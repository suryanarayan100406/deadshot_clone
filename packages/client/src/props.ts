/**
 * Prop rendering.
 *
 * The level's brushes are boxes, and boxes are all they can ever be: that array
 * *is* the collision geometry, so every vertex in it has to be something a bullet
 * stops on. Curves live here instead — pipes, barrels, vessels, domes, flanges,
 * valve wheels, lamps, ladder rungs — in a second array that is drawn and almost
 * never collided. `propPlacementIssue` in the shared package is what makes that
 * safe; this file's only job is to draw the result without giving back the frame
 * budget that the brush merge bought.
 *
 * Which is the whole design problem. A dressed map runs to about 1 700 props, and
 * 1 700 meshes is not a renderer, it is a slideshow. So:
 *
 *   • **One `InstancedMesh` per distinct shape.** Props are grouped by kind, axis,
 *     material, segment count and (for rings) tube ratio, which collapses those
 *     1 700 objects into on the order of 60 draw calls — every pipe of a given
 *     gauge in a given metal is one call, however many there are.
 *
 *   • **Unit geometry, per-instance transform.** Each group holds one shape built
 *     at radius 1 and length 1 with its axis rotation baked in, and every instance
 *     is a scale and a translate of it. Nothing is rebuilt per prop.
 *
 *   • **Segment count scaled to radius.** A 3 cm ladder rung and a 1 m vessel do
 *     not need the same silhouette budget. A rung gets five sides and reads as
 *     perfectly round at the distance anyone ever sees it from.
 *
 * Positions come from `propHalf`, the same function the collider and the test
 * suite use, so a prop cannot be drawn in one place and collided in another.
 *
 * Still nothing loaded from disk: every shape here is a three.js primitive.
 */

import * as THREE from 'three';
import {
  MATERIALS,
  propHalf,
  type MatKey,
  type Prop,
  type PropKind,
} from '@oneshot/shared';

/** Everything a batch owns, so `World.clear()` can dispose it. */
export interface PropBatch {
  meshes: THREE.InstancedMesh[];
  geometries: THREE.BufferGeometry[];
  materials: THREE.Material[];
}

/**
 * Silhouette budget for a given radius.
 *
 * Bucketed rather than continuous, because every distinct value is another draw
 * call: three buckets keep a map's ladders, pipework and vessels sharing three
 * cylinders between them. Odd counts, so a cylinder never presents two parallel
 * flat faces to the camera — the one artefact that makes a low-poly round thing
 * look faceted rather than round.
 */
function radialSegments(r: number): number {
  if (r < 0.09) return 5;
  if (r < 0.35) return 9;
  if (r < 1.1) return 15;
  return 21;
}

/**
 * Tube-to-radius ratio for a ring, quantised so rings of the same proportion
 * share a geometry.
 *
 * Floored, never rounded. A ring drawn slightly thinner than declared stays
 * inside the bounding box the placement rules were checked against; one drawn
 * slightly fatter would poke out of it, and the whole point of those rules is
 * that nothing decorative extends past where it was proven legal.
 */
function tubeRatio(p: Prop): number {
  return Math.max(0.01, Math.floor((p.len / p.r) * 100) / 100);
}

/** Deterministic hash → [0,1). Mirrors `world.ts`; same input, same tint. */
function hash01(x: number, y: number, z: number, salt: number): number {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2246822519)) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 1274126177) >>> 0;
  h = (h ^ salt) >>> 0;
  h = (h ^ (h >>> 16)) >>> 0;
  return (h >>> 8) / 16777216;
}

/**
 * One shape at radius 1, length 1, with its axis rotation baked in.
 *
 * Baking the rotation into the geometry rather than the instance matrix means the
 * per-instance transform stays a scale and a translate, which is what lets the
 * scale be read straight off the prop's own radius and length.
 */
function unitGeometry(kind: PropKind, axis: 'x' | 'y' | 'z', seg: number, ratio: number): THREE.BufferGeometry {
  let g: THREE.BufferGeometry;
  switch (kind) {
    case 'cyl':
      g = new THREE.CylinderGeometry(1, 1, 1, seg, 1, false);
      break;
    case 'cone':
      g = new THREE.ConeGeometry(1, 1, seg, 1, false);
      break;
    case 'dome':
      // Top half of a sphere, dropped so it spans [-0.5, +0.5] like the others.
      // Scaling y independently then gives a squashed dome, which is what a tank
      // head, a bollard cap and a barrel lid all actually are.
      g = new THREE.SphereGeometry(1, seg, Math.max(2, Math.round(seg / 2)), 0, Math.PI * 2, 0, Math.PI / 2);
      g.translate(0, -0.5, 0);
      break;
    case 'sphere':
      g = new THREE.SphereGeometry(1, seg, Math.max(3, Math.round(seg / 2)));
      break;
    case 'ring':
      // Torus in the XY plane, so its axis is +Z before rotation. Outer radius
      // is 1 + ratio, which scaled by r gives exactly `propHalf`'s r + len.
      g = new THREE.TorusGeometry(1, ratio, Math.max(4, Math.round(seg * 0.6)), Math.max(6, seg * 2));
      break;
  }

  if (kind === 'ring') {
    // Default axis is Z; a torus is symmetric about its own plane, so either
    // sign of the quarter turn lands the same shape.
    if (axis === 'y') g.rotateX(Math.PI / 2);
    else if (axis === 'x') g.rotateY(Math.PI / 2);
  } else if (axis === 'x') {
    g.rotateZ(-Math.PI / 2); // +Y → +X, so a dome's cap faces outward.
  } else if (axis === 'z') {
    g.rotateX(Math.PI / 2); // +Y → +Z.
  }
  return g;
}

/** Instance scale: radius across the two cross axes, length along `axis`. */
function instanceScale(p: Prop, out: THREE.Vector3): THREE.Vector3 {
  if (p.kind === 'sphere' || p.kind === 'ring') return out.set(p.r, p.r, p.r);
  return out.set(
    p.axis === 'x' ? p.len : p.r,
    p.axis === 'y' ? p.len : p.r,
    p.axis === 'z' ? p.len : p.r,
  );
}

/**
 * Builds the instanced meshes for a map's props.
 *
 * The caller owns the result and must add the meshes to the scene graph and
 * dispose the geometries and materials on teardown.
 */
export function buildProps(props: readonly Prop[], shadows: number): PropBatch {
  const batch: PropBatch = { meshes: [], geometries: [], materials: [] };
  if (props.length === 0) return batch;

  // Bucket first, build second: the group has to be sized before an
  // InstancedMesh can be allocated for it.
  const groups = new Map<string, Prop[]>();
  for (const p of props) {
    const seg = radialSegments(p.r);
    const ratio = p.kind === 'ring' ? tubeRatio(p) : 0;
    const key = `${p.kind}|${p.axis}|${p.mat}|${seg}|${ratio}`;
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(p);
  }

  const m = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const tint = new THREE.Color();

  for (const [key, list] of groups) {
    const first = list[0];
    const parts = key.split('|');
    const geo = unitGeometry(first.kind, first.axis, Number(parts[3]), Number(parts[4]));
    const spec = MATERIALS[first.mat as MatKey];
    const transparent = spec.opacity !== undefined && spec.opacity < 1;

    // Lit panels and lamp bulbs go through Basic so they read as emitting rather
    // than as a pale surface that happens to be facing the sun. Everything else
    // matches the level's Lambert shading exactly — props sitting in a different
    // lighting model from the wall behind them is instantly visible.
    const mat: THREE.Material =
      first.mat === 'light'
        ? new THREE.MeshBasicMaterial({ color: spec.color })
        : new THREE.MeshLambertMaterial({
            color: spec.color,
            transparent,
            opacity: spec.opacity ?? 1,
            side: transparent ? THREE.DoubleSide : THREE.FrontSide,
            depthWrite: !transparent,
          });

    const mesh = new THREE.InstancedMesh(geo, mat, list.length);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const { hy } = propHalf(p);
      pos.set(p.x, p.y + hy, p.z);
      instanceScale(p, scale);
      m.compose(pos, quat, scale);
      mesh.setMatrixAt(i, m);

      // Per-instance brightness, so forty identical barrels do not read as forty
      // copies of one barrel. Same trick the brush merge plays on faces, at ±6%
      // — enough to break the repetition, not enough to look like a colour bug.
      const n = 0.94 + hash01(Math.round(p.x * 4), Math.round(p.y * 4), Math.round(p.z * 4), 0x9e37) * 0.12;
      mesh.setColorAt(i, tint.setHex(spec.color).multiplyScalar(n));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;

    // Thin pipework casts shadows finer than the shadow map can resolve, so it
    // arrives as speckle rather than shadow. Below about 12 cm it is left out of
    // the depth pass entirely — cheaper, and it looks better.
    const mayCast = !transparent && first.mat !== 'light' && first.r >= 0.12;
    const mayReceive = first.mat !== 'light';
    // Stashed so a mid-session shadow-quality change can restore the policy
    // instead of turning every ladder rung back into a shadow caster.
    mesh.userData.mayCastShadow = mayCast;
    mesh.userData.mayReceiveShadow = mayReceive;
    mesh.castShadow = shadows > 0 && mayCast;
    mesh.receiveShadow = shadows > 0 && mayReceive;
    mesh.frustumCulled = false; // A group spans the map; culling it drops half the plant.
    batch.meshes.push(mesh);
    batch.geometries.push(geo);
    batch.materials.push(mat);
  }

  return batch;
}
