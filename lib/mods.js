// Mod-Verwaltung: aktive Mods liegen in <serverDir>/mods, deaktivierte in <serverDir>/disabled_mods.
// Der disabled-Ordner liegt bewusst NEBEN dem mods-Ordner, da manche Loader Unterordner mitladen.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');
const { jarInfo } = require('./jarinfo');

function requireDirs() {
  const { serverDir, modsDir, disabledModsDir } = config.paths();
  if (!serverDir || !fs.existsSync(serverDir)) {
    throw httpError(400, 'Server-Verzeichnis ist nicht konfiguriert oder existiert nicht.');
  }
  return { modsDir, disabledModsDir };
}

function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Schutz vor Pfad-Tricks wie "../../datei.jar"
function safeJarName(name) {
  const base = path.basename(String(name || ''));
  if (!base || base !== name || !base.toLowerCase().endsWith('.jar') || base.startsWith('.')) {
    throw httpError(400, `Ungültiger Dateiname: ${name}`);
  }
  return base;
}

async function readJars(dir, enabled) {
  if (!fs.existsSync(dir)) return [];
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.toLowerCase().endsWith('.jar')) continue;
    const stat = await fsp.stat(path.join(dir, e.name));
    const info = jarInfo(path.join(dir, e.name));
    result.push({
      name: e.name,
      enabled,
      size: stat.size,
      modified: stat.mtimeMs,
      modId: info ? info.id : null,
      displayName: info ? info.name : null,
      version: info ? info.version : null,
    });
  }
  return result;
}

async function list() {
  const { modsDir, disabledModsDir } = requireDirs();
  const mods = [...(await readJars(modsDir, true)), ...(await readJars(disabledModsDir, false))];
  mods.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { modsDir, disabledModsDir, mods };
}

async function setEnabled(name, enabled) {
  const file = safeJarName(name);
  const { modsDir, disabledModsDir } = requireDirs();
  const from = path.join(enabled ? disabledModsDir : modsDir, file);
  const toDir = enabled ? modsDir : disabledModsDir;
  const to = path.join(toDir, file);

  if (!fs.existsSync(from)) {
    if (fs.existsSync(to)) return; // ist schon im gewünschten Zustand
    throw httpError(404, `Mod nicht gefunden: ${file}`);
  }
  if (fs.existsSync(to)) {
    throw httpError(409, `"${file}" existiert bereits im Zielordner. Bitte zuerst eine Version löschen.`);
  }
  await fsp.mkdir(toDir, { recursive: true });
  try {
    await fsp.rename(from, to);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw httpError(423, `"${file}" ist gesperrt (wird vermutlich vom laufenden Server benutzt). Server zuerst stoppen.`);
    }
    throw err;
  }
}

async function remove(name, enabled) {
  const file = safeJarName(name);
  const { modsDir, disabledModsDir } = requireDirs();
  const target = path.join(enabled ? modsDir : disabledModsDir, file);
  if (!fs.existsSync(target)) throw httpError(404, `Mod nicht gefunden: ${file}`);
  try {
    await fsp.unlink(target);
  } catch (err) {
    if (err.code === 'EBUSY' || err.code === 'EPERM') {
      throw httpError(423, `"${file}" ist gesperrt. Server zuerst stoppen.`);
    }
    throw err;
  }
}

module.exports = { list, setEnabled, remove, safeJarName, requireDirs, httpError };
