// Frontend-Logik: Tabs, WebSocket-Konsole, Server-Steuerung, Spieler, Mods, Backups, Einstellungen.
const $ = (sel) => document.querySelector(sel);
const state = {
  status: 'offline', startedAt: null, mods: [], players: null, attempts: [],
  cmdHistory: [], historyIdx: -1, currentTab: 'dashboard', quitting: false,
};

// ---------------- Helfer ----------------
async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { status: res.status });
  return data;
}

function toast(msg, type = 'info') {
  const colors = { info: 'bg-zinc-800', ok: 'bg-emerald-700', err: 'bg-red-700', warn: 'bg-amber-700' };
  const el = document.createElement('div');
  el.className = `toast ${colors[type] || colors.info}`;
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'err' ? 7000 : 4500);
}

const fmtSize = (b) =>
  b > 1024 ** 3 ? (b / 1024 ** 3).toFixed(2) + ' GB' : b > 1024 ** 2 ? (b / 1024 ** 2).toFixed(1) + ' MB' : (b / 1024).toFixed(0) + ' KB';
const fmtDate = (ms) => new Date(ms).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const avatar = (name, size = 20) =>
  `<img src="https://mc-heads.net/avatar/${encodeURIComponent(name)}/${size}" class="rounded inline-block" style="width:${size}px;height:${size}px" onerror="this.style.visibility='hidden'" alt="">`;

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}h ${m}m` : m ? `${m}m ${sec}s` : `${sec}s`;
}

function fmtAgo(ms) {
  if (!ms) return '–';
  const d = Date.now() - ms;
  if (d < 60e3) return 'gerade eben';
  if (d < 3600e3) return `vor ${Math.floor(d / 60e3)} Min.`;
  if (d < 86400e3) return `vor ${Math.floor(d / 3600e3)} Std.`;
  if (d < 7 * 86400e3) return `vor ${Math.floor(d / 86400e3)} Tag(en)`;
  return fmtDate(ms);
}

function pingHtml(ping, online = true) {
  if (!online) return '<span class="ping-none">–</span>';
  if (ping == null) return '<span class="ping-none" title="Ping nicht messbar (Gerät/Router des Spielers antwortet nicht auf Ping)">?</span>';
  const cls = ping < 80 ? 'ping-good' : ping < 150 ? 'ping-mid' : 'ping-bad';
  return `<span class="${cls} font-mono" title="Netzwerk-Ping zwischen Server und Spieler">${ping} ms</span>`;
}

let debounceTimers = {};
function debounce(key, fn, ms = 400) {
  clearTimeout(debounceTimers[key]);
  debounceTimers[key] = setTimeout(fn, ms);
}

// ---------------- Tabs ----------------
function showTab(name) {
  if (!document.getElementById(`tab-${name}`)) name = 'dashboard';
  state.currentTab = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  const tabBtn = document.querySelector(`.tab[data-tab="${name}"] span`);
  $('#pageTitle').textContent = name === 'settings' ? 'Tool-Einstellungen' : tabBtn ? tabBtn.textContent : '';
  document.querySelectorAll('.tab-panel').forEach((p) => p.classList.toggle('hidden', p.id !== `tab-${name}`));
  try { localStorage.setItem('tab', name); } catch (_) {}
  if (name === 'players') loadPlayers();
  if (name === 'server') loadServerSettings();
  if (name === 'mods') loadMods();
  if (name === 'backups') loadBackups();
  if (name === 'settings') loadSettings();
}
$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('[data-tab]');
  if (tab) showTab(tab.dataset.tab);
});

// ---------------- Server-Datei öffnen (nativer Dialog) ----------------
async function loadServerInfo() {
  try {
    const { config, info } = await api('GET', '/api/config');
    const label = $('#serverFileLabel');
    label.textContent = config.serverFile || 'nicht ausgewählt';
    label.title = config.serverFile || '';
    $('#setupCard').classList.toggle('hidden', !!(config.serverFile && info.serverDirExists && info.startFileExists));
    return { config, info };
  } catch (err) {
    toast(err.message, 'err');
  }
}

// Zeigt einen Hinweis, solange der Windows-Dialog offen ist
async function browseDialog(type, apply) {
  $('#dialogOverlayName').textContent = type === 'folder' ? '„Ordner suchen“' : '„Datei öffnen“';
  $('#dialogOverlay').classList.remove('hidden');
  try {
    return (await api('POST', '/api/browse', { type, apply })).path;
  } finally {
    $('#dialogOverlay').classList.add('hidden');
  }
}

async function openServerFile() {
  try {
    const path = await browseDialog('file', 'serverFile');
    if (!path) return;
    toast(`Server ausgewählt: ${path}`, 'ok');
    await loadServerInfo();
    if (state.currentTab === 'settings') loadSettings();
  } catch (err) {
    toast(err.message, 'err');
  }
}
document.addEventListener('click', (e) => {
  if (e.target.closest('[data-open-server]')) openServerFile();
});

// ---------------- Status ----------------
const STATUS_UI = {
  offline: ['Server offline', 'is-offline'],
  starting: ['Server startet …', 'is-starting'],
  running: ['Server läuft', 'is-running'],
  stopping: ['Server stoppt …', 'is-stopping'],
};

function applyStatus(s) {
  const statusChanged = state.status !== s.status;
  state.status = s.status;
  state.startedAt = s.startedAt;
  const [text, cls] = STATUS_UI[s.status] || STATUS_UI.offline;
  const badge = $('#statusBadge');
  badge.textContent = text;
  badge.className = `status-pill ${cls}`;

  const alive = s.status !== 'offline';
  $('#btnStart').disabled = alive;
  $('#btnStop').disabled = !alive || s.status === 'stopping';
  $('#btnRestart').disabled = s.status === 'stopping';
  $('#btnKill').classList.toggle('hidden', s.status !== 'stopping');
  $('#cmdInput').disabled = !alive;
  $('#btnRefreshPlayers').disabled = s.status !== 'running';
  $('#infoPid').textContent = s.pid || '–';
  $('#modRestartHint').classList.toggle('hidden', !alive);

  // Online-Spieler mit Ping (Dashboard)
  const players = s.players || [];
  $('#playerCount').textContent = alive ? `(${players.length}${s.maxPlayers ? '/' + s.maxPlayers : ''})` : '';
  $('#playerList').innerHTML = players.length
    ? players
        .map(
          (p) => `<li><button data-player="${esc(p.name)}" class="w-full flex items-center gap-2 text-sm rounded px-1.5 py-1 -mx-1.5 hover:bg-zinc-800 text-left" title="Klicken für Aktionen">
            ${avatar(p.name)}<span>${esc(p.name)}</span><span class="ml-auto text-xs">${pingHtml(p.ping)}</span><span class="text-zinc-600">›</span></button></li>`
        )
        .join('')
    : `<li class="text-sm text-zinc-500">${alive ? 'Niemand online' : 'Server offline'}</li>`;

  state.lastOnline = players;
  updatePlayerModalLive(players);
  if (statusChanged && state.currentTab === 'server') debounce('serverSettings', loadServerSettings, 600);

  // Spieler-Tab aktuell halten (Ping, Online-Status)
  if (state.currentTab === 'players') {
    if (statusChanged) debounce('players', loadPlayers, 800);
    else if (state.players) {
      const online = new Map(players.map((p) => [p.name.toLowerCase(), p]));
      const known = new Set(state.players.players.map((p) => p.name.toLowerCase()));
      if ([...online.keys()].some((k) => !known.has(k))) return debounce('players', loadPlayers, 800);
      for (const p of state.players.players) {
        const o = online.get(p.name.toLowerCase());
        if (p.online && !o) p.lastSeen = Date.now();
        p.online = !!o;
        p.ping = o ? o.ping : null;
      }
      renderPlayers();
    }
  }
}

setInterval(() => {
  $('#infoUptime').textContent = state.startedAt ? fmtDuration(Date.now() - state.startedAt) : '–';
  renderArDash();
  renderArNext();
}, 1000);

// ---------------- Server-Leistung ----------------
function statusChip(cls, text) {
  return `<span class="status-chip ${cls}">${text}</span>`;
}

function renderPerf(p) {
  const fmt = (v) => (v == null ? '–' : String(v).replace('.', ','));
  $('#perfPing').textContent = fmt(p.ping);
  $('#perfTps').textContent = fmt(p.tps);
  $('#perfTpsTarget').textContent = fmt(p.targetTps || 20);
  $('#perfMspt').textContent = fmt(p.mspt);
  $('#perfPlayers').textContent = p.players ? `${p.players.online} / ${p.players.max}` : '–';
  $('#perfVersion').textContent = p.version || '–';
  $('#perfUpdated').textContent = p.updatedAt ? `aktualisiert ${new Date(p.updatedAt).toLocaleTimeString('de-DE')}` : '';

  let chip;
  if (!p.running) chip = statusChip('status-idle', '● Server offline');
  else if (p.tickStatus === 'frozen') chip = statusChip('status-idle', '⏸ Pausiert – keine Spieler online');
  else if (!p.tickSupported) chip = statusChip('status-idle', 'ℹ TPS/MSPT gibt es erst ab Minecraft 1.20.3');
  else if (p.mspt == null) chip = statusChip('status-idle', '⏳ Messe …');
  else if (p.mspt < 40 && p.tickStatus !== 'lagging') chip = statusChip('status-good', '✓ Läuft flüssig');
  else if (p.mspt < 50 && p.tickStatus !== 'lagging') chip = statusChip('status-warn', '⚠ Knapp am Limit');
  else chip = statusChip('status-crit', '✖ Server laggt');
  $('#perfStatus').innerHTML = chip;
}

// ---------------- Auto-Neustart ----------------
const DAY_NAMES = [[1, 'Mo'], [2, 'Di'], [3, 'Mi'], [4, 'Do'], [5, 'Fr'], [6, 'Sa'], [0, 'So']];
const ar = { data: null, form: null, dirty: false };

function setAutoRestart(d) {
  ar.data = d;
  if (!ar.dirty) ar.form = JSON.parse(JSON.stringify(d.settings));
  renderArDash();
  if (state.currentTab === 'server' && srv.sub === 'restart') renderAutoRestart();
}

async function loadAutoRestart() {
  try {
    ar.dirty = false;
    setAutoRestart(await api('GET', '/api/autorestart'));
    renderAutoRestart();
  } catch (err) {
    $('#arNext').innerHTML = `<span class="text-red-400">${esc(/404/.test(err.message) ? 'Diese Funktion ist erst nach einem Neustart des Tools verfügbar (blauer Hinweis oben).' : err.message)}</span>`;
  }
}

function fmtWhen(ms) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date();
  tomorrow.setDate(today.getDate() + 1);
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `heute ${time} Uhr`;
  if (d.toDateString() === tomorrow.toDateString()) return `morgen ${time} Uhr`;
  return `${d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit' })} ${time} Uhr`;
}

function fmtIn(ms) {
  const s = Math.max(0, Math.round((ms - Date.now()) / 1000));
  if (s < 60) return `${s} Sek.`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} Min. ${s % 60 ? (s % 60) + ' Sek.' : ''}`.trim();
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} Std. ${m % 60} Min.` : `${Math.floor(h / 24)} Tagen`;
}

function renderArDash() {
  const d = ar.data;
  const box = $('#arDash');
  if (!d || (!d.next && !d.restarting)) return box.classList.add('hidden');
  box.classList.remove('hidden');
  const countdown = d.next?.kind === 'countdown';
  if (d.restarting) {
    $('#arDashText').innerHTML = '🔄 <b>Neustart läuft …</b>';
  } else {
    $('#arDashText').innerHTML = `${countdown ? '⏱ <b>Neustart-Countdown</b>' : '⏰ Nächster Auto-Neustart'}: <b>${fmtWhen(d.next.at)}</b> <span class="text-zinc-400">(in ${fmtIn(d.next.at)})</span>` +
      (d.serverStatus !== 'running' && !countdown ? ' <span class="text-zinc-500">– nur wenn der Server dann läuft</span>' : '');
  }
  $('#arDashSkip').classList.toggle('hidden', countdown || d.restarting || !d.next);
  $('#arDashCancel').classList.toggle('hidden', !countdown || d.restarting);
}

function renderArNext() {
  const d = ar.data;
  if (!d || state.currentTab !== 'server' || srv.sub !== 'restart') return;
  let html;
  if (!d.settings.enabled) html = '<span class="text-zinc-400">Automatische Neustarts sind <b>aus</b>.</span>';
  else if (!d.next) html = 'Kein Termin geplant.';
  else html = `⏰ Nächster Neustart: <b>${fmtWhen(d.next.at)}</b> <span class="text-zinc-400">(in ${fmtIn(d.next.at)})</span>`;
  if (d.skipped) {
    html += `<div class="text-amber-300 mt-1">⏭ Der Termin ${fmtWhen(d.skipped)} wird übersprungen. <button class="underline" id="arUnskip">Rückgängig</button></div>`;
  }
  $('#arNext').innerHTML = html;
  document.getElementById('arUnskip')?.addEventListener('click', () => arSkip(false));
  const cd = d.next?.kind === 'countdown';
  $('#arCdCancel').classList.toggle('hidden', !cd);
  $('#arCdStart').disabled = cd || d.serverStatus !== 'running';
  $('#arCdStart').title = d.serverStatus !== 'running' ? 'Der Server läuft nicht' : '';
}

function renderAutoRestart() {
  const f = ar.form;
  if (!f) return;
  $('#arSwitch').classList.toggle('on', f.enabled);
  $('#arBackup').classList.toggle('on', f.backup);
  $('#arTimes').innerHTML = f.times.length
    ? f.times
        .map(
          (t) => `<span class="chip"><span class="chip-time" data-ar-edit="${esc(t)}" title="Klicken zum Ändern">${esc(t)} Uhr<input type="time" value="${esc(t)}" tabindex="-1"></span><button data-ar-del="${esc(t)}" title="Entfernen">✕</button></span>`
        )
        .join('')
    : '<span class="text-sm text-zinc-500">Noch keine Uhrzeit.</span>';
  $('#arDays').innerHTML = DAY_NAMES.map(([n, l]) => `<button class="daybtn ${f.days.includes(n) ? 'on' : ''}" data-ar-day="${n}">${l}</button>`).join('');
  if (document.activeElement !== $('#arWarn')) $('#arWarn').value = f.warnMinutes.join(', ');
  $('#arDirty').classList.toggle('hidden', !ar.dirty);
  $('#arSave').disabled = !ar.dirty;
  renderArNext();
}

function arChange(fn) {
  fn(ar.form);
  ar.dirty = true;
  renderAutoRestart();
}

$('#arSwitch').onclick = () => arChange((f) => (f.enabled = !f.enabled));
$('#arBackup').onclick = () => arChange((f) => (f.backup = !f.backup));
$('#arTimeAdd').onclick = () => {
  const t = $('#arTimeInput').value;
  if (!/^\d{2}:\d{2}$/.test(t)) return toast('Bitte eine Uhrzeit wählen', 'err');
  if (ar.form.times.includes(t)) return toast('Diese Uhrzeit gibt es schon', 'warn');
  arChange((f) => f.times.push(t) && f.times.sort());
};
$('#arTimes').addEventListener('click', (e) => {
  const t = e.target.closest('[data-ar-del]')?.dataset.arDel;
  if (t) return arChange((f) => (f.times = f.times.filter((x) => x !== t)));
  // Klick auf eine eingetragene Uhrzeit -> Uhrzeit-Auswahl öffnen und ändern
  const chip = e.target.closest('[data-ar-edit]');
  if (chip) openTimePicker(chip.querySelector('input'));
});
$('#arTimes').addEventListener('change', (e) => {
  const chip = e.target.closest('[data-ar-edit]');
  const oldT = chip?.dataset.arEdit;
  const newT = e.target.value;
  if (!oldT || !/^\d{2}:\d{2}$/.test(newT) || newT === oldT) return;
  if (ar.form.times.includes(newT)) return toast('Diese Uhrzeit gibt es schon', 'warn');
  arChange((f) => (f.times = f.times.map((x) => (x === oldT ? newT : x)).sort()));
});

// Öffnet die Uhrzeit-Auswahl – egal wo man ins Feld klickt (nicht nur auf das Uhr-Symbol)
function openTimePicker(input) {
  try {
    input.showPicker();
  } catch (_) {
    input.focus(); // ältere Browser: wenigstens Fokus setzen
  }
}
$('#arTimeInput').addEventListener('click', (e) => openTimePicker(e.currentTarget));
$('#arTimeInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('#arTimeAdd').click();
});
$('#arDays').addEventListener('click', (e) => {
  const b = e.target.closest('[data-ar-day]');
  if (!b) return;
  const n = Number(b.dataset.arDay);
  arChange((f) => (f.days = f.days.includes(n) ? f.days.filter((x) => x !== n) : [...f.days, n]));
});
$('#arWarn').addEventListener('input', () => {
  ar.dirty = true;
  $('#arDirty').classList.remove('hidden');
  $('#arSave').disabled = false;
});

$('#arSave').onclick = async () => {
  const warn = $('#arWarn').value.split(/[,;\s]+/).filter(Boolean).map(Number);
  if (warn.some((n) => !Number.isInteger(n))) return toast('Warnzeiten: nur ganze Minuten, mit Komma getrennt', 'err');
  try {
    const d = await api('PUT', '/api/autorestart', { ...ar.form, warnMinutes: warn });
    ar.dirty = false;
    setAutoRestart(d);
    renderAutoRestart();
    toast(d.settings.enabled ? (d.next ? `Auto-Neustart aktiv – nächster: ${fmtWhen(d.next.at)}` : 'Gespeichert') : 'Automatische Neustarts deaktiviert', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
};

async function arSkip(skip) {
  try {
    setAutoRestart(await api('POST', '/api/autorestart/skip', { skip }));
    toast(skip ? 'Nächster Neustart wird übersprungen' : 'Überspringen aufgehoben', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}
$('#arDashSkip').onclick = () => {
  if (confirm('Den nächsten automatischen Neustart überspringen?')) arSkip(true);
};

async function arCancelCountdown() {
  try {
    setAutoRestart(await api('DELETE', '/api/autorestart/countdown'));
    toast('Countdown abgebrochen', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
}
$('#arDashCancel').onclick = arCancelCountdown;
$('#arCdCancel').onclick = arCancelCountdown;
$('#arCdStart').onclick = async () => {
  const m = Number($('#arCdMinutes').value);
  if (!confirm(`Server in ${m} Minute${m === 1 ? '' : 'n'} neu starten? Die Spieler werden im Chat gewarnt.`)) return;
  try {
    setAutoRestart(await api('POST', '/api/autorestart/countdown', { minutes: m }));
    toast(`Neustart in ${m} Minute${m === 1 ? '' : 'n'}`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ---------------- Konsole / WebSocket ----------------
const consoleEl = $('#console');
const MAX_DOM_LINES = 1500;

function lineClass(line) {
  if (line.startsWith('[Servertool]')) return 'l-tool';
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception/.test(line)) return 'l-error';
  if (/\bWARN(ING)?\b/.test(line)) return 'l-warn';
  if (/joined the game|left the game|lost connection/.test(line)) return 'l-join';
  if (/<[^>]+>/.test(line)) return 'l-chat';
  return '';
}

function appendLines(lines) {
  const frag = document.createDocumentFragment();
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    const cls = lineClass(line);
    if (cls) div.className = cls;
    frag.appendChild(div);
  }
  consoleEl.appendChild(frag);
  while (consoleEl.childElementCount > MAX_DOM_LINES) consoleEl.firstElementChild.remove();
  if ($('#autoScroll').checked) consoleEl.scrollTop = consoleEl.scrollHeight;
}

let wsFailures = 0;
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.onopen = () => {
    wsFailures = 0;
    $('#offlineOverlay').classList.add('hidden');
  };
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.type === 'history') {
      consoleEl.innerHTML = '';
      appendLines(msg.lines);
    } else if (msg.type === 'log') {
      appendLines([msg.line]);
    } else if (msg.type === 'status') {
      applyStatus(msg);
    } else if (msg.type === 'perf') {
      renderPerf(msg);
    } else if (msg.type === 'autorestart') {
      setAutoRestart(msg);
    } else if (msg.type === 'mod-updates') {
      const before = JSON.stringify((catalog || {}).mods || []);
      renderCatalog(msg);
      if (state.currentTab === 'mods' && before !== JSON.stringify(msg.mods)) loadMods();
    } else if (msg.type === 'auto-update') {
      renderAutoUpdate(msg);
    } else if (msg.type === 'update') {
      renderUpdate(msg);
    } else if (msg.type === 'shutdown') {
      handleShutdown(msg);
    } else if (msg.type === 'gamerules') {
      if (state.currentTab === 'server') loadRules();
    } else if (msg.type === 'attempts') {
      setAttempts(msg.attempts);
    } else if (msg.type === 'attempt') {
      setAttempts(msg.attempts);
      const a = msg.attempt;
      toast(`🚪 ${a.name} wollte joinen – ${REASONS[a.reason] || a.reason}`, 'warn');
    }
  };
  ws.onclose = () => {
    wsFailures++;
    $('#statusBadge').textContent = 'Keine Verbindung';
    $('#statusBadge').className = 'status-pill is-error';
    if (state.quitting) {
      // Tool hat sich beendet -> Fenster schließen (falls nicht schon geschehen)
      if (!state.shutdownDone) closeWindowSoon('Servertool wurde beendet.');
      return;
    }
    if (wsFailures > 2) {
      $('#offlineText').textContent = 'Verbindung zum Servertool verloren …';
      $('#offlineHint').textContent = 'Du kannst dieses Fenster schließen.';
      $('#offlineOverlay').classList.remove('hidden');
    }
    setTimeout(connectWs, 2000);
  };
}

$('#btnClearConsole').onclick = () => (consoleEl.innerHTML = '');

$('#cmdForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('#cmdInput');
  const command = input.value.trim();
  if (!command) return;
  try {
    await api('POST', '/api/server/command', { command });
    state.cmdHistory.unshift(command);
    state.cmdHistory = state.cmdHistory.slice(0, 50);
    state.historyIdx = -1;
    input.value = '';
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#cmdInput').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const h = state.cmdHistory;
  if (!h.length) return;
  state.historyIdx = e.key === 'ArrowUp' ? Math.min(state.historyIdx + 1, h.length - 1) : Math.max(state.historyIdx - 1, -1);
  e.target.value = state.historyIdx >= 0 ? h[state.historyIdx] : '';
});

// ---------------- Steuerung ----------------
async function control(action, confirmText) {
  if (confirmText && !confirm(confirmText)) return;
  try {
    await api('POST', `/api/server/${action}`);
  } catch (err) {
    toast(err.message, 'err');
  }
}
$('#btnStart').onclick = () => control('start');
$('#btnStop').onclick = () => control('stop');
$('#btnRestart').onclick = () => control('restart', 'Server wirklich neu starten?');
$('#btnKill').onclick = () => control('kill', 'Prozess hart beenden? Nicht gespeicherte Daten gehen verloren!');
$('#btnRefreshPlayers').onclick = () => api('POST', '/api/players/refresh').catch((err) => toast(err.message, 'err'));

// ⏻: Server sicher stoppen (Welt speichern), Tool beenden, Fenster schließen
function showShutdownOverlay(text, hint = '', spinning = true) {
  $('#offlineIcon').textContent = spinning ? '⏳' : '✓';
  $('#offlineIcon').classList.toggle('animate-pulse', spinning);
  $('#offlineText').textContent = text;
  $('#offlineHint').textContent = hint;
  $('#offlineOverlay').classList.remove('hidden');
}

function closeWindowSoon(text, delay = 1200) {
  state.shutdownDone = true;
  showShutdownOverlay(text, 'Fenster wird geschlossen …', false);
  setTimeout(() => {
    window.close();
    // Falls der Browser das Schließen nicht erlaubt (z.B. normaler Browser-Tab):
    setTimeout(() => ($('#offlineHint').textContent = 'Du kannst dieses Fenster jetzt schließen.'), 600);
  }, delay);
}

function handleShutdown(msg) {
  state.quitting = true;
  if (msg.restart) state.restarting = true;
  if (msg.phase === 'done' && state.restarting && !msg.forced) {
    return closeWindowSoon('Servertool wird neu gestartet – das neue Fenster öffnet sich gleich.', 1500);
  }
  if (msg.update && (msg.phase === 'start' || msg.phase === 'stopping')) {
    showShutdownOverlay('Update wird installiert …', msg.serverRunning ? 'Minecraft-Server wird sicher gestoppt und danach wieder gestartet.' : 'Das Tool startet gleich in der neuen Version.');
  } else if (msg.phase === 'start' || msg.phase === 'stopping') {
    showShutdownOverlay(msg.serverRunning === false ? 'Servertool wird beendet …' : 'Minecraft-Server wird gestoppt …', 'Welt wird gespeichert – bitte warten, Fenster nicht schließen.');
  } else if (msg.phase === 'backup') {
    showShutdownOverlay('Warte auf laufendes Backup …', 'Danach wird der Server gestoppt.');
  } else if (msg.phase === 'done') {
    if (msg.forced) {
      // Server musste hart beendet werden -> Fenster offen lassen, damit man es sieht
      state.shutdownDone = true;
      showShutdownOverlay('⚠ Der Minecraft-Server hat nicht reagiert und wurde hart beendet.', 'Evtl. wurde nicht alles gespeichert. Du kannst dieses Fenster schließen.', false);
      $('#offlineIcon').textContent = '⚠';
    } else {
      closeWindowSoon(msg.serverWasRunning ? 'Welt gespeichert, Server sicher beendet.' : 'Servertool beendet.');
    }
  }
}

$('#btnQuit').onclick = async () => {
  const running = state.status !== 'offline';
  if (!confirm(running
    ? 'Server & Servertool beenden?\n\nDer Minecraft-Server wird sauber gestoppt (Welt wird gespeichert), danach schließt sich das Fenster.'
    : 'Servertool beenden? Das Fenster wird danach geschlossen.')) return;
  state.quitting = true;
  $('#btnQuit').disabled = true;
  showShutdownOverlay(running ? 'Minecraft-Server wird gestoppt …' : 'Servertool wird beendet …', running ? 'Welt wird gespeichert – bitte warten, Fenster nicht schließen.' : '');
  try { await api('POST', '/api/tool/quit'); } catch (_) {}
};

// Update-Erkennung: wurde das Tool aktualisiert, während es läuft?
async function checkToolVersion() {
  let outdated = false;
  try {
    const res = await fetch('/api/tool/version');
    // 404 = so alt, dass es die Versionsprüfung noch gar nicht kennt
    outdated = res.status === 404 ? true : res.ok ? (await res.json()).outdated : false;
  } catch (_) {
    return;
  }
  $('#updateBanner').classList.toggle('hidden', !outdated);
  $('#updateBannerHint').textContent = state.status !== 'offline' ? '(Der Minecraft-Server wird dabei sicher gestoppt.)' : '';
}
setInterval(checkToolVersion, 30000);

$('#btnToolRestart').onclick = async () => {
  const running = state.status !== 'offline';
  if (running && !confirm('Servertool neu starten?\n\nDer Minecraft-Server wird dabei sicher gestoppt (Welt wird gespeichert). Danach öffnet sich das Fenster neu – den Server kannst du dann wieder starten.')) return;
  state.quitting = true;
  state.restarting = true;
  showShutdownOverlay(running ? 'Minecraft-Server wird gestoppt …' : 'Servertool wird neu gestartet …', running ? 'Welt wird gespeichert – bitte warten.' : '');
  try {
    const res = await fetch('/api/tool/restart', { method: 'POST' });
    if (res.status === 404) {
      // sehr alte Version ohne Neustart-Funktion -> beenden, dann muss man selbst starten
      await fetch('/api/tool/quit', { method: 'POST' });
      state.restarting = false;
      showShutdownOverlay('Tool wurde beendet.', 'Bitte „Servertool starten.vbs“ doppelklicken, um die neue Version zu öffnen.', false);
      state.shutdownDone = true;
    }
  } catch (_) {}
};

// ---------------- Spieler ----------------
const REASONS = {
  whitelist: 'nicht auf der Whitelist',
  banned: 'gebannt',
  full: 'Server voll',
  version: 'falsche Minecraft-Version',
};

function setAttempts(list) {
  state.attempts = list || [];
  const n = state.attempts.length;
  const badge = $('#attemptBadge');
  badge.textContent = n;
  badge.classList.toggle('hidden', n === 0);
  const hint = $('#attemptHint');
  const wl = state.attempts.filter((a) => a.reason === 'whitelist').length;
  hint.classList.toggle('hidden', wl === 0);
  hint.textContent = `🚪 ${wl} Spieler wollte(n) joinen, sind aber nicht auf der Whitelist → anzeigen`;
  renderAttempts();
}
$('#attemptHint').onclick = () => showTab('players');

function renderAttempts() {
  $('#attemptsCard').classList.toggle('hidden', state.attempts.length === 0);
  $('#attemptTable').innerHTML = state.attempts
    .map((a) => {
      const btns = [];
      if (a.reason === 'banned') btns.push(`<button class="btn btn-green btn-sm" data-pa="pardon" data-name="${esc(a.name)}" data-uuid="${esc(a.uuid || '')}">Entbannen</button>`);
      else btns.push(`<button class="btn btn-green btn-sm" data-pa="whitelist-add" data-name="${esc(a.name)}" data-uuid="${esc(a.uuid || '')}">✓ Whitelisten</button>`);
      btns.push(`<button class="btn btn-ghost btn-sm" data-dismiss="${esc(a.name)}" title="Aus der Liste entfernen">✕</button>`);
      return `<tr>
        <td><div class="flex items-center gap-2">${avatar(a.name)}<span class="font-medium">${esc(a.name)}</span></div></td>
        <td class="text-amber-300" title="${esc(a.message || '')}">${esc(REASONS[a.reason] || a.reason)}</td>
        <td class="text-right">${a.count}×</td>
        <td class="text-right text-zinc-400">${fmtAgo(a.lastAt)}</td>
        <td class="text-right text-zinc-500 font-mono text-xs">${esc(a.ip || '–')}</td>
        <td class="text-right space-x-1 whitespace-nowrap">${btns.join('')}</td>
      </tr>`;
    })
    .join('');
}

async function loadPlayers() {
  try {
    state.players = await api('GET', '/api/players');
    renderPlayers();
  } catch (err) {
    state.players = null;
    $('#playerTable').innerHTML = `<tr><td colspan="6" class="py-6 text-center text-zinc-500">${esc(err.message)}</td></tr>`;
  }
}

function renderPlayers() {
  const data = state.players;
  if (!data) return;
  $('#whitelistSwitch').classList.toggle('on', data.whitelistEnabled);

  const modeHint = {
    running: '✓ Server läuft – Aktionen werden sofort per Konsolenbefehl ausgeführt.',
    offline: 'Server ist offline – Änderungen werden direkt in whitelist.json / ops.json / banned-players.json gespeichert und gelten beim nächsten Start.',
  }[state.status] || '⏳ Server startet/stoppt gerade – bitte kurz warten.';
  $('#playerModeHint').textContent = modeHint;

  const q = $('#playerSearch').value.trim().toLowerCase();
  const f = $('#playerFilter').value;
  const visible = data.players.filter((p) => {
    if (q && !p.name.toLowerCase().includes(q)) return false;
    if (f === 'online') return p.online;
    if (f === 'offline') return !p.online;
    if (f === 'whitelisted') return p.whitelisted;
    if (f === 'op') return p.op;
    if (f === 'banned') return p.banned;
    return true;
  });
  const onlineCount = data.players.filter((p) => p.online).length;
  $('#playerSummary').textContent = `${onlineCount} online · ${data.players.length - onlineCount} offline`;

  $('#playerTable').innerHTML = visible.length
    ? visible
        .map((p) => {
          const n = esc(p.name);
          const tags = [
            p.op ? `<span class="tag bg-purple-900 text-purple-200" title="Operator Level ${p.opLevel ?? '?'}">OP</span>` : '',
            p.whitelisted ? '<span class="tag bg-emerald-900 text-emerald-200">Whitelist</span>' : '',
            p.banned ? `<span class="tag bg-red-900 text-red-200" title="${esc(p.banReason || '')}">Gebannt</span>` : '',
          ].join('');
          const status = p.online
            ? '<span class="dot bg-emerald-500"></span>Online'
            : '<span class="dot bg-zinc-600"></span><span class="text-zinc-400">Offline</span>';
          const btn = (act, label, cls = 'btn-ghost', title = '') =>
            `<button class="btn ${cls} btn-sm" data-pa="${act}" data-name="${n}" title="${title}">${label}</button>`;
          const actions = [
            p.online ? btn('kick', 'Kick', 'btn-ghost', 'Spieler vom Server werfen') : '',
            p.whitelisted ? btn('whitelist-remove', '− Whitelist') : btn('whitelist-add', '+ Whitelist'),
            p.op ? btn('deop', '− OP') : btn('op', '+ OP'),
            p.banned ? btn('pardon', 'Entbannen') : btn('ban', 'Bannen', 'btn-ghost text-red-400'),
          ].join(' ');
          return `<tr>
            <td><div class="flex items-center gap-2">${avatar(p.name, 24)}<div><button data-player="${n}" class="font-medium hover:underline hover:text-emerald-400" title="Details & Aktionen">${n}</button><div class="text-[10px] text-zinc-600 font-mono">${esc(p.uuid || '')}</div></div></div></td>
            <td class="whitespace-nowrap">${status}</td>
            <td class="text-right">${pingHtml(p.ping, p.online)}</td>
            <td>${tags || '<span class="text-zinc-600">–</span>'}</td>
            <td class="text-right text-zinc-400 whitespace-nowrap">${p.online ? 'jetzt' : fmtAgo(p.lastSeen)}</td>
            <td class="text-right whitespace-nowrap">${actions}</td>
          </tr>`;
        })
        .join('')
    : `<tr><td colspan="6" class="py-6 text-center text-zinc-500">${data.players.length ? 'Keine Treffer' : 'Noch keine Spieler bekannt – sobald jemand joint, erscheint er hier.'}</td></tr>`;
}

$('#playerSearch').addEventListener('input', renderPlayers);
$('#playerFilter').addEventListener('change', renderPlayers);

const ACTION_TEXT = {
  'whitelist-add': (n) => `${n} zur Whitelist hinzugefügt`,
  'whitelist-remove': (n) => `${n} von der Whitelist entfernt`,
  op: (n) => `${n} ist jetzt Operator`,
  deop: (n) => `${n} ist kein Operator mehr`,
  ban: (n) => `${n} wurde gebannt`,
  pardon: (n) => `${n} wurde entbannt`,
  kick: (n) => `${n} wurde gekickt`,
  message: (n) => `Nachricht an ${n} gesendet`,
  gamemode: (n, x) => `Spielmodus von ${n}: ${GAMEMODE_NAMES[x.mode] || x.mode}`,
};
const GAMEMODE_NAMES = { survival: 'Überleben', creative: 'Kreativ', adventure: 'Abenteuer', spectator: 'Zuschauer' };

async function playerAction(name, action, extra = {}) {
  if (action === 'ban' || action === 'kick') {
    const reason = prompt(`${action === 'ban' ? 'Bannen' : 'Kicken'}: ${name}\nGrund (optional):`, '');
    if (reason === null) return;
    extra.reason = reason;
  }
  if (action === 'op' && !confirm(`${name} Operator-Rechte geben? (volle Admin-Rechte im Spiel)`)) return;
  try {
    await api('POST', '/api/players/action', { name, action, ...extra });
    toast(ACTION_TEXT[action](name, extra), 'ok');
  } catch (err) {
    toast(err.message, 'err');
    return false;
  }
  if (state.currentTab === 'players') loadPlayers();
  if (modalPlayer && modalPlayer.toLowerCase() === name.toLowerCase()) openPlayerModal(name);
  return true;
}

document.addEventListener('click', (e) => {
  const b = e.target.closest('[data-pa]');
  if (b) {
    const extra = {};
    if (b.dataset.uuid) extra.uuid = b.dataset.uuid;
    if (b.dataset.mode) extra.mode = b.dataset.mode;
    playerAction(b.dataset.name, b.dataset.pa, extra);
    return;
  }
  const p = e.target.closest('[data-player]');
  if (p) openPlayerModal(p.dataset.player);
});

// ---------------- Spieler-Fenster ----------------
let modalPlayer = null;
let modalData = null;

async function openPlayerModal(name) {
  modalPlayer = name;
  $('#playerModal').classList.remove('hidden');
  if (!modalData || modalData.name.toLowerCase() !== name.toLowerCase()) {
    $('#playerModalBody').innerHTML = `<div class="py-8 text-center text-zinc-500">Lade ${esc(name)} …</div>`;
  }
  try {
    state.players = await api('GET', '/api/players');
    if (state.currentTab === 'players') renderPlayers();
  } catch (_) {
    /* Server-Ordner nicht gesetzt -> nur Live-Daten */
  }
  if (modalPlayer !== name) return; // inzwischen geschlossen/gewechselt
  const fromList = state.players?.players.find((p) => p.name.toLowerCase() === name.toLowerCase());
  modalData = fromList || { name, uuid: null, op: false, whitelisted: false, banned: false, lastSeen: null };
  renderPlayerModal();
}

function closePlayerModal() {
  modalPlayer = null;
  modalData = null;
  $('#playerModal').classList.add('hidden');
}

// Ping / Online-Status im offenen Fenster live aktualisieren
function updatePlayerModalLive(onlinePlayers) {
  if (!modalData) return;
  const o = onlinePlayers.find((p) => p.name.toLowerCase() === modalData.name.toLowerCase());
  const wasOnline = modalData.online;
  modalData.online = !!o;
  modalData.ping = o ? o.ping : null;
  modalData.joinedAt = o ? o.joinedAt : null;
  if (wasOnline && !o) modalData.lastSeen = Date.now();
  const pingEl = document.getElementById('modalPing');
  if (wasOnline !== modalData.online || !pingEl) renderPlayerModal();
  else {
    pingEl.innerHTML = pingHtml(modalData.ping, modalData.online);
    const since = document.getElementById('modalSince');
    if (since && modalData.joinedAt) since.textContent = fmtDuration(Date.now() - modalData.joinedAt);
  }
}

function renderPlayerModal() {
  const p = modalData;
  if (!p) return;
  const live = (state.lastOnline || []).find((x) => x.name.toLowerCase() === p.name.toLowerCase());
  if (live) {
    p.online = true;
    p.ping = live.ping;
    p.joinedAt = live.joinedAt;
  }
  const n = esc(p.name);
  const running = state.status === 'running';
  const online = p.online && running;
  const btn = (act, label, cls = 'btn-ghost', extra = '') =>
    `<button class="btn ${cls} btn-sm" data-pa="${act}" data-name="${n}" ${extra}>${label}</button>`;

  const tags = [
    p.op ? '<span class="tag bg-purple-900 text-purple-200">OP</span>' : '',
    p.whitelisted ? '<span class="tag bg-emerald-900 text-emerald-200">Whitelist</span>' : '',
    p.banned ? `<span class="tag bg-red-900 text-red-200" title="${esc(p.banReason || '')}">Gebannt</span>` : '',
  ].join('');

  $('#playerModalBody').innerHTML = `
    <div class="flex items-center gap-4 mb-5 pr-10">
      <img src="https://mc-heads.net/body/${encodeURIComponent(p.name)}/64" class="h-24" onerror="this.style.display='none'" alt="">
      <div class="min-w-0">
        <div class="text-xl font-semibold">${n}</div>
        <div class="text-xs text-zinc-500 font-mono break-all">${esc(p.uuid || '')}</div>
        <div class="mt-2">${tags}</div>
      </div>
    </div>

    <div class="grid grid-cols-3 gap-3 mb-5 text-center">
      <div class="rounded bg-zinc-900 border border-zinc-800 py-2">
        <div class="text-xs text-zinc-500">Status</div>
        <div class="font-medium">${online ? '<span class="dot bg-emerald-500"></span>Online' : '<span class="dot bg-zinc-600"></span>Offline'}</div>
      </div>
      <div class="rounded bg-zinc-900 border border-zinc-800 py-2">
        <div class="text-xs text-zinc-500">Ping</div>
        <div id="modalPing" class="font-medium">${pingHtml(p.ping, online)}</div>
      </div>
      <div class="rounded bg-zinc-900 border border-zinc-800 py-2">
        <div class="text-xs text-zinc-500">${online ? 'Online seit' : 'Zuletzt gesehen'}</div>
        <div id="modalSince" class="font-medium">${online && p.joinedAt ? fmtDuration(Date.now() - p.joinedAt) : fmtAgo(p.lastSeen)}</div>
      </div>
    </div>

    ${online ? `
    <form id="modalMsgForm" class="flex gap-2 mb-4">
      <input id="modalMsg" class="input flex-1" maxlength="256" placeholder="Private Nachricht an ${n} …" autocomplete="off">
      <button class="btn btn-green btn-sm">Senden</button>
    </form>

    <div class="mb-4">
      <div class="text-xs text-zinc-500 mb-1.5">Spielmodus</div>
      <div class="flex flex-wrap gap-2">
        ${Object.entries(GAMEMODE_NAMES).map(([m, label]) => btn('gamemode', label, 'btn-ghost', `data-mode="${m}"`)).join('')}
      </div>
    </div>` : `
    <div class="text-sm text-zinc-500 mb-4">${running ? 'Spieler ist nicht online.' : 'Server läuft nicht.'} Nachricht, Spielmodus und Kick gehen nur bei Online-Spielern.</div>`}

    <div class="text-xs text-zinc-500 mb-1.5">Verwaltung</div>
    <div class="flex flex-wrap gap-2">
      ${online ? btn('kick', '👢 Kicken') : ''}
      ${p.whitelisted ? btn('whitelist-remove', '− Whitelist') : btn('whitelist-add', '+ Whitelist')}
      ${p.op ? btn('deop', '− OP') : btn('op', '+ OP')}
      ${p.banned ? btn('pardon', 'Entbannen', 'btn-green') : btn('ban', '⛔ Bannen', 'btn-red')}
    </div>`;

  const form = document.getElementById('modalMsgForm');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('modalMsg');
      const text = input.value.trim();
      if (!text) return;
      if (await playerAction(p.name, 'message', { reason: text })) input.value = '';
    });
  }
}

$('#playerModalClose').onclick = closePlayerModal;
$('#playerModal').addEventListener('click', (e) => {
  if (e.target.id === 'playerModal') closePlayerModal(); // Klick neben das Fenster
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && modalPlayer) closePlayerModal();
});

$('#attemptTable').addEventListener('click', async (e) => {
  const name = e.target.closest('[data-dismiss]')?.dataset.dismiss;
  if (!name) return;
  await api('DELETE', `/api/attempts?name=${encodeURIComponent(name)}`).catch((err) => toast(err.message, 'err'));
});

$('#btnClearAttempts').onclick = async () => {
  if (!confirm('Alle Verbindungsversuche aus der Liste entfernen?')) return;
  await api('DELETE', '/api/attempts').catch((err) => toast(err.message, 'err'));
};

$('#addPlayerForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('#addPlayerName').value.trim();
  if (!name) return;
  await playerAction(name, 'whitelist-add');
  $('#addPlayerName').value = '';
});

$('#whitelistSwitch').onclick = async () => {
  const enable = !state.players?.whitelistEnabled;
  try {
    await api('POST', '/api/players/whitelist-enabled', { enabled: enable });
    toast(enable ? 'Whitelist aktiviert – nur freigegebene Spieler können joinen' : 'Whitelist deaktiviert – jeder kann joinen', enable ? 'ok' : 'warn');
  } catch (err) {
    toast(err.message, 'err');
  }
  loadPlayers();
};

// ---------------- Server-Einstellungen ----------------
const srv = { sub: 'rules', rules: null, props: null, propChanges: {} };
try { srv.sub = localStorage.getItem('serverSub') || 'rules'; } catch (_) {}

function showSub(sub) {
  srv.sub = sub;
  try { localStorage.setItem('serverSub', sub); } catch (_) {}
  document.querySelectorAll('#serverSubTabs .subtab').forEach((b) => b.classList.toggle('active', b.dataset.sub === sub));
  $('#sub-rules').classList.toggle('hidden', sub !== 'rules');
  $('#sub-props').classList.toggle('hidden', sub !== 'props');
  $('#sub-restart').classList.toggle('hidden', sub !== 'restart');
  $('#settingsSearch').classList.toggle('invisible', sub === 'restart');
  if (sub === 'restart') loadAutoRestart();
  updatePropsSaveBar();
}
$('#serverSubTabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-sub]');
  if (b) showSub(b.dataset.sub);
});

function loadServerSettings() {
  showSub(srv.sub);
  loadDayLength();
  loadRules();
  loadProps();
}

// ----- Tag- & Nachtlänge -----
const dl = { data: null, enabled: false, day: 10, night: 10 };

async function loadDayLength() {
  try {
    dl.data = await api('GET', '/api/daylength');
    dl.enabled = dl.data.enabled;
    dl.day = dl.data.dayMinutes;
    dl.night = dl.data.nightMinutes;
    renderDayLength();
  } catch (err) {
    dl.data = null;
    $('#dlInfo').innerHTML = /404|Cannot GET/i.test(err.message)
      ? '<span class="text-amber-300">⚠ Diese Funktion ist erst nach einem Neustart des Tools verfügbar – siehe blauer Hinweis oben.</span>'
      : `<span class="text-red-400">⚠ ${esc(err.message)}</span>`;
    checkToolVersion();
  }
}

const fmtMin = (m) => (m >= 60 ? `${Math.floor(m / 60)} Std.${m % 60 ? ' ' + (m % 60) + ' Min.' : ''}` : `${m} Min.`);

function renderDayLength() {
  const d = dl.data;
  if (!d) return;
  $('#dlSwitch').classList.toggle('on', dl.enabled);
  $('#dlBody').classList.toggle('opacity-40', !dl.enabled);
  for (const el of ['#dlDay', '#dlNight', '#dlDayRange', '#dlNightRange']) $(el).disabled = !dl.enabled;
  $('#dlDay').value = dl.day;
  $('#dlNight').value = dl.night;
  $('#dlDayRange').value = Math.min(dl.day, 120);
  $('#dlNightRange').value = Math.min(dl.night, 120);
  $('#dlDayOut').textContent = fmtMin(dl.day);
  $('#dlNightOut').textContent = fmtMin(dl.night);

  const changed = dl.enabled !== d.enabled || (dl.enabled && (dl.day !== d.dayMinutes || dl.night !== d.nightMinutes));
  $('#dlSave').disabled = !changed;
  $('#dlSave').textContent = changed ? (d.running ? 'Übernehmen (sofort)' : 'Übernehmen (ab nächstem Start)') : 'Übernommen ✓';

  let info;
  if (!dl.enabled) {
    info = 'Aus: normaler Minecraft-Ablauf – Tag ≈ 10 Min., Nacht ≈ 10 Min. (inkl. Dämmerung), zusammen 20 Min.';
  } else {
    info = `Ein ganzer Tag dauert ${fmtMin(dl.day + dl.night)}. Schlafen überspringt die Nacht weiterhin. ` +
      'Hinweis: Die Sonne bewegt sich dabei in kleinen Schritten statt ganz flüssig.';
  }
  if (d.enabled && !d.running) info += ' • Aktiv ab dem nächsten Serverstart.';
  $('#dlInfo').textContent = info;
}

$('#dlSwitch').onclick = () => {
  if (!dl.data) {
    toast('Tag-/Nachtlänge ist gerade nicht verfügbar – bitte das Tool neu starten.', 'err');
    return loadDayLength();
  }
  dl.enabled = !dl.enabled;
  renderDayLength();
};
for (const [num, range, key] of [['#dlDay', '#dlDayRange', 'day'], ['#dlNight', '#dlNightRange', 'night']]) {
  $(range).addEventListener('input', (e) => {
    dl[key] = Number(e.target.value);
    renderDayLength();
  });
  $(num).addEventListener('change', (e) => {
    const n = Math.round(Number(e.target.value));
    dl[key] = Math.min(600, Math.max(1, Number.isFinite(n) ? n : 10));
    renderDayLength();
  });
}
$('#dlReset').onclick = () => {
  dl.day = 10;
  dl.night = 10;
  renderDayLength();
};
$('#dlSave').onclick = async () => {
  $('#dlSave').disabled = true;
  try {
    dl.data = await api('PUT', '/api/daylength', { enabled: dl.enabled, dayMinutes: dl.day, nightMinutes: dl.night });
    toast(dl.enabled ? `Tag ${fmtMin(dl.day)} / Nacht ${fmtMin(dl.night)}${dl.data.running ? '' : ' – aktiv ab nächstem Start'}` : 'Tag-/Nachtlänge wieder normal', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  renderDayLength();
  loadRules();
};

const matchesSearch = (...texts) => {
  const q = $('#settingsSearch').value.trim().toLowerCase();
  return !q || texts.some((t) => String(t || '').toLowerCase().includes(q));
};
$('#settingsSearch').addEventListener('input', () => {
  renderRules();
  renderProps();
});

function settingRow({ id, name, desc, key, ctrl, changed, extra = '' }) {
  return `<div class="setting-row ${changed ? 'changed' : ''}" ${id}>
    <div class="info"><div class="name">${esc(name)}${extra}</div>${desc ? `<div class="desc">${esc(desc)}</div>` : ''}<div class="key">${esc(key)}</div></div>
    <div class="ctrl">${ctrl}</div></div>`;
}

// ----- Spielregeln -----
async function loadRules() {
  try {
    srv.rules = await api('GET', '/api/gamerules');
    renderRules();
    // Läuft der Server, aber die Regeln sind noch unbekannt -> automatisch einlesen
    if (srv.rules.running && !srv.rules.known && !srv.autoQueried) {
      srv.autoQueried = true;
      refreshRules(true);
    }
  } catch (err) {
    $('#rulesInfo').textContent = err.message;
    $('#rulesList').innerHTML = '';
  }
}

async function refreshRules(silent) {
  const btn = document.getElementById('btnRulesRefresh');
  if (btn) btn.disabled = true;
  try {
    srv.rules = await api('POST', '/api/gamerules/refresh');
    renderRules();
    if (!silent) toast('Spielregeln neu eingelesen', 'ok');
  } catch (err) {
    toast(err.message, 'err');
    if (btn) btn.disabled = false;
  }
}

function renderRules() {
  const d = srv.rules;
  if (!d) return;
  const stand = d.updatedAt ? `Stand: ${fmtDate(d.updatedAt)}` : '';
  let info;
  if (d.running) {
    info = `<span class="text-emerald-400">✓ Server läuft – Änderungen wirken sofort.</span> <span class="text-zinc-500 ml-2">${stand}</span>
      <button id="btnRulesRefresh" class="btn btn-ghost btn-sm ml-3">⟳ Neu einlesen</button>`;
  } else if (d.status !== 'offline') {
    info = '⏳ Server startet/stoppt gerade …';
  } else if (d.known) {
    info = `Server ist aus – Änderungen werden <b>vorgemerkt</b> und beim nächsten Start automatisch angewendet. <span class="text-zinc-500">Angezeigte Werte: ${stand}</span>`;
  } else {
    info = 'Server ist aus. <b>Starte den Server einmal</b>, damit die aktuellen Werte deiner Version eingelesen werden. Änderungen kannst du trotzdem schon vormerken.';
  }
  if (d.pendingCount) {
    info += `<div class="mt-2 text-amber-300">⏳ ${d.pendingCount} Änderung(en) vorgemerkt – werden beim nächsten Serverstart angewendet.
      <button id="btnRulesClearPending" class="btn btn-ghost btn-sm ml-2">Vormerkungen verwerfen</button></div>`;
  }
  $('#rulesInfo').innerHTML = info;
  document.getElementById('btnRulesRefresh')?.addEventListener('click', () => refreshRules(false));
  document.getElementById('btnRulesClearPending')?.addEventListener('click', async () => {
    await api('DELETE', '/api/gamerules/pending').catch((err) => toast(err.message, 'err'));
    loadRules();
  });

  const cards = d.categories
    .map((c) => {
      const rows = c.rules
        .filter((r) => matchesSearch(r.label, r.desc, r.command, c.name))
        .map((r) => {
          const shown = r.pending !== undefined ? r.pending : r.value;
          const pendingTag = r.pending !== undefined ? '<span class="pending-tag">⏳ vorgemerkt</span>' : '';
          let ctrl;
          if (r.type === 'bool') {
            ctrl = `<button class="switch ${shown ? 'on' : ''} ${shown === undefined ? 'unknown' : ''}" data-rule="${esc(r.key)}" data-value="${shown === true}" title="${shown === undefined ? 'Wert unbekannt' : shown ? 'An' : 'Aus'}"></button>`;
          } else {
            ctrl = `<input type="number" step="1" class="input w-24 text-right" data-rule-int="${esc(r.key)}" value="${shown ?? ''}" placeholder="?">`;
          }
          if (r.key === 'advance_time' && dl.data?.enabled) {
            ctrl = '<span class="text-xs text-amber-300">wird von „Tag- & Nachtlänge“ gesteuert</span>';
          }
          return settingRow({ id: '', name: r.label, desc: r.desc, key: r.command, ctrl, changed: false, extra: pendingTag });
        })
        .join('');
      return rows ? `<div class="card"><h3 class="card-title">${esc(c.name)}</h3>${rows}</div>` : '';
    })
    .join('');
  $('#rulesList').innerHTML = cards || '<div class="text-zinc-500">Keine Treffer.</div>';
}

async function setRule(key, value) {
  try {
    const r = await api('PUT', `/api/gamerules/${encodeURIComponent(key)}`, { value });
    const label = srv.rules?.categories.flatMap((c) => c.rules).find((x) => x.key === key)?.label || key;
    const text = typeof value === 'boolean' ? (value ? 'an' : 'aus') : value;
    toast(r.pending ? `Vorgemerkt: ${label} → ${text}` : `${label} → ${text}`, r.pending ? 'warn' : 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  loadRules();
}

$('#rulesList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-rule]');
  if (!b) return;
  b.disabled = true;
  setRule(b.dataset.rule, b.dataset.value !== 'true');
});
$('#rulesList').addEventListener('change', (e) => {
  const i = e.target.closest('[data-rule-int]');
  if (i && i.value !== '') setRule(i.dataset.ruleInt, Number(i.value));
});

// ----- server.properties -----
async function loadProps() {
  try {
    srv.props = await api('GET', '/api/server-properties');
    renderProps();
  } catch (err) {
    srv.props = null;
    $('#propsInfo').textContent = err.message;
    $('#propsList').innerHTML = '';
  }
}

function propValue(item) {
  return item.key in srv.propChanges ? srv.propChanges[item.key] : item.value;
}

function renderProps() {
  const d = srv.props;
  if (!d) return;
  if (!d.exists) {
    $('#propsInfo').innerHTML = 'Es gibt noch keine <code>server.properties</code>. <b>Starte den Server einmal</b>, dann wird sie automatisch erstellt.';
    $('#propsList').innerHTML = '';
    return;
  }
  const all = d.groups.flatMap((g) => g.items);
  const movedHint = !all.some((i) => i.key === 'allow-nether')
    ? '<div class="text-zinc-500 mt-1">ℹ Nether, PvP und Monster-Spawning sind in deiner Version <b>Spielregeln</b> – siehe Tab „🎲 Spielregeln“.</div>'
    : '';
  $('#propsInfo').innerHTML = (d.running
    ? '⚠ Der Server läuft: <b>Whitelist</b>, <b>Schwierigkeit</b> und <b>Standard-Spielmodus</b> werden sofort übernommen, alles andere nach einem <b>Neustart</b>.'
    : 'Änderungen werden beim nächsten Serverstart aktiv.') + movedHint;

  $('#propsList').innerHTML = d.groups
    .map((g) => {
      const rows = g.items
        .filter((i) => matchesSearch(i.label, i.desc, i.key, g.name))
        .map((i) => {
          const v = propValue(i);
          const k = esc(i.key);
          let ctrl;
          if (i.type === 'bool') {
            ctrl = `<button class="switch ${v === 'true' ? 'on' : ''}" data-prop-bool="${k}"></button>`;
          } else if (i.type === 'select') {
            const opts = i.options.map(([o, l]) => `<option value="${esc(o)}" ${o === v ? 'selected' : ''}>${esc(l)}</option>`);
            if (!i.options.some(([o]) => o === v)) opts.unshift(`<option value="${esc(v)}" selected>${esc(v)}</option>`);
            ctrl = `<select class="input" data-prop="${k}">${opts.join('')}</select>`;
          } else if (i.type === 'int') {
            ctrl = `<input type="number" step="1" class="input w-28 text-right" data-prop="${k}" value="${esc(v)}" ${i.min !== undefined ? `min="${i.min}"` : ''} ${i.max !== undefined ? `max="${i.max}"` : ''}>`;
          } else {
            ctrl = `<input type="${i.type === 'secret' ? 'password' : 'text'}" class="input w-56" data-prop="${k}" value="${esc(v)}" autocomplete="off" spellcheck="false">`;
          }
          return settingRow({ id: '', name: i.label, desc: i.desc, key: i.key, ctrl, changed: i.key in srv.propChanges });
        })
        .join('');
      return rows ? `<div class="card"><h3 class="card-title">${esc(g.name)}</h3>${rows}</div>` : '';
    })
    .join('') || '<div class="text-zinc-500">Keine Treffer.</div>';
  updatePropsSaveBar();
}

function setPropChange(key, value) {
  const item = srv.props.groups.flatMap((g) => g.items).find((i) => i.key === key);
  if (!item) return;
  if (String(value) === item.value) delete srv.propChanges[key];
  else srv.propChanges[key] = String(value);
}

$('#propsList').addEventListener('click', (e) => {
  const b = e.target.closest('[data-prop-bool]');
  if (!b) return;
  const key = b.dataset.propBool;
  const item = srv.props.groups.flatMap((g) => g.items).find((i) => i.key === key);
  setPropChange(key, propValue(item) === 'true' ? 'false' : 'true');
  renderProps();
});
$('#propsList').addEventListener('change', (e) => {
  const el = e.target.closest('[data-prop]');
  if (!el) return;
  setPropChange(el.dataset.prop, el.value);
  renderProps();
});

function updatePropsSaveBar() {
  const n = Object.keys(srv.propChanges).length;
  $('#propsSaveBar').classList.toggle('hidden', n === 0 || state.currentTab !== 'server' || srv.sub !== 'props');
  $('#propsSaveText').textContent = `${n} ungespeicherte Änderung${n === 1 ? '' : 'en'}`;
}

$('#btnPropsDiscard').onclick = () => {
  srv.propChanges = {};
  renderProps();
};

$('#btnPropsSave').onclick = async () => {
  try {
    const r = await api('PUT', '/api/server-properties', { values: srv.propChanges });
    srv.propChanges = {};
    await loadProps();
    if (!r.changed.length) return toast('Keine Änderungen', 'info');
    toast(`${r.changed.length} Einstellung(en) gespeichert${r.live.length ? ` – ${r.live.length} sofort übernommen` : ''}`, 'ok');
    if (r.restartRequired && confirm('Einige Änderungen werden erst nach einem Neustart aktiv.\n\nServer jetzt neu starten?')) {
      control('restart');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
};

window.addEventListener('beforeunload', (e) => {
  if (Object.keys(srv.propChanges).length) e.preventDefault();
});

// ---------------- Mods ----------------
async function loadMods() {
  api('GET', '/api/mod-updates').then(renderCatalog).catch(() => {});
  try {
    const data = await api('GET', '/api/mods');
    state.mods = data.mods;
    $('#modPaths').textContent = `Aktiv: ${data.modsDir}   ·   Deaktiviert: ${data.disabledModsDir}`;
    renderMods();
  } catch (err) {
    state.mods = [];
    renderMods();
    $('#modPaths').textContent = '';
    toast(err.message, 'err');
  }
}

function renderMods() {
  const q = $('#modSearch').value.trim().toLowerCase();
  const filter = $('#modFilter').value;
  const visible = state.mods.filter(
    (m) => (!q || m.name.toLowerCase().includes(q) || (m.displayName || '').toLowerCase().includes(q)) && (filter === 'all' || (filter === 'enabled') === m.enabled)
  );
  const active = state.mods.filter((m) => m.enabled).length;
  $('#modCount').textContent = `${active} aktiv · ${state.mods.length - active} deaktiviert`;

  $('#modTable').innerHTML = visible.length
    ? visible
        .map(
          (m) => `<tr class="${m.enabled ? '' : 'off'}">
          <td><button class="switch ${m.enabled ? 'on' : ''}" data-toggle="${esc(m.name)}" data-enabled="${m.enabled}" title="${m.enabled ? 'Deaktivieren' : 'Aktivieren'}"></button></td>
          <td class="name pr-4">${modNameCell(m)}</td>
          <td class="text-right text-zinc-400">${fmtSize(m.size)}</td>
          <td class="text-right text-zinc-400">${fmtDate(m.modified)}</td>
          <td class="text-right"><button class="btn btn-ghost btn-sm text-red-400" data-delete="${esc(m.name)}" data-enabled="${m.enabled}" title="Löschen">🗑</button></td>
        </tr>`
        )
        .join('')
    : `<tr><td colspan="5" class="py-6 text-center text-zinc-500">Keine Mods gefunden</td></tr>`;
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-open-folder]');
  if (!b) return;
  try {
    const r = await api('POST', '/api/open-folder', { which: b.dataset.openFolder });
    toast(`Ordner geöffnet: ${r.path}`, 'ok');
  } catch (err) {
    toast(/404/.test(err.message) ? 'Diese Funktion ist erst nach einem Neustart des Tools verfügbar (blauer Hinweis oben).' : err.message, 'err');
  }
});

// ---------- Eigene Mods von GitHub ----------
let catalog = null;
const catalogFor = (id) => (catalog && id ? catalog.mods.find((c) => c.id === id) : null);

function modNameCell(m) {
  const c = catalogFor(m.modId);
  let badge = '';
  if (c && c.busy) badge = '<span class="mod-badge">⏳ lädt …</span>';
  else if (c && c.pendingVersion) badge = `<span class="mod-badge info" title="Wird automatisch eingespielt, sobald der Server gestoppt bzw. neu gestartet wird">⏳ ${esc(c.pendingVersion)} beim nächsten Start</span>`;
  else if (c && c.updateAvailable) badge = `<button class="mod-badge update" data-mod-update="${esc(c.id)}" title="${esc(c.notes || '')}">⬆ Update auf ${esc(c.version)}</button>`;
  else if (c) badge = '<span class="mod-badge ok" title="Neueste passende Version von GitHub">✓ aktuell</span>';
  if (c && c.newer && !c.updateAvailable) badge += ` <span class="mod-badge" title="Diese Version passt nicht zu deinem Server">${esc(c.newer.version)} nur für ${esc(c.newer.requires)}</span>`;
  const title = m.displayName
    ? `<span class="font-medium text-zinc-100">${esc(m.displayName)}</span> <span class="text-zinc-500 font-mono text-xs">${esc(m.version || '')}</span>`
    : `<span class="font-mono break-all">${esc(m.name)}</span>`;
  return `<div class="flex flex-wrap items-center gap-2">${title}${badge}</div>${m.displayName ? `<div class="text-[11px] text-zinc-600 font-mono break-all">${esc(m.name)}</div>` : ''}`;
}

function renderCatalog(d) {
  catalog = d;
  const t = d.checkedAt ? new Date(d.checkedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' }) : null;
  $('#catStatus').textContent =
    d.status === 'checking' ? 'Prüfe …' : d.status === 'error' ? `⚠ ${d.error}` : t ? `geprüft ${t} Uhr · alle ${d.intervalMin} Min.` : 'noch nicht geprüft';
  const LN = { forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', vanilla: 'Vanilla' };
  const sv = d.server || {};
  $('#catServer').innerHTML = sv.mcVersion || sv.loader
    ? `Dein Server: <b class="text-zinc-200">${esc([LN[sv.loader] || sv.loader, sv.mcVersion && 'MC ' + sv.mcVersion].filter(Boolean).join(' · '))}</b> – es werden nur passende Mod-Versionen angeboten.${sv.loader === 'vanilla' ? ' <span class="text-amber-400">Ohne Forge/NeoForge/Fabric können keine Mods geladen werden.</span>' : ''}`
    : '<span class="text-amber-400">⚠ Server-Version noch unbekannt – starte den Server einmal, dann werden passende Versionen erkannt.</span>';
  $('#catCheck').disabled = d.status === 'checking';

  const pend = d.mods.filter((m) => m.pendingVersion);
  $('#catPending').classList.toggle('hidden', !pend.length);
  if (pend.length) {
    $('#catPending').innerHTML = `⏳ ${pend.map((m) => `<b>${esc(m.name)} ${esc(m.pendingVersion)}</b>`).join(', ')} ${pend.length === 1 ? 'ist' : 'sind'} heruntergeladen und ${pend.length === 1 ? 'wird' : 'werden'} beim nächsten Server-Start bzw. sobald der Server gestoppt ist installiert.`;
  }

  const ups = d.mods.filter((m) => m.updateAvailable && !m.pendingVersion);
  $('#catUpdates').classList.toggle('hidden', !ups.length);
  $('#catUpdates').innerHTML = ups.length
    ? `<div class="rounded-lg border border-amber-600/40 bg-amber-900/15 px-3 py-2.5 text-sm">
        <div class="font-semibold text-amber-200 mb-2">⬆ ${ups.length === 1 ? 'Ein Update' : ups.length + ' Updates'} verfügbar</div>
        <div class="flex flex-col gap-2">${ups
          .map(
            (m) => `<div class="flex flex-wrap items-center gap-2"><span class="text-zinc-200">${esc(m.name)}</span>
              <span class="font-mono text-xs text-zinc-500">${esc(m.installedVersion)} → ${esc(m.version)}</span>
              ${m.notes ? `<span class="text-xs text-zinc-400 truncate max-w-md" title="${esc(m.notes)}">${esc(m.notes.split(/\r?\n/)[0])}</span>` : ''}
              <button class="btn btn-sm btn-amber ml-auto" data-mod-update="${esc(m.id)}" ${m.busy ? 'disabled' : ''}>${m.busy ? '⏳ …' : '⬆ Aktualisieren'}</button></div>`
          )
          .join('')}</div></div>`
    : '';
  const missing = d.mods.filter((m) => !m.installed);
  $('#catList').innerHTML = !d.repo
    ? '<p class="text-sm text-zinc-500">Keine Mod-Quelle eingestellt.</p>'
    : missing.length
      ? missing
          .map(
            (m) => `<div class="cat-item ${m.compatible === false ? 'incompatible' : ''}">
        <div class="flex items-start gap-2">
          <div class="flex-1 min-w-0">
            <div class="font-semibold text-zinc-100">${esc(m.name)} <span class="text-xs font-mono text-zinc-500">${esc(m.version)}</span></div>
            <div class="flex flex-wrap gap-1.5 mt-1.5">
              ${m.requires ? m.requires.split(' · ').map((x) => `<span class="mod-tag">${esc(x)}</span>`).join('') : ''}
              <span class="mod-tag" title="${m.serverOnly ? 'Spieler können ohne diese Mod joinen' : 'Spieler brauchen diese Mod ebenfalls'}">${m.serverOnly ? '🖥 nur Server' : '👥 auch für Spieler'}</span>
            </div>
          </div>
        </div>
        <p class="text-xs text-zinc-400 mt-2 flex-1">${esc(m.description || m.notes || '')}</p>
        ${m.compatible === false ? `<p class="text-xs text-red-300 mt-2">⛔ Passt nicht: ${esc(m.name)} ${esc(m.compatReason || '')}.</p>` : ''}
        ${m.compatible === null ? `<p class="text-xs text-amber-400 mt-2">⚠ ${esc(m.compatReason || 'Server-Version unbekannt')} – vor dem Installieren wird nachgefragt.</p>` : ''}
        ${m.compatible === false
          ? '<button class="btn btn-ghost btn-sm mt-3 self-start" disabled>Nicht installierbar</button>'
          : `<button class="btn btn-green btn-sm mt-3 self-start" data-mod-install="${esc(m.id)}" ${m.busy ? 'disabled' : ''}>${m.busy ? '⏳ Wird installiert …' : '⬇ Installieren'}</button>`}
      </div>`
          )
          .join('')
      : `<p class="text-sm text-zinc-500">${d.mods.length ? '✅ Alle Mods von GitHub sind installiert.' : d.status === 'ok' ? 'Auf GitHub sind noch keine Mods veröffentlicht.' : '–'}</p>`;
  if (state.mods) renderMods();
}

document.addEventListener('click', async (e) => {
  const inst = e.target.closest('[data-mod-install]');
  const upd = e.target.closest('[data-mod-update]');
  if (!inst && !upd) return;
  const id = (inst || upd).dataset.modInstall || (inst || upd).dataset.modUpdate;
  (inst || upd).disabled = true;
  const url = `/api/mod-updates/${encodeURIComponent(id)}/${inst ? 'install' : 'update'}`;
  try {
    let r;
    try {
      r = await api('POST', url);
    } catch (err) {
      if (err.status !== 428 || !confirm(err.message)) throw err;
      r = await api('POST', url, { force: true });
    }
    renderCatalog(r);
    const m = r.mods.find((x) => x.id === id);
    if (inst) toast(`${m.name} installiert.${r.restartRequired ? ' Aktiv nach dem nächsten Server-Neustart.' : ''}`, 'ok');
    else toast(m.pendingVersion ? `${m.name} ${m.pendingVersion} wird beim nächsten Server-Start installiert.` : `${m.name} auf ${m.version} aktualisiert.`, 'ok');
    loadMods();
  } catch (err) {
    toast(err.message, 'err');
    (inst || upd).disabled = false;
  }
});
$('#catCheck').onclick = async () => {
  try {
    renderCatalog(await api('POST', '/api/mod-updates/check'));
    loadMods();
  } catch (err) {
    toast(err.message, 'err');
  }
};
$('#modSearch').addEventListener('input', renderMods);
$('#modFilter').addEventListener('change', renderMods);
$('#btnReloadMods').onclick = loadMods;

$('#modTable').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const enabled = btn.dataset.enabled === 'true';
  try {
    if (btn.dataset.toggle) {
      btn.disabled = true;
      const name = btn.dataset.toggle;
      const r = await api('POST', `/api/mods/${encodeURIComponent(name)}/toggle`, { enabled: !enabled });
      toast(`${name} ${enabled ? 'deaktiviert' : 'aktiviert'}${r.restartRequired ? ' – Neustart nötig' : ''}`, r.restartRequired ? 'warn' : 'ok');
    } else if (btn.dataset.delete) {
      const name = btn.dataset.delete;
      if (!confirm(`Mod "${name}" endgültig löschen?`)) return;
      await api('DELETE', `/api/mods/${encodeURIComponent(name)}?enabled=${enabled}`);
      toast(`${name} gelöscht`, 'ok');
    }
  } catch (err) {
    toast(err.message, 'err');
  }
  loadMods();
});

// Upload (mit Fortschrittsanzeige über XHR)
function uploadMods(files) {
  const jars = [...files].filter((f) => f.name.toLowerCase().endsWith('.jar'));
  if (!jars.length) return toast('Bitte nur .jar-Dateien auswählen', 'err');
  const existing = new Set(state.mods.map((m) => m.name));
  const dupes = jars.filter((f) => existing.has(f.name)).map((f) => f.name);
  if (dupes.length && !confirm(`Bereits vorhanden und wird überschrieben:\n${dupes.join('\n')}\n\nFortfahren?`)) return;

  const form = new FormData();
  jars.forEach((f) => form.append('mods', f, f.name));
  const xhr = new XMLHttpRequest();
  $('#uploadProgress').classList.remove('hidden');
  xhr.upload.onprogress = (e) => {
    if (!e.lengthComputable) return;
    const pct = Math.round((e.loaded / e.total) * 100);
    $('#uploadBar').style.width = pct + '%';
    $('#uploadText').textContent = `${jars.length} Datei(en) – ${pct}%`;
  };
  xhr.onloadend = () => {
    $('#uploadProgress').classList.add('hidden');
    $('#uploadBar').style.width = '0%';
    let data = {};
    try { data = JSON.parse(xhr.responseText); } catch (_) {}
    if (xhr.status === 200) {
      toast(`${data.uploaded.length} Mod(s) hochgeladen${data.restartRequired ? ' – Neustart nötig' : ''}`, 'ok');
    } else {
      toast(data.error || 'Upload fehlgeschlagen', 'err');
    }
    $('#modFiles').value = '';
    loadMods();
  };
  xhr.open('POST', '/api/mods/upload');
  xhr.send(form);
}

$('#modFiles').addEventListener('change', (e) => uploadMods(e.target.files));
const dz = $('#dropZone');
['dragenter', 'dragover'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove('drag'); }));
dz.addEventListener('drop', (e) => uploadMods(e.dataTransfer.files));

// ---------------- Backups ----------------
async function loadBackups() {
  try {
    const data = await api('GET', '/api/backups');
    $('#backupDirInfo').textContent = data.backupDir;
    setBackupBusy(!!data.inProgress);
    $('#backupTable').innerHTML = data.backups.length
      ? data.backups
          .map(
            (b) => `<tr>
          <td class="font-mono break-all pr-4">${esc(b.name)}</td>
          <td class="text-right text-zinc-400">${fmtSize(b.size)}</td>
          <td class="text-right text-zinc-400">${fmtDate(b.created)}</td>
          <td class="text-right space-x-2">
            <a class="btn btn-ghost btn-sm" href="/api/backups/${encodeURIComponent(b.name)}/download">⬇ Download</a>
            <button class="btn btn-ghost btn-sm text-red-400" data-delete="${esc(b.name)}">🗑</button>
          </td></tr>`
          )
          .join('')
      : `<tr><td colspan="4" class="py-6 text-center text-zinc-500">Noch keine Backups</td></tr>`;
  } catch (err) {
    toast(err.message, 'err');
  }
}

function setBackupBusy(busy) {
  $('#btnBackup').disabled = busy;
  $('#backupBusy').classList.toggle('hidden', !busy);
}

$('#btnBackup').onclick = async () => {
  setBackupBusy(true);
  try {
    const r = await api('POST', '/api/backups', { mode: $('#backupMode').value });
    toast(`Backup erstellt: ${r.name} (${fmtSize(r.size)})`, 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  setBackupBusy(false);
  loadBackups();
};

$('#backupTable').addEventListener('click', async (e) => {
  const name = e.target.closest('button')?.dataset.delete;
  if (!name || !confirm(`Backup "${name}" löschen?`)) return;
  try {
    await api('DELETE', `/api/backups/${encodeURIComponent(name)}`);
    toast('Backup gelöscht', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
  loadBackups();
});

// ---------------- Einstellungen ----------------
const form = $('#settingsForm');

function setHint(id, ok, okText, errText) {
  const el = $(id);
  el.className = `hint ${ok ? 'ok' : 'err'}`;
  el.textContent = ok ? okText : errText;
}

async function loadSettings() {
  const result = await loadServerInfo();
  if (!result) return;
  const { config, info } = result;
  for (const [k, v] of Object.entries(config)) if (form.elements[k]) form.elements[k].value = v;
  if (config.serverFile) {
    setHint('#hintServerFile', info.serverDirExists && info.startFileExists, '✓ Server-Datei gefunden', '✗ Datei nicht gefunden – bitte über „Öffnen …“ neu auswählen');
  } else {
    setHint('#hintServerFile', false, '', 'Noch keine Server-Datei ausgewählt');
  }
  $('#hintBackupDir').className = 'hint';
  $('#hintBackupDir').textContent = `Backups landen in: ${info.resolvedBackupDir}`;
  $('#eulaBox').classList.toggle('hidden', info.eula !== false || !info.serverDirExists);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(form).entries());
  try {
    await api('PUT', '/api/config', body);
    toast('Einstellungen gespeichert', 'ok');
    loadSettings();
  } catch (err) {
    toast(err.message, 'err');
  }
});

$('#btnBrowseBackup').onclick = async () => {
  try {
    const path = await browseDialog('folder', 'backupDir');
    if (path) {
      toast(`Backup-Ordner: ${path}`, 'ok');
      loadSettings();
    }
  } catch (err) {
    toast(err.message, 'err');
  }
};

$('#btnEula').onclick = async () => {
  if (!confirm('Bestätigst du, dass du die Minecraft-EULA (https://aka.ms/MinecraftEULA) gelesen hast und akzeptierst?')) return;
  try {
    await api('POST', '/api/eula');
    toast('EULA akzeptiert', 'ok');
    loadSettings();
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ---------------- Updates ----------------
let upState = null;
let notifiedVersion = null; // nur einmal pro Version melden
function renderUpdate(u) {
  upState = u;
  $('#upVersion').textContent = `Version ${u.version}`;
  const next = u.latest && u.latest.version;
  const texts = {
    idle: 'Noch nicht nach Updates gesucht.',
    checking: 'Suche nach Updates …',
    uptodate: '✅ Du hast die neueste Version.',
    available: `⬆ Version ${next} ist verfügbar – klicke auf „Jetzt aktualisieren“.`,
    downloading: `Version ${next} wird heruntergeladen …`,
    ready: `⬆ Version ${next} ist heruntergeladen – klicke auf „Jetzt aktualisieren“.`,
    installing: `Version ${next} wird installiert …`,
    error: `⚠ ${u.error || 'Fehler bei der Update-Suche.'}`,
  };
  let text = texts[u.status] || '';
  if (u.devMode) text = 'Entwicklerversion – Updates werden von hier aus veröffentlicht, nicht installiert.';
  if (u.checkedAt && ['uptodate', 'error'].includes(u.status)) text += ` (geprüft ${new Date(u.checkedAt).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr)`;
  $('#upText').textContent = text;
  const showNotes = next && u.latest.notes && ['available', 'downloading', 'ready'].includes(u.status);
  $('#upNotes').classList.toggle('hidden', !showNotes);
  if (showNotes) $('#upNotes').textContent = `Neu in ${next}:\n${u.latest.notes}`;
  $('#upInstall').classList.toggle('hidden', u.devMode || !['available', 'ready'].includes(u.status));
  $('#upCheck').disabled = ['checking', 'downloading', 'installing'].includes(u.status);
  if (!u.devMode && u.status === 'available' && next && notifiedVersion !== next) {
    toast(`⬆ Servertool ${next} ist verfügbar – Einstellungen → Updates.`, 'info');
  }
  notifiedVersion = ['available', 'ready'].includes(u.status) ? next : null;
  // Hinweis im Menü
  const tab = document.querySelector('.tab[data-tab="settings"] span');
  if (tab) tab.textContent = !u.devMode && ['available', 'ready'].includes(u.status) ? 'Einstellungen •' : 'Einstellungen';

  // Ergebnis des letzten Updates einmalig anzeigen
  const r = u.lastResult;
  if (r && !r.seen) {
    if (r.ok) toast(`🎉 Servertool wurde auf Version ${r.to} aktualisiert.${r.notes ? '\n' + r.notes : ''}`, 'ok');
    else toast(`⚠ Update auf ${r.to} fehlgeschlagen – Version ${r.from} wurde wiederhergestellt. (${r.error})`, 'err');
    api('POST', '/api/update/dismiss').catch(() => {});
  }
}
$('#upCheck').onclick = async () => {
  try {
    const u = await api('POST', '/api/update/check');
    renderUpdate(u);
    if (u.status === 'uptodate') toast('Keine neue Version – du bist aktuell.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
};
$('#upInstall').onclick = async () => {
  const running = state.status && state.status !== 'offline';
  if (!confirm(`Auf Version ${upState.latest.version} aktualisieren?

${running ? 'Der Minecraft-Server wird dafür sicher gestoppt (Welt wird gespeichert) und nach dem Update wieder gestartet.' : 'Das Tool startet danach automatisch neu.'}`)) return;
  try {
    await api('POST', '/api/update/install');
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ---------------- Automatische Updates (Einstellung) ----------------
let au = null;
function fmtMMSS(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function renderAutoUpdate(d) {
  if (d) au = d;
  if (!au) return;
  $('#auEnabled').classList.toggle('on', !!au.enabled);
  const work = [...au.work.mods.map((m) => `Mod ${m}`), ...(au.work.tool ? [`Servertool ${au.work.tool}`] : [])];
  let text = '';
  let cls = 'text-zinc-500';
  if (!au.enabled) {
    text = 'Aus – Updates werden nur angezeigt.';
  } else if (au.running) {
    text = '⏳ Updates werden gerade installiert …';
    cls = 'text-sky-300';
  } else if (!work.length) {
    text = '✅ An – zurzeit keine Updates.';
    cls = 'text-emerald-300';
  } else if (au.installAt) {
    text = `⏳ Server ist leer – ${work.join(', ')} ${work.length === 1 ? 'wird' : 'werden'} in ${fmtMMSS(au.installAt - Date.now())} installiert.`;
    cls = 'text-amber-300';
  } else {
    text = `🕹 ${work.join(', ')} ${work.length === 1 ? 'wartet' : 'warten'}, bis der Server ${au.emptyMinutes} Minuten leer ist.`;
    cls = 'text-amber-300';
  }
  if (au.lastAction && !au.running) text += ` Zuletzt: ${au.lastAction.text} (${new Date(au.lastAction.at).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr).`;
  $('#auInfo').className = `text-sm mt-2 ${cls}`;
  $('#auInfo').textContent = text;
}
setInterval(() => au && au.installAt && renderAutoUpdate(), 1000);
$('#auEnabled').onclick = async () => {
  const turnOn = !(au && au.enabled);
  if (turnOn && !confirm('Updates automatisch installieren?\n\nSobald der Server 3 Minuten leer ist, werden zuerst Mod-Updates und danach Servertool-Updates installiert. Der Minecraft-Server wird dafür kurz gestoppt und startet danach automatisch wieder.')) return;
  try {
    renderAutoUpdate(await api('PUT', '/api/auto-update', { enabled: turnOn }));
    toast(turnOn ? 'Automatische Updates eingeschaltet.' : 'Automatische Updates ausgeschaltet.', 'ok');
  } catch (err) {
    toast(err.message, 'err');
  }
};

// ---------------- Init ----------------
connectWs();
checkToolVersion();
loadServerInfo();
let initialTab = 'dashboard';
try { initialTab = localStorage.getItem('tab') || 'dashboard'; } catch (_) {}
// Direktaufruf per Adresse, z.B. #server:restart
const [hashTab, hashSub] = location.hash.slice(1).split(':');
if (hashTab) initialTab = hashTab;
if (hashSub) srv.sub = hashSub;
showTab(initialTab);
window.addEventListener('hashchange', () => {
  const [t, s] = location.hash.slice(1).split(':');
  if (!t) return;
  if (s && ['rules', 'props', 'restart'].includes(s)) srv.sub = s;
  showTab(t);
  if (t === 'server' && s) showSub(srv.sub);
});
