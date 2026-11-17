// Server-Leistung: Ping (Antwortzeit wie in der Minecraft-Serverliste), TPS und MSPT.
//  - Ping: "Server List Ping"-Protokoll über TCP an den eigenen Server
//  - TPS/MSPT: Befehl "tick query" (ab 1.20.3). Die Antwort wird in der Konsole ausgeblendet.
const net = require('net');
const config = require('./config');
const mc = require('./mcServer');
const { readMap } = require('./serverSettings');

const PING_EVERY_MS = 5000;
const TICK_EVERY_MS = 10000;
const HISTORY = 60;

const state = {
  ping: null, // ms
  tps: null,
  mspt: null,
  targetTps: 20,
  tickStatus: null, // running | lagging | frozen | sprinting
  players: null, // { online, max }
  version: null,
  tickSupported: true,
  updatedAt: null,
  history: [], // [{ t, ping, tps, mspt }]
};

// ---------- Server List Ping ----------
function varint(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return Buffer.from(out);
}

function readVarint(buf, off) {
  let value = 0;
  for (let i = 0; i < 5; i++) {
    if (off + i >= buf.length) return null;
    const b = buf[off + i];
    value |= (b & 0x7f) << (7 * i);
    if (!(b & 0x80)) return { value, size: i + 1 };
  }
  throw new Error('VarInt zu lang');
}

const mcString = (s) => {
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([varint(b.length), b]);
};
const packet = (id, payload = Buffer.alloc(0)) => {
  const body = Buffer.concat([varint(id), payload]);
  return Buffer.concat([varint(body.length), body]);
};

function serverListPing(host, port, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    let buf = Buffer.alloc(0);
    let status = null;
    let sentAt = 0;
    const fail = (err) => {
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(timeoutMs, () => fail(new Error('Zeitüberschreitung')));
    sock.on('error', fail);
    sock.on('connect', () => {
      const portBuf = Buffer.alloc(2);
      portBuf.writeUInt16BE(port);
      sock.write(packet(0x00, Buffer.concat([varint(-1), mcString(host), portBuf, varint(1)]))); // Handshake (Status)
      sock.write(packet(0x00)); // Status-Anfrage
    });
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        const len = readVarint(buf, 0);
        if (!len || buf.length < len.size + len.value) return;
        const body = buf.subarray(len.size, len.size + len.value);
        buf = buf.subarray(len.size + len.value);
        const id = readVarint(body, 0);
        if (id.value === 0x00 && !status) {
          const strLen = readVarint(body, id.size);
          status = JSON.parse(body.subarray(id.size + strLen.size, id.size + strLen.size + strLen.value).toString('utf8'));
          const payload = Buffer.alloc(8);
          payload.writeBigInt64BE(BigInt(Date.now()));
          sentAt = process.hrtime.bigint();
          sock.write(packet(0x01, payload)); // Ping
        } else if (id.value === 0x01) {
          const latency = Number(process.hrtime.bigint() - sentAt) / 1e6;
          sock.destroy();
          resolve({ latency, status });
        }
      }
    });
  });
}

// ---------- tick query ----------
const TICK_LINE_RE = /The game is (running normally|running, but can't keep up|frozen|sprinting)|Target tick rate: ([\d.,]+)|Average time per tick: ([\d.,]+)\s*ms|Percentiles: P50|Unknown or incomplete command|<--\[HERE\]/i;
const num = (s) => Number(String(s).replace(',', '.'));

async function tickQuery() {
  const result = {};
  const onLine = (line) => {
    let m;
    if ((m = line.match(/The game is (running normally|running, but can't keep up|frozen|sprinting)/i))) {
      result.status = /normally/i.test(m[1]) ? 'running' : /keep up/i.test(m[1]) ? 'lagging' : m[1].toLowerCase();
    }
    if ((m = line.match(/Target tick rate: ([\d.,]+)/i))) result.target = num(m[1]);
    if ((m = line.match(/Average time per tick: ([\d.,]+)\s*ms/i))) result.mspt = num(m[1]);
    if (/Unknown or incomplete command/i.test(line)) result.unsupported = true;
  };
  mc.on('line', onLine);
  const removeFilter = mc.addLogFilter((l) => TICK_LINE_RE.test(l) && !/joined|left|<[^>]+>/.test(l));
  try {
    mc.sendCommand('tick query');
    for (let i = 0; i < 15 && result.mspt === undefined && !result.unsupported; i++) await new Promise((r) => setTimeout(r, 100));
  } finally {
    mc.off('line', onLine);
    setTimeout(removeFilter, 800); // späte Zeilen (Percentiles) noch ausblenden
  }
  return result;
}

// ---------- Messschleife ----------
let lastTick = 0;
let busy = false;

async function measure() {
  if (busy || mc.status !== 'running') return;
  busy = true;
  try {
    const { serverDir } = config.paths();
    const props = readMap(serverDir);
    const host = props['server-ip'] || '127.0.0.1';
    const port = Number(props['server-port']) || 25565;

    try {
      const { latency, status } = await serverListPing(host, port);
      state.ping = Math.round(latency * 10) / 10;
      state.players = status?.players ? { online: status.players.online, max: status.players.max } : null;
      state.version = status?.version?.name || null;
    } catch (_) {
      state.ping = null;
    }

    if (state.tickSupported && Date.now() - lastTick >= TICK_EVERY_MS) {
      lastTick = Date.now();
      const t = await tickQuery();
      if (t.unsupported) state.tickSupported = false;
      if (t.mspt !== undefined) {
        state.mspt = Math.round(t.mspt * 10) / 10;
        state.targetTps = t.target || 20;
        state.tps = Math.round(Math.min(state.targetTps, 1000 / Math.max(t.mspt, 0.001)) * 10) / 10;
        state.tickStatus = t.status || null;
      }
    }

    state.updatedAt = Date.now();
    state.history.push({ t: state.updatedAt, ping: state.ping, tps: state.tps, mspt: state.mspt });
    if (state.history.length > HISTORY) state.history.shift();
    mc.emit('perf', getState());
  } finally {
    busy = false;
  }
}

function getState() {
  return { ...state, history: state.history.slice(), running: mc.status === 'running' };
}

function reset() {
  Object.assign(state, { ping: null, tps: null, mspt: null, tickStatus: null, players: null, version: null, tickSupported: true, history: [], updatedAt: null });
  lastTick = 0;
  mc.emit('perf', getState());
}

setInterval(() => measure().catch(() => {}), PING_EVERY_MS);
mc.on('ready', () => setTimeout(() => measure().catch(() => {}), 3000));
mc.on('status', (s) => {
  if (s.status === 'offline' && state.updatedAt) reset();
});

module.exports = { getState, serverListPing };
