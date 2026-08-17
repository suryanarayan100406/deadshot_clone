import { SKIN, GROUND_PROBE } from './constants';
import type { Vec3 } from './math';

/** Axis-aligned box in world space. Render geometry and collision geometry are the
 *  same data — the map is built from these and nothing else. */
export interface Box {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/** Footprint-centred, base-anchored: (x,z) is the centre, y is the *bottom*. */
export function boxFrom(x: number, y: number, z: number, sx: number, sy: number, sz: number): Box {
  const hx = sx / 2;
  const hz = sz / 2;
  return { minX: x - hx, minY: y, minZ: z - hz, maxX: x + hx, maxY: y + sy, maxZ: z + hz };
}

export function boxOverlap(a: Box, b: Box): boolean {
  return (
    a.minX < b.maxX &&
    a.maxX > b.minX &&
    a.minY < b.maxY &&
    a.maxY > b.minY &&
    a.minZ < b.maxZ &&
    a.maxZ > b.minZ
  );
}

export function boxCenter(b: Box, out: Vec3): Vec3 {
  out.x = (b.minX + b.maxX) * 0.5;
  out.y = (b.minY + b.maxY) * 0.5;
  out.z = (b.minZ + b.maxZ) * 0.5;
  return out;
}

/** Player collision volume: a box around the feet position. */
export function setPlayerBox(
  out: Box,
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
): Box {
  out.minX = x - radius;
  out.maxX = x + radius;
  out.minY = y;
  out.maxY = y + height;
  out.minZ = z - radius;
  out.maxZ = z + radius;
  return out;
}

const scratch: Box = { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 };

function firstOverlap(b: Box, brushes: readonly Box[]): Box | null {
  for (let i = 0; i < brushes.length; i++) {
    const o = brushes[i]!;
    if (boxOverlap(b, o)) return o;
  }
  return null;
}

/** True if a standing body of `height` fits here — used to block un-crouching. */
export function canFit(
  x: number,
  y: number,
  z: number,
  radius: number,
  height: number,
  brushes: readonly Box[],
): boolean {
  setPlayerBox(scratch, x, y, z, radius, height);
  return firstOverlap(scratch, brushes) === null;
}

export interface MoveResult {
  onGround: boolean;
  /** Became grounded this tick (used for landing dip + fall damage). */
  landed: boolean;
  /** Vertical speed at the instant of landing, as a positive number. */
  impactSpeed: number;
  hitWall: boolean;
}

const result: MoveResult = { onGround: false, landed: false, impactSpeed: 0, hitWall: false };

/**
 * Axis-separated collide-and-slide. X, then Z, then Y — resolving one axis at a time
 * is what produces clean sliding along walls instead of catching on corners.
 *
 * Mutates `pos` and `vel`. Returns a shared result object (do not retain it).
 */
export function moveWithCollision(
  pos: Vec3,
  vel: Vec3,
  radius: number,
  height: number,
  brushes: readonly Box[],
  dt: number,
  stepHeight: number,
): MoveResult {
  result.onGround = false;
  result.landed = false;
  result.impactSpeed = 0;
  result.hitWall = false;

  // ── X ────────────────────────────────────────────────────────────────────
  if (vel.x !== 0) {
    const nx = pos.x + vel.x * dt;
    setPlayerBox(scratch, nx, pos.y, pos.z, radius, height);
    const hit = firstOverlap(scratch, brushes);
    if (hit) {
      if (!tryStep(pos, nx, pos.y, pos.z, radius, height, brushes, stepHeight, hit, 'x')) {
        pos.x = vel.x > 0 ? hit.minX - radius - SKIN : hit.maxX + radius + SKIN;
        vel.x = 0;
        result.hitWall = true;
      }
    } else {
      pos.x = nx;
    }
  }

  // ── Z ────────────────────────────────────────────────────────────────────
  if (vel.z !== 0) {
    const nz = pos.z + vel.z * dt;
    setPlayerBox(scratch, pos.x, pos.y, nz, radius, height);
    const hit = firstOverlap(scratch, brushes);
    if (hit) {
      if (!tryStep(pos, pos.x, pos.y, nz, radius, height, brushes, stepHeight, hit, 'z')) {
        pos.z = vel.z > 0 ? hit.minZ - radius - SKIN : hit.maxZ + radius + SKIN;
        vel.z = 0;
        result.hitWall = true;
      }
    } else {
      pos.z = nz;
    }
  }

  // ── Y ────────────────────────────────────────────────────────────────────
  const ny = pos.y + vel.y * dt;
  setPlayerBox(scratch, pos.x, ny, pos.z, radius, height);
  const vhit = firstOverlap(scratch, brushes);
  if (vhit) {
    if (vel.y <= 0) {
      pos.y = vhit.maxY + SKIN;
      result.onGround = true;
      result.landed = true;
      result.impactSpeed = -vel.y;
    } else {
      pos.y = vhit.minY - height - SKIN;
    }
    vel.y = 0;
  } else {
    pos.y = ny;
  }

  // Standing check: probe a thin sliver directly under the feet. Without this,
  // walking off a ledge would keep `onGround` true for a tick and eat the fall.
  if (!result.onGround && vel.y <= 0.0001) {
    setPlayerBox(scratch, pos.x, pos.y - GROUND_PROBE, pos.z, radius, height);
    scratch.maxY = pos.y;
    if (firstOverlap(scratch, brushes)) result.onGround = true;
  }

  return result;
}

/**
 * Step-up: when a horizontal move is blocked by something low enough, lift the body
 * onto it rather than stopping. This is what lets stairs and crate stacks be walked
 * up without jumping.
 */
function tryStep(
  pos: Vec3,
  nx: number,
  ny: number,
  nz: number,
  radius: number,
  height: number,
  brushes: readonly Box[],
  stepHeight: number,
  hit: Box,
  axis: 'x' | 'z',
): boolean {
  if (stepHeight <= 0) return false;
  const rise = hit.maxY - ny;
  if (rise <= 0 || rise > stepHeight) return false;

  const liftedY = hit.maxY + SKIN;
  setPlayerBox(scratch, nx, liftedY, nz, radius, height);
  if (firstOverlap(scratch, brushes)) return false;

  pos.y = liftedY;
  if (axis === 'x') pos.x = nx;
  else pos.z = nz;
  return true;
}

// ── Raycasting ───────────────────────────────────────────────────────────────

/**
 * Ray/AABB via the slab method. Returns distance along the ray, or -1 for a miss.
 * Rays starting inside the box return 0.
 */
export function rayBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  b: Box,
  maxT: number,
): number {
  let tmin = 0;
  let tmax = maxT;

  if (Math.abs(dx) < 1e-9) {
    if (ox < b.minX || ox > b.maxX) return -1;
  } else {
    const inv = 1 / dx;
    let t1 = (b.minX - ox) * inv;
    let t2 = (b.maxX - ox) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  if (Math.abs(dy) < 1e-9) {
    if (oy < b.minY || oy > b.maxY) return -1;
  } else {
    const inv = 1 / dy;
    let t1 = (b.minY - oy) * inv;
    let t2 = (b.maxY - oy) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  if (Math.abs(dz) < 1e-9) {
    if (oz < b.minZ || oz > b.maxZ) return -1;
  } else {
    const inv = 1 / dz;
    let t1 = (b.minZ - oz) * inv;
    let t2 = (b.maxZ - oz) * inv;
    if (t1 > t2) {
      const t = t1;
      t1 = t2;
      t2 = t;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }

  return tmin;
}

export interface RayHit {
  t: number;
  box: Box | null;
  /** Which face was struck, as a unit normal — used to orient impact decals. */
  nx: number;
  ny: number;
  nz: number;
}

const rayHit: RayHit = { t: 0, box: null, nx: 0, ny: 0, nz: 0 };

/** Nearest brush along a ray, or null. Returns a shared object (do not retain it). */
export function raycastWorld(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  brushes: readonly Box[],
  maxT: number,
): RayHit | null {
  let best = maxT;
  let bestBox: Box | null = null;
  for (let i = 0; i < brushes.length; i++) {
    const t = rayBox(ox, oy, oz, dx, dy, dz, brushes[i]!, best);
    if (t >= 0 && t < best) {
      best = t;
      bestBox = brushes[i]!;
    }
  }
  if (!bestBox) return null;

  // Recover the face normal from which slab the hit point sits on.
  const hx = ox + dx * best;
  const hy = oy + dy * best;
  const hz = oz + dz * best;
  const eps = 1e-3;
  let nx = 0;
  let ny = 0;
  let nz = 0;
  if (Math.abs(hx - bestBox.minX) < eps) nx = -1;
  else if (Math.abs(hx - bestBox.maxX) < eps) nx = 1;
  else if (Math.abs(hy - bestBox.minY) < eps) ny = -1;
  else if (Math.abs(hy - bestBox.maxY) < eps) ny = 1;
  else if (Math.abs(hz - bestBox.minZ) < eps) nz = -1;
  else nz = 1;

  rayHit.t = best;
  rayHit.box = bestBox;
  rayHit.nx = nx;
  rayHit.ny = ny;
  rayHit.nz = nz;
  return rayHit;
}

/** Line-of-sight test between two points. Used by bot AI and spawn selection. */
export function losClear(a: Vec3, b: Vec3, brushes: readonly Box[]): boolean {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len < 1e-6) return true;
  const hit = raycastWorld(a.x, a.y, a.z, dx / len, dy / len, dz / len, brushes, len);
  return hit === null;
}
