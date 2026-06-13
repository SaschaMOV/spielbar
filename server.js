// ============================================================
//  SPIELBAR — Trinkspiel-Plattform
//  Ein Raum, mehrere Spiele: Der Host wählt in der Lobby das
//  Spiel, nach jeder Runde geht's zurück zur Lobby.
//
//  Spiele:
//   - busfahrer    (Karten: Fragerunde, Pyramide, Busfahren)
//   - werwuerde    (Voting: "Wer würde eher...?")
//
//  Der Server ist die "Wahrheit": verdeckte Karten und geheime
//  Votes verlassen den Server nie.
// ============================================================

const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const MAX_PLAYERS_FREE = 6;
const GAMES = ["busfahrer", "werwuerde"];

const app = express();
app.use(express.static(path.join(__dirname, "public")));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ---------- Karten ----------
const SUITS = ["♥", "♦", "♣", "♠"];
const isRed = (s) => s === "♥" || s === "♦";
const VL = { 11: "J", 12: "Q", 13: "K", 14: "A" };
const labelCard = (c) => `${VL[c.v] || c.v}${c.s}`;

function makeDeck() {
  const d = [];
  for (const s of SUITS) for (let v = 2; v <= 14; v++) d.push({ s, v });
  for (let i = d.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

// ---------- "Wer würde eher?" Fragen nach Kategorien ----------
const WW_CATEGORIES = {
  harmlos: {
    name: "Harmlos", icon: "😊", adult: false,
    desc: "Alltagstauglich für jede Runde",
    prompts: [
      "…einen ganzen Tag im Schlafanzug verbringen?",
      "…beim Kochen das Rezept komplett ignorieren?",
      "…sich über die kleinste Kleinigkeit tierisch freuen?",
      "…einen Streamingdienst-Account mit zu vielen Leuten teilen?",
      "…beim Wandern nach 10 Minuten umkehren wollen?",
      "…die Anleitung erst lesen, wenn nichts mehr geht?",
      "…ein Tier adoptieren, ohne vorher nachzudenken?",
      "…beim Brettspiel die Regeln zu eigenen Gunsten auslegen?",
      "…den Kühlschrank öffnen und ihn wieder zumachen, ohne was zu nehmen?",
      "…sich für ein Selfie 20 Mal neu hinstellen?",
      "…in einem fremden Land sofort die Sprache radebrechen?",
      "…einen Pflanzen-Shop leerkaufen?",
      "…beim Film weinen und es abstreiten?",
      "…drei Wecker stellen und trotzdem verschlafen?",
      "…spontan einen Kuchen um Mitternacht backen?",
      "…beim Spazieren jeden Hund streicheln müssen?",
      "…eine Playlist für jede Stimmung haben?",
      "…sich beim Friseur nie trauen, was zu sagen?",
      "…den Einkaufswagen mit Sachen füllen, die nicht auf der Liste stehen?",
      "…als Erste/r bei einer Überraschung alles ausplaudern?",
    ],
  },
  party: {
    name: "Party", icon: "🎉", adult: false,
    desc: "Betrunken, peinlich, Eskalation",
    prompts: [
      "…um 3 Uhr nachts noch Pizza für alle bestellen?",
      "…auf dem Tisch tanzen, wenn das Lieblingslied läuft?",
      "…betrunken eine emotionale Liebeserklärung an die Freunde halten?",
      "…beim Trinkspiel absichtlich verlieren, um mehr zu trinken?",
      "…die After-Show-Party noch verlängern, wenn alle gehen wollen?",
      "…am nächsten Morgen 47 unbeantwortete Nachrichten haben?",
      "…sich am Tresen mit dem Personal anfreunden?",
      "…den DJ um dasselbe Lied zum dritten Mal bitten?",
      "…betrunken die komplette Lebensgeschichte einem Fremden erzählen?",
      "…morgens mit Glitzer im Gesicht aufwachen und nicht wissen warum?",
      '…als Erste/r „nur noch einen" sagen und dann bleiben?',
      "…auf einer Hochzeit als Letzte/r die Tanzfläche verlassen?",
      "…den Heimweg antreten und beim Späti enden?",
      "…ein Gruppenfoto ruinieren, weil man Quatsch macht?",
      "…betrunken großspurig eine Wette eingehen?",
      "…den Kühlschrank der Gastgeber komplett plündern?",
      "…sich freiwillig zum Karaoke-Solo melden?",
      "…am nächsten Tag behaupten, gar nicht so betrunken gewesen zu sein?",
      "…auf der Party einschlafen und durchgemalt werden?",
      "…spontan eine Runde Shots für Wildfremde ausgeben?",
    ],
  },
  spicy: {
    name: "Spicy", icon: "🌶️", adult: true,
    desc: "Frech & unter der Gürtellinie · 18+",
    prompts: [
      "…in dieser Runde am ehesten ein pikantes Geheimnis haben?",
      "…schon mal an einem ungewöhnlichen Ort übereinander hergefallen sein?",
      "…die meisten Matches auf einer Dating-App haben?",
      "…am ehesten mit zwei Leuten gleichzeitig schreiben?",
      "…den frechsten Suchverlauf haben?",
      "…am lautesten Nachbarn nerven?",
      "…schon mal jemanden aus dieser Runde attraktiv gefunden haben?",
      "…am ehesten beim ersten Date schon mitkommen?",
      "…den wildesten Junggesellenabschied erlebt haben?",
      "…ein Date abbrechen, um zu jemand anderem zu fahren?",
      "…am ehesten ein Tabu im Schlafzimmer ausprobieren?",
      "…schon mal erwischt worden sein, wo man nicht sein sollte?",
      "…am ehesten ein gewagtes Foto verschicken?",
      "…den peinlichsten Spitznamen vom Ex bekommen haben?",
      "…am ehesten beim Dirty Talk in Lachen ausbrechen?",
      "…den meisten Drama-Verflossenen-Verlauf haben?",
      "…am ehesten beim Flaschendrehen aufs Ganze gehen?",
      "…schon mal eine Affäre für sich behalten haben?",
      "…am ehesten jemanden aus dem Freundeskreis daten?",
      "…den frechsten Korb verteilt haben?",
    ],
  },
};
const WW_ROUNDS = 10;

// ---------- Räume ----------
const rooms = new Map();

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
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
    players: [],
    hostId: null,
    phase: "lobby",
    game: null, // in der Lobby gewähltes Spiel (null = noch keins gewählt)
    mode: "cards",
    deck: [],
    sipLog: [],
    q: null, py: null, bus: null,  // Busfahrer
    ww: null,                      // Wer würde eher (läuft)
    wwConfig: { cats: ["harmlos", "party"], custom: [] }, // Lobby-Einstellungen
    createdAt: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addLog(room, msg) {
  room.sipLog.unshift(msg);
  room.sipLog = room.sipLog.slice(0, 8);
}

function resetToLobby(room) {
  for (const p of room.players) p.hand = [];
  room.phase = "lobby";
  room.q = null; room.py = null; room.bus = null; room.ww = null;
  room.sipLog = [];
}

// ---------- Personalisierter State pro Spieler ----------
function stateFor(room, player) {
  const base = {
    type: "state",
    code: room.code,
    phase: room.phase,
    game: room.game,
    mode: room.mode,
    maxPlayers: MAX_PLAYERS_FREE,
    you: { id: player.id, name: player.name, hand: player.hand },
    isHost: player.id === room.hostId,
    players: room.players.map((p) => ({
      id: p.id, name: p.name, cards: p.hand.length,
      connected: p.connected, isHost: p.id === room.hostId,
    })),
    sipLog: room.sipLog,
  };

  // --- Wer würde eher: Lobby-Einstellungen (nur in der Lobby relevant) ---
  if (room.phase === "lobby" && room.game === "werwuerde") {
    base.wwCats = Object.entries(WW_CATEGORIES).map(([key, c]) => ({
      key, name: c.name, icon: c.icon, adult: c.adult, desc: c.desc,
      count: c.prompts.length,
      active: room.wwConfig.cats.includes(key),
    }));
    base.wwCustom = room.wwConfig.custom.slice();
  }

  // --- Busfahrer ---
  if (room.phase === "questions" && room.q) {
    const turnPlayer = room.players[room.q.turn];
    base.questions = {
      qIndex: room.q.qIndex,
      turnPlayerId: turnPlayer ? turnPlayer.id : null,
      turnPlayerName: turnPlayer ? turnPlayer.name : "",
      turnHand: turnPlayer ? turnPlayer.hand : [],
      pending: room.q.pending,
    };
  }
  if ((room.phase === "pyramid" || room.phase === "busIntro") && room.py) {
    base.pyramid = {
      rows: room.py.rows.map((row) => row.map((slot) => ({
        quer: slot.quer, revealed: slot.revealed,
        card: slot.revealed ? slot.card : null,
      }))),
      ptr: room.py.ptr,
      total: room.py.rows.flat().length,
      sub: room.py.sub,
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
      driverId: room.bus.driver, driverName: d ? d.name : "?",
      run: room.bus.run, step: room.bus.step,
      total: room.bus.total, fails: room.bus.fails,
      pending: room.bus.pending,
    };
  }

  // --- Wer würde eher ---
  if (room.ww && (room.phase === "ww_vote" || room.phase === "ww_reveal" || room.phase === "ww_end")) {
    const expected = room.players.filter((p) => p.connected).map((p) => p.id);
    base.ww = {
      round: room.ww.round,
      totalRounds: room.ww.totalRounds,
      prompt: room.ww.prompts[room.ww.round - 1],
      youVoted: room.ww.votes[player.id] !== undefined,
      waitingNames: room.players
        .filter((p) => p.connected && room.ww.votes[p.id] === undefined)
        .map((p) => p.name),
      // Geheime Votes werden erst im Reveal mitgeschickt:
      reveal: room.phase !== "ww_vote" ? buildWwReveal(room) : null,
      totals: room.phase === "ww_end" ? buildWwTotals(room) : null,
      _expectedCount: expected.length,
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
function send(ws, obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

// ============================================================
//  SPIEL 1: BUSFAHRER
// ============================================================
function startBusfahrer(room, mode) {
  room.mode = mode === "points" ? "points" : "cards";
  room.deck = makeDeck();
  for (const p of room.players) p.hand = [];
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
  if (room.q.turn >= room.players.length) { room.q.turn = 0; room.q.qIndex++; }
  if (room.q.qIndex >= 4) return buildPyramid(room);
  skipDisconnected(room);
}

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

function buildPyramid(room) {
  const layout = [
    [0, 0, 1, 0, 1, 0, 0],
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
  if (room.py.ptr + 1 >= flat.length) return;
  room.py.ptr++;
  flat[room.py.ptr].slot.revealed = true;
  room.py.lastLog = [];
  room.py.sub = "choose";
  // Wie beim Poker: JEDER wählt — das Warten verrät nicht, wer legen könnte.
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

// ============================================================
//  SPIEL 2: WER WÜRDE EHER?
// ============================================================
function startWerwuerde(room) {
  // Fragenpool aus gewählten Kategorien + eigenen Fragen bauen
  const cfg = room.wwConfig || { cats: ["harmlos", "party"], custom: [] };
  let pool = [];
  for (const cat of cfg.cats) {
    if (WW_CATEGORIES[cat]) pool.push(...WW_CATEGORIES[cat].prompts);
  }
  pool.push(...(cfg.custom || []));
  // Fallback: falls irgendwie leer, harmlose Fragen nehmen
  if (pool.length === 0) pool = [...WW_CATEGORIES.harmlos.prompts];
  // Mischen
  for (let i = pool.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  room.ww = {
    round: 1,
    totalRounds: Math.min(WW_ROUNDS, pool.length),
    prompts: pool,
    votes: {},          // voterId -> targetId (geheim bis Reveal!)
    totals: {},         // targetId -> Stimmen über alle Runden
  };
  room.phase = "ww_vote";
}

function wwVote(room, player, targetId) {
  if (room.phase !== "ww_vote") return;
  if (room.ww.votes[player.id] !== undefined) return; // schon gevotet
  const target = room.players.find((p) => p.id === targetId);
  if (!target) return;
  room.ww.votes[player.id] = targetId;
  checkWwAllVoted(room);
}

function checkWwAllVoted(room) {
  const expected = room.players.filter((p) => p.connected).map((p) => p.id);
  const allVoted = expected.every((id) => room.ww.votes[id] !== undefined);
  if (allVoted && expected.length > 0) {
    // Stimmen zählen und in Gesamtstatistik übernehmen
    const tally = {};
    for (const t of Object.values(room.ww.votes)) tally[t] = (tally[t] || 0) + 1;
    for (const [id, n] of Object.entries(tally)) room.ww.totals[id] = (room.ww.totals[id] || 0) + n;
    const max = Math.max(...Object.values(tally));
    const drinkers = room.players.filter((p) => tally[p.id] === max);
    for (const d of drinkers) {
      addLog(room, `🫵 ${d.name} trinkt ${max} ${max === 1 ? "Schluck" : "Schlücke"} (${max} ${max === 1 ? "Stimme" : "Stimmen"})`);
    }
    room.ww.lastTally = tally;
    room.phase = "ww_reveal";
  }
}

function buildWwReveal(room) {
  const tally = room.ww.lastTally || {};
  const max = Object.values(tally).length ? Math.max(...Object.values(tally)) : 0;
  return {
    tally: room.players
      .map((p) => ({ id: p.id, name: p.name, votes: tally[p.id] || 0 }))
      .sort((a, b) => b.votes - a.votes),
    drinkers: room.players.filter((p) => tally[p.id] === max && max > 0).map((p) => p.name),
    sips: max,
  };
}

function buildWwTotals(room) {
  return room.players
    .map((p) => ({ name: p.name, votes: room.ww.totals[p.id] || 0 }))
    .sort((a, b) => b.votes - a.votes);
}

function wwNext(room, player) {
  if (room.phase !== "ww_reveal" || player.id !== room.hostId) return;
  if (room.ww.round >= room.ww.totalRounds) { room.phase = "ww_end"; return; }
  room.ww.round++;
  room.ww.votes = {};
  room.ww.lastTally = null;
  room.phase = "ww_vote";
}

// ============================================================
//  WebSocket-Handling
// ============================================================
wss.on("connection", (ws) => {
  let me = null;
  let myRoom = null;

  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg !== "object" || !msg) return;

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

    if (msg.type === "join") {
      const name = cleanName(msg.name);
      const code = String(msg.code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!name) return send(ws, { type: "error", msg: "Bitte gib einen Namen ein." });
      if (!room) return send(ws, { type: "error", msg: "Raum nicht gefunden. Code prüfen!" });
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
      // --- Lobby ---
      case "selectGame":
        if (me.id === room.hostId && room.phase === "lobby") {
          if (msg.game === null || msg.game === "none") room.game = null;
          else if (GAMES.includes(msg.game)) room.game = msg.game;
        }
        break;
      case "start":
        if (me.id === room.hostId && room.phase === "lobby" && room.players.length >= 2) {
          if (room.game === "busfahrer") startBusfahrer(room, msg.mode);
          else if (room.game === "werwuerde") startWerwuerde(room);
        }
        break;

      // --- Wer würde eher: Lobby-Einstellungen ---
      case "wwToggleCat":
        if (me.id === room.hostId && room.phase === "lobby") {
          const cat = String(msg.cat);
          if (WW_CATEGORIES[cat]) {
            const i = room.wwConfig.cats.indexOf(cat);
            if (i >= 0) room.wwConfig.cats.splice(i, 1);
            else room.wwConfig.cats.push(cat);
          }
        }
        break;
      case "wwAddCustom":
        if (room.phase === "lobby") {
          const text = cleanCustomQuestion(msg.text);
          if (text && room.wwConfig.custom.length < 30) {
            room.wwConfig.custom.push(text);
            addLog(room, `✍️ ${me.name} hat eine eigene Frage hinzugefügt`);
          }
        }
        break;
      case "wwRemoveCustom":
        if (me.id === room.hostId && room.phase === "lobby") {
          const idx = Number(msg.index);
          if (Number.isInteger(idx) && idx >= 0 && idx < room.wwConfig.custom.length) {
            room.wwConfig.custom.splice(idx, 1);
          }
        }
        break;
      case "backToLobby":
        if (me.id === room.hostId && (room.phase === "end" || room.phase === "ww_end")) {
          resetToLobby(room);
        }
        break;

      // --- Busfahrer ---
      case "answer":    answerQuestion(room, me, String(msg.value)); break;
      case "qNext":     questionNext(room, me); break;
      case "nextCard":  pyramidNextCard(room, me); break;
      case "lay":       pyramidLay(room, me, msg.plays); break;
      case "toBus":     toBus(room, me); break;
      case "busStart":  busStart(room, me); break;
      case "busAnswer": busAnswer(room, me, String(msg.value)); break;
      case "busNext":   busNext(room, me); break;

      // --- Wer würde eher ---
      case "wwVote":    wwVote(room, me, String(msg.targetId)); break;
      case "wwNext":    wwNext(room, me); break;

      default: return;
    }
    broadcast(room);
  });

  ws.on("close", () => {
    if (!me || !myRoom) return;
    me.connected = false;
    me.ws = null;
    const room = myRoom;

    if (room.phase === "lobby") {
      room.players = room.players.filter((p) => p.id !== me.id);
      if (room.hostId === me.id && room.players.length > 0) room.hostId = room.players[0].id;
    } else {
      addLog(room, `📵 ${me.name} hat die Verbindung verloren`);
      if (room.phase === "pyramid" && room.py && room.py.waiting.has(me.id)) {
        room.py.waiting.delete(me.id);
        room.py.lastLog.push(`${me.name} (offline) legt nicht.`);
        if (room.py.waiting.size === 0) room.py.sub = "results";
      }
      if (room.phase === "questions" && room.q && !room.q.pending) skipDisconnected(room);
      if (room.phase === "ww_vote" && room.ww) checkWwAllVoted(room);
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

function cleanCustomQuestion(t) {
  let s = String(t || "").trim().replace(/[<>]/g, "").slice(0, 120);
  if (s.length < 3) return null;
  // Komfort: führendes "Wer würde eher" entfernen, damit es zum Format passt
  s = s.replace(/^wer würde eher\s*/i, "").trim();
  // Mit … beginnen lassen, wenn nicht schon Satzzeichen am Anfang
  if (!s.startsWith("…") && !s.startsWith("...")) s = "…" + s;
  return s;
}

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
