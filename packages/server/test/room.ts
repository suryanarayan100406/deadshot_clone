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

import { MAPS, MAX_PLAYERS, MODE, TEAM_A, TEAM_B, TEAM_NONE } from '@oneshot/shared';

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

function count(room: Room, team: number, bots?: boolean): number {
  let n = 0;
  for (const p of room.players.values()) {
    if (bots !== undefined && p.isBot !== bots) continue;
    if (p.team === team) n++;
  }
  return n;
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
  check(
    lobby.findRoom(MODE.FFA, 'FXTRT', NOW) !== party,
    'while the same code in another mode is a different room',
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
  const busy = lobby.findRoom(MODE.FFA, 'BUSY', NOW);
  fill(busy, 1, human);
  lobby.sweepEmpty();
  check(lobby.rooms.has(`${MODE.FFA}:BUSY`), 'a room with a player in it is never swept');
  check(keep !== busy, 'and it is not the one that was kept by default');
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
