// Verwaltet den Minecraft-Serverprozess: Start, Stop, Konsole, Log-Puffer, Spieler + Ping.
const { spawn, execFile } = require('child_process');
const { EventEmitter } = require('events');
const fs = require('fs');
const net = require('net');
const path = require('path');
const config = require('./config');

const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
const NAME = '([A-Za-z0-9_.]{1,16})';
// Ab Minecraft 26.x stehen System-Meldungen mit Vorsatz im Log: "System chat: Name joined the game"
const MSG_PREFIX = '(?:\\[[^\\]]*\\]\\s)?(?:(?:System\\s)?[Cc]hat:\\s)?';
const JOIN_RE = new RegExp(`\\]:\\s${MSG_PREFIX}${NAME} joined the game`);
const LEFT_RE = new RegExp(`\\]:\\s${MSG_PREFIX}${NAME} left the game`);
const LOGIN_RE = new RegExp(`:\\s${NAME}\\[\\/(.+):\\d+\\] logged in with entity id`);
const AUTH_RE = new RegExp(`UUID of player ${NAME} is ([0-9a-fA-F-]{32,36})`);
const LIST_RE = /There are (\d+) (?:of a max(?: of)?|\/) (\d+) players online:?(.*)$/;
const DONE_RE = /Done \([\d.,]+s\)!/;
const REJECT_REASONS = [
  [/not white-?listed/i, 'whitelist'],
  [/you are banned|banned from this server|banned on this server/i, 'banned'],
  [/server is full/i, 'full'],
  [/outdated (client|server)|incompatible client/i, 'version'],
];
const PING_INTERVAL_MS = 10000;

// Zerlegt "-Xmx4G -Dfoo=\"a b\"" in ein Argument-Array (unterstützt Anführungszeichen).
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

// "nogui" verhindert, dass sich das Java-Fenster "Minecraft server" öffnet.
function withNogui(args) {
  return args.some((a) => /^-{0,2}nogui$/i.test(a)) ? args : [...args, 'nogui'];
}

// Netzwerk-Ping (ICMP) zur IP des Spielers. Liefert ms oder null.
function pingHost(ip) {
  return new Promise((resolve) => {
    if (!net.isIP(ip)) return resolve(null);
    const win = process.platform === 'win32';
    const args = win ? ['-n', '1', '-w', '1500', ip] : ['-c', '1', '-W', '2', ip];
    execFile('ping', args, { windowsHide: true, timeout: 5000 }, (err, stdout) => {
      const out = String(stdout || '');
      const m = win ? out.match(/[=<]\s*(\d+)\s*ms\s+TTL/i) : out.match(/time[=<]\s*([\d.]+)\s*ms/i);
      resolve(m ? Math.round(Number(m[1])) : null);
    });
  });
}

class MinecraftServer extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.status = 'offline'; // offline | starting | running | stopping
    this.logs = [];
    this.online = new Map(); // name -> { ip, ping, joinedAt }
    this.recentAuth = new Map(); // name(lower) -> { name, uuid, at }
    this.maxPlayers = null;
    this.startedAt = null;
    this._partial = { stdout: '', stderr: '' };
    this._exitPromise = null;
    this._killTimer = null;
    this._pingTimer = null;
    this._filters = [];
  }

  isAlive() {
    return !!this.proc;
  }

  getState() {
    return {
      status: this.status,
      pid: this.proc ? this.proc.pid : null,
      startedAt: this.startedAt,
      players: [...this.online.entries()]
        .map(([name, info]) => ({ name, ping: info.ping, joinedAt: info.joinedAt }))
        .sort((a, b) => a.name.localeCompare(b.name)),
      maxPlayers: this.maxPlayers,
    };
  }

  _emitState() {
    this.emit('status', this.getState());
  }

  _setStatus(status) {
    if (this.status === status) return;
    this.status = status;
    this._emitState();
  }

  // Interne Meldungen des Tools landen ebenfalls in der Konsole
  log(line) {
    this._pushLine(`[Servertool] ${line}`);
  }

  _pushLine(line) {
    const max = config.get().maxLogLines;
    this.logs.push(line);
    if (this.logs.length > max) this.logs.splice(0, this.logs.length - max);
    this.emit('log', line);
  }

  _handleChunk(source, chunk) {
    const text = this._partial[source] + chunk.toString('utf8');
    const lines = text.split(/\r?\n/);
    this._partial[source] = lines.pop();
    // Forge-run.bat endet mit "pause": hat sich der Server selbst beendet (/stop im Spiel, Absturz),
    // wartet cmd sonst ewig auf einen Tastendruck und das Tool zeigt weiter "läuft".
    // Die Aufforderung kommt OHNE Zeilenumbruch, steht also im noch unvollständigen Rest.
    const PAUSE_RE = /^(Dr.cken Sie eine beliebige Taste|Press any key to continue)/i;
    if (this.proc && [...lines, this._partial[source]].some((l) => PAUSE_RE.test(l.replace(ANSI_RE, '').trim()))) {
      try {
        this.proc.stdin.end();
      } catch (_) {
        /* schon zu */
      }
    }
    for (const raw of lines) {
      const line = raw.replace(ANSI_RE, '').replace(/^>\s*/, '');
      if (!line.trim()) continue;
      this._parseLine(line);
      this.emit('line', line);
      if (this._filters.some((f) => f(line))) continue; // z.B. automatische Abfragen nicht anzeigen
      this._pushLine(line);
    }
  }

  // Blendet passende Zeilen in der Konsole aus, bis die zurückgegebene Funktion aufgerufen wird
  addLogFilter(fn) {
    this._filters.push(fn);
    return () => {
      this._filters = this._filters.filter((f) => f !== fn);
    };
  }

  _addOnline(name, ip) {
    const prev = this.online.get(name);
    this.online.set(name, { ip: ip || prev?.ip || null, ping: prev?.ping ?? null, joinedAt: prev?.joinedAt || Date.now() });
  }

  _parseLine(line) {
    let m;
    if (this.status === 'starting' && DONE_RE.test(line)) {
      this._setStatus('running');
      this.log('Server ist bereit.');
      setImmediate(() => this.emit('ready'));
    }

    if ((m = line.match(AUTH_RE))) {
      this.recentAuth.set(m[1].toLowerCase(), { name: m[1], uuid: m[2], at: Date.now() });
      if (this.recentAuth.size > 200) this.recentAuth.delete(this.recentAuth.keys().next().value);
    }

    if ((m = line.match(LOGIN_RE))) {
      const ip = m[2].replace(/^\[|\]$/g, '');
      this._addOnline(m[1], ip);
      this._pingPlayer(m[1]);
      this._emitState();
    } else if ((m = line.match(JOIN_RE))) {
      this._addOnline(m[1]);
      this._emitState();
    } else if ((m = line.match(LEFT_RE))) {
      this.online.delete(m[1]);
      this._emitState();
    } else if ((m = line.match(LIST_RE))) {
      this.maxPlayers = Number(m[2]);
      const names = m[3].split(',').map((s) => s.trim()).filter(Boolean);
      for (const n of [...this.online.keys()]) if (!names.includes(n)) this.online.delete(n);
      for (const n of names) this._addOnline(n);
      this._emitState();
    }

    if (/lost connection|Disconnecting/i.test(line)) {
      const reason = REJECT_REASONS.find(([re]) => re.test(line));
      if (reason) this._recordRejection(line, reason[1]);
    }

    if (/EULA/i.test(line) && /agree|eula\.txt/i.test(line)) {
      this.log('Hinweis: Du musst die EULA akzeptieren (Einstellungen -> EULA akzeptieren).');
    }
  }

  _recordRejection(line, reason) {
    const name =
      (line.match(/name=([A-Za-z0-9_.]{1,16})/) ||
        line.match(/Disconnecting ([A-Za-z0-9_.]{1,16}) \(/) ||
        line.match(/:\s([A-Za-z0-9_.]{1,16}) \(\/[^)]*\) lost connection/) ||
        [])[1] || this._latestAuthName();
    if (!name) return;
    const auth = this.recentAuth.get(name.toLowerCase());
    const uuid = (line.match(/id=([0-9a-fA-F-]{32,36})/) || [])[1] || auth?.uuid || null;
    const ip = (line.match(/\(\/([^)]+?):\d+\)/) || [])[1] || null;
    const message = (line.split(/lost connection:|:\s*(?=You )/).pop() || '').trim();
    this.emit('rejected', { name, uuid, ip, reason, message, at: Date.now() });
  }

  _latestAuthName() {
    let best = null;
    for (const a of this.recentAuth.values()) if (Date.now() - a.at < 10000 && (!best || a.at > best.at)) best = a;
    return best?.name || null;
  }

  async _pingPlayer(name) {
    const info = this.online.get(name);
    if (!info || !info.ip) return;
    const ms = await pingHost(info.ip);
    const cur = this.online.get(name);
    if (cur && cur.ping !== ms) {
      cur.ping = ms;
      this._emitState();
    }
  }

  _buildCommand() {
    const cfg = config.get();
    const { serverDir } = config.paths();
    if (!serverDir) throw new Error('Kein Server ausgewählt. Bitte zuerst die Server-Datei öffnen.');
    if (!fs.existsSync(serverDir)) throw new Error(`Server-Verzeichnis existiert nicht: ${serverDir}`);
    const startPath = path.resolve(serverDir, cfg.startFile);
    if (!fs.existsSync(startPath)) throw new Error(`Startdatei nicht gefunden: ${startPath}`);

    const serverArgs = withNogui(splitArgs(cfg.serverArgs));
    const ext = path.extname(startPath).toLowerCase();
    if (ext === '.jar') {
      return { cmd: cfg.javaPath || 'java', args: [...splitArgs(cfg.javaArgs), '-jar', startPath, ...serverArgs] };
    }
    if (ext === '.bat' || ext === '.cmd') {
      // /s + äußere Anführungszeichen: funktioniert auch mit Leerzeichen/Klammern im Pfad
      const inner = [`"${startPath}"`, ...serverArgs.map((a) => (/\s/.test(a) ? `"${a}"` : a))].join(' ');
      return {
        cmd: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', `"${inner}"`],
        verbatim: true,
      };
    }
    if (ext === '.sh') return { cmd: 'bash', args: [startPath, ...serverArgs] };
    return { cmd: startPath, args: serverArgs };
  }

  start() {
    if (this.proc) throw new Error('Server läuft bereits.');
    this.emit('before-start'); // z.B. ausstehende Mod-Updates einspielen (synchron)
    const { cmd, args, verbatim } = this._buildCommand();
    const { serverDir } = config.paths();

    this.online.clear();
    this.maxPlayers = null;
    this.lastStopForced = false;
    this._partial = { stdout: '', stderr: '' };
    this.log(`Starte: ${cmd} ${args.join(' ')}`);

    const proc = spawn(cmd, args, {
      cwd: serverDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true, // kein Konsolenfenster
      windowsVerbatimArguments: !!verbatim,
    });
    this.proc = proc;
    this.startedAt = Date.now();
    this._setStatus('starting');

    proc.stdout.on('data', (c) => this._handleChunk('stdout', c));
    proc.stderr.on('data', (c) => this._handleChunk('stderr', c));
    proc.stdin.on('error', () => {}); // z.B. EPIPE, wenn der Prozess schon weg ist

    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      for (const name of this.online.keys()) this._pingPlayer(name);
    }, PING_INTERVAL_MS);

    this._exitPromise = new Promise((resolve) => {
      let done = false;
      const finish = (code, signal, err) => {
        if (done) return;
        done = true;
        clearTimeout(this._killTimer);
        clearInterval(this._pingTimer);
        for (const src of ['stdout', 'stderr']) {
          if (this._partial[src]) this._pushLine(this._partial[src]);
        }
        if (err) this.log(`Prozess konnte nicht gestartet werden: ${err.message}`);
        else this.log(`Serverprozess beendet (Code ${code}${signal ? ', Signal ' + signal : ''}).`);
        this.proc = null;
        this.startedAt = null;
        this.online.clear();
        this._setStatus('offline');
        resolve();
      };
      proc.on('exit', (code, signal) => finish(code, signal));
      proc.on('error', (err) => finish(null, null, err));
    });
  }

  sendCommand(command) {
    if (!this.proc || !this.proc.stdin.writable) throw new Error('Server läuft nicht.');
    const cmd = String(command).replace(/[\r\n]+/g, ' ').trim().replace(/^\//, '');
    if (!cmd) throw new Error('Leerer Befehl.');
    this.proc.stdin.write(cmd + '\n');
    return cmd;
  }

  // Wartet, bis eine Log-Zeile auf das Muster passt (oder Timeout)
  waitForLog(regex, timeoutMs) {
    return new Promise((resolve) => {
      const onLog = (line) => {
        if (regex.test(line)) cleanup(true);
      };
      const timer = setTimeout(() => cleanup(false), timeoutMs);
      const cleanup = (ok) => {
        clearTimeout(timer);
        this.off('log', onLog);
        resolve(ok);
      };
      this.on('log', onLog);
    });
  }

  async stop() {
    if (!this.proc) throw new Error('Server läuft nicht.');
    if (this.status === 'stopping') return this._exitPromise;
    this._setStatus('stopping');
    this.log('Sende "stop" an den Server ...');
    try {
      this.proc.stdin.write('stop\n');
      // stdin schließen: beendet z.B. ein "pause" am Ende von run.bat sauber
      this.proc.stdin.end();
    } catch (_) {
      /* ignorieren */
    }
    const timeout = config.get().stopTimeoutSec * 1000;
    clearTimeout(this._killTimer);
    this._killTimer = setTimeout(() => {
      this.log(`Server hat nach ${timeout / 1000}s nicht reagiert – Prozess wird hart beendet.`);
      this.kill();
    }, timeout);
    return this._exitPromise;
  }

  kill() {
    if (!this.proc) return;
    this.lastStopForced = true;
    const pid = this.proc.pid;
    if (process.platform === 'win32') {
      // /T beendet auch Kindprozesse (z.B. java.exe unter cmd.exe)
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {});
    } else {
      this.proc.kill('SIGKILL');
    }
  }

  async restart() {
    if (this.proc) await this.stop();
    this.start();
  }
}

module.exports = new MinecraftServer();
