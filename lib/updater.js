// Automatische Updates über GitHub-Releases.
// Ablauf: neue Version suchen -> im Hintergrund herunterladen & entpacken -> installieren, sobald
// niemand spielt. Das eigentliche Austauschen der Dateien übernimmt lib/updateGuard.js, nachdem
// sich das Tool beendet hat (inkl. automatischem Zurücksetzen, falls die neue Version nicht startet).
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const mc = require('./mcServer');

const APP_DIR = path.join(__dirname, '..');
const PKG = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8'));
const VERSION = PKG.version;
const REPO = PKG.updateRepo; // z.B. "kaik93-bit/minecraft-servertool"
const API = process.env.MCST_UPDATE_API || 'https://api.github.com'; // für Tests überschreibbar
const UPDATE_DIR = path.join(APP_DIR, 'data', 'update');
const SETTINGS_FILE = path.join(APP_DIR, 'data', 'update.json');
// Im Entwicklungsordner (Git-Repository) niemals selbst überschreiben
const DEV_MODE = fs.existsSync(path.join(APP_DIR, '.git'));

const CHECK_EVERY_MS = 10 * 1000; // TESTPHASE: alle 10 s (normal: 3 * 60 * 60 * 1000)
const INSTALL_TICK_MS = 10 * 1000; // so oft wird geprüft, ob jetzt installiert werden kann
const IDLE_CHECKS_BEFORE_INSTALL = 18; // 18 x 10 s = 3 Minuten niemand online, bevor ein laufender Server neu gestartet wird

const state = {
  version: VERSION,
  repo: REPO || null,
  devMode: DEV_MODE,
  status: 'idle', // idle | checking | uptodate | available | downloading | ready | installing | error
  latest: null, // { version, notes, url, publishedAt }
  error: null,
  checkedAt: null,
};
let hooks = { requestShutdown: null, playersOnline: () => 0, busy: () => false };
let idleChecks = 0;

// ---------- Einstellungen ----------
function readSettings() {
  try {
    return { auto: true, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (_) {
    return { auto: true };
  }
}
function writeSettings(s) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

function publicState() {
  const s = readSettings();
  return { ...state, auto: s.auto, lastResult: s.lastResult || null };
}
function emit() {
  mc.emit('update', publicState());
}
function setStatus(status, extra = {}) {
  Object.assign(state, { status, ...extra });
  emit();
}

// ---------- Versionen ----------
function cmpVersion(a, b) {
  const pa = String(a).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
  }
  return 0;
}

async function gh(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Minecraft-Servertool', Accept: 'application/vnd.github+json' },
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub antwortet mit Fehler ${res.status}.`);
  return res;
}

// ---------- Suchen ----------
// Neueste Version ermitteln. Standard: Weiterleitung von github.com/<repo>/releases/latest auslesen –
// das zählt nicht gegen das API-Limit (60/h), daher ist auch häufiges Prüfen möglich.
// Die API wird nur einmal pro neuer Version abgefragt (für die Änderungsliste).
async function fetchLatest() {
  if (process.env.MCST_UPDATE_API) {
    // Testmodus mit Fake-API
    const res = await gh(`${API}/repos/${REPO}/releases/latest`);
    if (!res) return null;
    const rel = await res.json();
    return { version: String(rel.tag_name || '').replace(/^v/i, ''), notes: rel.body || '', zip: rel.zipball_url };
  }
  const res = await fetch(`https://github.com/${REPO}/releases/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': 'Minecraft-Servertool' },
    signal: AbortSignal.timeout(15000),
  });
  if (res.status >= 400) throw new Error(`GitHub antwortet mit Fehler ${res.status}.`);
  const m = String(res.headers.get('location') || '').match(/\/releases\/tag\/v?([^/?#]+)/);
  if (!m) return null; // noch kein Release
  const version = decodeURIComponent(m[1]);
  if (state.latest && state.latest.version === version) return state.latest; // schon bekannt
  const latest = { version, notes: '', zip: `https://github.com/${REPO}/archive/refs/tags/v${version}.zip` };
  if (cmpVersion(version, VERSION) > 0) {
    try {
      const r = await gh(`${API}/repos/${REPO}/releases/tags/v${version}`);
      if (r) latest.notes = (await r.json()).body || '';
    } catch (_) {
      /* Änderungsliste ist optional */
    }
  }
  return latest;
}

async function check({ manual = false } = {}) {
  if (!REPO) return setStatus('error', { error: 'Keine Update-Quelle eingestellt.' });
  if (['downloading', 'installing'].includes(state.status)) return publicState();
  if (manual) setStatus('checking', { error: null }); // Hintergrund-Prüfungen ohne Flackern
  try {
    const latest = await fetchLatest();
    state.checkedAt = Date.now();
    state.error = null;
    if (!latest || cmpVersion(latest.version, VERSION) <= 0) {
      if (state.status !== 'uptodate' || manual) setStatus('uptodate', { latest });
      return publicState();
    }
    // Bereits heruntergeladen?
    if (stagedVersion() === latest.version) {
      if (state.status !== 'ready') setStatus('ready', { latest });
    } else {
      setStatus('available', { latest });
    }
    const autoOk = readSettings().auto && readSettings().failedVersion !== latest.version;
    if (!DEV_MODE && (autoOk || manual) && state.status === 'available') await download();
  } catch (err) {
    setStatus('error', { error: `Update-Suche fehlgeschlagen: ${err.message}` });
  }
  return publicState();
}

// ---------- Herunterladen & entpacken ----------
function stagedDir() {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(UPDATE_DIR, 'staged.json'), 'utf8'));
    return fs.existsSync(info.dir) ? info : null;
  } catch (_) {
    return null;
  }
}
function stagedVersion() {
  return stagedDir()?.version || null;
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { windowsHide: true, ...opts });
    let err = '';
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(err.trim() || `${path.basename(cmd)} Exit-Code ${code}`))));
  });
}

async function download() {
  if (DEV_MODE) throw Object.assign(new Error('Im Entwicklungsordner werden keine Updates installiert.'), { status: 409 });
  const latest = state.latest;
  if (!latest) throw Object.assign(new Error('Keine neue Version bekannt.'), { status: 409 });
  setStatus('downloading', { error: null });
  try {
    // nur den Download-Bereich leeren – Sicherung (previous) und Wächter bleiben unangetastet
    fs.rmSync(path.join(UPDATE_DIR, 'staged'), { recursive: true, force: true });
    fs.rmSync(path.join(UPDATE_DIR, 'staged.json'), { force: true });
    const extractDir = path.join(UPDATE_DIR, 'staged');
    fs.mkdirSync(extractDir, { recursive: true });
    const zipFile = path.join(UPDATE_DIR, 'download.zip');
    const res = await gh(latest.zip);
    if (!res) throw new Error('Download nicht gefunden.');
    fs.writeFileSync(zipFile, Buffer.from(await res.arrayBuffer()));

    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    await run(fs.existsSync(tar) ? tar : 'tar', ['-xf', zipFile, '-C', extractDir]);
    fs.rmSync(zipFile, { force: true });

    // GitHub packt alles in einen Unterordner "<besitzer>-<repo>-<hash>"
    const entries = fs.readdirSync(extractDir);
    const root = entries.length === 1 ? path.join(extractDir, entries[0]) : extractDir;
    const pkgFile = path.join(root, 'package.json');
    if (!fs.existsSync(path.join(root, 'server.js')) || !fs.existsSync(pkgFile)) throw new Error('Download ist unvollständig.');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    if (pkg.name !== PKG.name) throw new Error('Download gehört nicht zu diesem Tool.');

    fs.writeFileSync(path.join(UPDATE_DIR, 'staged.json'), JSON.stringify({ version: latest.version, dir: root, notes: latest.notes }), 'utf8');
    setStatus('ready');
    mc.log(`Update ${latest.version} wurde heruntergeladen und wird installiert, sobald niemand spielt.`);
  } catch (err) {
    setStatus('error', { error: `Download fehlgeschlagen: ${err.message}` });
  }
}

// ---------- Installieren ----------
// Beendet das Tool sicher (stoppt den Minecraft-Server) und übergibt an den Update-Wächter.
async function install({ resumeServer } = {}) {
  if (DEV_MODE) throw Object.assign(new Error('Im Entwicklungsordner werden keine Updates installiert.'), { status: 409 });
  const staged = stagedDir();
  if (!staged) throw Object.assign(new Error('Es ist kein Update heruntergeladen.'), { status: 409 });
  if (resumeServer === undefined) resumeServer = mc.isAlive();
  const s = readSettings();
  writeSettings({ ...s, resumeServer: !!resumeServer });
  setStatus('installing');
  mc.log(`Update auf Version ${staged.version} wird installiert – das Tool startet gleich neu.`);
  hooks.requestShutdown({ restart: true, update: true });
  return publicState();
}

// Wird vom beendenden Tool aufgerufen (Port ist schon frei): startet den Wächter, der die Dateien tauscht.
function spawnGuard(port) {
  const staged = stagedDir();
  const guard = path.join(UPDATE_DIR, 'guard.js');
  // Wächter aus der *aktuellen* (funktionierenden) Version kopieren – er wird selbst nicht ersetzt
  fs.copyFileSync(path.join(__dirname, 'updateGuard.js'), guard);
  const log = fs.openSync(path.join(UPDATE_DIR, 'update.log'), 'w');
  spawn(process.execPath, [guard, APP_DIR, staged.dir, String(port), String(process.pid), VERSION, staged.version], {
    cwd: APP_DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
    env: process.env,
  }).unref();
}

// Alle 60 s: heruntergeladenes Update installieren, sobald es niemanden stört
function maybeInstall() {
  const s = readSettings();
  if (DEV_MODE || state.status !== 'ready' || !s.auto) return;
  if (s.failedVersion && s.failedVersion === stagedVersion()) return; // schon einmal gescheitert -> nur noch per Klick
  if (hooks.busy()) return; // z.B. Backup läuft
  if (mc.status === 'offline' || mc.status === 'crashed') {
    install({ resumeServer: false }).catch(() => {});
  } else if (mc.status === 'running') {
    idleChecks = hooks.playersOnline() === 0 ? idleChecks + 1 : 0;
    if (idleChecks >= IDLE_CHECKS_BEFORE_INSTALL) install({ resumeServer: true }).catch(() => {});
  } else {
    idleChecks = 0;
  }
}

// ---------- Start ----------
function init(h) {
  hooks = { ...hooks, ...h };
  if (!DEV_MODE && stagedVersion() && cmpVersion(stagedVersion(), VERSION) > 0) {
    const st = stagedDir();
    state.latest = { version: st.version, notes: st.notes };
    state.status = 'ready';
  }
  // Aufräumen übernimmt der Update-Wächter – hier nichts löschen (er prüft evtl. gerade diese Instanz)
  // Ergebnis eines gerade abgeschlossenen Updates schreibt der Wächter erst nach ein paar Sekunden
  setTimeout(emit, 12000);
  if (!REPO) return;
  setTimeout(() => check().catch(() => {}), Math.min(15000, CHECK_EVERY_MS));
  setInterval(() => check().catch(() => {}), CHECK_EVERY_MS);
  setInterval(maybeInstall, INSTALL_TICK_MS);
}

// Nach dem Start: Server ggf. wieder hochfahren (falls er fürs Update gestoppt wurde)
function shouldResumeServer() {
  const s = readSettings();
  if (!s.resumeServer) return false;
  writeSettings({ ...s, resumeServer: false });
  return true;
}

function setAuto(auto) {
  writeSettings({ ...readSettings(), auto: !!auto });
  emit();
  if (auto && state.status === 'available') download();
  return publicState();
}

function dismissResult() {
  const s = readSettings();
  if (s.lastResult) s.lastResult.seen = true;
  writeSettings(s);
  return publicState();
}

module.exports = { VERSION, init, check, download, install, spawnGuard, shouldResumeServer, setAuto, dismissResult, status: publicState, cmpVersion };
