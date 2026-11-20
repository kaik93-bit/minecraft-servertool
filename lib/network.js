// Adressen, unter denen Spieler den Minecraft-Server erreichen: dieser PC, Heimnetz (LAN), Internet.
const os = require('os');
const config = require('./config');
const { readMap } = require('./serverSettings');

const PUBLIC_TTL_MS = 15 * 60 * 1000;
const PUBLIC_RETRY_MS = 60 * 1000;
const pub = { ip: null, error: null, checkedAt: 0, pending: null };

// Virtuelle Netzwerkkarten (VPN-Software, VirtualBox, Hyper-V, WSL …) sind für Mitspieler nutzlos
const VIRTUAL_RE = /vethernet|virtualbox|vmware|vbox|hyper-v|wsl|docker|loopback|bluetooth|tailscale|zerotier|hamachi|radmin/i;
const isPrivate = (ip) => /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);

function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal || a.address.startsWith('169.254.')) continue;
      out.push({ ip: a.address, name, virtual: VIRTUAL_RE.test(name) || !isPrivate(a.address) });
    }
  }
  // Echte Heimnetz-Adressen zuerst
  return out.sort((x, y) => Number(x.virtual) - Number(y.virtual));
}

async function refreshPublic(force = false) {
  const age = Date.now() - pub.checkedAt;
  if (!force && age < (pub.ip ? PUBLIC_TTL_MS : PUBLIC_RETRY_MS)) return;
  if (pub.pending) return pub.pending;
  pub.pending = (async () => {
    try {
      const res = await fetch('https://api.ipify.org', {
        headers: { 'User-Agent': 'Minecraft-Servertool' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const ip = (await res.text()).trim();
      if (!/^[\d.]+$|^[0-9a-f:]+$/i.test(ip)) throw new Error('unerwartete Antwort');
      pub.ip = ip;
      pub.error = null;
    } catch (err) {
      pub.error = 'Öffentliche IP konnte nicht ermittelt werden (keine Internetverbindung?)';
    } finally {
      pub.checkedAt = Date.now();
      pub.pending = null;
    }
  })();
  return pub.pending;
}

async function status({ force = false } = {}) {
  const { serverDir } = config.paths();
  const props = serverDir ? readMap(serverDir) : {};
  const port = Number(props['server-port']) || 25565;
  const bound = (props['server-ip'] || '').trim() || null;
  await refreshPublic(force);
  return {
    port,
    defaultPort: port === 25565,
    bound, // server-ip in server.properties: der Server lauscht nur auf dieser Adresse
    lan: lanAddresses(),
    public: { ip: pub.ip, error: pub.ip ? null : pub.error },
  };
}

module.exports = { status };
