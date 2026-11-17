// Neue Version veröffentlichen:
//   npm run release -- 1.2.0 "Was ist neu 1" "Was ist neu 2"
// Erhöht die Versionsnummer, committet, pusht, baut das Komplettpaket (inkl. Node.js)
// und erstellt ein GitHub-Release. Installierte Tools holen sich das Update dann selbst.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...opts }).trim();

function cmp(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  return 0;
}

async function portableNode() {
  const v = process.version; // gleiche Version wie hier
  const name = `node-${v}-win-x64`;
  const cache = path.join(os.tmpdir(), 'mcst-node-cache');
  const dir = path.join(cache, name);
  if (fs.existsSync(path.join(dir, 'node.exe'))) return dir;
  fs.mkdirSync(cache, { recursive: true });
  const zip = path.join(cache, name + '.zip');
  console.log(`Lade Node.js ${v} für das Paket herunter ...`);
  const res = await fetch(`https://nodejs.org/dist/${v}/${name}.zip`);
  if (!res.ok) throw new Error(`Node.js-Download fehlgeschlagen (${res.status})`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  execFileSync(path.join(process.env.SystemRoot, 'System32', 'tar.exe'), ['-xf', zip, '-C', cache]);
  return dir;
}

async function buildPackage(version) {
  const files = sh('git', ['ls-files']).split('\n').filter(Boolean);
  const out = path.join(ROOT, 'dist', `Minecraft-Servertool-${version}.zip`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const nodeDir = await portableNode();
  await new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(out);
    const zip = archiver('zip', { zlib: { level: 9 } });
    ws.on('close', resolve);
    zip.on('error', reject);
    zip.pipe(ws);
    const base = 'Minecraft Servertool/';
    for (const f of files) if (!f.startsWith('scripts/')) zip.file(path.join(ROOT, f), { name: base + f });
    zip.directory(path.join(ROOT, 'node_modules'), base + 'node_modules');
    zip.directory(nodeDir, base + 'node');
    zip.finalize();
  });
  console.log(`Paket: ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB)`);
  return out;
}

(async () => {
  const [version, ...notesArr] = process.argv.slice(2);
  const pkgFile = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('Aufruf: npm run release -- 1.2.0 "Änderung 1" "Änderung 2"');
  const first = !sh('git', ['tag', '--list', 'v*']);
  if (!first && cmp(version, pkg.version) <= 0) throw new Error(`Version muss größer als ${pkg.version} sein.`);
  const notes = notesArr.length ? notesArr.map((n) => `• ${n}`).join('\n') : '• Verbesserungen und Fehlerbehebungen';

  pkg.version = version;
  fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  const lockFile = path.join(ROOT, 'package-lock.json');
  if (fs.existsSync(lockFile)) {
    const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    lock.version = version;
    if (lock.packages && lock.packages['']) lock.packages[''].version = version;
    fs.writeFileSync(lockFile, JSON.stringify(lock, null, 2) + '\n');
  }

  sh('git', ['add', '-A']);
  if (sh('git', ['status', '--porcelain'])) sh('git', ['commit', '-q', '-m', `Version ${version}\n\n${notes}`]);
  sh('git', ['tag', `v${version}`]);
  sh('git', ['push', '-q', 'origin', 'HEAD', `refs/tags/v${version}`]);

  const zip = await buildPackage(version);
  sh('gh', ['release', 'create', `v${version}`, zip, '--title', `Version ${version}`, '--notes', notes]);
  console.log(`\n✅ Version ${version} veröffentlicht. Installierte Servertools aktualisieren sich automatisch.`);
})().catch((err) => {
  console.error('❌', err.message);
  process.exit(1);
});
