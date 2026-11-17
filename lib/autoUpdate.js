// Automatische Updates (Einstellung, standardmäßig AUS).
// Ist sie an und der Server seit 3 Minuten leer, werden verfügbare Updates eingespielt:
//   1. zuerst alle Mod-Updates (Priorität)
//   2. danach das Servertool selbst – nach dessen Neustart startet der Minecraft-Server automatisch wieder
// Gibt es nur Mod-Updates und der Server läuft, wird er einmal neu gestartet, damit sie geladen werden.
const fs = require('fs');
const path = require('path');
const mc = require('./mcServer');
const modCatalog = require('./modCatalog');
const updater = require('./updater');

const SETTINGS_FILE = path.join(__dirname, '..', 'data', 'auto-update.json');
const EMPTY_MS = Number(process.env.MCST_EMPTY_MS) || 3 * 60 * 1000;
const TICK_MS = 5000;

const rt = { emptySince: null, running: false, lastAction: null };
let hooks = { busy: () => false };

function settings() {
  try {
    return { enabled: false, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (_) {
    return { enabled: false };
  }
}

// Was gibt es zu tun?
function pendingWork() {
  const mods = modCatalog
    .status()
    .mods.filter((m) => m.installed && m.updateAvailable && m.compatible && m.pendingVersion !== m.version && !m.busy);
  const queuedMods = modCatalog.status().mods.filter((m) => m.pendingVersion);
  const u = updater.status();
  const failed = updater.failedVersion();
  const tool = !u.devMode && ['available', 'ready'].includes(u.status) && u.latest && u.latest.version !== failed ? u.latest.version : null;
  return { mods, queuedMods, tool };
}

function status() {
  const s = settings();
  const w = pendingWork();
  return {
    enabled: s.enabled,
    emptyMinutes: EMPTY_MS / 60000,
    emptySince: rt.emptySince,
    installAt: s.enabled && rt.emptySince && (w.mods.length || w.queuedMods.length || w.tool) ? rt.emptySince + EMPTY_MS : null,
    work: { mods: w.mods.map((m) => `${m.name} ${m.version}`), tool: w.tool },
    running: rt.running,
    lastAction: rt.lastAction,
  };
}
function emit() {
  try {
    mc.emit('auto-update', status());
  } catch (_) {
    /* kein Server ausgewählt */
  }
}

function setEnabled(enabled) {
  fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ ...settings(), enabled: !!enabled }, null, 2), 'utf8');
  mc.log(`Automatische Updates ${enabled ? 'eingeschaltet' : 'ausgeschaltet'}.`);
  emit();
  return status();
}

const isEmpty = () => mc.status === 'offline' || (mc.status === 'running' && mc.online.size === 0);

async function run() {
  rt.running = true;
  emit();
  const wasRunning = mc.status === 'running';
  try {
    const { mods, tool } = pendingWork();
    // 1. Mods zuerst
    for (const m of mods) {
      if (!isEmpty()) {
        mc.log('Automatische Updates abgebrochen: ein Spieler ist gejoint.');
        return;
      }
      try {
        await modCatalog.update(m.id);
      } catch (err) {
        mc.log(`Automatisches Mod-Update ${m.name} fehlgeschlagen: ${err.message}`);
      }
    }
    const queued = modCatalog.status().mods.filter((m) => m.pendingVersion);

    // 2. Danach das Tool (stoppt den MC-Server sicher; ausstehende Mods werden dabei eingespielt)
    if (tool && isEmpty()) {
      rt.lastAction = { at: Date.now(), text: `Tool-Update auf ${tool}` };
      mc.log(`Automatisches Update: Servertool ${tool} wird installiert${wasRunning ? ' – der Minecraft-Server startet danach automatisch wieder' : ''}.`);
      if (updater.status().status === 'available') await updater.download();
      if (updater.status().status !== 'ready') throw new Error(updater.status().error || 'Download fehlgeschlagen');
      await updater.install({ resumeServer: wasRunning });
      return; // Tool beendet sich
    }

    // 3. Nur Mods: Server neu starten, damit sie geladen werden
    if (queued.length && mc.status === 'running' && isEmpty()) {
      rt.lastAction = { at: Date.now(), text: `Mod-Updates: ${queued.map((m) => m.name).join(', ')}` };
      mc.log('Automatische Updates: Minecraft-Server wird neu gestartet, um die Mod-Updates zu laden ...');
      await mc.restart(); // stop -> before-start spielt die Mods ein -> start
    } else if (mods.length) {
      rt.lastAction = { at: Date.now(), text: `Mod-Updates: ${mods.map((m) => m.name).join(', ')}` };
    }
  } catch (err) {
    mc.log(`Automatische Updates fehlgeschlagen: ${err.message}`);
  } finally {
    rt.running = false;
    rt.emptySince = null;
    emit();
  }
}

function tick() {
  const empty = isEmpty();
  const before = rt.emptySince;
  if (!empty) rt.emptySince = null;
  else if (!rt.emptySince) rt.emptySince = Date.now();
  if (before !== rt.emptySince) emit();

  if (!settings().enabled || rt.running || !rt.emptySince || hooks.busy()) return;
  if (Date.now() - rt.emptySince < EMPTY_MS) return;
  const w = pendingWork();
  const modsNeedRestart = w.queuedMods.length && mc.status === 'running';
  if (!w.mods.length && !w.tool && !modsNeedRestart) return;
  run();
}

function init(h) {
  hooks = { ...hooks, ...h };
  setInterval(tick, TICK_MS);
  mc.on('mod-updates', emit);
  mc.on('update', emit);
}

module.exports = { init, status, setEnabled };
