# 🍻 SPIELBAR — Busfahrer Online

Das Trinkspiel **Busfahrer** als echte Online-Version: Jeder Spieler ist am eigenen
Handy/Browser, sieht **nur seine eigenen Karten** und entscheidet privat, ob er legt.
Der Server verwaltet das komplette Spiel — schummeln über die Browser-Konsole ist
nicht möglich, weil verdeckte Karten den Server nie verlassen.

## ⚡ Schnellstart (lokal testen)

Voraussetzung: [Node.js](https://nodejs.org) installiert (Version 18+).

```bash
npm install
npm start
```

Dann im Browser öffnen: **http://localhost:3000**

### Mit Freunden im gleichen WLAN testen

1. Finde deine lokale IP-Adresse heraus:
   - Windows: `ipconfig` → "IPv4-Adresse" (z.B. `192.168.178.42`)
2. Deine Freunde öffnen am Handy: `http://192.168.178.42:3000`
3. Raum erstellen, Code teilen, los geht's! 🚌

> Falls es nicht klappt: Windows-Firewall fragt beim ersten Start, ob Node.js
> ins Netzwerk darf → "Zulassen" klicken.

## 🌍 Online stellen (damit Freunde von überall joinen)

Kostenlose Hosting-Optionen für Node.js + WebSockets:

- **Render.com** (Free Tier): Repo auf GitHub pushen → "New Web Service" →
  Build: `npm install`, Start: `npm start`. Fertig.
- **Railway.app**: Ähnlich simpel, GitHub-Repo verbinden.
- **Fly.io**: Etwas technischer, dafür sehr flexibel.

Der Server nutzt automatisch den Port aus der Umgebungsvariable `PORT` —
das erwarten alle diese Anbieter. HTTPS/WSS funktioniert automatisch,
der Client erkennt das selbst.

## 🧪 Automatischer Test

```bash
npm start          # in einem Terminal
node test.js       # in einem zweiten Terminal
```

Drei Bots spielen ein komplettes Spiel durch und prüfen dabei u.a.,
dass kein Spieler fremde oder verdeckte Karten sehen kann.

## 🎮 Spielregeln (wie implementiert)

1. **Fragerunde** — Reihum 4 Fragen: Rot/Schwarz → Höher/Tiefer → Innen/Außen →
   Farbe. Jede Antwort bringt eine Handkarte. Falsch = trinken. (Gleichstand
   bei Höher/Tiefer und Innen/Außen zählt als falsch.)
2. **Pyramide** — 15 Karten: 5+2quer / 3+1quer / 2+1quer / 1.
   Reihe 1 = 1 Schluck, Reihe 4 = 4 Schlücke, quer = doppelt.
   Karte aufgedeckt → jeder entscheidet **privat in seinem Browser**, ob er
   passende Karten (gleicher Wert) legt und wer trinkt. Es geht erst weiter,
   wenn alle gewählt haben. Wer nicht legen kann, wird automatisch übersprungen.
3. **Busfahren** — Wer am Ende die meisten Karten (oder höchsten Punkte, je nach
   Modus) übrig hat, fährt Bus: 4 Fragen in Folge richtig = frei.
   Falsch bei Frage X = X Schlücke und zurück auf Start.

## 📁 Projektstruktur

```
spielbar/
├── server.js          # Spiellogik + WebSocket-Server (die "Wahrheit")
├── public/
│   └── index.html     # Client (HTML/CSS/JS in einer Datei)
├── test.js            # Automatischer Bot-Testdurchlauf
└── package.json
```

## 🔜 Ideen für später

- Weitere Minispiele im gleichen Raum-System
- Premium: mehr als 6 Spieler pro Raum, eigene Regeln
- Dezente Werbung zwischen den Runden
- Reconnect-Verbesserungen, Spectator-Modus, Sounds

---
*18+ · Bitte trinkt verantwortungsvoll.*
