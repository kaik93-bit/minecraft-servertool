// Update-Wächter: läuft als eigener Prozess, nachdem sich das Tool für ein Update beendet hat.
// 1. wartet, bis das alte Tool weg ist
// 2. sichert die aktuellen Programmdateien und kopiert die neue Version hinein
// 3. startet die neue Version und prüft, ob sie antwortet
// 4. falls nicht: alte Version wiederherstellen und starten
// Benutzt bewusst nur Node-Bordmittel (läuft als Kopie aus data/update/).
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');

const [appDir, stagedDir, port, oldPid, fromVersion, toVersion] = process.argv.slice(2);
const UPDATE_DIR = path.join(appDir, 'data', 'update');
const BACKUP_DIR = path.join(UPDATE_DIR, 'previous');
const SETTINGS_FILE = path.join(appDir, 'data', 'update.json');
// Diese Dinge gehören dem Nutzer bzw. der Installation und werden nie angefasst
const KEEP = new Set(['config.json', 'data', 'backups', 'node_modules', 'node', 'tool.log', '.git']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

function alive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function readJson(f, fallback) {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeResult(result) {
  const s = readJson(SETTINGS_FILE, {});
  s.lastResult = { ...result, at: Date.now(), seen: false };
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function npmInstall() {
  const nodeDir = path.dirname(process.execPath);
  const cli = [path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'), path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')].find((f) =>
    fs.existsSync(f)
  );
  const r = cli
    ? spawnSync(process.execPath, [cli, 'install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appDir, windowsHide: true, encoding: 'utf8' })
    : spawnSync('npm.cmd', ['install', '--omit=dev', '--no-audit', '--no-fund'], { cwd: appDir, windowsHide: true, encoding: 'utf8', shell: true });
  log('npm install ->', r.status, (r.stderr || '').slice(-500));
  return r.status === 0;
}

function startTool(extraEnv = {}) {
  const out = fs.openSync(path.join(appDir, 'tool.log'), 'a');
  const p = spawn(process.execPath, [path.join(appDir, 'server.js'), '--open'], {
    cwd: appDir,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, ...extraEnv },
  });
  p.unref();
  return p;
}

function getVersion() {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port: Number(port), path: '/api/tool/version', timeout: 2000 }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(d).version || null);
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => req.destroy());
  });
}

async function waitHealthy(child, version, ms = 60000) {
  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => {
    exited = true;
    exitCode = code;
  });
  const end = Date.now() + ms;
  while (Date.now() < end && !exited) {
    if ((await getVersion()) === version) {
      // muss auch ein paar Sekunden später noch laufen (Absturz direkt nach dem Start abfangen)
      await sleep(8000);
      if (exited) return exitCode === 0; // sauber beendet (z.B. Nutzer hat ⏻ gedrückt) = kein Absturz
      return (await getVersion()) === version || (exited && exitCode === 0);
    }
    await sleep(1000);
  }
  return false;
}

function kill(pid) {
  spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
}

(async () => {
  log(`Update ${fromVersion} -> ${toVersion}`);
  for (let i = 0; i < 180 && alive(oldPid); i++) await sleep(500);
  if (alive(oldPid)) {
    log('Altes Tool beendet sich nicht – Abbruch.');
    writeResult({ ok: false, from: fromVersion, to: toVersion, error: 'Das alte Tool hat sich nicht beendet.' });
    return;
  }
  await sleep(500);

  const entries = fs.readdirSync(stagedDir).filter((n) => !KEEP.has(n));
  const oldDeps = JSON.stringify(readJson(path.join(appDir, 'package.json'), {}).dependencies || {});
  const newDeps = JSON.stringify(readJson(path.join(stagedDir, 'package.json'), {}).dependencies || {});
  const depsChanged = oldDeps !== newDeps;

  // 1. Sichern
  fs.rmSync(BACKUP_DIR, { recursive: true, force: true });
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const backedUp = [];
  for (const n of entries) {
    const src = path.join(appDir, n);
    if (fs.existsSync(src)) {
      fs.cpSync(src, path.join(BACKUP_DIR, n), { recursive: true });
      backedUp.push(n);
    }
  }

  const restore = () => {
    // nur löschen, was auch gesichert vorliegt
    if (!backedUp.every((n) => fs.existsSync(path.join(BACKUP_DIR, n)))) throw new Error('Sicherung unvollständig – nichts gelöscht.');
    for (const n of entries) fs.rmSync(path.join(appDir, n), { recursive: true, force: true });
    for (const n of backedUp) fs.cpSync(path.join(BACKUP_DIR, n), path.join(appDir, n), { recursive: true });
  };

  let error = null;
  try {
    // 2. Neue Dateien einspielen
    for (const n of entries) {
      fs.rmSync(path.join(appDir, n), { recursive: true, force: true });
      fs.cpSync(path.join(stagedDir, n), path.join(appDir, n), { recursive: true });
    }
    if (depsChanged && !npmInstall()) throw new Error('Abhängigkeiten konnten nicht installiert werden.');

    // 3. Neue Version starten & prüfen
    const child = startTool();
    if (await waitHealthy(child, toVersion)) {
      log('Neue Version läuft.');
      writeResult({ ok: true, from: fromVersion, to: toVersion, notes: readJson(path.join(UPDATE_DIR, 'staged.json'), {}).notes || '' });
      fs.rmSync(path.join(UPDATE_DIR, 'staged'), { recursive: true, force: true });
      fs.rmSync(path.join(UPDATE_DIR, 'staged.json'), { force: true });
      return;
    }
    kill(child.pid);
    await sleep(1500);
    throw new Error('Die neue Version ist nicht richtig gestartet.');
  } catch (err) {
    error = err.message;
  }

  // 4. Zurück zur alten Version
  log('Fehler:', error, '– stelle alte Version wieder her.');
  try {
    restore();
    if (depsChanged) npmInstall();
  } catch (err) {
    log('Wiederherstellen fehlgeschlagen:', err.message);
  }
  // fehlerhaftes Update nicht erneut automatisch versuchen
  fs.rmSync(path.join(UPDATE_DIR, 'staged'), { recursive: true, force: true });
  fs.rmSync(path.join(UPDATE_DIR, 'staged.json'), { force: true });
  writeResult({ ok: false, from: fromVersion, to: toVersion, error });
  const s = readJson(SETTINGS_FILE, {});
  s.failedVersion = toVersion;
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
  startTool();
})();
