/**
 * Remote players: entity interpolation plus procedurally generated bodies.
 *
 * ── Why interpolation, and why *behind* real time ────────────────────────────
 * Snapshots arrive 20 times a second but the screen refreshes 60–240 times a
 * second. Drawing the newest snapshot each frame gives visible 50 ms stutter.
 * Extrapolating forward from it instead guesses, and guesses wrong every time
 * someone changes direction — enemies overshoot corners and rubber-band back.
 *
 * So the renderer deliberately runs `INTERP_DELAY_MS` behind the estimated
 * server clock and interpolates between the two snapshots that bracket that
 * moment. Since the delay exceeds the 50 ms snapshot interval, both snapshots
 * have almost always arrived and the motion is exactly smooth. The cost is that
 * everyone else is drawn ~100 ms in the past — which is precisely the offset the
 * server's lag compensation rewinds by when it traces our shots, so aiming at
 * what we see is correct.
 *
 * ── Bodies ───────────────────────────────────────────────────────────────────
 * No model files. Each player is an InstancedMesh-free group of boxes sized from
 * the shared collider constants, so the visible silhouette agrees with the
 * hitboxes the server traces against. Legs and arms swing from a single phase
 * accumulator driven by the horizontal speed the snapshot already carries.
 */

import * as THREE from 'three';
import {
  AF,
  EYE_HEIGHT,
  EYE_HEIGHT_CROUCH,
  HEAD_BOX,
  INTERP_DELAY_MS,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  TEAM_A,
  TEAM_B,
  lerpAngle,
  weaponById,
  type ActorState,
} from '@oneshot/shared';

/** Snapshot history kept per actor. 20 frames ≈ 1 s, well past the interp delay. */
const HISTORY = 24;
/** Past this gap in a player's history, interpolation is a lie — snap instead. */
const MAX_INTERP_GAP_MS = 320;
/** How long a corpse stays on the ground. Matches the server's linger. */
const CORPSE_MS = 900;

interface Frame {
  t: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  speed: number;
  flags: number;
}

/**
 * Side colours, exported because the staging room paints the same people.
 *
 * The *mapping* is deliberately not shared. In a match you need to know friend from
 * enemy in a tenth of a second, so an actor paints every enemy the same red whatever
 * side they are on. In a lobby nobody is shooting anybody yet and the useful question
 * is which side each person is on, so the staging room paints both teams by their own
 * colour. Same palette, different question.
 */
export const TEAM_COLORS: Record<number, number> = {
  [TEAM_A]: 0xf2c14e,
  [TEAM_B]: 0x4f8fd0,
};
const ENEMY_COLOR = 0xd0574e;
export const NEUTRAL_COLOR = 0xb8b3c4;

/** Cached nameplate textures, keyed by the text drawn into them. */
const labelCache = new Map<string, THREE.Texture>();

/**
 * Text as a texture, outlined so it stays legible over anything.
 *
 * Exported because the lobby's staging room labels its characters too, and a
 * second implementation would drift: different weight, different outline, two
 * caches. Callers get a *shared* texture back — never mutate it, and never
 * dispose it.
 */
export function labelTexture(text: string, color: string): THREE.Texture {
  const key = `${text}\u0000${color}`;
  const hit = labelCache.get(key);
  if (hit) return hit;

  const pad = 10;
  const font = '600 34px "Encode Sans Semi Condensed", Verdana, sans-serif';
  const measure = document.createElement('canvas').getContext('2d')!;
  measure.font = font;
  const w = Math.ceil(measure.measureText(text).width) + pad * 2;
  const h = 52;

  const canvas = document.createElement('canvas');
  canvas.width = Math.max(2, w);
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.font = font;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // Outline first, fill second: readable against both sand and sky.
  ctx.lineWidth = 6;
  ctx.strokeStyle = 'rgba(0,0,0,0.78)';
  ctx.strokeText(text, canvas.width / 2, h / 2);
  ctx.fillStyle = color;
  ctx.fillText(text, canvas.width / 2, h / 2);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  labelCache.set(key, tex);
  return tex;
}

/* ─────────────────────────────────────────────────────────────────────────────
   The character
   ────────────────────────────────────────────────────────────────────────── */

/**
 * Joint positions, in metres above the feet of a standing player.
 *
 * Named and exported because two places pose this skeleton — the actor below and
 * the lobby's staging room — and a shoulder that sat at 1.4 in one and 1.38 in the
 * other would hold the weapon somewhere slightly different in the lobby than in
 * the match. That is the kind of difference a player registers as "it looks off"
 * without ever being able to point at it.
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
  bodyMat: THREE.MeshLambertMaterial;
  trimMat: THREE.MeshLambertMaterial;
  gearMat: THREE.MeshPhongMaterial;
  dispose(): void;
}

/**
 * Build one character out of boxes.
 *
 * No model files anywhere in this project, so a player is around sixty boxes in
 * three materials. The limbs are returned by name because posing is the caller's
 * job: an actor poses from network flags, the lobby poses an idle stance, and both
 * want the same body.
 *
 * Two invariants hold this together and both are easy to break by accident:
 *
 *  1. **Everything stays inside the collider envelope** the server traces against.
 *     Geometry that sticks out past the hitbox produces shots that visibly connect
 *     and deal no damage, which reads as broken netcode rather than as a modelling
 *     liberty. So the helmet lives *within* the head cube and is distinguished by
 *     material and cut, not by being bigger than the head.
 *  2. **Limb geometry is pre-translated so its pivot is the joint.** A child bolted
 *     to an arm therefore measures its local Y *down from the shoulder*, not from
 *     the limb's centre — which is what makes the whole rig animate for free when
 *     the caller rotates eight objects by name.
 */
export function buildCharacter(shadows: boolean): CharacterRig {
  const ownedGeo: THREE.BufferGeometry[] = [];

  const bodyMat = new THREE.MeshLambertMaterial({ color: NEUTRAL_COLOR });
  const trimMat = new THREE.MeshLambertMaterial({ color: 0x282c32 });
  const camoMat = new THREE.MeshLambertMaterial({ color: 0x3a4049 });
  const gearMat = new THREE.MeshPhongMaterial({
    color: 0x1a1d22,
    specular: 0x444c58,
    shininess: 32,
  });
  const lensMat = new THREE.MeshPhongMaterial({
    color: 0x102824,
    specular: 0x70ffd0,
    shininess: 110,
    transparent: true,
    opacity: 0.92,
  });
  const metalMat = new THREE.MeshPhongMaterial({
    color: 0x78828e,
    specular: 0xd8e0ea,
    shininess: 90,
  });

  const box = (sx: number, sy: number, sz: number, mat: THREE.Material) => {
    const g = new THREE.BoxGeometry(sx, sy, sz);
    ownedGeo.push(g);
    const m = new THREE.Mesh(g, mat);
    m.castShadow = shadows;
    m.receiveShadow = false;
    return m;
  };

  /** Bolts a detail box onto a parent limb — see invariant 2 above. */
  const detail = (
    parent: THREE.Object3D,
    sx: number,
    sy: number,
    sz: number,
    mat: THREE.Material,
    x: number,
    y: number,
    z: number,
    rx = 0,
    ry = 0,
    rz = 0,
  ): THREE.Mesh => {
    const m = box(sx, sy, sz, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    parent.add(m);
    return m;
  };

  // Proportions derive from the shared collider: 1.8 m tall, 0.8 m wide.
  const head = box(HEAD_BOX, HEAD_BOX, HEAD_BOX, trimMat); // Balaclava head base
  const visor = box(HEAD_BOX * 0.84, HEAD_BOX * 0.28, 0.024, lensMat);
  const torso = box(0.44, 0.56, 0.26, camoMat);
  const hips = box(0.38, 0.16, 0.24, trimMat);
  const armL = box(0.12, 0.5, 0.12, camoMat);
  const armR = box(0.12, 0.5, 0.12, camoMat);
  const legL = box(0.15, 0.72, 0.16, camoMat);
  const legR = box(0.15, 0.72, 0.16, camoMat);
  const gun = box(0.06, 0.08, 0.44, gearMat);

  armL.geometry.translate(0, -0.25, 0);
  armR.geometry.translate(0, -0.25, 0);
  legL.geometry.translate(0, -0.36, 0);
  legR.geometry.translate(0, -0.36, 0);

  // ── Tactical Helmet & Special-Ops Headwear ─────────────────────────────────
  const H = HEAD_BOX;
  // FAST High-Cut ballistic helmet shell
  detail(head, H * 1.02, H * 0.52, H * 1.02, gearMat, 0, H * 0.25, 0);
  // Team identifier helmet top crown & rear patch
  detail(head, H * 0.76, H * 0.12, H * 0.8, bodyMat, 0, H * 0.47, 0);
  detail(head, H * 0.4, H * 0.18, 0.02, bodyMat, 0, H * 0.15, H * 0.51);

  // Front NVG Mount Shroud + Wilcox Arm
  detail(head, 0.065, 0.07, 0.03, metalMat, 0, H * 0.28, -(H * 0.52));
  // Dual-Tube Night Vision Goggles (PVS-31) flipped up above visor
  detail(head, 0.045, 0.045, 0.075, gearMat, -0.05, H * 0.35, -(H * 0.55), 0.2);
  detail(head, 0.045, 0.045, 0.075, gearMat, 0.05, H * 0.35, -(H * 0.55), 0.2);
  detail(head, 0.035, 0.035, 0.008, lensMat, -0.05, H * 0.34, -(H * 0.58), 0.2);
  detail(head, 0.035, 0.035, 0.008, lensMat, 0.05, H * 0.34, -(H * 0.58), 0.2);

  // Tactical ARC rails & Comms Headset (ear cups left & right)
  detail(head, 0.02, 0.05, H * 0.65, gearMat, H * 0.52, H * 0.22, 0);
  detail(head, 0.02, 0.05, H * 0.65, gearMat, -(H * 0.52), H * 0.22, 0);
  detail(head, 0.04, 0.14, 0.09, gearMat, H * 0.5, H * 0.02, 0);
  detail(head, 0.04, 0.14, 0.09, gearMat, -(H * 0.5), H * 0.02, 0);

  // Helmet battery counterweight & IR strobe on back
  detail(head, 0.11, 0.07, 0.04, gearMat, 0, H * 0.18, H * 0.52);
  detail(head, 0.04, 0.03, 0.02, metalMat, 0, H * 0.22, H * 0.54);

  // ── Tactical Plate Carrier & Chest Rig ────────────────────────────────────
  // Front armor plate carrier
  detail(torso, 0.41, 0.34, 0.07, bodyMat, 0, 0.06, -0.155);
  // Triple rifle magazine pouches on chest
  detail(torso, 0.08, 0.13, 0.055, gearMat, -0.11, -0.06, -0.185);
  detail(torso, 0.08, 0.13, 0.055, gearMat, 0, -0.06, -0.185);
  detail(torso, 0.08, 0.13, 0.055, gearMat, 0.11, -0.06, -0.185);

  // MBITR Tactical Radio with Whip Antenna over left shoulder
  detail(torso, 0.075, 0.16, 0.06, gearMat, -0.18, 0.08, -0.15);
  detail(torso, 0.015, 0.32, 0.015, metalMat, -0.18, 0.28, -0.14, 0, 0, 0.1);

  // Tourniquet (CAT) & Padded Shoulder Straps
  detail(torso, 0.12, 0.04, 0.03, metalMat, 0.08, 0.15, -0.165);
  detail(torso, 0.07, 0.04, 0.24, gearMat, -0.15, 0.28, 0);
  detail(torso, 0.07, 0.04, 0.24, gearMat, 0.15, 0.28, 0);

  // Rear Assault Backpack & Hydration System
  detail(torso, 0.34, 0.36, 0.12, gearMat, 0, 0.04, 0.18);
  detail(torso, 0.28, 0.06, 0.04, bodyMat, 0, 0.18, 0.23); // Team ID pack strap

  // ── Tactical Duty Belt & Holsters ─────────────────────────────────────────
  detail(hips, 0.42, 0.07, 0.27, gearMat, 0, 0.02, 0);
  detail(hips, 0.08, 0.06, 0.03, metalMat, 0, 0.02, -0.14); // Metal belt buckle

  // Drop-leg Tactical Kydex Holster with Sidearm Pistol on right thigh
  detail(hips, 0.09, 0.16, 0.11, gearMat, -0.21, -0.11, 0);
  detail(hips, 0.04, 0.07, 0.14, metalMat, -0.22, -0.08, 0.01); // Molded pistol slide

  // Tactical IFAK (Medkit) pouch on left hip
  detail(hips, 0.1, 0.13, 0.09, gearMat, 0.21, -0.08, 0);

  // ── Arms & Operator Combat Gloves ─────────────────────────────────────────
  for (const arm of [armL, armR]) {
    // Shoulder rank/team patch
    detail(arm, 0.135, 0.11, 0.135, bodyMat, 0, -0.03, 0);
    // Hard tactical elbow pad
    detail(arm, 0.138, 0.1, 0.138, gearMat, 0, -0.26, 0);
    detail(arm, 0.11, 0.07, 0.03, metalMat, 0, -0.26, -0.06);
    // Combat Operator Glove with carbon knuckle protector
    detail(arm, 0.13, 0.12, 0.14, gearMat, 0, -0.47, 0);
    detail(arm, 0.11, 0.03, 0.07, metalMat, 0, -0.45, -0.04);
  }

  // ── Legs & G3 Knee Armor / Tactical Combat Boots ──────────────────────────
  for (const leg of [legL, legR]) {
    // Molded Crye G3 hard knee armor pad
    detail(leg, 0.165, 0.14, 0.06, gearMat, 0, -0.36, -0.085);
    detail(leg, 0.12, 0.09, 0.02, metalMat, 0, -0.36, -0.115);
    // Combat Assault Boot with ankle support & deep tread sole
    detail(leg, 0.168, 0.16, 0.21, gearMat, 0, -0.63, -0.02);
    detail(leg, 0.178, 0.04, 0.23, trimMat, 0, -0.73, -0.02);
  }

  // ── Third-Person Weapon (Rifle) ───────────────────────────────────────────
  // Optic sight on top with lens
  detail(gun, 0.045, 0.05, 0.09, gearMat, 0, 0.065, 0.02);
  detail(gun, 0.035, 0.035, 0.01, lensMat, 0, 0.065, 0.065);
  // PMAG Magazine under receiver
  detail(gun, 0.048, 0.14, 0.065, gearMat, 0, -0.1, 0.04, -0.15);
  // Multi-port compensator at muzzle
  detail(gun, 0.05, 0.05, 0.04, metalMat, 0, 0, -0.23);

  const group = new THREE.Group();
  group.add(head, torso, hips, armL, armR, legL, legR, gun);

  head.add(visor);
  visor.position.set(0, HEAD_BOX * 0.04, -(HEAD_BOX * 0.5 + 0.012));

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
      bodyMat.dispose();
      trimMat.dispose();
      camoMat.dispose();
      gearMat.dispose();
      lensMat.dispose();
      metalMat.dispose();
    },
  };
}

/**
 * Pose a weapon in a character's right hand, pointing where they are looking.
 *
 * Shared for the same reason `JOINT` is: the lobby holds the gun the player picked
 * in the menu, and it has to be held the way the match holds it or the staging room
 * is showing a different game.
 *
 * `pitch` is the shared convention — positive looks up — and both the arc the weapon
 * rides on and its own tilt follow it. The tilt used to be negated, which pointed the
 * muzzle at the floor whenever the player looked at the sky. Nobody noticed for a
 * while because the only place it showed was somebody else's silhouette at range;
 * the staging room puts the same body two metres from the camera.
 */
export function poseWeapon(rig: CharacterRig, weaponId: number, pitch: number, k: number): void {
  const w = weaponById(weaponId);
  const gunLen = Math.max(0.18, w.viz.bodyLen + w.viz.barrelLen);
  rig.gun.scale.set(1, 1, gunLen / 0.44);
  const reach = 0.34 + gunLen * 0.35;
  rig.gun.position.set(
    -JOINT.armX,
    JOINT.shoulderY * k - 0.22 + Math.sin(pitch) * reach,
    -Math.cos(pitch) * reach,
  );
  rig.gun.rotation.set(pitch, 0, 0);
  rig.gun.visible = w.fireMode !== 'melee';
}

/** One rendered player. */
class Actor {
  readonly id: number;
  readonly group: THREE.Group;

  team = 0;
  health = 100;
  weapon = 0;
  flags = 0;
  name = '';

  /** Interpolated render transform, read by the radar and by tracer aiming. */
  x = 0;
  y = 0;
  z = 0;
  yaw = 0;
  pitch = 0;
  speed = 0;
  dead = false;

  /** Rising edge helpers so the game can fire sounds off state changes. */
  private wasDead = false;
  private wasOnGround = true;
  private stepPhase = 0;
  private lastStepEmit = 0;
  /** Set when a step should play this frame; consumed by the caller. */
  stepThisFrame = false;
  landedThisFrame = false;

  private frames: Frame[] = [];
  private rig: CharacterRig;
  private head: THREE.Mesh;
  private torso: THREE.Mesh;
  private hips: THREE.Mesh;
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private gun: THREE.Mesh;
  private label: THREE.Sprite;
  private bodyMat: THREE.MeshLambertMaterial;
  private trimMat: THREE.MeshLambertMaterial;
  private gearMat: THREE.MeshPhongMaterial;
  private deadAt = 0;
  private labelText = '';
  private labelColor = '';

  constructor(id: number, shadows: boolean) {
    this.id = id;

    // The rig *is* this actor's group — not a child of one. A wrapper would add a
    // transform that `poseDead` would then have to reason about, since the death
    // collapse rotates the whole body about its feet.
    const rig = buildCharacter(shadows);
    this.rig = rig;
    this.group = rig.group;
    this.head = rig.head;
    this.torso = rig.torso;
    this.hips = rig.hips;
    this.armL = rig.armL;
    this.armR = rig.armR;
    this.legL = rig.legL;
    this.legR = rig.legR;
    this.gun = rig.gun;
    this.bodyMat = rig.bodyMat;
    this.trimMat = rig.trimMat;
    this.gearMat = rig.gearMat;

    const spriteMat = new THREE.SpriteMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      // Nameplates should not dim with distance fog.
      fog: false,
    });
    this.label = new THREE.Sprite(spriteMat);
    this.label.center.set(0.5, 0);
    this.group.add(this.label);
  }

  addTo(parent: THREE.Object3D): void {
    parent.add(this.group);
  }

  dispose(): void {
    this.rig.dispose();
    (this.label.material as THREE.SpriteMaterial).dispose();
  }

  /** Appends a snapshot frame, dropping anything out of order. */
  push(s: ActorState, t: number): void {
    const last = this.frames[this.frames.length - 1];
    if (last && t <= last.t) return;
    this.team = s.team;
    this.health = s.health;
    this.weapon = s.weapon;
    this.flags = s.flags;
    this.frames.push({
      t,
      x: s.x,
      y: s.y,
      z: s.z,
      yaw: s.yaw,
      pitch: s.pitch,
      speed: s.speed,
      flags: s.flags,
    });
    if (this.frames.length > HISTORY) this.frames.shift();
  }

  setName(name: string, myTeam: number, teamMode: boolean): void {
    const color = this.tint(myTeam, teamMode);
    const css = `#${color.toString(16).padStart(6, '0')}`;
    if (name === this.labelText && css === this.labelColor) return;
    this.labelText = name;
    this.labelColor = css;
    this.name = name;

    const mat = this.label.material as THREE.SpriteMaterial;
    if (!name) {
      mat.visible = false;
      return;
    }
    mat.visible = true;
    const tex = labelTexture(name, css);
    mat.map = tex;
    mat.needsUpdate = true;
    const img = tex.image as HTMLCanvasElement;
    // Scale so text height is a constant world size regardless of name length.
    const height = 0.19;
    this.label.scale.set((img.width / img.height) * height, height, 1);
  }

  private tint(myTeam: number, teamMode: boolean): number {
    if (!teamMode) return ENEMY_COLOR;
    if (this.team === myTeam) return TEAM_COLORS[this.team] ?? NEUTRAL_COLOR;
    return ENEMY_COLOR;
  }

  applyTint(myTeam: number, teamMode: boolean): void {
    this.bodyMat.color.setHex(this.tint(myTeam, teamMode));
  }

  /**
   * Interpolates to `renderTime` and updates the meshes.
   * Returns false if this actor has no usable data and should be hidden.
   */
  update(renderTime: number, dt: number, nowLocal: number): boolean {
    const n = this.frames.length;
    if (n === 0) return false;

    let x: number;
    let y: number;
    let z: number;
    let yaw: number;
    let pitch: number;
    let speed: number;
    let flags: number;

    const newest = this.frames[n - 1]!;
    const oldest = this.frames[0]!;

    if (renderTime >= newest.t) {
      // Ahead of the newest frame — the snapshot we need has not landed yet.
      // Hold the last known pose rather than extrapolating into a wall.
      x = newest.x;
      y = newest.y;
      z = newest.z;
      yaw = newest.yaw;
      pitch = newest.pitch;
      speed = newest.speed;
      flags = newest.flags;
    } else if (renderTime <= oldest.t) {
      // Behind everything we have: the actor just appeared, or we stalled.
      x = oldest.x;
      y = oldest.y;
      z = oldest.z;
      yaw = oldest.yaw;
      pitch = oldest.pitch;
      speed = oldest.speed;
      flags = oldest.flags;
    } else {
      // Find the bracketing pair. Walking backwards is fastest because
      // renderTime is almost always near the end of the buffer.
      let i = n - 1;
      while (i > 0 && this.frames[i - 1]!.t > renderTime) i--;
      const b = this.frames[i]!;
      const a = this.frames[i - 1]!;
      const span = b.t - a.t;

      if (span > MAX_INTERP_GAP_MS) {
        // A packet-loss hole. Interpolating across it would glide the player
        // through geometry in a straight line, which looks far worse than a cut.
        x = b.x;
        y = b.y;
        z = b.z;
        yaw = b.yaw;
        pitch = b.pitch;
        speed = b.speed;
        flags = b.flags;
      } else {
        const t = span > 0 ? (renderTime - a.t) / span : 1;
        x = a.x + (b.x - a.x) * t;
        y = a.y + (b.y - a.y) * t;
        z = a.z + (b.z - a.z) * t;
        // Angles must take the short way round or a player crossing ±π spins.
        yaw = lerpAngle(a.yaw, b.yaw, t);
        pitch = a.pitch + (b.pitch - a.pitch) * t;
        speed = a.speed + (b.speed - a.speed) * t;
        // Flags are discrete; blending them is meaningless, so take the newer.
        flags = b.flags;
      }
    }

    this.x = x;
    this.y = y;
    this.z = z;
    this.yaw = yaw;
    this.pitch = pitch;
    this.speed = speed;
    this.flags = flags;

    const dead = (flags & AF.DEAD) !== 0;
    this.landedThisFrame = false;
    this.stepThisFrame = false;

    if (dead && !this.wasDead) this.deadAt = nowLocal;
    this.wasDead = dead;
    this.dead = dead;

    if (dead) {
      const age = nowLocal - this.deadAt;
      if (age > CORPSE_MS) {
        this.group.visible = false;
        return true;
      }
      this.group.visible = true;
      this.poseDead(x, y, z, yaw, Math.min(1, age / 260));
      return true;
    }

    const onGround = (flags & AF.ON_GROUND) !== 0;
    if (onGround && !this.wasOnGround) this.landedThisFrame = true;
    this.wasOnGround = onGround;

    this.group.visible = true;
    this.poseAlive(x, y, z, yaw, pitch, speed, flags, dt, onGround, nowLocal);
    return true;
  }

  private poseAlive(
    x: number,
    y: number,
    z: number,
    yaw: number,
    pitch: number,
    speed: number,
    flags: number,
    dt: number,
    onGround: boolean,
    nowLocal: number,
  ): void {
    const crouch = (flags & AF.CROUCH) !== 0;
    const height = crouch ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
    const eye = crouch ? EYE_HEIGHT_CROUCH : EYE_HEIGHT;
    // Scale the whole skeleton when crouching instead of re-authoring poses.
    const k = height / PLAYER_HEIGHT;

    this.group.position.set(x, y, z);
    this.group.rotation.y = yaw;

    // Gait: phase advances with distance covered, not with time, so the legs
    // never scissor in place and never skate at speed.
    if (onGround && speed > 0.4) {
      this.stepPhase += speed * dt * 2.4;
      // Emit a footstep at each extreme of the swing.
      const halfCycle = Math.floor(this.stepPhase / Math.PI);
      if (halfCycle !== this.lastStepEmit) {
        this.lastStepEmit = halfCycle;
        this.stepThisFrame = true;
      }
    } else {
      // Ease back to a neutral stance rather than freezing mid-stride.
      this.stepPhase += (0 - (this.stepPhase % (Math.PI * 2))) * Math.min(1, dt * 8);
    }

    const swing = onGround && speed > 0.4 ? Math.sin(this.stepPhase) : 0;
    const amp = Math.min(0.62, speed * 0.085);
    // Breathing/idle sway keeps a standing player from looking like a statue.
    const idle = Math.sin(nowLocal * 0.0016) * 0.012;

    const torsoY = (JOINT.torsoY + idle) * k;
    this.torso.position.set(0, torsoY, 0);
    this.torso.scale.set(1, k, 1);
    this.hips.position.set(0, JOINT.hipsY * k, 0);

    const headY = (height - HEAD_BOX * 0.5) + idle * 0.5;
    this.head.position.set(0, headY, 0);
    // Head pitch is clamped short of the collider so it never pokes out. The visor
    // is parented to the head, so it comes along for free.
    this.head.rotation.x = Math.max(-0.9, Math.min(0.9, pitch)) * 0.75;

    const shoulderY = JOINT.shoulderY * k;
    const hipY = JOINT.legHipY * k;

    this.legL.position.set(-JOINT.legX, hipY, 0);
    this.legR.position.set(JOINT.legX, hipY, 0);
    this.legL.rotation.x = swing * amp;
    this.legR.rotation.x = -swing * amp;
    this.legL.scale.set(1, k, 1);
    this.legR.scale.set(1, k, 1);

    // The weapon arm stays forward and level; only the free arm swings.
    //
    // Signs matter and were wrong here for a long time. The arms hang along -Y and
    // the character faces -Z, so a *positive* `rotation.x` is what swings a hand
    // forward (verified against Three.js rather than reasoned about: at +1.15 rad
    // the glove lands at z = -0.45, in front; at -1.15 it lands at z = +0.45,
    // behind the player's own back). Every arm angle below therefore reads as
    // "how far forward", and a bigger number is a hand held higher.
    const ads = (flags & AF.ADS) !== 0;
    this.armR.position.set(-JOINT.armX, shoulderY, 0);
    this.armR.rotation.x = 1.15 + (ads ? 0.28 : 0) + Math.max(-0.8, Math.min(0.8, pitch)) * 0.5;
    this.armL.position.set(JOINT.armX, shoulderY, 0);
    // The free arm swings through the gait, so this one legitimately goes negative:
    // half a stride is an arm travelling behind the hip.
    this.armL.rotation.x = ads ? 1.0 : 0.35 + swing * amp * 0.85;
    this.armL.scale.set(1, k, 1);
    this.armR.scale.set(1, k, 1);

    // Gun rides in front of the right hand, aligned with the view direction.
    poseWeapon(this.rig, this.weapon, pitch, k);

    this.label.position.set(0, height + 0.22, 0);
  }

  /**
   * Death pose: rotate the whole body onto its side about the base and drop it
   * to the floor. Not a ragdoll — a ragdoll needs the server to agree on the
   * final resting place or bodies desync between clients — but it reads as one.
   */
  private poseDead(x: number, y: number, z: number, yaw: number, t: number): void {
    const ease = 1 - (1 - t) * (1 - t);
    this.group.position.set(x, y + 0.02, z);
    this.group.rotation.set(0, yaw, 0);

    const fall = ease * (Math.PI * 0.5);
    this.torso.rotation.set(0, 0, 0);
    this.torso.position.set(0, JOINT.torsoY, 0);
    this.torso.scale.set(1, 1, 1);
    this.hips.position.set(0, JOINT.hipsY, 0);

    // Collapse by rotating the group about X — the base stays pinned to the
    // ground so the body never sinks through the floor.
    this.group.rotation.x = -fall;
    this.group.position.y = y + 0.02 + Math.sin(fall) * 0.16;

    this.head.position.set(0, PLAYER_HEIGHT - HEAD_BOX * 0.5, 0);
    this.head.rotation.x = 0.25;
    this.legL.position.set(-JOINT.legX, JOINT.legHipY, 0);
    this.legR.position.set(JOINT.legX, JOINT.legHipY, 0);
    this.legL.rotation.x = -0.2;
    this.legR.rotation.x = 0.12;
    this.legL.scale.set(1, 1, 1);
    this.legR.scale.set(1, 1, 1);
    this.armL.position.set(JOINT.armX, JOINT.shoulderY, 0);
    this.armR.position.set(-JOINT.armX, JOINT.shoulderY, 0);
    this.armL.rotation.x = 0.5;
    this.armR.rotation.x = 0.7;
    this.armL.scale.set(1, 1, 1);
    this.armR.scale.set(1, 1, 1);
    this.gun.visible = false;
    (this.label.material as THREE.SpriteMaterial).visible = false;
  }

  /** Restores the nameplate after a respawn. */
  showLabel(): void {
    const mat = this.label.material as THREE.SpriteMaterial;
    if (this.labelText) mat.visible = true;
  }
}

export class ActorPool {
  readonly root = new THREE.Group();
  private actors = new Map<number, Actor>();
  private names = new Map<number, string>();
  private shadows: boolean;
  private myTeam = 0;
  private teamMode = false;
  /** Ids seen in the newest snapshot, used to retire everyone else. */
  private seen = new Set<number>();

  constructor(shadows: boolean) {
    this.shadows = shadows;
  }

  setShadows(on: boolean): void {
    this.shadows = on;
  }

  setContext(myTeam: number, teamMode: boolean): void {
    if (myTeam === this.myTeam && teamMode === this.teamMode) return;
    this.myTeam = myTeam;
    this.teamMode = teamMode;
    for (const a of this.actors.values()) {
      a.applyTint(myTeam, teamMode);
      a.setName(this.names.get(a.id) ?? '', myTeam, teamMode);
    }
  }

  /** Names come from the roster message, not from snapshots. */
  setNames(entries: ReadonlyArray<{ id: number; name: string }>): void {
    for (const e of entries) {
      this.names.set(e.id, e.name);
      const a = this.actors.get(e.id);
      if (a) a.setName(e.name, this.myTeam, this.teamMode);
    }
  }

  /** Feeds one snapshot's actor list. `selfId` is skipped — we predict that one. */
  ingest(actors: readonly ActorState[], serverTime: number, selfId: number): void {
    this.seen.clear();
    for (const s of actors) {
      if (s.id === selfId) continue;
      this.seen.add(s.id);
      let a = this.actors.get(s.id);
      if (!a) {
        a = new Actor(s.id, this.shadows);
        a.addTo(this.root);
        a.setName(this.names.get(s.id) ?? '', this.myTeam, this.teamMode);
        this.actors.set(s.id, a);
      }
      a.push(s, serverTime);
      a.applyTint(this.myTeam, this.teamMode);
    }

    // Retire anyone the server stopped sending. Deferred to a second pass so a
    // player is never removed and re-created inside the same snapshot.
    for (const [id, a] of this.actors) {
      if (this.seen.has(id)) continue;
      a.dispose();
      this.actors.delete(id);
    }
  }

  /** Advances every actor to the render clock. */
  update(serverNow: number, dt: number, nowLocal: number): void {
    const renderTime = serverNow - INTERP_DELAY_MS;
    for (const a of this.actors.values()) {
      if (!a.update(renderTime, dt, nowLocal)) a.group.visible = false;
    }
  }

  get(id: number): Actor | undefined {
    return this.actors.get(id);
  }

  nameOf(id: number): string {
    return this.names.get(id) ?? '';
  }

  /** Live actors, for the radar and for spatial footstep audio. */
  forEach(fn: (a: Actor) => void): void {
    for (const a of this.actors.values()) fn(a);
  }

  get count(): number {
    return this.actors.size;
  }

  clear(): void {
    for (const a of this.actors.values()) a.dispose();
    this.actors.clear();
    this.names.clear();
  }
}

export type { Actor };
