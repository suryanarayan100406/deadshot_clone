/**
 * Headless checks on the two server-side decisions a player actually feels:
 * which side of a team match they land on, and which room they land in.
 *
 * `npm test` covers the simulation and the codec, and `npm run smoke` proves a
 * live server is wired together — but neither can see this. The smoke test
 * connects one socket, and the entire point of a party is what happens to the
 * *second* one. Both failures here are silent at runtime: nothing throws, no
 * packet is malformed, the match simply is not the match anybody asked for.
 *
 * That is not hypothetical. Team assignment used to send friends to opposite
 * sides every single time, because balancing an empty room puts the first player
 * on a coin-flip side and the second on "whichever is emptier" — which is always
 * the other one. Playing with a friend was impossible by construction, and it
 * cost nothing at runtime to be that broken.
 *
 * Run with `npm run test:server` (or as part of `npm test`).
 */

import {
  LF,
  LOBBY_ACT,
  LOBBY_COUNTDOWN_MS,
  MAPS,
  MATCH_TIME_MS,
  MAX_PLAYERS,
  MODE,
  MSG,
  PHASE,
  RF,
  TARGET_LOBBY_SIZE,
  TEAM_A,
  TEAM_B,
  TEAM_NONE,
  ByteReader,
  decodeLobby,
  decodeMatch,
  decodeRoster,
} from '@oneshot/shared';
import type { WebSocket } from 'ws';

import { Lobby, hashName } from '../src/matchmaking.js';
import { ServerPlayer } from '../src/player.js';
import { Room } from '../src/room.js';

/* ── Harness ─────────────────────────────────────────────────────────────── */

let passed = 0;
const failures: string[] = [];
let currentSuite = '';

function suite(name: string, run: () => void): void {
  currentSuite = name;
  try {
    run();
  } catch (err) {
    failures.push(`${name}: threw ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  }
  currentSuite = '';
}

function check(ok: boolean, what: string): void {
  if (ok) {
    passed++;
    return;
  }
  failures.push(`${currentSuite ? `${currentSuite} — ` : ''}${what}`);
}

/* ── Fixtures ────────────────────────────────────────────────────────────── */

const NOW = 1_700_000_000_000;
const MAP_ID = MAPS[0]!.id;
/** Half the lobby: the point past which a party stops stacking and starts a match. */
const HALF = Math.floor(MAX_PLAYERS / 2);

function human(n: number): ServerPlayer {
  return new ServerPlayer(`Human${n}`, false, null, 'ranger');
}

function bot(n: number): ServerPlayer {
  return new ServerPlayer(`Bot${n}`, true, null, 'ranger');
}

/** Add `n` players and hand back what was added, so a test can inspect sides. */
function fill(room: Room, n: number, make: (i: number) => ServerPlayer): ServerPlayer[] {
  const added: ServerPlayer[] = [];
  for (let i = 0; i < n; i++) {
    const p = make(i);
    room.add(p, NOW);
    added.push(p);
  }
  return added;
}

/**
 * Ready everyone in the list up, whatever state they were already in.
 *
 * `LOBBY_ACT.READY` is a *toggle* — it is one button on screen — so sending it
 * blindly to a player who already agreed un-readies them instead. That is a
 * footgun in any test that readies, cancels and readies again, and it fails in
 * the most confusing possible way: the room refuses to start and the assertion
 * blames the consent gate.
 */
function readyUp(room: Room, players: readonly ServerPlayer[], now: number): void {
  for (const p of players) if (!p.ready) room.lobbyAction(p, LOBBY_ACT.READY, 0, now);
}

function count(room: Room, team: number, bots?: boolean): number {
  let n = 0;
  for (const p of room.players.values()) {
    if (bots !== undefined && p.isBot !== bots) continue;
    if (p.team === team) n++;
  }
  return n;
}

function botCount(room: Room): number {
  let n = 0;
  for (const p of room.players.values()) if (p.isBot) n++;
  return n;
}

/**
 * Mirrors `BOT_MANAGE_INTERVAL` in `room.ts`, which is module-private.
 *
 * Bots are added and retired on a periodic pass rather than the moment anything
 * changes, so a test that toggles the setting and looks immediately would see the
 * old room. Stepping a full interval is what a player waiting half a second does.
 */
const BOT_MANAGE_TICKS = 30;

function runBotPass(room: Room, now: number): void {
  const from = room.tick;
  while (room.tick - from < BOT_MANAGE_TICKS) room.step(now);
}

/** Captures what the room actually put on the wire, so flags can be decoded back. */
function fakeSocket(): { socket: WebSocket; last(tag: number): ByteReader | null } {
  const sent: Uint8Array[] = [];
  const socket = {
    readyState: 1,
    send(data: Uint8Array): void {
      sent.push(data);
    },
  } as unknown as WebSocket;
  return {
    socket,
    last(tag: number): ByteReader | null {
      for (let i = sent.length - 1; i >= 0; i--) {
        const bytes = sent[i]!;
        if (bytes[0] !== tag) continue;
        const r = new ByteReader(bytes);
        r.u8v(); // every decoder expects the reader positioned past the tag
        return r;
      }
      return null;
    },
  };
}

/* ── Team assignment ─────────────────────────────────────────────────────── */

suite('a party lands on one side', () => {
  // The regression test for the whole feature. Four friends, one code, one team.
  const room = new Room('FXTRT', MODE.TDM, MAP_ID, NOW, true);
  const friends = fill(room, 4, human);

  check(
    friends.every((p) => p.team === TEAM_A),
    `all four friends are on the same side (A: ${count(room, TEAM_A)}, B: ${count(room, TEAM_B)})`,
  );
  check(count(room, TEAM_B) === 0, 'and nobody was split off onto the other one');
});

suite('a party bigger than half the lobby becomes a match', () => {
  // The counterweight. Stacking is right up to the point where it leaves nobody
  // to play against, so past half the lobby the overflow has to cross over.
  const room = new Room('BIGONE', MODE.TDM, MAP_ID, NOW, true);
  fill(room, MAX_PLAYERS, human);

  check(count(room, TEAM_A) === HALF, `Alpha fills to half the lobby (${count(room, TEAM_A)} of ${HALF})`);
  check(count(room, TEAM_B) === MAX_PLAYERS - HALF, `and the rest cross to Bravo (${count(room, TEAM_B)})`);
  check(count(room, TEAM_A) > 0 && count(room, TEAM_B) > 0, 'so a full private lobby is a match, not a firing squad');
});

suite('a public lobby balances strangers', () => {
  // Party behaviour must not leak into the default path: people who did not
  // choose each other still want even sides.
  const room = new Room('lobby-1', MODE.TDM, MAP_ID, NOW);
  check(room.party === false, 'a room nobody asked for by name is not a party');

  fill(room, MAX_PLAYERS, human);
  const a = count(room, TEAM_A);
  const b = count(room, TEAM_B);
  check(Math.abs(a - b) <= 1, `sides stay even for strangers (${a} vs ${b})`);
});

suite('bots even out a party rather than ganging up on it', () => {
  // What gives a party a fair match. Humans stack on Alpha by design, so the fill
  // has to keep using plain balance — and the interesting consequence is that it
  // does not simply pile onto Bravo. Two friends in a six-player match get a bot
  // *teammate* and a 3v3, not a 2v4 against every bot in the room.
  const room = new Room('DUOS', MODE.TDM, MAP_ID, NOW, true);
  fill(room, 2, human);
  const bots = fill(room, 4, bot);

  check(count(room, TEAM_A, false) === 2, 'both humans are still together on Alpha');
  check(count(room, TEAM_B, false) === 0, 'and neither was split off onto Bravo');

  const a = count(room, TEAM_A);
  const b = count(room, TEAM_B);
  check(Math.abs(a - b) <= 1, `the sides come out even anyway (${a} vs ${b})`);
  check(b > 0, 'so the party has an opposition from the first round');
  check(
    count(room, TEAM_A, true) >= 1 && count(room, TEAM_B, true) >= 1,
    `and the fill spreads across both sides (${count(room, TEAM_A, true)} on A, ${count(room, TEAM_B, true)} on B of ${bots.length})`,
  );
});

suite('free-for-all has no sides at all', () => {
  // Guards the mode check in `add`. A team id leaking into FFA would turn on
  // friendly-fire rejection, and half the lobby would be unkillable.
  const room = new Room('SOLOS', MODE.FFA, MAP_ID, NOW, true);
  const everyone = [...fill(room, 4, human), ...fill(room, 2, bot)];

  check(
    everyone.every((p) => p.team === TEAM_NONE),
    `nobody has a team in FFA (${everyone.filter((p) => p.team !== TEAM_NONE).length} did)`,
  );
  check(room.party === true, 'even though the room itself is still a party');
});

/* ── Room selection ──────────────────────────────────────────────────────── */

suite('a party room is never handed to a stranger', () => {
  // The property a player would describe as "my private lobby filled up with
  // people I did not invite". Matching on free space alone does exactly that.
  const lobby = new Lobby();
  const party = lobby.findRoom(MODE.TDM, 'FXTRT', NOW);
  check(party.party === true, 'a room asked for by name is a party');
  check(party.id === 'FXTRT', 'and keeps the code as its name');

  const stranger = lobby.findRoom(MODE.TDM, '', NOW);
  check(stranger !== party, 'somebody pressing Play does not land in it');
  check(stranger.party === false, 'they get a public lobby instead');

  // ...and the same code goes back to the same party, which is the only reason
  // telling somebody a code works.
  check(lobby.findRoom(MODE.TDM, 'FXTRT', NOW) === party, 'the same code returns to the same room');
});

suite('a code names one room, whatever mode the joiner had selected', () => {
  // The bug behind "the map is different for both of us" and "I cannot see the
  // other person who joined". A party used to be keyed by mode *and* code, so two
  // friends typing the same five characters with different modes selected got two
  // rooms — each with its own independent `pickMap` draw. Both were told they had
  // joined FXTRT. They were on different levels, alone, with nothing in the
  // interface to explain it.
  //
  // A code identifies a room; the mode is a property of the room, decided by
  // whoever opened it. The joiner adopts it.
  const lobby = new Lobby();
  const opener = lobby.findRoom(MODE.TDM, 'FXTRT', NOW);
  const joiner = lobby.findRoom(MODE.FFA, 'FXTRT', NOW);

  check(joiner === opener, 'the same code in another mode is the same room');
  check(lobby.rooms.size === 1, `and only one room was ever opened (${lobby.rooms.size})`);
  check(joiner.map.id === opener.map.id, 'so both of them are on one map');
  check(
    joiner.mode === MODE.TDM,
    `and on the mode the room was opened with, not the one they asked for (got ${joiner.mode})`,
  );
});

suite('a full public lobby overflows into a new one', () => {
  // This path never ran until recently, because the client sent a hardcoded room
  // name — so every player in the world shared one twelve-slot lobby and the
  // thirteenth was refused the connection outright.
  const lobby = new Lobby();
  const first = lobby.findRoom(MODE.FFA, '', NOW);
  fill(first, MAX_PLAYERS, human);
  check(first.isFull, `the first lobby fills at ${MAX_PLAYERS} humans`);

  const second = lobby.findRoom(MODE.FFA, '', NOW);
  check(second !== first, 'the next player gets a second lobby rather than a closed socket');
  check(second.party === false, 'which is public, like the one it overflowed from');
  check(lobby.rooms.size >= 2, `so the server is holding both (${lobby.rooms.size} rooms)`);

  // Bots do not count against the cap — they are the fill, and they retire when
  // humans need the slots.
  const third = lobby.findRoom(MODE.FFA, '', NOW);
  check(third === second, 'and further joins keep landing in the room with space');
});

suite('a party code always means the same map', () => {
  // "Meet me on FOXTROT" has to name a level, not just a room, or the map is a
  // surprise every time the group reconvenes. Two independent lobbies stand in
  // for two separate server runs.
  const a = new Lobby().findRoom(MODE.TDM, 'FXTRT', NOW);
  const b = new Lobby().findRoom(MODE.TDM, 'FXTRT', NOW + 86_400_000);
  check(a.map.id === b.map.id, `the same code opens the same map (${a.map.name} / ${b.map.name})`);

  const other = new Lobby().findRoom(MODE.TDM, 'OTHER1', NOW);
  check(
    typeof other.map.id === 'number' && other.map.id >= 0,
    `and a different code still resolves to a real map (${other.map.name})`,
  );

  // The hash behind it: stable, and unsigned so the caller never handles a sign.
  check(hashName('FXTRT') === hashName('FXTRT'), 'the name hash is stable');
  check(hashName('FXTRT') !== hashName('FXTRU'), 'and separates codes one character apart');
  for (const s of ['', 'A', 'FXTRT', 'ZZZZZZZZZZZZ']) {
    check(hashName(s) >= 0 && Number.isInteger(hashName(s)), `hashName("${s}") is a non-negative integer`);
  }
});

suite('successive public lobbies rotate the map', () => {
  // Otherwise every player who ever presses Play sees the same level, which is
  // what four extra maps were built to stop.
  const lobby = new Lobby();
  const seen: number[] = [];
  for (let i = 0; i < 3; i++) {
    const r = lobby.findRoom(MODE.FFA, '', NOW);
    seen.push(r.map.id);
    fill(r, MAX_PLAYERS, human); // force the next join to open a fresh lobby
  }
  check(new Set(seen).size === seen.length, `three lobbies, three different maps (ids ${seen.join(', ')})`);
});

suite('empty rooms are retired but one is always kept', () => {
  const lobby = new Lobby();
  const keep = lobby.findRoom(MODE.FFA, '', NOW);
  lobby.findRoom(MODE.TDM, 'GHOST', NOW);
  lobby.findRoom(MODE.TDM, 'GHOST2', NOW);
  check(lobby.rooms.size === 3, 'three rooms exist');

  lobby.sweepEmpty();
  check(lobby.rooms.size === 1, `all but one empty room is retired (${lobby.rooms.size} left)`);

  // A populated room survives the sweep, which is the part that would be a
  // catastrophe to get wrong: it would delete matches out from under people.
  // Checked by identity rather than by key, so the sweep is what is under test
  // rather than the room-key format.
  const busy = lobby.findRoom(MODE.FFA, 'BUSY', NOW);
  fill(busy, 1, human);
  lobby.sweepEmpty();
  check([...lobby.rooms.values()].includes(busy), 'a room with a player in it is never swept');
  check(keep !== busy, 'and it is not the one that was kept by default');
});

suite('quick match puts people together rather than spreading them out', () => {
  // Pressing Quick Match means "find me a game", and the room selection used to
  // answer it with the *first* room that had space — so arrivals scattered across
  // every open lobby and a server with a dozen people on it felt like a server of
  // bots. Filling one room before opening another is what makes real opponents
  // likely, which is the entire request.
  const lobby = new Lobby();
  const rooms: Room[] = [];
  for (let i = 0; i < 3; i++) {
    const r = lobby.findRoom(MODE.FFA, '', NOW);
    rooms.push(r);
    // Fill it so the next call is forced to open a fresh one instead of returning
    // this one, then hand the slots back below.
    fill(r, MAX_PLAYERS, human);
  }
  const [quiet, middling, busiest] = rooms as [Room, Room, Room];
  for (const r of rooms) for (const id of [...r.players.keys()]) r.remove(id);

  fill(middling, 1, human);
  fill(busiest, 3, human);
  check(quiet.humanCount === 0 && middling.humanCount === 1 && busiest.humanCount === 3, 'three rooms, 0/1/3 humans');

  check(lobby.findRoom(MODE.FFA, '', NOW) === busiest, 'the next arrival joins the busiest one');

  // Bots only break a tie. Given the same number of real people, the room with
  // fewer of them is the one with more of a real game in it.
  fill(middling, 2, human);
  fill(middling, 4, bot);
  check(
    lobby.findRoom(MODE.FFA, '', NOW) === busiest,
    `and a tie on humans goes to the room with fewer bots (${busiest.botCount} vs ${middling.botCount})`,
  );
});

/* ── Lobby and bot consent ───────────────────────────────────────────────── */

suite('a private lobby starts empty of everyone who was not invited', () => {
  // The bug this exists for, in one assertion: a party used to fill to eight with
  // bots the instant the first player connected, and there was no way to decline.
  const room = new Room('FRENDS', MODE.TDM, MAP_ID, NOW, true);
  const [host] = fill(room, 1, human);
  runBotPass(room, NOW);

  check(botCount(room) === 0, `nobody uninvited joined (${botCount(room)} bots)`);
  check(room.botsEnabled === false, 'bots are off by default in a party');
  check(room.inLobby, 'and the room is gathering rather than playing');
  check(room.hostId === host!.id, 'the first player to arrive runs it');
});

suite('a public room still fills itself and is already in progress', () => {
  // The other half of the default. Pressing Play means "a game, now" — a waiting
  // room and an empty map would both be worse answers than bots.
  const room = new Room('lobby-9', MODE.FFA, MAP_ID, NOW);
  fill(room, 1, human);
  runBotPass(room, NOW);

  check(room.inLobby === false, 'a public room does not gather first');
  check(room.botsEnabled === true, 'and fills itself by default');
  check(
    botCount(room) === TARGET_LOBBY_SIZE - 1,
    `topped up to ${TARGET_LOBBY_SIZE} players (${botCount(room)} bots for 1 human)`,
  );
});

suite('bots are the host’s decision, and only the host’s', () => {
  const room = new Room('DUOS2', MODE.TDM, MAP_ID, NOW, true);
  const [host, guest] = fill(room, 2, human);

  room.lobbyAction(guest!, LOBBY_ACT.BOTS, 1, NOW);
  check(room.botsEnabled === false, 'a guest asking for bots is ignored');

  room.lobbyAction(host!, LOBBY_ACT.BOTS, 1, NOW);
  check(room.botsEnabled === true, 'the host can turn them on');
  runBotPass(room, NOW);
  check(botCount(room) > 0, `and they arrive (${botCount(room)} bots)`);

  room.lobbyAction(host!, LOBBY_ACT.BOTS, 0, NOW);
  runBotPass(room, NOW + 1000);
  check(botCount(room) === 0, `turning them off clears the room again (${botCount(room)} left)`);
  check(room.humanCount === 2, 'without taking the humans with them');
});

suite('the host role is never left vacant', () => {
  const room = new Room('HOSTS', MODE.FFA, MAP_ID, NOW, true);
  const [first, second] = fill(room, 2, human);
  check(room.hostId === first!.id, 'the earliest join hosts');

  room.remove(first!.id);
  check(room.hostId === second!.id, 'and the role passes on when they leave');

  room.remove(second!.id);
  check(room.hostId === 0, 'an empty room has no host to hold');

  const late = human(3);
  room.add(late, NOW);
  check(room.hostId === late.id, 'so whoever comes back is handed it');

  // A bot must never hold the role: it could not press Start, and the lobby would
  // wait forever for a decision nothing was going to make.
  room.lobbyAction(late, LOBBY_ACT.BOTS, 1, NOW);
  runBotPass(room, NOW);
  room.remove(late.id);
  check(room.hostId === 0, `bots do not inherit the room (${botCount(room)} still in it)`);
});

suite('only the host starts the match, and can change their mind', () => {
  const room = new Room('START1', MODE.TDM, MAP_ID, NOW, true);
  const [host, guest] = fill(room, 2, human);
  // Consent first: with anybody unready the host's Start is refused outright, so
  // without this the suite would be testing the gate instead of the authority.
  readyUp(room, [host!, guest!], NOW);

  room.lobbyAction(guest!, LOBBY_ACT.START, 0, NOW);
  check(room.startAt === 0, 'a guest pressing Start does nothing');

  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW);
  check(room.startAt === NOW + LOBBY_COUNTDOWN_MS, `the host opens a ${LOBBY_COUNTDOWN_MS}ms countdown`);

  room.step(NOW + LOBBY_COUNTDOWN_MS - 1);
  check(room.inLobby, 'which has not fired a millisecond early');

  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW + 1000);
  check(room.startAt === 0, 'pressing it again cancels — a misclick is not a commitment');

  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW + 2000);
  room.step(NOW + 2000 + LOBBY_COUNTDOWN_MS);
  check(room.phase === PHASE.LIVE, 'and the second attempt starts the match');
  check(room.startAt === 0, 'with the countdown cleared');
});

suite('nothing done in the lobby carries into the match', () => {
  // What lets the lobby be a live map instead of a menu: warming up has to cost
  // nothing, or the first thing anybody does in a party is farm their friends.
  const room = new Room('WARMUP', MODE.TDM, MAP_ID, NOW, true);
  const [host, guest] = fill(room, 2, human);
  host!.kills = 7;
  guest!.deaths = 7;
  room.scoreA = 5;
  room.lobbyAction(guest!, LOBBY_ACT.READY, 0, NOW);
  check(guest!.ready === true, 'a player can ready up');

  readyUp(room, [host!], NOW);
  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW);
  room.step(NOW + LOBBY_COUNTDOWN_MS);

  check(host!.kills === 0 && guest!.deaths === 0, 'the warm-up scoreline is wiped');
  check(room.scoreA === 0 && room.scoreB === 0, 'and so is the team score');
  check(
    host!.ready === false && guest!.ready === false,
    'ready flags are cleared, so the next round has to be agreed to on its own merits',
  );
});

suite('the match clock does not run while people are still arriving', () => {
  // Otherwise the last friend to load walks into a round that is half over. Read
  // off the wire rather than out of the room, because the clock the player argues
  // with is the one in the packet.
  const wire = fakeSocket();
  const room = new Room('CLOCK', MODE.FFA, MAP_ID, NOW, true);
  room.add(new ServerPlayer('Waiting', false, wire.socket, 'ranger'), NOW);

  const later = NOW + 4 * 60 * 1000;
  room.step(later);
  room.flush(later);

  const reader = wire.last(MSG.S_MATCH);
  check(reader !== null, 'a match packet went out');
  const m = reader ? decodeMatch(reader) : null;
  check(
    m?.timeLeft === MATCH_TIME_MS,
    `the full ${MATCH_TIME_MS / 60000} minutes are still ahead after four spent waiting (${Math.round((m?.timeLeft ?? 0) / 1000)}s left)`,
  );
  check(m?.over === 0, 'and the room has not timed itself out while nobody was playing');
});

suite('consent is mandatory, and the host is not exempt from it', () => {
  const room = new Room('READY1', MODE.FFA, MAP_ID, NOW, true);
  const [host, guest] = fill(room, 2, human);

  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW);
  check(room.startAt === 0, 'the host cannot start a room where nobody has agreed to play');

  readyUp(room, [guest!], NOW);
  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW);
  check(room.startAt === 0, 'nor one where they are themselves the last holdout');

  // The other half of the same rule, and the one the user actually hit: the room
  // used to start itself the moment the ready count matched the human count. That
  // is what "the match started as soon as a bot joined" was — a decision the room
  // made on its own, with no button pressed. A full ready-up is now permission for
  // the host to start, not a start.
  readyUp(room, [host!], NOW);
  room.step(NOW);
  room.step(NOW + 1000);
  check(room.startAt === 0, 'and a fully-agreed room still waits to be started by someone');

  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW + 1000);
  check(
    room.startAt === NOW + 1000 + LOBBY_COUNTDOWN_MS,
    'with the whole room agreed, the host opens the countdown',
  );
  room.step(NOW + 1000 + LOBBY_COUNTDOWN_MS);
  check(room.phase === PHASE.LIVE, 'and that is the only way a match ever begins');
});

suite('a countdown stops the moment the room stops agreeing', () => {
  const room = new Room('READY2', MODE.FFA, MAP_ID, NOW, true);
  const [host, guest] = fill(room, 2, human);
  readyUp(room, [host!, guest!], NOW);
  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW);
  check(room.startAt > 0, 'a countdown is running');

  // Withdrawing consent has to be worth something. If un-readying in the last
  // second still dragged you into the match, Ready would be a formality rather
  // than the permission the match is gated on.
  //
  // The room re-checks on its next tick rather than cancelling inside the READY
  // handler, which is why the test steps to observe it — one rule in one place,
  // covering every way a countdown can go stale, instead of a cancel remembered
  // at each call site that can invalidate one.
  room.lobbyAction(guest!, LOBBY_ACT.READY, 0, NOW + 1000);
  check(guest!.ready === false, 'the guest changes their mind');
  room.step(NOW + 1000);
  check(room.startAt === 0, 'and the countdown is called off');
  room.step(NOW + LOBBY_COUNTDOWN_MS + 1);
  check(room.inLobby, 'so the match they were counting down to never happens');

  readyUp(room, [guest!], NOW + 2000);
  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW + 2000);
  check(room.startAt === NOW + 2000 + LOBBY_COUNTDOWN_MS, 'the host tries again');

  // This reverses what the room used to do. A late arrival was allowed to ride
  // out a countdown they had not agreed to, on the grounds that it was short and
  // the others had already committed — but being put into a round you never
  // consented to is the same complaint as the room starting itself, seen from the
  // other side. Whoever is in the room when it starts has to have said yes.
  const late = human(3);
  room.add(late, NOW + 3000);
  check(late.ready === false, 'somebody joining mid-countdown is not silently readied');
  room.step(NOW + 3000);
  check(room.startAt === 0, 'so their arrival cancels the countdown they walked into');
  room.step(NOW + 2000 + LOBBY_COUNTDOWN_MS);
  check(room.inLobby, 'and the room is still gathering when that countdown would have fired');

  // Not wedged, though — the newcomer agreeing is all it was waiting for.
  readyUp(room, [late], NOW + 4000);
  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW + 4000);
  room.step(NOW + 4000 + LOBBY_COUNTDOWN_MS);
  check(room.phase === PHASE.LIVE, 'once the newcomer agrees too, the match starts');
});

suite('the lobby packet says whether Start would be honoured', () => {
  // The client disables its Start button from this bit instead of counting ready
  // flags out of the roster, so that a greyed-out button and a refused request are
  // one decision rather than two that can drift apart. It is only worth having if
  // it tracks the real gate, which is what this checks.
  const wire = fakeSocket();
  const room = new Room('CANSTRT', MODE.FFA, MAP_ID, NOW, true);
  const host = new ServerPlayer('Hostess', false, wire.socket, 'ranger');
  room.add(host, NOW);
  const guest = human(2);
  room.add(guest, NOW);

  /** The flags off the most recent lobby packet. Timestamps are spaced past
   *  `LOBBY_INTERVAL_MS` so the heartbeat guarantees a fresh one either way. */
  const flags = (at: number): number => {
    room.flush(at);
    const r = wire.last(MSG.S_LOBBY);
    return r ? decodeLobby(r).flags : 0;
  };

  check((flags(NOW + 250) & LF.CAN_START) === 0, 'clear while anybody is unready');

  readyUp(room, [host, guest], NOW + 400);
  check((flags(NOW + 600) & LF.CAN_START) !== 0, 'set once the whole room agrees');

  // Bots cannot press Ready, so counting them would make a room with bot fill
  // impossible to start at all — the host would be waiting on consent that was
  // never coming.
  room.lobbyAction(host, LOBBY_ACT.BOTS, 1, NOW + 700);
  runBotPass(room, NOW + 700);
  check(botCount(room) > 0, `bots filled the room (${botCount(room)} of them)`);
  check((flags(NOW + 1000) & LF.CAN_START) !== 0, 'and they do not withhold it');

  room.lobbyAction(guest, LOBBY_ACT.READY, 0, NOW + 1100);
  check((flags(NOW + 1400) & LF.CAN_START) === 0, 'one player changing their mind clears it again');
});

suite('a party goes back to its own lobby when the match ends', () => {
  const room = new Room('AGAIN', MODE.FFA, MAP_ID, NOW, true);
  const [host] = fill(room, 1, human);
  readyUp(room, [host!], NOW);
  room.lobbyAction(host!, LOBBY_ACT.START, 0, NOW);
  room.step(NOW + LOBBY_COUNTDOWN_MS);
  check(room.phase === PHASE.LIVE, 'the match is running');

  const ended = NOW + LOBBY_COUNTDOWN_MS + MATCH_TIME_MS + 1;
  room.step(ended);
  check(room.phase === PHASE.OVER && room.isOver, 'time runs out and the room shows the result');

  room.step(ended + 1000);
  check(room.phase === PHASE.OVER, 'the result card stays up for a moment');

  // Comfortably past the post-match wait, which is private to the room.
  room.step(ended + 60_000);
  check(room.inLobby, 'then the party is back in its lobby to argue about the next map');
  check(room.isOver === false, 'with the round cleared');
});

suite('a public room rolls straight into the next round', () => {
  // Nobody there chose each other, so there is nobody to make a decision and
  // nothing to wait for.
  const room = new Room('lobby-7', MODE.FFA, MAP_ID, NOW);
  fill(room, 1, human);
  const ended = NOW + MATCH_TIME_MS + 1;
  room.step(ended);
  check(room.phase === PHASE.OVER, 'the match ends');

  room.step(ended + 60_000);
  check(room.phase === PHASE.LIVE, 'and the next one is already running');
  check(room.inLobby === false, 'no waiting room appears in a public game');
});

suite('the roster says who is a bot, who is ready and who is host', () => {
  // These three flags are read by the scoreboard and the lobby panel, and they
  // were read with the wrong table for a while: bot is bit 6 in the actor flags
  // and bit 0 here, so every test came back false and nothing was ever labelled.
  // Decoding the real packet is the only way to catch that from this side.
  const wire = fakeSocket();
  const room = new Room('FLAGS1', MODE.FFA, MAP_ID, NOW, true);
  const host = new ServerPlayer('Hostess', false, wire.socket, 'ranger');
  room.add(host, NOW);
  room.lobbyAction(host, LOBBY_ACT.READY, 0, NOW);
  room.lobbyAction(host, LOBBY_ACT.BOTS, 1, NOW);
  runBotPass(room, NOW);
  room.flush(NOW + 5000);

  const rosterReader = wire.last(MSG.S_ROSTER);
  check(rosterReader !== null, 'a roster packet went out');
  const entries = rosterReader ? decodeRoster(rosterReader) : [];
  const mine = entries.find((e) => e.id === host.id);
  const bots = entries.filter((e) => (e.flags & RF.BOT) !== 0);

  check(bots.length === botCount(room), `every bot is tagged as one (${bots.length} of ${botCount(room)})`);
  check(!!mine && (mine.flags & RF.BOT) === 0, 'and the human is not');
  check(!!mine && (mine.flags & RF.HOST) !== 0, 'the host is marked');
  check(!!mine && (mine.flags & RF.READY) !== 0, 'so is their ready state');
  check(
    bots.every((e) => (e.flags & RF.HOST) === 0),
    'and no bot claims the room',
  );

  const lobbyReader = wire.last(MSG.S_LOBBY);
  check(lobbyReader !== null, 'a lobby packet went out too');
  const lobby = lobbyReader ? decodeLobby(lobbyReader) : null;
  check(lobby?.phase === PHASE.LOBBY, 'reporting the gathering phase');
  check(lobby?.hostId === host.id, 'and who to ask to start it');
});

/* ── Report ──────────────────────────────────────────────────────────────── */

const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`\n  server: ${total} checks passed.\n`);
  process.exit(0);
}
console.error(`\n  server: ${passed} of ${total} passed, ${failures.length} failed:\n`);
for (const f of failures) console.error(`  ✗ ${f}`);
console.error('');
process.exit(1);
