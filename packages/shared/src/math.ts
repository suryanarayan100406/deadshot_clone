/** Small allocation-free 3D math. Helpers mutate an `out` argument on purpose:
 *  the movement code runs 60×/sec per player on the server and must not churn GC. */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function vset(o: Vec3, x: number, y: number, z: number): Vec3 {
  o.x = x;
  o.y = y;
  o.z = z;
  return o;
}

export function vcopy(o: Vec3, a: Vec3): Vec3 {
  o.x = a.x;
  o.y = a.y;
  o.z = a.z;
  return o;
}

export function vaddScaled(o: Vec3, a: Vec3, s: number): Vec3 {
  o.x += a.x * s;
  o.y += a.y * s;
  o.z += a.z * s;
  return o;
}

export function vlen(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function vlenXZ(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.z * a.z);
}

export function vdist(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

export function vdistSq(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

export function vlerp(o: Vec3, a: Vec3, b: Vec3, t: number): Vec3 {
  o.x = a.x + (b.x - a.x) * t;
  o.y = a.y + (b.y - a.y) * t;
  o.z = a.z + (b.z - a.z) * t;
  return o;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Frame-rate independent exponential approach. `rate` is roughly "per second". */
export function damp(a: number, b: number, rate: number, dt: number): number {
  return b + (a - b) * Math.exp(-rate * dt);
}

export const DEG2RAD = Math.PI / 180;
export const RAD2DEG = 180 / Math.PI;
export const TAU = Math.PI * 2;

/** Wrap to (-PI, PI]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}

/** Shortest-path angle interpolation, so yaw never spins the long way round. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

/**
 * View direction from yaw/pitch. Convention, matching Three.js:
 * yaw 0 looks down -Z, +yaw turns left, +pitch looks up.
 */
export function dirFromAngles(out: Vec3, yaw: number, pitch: number): Vec3 {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

/** Horizontal right-hand vector for a yaw. */
export function rightFromYaw(out: Vec3, yaw: number): Vec3 {
  out.x = Math.cos(yaw);
  out.y = 0;
  out.z = -Math.sin(yaw);
  return out;
}

/** Deterministic PRNG (mulberry32) — used for spread so a seed reproduces a shot. */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
