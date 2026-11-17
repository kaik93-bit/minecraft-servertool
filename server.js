// Einstiegspunkt: REST-API + WebSocket + Auslieferung des Frontends.
const fs = require('fs');
const path = require('path');

// Startet das Tool unsichtbar im Hintergrund (kein Konsolenfenster) mit App-Fenster.
// Ausgaben landen in tool.log.
function spawnDetached(extraArgs = [], logMode = 'w') {
  const { spawn } = require('child_process');
  const log = fs.openSync(path.join(__dirname, 'tool.log'), logMode);
  spawn(process.execPath, [__filename, '--open', ...extraArgs], {
    cwd: __dirname,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: process.env,
  }).unref();
}

if (process.argv.includes('--detach')) {
  spawnDetached();
  process.exit(0);
}

// Fingerabdruck des Programmcodes: ändert sich, wenn das Tool aktualisiert wurde,
// während es läuft -> Oberfläche bietet "Jetzt neu starten" an.
function codeFingerprint() {
  const files = [path.join(__dirname, 'server.js')];
  for (const dir of ['lib', 'public']) {
    try {
      for (const f of fs.readdirSync(path.join(__dirname, dir))) files.push(path.join(__dirname, dir, f));
    } catch (_) {
      /* Ordner fehlt */
    }
  }
  return files
    .map((f) => {
      try {
        const s = fs.statSync(f);
        return `${f}:${s.size}:${Math.round(s.mtimeMs)}`;
      } catch (_) {
        return f;
      }
    })
    .sort()
    .join('|');
}
const STARTUP_FINGERPRINT = codeFingerprint();

const http = require('http');
const express = require('express');
const multer = require('multer');
const { WebSocketServer } = require('ws');

const config = require('./lib/config');
const mc = require('./lib/mcServer');
const mods = require('./lib/mods');
const backups = require('./lib/backups');
const players = require('./lib/players');
const serverSettings = require('./lib/serverSettings');
const gamerules = require('./lib/gamerules');
const daylength = require('./lib/daylength');
const perf = require('./lib/perf');
const autorestart = require('./lib/autorestart');
const dialog = require('./lib/dialog');
const { openFolder } = require('./lib/explorer');
const { openAppWindow } = require('./lib/appWindow');
const updater = require('./lib/updater');
const modCatalog = require('./lib/modCatalog');

config.load();

const PORT = Number(process.env.PORT) || 3000;
// Standardmäßig nur lokal erreichbar! Wer die Seite öffnen kann, kann Befehle ausführen.
const HOST = process.env.HOST || '127.0.0.1';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Kleiner Helfer: async-Handler mit einheitlicher Fehlerbehandlung
const route = (fn) => (req, res) =>
  Promise.resolve(fn(req, res)).catch((err) => {
    const status = err.status || 400;
    if (status >= 500 || !err.status) console.error('[api]', err);
    res.status(status).json({ error: err.message || String(err) });
  });

// ---------------- Server-Steuerung ----------------
app.get('/api/status', (req, res) => res.json(mc.getState()));

app.post('/api/server/start', route(async (req, res) => {
  mc.start();
  res.json(mc.getState());
}));

app.post('/api/server/stop', route(async (req, res) => {
  mc.stop().catch(() => {}); // läuft im Hintergrund weiter, Status kommt per WebSocket
  res.json(mc.getState());
}));

app.post('/api/server/restart', route(async (req, res) => {
  if (!mc.isAlive()) {
    mc.start();
  } else {
    mc.restart().catch((err) => mc.log(`Neustart fehlgeschlagen: ${err.message}`));
  }
  res.json(mc.getState());
}));

app.post('/api/server/kill', route(async (req, res) => {
  if (!mc.isAlive()) throw new Error('Server läuft nicht.');
  mc.log('Prozess wird hart beendet (Kill).');
  mc.kill();
  res.json({ ok: true });
}));

app.post('/api/server/command', route(async (req, res) => {
  const cmd = mc.sendCommand(req.body.command);
  mc.log(`> ${cmd}`);
  res.json({ ok: true });
}));

app.get('/api/logs', (req, res) => res.json({ lines: mc.logs }));

// ---------------- Spieler ----------------
app.get('/api/players', route(async (req, res) => res.json(players.list())));

app.post('/api/players/refresh', route(async (req, res) => {
  mc.sendCommand('list'); // Antwort wird aus dem Log geparst
  res.json({ ok: true });
}));

app.post('/api/players/action', route(async (req, res) => {
  const { name, action, reason, uuid, mode } = req.body || {};
  await players.action(name, action, { reason, uuid, mode });
  res.json({ ok: true });
}));

app.post('/api/players/whitelist-enabled', route(async (req, res) => {
  await players.setWhitelistEnabled(!!req.body.enabled);
  res.json({ ok: true });
}));

app.get('/api/attempts', (req, res) => res.json({ attempts: players.listAttempts() }));

app.delete('/api/attempts', route(async (req, res) => {
  players.dismissAttempt(req.query.name || null);
  broadcast({ type: 'attempts', attempts: players.listAttempts() });
  res.json({ ok: true });
}));

// ---------------- Server-Einstellungen ----------------
app.get('/api/server-properties', route(async (req, res) => res.json(serverSettings.list())));

app.put('/api/server-properties', route(async (req, res) => {
  res.json(await serverSettings.save((req.body || {}).values));
}));

app.get('/api/gamerules', route(async (req, res) => res.json(gamerules.list())));

app.post('/api/gamerules/refresh', route(async (req, res) => {
  await gamerules.query();
  res.json(gamerules.list());
}));

app.put('/api/gamerules/:key', route(async (req, res) => {
  res.json(await gamerules.set(req.params.key, (req.body || {}).value));
}));

app.get('/api/perf', (req, res) => res.json(perf.getState()));

app.get('/api/autorestart', route(async (req, res) => res.json(autorestart.status())));
app.put('/api/autorestart', route(async (req, res) => res.json(autorestart.save(req.body || {}))));
app.post('/api/autorestart/skip', route(async (req, res) => res.json(autorestart.skipNext(req.body?.skip !== false))));
app.post('/api/autorestart/countdown', route(async (req, res) => res.json(autorestart.startCountdown(req.body?.minutes))));
app.delete('/api/autorestart/countdown', route(async (req, res) => res.json(autorestart.cancelCountdown())));

app.get('/api/daylength', route(async (req, res) => res.json(daylength.status())));

app.put('/api/daylength', route(async (req, res) => {
  res.json(await daylength.apply(req.body || {}));
}));

app.delete('/api/gamerules/pending', route(async (req, res) => {
  gamerules.clearPending();
  res.json({ ok: true });
}));

// ---------------- Mods ----------------
app.get('/api/mods', route(async (req, res) => res.json(await mods.list())));

// Ordner im Windows-Explorer öffnen (mods, disabled_mods, Server-Ordner, Backups)
app.post('/api/open-folder', route(async (req, res) => {
  const p = config.paths();
  const dir = { mods: p.modsDir, disabled: p.disabledModsDir, server: p.serverDir, backups: p.backupDir }[req.body?.which];
  if (!dir) throw new Error('Kein Server ausgewählt bzw. unbekannter Ordner.');
  fs.mkdirSync(dir, { recursive: true }); // z.B. disabled_mods gibt es evtl. noch nicht
  const result = await openFolder(dir); // öffnet bzw. holt das Explorer-Fenster in den Vordergrund
  res.json({ ok: true, path: dir, result });
}));

app.post('/api/mods/:name/toggle', route(async (req, res) => {
  await mods.setEnabled(req.params.name, !!req.body.enabled);
  res.json({ ok: true, restartRequired: mc.isAlive() });
}));

app.delete('/api/mods/:name', route(async (req, res) => {
  await mods.remove(req.params.name, req.query.enabled !== 'false');
  res.json({ ok: true });
}));

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      try {
        const { modsDir } = mods.requireDirs();
        fs.mkdirSync(modsDir, { recursive: true });
        cb(null, modsDir);
      } catch (err) {
        cb(err);
      }
    },
    filename: (req, file, cb) => {
      try {
        // multer liefert Dateinamen als latin1 -> nach UTF-8 umwandeln (Umlaute etc.)
        const name = Buffer.from(file.originalname, 'latin1').toString('utf8');
        cb(null, mods.safeJarName(name));
      } catch (err) {
        cb(err);
      }
    },
  }),
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.jar')) cb(null, true);
    else cb(mods.httpError(400, `Nur .jar-Dateien erlaubt: ${file.originalname}`));
  },
  limits: { fileSize: 1024 * 1024 * 1024, files: 50 },
});

app.post('/api/mods/upload', (req, res) => {
  upload.array('mods', 50)(req, res, (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    const names = (req.files || []).map((f) => f.filename);
    if (names.length) mc.log(`Mods hochgeladen: ${names.join(', ')}`);
    res.json({ ok: true, uploaded: names, restartRequired: mc.isAlive() });
  });
});

// ---------------- Backups ----------------
app.get('/api/backups', route(async (req, res) => res.json(await backups.list())));

app.post('/api/backups', route(async (req, res) => {
  const result = await backups.create(req.body.mode || 'world');
  res.json(result);
}));

app.get('/api/backups/:name/download', route(async (req, res) => {
  res.download(backups.filePath(req.params.name));
}));

app.delete('/api/backups/:name', route(async (req, res) => {
  await backups.remove(req.params.name);
  res.json({ ok: true });
}));

// ---------------- Konfiguration ----------------
app.get('/api/config', (req, res) => {
  const { serverDir, backupDir } = config.paths();
  let eula = null;
  if (serverDir) {
    try {
      eula = /^eula\s*=\s*true\s*$/m.test(fs.readFileSync(path.join(serverDir, 'eula.txt'), 'utf8'));
    } catch (_) {
      eula = false;
    }
  }
  res.json({
    config: { ...config.get(), serverFile: config.paths().serverFile },
    info: {
      serverDirExists: !!serverDir && fs.existsSync(serverDir),
      startFileExists: !!serverDir && fs.existsSync(path.resolve(serverDir, config.get().startFile)),
      resolvedBackupDir: backupDir,
      eula,
    },
  });
});

app.put('/api/config', route(async (req, res) => {
  const cfg = config.update(req.body || {});
  res.json({ config: cfg });
}));

// Nativer "Öffnen"-Dialog. Mit apply=true wird die Auswahl direkt gespeichert.
app.post('/api/browse', route(async (req, res) => {
  const { type = 'file', apply } = req.body || {};
  const current = type === 'folder' ? config.paths().backupDir : config.paths().serverFile;
  const picked = await dialog.browse(type, current);
  if (picked && apply === 'serverFile') config.update({ serverFile: picked });
  if (picked && apply === 'backupDir') config.update({ backupDir: picked });
  res.json({ path: picked });
}));

app.post('/api/tool/quit', (req, res) => {
  res.json({ ok: true });
  setTimeout(shutdown, 100);
});

app.get('/api/tool/version', (req, res) => {
  res.json({ version: updater.VERSION, outdated: codeFingerprint() !== STARTUP_FINGERPRINT });
});

// ---------------- Eigene Mods von GitHub ----------------
app.get('/api/mod-updates', route(async (req, res) => res.json(modCatalog.status())));
app.post('/api/mod-updates/check', route(async (req, res) => res.json(await modCatalog.check({ manual: true }))));
app.post('/api/mod-updates/:id/update', route(async (req, res) => res.json(await modCatalog.update(req.params.id))));
app.post('/api/mod-updates/:id/install', route(async (req, res) => res.json(await modCatalog.install(req.params.id))));
app.put('/api/mod-updates/settings', route(async (req, res) => res.json(modCatalog.setAuto((req.body || {}).auto !== false))));

// ---------------- Updates (GitHub) ----------------
app.get('/api/update', (req, res) => res.json(updater.status()));
app.post('/api/update/check', route(async (req, res) => res.json(await updater.check({ manual: true }))));
app.post('/api/update/install', route(async (req, res) => {
  if (updater.status().status === 'available') await updater.download();
  res.json(await updater.install());
}));
app.put('/api/update/settings', route(async (req, res) => res.json(updater.setAuto((req.body || {}).auto !== false))));
app.post('/api/update/dismiss', route(async (req, res) => res.json(updater.dismissResult())));

// Neu starten (z.B. nach einem Update): Server sicher stoppen, neue Instanz mit Fenster starten
app.post('/api/tool/restart', (req, res) => {
  res.json({ ok: true });
  setTimeout(() => shutdown({ restart: true }), 100);
});

app.post('/api/eula', route(async (req, res) => {
  const { serverDir } = config.paths();
  if (!serverDir || !fs.existsSync(serverDir)) throw new Error('Server-Verzeichnis ist nicht konfiguriert.');
  fs.writeFileSync(
    path.join(serverDir, 'eula.txt'),
    `# Akzeptiert über Minecraft Servertool (https://aka.ms/MinecraftEULA)\neula=true\n`,
    'utf8'
  );
  res.json({ ok: true });
}));

// ---------------- HTTP + WebSocket ----------------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
// Fehler des HTTP-Servers (z.B. Port belegt) gibt "ws" weiter – behandelt wird das unten bei server.on('error')
wss.on('error', () => {});

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const client of wss.clients) {
    if (client.readyState === 1) client.send(data);
  }
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'history', lines: mc.logs }));
  ws.send(JSON.stringify({ type: 'status', ...mc.getState() }));
  ws.send(JSON.stringify({ type: 'attempts', attempts: players.listAttempts() }));
  ws.send(JSON.stringify({ type: 'perf', ...perf.getState() }));
  try {
    ws.send(JSON.stringify({ type: 'autorestart', ...autorestart.status() }));
  } catch (_) {
    /* kein Server ausgewählt */
  }
  ws.send(JSON.stringify({ type: 'update', ...updater.status() }));
});
mc.on('update', (u) => broadcast({ type: 'update', ...u }));
mc.on('mod-updates', (m) => broadcast({ type: 'mod-updates', ...m }));

mc.on('log', (line) => broadcast({ type: 'log', line }));
mc.on('status', (state) => broadcast({ type: 'status', ...state }));
mc.on('gamerules-changed', () => broadcast({ type: 'gamerules' }));
mc.on('perf', (p) => broadcast({ type: 'perf', ...p }));
mc.on('autorestart', (a) => broadcast({ type: 'autorestart', ...a }));
mc.on('rejected', (attempt) => {
  const entry = players.recordAttempt(attempt);
  broadcast({ type: 'attempt', attempt: entry, attempts: players.listAttempts() });
});

// --open: Oberfläche als eigenes App-Fenster öffnen (ohne Browser-Leisten)
const OPEN_WINDOW = process.argv.includes('--open');
const APP_URL = `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`;

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    if (OPEN_WINDOW) {
      // Tool läuft schon (z.B. im Hintergrund) -> nur das Fenster öffnen
      openAppWindow(APP_URL);
      return setTimeout(() => process.exit(0), 1500);
    }
    console.error(`Port ${PORT} ist schon belegt – läuft das Tool bereits? Öffne ${APP_URL}`);
    process.exit(1);
  }
  throw err;
});

server.listen(PORT, HOST, () => {
  console.log(`Minecraft Servertool läuft auf ${APP_URL}`);
  if (OPEN_WINDOW) openAppWindow(APP_URL);
  modCatalog.init();
  updater.init({
    requestShutdown: (opts) => shutdown(opts),
    playersOnline: () => mc.online.size,
    busy: () => backups.isRunning() || shuttingDown,
  });
  // Wurde der Minecraft-Server für ein Update gestoppt? Dann wieder starten.
  if (updater.shouldResumeServer()) {
    mc.log('Update abgeschlossen – Minecraft-Server wird wieder gestartet ...');
    Promise.resolve()
      .then(() => mc.start())
      .catch((err) => mc.log(`Server konnte nicht gestartet werden: ${err.message}`));
  }
});

// Tool beenden (⏻-Knopf oder Strg+C): erst laufendes Backup abwarten, dann den
// Minecraft-Server sauber stoppen (speichert die Welt) und erst danach das Tool beenden.
// Die Fenster bekommen den Fortschritt per WebSocket und schließen sich am Ende selbst.
let shuttingDown = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shutdown({ restart = false, update = false } = {}) {
  if (shuttingDown) return; // mehrfaches Klicken ignorieren – niemals mitten im Speichern abbrechen
  shuttingDown = true;
  const wasRunning = mc.isAlive();
  broadcast({ type: 'shutdown', phase: 'start', serverRunning: wasRunning, restart, update });

  if (backups.isRunning()) {
    mc.log('Warte, bis das laufende Backup fertig ist ...');
    broadcast({ type: 'shutdown', phase: 'backup' });
    while (backups.isRunning()) await sleep(500);
  }

  if (mc.isAlive()) {
    console.log('Fahre Minecraft-Server herunter ...');
    broadcast({ type: 'shutdown', phase: 'stopping' });
    await mc.stop().catch(() => {});
  }

  broadcast({ type: 'shutdown', phase: 'done', serverWasRunning: wasRunning, forced: mc.lastStopForced, restart, update });
  await sleep(1000); // Fenstern Zeit geben, die Nachricht zu empfangen und sich zu schließen
  if (restart) {
    // Port freigeben, dann die neue Version starten (öffnet ein neues Fenster)
    for (const c of wss.clients) c.terminate();
    await Promise.race([new Promise((r) => server.close(() => r())), sleep(2000)]);
    server.closeAllConnections?.();
    if (update) {
      try {
        updater.spawnGuard(PORT); // tauscht die Dateien, sobald dieser Prozess weg ist
      } catch (err) {
        console.error('Update konnte nicht gestartet werden:', err);
        spawnDetached([], 'a');
      }
    } else {
      spawnDetached([], 'a');
    }
  }
  process.exit(0);
}

process.on('SIGINT', () => {
  if (shuttingDown) process.exit(1); // zweites Strg+C im Terminal = erzwingen
  shutdown();
});
process.on('SIGTERM', shutdown);
