// Chat-Befehle ohne Mod: das Tool liest den Chat aus dem Server-Log und antwortet per tellraw.
//   !ping  -> Uhrzeit des letzten Neustarts, Laufzeit und gemessene Reaktionszeit des Servers
// (Echte /Befehle gehen ohne Mod nicht – Befehle von Spielern stehen nicht im Log, Chat schon.)
const mc = require('./mcServer');

// "...]: <Name> !ping" bzw. "...]: [Not Secure] <Name> !ping"
const PING_RE = /\]:\s(?:\[[^\]]*\]\s)?<([A-Za-z0-9_]{1,16})>\s+!ping\s*$/i;
const TIME_RE = /The time is \d+/;
const COOLDOWN_MS = 3000;
const lastUse = new Map();

function fmtDate(ms) {
  const d = new Date(ms);
  const date = d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return `${date}, ${time} Uhr`;
}

function fmtUptime(ms) {
  const min = Math.floor(ms / 60000);
  const d = Math.floor(min / 1440);
  const h = Math.floor((min % 1440) / 60);
  const m = min % 60;
  if (d) return `${d} ${d === 1 ? 'Tag' : 'Tage'} ${h} Std.`;
  if (h) return `${h} Std. ${m} Min.`;
  if (m) return `${m} Min.`;
  return 'weniger als 1 Min.';
}

// Reaktionszeit messen: kurzer Befehl an den Server, Zeit bis zur Antwort im Log.
// Die Antwort wird aus der Konsole herausgefiltert.
function measureResponse(timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = process.hrtime.bigint();
    let done = false;
    let removeFilter = () => {};
    const finish = (ms) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      mc.off('line', onLine);
      setTimeout(() => removeFilter(), 50); // Zeile ist dann sicher schon gefiltert
      resolve(ms);
    };
    const onLine = (line) => {
      if (TIME_RE.test(line)) finish(Number(process.hrtime.bigint() - t0) / 1e6);
    };
    let swallowed = false;
    removeFilter = mc.addLogFilter((line) => {
      if (!swallowed && TIME_RE.test(line)) {
        swallowed = true;
        return true;
      }
      return false;
    });
    const timer = setTimeout(() => finish(null), timeoutMs);
    mc.on('line', onLine);
    try {
      mc.sendCommand('time query gametime');
    } catch (_) {
      finish(null);
    }
  });
}

function colorFor(ms) {
  if (ms == null) return 'red';
  if (ms < 50) return 'green';
  if (ms < 200) return 'yellow';
  return 'red';
}

async function handlePing(name) {
  const now = Date.now();
  if (now - (lastUse.get(name.toLowerCase()) || 0) < COOLDOWN_MS) return;
  lastUse.set(name.toLowerCase(), now);

  const response = await measureResponse();
  if (mc.status !== 'running') return;

  let perf = {};
  try {
    perf = require('./perf').getState();
  } catch (_) {
    /* egal */
  }
  const player = mc.online.get(name) || [...mc.online.entries()].find(([n]) => n.toLowerCase() === name.toLowerCase())?.[1];
  const nl = { text: '\n' };
  const label = (t) => ({ text: t, color: 'gray' });
  const parts = [
    { text: 'Pong', color: 'green', bold: true },
    { text: `, ${name}!`, color: 'green' },
    nl,
    label('Letzter Neustart: '),
    { text: mc.startedAt ? fmtDate(mc.startedAt) : 'unbekannt', color: 'white' },
    nl,
    label('Läuft seit: '),
    { text: mc.startedAt ? fmtUptime(now - mc.startedAt) : '–', color: 'white' },
    nl,
    label('Server-Reaktion: '),
    { text: response == null ? 'keine Antwort' : `${Math.max(1, Math.round(response))} ms`, color: colorFor(response) },
  ];
  if (perf.tps != null) parts.push(label('  ·  TPS: '), { text: String(perf.tps), color: perf.tps >= 19 ? 'green' : perf.tps >= 15 ? 'yellow' : 'red' });
  if (player && player.ping != null) parts.push(label('  ·  Dein Ping: '), { text: `${player.ping} ms`, color: 'white' });

  try {
    mc.sendCommand(`tellraw ${name} ${JSON.stringify(parts)}`);
    mc.log(`!ping von ${name} beantwortet (Server-Reaktion ${response == null ? '–' : Math.round(response) + ' ms'}).`);
  } catch (_) {
    /* Server gerade weg */
  }
}

mc.on('line', (line) => {
  if (mc.status !== 'running') return;
  const m = line.match(PING_RE);
  if (m) handlePing(m[1]).catch(() => {});
});

module.exports = { PING_RE };
