// Eigene Mods von GitHub: alle 5 Minuten nach neuen Versionen suchen, Updates installieren
// und noch nicht installierte Mods zum Installieren anbieten.
// Quelle: ein GitHub-Repository (package.json "modsRepo"), jede Mod-Version = ein Release mit der .jar.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const mc = require('./mcServer');
const { jarInfo } = require('./jarinfo');

const APP_DIR = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const REPO = PKG.modsRepo || null;
const API = process.env.MCST_UPDATE_API || 'https://api.github.com';
const CHECK_EVERY_MS = Number(process.env.MCST_MOD_CHECK_MS) || 5 * 60 * 1000;
const DATA_DIR = path.join(APP_DIR, 'data');
const SETTINGS_FILE = path.join(DATA_DIR, 'mod-updates.json');
const DOWNLOAD_DIR = path.join(DATA_DIR, 'mod-downloads');
const BACKUP_DIR = path.join(DATA_DIR, 'mod-backups');

const state = { status: 'idle', error: null, checkedAt: null, releases: [], etag: null, busy: new Set() };

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.+-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

// ---------- Einstellungen & ausstehende Updates (pro Server-Ordner) ----------
function readAll() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}
function writeAll(all) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(all, null, 2), 'utf8');
}
function settings() {
  const all = readAll();
  return { auto: all.auto !== false };
}
function pendingList() {
  return readAll().pending?.[config.paths().serverDir || ''] || [];
}
function setPending(list) {
  const all = readAll();
  all.pending = all.pending || {};
  all.pending[config.paths().serverDir || ''] = list;
  writeAll(all);
}

// ---------- Katalog von GitHub ----------
// Release-Text enthält unsichtbar: <!-- servertool-mod {"id":...,"version":...} -->
function parseRelease(rel) {
  if (rel.draft) return null;
  const jar = (rel.assets || []).find((a) => /\.jar$/i.test(a.name));
  if (!jar) return null;
  let meta = {};
  const m = String(rel.body || '').match(/<!--\s*servertool-mod\s*(\{[\s\S]*?\})\s*-->/);
  if (m) {
    try {
      meta = JSON.parse(m[1]);
    } catch (_) {
      meta = {};
    }
  }
  if (!meta.id || !meta.version) {
    const t = String(rel.tag_name || '').match(/^(.+?)-v?(\d[\w.+-]*)$/);
    if (!t) return null;
    meta = { id: t[1], version: t[2], name: t[1], ...meta };
  }
  const notes = String(rel.body || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .trim();
  return {
    id: meta.id,
    version: meta.version,
    name: meta.name || meta.id,
    description: meta.description || '',
    mc: meta.mc || null,
    loader: meta.loader || null,
    serverOnly: !!meta.serverOnly,
    notes,
    asset: { name: jar.name, url: jar.browser_download_url, size: jar.size },
    publishedAt: rel.published_at,
  };
}

async function fetchReleases() {
  const headers = { 'User-Agent': 'Minecraft-Servertool', Accept: 'application/vnd.github+json' };
  if (state.etag) headers['If-None-Match'] = state.etag; // 304 zählt nicht gegen das API-Limit
  const res = await fetch(`${API}/repos/${REPO}/releases?per_page=100`, { headers, signal: AbortSignal.timeout(20000) });
  if (res.status === 304) return state.releases;
  if (res.status === 404) return [];
  if (res.status === 403 || res.status === 429) throw new Error('GitHub-Abfragelimit erreicht – nächster Versuch in ein paar Minuten.');
  if (!res.ok) throw new Error(`GitHub antwortet mit Fehler ${res.status}.`);
  state.etag = res.headers.get('etag');
  const rels = (await res.json()).map(parseRelease).filter(Boolean);
  return rels;
}

// Neueste Version je Mod
function latestById() {
  const map = new Map();
  for (const r of state.releases) {
    const cur = map.get(r.id);
    if (!cur || cmpVersion(r.version, cur.version) > 0) map.set(r.id, r);
  }
  return map;
}

// ---------- installierte Mods ----------
function installed() {
  const { modsDir, disabledModsDir, serverDir } = config.paths();
  if (!serverDir || !fs.existsSync(serverDir)) return [];
  const out = [];
  for (const [dir, enabled] of [
    [modsDir, true],
    [disabledModsDir, false],
  ]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!/\.jar$/i.test(f)) continue;
      out.push({ file: f, dir, enabled, info: jarInfo(path.join(dir, f)) });
    }
  }
  return out;
}

// Minecraft-Version & Loader des Servers erkennen (für Kompatibilitätshinweise)
function serverEnv() {
  const { serverDir } = config.paths();
  let mcVersion = null;
  let loader = null;
  try {
    const perf = require('./perf').getState();
    if (perf.version) mcVersion = (String(perf.version).match(/\d+\.\d+(?:\.\d+)?/) || [null])[0];
  } catch (_) {
    /* egal */
  }
  if (serverDir) {
    const forgeDir = path.join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge');
    const neoDir = path.join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge');
    if (fs.existsSync(neoDir)) loader = 'neoforge';
    else if (fs.existsSync(forgeDir)) {
      loader = 'forge';
      if (!mcVersion) {
        const v = fs.readdirSync(forgeDir)[0];
        if (v) mcVersion = v.split('-')[0];
      }
    } else if (fs.existsSync(path.join(serverDir, '.fabric')) || fs.existsSync(path.join(serverDir, 'fabric-server-launch.jar'))) loader = 'fabric';
  }
  return { mcVersion, loader };
}

function status() {
  const latest = latestById();
  const inst = installed();
  const pend = pendingList();
  const env = serverEnv();
  const mods = [];
  for (const [id, rel] of latest) {
    const i = inst.find((x) => x.info && x.info.id === id);
    const p = pend.find((x) => x.id === id);
    const compatible = !(env.mcVersion && rel.mc && rel.mc !== env.mcVersion) && !(env.loader && rel.loader && rel.loader !== env.loader);
    mods.push({
      ...rel,
      installed: !!i,
      installedVersion: i ? i.info.version : null,
      installedFile: i ? i.file : null,
      enabled: i ? i.enabled : null,
      updateAvailable: !!i && cmpVersion(rel.version, i.info.version) > 0,
      pendingVersion: p ? p.version : null,
      busy: state.busy.has(id),
      compatible,
    });
  }
  mods.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  return {
    repo: REPO,
    status: state.status,
    error: state.error,
    checkedAt: state.checkedAt,
    intervalMin: Math.round(CHECK_EVERY_MS / 60000),
    auto: settings().auto,
    server: env,
    mods,
  };
}

function emit() {
  try {
    mc.emit('mod-updates', status());
  } catch (_) {
    /* kein Server ausgewählt */
  }
}

// ---------- Download ----------
async function download(rel) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const res = await fetch(rel.asset.url, { headers: { 'User-Agent': 'Minecraft-Servertool' }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`Download von ${rel.name} fehlgeschlagen (${res.status}).`);
  const file = path.join(DOWNLOAD_DIR, path.basename(rel.asset.name));
  fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  const info = jarInfo(file);
  if (info && info.id !== rel.id) {
    fs.rmSync(file, { force: true });
    throw new Error(`Die heruntergeladene Datei gehört nicht zu ${rel.name}.`);
  }
  return file;
}

function safeName(name) {
  const base = path.basename(String(name));
  if (!/\.jar$/i.test(base) || base.startsWith('.')) throw new Error(`Ungültiger Dateiname: ${name}`);
  return base;
}

// Alte .jar sichern & ersetzen (nur bei gestopptem Server – Windows sperrt geladene Jars)
function replaceJar(oldPath, newFile, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });
  const target = path.join(targetDir, safeName(path.basename(newFile)));
  if (oldPath && fs.existsSync(oldPath)) {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const bak = path.join(BACKUP_DIR, path.basename(oldPath));
    fs.copyFileSync(oldPath, bak);
    fs.rmSync(oldPath); // wirft EBUSY, falls gesperrt -> nichts kaputt
  }
  fs.copyFileSync(newFile, target);
  return target;
}

const serverStopped = () => mc.status === 'offline';

async function update(id, { auto = false } = {}) {
  const rel = latestById().get(id);
  if (!rel) throw httpError(404, 'Mod nicht im Katalog.');
  const inst = installed().find((x) => x.info && x.info.id === id);
  if (!inst) throw httpError(409, 'Mod ist nicht installiert.');
  if (cmpVersion(rel.version, inst.info.version) <= 0) return status();
  if (pendingList().some((p) => p.id === id && p.version === rel.version)) return status();
  state.busy.add(id);
  emit();
  try {
    const file = await download(rel);
    if (serverStopped()) {
      replaceJar(path.join(inst.dir, inst.file), file, inst.dir);
      fs.rmSync(file, { force: true });
      mc.log(`Mod-Update: ${rel.name} ${inst.info.version} → ${rel.version} installiert.`);
    } else {
      setPending([...pendingList().filter((p) => p.id !== id), { id, name: rel.name, version: rel.version, from: inst.info.version, file, oldFile: inst.file, dir: inst.dir }]);
      mc.log(`Mod-Update: ${rel.name} ${rel.version} heruntergeladen – wird beim nächsten Server-Start installiert.`);
    }
  } catch (err) {
    if (!auto) throw httpError(err.status || 400, err.message);
    mc.log(`Mod-Update ${rel.name} fehlgeschlagen: ${err.message}`);
  } finally {
    state.busy.delete(id);
    emit();
  }
  return status();
}

async function install(id) {
  const rel = latestById().get(id);
  if (!rel) throw httpError(404, 'Mod nicht im Katalog.');
  if (installed().some((x) => x.info && x.info.id === id)) throw httpError(409, `${rel.name} ist schon installiert.`);
  const { modsDir, serverDir } = config.paths();
  if (!serverDir || !fs.existsSync(serverDir)) throw httpError(400, 'Server-Verzeichnis ist nicht konfiguriert.');
  if (fs.existsSync(path.join(modsDir, safeName(rel.asset.name)))) throw httpError(409, `Die Datei ${rel.asset.name} existiert bereits im mods-Ordner.`);
  state.busy.add(id);
  emit();
  try {
    const file = await download(rel);
    replaceJar(null, file, modsDir); // neue Datei – geht auch bei laufendem Server
    fs.rmSync(file, { force: true });
    mc.log(`Mod installiert: ${rel.name} ${rel.version}${mc.status !== 'offline' ? ' (aktiv nach dem nächsten Neustart)' : ''}.`);
  } finally {
    state.busy.delete(id);
    emit();
  }
  return { ...status(), restartRequired: mc.status !== 'offline' };
}

// Ausstehende Updates einspielen (vor dem Server-Start bzw. sobald er gestoppt ist)
function applyPending() {
  const list = pendingList();
  if (!list.length) return;
  const rest = [];
  for (const p of list) {
    try {
      if (!fs.existsSync(p.file)) continue;
      replaceJar(path.join(p.dir, p.oldFile), p.file, p.dir);
      fs.rmSync(p.file, { force: true });
      mc.log(`Mod-Update: ${p.name} ${p.from} → ${p.version} installiert.`);
    } catch (err) {
      rest.push(p);
      mc.log(`Mod-Update ${p.name} konnte nicht installiert werden: ${err.message}`);
    }
  }
  setPending(rest);
  emit();
}

// ---------- Prüfen ----------
async function check({ manual = false } = {}) {
  if (!REPO) return status();
  if (state.status === 'checking') return status();
  state.status = 'checking';
  if (manual) emit();
  try {
    state.releases = await fetchReleases();
    state.checkedAt = Date.now();
    state.status = 'ok';
    state.error = null;
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  }
  if (settings().auto && state.status === 'ok') {
    for (const m of status().mods) {
      if (m.updateAvailable && m.compatible && m.pendingVersion !== m.version && !m.busy) await update(m.id, { auto: true });
    }
  }
  emit();
  return status();
}

function setAuto(auto) {
  const all = readAll();
  all.auto = !!auto;
  writeAll(all);
  if (auto) check().catch(() => {});
  emit();
  return status();
}

// Vor jedem Start: ausstehende Mod-Updates einspielen
mc.on('before-start', () => {
  try {
    applyPending();
  } catch (_) {
    /* Start nicht verhindern */
  }
});
// Server gestoppt -> sofort einspielen
mc.on('status', (s) => {
  if (s.status === 'offline' && pendingList().length) setTimeout(applyPending, 1500);
});

function init() {
  if (!REPO) return;
  setTimeout(() => check().catch(() => {}), 10000);
  setInterval(() => check().catch(() => {}), CHECK_EVERY_MS);
}

module.exports = { init, check, status, update, install, setAuto, applyPending, parseRelease };
