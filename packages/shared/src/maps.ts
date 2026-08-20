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
  | 'metalDark'
  | 'accent'
  | 'paint'
  | 'light'
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
  metalDark: { color: 0x4d5359, roughness: 0.5, metalness: 0.6 },
  accent: { color: 0x3d78b4, roughness: 0.6, metalness: 0.2 },
  // Red-oxide industrial paint. Every real plant marks its valves, hazards and
  // handrails in something like this, and a level built from nine desaturated
  // greys and browns badly needs one saturated colour to look photographed
  // rather than sculpted. Used sparingly, on details only.
  paint: { color: 0xb8482f, roughness: 0.7, metalness: 0.05 },
  // Lamp glass and lit panels. Lambert has no emission, so this is simply a very
  // pale warm surface — under the sun it reads as a bulb, which is all it has to do.
  light: { color: 0xffe9b0, roughness: 0.3, metalness: 0 },
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

/**
 * The shapes a prop can take. Deliberately five, and deliberately all round:
 * brushes already cover everything with a flat face, so the only thing a prop is
 * for is the geometry a box cannot express.
 */
export type PropKind = 'cyl' | 'cone' | 'dome' | 'sphere' | 'ring';

/**
 * A round decoration: pipe, barrel, vessel, dome, flange, valve wheel, lamp.
 *
 * Props exist because a level built only from axis-aligned boxes reads as a pile
 * of blocks no matter how well it is laid out — there is no curve anywhere in it,
 * and the eye reads "unfinished" long before it reads "arena". So this is a second
 * array, rendered but *almost* never collided, and the rules about what may go in
 * it are the whole reason it is safe to have.
 *
 * Positioning matches `Brush` exactly: `(x, z)` is the footprint centre and `y` is
 * the **bottom of the bounding box**, so the two arrays can be authored side by
 * side without switching conventions mid-line.
 *
 * `solid` is the one escape hatch. A solid prop contributes a collision box
 * *inscribed* in its own silhouette — never circumscribed — so a player can always
 * walk right up to what they can see and can never be stopped by air. That is the
 * one direction of error that is not a bug: clipping a few centimetres into a
 * barrel is invisible, being blocked by nothing is a bug report.
 */
export interface Prop {
  kind: PropKind;
  /** Footprint centre. */
  x: number;
  z: number;
  /** Bottom of the bounding box, as with `Brush`. */
  y: number;
  /** Radius. For `ring`, the radius of the ring itself, not the tube. */
  r: number;
  /** Extent along `axis`. Unused by `sphere`; for `ring` this is the tube radius. */
  len: number;
  /** Which way the shape's length runs. A `ring` lies in the plane normal to it. */
  axis: 'x' | 'y' | 'z';
  mat: MatKey;
  /** Contributes an inscribed collision box. Only meaningful on `cyl`. */
  solid?: boolean;
}

export interface GameMap {
  id: number;
  key: string;
  name: string;
  half: number;
  brushes: Brush[];
  props: Prop[];
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

/* ── Prop geometry ───────────────────────────────────────────────────────────
 *
 * Three functions, and every consumer goes through them: the renderer places its
 * instances with `propHalf`, the collider inscribes its box with `propCollider`,
 * and the test suite bounds them both with `propBox`. Sharing the arithmetic is
 * the point — a prop drawn in one place and collided in another is exactly the
 * class of bug the single-array brush design was built to avoid, and reintroducing
 * it via a second array would be a poor trade for some pipes.
 */

/** Half-extents of a prop's axis-aligned bounding box. */
export function propHalf(p: Prop): { hx: number; hy: number; hz: number } {
  if (p.kind === 'sphere') return { hx: p.r, hy: p.r, hz: p.r };
  if (p.kind === 'ring') {
    const o = p.r + p.len; // outer radius: ring plus tube
    if (p.axis === 'y') return { hx: o, hy: p.len, hz: o };
    if (p.axis === 'x') return { hx: p.len, hy: o, hz: o };
    return { hx: o, hy: o, hz: p.len };
  }
  // cyl / cone / dome: a radius across, `len` along the axis.
  const h = p.len / 2;
  if (p.axis === 'y') return { hx: p.r, hy: h, hz: p.r };
  if (p.axis === 'x') return { hx: h, hy: p.r, hz: p.r };
  return { hx: p.r, hy: p.r, hz: h };
}

/** Bounding box of a prop. Not collision — see `propCollider` for that. */
export function propBox(p: Prop): Box {
  const { hx, hy, hz } = propHalf(p);
  return boxFrom(p.x, p.y, p.z, hx * 2, hy * 2, hz * 2);
}

/**
 * The collision box of a solid prop, or `null` for decoration.
 *
 * A circle of radius r contains a square of side r√2, and that square is what the
 * player collides with. The worst-case gap between what is drawn and what is hit
 * is therefore `r(1 − 1/√2)` ≈ 0.29 r, at the diagonals — 9 cm on a barrel, and
 * the reason `propPlacementIssue` caps the radius of a solid prop rather than
 * letting a five-metre tank be built this way.
 */
export function propCollider(p: Prop): Box | null {
  if (!p.solid || p.kind !== 'cyl') return null;
  const s = p.r * Math.SQRT2;
  if (p.axis === 'y') return boxFrom(p.x, p.y, p.z, s, p.len, s);
  // Horizontal: the inscribed square is centred on the axis, which sits one
  // radius above the bounding box's floor.
  const y = p.y + p.r - s / 2;
  if (p.axis === 'x') return boxFrom(p.x, y, p.z, p.len, s, s);
  return boxFrom(p.x, y, p.z, s, s, p.len);
}

/** Largest solid-prop radius. See `propCollider` for where 0.47 m comes from. */
const SOLID_PROP_MAX_R = 1.6;
/** Clearance a purely decorative prop needs above anything a player can stand on. */
const PROP_OVERHEAD = 2.6;
/** How far a prop may stand off the brush backing it before it reads as cover. */
const PROP_FLUSH = 0.3;

/**
 * Why this prop is not allowed to be where it is, or `null` if it is fine.
 *
 * Props are not collided, so a badly placed one is a lie: the player sees a barrel,
 * shoots it, and the bullet passes straight through — or worse, hides behind it and
 * dies. Rather than trusting authors to remember that, every prop on every map has
 * to satisfy one of four conditions, and the suite walks all of them.
 *
 *   1. **Solid.** It declares its own collider, inscribed in its silhouette.
 *   2. **Backed.** Its bounding box sits inside a brush (or a solid prop),
 *      allowing a small stand-off for flush detail like conduit and ladders.
 *   3. **Overhead.** It is high enough above anything standable that a player can
 *      neither touch it nor mistake it for cover.
 *   4. **Out of bounds.** It is beyond the perimeter — skyline, not level.
 */
export function propPlacementIssue(map: GameMap, p: Prop): string | null {
  const box = propBox(p);

  if (p.solid) {
    if (p.kind !== 'cyl') return `a ${p.kind} cannot be solid; only cylinders inscribe cleanly`;
    if (p.r > SOLID_PROP_MAX_R) return `solid radius ${p.r} exceeds ${SOLID_PROP_MAX_R} m`;
    return null;
  }

  // 4. Out of bounds: entirely past the perimeter on some axis.
  const h = map.half;
  if (box.maxX <= -h || box.minX >= h || box.maxZ <= -h || box.minZ >= h) return null;

  // 2. Backed by a brush or a solid prop, within the flush tolerance.
  const inside = (o: Box): boolean =>
    box.minX >= o.minX - PROP_FLUSH &&
    box.maxX <= o.maxX + PROP_FLUSH &&
    box.minY >= o.minY - PROP_FLUSH &&
    box.maxY <= o.maxY + PROP_FLUSH &&
    box.minZ >= o.minZ - PROP_FLUSH &&
    box.maxZ <= o.maxZ + PROP_FLUSH;
  for (const b of map.brushes) if (inside(brushToBox(b))) return null;
  // Against a solid prop's *drawn* box rather than its inscribed collider. A hoop
  // wrapped round a drum is backed by the drum: what rule 2 is really asking is
  // whether there is solid geometry behind the decoration, and a solid cylinder is
  // solid geometry — its 0.29 r draw-versus-hit gap is already priced in by
  // `SOLID_PROP_MAX_R` and does not need charging twice. Tested against the
  // collider instead, a band on anything wider than 0.96 m would be rejected, which
  // would ban every vessel worth building.
  for (const q of map.props) {
    if (q === p) continue;
    if (propCollider(q) && inside(propBox(q))) return null;
  }

  // 3. Overhead: clear of the tallest thing anyone could stand on underneath it.
  //
  // Brushes only, deliberately. A solid prop's collider top is incidental rather
  // than designed — nobody lays out a route across the lids of oil drums — and
  // counting it would ban the one construction the prop layer exists for: a domed
  // head sits `0.62 r` proud of the vessel carrying it, which is neither flush
  // enough for rule 2 nor 2.6 m clear of a top the vessel itself defines. The cost
  // is that a prop can be within reach of somebody who has climbed on top of a
  // solid prop, which is a worse place to be standing than it is a bug.
  let floor = 0;
  for (const b of map.brushes) {
    const o = brushToBox(b);
    if (o.maxX <= box.minX || o.minX >= box.maxX) continue;
    if (o.maxZ <= box.minZ || o.minZ >= box.maxZ) continue;
    if (o.maxY > box.minY) continue; // above the prop; not something under it
    if (o.maxY > floor) floor = o.maxY;
  }
  if (box.minY - floor >= PROP_OVERHEAD) return null;

  return `floats in playable space: bottom ${box.minY.toFixed(2)} is only ${(
    box.minY - floor
  ).toFixed(2)} m above the surface at ${floor.toFixed(2)}, is not solid, and is not flush to a brush`;
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

export interface WindowSpec {
  at: number;
  width: number;
  sillY: number;
  height: number;
}

/**
 * A wall with optional doorways and windows that players can look and shoot through.
 */
function wallWithOpenings(
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
  windows?: WindowSpec[],
): void {
  if (!door && (!windows || windows.length === 0)) {
    const len = to - from;
    const mid = (from + to) / 2;
    if (axis === 'x') br(out, mid, y, fixed, len, h, thick, mat);
    else br(out, fixed, y, mid, thick, h, len, mat);
    return;
  }

  interface Cutout {
    start: number;
    end: number;
    bottomH: number;
    topY: number;
  }
  const cuts: Cutout[] = [];
  if (door) {
    cuts.push({
      start: door.at - door.width / 2,
      end: door.at + door.width / 2,
      bottomH: 0,
      topY: y + door.height,
    });
  }
  if (windows) {
    for (const w of windows) {
      cuts.push({
        start: w.at - w.width / 2,
        end: w.at + w.width / 2,
        bottomH: w.sillY,
        topY: y + w.sillY + w.height,
      });
    }
  }

  cuts.sort((a, b) => a.start - b.start);

  let cur = from;
  for (const c of cuts) {
    const c0 = Math.max(from, c.start);
    const c1 = Math.min(to, c.end);
    if (c0 > cur) {
      const len = c0 - cur;
      const mid = (cur + c0) / 2;
      if (axis === 'x') br(out, mid, y, fixed, len, h, thick, mat);
      else br(out, fixed, y, mid, thick, h, len, mat);
    }
    if (c1 > c0) {
      if (c.bottomH > 0.01) {
        const len = c1 - c0;
        const mid = (c0 + c1) / 2;
        if (axis === 'x') br(out, mid, y, fixed, len, c.bottomH, thick, mat);
        else br(out, fixed, y, mid, thick, c.bottomH, len, mat);
      }
      if (y + h > c.topY) {
        const len = c1 - c0;
        const mid = (c0 + c1) / 2;
        const lintelH = y + h - c.topY;
        if (axis === 'x') br(out, mid, c.topY, fixed, len, lintelH, thick, mat);
        else br(out, fixed, c.topY, mid, thick, lintelH, len, mat);
      }
    }
    cur = Math.max(cur, c1);
  }

  if (cur < to) {
    const len = to - cur;
    const mid = (cur + to) / 2;
    if (axis === 'x') br(out, mid, y, fixed, len, h, thick, mat);
    else br(out, fixed, y, mid, thick, h, len, mat);
  }
}

/**
 * A grand multi-story walkable building/house.
 * - Ground Floor with entry doors, rooms, shooting windows, and tactical tables
 * - Interior Staircase to 2nd Floor
 * - 2nd Floor with interior rooms, windows, and outdoor shooting balcony
 * - 2nd Staircase up to Rooftop
 * - Rooftop Terrace with parapets, penthouse exit, HVAC chillers, and satellite antennas
 */
function multiStoryBuilding(
  b: Brush[],
  p: Prop[],
  cx: number,
  cz: number,
  w: number,
  d: number,
  fl1H = 3.6,
  fl2H = 3.6,
  wallMat: MatKey = 'concrete',
  roofMat: MatKey = 'concreteDark',
  balconySide: 'north' | 'south' | 'east' | 'west' = 'north',
): void {
  const t = 0.5;
  const x0 = cx - w / 2;
  const x1 = cx + w / 2;
  const z0 = cz - d / 2;
  const z1 = cz + d / 2;

  // ── Level 1 (Ground Floor: y = 0 to fl1H) ──────────────────────────────────
  const mainDoor: Door = { at: cx, width: 3.2, height: 2.6 };
  const sideDoor: Door = { at: cz, width: 2.4, height: 2.5 };
  const winL1: WindowSpec[] = [
    { at: cx - w * 0.28, width: 2.2, sillY: 1.0, height: 1.4 },
    { at: cx + w * 0.28, width: 2.2, sillY: 1.0, height: 1.4 },
  ];
  const winSideL1: WindowSpec[] = [
    { at: cz - d * 0.25, width: 2.0, sillY: 1.0, height: 1.4 },
    { at: cz + d * 0.25, width: 2.0, sillY: 1.0, height: 1.4 },
  ];

  wallWithOpenings(b, 'x', z0, x0, x1, 0, fl1H, t, wallMat, balconySide === 'north' ? mainDoor : undefined, winL1);
  wallWithOpenings(b, 'x', z1, x0, x1, 0, fl1H, t, wallMat, balconySide === 'south' ? mainDoor : undefined, winL1);
  wallWithOpenings(b, 'z', x0, z0, z1, 0, fl1H, t, wallMat, balconySide === 'west' ? sideDoor : undefined, winSideL1);
  wallWithOpenings(b, 'z', x1, z0, z1, 0, fl1H, t, wallMat, balconySide === 'east' ? sideDoor : undefined, winSideL1);

  // Interior dividing wall separating Ground Floor into 2 tactical rooms
  const partX = cx;
  wall(b, 'z', partX, z0 + 1, z1 - 1, 0, fl1H, 0.4, 'concreteDark', { at: cz, width: 2.6, height: 2.5 });

  // Interior Ground Floor furniture & cover
  br(b, cx - w * 0.25, 0, cz - d * 0.2, 2.6, 1.0, 2.0, 'wood');
  br(b, cx - w * 0.25, 0, cz + d * 0.25, 1.8, 1.8, 1.8, 'rust');
  br(b, cx + w * 0.25, 0, cz + d * 0.25, 2.2, 1.2, 1.6, 'wood');
  barrel(p, cx + w * 0.35, 0, cz - d * 0.3, 'paint');
  barrel(p, cx + w * 0.35, 0, cz - d * 0.2, 'rust');

  lamp(p, cx - w * 0.25, fl1H - 0.05, cz, 0.35);
  lamp(p, cx + w * 0.25, fl1H - 0.05, cz, 0.35);

  // ── Ground Floor to 2nd Floor Staircase ───────────────────────────────────
  const stairW = 2.4;
  const stairSteps = 12;
  const stairStepH = fl1H / stairSteps;
  const stairStepD = 0.45;
  const stairLen = stairSteps * stairStepD;
  const stairX = cx + w * 0.25;
  const stairZ0 = z0 + 1.2;
  stairs(b, stairX, 0, stairZ0, 'z+', stairSteps, stairStepH, stairStepD, stairW, 'concreteDark');

  // ── Level 2 Floor Slab (y = fl1H) ─────────────────────────────────────────
  const slabT = 0.4;
  const fl2Y = fl1H + slabT;
  // Left half of floor (solid)
  br(b, cx - w * 0.25, fl1H, cz, w * 0.5 + t, slabT, d + t, roofMat);
  // Right half front (solid in front of stairwell)
  br(b, cx + w * 0.25, fl1H, z1 - (d - stairLen - 1.5) * 0.5, w * 0.5 + t, slabT, Math.max(1, d - stairLen - 1.5), roofMat);

  // Stairwell guardrail on 2nd floor
  guard(b, p, 'z', stairX - stairW * 0.5 - 0.1, stairZ0, stairZ0 + stairLen, fl2Y, 'metal');

  // ── Level 2 (Second Floor: y = fl2Y to fl2Y + fl2H) ────────────────────────
  const winL2: WindowSpec[] = [
    { at: cx - w * 0.28, width: 2.4, sillY: 1.0, height: 1.4 },
    { at: cx + w * 0.28, width: 2.4, sillY: 1.0, height: 1.4 },
  ];
  const winSideL2: WindowSpec[] = [
    { at: cz - d * 0.25, width: 2.2, sillY: 1.0, height: 1.4 },
    { at: cz + d * 0.25, width: 2.2, sillY: 1.0, height: 1.4 },
  ];
  const balconyDoor: Door = { at: cx, width: 2.6, height: 2.5 };

  wallWithOpenings(b, 'x', z0, x0, x1, fl2Y, fl2H, t, wallMat, balconySide === 'north' ? balconyDoor : undefined, winL2);
  wallWithOpenings(b, 'x', z1, x0, x1, fl2Y, fl2H, t, wallMat, balconySide === 'south' ? balconyDoor : undefined, winL2);
  wallWithOpenings(b, 'z', x0, z0, z1, fl2Y, fl2H, t, wallMat, balconySide === 'west' ? balconyDoor : undefined, winSideL2);
  wallWithOpenings(b, 'z', x1, z0, z1, fl2Y, fl2H, t, wallMat, balconySide === 'east' ? balconyDoor : undefined, winSideL2);

  // 2nd Floor Cantilevered Balcony Terrace
  const balcDepth = 2.4;
  const balcWidth = w * 0.65;
  const balcCX = cx;
  if (balconySide === 'north') {
    const balcCZ = z0 - balcDepth * 0.5;
    br(b, balcCX, fl1H, balcCZ, balcWidth, slabT, balcDepth, roofMat);
    wall(b, 'x', z0 - balcDepth, balcCX - balcWidth * 0.5, balcCX + balcWidth * 0.5, fl2Y, 1.0, 0.3, wallMat);
    wall(b, 'z', balcCX - balcWidth * 0.5, z0 - balcDepth, z0, fl2Y, 1.0, 0.3, wallMat);
    wall(b, 'z', balcCX + balcWidth * 0.5, z0 - balcDepth, z0, fl2Y, 1.0, 0.3, wallMat);
  } else if (balconySide === 'south') {
    const balcCZ = z1 + balcDepth * 0.5;
    br(b, balcCX, fl1H, balcCZ, balcWidth, slabT, balcDepth, roofMat);
    wall(b, 'x', z1 + balcDepth, balcCX - balcWidth * 0.5, balcCX + balcWidth * 0.5, fl2Y, 1.0, 0.3, wallMat);
    wall(b, 'z', balcCX - balcWidth * 0.5, z1, z1 + balcDepth, fl2Y, 1.0, 0.3, wallMat);
    wall(b, 'z', balcCX + balcWidth * 0.5, z1, z1 + balcDepth, fl2Y, 1.0, 0.3, wallMat);
  }

  br(b, cx - w * 0.25, fl2Y, cz + d * 0.25, 2.2, 1.1, 2.2, 'rust');
  lamp(p, cx - w * 0.25, fl2Y + fl2H - 0.05, cz, 0.35);

  // ── 2nd Floor to Rooftop Staircase ────────────────────────────────────────
  const stair2X = cx - w * 0.25;
  const stair2Z0 = z1 - 1.2;
  stairs(b, stair2X, fl2Y, stair2Z0, 'z-', stairSteps, fl2H / stairSteps, stairStepD, stairW, 'concreteDark');

  // ── Rooftop Terrace (y = fl2Y + fl2H) ─────────────────────────────────────
  const roofY = fl2Y + fl2H;
  const roofWalkY = roofY + slabT;
  br(b, cx, roofY, cz, w + t * 2, slabT, d + t * 2, roofMat);

  // Stairwell penthouse enclosure on roof
  const pentW = stairW + 1.2;
  const pentD = stairLen * 0.7;
  const pentH = 2.4;
  building(b, stair2X, stair2Z0 - pentD * 0.5, pentW, pentD, pentH, wallMat, roofMat, { south: true });

  // Perimeter parapets with sniper peek slots
  const pWallH = 0.95;
  wall(b, 'x', z0 - t, x0 - t, x1 + t, roofWalkY, pWallH, t, wallMat);
  wall(b, 'x', z1 + t, x0 - t, x1 + t, roofWalkY, pWallH, t, wallMat);
  wall(b, 'z', x0 - t, z0 - t, z1 + t, roofWalkY, pWallH, t, wallMat);
  wall(b, 'z', x1 + t, z0 - t, z1 + t, roofWalkY, pWallH, t, wallMat);

  // ── Tactical Rooftop Equipment Props ──────────────────────────────────────
  roundColumn(p, cx + w * 0.2, roofWalkY, cz - d * 0.2, 0.95, 1.4, 'metal', 'metalDark');
  roundColumn(p, cx + w * 0.2, roofWalkY, cz - d * 0.05, 0.95, 1.4, 'metal', 'metalDark');
  br(b, cx + w * 0.2, roofWalkY, cz - d * 0.125, 2.6, 1.2, 4.2, 'metalDark');

  pr(p, 'cyl', cx + w * 0.28, roofWalkY, cz + d * 0.25, 0.22, 2.7, 'metalDark', 'y', true);
  pr(p, 'dome', cx + w * 0.28, roofWalkY + 2.7, cz + d * 0.25, 1.3, 0.5, 'metal');
  pipe(p, 'z', cz + d * 0.15, cz + d * 0.35, roofWalkY + 2.7, cx + w * 0.28, 0.07, 'paint');

  pr(p, 'cyl', cx - w * 0.35, roofWalkY, cz + d * 0.3, 0.12, 6.5, 'metalDark', 'y', true);
  pr(p, 'sphere', cx - w * 0.35, roofWalkY + 6.5, cz + d * 0.3, 0.16, 0, 'light');
}

/**
 * A wall's capping band and pilasters.
 *
 * Purely visual, and the cheapest "finished" pass there is. An 8 m perimeter slab
 * with nothing on it reads as the inside of a box; the same slab with a coping
 * course along the top and a pier every few metres reads as a wall somebody built.
 * Both are brushes because they stick out far enough to catch a shot.
 */
function trimWall(
  out: Brush[],
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  h: number,
  thick: number,
  mat: MatKey,
  pierEvery = 7,
): void {
  const cap = thick + 0.4;
  if (axis === 'x') br(out, (from + to) / 2, h, fixed, to - from, 0.35, cap, mat);
  else br(out, fixed, h, (from + to) / 2, cap, 0.35, to - from, mat);

  // Piers, inset from the ends so two perpendicular walls never fight in a corner.
  const n = Math.max(1, Math.round((to - from) / pierEvery));
  for (let i = 1; i < n; i++) {
    const t = from + ((to - from) * i) / n;
    if (axis === 'x') br(out, t, 0, fixed, 1.1, h, cap, mat);
    else br(out, fixed, 0, t, cap, h, 1.1, mat);
  }
}

/** ISO Shipping Container providing solid tactical cover */
function shippingContainer(
  b: Brush[],
  p: Prop[],
  x: number,
  y: number,
  z: number,
  axis: 'x' | 'z',
  mat: MatKey = 'accent',
): void {
  const sx = axis === 'x' ? 6.0 : 2.4;
  const sz = axis === 'x' ? 2.4 : 6.0;
  const sy = 2.6;
  br(b, x, y, z, sx, sy, sz, mat);
  if (axis === 'z') {
    pr(p, 'cyl', x - 0.4, y + 0.3, z + sz * 0.5 + 0.02, 0.035, 2.0, 'metalDark', 'y', true);
    pr(p, 'cyl', x + 0.4, y + 0.3, z + sz * 0.5 + 0.02, 0.035, 2.0, 'metalDark', 'y', true);
  } else {
    pr(p, 'cyl', x + sx * 0.5 + 0.02, y + 0.3, z - 0.4, 0.035, 2.0, 'metalDark', 'y', true);
    pr(p, 'cyl', x + sx * 0.5 + 0.02, y + 0.3, z + 0.4, 0.035, 2.0, 'metalDark', 'y', true);
  }
}

/** Coastal Pine / Palm Tree with solid trunk and lush foliage canopy */
function pineTree(p: Prop[], x: number, y: number, z: number, height = 7.5): void {
  // Solid trunk
  pr(p, 'cyl', x, y, z, 0.22, height * 0.45, 'wood', 'y', true);
  // Tiered foliage canopies (overhead >= 2.6m)
  pr(p, 'dome', x, y + height * 0.45, z, 1.45, height * 0.35, 'paint');
  pr(p, 'dome', x, y + height * 0.68, z, 1.1, height * 0.3, 'paint');
  pr(p, 'dome', x, y + height * 0.88, z, 0.65, height * 0.22, 'paint');
}

/** Military Transport Cargo Truck */
function militaryTruck(b: Brush[], p: Prop[], x: number, y: number, z: number, axis: 'x' | 'z'): void {
  if (axis === 'z') {
    // Cab & Engine Hood
    br(b, x, y, z - 1.8, 2.4, 2.2, 2.2, 'metalDark');
    br(b, x, y, z - 3.4, 2.2, 1.3, 1.4, 'metalDark');
    // Wooden Cargo Bed
    br(b, x, y, z + 1.6, 2.5, 2.4, 4.4, 'wood');
    // Wheels
    roundColumn(p, x - 1.25, y, z - 2.6, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x + 1.25, y, z - 2.6, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x - 1.25, y, z + 1.2, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x + 1.25, y, z + 1.2, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x - 1.25, y, z + 2.8, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x + 1.25, y, z + 2.8, 0.45, 0.4, 'metalDark', 'metalDark');
  } else {
    br(b, x - 1.8, y, z, 2.2, 2.2, 2.4, 'metalDark');
    br(b, x - 3.4, y, z, 1.4, 1.3, 2.2, 'metalDark');
    br(b, x + 1.6, y, z, 4.4, 2.4, 2.5, 'wood');
    roundColumn(p, x - 2.6, y, z - 1.25, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x - 2.6, y, z + 1.25, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x + 1.2, y, z - 1.25, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x + 1.2, y, z + 1.25, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x + 2.8, y, z - 1.25, 0.45, 0.4, 'metalDark', 'metalDark');
    roundColumn(p, x + 2.8, y, z + 1.25, 0.45, 0.4, 'metalDark', 'metalDark');
  }
}

// ── Prop builders ────────────────────────────────────────────────────────────

/** Push a prop. `y` is the bottom of its bounding box, as with `br`. */
function pr(
  out: Prop[],
  kind: PropKind,
  x: number,
  y: number,
  z: number,
  r: number,
  len: number,
  mat: MatKey,
  axis: Prop['axis'] = 'y',
  solid = false,
): void {
  if (r <= 0.001) return;
  out.push({ kind, x, y, z, r, len, axis, mat, solid });
}

/**
 * A horizontal pipe, seated on its **centre line** rather than its underside.
 *
 * Pipes are laid out by where their axis runs — that is how a real rack is set
 * out, and it is the only way two pipes of different bore read as parallel.
 */
function pipe(
  out: Prop[],
  axis: 'x' | 'z',
  from: number,
  to: number,
  cy: number,
  other: number,
  r: number,
  mat: MatKey,
): void {
  const len = to - from;
  if (len <= 0.01) return;
  const mid = (from + to) / 2;
  if (axis === 'x') pr(out, 'cyl', mid, cy - r, other, r, len, mat, 'x');
  else pr(out, 'cyl', other, cy - r, mid, r, len, mat, 'z');
}

/** A ring seated on its centre, for flanges and bands wrapped around something. */
function ringAt(
  out: Prop[],
  x: number,
  cy: number,
  z: number,
  r: number,
  tube: number,
  mat: MatKey,
  axis: Prop['axis'],
): void {
  const hy = axis === 'y' ? tube : r + tube;
  pr(out, 'ring', x, cy - hy, z, r, tube, mat, axis);
}

/** An elbow: two pipes meeting at a right angle, with the corner filled by a sphere. */
function elbow(
  out: Prop[],
  x: number,
  cy: number,
  z: number,
  r: number,
  mat: MatKey,
): void {
  pr(out, 'sphere', x, cy - r, z, r, 0, mat);
}

/** A 205-litre drum: solid, so it is real cover, with two rolling hoops. */
function barrel(out: Prop[], x: number, y: number, z: number, mat: MatKey): void {
  const r = 0.31;
  const h = 0.9;
  pr(out, 'cyl', x, y, z, r, h, mat, 'y', true);
  ringAt(out, x, y + h * 0.28, z, r * 0.99, 0.035, 'metalDark', 'y');
  ringAt(out, x, y + h * 0.72, z, r * 0.99, 0.035, 'metalDark', 'y');
}

/** A short solid post. Reads as a bollard, and stops a jump route at knee height. */
function bollard(out: Prop[], x: number, y: number, z: number, h = 1.0): void {
  pr(out, 'cyl', x, y, z, 0.14, h, 'paint', 'y', true);
  pr(out, 'dome', x, y + h, z, 0.14, 0.12, 'paint');
}

/**
 * A process column: a solid vertical vessel with a domed head and skirt bands.
 *
 * Capped at 1.6 m radius by the solid-prop rule, which is not a compromise — a
 * fractionating column really is tall and narrow, and a row of them at different
 * heights is the single most recognisable thing in a refinery skyline.
 */
function vessel(
  out: Prop[],
  x: number,
  y: number,
  z: number,
  r: number,
  h: number,
  mat: MatKey,
): void {
  pr(out, 'cyl', x, y, z, r, h, mat, 'y', true);
  pr(out, 'dome', x, y + h, z, r, r * 0.62, mat);
  for (let t = 2.2; t < h - 0.6; t += 2.6) ringAt(out, x, y + t, z, r * 1.02, r * 0.07, 'metalDark', 'y');
}

/** A big storage tank. Skyline only — see `propPlacementIssue` rule 4. */
function tank(out: Prop[], x: number, y: number, z: number, r: number, h: number, mat: MatKey): void {
  pr(out, 'cyl', x, y, z, r, h, mat);
  pr(out, 'dome', x, y + h, z, r, r * 0.34, 'metalDark');
  for (let t = 1.6; t < h - 0.8; t += 2.4) ringAt(out, x, y + t, z, r * 1.01, 0.09, 'metalDark', 'y');
  // The spiral stair every tank of this size has, flattened to a ring stack —
  // legible from the distance it is actually viewed at, and free.
  for (let t = 0.6; t < h; t += 0.55) ringAt(out, x, y + t, z, r * 1.06, 0.055, 'metal', 'y');
}

/** A caged ladder flush against a wall face. `face` is the axis it stands off. */
function ladder(
  out: Prop[],
  x: number,
  y: number,
  z: number,
  top: number,
  face: 'x' | 'z',
  mat: MatKey = 'metal',
): void {
  const h = top - y;
  if (h <= 0.4) return;
  const w = 0.24; // half the rail spacing
  for (const s of [-1, 1] as const) {
    if (face === 'x') pr(out, 'cyl', x, y, z + w * s, 0.045, h, mat);
    else pr(out, 'cyl', x + w * s, y, z, 0.045, h, mat);
  }
  for (let t = 0.32; t < h; t += 0.32) {
    if (face === 'x') pr(out, 'cyl', x, y + t - 0.028, z, 0.028, w * 2, mat, 'z');
    else pr(out, 'cyl', x, y + t - 0.028, z, 0.028, w * 2, mat, 'x');
  }
}

/** A lamp hanging under a ceiling or a gantry. `y` is the surface it hangs from. */
function lamp(out: Prop[], x: number, y: number, z: number, drop = 0.5): void {
  pr(out, 'cyl', x, y - drop, z, 0.035, drop, 'metalDark');
  pr(out, 'cone', x, y - drop - 0.34, z, 0.34, 0.34, 'metalDark');
  pr(out, 'sphere', x, y - drop - 0.4, z, 0.13, 0, 'light');
}

/**
 * A guardrail: a solid kick panel that stops a fall, a round top rail, and posts.
 *
 * The panel is a brush because walking off a catwalk has to be blocked; the rail
 * and posts are props because a handrail is round and a box pretending to be one
 * is precisely what makes the level look unfinished. Painted, because handrails
 * are the one thing in a plant that is always painted.
 */
function guard(
  bOut: Brush[],
  pOut: Prop[],
  axis: 'x' | 'z',
  fixed: number,
  from: number,
  to: number,
  y: number,
  panelMat: MatKey,
): void {
  const h = 1.0;
  wall(bOut, axis, fixed, from, to, y, h, 0.12, panelMat);
  pipe(pOut, axis, from, to, y + h + 0.03, fixed, 0.055, 'paint');
  const n = Math.max(1, Math.round((to - from) / 2.2));
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    if (axis === 'x') pr(pOut, 'cyl', t, y, fixed, 0.05, h + 0.03, 'paint');
    else pr(pOut, 'cyl', fixed, y, t, 0.05, h + 0.03, 'paint');
  }
}

/**
 * A round pillar you can actually take cover behind.
 *
 * The trick that makes the whole prop layer worthwhile. A solid cylinder collides
 * as the square of side `r√2` inscribed in it, so the collider is strictly *inside*
 * the silhouette: the player sees a round column, and can never be stopped by air,
 * because every point the collider occupies is somewhere the column visibly is. The
 * only error is the 0.29 r sliver at each diagonal, which gives cover away rather
 * than inventing it.
 *
 * This was two objects for a while — an inscribed brush with a cylinder drawn over
 * it — which produced exactly the same collider by a longer road, and cost the cap
 * bands their backing: a band at `1.06 r` has to reach `0.35 r` past a brush whose
 * half-width is only `0.71 r`, so anything above about 0.6 m radius failed rule 2
 * and a colonnade could not be banded at all. One solid cylinder fixes it, because
 * rule 2 measures decoration against a solid prop's *drawn* box.
 */
function roundColumn(
  out: Prop[],
  x: number,
  y: number,
  z: number,
  r: number,
  h: number,
  mat: MatKey,
  capMat?: MatKey,
): void {
  pr(out, 'cyl', x, y, z, r, h, mat, 'y', true);
  if (capMat) {
    ringAt(out, x, y + h - 0.12, z, r * 1.02, r * 0.13, capMat, 'y');
    ringAt(out, x, y + 0.16, z, r * 1.06, r * 0.15, capMat, 'y');
  }
}

/**
 * A lamp on a post: solid stem, cranked arm, shade, bulb.
 *
 * The stem is solid rather than decorative, which costs a 20 cm collision box and
 * buys the thing being real — you can clip it with a shoulder while strafing and it
 * behaves the way it looks. Everything above the arm is overhead by rule 3.
 */
function lampPost(out: Prop[], x: number, y: number, z: number, h = 4.3, reach = 0.9): void {
  pr(out, 'cyl', x, y, z, 0.13, h, 'metalDark', 'y', true);
  ringAt(out, x, y + 0.3, z, 0.2, 0.06, 'metalDark', 'y');
  // The arm reaches along +x, so a pair either side of a lane both point inward
  // when the caller flips `reach`.
  pipe(out, 'x', Math.min(x, x + reach), Math.max(x, x + reach), y + h - 0.06, z, 0.07, 'metalDark');
  pr(out, 'cone', x + reach, y + h - 0.46, z, 0.3, 0.34, 'metalDark');
  pr(out, 'sphere', x + reach, y + h - 0.6, z, 0.13, 0, 'light');
}

/**
 * A roof truss spanning a hall, plus the tie rods under it.
 *
 * Overhead by rule 3, and the reason indoor spaces stop looking like shoeboxes:
 * a flat ceiling has no scale to it, and a repeated truss gives the eye something
 * to measure the span against.
 */
function truss(
  out: Prop[],
  axis: 'x' | 'z',
  from: number,
  to: number,
  cy: number,
  other: number,
  mat: MatKey = 'metalDark',
): void {
  pipe(out, axis, from, to, cy, other, 0.11, mat);
  pipe(out, axis, from, to, cy - 0.9, other, 0.08, mat);
  const n = Math.max(2, Math.round((to - from) / 2.4));
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n;
    if (axis === 'x') pr(out, 'cyl', t, cy - 0.9, other, 0.05, 0.9, mat);
    else pr(out, 'cyl', other, cy - 0.9, t, 0.05, 0.9, mat);
  }
}

// ── Dustworks ────────────────────────────────────────────────────────────────

/**
 * A walled desert compound: a raised middle everyone wants, four blockhouses that
 * overlook it, and a service ring around the outside.
 *
 * Grown from 60 m across to 76 m. The version before this one read as a courtyard
 * with four sheds in it, and the reason was not the size on its own — it was that
 * everything in it was a box, all of it the same height, with nothing between the
 * sheds and the wall. The extra 16 m all went into the ring: a colonnade down each
 * flank, a fuel bund on each diagonal, and a water tower straddling the middle so
 * the map has a silhouette from anywhere in it.
 *
 * The stair runs deserve a note, because the previous ones were wrong. `stairs()`
 * places the **foot** of the run at the coordinate it is given and ascends *away*
 * from it, so a flight serving a platform edge has to start `steps × stepD` clear
 * of that edge and climb toward it. Started at the edge itself — which is what this
 * map used to do — every step lands inside the platform it is supposed to serve,
 * and the platform is left unreachable: a 1.8 m lip against a 1.24 m jump.
 */
function buildDustworks(): GameMap {
  const b: Brush[] = [];
  const p: Prop[] = [];
  const HALF = 48;

  // Concrete Fortress ground floor
  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'concrete');

  // Perimeter fortress walls & coastal overlook
  const PW = 7.0;
  for (const s of [-1, 1] as const) {
    wall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concreteDark');
    wall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concreteDark');
    trimWall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'concrete');
    trimWall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'concrete');
  }

  // Pine trees along perimeter
  for (let i = -40; i <= 40; i += 16) {
    pineTree(p, i, 0, -44, 8.5);
    pineTree(p, i, 3.2, 44, 8.5);
    pineTree(p, -44, 0, i, 8.5);
    pineTree(p, 44, 0, i, 8.5);
  }

  // North Helipad & Substation Terrace
  const HZ = 33;
  const HY = 3.2;
  const HW = 44;
  const HD = 20;

  // ── 1. West Wing: 2-Story Operations Headquarters (Left Complex) ───────────
  const WX = -24;
  const WZ = 0;
  const WW = 20;
  const WD = 28;
  const fl1H = 3.6;
  const fl2H = 3.6;
  const fl2Y = 4.0;
  const roofY = 7.6;
  const roofWalkY = 8.0;

  const wDoorMain: Door = { at: WZ, width: 3.4, height: 2.6 };
  const wDoorSide: Door = { at: WX, width: 2.4, height: 2.5 };
  const winW: WindowSpec[] = [
    { at: WZ - 8, width: 2.4, sillY: 1.0, height: 1.4 },
    { at: WZ + 8, width: 2.4, sillY: 1.0, height: 1.4 },
  ];
  const winFront: WindowSpec[] = [
    { at: WX - 4, width: 2.2, sillY: 1.0, height: 1.4 },
    { at: WX + 4, width: 2.2, sillY: 1.0, height: 1.4 },
  ];

  // Ground Floor exterior
  wallWithOpenings(b, 'z', WX + WW / 2, WZ - WD / 2, WZ + WD / 2, 0, fl1H, 0.5, 'concrete', wDoorMain, winW);
  wallWithOpenings(b, 'z', WX - WW / 2, WZ - WD / 2, WZ + WD / 2, 0, fl1H, 0.5, 'concrete', undefined, winW);
  wallWithOpenings(b, 'x', WZ - WD / 2, WX - WW / 2, WX + WW / 2, 0, fl1H, 0.5, 'concrete', wDoorSide, winFront);
  wallWithOpenings(b, 'x', WZ + WD / 2, WX - WW / 2, WX + WW / 2, 0, fl1H, 0.5, 'concrete', wDoorSide, winFront);

  // Interior partition wall
  wall(b, 'x', WZ, WX - WW / 2 + 1, WX + WW / 2 - 1, 0, fl1H, 0.4, 'concreteDark', { at: WX, width: 2.4, height: 2.5 });

  // Ground Floor interior cover
  br(b, WX - 4, 0, WZ - 6, 3.2, 1.0, 2.0, 'wood');
  br(b, WX - 4, 0, WZ + 6, 2.2, 1.8, 2.2, 'rust');
  br(b, WX + 4, 0, WZ + 6, 2.4, 1.2, 1.8, 'wood');
  lamp(p, WX, fl1H - 0.05, WZ - 6, 0.15);
  lamp(p, WX, fl1H - 0.05, WZ + 6, 0.15);

  // Interior staircase to 2nd Floor (14 steps of 0.286m rise, lands at z = -4.12, exact y = 4.0m)
  stairs(b, WX - 5, 0, -10.0, 'z+', 14, fl2Y / 14, 0.42, 2.4, 'concreteDark');

  // 2nd Floor Slab with stairwell void allowing seamless walk-through
  br(b, -19.5, fl1H, 0, 11.0, 0.4, 28.0, 'concreteDark'); // East section
  br(b, -29.5, fl1H, -12.5, 9.0, 0.4, 3.0, 'concreteDark'); // West south section
  br(b, -29.5, fl1H, 5.0, 9.0, 0.4, 18.0, 'concreteDark'); // West north section
  guard(b, p, 'z', -25.0, -11.0, -4.0, fl2Y, 'metal'); // Stairwell guardrail along side only

  // ── 2nd Floor Exterior Catwalk Terrace & Upper Skybridge ─────────────────
  // Continuous 4.0m-wide elevated walkway running full length from z = -14 to z = 23
  br(b, -12.0, fl1H, 4.5, 4.0, 0.4, 37.0, 'concreteDark');
  // Catwalk guardrails with wide landing opening for the Grand Central Staircase
  guard(b, p, 'z', -10.0, -14, -2.8, fl2Y, 'metal');
  guard(b, p, 'z', -10.0, 2.8, 23, fl2Y, 'metal');
  guard(b, p, 'x', -14.0, -14, -10, fl2Y, 'metal');

  // Transition stairs connecting bridge end (z = 23, y = 4.0m) down to Helipad Terrace (y = 3.2m)
  stairs(b, -12.0, HY, 24.5, 'z-', 3, (fl2Y - HY) / 3, 0.5, 4.0, 'concreteDark');
  br(b, -9.8, HY, 24.0, 0.4, 0.9, 2.0, 'concreteDark');
  br(b, -14.2, HY, 24.0, 0.4, 0.9, 2.0, 'concreteDark');

  // ── Grand Central Staircase from Courtyard to 2nd Floor Catwalk ──────────
  stairs(b, -4.12, 0, WZ, 'x-', 14, fl2Y / 14, 0.42, 5.0, 'concreteDark');
  br(b, -7.06, 0, WZ - 2.7, 5.88, 2.4, 0.4, 'concreteDark');
  br(b, -7.06, 0, WZ + 2.7, 5.88, 2.4, 0.4, 'concreteDark');

  // 2nd Floor exterior walls & windows
  const winCatDoor: Door = { at: WZ, width: 2.8, height: 2.5 };
  wallWithOpenings(b, 'z', WX + WW / 2, WZ - WD / 2, WZ + WD / 2, fl2Y, fl2H, 0.5, 'concrete', winCatDoor, winW);
  wallWithOpenings(b, 'z', WX - WW / 2, WZ - WD / 2, WZ + WD / 2, fl2Y, fl2H, 0.5, 'concrete', undefined, winW);
  wallWithOpenings(b, 'x', WZ - WD / 2, WX - WW / 2, WX + WW / 2, fl2Y, fl2H, 0.5, 'concrete', undefined, winFront);
  wallWithOpenings(b, 'x', WZ + WD / 2, WX - WW / 2, WX + WW / 2, fl2Y, fl2H, 0.5, 'concrete', undefined, winFront);

  // 2nd Floor Staircase to Roof (14 steps of 0.286m rise, lands at z = 4.12, exact y = 8.0m)
  stairs(b, WX + 5, fl2Y, 10.0, 'z-', 14, (roofWalkY - fl2Y) / 14, 0.42, 2.4, 'concreteDark');

  // Roof Slab with stairwell roof opening
  br(b, -28.5, roofY, 0, 11.0, 0.4, 28.0, 'concreteDark'); // West roof section
  br(b, -18.5, roofY, -5.0, 9.0, 0.4, 18.0, 'concreteDark'); // East south roof section
  br(b, -18.5, roofY, 12.5, 9.0, 0.4, 3.0, 'concreteDark'); // East north roof section

  // Roof stairwell penthouse enclosure with wide access doorway
  wall(b, 'z', -23.0, 4.0, 11.0, roofWalkY, 2.6, 0.4, 'concrete');
  wall(b, 'x', 4.0, -23.0, -14.0, roofWalkY, 2.6, 0.4, 'concrete', { at: -18.5, width: 2.6, height: 2.5 });
  wall(b, 'x', 11.0, -23.0, -14.0, roofWalkY, 2.6, 0.4, 'concrete');
  br(b, -18.5, roofWalkY + 2.6, 7.5, 9.0, 0.3, 7.5, 'metalDark');

  // Roof Perimeter parapet walls
  wall(b, 'z', WX + WW / 2 + 0.5, WZ - WD / 2 - 0.5, WZ + WD / 2 + 0.5, roofWalkY, 0.95, 0.5, 'concrete');
  wall(b, 'z', WX - WW / 2 - 0.5, WZ - WD / 2 - 0.5, WZ + WD / 2 + 0.5, roofWalkY, 0.95, 0.5, 'concrete');
  wall(b, 'x', WZ - WD / 2 - 0.5, WX - WW / 2 - 0.5, WX + WW / 2 + 0.5, roofWalkY, 0.95, 0.5, 'concrete');
  wall(b, 'x', WZ + WD / 2 - 0.5, WX - WW / 2 - 0.5, WX + WW / 2 + 0.5, roofWalkY, 0.95, 0.5, 'concrete');

  // Rooftop industrial skylight monitor vents
  br(b, WX - 3, roofWalkY, WZ - 6, 6.0, 1.4, 5.0, 'metalDark');
  br(b, WX - 3, roofWalkY, WZ + 6, 6.0, 1.4, 5.0, 'metalDark');
  pr(p, 'cyl', WX + 6, roofWalkY, WZ - 8, 0.14, 7.0, 'metalDark', 'y', true);
  pr(p, 'sphere', WX + 6, roofWalkY + 7.0, WZ - 8, 0.18, 0, 'light');

  // ── West Operations North Connecting Annex (Closing Gap to Terrace) ────────
  wall(b, 'z', -28, 14, 23, 0, fl1H, 0.5, 'concrete');
  br(b, -21, fl1H, 18.5, 14.0, 0.4, 9.0, 'concreteDark');
  stairs(b, -21, HY, 24.5, 'z-', 3, (fl2Y - HY) / 3, 0.5, 10.0, 'concreteDark');
  wall(b, 'z', -28, 14, 23, fl2Y, fl2H, 0.5, 'concrete');
  br(b, -21, roofY, 18.5, 14.5, 0.4, 9.5, 'concreteDark');
  guard(b, p, 'z', -28.25, 14, 23, roofWalkY, 'metal');

  // ── 2. East Wing: Industrial Logistics Hangar (Right Complex) ─────────────
  const EX = 24;
  const EZ = 0;
  const EW = 20;
  const ED = 26;
  const EH = 6.2;

  const hangarBayDoor: Door = { at: EZ, width: 6.4, height: 4.8 };
  const hangarBackDoor: Door = { at: EX, width: 3.0, height: 3.2 };
  wall(b, 'z', EX - EW / 2, EZ - ED / 2, EZ + ED / 2, 0, EH, 0.5, 'concrete', hangarBayDoor);
  wall(b, 'z', EX + EW / 2, EZ - ED / 2, EZ + ED / 2, 0, EH, 0.5, 'concrete');
  wall(b, 'x', EZ - ED / 2, EX - EW / 2, EX + EW / 2, 0, EH, 0.5, 'concrete', hangarBackDoor);
  wall(b, 'x', EZ + ED / 2, EX - EW / 2, EX + EW / 2, 0, EH, 0.5, 'concrete', hangarBackDoor);

  // Hangar roof
  br(b, EX, EH, EZ, EW + 1.0, 0.4, ED + 1.0, 'concreteDark');
  br(b, EX, EH + 0.4, EZ - 5, 8.0, 1.2, 4.4, 'metalDark');
  br(b, EX, EH + 0.4, EZ + 5, 8.0, 1.2, 4.4, 'metalDark');

  // Hangar interior mezzanine catwalk with dedicated stairwell opening
  br(b, EX + EW / 2 - 2.0, 3.2, 4.5, 4.0, 0.4, 15.0, 'concreteDark');
  guard(b, p, 'z', EX + EW / 2 - 4.0, -3.0, 12.0, 3.6, 'metal');
  guard(b, p, 'x', 12.0, EX + EW / 2 - 4.0, EX + EW / 2, 3.6, 'metal');
  stairs(b, EX + EW / 2 - 2.0, 0, -8.04, 'z+', 12, 3.6 / 12, 0.42, 2.0, 'concreteDark');

  // Hangar interior crates & barrels
  br(b, EX - 2, 0, EZ - 6, 2.4, 1.2, 3.6, 'wood');
  br(b, EX - 2, 0, EZ + 6, 2.4, 2.2, 2.4, 'rust');
  barrel(p, EX + 2, 0, EZ - 6, 'paint');
  barrel(p, EX + 2, 0, EZ - 5, 'rust');
  lamp(p, EX, EH - 0.1, EZ, 0.45);

  // ── East Hangar North Covered Breezeway (Closing Gap to Terrace) ───────────
  br(b, 24, 0, 18, 12.0, 0.2, 10.0, 'concrete');
  roundColumn(p, 18.5, 0, 18, 0.35, 4.0, 'metalDark', 'metalDark');
  roundColumn(p, 29.5, 0, 18, 0.35, 4.0, 'metalDark', 'metalDark');
  br(b, 24, 4.0, 18, 12.5, 0.35, 10.5, 'metalDark');
  guard(b, p, 'z', 18, 13, 23, 4.35, 'metal');
  guard(b, p, 'z', 30, 13, 23, 4.35, 'metal');
  stairs(b, 24, HY, 24.5, 'z-', 4, (4.35 - HY) / 4, 0.45, 6.0, 'concreteDark');

  // ── 3. Blue Shipping Containers Depot ─────────────────────────────────────
  shippingContainer(b, p, 11, 0, -10, 'z', 'accent');
  shippingContainer(b, p, 11, 0, -3.6, 'z', 'accent');
  shippingContainer(b, p, 11, 2.6, -3.6, 'z', 'accent');
  shippingContainer(b, p, 11, 0, 10, 'z', 'accent');
  shippingContainer(b, p, 11, 0, 16.4, 'z', 'accent');
  shippingContainer(b, p, 15, 0, 3.6, 'x', 'accent');
  shippingContainer(b, p, 6, 0, 12, 'x', 'metalDark');

  // ── 4. Central Staging Courtyard, Roads & Sidewalks ───────────────────────
  // Paved central vehicle lane & markings
  br(b, 0, -1, -5, 12.0, 1.0, 46.0, 'concreteDark');

  // Raised pedestrian sidewalks & curbs
  br(b, -10.5, 0, 0, 3.0, 0.18, 28.0, 'concrete');
  br(b, 10.5, 0, 0, 3.0, 0.18, 26.0, 'concrete');
  br(b, 0, 0, 21.0, 36.0, 0.18, 4.0, 'concrete');
  br(b, 0, 0, -28.0, 24.0, 0.18, 4.0, 'concrete');

  militaryTruck(b, p, -1.0, 0, -12.0, 'z');

  br(b, 0, 0, 0, 2.6, 1.2, 2.6, 'wood');
  br(b, 2.2, 0, 0, 1.6, 1.6, 1.6, 'rust');
  barrel(p, -2.2, 0, 0, 'rust');
  barrel(p, -2.2, 0, 0.8, 'paint');

  wall(b, 'x', -4, -6, 2, 0, 1.1, 0.4, 'concreteDark');
  wall(b, 'x', 6, -2, 6, 0, 1.1, 0.4, 'concreteDark');

  // ── 5. Upper Back Heliport & Solar Generator Terrace (North) ──────────────
  br(b, 0, 0, HZ, HW, HY, HD, 'concrete');

  // Access stairs on left and right climbing from courtyard up to terrace
  stairs(b, -16, 0, 18.05, 'z+', 11, HY / 11, 0.45, 4.0, 'concreteDark');
  stairs(b, 16, 0, 18.05, 'z+', 11, HY / 11, 0.45, 4.0, 'concreteDark');

  // Helipad tarmac & painted "H" markings
  br(b, 0, HY, HZ, 16.0, 0.02, 16.0, 'concreteDark');
  wall(b, 'x', HZ - 7.5, -7.5, 7.5, HY + 0.02, 0.01, 0.4, 'accent');
  wall(b, 'x', HZ + 7.5, -7.5, 7.5, HY + 0.02, 0.01, 0.4, 'accent');
  wall(b, 'z', -7.5, HZ - 7.5, HZ + 7.5, HY + 0.02, 0.01, 0.4, 'accent');
  wall(b, 'z', 7.5, HZ - 7.5, HZ + 7.5, HY + 0.02, 0.01, 0.4, 'accent');

  // Bold "H"
  br(b, -2.2, HY + 0.02, HZ, 0.6, 0.01, 4.6, 'paint');
  br(b, 2.2, HY + 0.02, HZ, 0.6, 0.01, 4.6, 'paint');
  br(b, 0, HY + 0.02, HZ, 4.4, 0.01, 0.6, 'paint');
  ringAt(p, 0, HY + 0.02, HZ, 6.2, 0.2, 'paint', 'y');

  // Electrical Generator Substation
  vessel(p, -14, HY, HZ + 4, 1.1, 4.2, 'metal');
  vessel(p, -11, HY, HZ + 4, 1.1, 4.2, 'metal');
  vessel(p, -8, HY, HZ + 4, 0.9, 3.4, 'rust');

  // Solar panel arrays
  br(b, 10, HY, HZ + 4, 6.0, 1.6, 3.0, 'metalDark');
  br(b, 17, HY, HZ + 4, 6.0, 1.6, 3.0, 'metalDark');

  // Perimeter guardrail on terrace
  guard(b, p, 'x', HZ - HD / 2, -14, 14, HY, 'metal');
  guard(b, p, 'z', -HW / 2, HZ - HD / 2, HZ + HD / 2, HY, 'metal');
  guard(b, p, 'z', HW / 2, HZ - HD / 2, HZ + HD / 2, HY, 'metal');

  // ── 6. Front Security Checkpoint Guardhouse (South) ───────────────────────
  const GX = 0;
  const GZ = -32;
  building(b, GX, GZ, 7.0, 5.6, 3.2, 'concrete', 'concreteDark', { north: true, south: true });
  br(b, GX + 5.0, 0, GZ, 0.4, 1.0, 6.0, 'accent');
  lampPost(p, GX - 6, 0, GZ, 4.8, 1);
  lampPost(p, GX + 6, 0, GZ, 4.8, -1);

  // ── 7. Perimeter Watchtower Pillboxes (4 Corners) ─────────────────────────
  for (const [tx, tz] of [[-38, -38], [38, -38], [-38, 38], [38, 38]] as const) {
    br(b, tx, 0, tz, 6.0, 3.4, 6.0, 'concreteDark');
    wall(b, 'x', tz - 2.8, tx - 2.8, tx + 2.8, 3.4, 0.9, 0.4, 'concrete');
    wall(b, 'x', tz + 2.8, tx - 2.8, tx + 2.8, 3.4, 0.9, 0.4, 'concrete');
    // Outer wall solid, inner wall with access doorway from stairs
    wall(b, 'z', tx + (tx > 0 ? 2.8 : -2.8), tz - 2.8, tz + 2.8, 3.4, 0.9, 0.4, 'concrete');
    wall(b, 'z', tx + (tx > 0 ? -2.8 : 2.8), tz - 2.8, tz + 2.8, 3.4, 0.9, 0.4, 'concrete', { at: tz, width: 1.8, height: 0.9 });
    // Access stairs into watchtowers
    if (tx > 0) {
      stairs(b, 30.6, 0, tz, 'x+', 11, 3.4 / 11, 0.40, 1.8, 'concreteDark');
    } else {
      stairs(b, -30.6, 0, tz, 'x-', 11, 3.4 / 11, 0.40, 1.8, 'concreteDark');
    }
    pr(p, 'cyl', tx, 3.4, tz, 0.12, 2.7, 'metalDark', 'y', true);
    pr(p, 'sphere', tx, 6.1, tz, 0.22, 0, 'light');
  }

  // ── Spawns ────────────────────────────────────────────────────────────────
  const spawns: Spawn[] = [
    { x: -24, y: 0.05, z: -8, yaw: faceCentre(-24, -8) },
    { x: -24, y: 0.05, z: 8, yaw: faceCentre(-24, 8) },
    { x: 24, y: 0.05, z: -8, yaw: faceCentre(24, -8) },
    { x: 24, y: 0.05, z: 8, yaw: faceCentre(24, 8) },
    { x: -8, y: 0.05, z: -16, yaw: faceCentre(-8, -16) },
    { x: 4, y: 0.05, z: 16, yaw: faceCentre(4, 16) },
    { x: 6, y: 0.05, z: -10, yaw: faceCentre(6, -10) },
    { x: 6, y: 0.05, z: 4, yaw: faceCentre(6, 4) },
    { x: 0, y: 3.25, z: 33, yaw: faceCentre(0, 33) },
    { x: -16, y: 3.25, z: 33, yaw: faceCentre(-16, 33) },
    { x: 16, y: 3.25, z: 33, yaw: faceCentre(16, 33) },
    { x: 0, y: 0.05, z: -22, yaw: faceCentre(0, -22) },
  ];

  return {
    id: 0,
    key: 'dustworks',
    name: 'Dustworks',
    half: HALF,
    brushes: b,
    props: p,
    spawns,
    sky: 0x6e9ec8,
    fog: 0x9ec0de,
    fogNear: 50,
    fogFar: 140,
    sun: { x: -0.6, y: 0.9, z: -0.5 },
    sunColor: 0xfff6e8,
    ambientColor: 0xdae8f5,
    ambientGround: 0xb09c84,
    ambientIntensity: 0.9,
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
  const p: Prop[] = [];
  const HALF = 24;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'concreteDark');

  // Shell. Taller than Dustworks' perimeter because this one is a building
  // rather than a compound wall, and a 10 m wall stops a bunny-hopper reaching
  // the top of it from the catwalks.
  const PW = 10;
  for (const s of [-1, 1] as const) {
    wall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concrete');
    wall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concrete');
  }

  // ── The roof structure ────────────────────────────────────────────────────
  // The single biggest reason the hall used to read as a shoebox: a 10 m wall
  // with nothing at the top of it gives the eye no way to measure the span. Five
  // trusses with lamps hung off them fix that, and all of it is 3 m clear of
  // anything a player can stand on.
  const TRUSS_Z = [-16, -8, 0, 8, 16] as const;
  for (const z of TRUSS_Z) truss(p, 'x', -23, 23, 9.2, z);
  for (const x of [-16, -8, 8, 16]) {
    for (const z of TRUSS_Z) {
      // Aligned to the trusses on purpose, so the drop rod meets the chord it is
      // hanging from instead of ending in air two metres to one side of it.
      if (Math.abs(x) === 8 && Math.abs(z) === 16) continue;
      lamp(p, x, 8.6, z, 0.5);
    }
  }

  // Service runs down the inside of the shell, three bores to a wall. Against the
  // wall rather than out in the roof space because a pipe needs something visible
  // holding it up, and the wall is the one thing in here that is unambiguously
  // structural — it also makes them flush detail by rule 2 instead of decoration
  // floating over the walking surface.
  for (const s of [-1, 1] as const) {
    for (const [cy, r, mat] of [
      [5.0, 0.2, 'rust'],
      [5.7, 0.14, 'metal'],
      [6.3, 0.1, 'paint'],
    ] as const) {
      pipe(p, 'z', -23, 23, cy, 22.95 * s, r, mat);
      pipe(p, 'x', -23, 23, cy, 22.95 * s, r, mat);
    }
    // Flanged joints along the biggest bore, and the elbow turning each corner.
    for (const t of [-12, 0, 12]) {
      ringAt(p, 22.95 * s, 5.0, t, 0.27, 0.06, 'paint', 'z');
      ringAt(p, t, 5.0, 22.95 * s, 0.27, 0.06, 'paint', 'x');
    }
  }

  // ── The furnace ───────────────────────────────────────────────────────────
  // One solid block, and nothing anywhere touches it that would let you walk up.
  const FURN_H = 4.8;
  br(b, 0, 0, 0, 9, FURN_H, 9, 'metal');
  for (const [sx, sz] of CORNERS) {
    // Flues on top, and a heat-shield skirt at the base to crouch behind while
    // working around the block.
    br(b, 3 * sx, FURN_H, 3 * sz, 1.5, 2.6, 1.5, 'rust');
    br(b, 6.6 * sx, 0, 6.6 * sz, 2.6, 1.2, 2.6, 'rust');
    // A round stack on each flue, solid so that what stops a bullet is what the
    // player can see stopping it. Nothing can reach the 7.4 m it starts at — the
    // furnace roof is 2.6 m below it, twice what a jump clears — so the collider
    // it contributes is inert, and being inert is not a reason to make it a lie.
    pr(p, 'cyl', 3 * sx, FURN_H + 2.6, 3 * sz, 0.62, 2.6, 'metalDark', 'y', true);
    ringAt(p, 3 * sx, FURN_H + 2.9, 3 * sz, 0.68, 0.08, 'rust', 'y');
    pr(p, 'dome', 3 * sx, FURN_H + 5.2, 3 * sz, 0.62, 0.3, 'metalDark');
    barrel(p, 6.6 * sx + 1.9 * sx, 0, 6.6 * sz, 'paint');
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
    guard(b, p, 'z', (CAT_X + 1.6) * s, -16, 16, CAT_TOP, 'metal');
    guard(b, p, 'z', (CAT_X - 1.6) * s, -16, -5, CAT_TOP, 'metal');
    guard(b, p, 'z', (CAT_X - 1.6) * s, 5, 16, CAT_TOP, 'metal');
    stairs(b, CAT_X * s, 0, -22, 'z+', 12, CAT_TOP / 12, 0.5, 3, 'metal');
    stairs(b, CAT_X * s, 0, 22, 'z-', 12, CAT_TOP / 12, 0.5, 3, 'metal');
    // Columns carrying the outer edge. A catwalk resting on nothing is the single
    // clearest tell that a level was assembled rather than built.
    for (const z of [-13, -5, 5, 13]) {
      roundColumn(p, 14.2 * s, 0, z, 0.4, CAT_TOP - 0.4, 'metalDark', 'metal');
    }
  }

  // ── Floor clutter ─────────────────────────────────────────────────────────
  for (const s of [-1, 1] as const) {
    // Presses at the ends of the hall, tall enough to break the shot down the
    // middle of the aisle without blocking the aisle itself.
    br(b, 0, 0, 14 * s, 6, 1.8, 2.4, 'metal');
    // The roller each press works, solid so it is cover in its own right.
    pr(p, 'cyl', 0, 1.8, 14 * s, 0.3, 5, 'metal', 'x', true);
    for (const t of [-1, 1] as const) ringAt(p, 2.5 * t, 2.1, 14 * s, 0.34, 0.06, 'metalDark', 'x');
    // Racking along the side lanes, under the catwalks.
    br(b, 18 * s, 0, 0, 2.4, 3.4, 9, 'rust');
    // Process columns in the two far bays, with a ladder up the outboard side.
    for (const t of [-1, 1] as const) {
      vessel(p, 20.5 * s, 0, 13 * t, 1.05, 7.6, 'metal');
      ladder(p, 21.5 * s, 0, 13 * t, 7.6, 'x');
      barrel(p, 17.6 * s, 0, (13 + 1.6) * t, 'rust');
      barrel(p, 17.6 * s, 0, (13 - 1.6) * t, 'paint');
      br(b, 8 * s, 0, 13 * t, 1.8, 1.8, 1.8, 'wood');
      br(b, 8 * s + 1.5 * s, 0, 13 * t, 1.1, 1.1, 1.1, 'wood');
      bollard(p, 10.6 * s, 0, 13 * t, 0.9);
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
    props: p,
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
  const p: Prop[] = [];
  const HALF = 34;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'sand');

  const PW = 11;
  for (const s of [-1, 1] as const) {
    wall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'sandDark');
    wall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'sandDark');
    trimWall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'sand');
    trimWall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'sand');
  }

  // ── The deck ──────────────────────────────────────────────────────────────
  const DECK_Y = 5.5;
  const DECK_TOP = DECK_Y + 0.6;
  const DECK_X = 22;
  br(b, 0, DECK_Y, 0, DECK_X * 2, 0.6, 11, 'concrete');

  // Parapets, broken either side of the midpoint. The gap is the whole balance
  // of the map: it is the one place a player on the deck can be shot at from the
  // ground, and the one place they can drop off without walking to an end.
  for (const s of [-1, 1] as const) {
    for (const [from, to] of [
      [-DECK_X, -7],
      [7, DECK_X],
    ] as const) {
      wall(b, 'x', 5.5 * s, from, to, DECK_TOP, 1.1, 0.5, 'concreteDark');
      // The rail capping it. Round, because a concrete kerb with a square top is
      // the shape nobody has ever built a road bridge out of.
      pipe(p, 'x', from, to, DECK_TOP + 1.15, 5.5 * s, 0.055, 'paint');
    }
  }

  // Pillars — round piers, and the reason to bother: a solid cylinder collides
  // with the square inscribed in it, so `PILLAR_R = 1.8/√2` hands back the exact
  // 1.8 m box these used to be while the player sees a pier. Cover is unchanged
  // to the millimetre; only the silhouette is honest now.
  const PILLAR_R = 1.8 / Math.SQRT2;
  const PILLAR_X = [-18, -9, 0, 9, 18] as const;
  for (const x of PILLAR_X) {
    for (const s of [-1, 1] as const) {
      pr(p, 'cyl', x, 0, 3.6 * s, PILLAR_R, DECK_Y, 'concreteDark', 'y', true);
      ringAt(p, x, DECK_Y - 0.22, 3.6 * s, PILLAR_R * 1.04, 0.16, 'concrete', 'y');
      ringAt(p, x, 0.42, 3.6 * s, PILLAR_R * 1.06, 0.18, 'concrete', 'y');
    }
    // Cross beam tying each pair of piers, tucked under the slab soffit.
    pipe(p, 'z', -5.5, 5.5, DECK_Y, x, 0.11, 'concreteDark');
  }
  // Edge beams down the length of the soffit.
  for (const s of [-1, 1] as const) pipe(p, 'x', -DECK_X, DECK_X, DECK_Y, 5 * s, 0.13, 'concreteDark');

  // Ramps at both ends, descending outward from the deck. 18 steps of 0.339 —
  // under the 0.35 step-up, so it is walkable rather than a stack to hop.
  const RAMP_STEPS = 18;
  stairs(b, 31, 0, 0, 'x-', RAMP_STEPS, DECK_TOP / RAMP_STEPS, 0.5, 5.4, 'concreteDark');
  stairs(b, -31, 0, 0, 'x+', RAMP_STEPS, DECK_TOP / RAMP_STEPS, 0.5, 5.4, 'concreteDark');

  // ── Ground level ──────────────────────────────────────────────────────────
  // A container across the midpoint, directly under the parapet gap, so the
  // ground fight there has cover of its own.
  br(b, 0, 0, 0, 6, 2.4, 2.6, 'rust');
  for (const s of [-1, 1] as const) {
    barrel(p, 3.6 * s, 0, 1.9, 'paint');
    barrel(p, 3.6 * s, 0, -1.9, 'rust');
  }
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
    // Roof plant, and the conduit along the parapet it sits behind.
    roundColumn(p, (15 - 3) * sx, 5.4, (20 - 3) * sz, 0.95, 1.1, 'metal', 'metalDark');
    pr(p, 'cyl', (15 + 3.4) * sx, 5.4, (20 + 3.4) * sz, 0.5, 3.2, 'rust', 'y', true);
    pr(p, 'dome', (15 + 3.4) * sx, 8.6, (20 + 3.4) * sz, 0.5, 0.34, 'rust');
    const e0 = (15 - 5.5) * sx;
    const e1 = (15 + 5.5) * sx;
    pipe(p, 'x', Math.min(e0, e1), Math.max(e0, e1), 5.95, (20 + 5.5 + 0.05) * sz, 0.09, 'metal');
    lamp(p, 15 * sx, 4.95, 20 * sz, 0.35);
    // A tall post on the verge, throwing light across the deck from beside it.
    lampPost(p, 26 * sx, 0, 8 * sz, 8.5, -0.9 * sx);
  }
  // Low walls along the two side lanes, with a gap at the middle of each.
  for (const s of [-1, 1] as const) {
    for (const [from, to] of [
      [-18, -7],
      [7, 18],
    ] as const) {
      wall(b, 'x', 26 * s, from, to, 0, 2.4, 0.6, 'rust');
      trimWall(b, 'x', 26 * s, from, to, 2.4, 0.6, 'sandDark', 20);
    }
  }

  // ── Skyline ───────────────────────────────────────────────────────────────
  // The road has to come from somewhere and go somewhere. Two abutment blocks
  // carrying it out past the wall, and a town behind them.
  for (const s of [-1, 1] as const) {
    br(b, 40 * s, -1, 0, 18, 7, 13, 'concreteDark');
    br(b, 40 * s, 6, 0, 19, 0.6, 14, 'concrete');
    tank(p, 47 * s, 0, 26, 8, 15, 'sandDark');
  }
  pr(p, 'cyl', -13, 0, -46, 2.3, 31, 'concrete');
  pr(p, 'cyl', -13, 31, -46, 2.3, 1.2, 'paint');
  pr(p, 'cyl', 20, 0, 48, 2, 26, 'concreteDark');
  for (const [x, z, w, d, h] of [
    [-52, 40, 18, 15, 14],
    [50, -42, 22, 16, 12],
    [8, -52, 16, 13, 17],
    [-26, 54, 20, 14, 11],
  ] as const) {
    br(b, x, -1, z, w, h, d, 'sandDark');
    br(b, x, h - 1, z, w + 1, 0.6, d + 1, 'sand');
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
    props: p,
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
  const p: Prop[] = [];
  const HALF = 32;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'concrete');

  const PW = 10;
  for (const s of [-1, 1] as const) {
    wall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concreteDark');
    wall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concreteDark');
    trimWall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'concrete');
    trimWall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'concrete');
  }

  // ── The two bases ─────────────────────────────────────────────────────────
  // Doors on the inward face and both flanks, none at the back: a base is a
  // position to hold, and one that can be entered from behind is not.
  const ROOF = 5.4;
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

    // Roof plant. A base roof is the one surface here that gets fought over from
    // below, and a bare slab inside a parapet gives that fight nothing: no sightline
    // broken, nothing to peek from. A stair head and a vent stack give it both, and
    // both are solid, so the cover is real. They sit toward the back so the parapet
    // facing the enemy stays the firing position rather than becoming the only one.
    const rz = 26.2 * s;
    roundColumn(p, -6, ROOF, rz, 0.85, 1.5, 'concreteDark', 'accent');
    pr(p, 'cyl', 6, ROOF, rz, 0.5, 2.8, 'rust', 'y', true);
    ringAt(p, 6, ROOF + 1.5, rz, 0.56, 0.07, 'metalDark', 'y');
    pr(p, 'dome', 6, ROOF + 2.8, rz, 0.5, 0.4, 'rust');

    // Conduit along the back parapet, a ladder up the flank clear of the doorway,
    // and lamps under the roof — the inside of a base was lit by nothing at all and
    // read as a hole in a wall rather than a room somebody works in.
    pipe(p, 'x', -11, 11, ROOF + 0.6, (24 + 5.5) * s, 0.09, 'metal');
    ladder(p, 10.55, 0, 20.6 * s, 5, 'x');
    for (const x of [-7, 0, 7]) lamp(p, x, 5, 24 * s, 0.35);
  }

  // ── The walkway ───────────────────────────────────────────────────────────
  // Runs base to base, so pushing along it is pushing at the enemy. Railings
  // broken in the middle, which is where a fight on it is decided.
  const BR_Y = 3.4;
  const BR_TOP = BR_Y + 0.5;
  br(b, 0, BR_Y, 0, 8, 0.5, 22, 'metal');
  for (const s of [-1, 1] as const) {
    guard(b, p, 'z', 4 * s, -11, -3, BR_TOP, 'metal');
    guard(b, p, 'z', 4 * s, 3, 11, BR_TOP, 'metal');
    stairs(b, 0, 0, 17 * s, `z${s > 0 ? '-' : '+'}`, 12, BR_TOP / 12, 0.5, 5, 'metal');
    // Piers under the deck edge. A 22 m span floating on nothing was the most
    // unfinished thing on the map seen from the courtyard, and they cost the ground
    // route almost nothing: two 0.57 m boxes inside an 8 m gap.
    for (const z of [0, 8, -8]) roundColumn(p, 3 * s, 0, z, 0.4, BR_Y, 'metalDark', 'metal');
  }

  // ── The courtyard ─────────────────────────────────────────────────────────
  for (const [sx, sz] of CORNERS) {
    br(b, 16 * sx, 0, 8 * sz, 6, 2.6, 2.6, 'rust');
    br(b, 24 * sx, 0, 16 * sz, 2.6, 1.5, 2.6, 'wood');
    br(b, 7 * sx, 0, 14 * sz, 2.2, 1.2, 2.2, 'wood');
    // Drums beside the containers rather than in the lanes, and one on top of a
    // crate, which is what makes a stack read as stored goods and not as geometry.
    barrel(p, 19.6 * sx, 0, 8 * sz, 'paint');
    barrel(p, 19.6 * sx, 0, 9.2 * sz, 'rust');
    barrel(p, 24 * sx, 1.5, 16 * sz, 'metal');
    bollard(p, 12 * sx, 0, 3 * sz, 0.9);
  }
  // Under-walkway cover, so crossing the middle at ground level is possible.
  for (const s of [-1, 1] as const) br(b, 0, 0, 6 * s, 3, 1.5, 3, 'rust');
  // Side-lane screens: the flanks are a real route, not an empty margin.
  for (const s of [-1, 1] as const) {
    wall(b, 'z', 22 * s, -6, 6, 0, 2.8, 0.6, 'concreteDark');
    trimWall(b, 'z', 22 * s, -6, 6, 2.8, 0.6, 'concrete', 20);
    br(b, 28 * s, 0, 0, 2.4, 3.2, 7, 'concreteDark');
    pipe(p, 'z', -6, 6, 2.3, 22 * s, 0.11, 'rust');
    pipe(p, 'z', -3.5, 3.5, 2.7, 28 * s, 0.09, 'metal');
  }
  // Floodlights on the diagonals, arms cranked inward. Four posts are the whole
  // difference between a yard somebody lights and a slab with walls round it.
  for (const [sx, sz] of CORNERS) lampPost(p, 28 * sx, 0, 22 * sz, 8.5, -0.9 * sx);

  // ── Skyline ───────────────────────────────────────────────────────────────
  // Rule 4 territory: all of it entirely outside the perimeter, so it exists only
  // to be looked at over the wall. From a base roof the sight line clears a 10 m
  // parapet at roughly 14 m of height by 60 m out, which is what sets the sizes
  // below — anything shorter is hidden by the thing it is meant to be seen past.
  for (const [sx, sz] of CORNERS) {
    br(b, 46 * sx, 0, 44 * sz, 20, 16, 18, 'concreteDark');
    br(b, 46 * sx, 16, 44 * sz, 21, 0.6, 19, 'concrete');
  }
  tank(p, 40, 0, -46, 6.5, 14, 'metal');
  tank(p, 52, 0, 6, 5.2, 11, 'metalDark');
  for (const [x, z, h] of [
    [-44, -40, 26],
    [-50, 12, 22],
    [38, 41, 30],
  ] as const) {
    pr(p, 'cyl', x, 0, z, 1.5, h, 'concreteDark');
    ringAt(p, x, h - 1.2, z, 1.6, 0.12, 'paint', 'y');
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
    props: p,
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
  const p: Prop[] = [];
  const HALF = 20;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'concreteDark');

  const PW = 8;
  for (const s of [-1, 1] as const) {
    wall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concrete');
    wall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concrete');
    trimWall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'concreteDark');
    trimWall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'concreteDark');
    // Service conduit round the inside of the tank wall, and the inlet each side
    // discharges through. The stubs are the reason the room reads as plumbing: a
    // cistern with no way in is a swimming pool.
    pipe(p, 'z', -13, 13, 6.6, 18.9 * s, 0.13, 'rust');
    pipe(p, 'x', -13, 13, 6.6, 18.9 * s, 0.13, 'rust');
    pr(p, 'cyl', 18.6 * s, 4.55, 0, 0.45, 1.8, 'concreteDark', 'x');
    ringAt(p, 17.9 * s, 5, 0, 0.5, 0.07, 'paint', 'x');
    pr(p, 'cyl', 0, 4.55, 18.6 * s, 0.45, 1.8, 'concreteDark', 'z');
    ringAt(p, 0, 5, 17.9 * s, 0.5, 0.07, 'paint', 'z');
  }

  // ── The ring ──────────────────────────────────────────────────────────────
  // 1.6 m up: above the 1.24 m a jump clears, so the ramps are the only way up
  // and the ring is a position rather than a ledge. The floor is a full slab
  // underneath it all — the "sunken" middle is the rest of the map being raised,
  // which means there is no hole in the world to fall through.
  const RING_Y = 1.6;
  for (const s of [-1, 1] as const) {
    br(b, 0, 0, 16.25 * s, 38, RING_Y, 5.5, 'concrete');
    br(b, 16.25 * s, 0, 0, 5.5, RING_Y, 27, 'concrete');
    // Inner parapet, open where the ramp arrives. A kick panel with a round rail on
    // top rather than a 0.4 m slab: the slab was the thing you saw from every point
    // in the pit, and a handrail is the detail that tells you the ring is a walkway.
    guard(b, p, 'x', 13.5 * s, -19, -3, RING_Y, 'metal');
    guard(b, p, 'x', 13.5 * s, 3, 19, RING_Y, 'metal');
    guard(b, p, 'z', 13.5 * s, -13.5, -3, RING_Y, 'metal');
    guard(b, p, 'z', 13.5 * s, 3, 13.5, RING_Y, 'metal');
    // Ramps down into the middle, one per side.
    stairs(b, 0, 0, 10.5 * s, `z${s > 0 ? '+' : '-'}`, 5, RING_Y / 5, 0.6, 5, 'concreteDark');
    stairs(b, 10.5 * s, 0, 0, `x${s > 0 ? '+' : '-'}`, 5, RING_Y / 5, 0.6, 5, 'concreteDark');
  }

  // ── The middle ────────────────────────────────────────────────────────────
  br(b, 0, 0, 0, 5, 2.2, 5, 'metal');
  for (const [sx, sz] of CORNERS) {
    // Columns carrying the roof that is not modelled, tall enough to break the
    // ring's view of the opposite ramp. Round, and solid at exactly the radius whose
    // inscribed square is the 1.6 m box these used to be — so the cover behind them
    // is unchanged to the millimetre and only the silhouette is different.
    roundColumn(p, 7 * sx, 0, 7 * sz, 1.6 / Math.SQRT2, 3.4, 'concrete', 'concreteDark');
    br(b, 10 * sx, 0, 5 * sz, 1.8, 1.8, 1.8, 'rust');
    br(b, 4 * sx, 0, 11 * sz, 1.5, 1.1, 1.5, 'wood');
    barrel(p, 12.2 * sx, 0, 5 * sz, 'paint');
    barrel(p, 10 * sx, 1.8, 5 * sz, 'rust');
    bollard(p, 4 * sx, 1.1, 11 * sz, 0.8);
  }

  // Trusses across the top and the lamps hung off them. Not a slab: a lid would
  // make the pit feel like the inside of a box, which is the one thing a map this
  // enclosed cannot afford. A truss gives the space a top edge to read the height
  // against and leaves the sky doing the lighting.
  for (const z of [-9, 0, 9]) truss(p, 'x', -13, 13, 7.4, z);
  for (const x of [-8, 0, 8]) {
    for (const z of [-9, 0, 9]) lamp(p, x, 6.4, z, 0.4);
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
    props: p,
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
 * Refinery — the big one.
 *
 * The other five levels are arenas: a shape, dressed. This one is a *place*, and
 * at 92 m across it is more than twice the floor area of anything else here, so it
 * had to be laid out the way a plant is laid out rather than the way an arena is.
 * Every zone is something with a job:
 *
 *   • **Two process halls**, north and south, 48 m wide with a 9 m roller door
 *     facing the middle. These are the bases, and the only enclosed volumes on the
 *     map — the one place a player can reload out of sight of a sniper.
 *   • **A pipe rack** crossing the whole yard, carried on round columns, with a
 *     walkway on top and three banks of product line running either side of it.
 *     This is the map's spine and its signature: from anywhere in the yard the
 *     silhouette overhead tells you which way you are facing.
 *   • **A bunded tank farm** on the east, with a platform between the vessels.
 *   • **A loading dock** on the west, raised 1.2 m — low enough to hop, high
 *     enough that the containers on it break every sight line across that flank.
 *
 * Mirror-symmetric across z, which makes the two halls exact reflections and is a
 * fairness requirement rather than a preference. Deliberately *not* symmetric
 * across x: the tank farm and the dock play completely differently, and both bases
 * look out on both of them, so nobody is advantaged and the map stops reading as a
 * kaleidoscope. That asymmetry is most of what makes it feel like somewhere real.
 *
 * The vertical scheme is three surfaces and one number:
 *
 *   yard 0 → catwalk 4.4 → hall roof 5.4
 *
 * Stairs get you to the catwalk; the last metre onto a roof is a **jump**, because
 * 1.0 m is under the 1.24 m a jump clears and over the 0.35 m a player can walk
 * up. So the roofs are held by whoever commits to the hop, and the parapet is left
 * open for 6 m at the middle of each hall so there is exactly one place to do it.
 */
function buildRefinery(): GameMap {
  const b: Brush[] = [];
  const p: Prop[] = [];
  const HALF = 46;

  br(b, 0, -1, 0, HALF * 2, 1, HALF * 2, 'concrete');

  // Perimeter. Taller than the other maps' at 12 m, because a 92 m yard with an
  // 8 m wall around it reads as a field with a fence; 12 m reads as a compound.
  const PW = 12;
  for (const s of [-1, 1] as const) {
    wall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concreteDark');
    wall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, 0, PW, 1, 'concreteDark');
    trimWall(b, 'x', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'concrete', 8);
    trimWall(b, 'z', (HALF - 0.5) * s, -HALF, HALF, PW, 1, 'concrete', 8);
  }

  const DECK = 4.0; // catwalk slab bottom; walking surface is 0.4 above
  const DECK_TOP = DECK + 0.4;
  const HALL_H = 5.0;
  const ROOF = HALL_H + 0.4; // hall roof walking surface

  // ── The pipe rack ─────────────────────────────────────────────────────────
  // A cross, not a single run: the long arm carries the eye from wall to wall, and
  // the short arm is the route between the two bases that does not involve
  // crossing the yard at ground level. They overlap at the middle, which is the
  // one piece of ground worth fighting over on a map this size.
  br(b, 0, DECK, 0, 80, 0.4, 5, 'metal');
  br(b, 0, DECK, 0, 5, 0.4, 45, 'metal');
  for (const s of [-1, 1] as const) {
    guard(b, p, 'x', 2.5 * s, -40, -2.5, DECK_TOP, 'metal');
    guard(b, p, 'x', 2.5 * s, 2.5, 40, DECK_TOP, 'metal');
    guard(b, p, 'z', 2.5 * s, -22.5, -2.5, DECK_TOP, 'metal');
    guard(b, p, 'z', 2.5 * s, 2.5, 22.5, DECK_TOP, 'metal');
  }
  // Columns, topping out exactly at the slab soffit.
  for (const x of [-36, -24, -12, 12, 24, 36]) roundColumn(p, x, 0, 0, 0.75, DECK, 'concreteDark', 'concrete');
  for (const z of [-18, -9, 9, 18]) roundColumn(p, 0, 0, z, 0.75, DECK, 'concreteDark', 'concrete');

  // Product lines either side of the walkway, stopped short of the crossing so
  // nothing runs through the deck a player is standing on. Three gauges rather
  // than one: a single pipe reads as a handrail, three read as a plant.
  //
  // The outer ends stop at 25.4 and not at the bund wall at 26, because the last
  // 30 cm of a pipe passing 2.5 m over a wall somebody is crouched behind is cover
  // as far as the eye is concerned. `propPlacementIssue` is right to reject that,
  // and moving the pipe is a better answer than lowering the wall.
  for (const s of [-1, 1] as const) {
    for (const [x0, x1] of [
      [-25.4, -4],
      [4, 25.4],
    ] as const) {
      pipe(p, 'x', x0, x1, 3.7, 3.6 * s, 0.2, 'metal');
      pipe(p, 'x', x0, x1, 4.5, 3.6 * s, 0.26, 'rust');
      pipe(p, 'x', x0, x1, 5.1, 3.6 * s, 0.15, 'paint');
      // Sleepers under the bank. Solid, so they are honest cover at 23 cm, and
      // they stop the run reading as three pipes suspended from nothing.
      for (let x = x0 + 5; x < x1 - 1; x += 11) pr(p, 'cyl', x, 0, 3.6 * s, 0.16, 3.5, 'metalDark', 'y', true);
    }
    // Valve stations where the banks pass the crossing.
    ringAt(p, 24 * s, 4.5, 3.6, 0.34, 0.06, 'paint', 'x');
    ringAt(p, 24 * s, 4.5, -3.6, 0.34, 0.06, 'paint', 'x');
    elbow(p, 25.4 * s, 4.5, 3.6 * s, 0.3, 'rust');
  }
  // Stairs to the deck, one per quadrant, arriving on the short arm so no flight
  // ever crosses under the product banks.
  for (const [sx, sz] of CORNERS) {
    stairs(b, 9 * sx, 0, 14 * sz, sx > 0 ? 'x-' : 'x+', 13, 0.34, 0.5, 4, 'metal');
  }
  for (const x of [-30, -18, -6, 6, 18, 30]) lamp(p, x, DECK, 0, 0.3);

  // ── The two process halls ─────────────────────────────────────────────────
  for (const s of [-1, 1] as const) {
    const cz = 33 * s;
    const zIn = 24 * s; // face toward the middle
    const zOut = 42 * s;
    const z0 = Math.min(zIn, zOut);
    const z1 = Math.max(zIn, zOut);
    const t = 0.6;

    // Roller door wide enough to fight through, and high enough that the lintel
    // clears the catwalk that stops just short of it.
    wall(b, 'x', zIn, -24, 24, 0, HALL_H, t, 'concrete', { at: 0, width: 9, height: 4.2 });
    wall(b, 'x', zOut, -24, 24, 0, HALL_H, t, 'concrete');
    wall(b, 'z', -24, z0, z1, 0, HALL_H, t, 'concrete', { at: cz, width: 4, height: 3.2 });
    wall(b, 'z', 24, z0, z1, 0, HALL_H, t, 'concrete', { at: cz, width: 4, height: 3.2 });

    br(b, 0, HALL_H, cz, 49, 0.4, 19, 'concreteDark');
    const rIn = 23.5 * s;
    const rOut = 42.5 * s;
    const r0 = Math.min(rIn, rOut);
    const r1 = Math.max(rIn, rOut);
    // Parapet, open for 6 m where the catwalk hop lands.
    wall(b, 'x', rIn, -24.5, -3, ROOF, 0.9, 0.5, 'concreteDark');
    wall(b, 'x', rIn, 3, 24.5, ROOF, 0.9, 0.5, 'concreteDark');
    wall(b, 'x', rOut, -24.5, 24.5, ROOF, 0.9, 0.5, 'concreteDark');
    wall(b, 'z', -24.5, r0, r1, ROOF, 0.9, 0.5, 'concreteDark');
    wall(b, 'z', 24.5, r0, r1, ROOF, 0.9, 0.5, 'concreteDark');

    // Interior mezzanine down one end, and the flight up to it. Puts a shooter
    // above the door without giving them the roof.
    const MZ = 2.6;
    br(b, 19, MZ, cz, 10, 0.4, 12, 'metal');
    guard(b, p, 'z', 14, Math.min(cz - 6, cz + 6), Math.max(cz - 6, cz + 6), MZ + 0.4, 'metal');
    stairs(b, 10, 0, cz, 'x+', 9, MZ / 9 + 0.045, 0.5, 4, 'metal');

    // Plant against the outward wall: reactors, drums, the overhead line feeding
    // them, and the lamps. All of it clear of the door and of the three spawn
    // points on the open floor.
    for (const x of [-19, -13]) vessel(p, x, 0, cz + 6.4 * s, 1.5, 4.4, 'metal');
    vessel(p, 6, 0, cz + 6.4 * s, 1.2, 3.6, 'rust');
    for (const x of [-22, -16, -10]) barrel(p, x, 0, cz - 7 * s, 'paint');
    barrel(p, -22, 0.9, cz - 7 * s, 'rust');
    br(b, 12, 0, cz - 6 * s, 3.2, 1.4, 2.4, 'wood');
    // Two boxes rather than one 2.2 m block: the low half is the step, the tall
    // half is the cover, and the split leaves the overhead line 2.8 m clear of
    // anything standable instead of 1.8.
    br(b, -4, 0, cz + 7 * s, 2.6, 1.2, 2.6, 'rust');
    br(b, -4, 1.2, cz + 7.8 * s, 2.6, 1.0, 1.0, 'rust');
    pipe(p, 'x', -22, 8, 4.2, cz + 6.4 * s, 0.22, 'rust');
    // Clear of the flight at x 10..14: a lamp is 2.6 m of headroom or it is
    // something a player on the fourth step walks their face into.
    for (const x of [-16, -6, 4]) lamp(p, x, HALL_H, cz, 0.4);
    // On the end wall, not on the mezzanine's own edge: a ladder has to be flush
    // to something full height or it is a decoration hanging in a doorway.
    ladder(p, 23.5, 0, cz + 4 * s, MZ + 0.4, 'x');

    // Roof plant. Solid, so every silhouette up there is something to hide behind
    // rather than something to be surprised by.
    for (const x of [-14, 14]) {
      pr(p, 'cyl', x, ROOF, cz, 1.1, 2.8, 'metal', 'y', true);
      ringAt(p, x, ROOF + 2.8, cz, 1.12, 0.1, 'metalDark', 'y');
      pr(p, 'dome', x, ROOF + 2.8, cz, 1.1, 0.7, 'metal');
    }
    pr(p, 'cyl', 0, ROOF, cz + 6 * s, 0.9, 3.2, 'rust', 'y', true);
    pr(p, 'cone', 0, ROOF + 3.2, cz + 6 * s, 0.9, 0.9, 'rust');

    // Floodlights on the outward corners, and the perimeter conduit.
    for (const sx of [-1, 1] as const) lampPost(p, 21 * sx, ROOF + 1.3, cz + 7 * s, 4.6, -0.9 * sx);
    pipe(p, 'x', -34, 34, 8.4, 44.6 * s, 0.16, 'rust');
  }

  // ── East: the tank farm ───────────────────────────────────────────────────
  // A bund is a low wall round a spill, which makes it the most useful shape in
  // the game: 1.0 m is cover standing and a hop to cross, so the whole quadrant
  // is fightable without a single piece of geometry taller than a table.
  for (const s of [-1, 1] as const) {
    wall(b, 'x', 16 * s, 26, 42, 0, 1.0, 0.6, 'concreteDark');
    trimWall(b, 'x', 16 * s, 26, 42, 1.0, 0.6, 'concrete', 8);
  }
  wall(b, 'z', 42, -16, 16, 0, 1.0, 0.6, 'concreteDark');
  wall(b, 'z', 26, -16, 16, 0, 1.0, 0.6, 'concreteDark', { at: 0, width: 5, height: 1.0 });
  for (const s of [-1, 1] as const) {
    vessel(p, 32, 0, 10 * s, 1.6, 9.5, 'metal');
    vessel(p, 39, 0, 12 * s, 1.35, 7.0, 'concrete');
    pipe(p, 'z', 4, 13, 6.2, 32, 0.18, 'rust');
    ringAt(p, 32, 6.2, 13.4 * s, 0.24, 0.05, 'paint', 'z');
  }
  // Platform between them, and the flight up to it.
  br(b, 34, DECK, 0, 10, 0.4, 5, 'metal');
  for (const s of [-1, 1] as const) guard(b, p, 'x', 2.5 * s, 29, 39, DECK_TOP, 'metal');
  guard(b, p, 'z', 39, -2.5, 2.5, DECK_TOP, 'metal');
  stairs(b, 34, 0, 9, 'z-', 13, 0.34, 0.5, 4, 'metal');
  for (const x of [30, 38]) lamp(p, x, DECK, 0, 0.3);
  // 2.8, not 2.4: a vessel's domed head is decoration, and it has to sit 2.6 m
  // clear of the platform holding the vessel up.
  vessel(p, 34, DECK_TOP, 0, 0.9, 2.8, 'rust');
  for (const [sx, sz] of CORNERS) barrel(p, 28.5 + 1.3 * sx, 0, 6 * sz, sx > 0 ? 'rust' : 'paint');

  // ── West: the loading dock ────────────────────────────────────────────────
  // Two aprons, not one, with a lane between them at ground level where the pipe
  // rack crosses. The rack's columns then land on ground instead of standing in
  // the middle of a slab, the lamps under its deck have the 2.6 m they need, and
  // the dock gains the thing a flat 14x44 platform did not have: a way through it
  // that is not over it. The 1.2 m lip is the step, and a jump clears 1.24.
  for (const s of [-1, 1] as const) br(b, -35, 0, 12.75 * s, 14, 1.2, 18.5, 'concrete');
  for (const s of [-1, 1] as const) trimWall(b, 'x', 22 * s, -42, -28, 1.2, 0.5, 'concreteDark', 7);
  // Containers. Two heights, adjacent, so the tall ones are cover and the short
  // ones are the step onto them — a 2.4 m box with nothing beside it is a wall.
  for (const s of [-1, 1] as const) {
    br(b, -38, 1.2, 8 * s, 5, 2.4, 6, s > 0 ? 'accent' : 'rust');
    br(b, -32, 1.2, 8 * s, 5, 1.2, 6, 'paint');
    br(b, -38, 1.2, 17 * s, 5, 1.2, 5, 'rust');
    br(b, -31, 1.2, 16 * s, 4, 2.4, 4, 'accent');
    bollard(p, -27.4, 1.2, 12 * s, 1.0);
    bollard(p, -27.4, 1.2, 4 * s, 1.0);
  }
  // In the lane, not on the apron: at 1.2 m its top is flush with the lip, so it
  // is the step up as well as the cover down there.
  br(b, -35, 0, 0, 6, 1.2, 5, 'wood');
  // Gantry over the dock: solid legs, a truss each way, and the hoist. The cross
  // rail has to pass over the pipe rack, whose handrail tops out at 5.4, so the
  // rails sit at 9.1 rather than 7.6 — the bottom chord then clears the rack by
  // 2.7 m and a container top by 4.5, and the whole thing reads as a yard crane
  // instead of a pergola.
  const GANTRY = 9.1;
  for (const s of [-1, 1] as const) {
    for (const x of [-41, -29]) pr(p, 'cyl', x, 1.2, 10 * s, 0.28, GANTRY - 1.2, 'metalDark', 'y', true);
    truss(p, 'x', -41, -29, GANTRY, 10 * s);
    pr(p, 'cyl', -35, GANTRY - 0.7, 10 * s, 0.22, 1.0, 'paint', 'y', true);
  }
  truss(p, 'z', -10, 10, GANTRY, -35);
  for (const s of [-1, 1] as const) lampPost(p, -26.6, 1.2, 20 * s, 4.6, 0.9);

  // ── The yard ──────────────────────────────────────────────────────────────
  // Cover in the open ground, kept clear of the band under the product banks so
  // nothing raises the floor beneath a pipe.
  for (const [sx, sz] of CORNERS) {
    br(b, 16 * sx, 0, 9 * sz, 4.5, 1.5, 3, 'wood');
    br(b, 30 * sx, 0, 22 * sz, 3.5, 2.2, 3.5, 'concreteDark');
    br(b, 10 * sx, 0, 20 * sz, 3, 1.2, 6, 'rust');
    br(b, 21 * sx, 0, 30 * sz, 6, 1.8, 3, 'sandDark');
    barrel(p, 13.6 * sx, 0, 9 * sz, 'rust');
    barrel(p, 13.6 * sx, 0, 10.4 * sz, 'paint');
    barrel(p, 16 * sx, 1.5, 9 * sz, 'metal');
    bollard(p, 6 * sx, 0, 26 * sz, 1.0);
    roundColumn(p, 27 * sx, 0, 15 * sz, 0.55, 3.2, 'concreteDark', 'paint');
    lampPost(p, 41 * sx, 0, 33 * sz, 8.5, -0.9 * sx);
  }

  // ── Beyond the wall ───────────────────────────────────────────────────────
  // The rest of the plant, which exists purely so the 12 m wall is not the end of
  // the world. Sized and placed to clear the parapet from a hall roof: from an eye
  // at 7.1 m the sight line rises about 0.09 per metre, so at 60 m out anything
  // over ~13 m shows. Everything here is past the perimeter, so none of it is
  // subject to the placement rules and none of it is ever collided.
  for (const s of [-1, 1] as const) {
    tank(p, -6, 0, 64 * s, 7.5, 21, 'metal');
    tank(p, 16, 0, 58 * s, 5.5, 15, 'metalDark');
    tank(p, -34, 0, 60 * s, 6.2, 17, 'concrete');
    // Fractionating column and its flare, the tallest things on the horizon.
    pr(p, 'cyl', 38, 0, 56 * s, 3.2, 34, 'concrete');
    for (let y = 6; y < 32; y += 6) ringAt(p, 38, y, 56 * s, 3.4, 0.35, 'metalDark', 'y');
    pr(p, 'dome', 38, 34, 56 * s, 3.2, 2.4, 'concrete');
    pr(p, 'cyl', 52, 0, 30 * s, 1.7, 40, 'metalDark');
    pr(p, 'cone', 52, 40, 30 * s, 1.7, 3.5, 'paint');
    // A town, so the skyline is not all industry.
    for (const [i, x] of [-58, -50, 56, 62].entries()) {
      const h = 14 + ((i * 7) % 11);
      br(b, x, 0, (52 + i * 6) * s, 18, h, 16, i % 2 ? 'concreteDark' : 'concrete');
      br(b, x, h, (52 + i * 6) * s, 19, 0.8, 17, 'concrete');
    }
  }

  // ── Spawns ────────────────────────────────────────────────────────────────
  // Four inside each hall and one on each flank per side, so a team holds its own
  // hall while both teams look out on the dock and the tank farm equally.
  const spawns: Spawn[] = [];
  for (const s of [-1, 1] as const) {
    for (const [x, z] of [
      [-16, 36],
      [0, 38],
      [16, 36],
      [0, 27],
    ] as const) {
      spawns.push({ x, y: 0.05, z: z * s, yaw: faceCentre(x, z * s) });
    }
    spawns.push({ x: -35, y: 1.25, z: 20 * s, yaw: faceCentre(-35, 20 * s) });
    spawns.push({ x: 35, y: 0.05, z: 20 * s, yaw: faceCentre(35, 20 * s) });
  }

  return {
    id: 5,
    key: 'refinery',
    name: 'Refinery',
    half: HALF,
    brushes: b,
    props: p,
    spawns,
    sky: 0x9fb3c4,
    fog: 0xa9b6bd,
    fogNear: 34,
    fogFar: 150,
    sun: { x: -0.34, y: 0.78, z: 0.52 },
    sunColor: 0xfff2d6,
    ambientColor: 0xa8c0d4,
    ambientGround: 0x6d675c,
    ambientIntensity: 0.8,
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
  buildRefinery(),
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
  ffa: ['refinery', 'dustworks', 'foundry', 'cistern', 'overpass'],
  tdm: ['meridian', 'refinery', 'overpass', 'dustworks', 'foundry'],
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

/**
 * Collision boxes for a map, built once and reused.
 *
 * Brushes first, then the inscribed box of every solid prop. The order is not
 * arbitrary: `raycastWorld` returns the nearest hit either way, but `firstOverlap`
 * stops at the first box it finds, and resolving a player against the wall they are
 * standing against before the barrel beside it is the cheaper of the two.
 */
export function mapColliders(m: GameMap): Box[] {
  let c = colliderCache.get(m);
  if (!c) {
    c = m.brushes.map(brushToBox);
    for (const p of m.props) {
      const box = propCollider(p);
      if (box) c.push(box);
    }
    colliderCache.set(m, c);
  }
  return c;
}
