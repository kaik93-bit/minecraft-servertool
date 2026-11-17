// Automatische Neustarts zu festen Uhrzeiten (an ausgewählten Wochentagen)
// inkl. Chat-Warnungen an die Spieler, optionalem Backup und "Neustart mit Countdown".
const fs = require('fs');
const path = require('path');
const config = require('./config');
const mc = require('./mcServer');
const backups = require('./backups');

const DATA_FILE = path.join(__dirname, '..', 'data', 'autorestart.json');
const DEFAULTS = {
  enabled: false,
  times: ['04:00'],
  days: [0, 1, 2, 3, 4, 5, 6], // 0 = Sonntag (wie JavaScript getDay)
  warnMinutes: [10, 5, 1],
  backup: false,
};
const COUNTDOWN_SECONDS = [30, 10, 5, 4, 3, 2, 1];

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
  const s = loadAll()[config.paths().serverDir || ''] || {};
  return { ...DEFAULTS, ...s };
}

function saveSettings(s) {
  const all = loadAll();
  all[config.paths().serverDir || ''] = s;
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(all, null, 2), 'utf8');
}

// ---------- Laufzeit-Zustand ----------
const rt = {
  skipKey: null, // Zeitpunkt (ms) eines übersprungenen Termins
  oneOff: null, // einmaliger Neustart (ms), z.B. "in 5 Minuten"
  sent: new Set(), // bereits gesendete Warnungen "<ziel>:<sekunden>"
  doneKey: null, // zuletzt ausgeführter Termin
  restarting: false,
};

function nextScheduled(s = getSettings(), from = Date.now()) {
  if (!s.enabled || !s.times.length || !s.days.length) return null;
  let best = null;
  for (let d = 0; d <= 7; d++) {
    for (const t of s.times) {
      const [h, m] = t.split(':').map(Number);
      const c = new Date(from);
      c.setDate(c.getDate() + d);
      c.setHours(h, m, 0, 0);
      if (c.getTime() <= from || !s.days.includes(c.getDay())) continue;
      if (!best || c.getTime() < best) best = c.getTime();
    }
  }
  return best;
}

// Der nächste tatsächlich auszuführende Neustart (einmaliger Countdown hat Vorrang)
function nextTarget() {
  const s = getSettings();
  // 5 s Rückblick, damit der Termin genau zur Uhrzeit noch "fällig" ist
  let sched = nextScheduled(s, Date.now() - 5000);
  if (sched && sched === rt.skipKey) sched = nextScheduled(s, sched); // übersprungen -> den danach
  if (sched && sched === rt.doneKey && sched <= Date.now()) sched = nextScheduled(s); // schon erledigt
  const candidates = [rt.oneOff, sched].filter((x) => x && x > Date.now() - 5000);
  if (!candidates.length) return null;
  const at = Math.min(...candidates);
  return { at, kind: at === rt.oneOff ? 'countdown' : 'scheduled' };
}

function status() {
  const s = getSettings();
  const next = nextTarget();
  const sched = nextScheduled(s);
  return {
    settings: s,
    next,
    skipped: rt.skipKey && rt.skipKey === sched ? rt.skipKey : null,
    restarting: rt.restarting,
    serverStatus: mc.status,
  };
}

// ---------- Nachrichten an Spieler ----------
function fmtLeft(sec) {
  if (sec >= 60) {
    const m = Math.round(sec / 60);
    return `${m} ${m === 1 ? 'Minute' : 'Minuten'}`;
  }
  return `${sec} ${sec === 1 ? 'Sekunde' : 'Sekunden'}`;
}

function announce(text, color = 'yellow') {
  if (mc.status !== 'running') return;
  const json = JSON.stringify([{ text: '[Server] ', color: 'gold', bold: true }, { text, color, bold: false }]);
  try {
    mc.sendCommand(`tellraw @a ${json}`); // tellraw erzeugt keine Rückmeldung im OP-Chat
  } catch (_) {
    /* Server gerade weg */
  }
}

// ---------- Ablauf ----------
async function runRestart(kind) {
  if (rt.restarting) return;
  if (mc.status !== 'running') {
    mc.log(`Auto-Neustart übersprungen: Server läuft nicht.`);
    return;
  }
  rt.restarting = true;
  mc.emit('autorestart', status());
  try {
    const s = getSettings();
    announce('Server startet jetzt neu – bis gleich!', 'red');
    mc.log(kind === 'countdown' ? 'Neustart (Countdown) wird ausgeführt ...' : 'Geplanter Auto-Neustart wird ausgeführt ...');
    if (s.backup) {
      try {
        await backups.create('world');
      } catch (err) {
        mc.log(`Backup vor dem Neustart fehlgeschlagen: ${err.message} – Neustart wird trotzdem ausgeführt.`);
      }
    }
    await mc.restart();
  } catch (err) {
    mc.log(`Auto-Neustart fehlgeschlagen: ${err.message}`);
  } finally {
    rt.restarting = false;
    mc.emit('autorestart', status());
  }
}

function tick() {
  const next = nextTarget();
  if (!next) return;
  const left = Math.round((next.at - Date.now()) / 1000);
  const s = getSettings();

  // Warnungen (nur wenn wir gerade im passenden Zeitfenster sind – keine "Nachhol"-Flut)
  const offsets = [...new Set([...s.warnMinutes.map((m) => m * 60), ...COUNTDOWN_SECONDS])];
  for (const off of offsets) {
    const key = `${next.at}:${off}`;
    if (left <= off && left > off - 3 && !rt.sent.has(key)) {
      rt.sent.add(key);
      announce(`Neustart in ${fmtLeft(off)}!`, off <= 10 ? 'red' : 'yellow');
      if (off >= 60 || off === 30 || off === 10) mc.log(`Auto-Neustart in ${fmtLeft(off)} (Spieler wurden gewarnt).`);
    }
  }

  if (left <= 0 && rt.doneKey !== next.at) {
    rt.doneKey = next.at;
    if (next.kind === 'countdown') rt.oneOff = null;
    if (rt.sent.size > 500) rt.sent.clear();
    runRestart(next.kind);
  }
}
setInterval(tick, 1000);

// ---------- API ----------
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function save(input) {
  const s = { ...getSettings() };
  if (input.enabled !== undefined) s.enabled = !!input.enabled;
  if (input.times !== undefined) {
    if (!Array.isArray(input.times)) throw httpError(400, 'Ungültige Uhrzeiten.');
    const times = [...new Set(input.times.map(String))];
    for (const t of times) if (!TIME_RE.test(t)) throw httpError(400, `Ungültige Uhrzeit: ${t}`);
    if (times.length > 24) throw httpError(400, 'Maximal 24 Uhrzeiten.');
    s.times = times.sort();
  }
  if (input.days !== undefined) {
    if (!Array.isArray(input.days) || input.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) throw httpError(400, 'Ungültige Wochentage.');
    s.days = [...new Set(input.days)].sort();
  }
  if (input.warnMinutes !== undefined) {
    if (!Array.isArray(input.warnMinutes)) throw httpError(400, 'Ungültige Warnzeiten.');
    const w = [...new Set(input.warnMinutes.map(Number))];
    if (w.some((m) => !Number.isInteger(m) || m < 1 || m > 120) || w.length > 10) {
      throw httpError(400, 'Warnzeiten: ganze Minuten von 1 bis 120, höchstens 10 Stück.');
    }
    s.warnMinutes = w.sort((a, b) => b - a);
  }
  if (input.backup !== undefined) s.backup = !!input.backup;
  if (s.enabled && (!s.times.length || !s.days.length)) throw httpError(400, 'Bitte mindestens eine Uhrzeit und einen Wochentag auswählen.');
  saveSettings(s);
  rt.skipKey = null;
  const st = status();
  mc.emit('autorestart', st);
  return st;
}

function skipNext(skip) {
  const sched = nextScheduled();
  rt.skipKey = skip && sched ? sched : null;
  if (skip && sched) mc.log(`Nächster Auto-Neustart (${new Date(sched).toLocaleString('de-DE')}) wird übersprungen.`);
  const st = status();
  mc.emit('autorestart', st);
  return st;
}

function startCountdown(minutes) {
  const m = Number(minutes);
  if (!Number.isFinite(m) || m < 0.5 || m > 120) throw httpError(400, 'Countdown: 1 bis 120 Minuten.');
  if (mc.status !== 'running') throw httpError(409, 'Der Server läuft nicht.');
  rt.oneOff = Date.now() + Math.round(m * 60) * 1000;
  announce(`Der Server wird in ${fmtLeft(Math.round(m * 60))} neu gestartet.`);
  mc.log(`Neustart mit Countdown: in ${fmtLeft(Math.round(m * 60))}.`);
  const st = status();
  mc.emit('autorestart', st);
  return st;
}

function cancelCountdown() {
  if (rt.oneOff) {
    rt.oneOff = null;
    announce('Der geplante Neustart wurde abgebrochen.', 'green');
    mc.log('Neustart-Countdown abgebrochen.');
  }
  const st = status();
  mc.emit('autorestart', st);
  return st;
}

module.exports = { status, save, skipNext, startCountdown, cancelCountdown, nextScheduled };
