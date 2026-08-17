/**
 * Transient visual effects: tracers, impact sparks, bullet holes, blood, shake.
 *
 * Everything here is pooled and pre-allocated. A firefight between eight players
 * with automatic weapons produces a few hundred effects a second, and allocating
 * a mesh per bullet would hand the garbage collector a stutter every few seconds
 * — exactly when the player can least afford one.
 *
 * So each effect type owns one buffer geometry sized at construction, and firing
 * an effect writes into a slot. When a pool is full the oldest slot is reused;
 * the visual difference is imperceptible and the frame cost is fixed no matter
 * how chaotic the fight gets.
 */

import * as THREE from 'three';

const TRACER_COUNT = 96;
const SPARK_COUNT = 420;
const DECAL_COUNT = 128;

/** Tracers are short-lived on purpose: long ones read as lasers, not bullets. */
const TRACER_LIFE = 0.075;
const SPARK_LIFE = 0.42;
const DECAL_LIFE = 11;
const DECAL_FADE = 2.2;

/* ─────────────────────────────────────────────────────────────────────────────
   Tracers

   Drawn as camera-facing quads, not as lines. `LineBasicMaterial.linewidth` is
   silently ignored by every WebGL implementation — the spec allows a driver to
   support only 1.0 — so a line-based tracer is a one-pixel hairline no matter
   what width you ask for, and at 1080p a hairline is nearly invisible against a
   bright wall. A quad billboarded around the segment gives real thickness, a soft
   edge and a bright head, for four vertices per tracer.

   The whole animation lives in the shader, driven from a birth time: the CPU
   writes each tracer exactly once at spawn and then only advances a clock, so a
   firefight costs one uniform update per frame regardless of how much is flying.
   ────────────────────────────────────────────────────────────────────────── */

const TRACER_VERT = `
attribute vec3 aEnd;
attribute float aSide;
attribute float aAlong;
attribute float aBirth;
attribute float aLife;
attribute float aWidth;
attribute vec3 aColor;
uniform float uTime;
varying float vSide;
varying float vAlong;
varying vec3 vColor;
varying float vFade;
void main() {
  float age = uTime - aBirth;
  if (age < 0.0 || age > aLife) {
    // Collapse dead tracers off-screen rather than branching in the fragment
    // stage; a degenerate triangle rasterises nothing.
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    vFade = 0.0;
    return;
  }
  vFade = 1.0 - age / aLife;
  vSide = aSide;
  vAlong = aAlong;
  vColor = aColor;

  // The position attribute holds the segment start; aEnd holds the impact point.
  vec3 p = mix(position, aEnd, aAlong);
  vec4 mv = modelViewMatrix * vec4(p, 1.0);

  vec3 dir = (modelViewMatrix * vec4(aEnd - position, 0.0)).xyz;
  float dl = length(dir);
  dir = dl > 1e-6 ? dir / dl : vec3(0.0, 0.0, -1.0);

  // Widen perpendicular to both the segment and the direction to the eye, so the
  // ribbon always presents its face to the camera.
  vec3 eye = normalize(-mv.xyz);
  vec3 side = cross(dir, eye);
  float sl = length(side);
  // A tracer aimed straight down the eye axis has no meaningful width axis. Any
  // perpendicular will do — on screen it is a dot either way.
  side = sl > 1e-4 ? side / sl : vec3(1.0, 0.0, 0.0);

  // Width grows slightly with distance. In pure world units a tracer 80 m away
  // falls below one pixel and strobes in and out as the camera moves; this keeps
  // a floor under it without making near ones fat.
  float w = aWidth * (1.0 + 0.05 * max(0.0, -mv.z));
  mv.xyz += side * (aSide * w);
  gl_Position = projectionMatrix * mv;
}`;

const TRACER_FRAG = `
varying float vSide;
varying float vAlong;
varying vec3 vColor;
varying float vFade;
void main() {
  if (vFade <= 0.0) discard;
  // Falloff across the width. A hard-edged quad reads as a strip of paper; a
  // soft one with a hot centre reads as something glowing in flight.
  float across = 1.0 - abs(vSide);
  float core = pow(across, 2.6);
  // Bright at the leading end, thin toward the muzzle. That gradient is what
  // sells the direction of travel in the four frames a tracer is alive for.
  float along = mix(0.14, 1.0, vAlong);
  gl_FragColor = vec4(vColor * (0.3 + core * 1.6), vFade * across * along);
}`;

class TracerPool {
  readonly object: THREE.Mesh;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private start: Float32Array;
  private end: Float32Array;
  private birth: Float32Array;
  private life: Float32Array;
  private width: Float32Array;
  private color: Float32Array;
  private next = 0;
  private used = 0;
  private time = 0;

  constructor() {
    const n = TRACER_COUNT;
    this.start = new Float32Array(n * 12);
    this.end = new Float32Array(n * 12);
    this.birth = new Float32Array(n * 4);
    this.life = new Float32Array(n * 4);
    this.width = new Float32Array(n * 4);
    this.color = new Float32Array(n * 12);
    const side = new Float32Array(n * 4);
    const along = new Float32Array(n * 4);
    const index = new Uint16Array(n * 6);
    // Born in the far past, so nothing draws before the first shot.
    this.birth.fill(-1000);

    for (let i = 0; i < n; i++) {
      const v = i * 4;
      // Four corners: two at the muzzle end, two at the impact end.
      side[v] = -1;
      along[v] = 0;
      side[v + 1] = 1;
      along[v + 1] = 0;
      side[v + 2] = 1;
      along[v + 2] = 1;
      side[v + 3] = -1;
      along[v + 3] = 1;

      const o = i * 6;
      index[o] = v;
      index[o + 1] = v + 1;
      index[o + 2] = v + 2;
      index[o + 3] = v;
      index[o + 4] = v + 2;
      index[o + 5] = v + 3;
    }

    this.geo = new THREE.BufferGeometry();
    // The segment start doubles as `position`, which keeps Three.js's own
    // bookkeeping happy instead of carrying a parallel dummy attribute.
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.start, 3));
    this.geo.setAttribute('aEnd', new THREE.BufferAttribute(this.end, 3));
    this.geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    this.geo.setAttribute('aAlong', new THREE.BufferAttribute(along, 1));
    this.geo.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    this.geo.setAttribute('aWidth', new THREE.BufferAttribute(this.width, 1));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    this.geo.setIndex(new THREE.BufferAttribute(index, 1));
    this.geo.setDrawRange(0, 0);

    this.mat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 } },
      vertexShader: TRACER_VERT,
      fragmentShader: TRACER_FRAG,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Tracers should be occluded by walls, so depth testing stays on.
      depthTest: true,
      side: THREE.DoubleSide,
    });

    this.object = new THREE.Mesh(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
  }

  /**
   * @param own  a tracer from the local player's gun, drawn thinner, dimmer and
   *             started further down the path so it never blocks the crosshair
   */
  spawn(
    ax: number,
    ay: number,
    az: number,
    bx: number,
    by: number,
    bz: number,
    own: boolean,
  ): void {
    const i = this.next;
    this.next = (this.next + 1) % TRACER_COUNT;
    if (this.used < TRACER_COUNT) this.used++;

    // Start the visible segment a little way down the path: a tracer that begins
    // at the muzzle covers the sights.
    const t0 = own ? 0.16 : 0.0;
    const sx = ax + (bx - ax) * t0;
    const sy = ay + (by - ay) * t0;
    const sz = az + (bz - az) * t0;

    const head = own ? 0.6 : 1.0;
    const w = own ? 0.013 : 0.022;
    // Warm, with a touch of variation so a burst is not one shape repeated.
    const j = 0.9 + Math.random() * 0.2;

    for (let k = 0; k < 4; k++) {
      const v = i * 4 + k;
      const p = v * 3;
      this.start[p] = sx;
      this.start[p + 1] = sy;
      this.start[p + 2] = sz;
      this.end[p] = bx;
      this.end[p + 1] = by;
      this.end[p + 2] = bz;
      this.color[p] = 1.0 * head * j;
      this.color[p + 1] = 0.82 * head * j;
      this.color[p + 2] = 0.46 * head;
      this.birth[v] = this.time;
      this.life[v] = TRACER_LIFE;
      this.width[v] = w;
    }

    this.geo.setDrawRange(0, this.used * 6);
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('aEnd').needsUpdate = true;
    this.geo.getAttribute('aBirth').needsUpdate = true;
    this.geo.getAttribute('aLife').needsUpdate = true;
    this.geo.getAttribute('aWidth').needsUpdate = true;
    this.geo.getAttribute('aColor').needsUpdate = true;
  }

  update(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime!.value = this.time;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Sparks / blood

   One Points object with a custom shader. A shader is worth it here: it lets
   gravity, drag and fade run entirely on the GPU from a spawn time and a spawn
   velocity, so the CPU writes each particle exactly once instead of every frame.
   ────────────────────────────────────────────────────────────────────────── */

const SPARK_VERT = `
attribute vec3 aVel;
attribute float aBirth;
attribute float aSize;
attribute vec3 aColor;
attribute float aLife;
uniform float uTime;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
void main() {
  float age = uTime - aBirth;
  // Dead particles are pushed far behind the camera and given zero size so
  // they cost nothing but a vertex.
  if (age < 0.0 || age > aLife) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  float t = age;
  // Integrated ballistic path with linear drag, closed form so there is no
  // per-frame state to keep.
  float drag = 2.4;
  float decay = (1.0 - exp(-drag * t)) / drag;
  vec3 pos = position + aVel * decay + vec3(0.0, -9.8 * 0.5 * t * t, 0.0);
  vec4 mv = modelViewMatrix * vec4(pos, 1.0);
  gl_Position = projectionMatrix * mv;
  float k = 1.0 - age / aLife;
  vAlpha = k * k;
  gl_PointSize = aSize * uScale * (1.0 + k) * 0.5 / max(0.001, -mv.z);
  vColor = aColor;
}`;

const SPARK_FRAG = `
varying vec3 vColor;
varying float vAlpha;
void main() {
  if (vAlpha <= 0.0) discard;
  // Round the square point sprite off and give it a hot centre.
  vec2 d = gl_PointCoord - vec2(0.5);
  float r = dot(d, d);
  if (r > 0.25) discard;
  float core = 1.0 - smoothstep(0.0, 0.25, r);
  gl_FragColor = vec4(vColor * (0.55 + core), vAlpha * core);
}`;

class SparkPool {
  readonly object: THREE.Points;
  private geo: THREE.BufferGeometry;
  private mat: THREE.ShaderMaterial;
  private pos: Float32Array;
  private vel: Float32Array;
  private birth: Float32Array;
  private size: Float32Array;
  private color: Float32Array;
  private life: Float32Array;
  private next = 0;
  private used = 0;
  private time = 0;
  /** The two halves of the point-size term — see `setViewportHeight`. */
  private heightPx = 1080;
  private fovDeg = 90;

  constructor() {
    this.pos = new Float32Array(SPARK_COUNT * 3);
    this.vel = new Float32Array(SPARK_COUNT * 3);
    this.birth = new Float32Array(SPARK_COUNT);
    this.size = new Float32Array(SPARK_COUNT);
    this.color = new Float32Array(SPARK_COUNT * 3);
    this.life = new Float32Array(SPARK_COUNT);
    // Birth in the far past so nothing draws before the first spawn.
    this.birth.fill(-1000);

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this.geo.setAttribute('aVel', new THREE.BufferAttribute(this.vel, 3));
    this.geo.setAttribute('aBirth', new THREE.BufferAttribute(this.birth, 1));
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    this.geo.setAttribute('aColor', new THREE.BufferAttribute(this.color, 3));
    this.geo.setAttribute('aLife', new THREE.BufferAttribute(this.life, 1));
    this.geo.setDrawRange(0, 0);

    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        // Replaced on the first resize; this only has to be sane for a frame.
        uScale: { value: 540 },
      },
      vertexShader: SPARK_VERT,
      fragmentShader: SPARK_FRAG,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });

    this.object = new THREE.Points(this.geo, this.mat);
    this.object.frustumCulled = false;
    this.object.renderOrder = 5;
  }

  /**
   * Point size is in pixels, so the shader needs the term that converts a world
   * size into one: `height / (2 tan(fov/2))`. Both halves of it move at runtime
   * — the height on resize, the FOV every frame while aiming down sights — so
   * each is stored separately and the product recomputed on either.
   *
   * Folding the FOV in is what makes a spark grow when a scope zooms. With a
   * constant in its place, a sniper watching hits at sixty metres sees them
   * shrink as the magnification goes up, which is backwards.
   */
  setViewportHeight(h: number): void {
    this.heightPx = h;
    this.rescale();
  }

  setCameraFov(fovDeg: number): void {
    this.fovDeg = fovDeg;
    this.rescale();
  }

  private rescale(): void {
    const half = Math.tan((Math.max(1, this.fovDeg) * Math.PI) / 360);
    this.mat.uniforms.uScale!.value = this.heightPx / (2 * half);
  }

  /**
   * Emits a burst.
   *
   * @param sizeCm particle diameter in **centimetres**. The shader works in
   *   metres, since it divides by view depth to get pixels, so this is converted
   *   on the way in. Quoting the roster in centimetres is not decoration: a
   *   spark is a few centimetres across and a dust puff about a handspan, and
   *   those are numbers that can be sanity-checked at a glance, where a bare
   *   `0.045` is a number that can lose a zero and never be questioned.
   * @param spreadCone 0 = straight along the normal, 1 = full hemisphere
   */
  burst(
    x: number,
    y: number,
    z: number,
    nx: number,
    ny: number,
    nz: number,
    count: number,
    speed: number,
    sizeCm: number,
    r: number,
    g: number,
    b: number,
    life: number,
    spreadCone: number,
  ): void {
    for (let n = 0; n < count; n++) {
      const i = this.next;
      this.next = (this.next + 1) % SPARK_COUNT;
      if (this.used < SPARK_COUNT) this.used++;

      const p = i * 3;
      this.pos[p] = x;
      this.pos[p + 1] = y;
      this.pos[p + 2] = z;

      // Random direction biased toward the surface normal.
      let dx = Math.random() * 2 - 1;
      let dy = Math.random() * 2 - 1;
      let dz = Math.random() * 2 - 1;
      const len = Math.hypot(dx, dy, dz) || 1;
      dx /= len;
      dy /= len;
      dz /= len;
      const mix = spreadCone;
      dx = nx * (1 - mix) + dx * mix;
      dy = ny * (1 - mix) + dy * mix;
      dz = nz * (1 - mix) + dz * mix;
      const l2 = Math.hypot(dx, dy, dz) || 1;

      const v = speed * (0.45 + Math.random() * 0.9);
      this.vel[p] = (dx / l2) * v;
      this.vel[p + 1] = (dy / l2) * v;
      this.vel[p + 2] = (dz / l2) * v;

      this.birth[i] = this.time;
      this.life[i] = life * (0.7 + Math.random() * 0.6);
      this.size[i] = sizeCm * 0.01 * (0.6 + Math.random() * 0.8);
      // Slight per-particle colour jitter so a burst is not monochrome.
      const j = 0.85 + Math.random() * 0.3;
      this.color[p] = r * j;
      this.color[p + 1] = g * j;
      this.color[p + 2] = b * j;
    }

    this.geo.setDrawRange(0, this.used);
    this.geo.getAttribute('position').needsUpdate = true;
    this.geo.getAttribute('aVel').needsUpdate = true;
    this.geo.getAttribute('aBirth').needsUpdate = true;
    this.geo.getAttribute('aSize').needsUpdate = true;
    this.geo.getAttribute('aColor').needsUpdate = true;
    this.geo.getAttribute('aLife').needsUpdate = true;
  }

  update(dt: number): void {
    this.time += dt;
    this.mat.uniforms.uTime!.value = this.time;
  }

  dispose(): void {
    this.geo.dispose();
    this.mat.dispose();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Bullet holes

   A pool of camera-facing-independent quads, each nudged off the surface along
   its normal to avoid z-fighting. Reused oldest-first so the count is bounded.
   ────────────────────────────────────────────────────────────────────────── */

class DecalPool {
  readonly object: THREE.Group;
  private meshes: THREE.Mesh[] = [];
  private born: number[] = [];
  private next = 0;
  private geo: THREE.PlaneGeometry;
  private mats: THREE.MeshBasicMaterial[] = [];
  private time = 0;
  private up = new THREE.Vector3(0, 1, 0);
  private alt = new THREE.Vector3(1, 0, 0);
  private normal = new THREE.Vector3();
  private tangent = new THREE.Vector3();
  private bitangent = new THREE.Vector3();
  private basis = new THREE.Matrix4();

  constructor() {
    this.object = new THREE.Group();
    this.geo = new THREE.PlaneGeometry(1, 1);

    // A generated radial texture — a soft dark disc with a darker core. Cheaper
    // and sharper than trying to fake a hole with vertex colours.
    const tex = makeHoleTexture();

    for (let i = 0; i < DECAL_COUNT; i++) {
      const mat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        // Multiply so the hole darkens whatever it sits on instead of painting
        // a grey blob on a dark wall.
        blending: THREE.MultiplyBlending,
      });
      const m = new THREE.Mesh(this.geo, mat);
      m.visible = false;
      m.matrixAutoUpdate = false;
      m.renderOrder = 2;
      this.object.add(m);
      this.meshes.push(m);
      this.mats.push(mat);
      this.born.push(-1000);
    }
  }

  spawn(x: number, y: number, z: number, nx: number, ny: number, nz: number, scale: number): void {
    const i = this.next;
    this.next = (this.next + 1) % DECAL_COUNT;
    const m = this.meshes[i]!;

    this.normal.set(nx, ny, nz);
    if (this.normal.lengthSq() < 1e-6) this.normal.set(0, 1, 0);
    this.normal.normalize();

    // Build an orthonormal basis around the normal. Picking the up vector needs
    // a fallback: on a floor or ceiling, up is parallel to the normal and the
    // cross product collapses.
    const ref = Math.abs(this.normal.y) > 0.94 ? this.alt : this.up;
    this.tangent.crossVectors(ref, this.normal).normalize();
    this.bitangent.crossVectors(this.normal, this.tangent);

    const s = scale * (0.82 + Math.random() * 0.42);
    this.tangent.multiplyScalar(s);
    this.bitangent.multiplyScalar(s);

    // 1.5 cm of offset clears the depth precision at any range on this map.
    this.basis.makeBasis(this.tangent, this.bitangent, this.normal);
    this.basis.setPosition(x + nx * 0.015, y + ny * 0.015, z + nz * 0.015);
    m.matrix.copy(this.basis);
    m.visible = true;

    this.mats[i]!.opacity = 0.9;
    this.born[i] = this.time;
  }

  update(dt: number): void {
    this.time += dt;
    for (let i = 0; i < DECAL_COUNT; i++) {
      const m = this.meshes[i]!;
      if (!m.visible) continue;
      const age = this.time - this.born[i]!;
      if (age > DECAL_LIFE) {
        m.visible = false;
        continue;
      }
      // Hold full opacity, then fade over the last stretch of the lifetime.
      const remain = DECAL_LIFE - age;
      this.mats[i]!.opacity = remain < DECAL_FADE ? 0.9 * (remain / DECAL_FADE) : 0.9;
    }
  }

  clear(): void {
    for (const m of this.meshes) m.visible = false;
  }

  dispose(): void {
    this.geo.dispose();
    for (const m of this.mats) {
      m.map?.dispose();
      m.dispose();
    }
  }
}

function makeHoleTexture(): THREE.Texture {
  const size = 64;
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  const ctx = c.getContext('2d')!;
  // White = no effect under multiply blending, so the background must be white.
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size, size);

  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(20,16,14,1)');
  g.addColorStop(0.34, 'rgba(56,46,38,0.9)');
  g.addColorStop(0.62, 'rgba(128,112,96,0.42)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);

  // A few dark flecks so repeated holes are not obviously the same sprite.
  ctx.fillStyle = 'rgba(40,32,26,0.55)';
  for (let i = 0; i < 7; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 6 + Math.random() * 14;
    ctx.beginPath();
    ctx.arc(size / 2 + Math.cos(a) * r, size / 2 + Math.sin(a) * r, 1 + Math.random() * 2, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/* ─────────────────────────────────────────────────────────────────────────────
   Camera shake

   Two decaying oscillators at incommensurate frequencies. A single sine reads as
   a mechanical wobble; two that never line up read as an impact.
   ────────────────────────────────────────────────────────────────────────── */

export class Shake {
  private amp = 0;
  private phase = 0;
  offsetPitch = 0;
  offsetYaw = 0;
  offsetRoll = 0;

  add(amount: number): void {
    // Take the larger rather than summing, so a shotgun blast during a grenade
    // does not launch the camera into orbit.
    this.amp = Math.max(this.amp, amount);
  }

  update(dt: number, scale: number): void {
    if (this.amp <= 0.00001) {
      this.offsetPitch = 0;
      this.offsetYaw = 0;
      this.offsetRoll = 0;
      this.amp = 0;
      return;
    }
    this.phase += dt;
    this.amp *= Math.exp(-8.5 * dt);
    const a = this.amp * scale;
    this.offsetPitch = Math.sin(this.phase * 47.3) * a;
    this.offsetYaw = Math.sin(this.phase * 31.7 + 1.1) * a * 0.85;
    this.offsetRoll = Math.sin(this.phase * 23.1 + 2.3) * a * 1.6;
  }
}

/* ─────────────────────────────────────────────────────────────────────────── */

export class Effects {
  readonly root = new THREE.Group();
  readonly shake = new Shake();

  private tracers = new TracerPool();
  private sparks = new SparkPool();
  private decals = new DecalPool();
  private enabled = true;

  constructor() {
    this.root.add(this.tracers.object);
    this.root.add(this.sparks.object);
    this.root.add(this.decals.object);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.sparks.object.visible = on;
    this.decals.object.visible = on;
    if (!on) this.decals.clear();
  }

  setViewportHeight(h: number): void {
    this.sparks.setViewportHeight(h);
  }

  setCameraFov(fovDeg: number): void {
    this.sparks.setCameraFov(fovDeg);
  }

  tracer(ax: number, ay: number, az: number, bx: number, by: number, bz: number, own: boolean): void {
    this.tracers.spawn(ax, ay, az, bx, by, bz, own);
  }

  /** A bullet hitting the level. */
  impactWorld(x: number, y: number, z: number, nx: number, ny: number, nz: number): void {
    if (!this.enabled) return;
    // Hot chips along the normal, plus a puff of pulverised wall that lingers.
    // The chips are a few centimetres and the puff a quarter of a metre, which is
    // the size relationship that reads as "something broke" rather than as two
    // clouds of different colours.
    this.sparks.burst(x, y, z, nx, ny, nz, 7, 4.2, 4.5, 1.0, 0.72, 0.3, SPARK_LIFE, 0.55);
    this.sparks.burst(x, y, z, nx, ny, nz, 5, 1.3, 26, 0.62, 0.55, 0.44, SPARK_LIFE * 1.8, 0.8);
    this.decals.spawn(x, y, z, nx, ny, nz, 0.13);
  }

  /** A bullet hitting a player. `head` swaps in a bigger, brighter burst. */
  impactFlesh(x: number, y: number, z: number, nx: number, ny: number, nz: number, head: boolean): void {
    if (!this.enabled) return;
    const n = head ? 16 : 9;
    this.sparks.burst(x, y, z, nx, ny, nz, n, head ? 3.4 : 2.4, 5.5, 0.78, 0.09, 0.1, 0.5, 0.7);
  }

  /**
   * Muzzle smoke, spawned at the world muzzle position.
   *
   * `power` scales it with the charge behind the shot, so a 12-gauge leaves a
   * cloud and an SMG leaves a wisp. Two bursts rather than one: a bright fast
   * puff, still lit by the flash that made it, and slower grey smoke that hangs
   * around long enough to mark where someone was firing from.
   */
  muzzleSmoke(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    power = 1,
  ): void {
    if (!this.enabled) return;
    const hot = Math.max(2, Math.round(4 * power));
    const cool = Math.max(2, Math.round(5 * power));
    this.sparks.burst(x, y, z, dx, dy, dz, hot, 3.6 * power, 11, 1.0, 0.85, 0.58, 0.12, 0.45);
    this.sparks.burst(x, y, z, dx, dy, dz, cool, 1.5 * power, 30, 0.6, 0.57, 0.52, 0.44, 0.72);
  }

  /**
   * The flash at another player's muzzle.
   *
   * Only ever drawn for someone else's gun. The local player's flash is drawn on
   * the view model itself, three layers of it, and a world flash on top would
   * double it. For everyone else this is the strongest cue there is for locating
   * fire: a tracer says where a bullet went, a flash says where the shooter is
   * standing.
   *
   * Two sprites rather than one, both additive, so the overlap makes a hot white
   * centre inside a warm halo instead of a flat disc.
   *
   * @param power the charge behind the shot, `sfx.gain` — the same number that
   *   voices it and sizes the view model's own flash
   * @param cycle the weapon's cycle time in seconds. The flash has to finish
   *   inside it, or it stops strobing per shot and becomes a lamp on the gun,
   *   which is how sustained fire loses its rhythm. Clamped here rather than
   *   asserted somewhere else, so a faster weapon added later cannot break it.
   */
  muzzleFlash(
    x: number,
    y: number,
    z: number,
    dx: number,
    dy: number,
    dz: number,
    power = 1,
    cycle = 0.1,
  ): void {
    if (!this.enabled) return;
    // `burst` jitters life by up to 1.3x, so it is that product the cycle has to
    // contain, not this number.
    const life = Math.min(0.048, cycle * 0.45);
    this.sparks.burst(x, y, z, dx, dy, dz, 1, 0, 28 * power, 1.0, 0.97, 0.86, life, 0);
    this.sparks.burst(x, y, z, dx, dy, dz, 1, 0, 70 * power, 1.0, 0.7, 0.28, life * 1.15, 0);
  }

  /** Big burst when a player dies. */
  deathBurst(x: number, y: number, z: number): void {
    if (!this.enabled) return;
    this.sparks.burst(x, y + 0.9, z, 0, 1, 0, 26, 3.6, 13, 0.72, 0.1, 0.1, 0.8, 1.0);
  }

  /** Dust kicked up on landing. */
  landDust(x: number, y: number, z: number, force: number): void {
    if (!this.enabled || force < 0.25) return;
    const n = Math.min(14, 4 + Math.round(force * 10));
    this.sparks.burst(x, y + 0.05, z, 0, 1, 0, n, 1.4 + force, 28, 0.66, 0.58, 0.46, 0.55, 0.95);
  }

  update(dt: number, shakeScale: number): void {
    this.tracers.update(dt);
    this.sparks.update(dt);
    this.decals.update(dt);
    this.shake.update(dt, shakeScale);
  }

  clear(): void {
    this.decals.clear();
  }

  dispose(): void {
    this.tracers.dispose();
    this.sparks.dispose();
    this.decals.dispose();
  }
}
