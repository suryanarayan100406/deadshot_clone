/**
 * Combat resolution shared by the server (authoritative) and the client (for
 * predicted visuals only). Keeping the hitbox layout here means the client draws
 * debug boxes in exactly the places the server shoots at.
 */

import { HEAD_BOX, PLAYER_RADIUS } from './constants';
import { rayBox, raycastWorld, type Box } from './collision';
import type { Vec3 } from './math';

export interface Hitbox {
  box: Box;
  ownerId: number;
  head: boolean;
}

export function makeHitbox(): Hitbox {
  return {
    box: { minX: 0, minY: 0, minZ: 0, maxX: 0, maxY: 0, maxZ: 0 },
    ownerId: -1,
    head: false,
  };
}

/**
 * Two boxes per player: a cube at the crown and the torso/legs below it. Simple,
 * predictable, and cheap enough to rebuild for every player on every shot during
 * lag-compensated rewind.
 */
export function writeHitboxes(
  head: Hitbox,
  body: Hitbox,
  id: number,
  x: number,
  y: number,
  z: number,
  height: number,
): void {
  const r = PLAYER_RADIUS;
  const headBottom = y + height - HEAD_BOX;

  head.ownerId = id;
  head.head = true;
  head.box.minX = x - HEAD_BOX / 2;
  head.box.maxX = x + HEAD_BOX / 2;
  head.box.minY = headBottom;
  head.box.maxY = y + height;
  head.box.minZ = z - HEAD_BOX / 2;
  head.box.maxZ = z + HEAD_BOX / 2;

  body.ownerId = id;
  body.head = false;
  body.box.minX = x - r;
  body.box.maxX = x + r;
  body.box.minY = y;
  body.box.maxY = headBottom;
  body.box.minZ = z - r;
  body.box.maxZ = z + r;
}

export interface ShotResult {
  /** Distance travelled before stopping. */
  t: number;
  /** Player id struck, or -1 for a wall/nothing. */
  hitId: number;
  head: boolean;
  /** Impact point. */
  x: number;
  y: number;
  z: number;
  /** Surface normal at impact; zero when nothing was struck. */
  nx: number;
  ny: number;
  nz: number;
  hitWorld: boolean;
}

const shot: ShotResult = {
  t: 0,
  hitId: -1,
  head: false,
  x: 0,
  y: 0,
  z: 0,
  nx: 0,
  ny: 0,
  nz: 0,
  hitWorld: false,
};

/**
 * Trace one bullet. Walls and players compete on distance, so cover works: the
 * nearest thing along the ray wins, whatever it is.
 *
 * Returns a shared object — read it before the next call.
 */
export function traceShot(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  brushes: readonly Box[],
  hitboxes: readonly Hitbox[],
  maxRange: number,
): ShotResult {
  let best = maxRange;
  let bestId = -1;
  let bestHead = false;

  for (let i = 0; i < hitboxes.length; i++) {
    const hb = hitboxes[i]!;
    const t = rayBox(ox, oy, oz, dx, dy, dz, hb.box, best);
    // t > 0 rejects a ray that starts inside our own hitbox
    if (t > 0.001 && t < best) {
      best = t;
      bestId = hb.ownerId;
      bestHead = hb.head;
    }
  }

  const world = raycastWorld(ox, oy, oz, dx, dy, dz, brushes, best);
  if (world) {
    shot.t = world.t;
    shot.hitId = -1;
    shot.head = false;
    shot.hitWorld = true;
    shot.nx = world.nx;
    shot.ny = world.ny;
    shot.nz = world.nz;
    shot.x = ox + dx * world.t;
    shot.y = oy + dy * world.t;
    shot.z = oz + dz * world.t;
    return shot;
  }

  shot.t = best;
  shot.hitId = bestId;
  shot.head = bestHead;
  shot.hitWorld = false;
  shot.nx = 0;
  shot.ny = 0;
  shot.nz = 0;
  shot.x = ox + dx * best;
  shot.y = oy + dy * best;
  shot.z = oz + dz * best;
  return shot;
}

/**
 * Rotate a direction into a random point inside a cone. Uses a supplied RNG so the
 * server can reproduce a client's shot pattern from a seed if it ever needs to.
 */
export function applySpread(
  out: Vec3,
  dx: number,
  dy: number,
  dz: number,
  spread: number,
  rng: () => number,
): Vec3 {
  if (spread <= 0) {
    out.x = dx;
    out.y = dy;
    out.z = dz;
    return out;
  }

  // Build a basis around the shot direction.
  let ux: number, uy: number, uz: number;
  if (Math.abs(dy) < 0.99) {
    // up × dir
    ux = dz;
    uy = 0;
    uz = -dx;
  } else {
    ux = 1;
    uy = 0;
    uz = 0;
  }
  const ul = Math.hypot(ux, uy, uz) || 1;
  ux /= ul;
  uy /= ul;
  uz /= ul;
  // second basis vector = dir × u
  const vx = dy * uz - dz * uy;
  const vy = dz * ux - dx * uz;
  const vz = dx * uy - dy * ux;

  // Uniform-in-disc sample, scaled by the cone half-angle.
  const ang = rng() * Math.PI * 2;
  const rad = Math.sqrt(rng()) * Math.tan(spread);
  const a = Math.cos(ang) * rad;
  const b = Math.sin(ang) * rad;

  out.x = dx + ux * a + vx * b;
  out.y = dy + uy * a + vy * b;
  out.z = dz + uz * a + vz * b;
  const l = Math.hypot(out.x, out.y, out.z) || 1;
  out.x /= l;
  out.y /= l;
  out.z /= l;
  return out;
}
