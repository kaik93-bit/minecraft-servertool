// Lädt und speichert die Konfiguration in config.json (im Tool-Ordner).
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const CONFIG_PATH = path.join(ROOT_DIR, 'config.json');

const DEFAULTS = {
  // Absoluter Pfad zum Minecraft-Server-Ordner (dort liegen server.jar, mods/, world/ ...)
  serverDir: '',
  // Startdatei relativ zu serverDir: z.B. "server.jar", "run.bat" (Forge/NeoForge) oder "start.sh"
  startFile: 'server.jar',
  // Nur relevant, wenn startFile eine .jar ist
  javaPath: 'java',
  javaArgs: '-Xms1G -Xmx4G',
  serverArgs: 'nogui',
  // Name des Mod-Ordners und des Ordners für deaktivierte Mods (beide relativ zu serverDir)
  modsFolder: 'mods',
  disabledModsFolder: 'disabled_mods',
  // Zielordner für Backups (leer = ./backups im Tool-Ordner)
  backupDir: '',
  // Sekunden, die nach "stop" gewartet wird, bevor der Prozess hart beendet wird
  stopTimeoutSec: 60,
  // Wie viele Log-Zeilen im Speicher gehalten werden
  maxLogLines: 2000,
};

let current = null;

function load() {
  let fromFile = {};
  if (fs.existsSync(CONFIG_PATH)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (err) {
      console.error('[config] config.json ist ungültig, verwende Standardwerte:', err.message);
    }
  }
  current = { ...DEFAULTS, ...fromFile };
  return current;
}

function get() {
  return current || load();
}

function update(partial) {
  partial = { ...partial };
  // Komplettpfad zur Server-Datei (z.B. aus dem "Öffnen"-Dialog) -> Ordner + Dateiname
  if (partial.serverFile !== undefined) {
    const file = String(partial.serverFile).trim().replace(/^"|"$/g, '');
    partial.serverDir = file ? path.dirname(path.resolve(file)) : '';
    partial.startFile = file ? path.basename(file) : DEFAULTS.startFile;
  }
  const next = { ...get() };
  for (const key of Object.keys(DEFAULTS)) {
    if (partial[key] === undefined) continue;
    const def = DEFAULTS[key];
    if (typeof def === 'number') {
      const n = Number(partial[key]);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`Ungültiger Wert für ${key}`);
      next[key] = n;
    } else {
      next[key] = String(partial[key]).trim();
    }
  }
  for (const key of ['modsFolder', 'disabledModsFolder']) {
    if (!next[key] || /[\\/]|\.\./.test(next[key])) {
      throw new Error(`${key} muss ein einfacher Ordnername sein`);
    }
  }
  if (next.modsFolder === next.disabledModsFolder) {
    throw new Error('Mod-Ordner und Ordner für deaktivierte Mods müssen verschieden sein');
  }
  current = next;
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(current, null, 2), 'utf8');
  return current;
}

// Abgeleitete, absolute Pfade
function paths() {
  const cfg = get();
  const serverDir = cfg.serverDir ? path.resolve(cfg.serverDir) : '';
  return {
    serverDir,
    serverFile: serverDir ? path.join(serverDir, cfg.startFile) : '',
    modsDir: serverDir ? path.join(serverDir, cfg.modsFolder) : '',
    disabledModsDir: serverDir ? path.join(serverDir, cfg.disabledModsFolder) : '',
    backupDir: cfg.backupDir ? path.resolve(cfg.backupDir) : path.join(ROOT_DIR, 'backups'),
  };
}

module.exports = { load, get, update, paths, DEFAULTS };
