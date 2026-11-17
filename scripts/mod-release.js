// Eigene Mod auf GitHub veröffentlichen – alle Servertools finden sie danach innerhalb von 5 Minuten:
//   npm run mod-release -- "..\VeinMinex" "Neue Funktion X" "Fehler Y behoben"
//   npm run mod-release -- "C:\pfad\zur\mod.jar"
// Liest ID, Name, Version usw. aus der .jar. Jede Version kann nur einmal veröffentlicht werden
// (vorher mod_version in gradle.properties erhöhen und neu bauen).
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { readJarInfo } = require('../lib/jarinfo');

const ROOT = path.join(__dirname, '..');
const REPO = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).modsRepo;
const gh = (args, opts = {}) => execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim();

function findJar(p) {
  const abs = path.resolve(p);
  if (fs.statSync(abs).isFile()) return abs;
  const libs = path.join(abs, 'build', 'libs');
  const jars = fs.existsSync(libs)
    ? fs.readdirSync(libs).filter((f) => /\.jar$/i.test(f) && !/-(sources|javadoc|dev|slim)\.jar$/i.test(f))
    : [];
  if (!jars.length) throw new Error(`Keine .jar in ${libs} – Mod zuerst bauen (gradlew build).`);
  jars.sort((a, b) => fs.statSync(path.join(libs, b)).mtimeMs - fs.statSync(path.join(libs, a)).mtimeMs);
  return path.join(libs, jars[0]);
}

function ensureRepo() {
  try {
    gh(['repo', 'view', REPO, '--json', 'name']);
  } catch (_) {
    console.log(`Lege ${REPO} an ...`);
    gh(['repo', 'create', REPO, '--public', '--add-readme', '--description', 'Eigene Minecraft-Mods – werden vom Minecraft Servertool automatisch installiert und aktualisiert']);
  }
}

(async () => {
  const [target, ...notesArr] = process.argv.slice(2);
  if (!target) throw new Error('Aufruf: npm run mod-release -- <Mod-Ordner oder .jar> ["Änderung 1" ...]');
  const jar = findJar(target);
  const info = readJarInfo(jar);
  if (!info || !info.id || !info.version) throw new Error(`Konnte Mod-Infos nicht aus ${path.basename(jar)} lesen.`);
  ensureRepo();

  const tag = `${info.id}-v${info.version}`;
  let exists = true;
  try {
    gh(['release', 'view', tag, '--repo', REPO]);
  } catch (_) {
    exists = false;
  }
  if (exists) throw new Error(`${info.name} ${info.version} ist schon veröffentlicht. Bitte mod_version erhöhen und neu bauen.`);

  const meta = { id: info.id, version: info.version, name: info.name, description: info.description, mc: info.mc, loader: info.loader, serverOnly: info.serverOnly };
  const notes = notesArr.length ? notesArr.map((n) => `• ${n}`).join('\n') : '';
  const body = [notes, info.description, `<!-- servertool-mod ${JSON.stringify(meta)} -->`].filter(Boolean).join('\n\n');
  gh(['release', 'create', tag, jar, '--repo', REPO, '--title', `${info.name} ${info.version}`, '--notes', body]);
  console.log(`✅ ${info.name} ${info.version} veröffentlicht (${path.basename(jar)}).`);
})().catch((err) => {
  console.error('❌', (err.stderr && String(err.stderr).trim()) || err.message);
  process.exit(1);
});
