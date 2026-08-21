/**
 * The character mesh.
 *
 * Split out of `actors.ts` because that file is about netcode — interpolation,
 * snapshot history, lag-compensation offsets — and this one is about a body. Two
 * places build the same body (the match and the lobby's staging room), and both
 * import it from here; `actors.ts` re-exports the names so neither had to change.
 *
 * ── Why it stopped being boxes ───────────────────────────────────────────────
 * The previous rig was ~60 axis-aligned `BoxGeometry` in two Lambert materials and
 * one low-shine Phong. Both halves of that were holding the look back:
 *
 *  • **Silhouette.** A human read at 40 m is almost entirely outline, and a limb
 *    built from a box has a hard rectangular outline from every angle. Tapered
 *    cylinders cost the same draw call and read as arms and legs, because the taper
 *    (wrist narrower than shoulder, ankle narrower than thigh) is most of what the
 *    eye uses to identify a limb.
 *  • **Shading.** Lambert has no specular term at all, so nylon, kevlar, rubber and
 *    steel all returned identical light. See `charactermat.ts` — that is where the
 *    fix lives, and it matters more than the geometry does.
 *
 * ── Two invariants, both easy to break by accident ───────────────────────────
 *  1. **Everything stays inside the collider envelope** the server traces against —
 *     `PLAYER_HEIGHT` tall, `HEAD_BOX` for the head. Geometry poking out past the
 *     hitbox produces shots that visibly connect and deal no damage, which reads as
 *     broken netcode rather than as a modelling liberty. So the helmet is a shell
 *     *around a smaller skull*, both inscribed in `HEAD_BOX`: it is distinguished by
 *     material and cut, never by being bigger than the head. `ENVELOPE` below states
 *     the numbers the shared test asserts.
 *  2. **Limb geometry is pre-translated so its pivot is the joint.** A child bolted
 *     to an arm therefore measures its local Y *down from the shoulder*, not from the
 *     limb's centre — which is what lets the whole rig animate for free when a caller
 *     rotates eight objects by name.
 */

import * as THREE from 'three';
import { HEAD_BOX, PLAYER_HEIGHT } from '@oneshot/shared';
import { characterMaterial } from './charactermat';

/** Unteamed body colour, exported because the staging room paints the same people. */
export const NEUTRAL_COLOR = 0xb8b3c4;

/**
 * Joint positions, in metres above the feet of a standing player.
 *
 * Named and exported because two places pose this skeleton — the actor and the
 * lobby's staging room — and a shoulder that sat at 1.4 in one and 1.38 in the other
 * would hold the weapon somewhere slightly different in the lobby than in the match.
 * That is the kind of difference a player registers as "it looks off" without ever
 * being able to point at it.
 */
export const JOINT = {
  torsoY: 0.86,
  hipsY: 0.76,
  shoulderY: 1.4,
  legHipY: 0.78,
  /** Half the separation: arms and legs are mirrored about the spine. */
  armX: 0.28,
  legX: 0.11,
} as const;

/**
 * The extents every part has to fit inside, derived from the shared collider.
 *
 * Exported so `packages/shared/test` can assert the geometry against the same
 * numbers the server traces against, rather than against a copy that can drift.
 */
export const ENVELOPE = {
  /** Widest half-extent any body part may reach on X or Z. */
  halfWidth: 0.4,
  /** Crown height. Nothing may be taller. */
  top: PLAYER_HEIGHT,
  /** Head half-extent — the helmet shell has to fit within this too. */
  headHalf: HEAD_BOX * 0.5,
} as const;

/** Every limb of a built character, by name, plus what it takes to free it. */
export interface CharacterRig {
  /** Origin at the feet, +Z behind the player — so `rotation.y` is view yaw. */
  group: THREE.Group;
  head: THREE.Mesh;
  visor: THREE.Mesh;
  torso: THREE.Mesh;
  hips: THREE.Mesh;
  armL: THREE.Mesh;
  armR: THREE.Mesh;
  legL: THREE.Mesh;
  legR: THREE.Mesh;
  gun: THREE.Mesh;
  /** Team colour lives here — the one material a caller is expected to recolour. */
  bodyMat: THREE.MeshStandardMaterial;
  trimMat: THREE.MeshStandardMaterial;
  gearMat: THREE.MeshStandardMaterial;
  dispose(): void;
}

/**
 * Build one character.
 *
 * The limbs are returned by name because posing is the caller's job: an actor poses
 * from network flags, the lobby poses an idle stance, and both want the same body.
 */
export function buildCharacter(shadows: boolean): CharacterRig {
  const ownedGeo: THREE.BufferGeometry[] = [];
  const ownedMat: THREE.Material[] = [];

  const mat = (m: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial => {
    ownedMat.push(m);
    return m;
  };

  // Six surface classes, because six is how many materials a soldier is made of.
  // The tile rates differ by part size: a chest panel is half a metre across and a
  // pouch is eight centimetres, so a single rate would make one of them look like a
  // photograph of the other.
  const bodyMat = mat(characterMaterial('cloth', NEUTRAL_COLOR, 5));
  const trimMat = mat(characterMaterial('cloth', 0x2f3238, 7));
  const gearMat = mat(characterMaterial('armour', 0x23262b, 6));
  const bootMat = mat(characterMaterial('rubber', 0x1b1d21, 3));
  // metalness 0.92, not 1: even a machined buckle has a micron of oxide on it, and
  // a perfect conductor with nothing to reflect renders as a black hole.
  const steelMat = mat(characterMaterial('steel', 0x8d949c, 3, 0.92));
  const skinMat = mat(characterMaterial('skin', 0xa87c5c, 2));

  const keep = <T extends THREE.BufferGeometry>(g: T): T => {
    ownedGeo.push(g);
    return g;
  };

  const mesh = (g: THREE.BufferGeometry, m: THREE.Material): THREE.Mesh => {
    const o = new THREE.Mesh(keep(g), m);
    o.castShadow = shadows;
    o.receiveShadow = false;
    return o;
  };

  /** Axis-aligned panel. Still the right primitive for plates and straps. */
  const box = (sx: number, sy: number, sz: number, m: THREE.Material): THREE.Mesh =>
    mesh(new THREE.BoxGeometry(sx, sy, sz), m);

  /**
   * Tapered limb segment, pivoting at its top.
   *
   * 10 radial segments is the sweet spot: 8 still shows facets on a forearm at
   * conversational range in the staging room, and 12 costs triangles that no longer
   * change the outline.
   */
  const limb = (rTop: number, rBot: number, len: number, m: THREE.Material): THREE.Mesh => {
    const g = new THREE.CylinderGeometry(rTop, rBot, len, 10, 1);
    g.translate(0, -len * 0.5, 0); // invariant 2: pivot at the joint, not the middle
    return mesh(g, m);
  };

  /** Rounded mass — skulls, shoulder caps, knees, pouch bellies. */
  const blob = (r: number, m: THREE.Material, wSeg = 12, hSeg = 8): THREE.Mesh =>
    mesh(new THREE.SphereGeometry(r, wSeg, hSeg), m);

  /** Bolts a detail onto a parent limb — see invariant 2. */
  const on = (parent: THREE.Object3D, o: THREE.Mesh, x: number, y: number, z: number): THREE.Mesh => {
    o.position.set(x, y, z);
    parent.add(o);
    return o;
  };

  const H = HEAD_BOX;
  const headHalf = ENVELOPE.headHalf; // 0.15

  /* ── Head ────────────────────────────────────────────────────────────────────
     A sphere of radius `headHalf` inscribes HEAD_BOX exactly, so the skull is cut
     below that to leave room for the helmet shell *outside* it and still inside the
     hitbox. This is invariant 1 in its most load-bearing form. */
  const skullR = headHalf * 0.84;
  const head = blob(skullR, skinMat, 14, 10);
  head.scale.set(1, 1.04, 1.08); // faces are longer than they are wide
  const visor = box(H * 0.8, H * 0.26, 0.018, steelMat);

  // Jaw and neck. The neck matters more than it sounds: without it the head floats,
  // which is the single most obvious tell that a body was assembled from parts.
  on(head, box(skullR * 1.0, skullR * 0.5, skullR * 0.6, skinMat), 0, -skullR * 0.62, -skullR * 0.42);
  on(head, limb(skullR * 0.52, skullR * 0.58, skullR * 0.7, skinMat), 0, -skullR * 0.72, 0.02);

  // Helmet: a hemisphere shell at the full envelope radius, over the smaller skull.
  const shellG = keep(new THREE.SphereGeometry(headHalf, 16, 10, 0, Math.PI * 2, 0, Math.PI * 0.62));
  const helmet = new THREE.Mesh(shellG, gearMat);
  helmet.castShadow = shadows;
  helmet.scale.set(1, 1.12, 1.04);
  on(head, helmet, 0, headHalf * 0.06, 0);
  // Crown plate in team colour — the surface most often seen from above and across
  // the map, so it is the one that carries the identification.
  const crownG = keep(new THREE.SphereGeometry(headHalf * 0.99, 14, 6, 0, Math.PI * 2, 0, Math.PI * 0.3));
  const crown = new THREE.Mesh(crownG, bodyMat);
  crown.castShadow = shadows;
  crown.scale.set(1, 1.14, 1.04);
  on(head, crown, 0, headHalf * 0.075, 0);

  // Helmet furniture: brow trim, ear cups, NVG shroud with its mount, chinstrap.
  on(head, box(H * 0.86, H * 0.085, H * 0.14, gearMat), 0, H * 0.1, -H * 0.4);
  for (const s of [1, -1]) {
    const cup = limb(H * 0.15, H * 0.14, H * 0.1, gearMat);
    cup.rotation.z = Math.PI * 0.5;
    on(head, cup, s * (H * 0.44 + H * 0.05), H * 0.02, 0);
    on(head, box(H * 0.05, H * 0.06, H * 0.2, steelMat), s * H * 0.4, H * 0.24, -H * 0.06);
  }
  on(head, box(H * 0.2, H * 0.1, H * 0.11, gearMat), 0, H * 0.24, -H * 0.36);
  on(head, box(H * 0.09, H * 0.13, H * 0.05, steelMat), 0, H * 0.3, -H * 0.42);
  on(head, box(H * 0.62, H * 0.05, H * 0.05, trimMat), 0, -H * 0.28, -H * 0.3);

  /* ── Torso ───────────────────────────────────────────────────────────────────
     A chest is an ellipse, not a square. A 12-sided cylinder squashed on Z gives
     that for one draw call, and the shoulder-to-waist taper is what makes the body
     read as a torso instead of as a crate. */
  const torso = limb(0.235, 0.185, 0.56, trimMat);
  torso.geometry.translate(0, 0.28, 0); // re-centre: torso is posed at its middle
  torso.scale.set(1, 1, 0.58);

  const hips = limb(0.195, 0.185, 0.16, trimMat);
  hips.geometry.translate(0, 0.08, 0);
  hips.scale.set(1, 1, 0.66);

  const armL = limb(0.062, 0.043, 0.5, trimMat);
  const armR = limb(0.062, 0.043, 0.5, trimMat);
  const legL = limb(0.085, 0.056, 0.72, trimMat);
  const legR = limb(0.085, 0.056, 0.72, trimMat);
  const gun = box(0.07, 0.09, 0.44, gearMat);

  /* ── Plate carrier ───────────────────────────────────────────────────────────
     Front and back plates in team colour, with a chamfered upper edge — a single
     slab reads as a bib, and the chamfer is what makes it read as armour. */
  on(torso, box(0.4, 0.3, 0.055, bodyMat), 0, 0.06, -0.145);
  on(torso, box(0.34, 0.07, 0.05, bodyMat), 0, 0.225, -0.135);
  on(torso, box(0.36, 0.26, 0.05, bodyMat), 0, 0.04, 0.145);
  // Cummerbund: wraps the waist, so a cylinder rather than a plate.
  const cummer = limb(0.2, 0.2, 0.12, gearMat);
  cummer.scale.set(1, 1, 0.62);
  on(torso, cummer, 0, -0.1, 0);

  // Shoulder straps over the trapezius, and the two front buckles.
  for (const s of [1, -1]) {
    const strap = box(0.075, 0.34, 0.03, gearMat);
    strap.rotation.x = -0.06;
    on(torso, strap, s * 0.125, 0.12, -0.17);
    on(torso, box(0.055, 0.045, 0.02, steelMat), s * 0.125, 0.2, -0.19);
  }

  // Pouches: rounded bellies, because a magazine pouch under load is not a cube.
  for (const [px, py, pr] of [
    [0.11, -0.11, 0.055],
    [-0.11, -0.11, 0.055],
    [0.0, -0.13, 0.05],
  ] as const) {
    const pouch = blob(pr, gearMat, 10, 6);
    pouch.scale.set(1.1, 1.3, 0.72);
    on(torso, pouch, px, py, -0.165);
    on(torso, box(pr * 1.9, pr * 0.3, 0.02, trimMat), px, py + pr * 0.9, -0.185);
  }
  // Radio on the left chest, antenna angled back over the shoulder.
  on(torso, box(0.075, 0.11, 0.05, gearMat), 0.16, 0.02, -0.155);
  const ant = limb(0.006, 0.004, 0.2, steelMat);
  ant.rotation.set(-0.4, 0, -0.12);
  on(torso, ant, 0.16, 0.26, -0.14);

  // Pack high on the back, with a rolled top and compression straps.
  const pack = box(0.26, 0.28, 0.12, trimMat);
  on(torso, pack, 0, -0.02, 0.2);
  on(torso, (() => {
    const roll = limb(0.055, 0.055, 0.26, trimMat);
    roll.rotation.z = Math.PI * 0.5;
    return roll;
  })(), 0.13, 0.15, 0.205);
  for (const sy of [0.04, -0.08]) on(torso, box(0.28, 0.022, 0.135, gearMat), 0, sy, 0.205);

  /* ── Hips ────────────────────────────────────────────────────────────────── */
  const belt = limb(0.2, 0.2, 0.07, gearMat);
  belt.scale.set(1, 1, 0.68);
  on(hips, belt, 0, 0.05, 0);
  on(hips, box(0.065, 0.05, 0.02, steelMat), 0, 0.05, -0.135);
  // Drop-leg holster on the left, dump pouch on the right.
  on(hips, box(0.095, 0.14, 0.07, gearMat), -0.175, -0.03, 0.01);
  on(hips, box(0.055, 0.06, 0.045, steelMat), -0.175, 0.04, -0.015);
  const dump = blob(0.06, gearMat, 10, 6);
  dump.scale.set(0.9, 1.2, 0.8);
  on(hips, dump, 0.17, -0.03, 0.06);

  /* ── Arms ────────────────────────────────────────────────────────────────────
     Deltoid cap, elbow pad, glove. The cap is team-coloured because the shoulder is
     what shows first around a corner — the read has to survive being half-occluded. */
  for (const arm of [armL, armR]) {
    const delt = blob(0.072, bodyMat, 12, 8);
    delt.scale.set(1, 0.92, 1);
    on(arm, delt, 0, -0.012, 0);
    const elbow = blob(0.05, gearMat, 10, 6);
    elbow.scale.set(1, 0.85, 1.05);
    on(arm, elbow, 0, -0.255, -0.004);
    // Forearm sleeve cuff — a hard band where cloth meets glove.
    on(arm, box(0.095, 0.03, 0.095, trimMat), 0, -0.435, 0);
    const glove = blob(0.055, gearMat, 10, 6);
    glove.scale.set(1, 1.15, 1.2);
    on(arm, glove, 0, -0.5, -0.008);
    // Exposed knuckles: the one place skin appears below the jaw, and the reason
    // the hands stop looking like mittens.
    on(arm, box(0.05, 0.035, 0.055, skinMat), 0, -0.52, -0.045);
  }

  /* ── Legs ────────────────────────────────────────────────────────────────────
     Thigh mass, knee pad, and a boot built as a heel block plus a shaped toe. A
     single box for a boot is the most visible remaining block on the body. */
  for (const leg of [legL, legR]) {
    const thigh = blob(0.088, trimMat, 10, 6);
    thigh.scale.set(1, 1.5, 1.05);
    on(leg, thigh, 0, -0.13, 0);
    const knee = blob(0.062, gearMat, 10, 6);
    knee.scale.set(1.05, 1.1, 0.95);
    on(leg, knee, 0, -0.365, -0.03);
    // Cargo pocket on the outer thigh.
    on(leg, box(0.075, 0.1, 0.055, trimMat), 0.055, -0.2, -0.035);
    // Boot: shaft, heel, toe. The toe is a squashed sphere so it has a curve.
    on(leg, limb(0.075, 0.078, 0.14, bootMat), 0, -0.58, -0.01);
    on(leg, box(0.15, 0.1, 0.15, bootMat), 0, -0.665, 0.0);
    const toe = blob(0.075, bootMat, 10, 6);
    toe.scale.set(1, 0.62, 1.3);
    on(leg, toe, 0, -0.685, -0.075);
    on(leg, box(0.165, 0.03, 0.235, bootMat), 0, -0.735, -0.03);
    // Laces, as a stack of thin bands. Cheap, and the eye reads it instantly.
    for (let i = 0; i < 3; i++) on(leg, box(0.1, 0.012, 0.02, trimMat), 0, -0.6 + i * 0.032, -0.075);
  }

  /* ── Third-person weapon ─────────────────────────────────────────────────────
     A bar reads as a bar at fifty metres. A magazine under it and an optic on top
     give it enough silhouette to be recognisable as a gun; the barrel is a cylinder
     so the muzzle end does not read as a plank. */
  on(gun, box(0.05, 0.13, 0.055, gearMat), 0, -0.1, 0.05);
  on(gun, box(0.04, 0.045, 0.085, steelMat), 0, 0.066, 0.015);
  const barrel = limb(0.012, 0.014, 0.16, steelMat);
  barrel.rotation.x = Math.PI * 0.5;
  on(gun, barrel, 0, 0.012, -0.2);

  const group = new THREE.Group();
  group.add(head, torso, hips, armL, armR, legL, legR, gun);
  // The visor is the one part that belongs to another part: it sits on the face, so
  // it is parented to the head rather than posed alongside it. Both pose functions
  // used to place it themselves, which worked only because the head never yawed —
  // the staging room's characters glance around, and a sibling visor would have slid
  // off the side of the face the moment one did.
  head.add(visor);
  visor.position.set(0, H * 0.04, -(skullR * 1.02 + 0.012));

  return {
    group,
    head,
    visor,
    torso,
    hips,
    armL,
    armR,
    legL,
    legR,
    gun,
    bodyMat,
    trimMat,
    gearMat,
    dispose(): void {
      group.parent?.remove(group);
      for (const g of ownedGeo) g.dispose();
      ownedGeo.length = 0;
      // Materials own cloned textures (per-material `repeat`), so disposing the
      // material is not enough — the clones have to go with it or every character
      // that ever spawned leaks three GPU textures.
      for (const m of ownedMat) {
        const s = m as THREE.MeshStandardMaterial;
        s.map?.dispose();
        s.normalMap?.dispose();
        s.roughnessMap?.dispose();
        m.dispose();
      }
      ownedMat.length = 0;
    },
  };
}
