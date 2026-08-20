/**
 * World rendering.
 *
 * Every wall, crate and stair in the level is one entry in the shared `GameMap`
 * brush list — the exact same array the collision code raycasts against. There
 * is no separate visual mesh, so what you see is what you hit, always.
 *
 * Three things make this cheap enough to run at 144 fps on integrated graphics:
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
 *   • **Baked contact shading.** Vertical faces are split into a few horizontal
 *     bands and darkened toward their base, with a bright lip along their top.
 *     Nothing else available without textures does as much work: the eye finds an
 *     edge by the shadow under it rather than by the line itself, so this is what
 *     stops a level of untextured boxes reading as a pile of boxes.
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
import { buildProps } from './props';
import { getTextureForMaterial } from './textures';

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
 * How far a contact shadow rises up a vertical face, in metres, and how tall the
 * bright lip along its top is.
 *
 * Both get clamped to a fraction of the brush's own height below, because a fixed
 * band is wrong at small sizes: a 35 cm coping course darkened over its bottom
 * 60 cm is not a shadow under a coping, it is a black stripe where a coping was.
 */
const CONTACT_BAND = 0.6;
const EDGE_BAND = 0.16;

/**
 * Brightness multiplier for a vertex at world height `wy` on a vertical face
 * spanning `y0`..`y1`.
 *
 * Squared falloff on the way down, so the darkening hugs the base rather than
 * washing out the whole lower half of a wall — the shape a real contact shadow
 * has. A brighter lip along the top edge does the opposite job: it separates a
 * wall from whatever is behind it at a distance, where the silhouette is all the
 * information there is.
 */
function contactShade(wy: number, y0: number, y1: number, band: number, lip: number): number {
  let m = 1;
  const dBot = wy - y0;
  if (dBot < band) {
    const t = 1 - dBot / band;
    m *= 1 - 0.36 * t * t;
  }
  const dTop = y1 - wy;
  if (dTop < lip) m *= 1 + 0.18 * (1 - dTop / lip);
  return m;
}

/**
 * The horizontal band boundaries of a vertical face, ascending.
 *
 * Three quads at most, and only where they buy something: one boundary at the top
 * of the contact band, one at the bottom of the lip. Interpolating the gradient
 * across a single tall quad instead would smear a 60 cm shadow over 12 m of wall,
 * and fixing that with evenly spaced rows would multiply the vertex count for
 * bands whose shade is constant anyway.
 */
function faceBands(y0: number, y1: number, band: number, lip: number, out: number[]): void {
  out.length = 0;
  out.push(y0);
  const h = y1 - y0;
  if (h > band * 1.8) out.push(y0 + band);
  if (h > lip * 4) out.push(y1 - lip);
  out.push(y1);
}

/** Contact band and top lip for a brush of height `sy`. */
function brushBands(sy: number): [number, number] {
  return [Math.min(CONTACT_BAND, sy * 0.45), Math.min(EDGE_BAND, sy * 0.25)];
}

/**
 * Builds one merged, vertex-coloured geometry from a set of brushes.
 *
 * Faces are emitted manually rather than via BoxGeometry so each face can carry
 * its own tint and its own vertical gradient, and so we can skip the underside of
 * anything sitting on the ground — those triangles are never visible and cost
 * fill rate on every frame.
 */
function mergeBrushes(brushes: readonly Brush[], baseColor: number): THREE.BufferGeometry {
  const rows: number[] = [];

  // Exact vertex count first. A vertical face is now 1–3 quads depending on how
  // much room its height leaves for a contact band and a lip, so the old "6 faces
  // × 4 verts" bound no longer holds, and guessing high would mean allocating
  // several times the buffer a map actually needs.
  let total = 0;
  for (const b of brushes) {
    const [band, lip] = brushBands(b.sy);
    faceBands(b.y, b.y + b.sy, band, lip, rows);
    const quads = rows.length - 1;
    for (let f = 0; f < 6; f++) {
      const ny = FACES[f]!.n[1];
      if (ny < 0 && b.y <= 0.001) continue;
      total += (ny !== 0 ? 1 : quads) * 4;
    }
  }

  const positions = new Float32Array(total * 3);
  const normals = new Float32Array(total * 3);
  const colors = new Float32Array(total * 3);
  const uvs = new Float32Array(total * 2);
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
    const y0 = b.y;
    const y1 = b.y + b.sy;
    const [band, lip] = brushBands(b.sy);
    faceBands(y0, y1, band, lip, rows);

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

      if (ny !== 0) {
        // Horizontal face: one quad, and no gradient to bake into it.
        const r = base.r * faceTint;
        const g = base.g * faceTint;
        const bl = base.b * faceTint;
        const start = vi;
        for (let c = 0; c < 4; c++) {
          // Corner order 0..3 walks the quad so (0,1,2)+(0,2,3) wind correctly.
          const cu = c === 0 || c === 3 ? -1 : 1;
          const cv = c < 2 ? -1 : 1;
          const q = vi * 3;
          const px = cx + ex + ux * su * cu + vx * sv * cv;
          const py = cy + ey + uy * su * cu + vy * sv * cv;
          const pz = cz + ez + uz * su * cu + vz * sv * cv;
          positions[q] = px;
          positions[q + 1] = py;
          positions[q + 2] = pz;
          normals[q] = nx;
          normals[q + 1] = ny;
          normals[q + 2] = nz;
          colors[q] = r;
          colors[q + 1] = g;
          colors[q + 2] = bl;
          uvs[vi * 2] = px * 0.25;
          uvs[vi * 2 + 1] = pz * 0.25;
          vi++;
        }
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
        continue;
      }

      // Vertical face. Its in-plane v axis is world up for all four of them (see
      // FACES), so a band is just a pair of heights and each corner takes the
      // gradient at its own.
      for (let r0 = 0; r0 < rows.length - 1; r0++) {
        const yLo = rows[r0]!;
        const yHi = rows[r0 + 1]!;
        const start = vi;
        for (let c = 0; c < 4; c++) {
          const cu = c === 0 || c === 3 ? -1 : 1;
          const wy = c < 2 ? yLo : yHi;
          const t = faceTint * contactShade(wy, y0, y1, band, lip);
          const q = vi * 3;
          const px = cx + ex + ux * su * cu;
          const pz = cz + ez + uz * su * cu;
          positions[q] = px;
          positions[q + 1] = wy;
          positions[q + 2] = pz;
          normals[q] = nx;
          normals[q + 1] = 0;
          normals[q + 2] = nz;
          colors[q] = base.r * t;
          colors[q + 1] = base.g * t;
          colors[q + 2] = base.b * t;
          uvs[vi * 2] = nx !== 0 ? pz * 0.25 : px * 0.25;
          uvs[vi * 2 + 1] = wy * 0.25;
          vi++;
        }
        indices.push(start, start + 1, start + 2, start, start + 2, start + 3);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions.subarray(0, vi * 3), 3));
  geo.setAttribute('normal', new THREE.BufferAttribute(normals.subarray(0, vi * 3), 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors.subarray(0, vi * 3), 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uvs.subarray(0, vi * 2), 2));
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
  private propMeshes: THREE.InstancedMesh[] = [];
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
    // 92 m square, centred on the player by `followShadow`. That is the full
    // extent of the largest map, so on the smaller ones it is pure headroom; a
    // tighter frustum is the single biggest win for shadow crispness at a given
    // map resolution, and following the player is what keeps it tight.
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
    for (const m of this.propMeshes) {
      m.castShadow = quality > 0 && m.userData.mayCastShadow === true;
      m.receiveShadow = quality > 0 && m.userData.mayReceiveShadow === true;
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
      const tex = getTextureForMaterial(key);
      let mat: THREE.Material;
      if (key === 'metal' || key === 'metalDark' || key === 'accent') {
        mat = new THREE.MeshPhongMaterial({
          map: tex,
          vertexColors: true,
          specular: key === 'metal' ? 0x707c8c : 0x424a54,
          shininess: key === 'metal' ? 60 : 42,
          transparent,
          opacity: spec.opacity ?? 1,
          side: transparent ? THREE.DoubleSide : THREE.FrontSide,
          depthWrite: !transparent,
        });
      } else {
        mat = new THREE.MeshLambertMaterial({
          map: tex,
          vertexColors: true,
          transparent,
          opacity: spec.opacity ?? 1,
          side: transparent ? THREE.DoubleSide : THREE.FrontSide,
          depthWrite: !transparent,
        });
      }
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

    // Round decoration, in as few draw calls as the shapes allow. Parked on
    // `root` alongside the merged brushes rather than on the scene, because
    // `clear()` treats anything directly on the scene as the sun disc.
    const batch = buildProps(map.props, shadows);
    for (const mesh of batch.meshes) {
      this.root.add(mesh);
      this.propMeshes.push(mesh);
    }
    this.geometries.push(...batch.geometries);
    this.materials.push(...batch.materials);

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

    // ── Coastal Ocean Plane ──────────────────────────────────────────────────
    const oceanGeo = new THREE.PlaneGeometry(1600, 1600, 8, 8);
    oceanGeo.rotateX(-Math.PI / 2);
    const oceanMat = new THREE.MeshPhongMaterial({
      color: 0x1a4660,
      specular: 0x6bb8dc,
      shininess: 75,
      fog: true,
    });
    const ocean = new THREE.Mesh(oceanGeo, oceanMat);
    ocean.position.set(0, -42, 0);
    ocean.frustumCulled = false;
    ocean.receiveShadow = false;
    this.scene.add(ocean);
    this.geometries.push(oceanGeo);
    this.materials.push(oceanMat);

    // ── Distant Coastal Mountains & Island Ridges ────────────────────────────
    const mtnGeo = new THREE.ConeGeometry(55, 65, 5);
    const mtnMat = new THREE.MeshLambertMaterial({
      color: new THREE.Color(map.fog).lerp(new THREE.Color(0x354854), 0.45),
      fog: true,
    });
    for (const [mx, mz, scale, rot] of [
      [220, 180, 1.3, 0.4],
      [280, 70, 1.1, 1.2],
      [-240, 160, 1.4, 0.8],
      [-290, -40, 1.2, 2.1],
      [140, 290, 1.5, 0.2],
      [-120, 270, 1.6, 1.7],
      [-260, -200, 1.3, 0.5],
      [230, -220, 1.2, 1.9],
    ] as const) {
      const mtn = new THREE.Mesh(mtnGeo, mtnMat);
      mtn.position.set(mx, -42 + 32 * scale, mz);
      mtn.scale.set(scale, scale, scale);
      mtn.rotation.y = rot;
      mtn.frustumCulled = false;
      this.scene.add(mtn);
    }
    this.geometries.push(mtnGeo);
    this.materials.push(mtnMat);

    // ── Coastal Outpost Cliff Embankment (under the compound) ────────────────
    const cliffGeo = new THREE.CylinderGeometry(map.half + 6, map.half + 45, 42, 16);
    const cliffMat = new THREE.MeshLambertMaterial({
      color: 0x5a5246,
      fog: true,
    });
    const cliff = new THREE.Mesh(cliffGeo, cliffMat);
    cliff.position.set(0, -21, 0);
    cliff.frustumCulled = false;
    this.scene.add(cliff);
    this.geometries.push(cliffGeo);
    this.materials.push(cliffMat);
  }

  clear(): void {
    for (const m of this.meshes) this.root.remove(m);
    this.meshes.length = 0;
    for (const m of this.propMeshes) {
      this.root.remove(m);
      m.dispose();
    }
    this.propMeshes.length = 0;
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
