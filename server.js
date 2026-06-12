// ============================================================
//  SPIELBAR — Busfahrer Online
//  Server: Express (statische Dateien) + WebSocket (Spiellogik)
//  Der Server ist die "Wahrheit": Karten werden NUR hier gemischt
//  und jeder Spieler bekommt ausschließlich seine eigene Hand
//  geschickt. Schummeln über die Browser-Konsole ist damit
//  nicht möglich.
// ============================================================

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_FREE = 6;

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Karten ----------
const SUITS = ["♥", "♦", "♣", "♠"];
const isRed = (s) => s === "♥" || s === "♦";

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let v = 2; v <= 14; v++) d.push({ s, v });
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ---------- Räume ----------
const rooms = new Map(); // code -> room

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // ohne I/O/0/1 (Verwechslungsgefahr)
  let c;
  do {
    c = "";
    for (let i = 0; i < 4; i++) c += chars[crypto.randomInt(chars.length)];
  } while (rooms.has(c));
  return c;
}

function createRoom() {
  const room = {
    code: makeCode(),
    players: [], // {id, name, ws, connected, hand: []}
    hostId: null,
    phase: "lobby", // lobby | questions | pyramid | busIntro | bus | end
    mode: "cards",
    deck: [],
    sipLog: [],
    q: null,   // {qIndex, turn, pending}
    py: null,  // {rows, ptr, sub, waiting:Set, log, lastLog}
    bus: null, // {driver, deck, run, step, total, fails, pending}
    createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addLog(room, msg) {
  room.sipLog.unshift(msg);
  room.sipLog = room.sipLog.slice(0, 8);
}

// ---------- Personalisierter State pro Spieler ----------
function stateFor(room, player) {
  const base = {
    type: "state",
    code: room.code,
    phase: room.phase,
    mode: room.mode,
    maxPlayers: MAX_PLAYERS_FREE,
    you: { id: player.id, name: player.name, hand: player.hand },
    isHost: player.id === room.hostId,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      cards: p.hand.length,
      connected: p.connected,
      isHost: p.id === room.hostId,
    })),
    sipLog: room.sipLog,
  };

  if (room.phase === "questions" && room.q) {
    const turnPlayer = room.players[room.q.turn];
    base.questions = {
      qIndex: room.q.qIndex,
      turnPlayerId: turnPlayer ? turnPlayer.id : null,
      turnPlayerName: turnPlayer ? turnPlayer.name : "",
      turnHand: turnPlayer ? turnPlayer.hand : [], // Referenzkarten sind offen sichtbar
      pending: room.q.pending, // {card, correct} — Ergebnis sehen alle
    };
  }

  if ((room.phase === "pyramid" || room.phase === "busIntro") && room.py) {
    base.pyramid = {
      rows: room.py.rows.map((row) =>
        row.map((slot) => ({
          quer: slot.quer,
          revealed: slot.revealed,
          card: slot.revealed ? slot.card : null, // verdeckte Karten verlassen NIE den Server
        }))
      ),
      ptr: room.py.ptr,
      total: room.py.rows.flat().length,
      sub: room.py.sub, // choose | results | done
      currentSips: currentSips(room),
      currentCard: currentCard(room),
      waitingNames: room.players.filter((p) => room.py.waiting.has(p.id)).map((p) => p.name),
      youDone: !room.py.waiting.has(player.id),
      youCanLay: canLayIndices(room, player),
      lastLog: room.py.lastLog,
    };
  }

  if ((room.phase === "bus" || room.phase === "busIntro" || room.phase === "end") && room.bus) {
    const d = room.players.find((p) => p.id === room.bus.driver);
    base.bus = {
      driverId: room.bus.driver,
      driverName: d ? d.name : "?",
      run: room.bus.run,
      step: room.bus.step,
      total: room.bus.total,
      fails: room.bus.fails,
      pending: room.bus.pending,
    };
  }

  return base;
}

function broadcast(room) {
  for (const p of room.players) {
    if (p.connected && p.ws && p.ws.readyState === 1) {
      try { p.ws.send(JSON.stringify(stateFor(room, p))); } catch (e) {}
    }
  }
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- Phase 1: Fragerunde ----------
function startGame(room, mode) {
  room.mode = mode === "points" ? "points" : "cards";
  room.deck = makeDeck();
  for (const p of room.players) p.hand = [];
  room.sipLog = [];
  room.q = { qIndex: 0, turn: 0, pending: null };
  room.phase = "questions";
  skipDisconnected(room);
}

function checkAnswer(qIndex, ans, card, hand, runRef) {
  const ref = runRef || hand;
  if (qIndex === 0) return (ans === "rot") === isRed(card.s);
  if (qIndex === 1) {
    if (!ref[0]) return false;
    return ans === "hoch" ? card.v > ref[0].v : card.v < ref[0].v;
  }
  if (qIndex === 2) {
    if (!ref[0] || !ref[1]) return false;
    const a = Math.min(ref[0].v, ref[1].v);
    const b = Math.max(ref[0].v, ref[1].v);
    return ans === "innen" ? card.v > a && card.v < b : card.v < a || card.v > b;
  }
  if (qIndex === 3) return ans === card.s;
  return false;
}

function answerQuestion(room, player, ans) {
  if (room.phase !== "questions" || room.q.pending) return;
  const turnPlayer = room.players[room.q.turn];
  if (!turnPlayer || turnPlayer.id !== player.id) return;

  const card = room.deck.shift();
  const correct = checkAnswer(room.q.qIndex, ans, card, turnPlayer.hand);
  turnPlayer.hand.push(card);
  room.q.pending = { card, correct };
  if (!correct) addLog(room, `🍺 ${turnPlayer.name} trinkt 1 Schluck`);
}

function questionNext(room, player) {
  if (room.phase !== "questions" || !room.q.pending) return;
  const turnPlayer = room.players[room.q.turn];
  if (turnPlayer.id !== player.id && player.id !== room.hostId) return;

  room.q.pending = null;
  room.q.turn++;
  if (room.q.turn >= room.players.length) {
    room.q.turn = 0;
    room.q.qIndex++;
  }
  if (room.q.qIndex >= 4) return buildPyramid(room);
  skipDisconnected(room);
}

// Getrennte Spieler: Zufallsantwort, damit das Spiel nicht hängt
function skipDisconnected(room) {
  let guard = 0;
  while (room.phase === "questions" && guard++ < 50) {
    const tp = room.players[room.q.turn];
    if (!tp || tp.connected) return;
    const opts = [["rot", "schwarz"], ["hoch", "tief"], ["innen", "außen"], SUITS][room.q.qIndex];
    const ans = opts[crypto.randomInt(opts.length)];
    const card = room.deck.shift();
    const correct = checkAnswer(room.q.qIndex, ans, card, tp.hand);
    tp.hand.push(card);
    addLog(room, `📵 ${tp.name} (offline) — Zufallsantwort: ${correct ? "richtig" : "falsch, 1 Schluck"}`);
    room.q.turn++;
    if (room.q.turn >= room.players.length) { room.q.turn = 0; room.q.qIndex++; }
    if (room.q.qIndex >= 4) return buildPyramid(room);
  }
}

// ---------- Phase 2: Pyramide ----------
function buildPyramid(room) {
  const layout = [
    [0, 0, 1, 0, 1, 0, 0], // unten: 5 normal + 2 quer
    [0, 1, 0, 0],
    [0, 1, 0],
    [0],
  ];
  const rows = layout.map((row) =>
    row.map((q) => ({ card: room.deck.shift(), quer: q === 1, revealed: false }))
  );
  room.py = { rows, ptr: -1, sub: "results", waiting: new Set(), lastLog: [] };
  room.phase = "pyramid";
}

function flatSlots(room) {
  return room.py.rows.flatMap((row, r) => row.map((slot) => ({ slot, row: r })));
}
function currentCard(room) {
  if (!room.py || room.py.ptr < 0) return null;
  const f = flatSlots(room)[room.py.ptr];
  return f ? f.slot.card : null;
}
function currentSips(room) {
  if (!room.py || room.py.ptr < 0) return 0;
  const f = flatSlots(room)[room.py.ptr];
  return f ? (f.row + 1) * (f.slot.quer ? 2 : 1) : 0;
}
function canLayIndices(room, player) {
  const c = currentCard(room);
  if (!c || room.py.sub !== "choose") return [];
  return player.hand.map((h, i) => (h.v === c.v ? i : -1)).filter((i) => i >= 0);
}

function pyramidNextCard(room, player) {
  if (room.phase !== "pyramid" || player.id !== room.hostId) return;
  if (room.py.sub !== "results") return;
  const flat = flatSlots(room);
  if (room.py.ptr + 1 >= flat.length) return; // fertig — Host nutzt "toBus"

  room.py.ptr++;
  flat[room.py.ptr].slot.revealed = true;
  room.py.lastLog = [];
  room.py.sub = "choose";

  // Wie beim Poker: JEDER muss wählen (legen oder passen) — egal ob er
  // passende Karten hat. So verrät das Warten nicht, wer legen könnte.
  room.py.waiting = new Set(room.players.filter((p) => p.connected).map((p) => p.id));
  if (room.py.waiting.size === 0) {
    room.py.sub = "results";
    room.py.lastLog = ["Niemand hat gelegt."];
  }
}

function pyramidLay(room, player, plays) {
  if (room.phase !== "pyramid" || room.py.sub !== "choose") return;
  if (!room.py.waiting.has(player.id)) return;

  const c = currentCard(room);
  const sips = currentSips(room);
  const valid = [];
  const used = new Set();
  if (Array.isArray(plays)) {
    for (const pl of plays.slice(0, 8)) {
      const idx = pl && Number.isInteger(pl.cardIdx) ? pl.cardIdx : -1;
      const target = room.players.find((x) => x.id === pl.targetId);
      if (idx >= 0 && idx < player.hand.length && !used.has(idx) && player.hand[idx].v === c.v && target) {
        used.add(idx);
        valid.push({ idx, target });
      }
    }
  }
  // Karten entfernen (absteigend, damit Indizes stimmen)
  valid.sort((a, b) => b.idx - a.idx);
  for (const v of valid) {
    const card = player.hand.splice(v.idx, 1)[0];
    const line = `🍺 ${player.name} legt ${labelCard(card)} → ${v.target.name} trinkt ${sips} ${sips === 1 ? "Schluck" : "Schlücke"}`;
    room.py.lastLog.push(line);
    addLog(room, line);
  }
  if (valid.length === 0) room.py.lastLog.push(`${player.name} legt nicht.`);

  room.py.waiting.delete(player.id);
  if (room.py.waiting.size === 0) {
    room.py.sub = "results";
    if (room.py.lastLog.length === 0) room.py.lastLog = ["Niemand hat gelegt."];
  }
}

const VL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const labelCard = (c) => `${VL[c.v] || c.v}${c.s}`;

function toBus(room, player) {
  if (room.phase !== "pyramid" || player.id !== room.hostId) return;
  const flat = flatSlots(room);
  if (room.py.ptr + 1 < flat.length || room.py.sub !== "results") return;

  const score = (p) => (room.mode === "cards" ? p.hand.length : p.hand.reduce((a, c) => a + c.v, 0));
  const max = Math.max(...room.players.map(score));
  const tied = room.players.filter((p) => score(p) === max);
  const driver = tied[crypto.randomInt(tied.length)];

  room.bus = { driver: driver.id, deck: makeDeck(), run: [], step: 0, total: 0, fails: 0, pending: null };
  room.phase = "busIntro";
}

// ---------- Phase 3: Busfahren ----------
function busStart(room, player) {
  if (room.phase !== "busIntro") return;
  if (player.id !== room.bus.driver && player.id !== room.hostId) return;
  room.phase = "bus";
}

function busAnswer(room, player, ans) {
  if (room.phase !== "bus" || room.bus.pending) return;
  if (player.id !== room.bus.driver) return;
  if (room.bus.deck.length < 5) room.bus.deck = makeDeck();
  const card = room.bus.deck.shift();
  const correct = checkAnswer(room.bus.step, ans, card, null, room.bus.run);
  room.bus.pending = { card, correct };
}

function busNext(room, player) {
  if (room.phase !== "bus" || !room.bus.pending) return;
  if (player.id !== room.bus.driver && player.id !== room.hostId) return;
  const { card, correct } = room.bus.pending;
  room.bus.pending = null;
  if (correct) {
    room.bus.run.push(card);
    if (room.bus.step === 3) { room.phase = "end"; return; }
    room.bus.step++;
  } else {
    const sips = room.bus.step + 1;
    room.bus.total += sips;
    room.bus.fails++;
    addLog(room, `🚌 ${player.name}: falsch bei Frage ${room.bus.step + 1} — ${sips} ${sips === 1 ? "Schluck" : "Schlücke"}, zurück auf Start`);
    room.bus.run = [];
    room.bus.step = 0;
  }
}

function playAgain(room, player) {
  if (room.phase !== "end" || player.id !== room.hostId) return;
  for (const p of room.players) p.hand = [];
  room.phase = "lobby";
  room.q = null; room.py = null; room.bus = null;
  room.sipLog = [];
}

// ---------- WebSocket-Handling ----------
wss.on("connection", (ws) => {
  let me = null;   // player object
  let myRoom = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg !== "object" || !msg) return;

    // --- Raum erstellen ---
    if (msg.type === "create") {
      const name = cleanName(msg.name);
      if (!name) return send(ws, { type: "error", msg: "Bitte gib einen Namen ein." });
      const room = createRoom();
      const player = { id: crypto.randomUUID(), name, ws, connected: true, hand: [] };
      room.players.push(player);
      room.hostId = player.id;
      me = player; myRoom = room;
      broadcast(room);
      return;
    }

    // --- Raum beitreten ---
    if (msg.type === "join") {
      const name = cleanName(msg.name);
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!name) return send(ws, { type: "error", msg: "Bitte gib einen Namen ein." });
      if (!room) return send(ws, { type: "error", msg: "Raum nicht gefunden. Code prüfen!" });

      // Rejoin: gleicher Name, getrennter Slot
      const ghost = room.players.find((p) => !p.connected && p.name.toLowerCase() === name.toLowerCase());
      if (ghost) {
        ghost.ws = ws; ghost.connected = true;
        me = ghost; myRoom = room;
        addLog(room, `🔌 ${ghost.name} ist wieder da`);
        broadcast(room);
        return;
      }
      if (room.phase !== "lobby") return send(ws, { type: "error", msg: "Das Spiel läuft schon. Warte auf die nächste Runde!" });
      if (room.players.length >= MAX_PLAYERS_FREE)
        return send(ws, { type: "error", msg: `Maximal ${MAX_PLAYERS_FREE} Spieler (Free-Version).` });
      if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase()))
        return send(ws, { type: "error", msg: "Der Name ist im Raum schon vergeben." });

      const player = { id: crypto.randomUUID(), name, ws, connected: true, hand: [] };
      room.players.push(player);
      me = player; myRoom = room;
      broadcast(room);
      return;
    }

    if (!me || !myRoom) return;
    const room = myRoom;

    switch (msg.type) {
      case "start":
        if (me.id === room.hostId && room.phase === "lobby" && room.players.length >= 2) {
          startGame(room, msg.mode);
        }
        break;
      case "answer":      answerQuestion(room, me, String(msg.value)); break;
      case "qNext":       questionNext(room, me); break;
      case "nextCard":    pyramidNextCard(room, me); break;
      case "lay":         pyramidLay(room, me, msg.plays); break;
      case "toBus":       toBus(room, me); break;
      case "busStart":    busStart(room, me); break;
      case "busAnswer":   busAnswer(room, me, String(msg.value)); break;
      case "busNext":     busNext(room, me); break;
      case "again":       playAgain(room, me); break;
      default: return;
    }
    broadcast(room);
  });

  ws.on("close", () => {
    if (!me || !myRoom) return;
    me.connected = false;
    me.ws = null;
    const room = myRoom;

    // Lobby: Spieler ganz entfernen
    if (room.phase === "lobby") {
      room.players = room.players.filter((p) => p.id !== me.id);
      if (room.hostId === me.id && room.players.length > 0) room.hostId = room.players[0].id;
    } else {
      addLog(room, `📵 ${me.name} hat die Verbindung verloren`);
      // Blockiert die Pyramide nicht: offene Wahl wird übersprungen
      if (room.phase === "pyramid" && room.py.waiting.has(me.id)) {
        room.py.waiting.delete(me.id);
        room.py.lastLog.push(`${me.name} (offline) legt nicht.`);
        if (room.py.waiting.size === 0) room.py.sub = "results";
      }
      // Fragerunde: ggf. weiterschalten
      if (room.phase === "questions" && !room.q.pending) skipDisconnected(room);
      // Host-Wechsel auf verbundenen Spieler
      if (room.hostId === me.id) {
        const next = room.players.find((p) => p.connected);
        if (next) room.hostId = next.id;
      }
    }
    if (room.players.length === 0) rooms.delete(room.code);
    else broadcast(room);
  });
});

function cleanName(n) {
  return String(n || "").trim().slice(0, 16).replace(/[<>]/g, "");
}

// Alte leere Räume aufräumen (alle 10 Min)
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyConnected = room.players.some((p) => p.connected);
    if (!anyConnected && now - room.createdAt > 1000 * 60 * 30) rooms.delete(code);
  }
}, 1000 * 60 * 10);

server.listen(PORT, () => {
  console.log(`🍻 SPIELBAR läuft auf http://localhost:${PORT}`);
});
