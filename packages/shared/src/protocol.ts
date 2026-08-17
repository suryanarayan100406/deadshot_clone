/**
 * Wire protocol. Binary, little-effort-to-read but cheap to send.
 *
 * Direction is encoded in the first byte. Client→server messages are validated on
 * arrival: the server ignores any position the client claims and only ever accepts
 * intent (axes, buttons, view angles).
 */

import { ByteReader, ByteWriter } from './bitio';
import { BTN, type InputCmd } from './movement';

export const MSG = {
  // client → server
  C_JOIN: 1,
  C_INPUT: 2,
  C_PING: 3,
  C_SWITCH: 4,
  C_RESPAWN: 5,
  C_CHAT: 6,
  C_LOBBY: 7,
  // server → client
  S_WELCOME: 128,
  S_SNAPSHOT: 129,
  S_PONG: 130,
  S_ROSTER: 131,
  S_MATCH: 132,
  S_LOBBY: 133,
} as const;

/** Per-actor state flags packed into one byte. */
export const AF = {
  ON_GROUND: 1 << 0,
  CROUCH: 1 << 1,
  ADS: 1 << 2,
  DEAD: 1 << 3,
  FIRING: 1 << 4,
  RELOADING: 1 << 5,
  BOT: 1 << 6,
  SPAWN_PROTECTED: 1 << 7,
} as const;

export const EV = {
  SHOT: 1,
  IMPACT: 2,
  HIT_CONFIRM: 3,
  DAMAGED: 4,
  KILL: 5,
  RELOAD: 6,
  SPAWN: 7,
  DEATH: 8,
  CHAT: 9,
} as const;

/**
 * Per-entry roster flags.
 *
 * Named rather than written as `1 | 2` at the two ends, because the roster is the
 * one packet whose bits are read by the scoreboard, the nameplates *and* the
 * lobby panel — three readers is two too many to be relying on everybody
 * remembering which bit meant "bot".
 */
export const RF = {
  BOT: 1 << 0,
  DEAD: 1 << 1,
  READY: 1 << 2,
  HOST: 1 << 3,
} as const;

/**
 * Room phase.
 *
 * `LOBBY` is the state a private room opens in: everybody is on the map and can
 * move and shoot, but the clock is stopped and the score is wiped when the match
 * actually begins, so nothing that happens in it counts. It exists because a
 * party is a group of people arriving at slightly different times, and dropping
 * the first one straight into a scored match means the round is already lopsided
 * by the time the last one loads.
 *
 * Public rooms never sit in `LOBBY` — pressing Play there means "put me in a
 * game now", and a waiting room would be a worse answer to that than the match
 * already in progress.
 */
export const PHASE = {
  LOBBY: 0,
  LIVE: 1,
  OVER: 2,
} as const;

/** Room-level lobby flags. */
export const LF = {
  /** Bots are allowed to fill this room. */
  BOTS: 1 << 0,
  /** The room was asked for by name, i.e. it is a party. */
  PARTY: 1 << 1,
} as const;

/** What a client is asking the lobby to do. */
export const LOBBY_ACT = {
  /** Host: begin the countdown (or cancel it if one is running). */
  START: 1,
  /** Host: turn bot fill on or off. `value` is 0 or 1. */
  BOTS: 2,
  /** Anyone: flip their own ready state. */
  READY: 3,
} as const;

// ── Client → Server ──────────────────────────────────────────────────────────

export interface JoinMsg {
  name: string;
  primary: string;
  mode: number;
  room: string;
}

export function encodeJoin(m: JoinMsg): Uint8Array {
  const w = new ByteWriter(128);
  w.u8v(MSG.C_JOIN).str(m.name).str(m.primary).u8v(m.mode).str(m.room);
  return w.take();
}

export function decodeJoin(r: ByteReader): JoinMsg {
  return { name: r.str(), primary: r.str(), mode: r.u8v(), room: r.str() };
}

/* ── Party codes ──────────────────────────────────────────────────────────────
   `JoinMsg.room` is a party: empty means "any lobby with space", anything else
   is a private room that everyone typing the same characters lands in. That
   makes the code a *key*, shared between a client that generates it and a server
   that indexes rooms by it — so the alphabet and the canonical form live here,
   in the one package both ends already depend on.

   They were briefly a copy each. Two identical string literals that have to
   agree forever is the setup for the worst class of bug in this feature: a code
   the menu happily produces, silently mangled into a different room name by the
   server, so a party splits in half with nothing on screen to explain why.
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Alphabet for party codes.
 *
 * `I`, `O`, `0` and `1` are absent, and that omission is the entire design of
 * this string. A code's job is to survive being read aloud and typed in by
 * somebody else, so the two pairs that are indistinguishable in most faces
 * simply cannot occur. A code that has to be spelled out twice has failed at the
 * only thing it does.
 */
export const PARTY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/**
 * Length of a generated code. Five characters of a 32-symbol alphabet is about
 * 33 million codes — collision is not the risk worth optimising against, being
 * annoying to say out loud is.
 */
export const PARTY_CODE_LEN = 5;

/**
 * Longest code the server will key a room by. Typed codes are allowed to be
 * longer than generated ones, because people invent their own; bounded because
 * the result becomes a map key and is echoed to every other player in the room.
 */
export const PARTY_CODE_MAX = 12;

/**
 * Reduce whatever was typed to something a room name can safely be.
 *
 * The server calls this on arrival regardless of what the client did, because
 * the client is only ever "whatever connected to the socket" — and the client
 * calls it while typing so that what you see is what you joined.
 *
 * Uppercased, so `foxtrot` and `FOXTROT` are one party rather than two: case
 * sensitivity here would split a group over a caps-lock key. Characters outside
 * the alphabet are dropped rather than replaced, so a code arriving with padding
 * or punctuation around it — `  FX7-2K  ` — still reaches the party.
 *
 * It is not a code *extractor*, though: surrounding words keep their letters, so
 * `code: FX7-2K` canonicalises to `CDEFX72K` and is a different room. Paste the
 * code, not the sentence it came in.
 */
export function sanitizePartyCode(raw: string): string {
  let out = '';
  for (const ch of raw.toUpperCase()) {
    if (PARTY_CODE_ALPHABET.includes(ch)) out += ch;
    if (out.length >= PARTY_CODE_MAX) break;
  }
  return out;
}

/**
 * A fresh code.
 *
 * `rand` is injectable so the suite can draw deterministically — the property
 * worth asserting is that every code this produces survives
 * `sanitizePartyCode` unchanged, and a test of that should not depend on luck.
 */
export function randomPartyCode(rand: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < PARTY_CODE_LEN; i++) {
    // Modulo as well as floor: an rng that can return exactly 1 would otherwise
    // index off the end and append the string "undefined".
    const at = Math.floor(rand() * PARTY_CODE_ALPHABET.length) % PARTY_CODE_ALPHABET.length;
    out += PARTY_CODE_ALPHABET[at]!;
  }
  return out;
}

/**
 * Inputs are sent in small redundant batches: the newest command plus up to a few
 * previous ones. A dropped UDP-ish packet then costs nothing, because the next
 * packet re-delivers the commands the server has not acked.
 */
export function encodeInputBatch(cmds: readonly InputCmd[], from: number): Uint8Array {
  const n = Math.min(cmds.length - from, 8);
  const w = new ByteWriter(16 + n * 12);
  w.u8v(MSG.C_INPUT).u8v(n);
  for (let i = 0; i < n; i++) {
    const c = cmds[from + i]!;
    w.u32v(c.seq);
    // axes as signed bytes: 1/127 of a unit is far finer than a keyboard needs
    w.i8v(Math.round(c.forward * 127));
    w.i8v(Math.round(c.right * 127));
    w.u8v(c.buttons);
    w.angle16(c.yaw);
    w.pitch16(c.pitch);
  }
  return w.take();
}

export function decodeInputBatch(r: ByteReader, out: InputCmd[]): number {
  const n = r.u8v();
  for (let i = 0; i < n; i++) {
    const seq = r.u32v();
    const forward = r.i8v() / 127;
    const right = r.i8v() / 127;
    const buttons = r.u8v();
    const yaw = r.angle16();
    const pitch = r.pitch16();
    out.push({
      seq,
      // clamp: a hacked client cannot ask for more than full-stick input
      forward: forward < -1 ? -1 : forward > 1 ? 1 : forward,
      right: right < -1 ? -1 : right > 1 ? 1 : right,
      buttons: buttons & 0x3f,
      yaw,
      pitch,
    });
  }
  return n;
}

export function encodePing(clientTime: number): Uint8Array {
  const w = new ByteWriter(8);
  w.u8v(MSG.C_PING).u32v(clientTime >>> 0);
  return w.take();
}

export function encodeSwitch(slot: number): Uint8Array {
  const w = new ByteWriter(4);
  w.u8v(MSG.C_SWITCH).u8v(slot);
  return w.take();
}

export function encodeRespawn(): Uint8Array {
  const w = new ByteWriter(2);
  w.u8v(MSG.C_RESPAWN);
  return w.take();
}

export function encodeChat(text: string): Uint8Array {
  const w = new ByteWriter(160);
  w.u8v(MSG.C_CHAT).str(text.slice(0, 120));
  return w.take();
}

/**
 * A lobby request: one of `LOBBY_ACT`, plus a value for the ones that carry one.
 *
 * Authority stays entirely on the server — this says what the player *asked* for,
 * and the room decides whether they are allowed to (only the host may start a
 * match or turn bots on) and whether it makes sense in the current phase. A
 * client that sends `START` mid-match is not an error to report, just nothing.
 */
export function encodeLobbyCmd(action: number, value = 0): Uint8Array {
  const w = new ByteWriter(4);
  w.u8v(MSG.C_LOBBY).u8v(action).u8v(value);
  return w.take();
}

export function decodeLobbyCmd(r: ByteReader): { action: number; value: number } {
  return { action: r.u8v(), value: r.u8v() };
}

// ── Server → Client ──────────────────────────────────────────────────────────

export interface WelcomeMsg {
  id: number;
  mapId: number;
  mode: number;
  tickRate: number;
  serverTime: number;
  room: string;
}

export function encodeWelcome(m: WelcomeMsg): Uint8Array {
  const w = new ByteWriter(64);
  w.u8v(MSG.S_WELCOME)
    .u16v(m.id)
    .u8v(m.mapId)
    .u8v(m.mode)
    .u8v(m.tickRate)
    .u32v(m.serverTime >>> 0)
    .str(m.room);
  return w.take();
}

export function decodeWelcome(r: ByteReader): WelcomeMsg {
  return {
    id: r.u16v(),
    mapId: r.u8v(),
    mode: r.u8v(),
    tickRate: r.u8v(),
    serverTime: r.u32v(),
    room: r.str(),
  };
}

export interface ActorState {
  id: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  flags: number;
  health: number;
  weapon: number;
  team: number;
  /** Horizontal speed, sent so the client can drive walk animation without deriving it. */
  speed: number;
}

export interface SelfState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  flags: number;
  health: number;
  weapon: number;
  magAmmo: number;
  reserveAmmo: number;
  /** Seconds left of an in-progress reload, 0 if not reloading. */
  reloadLeft: number;
  kills: number;
  deaths: number;
  streak: number;
  respawnIn: number;
}

export interface GameEvent {
  kind: number;
  a?: number;
  b?: number;
  c?: number;
  x?: number;
  y?: number;
  z?: number;
  nx?: number;
  ny?: number;
  nz?: number;
  text?: string;
  flag?: number;
}

export interface Snapshot {
  serverTime: number;
  ackSeq: number;
  self: SelfState;
  actors: ActorState[];
  events: GameEvent[];
}

export function encodeSnapshot(
  w: ByteWriter,
  serverTime: number,
  ackSeq: number,
  self: SelfState,
  actors: readonly ActorState[],
  events: readonly GameEvent[],
): Uint8Array {
  w.reset();
  w.u8v(MSG.S_SNAPSHOT).u32v(serverTime >>> 0).u32v(ackSeq >>> 0);

  w.f32v(self.x).f32v(self.y).f32v(self.z);
  w.f32v(self.vx).f32v(self.vy).f32v(self.vz);
  w.u8v(self.flags)
    .u8v(Math.max(0, Math.round(self.health)))
    .u8v(self.weapon)
    .u16v(self.magAmmo)
    .u16v(self.reserveAmmo)
    .u16v(Math.round(self.reloadLeft * 1000))
    .u16v(self.kills)
    .u16v(self.deaths)
    .u8v(Math.min(255, self.streak))
    .u16v(Math.round(self.respawnIn * 1000));

  w.u8v(actors.length);
  for (const a of actors) {
    w.u16v(a.id)
      .f32v(a.x)
      .f32v(a.y)
      .f32v(a.z)
      .angle16(a.yaw)
      .pitch16(a.pitch)
      .u8v(a.flags)
      .u8v(Math.max(0, Math.round(a.health)))
      .u8v(a.weapon)
      .u8v(a.team)
      .u8v(Math.min(255, Math.round(a.speed * 10)));
  }

  w.u8v(Math.min(255, events.length));
  for (let i = 0; i < events.length && i < 255; i++) {
    const e = events[i]!;
    w.u8v(e.kind);
    switch (e.kind) {
      case EV.SHOT:
        w.u16v(e.a ?? 0)
          .u8v(e.b ?? 0)
          .f32v(e.x ?? 0)
          .f32v(e.y ?? 0)
          .f32v(e.z ?? 0)
          .f32v(e.nx ?? 0)
          .f32v(e.ny ?? 0)
          .f32v(e.nz ?? 0);
        break;
      case EV.IMPACT:
        w.f32v(e.x ?? 0)
          .f32v(e.y ?? 0)
          .f32v(e.z ?? 0)
          .i8v(Math.round(e.nx ?? 0))
          .i8v(Math.round(e.ny ?? 0))
          .i8v(Math.round(e.nz ?? 0))
          .u8v(e.flag ?? 0);
        break;
      case EV.HIT_CONFIRM:
        w.u16v(e.a ?? 0).u16v(e.b ?? 0).u8v(e.flag ?? 0);
        break;
      case EV.DAMAGED:
        w.u16v(e.a ?? 0).u16v(e.b ?? 0).angle16(e.x ?? 0);
        break;
      case EV.KILL:
        w.u16v(e.a ?? 0).u16v(e.b ?? 0).u8v(e.c ?? 0).u8v(e.flag ?? 0);
        break;
      case EV.RELOAD:
      case EV.SPAWN:
      case EV.DEATH:
        w.u16v(e.a ?? 0);
        break;
      case EV.CHAT:
        w.u16v(e.a ?? 0).str(e.text ?? '');
        break;
    }
  }
  return w.take();
}

export function decodeSnapshot(r: ByteReader): Snapshot {
  const serverTime = r.u32v();
  const ackSeq = r.u32v();

  const self: SelfState = {
    x: r.f32v(),
    y: r.f32v(),
    z: r.f32v(),
    vx: r.f32v(),
    vy: r.f32v(),
    vz: r.f32v(),
    flags: r.u8v(),
    health: r.u8v(),
    weapon: r.u8v(),
    magAmmo: r.u16v(),
    reserveAmmo: r.u16v(),
    reloadLeft: r.u16v() / 1000,
    kills: r.u16v(),
    deaths: r.u16v(),
    streak: r.u8v(),
    respawnIn: r.u16v() / 1000,
  };

  const actorCount = r.u8v();
  const actors: ActorState[] = new Array(actorCount);
  for (let i = 0; i < actorCount; i++) {
    actors[i] = {
      id: r.u16v(),
      x: r.f32v(),
      y: r.f32v(),
      z: r.f32v(),
      yaw: r.angle16(),
      pitch: r.pitch16(),
      flags: r.u8v(),
      health: r.u8v(),
      weapon: r.u8v(),
      team: r.u8v(),
      speed: r.u8v() / 10,
    };
  }

  const eventCount = r.u8v();
  const events: GameEvent[] = [];
  for (let i = 0; i < eventCount; i++) {
    const kind = r.u8v();
    switch (kind) {
      case EV.SHOT:
        events.push({
          kind,
          a: r.u16v(),
          b: r.u8v(),
          x: r.f32v(),
          y: r.f32v(),
          z: r.f32v(),
          nx: r.f32v(),
          ny: r.f32v(),
          nz: r.f32v(),
        });
        break;
      case EV.IMPACT:
        events.push({
          kind,
          x: r.f32v(),
          y: r.f32v(),
          z: r.f32v(),
          nx: r.i8v(),
          ny: r.i8v(),
          nz: r.i8v(),
          flag: r.u8v(),
        });
        break;
      case EV.HIT_CONFIRM:
        events.push({ kind, a: r.u16v(), b: r.u16v(), flag: r.u8v() });
        break;
      case EV.DAMAGED:
        events.push({ kind, a: r.u16v(), b: r.u16v(), x: r.angle16() });
        break;
      case EV.KILL:
        events.push({ kind, a: r.u16v(), b: r.u16v(), c: r.u8v(), flag: r.u8v() });
        break;
      case EV.RELOAD:
      case EV.SPAWN:
      case EV.DEATH:
        events.push({ kind, a: r.u16v() });
        break;
      case EV.CHAT:
        events.push({ kind, a: r.u16v(), text: r.str() });
        break;
      default:
        // Unknown event: the rest of the buffer is no longer parseable.
        return { serverTime, ackSeq, self, actors, events };
    }
  }

  return { serverTime, ackSeq, self, actors, events };
}

export interface RosterEntry {
  id: number;
  name: string;
  team: number;
  kills: number;
  deaths: number;
  ping: number;
  flags: number;
}

export function encodeRoster(entries: readonly RosterEntry[]): Uint8Array {
  const w = new ByteWriter(64 + entries.length * 40);
  w.u8v(MSG.S_ROSTER).u8v(entries.length);
  for (const e of entries) {
    w.u16v(e.id)
      .str(e.name)
      .u8v(e.team)
      .u16v(e.kills)
      .u16v(e.deaths)
      .u16v(Math.min(65535, e.ping))
      .u8v(e.flags);
  }
  return w.take();
}

export function decodeRoster(r: ByteReader): RosterEntry[] {
  const n = r.u8v();
  const out: RosterEntry[] = new Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = {
      id: r.u16v(),
      name: r.str(),
      team: r.u8v(),
      kills: r.u16v(),
      deaths: r.u16v(),
      ping: r.u16v(),
      flags: r.u8v(),
    };
  }
  return out;
}

export interface MatchMsg {
  timeLeft: number;
  scoreA: number;
  scoreB: number;
  limit: number;
  over: number;
  playersOnline: number;
}

export function encodeMatch(m: MatchMsg): Uint8Array {
  const w = new ByteWriter(24);
  w.u8v(MSG.S_MATCH)
    .u32v(Math.max(0, Math.round(m.timeLeft)))
    .u16v(m.scoreA)
    .u16v(m.scoreB)
    .u16v(m.limit)
    .u8v(m.over)
    .u16v(m.playersOnline);
  return w.take();
}

export function decodeMatch(r: ByteReader): MatchMsg {
  return {
    timeLeft: r.u32v(),
    scoreA: r.u16v(),
    scoreB: r.u16v(),
    limit: r.u16v(),
    over: r.u8v(),
    playersOnline: r.u16v(),
  };
}

export function encodePong(clientTime: number, serverTime: number): Uint8Array {
  const w = new ByteWriter(12);
  w.u8v(MSG.S_PONG).u32v(clientTime >>> 0).u32v(serverTime >>> 0);
  return w.take();
}

/**
 * Lobby state.
 *
 * Sent on every change and then on a slow heartbeat, because it is the packet
 * that decides whether the player is looking at a lobby panel or a match — a
 * dropped one would leave them staring at a Start button in a game that has
 * already begun.
 *
 * Deliberately *not* folded into `MatchMsg`, which every client gets twice a
 * second in every room: the great majority of rooms are public and never leave
 * `LIVE`, so this is four bytes they would carry forever to describe a state they
 * cannot be in.
 */
export interface LobbyMsg {
  /** One of `PHASE`. */
  phase: number;
  /** Actor id of the host, or 0 if the room has no humans in it. */
  hostId: number;
  /** Bitmask of `LF`. */
  flags: number;
  /** Milliseconds until the match starts, or 0 when no countdown is running. */
  countdown: number;
}

export function encodeLobby(m: LobbyMsg): Uint8Array {
  const w = new ByteWriter(12);
  w.u8v(MSG.S_LOBBY)
    .u8v(m.phase)
    .u16v(m.hostId)
    .u8v(m.flags)
    .u16v(Math.max(0, Math.min(65535, Math.round(m.countdown))));
  return w.take();
}

export function decodeLobby(r: ByteReader): LobbyMsg {
  return { phase: r.u8v(), hostId: r.u16v(), flags: r.u8v(), countdown: r.u16v() };
}

export { BTN };
