/**
 * World rendering.
 *
 * Every wall, crate and stair in the level is one entry in the shared `GameMap`
 * brush list — the exact same array the collision code raycasts against. There
 * is no separate visual mesh, so what you see is what you hit, always.
 *
 * Two things make this cheap enough to run at 144 fps on integrated graphics:
 *
 *   • **One merged mesh per material.** A map of ~450 brushes across 9 materials
 *     becomes 9 draw calls instead of 450, by baking every box into a single
 *     BufferGeometry with pre-transformed vertices. Static geometry never moves,
 *     so there is nothing to gain from keeping them separate.
 *
 *   • **Procedural vertex tinting.** With no textures, flat-coloured boxes read
 *     as plastic. Each face gets a small deterministic brightness offset derived
 *     from its world position, which reads as surface variation and makes edges
 *     legible without a single byte of texture data.
 *
 * Nothing here is loaded from disk. The sky, the ground, the sun and the whole
 * level are generated at startup in a few milliseconds.
 */

import * as THREE from 'three';
import {
  MATERIALS,
  type Brush,
  type GameMap,
  type MatKey,
} from '@oneshot/shared';

/** Deterministic hash → [0,1). Same input always gives the same tint. */
function hash01(x: number, y: number, z: number, salt: number): number {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2246822519)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ salt) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h >>> 8) / 16777216;
}

/** Cube face normals and the two in-plane axes for each, in fixed order. */
const FACES: Array<{ n: [number, number, number]; u: [number, number, number]; v: [number, number, number] }> = [
  { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
  { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
  { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, 1] },
  { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, -1] },
  { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
  { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
];

/**
 * Builds one merged, vertex-coloured geometry from a set of brushes.
 *
 * Faces are emitted manually rather than via BoxGeometry so each face can carry
 * its own tint and so we can skip the underside of anything sitting on the
 * ground — those triangles are never visible and cost fill rate on every frame.
 */
function mergeBrushes(brushes: readonly Brush[], baseColor: number): THREE.BufferGeometry {
  // Worst case 6 faces × 4 verts; the underside skip only ever shrinks this.
  const maxVerts = brushes.length * 24;
  const positions = new Float32Array(maxVerts * 3);
  const normals = new Float32Array(maxVerts * 3);
  const colors = new Float32Array(maxVerts * 3);
  const indices: number[] = [];

  const base = new THREE.Color(baseColor);
  let vi = 0;

  for (const b of brushes) {
    const hx = b.sx * 0.5;
    const hy = b.sy * 0.5;
    const hz = b.sz * 0.5;
    const cx = b.x;
    const cy = b.y + hy;
    const cz = b.z;

    // Per-brush tint so two identical crates never look stamped from a mould.
    const brushTint = 1 + (hash01(Math.round(b.x * 4), Math.round(b.y * 4), Math.round(b.z * 4), 0x9e37) - 0.5) * 0.13;

    for (let f = 0; f < 6; f++) {
      const face = FACES[f]!;
      const [nx, ny, nz] = face.n;

      // Skip the bottom face of anything resting on or below the floor.
      if (ny < 0 && b.y <= 0.001) continue;

      const ex = nx * hx;
      const ey = ny * hy;
      const ez = nz * hz;
      const [ux, uy, uz] = face.u;
      const [vx, vy, vz] = face.v;
      // In-plane extents: whichever half-sizes are not consumed by the normal.
      const su = Math.abs(ux) * hx + Math.abs(uy) * hy + Math.abs(uz) * hz;
      const sv = Math.abs(vx) * hx + Math.abs(vy) * hy + Math.abs(vz) * hz;

      // Directional shade: top faces catch light, undersides fall away, and the
      // two horizontal axes differ slightly so corners never merge visually.
      let shade = 1;
      if (ny > 0) shade = 1.14;
      else if (ny < 0) shade = 0.6;
      else if (nx !== 0) shade = 0.88;
      else shade = 0.96;

      const faceTint =
        shade *
        brushTint *
        (1 + (hash01(Math.round(cx * 8 + ex * 3), Math.round(cy * 8 + ey * 3), Math.round(cz * 8 + ez * 3), f * 7919) - 0.5) * 0.075);

      const r = base.r * faceTint;
      const g = base.g * faceTint;
      const bl = base.b * faceTint;

      const start = vi;
      for (let c = 0; c < 4; c++) {
        // Corner order 0..3 walks the quad so (0,1,2)+(0,2,3) wind correctly.
        const cu = c === 0 || c === 3 ? -1 : 1;
        const cv = c < 2 ? -1 : 1;
        const p = vi * 3;
        positions[p] = cx + ex + ux * su * cu + vx * sv * cv;
        positions[p + 1] = cy + ey + uy * su * cu + vy * sv * cv;
        positions[p + 2] = cz + ez + uz * su * cu + vz * sv * cv;
        normals[p] = nx;
        normals[p + 1] = ny;
        normals[p + 2] = nz;
        colors[p] = r;
        colors[p + 1] = g;
        colors[p + 2] = bl;
        vi++;
      }
      indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, vi * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(0, vi * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, vi * 3), 3));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}

export interface WorldOptions {
  shadows: number;
}

export class World {
  readonly scene = new THREE.Scene();
  readonly root = new THREE.Group();

  private sun: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;
  private fill: THREE.DirectionalLight;
  private meshes: THREE.Mesh[] = [];
  private materials: THREE.Material[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private skyMesh: THREE.Mesh | null = null;
  private map: GameMap | null = null;

  constructor(opts: WorldOptions) {
    this.scene.add(this.root);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.0);
    this.sun.castShadow = opts.shadows > 0;
    this.configureShadow(opts.shadows);
    this.scene.add(this.sun);
    this.scene.add(this.sun.target);

    // Sky/ground hemisphere: the cheapest way to keep shadowed faces from going
    // pure black without paying for any kind of global illumination.
    this.hemi = new THREE.HemisphereLight(0xbfd8ee, 0x8a7355, 0.85);
    this.scene.add(this.hemi);

    // A dim opposing light so surfaces facing away from the sun still read.
    this.fill = new THREE.DirectionalLight(0xffffff, 0.28);
    this.fill.position.set(-0.4, 0.7, -0.55);
    this.scene.add(this.fill);
  }

  private configureShadow(quality: number): void {
    const size = quality >= 2 ? 2048 : 1024;
    const cam = this.sun.shadow.camera;
    this.sun.shadow.mapSize.set(size, size);
    // Fitted to the map extent (60 m) with headroom; a tighter frustum is the
    // single biggest win for shadow crispness at a given map resolution.
    cam.left = -46;
    cam.right = 46;
    cam.top = 46;
    cam.bottom = -46;
    cam.near = 1;
    cam.far = 190;
    cam.updateProjectionMatrix();
    this.sun.shadow.bias = -0.0012;
    this.sun.shadow.normalBias = 0.035;
  }

  setShadowQuality(quality: number): void {
    this.sun.castShadow = quality > 0;
    if (this.sun.shadow.map && this.sun.shadow.mapSize.x !== (quality >= 2 ? 2048 : 1024)) {
      this.sun.shadow.map.dispose();
      this.sun.shadow.map = null as unknown as THREE.WebGLRenderTarget;
    }
    this.configureShadow(quality);
    for (const m of this.meshes) {
      m.castShadow = quality > 0;
      m.receiveShadow = quality > 0;
    }
  }

  /** Tears down the previous map and builds the new one. */
  load(map: GameMap, shadows: number): void {
    this.clear();
    this.map = map;

    // Fog does double duty: atmosphere, and hiding the point where the merged
    // geometry ends against the sky.
    this.scene.fog = new THREE.Fog(map.fog, map.fogNear, map.fogFar);
    this.scene.background = new THREE.Color(map.sky);

    this.buildSky(map);

    // Group brushes by material, then merge each group.
    const byMat = new Map<MatKey, Brush[]>();
    for (const b of map.brushes) {
      let list = byMat.get(b.mat);
      if (!list) {
        list = [];
        byMat.set(b.mat, list);
      }
      list.push(b);
    }

    for (const [key, list] of byMat) {
      const spec = MATERIALS[key];
      const geo = mergeBrushes(list, spec.color);
      const transparent = spec.opacity !== undefined && spec.opacity < 1;
      const mat = new THREE.MeshLambertMaterial({
        vertexColors: true,
        transparent,
        opacity: spec.opacity ?? 1,
        // Lambert ignores roughness/metalness, which is exactly what we want:
        // the level is matte, and the cost of a physical material across 450
        // brushes buys nothing visible on flat untextured faces.
        side: transparent ? THREE.DoubleSide : THREE.FrontSide,
        depthWrite: !transparent,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.castShadow = shadows > 0 && !transparent;
      mesh.receiveShadow = shadows > 0;
      mesh.matrixAutoUpdate = false;
      mesh.frustumCulled = false; // One mesh spans the map; culling it is a bug.
      this.root.add(mesh);
      this.meshes.push(mesh);
      this.materials.push(mat);
      this.geometries.push(geo);
    }

    // Light rig, driven from the map data.
    const s = map.sun;
    const len = Math.hypot(s.x, s.y, s.z) || 1;
    this.sun.position.set((s.x / len) * 90, (s.y / len) * 90, (s.z / len) * 90);
    this.sun.target.position.set(0, 0, 0);
    this.sun.color.setHex(map.sunColor);
    this.hemi.color.setHex(map.ambientColor);
    this.hemi.groundColor.setHex(map.ambientGround);
    this.hemi.intensity = map.ambientIntensity;
    this.fill.color.setHex(map.ambientColor);
    this.setShadowQuality(shadows);
  }

  /**
   * Sky dome: a large inverted sphere with a vertical gradient baked into vertex
   * colours. Cheaper than a cube map, needs no assets, and the horizon colour
   * can be matched to the fog exactly so the seam is invisible.
   */
  private buildSky(map: GameMap): void {
    const geo = new THREE.SphereGeometry(400, 24, 16);
    const pos = geo.getAttribute('position');
    const colors = new Float32Array(pos.count * 3);
    const top = new THREE.Color(map.sky).multiplyScalar(0.82);
    const horizon = new THREE.Color(map.fog).lerp(new THREE.Color(map.sky), 0.35);
    const c = new THREE.Color();
    for (let i = 0; i < pos.count; i++) {
      // Bias toward the horizon so the gradient is concentrated where the
      // player actually looks rather than spread evenly over the dome.
      const t = Math.max(0, Math.min(1, pos.getY(i) / 400));
      c.copy(horizon).lerp(top, Math.pow(t, 0.55));
      colors[i * 3] = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      side: THREE.BackSide,
      fog: false,
      depthWrite: false,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    // Render first so it never overdraws the level.
    mesh.renderOrder = -1;
    this.scene.add(mesh);
    this.skyMesh = mesh;
    this.geometries.push(geo);
    this.materials.push(mat);

    // A faint sun disc, so the light direction is readable in-world.
    const s = map.sun;
    const len = Math.hypot(s.x, s.y, s.z) || 1;
    const discGeo = new THREE.SphereGeometry(9, 12, 8);
    const discMat = new THREE.MeshBasicMaterial({ color: 0xfff2cf, fog: false, depthWrite: false });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.position.set((s.x / len) * 340, (s.y / len) * 340, (s.z / len) * 340);
    disc.frustumCulled = false;
    disc.renderOrder = -1;
    this.scene.add(disc);
    this.geometries.push(discGeo);
    this.materials.push(discMat);
  }

  clear(): void {
    for (const m of this.meshes) this.root.remove(m);
    this.meshes.length = 0;
    if (this.skyMesh) {
      this.scene.remove(this.skyMesh);
      this.skyMesh = null;
    }
    // Remove the sun disc and anything else parked directly on the scene.
    for (const child of [...this.scene.children]) {
      if (child instanceof THREE.Mesh) this.scene.remove(child);
    }
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.map = null;
  }

  get currentMap(): GameMap | null {
    return this.map;
  }

  /**
   * Keeps the shadow frustum centred on the player.
   *
   * With a 60 m map and a 92 m frustum this is not strictly required, but it
   * lets the frustum stay small — and therefore the shadows stay sharp — if a
   * larger map is added later.
   */
  followShadow(x: number, z: number): void {
    if (!this.map) return;
    const s = this.map.sun;
    const len = Math.hypot(s.x, s.y, s.z) || 1;
    this.sun.target.position.set(x, 0, z);
    this.sun.position.set(x + (s.x / len) * 90, (s.y / len) * 90, z + (s.z / len) * 90);
  }
}
