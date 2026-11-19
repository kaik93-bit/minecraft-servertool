// Spielregeln (/gamerule): auslesen, ändern, vormerken (wenn Server aus).
//
// Ab Minecraft 1.21.11 heißen die Regeln anders (z.B. keepInventory -> keep_inventory).
// Das Tool fragt beim Serverstart beide Schreibweisen ab und merkt sich, welche der Server versteht.
// Die Abfrage-Antworten werden in der Konsole ausgeblendet.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const mc = require('./mcServer');

const DATA_FILE = path.join(__dirname, '..', 'data', 'gamerules.json');

const CATS = ['Wichtig', 'Spieler', 'Mobs', 'Drops', 'Welt', 'Chat & Befehle'];

// [neuer Name (1.21.11+), alter Name, Typ, Kategorie, Beschriftung, Beschreibung, Optionen]
// Optionen: invertOld = alte Regel bedeutet das Gegenteil ("disableRaids"), only = nur 'old'/'new'
const RAW = [
  ['allow_entering_nether_using_portals', 'allowEnteringNetherUsingPortals', 'bool', 'Wichtig', 'Nether erlauben', 'Spieler können über Portale in den Nether.'],
  ['pvp', 'pvp', 'bool', 'Wichtig', 'PvP', 'Spieler können sich gegenseitig Schaden zufügen.'],
  ['keep_inventory', 'keepInventory', 'bool', 'Wichtig', 'Inventar nach dem Tod behalten'],
  ['spawn_monsters', 'spawnMonsters', 'bool', 'Wichtig', 'Monster spawnen'],
  ['mob_griefing', 'mobGriefing', 'bool', 'Wichtig', 'Mobs zerstören Blöcke', 'Creeper-Explosionen, Endermen nehmen Blöcke, usw.'],
  ['advance_time', 'doDaylightCycle', 'bool', 'Wichtig', 'Tag-Nacht-Zyklus', 'Aus = Zeit bleibt stehen.'],
  ['advance_weather', 'doWeatherCycle', 'bool', 'Wichtig', 'Wetterwechsel'],
  ['players_sleeping_percentage', 'playersSleepingPercentage', 'int', 'Wichtig', 'Schlafende Spieler zum Überspringen der Nacht (%)', '0 = einer reicht, 100 = alle.'],
  ['natural_health_regeneration', 'naturalRegeneration', 'bool', 'Wichtig', 'Natürliche Lebensregeneration'],
  ['immediate_respawn', 'doImmediateRespawn', 'bool', 'Wichtig', 'Sofort respawnen (ohne Todesbildschirm)'],
  ['show_death_messages', 'showDeathMessages', 'bool', 'Wichtig', 'Todesnachrichten im Chat'],
  ['locator_bar', 'locatorBar', 'bool', 'Wichtig', 'Ortungsleiste (zeigt Mitspieler-Richtung)'],

  ['fall_damage', 'fallDamage', 'bool', 'Spieler', 'Fallschaden'],
  ['fire_damage', 'fireDamage', 'bool', 'Spieler', 'Feuerschaden'],
  ['drowning_damage', 'drowningDamage', 'bool', 'Spieler', 'Ertrinkungsschaden'],
  ['freeze_damage', 'freezeDamage', 'bool', 'Spieler', 'Erfrierungsschaden (Pulverschnee)'],
  ['ender_pearls_vanish_on_death', 'enderPearlsVanishOnDeath', 'bool', 'Spieler', 'Geworfene Enderperlen verschwinden beim Tod'],
  ['reduced_debug_info', 'reducedDebugInfo', 'bool', 'Spieler', 'Koordinaten im F3-Menü verbergen'],
  ['respawn_radius', 'spawnRadius', 'int', 'Spieler', 'Respawn-Radius um den Weltspawn (Blöcke)'],
  ['limited_crafting', 'doLimitedCrafting', 'bool', 'Spieler', 'Nur freigeschaltete Rezepte craftbar'],
  ['player_movement_check', 'disablePlayerMovementCheck', 'bool', 'Spieler', 'Bewegungsprüfung (Anti-Cheat)', '', { invertOld: true }],
  ['elytra_movement_check', 'disableElytraMovementCheck', 'bool', 'Spieler', 'Elytra-Bewegungsprüfung (Anti-Cheat)', '', { invertOld: true }],
  ['spectators_generate_chunks', 'spectatorsGenerateChunks', 'bool', 'Spieler', 'Zuschauer generieren neue Gebiete'],
  ['players_nether_portal_default_delay', 'playersNetherPortalDefaultDelay', 'int', 'Spieler', 'Netherportal-Verzögerung (Ticks, Überleben)'],
  ['players_nether_portal_creative_delay', 'playersNetherPortalCreativeDelay', 'int', 'Spieler', 'Netherportal-Verzögerung (Ticks, Kreativ)'],

  ['spawn_mobs', 'doMobSpawning', 'bool', 'Mobs', 'Mobs spawnen (alle)'],
  ['spawn_phantoms', 'doInsomnia', 'bool', 'Mobs', 'Phantome spawnen'],
  ['spawn_patrols', 'doPatrolSpawning', 'bool', 'Mobs', 'Plünderer-Patrouillen'],
  ['spawn_wandering_traders', 'doTraderSpawning', 'bool', 'Mobs', 'Fahrende Händler'],
  ['spawn_wardens', 'doWardenSpawning', 'bool', 'Mobs', 'Wärter (Warden) spawnen'],
  ['raids', 'disableRaids', 'bool', 'Mobs', 'Überfälle (Raids)', '', { invertOld: true }],
  ['spawner_blocks_work', 'spawnerBlocksEnabled', 'bool', 'Mobs', 'Spawner-Blöcke aktiv'],
  ['forgive_dead_players', 'forgiveDeadPlayers', 'bool', 'Mobs', 'Wütende Mobs vergeben tote Spieler'],
  ['universal_anger', 'universalAnger', 'bool', 'Mobs', 'Wütende Mobs greifen alle Spieler an'],
  ['max_entity_cramming', 'maxEntityCramming', 'int', 'Mobs', 'Max. Kreaturen auf einem Block (Erdrücken)'],

  ['block_drops', 'doTileDrops', 'bool', 'Drops', 'Blöcke droppen Items'],
  ['mob_drops', 'doMobLoot', 'bool', 'Drops', 'Mobs droppen Beute'],
  ['entity_drops', 'doEntityDrops', 'bool', 'Drops', 'Objekte droppen (Loren, Rahmen …)'],
  ['block_explosion_drop_decay', 'blockExplosionDropDecay', 'bool', 'Drops', 'Block-Explosionen zerstören Teil der Drops'],
  ['mob_explosion_drop_decay', 'mobExplosionDropDecay', 'bool', 'Drops', 'Mob-Explosionen zerstören Teil der Drops'],
  ['tnt_explosion_drop_decay', 'tntExplosionDropDecay', 'bool', 'Drops', 'TNT-Explosionen zerstören Teil der Drops'],

  ['fire_spread_radius_around_player', null, 'int', 'Welt', 'Feuerausbreitung: Radius um Spieler (Chunks)', '0 = Feuer breitet sich nicht aus, -1 = überall.', { only: 'new' }],
  [null, 'doFireTick', 'bool', 'Welt', 'Feuer breitet sich aus', '', { only: 'old' }],
  [null, 'allowFireTicksAwayFromPlayer', 'bool', 'Welt', 'Feuer auch fern von Spielern aktiv', '', { only: 'old' }],
  ['tnt_explodes', 'tntExplodes', 'bool', 'Welt', 'TNT explodiert'],
  ['projectiles_can_break_blocks', 'projectilesCanBreakBlocks', 'bool', 'Welt', 'Geschosse können Blöcke zerstören'],
  ['spread_vines', 'doVinesSpread', 'bool', 'Welt', 'Ranken wachsen'],
  ['lava_source_conversion', 'lavaSourceConversion', 'bool', 'Welt', 'Lava bildet neue Quellen'],
  ['water_source_conversion', 'waterSourceConversion', 'bool', 'Welt', 'Wasser bildet neue Quellen'],
  ['random_tick_speed', 'randomTickSpeed', 'int', 'Welt', 'Zufalls-Tick-Rate (Pflanzenwachstum)', 'Standard 3. Höher = schnelleres Wachstum.'],
  ['max_snow_accumulation_height', 'snowAccumulationHeight', 'int', 'Welt', 'Max. Schneehöhe (Schichten)'],
  ['global_sound_events', 'globalSoundEvents', 'bool', 'Welt', 'Globale Geräusche (Boss-Spawns etc.)'],
  ['max_minecart_speed', 'minecartMaxSpeed', 'int', 'Welt', 'Max. Lorengeschwindigkeit (experimentell)'],
  [null, 'spawnChunkRadius', 'int', 'Welt', 'Spawn-Chunks-Radius', '', { only: 'old' }],
  [null, 'entitiesWithPassengersCanUsePortals', 'bool', 'Welt', 'Reittiere mit Reitern durch Portale', '', { only: 'old' }],

  ['show_advancement_messages', 'announceAdvancements', 'bool', 'Chat & Befehle', 'Fortschritte im Chat ankündigen'],
  ['send_command_feedback', 'sendCommandFeedback', 'bool', 'Chat & Befehle', 'Befehlsrückmeldungen im Chat'],
  ['log_admin_commands', 'logAdminCommands', 'bool', 'Chat & Befehle', 'Admin-Befehle an OPs melden'],
  ['command_block_output', 'commandBlockOutput', 'bool', 'Chat & Befehle', 'Befehlsblock-Ausgaben im Chat'],
  ['command_blocks_work', 'commandBlocksEnabled', 'bool', 'Chat & Befehle', 'Befehlsblöcke aktiv'],
  ['max_command_sequence_length', 'maxCommandChainLength', 'int', 'Chat & Befehle', 'Max. Befehlsketten-Länge'],
  ['max_command_forks', 'maxCommandForkCount', 'int', 'Chat & Befehle', 'Max. Befehls-Kontexte'],
  ['max_block_modifications', 'commandModificationBlockLimit', 'int', 'Chat & Befehle', 'Max. Blöcke pro /fill bzw. /clone'],
];

const DEFS = RAW.map(([id, old, type, cat, label, desc, opts = {}]) => ({
  key: id || old, id, old, type, cat, label, desc: desc || '', invertOld: !!opts.invertOld, only: opts.only || null,
}));
const DEF_BY_KEY = new Map(DEFS.map((d) => [d.key, d]));

// 1.21: "Gamerule keep_inventory is currently set to: true"
// 26.x: "System chat: Game rule keep_inventory is currently set to true"
const RESP_RE = /Game ?rule (\S+) is (?:currently|now) set to:? (\S+)/i;
const ERR_RE = /Unknown or incomplete command|Incorrect argument for command|Unknown game ?rule|<--\[HERE\]|Invalid (?:boolean|integer)/i;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bare = (n) => String(n).replace(/^minecraft:/, '');

// ---------- Speicher (pro Server-Ordner) ----------
function loadAll() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (_) {
    return {};
  }
}

function entry() {
  const dir = config.paths().serverDir || '';
  const all = loadAll();
  return all[dir] || { scheme: null, values: {}, pending: {}, updatedAt: null };
}

function saveEntry(e) {
  const dir = config.paths().serverDir || '';
  const all = loadAll();
  all[dir] = e;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2), 'utf8');
}

function nameFor(def, scheme) {
  return scheme === 'old' ? def.old : def.id;
}

function parseValue(def, raw, scheme) {
  if (def.type === 'int') return Number(raw);
  let v = raw === 'true';
  if (scheme === 'old' && def.invertOld) v = !v;
  return v;
}

function toRaw(def, value, scheme) {
  if (def.type === 'int') return String(value);
  let v = !!value;
  if (scheme === 'old' && def.invertOld) v = !v;
  return String(v);
}

// ---------- Abfragen ----------
let querying = null;

function query() {
  if (mc.status !== 'running') {
    return Promise.reject(Object.assign(new Error('Der Server muss laufen, um die Spielregeln abzufragen.'), { status: 409 }));
  }
  if (querying) return querying;
  querying = (async () => {
    const results = {};
    let last = Date.now();
    const onLine = (line) => {
      const m = line.match(RESP_RE);
      if (m) {
        results[bare(m[1])] = m[2];
        last = Date.now();
      }
    };
    mc.on('line', onLine);
    const removeFilter = mc.addLogFilter((l) => RESP_RE.test(l) || ERR_RE.test(l) || /\.\.\.\S*gamerule /.test(l));
    try {
      // Ist die Schreibweise schon bekannt, nur diese abfragen – sonst erscheinen im Server-Log
      // für jede Regel "Incorrect argument for command"-Fehler der jeweils anderen Schreibweise.
      const known = entry().scheme;
      const ask = async (which) => {
        const names = new Set();
        for (const d of DEFS) {
          if (d.id && (which === 'all' || which === 'new')) names.add(d.id);
          if (d.old && (which === 'all' || which === 'old')) names.add(d.old);
        }
        last = Date.now();
        for (const n of names) mc.sendCommand(`gamerule ${n}`);
        const start = Date.now();
        // warten, bis keine Antworten mehr kommen (max. 8 s)
        while (Date.now() - start < 8000) {
          await sleep(200);
          if (Date.now() - last > 900 && Date.now() - start > 1200) break;
        }
      };
      await ask(known || 'all');
      // Bekannte Schreibweise passt nicht mehr (z.B. Server auf neue Version umgestellt) -> beide probieren
      const hits = DEFS.filter((d) => results[nameFor(d, known)] !== undefined && d.id !== d.old).length;
      if (known && !hits) await ask('all');
    } finally {
      // kurze Nachlaufzeit für späte Fehlermeldungen
      setTimeout(removeFilter, 1500);
      mc.off('line', onLine);
    }

    const newHits = DEFS.filter((d) => d.id && d.id !== d.old && results[d.id] !== undefined).length;
    const oldHits = DEFS.filter((d) => d.old && d.id !== d.old && results[d.old] !== undefined).length;
    if (!newHits && !oldHits) throw new Error('Der Server hat auf die Spielregel-Abfrage nicht geantwortet.');
    const scheme = newHits >= oldHits ? 'new' : 'old';

    const values = {};
    for (const d of DEFS) {
      const n = nameFor(d, scheme);
      if (n && results[n] !== undefined) values[d.key] = parseValue(d, results[n], scheme);
    }
    const e = entry();
    Object.assign(e, { scheme, values, updatedAt: Date.now() });
    saveEntry(e);
    return e;
  })();
  return querying.finally(() => {
    querying = null;
  });
}

// ---------- Ändern ----------
function validate(def, value) {
  if (!def) throw Object.assign(new Error('Unbekannte Spielregel.'), { status: 400 });
  if (def.type === 'bool') {
    if (typeof value !== 'boolean') throw new Error('Wert muss an/aus sein.');
    return value;
  }
  const n = Number(value);
  if (!Number.isInteger(n) || Math.abs(n) > 2147483647) throw new Error('Wert muss eine ganze Zahl sein.');
  return n;
}

async function set(key, value) {
  const def = DEF_BY_KEY.get(key);
  const v = validate(def, value);
  const e = entry();

  if (mc.status !== 'running') {
    if (mc.status !== 'offline') throw Object.assign(new Error('Server startet/stoppt gerade – bitte kurz warten.'), { status: 409 });
    e.pending[key] = v;
    saveEntry(e);
    return { pending: true };
  }

  const scheme = e.scheme || 'new';
  const name = nameFor(def, scheme);
  if (!name) throw new Error('Diese Spielregel gibt es in deiner Minecraft-Version nicht.');
  const result = new Promise((resolve) => {
    const onLine = (line) => {
      const m = line.match(RESP_RE);
      if (m && bare(m[1]) === name) done(true);
      else if (ERR_RE.test(line)) done(false);
    };
    const timer = setTimeout(() => done(null), 3000);
    const done = (ok) => {
      clearTimeout(timer);
      mc.off('line', onLine);
      resolve(ok);
    };
    mc.on('line', onLine);
  });
  mc.sendCommand(`gamerule ${name} ${toRaw(def, v, scheme)}`);
  const ok = await result;
  if (ok === false) throw new Error(`Der Server hat "${name}" abgelehnt (gibt es in dieser Version evtl. nicht).`);
  e.values[key] = v;
  delete e.pending[key];
  saveEntry(e);
  return { pending: false };
}

function clearPending() {
  const e = entry();
  e.pending = {};
  saveEntry(e);
}

function list() {
  const e = entry();
  const known = Object.keys(e.values).length > 0;
  const rules = DEFS.filter((d) => {
    if (known) return d.key in e.values; // nur Regeln, die diese Version wirklich hat
    return d.only !== 'old';
  }).map((d) => ({
    key: d.key, label: d.label, desc: d.desc, type: d.type, cat: d.cat,
    command: nameFor(d, e.scheme || 'new'),
    value: e.values[d.key],
    pending: d.key in e.pending ? e.pending[d.key] : undefined,
  }));
  return {
    running: mc.status === 'running',
    status: mc.status,
    known,
    scheme: e.scheme,
    updatedAt: e.updatedAt,
    pendingCount: Object.keys(e.pending).length,
    categories: CATS.map((c) => ({ name: c, rules: rules.filter((r) => r.cat === c) })).filter((c) => c.rules.length),
  };
}

// Beim Serverstart: vorgemerkte Änderungen anwenden und aktuelle Werte einlesen
mc.on('ready', async () => {
  try {
    await sleep(1500);
    if (mc.status !== 'running') return;
    const e = await query();
    const pending = Object.entries(e.pending || {});
    if (!pending.length) return mc.emit('gamerules-changed');
    const applied = [];
    for (const [key, value] of pending) {
      try {
        await set(key, value);
        applied.push(DEF_BY_KEY.get(key)?.label || key);
      } catch (err) {
        mc.log(`Spielregel ${key} konnte nicht gesetzt werden: ${err.message}`);
      }
    }
    clearPending();
    if (applied.length) mc.log(`Vorgemerkte Spielregeln angewendet: ${applied.join(', ')}`);
    mc.emit('gamerules-changed');
  } catch (err) {
    mc.log(`Spielregeln konnten nicht gelesen werden: ${err.message}`);
  }
});

// Welche Schreibweise der Server nutzt ('new' ab 1.21.11, 'old' davor; unbekannt -> 'new')
function scheme() {
  return entry().scheme || 'new';
}

// Befehlsname einer Regel für diesen Server (z.B. advance_time bzw. doDaylightCycle)
function commandName(key) {
  const d = DEF_BY_KEY.get(key);
  return d ? nameFor(d, scheme()) : key;
}

function dropPending(key) {
  const e = entry();
  if (key in e.pending) {
    delete e.pending[key];
    saveEntry(e);
  }
}

module.exports = { list, query, set, clearPending, dropPending, scheme, commandName };
