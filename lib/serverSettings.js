// server.properties lesen/schreiben (Kommentare und Reihenfolge bleiben erhalten)
// inkl. deutscher Beschriftungen für alle bekannten Einstellungen.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const mc = require('./mcServer');

const GROUPS = [
  'Allgemein',
  'Spiel',
  'Welt',
  'Leistung',
  'Sicherheit & Rechte',
  'Ressourcenpaket',
  'Fernzugriff (RCON, Query, Management)',
  'Weitere',
];

const DIFFICULTY = [['peaceful', 'Friedlich'], ['easy', 'Einfach'], ['normal', 'Normal'], ['hard', 'Schwer']];
const GAMEMODE = [['survival', 'Überleben'], ['creative', 'Kreativ'], ['adventure', 'Abenteuer'], ['spectator', 'Zuschauer']];

// type: bool | int | text | select | secret
const DEFS = [
  // Allgemein
  { key: 'motd', label: 'Server-Beschreibung (MOTD)', type: 'text', group: 'Allgemein', desc: 'Text in der Serverliste. Farben mit § (z.B. §aGrün).' },
  { key: 'max-players', label: 'Maximale Spieler', type: 'int', min: 1, max: 1000, group: 'Allgemein' },
  { key: 'white-list', label: 'Whitelist aktiv', type: 'bool', group: 'Allgemein', desc: 'Nur Spieler auf der Whitelist dürfen joinen.' },
  { key: 'enforce-whitelist', label: 'Whitelist erzwingen', type: 'bool', group: 'Allgemein', desc: 'Spieler, die nicht (mehr) auf der Whitelist sind, werden sofort gekickt.' },
  { key: 'online-mode', label: 'Online-Modus (Premium-Accounts prüfen)', type: 'bool', group: 'Allgemein', desc: 'Aus = auch nicht gekaufte/gecrackte Accounts können joinen. Nicht empfohlen!' },
  { key: 'server-port', label: 'Server-Port', type: 'int', min: 1, max: 65535, group: 'Allgemein' },
  { key: 'server-ip', label: 'Server-IP (leer = alle)', type: 'text', group: 'Allgemein', desc: 'Normalerweise leer lassen.' },
  { key: 'hide-online-players', label: 'Online-Spieler in Serverliste verbergen', type: 'bool', group: 'Allgemein' },
  { key: 'enable-status', label: 'In Serverliste als online anzeigen', type: 'bool', group: 'Allgemein' },
  { key: 'bug-report-link', label: 'Link für Fehlerberichte', type: 'text', group: 'Allgemein' },

  // Spiel
  { key: 'difficulty', label: 'Schwierigkeit', type: 'select', options: DIFFICULTY, group: 'Spiel', live: true },
  { key: 'gamemode', label: 'Standard-Spielmodus', type: 'select', options: GAMEMODE, group: 'Spiel', live: true },
  { key: 'force-gamemode', label: 'Spielmodus beim Joinen erzwingen', type: 'bool', group: 'Spiel' },
  { key: 'hardcore', label: 'Hardcore (ein Leben)', type: 'bool', group: 'Spiel' },
  { key: 'pvp', label: 'PvP', type: 'bool', group: 'Spiel', desc: 'Ab 1.21.9 als Spielregel.' },
  { key: 'allow-nether', label: 'Nether erlauben', type: 'bool', group: 'Spiel', desc: 'Ab 1.21.9 als Spielregel.' },
  { key: 'allow-flight', label: 'Fliegen erlauben (Anti-Cheat aus)', type: 'bool', group: 'Spiel', desc: 'Nötig für Mods mit Flug/Jetpacks, sonst werden Spieler gekickt.' },
  { key: 'spawn-monsters', label: 'Monster spawnen', type: 'bool', group: 'Spiel' },
  { key: 'spawn-animals', label: 'Tiere spawnen', type: 'bool', group: 'Spiel' },
  { key: 'spawn-npcs', label: 'Dorfbewohner spawnen', type: 'bool', group: 'Spiel' },
  { key: 'spawn-protection', label: 'Spawn-Schutz (Radius in Blöcken)', type: 'int', min: 0, max: 1000, group: 'Spiel', desc: '0 = aus. Gilt nicht für OPs.' },
  { key: 'player-idle-timeout', label: 'AFK-Kick nach Minuten (0 = nie)', type: 'int', min: 0, max: 100000, group: 'Spiel' },
  { key: 'max-world-size', label: 'Maximale Weltgröße (Radius)', type: 'int', min: 1, max: 29999984, group: 'Spiel' },
  { key: 'max-build-height', label: 'Maximale Bauhöhe', type: 'int', min: 64, max: 4096, group: 'Spiel' },
  { key: 'announce-player-achievements', label: 'Erfolge ankündigen', type: 'bool', group: 'Spiel' },
  { key: 'enable-command-block', label: 'Befehlsblöcke aktivieren', type: 'bool', group: 'Spiel' },

  // Welt
  { key: 'level-name', label: 'Welt-Ordner', type: 'text', group: 'Welt', desc: 'Anderer Name = andere/neue Welt.' },
  { key: 'level-seed', label: 'Seed (nur für neue Welten)', type: 'text', group: 'Welt' },
  {
    key: 'level-type', label: 'Welttyp (nur für neue Welten)', type: 'select', group: 'Welt',
    options: [['minecraft:normal', 'Normal'], ['minecraft:flat', 'Flachland'], ['minecraft:large_biomes', 'Große Biome'], ['minecraft:amplified', 'Zerklüftet (Amplified)'], ['minecraft:single_biome_surface', 'Ein Biom']],
  },
  { key: 'generate-structures', label: 'Strukturen generieren (Dörfer etc.)', type: 'bool', group: 'Welt' },
  { key: 'generator-settings', label: 'Generator-Einstellungen (JSON)', type: 'text', group: 'Welt' },
  { key: 'initial-enabled-packs', label: 'Aktive Datenpakete (neue Welt)', type: 'text', group: 'Welt' },
  { key: 'initial-disabled-packs', label: 'Deaktivierte Datenpakete (neue Welt)', type: 'text', group: 'Welt' },

  // Leistung
  { key: 'view-distance', label: 'Sichtweite (Chunks)', type: 'int', min: 3, max: 32, group: 'Leistung', desc: 'Weniger = weniger Last.' },
  { key: 'simulation-distance', label: 'Simulationsdistanz (Chunks)', type: 'int', min: 3, max: 32, group: 'Leistung', desc: 'In diesem Radius laufen Farmen, Mobs, Redstone.' },
  { key: 'entity-broadcast-range-percentage', label: 'Sichtweite für Kreaturen (%)', type: 'int', min: 10, max: 1000, group: 'Leistung' },
  { key: 'pause-when-empty-seconds', label: 'Server pausieren wenn leer (Sekunden)', type: 'int', min: 0, max: 100000, group: 'Leistung', desc: '0 = nie pausieren.' },
  { key: 'max-tick-time', label: 'Watchdog: max. Tick-Zeit (ms, -1 = aus)', type: 'int', min: -1, max: 100000000, group: 'Leistung', desc: 'Bei großen Modpacks ggf. auf -1 setzen, damit der Server nicht abstürzt.' },
  { key: 'network-compression-threshold', label: 'Netzwerk-Kompression ab Bytes', type: 'int', min: -1, max: 100000, group: 'Leistung' },
  { key: 'sync-chunk-writes', label: 'Chunks synchron speichern', type: 'bool', group: 'Leistung' },
  { key: 'use-native-transport', label: 'Optimierte Netzwerk-Übertragung (Linux)', type: 'bool', group: 'Leistung' },
  { key: 'rate-limit', label: 'Paket-Limit pro Sekunde (0 = aus)', type: 'int', min: 0, max: 100000, group: 'Leistung' },
  { key: 'region-file-compression', label: 'Kompression der Weltdateien', type: 'select', options: [['deflate', 'deflate (Standard)'], ['lz4', 'lz4 (schneller, größer)'], ['none', 'keine']], group: 'Leistung' },
  { key: 'max-chained-neighbor-updates', label: 'Max. verkettete Block-Updates', type: 'int', min: -1, max: 100000000, group: 'Leistung' },

  // Sicherheit & Rechte
  { key: 'op-permission-level', label: 'Standard-Rechtestufe für OPs (1–4)', type: 'int', min: 1, max: 4, group: 'Sicherheit & Rechte' },
  { key: 'function-permission-level', label: 'Rechtestufe für Funktionen (1–4)', type: 'int', min: 1, max: 4, group: 'Sicherheit & Rechte' },
  { key: 'enforce-secure-profile', label: 'Signierte Chat-Nachrichten verlangen', type: 'bool', group: 'Sicherheit & Rechte' },
  { key: 'prevent-proxy-connections', label: 'VPN/Proxy-Verbindungen blockieren', type: 'bool', group: 'Sicherheit & Rechte' },
  { key: 'log-ips', label: 'Spieler-IPs ins Log schreiben', type: 'bool', group: 'Sicherheit & Rechte', desc: 'Wird für Ping-Anzeige und Verbindungsversuche gebraucht.' },
  { key: 'broadcast-console-to-ops', label: 'Konsolenbefehle an OPs anzeigen', type: 'bool', group: 'Sicherheit & Rechte' },
  { key: 'broadcast-rcon-to-ops', label: 'RCON-Befehle an OPs anzeigen', type: 'bool', group: 'Sicherheit & Rechte' },
  { key: 'enable-code-of-conduct', label: 'Verhaltensregeln beim Joinen anzeigen', type: 'bool', group: 'Sicherheit & Rechte' },
  { key: 'accepts-transfers', label: 'Weiterleitungen von anderen Servern annehmen', type: 'bool', group: 'Sicherheit & Rechte' },
  { key: 'text-filtering-config', label: 'Textfilter-Konfiguration', type: 'text', group: 'Sicherheit & Rechte' },
  { key: 'text-filtering-version', label: 'Textfilter-Version', type: 'int', min: 0, max: 10, group: 'Sicherheit & Rechte' },

  // Ressourcenpaket
  { key: 'resource-pack', label: 'Ressourcenpaket-URL', type: 'text', group: 'Ressourcenpaket' },
  { key: 'resource-pack-sha1', label: 'SHA-1 Prüfsumme', type: 'text', group: 'Ressourcenpaket' },
  { key: 'resource-pack-id', label: 'Paket-ID (UUID)', type: 'text', group: 'Ressourcenpaket' },
  { key: 'resource-pack-prompt', label: 'Hinweistext beim Download', type: 'text', group: 'Ressourcenpaket' },
  { key: 'require-resource-pack', label: 'Ressourcenpaket erzwingen', type: 'bool', group: 'Ressourcenpaket' },

  // Fernzugriff
  { key: 'enable-rcon', label: 'RCON aktivieren', type: 'bool', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'rcon.port', label: 'RCON-Port', type: 'int', min: 1, max: 65535, group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'rcon.password', label: 'RCON-Passwort', type: 'secret', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'enable-query', label: 'Query aktivieren', type: 'bool', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'query.port', label: 'Query-Port', type: 'int', min: 1, max: 65535, group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'enable-jmx-monitoring', label: 'JMX-Monitoring', type: 'bool', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'status-heartbeat-interval', label: 'Status-Heartbeat-Intervall', type: 'int', min: 0, max: 100000, group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'management-server-enabled', label: 'Management-Server aktivieren', type: 'bool', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'management-server-host', label: 'Management-Server Host', type: 'text', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'management-server-port', label: 'Management-Server Port', type: 'int', min: 0, max: 65535, group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'management-server-secret', label: 'Management-Server Secret', type: 'secret', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'management-server-tls-enabled', label: 'Management-Server TLS', type: 'bool', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'management-server-tls-keystore', label: 'TLS-Keystore', type: 'text', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'management-server-tls-keystore-password', label: 'TLS-Keystore-Passwort', type: 'secret', group: 'Fernzugriff (RCON, Query, Management)' },
  { key: 'management-server-allowed-origins', label: 'Erlaubte Origins', type: 'text', group: 'Fernzugriff (RCON, Query, Management)' },
];
const DEF_BY_KEY = new Map(DEFS.map((d) => [d.key, d]));

// ---------- Java-Properties-Format ----------
function unescape(s) {
  return s.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, c) => {
    if (c[0] === 'u' && c.length === 5) return String.fromCharCode(parseInt(c.slice(1), 16));
    return { t: '\t', n: '\n', r: '\r', f: '\f' }[c] ?? c;
  });
}

function escapeValue(v) {
  let out = '';
  for (let i = 0; i < v.length; i++) {
    const ch = v[i];
    const c = v.charCodeAt(i);
    if (ch === '\\') out += '\\\\';
    else if (':=#!'.includes(ch)) out += '\\' + ch;
    else if (ch === '\n') out += '\\n';
    else if (ch === '\r') out += '\\r';
    else if (ch === '\t') out += '\\t';
    else if (c < 0x20 || c > 0x7e) out += '\\u' + c.toString(16).toUpperCase().padStart(4, '0');
    else out += ch;
  }
  return out;
}

const LINE_RE = /^\s*((?:\\.|[^=:\s\\])+)\s*[=:]?\s*(.*)$/;

function filePath() {
  const { serverDir } = config.paths();
  if (!serverDir || !fs.existsSync(serverDir)) {
    throw Object.assign(new Error('Kein Server ausgewählt.'), { status: 400 });
  }
  return path.join(serverDir, 'server.properties');
}

function readMap(serverDir) {
  const map = {};
  let text;
  try {
    text = fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8');
  } catch (_) {
    return map;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*([#!]|$)/.test(line)) continue;
    const m = line.match(LINE_RE);
    if (m) map[unescape(m[1])] = unescape(m[2]);
  }
  return map;
}

function writeValues(file, values) {
  let lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/) : [];
  const done = new Set();
  lines = lines.map((line) => {
    if (/^\s*([#!]|$)/.test(line)) return line;
    const m = line.match(LINE_RE);
    if (!m) return line;
    const key = unescape(m[1]);
    if (!(key in values)) return line;
    done.add(key);
    return `${m[1]}=${escapeValue(String(values[key]))}`;
  });
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  for (const [k, v] of Object.entries(values)) if (!done.has(k)) lines.push(`${k}=${escapeValue(String(v))}`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
}

// ---------- API ----------
function list() {
  const file = filePath();
  const exists = fs.existsSync(file);
  const map = exists ? readMap(path.dirname(file)) : {};
  const groups = GROUPS.map((name) => ({ name, items: [] }));
  const byName = new Map(groups.map((g) => [g.name, g]));

  // Bekannte Einstellungen in fester Reihenfolge, nur wenn in dieser Version vorhanden
  for (const d of DEFS) if (d.key in map) byName.get(d.group).items.push({ ...d, value: map[d.key] });
  for (const [key, value] of Object.entries(map)) {
    if (!DEF_BY_KEY.has(key)) byName.get('Weitere').items.push({ key, label: key, type: guessType(value), group: 'Weitere', value });
  }
  return { exists, running: mc.status !== 'offline', groups: groups.filter((g) => g.items.length) };
}

function guessType(v) {
  if (v === 'true' || v === 'false') return 'bool';
  if (/^-?\d+$/.test(v)) return 'int';
  return 'text';
}

function validate(key, value, current) {
  const d = DEF_BY_KEY.get(key) || { key, type: guessType(current ?? '') };
  const v = String(value ?? '');
  if (/[\r\n]/.test(v)) throw new Error(`${d.label || key}: Zeilenumbrüche sind nicht erlaubt.`);
  if (d.type === 'bool' && v !== 'true' && v !== 'false') throw new Error(`${d.label || key}: muss an oder aus sein.`);
  if (d.type === 'int') {
    if (!/^-?\d+$/.test(v)) throw new Error(`${d.label || key}: muss eine ganze Zahl sein.`);
    const n = Number(v);
    if ((d.min !== undefined && n < d.min) || (d.max !== undefined && n > d.max)) {
      throw new Error(`${d.label || key}: erlaubt ist ${d.min} bis ${d.max}.`);
    }
  }
  if (d.type === 'select' && !d.options.some(([o]) => o === v)) throw new Error(`${d.label || key}: ungültige Auswahl.`);
  return v;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function save(values) {
  const file = filePath();
  const current = readMap(path.dirname(file));
  const changes = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!/^[\w.-]+$/.test(k)) throw new Error(`Ungültiger Schlüssel: ${k}`);
    const val = validate(k, v, current[k]);
    if (current[k] !== val) changes[k] = val;
  }
  const keys = Object.keys(changes);
  if (!keys.length) return { changed: [], live: [], restartRequired: false };

  // Bei laufendem Server: was geht, sofort per Befehl übernehmen
  const live = [];
  if (mc.status === 'running') {
    const cmds = {
      'white-list': (v) => `whitelist ${v === 'true' ? 'on' : 'off'}`,
      difficulty: (v) => `difficulty ${v}`,
      gamemode: (v) => `defaultgamemode ${v}`,
    };
    for (const k of keys) {
      if (!cmds[k]) continue;
      mc.sendCommand(cmds[k](changes[k]));
      live.push(k);
    }
    // Der Server schreibt z.B. bei "whitelist on" selbst in server.properties -> danach unsere Werte schreiben
    if (live.length) await sleep(800);
  }
  writeValues(file, changes);
  mc.log(`server.properties geändert: ${keys.map((k) => `${k}=${changes[k]}`).join(', ')}`);
  const restartRequired = mc.status !== 'offline' && keys.some((k) => !live.includes(k));
  return { changed: keys, live, restartRequired };
}

module.exports = { list, save, readMap, writeValues };
