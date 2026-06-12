// Automatischer Durchlauf: 3 Bots spielen ein komplettes Spiel
// und prüfen, dass niemand fremde Karten sehen kann.
const WebSocket = require("ws");
const URL = "ws://localhost:3000";

function bot(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const b = { name, ws, state: null, resolve };
    ws.on("message", (raw) => {
      const msg = JSON.parse(raw);
      if (msg.type === "error") { console.error(`[${name}] ERROR: ${msg.msg}`); process.exit(1); }
      if (msg.type === "state") b.state = msg;
    });
    ws.on("open", () => resolve(b));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (b, obj) => b.ws.send(JSON.stringify(obj));

(async () => {
  let privacyChecks = 0;

  // 1) Host erstellt Raum
  const host = await bot("Sascha");
  send(host, { type: "create", name: "Sascha" });
  await sleep(150);
  const code = host.state.code;
  console.log(`✅ Raum erstellt: ${code}`);

  // 2) Zwei Spieler joinen
  const p2 = await bot("Nini");
  send(p2, { type: "join", name: "Nini", code });
  const p3 = await bot("Tom");
  send(p3, { type: "join", name: "Tom", code });
  await sleep(150);
  if (host.state.players.length !== 3) { console.error("❌ Join fehlgeschlagen"); process.exit(1); }
  console.log("✅ 3 Spieler in der Lobby");

  // Falscher Code → Fehler erwartet
  const ghost = await bot("Geist");
  let gotErr = false;
  ghost.ws.removeAllListeners("message");
  ghost.ws.on("message", (raw) => { if (JSON.parse(raw).type === "error") gotErr = true; });
  send(ghost, { type: "join", name: "Geist", code: "ZZZZ" });
  await sleep(150);
  console.log(gotErr ? "✅ Falscher Raumcode wird abgelehnt" : "❌ Falscher Code nicht abgelehnt");
  ghost.ws.close();

  // 3) Nicht-Host versucht zu starten (muss ignoriert werden)
  send(p2, { type: "start", mode: "cards" });
  await sleep(100);
  if (host.state.phase !== "lobby") { console.error("❌ Nicht-Host konnte starten!"); process.exit(1); }
  console.log("✅ Nur der Host kann starten");

  // 4) Host startet
  send(host, { type: "start", mode: "cards" });
  await sleep(150);
  console.log(`✅ Spiel gestartet, Phase: ${host.state.phase}`);

  const bots = [host, p2, p3];
  const byId = (id) => bots.find((b) => b.state.you.id === id);

  // 5) Fragerunde durchspielen
  const QOPTS = [["rot", "schwarz"], ["hoch", "tief"], ["innen", "außen"], ["♥", "♦", "♣", "♠"]];
  let guard = 0;
  while (host.state.phase === "questions" && guard++ < 60) {
    const q = host.state.questions;
    // Privacy-Check: Sehe ich fremde Hände? (außer der offenen Referenzhand des aktiven Spielers)
    for (const b of bots) {
      const others = b.state.players.filter((p) => p.id !== b.state.you.id);
      for (const o of others) {
        if (o.hand !== undefined) { console.error(`❌ ${b.name} sieht fremde Hand!`); process.exit(1); }
      }
      privacyChecks++;
    }
    const active = byId(q.turnPlayerId);
    if (q.pending) send(active, { type: "qNext" });
    else {
      const opts = QOPTS[q.qIndex];
      send(active, { type: "answer", value: opts[Math.floor(Math.random() * opts.length)] });
    }
    await sleep(60);
  }
  console.log(`✅ Fragerunde abgeschlossen (${privacyChecks} Privacy-Checks ok), Phase: ${host.state.phase}`);
  for (const b of bots) {
    if (b.state.you.hand.length !== 4) { console.error(`❌ ${b.name} hat ${b.state.you.hand.length} statt 4 Karten`); process.exit(1); }
  }
  console.log("✅ Jeder Spieler hat 4 Handkarten");

  // 6) Pyramide: verdeckte Karten dürfen NIE mitgeschickt werden
  guard = 0;
  while (host.state.phase === "pyramid" && guard++ < 120) {
    const py = host.state.pyramid;
    for (const b of bots) {
      for (const row of b.state.pyramid.rows) for (const slot of row) {
        if (!slot.revealed && slot.card) { console.error("❌ Verdeckte Pyramidenkarte wurde an Client geschickt!"); process.exit(1); }
      }
    }
    if (py.sub === "results") {
      if (py.ptr + 1 >= py.total && py.ptr >= 0) send(host, { type: "toBus" });
      else send(host, { type: "nextCard" });
    } else {
      // Alle die noch wählen müssen: erste passende Karte auf zufälliges Ziel legen
      for (const b of bots) {
        const bp = b.state.pyramid;
        if (!bp.youDone) {
          const canLay = bp.youCanLay;
          if (canLay.length > 0) {
            const target = b.state.players[Math.floor(Math.random() * b.state.players.length)].id;
            send(b, { type: "lay", plays: [{ cardIdx: canLay[0], targetId: target }] });
          } else {
            send(b, { type: "lay", plays: [] });
          }
        }
      }
    }
    await sleep(60);
  }
  console.log(`✅ Pyramide abgeschlossen, Phase: ${host.state.phase}`);
  console.log(`   Busfahrer: ${host.state.bus.driverName}`);

  // 7) Busfahren
  const driver = byId(host.state.bus.driverId);
  send(driver, { type: "busStart" });
  await sleep(100);
  guard = 0;
  while (host.state.phase === "bus" && guard++ < 400) {
    const bus = driver.state.bus;
    if (bus.pending) send(driver, { type: "busNext" });
    else send(driver, { type: "busAnswer", value: QOPTS[bus.step][Math.floor(Math.random() * QOPTS[bus.step].length)] });
    await sleep(25);
  }
  console.log(`✅ Busfahren beendet, Phase: ${host.state.phase} — ${host.state.bus.fails} Fehlversuche, ${host.state.bus.total} Schlücke`);

  // 8) Neue Runde
  send(host, { type: "again" });
  await sleep(100);
  console.log(`✅ Neue Runde, Phase: ${host.state.phase}`);

  console.log("\n🍻 ALLE TESTS BESTANDEN");
  process.exit(0);
})().catch((e) => { console.error("❌ Test-Crash:", e); process.exit(1); });
