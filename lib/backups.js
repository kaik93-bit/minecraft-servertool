// ZIP-Backups der Welt(en) oder des kompletten Server-Ordners.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const archiver = require('archiver');
const config = require('./config');
const mc = require('./mcServer');
const { httpError } = require('./mods');

let running = false;

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

// Liest level-name aus server.properties (Standard: "world")
function levelName(serverDir) {
  try {
    const props = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
    const m = props.match(/^level-name=(.*)$/m);
    if (m && m[1].trim()) return m[1].trim();
  } catch (_) {
    /* Datei fehlt -> Standard */
  }
  return 'world';
}

function safeZipName(name) {
  const base = path.basename(String(name || ''));
  if (base !== name || !/^[\w.-]+\.zip$/.test(base)) throw httpError(400, 'Ungültiger Backup-Name.');
  return base;
}

async function list() {
  const { backupDir } = config.paths();
  if (!fs.existsSync(backupDir)) return { backupDir, backups: [] };
  const files = (await fsp.readdir(backupDir)).filter((f) => f.toLowerCase().endsWith('.zip'));
  const backups = [];
  for (const f of files) {
    const st = await fsp.stat(path.join(backupDir, f));
    backups.push({ name: f, size: st.size, created: st.mtimeMs });
  }
  backups.sort((a, b) => b.created - a.created);
  return { backupDir, backups, inProgress: running };
}

async function create(mode = 'world') {
  if (running) throw httpError(409, 'Es läuft bereits ein Backup.');
  const { serverDir, backupDir } = config.paths();
  if (!serverDir || !fs.existsSync(serverDir)) throw httpError(400, 'Server-Verzeichnis ist nicht konfiguriert.');
  if (mode !== 'world' && mode !== 'full') throw httpError(400, 'Modus muss "world" oder "full" sein.');

  // Welt-Ordner bestimmen (Vanilla/Forge: world, Paper/Spigot zusätzlich world_nether/world_the_end)
  const level = levelName(serverDir);
  const worldDirs = [level, `${level}_nether`, `${level}_the_end`].filter((d) =>
    fs.existsSync(path.join(serverDir, d))
  );
  if (mode === 'world' && worldDirs.length === 0) {
    throw httpError(404, `Welt-Ordner "${level}" nicht gefunden.`);
  }

  running = true;
  await fsp.mkdir(backupDir, { recursive: true });
  const fileName = `backup-${mode}-${stamp()}.zip`;
  const target = path.join(backupDir, fileName);
  const serverWasRunning = mc.isAlive() && mc.status === 'running';

  try {
    if (serverWasRunning) {
      // Automatisches Speichern pausieren und alles auf die Platte schreiben
      mc.log('Backup: Speichere Welt und pausiere Auto-Save ...');
      mc.sendCommand('save-off');
      const saved = mc.waitForLog(/Saved the game|Saved the world/i, 20000);
      mc.sendCommand('save-all flush');
      await saved;
    }
    mc.log(`Backup wird erstellt: ${fileName}`);

    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(target);
      const archive = archiver('zip', { zlib: { level: 6 } });
      output.on('close', resolve);
      archive.on('warning', (err) => mc.log(`Backup-Warnung: ${err.message}`));
      archive.on('error', reject);
      archive.pipe(output);

      // session.lock ist vom laufenden Server gesperrt und wird nicht benötigt
      const ignore = ['**/session.lock'];
      if (mode === 'world') {
        for (const d of worldDirs) {
          archive.glob('**/*', { cwd: path.join(serverDir, d), ignore, dot: true }, { prefix: d });
        }
      } else {
        // Backup-Ordner nicht in sich selbst packen, falls er im Server-Ordner liegt
        const rel = path.relative(serverDir, backupDir);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          ignore.push(`${rel.split(path.sep).join('/')}/**`);
        }
        archive.glob('**/*', { cwd: serverDir, ignore, dot: true });
      }
      archive.finalize();
    });

    const { size } = await fsp.stat(target);
    mc.log(`Backup fertig: ${fileName} (${(size / 1024 / 1024).toFixed(1)} MB)`);
    return { name: fileName, size };
  } catch (err) {
    mc.log(`Backup fehlgeschlagen: ${err.message}`);
    await fsp.rm(target, { force: true }).catch(() => {});
    throw err;
  } finally {
    if (serverWasRunning && mc.isAlive()) {
      try {
        mc.sendCommand('save-on');
      } catch (_) {
        /* Server inzwischen gestoppt */
      }
    }
    running = false;
  }
}

function filePath(name) {
  const file = safeZipName(name);
  const p = path.join(config.paths().backupDir, file);
  if (!fs.existsSync(p)) throw httpError(404, 'Backup nicht gefunden.');
  return p;
}

async function remove(name) {
  await fsp.unlink(filePath(name));
}

module.exports = { list, create, remove, filePath, isRunning: () => running };
