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

const TEAM_COLORS: Record<number, number> = {
  [TEAM_A]: 0xf2c14e,
  [TEAM_B]: 0x4f8fd0,
};
const ENEMY_COLOR = 0xd0574e;
const NEUTRAL_COLOR = 0xb8b3c4;

/** Cached nameplate textures, keyed by the text drawn into them. */
const labelCache = new Map<string, THREE.Texture>();

function labelTexture(text: string, color: string): THREE.Texture {
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

/** One rendered player. */
class Actor {
  readonly id: number;
  readonly group = new THREE.Group();

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
  private head: THREE.Mesh;
  private torso: THREE.Mesh;
  private hips: THREE.Mesh;
  private armL: THREE.Mesh;
  private armR: THREE.Mesh;
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private gun: THREE.Mesh;
  private visor: THREE.Mesh;
  private label: THREE.Sprite;
  private bodyMat: THREE.MeshLambertMaterial;
  private trimMat: THREE.MeshLambertMaterial;
  private gearMat: THREE.MeshPhongMaterial;
  private deadAt = 0;
  private labelText = '';
  private labelColor = '';
  private ownedGeo: THREE.BufferGeometry[] = [];

  constructor(id: number, shadows: boolean) {
    this.id = id;

    this.bodyMat = new THREE.MeshLambertMaterial({ color: NEUTRAL_COLOR });
    this.trimMat = new THREE.MeshLambertMaterial({ color: 0x2f3238 });
    // Gear is Phong with a low shine so webbing, helmets and boots separate from
    // the flat team colour. The team surfaces stay Lambert on purpose: a specular
    // roll across the one colour that tells you whether to shoot would be a
    // readability regression dressed up as fidelity.
    this.gearMat = new THREE.MeshPhongMaterial({
      color: 0x23262b,
      specular: 0x3c4148,
      shininess: 26,
    });

    const box = (sx: number, sy: number, sz: number, mat: THREE.Material) => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      this.ownedGeo.push(g);
      const m = new THREE.Mesh(g, mat);
      m.castShadow = shadows;
      m.receiveShadow = false;
      return m;
    };

    /**
     * Bolts a detail box onto a parent limb.
     *
     * Parenting rather than adding to the group is what keeps this free: the
     * crouch scale, the gait swing and the death collapse are all applied to the
     * eight limbs by name in `poseAlive`/`poseDead`, and children inherit every
     * one of them without a line of animation code.
     *
     * Note that limb geometry is pre-translated so its pivot is the joint, so a
     * child's local Y is measured *down from the shoulder or hip*, not from the
     * limb's centre.
     */
    const detail = (
      parent: THREE.Object3D,
      sx: number,
      sy: number,
      sz: number,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
    ): THREE.Mesh => {
      const m = box(sx, sy, sz, mat);
      m.position.set(x, y, z);
      parent.add(m);
      return m;
    };

    // Proportions derive from the shared collider: 1.8 m tall, 0.8 m wide.
    // Head sits at the crown so the visible head matches HEAD_BOX exactly.
    this.head = box(HEAD_BOX, HEAD_BOX, HEAD_BOX, this.bodyMat);
    this.visor = box(HEAD_BOX * 0.82, HEAD_BOX * 0.3, 0.02, this.trimMat);
    this.torso = box(0.44, 0.56, 0.26, this.bodyMat);
    this.hips = box(0.38, 0.16, 0.24, this.trimMat);
    this.armL = box(0.12, 0.5, 0.12, this.trimMat);
    this.armR = box(0.12, 0.5, 0.12, this.trimMat);
    this.legL = box(0.15, 0.72, 0.16, this.trimMat);
    this.legR = box(0.15, 0.72, 0.16, this.trimMat);
    this.gun = box(0.07, 0.09, 0.44, this.trimMat);

    // Pivot the limbs at the shoulder/hip by offsetting the mesh inside a group
    // — rotating a centred box would swing it from the middle.
    this.armL.geometry.translate(0, -0.25, 0);
    this.armR.geometry.translate(0, -0.25, 0);
    this.legL.geometry.translate(0, -0.36, 0);
    this.legR.geometry.translate(0, -0.36, 0);

    // ── Gear ────────────────────────────────────────────────────────────────
    // Every piece below stays inside the collider envelope the server traces
    // against. That is the hard constraint on this whole section: geometry that
    // sticks out past the hitbox produces shots that visibly connect and deal no
    // damage, which reads as netcode failure rather than as a modelling liberty.
    // So the helmet lives *within* the head cube and is distinguished by material
    // and cut, not by being bigger than the head.
    const H = HEAD_BOX;
    detail(this.head, H * 1.0, H * 0.5, H * 1.0, this.gearMat, 0, H * 0.24, 0);
    // Crown plate in team colour — the surface most often seen from above and
    // across the map, so it is the one that carries the identification.
    detail(this.head, H * 0.72, H * 0.1, H * 0.78, this.bodyMat, 0, H * 0.46, 0);
    // Brim over the visor, ear cups either side, mandible below.
    detail(this.head, H * 0.94, H * 0.1, H * 0.16, this.gearMat, 0, H * 0.08, -H * 0.42);
    detail(this.head, H * 0.12, H * 0.28, H * 0.34, this.gearMat, H * 0.44, -H * 0.04, 0);
    detail(this.head, H * 0.12, H * 0.28, H * 0.34, this.gearMat, -H * 0.44, -H * 0.04, 0);
    detail(this.head, H * 0.54, H * 0.22, H * 0.16, this.gearMat, 0, -H * 0.3, -H * 0.42);

    // Torso: plate carrier over the chest, straps, pouches, shoulders, pack.
    detail(this.torso, 0.4, 0.3, 0.06, this.bodyMat, 0, 0.06, -0.15);
    detail(this.torso, 0.05, 0.34, 0.02, this.gearMat, 0.13, 0.1, -0.175);
    detail(this.torso, 0.05, 0.34, 0.02, this.gearMat, -0.13, 0.1, -0.175);
    detail(this.torso, 0.09, 0.08, 0.05, this.gearMat, 0.1, -0.15, -0.16);
    detail(this.torso, 0.09, 0.08, 0.05, this.gearMat, -0.1, -0.15, -0.16);
    detail(this.torso, 0.34, 0.07, 0.24, this.trimMat, 0, 0.3, 0);
    detail(this.torso, 0.13, 0.12, 0.22, this.bodyMat, 0.235, 0.2, 0);
    detail(this.torso, 0.13, 0.12, 0.22, this.bodyMat, -0.235, 0.2, 0);
    detail(this.torso, 0.36, 0.26, 0.05, this.trimMat, 0, 0.04, 0.145);
    detail(this.torso, 0.26, 0.28, 0.12, this.gearMat, 0, -0.04, 0.2);
    detail(this.torso, 0.28, 0.04, 0.13, this.trimMat, 0, 0.08, 0.205);

    // Hips: belt, buckle, thigh rig.
    detail(this.hips, 0.4, 0.06, 0.26, this.gearMat, 0, 0.02, 0);
    detail(this.hips, 0.07, 0.05, 0.02, this.bodyMat, 0, 0.02, -0.135);
    detail(this.hips, 0.1, 0.13, 0.08, this.gearMat, -0.19, -0.07, 0.01);

    // Arms: shoulder cap, elbow pad, wrist band, glove. The cap is team-coloured
    // because the shoulder is what shows first around a corner.
    for (const arm of [this.armL, this.armR]) {
      detail(arm, 0.135, 0.1, 0.135, this.bodyMat, 0, -0.02, 0);
      detail(arm, 0.13, 0.09, 0.13, this.gearMat, 0, -0.26, 0);
      detail(arm, 0.135, 0.03, 0.135, this.bodyMat, 0, -0.42, 0);
      detail(arm, 0.125, 0.11, 0.14, this.gearMat, 0, -0.49, -0.01);
    }

    // Legs: knee pad, boot, sole.
    for (const leg of [this.legL, this.legR]) {
      detail(leg, 0.16, 0.12, 0.045, this.gearMat, 0, -0.36, -0.085);
      detail(leg, 0.17, 0.15, 0.21, this.gearMat, 0, -0.645, -0.025);
      detail(leg, 0.18, 0.035, 0.22, this.trimMat, 0, -0.735, -0.025);
    }

    // Remote weapon: a bar reads as a bar at fifty metres. A magazine under it
    // and an optic on top give it enough silhouette to be recognisable as a gun.
    detail(this.gun, 0.05, 0.13, 0.055, this.gearMat, 0, -0.1, 0.05);
    detail(this.gun, 0.04, 0.045, 0.085, this.gearMat, 0, 0.066, 0.015);

    this.group.add(
      this.head,
      this.visor,
      this.torso,
      this.hips,
      this.armL,
      this.armR,
      this.legL,
      this.legR,
      this.gun,
    );

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
    this.group.parent?.remove(this.group);
    for (const g of this.ownedGeo) g.dispose();
    this.ownedGeo.length = 0;
    this.bodyMat.dispose();
    this.trimMat.dispose();
    this.gearMat.dispose();
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

    const torsoY = (0.86 + idle) * k;
    this.torso.position.set(0, torsoY, 0);
    this.torso.scale.set(1, k, 1);
    this.hips.position.set(0, 0.76 * k, 0);

    const headY = (height - HEAD_BOX * 0.5) + idle * 0.5;
    this.head.position.set(0, headY, 0);
    // Head pitch is clamped short of the collider so it never pokes out.
    this.head.rotation.x = Math.max(-0.9, Math.min(0.9, pitch)) * 0.75;
    this.visor.position.set(0, headY + HEAD_BOX * 0.06, -(HEAD_BOX * 0.5 + 0.012));
    this.visor.rotation.x = this.head.rotation.x;

    const shoulderY = 1.4 * k;
    const hipY = 0.78 * k;

    this.legL.position.set(-0.11, hipY, 0);
    this.legR.position.set(0.11, hipY, 0);
    this.legL.rotation.x = swing * amp;
    this.legR.rotation.x = -swing * amp;
    this.legL.scale.set(1, k, 1);
    this.legR.scale.set(1, k, 1);

    // The weapon arm stays forward and level; only the free arm swings.
    const ads = (flags & AF.ADS) !== 0;
    this.armR.position.set(-0.28, shoulderY, 0);
    this.armR.rotation.x = -1.15 - (ads ? 0.28 : 0) - Math.max(-0.8, Math.min(0.8, pitch)) * 0.5;
    this.armL.position.set(0.28, shoulderY, 0);
    this.armL.rotation.x = ads ? -1.0 : -0.35 - swing * amp * 0.85;
    this.armL.scale.set(1, k, 1);
    this.armR.scale.set(1, k, 1);

    // Gun rides in front of the right hand, aligned with the view direction.
    const w = weaponById(this.weapon);
    const gunLen = Math.max(0.18, w.viz.bodyLen + w.viz.barrelLen);
    this.gun.scale.set(1, 1, gunLen / 0.44);
    const reach = 0.34 + gunLen * 0.35;
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    this.gun.position.set(-0.28, shoulderY - 0.22 + sp * reach, -cp * reach);
    this.gun.rotation.set(-pitch, 0, 0);
    this.gun.visible = w.fireMode !== 'melee';

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
    this.torso.position.set(0, 0.86, 0);
    this.torso.scale.set(1, 1, 1);
    this.hips.position.set(0, 0.76, 0);

    // Collapse by rotating the group about X — the base stays pinned to the
    // ground so the body never sinks through the floor.
    this.group.rotation.x = -fall;
    this.group.position.y = y + 0.02 + Math.sin(fall) * 0.16;

    this.head.position.set(0, PLAYER_HEIGHT - HEAD_BOX * 0.5, 0);
    this.head.rotation.x = 0.25;
    this.visor.position.set(0, PLAYER_HEIGHT - HEAD_BOX * 0.44, -(HEAD_BOX * 0.5 + 0.012));
    this.visor.rotation.x = 0.25;
    this.legL.position.set(-0.11, 0.78, 0);
    this.legR.position.set(0.11, 0.78, 0);
    this.legL.rotation.x = -0.2;
    this.legR.rotation.x = 0.12;
    this.legL.scale.set(1, 1, 1);
    this.legR.scale.set(1, 1, 1);
    this.armL.position.set(0.28, 1.4, 0);
    this.armR.position.set(-0.28, 1.4, 0);
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
