/**
 * Server entry point.
 *
 * One HTTP server does three jobs:
 *   - upgrades WebSocket connections into the game
 *   - answers `/api/status` for the menu's player counter
 *   - serves `packages/client/dist` in production so the whole thing runs from
 *     `npm start` with no separate web server
 *
 * The simulation is one `setInterval` at 60 Hz driving every room. Rooms are cheap
 * (a few maps' worth of AABBs, shared and memoised) so a single Node process happily
 * runs a dozen of them.
 */

import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';

import {
  ByteReader,
  CLIENT_TIMEOUT_MS,
  FULL_NAME,
  MODE,
  MSG,
  TICK_MS,
  decodeInputBatch,
  decodeJoin,
  decodeLobbyCmd,
  encodePong,
  sanitizePartyCode,
  type InputCmd,
} from '@oneshot/shared';

import { Lobby } from './matchmaking.js';
import { ServerPlayer } from './player.js';
import type { Room } from './room.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const here = fileURLToPath(new URL('.', import.meta.url));
const CLIENT_DIST = resolve(here, '../../client/dist');

// ── Rooms ────────────────────────────────────────────────────────────────────
// Selection lives in `matchmaking.ts` rather than here, because this file listens
// on a socket and starts the tick the moment it is imported — which makes every
// decision in it unreachable from a test as long as it stays in it.

const lobby = new Lobby();
const rooms = lobby.rooms;

// ── Connections ──────────────────────────────────────────────────────────────

interface Conn {
  socket: WebSocket;
  player: ServerPlayer | null;
  room: Room | null;
  /** Rate-limit guard: messages seen since the last check. */
  msgs: number;
  windowAt: number;
}

const conns = new Map<WebSocket, Conn>();
const inputScratch: InputCmd[] = [];

function sanitizeName(raw: string): string {
  let out = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || c === 0x7f) continue;
    out += ch;
  }
  out = out.trim().slice(0, 16);
  return out || 'Player';
}

function onMessage(conn: Conn, data: Uint8Array, now: number): void {
  // Cheap flood guard: 60 Hz input plus pings is ~70 msg/s; 240 is generous.
  if (now - conn.windowAt > 1000) {
    conn.windowAt = now;
    conn.msgs = 0;
  }
  if (++conn.msgs > 240) return;

  if (data.length < 1) return;
  const r = new ByteReader(data);
  const kind = r.u8v();

  switch (kind) {
    case MSG.C_JOIN: {
      if (conn.player) return;
      const join = decodeJoin(r);
      const mode = join.mode === MODE.TDM ? MODE.TDM : MODE.FFA;
      // Canonicalised on arrival regardless of what the client already did, because
      // the client is whatever connected to the socket. Worth noting what this also
      // rules out: `-` and lowercase are both stripped, so a code arriving from a
      // client can never collide with a server-generated `lobby-N` key. A stranger
      // cannot name their way into the public rotation.
      const room = lobby.findRoom(mode, sanitizePartyCode(join.room), now);
      if (room.isFull) {
        conn.socket.close(4001, 'room full');
        return;
      }
      const player = new ServerPlayer(sanitizeName(join.name), false, conn.socket, join.primary);
      player.lastPacketAt = now;
      conn.player = player;
      conn.room = room;
      room.add(player, now);
      console.log(`[join] ${player.name} #${player.id} -> ${room.id} (${room.players.size} in room)`);
      return;
    }

    case MSG.C_INPUT: {
      const p = conn.player;
      const room = conn.room;
      if (!p || !room) return;
      p.lastPacketAt = now;
      inputScratch.length = 0;
      decodeInputBatch(r, inputScratch);
      room.pushInputs(p, inputScratch);
      return;
    }

    case MSG.C_PING: {
      const p = conn.player;
      const clientTime = r.u32v();
      if (p) p.lastPacketAt = now;
      try {
        conn.socket.send(encodePong(clientTime, now >>> 0), { binary: true });
      } catch {
        /* closing */
      }
      return;
    }

    case MSG.C_SWITCH: {
      const p = conn.player;
      if (!p || !conn.room) return;
      p.lastPacketAt = now;
      conn.room.requestSwitch(p, r.u8v(), now);
      return;
    }

    case MSG.C_RESPAWN: {
      const p = conn.player;
      if (!p || !conn.room) return;
      p.lastPacketAt = now;
      conn.room.requestRespawn(p, now);
      return;
    }

    case MSG.C_CHAT: {
      const p = conn.player;
      if (!p || !conn.room) return;
      p.lastPacketAt = now;
      conn.room.pushChat(p, r.str());
      return;
    }

    case MSG.C_LOBBY: {
      const p = conn.player;
      if (!p || !conn.room) return;
      p.lastPacketAt = now;
      const cmd = decodeLobbyCmd(r);
      conn.room.lobbyAction(p, cmd.action, cmd.value, now);
      return;
    }

    default:
      return;
  }
}

function dropConn(conn: Conn): void {
  conns.delete(conn.socket);
  if (conn.player && conn.room) {
    console.log(`[left] ${conn.player.name} #${conn.player.id} <- ${conn.room.id}`);
    conn.room.remove(conn.player.id);
  }
  conn.player = null;
  conn.room = null;
}

// ── Round-trip time ──────────────────────────────────────────────────────────
// `ws` gives us pong latency for free, which is a better ping estimate than
// anything derived from game packets because it skips the simulation entirely.

function attachPing(conn: Conn): void {
  let sentAt = 0;
  const timer = setInterval(() => {
    if (conn.socket.readyState !== 1) return;
    sentAt = Date.now();
    try {
      conn.socket.ping();
    } catch {
      /* closing */
    }
  }, 1000);
  conn.socket.on('pong', () => {
    if (!conn.player || sentAt === 0) return;
    const rtt = Date.now() - sentAt;
    // Smoothed, so one bad sample cannot swing lag compensation.
    conn.player.ping = conn.player.ping === 0 ? rtt : conn.player.ping * 0.7 + rtt * 0.3;
  });
  conn.socket.on('close', () => clearInterval(timer));
}

// ── Static file serving ──────────────────────────────────────────────────────

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.webmanifest': 'application/manifest+json',
};

/**
 * Request entry point. Everything is wrapped, because this function runs
 * synchronously inside Node's HTTP parser: anything thrown here escapes as an
 * uncaught exception and ends the process — taking every room and every player
 * with it. A single malformed URL from a passing crawler must not be able to do
 * that, so the trust boundary gets a hard boundary in code too.
 */
function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  try {
    route(req, res);
  } catch (err) {
    console.warn(`[warn] request ${req.method} ${req.url} failed:`, (err as Error).message);
    try {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
      res.end('server error');
    } catch {
      /* Socket already gone. */
    }
  }
}

function route(req: IncomingMessage, res: ServerResponse): void {
  const url = (req.url ?? '/').split('?')[0];

  if (url === '/api/status') {
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(
      JSON.stringify({
        game: FULL_NAME,
        players: lobby.totalPlayers(),
        rooms: [...rooms.values()].map((r) => ({
          id: r.id,
          mode: r.mode,
          players: r.humanCount,
          bots: r.players.size - r.humanCount,
        })),
      }),
    );
    return;
  }

  if (!existsSync(CLIENT_DIST)) {
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(
      `${FULL_NAME} game server is running on ws://${HOST}:${PORT}.\n` +
        `No client build found at ${CLIENT_DIST} — run \`npm run dev\` for the dev server, ` +
        `or \`npm run build\` then \`npm start\` for production.\n`,
    );
    return;
  }

  // Reject anything that escapes the dist directory.
  //
  // `decodeURIComponent` throws URIError on a malformed escape such as `/%zz`.
  // Left unguarded that was a one-request remote kill of the whole server, so
  // the answer is an explicit 400 rather than a rescued 500.
  let decoded: string;
  try {
    decoded = decodeURIComponent(url);
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
    return;
  }
  // A NUL truncates paths inside some syscalls, and Node throws on it rather
  // than returning an error. Refuse it here where the refusal is deliberate.
  if (decoded.includes('\0')) {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request');
    return;
  }

  const rel = normalize(decoded).replace(/^([/\\])+/, '');
  if (rel.includes('..')) {
    res.writeHead(403).end('forbidden');
    return;
  }
  let file = join(CLIENT_DIST, rel);
  // Compared with a trailing separator: a bare `startsWith` would also accept a
  // sibling directory whose name merely begins with `dist`.
  if (file !== CLIENT_DIST && !file.startsWith(CLIENT_DIST + sep)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(CLIENT_DIST, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404).end('not found');
    return;
  }

  const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
  const cache = file.endsWith('index.html') ? 'no-cache' : 'public, max-age=31536000, immutable';
  res.writeHead(200, { 'content-type': type, 'cache-control': cache });
  const stream = createReadStream(file);
  // An unhandled 'error' here would also be fatal — `existsSync` above is a
  // check, not a lock, so the file can vanish before the open completes.
  stream.on('error', (err) => {
    console.warn(`[warn] could not stream ${file}:`, err.message);
    res.destroy();
  });
  stream.pipe(res);
}

// ── Boot ─────────────────────────────────────────────────────────────────────

const http = createServer(serveStatic);
const wss = new WebSocketServer({ server: http, path: '/ws', maxPayload: 4096 });

wss.on('connection', (socket) => {
  socket.binaryType = 'nodebuffer';
  const conn: Conn = { socket, player: null, room: null, msgs: 0, windowAt: Date.now() };
  conns.set(socket, conn);
  attachPing(conn);

  socket.on('message', (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const now = Date.now();
    try {
      if (Array.isArray(raw)) return;
      const bytes =
        raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
      onMessage(conn, bytes, now);
    } catch (err) {
      // A malformed packet is a client problem, never a server problem.
      console.warn('[warn] bad packet:', (err as Error).message);
    }
  });

  socket.on('close', () => dropConn(conn));
  socket.on('error', () => dropConn(conn));
});

let last = Date.now();
let accumulator = 0;

setInterval(() => {
  const now = Date.now();
  let frame = now - last;
  last = now;
  // A long stall (laptop lid, GC pause) must not be replayed as 400 ticks.
  if (frame > 250) frame = 250;
  accumulator += frame;

  let steps = 0;
  while (accumulator >= TICK_MS && steps < 8) {
    accumulator -= TICK_MS;
    steps++;
    // Per room, not per loop: this callback is the only thing driving the whole
    // server, so an exception escaping it would be uncaught and end the process.
    // Isolating each room means one bad room degrades alone instead of taking
    // every other match down with it.
    for (const room of rooms.values()) {
      try {
        room.step(now);
      } catch (err) {
        console.error(`[error] room ${room.id} step failed:`, err);
      }
    }
  }

  for (const room of rooms.values()) {
    try {
      room.flush(now);
    } catch (err) {
      console.error(`[error] room ${room.id} flush failed:`, err);
    }
  }

  // Timeouts and empty-room cleanup.
  for (const conn of conns.values()) {
    const p = conn.player;
    if (p && now - p.lastPacketAt > CLIENT_TIMEOUT_MS) {
      // Still inside the one interval that drives the whole server, so a socket
      // in an unexpected state must not be able to end the process.
      try {
        conn.socket.close(4002, 'timeout');
      } catch {
        /* Already closing. */
      }
      dropConn(conn);
    }
  }
  lobby.sweepEmpty();
}, TICK_MS);

http.listen(PORT, HOST, () => {
  console.log(`${FULL_NAME} server listening on http://${HOST}:${PORT} (ws path /ws)`);
  console.log(`  tick ${Math.round(1000 / TICK_MS)} Hz  ·  client dist: ${CLIENT_DIST}`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    console.log(`\n${sig} — shutting down`);
    for (const conn of conns.values()) conn.socket.close(1001, 'server shutdown');
    http.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500);
  });
}
