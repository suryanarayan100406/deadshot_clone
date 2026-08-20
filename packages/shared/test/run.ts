/**
 * Shared-simulation test harness.
 *
 * Run with `npm test`. No framework: the properties worth checking here are few
 * and specific, and a dependency-free script that exits non-zero says everything
 * a runner would.
 *
 * Two of them matter more than the rest, because both fail *silently*:
 *
 *   1. **The collision solver never lets a player end a tick inside geometry.**
 *      One escape is not cosmetic — the player falls out of the map, or shoots
 *      through a wall from inside it. It also hides well: it needs a particular
 *      approach angle, at a particular speed, into a particular corner. So this
 *      is fuzzed over ten thousand ticks rather than spot-checked, from a fixed
 *      seed so a failure is reproducible instead of a one-off nobody can chase.
 *
 *   2. **Every message survives a round trip byte-for-byte.** The wire format is
 *      hand-rolled binary: an encoder and a decoder that must be edited in
 *      lockstep. Re-encoding the decoded value and comparing bytes catches a
 *      field added to one side and not the other, which a hand-written fixture
 *      would not.
 *
 * A fuzz that satisfies its invariants by doing nothing is worthless, so the run
 * also asserts it was representative — that most ticks were spent on the ground
 * and a decent number in the air.
 */

import {
  ACCEL_GROUND,
  AMMO_REFILL_MAGS_PER_KILL,
  BTN,
  FRICTION_GROUND,
  LF,
  LOBBY_ACT,
  MAPS,
  MAX_HEALTH,
  MAX_PLAYERS,
  MELEE_BACKSTAB_DAMAGE,
  MELEE_BACKSTAB_DOT,
  MELEE_SWING,
  PARTY_CODE_ALPHABET,
  PARTY_CODE_LEN,
  PARTY_CODE_MAX,
  PHASE,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  RF,
  ROTATIONS,
  SKIN,
  SPEED_CROUCH,
  SPEED_SPRINT,
  SPEED_WALK,
  TICK_DT,
  WEAPONS,
  WEAPON_BY_KEY,
  ByteReader,
  ByteWriter,
  boxOverlap,
  canFit,
  cycleTime,
  damageAtRange,
  decodeInputBatch,
  decodeJoin,
  decodeLobby,
  decodeLobbyCmd,
  decodeMatch,
  decodeRoster,
  decodeSnapshot,
  decodeWelcome,
  dirFromAngles,
  encodeInputBatch,
  encodeJoin,
  encodeLobby,
  encodeLobbyCmd,
  encodeMatch,
  encodeRoster,
  encodeSnapshot,
  encodeWelcome,
  makeHitbox,
  makeRng,
  mapColliders,
  newInputCmd,
  pickMap,
  propBox,
  propCollider,
  propPlacementIssue,
  randomPartyCode,
  sanitizePartyCode,
  stepMovement,
  traceShot,
  v3,
  weaponById,
  wrapAngle,
  writeHitboxes,
  type ActorState,
  type Box,
  type GameEvent,
  type InputCmd,
  type MoveState,
  type RosterEntry,
  type SelfState,
} from '../src/index';

/* ─────────────────────────────────────────────────────────────────────────────
   Harness
   ────────────────────────────────────────────────────────────────────────── */

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

function near(a: number, b: number, tol: number, what: string): void {
  check(Math.abs(a - b) <= tol, `${what}: expected ≈${b}, got ${a} (tolerance ${tol})`);
}

function sameBytes(a: Uint8Array, b: Uint8Array, what: string): void {
  if (a.length !== b.length) {
    check(false, `${what}: length ${a.length} vs ${b.length}`);
    return;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      check(false, `${what}: first difference at byte ${i} (${a[i]} vs ${b[i]})`);
      return;
    }
  }
  passed++;
}

/* ─────────────────────────────────────────────────────────────────────────────
   1. Byte plumbing
   ────────────────────────────────────────────────────────────────────────── */

suite('byte writer and reader', () => {
  const w = new ByteWriter(4); // deliberately too small, to force a grow
  w.u8v(255)
    .i8v(-128)
    .u16v(65535)
    .i16v(-32768)
    .u32v(4_294_967_295)
    .f32v(0.5)
    .str('ünïcode ✓')
    .angle16(1.25)
    .pitch16(-1.2);

  const bytes = w.take();
  const r = new ByteReader(bytes);
  check(r.u8v() === 255, 'u8 at its maximum');
  check(r.i8v() === -128, 'i8 at its minimum');
  check(r.u16v() === 65535, 'u16 at its maximum');
  check(r.i16v() === -32768, 'i16 at its minimum');
  check(r.u32v() === 4_294_967_295, 'u32 at its maximum');
  check(r.f32v() === 0.5, 'f32 exact for a representable value');
  check(r.str() === 'ünïcode ✓', 'length-prefixed UTF-8');
  near(r.angle16(), 1.25, 1e-4, 'angle quantisation');
  near(r.pitch16(), -1.2, 1e-4, 'pitch quantisation');
  check(r.remaining === 0, 'the reader consumed exactly what was written');

  // `take()` must hand back an independent copy rather than a view: the server
  // reuses one writer for every snapshot, and a view would be overwritten in
  // place before the socket had flushed it. It would also quietly make every
  // re-encode comparison below vacuously true.
  const before = bytes[0]!;
  w.reset().u8v(7);
  check(bytes[0] === before, 'take() returns a copy that the next write cannot touch');
  check(w.length === 1, 'reset() rewinds the writer');
});

/* ─────────────────────────────────────────────────────────────────────────────
   2. Collision fuzz
   ────────────────────────────────────────────────────────────────────────── */

const FUZZ_TICKS = 10_000;
const FUZZ_SEED = 0x5eed_1337;

/**
 * Half a millimetre. The solver leaves a 1.5 mm skin when it stops against a
 * surface, so a correct run has *separation*, not penetration; this only absorbs
 * float error in the comparison itself.
 */
const PENETRATION_TOLERANCE = 0.0005;

function writePlayerBox(out: Box, s: MoveState): Box {
  out.minX = s.pos.x - PLAYER_RADIUS;
  out.maxX = s.pos.x + PLAYER_RADIUS;
  out.minY = s.pos.y;
  out.maxY = s.pos.y + s.height;
  out.minZ = s.pos.z - PLAYER_RADIUS;
  out.maxZ = s.pos.z + PLAYER_RADIUS;
  return out;
}

/** Shrinks a box so that flush contact is not read as penetration. */
function shrink(b: Box, by: number): Box {
  return {
    minX: b.minX + by,
    minY: b.minY + by,
    minZ: b.minZ + by,
    maxX: b.maxX - by,
    maxY: b.maxY - by,
    maxZ: b.maxZ - by,
  };
}

function overlapDepth(a: Box, b: Box): number {
  const x = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const y = Math.min(a.maxY, b.maxY) - Math.max(a.minY, b.minY);
  const z = Math.min(a.maxZ, b.maxZ) - Math.max(a.minZ, b.minZ);
  if (x <= 0 || y <= 0 || z <= 0) return 0;
  return Math.min(x, y, z);
}

suite('collision fuzz', () => {
  const map = MAPS[0]!;
  const brushes = mapColliders(map);
  check(brushes.length > 0, 'the map has colliders');

  const rng = makeRng(FUZZ_SEED);
  const spawn = map.spawns[0]!;
  const state: MoveState = {
    pos: v3(spawn.x, spawn.y, spawn.z),
    vel: v3(0, 0, 0),
    onGround: false,
    crouching: false,
    height: PLAYER_HEIGHT,
  };

  const cmd = newInputCmd();
  cmd.yaw = spawn.yaw;

  const box: Box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };
  // The playfield is a 60 m square inside an 8 m perimeter wall, so this bound
  // sits well outside anything reachable — no false positives.
  const bound = map.half + 4;

  let worstDepth = 0;
  let worstTick = -1;
  let stuckTicks = 0;
  let escapes = 0;
  let escapeTick = -1;
  let respawns = 0;
  let airTicks = 0;
  let groundTicks = 0;

  for (let tick = 0; tick < FUZZ_TICKS; tick++) {
    // Intent changes in bursts, not every tick. A fresh random direction at
    // 60 Hz averages out to standing still and exercises nothing; holding a
    // direction is what drives the player into a wall at full speed.
    if (tick % 11 === 0) {
      cmd.forward = Math.round(rng() * 2 - 1);
      cmd.right = Math.round(rng() * 2 - 1);
    }
    if (tick % 7 === 0) {
      // Occasionally spin hard, otherwise drift: wall-sliding depends on the
      // angle of approach, so both need covering.
      cmd.yaw = wrapAngle(cmd.yaw + (rng() * 2 - 1) * (rng() < 0.2 ? Math.PI : 0.4));
    }
    let buttons = 0;
    // Deliberately low. One jump is ~40 ticks of airtime, so a high press rate
    // would spend the whole run in the air and never test ground movement.
    if (rng() < 0.015) buttons |= BTN.JUMP;
    if (rng() < 0.12) buttons |= BTN.CROUCH;
    if (rng() < 0.4) buttons |= BTN.SPRINT;
    cmd.buttons = buttons;
    cmd.seq = tick + 1;

    stepMovement(state, cmd, brushes, 1, TICK_DT);

    if (state.onGround) groundTicks++;
    else airTicks++;

    // Invariant 1 — never inside geometry.
    writePlayerBox(box, state);
    const probe = shrink(box, PENETRATION_TOLERANCE);
    let stuck = false;
    for (const brush of brushes) {
      if (!boxOverlap(probe, brush)) continue;
      stuck = true;
      const depth = overlapDepth(box, brush);
      if (depth > worstDepth) {
        worstDepth = depth;
        worstTick = tick;
      }
    }
    if (stuck) stuckTicks++;

    // Invariant 2 — never outside it either. Falling through the floor and
    // walking through the perimeter wall both land here.
    if (
      Math.abs(state.pos.x) > bound ||
      Math.abs(state.pos.z) > bound ||
      state.pos.y < -3 ||
      state.pos.y > 40
    ) {
      escapes++;
      if (escapeTick < 0) escapeTick = tick;
      // Put the player back so the remaining ticks still test something.
      const s = map.spawns[respawns++ % map.spawns.length]!;
      state.pos.x = s.x;
      state.pos.y = s.y;
      state.pos.z = s.z;
      state.vel.x = 0;
      state.vel.y = 0;
      state.vel.z = 0;
    }
  }

  const seed = FUZZ_SEED.toString(16);
  check(
    stuckTicks === 0,
    `player never penetrates a brush (seed ${seed}: ${stuckTicks} bad ticks, worst ${worstDepth.toFixed(
      5,
    )} m at tick ${worstTick})`,
  );
  check(escapes === 0, `player never leaves the map (seed ${seed}: ${escapes} escapes, first at tick ${escapeTick})`);

  // Coverage, not correctness: a run that floated for 10 000 ticks would satisfy
  // both invariants while testing none of the ground solver.
  check(groundTicks > FUZZ_TICKS * 0.35, `the fuzz spent most ticks grounded (${groundTicks} of ${FUZZ_TICKS})`);
  check(airTicks > 200, `the fuzz spent a meaningful number of ticks airborne (${airTicks})`);
});

suite('spawns are clear', () => {
  // Every map, not just the first. A spawn wedged inside a wall, floating over a
  // pit, or facing the back of its own base is legal geometry — nothing at
  // runtime complains, the player just dies a second after appearing — so a new
  // map's spawns are exactly the kind of thing that has to be checked by
  // something other than a person walking the level.
  for (const map of MAPS) {
    const brushes = mapColliders(map);

    // `mapById` indexes MAPS directly, so a mismatch here would serve the client
    // one level's geometry while the server simulates another's.
    check(map.id === MAPS.indexOf(map), `${map.name} has id ${MAPS.indexOf(map)}, matching its slot in MAPS`);
    check(map.spawns.length >= MAX_PLAYERS, `${map.name} has at least ${MAX_PLAYERS} spawns, one per player slot`);

    /** Tallest brush top under the spawn's footprint that is at or below its feet. */
    const supportUnder = (x: number, y: number, z: number): number => {
      let top = -Infinity;
      for (const b of brushes) {
        if (b.maxY > y + 0.01) continue;
        if (b.maxX <= x - PLAYER_RADIUS || b.minX >= x + PLAYER_RADIUS) continue;
        if (b.maxZ <= z - PLAYER_RADIUS || b.minZ >= z + PLAYER_RADIUS) continue;
        if (b.maxY > top) top = b.maxY;
      }
      return top;
    };

    map.spawns.forEach((s, i) => {
      const where = `${map.name} spawn ${i} (${s.x}, ${s.y}, ${s.z})`;
      check(
        canFit(s.x, s.y + 0.002, s.z, PLAYER_RADIUS, PLAYER_HEIGHT, brushes),
        `${where} has room for a standing player`,
      );
      check(Math.abs(s.x) < map.half && Math.abs(s.z) < map.half, `${where} is inside the map`);
      // Standing on something, and standing on the thing the author meant. A
      // raised spawn whose surface is missing would drop the player somewhere
      // else entirely — on Cistern's ring that means into the pit it overlooks.
      const top = supportUnder(s.x, s.y, s.z);
      check(s.y - top < 0.25, `${where} rests on solid ground (${(s.y - top).toFixed(3)} m above it)`);
    });

    // Spawn yaws point somewhere useful. Every map here faces its spawns at the
    // middle, so the dot of the forward vector with the direction to the origin
    // has to be positive — which catches a sign flip in the yaw convention, the
    // one map error that looks completely fine in a top-down view.
    let facingIn = 0;
    for (const s of map.spawns) {
      const d = Math.hypot(s.x, s.z);
      if (d < 1) {
        facingIn++;
        continue;
      }
      const fx = -Math.sin(s.yaw);
      const fz = -Math.cos(s.yaw);
      if ((fx * -s.x + fz * -s.z) / d > 0) facingIn++;
    }
    check(facingIn === map.spawns.length, `${map.name}: all ${map.spawns.length} spawns face the centre (${facingIn})`);
  }
});

suite('decoration never lies about cover', () => {
  // Props are drawn and almost never collided, which makes a badly placed one a
  // lie the engine cannot detect at runtime: the player sees a barrel, shoots it,
  // and the round passes straight through — or hides behind it and dies. So every
  // prop on every map has to satisfy one of the three placement rules, and the
  // rules are checked here rather than trusted to whoever authored the level,
  // because there are over a thousand of them and no person is going to re-walk
  // that after every edit.
  for (const map of MAPS) {
    let bad = 0;
    let first = '';
    for (const p of map.props) {
      const issue = propPlacementIssue(map, p);
      if (!issue) continue;
      bad++;
      if (!first) first = `${p.kind} r=${p.r} at (${p.x}, ${p.y}, ${p.z}): ${issue}`;
    }
    check(bad === 0, `${map.name}: all ${map.props.length} props are legally placed (${bad} bad${first ? `, e.g. ${first}` : ''})`);

    // A map that lost its props would satisfy the rule above perfectly, so the
    // floor is what stops the check from passing by being vacuous. Scaled off the
    // map's own size so enlarging a level does not silently lower the bar.
    const floor = Math.max(60, Math.round(map.half * 2));
    check(map.props.length >= floor, `${map.name} is actually dressed (${map.props.length} props, floor ${floor})`);
  }

  // The one place props do collide. A solid prop is collided as the box inscribed
  // in its silhouette, so the collider has to sit *inside* what is drawn: erring
  // that way gives cover away, and erring the other way stops bullets and players
  // with air. Cylinders lose 0.29 r at each diagonal, which is the whole error
  // budget of the scheme and is deliberate.
  let loose = 0;
  let looseWhere = '';
  for (const map of MAPS) {
    for (const p of map.props) {
      const c = propCollider(p);
      if (!c) continue;
      const d = propBox(p);
      const inside =
        c.minX >= d.minX - 1e-9 && c.maxX <= d.maxX + 1e-9 &&
        c.minY >= d.minY - 1e-9 && c.maxY <= d.maxY + 1e-9 &&
        c.minZ >= d.minZ - 1e-9 && c.maxZ <= d.maxZ + 1e-9;
      if (inside) continue;
      loose++;
      if (!looseWhere) looseWhere = `${map.name} ${p.kind} at (${p.x}, ${p.y}, ${p.z})`;
    }
  }
  check(loose === 0, `every solid prop's collider stays inside its silhouette (${loose} loose${looseWhere ? `, e.g. ${looseWhere}` : ''})`);
});

suite('the map rotation plays every map, in the right mode', () => {
  // A map can be fully authored, tested and completely unreachable, because
  // nothing outside this file ever mentions it by name. So: every map has to be
  // in a rotation somewhere, or it does not exist as far as a player is concerned.
  for (const m of MAPS) {
    const inFfa = ROTATIONS.ffa.includes(m);
    const inTdm = ROTATIONS.tdm.includes(m);
    check(inFfa || inTdm, `${m.name} is in a rotation, so a player can actually get to it`);
  }

  // `pickMap` walks its rotation with the seed. Both properties matter: covering
  // the whole rotation is what stops four of five maps being decoration, and
  // being stable per seed is what makes a shared join code mean a shared level.
  for (const [team, label, rot] of [
    [false, 'FFA', ROTATIONS.ffa],
    [true, 'TDM', ROTATIONS.tdm],
  ] as const) {
    const seen = new Set<string>();
    for (let seed = 0; seed < rot.length * 3; seed++) seen.add(pickMap(team, seed).key);
    check(seen.size === rot.length, `${label} seeds cover all ${rot.length} of its maps (${seen.size})`);
    check(
      pickMap(team, 7) === pickMap(team, 7) && pickMap(team, -1) === pickMap(team, rot.length - 1),
      `${label} map choice is stable per seed, and sane for a negative one`,
    );
    for (const m of rot) check(ROTATIONS[team ? 'tdm' : 'ffa'].includes(m), `${label} rotation holds ${m.name}`);
  }

  /**
   * How far apart the two closest spawns on a map are.
   *
   * This is the number that decides whether a map can host a free-for-all. The
   * server puts a spawning player on the point furthest from everyone else, but it
   * can only choose from what the map offers — so a map whose spawns sit in tight
   * clusters makes a full lobby appear on top of itself no matter how good the
   * chooser is. Meridian is exactly that map on purpose: six spawns behind each
   * base is the right answer for teams and the wrong one for a free-for-all, and
   * this is the assertion that keeps it out of the FFA rotation if someone adds it
   * there because five maps looked better than four.
   */
  const closestPair = (m: (typeof MAPS)[number]): number => {
    let best = Infinity;
    for (let i = 0; i < m.spawns.length; i++) {
      for (let j = i + 1; j < m.spawns.length; j++) {
        const a = m.spawns[i]!;
        const b = m.spawns[j]!;
        const d = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
        if (d < best) best = d;
      }
    }
    return best;
  };

  for (const m of ROTATIONS.ffa) {
    check(closestPair(m) > 8, `${m.name} keeps its spawns apart for FFA (closest pair ${closestPair(m).toFixed(1)} m)`);
  }
  // And the converse, stated rather than implied: the team map is a team map.
  const meridian = MAPS.find((m) => m.key === 'meridian');
  check(!!meridian && ROTATIONS.tdm.includes(meridian), 'Meridian is in the team rotation');
  check(!!meridian && !ROTATIONS.ffa.includes(meridian), 'and not in the free-for-all one');
});

suite('a dropped player lands and settles', () => {
  const brushes = mapColliders(MAPS[0]!);
  const DROP_FROM = 6;

  /**
   * The height the player should come to rest at: the tallest brush top beneath
   * the footprint they fall through. Derived rather than hardcoded, because the
   * first version of this test asserted a literal 1.5 m and failed the moment it
   * met the pillar standing on the middle of the platform — the map was right and
   * the test was wrong.
   */
  const supportUnder = (x: number, z: number): number => {
    let top = -Infinity;
    for (const b of brushes) {
      if (b.maxY > DROP_FROM) continue;
      if (b.maxX <= x - PLAYER_RADIUS || b.minX >= x + PLAYER_RADIUS) continue;
      if (b.maxZ <= z - PLAYER_RADIUS || b.minZ >= z + PLAYER_RADIUS) continue;
      if (b.maxY > top) top = b.maxY;
    }
    return top;
  };

  // Two columns: one over open platform, one over the pillar at the centre, so
  // both a plain floor and a raised surface get landed on.
  for (const [x, z, what] of [
    [4, 4, 'the platform'],
    [0, 0, 'the pillar at the centre'],
  ] as const) {
    const expected = supportUnder(x, z);
    check(Number.isFinite(expected), `${what} is solid under (${x}, ${z})`);
    check(
      canFit(x, DROP_FROM, z, PLAYER_RADIUS, PLAYER_HEIGHT, brushes),
      `the drop point above ${what} is clear`,
    );

    const state: MoveState = {
      pos: v3(x, DROP_FROM, z),
      vel: v3(0, 0, 0),
      onGround: false,
      crouching: false,
      height: PLAYER_HEIGHT,
    };
    const cmd = newInputCmd();

    let landedAt = -1;
    let impact = 0;
    for (let i = 0; i < 240; i++) {
      const res = stepMovement(state, cmd, brushes, 1, TICK_DT);
      if (res.landed && landedAt < 0) {
        landedAt = i;
        impact = res.impactSpeed;
      }
    }

    check(landedAt >= 0, `a player dropped onto ${what} reports landing`);
    check(impact > 0, `and an impact speed (${impact.toFixed(2)} m/s), so fall damage can be judged`);
    check(state.onGround, `and is still grounded on ${what} four seconds later`);
    // Resting *on* the surface means separation by the solver's skin, never
    // penetration, so the tolerance is one-sided in spirit and tiny in size.
    near(state.pos.y, expected + SKIN, 0.002, `resting height on ${what}`);
    check(state.vel.y > -1, `and is not accumulating fall speed at rest (${state.vel.y.toFixed(3)})`);
  }
});

suite('crouch cannot be released into a ceiling', () => {
  const floor: Box = { minX: -8, minY: -1, minZ: -8, maxX: 8, maxY: 0, maxZ: 8 };
  // A slab with 1.3 m of headroom: enough to crouch under, not to stand.
  const slab: Box = { minX: -2, minY: 1.3, minZ: -2, maxX: 2, maxY: 2.6, maxZ: 2 };

  const crouched = (): MoveState => ({
    pos: v3(0, 0, 0),
    vel: v3(0, 0, 0),
    onGround: true,
    crouching: true,
    height: PLAYER_CROUCH_HEIGHT,
  });
  const cmd = newInputCmd();

  // Under the slab, releasing crouch must not stand the player up into it.
  const trapped = crouched();
  cmd.buttons = 0;
  for (let i = 0; i < 30; i++) stepMovement(trapped, cmd, [floor, slab], 1, TICK_DT);
  check(trapped.crouching, 'stays crouched with no headroom');
  near(trapped.height, PLAYER_CROUCH_HEIGHT, 1e-9, 'and keeps the crouched height');
  check(trapped.pos.y + trapped.height <= slab.minY + 1e-6, 'so the body never intersects the slab');

  // The complement, without which the check above would also pass if crouch
  // simply never released: given headroom, the player must stand back up.
  const free = crouched();
  for (let i = 0; i < 30; i++) stepMovement(free, cmd, [floor], 1, TICK_DT);
  check(!free.crouching, 'stands up again once there is headroom');
  near(free.height, PLAYER_HEIGHT, 1e-9, 'and returns to full height');

  // And crouching is what got them under there in the first place.
  const ducking = crouched();
  ducking.crouching = false;
  ducking.height = PLAYER_HEIGHT;
  cmd.buttons = BTN.CROUCH;
  stepMovement(ducking, cmd, [floor], 1, TICK_DT);
  check(ducking.crouching, 'holding crouch ducks immediately');
});

suite('stance speeds are ordered', () => {
  check(SPEED_SPRINT > SPEED_WALK, 'sprinting beats walking');
  check(SPEED_WALK > SPEED_CROUCH, 'walking beats crouching');
  check(SPEED_CROUCH > 0, 'crouching still moves');
});

/**
 * The stance table is only worth anything if the simulation can actually reach the
 * numbers in it, and for a long time it could not.
 *
 * `accelerate()` adds `ACCEL_GROUND * dt` per tick, flat, regardless of how fast
 * the player is asking to go — Quake scales that gain by `wishSpeed` and this does
 * not. Friction, meanwhile, removes a *proportion* of current speed every tick. Set
 * those two against each other and ground speed is capped at
 * `ACCEL_GROUND / FRICTION_GROUND` whatever the stance requests: at 90/11 the
 * ceiling was 8.18 m/s, which is *below* `SPEED_SPRINT`. Sprint was therefore
 * unreachable, holding shift did almost nothing you could feel, and — the part that
 * made it hard to find — raising `SPEED_SPRINT` would not have helped either,
 * because the number was never the binding constraint.
 *
 * So this suite asserts the reachable speeds rather than the declared ones, and
 * asserts the inequality that makes them reachable. Retuning either constant now
 * has to keep both true.
 */
suite('every stance actually reaches the speed it advertises', () => {
  const floor: Box = { minX: -400, minY: -1, minZ: -400, maxX: 400, maxY: 0, maxZ: 400 };

  /** Hold one stance in a straight line and report the speed it settles at. */
  function terminal(buttons: number, speedMult = 1): number {
    const crouching = (buttons & BTN.CROUCH) !== 0;
    const s: MoveState = {
      pos: v3(0, 0, 0),
      vel: v3(0, 0, 0),
      onGround: true,
      crouching,
      height: crouching ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT,
    };
    const cmd = newInputCmd();
    cmd.forward = 1;
    cmd.buttons = buttons;
    // Two seconds, against a convergence time of about a tenth of one: this is the
    // speed the player holds, not a number caught mid-acceleration.
    for (let i = 0; i < 120; i++) stepMovement(s, cmd, [floor], speedMult, TICK_DT);
    return Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
  }

  const ceiling = ACCEL_GROUND / FRICTION_GROUND;
  const fastest = Math.max(...WEAPONS.map((w) => w.moveMult));

  near(terminal(BTN.SPRINT), SPEED_SPRINT, 0.01, 'sprint settles at SPEED_SPRINT');
  near(terminal(0), SPEED_WALK, 0.01, 'walking settles at SPEED_WALK');
  near(terminal(BTN.CROUCH), SPEED_CROUCH, 0.01, 'crouching settles at SPEED_CROUCH');

  // The difference, stated as the thing a player notices. Asserting the two speeds
  // separately would still pass if both were clamped to the same ceiling.
  near(
    terminal(BTN.SPRINT) / terminal(0),
    SPEED_SPRINT / SPEED_WALK,
    0.01,
    'so shift is worth the full advertised multiplier',
  );

  check(
    ceiling > SPEED_SPRINT * fastest,
    `the ground-speed ceiling (${ceiling.toFixed(2)} m/s) clears the fastest loadout ` +
      `in the table (${(SPEED_SPRINT * fastest).toFixed(2)} m/s)`,
  );
  // Without the headroom above, every weapon sprints at the ceiling and the menu's
  // Mobility bars describe a difference the simulation does not have.
  near(
    terminal(BTN.SPRINT, fastest),
    SPEED_SPRINT * fastest,
    0.01,
    'and a high-mobility loadout gets its multiplier instead of clamping',
  );
});

suite('sprint stamina drains and triggers cooldown', () => {
  const floor: Box = { minX: -400, minY: -1, minZ: -400, maxX: 400, maxY: 0, maxZ: 400 };
  const s: MoveState = {
    pos: v3(0, 0, 0),
    vel: v3(0, 0, 0),
    onGround: true,
    crouching: false,
    height: PLAYER_HEIGHT,
  };
  const cmd = newInputCmd();
  cmd.forward = 1;
  cmd.buttons = BTN.SPRINT;

  // Sprint for 5 seconds (past the 4.5s stamina limit)
  for (let i = 0; i < 300; i++) stepMovement(s, cmd, [floor], 1, TICK_DT);

  check((s.stamina ?? 0) <= 0.05, 'stamina drains completely after 5s sprint');
  check((s.staminaCooldown ?? 0) > 0, 'stamina enters cooldown after exhaustion');

  const exhaustedSpeed = Math.sqrt(s.vel.x * s.vel.x + s.vel.z * s.vel.z);
  near(exhaustedSpeed, SPEED_WALK, 0.05, 'exhausted player drops back to SPEED_WALK');

  // Release sprint and wait for cooldown to pass and recharge (5 seconds)
  cmd.buttons = 0;
  for (let i = 0; i < 300; i++) stepMovement(s, cmd, [floor], 1, TICK_DT);

  check((s.stamina ?? 0) >= 0.98, 'stamina fully recharges after cooldown');
  check((s.staminaCooldown ?? 0) === 0, 'cooldown clears after recovery');
});

/* ─────────────────────────────────────────────────────────────────────────────
   3. Hitscan
   ────────────────────────────────────────────────────────────────────────── */

suite('hitscan respects cover, hitboxes and range', () => {
  const head = makeHitbox();
  const body = makeHitbox();
  // A standing target ten metres down −Z.
  writeHitboxes(head, body, 7, 0, 0, -10, PLAYER_HEIGHT);
  const targets = [head, body];

  // Chest height. The head cube occupies only the top 0.3 m, so 1.0 m is torso.
  let r = traceShot(0, 1.0, 0, 0, 0, -1, [], targets, 300);
  check(r.hitId === 7, 'a clear shot hits the target');
  check(!r.head, 'a chest-height shot is a body hit');
  near(r.t, 10 - PLAYER_RADIUS, 0.01, 'and stops at the near face of the target');

  // Just under the crown.
  r = traceShot(0, PLAYER_HEIGHT - 0.05, 0, 0, 0, -1, [], targets, 300);
  check(r.hitId === 7 && r.head, 'a shot at the crown is a headshot');

  // A wall in between: the nearest thing along the ray wins, so cover works.
  const blocker: Box = { minX: -5, minY: 0, minZ: -5.4, maxX: 5, maxY: 4, maxZ: -5 };
  r = traceShot(0, 1.0, 0, 0, 0, -1, [blocker], targets, 300);
  check(r.hitId === -1, 'a wall in the way blocks the shot');
  check(r.hitWorld, 'and registers as a world hit');
  near(r.t, 5, 0.01, 'stopping at the wall rather than behind it');
  near(r.nz, 1, 1e-6, 'with a normal pointing back along the ray');

  // The same wall behind the shooter must not block anything.
  const behind: Box = { minX: -5, minY: 0, minZ: 3, maxX: 5, maxY: 4, maxZ: 3.4 };
  r = traceShot(0, 1.0, 0, 0, 0, -1, [behind], targets, 300);
  check(r.hitId === 7, 'geometry behind the shooter is ignored');

  // Beyond the weapon's reach.
  r = traceShot(0, 1.0, 0, 0, 0, -1, [], targets, 4);
  check(r.hitId === -1 && !r.hitWorld, 'a target past maximum range is not hit');

  // Nothing at all: the client reads a zero normal as "no surface to mark".
  r = traceShot(0, 1.0, 0, 1, 0, 0, [], [], 100);
  check(r.hitId === -1 && r.nx === 0 && r.ny === 0 && r.nz === 0, 'a shot into open air reports no normal');
  near(r.t, 100, 1e-9, 'and travels its full range');

  // A shot starting inside the shooter's own hitbox must not hit the shooter.
  const selfHead = makeHitbox();
  const selfBody = makeHitbox();
  writeHitboxes(selfHead, selfBody, 42, 0, 0, 0, PLAYER_HEIGHT);
  r = traceShot(0, 1.0, 0, 0, 0, -1, [], [selfHead, selfBody, head, body], 300);
  check(r.hitId === 7, 'a shot fired from inside your own hitbox hits the enemy, not you');
});

/* ─────────────────────────────────────────────────────────────────────────────
   4. Angle convention
   ────────────────────────────────────────────────────────────────────────── */

suite('angle convention', () => {
  const d = v3();

  dirFromAngles(d, 0, 0);
  near(d.x, 0, 1e-9, 'yaw 0 has no x component');
  near(d.z, -1, 1e-9, 'yaw 0 looks down −Z');

  dirFromAngles(d, Math.PI / 2, 0);
  near(d.x, -1, 1e-9, 'a quarter turn of +yaw looks down −X, i.e. to the left');
  near(d.z, 0, 1e-9, 'and has no z component');

  dirFromAngles(d, 0, Math.PI / 2);
  near(d.y, 1, 1e-9, '+pitch looks up');

  for (const [yaw, pitch] of [
    [0.3, 0.2],
    [-2.1, -0.9],
    [3.0, 1.4],
  ] as const) {
    dirFromAngles(d, yaw, pitch);
    near(Math.hypot(d.x, d.y, d.z), 1, 1e-9, `direction is a unit vector at yaw ${yaw}, pitch ${pitch}`);
  }

  // wrapAngle's contract is "same direction, folded into one turn" — not a
  // specific representative. ±π name the same angle, so asserting a sign at the
  // boundary tests the implementation's arbitrary choice rather than the
  // property that matters. Check the property instead.
  for (const a of [0, 0.4, -0.4, Math.PI * 3, Math.PI * -1.5, 7.9, -51.3, 1e4]) {
    const w = wrapAngle(a);
    check(Math.abs(w) <= Math.PI + 1e-9, `wrapAngle(${a}) lands within one turn (got ${w})`);
    near(Math.cos(w), Math.cos(a), 1e-9, `wrapAngle(${a}) preserves direction (cos)`);
    near(Math.sin(w), Math.sin(a), 1e-9, `wrapAngle(${a}) preserves direction (sin)`);
  }
  // An angle already in range must come back essentially untouched. Not bit
  // identical: the implementation adds π, takes a modulo and subtracts π again,
  // and `0.4 + Math.PI` is not exactly representable, so a couple of ulps are
  // lost. That is well below the 2π/65536 ≈ 9.6e-5 rad step the angle is
  // quantised to on the wire, so it can never change a byte anyone sees.
  near(wrapAngle(0.4), 0.4, 1e-15, 'wrapAngle returns an in-range angle unchanged');
  near(wrapAngle(Math.PI * -1.5), Math.PI * 0.5, 1e-9, 'wrapAngle folds −1.5π to +0.5π');
});

/* ─────────────────────────────────────────────────────────────────────────────
   5. Protocol round trips
   ────────────────────────────────────────────────────────────────────────── */

/** Every decoder expects the reader positioned just past the message tag. */
function afterTag(bytes: Uint8Array): ByteReader {
  const r = new ByteReader(bytes);
  r.u8v();
  return r;
}

suite('join round trip', () => {
  const msg = { name: 'Ünïcødé_16ch', primary: 'longshot', mode: 1, room: 'main' };
  const first = encodeJoin(msg);
  const decoded = decodeJoin(afterTag(first));
  check(decoded.name === msg.name, 'the name survives multi-byte UTF-8');
  check(decoded.primary === msg.primary, 'the chosen weapon survives');
  check(decoded.mode === msg.mode, 'the mode survives');
  check(decoded.room === msg.room, 'the room survives');
  sameBytes(first, encodeJoin(decoded), 'join re-encodes identically');
});

suite('party codes survive being read aloud and typed back in', () => {
  // A party is just a named room, so the code is a key shared between the client
  // that generates it and the server that indexes rooms by it. Everything here is
  // about those two ends agreeing — the failure mode is not a crash but a party
  // quietly splitting in half, which nothing at runtime would report.

  // The coupling that matters most: a code the menu hands out must be one the
  // server keeps verbatim. If the generator ever reached outside the alphabet, the
  // "New code" button would start producing codes the server mangles into a
  // different room, and the person who clicked it would be alone in it.
  const rng = makeRng(0x9e3779b9);
  let stable = 0;
  const drawn = new Set<string>();
  for (let i = 0; i < 4000; i++) {
    const code = randomPartyCode(rng);
    drawn.add(code);
    if (sanitizePartyCode(code) === code && code.length === PARTY_CODE_LEN) stable++;
  }
  check(stable === 4000, `every generated code is already canonical (${stable}/4000)`);
  check(drawn.size > 3800, `and they are not all the same code (${drawn.size} distinct of 4000)`);

  // Every symbol in the alphabet has to round-trip, or the generator can emit a
  // character the sanitizer drops — the same failure as above, but rarer and
  // therefore worse, because it would only bite the occasional player.
  let kept = 0;
  for (const ch of PARTY_CODE_ALPHABET) if (sanitizePartyCode(ch) === ch) kept++;
  check(kept === PARTY_CODE_ALPHABET.length, `all ${PARTY_CODE_ALPHABET.length} symbols survive`);

  // The four characters that exist to be absent. A code is read out loud; these
  // are the pairs that make that fail, so they must not appear in the alphabet at
  // all — and the sanitizer folds the two letters up rather than keeping them.
  for (const ch of 'IO01') {
    check(!PARTY_CODE_ALPHABET.includes(ch), `the alphabet excludes the ambiguous "${ch}"`);
  }

  check(sanitizePartyCode('foxtrot') === 'FXTRT', 'lower case is folded up so caps lock cannot split a party');
  check(sanitizePartyCode('FXTRT') === 'FXTRT', 'an already-clean code is left exactly as it is');
  check(sanitizePartyCode('  FX7-2K  ') === 'FX72K', 'padding and punctuation are dropped, not substituted');
  // Stated so nobody mistakes this for a code *extractor*: surrounding words keep
  // their letters, so "code: FX7-2K" is not the same party as "FX72K". Pasting a
  // whole sentence is a real thing people do, and this is what it gets them.
  check(sanitizePartyCode('code: FX7-2K') === 'CDEFX72K', 'but letters in surrounding words are kept');
  check(sanitizePartyCode('  ') === '', 'whitespace alone means "any lobby with space"');
  check(sanitizePartyCode('io01') === '', 'a code of nothing but ambiguous characters collapses to none');
  check(
    sanitizePartyCode('A'.repeat(50)).length === PARTY_CODE_MAX,
    `an over-long code is bounded to ${PARTY_CODE_MAX} characters`,
  );

  // Idempotent, because both ends run it: the client while you type, the server on
  // arrival. If a second pass could change the answer, the room you were shown
  // would not be the room you joined.
  let idempotent = 0;
  const nasty = ['foxtrot', 'FX7-2K', '  spaced  ', 'io01', 'A'.repeat(50), '', 'ünïcødé', '<b>x</b>'];
  for (const raw of nasty) {
    const once = sanitizePartyCode(raw);
    if (sanitizePartyCode(once) === once) idempotent++;
  }
  check(idempotent === nasty.length, `sanitizing twice changes nothing (${idempotent}/${nasty.length})`);

  // The room name is echoed to every other player in the room, so the set of
  // strings a stranger can put on someone else's screen should be small and dull.
  // This is the assertion that says so in code rather than in a comment.
  for (const raw of ['<script>alert(1)</script>', 'a b', 'x\ny', '../../etc/passwd', '🙂🙂']) {
    const out = sanitizePartyCode(raw);
    let inAlphabet = true;
    for (const ch of out) if (!PARTY_CODE_ALPHABET.includes(ch)) inAlphabet = false;
    check(inAlphabet, `a hostile code reduces to alphabet characters only (got "${out}")`);
  }

  // And the one property the server's room keying depends on: a sanitized code can
  // never collide with a `lobby-N` name, because both `-` and lower case are gone.
  // Without this a stranger could type their way into the public rotation.
  for (const n of [1, 2, 7, 12]) {
    check(sanitizePartyCode(`lobby-${n}`) !== `lobby-${n}`, `"lobby-${n}" cannot be requested as a party`);
  }
});

suite('input batch round trip', () => {
  const cmds: InputCmd[] = [];
  for (let i = 0; i < 8; i++) {
    cmds.push({
      seq: 5000 + i,
      forward: (i % 3) - 1,
      right: ((i + 1) % 3) - 1,
      // Only six button bits exist on the wire, and the decoder masks the rest.
      buttons: i * 7,
      yaw: wrapAngle(i * 0.9 - 2),
      pitch: (i / 8 - 0.5) * 2.6,
    });
  }

  const first = encodeInputBatch(cmds, 0);
  const out: InputCmd[] = [];
  const count = decodeInputBatch(afterTag(first), out);
  check(count === cmds.length, `decoded ${count} of ${cmds.length} commands`);

  for (let i = 0; i < count; i++) {
    const a = cmds[i]!;
    const b = out[i]!;
    check(b.seq === a.seq, `command ${i} sequence number`);
    check(b.forward === a.forward, `command ${i} forward axis`);
    check(b.right === a.right, `command ${i} right axis`);
    check(b.buttons === a.buttons, `command ${i} buttons`);
    // Angles are 16-bit, so exactness is neither expected nor wanted — but the
    // error has to sit far below anything a player could aim by hand.
    near(wrapAngle(b.yaw - a.yaw), 0, 1e-4, `command ${i} yaw`);
    near(b.pitch - a.pitch, 0, 1e-4, `command ${i} pitch`);
  }
  sameBytes(first, encodeInputBatch(out, 0), 'input batch re-encodes identically');

  // The batch is capped at eight, and `from` selects the newest window — a
  // server that acks nothing must not make the packet grow without bound.
  const many: InputCmd[] = [];
  for (let i = 0; i < 40; i++) many.push({ ...cmds[0]!, seq: i });
  const capped: InputCmd[] = [];
  check(decodeInputBatch(afterTag(encodeInputBatch(many, 0)), capped) === 8, 'a long queue is capped at 8 commands');
  const windowed: InputCmd[] = [];
  decodeInputBatch(afterTag(encodeInputBatch(many, 32)), windowed);
  check(windowed[0]?.seq === 32, '`from` sends the newest window, not the oldest');
});

suite('welcome round trip', () => {
  const msg = { id: 9, mapId: MAPS[0]!.id, mode: 1, tickRate: 60, serverTime: 1_234_567, room: 'main' };
  const first = encodeWelcome(msg);
  const decoded = decodeWelcome(afterTag(first));
  check(decoded.id === msg.id, 'the assigned player id survives');
  check(decoded.mapId === msg.mapId, 'the map id survives');
  check(decoded.serverTime === msg.serverTime, 'the server clock survives');
  sameBytes(first, encodeWelcome(decoded), 'welcome re-encodes identically');
});

suite('snapshot round trip', () => {
  const self: SelfState = {
    x: 12.5,
    y: 1.5,
    z: -8.25,
    vx: 3.5,
    vy: -2.25,
    vz: 0.75,
    flags: 0b1010_0101,
    health: 63,
    weapon: 3,
    magAmmo: 4,
    reserveAmmo: 17,
    reloadLeft: 1.234,
    kills: 12,
    deaths: 9,
    streak: 4,
    respawnIn: 2.2,
  };

  const actors: ActorState[] = [];
  for (let i = 0; i < MAX_PLAYERS - 1; i++) {
    actors.push({
      id: 100 + i,
      x: i * 1.5 - 10,
      y: (i % 3) * 0.5,
      z: 14 - i * 2,
      yaw: wrapAngle(i * 0.7 - 3),
      pitch: (i / 12 - 0.5) * 3,
      flags: i * 13,
      health: 100 - i * 6,
      weapon: i % WEAPONS.length,
      team: (i % 2) + 1,
      speed: i * 0.7,
    });
  }

  // One of every event shape the server actually emits. Impact normals travel as
  // signed bytes, which is why they are whole numbers here — an AABB normal is
  // always ±1 on a single axis.
  const events: GameEvent[] = [
    { kind: 1, a: 3, b: 0, x: 1.5, y: 2, z: -3, nx: 20, ny: 3, nz: -40 },
    { kind: 2, x: -4.5, y: 0.25, z: 7, nx: 0, ny: 1, nz: 0, flag: 0 },
    { kind: 2, x: 6, y: 1.75, z: 2, nx: 0, ny: 0, nz: 0, flag: 2 },
    { kind: 3, a: 104, b: 47, flag: 3 },
    { kind: 4, a: 101, b: 28, x: -1.75 },
    { kind: 5, a: 102, b: 103, c: 4, flag: 1 },
    { kind: 5, a: 102, b: 102, c: 255, flag: 4 },
    { kind: 6, a: 7 },
    { kind: 7, a: 8 },
    { kind: 8, a: 102 },
    { kind: 9, a: 5, text: 'nice shot — ünïcode ok' },
  ];

  const w = new ByteWriter();
  const first = encodeSnapshot(w, 987_654, 4321, self, actors, events);
  const snap = decodeSnapshot(afterTag(first));

  check(snap.serverTime === 987_654, 'the server clock survives');
  check(snap.ackSeq === 4321, 'the input acknowledgement survives');
  check(snap.actors.length === actors.length, `all ${actors.length} actors survive`);
  check(snap.events.length === events.length, `all ${events.length} events survive`);

  // Positions are full float32, so these are exact.
  check(snap.self.x === self.x && snap.self.y === self.y && snap.self.z === self.z, 'own position is exact');
  check(snap.self.vy === self.vy, 'own velocity is exact');
  check(snap.self.flags === self.flags, 'own state flags survive');
  check(snap.self.magAmmo === self.magAmmo && snap.self.reserveAmmo === self.reserveAmmo, 'ammunition survives');
  check(snap.self.streak === self.streak, 'the kill streak survives');
  // The two timers are quantised to milliseconds.
  near(snap.self.reloadLeft, self.reloadLeft, 0.001, 'the reload timer');
  near(snap.self.respawnIn, self.respawnIn, 0.001, 'the respawn timer');

  const a0 = snap.actors[0]!;
  check(a0.id === actors[0]!.id, 'actor ids survive');
  check(a0.team === actors[0]!.team, 'actor teams survive');
  near(wrapAngle(a0.yaw - actors[0]!.yaw), 0, 1e-4, 'actor yaw');
  near(a0.pitch - actors[0]!.pitch, 0, 1e-4, 'actor pitch');

  const chat = snap.events.find((e) => e.kind === 9);
  check(chat?.text === 'nice shot — ünïcode ok', 'chat text survives multi-byte UTF-8');
  const flesh = snap.events.filter((e) => e.kind === 2);
  check(flesh[1]?.flag === 2, 'a headshot impact keeps its flag');

  // Reusing the same writer, which is what the server does twenty times a
  // second — so `reset()` must leave no residue from the previous frame.
  const second = encodeSnapshot(w, snap.serverTime, snap.ackSeq, snap.self, snap.actors, snap.events);
  sameBytes(first, second, 'snapshot re-encodes identically');

  // Worth failing on if it ever balloons: the whole point of a binary format is
  // that a full lobby fits comfortably inside one small frame.
  check(first.length < 700, `a full ${actors.length}-actor snapshot stays compact (${first.length} bytes)`);
});

suite('roster and match round trip', () => {
  const entries: RosterEntry[] = [
    { id: 1, name: 'Alpha', team: 1, kills: 9, deaths: 3, ping: 42, flags: 0, weapon: 0 },
    { id: 2, name: 'Bravo', team: 2, kills: 0, deaths: 11, ping: 250, flags: 64, weapon: 3 },
    { id: 3, name: 'ünïcode', team: 0, kills: 30, deaths: 0, ping: 7, flags: 1, weapon: 5 },
  ];
  const first = encodeRoster(entries);
  const decoded = decodeRoster(afterTag(first));
  check(decoded.length === entries.length, 'the roster length survives');
  check(decoded[2]?.name === 'ünïcode', 'roster names survive multi-byte UTF-8');
  check(decoded[1]?.ping === 250, 'a high ping is not truncated');
  check(decoded[1]?.flags === 64, 'the bot flag survives');
  // The staging room puts a weapon in each character's hands from this byte alone,
  // so a roster that decoded everybody's gun as slot 0 would be a lobby full of
  // people holding the same rifle and nothing on screen to say why.
  check(
    decoded.every((e, i) => e.weapon === entries[i]!.weapon),
    'and so does the weapon each of them is holding',
  );
  sameBytes(first, encodeRoster(decoded), 'roster re-encodes identically');

  const match = { timeLeft: 421_000, scoreA: 61, scoreB: 74, limit: 75, over: 1, playersOnline: 11 };
  const mFirst = encodeMatch(match);
  const mBack = decodeMatch(afterTag(mFirst));
  check(mBack.timeLeft === match.timeLeft, 'the clock survives');
  check(mBack.scoreA === match.scoreA && mBack.scoreB === match.scoreB, 'the scores survive');
  check(mBack.limit === match.limit, 'the score limit survives');
  check(mBack.over === match.over, 'the match-over flag survives');
  check(mBack.playersOnline === match.playersOnline, 'the player count survives');
  sameBytes(mFirst, encodeMatch(mBack), 'match state re-encodes identically');
});

suite('lobby round trip', () => {
  // Both directions, because the lobby is the one place where the client sends
  // something other than movement: an action the server may refuse.
  const msg = {
    phase: PHASE.LOBBY,
    hostId: 40_000,
    flags: LF.BOTS | LF.PARTY,
    countdown: 4_250,
  };
  const first = encodeLobby(msg);
  const back = decodeLobby(afterTag(first));
  check(back.phase === msg.phase, 'the phase survives');
  check(back.hostId === msg.hostId, 'a high host id is not truncated');
  check(back.flags === msg.flags, 'both room flags survive');
  check(back.countdown === msg.countdown, 'the countdown survives to the millisecond');
  sameBytes(first, encodeLobby(back), 'lobby state re-encodes identically');

  // The countdown is a u16, so it saturates rather than wrapping — a value that
  // wrapped would show as `0.0s` and read as "starting now" forever.
  check(
    decodeLobby(afterTag(encodeLobby({ ...msg, countdown: 90_000 }))).countdown === 65_535,
    'an out-of-range countdown clamps instead of wrapping',
  );

  const cmd = encodeLobbyCmd(LOBBY_ACT.BOTS, 1);
  const cmdBack = decodeLobbyCmd(afterTag(cmd));
  check(cmdBack.action === LOBBY_ACT.BOTS, 'the requested action survives');
  check(cmdBack.value === 1, 'and its value with it');
  sameBytes(cmd, encodeLobbyCmd(cmdBack.action, cmdBack.value), 'a lobby command re-encodes identically');
  sameBytes(encodeLobbyCmd(LOBBY_ACT.READY), encodeLobbyCmd(LOBBY_ACT.READY, 0), 'value defaults to 0');
});

suite('lobby and roster flags do not collide', () => {
  // Not pedantry. The scoreboard read roster entries with the *actor* flag table
  // for a while: bot was bit 6 there and bit 0 here, so every test came back
  // false and bots quietly stopped being labelled. Distinct single bits, checked
  // here, are what make that a compile-time concern rather than a silent one.
  const rf = Object.values(RF);
  check(new Set(rf).size === rf.length, `roster flags are distinct (${rf.join(', ')})`);
  check(
    rf.every((f) => f > 0 && (f & (f - 1)) === 0),
    'and each is a single bit',
  );
  check(rf.reduce((a, b) => a | b, 0) <= 0xff, 'the whole set fits the u8 the roster writes');

  const lf = Object.values(LF);
  check(new Set(lf).size === lf.length, 'lobby flags are distinct');
  check(lf.reduce((a, b) => a | b, 0) <= 0xff, 'and fit their u8 too');

  const phases = Object.values(PHASE);
  check(new Set(phases).size === phases.length, 'the three phases are three different numbers');
  const acts = Object.values(LOBBY_ACT);
  check(!acts.includes(0 as never), 'no lobby action is 0, so an empty packet asks for nothing');
});

/* ─────────────────────────────────────────────────────────────────────────────
   6. Weapon table
   ────────────────────────────────────────────────────────────────────────── */

suite('weapon table is coherent', () => {
  const ids = new Set<number>();
  const keys = new Set<string>();

  for (const w of WEAPONS) {
    check(!ids.has(w.id), `weapon id ${w.id} is unique`);
    check(!keys.has(w.key), `weapon key "${w.key}" is unique`);
    ids.add(w.id);
    keys.add(w.key);

    check(weaponById(w.id) === w, `weaponById finds ${w.key}`);
    check(WEAPON_BY_KEY[w.key] === w, `WEAPON_BY_KEY finds ${w.key}`);

    check(w.rpm > 0, `${w.key} has a positive fire rate`);
    check(w.damage > 0 && w.pellets >= 1, `${w.key} does damage`);
    check(w.headMult >= 1, `${w.key} never punishes a head hit`);
    check(w.falloffEnd >= w.falloffStart, `${w.key} falloff range is ordered`);
    check(w.spreadMax >= w.spreadBase, `${w.key} spread ceiling is at or above its floor`);
    check(w.minMult > 0 && w.minMult <= 1, `${w.key} distance multiplier is a fraction`);
    check(w.range > 0, `${w.key} has reach`);
    check(w.range >= w.falloffEnd || w.minMult >= 1, `${w.key} reach covers its own falloff curve`);
    check(w.switchTime > 0, `${w.key} takes time to draw`);
    check(w.moveMult > 0, `${w.key} does not freeze the player`);
    check(w.adsSpreadMult >= 0 && w.adsSpreadMult <= 1, `${w.key} aiming never widens the cone`);

    if (w.fireMode === 'melee') {
      check(w.magSize === 0 && w.reserveSize === 0, `${w.key} has no magazine`);
    } else {
      check(w.magSize > 0 && w.reserveSize > 0, `${w.key} carries ammunition`);
      check(w.reloadTime > 0, `${w.key} takes time to reload`);
      check(w.reserveSize >= w.magSize, `${w.key} carries at least one spare magazine`);
    }

    // Damage falloff must be monotone. A step *up* with distance would make
    // range a downside, which nothing in the table intends.
    let prev = Infinity;
    const stride = Math.max(0.5, w.range / 80);
    for (let d = 0; d <= w.range; d += stride) {
      const dmg = damageAtRange(w, d);
      check(dmg <= prev + 1e-9, `${w.key} damage never rises with distance (at ${d.toFixed(1)} m)`);
      prev = dmg;
    }
    near(damageAtRange(w, 0), w.damage, 1e-9, `${w.key} does full damage point blank`);
    near(damageAtRange(w, w.falloffStart), w.damage, 1e-9, `${w.key} holds full damage until falloff begins`);
    near(
      damageAtRange(w, w.falloffEnd + 10),
      w.damage * w.minMult,
      1e-6,
      `${w.key} bottoms out at its minimum multiplier`,
    );

    near(cycleTime(w), 60 / w.rpm, 1e-12, `${w.key} cycle time matches its rpm`);
  }

  check(
    WEAPONS.some((w) => w.slot === 'primary'),
    'there is at least one primary',
  );
  check(
    WEAPONS.some((w) => w.slot === 'secondary'),
    'there is at least one secondary',
  );
  check(
    WEAPONS.some((w) => w.slot === 'melee'),
    'there is a melee option',
  );

  // Melee, and the backstab in particular. These are coupling assertions: the
  // numbers live in three different files and nothing at runtime would complain
  // if they stopped agreeing — a backstab that quietly stopped killing would just
  // feel like the knife was broken, with no error anywhere to say why.
  const blade = WEAPONS.find((w) => w.fireMode === 'melee');
  check(blade !== undefined, 'the melee weapon is findable by fire mode');
  if (blade) {
    check(
      blade.damage * 2 >= MAX_HEALTH,
      `two ${blade.key} hits to the front kill (${blade.damage} × 2 vs ${MAX_HEALTH} health)`,
    );
    check(
      blade.damage < MAX_HEALTH,
      `but one does not (${blade.damage} vs ${MAX_HEALTH} health)`,
    );
  }
  check(
    MELEE_BACKSTAB_DAMAGE >= MAX_HEALTH,
    `a backstab is lethal (${MELEE_BACKSTAB_DAMAGE} vs ${MAX_HEALTH} health)`,
  );
  check(
    MELEE_BACKSTAB_DOT < 0,
    `a backstab requires being behind the victim, not beside them (dot ${MELEE_BACKSTAB_DOT})`,
  );
  check(
    MELEE_BACKSTAB_DOT >= -1,
    `and the backstab threshold is a reachable dot product (${MELEE_BACKSTAB_DOT})`,
  );
  // The swing animation is a coupling of the same kind, one file further out: the
  // view model plays a wind-up, a cut and a recovery over `MELEE_SWING`, and a
  // held melee that retriggers before the recovery has finished snaps the blade
  // back to the wind-up from mid-arc. Raising the knife's rate of fire is the way
  // that happens, and it would break the animation silently — the weapon would
  // still deal damage on exactly the same schedule.
  if (blade) {
    check(
      MELEE_SWING < cycleTime(blade),
      `the knife swing fits inside its own cycle (${MELEE_SWING}s vs ${cycleTime(blade).toFixed(3)}s)`,
    );
    check(MELEE_SWING > 0.1, `and is long enough to read as a swing (${MELEE_SWING}s)`);
  }

  // ── Ammunition economy ──────────────────────────────────────────────────
  // The resupply-on-kill only works inside a window. Too small and the reserve
  // is still a one-way countdown that strands whoever is winning with a knife;
  // large enough to refill the reserve outright and ammunition stops being a
  // resource at all. Neither failure raises anything at runtime.
  check(
    AMMO_REFILL_MAGS_PER_KILL >= 1,
    `a kill returns at least a full magazine (${AMMO_REFILL_MAGS_PER_KILL} mags)`,
  );
  for (const w of WEAPONS) {
    if (w.magSize <= 0) continue;
    const gain = Math.max(1, Math.round(w.magSize * AMMO_REFILL_MAGS_PER_KILL));
    check(gain >= w.magSize, `a kill buys ${w.key} a reload (${gain} vs mag ${w.magSize})`);
    check(
      gain < w.reserveSize,
      `but not a full resupply for ${w.key} (${gain} vs reserve ${w.reserveSize})`,
    );
    check(
      w.reserveSize >= w.magSize * 4,
      `${w.key} starts with real depth (${w.reserveSize} = ${(w.reserveSize / w.magSize).toFixed(1)} mags)`,
    );
  }

  // ── Sound model ─────────────────────────────────────────────────────────
  // The synthesiser reads these as a physical description of the shot, and one
  // constraint governs all of them: the percussive part has to finish before the
  // next round leaves the barrel. A shot longer than its own cycle time stops
  // being a thump and becomes a pitched note, and consecutive notes stack into a
  // chord — which is precisely what made sustained fire buzz before this table
  // was voiced. Nothing at runtime can detect it; it just sounds wrong.
  for (const w of WEAPONS) {
    const s = w.sfx;
    const cycle = cycleTime(w);
    check(s.gain > 0 && s.gain <= 1, `${w.key} shot level is a fraction (${s.gain})`);
    check(s.body > 0, `${w.key} has a fundamental`);
    check(s.crack > s.body, `${w.key} sweeps downward, from crack to body`);
    check(s.grit >= 0 && s.grit <= 1, `${w.key} saturation drive is a fraction (${s.grit})`);
    check(s.mech >= 0 && s.mech <= 1, `${w.key} action level is a fraction (${s.mech})`);
    check(s.mechFreq > 0, `${w.key} action has a resonance`);
    check(s.tail >= 0, `${w.key} tail length is not negative`);
    check(
      s.punch > 0 && s.punch < cycle,
      `${w.key} shot ends before the next one starts (${(s.punch * 1000) | 0} ms vs ${(cycle * 1000) | 0} ms cycle)`,
    );
    // Automatics get a tighter leash on the tail: ducking overlapping tails keeps
    // them from piling up, but a long one at fifteen rounds a second still drones.
    if (w.fireMode === 'auto') {
      check(
        s.tail <= cycle * 3,
        `${w.key} tail cannot drone under sustained fire (${(s.tail * 1000) | 0} ms vs ${(cycle * 3000) | 0} ms)`,
      );
    }
  }

  // ── View model proportions ──────────────────────────────────────────────
  // The gun is generated from these, and the builder branches on them: a
  // handguard appears past a barrel length, a magazine only if there is one, a
  // scope only for a weapon that zooms. A zero here produces a degenerate mesh
  // rather than an error.
  for (const w of WEAPONS) {
    const v = w.viz;
    check(v.bodyLen > 0 && v.bodyH > 0 && v.bodyW > 0, `${w.key} receiver has volume`);
    check(v.barrelLen > 0 && v.barrelR > 0, `${w.key} has a barrel`);
    check(v.magLen >= 0, `${w.key} magazine length is not negative`);
    check(v.color !== v.accent, `${w.key} accent reads against its body colour`);
    if (w.fireMode === 'melee') {
      check(v.magLen === 0 && !v.stock, `${w.key} is not built like a gun`);
    }
    check(
      !w.scoped || w.adsFovMult < 0.5,
      `${w.key} only wears a scope if it actually zooms (${w.adsFovMult})`,
    );
  }

  // ── Muzzle flash inputs ─────────────────────────────────────────────────
  // The view model sizes the muzzle flash from `viz.barrelR` and `sfx.gain` —
  // bore and charge, the two things that decide how big a fireball a gun makes.
  // That gives `sfx.gain` three consumers: it was added to voice the shot, and it
  // now also sizes the view model's flash and the world flash drawn at another
  // player's muzzle, so someone retuning it purely by ear would silently resize
  // both.
  //
  // What is asserted is the ordering the visual depends on, not the arithmetic
  // the client does with it. A 12-gauge has to throw the biggest flash and a
  // pistol the smallest, and the spread has to be wide enough to see — a roster
  // where every flash is the same size is the thing this replaced.
  const flashInput = (w: (typeof WEAPONS)[number]): number =>
    w.viz.barrelR * 22 + w.sfx.gain * 0.55;
  const firearms = WEAPONS.filter((w) => w.fireMode !== 'melee');
  const biggest = firearms.reduce((a, b) => (flashInput(a) >= flashInput(b) ? a : b));
  const smallest = firearms.reduce((a, b) => (flashInput(a) <= flashInput(b) ? a : b));
  check(
    biggest.key === 'breacher',
    `the shotgun throws the biggest muzzle flash (got ${biggest.key})`,
  );
  check(
    smallest.key === 'sidearm',
    `the pistol throws the smallest muzzle flash (got ${smallest.key})`,
  );
  check(
    flashInput(biggest) > flashInput(smallest) * 1.4,
    `flash size varies enough across the roster to read (${flashInput(biggest).toFixed(
      2,
    )} vs ${flashInput(smallest).toFixed(2)})`,
  );
});

/* ─────────────────────────────────────────────────────────────────────────────
   7. Determinism — the property client prediction rests on
   ────────────────────────────────────────────────────────────────────────── */

suite('movement is deterministic', () => {
  const brushes = mapColliders(MAPS[0]!);
  const spawn = MAPS[0]!.spawns[3]!;

  const play = (): MoveState => {
    const s: MoveState = {
      pos: v3(spawn.x, spawn.y, spawn.z),
      vel: v3(0, 0, 0),
      onGround: false,
      crouching: false,
      height: PLAYER_HEIGHT,
    };
    const rng = makeRng(99);
    const cmd = newInputCmd();
    cmd.yaw = spawn.yaw;
    for (let i = 0; i < 600; i++) {
      cmd.seq = i + 1;
      cmd.forward = Math.round(rng() * 2 - 1);
      cmd.right = Math.round(rng() * 2 - 1);
      cmd.yaw = wrapAngle(cmd.yaw + (rng() - 0.5) * 0.3);
      cmd.buttons = rng() < 0.02 ? BTN.JUMP : rng() < 0.15 ? BTN.CROUCH : 0;
      stepMovement(s, cmd, brushes, 1, TICK_DT);
    }
    return s;
  };

  const a = play();
  const b = play();
  // Bit for bit, not approximately. The client replays unacknowledged inputs
  // through this same function and compares the result with the server's; any
  // divergence at all surfaces as rubber-banding.
  check(
    a.pos.x === b.pos.x && a.pos.y === b.pos.y && a.pos.z === b.pos.z,
    'identical input gives a bit-identical position',
  );
  check(a.vel.x === b.vel.x && a.vel.y === b.vel.y && a.vel.z === b.vel.z, 'and a bit-identical velocity');
  check(a.onGround === b.onGround && a.crouching === b.crouching && a.height === b.height, 'and an identical stance');

  // And the seeded generator is itself reproducible, or none of the above means
  // anything.
  const r1 = makeRng(1234);
  const r2 = makeRng(1234);
  let same = true;
  for (let i = 0; i < 100; i++) if (r1() !== r2()) same = false;
  check(same, 'the seeded generator is reproducible');
});

/* ─────────────────────────────────────────────────────────────────────────────
   Report
   ────────────────────────────────────────────────────────────────────────── */

const total = passed + failures.length;
if (failures.length === 0) {
  console.log(`\n  ${total} checks passed.\n`);
  process.exit(0);
}

console.error(`\n  ${passed} of ${total} checks passed, ${failures.length} failed:\n`);
for (const f of failures) console.error(`  ✗ ${f}`);
console.error('');
process.exit(1);
