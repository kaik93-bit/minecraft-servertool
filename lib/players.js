// Spielerverwaltung: bekannte/online/offline Spieler, Whitelist, OP, Bann, Kick
// und abgewiesene Verbindungsversuche.
//
// Läuft der Server: Aktionen werden als Konsolenbefehl gesendet (whitelist add, op, ban ...).
// Ist er offline: die JSON-Dateien des Servers (whitelist.json, ops.json, ...) werden direkt bearbeitet.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const mc = require('./mcServer');
const { httpError } = require('./mods');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ATTEMPTS_FILE = path.join(DATA_DIR, 'attempts.json');
const NAME_RE = /^[A-Za-z0-9_.]{1,16}$/;

// ---------- Hilfsfunktionen ----------
function serverDirOrThrow() {
  const { serverDir } = config.paths();
  if (!serverDir || !fs.existsSync(serverDir)) throw httpError(400, 'Kein Server ausgewählt.');
  return serverDir;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function readProps(serverDir) {
  const props = {};
  try {
    for (const line of fs.readFileSync(path.join(serverDir, 'server.properties'), 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
      if (m) props[m[1].trim()] = m[2].trim();
    }
  } catch (_) {
    /* fehlt beim allerersten Start */
  }
  return props;
}

function setProp(serverDir, key, value) {
  const file = path.join(serverDir, 'server.properties');
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const re = new RegExp(`^${key.replace(/[.-]/g, '\\$&')}=.*$`, 'm');
  text = re.test(text) ? text.replace(re, `${key}=${value}`) : `${text.replace(/\s*$/, '\n')}${key}=${value}\n`;
  fs.writeFileSync(file, text, 'utf8');
}

function dashUuid(id) {
  const h = String(id).replace(/-/g, '').toLowerCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

// UUID, die ein Server mit online-mode=false für diesen Namen vergibt
function offlineUuid(name) {
  const b = crypto.createHash('md5').update(`OfflinePlayer:${name}`).digest();
  b[6] = (b[6] & 0x0f) | 0x30;
  b[8] = (b[8] & 0x3f) | 0x80;
  return dashUuid(b.toString('hex'));
}

function banDate(d = new Date()) {
  const p = (n) => String(Math.abs(n)).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${off >= 0 ? '+' : '-'}${p(Math.floor(Math.abs(off) / 60))}${p(Math.abs(off) % 60)}`;
}

const sameName = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- Verbindungsversuche ----------
let attempts = readJson(ATTEMPTS_FILE, []);

function saveAttempts() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  writeJson(ATTEMPTS_FILE, attempts);
}

function recordAttempt(a) {
  let entry = attempts.find((x) => sameName(x.name, a.name));
  if (!entry) {
    entry = { name: a.name, count: 0, firstAt: a.at };
    attempts.unshift(entry);
  }
  Object.assign(entry, {
    uuid: a.uuid || entry.uuid || null,
    ip: a.ip || entry.ip || null,
    reason: a.reason,
    message: a.message,
    lastAt: a.at,
    count: entry.count + 1,
  });
  attempts.sort((x, y) => y.lastAt - x.lastAt);
  attempts = attempts.slice(0, 200);
  saveAttempts();
  return entry;
}

function listAttempts() {
  return attempts;
}

function dismissAttempt(name) {
  attempts = name ? attempts.filter((a) => !sameName(a.name, name)) : [];
  saveAttempts();
}

// ---------- Spielerliste ----------
function list() {
  const serverDir = serverDirOrThrow();
  const props = readProps(serverDir);
  const level = props['level-name'] || 'world';
  const file = (f) => path.join(serverDir, f);

  const map = new Map();
  const get = (name, uuid) => {
    const key = String(name).toLowerCase();
    if (!map.has(key)) {
      map.set(key, { name, uuid: null, online: false, ping: null, op: false, opLevel: null, whitelisted: false, banned: false, banReason: null, lastSeen: null });
    }
    const p = map.get(key);
    if (uuid && !p.uuid) p.uuid = uuid;
    return p;
  };

  for (const e of readJson(file('usercache.json'), [])) if (e.name) get(e.name, e.uuid);
  for (const e of readJson(file('whitelist.json'), [])) if (e.name) get(e.name, e.uuid).whitelisted = true;
  for (const e of readJson(file('ops.json'), [])) {
    if (!e.name) continue;
    const p = get(e.name, e.uuid);
    p.op = true;
    p.opLevel = e.level ?? null;
  }
  for (const e of readJson(file('banned-players.json'), [])) {
    if (!e.name) continue;
    const p = get(e.name, e.uuid);
    p.banned = true;
    p.banReason = e.reason || null;
  }

  const state = mc.getState();
  for (const o of state.players) {
    const p = get(o.name);
    p.online = true;
    p.ping = o.ping;
    p.lastSeen = Date.now();
  }

  // "Zuletzt gesehen" = letzte Speicherung der Spielerdaten in der Welt
  for (const p of map.values()) {
    if (p.online || !p.uuid) continue;
    try {
      p.lastSeen = fs.statSync(path.join(serverDir, level, 'playerdata', `${p.uuid}.dat`)).mtimeMs;
    } catch (_) {
      /* Spieler war nie in dieser Welt */
    }
  }

  const players = [...map.values()].sort(
    (a, b) => b.online - a.online || (b.lastSeen || 0) - (a.lastSeen || 0) || a.name.localeCompare(b.name)
  );
  return {
    players,
    whitelistEnabled: props['white-list'] === 'true',
    onlineMode: props['online-mode'] !== 'false',
    serverStatus: mc.status,
    maxPlayers: state.maxPlayers || Number(props['max-players']) || null,
  };
}

// UUID für Dateibearbeitung (Server offline) ermitteln
async function resolveUuid(serverDir, name, hint) {
  if (hint && /^[0-9a-f]{32}$/i.test(String(hint).replace(/-/g, ''))) return { uuid: dashUuid(hint), name };
  const known = [
    ...readJson(path.join(serverDir, 'usercache.json'), []),
    ...readJson(path.join(serverDir, 'whitelist.json'), []),
    ...readJson(path.join(serverDir, 'ops.json'), []),
    ...readJson(path.join(serverDir, 'banned-players.json'), []),
    ...attempts,
  ].find((e) => e.uuid && sameName(e.name, name));
  if (known) return { uuid: dashUuid(known.uuid), name: known.name };

  if (readProps(serverDir)['online-mode'] === 'false') return { uuid: offlineUuid(name), name };

  let res;
  try {
    res = await fetch(`https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`, {
      signal: AbortSignal.timeout(6000),
    });
  } catch (_) {
    throw httpError(502, 'Mojang-Server nicht erreichbar – UUID konnte nicht ermittelt werden.');
  }
  if (res.status === 404 || res.status === 204) throw httpError(404, `Es gibt keinen Minecraft-Account "${name}".`);
  if (!res.ok) throw httpError(502, `Mojang-API Fehler (${res.status}).`);
  const data = await res.json();
  return { uuid: dashUuid(data.id), name: data.name };
}

function upsert(file, uuid, entry) {
  const arr = readJson(file, []).filter((e) => !(e.uuid && dashUuid(e.uuid) === uuid) && !sameName(e.name, entry.name));
  arr.push({ uuid, ...entry });
  writeJson(file, arr);
}

function removeEntry(file, name) {
  writeJson(file, readJson(file, []).filter((e) => !sameName(e.name, name)));
}

const ACTIONS = ['whitelist-add', 'whitelist-remove', 'op', 'deop', 'ban', 'pardon', 'kick', 'message', 'gamemode'];
const GAMEMODES = ['survival', 'creative', 'adventure', 'spectator'];
const ONLINE_ONLY = { kick: 'Kicken', message: 'Nachrichten senden', gamemode: 'Spielmodus ändern' };

async function action(name, act, { reason, uuid, mode } = {}) {
  name = String(name || '').trim();
  if (!NAME_RE.test(name)) throw httpError(400, `Ungültiger Spielername: "${name}"`);
  if (!ACTIONS.includes(act)) throw httpError(400, `Unbekannte Aktion: ${act}`);
  const serverDir = serverDirOrThrow();
  const why = String(reason || '').replace(/[\r\n]+/g, ' ').trim();
  if (act === 'message' && !why) throw httpError(400, 'Bitte eine Nachricht eingeben.');
  if (act === 'gamemode' && !GAMEMODES.includes(mode)) throw httpError(400, 'Ungültiger Spielmodus.');
  if (ONLINE_ONLY[act] && mc.status !== 'running') {
    throw httpError(409, `${ONLINE_ONLY[act]} geht nur, wenn der Server läuft.`);
  }

  const offlineMode = readProps(serverDir)['online-mode'] === 'false';
  if (mc.status === 'running' && act === 'whitelist-add' && offlineMode) {
    // Vanilla holt bei "whitelist add" auch im Offline-Modus die Mojang-UUID – der Spieler
    // meldet sich aber mit der Offline-UUID an und käme so nicht rein. Daher direkt eintragen.
    const real = attempts.find((a) => sameName(a.name, name))?.name || name;
    upsert(path.join(serverDir, 'whitelist.json'), offlineUuid(real), { name: real });
    mc.log(`> whitelist reload (${real} mit Offline-UUID eingetragen)`);
    mc.sendCommand('whitelist reload');
    await sleep(500);
  } else if (mc.status === 'running') {
    const cmd = {
      'whitelist-add': `whitelist add ${name}`,
      'whitelist-remove': `whitelist remove ${name}`,
      op: `op ${name}`,
      deop: `deop ${name}`,
      ban: `ban ${name}${why ? ' ' + why : ''}`,
      pardon: `pardon ${name}`,
      kick: `kick ${name}${why ? ' ' + why : ''}`,
      message: `tell ${name} ${why}`,
      gamemode: `gamemode ${mode} ${name}`,
    }[act];
    mc.log(`> ${cmd}`);
    mc.sendCommand(cmd);
    await sleep(700); // Server schreibt die JSON-Dateien kurz darauf
  } else if (mc.status !== 'offline') {
    throw httpError(409, 'Der Server startet bzw. stoppt gerade – bitte kurz warten.');
  } else {
    const file = (f) => path.join(serverDir, f);
    const attemptUuid = attempts.find((a) => sameName(a.name, name))?.uuid;
    const needUuid = ['whitelist-add', 'op', 'ban'].includes(act);
    const prof = needUuid ? await resolveUuid(serverDir, name, uuid || attemptUuid) : null;

    if (act === 'whitelist-add') upsert(file('whitelist.json'), prof.uuid, { name: prof.name });
    if (act === 'whitelist-remove') removeEntry(file('whitelist.json'), name);
    if (act === 'op') upsert(file('ops.json'), prof.uuid, { name: prof.name, level: 4, bypassesPlayerLimit: false });
    if (act === 'deop') removeEntry(file('ops.json'), name);
    if (act === 'ban') {
      upsert(file('banned-players.json'), prof.uuid, {
        name: prof.name,
        created: banDate(),
        source: 'Servertool',
        expires: 'forever',
        reason: why || 'Banned by an operator.',
      });
    }
    if (act === 'pardon') removeEntry(file('banned-players.json'), name);
    mc.log(`Spieler ${name}: ${act} (Datei bearbeitet, Server offline)`);
  }

  // Erledigte Verbindungsversuche aus der Liste nehmen
  const done = { 'whitelist-add': 'whitelist', pardon: 'banned' }[act];
  if (done && attempts.some((a) => sameName(a.name, name) && a.reason === done)) dismissAttempt(name);
}

async function setWhitelistEnabled(enabled) {
  const serverDir = serverDirOrThrow();
  if (mc.status === 'running') {
    mc.sendCommand(`whitelist ${enabled ? 'on' : 'off'}`);
    await sleep(700);
  } else if (mc.status !== 'offline') {
    throw httpError(409, 'Der Server startet bzw. stoppt gerade – bitte kurz warten.');
  }
  // Auch in server.properties festhalten (gilt für den nächsten Start)
  setProp(serverDir, 'white-list', enabled ? 'true' : 'false');
}

module.exports = { list, action, setWhitelistEnabled, recordAttempt, listAttempts, dismissAttempt };
