/**
 * Map definition. Levels are built from axis-aligned brushes only, which means the
 * geometry the player sees and the geometry the player collides with are literally
 * the same array — there is no separate collision mesh to fall out of sync.
 *
 * The whole level is generated in code: no model files, no textures. See
 * docs/RESEARCH.md §2 — the original ships only five static assets, so its world is
 * procedural too.
 */

import { boxFrom, type Box } from './collision';

export type MatKey =
  | 'sand'
  | 'sandDark'
  | 'concrete'
  | 'concreteDark'
  | 'rust'
  | 'wood'
  | 'metal'
  | 'accent'
  | 'glass';

export interface Material {
  color: number;
  roughness: number;
  metalness: number;
  opacity?: number;
}

export const MATERIALS: Record<MatKey, Material> = {
  sand: { color: 0xc9a97b, roughness: 0.96, metalness: 0 },
  sandDark: { color: 0xa8875c, roughness: 0.95, metalness: 0 },
  concrete: { color: 0x9d9c93, roughness: 0.88, metalness: 0 },
  concreteDark: { color: 0x76756e, roughness: 0.9, metalness: 0 },
  rust: { color: 0x8d5b3d, roughness: 0.84, metalness: 0.12 },
  wood: { color: 0x8a6a45, roughness: 0.82, metalness: 0 },
  metal: { color: 0x6e747a, roughness: 0.45, metalness: 0.65 },
  accent: { color: 0x3d78b4, roughness: 0.6, metalness: 0.2 },
  glass: { color: 0x9fc4d8, roughness: 0.15, metalness: 0.1, opacity: 0.35 },
};

export interface Brush {
  /** Footprint centre. */
  x: number;
  z: number;
  /** Bottom of the brush. */
  y: number;
  sx: number;
  sy: number;
  sz: number;
  mat: MatKey;
}

export interface Spawn {
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface GameMap {
  id: number;
  key: string;
  name: string;
  half: number;
  brushes: Brush[];
  spawns: Spawn[];
  sky: number;
  fog: number;
  fogNear: number;
  fogFar: number;
  sun: { x: number; y: number; z: number };
  sunColor: number;
  ambientColor: number;
  ambientGround: number;
  ambientIntensity: number;
}

export function brushToBox(b: Brush): Box {
  return boxFrom(b.x, b.y, b.z, b.sx, b.sy, b.sz);
}

// ── Builder helpers ──────────────────────────────────────────────────────────

function br(
  out: Brush[],
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
  mat: MatKey,
): void {
  if (sx <= 0.001 || sy <= 0.001 || sz <= 0.001) return;
  out.push({ x, y, z, sx, sy, sz, mat });
}

interface Door {
  /** Centre along the wall's run. */
  at: number;
  width: number;
  height: number;
}

/**
 * A wall running along one axis, optionally with a doorway punched through it and a
 * lintel above the gap so the opening reads as a door rather than a missing panel.
 */
function wall(
  out: Brush[],
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  y: number,
  h: number,
  thick: number,
  mat: MatKey,
  door?: Door,
): void {
  const segments: Array<[number, number]> = [];
  if (door) {
    const d0 = door.at - door.width / 2;
    const d1 = door.at + door.width / 2;
    if (d0 > from) segments.push([from, d0]);
    if (d1 < to) segments.push([d1, to]);
    // lintel over the opening
    if (h > door.height) {
      const len = Math.min(d1, to) - Math.max(d0, from);
      const mid = (Math.max(d0, from) + Math.min(d1, to)) / 2;
      if (axis === 'x') br(out, mid, y + door.height, fixed, len, h - door.height, thick, mat);
      else br(out, fixed, y + door.height, mid, thick, h - door.height, len, mat);
    }
  } else {
    segments.push([from, to]);
  }

  for (const [a, b] of segments) {
    const len = b - a;
    const mid = (a + b) / 2;
    if (axis === 'x') br(out, mid, y, fixed, len, h, thick, mat);
    else br(out, fixed, y, mid, thick, h, len, mat);
  }
}

/** A run of steps. `dir` is the direction of ascent. */
function stairs(
  out: Brush[],
  x: number,
  y: number,
  z: number,
  dir: 'x+' | 'x-' | 'z+' | 'z-',
  steps: number,
  stepH: number,
  stepD: number,
  width: number,
  mat: MatKey,
): void {
  for (let i = 0; i < steps; i++) {
    const h = (i + 1) * stepH;
    const off = (i + 0.5) * stepD;
    switch (dir) {
      case 'x+':
        br(out, x + off, y, z, stepD, h, width, mat);
        break;
      case 'x-':
        br(out, x - off, y, z, stepD, h, width, mat);
        break;
      case 'z+':
        br(out, x, y, z + off, width, h, stepD, mat);
        break;
      case 'z-':
        br(out, x, y, z - off, width, h, stepD, mat);
        break;
    }
  }
}

/**
 * The four quadrant signs. Every map here is rotationally or mirror symmetric —
 * that is not a stylistic preference but a fairness requirement, since a spawn
 * that reaches the middle first wins fights it should not — so the same four-way
 * loop appears in each of them.
 */
const CORNERS = [
  [-1, -1],
  [1, -1],
  [-1, 1],
  [1, 1],
] as const;

/**
 * The yaw that makes a player at `(x, z)` look at the origin.
 *
 * One line, but it earns a name: forward is `(-sin yaw, 0, -cos yaw)`, so aiming
 * at the centre wants `atan2(x, z)` — and the sign of that is not something worth
 * re-deriving once per map. Hand-written yaws are the classic silent map bug,
 * because a spawn facing backwards is perfectly legal geometry and only shows up
 * as players who die a second after appearing.
 */
function faceCentre(x: number, z: number): number {
  return Math.atan2(x, z);
}

/** A four-walled structure with a roof slab and a parapet you can crouch behind. */
function building(
  out: Brush[],
  cx: number,
  cz: number,
  w: number,
  d: number,
  h: number,
  mat: MatKey,
  roofMat: MatKey,
  doors: { north?: boolean; south?: boolean; east?: boolean; west?: boolean },
): void {
  const t = 0.5;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;
  const door: Door = { at: 0, width: 2.6, height: 2.5 };

  wall(out, 'x', z0, x0, x1, 0, h, t, mat, doors.north ? { ...door, at: cx } : undefined);
  wall(out, 'x', z1, x0, x1, 0, h, t, mat, doors.south ? { ...door, at: cx } : undefined);
  wall(out, 'z', x0, z0, z1, 0, h, t, mat, doors.west ? { ...door, at: cz } : undefined);
  wall(out, 'z', x1, z0, z1, 0, h, t, mat, doors.east ? { ...door, at: cz } : undefined);

  // roof slab, then a low parapet around it
  br(out, cx, h, cz, w + t, 0.4, d + t, roofMat);
  const ry = h + 0.4;
  wall(out, 'x', z0, x0, x1, ry, 0.9, t, roofMat);
  wall(out, 'x', z1, x0, x1, ry, 0.9, t, roofMat);
  wall(out, 'z', x0, z0, z1, ry, 0.9, t, roofMat);
  wall(out, 'z', x1, z0, z1, ry, 0.9, t, roofMat);
}

// ── Dustworks ────────────────────────────────────────────────────────────────

function buildDustworks(): GameMap {
  const b: Brush[] = [];
  const HALF = 30;

  // Floor, sunk so its top face sits exactly at y = 0.
  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'sand');

  // Perimeter wall.
  const PW = 8;
  wall(b, 'x', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'sandDark');
  wall(b, 'x', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'sandDark');
  wall(b, 'z', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'sandDark');
  wall(b, 'z', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'sandDark');

  // ── Centre: raised platform, reachable from all four sides ────────────────
  const PLAT = 13;
  const PLAT_H = 1.5;
  br(b, 0, 0, 0, PLAT, PLAT_H, PLAT, 'concrete');
  stairs(b, 0, 0, PLAT / 2, 'z-', 5, PLAT_H / 5, 0.42, 4.4, 'concreteDark');
  stairs(b, 0, 0, -PLAT / 2, 'z+', 5, PLAT_H / 5, 0.42, 4.4, 'concreteDark');
  stairs(b, PLAT / 2, 0, 0, 'x-', 5, PLAT_H / 5, 0.42, 4.4, 'concreteDark');
  stairs(b, -PLAT / 2, 0, 0, 'x+', 5, PLAT_H / 5, 0.42, 4.4, 'concreteDark');

  // Cover on the platform: a broken ring so it can be fought over.
  br(b, 0, PLAT_H, 0, 3.4, 2.6, 3.4, 'concreteDark');
  br(b, -4.4, PLAT_H, -4.4, 2.2, 1.1, 2.2, 'rust');
  br(b, 4.4, PLAT_H, 4.4, 2.2, 1.1, 2.2, 'rust');
  br(b, -4.4, PLAT_H, 4.4, 2.2, 1.1, 2.2, 'rust');
  br(b, 4.4, PLAT_H, -4.4, 2.2, 1.1, 2.2, 'rust');

  // ── Four corner buildings, rotationally symmetric ─────────────────────────
  const C = 18.5;
  const BW = 12;
  const BH = 4.4;
  building(b, -C, -C, BW, BW, BH, 'concrete', 'concreteDark', { south: true, east: true });
  building(b, C, -C, BW, BW, BH, 'concrete', 'concreteDark', { south: true, west: true });
  building(b, -C, C, BW, BW, BH, 'concrete', 'concreteDark', { north: true, east: true });
  building(b, C, C, BW, BW, BH, 'concrete', 'concreteDark', { north: true, west: true });

  // Stair stacks up the outer face of each building to its roof.
  const rise = BH + 0.4;
  const steps = 11;
  stairs(b, -C, 0, -C - BW / 2 - 0.6, 'z-', steps, rise / steps, 0.5, 3.2, 'wood');
  stairs(b, C, 0, -C - BW / 2 - 0.6, 'z-', steps, rise / steps, 0.5, 3.2, 'wood');
  stairs(b, -C, 0, C + BW / 2 + 0.6, 'z+', steps, rise / steps, 0.5, 3.2, 'wood');
  stairs(b, C, 0, C + BW / 2 + 0.6, 'z+', steps, rise / steps, 0.5, 3.2, 'wood');

  // Interior crate in each building, so the inside isn't an empty box.
  for (const [sx, sz] of CORNERS) {
    br(b, C * sx + 3 * sx, 0, C * sz + 3 * sz, 2, 1.2, 2, 'wood');
    br(b, C * sx - 3.5 * sx, 0, C * sz - 3.5 * sz, 1.4, 2.4, 1.4, 'rust');
  }

  // ── Mid-field cover: four L-walls forming rotational half-cover ────────────
  for (const [sx, sz] of CORNERS) {
    wall(b, 'x', 11.5 * sz, 2.5 * sx, 10.5 * sx, 0, 2.6, 0.6, 'sandDark');
    wall(b, 'z', 11.5 * sx, 2.5 * sz, 10.5 * sz, 0, 2.6, 0.6, 'sandDark');
  }

  // ── Flank lanes along the perimeter, with gaps to shoot through ────────────
  for (const s of [-1, 1] as const) {
    wall(b, 'x', 26 * s, -12, -3, 0, 2.2, 0.6, 'rust');
    wall(b, 'x', 26 * s, 3, 12, 0, 2.2, 0.6, 'rust');
    wall(b, 'z', 26 * s, -12, -3, 0, 2.2, 0.6, 'rust');
    wall(b, 'z', 26 * s, 3, 12, 0, 2.2, 0.6, 'rust');
  }

  // ── Scattered crates for micro-cover and jump routes ──────────────────────
  const crates: Array<[number, number, number, MatKey]> = [
    [-9, -20, 1.3, 'wood'],
    [9, -20, 1.3, 'wood'],
    [-9, 20, 1.3, 'wood'],
    [9, 20, 1.3, 'wood'],
    [-20, -9, 1.3, 'wood'],
    [20, -9, 1.3, 'wood'],
    [-20, 9, 1.3, 'wood'],
    [20, 9, 1.3, 'wood'],
    [0, -22, 1.7, 'rust'],
    [0, 22, 1.7, 'rust'],
    [-22, 0, 1.7, 'rust'],
    [22, 0, 1.7, 'rust'],
  ];
  for (const [x, z, s, m] of crates) {
    br(b, x, 0, z, s, s, s, m);
    // a smaller crate beside each, forming a two-step climb
    br(b, x + s * 0.9, 0, z, s * 0.62, s * 0.62, s * 0.62, m);
  }

  // ── Spawns: ringed, facing inward, never facing another spawn directly ────
  const spawns: Spawn[] = [];
  const R = 24.5;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
    const x = Math.sin(a) * R;
    const z = Math.cos(a) * R;
    // face the centre: yaw such that forward (-sin y, 0, -cos y) points at origin
    spawns.push({ x, y: 0.05, z, yaw: faceCentre(x, z) });
  }

  return {
    id: 0,
    key: 'dustworks',
    name: 'Dustworks',
    half: HALF,
    brushes: b,
    spawns,
    sky: 0x8ab4d8,
    fog: 0xc2d2de,
    fogNear: 40,
    fogFar: 145,
    sun: { x: -0.45, y: 0.82, z: 0.36 },
    sunColor: 0xfff2dc,
    ambientColor: 0xbcd4ea,
    ambientGround: 0xa08a68,
    ambientIntensity: 0.85,
  };
}

// ── Foundry ──────────────────────────────────────────────────────────────────

/**
 * An indoor industrial hall: a furnace in the middle solid enough to break every
 * centre sightline, and two catwalks running the length of it.
 *
 * It is deliberately the opposite map to Dustworks. That one is an open
 * courtyard around a raised middle, which rewards whoever saw the other player
 * first and gives a sniper the whole arena. Here the centre cannot be held from
 * anywhere — the furnace blocks it in every direction — and the only long shots
 * are down the two side lanes, both overlooked from a catwalk you have to walk to
 * the end of the hall to climb. A player who wants distance has to give up the
 * middle to get it, which is the trade Dustworks never asks for.
 *
 * Smaller than Dustworks too (48 m against 60), because a map without long
 * sightlines does not need the space and fights should start sooner.
 */
function buildFoundry(): GameMap {
  const b: Brush[] = [];
  const HALF = 24;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'concreteDark');

  // Shell. Taller than Dustworks' perimeter because this one is a building
  // rather than a compound wall, and a 10 m wall stops a bunny-hopper reaching
  // the top of it from the catwalks.
  const PW = 10;
  wall(b, 'x', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'concrete');
  wall(b, 'x', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'concrete');
  wall(b, 'z', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'concrete');
  wall(b, 'z', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'concrete');

  // ── The furnace ───────────────────────────────────────────────────────────
  // One solid block, and nothing anywhere touches it that would let you walk up.
  const FURN_H = 4.8;
  br(b, 0, 0, 0, 9, FURN_H, 9, 'metal');
  for (const [sx, sz] of CORNERS) {
    // Flues on top, and a heat-shield skirt at the base to crouch behind while
    // working around the block.
    br(b, 3 * sx, FURN_H, 3 * sz, 1.5, 2.6, 1.5, 'rust');
    br(b, 6.6 * sx, 0, 6.6 * sz, 2.6, 1.2, 2.6, 'rust');
  }

  // Ducting off two faces of the furnace, stepping 2.2 → 3.6. The last 1.2 m to
  // the roof is a jump, not a step: 7.4 m/s against 22 m/s² of gravity clears
  // about 1.24 m, so the route exists but has to be learned and committed to.
  // A staircase here would hand out the best position on the map.
  for (const s of [-1, 1] as const) {
    br(b, 0, 0, 7.4 * s, 3.2, 2.2, 2.2, 'metal');
    br(b, 0, 2.2, 10.4 * s, 3.2, 1.4, 2.2, 'metal');
  }

  // ── Catwalks down both long sides ─────────────────────────────────────────
  // 12 steps of 0.35 exactly reaches the walking surface, and 0.35 is also the
  // step-up height, so the climb works whether the player walks or hops it.
  const CAT_X = 13;
  const CAT_TOP = 4.2;
  for (const s of [-1, 1] as const) {
    br(b, CAT_X * s, CAT_TOP - 0.4, 0, 3.2, 0.4, 32, 'metal');
    // Outer railing runs the whole length; the inner one is broken in the middle
    // so the catwalk has a way down onto the furnace side rather than being a
    // corridor with two exits, both of them at the ends.
    wall(b, 'z', (CAT_X + 1.6) * s, -16, 16, CAT_TOP, 1, 0.15, 'metal');
    wall(b, 'z', (CAT_X - 1.6) * s, -16, -5, CAT_TOP, 1, 0.15, 'metal');
    wall(b, 'z', (CAT_X - 1.6) * s, 5, 16, CAT_TOP, 1, 0.15, 'metal');
    stairs(b, CAT_X * s, 0, -22, 'z+', 12, CAT_TOP / 12, 0.5, 3, 'metal');
    stairs(b, CAT_X * s, 0, 22, 'z-', 12, CAT_TOP / 12, 0.5, 3, 'metal');
  }

  // ── Floor clutter ─────────────────────────────────────────────────────────
  for (const s of [-1, 1] as const) {
    // Presses at the ends of the hall, tall enough to break the shot down the
    // middle of the aisle without blocking the aisle itself.
    br(b, 0, 0, 14 * s, 6, 1.8, 2.4, 'metal');
    // Racking along the side lanes, under the catwalks.
    br(b, 18 * s, 0, 0, 2.4, 3.4, 9, 'rust');
    for (const t of [-1, 1] as const) {
      br(b, 8 * s, 0, 13 * t, 1.8, 1.8, 1.8, 'wood');
      br(b, 8 * s + 1.5 * s, 0, 13 * t, 1.1, 1.1, 1.1, 'wood');
    }
  }

  // ── Spawns ────────────────────────────────────────────────────────────────
  // Along the two end walls and the two side lanes, all at floor level: the
  // catwalks are earned, never spawned onto.
  const spawns: Spawn[] = [];
  for (const s of [-1, 1] as const) {
    for (const x of [-20, -8, 8, 20]) spawns.push({ x, y: 0.05, z: 20 * s, yaw: faceCentre(x, 20 * s) });
    for (const z of [-5, 5]) spawns.push({ x: 21 * s, y: 0.05, z, yaw: faceCentre(21 * s, z) });
  }

  return {
    id: 1,
    key: 'foundry',
    name: 'Foundry',
    half: HALF,
    brushes: b,
    spawns,
    // Indoors, so the "sky" is only ever glimpsed and the fog closes in fast —
    // which is also what sells the space as enclosed from inside it.
    sky: 0x3b444e,
    fog: 0x4a5158,
    fogNear: 18,
    fogFar: 82,
    sun: { x: 0.3, y: 0.9, z: -0.28 },
    sunColor: 0xffe0b4,
    ambientColor: 0x8fa2b4,
    ambientGround: 0x4c4a46,
    ambientIntensity: 0.7,
  };
}

// ── Overpass ─────────────────────────────────────────────────────────────────

/**
 * A road deck on pillars crossing the whole arena, with ramps at both ends.
 *
 * This is the map the Longshot is for. The deck is 44 m of unbroken sightline
 * and the highest ground on the map, so holding it is worth doing — but it is
 * reachable only from the two far ends, it has a gap in its parapet at the
 * midpoint that anyone below can shoot up through, and everything under it is
 * covered. The result is that the deck is strong and losing it is survivable,
 * which is the only version of a sniper lane that does not decide the match.
 *
 * The biggest of the five at 68 m, because the sightline is the point.
 */
function buildOverpass(): GameMap {
  const b: Brush[] = [];
  const HALF = 34;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'sand');

  const PW = 11;
  wall(b, 'x', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'sandDark');
  wall(b, 'x', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'sandDark');
  wall(b, 'z', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'sandDark');
  wall(b, 'z', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'sandDark');

  // ── The deck ──────────────────────────────────────────────────────────────
  const DECK_Y = 5.5;
  const DECK_TOP = DECK_Y + 0.6;
  const DECK_X = 22;
  br(b, 0, DECK_Y, 0, DECK_X * 2, 0.6, 11, 'concrete');

  // Parapets, broken either side of the midpoint. The gap is the whole balance
  // of the map: it is the one place a player on the deck can be shot at from the
  // ground, and the one place they can drop off without walking to an end.
  for (const s of [-1, 1] as const) {
    wall(b, 'x', 5.5 * s, -DECK_X, -7, DECK_TOP, 1.1, 0.5, 'concreteDark');
    wall(b, 'x', 5.5 * s, 7, DECK_X, DECK_TOP, 1.1, 0.5, 'concreteDark');
  }

  // Pillars. Also the cover for whoever is fighting underneath.
  for (const x of [-18, -9, 0, 9, 18]) {
    for (const s of [-1, 1] as const) br(b, x, 0, 3.6 * s, 1.8, DECK_Y, 1.8, 'concreteDark');
  }

  // Ramps at both ends, descending outward from the deck. 18 steps of 0.339 —
  // under the 0.35 step-up, so it is walkable rather than a stack to hop.
  const RAMP_STEPS = 18;
  stairs(b, 31, 0, 0, 'x-', RAMP_STEPS, DECK_TOP / RAMP_STEPS, 0.5, 5.4, 'concreteDark');
  stairs(b, -31, 0, 0, 'x+', RAMP_STEPS, DECK_TOP / RAMP_STEPS, 0.5, 5.4, 'concreteDark');

  // ── Ground level ──────────────────────────────────────────────────────────
  // A container across the midpoint, directly under the parapet gap, so the
  // ground fight there has cover of its own.
  br(b, 0, 0, 0, 6, 2.4, 2.6, 'rust');
  for (const [sx, sz] of CORNERS) {
    // Flanking buildings with roofs, midway between the deck and the corners.
    building(b, 15 * sx, 20 * sz, 11, 11, 5, 'sandDark', 'concreteDark', {
      north: sz > 0,
      south: sz < 0,
      west: sx > 0,
      east: sx < 0,
    });
    br(b, 15 * sx, 0, 20 * sz + 3.5 * -sz, 2, 1.2, 2, 'wood');
    br(b, 11 * sx, 0, 8 * sz, 2.2, 1.4, 2.2, 'wood');
    br(b, 26 * sx, 0, 12 * sz, 1.8, 2.6, 1.8, 'rust');
  }
  // Low walls along the two side lanes, with a gap at the middle of each.
  for (const s of [-1, 1] as const) {
    wall(b, 'x', 26 * s, -18, -7, 0, 2.4, 0.6, 'rust');
    wall(b, 'x', 26 * s, 7, 18, 0, 2.4, 0.6, 'rust');
  }

  // ── Spawns ────────────────────────────────────────────────────────────────
  // Behind the ramp feet and along the two side lanes. None of them can see the
  // deck's midpoint, so nobody spawns already in a sniper's scope.
  const spawns: Spawn[] = [];
  for (const [sx, sz] of CORNERS) {
    for (const [x, z] of [
      [30.5 * sx, 14 * sz],
      [8 * sx, 30 * sz],
      [25 * sx, 25 * sz],
    ] as const) {
      spawns.push({ x, y: 0.05, z, yaw: faceCentre(x, z) });
    }
  }

  return {
    id: 2,
    key: 'overpass',
    name: 'Overpass',
    half: HALF,
    brushes: b,
    spawns,
    // Late afternoon, low sun down the length of the deck. The fog is pushed
    // well out because a map built around a 44 m shot cannot grey out at 40 m.
    sky: 0xd8b489,
    fog: 0xe0c9a8,
    fogNear: 60,
    fogFar: 190,
    sun: { x: 0.86, y: 0.42, z: 0.12 },
    sunColor: 0xffdca6,
    ambientColor: 0xd6c4a8,
    ambientGround: 0x9c7f56,
    ambientIntensity: 0.9,
  };
}

// ── Meridian ─────────────────────────────────────────────────────────────────

/**
 * Two mirrored bases at opposite ends with a raised walkway between them — the
 * map built for team deathmatch rather than adapted to it.
 *
 * Every other map here is rotationally symmetric and ringed with spawns, which
 * is right for a free-for-all and wrong for teams: it puts both teams
 * everywhere, so there is no ground to hold and no direction that means
 * "forward". This one is mirror symmetric about one axis instead, with all six
 * of each side's spawns inside and behind its own base. That gives a team a back
 * line to fall back to, a front to push, and a middle worth contesting — and it
 * is why the spawn chooser preferring to put you near a teammate produces a
 * defensible position here instead of a random one.
 */
function buildMeridian(): GameMap {
  const b: Brush[] = [];
  const HALF = 32;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'concrete');

  const PW = 10;
  wall(b, 'x', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'concreteDark');
  wall(b, 'x', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'concreteDark');
  wall(b, 'z', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'concreteDark');
  wall(b, 'z', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'concreteDark');

  // ── The two bases ─────────────────────────────────────────────────────────
  // Doors on the inward face and both flanks, none at the back: a base is a
  // position to hold, and one that can be entered from behind is not.
  for (const s of [-1, 1] as const) {
    building(b, 0, 24 * s, 22, 11, 5, 'concrete', 'accent', {
      north: s > 0,
      south: s < 0,
      east: true,
      west: true,
    });
    br(b, 0, 0, 21 * s, 3, 1.4, 2.5, 'metal');
    for (const t of [-1, 1] as const) {
      br(b, 8.5 * t, 0, 27 * s, 2, 2.2, 2, 'rust');
    }
  }

  // ── The walkway ───────────────────────────────────────────────────────────
  // Runs base to base, so pushing along it is pushing at the enemy. Railings
  // broken in the middle, which is where a fight on it is decided.
  const BR_Y = 3.4;
  const BR_TOP = BR_Y + 0.5;
  br(b, 0, BR_Y, 0, 8, 0.5, 22, 'metal');
  for (const s of [-1, 1] as const) {
    wall(b, 'z', 4 * s, -11, -3, BR_TOP, 1, 0.2, 'metal');
    wall(b, 'z', 4 * s, 3, 11, BR_TOP, 1, 0.2, 'metal');
    stairs(b, 0, 0, 17 * s, `z${s > 0 ? '-' : '+'}`, 12, BR_TOP / 12, 0.5, 5, 'metal');
  }

  // ── The courtyard ─────────────────────────────────────────────────────────
  for (const [sx, sz] of CORNERS) {
    br(b, 16 * sx, 0, 8 * sz, 6, 2.6, 2.6, 'rust');
    br(b, 24 * sx, 0, 16 * sz, 2.6, 1.5, 2.6, 'wood');
    br(b, 7 * sx, 0, 14 * sz, 2.2, 1.2, 2.2, 'wood');
  }
  // Under-walkway cover, so crossing the middle at ground level is possible.
  for (const s of [-1, 1] as const) br(b, 0, 0, 6 * s, 3, 1.5, 3, 'rust');
  // Side-lane screens: the flanks are a real route, not an empty margin.
  for (const s of [-1, 1] as const) {
    wall(b, 'z', 22 * s, -6, 6, 0, 2.8, 0.6, 'concreteDark');
    br(b, 28 * s, 0, 0, 2.4, 3.2, 7, 'concreteDark');
  }

  // ── Spawns: six per base, all of them behind that base's own front wall ───
  const spawns: Spawn[] = [];
  for (const s of [-1, 1] as const) {
    // Facing the centre, which for a team map means facing the enemy base.
    for (const x of [-7, 0, 7]) spawns.push({ x, y: 0.05, z: 25 * s, yaw: faceCentre(x, 25 * s) });
    for (const x of [-9, 0, 9]) spawns.push({ x, y: 0.05, z: 30.5 * s, yaw: faceCentre(x, 30.5 * s) });
  }

  return {
    id: 3,
    key: 'meridian',
    name: 'Meridian',
    half: HALF,
    brushes: b,
    spawns,
    sky: 0x9fb6c4,
    fog: 0xc4d0d6,
    fogNear: 46,
    fogFar: 160,
    sun: { x: -0.2, y: 0.9, z: 0.38 },
    sunColor: 0xfff4e6,
    ambientColor: 0xc2d2de,
    ambientGround: 0x8b8f92,
    ambientIntensity: 0.88,
  };
}

// ── Cistern ──────────────────────────────────────────────────────────────────

/**
 * The small one: a sunken floor with a walkway ring around it, 40 m across.
 *
 * Every map above is built so that a fight can be declined — there is always a
 * flank, a lane, a way to disengage and reset. This one is built so it cannot
 * be. The ring is the only high ground and it looks down into the whole of the
 * middle; the middle has cover but no exit that is not a ramp someone can watch.
 * At 40 m with twelve players, contact is immediate and continuous, which is
 * what the Breacher and the Blade need and what none of the larger maps give
 * them.
 *
 * It is the shortest map in the rotation on purpose. A map this relentless is
 * excellent for a round and exhausting for three.
 */
function buildCistern(): GameMap {
  const b: Brush[] = [];
  const HALF = 20;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'concreteDark');

  const PW = 8;
  wall(b, 'x', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'concrete');
  wall(b, 'x', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'concrete');
  wall(b, 'z', -HALF + 0.5, -HALF, HALF, 0, PW, 1, 'concrete');
  wall(b, 'z', HALF - 0.5, -HALF, HALF, 0, PW, 1, 'concrete');

  // ── The ring ──────────────────────────────────────────────────────────────
  // 1.6 m up: above the 1.24 m a jump clears, so the ramps are the only way up
  // and the ring is a position rather than a ledge. The floor is a full slab
  // underneath it all — the "sunken" middle is the rest of the map being raised,
  // which means there is no hole in the world to fall through.
  const RING_Y = 1.6;
  for (const s of [-1, 1] as const) {
    br(b, 0, 0, 16.25 * s, 38, RING_Y, 5.5, 'concrete');
    br(b, 16.25 * s, 0, 0, 5.5, RING_Y, 27, 'concrete');
    // Inner parapet, open where the ramp arrives.
    wall(b, 'x', 13.5 * s, -19, -3, RING_Y, 1, 0.4, 'metal');
    wall(b, 'x', 13.5 * s, 3, 19, RING_Y, 1, 0.4, 'metal');
    wall(b, 'z', 13.5 * s, -13.5, -3, RING_Y, 1, 0.4, 'metal');
    wall(b, 'z', 13.5 * s, 3, 13.5, RING_Y, 1, 0.4, 'metal');
    // Ramps down into the middle, one per side.
    stairs(b, 0, 0, 10.5 * s, `z${s > 0 ? '+' : '-'}`, 5, RING_Y / 5, 0.6, 5, 'concreteDark');
    stairs(b, 10.5 * s, 0, 0, `x${s > 0 ? '+' : '-'}`, 5, RING_Y / 5, 0.6, 5, 'concreteDark');
  }

  // ── The middle ────────────────────────────────────────────────────────────
  br(b, 0, 0, 0, 5, 2.2, 5, 'metal');
  for (const [sx, sz] of CORNERS) {
    // Columns carrying the roof that is not modelled, tall enough to break the
    // ring's view of the opposite ramp.
    br(b, 7 * sx, 0, 7 * sz, 1.6, 3.4, 1.6, 'concrete');
    br(b, 10 * sx, 0, 5 * sz, 1.8, 1.8, 1.8, 'rust');
    br(b, 4 * sx, 0, 11 * sz, 1.5, 1.1, 1.5, 'wood');
  }

  // ── Spawns: four on the ring, eight in the middle ─────────────────────────
  const spawns: Spawn[] = [];
  for (const [sx, sz] of CORNERS) {
    // One on the ring's corner, one down in the pit diagonally inside it.
    for (const [x, y, z] of [
      [16.2 * sx, RING_Y + 0.05, 16.2 * sz],
      [9.5 * sx, 0.05, 9.5 * sz],
    ] as const) {
      spawns.push({ x, y, z, yaw: faceCentre(x, z) });
    }
  }
  // Fill to twelve along the ring's straights, where the parapet gives the
  // spawning player something to be behind. Only the two z-signs are looped, so
  // this contributes four rather than eight.
  for (const s of [-1, 1] as const) {
    spawns.push({ x: 0, y: RING_Y + 0.05, z: 16.2 * s, yaw: faceCentre(0, 16.2 * s) });
    spawns.push({ x: 16.2 * s, y: RING_Y + 0.05, z: 0, yaw: faceCentre(16.2 * s, 0) });
  }

  return {
    id: 4,
    key: 'cistern',
    name: 'Cistern',
    half: HALF,
    brushes: b,
    spawns,
    sky: 0x4d5a63,
    fog: 0x5b6870,
    fogNear: 14,
    fogFar: 64,
    sun: { x: 0.1, y: 0.96, z: 0.24 },
    sunColor: 0xdff0ff,
    ambientColor: 0x8ea8b8,
    ambientGround: 0x4a5256,
    ambientIntensity: 0.72,
  };
}

/**
 * The rotation. Order matters: `mapById` indexes this array directly, so each
 * map's `id` has to equal its position in it — a coupling the suite asserts,
 * because getting it wrong sends the client the geometry of a different level
 * than the server is simulating and the first symptom is players standing inside
 * walls.
 */
export const MAPS: readonly GameMap[] = [
  buildDustworks(),
  buildFoundry(),
  buildOverpass(),
  buildMeridian(),
  buildCistern(),
];

export function mapById(id: number): GameMap {
  return MAPS[id] ?? MAPS[0]!;
}

export function mapByKey(key: string): GameMap | undefined {
  return MAPS.find((m) => m.key === key);
}

/**
 * Which maps each mode draws from, and in what order.
 *
 * Not every map suits every mode, and the difference is not cosmetic. Meridian
 * puts all six of a side's spawns behind that side's own base, which is the whole
 * point of it for team deathmatch and actively bad for a free-for-all: twelve
 * players with no teams would spawn in two piles facing each other. So it appears
 * in the team rotation only. The other four ring their spawns and read the same
 * either way, so they appear in both — in a different order per mode, so that a
 * player switching modes does not get handed the same level twice in a row.
 *
 * Keyed by `key` rather than by id because a rotation is a statement about which
 * *levels* are in play; expressing it as `[3, 2, 0, 1]` would be a statement about
 * array indices, and would quietly mean something else the first time a map is
 * inserted rather than appended.
 */
const ROTATION_KEYS: Record<'ffa' | 'tdm', readonly string[]> = {
  ffa: ['dustworks', 'foundry', 'cistern', 'overpass'],
  tdm: ['meridian', 'overpass', 'dustworks', 'foundry'],
};

/** Resolved once at module load, so a typo in a key fails immediately and loudly. */
export const ROTATIONS: Record<'ffa' | 'tdm', readonly GameMap[]> = {
  ffa: ROTATION_KEYS.ffa.map((k) => {
    const m = mapByKey(k);
    if (!m) throw new Error(`FFA rotation names an unknown map: ${k}`);
    return m;
  }),
  tdm: ROTATION_KEYS.tdm.map((k) => {
    const m = mapByKey(k);
    if (!m) throw new Error(`TDM rotation names an unknown map: ${k}`);
    return m;
  }),
};

/**
 * The map a room should open on.
 *
 * `seed` is whatever distinguishes this room from the last one — a lobby counter
 * for public matches, a hash of the join code for private ones. Deriving the map
 * rather than choosing it at random is deliberate: a party that shares a code gets
 * the same level every time they use it, which makes "meet me on FOXTROT" mean
 * something, and a fixed sequence of public lobbies is far easier to reason about
 * when a report says one level is broken.
 */
export function pickMap(team: boolean, seed: number): GameMap {
  const rot = team ? ROTATIONS.tdm : ROTATIONS.ffa;
  // `seed` may be negative if a caller hands us a signed hash.
  const i = ((seed % rot.length) + rot.length) % rot.length;
  return rot[i]!;
}

const colliderCache = new WeakMap<GameMap, Box[]>();

/** Collision boxes for a map, built once and reused. */
export function mapColliders(m: GameMap): Box[] {
  let c = colliderCache.get(m);
  if (!c) {
    c = m.brushes.map(brushToBox);
    colliderCache.set(m, c);
  }
  return c;
}
