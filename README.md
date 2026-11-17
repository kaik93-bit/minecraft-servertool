# Minecraft Servertool

Programm zum Steuern eines Minecraft-Servers auf dem eigenen PC (Vanilla, Paper, Fabric, Forge, NeoForge). Die Oberfläche läuft in einem eigenen App-Fenster. Es öffnet sich weder ein Konsolenfenster noch das Java-Fenster „Minecraft server“.

## Installation

1. Bei [Releases](../../releases/latest) die Datei **`Minecraft-Servertool-x.y.z.zip`** herunterladen.
2. Die ZIP-Datei an einen beliebigen Ort entpacken, z. B. auf den Desktop.
3. Im Ordner **`Minecraft Servertool`** auf **`Servertool starten.vbs`** doppelklicken.

Node.js ist im Paket enthalten, du musst also nichts zusätzlich installieren. Nur **Java** brauchst du in der Version, die zu deinem Minecraft-Server passt.

Beim ersten Start klickst du auf **„📂 Server-Datei öffnen …“** und wählst die Startdatei deines Servers aus:
- Vanilla, Paper oder Fabric: `server.jar`
- Forge oder NeoForge: `run.bat`

## Updates

Das Tool aktualisiert sich **von selbst**:
- Es sucht beim Start und danach regelmäßig nach einer neuen Version (in der Testphase alle 10 Sekunden).
- Eine neue Version wird im Hintergrund heruntergeladen und installiert, sobald **niemand spielt**.
- Läuft der Server gerade, wird er dafür sicher gestoppt (die Welt wird gespeichert) und danach automatisch wieder gestartet.
- Einstellungen, Spielerlisten, Auto-Neustart-Zeiten und Backups bleiben erhalten.
- Startet eine neue Version nicht richtig, stellt das Tool automatisch die vorherige wieder her.

Unter **Einstellungen → Updates** kannst du automatische Updates abschalten, selbst nach Updates suchen oder ein Update sofort installieren.

## Eigene Mods von GitHub

Im Bereich **Mods** zeigt die Karte **„Meine Mods auf GitHub“** alle Mods aus [kaik93-bit/minecraft-mods](https://github.com/kaik93-bit/minecraft-mods):
- **Noch nicht installierte** Mods stehen dort mit Beschreibung. Ein Klick auf **Installieren** genügt; aktiv werden sie nach dem nächsten Server-Neustart.
- Das Tool sucht **alle 5 Minuten** nach neuen Versionen. Installierte Mods zeigen „✓ aktuell“ oder „⬆ Update auf x.y“.
- **Automatische Updates** (an/aus):
  - Ist der Server aus, wird die neue Version sofort eingespielt.
  - Läuft er, wird sie heruntergeladen und beim nächsten Start bzw. Stopp installiert, weil Windows geladene Mods sperrt.
  - Die alte Version wird in `data/mod-backups` gesichert.
  - Deaktivierte Mods bleiben deaktiviert.
- Andere Mods (nicht aus diesem Katalog) werden nie angefasst.

Bei Mods mit „👥 auch für Spieler“ brauchen die Spieler dieselbe Version im eigenen Minecraft. „🖥 nur Server“-Mods brauchen sie nicht.

## Funktionen

- **Server**: starten, sicher stoppen, neu starten, notfalls hart beenden
- **Konsole**: live mitlesen, Befehle eingeben, Verlauf mit ↑/↓
- **Leistung**: Ping, TPS, MSPT, Spielerzahl
- **Spieler**:
  - Online- und Offline-Spieler mit Ping
  - ein Klick auf einen Spieler öffnet seine Aktionen: Nachricht, Spielmodus, Kick, Whitelist, OP, Bann
- **Verbindungsversuche**: abgewiesene Spieler (z. B. nicht auf der Whitelist) per Klick freischalten
- **Server-Einstellungen**:
  - Spielregeln (z. B. Nether, PvP, Inventar behalten) wirken sofort
  - `server.properties` mit verständlichen Beschriftungen
- **Tag-/Nachtlänge** frei einstellbar
- **Automatische Neustarts** zu festen Uhrzeiten und Wochentagen, mit Chat-Warnungen und optionalem Backup
- **Mods**: an/aus, hochladen per Drag & Drop, löschen, Ordner direkt öffnen
- **Backups** als ZIP (nur Welt oder ganzer Server)

## Bedienung

- **Fenster schließen**: Tool und Minecraft-Server laufen im Hintergrund weiter. Ein erneuter Doppelklick auf `Servertool starten.vbs` holt das Fenster zurück.
- **Komplett beenden**: Knopf **⏻ Beenden** in der Seitenleiste. Der Minecraft-Server wird vorher sicher gestoppt.

## Hinweise

- **Mods** umschalten oder löschen geht nur bei gestopptem Server, weil Windows geladene `.jar`-Dateien sperrt. Hochladen geht immer.
- **Ping der Spieler**: Minecraft stellt den Ping nicht für Tools bereit. Das Tool misst deshalb den Netzwerk-Ping zur IP des Spielers. Steht dort „?“, blockiert der Router des Spielers Ping-Anfragen.
- **Sicherheit**: Das Tool ist nur vom eigenen PC aus erreichbar (127.0.0.1). Bitte nicht per Port-Weiterleitung ins Internet stellen.
- Bei Problemen hilft die Datei `tool.log` im Tool-Ordner weiter.

---

## Für Entwickler

```
npm install
npm start                 # mit sichtbaren Logs, dann http://localhost:3000 öffnen
```

**Neue Version veröffentlichen.** Alle installierten Tools holen sie sich danach automatisch:

```
npm run release -- 1.2.0 "Neue Funktion X" "Fehler Y behoben"
```

Das Skript:
- erhöht die Versionsnummer, committet und pusht
- baut das Komplettpaket inklusive Node.js
- erstellt das GitHub-Release

**Eigene Mod veröffentlichen.** Vorher `mod_version` erhöhen und die Mod bauen:

```
npm run mod-release -- "..VeinMinex" "Was ist neu"
```

Das Skript liest ID, Name und Version aus der `.jar` (bei einem Ordner die neueste aus `build/libs`) und erstellt das Release in `minecraft-mods`. Alle Servertools finden die neue Version innerhalb von 5 Minuten.

Benötigt sind `git` und die GitHub-CLI (`gh`), eingeloggt. Im Entwicklungsordner (mit `.git`) installiert das Tool selbst keine Updates.

```
├── Servertool starten.vbs   # Starter ohne Konsolenfenster
├── server.js                # Backend: REST-API + WebSocket
├── lib/
│   ├── mcServer.js          # Serverprozess, Log, Spieler-Erkennung, Ping
│   ├── players.js           # Whitelist/OP/Bann/Kick, Verbindungsversuche
│   ├── serverSettings.js    # server.properties
│   ├── gamerules.js         # Spielregeln
│   ├── daylength.js         # Tag-/Nachtlänge (Datenpaket)
│   ├── autorestart.js       # Automatische Neustarts
│   ├── perf.js              # Ping/TPS/MSPT
│   ├── mods.js, backups.js
│   ├── updater.js           # Update-Suche & Download (GitHub-Releases)
│   ├── modCatalog.js        # eigene Mods von GitHub: Katalog, Updates, Installation
│   ├── jarinfo.js           # liest Mod-ID/Version aus .jar-Dateien
│   ├── updateGuard.js       # tauscht Dateien beim Update, stellt bei Fehlern wieder her
│   └── dialog.js, explorer.js, appWindow.js, config.js
├── public/                  # Oberfläche
├── scripts/release.js       # Veröffentlichen
└── data/                    # Laufzeitdaten (wird nie überschrieben)
```
