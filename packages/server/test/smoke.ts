/**
 * Live smoke test: connects to a running server over a real WebSocket and plays
 * for a few seconds.
 *
 * `npm test` proves the simulation and the codec are correct in isolation. This
 * proves the pieces are actually wired together — that a join is accepted, that
 * snapshots arrive at the advertised rate, that held inputs move the player the
 * server says we own, that other actors are alive and moving, and that firing
 * produces events. Those are integration failures no unit test can see, because
 * every piece can be individually correct while the transport, the room loop or
 * the tick order is wrong.
 *
 * Start the server first (`npm start`), then `npm run smoke`.
 */

import { WebSocket } from 'ws';
import {
  BTN,
  ByteReader,
  MODE,
  MSG,
  SNAPSHOT_MS,
  decodeMatch,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  encodeInputBatch,
  encodeJoin,
  encodePing,
  newInputCmd,
  type InputCmd,
  type MatchMsg,
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
const PLAY_MS = 3500;

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
let rosterSize = 0;
let latest: Snapshot | null = null;
let bestAck = 0;
let peakActors = 0;
let firstSnapshotAt = 0;
let lastSnapshotAt = 0;
let travelled = 0;
let startPos = { x: 0, z: 0 };
/** First seen position per actor, so we can tell whether anyone else moved. */
const actorFirst = new Map<number, { x: number; z: number }>();
let actorsThatMoved = 0;
const eventKinds = new Set<number>();

// The HTTP surface is checked first, on a server known to be up, so that a
// crash there is reported as a crash rather than as a socket that would not open.
await httpChecks();

const sock = new WebSocket(URL_WS);
sock.binaryType = 'arraybuffer';

const cmds: InputCmd[] = [];
let seq = 1;
let ticker: ReturnType<typeof setInterval> | null = null;

sock.on('open', () => {
  sock.send(encodeJoin({ name: 'smoke', primary: 'ranger', mode: MODE.FFA, room: 'smoke' }), {
    binary: true,
  });
  sock.send(encodePing(Date.now() >>> 0), { binary: true });

  const startedAt = Date.now();
  ticker = setInterval(() => {
    const elapsed = Date.now() - startedAt;
    const cmd = newInputCmd();
    cmd.seq = seq++;
    cmd.forward = 1;
    cmd.right = elapsed > PLAY_MS / 3 ? 1 : 0;
    cmd.yaw = Math.sin(elapsed / 900) * 0.8;
    cmd.pitch = 0;
    // Start shooting halfway through, so the run covers an idle and a firing phase.
    cmd.buttons = elapsed > PLAY_MS / 2 ? BTN.FIRE : 0;
    cmds.push(cmd);
    // The same redundant eight-command window the real client sends.
    sock.send(encodeInputBatch(cmds, Math.max(0, cmds.length - 8)), { binary: true });
  }, 1000 / 60);

  setTimeout(() => sock.close(1000, 'done'), PLAY_MS);
});

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
      if (snapshots === 1) startPos = { x: s.self.x, z: s.self.z };
      travelled = Math.max(travelled, Math.hypot(s.self.x - startPos.x, s.self.z - startPos.z));

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
      rosterSize = decodeRoster(r).length;
      rosters++;
      break;
    }

    case MSG.S_MATCH:
      match = decodeMatch(r);
      break;

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
    check(welcome.room.length > 0, `and the room we landed in (got "${welcome.room}")`);
  }

  check(pongs > 0, 'a ping was answered');
  check(match !== null, 'match state arrived');
  if (match) check(match.limit > 0, `with a score limit (got ${match.limit})`);
  check(rosters > 0, 'a roster arrived');
  check(rosterSize > 1, `listing more than just us (got ${rosterSize})`);

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

  if (latest) {
    check(latest.self.health > 0, `we are alive (health ${latest.self.health})`);
    check(travelled > 3, `holding forward moved us (${travelled.toFixed(1)} m from spawn)`);
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
    console.log(`\n  smoke: ${total} checks passed against a live server.\n`);
    process.exit(0);
  }
  console.error(`\n  smoke: ${passed} of ${total} passed, ${failures.length} failed:\n`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error('');
  process.exit(1);
}

// Never hang: if the socket neither opens nor errors, fail loudly instead.
setTimeout(() => {
  console.error(`\n  smoke: timed out with no response from ${URL_WS}\n`);
  process.exit(2);
}, PLAY_MS + 8000).unref();
