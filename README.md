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

Das Tool **prüft** regelmäßig, ob es Updates gibt: **Mods alle 5 Minuten**, das **Servertool alle 10 Minuten**. Gefundene Updates werden angezeigt.

**Updates automatisch installieren** (Einstellungen → Updates, standardmäßig **aus**):
- **Aus:** Updates werden nur angezeigt. Installiert wird per Klick, unter **Einstellungen → Updates** für das Tool und unter **Mods** für die Mods.
- **An:** Sobald der Server **3 Minuten leer** ist, werden die Updates eingespielt:
  1. zuerst alle **Mod-Updates**
  2. danach das **Servertool**
  3. danach startet der **Minecraft-Server automatisch** wieder

  Gibt es nur Mod-Updates, wird der Minecraft-Server einmal neu gestartet, damit sie geladen werden. Joint jemand, bevor die 3 Minuten um sind, wird gewartet.

In beiden Fällen gilt:
- Einstellungen, Welten, Spielerlisten und Backups bleiben erhalten.
- Alte Mod-Versionen werden in `data/mod-backups` gesichert.
- Startet eine neue Tool-Version nicht richtig, wird automatisch die vorherige wiederhergestellt.

## Eigene Mods von GitHub

Im Bereich **Mods** zeigt die Karte **„Meine Mods auf GitHub“** alle Mods aus [kaik93-bit/minecraft-mods](https://github.com/kaik93-bit/minecraft-mods). Das Tool **prüft alle 5 Minuten** auf neue Versionen. Installiert wird per Klick oder automatisch, siehe [Updates](#updates).

- **Updates verfügbar**: Mods mit neuer Version stehen oben mit **⬆ Aktualisieren**.
  - Ist der Server aus, wird die neue Version sofort eingespielt.
  - Läuft er, wird sie heruntergeladen und beim nächsten Start bzw. Stopp eingesetzt, weil Windows geladene Mods sperrt.
  - Die alte Version wird in `data/mod-backups` gesichert. Deaktivierte Mods bleiben deaktiviert.
- **Noch nicht installiert**: Mods, die du noch nicht hast, mit Beschreibung und **⬇ Installieren**. Sie sind nach dem nächsten Server-Neustart aktiv.
- Installierte Mods zeigen „✓ aktuell“ oder „⬆ Update auf x.y“.
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

**Neue Tool-Version veröffentlichen.** Alle installierten Tools zeigen sie danach als Update an:

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

Das Skript liest ID, Name und Version aus der `.jar` (bei einem Ordner die neueste aus `build/libs`) und erstellt das Release in `minecraft-mods`. Alle Servertools zeigen die neue Version innerhalb von 5 Minuten an.

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
