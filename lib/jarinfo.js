// Liest Mod-Infos (ID, Name, Version, Beschreibung, MC-Version, Loader) direkt aus einer .jar-Datei.
// Unterstützt Forge (META-INF/mods.toml), NeoForge (META-INF/neoforge.mods.toml) und Fabric (fabric.mod.json).
// Kleiner ZIP-Leser ohne Zusatzpakete: Zentralverzeichnis lesen, Eintrag mit zlib entpacken.
const fs = require('fs');
const zlib = require('zlib');

function readEntries(buf) {
  // "End of central directory" suchen (max. 64 KB Kommentar am Ende)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Keine gültige ZIP/JAR-Datei.');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count && buf.readUInt32LE(p) === 0x02014b50; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    entries.set(name, { method, csize, local });
    p += 46 + nlen + elen + clen;
  }
  return entries;
}

function readEntry(buf, e) {
  const nlen = buf.readUInt16LE(e.local + 26);
  const elen = buf.readUInt16LE(e.local + 28);
  const start = e.local + 30 + nlen + elen;
  const data = buf.subarray(start, start + e.csize);
  if (e.method === 0) return data.toString('utf8');
  if (e.method === 8) return zlib.inflateRawSync(data).toString('utf8');
  throw new Error('Unbekannte Komprimierung');
}

// Sehr einfacher TOML-Leser – reicht für die Felder in mods.toml
function tomlValue(block, key) {
  const multi = block.match(new RegExp(`^\\s*${key}\\s*=\\s*'''([\\s\\S]*?)'''`, 'm'));
  if (multi) return multi[1].trim();
  const m = block.match(new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm')) || block.match(new RegExp(`^\\s*${key}\\s*=\\s*'([^']*)'`, 'm'));
  return m ? m[1].replace(/\\"/g, '"').trim() : null;
}

function parseModsToml(text, loader) {
  const modsBlock = (text.split(/^\s*\[\[mods\]\]\s*$/m)[1] || '').split(/^\s*\[/m)[0];
  const id = tomlValue(modsBlock, 'modId');
  if (!id) return null;
  // minecraft-Abhängigkeit für die MC-Version
  let mc = null;
  for (const dep of text.split(/^\s*\[\[dependencies\.[^\]]+\]\]\s*$/m).slice(1)) {
    if (tomlValue(dep, 'modId') === 'minecraft') {
      mc = tomlValue(dep, 'versionRange');
      break;
    }
  }
  const displayTest = tomlValue(modsBlock, 'displayTest') || tomlValue(text, 'displayTest');
  return {
    id,
    name: tomlValue(modsBlock, 'displayName') || id,
    version: tomlValue(modsBlock, 'version'),
    description: tomlValue(modsBlock, 'description') || '',
    authors: tomlValue(modsBlock, 'authors') || tomlValue(text, 'authors') || '',
    mc: mcFromRange(mc),
    mcRange: mc || null,
    loader,
    serverOnly: /IGNORE_ALL_VERSION|IGNORE_SERVER_VERSION/.test(displayTest || ''),
  };
}

// Fabric: ">=1.21.11 <1.22", "~1.21.11", "1.21.x", ["1.21.10","1.21.11"] -> Maven-Bereich
function fabricRange(dep) {
  if (!dep) return null;
  const list = Array.isArray(dep) ? dep : [dep];
  const parts = [];
  for (const d of list) {
    const s = String(d).trim();
    let m;
    if ((m = s.match(/^>=s*([d.]+)s*<s*([d.]+)$/))) parts.push(`[${m[1]},${m[2]})`);
    else if ((m = s.match(/^>=s*([d.]+)$/))) parts.push(`[${m[1]},)`);
    else if ((m = s.match(/^~s*(d+).(d+)(?:.(d+))?$/))) parts.push(`[${m[1]}.${m[2]}${m[3] ? '.' + m[3] : ''},${m[1]}.${Number(m[2]) + 1})`);
    else if ((m = s.match(/^(d+).(d+).[x*]$/))) parts.push(`[${m[1]}.${m[2]},${m[1]}.${Number(m[2]) + 1})`);
    else if ((m = s.match(/^d+.d+(?:.d+)?$/))) parts.push(`[${s}]`);
    else if (s === '*') parts.push('[0,)');
  }
  return parts.length ? parts.join(',') : null;
}

// "[1.21.11,1.22)" -> "1.21.11"
function mcFromRange(range) {
  if (!range) return null;
  const m = String(range).match(/\d+\.\d+(?:\.\d+)?/);
  return m ? m[0] : null;
}

function readJarInfo(file) {
  const buf = fs.readFileSync(file);
  const entries = readEntries(buf);
  for (const [entry, loader] of [
    ['META-INF/neoforge.mods.toml', 'neoforge'],
    ['META-INF/mods.toml', 'forge'],
  ]) {
    if (entries.has(entry)) {
      const info = parseModsToml(readEntry(buf, entries.get(entry)), loader);
      if (info) return info;
    }
  }
  if (entries.has('fabric.mod.json')) {
    const j = JSON.parse(readEntry(buf, entries.get('fabric.mod.json')));
    return {
      id: j.id,
      name: j.name || j.id,
      version: j.version,
      description: j.description || '',
      authors: (j.authors || []).map((a) => (typeof a === 'string' ? a : a.name)).join(', '),
      mc: mcFromRange(j.depends && j.depends.minecraft),
      mcRange: fabricRange(j.depends && j.depends.minecraft),
      loader: 'fabric',
      serverOnly: j.environment === 'server',
    };
  }
  return null;
}

// Cache: Datei wird nur neu gelesen, wenn sie sich geändert hat
const cache = new Map();
function jarInfo(file) {
  try {
    const st = fs.statSync(file);
    const key = `${st.size}:${st.mtimeMs}`;
    const c = cache.get(file);
    if (c && c.key === key) return c.info;
    let info = null;
    try {
      info = readJarInfo(file);
    } catch (_) {
      info = null;
    }
    cache.set(file, { key, info });
    return info;
  } catch (_) {
    return null;
  }
}

// Einzelne Textdatei aus einer ZIP/JAR lesen (z.B. version.json aus der Vanilla-server.jar)
function readZipText(file, entry) {
  try {
    const buf = fs.readFileSync(file);
    const e = readEntries(buf).get(entry);
    return e ? readEntry(buf, e) : null;
  } catch (_) {
    return null;
  }
}

module.exports = { jarInfo, readJarInfo, readZipText };
