/**
 * Live smoke test: connects to a running server over a real WebSocket, gathers in
 * a lobby, starts the match and then plays for a few seconds.
 *
 * `npm test` proves the simulation, the codec and the room state machine are
 * correct in isolation. This proves the pieces are actually wired together — that
 * a join is accepted, that a private room opens in a lobby with nobody in it who
 * was not invited, that the host's requests are honoured *and refused* (a Start
 * sent before readying up must go nowhere), that the countdown runs and hands over
 * to a live match, that snapshots arrive at the advertised rate, that held inputs
 * move the player the server says we own, and that firing produces events. Those
 * are integration failures no unit test can see, because every piece can be
 * individually correct while the transport, the room loop or the tick order is
 * wrong.
 *
 * The run is driven by the server's own lobby packets rather than by a stopwatch:
 * each step waits for the state that proves the previous one landed. A step that
 * never lands is caught by the timeout at the bottom instead of hanging.
 *
 * Start the server first (`npm start`), then `npm run smoke`.
 */

import { WebSocket } from 'ws';
import {
  BTN,
  ByteReader,
  LF,
  LOBBY_ACT,
  LOBBY_COUNTDOWN_MS,
  MATCH_TIME_MS,
  MODE,
  MSG,
  PHASE,
  RF,
  SNAPSHOT_MS,
  decodeLobby,
  decodeMatch,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodeInputBatch,
  encodeJoin,
  encodeLobbyCmd,
  encodePing,
  newInputCmd,
  randomPartyCode,
  type InputCmd,
  type LobbyMsg,
  type MatchMsg,
  type RosterEntry,
  type Snapshot,
  type WelcomeMsg,
} from '@oneshot/shared';

const URL_WS = process.env.SMOKE_URL ?? 'ws://127.0.0.1:8787/ws';
/**
 * Where the HTTP checks go. Derived from the socket URL by default, but settable
 * on its own so the game socket can be reached through the Vite dev proxy while
 * the hostile-request checks still hit the game server directly — pointed at the
 * proxy they would only ever be testing Vite.
 */
const URL_HTTP = process.env.SMOKE_HTTP ?? URL_WS.replace(/^ws/, 'http').replace(/\/ws$/, '');
/** How long to play once the match is actually live. */
const PLAY_MS = 3500;
/**
 * A fresh room per run.
 *
 * A fixed name would mean the second run of the day joins the first run's room —
 * which by then is in a live match with bots in it, and every lobby check below
 * would fail for a reason that has nothing to do with the code. Generated codes
 * survive `sanitizePartyCode` unchanged, so what we ask for is what we get.
 */
const ROOM = randomPartyCode();

let passed = 0;
const failures: string[] = [];

function check(ok: boolean, what: string): void {
  if (ok) passed++;
  else failures.push(what);
}

/* ── HTTP surface ────────────────────────────────────────────────────────────
   The same process that runs the game answers HTTP, and its request handler runs
   synchronously inside Node's parser — so anything that throws there kills every
   room on the server. `GET /%zz` used to do exactly that, in one request, from
   an unauthenticated stranger. These checks exist so it cannot come back.
   ────────────────────────────────────────────────────────────────────────── */

async function status(path: string): Promise<number> {
  try {
    const res = await fetch(`${URL_HTTP}${path}`, { redirect: 'manual' });
    // Drain, or the socket stays open and the process will not exit.
    await res.arrayBuffer();
    return res.status;
  } catch {
    return 0;
  }
}

async function httpChecks(): Promise<void> {
  check((await status('/api/status')) === 200, 'the status endpoint answers');

  // Each of these was capable of reaching an unguarded throw.
  const hostile: Array<[string, string]> = [
    ['/%zz', 'a malformed percent-escape'],
    ['/%', 'a truncated percent-escape'],
    ['/%00', 'an encoded NUL byte'],
    ['/%c0%80', 'an overlong UTF-8 encoding'],
  ];
  for (const [path, what] of hostile) {
    const code = await status(path);
    check(code === 400, `${what} is rejected with 400, not a crash (got ${code || 'no response'})`);
  }

  // Traversal must not escape the bundle. A 200 here is the SPA fallback, so the
  // check is on the body, not the status.
  for (const path of ['/..%2f..%2fpackage.json', '/assets/..%2f..%2f..%2fpackage.json']) {
    let body = '';
    try {
      body = await (await fetch(`${URL_HTTP}${path}`)).text();
    } catch {
      /* leaves body empty, which fails the check below */
    }
    check(
      !body.includes('"workspaces"') && !body.includes('"devDependencies"'),
      `${path} does not serve files outside the client bundle`,
    );
  }

  // The point of all of the above: it is still running.
  check((await status('/api/status')) === 200, 'the server survived every hostile request');
}

/* ── What we learn from the game stream ──────────────────────────────────── */

let welcome: WelcomeMsg | null = null;
let match: MatchMsg | null = null;
let snapshots = 0;
let rosters = 0;
let pongs = 0;
let lobbies = 0;
let roster: readonly RosterEntry[] = [];
let latest: Snapshot | null = null;
let bestAck = 0;
let peakActors = 0;
let firstSnapshotAt = 0;
let lastSnapshotAt = 0;
const eventKinds = new Set<number>();

/* Movement is measured from a baseline that is re-taken when the match goes live,
   so the two phases are told apart: walking in the lobby and walking in the match
   are separate claims, and only one of them was ever tested before. */
let baseline = { x: 0, z: 0 };
let travelled = 0;
let lobbyTravelled = 0;
/** First seen position per actor, so we can tell whether anyone else moved. */
const actorFirst = new Map<number, { x: number; z: number }>();
let actorsThatMoved = 0;

/* ── The lobby, step by step ─────────────────────────────────────────────── */

/**
 * Where the run has got to.
 *
 * `joining` waits for a roster so that "nobody uninvited is here" is a claim about
 * something we have actually seen, rather than about a list that has not arrived.
 *
 * `unreadyStart` and `askedReady` exist to exercise the consent gate rather than
 * tiptoe around it: the run deliberately presses Start while unready, confirms it
 * went nowhere, and only then readies up. Both are steps rather than a pair of
 * booleans because the assertions are phrased as "was a countdown seen during this
 * step" — which is what makes them free of the race between our request arriving
 * and the next packet leaving.
 */
type Step = 'joining' | 'askedBots' | 'unreadyStart' | 'askedReady' | 'askedStart' | 'live';
let step: Step = 'joining';

let firstLobby: LobbyMsg | null = null;
let soloRoster = -1;
let filledRoster = 0;
let botsInRoster = 0;
let hostFlaggedInRoster = false;
let readyFlaggedInRoster = false;
let sawCountdown = 0;
let countdownBeforeAsking = false;
/** A countdown seen after the unready Start — i.e. consent was not enforced. */
let countdownWhileUnready = false;
/** `LF.CAN_START` advertised before we had consented to anything. */
let canStartWhileUnready = false;
/** `LF.CAN_START` advertised after we readied up, which is what unblocks Start. */
let canStartOnceReady = false;
/** Proof the unready Start was actually sent, so its refusal is not vacuous. */
let sentUnreadyStart = false;
let liveLobby: LobbyMsg | null = null;
let lobbyClockFirst = -1;
let lobbyClockLast = -1;
let liveClockFirst = -1;
let liveClockLast = -1;

// The HTTP surface is checked first, on a server known to be up, so that a
// crash there is reported as a crash rather than as a socket that would not open.
await httpChecks();

const sock = new WebSocket(URL_WS);
sock.binaryType = 'arraybuffer';

const cmds: InputCmd[] = [];
let seq = 1;
let ticker: ReturnType<typeof setInterval> | null = null;
let actStartedAt = 0;

function send(bytes: Uint8Array): void {
  if (sock.readyState === WebSocket.OPEN) sock.send(bytes, { binary: true });
}

sock.on('open', () => {
  send(encodeJoin({ name: 'smoke', primary: 'ranger', mode: MODE.FFA, room: ROOM }));
  send(encodePing(Date.now() >>> 0));

  actStartedAt = Date.now();
  ticker = setInterval(() => {
    const inAct = Date.now() - actStartedAt;
    const cmd = newInputCmd();
    cmd.seq = seq++;
    cmd.forward = 1;
    cmd.right = inAct > 900 ? 1 : 0;
    cmd.yaw = Math.sin(inAct / 900) * 0.8;
    cmd.pitch = 0;
    // Held after a moment's grace in both phases, so warming up in the lobby and
    // fighting in the match are each covered.
    cmd.buttons = inAct > 600 ? BTN.FIRE : 0;
    cmds.push(cmd);
    // The same redundant eight-command window the real client sends.
    send(encodeInputBatch(cmds, Math.max(0, cmds.length - 8)));
  }, 1000 / 60);
});

/**
 * Advance the run. Called on every lobby packet, which the server sends four
 * times a second — so each step is taken within 250 ms of becoming possible.
 */
function advance(m: LobbyMsg): void {
  if (m.phase === PHASE.LIVE) {
    if (step === 'live') return;
    step = 'live';
    liveLobby = m;
    // Fresh baselines: from here on, movement and events are the match's, not the
    // lobby's, and the play clock starts now rather than when the socket opened.
    lobbyTravelled = travelled;
    if (latest) baseline = { x: latest.self.x, z: latest.self.z };
    travelled = 0;
    eventKinds.clear();
    actStartedAt = Date.now();
    setTimeout(() => sock.close(1000, 'done'), PLAY_MS);
    return;
  }

  if (m.phase !== PHASE.LOBBY) return;

  // Read off the step rather than off our own bookkeeping of what we sent: "was a
  // countdown running during the part of the run where none could legitimately be"
  // is decided entirely by packets we have already received, so it cannot be
  // fooled by a request still in flight.
  const beforeConsent = step === 'joining' || step === 'askedBots' || step === 'unreadyStart';
  if (m.countdown > 0) {
    if (step === 'joining' || step === 'askedBots') countdownBeforeAsking = true;
    else if (step === 'unreadyStart' || step === 'askedReady') countdownWhileUnready = true;
  }
  if ((m.flags & LF.CAN_START) !== 0) {
    if (beforeConsent) canStartWhileUnready = true;
    else canStartOnceReady = true;
  }

  switch (step) {
    case 'joining':
      // Only once a roster has arrived, so the count below means something.
      if (rosters === 0) return;
      soloRoster = roster.length;
      send(encodeLobbyCmd(LOBBY_ACT.BOTS, 1));
      step = 'askedBots';
      return;

    case 'askedBots':
      // Wait for the fill to actually appear before starting: the request is only
      // honoured if we are the host, and a room that stayed empty would prove it
      // was not — which is a failure, not a reason to carry on.
      if ((m.flags & LF.BOTS) === 0 || roster.length <= 1) return;
      filledRoster = roster.length;
      botsInRoster = roster.filter((e) => (e.flags & RF.BOT) !== 0).length;
      hostFlaggedInRoster = roster.some(
        (e) => (e.flags & RF.HOST) !== 0 && e.id === (welcome?.id ?? -1),
      );
      // Deliberately premature. Consent is mandatory and we have given none, so
      // this has to go nowhere — being the host is permission to start the room
      // once it agrees, not permission to agree on its behalf. The room is full of
      // bots at this point, which is the case that used to start a match by
      // itself, so the refusal is being asked for under the exact conditions that
      // were broken.
      send(encodeLobbyCmd(LOBBY_ACT.START));
      sentUnreadyStart = true;
      step = 'unreadyStart';
      return;

    case 'unreadyStart':
      // Now consent, and let the server tell us when it counts.
      send(encodeLobbyCmd(LOBBY_ACT.READY));
      step = 'askedReady';
      return;

    case 'askedReady':
      // Wait for `CAN_START` rather than assuming our Ready landed: it is the same
      // answer the Start request is about to be judged against, so waiting on it
      // means the run cannot press Start into a window where it would be refused
      // for a reason that has nothing to do with what is being tested.
      if ((m.flags & LF.CAN_START) === 0) return;
      send(encodeLobbyCmd(LOBBY_ACT.START));
      step = 'askedStart';
      return;

    case 'askedStart':
      if (m.countdown > sawCountdown) sawCountdown = m.countdown;
      return;
  }
}

sock.on('message', (raw: ArrayBuffer | Buffer) => {
  const bytes =
    raw instanceof ArrayBuffer
      ? new Uint8Array(raw)
      : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  if (bytes.length < 1) return;

  const r = new ByteReader(bytes);
  const tag = r.u8v();

  switch (tag) {
    case MSG.S_WELCOME:
      welcome = decodeWelcome(r);
      break;

    case MSG.S_SNAPSHOT: {
      const now = Date.now();
      if (!firstSnapshotAt) firstSnapshotAt = now;
      lastSnapshotAt = now;
      snapshots++;

      const s = decodeSnapshot(r);
      latest = s;
      if (s.ackSeq > bestAck) bestAck = s.ackSeq;
      if (snapshots === 1) baseline = { x: s.self.x, z: s.self.z };
      travelled = Math.max(travelled, Math.hypot(s.self.x - baseline.x, s.self.z - baseline.z));

      peakActors = Math.max(peakActors, s.actors.length);
      for (const a of s.actors) {
        const first = actorFirst.get(a.id);
        if (!first) actorFirst.set(a.id, { x: a.x, z: a.z });
        else if (Math.hypot(a.x - first.x, a.z - first.z) > 1.5) actorsThatMoved++;
      }
      for (const e of s.events) eventKinds.add(e.kind);
      break;
    }

    case MSG.S_ROSTER: {
      roster = decodeRoster(r);
      rosters++;
      // Latched rather than read at the end, because `beginMatch` clears every
      // ready flag — by the time the run finishes, the roster truthfully says
      // nobody is ready, and a check made there would look like the flag never
      // worked. The lobby screen draws its ready ticks from this bit, so it is
      // worth proving it reaches a client at all.
      if (roster.some((e) => e.id === (welcome?.id ?? -1) && (e.flags & RF.READY) !== 0)) {
        readyFlaggedInRoster = true;
      }
      break;
    }

    case MSG.S_MATCH: {
      match = decodeMatch(r);
      // Recorded per phase: the lobby's job is to hold the clock still, and the
      // match's is to run it, so one number cannot answer for both.
      if (step === 'live') {
        if (liveClockFirst < 0) liveClockFirst = match.timeLeft;
        liveClockLast = match.timeLeft;
      } else {
        if (lobbyClockFirst < 0) lobbyClockFirst = match.timeLeft;
        lobbyClockLast = match.timeLeft;
      }
      break;
    }

    case MSG.S_LOBBY: {
      const m = decodeLobby(r);
      lobbies++;
      if (!firstLobby) firstLobby = m;
      advance(m);
      break;
    }

    case MSG.S_PONG:
      pongs++;
      break;

    default:
      failures.push(`unknown message tag ${tag}`);
  }
});

sock.on('error', (err: Error) => {
  console.error(`\n  smoke: could not reach ${URL_WS} — is the server running? (\`npm start\`)`);
  console.error(`  ${err.message}\n`);
  process.exit(2);
});

sock.on('close', () => {
  if (ticker) clearInterval(ticker);
  report();
});

function report(): void {
  check(welcome !== null, 'the server sent a welcome');
  if (welcome) {
    check(welcome.id > 0, `the welcome names our player id (got ${welcome.id})`);
    check(welcome.tickRate === 60, `and the 60 Hz tick rate (got ${welcome.tickRate})`);
    check(welcome.mode === MODE.FFA, `and the mode we asked for (got ${welcome.mode})`);
    check(welcome.room === ROOM, `and the room we asked for (wanted ${ROOM}, got "${welcome.room}")`);
  }

  check(pongs > 0, 'a ping was answered');
  check(match !== null, 'match state arrived');
  if (match) check(match.limit > 0, `with a score limit (got ${match.limit})`);
  check(rosters > 0, 'a roster arrived');

  /* ── The lobby ─────────────────────────────────────────────────────────── */

  check(lobbies > 0, 'lobby state arrived');
  check(firstLobby !== null, 'the room told us what phase it was in');
  if (firstLobby) {
    check(firstLobby.phase === PHASE.LOBBY, 'a private room opens in its lobby, not mid-match');
    check((firstLobby.flags & LF.PARTY) !== 0, 'and knows it is a party');
    check((firstLobby.flags & LF.BOTS) === 0, 'with bot fill off until somebody asks for it');
    check(
      firstLobby.hostId === (welcome?.id ?? -1),
      `and the first one in is the host (host ${firstLobby.hostId}, us ${welcome?.id ?? -1})`,
    );
  }
  // The bug this whole phase exists to fix: an uninvited room full of strangers.
  check(soloRoster === 1, `nobody we did not invite was already here (roster had ${soloRoster})`);
  check(filledRoster > 1, `the host asking for bots filled the room (${filledRoster} players)`);
  check(botsInRoster > 0, `and the arrivals are marked as bots (${botsInRoster} of them)`);
  check(hostFlaggedInRoster, 'the roster marks us as the host');
  check(!countdownBeforeAsking, 'no countdown started without the host pressing Start');

  /* ── Consent ───────────────────────────────────────────────────────────────
     The room used to start on a bare host request, and to start itself outright
     once the ready count matched the human count — which is what "the match began
     the moment a bot joined" was from the inside. Both paths are gone, and this is
     the wiring that proves it end to end rather than in a headless room. */
  check(sentUnreadyStart, 'the run pressed Start before readying up');
  check(!countdownWhileUnready, 'and a Start sent without consent was refused');
  check(!canStartWhileUnready, 'the room never claimed it could start while we were unready');
  check(canStartOnceReady, 'and said so as soon as we readied up');
  check(readyFlaggedInRoster, 'the roster carried our ready flag');
  check(
    sawCountdown > 0 && sawCountdown <= LOBBY_COUNTDOWN_MS,
    `Start ran a countdown once the room agreed (peaked at ${sawCountdown} ms of ${LOBBY_COUNTDOWN_MS})`,
  );
  check(liveLobby !== null, 'and the countdown handed over to a live match');
  if (liveLobby) check(liveLobby.countdown === 0, 'which then reports no countdown left to run');

  // A lobby you can walk around in is the entire reason it is a phase rather than
  // a screen, so it is worth proving rather than asserting in a comment.
  check(lobbyTravelled > 3, `we could move while gathering (${lobbyTravelled.toFixed(1)} m)`);
  check(
    lobbyClockFirst >= 0 && Math.abs(lobbyClockLast - lobbyClockFirst) < 400,
    `the clock stood still in the lobby (${lobbyClockFirst} → ${lobbyClockLast} ms)`,
  );
  check(
    liveClockFirst > MATCH_TIME_MS - 1500,
    `the match began on a full clock (${liveClockFirst} of ${MATCH_TIME_MS} ms)`,
  );
  check(
    liveClockLast >= 0 && liveClockLast < liveClockFirst,
    `and then it ran (${liveClockFirst} → ${liveClockLast} ms)`,
  );

  /* ── The match ─────────────────────────────────────────────────────────── */

  const span = lastSnapshotAt - firstSnapshotAt;
  const expected = span / SNAPSHOT_MS;
  check(snapshots > 20, `snapshots streamed (${snapshots} over ${span} ms)`);
  check(
    snapshots > expected * 0.6,
    `at roughly the advertised rate (${snapshots}, expected about ${Math.round(expected)})`,
  );

  // The ack is what client prediction reconciles against; without it the client
  // would replay every input it had ever sent, forever.
  check(bestAck > 0, `the server acknowledged our input sequence (reached ${bestAck})`);
  check(bestAck <= seq, `and never acknowledged an input we had not sent (${bestAck} of ${seq})`);

  check(roster.length > 1, `the live match has a full room (roster ${roster.length})`);

  if (latest) {
    check(latest.self.health > 0, `we are alive (health ${latest.self.health})`);
    check(travelled > 3, `holding forward moved us (${travelled.toFixed(1)} m from the round start)`);
    check(latest.self.y > -5, `and we did not fall out of the map (y ${latest.self.y.toFixed(2)})`);
    check(
      latest.self.magAmmo < 30 || latest.self.reloadLeft > 0,
      `firing consumed ammunition (mag ${latest.self.magAmmo}, reloading ${latest.self.reloadLeft.toFixed(2)}s)`,
    );
  }

  check(peakActors > 0, `other actors share the room (peak ${peakActors})`);
  check(actorsThatMoved > 0, `and at least one of them moved (${actorsThatMoved} observations)`);

  check(eventKinds.size > 0, `events were broadcast (kinds ${[...eventKinds].join(', ') || 'none'})`);

  const total = passed + failures.length;
  if (failures.length === 0) {
    console.log(`\n  smoke: ${total} checks passed against a live server (room ${ROOM}).\n`);
    process.exit(0);
  }
  console.error(`\n  smoke: ${passed} of ${total} passed, ${failures.length} failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('');
  process.exit(1);
}

/**
 * Never hang.
 *
 * The budget is the whole run — gathering, the countdown the server chose, and the
 * play window — plus enough slack that a slow machine is not reported as a broken
 * one. If a step never lands, this is what says so.
 */
setTimeout(
  () => {
    console.error(`\n  smoke: timed out at step "${step}" with no response from ${URL_WS}`);
    console.error(`  ${lobbies} lobby packets, ${rosters} rosters, ${snapshots} snapshots\n`);
    process.exit(2);
  },
  LOBBY_COUNTDOWN_MS + PLAY_MS + 15000,
).unref();
