// Einstellbare Tag- und Nachtlänge.
//
// Minecraft hat dafür keine eigene Einstellung (ein Tag = 20 Min.: 10 Min. Tag, 10 Min. Nacht inkl. Dämmerung).
// Das Tool legt deshalb ein kleines Datenpaket in die Welt (<welt>/datapacks/servertool_tageslaenge):
//  - es schaltet den normalen Tag-Nacht-Zyklus ab (Spielregel advance_time / doDaylightCycle)
//  - und lässt die Zeit jeden Tick selbst weiterlaufen – tagsüber und nachts unterschiedlich schnell.
//  - Schlafen funktioniert weiter: schlafende Spieler werden über die Statistik "Zeit seit letzter Ruhe"
//    erkannt; die Spielregel "Schlaf-Prozent" wird beachtet.
// Befehle aus Datenpaket-Funktionen laufen still – es erscheinen keine Chat-Meldungen.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const mc = require('./mcServer');
const gamerules = require('./gamerules');
const { readMap } = require('./serverSettings');

const PACK_NAME = 'servertool_tageslaenge';
const NS = 'servertool_tageslaenge';
const DATA_FILE = path.join(__dirname, '..', 'data', 'daylength.json');
const DEFAULTS = { enabled: false, dayMinutes: 10, nightMinutes: 10 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- Speicher (pro Server-Ordner) ----------
function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function getSettings() {
  return { ...DEFAULTS, ...(loadAll()[config.paths().serverDir || ''] || {}) };
}

function saveSettings(s) {
  const all = loadAll();
  all[config.paths().serverDir || ''] = s;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2), 'utf8');
}

function packDir() {
  const { serverDir } = config.paths();
  if (!serverDir || !fs.existsSync(serverDir)) throw httpError(400, 'Kein Server ausgewählt.');
  const level = readMap(serverDir)['level-name'] || 'world';
  return path.join(serverDir, level, 'datapacks', PACK_NAME);
}

// ---------- Datenpaket erzeugen ----------
// Geschwindigkeit in Tausendstel-Ticks pro Tick: 1000 = normal (Tag/Nacht je 10 Min.)
const rate = (minutes) => Math.max(1, Math.round(10000 / minutes));

// Wie die Tageszeit abgefragt wird:
//  - bis 1.21.x: "time query daytime" (0..23999)
//  - ab 26.x: Zeitleisten – "time query day" (0..23999); "daytime" gibt es nicht mehr.
//    Achtung: in älteren Versionen liefert "time query day" die Anzahl der Tage, darum nie beides mischen.
const TIME_QUERY = { daytime: 'time query daytime', timeline: 'time query day' };
const TIMELINE_ERR_RE = /Can't find element 'minecraft:daytime' of type 'minecraft:timeline'/;

function timeStyle() {
  try {
    const v = require('./modCatalog').serverEnv().mcVersion;
    const major = parseInt(String(v || ''), 10);
    if (major >= 26) return 'timeline';
    if (major === 1) return 'daytime';
  } catch (_) {
    /* Version unbekannt */
  }
  return getSettings().timeStyle || 'daytime'; // zuletzt gelernte Variante (z.B. aus einer Fehlermeldung)
}

function packFiles(s, scheme, style = 'daytime') {
  const cycle = scheme === 'old' ? 'doDaylightCycle' : 'advance_time';
  const sleepPct = scheme === 'old' ? 'playersSleepingPercentage' : 'players_sleeping_percentage';
  const fn = {
    load: [
      '# Servertool: Tag-/Nachtlänge (automatisch erzeugt – nicht von Hand ändern)',
      'scoreboard objectives add st_time dummy',
      'scoreboard objectives add st_sleep dummy',
      'scoreboard objectives add st_rest minecraft.custom:minecraft.time_since_rest',
      'scoreboard players set #100 st_time 100',
      'scoreboard players set #1000 st_time 1000',
      'scoreboard players set #24000 st_time 24000',
      `gamerule ${cycle} false`,
    ],
    tick: [
      `# Tag: ${s.dayMinutes} Min., Nacht: ${s.nightMinutes} Min.`,
      `execute store result score #t st_time run ${TIME_QUERY[style] || TIME_QUERY.daytime}`,
      // Schlafende Spieler zählen (Statistik "Zeit seit letzter Ruhe" bleibt im Bett bei 0)
      'scoreboard players add @a[scores={st_rest=0}] st_sleep 1',
      'scoreboard players set @a[scores={st_rest=1..}] st_sleep 0',
      'execute in minecraft:overworld store result score #all st_time if entity @a[distance=0..,gamemode=!spectator]',
      'execute in minecraft:overworld store result score #sleep st_time if entity @a[distance=0..,gamemode=!spectator,scores={st_sleep=90..}]',
      `execute if score #sleep st_time matches 1.. run function ${NS}:check_sleep`,
      // Zeit weiterlaufen lassen
      `execute if score #t st_time matches 0..11999 run scoreboard players add #acc st_time ${rate(s.dayMinutes)}`,
      `execute if score #t st_time matches 12000.. run scoreboard players add #acc st_time ${rate(s.nightMinutes)}`,
      `execute if score #acc st_time matches 1000.. run function ${NS}:advance`,
    ],
    check_sleep: [
      `execute store result score #pct st_time run gamerule ${sleepPct}`,
      'scoreboard players operation #a st_time = #sleep st_time',
      'scoreboard players operation #a st_time *= #100 st_time',
      'scoreboard players operation #b st_time = #all st_time',
      'scoreboard players operation #b st_time *= #pct st_time',
      `execute if score #a st_time >= #b st_time run function ${NS}:skip_night`,
    ],
    skip_night: [
      'scoreboard players operation #d st_time = #24000 st_time',
      'scoreboard players operation #d st_time -= #t st_time',
      `execute store result storage ${NS}:tmp n int 1 run scoreboard players get #d st_time`,
      `function ${NS}:add with storage ${NS}:tmp`,
      'scoreboard players set @a st_sleep 0',
    ],
    advance: [
      'scoreboard players operation #n st_time = #acc st_time',
      'scoreboard players operation #n st_time /= #1000 st_time',
      'scoreboard players operation #acc st_time %= #1000 st_time',
      `execute store result storage ${NS}:tmp n int 1 run scoreboard players get #n st_time`,
      `function ${NS}:add with storage ${NS}:tmp`,
    ],
    add: ['$time add $(n)'],
  };

  const files = {
    'pack.mcmeta': JSON.stringify(
      {
        pack: {
          description: `Servertool: Tag ${s.dayMinutes} Min. / Nacht ${s.nightMinutes} Min.`,
          pack_format: 18,
          supported_formats: { min_inclusive: 18, max_inclusive: 999 },
          min_format: 18,
          max_format: 999,
        },
      },
      null,
      2
    ),
  };
  // "function" (ab 1.21) und "functions" (ältere Versionen) – die jeweils andere wird ignoriert
  for (const dir of ['function', 'functions']) {
    for (const [name, lines] of Object.entries(fn)) files[`data/${NS}/${dir}/${name}.mcfunction`] = lines.join('\n') + '\n';
    files[`data/minecraft/tags/${dir}/load.json`] = JSON.stringify({ values: [`${NS}:load`] }, null, 2);
    files[`data/minecraft/tags/${dir}/tick.json`] = JSON.stringify({ values: [`${NS}:tick`] }, null, 2);
  }
  return files;
}

function writePack(s, scheme, style) {
  const dir = packDir();
  fs.rmSync(dir, { recursive: true, force: true });
  for (const [rel, content] of Object.entries(packFiles(s, scheme, style))) {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content, 'utf8');
  }
}

async function reloadServer() {
  mc.log('Lade Datenpakete neu (/reload) ...');
  mc.sendCommand('reload');
  await mc.waitForLog(/Reloading!|reload|Loaded \d+/i, 15000);
}

// ---------- API ----------
function status() {
  const s = getSettings();
  let installed = false;
  try {
    installed = fs.existsSync(packDir());
  } catch (_) {
    /* kein Server */
  }
  return { ...s, installed, running: mc.status === 'running', serverStatus: mc.status };
}

async function apply(input) {
  const s = { ...getSettings() };
  if (input.enabled !== undefined) s.enabled = !!input.enabled;
  for (const k of ['dayMinutes', 'nightMinutes']) {
    if (input[k] === undefined) continue;
    const n = Number(input[k]);
    if (!Number.isFinite(n) || n < 1 || n > 600) throw httpError(400, 'Tag und Nacht müssen zwischen 1 und 600 Minuten lang sein.');
    s[k] = Math.round(n * 10) / 10;
  }
  if (mc.status === 'starting' || mc.status === 'stopping') throw httpError(409, 'Server startet/stoppt gerade – bitte kurz warten.');

  const cycleKey = 'advance_time';
  if (s.enabled) {
    s.scheme = gamerules.scheme();
    s.timeStyle = timeStyle();
    writePack(s, s.scheme, s.timeStyle);
    gamerules.dropPending(cycleKey); // eine vorgemerkte "Zyklus an"-Änderung würde das Paket aushebeln
    saveSettings(s);
    if (mc.status === 'running') await reloadServer();
    mc.log(`Tag-/Nachtlänge: Tag ${s.dayMinutes} Min., Nacht ${s.nightMinutes} Min.${mc.status === 'running' ? '' : ' (aktiv ab nächstem Start)'}`);
  } else {
    fs.rmSync(packDir(), { recursive: true, force: true });
    saveSettings(s);
    if (mc.status === 'running') await reloadServer();
    // normalen Tag-Nacht-Zyklus wieder einschalten (oder für den nächsten Start vormerken)
    await gamerules.set(cycleKey, true).catch((err) => mc.log(`Tag-Nacht-Zyklus konnte nicht eingeschaltet werden: ${err.message}`));
    mc.log('Tag-/Nachtlänge: wieder normal (Minecraft-Standard).');
  }
  return status();
}

// Passt das Datenpaket nicht mehr zur Minecraft-Version (Regel-Schreibweise, Zeitabfrage) -> neu erzeugen.
// Gibt true zurück, wenn es neu geschrieben wurde.
function refreshPack({ style } = {}) {
  const s = getSettings();
  if (!s.enabled) return false;
  const scheme = gamerules.scheme();
  const wanted = style || timeStyle();
  if (s.scheme === scheme && (s.timeStyle || 'daytime') === wanted && fs.existsSync(packDir())) return false;
  s.scheme = scheme;
  s.timeStyle = wanted;
  writePack(s, scheme, wanted);
  saveSettings(s);
  return true;
}

async function refreshAndReload(opts) {
  try {
    if (mc.status !== 'running' || !refreshPack(opts)) return;
    await sleep(500);
    await reloadServer();
    mc.log('Tag-/Nachtlänge: Datenpaket an die Minecraft-Version angepasst.');
  } catch (err) {
    mc.log(`Tag-/Nachtlänge: ${err.message}`);
  }
}

// Vor dem Start: Datenpaket passend zur (evtl. neuen) Server-Version schreiben – ohne /reload, der Server lädt es gleich selbst
mc.on('before-start', () => {
  try {
    if (refreshPack()) mc.log('Tag-/Nachtlänge: Datenpaket an die Minecraft-Version angepasst.');
  } catch (err) {
    mc.log(`Tag-/Nachtlänge: ${err.message}`);
  }
});
mc.on('gamerules-changed', () => refreshAndReload());
// Sicherheitsnetz, falls die Version nicht erkannt wurde: Server meldet, dass es "daytime" nicht mehr gibt
mc.on('line', (line) => {
  if (TIMELINE_ERR_RE.test(line)) setTimeout(() => refreshAndReload({ style: 'timeline' }), 0);
});

module.exports = { status, apply, packFiles, timeStyle };
