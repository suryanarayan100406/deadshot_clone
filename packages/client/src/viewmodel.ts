/**
 * First-person view model.
 *
 * Rendered into its own scene with its own camera, composited over the world by
 * the renderer with the depth buffer cleared in between. That separation is not
 * cosmetic: a gun parented to the world camera would clip through every wall the
 * player walks up to, because it physically occupies a metre of space in front
 * of the eye. Its own pass means the near plane can be a few centimetres and the
 * geometry can never intersect the level.
 *
 * The gun itself is generated from `WeaponDef.viz` — a handful of proportions —
 * so a new weapon needs numbers, not a model. Every animation is procedural:
 *
 *   • **Sway** trails the mouse. The gun lags the camera slightly, which is what
 *     makes a mouse turn feel weighty rather than instant.
 *   • **Bob** is driven by a phase accumulator that advances with distance
 *     travelled, in a figure-eight, so the hands rise and fall in step with the
 *     legs instead of oscillating on a wall-clock timer.
 *   • **Recoil** is a spring: an impulse per shot, then critically-ish damped
 *     recovery. Sustained fire therefore climbs and settles the way a real
 *     recoil pattern does, with no keyframes.
 *   • **Reload / switch** are short scripted curves driven off the server's own
 *     timers, so the animation always ends exactly when the weapon is usable.
 */

import * as THREE from 'three';
import { MELEE_SWING, clamp, cycleTime, weaponById, type WeaponDef } from '@oneshot/shared';

/** Resting offset from the eye: right, down, forward. */
const HIP_POS = new THREE.Vector3(0.19, -0.17, -0.34);
/** Where the gun sits when aiming — centred and pulled in. */
const ADS_POS = new THREE.Vector3(0.0, -0.082, -0.22);

const BOB_AMOUNT = 0.014;
const SWAY_AMOUNT = 0.055;
const SWAY_RATE = 11;

/**
 * Which part of the weapon moves when it cycles, and therefore which stroke
 * `update` plays. Derived from `WeaponDef.fireMode` once, in `build`, so the
 * per-frame path is a switch over three shapes rather than a chain of fire-mode
 * string comparisons — and so a fire mode added later gets `none`, which draws a
 * static weapon instead of throwing.
 */
type ActionKind = 'none' | 'slide' | 'pump' | 'bolt';

/* ─────────────────────────────────────────────────────────────────────────────
   Ejected cases

   Brass tumbling out of the port is one of the cheapest things a shooter can do
   to make a gun read as a mechanism rather than as a hitscan emitter, and it is
   the part of firing the eye tracks when the flash is over.

   They live in the view model's own scene rather than in the world, which means
   they can never clip through level geometry and never need a collision test —
   they simply tumble out of frame and are recycled. A dozen small cylinders with
   Euler integration on the CPU is nothing; this does not need the GPU path the
   world's sparks use.
   ────────────────────────────────────────────────────────────────────────── */

const SHELL_COUNT = 12;
const SHELL_LIFE = 0.85;

class ShellPool {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh[] = [];
  private vel: THREE.Vector3[] = [];
  private spin: THREE.Vector3[] = [];
  private life = new Float32Array(SHELL_COUNT);
  private next = 0;
  private geo: THREE.CylinderGeometry;
  private brass: THREE.MeshPhongMaterial;
  private hull: THREE.MeshPhongMaterial;

  constructor() {
    // A unit cylinder, scaled per shell, so every calibre shares one geometry.
    this.geo = new THREE.CylinderGeometry(0.5, 0.5, 1, 7, 1);
    this.brass = new THREE.MeshPhongMaterial({
      color: 0xc79a3e,
      specular: 0xfff0c0,
      shininess: 90,
    });
    // A shotgun throws a plastic hull, not a brass case. Different colour is the
    // whole tell, and it is the one gun whose ejection you actually watch,
    // because the pump gives you time to.
    this.hull = new THREE.MeshPhongMaterial({
      color: 0x9c3630,
      specular: 0xd8a0a0,
      shininess: 40,
    });

    for (let i = 0; i < SHELL_COUNT; i++) {
      const m = new THREE.Mesh(this.geo, this.brass);
      m.visible = false;
      this.group.add(m);
      this.mesh.push(m);
      this.vel.push(new THREE.Vector3());
      this.spin.push(new THREE.Vector3());
    }
  }

  /**
   * @param at    spawn point, in the view model scene's space
   * @param basis the gun's world rotation, so a case leaves the port sideways
   *              relative to the weapon rather than sideways relative to the screen
   */
  spawn(at: THREE.Vector3, basis: THREE.Quaternion, calibre: number, shotgun: boolean): void {
    const i = this.next;
    this.next = (this.next + 1) % SHELL_COUNT;
    const m = this.mesh[i]!;

    m.material = shotgun ? this.hull : this.brass;
    // Length is roughly four bore diameters for a rifle case, less for a hull.
    const r = calibre * (shotgun ? 1.25 : 1.0);
    m.scale.set(r * 2.1, r * (shotgun ? 5.2 : 4.4), r * 2.1);
    m.position.copy(at);
    m.rotation.set(Math.random() * 3, Math.random() * 3, Math.random() * 3);
    m.visible = true;

    // Out to the right and up, with scatter, then rotated into the gun's frame.
    this.vel[i]!
      .set(1.25 + Math.random() * 0.5, 0.85 + Math.random() * 0.45, 0.35 + Math.random() * 0.3)
      .applyQuaternion(basis);
    this.spin[i]!.set(
      (Math.random() * 2 - 1) * 22,
      (Math.random() * 2 - 1) * 16,
      (Math.random() * 2 - 1) * 22,
    );
    this.life[i] = SHELL_LIFE;
  }

  update(dt: number): void {
    for (let i = 0; i < SHELL_COUNT; i++) {
      const l = this.life[i]!;
      if (l <= 0) continue;
      const next = l - dt;
      this.life[i] = next > 0 ? next : 0;
      const m = this.mesh[i]!;
      if (next <= 0) {
        m.visible = false;
        continue;
      }
      const v = this.vel[i]!;
      // Reduced gravity. Real 9.8 drops a case out of a 70° frustum in about
      // three frames; this keeps the arc on screen long enough to be seen, which
      // is the entire point of drawing it.
      v.y -= 5.4 * dt;
      m.position.addScaledVector(v, dt);
      const s = this.spin[i]!;
      m.rotation.x += s.x * dt;
      m.rotation.y += s.y * dt;
      m.rotation.z += s.z * dt;
    }
  }

  clear(): void {
    for (let i = 0; i < SHELL_COUNT; i++) {
      this.life[i] = 0;
      this.mesh[i]!.visible = false;
    }
  }

  dispose(): void {
    this.geo.dispose();
    this.brass.dispose();
    this.hull.dispose();
  }
}

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;

  /** 0 = hip, 1 = fully aimed. Read by the HUD and the world camera for FOV. */
  adsFactor = 0;
  /** Extra camera pitch/yaw the recoil spring is currently demanding, radians. */
  recoilPitch = 0;
  recoilYaw = 0;

  private root = new THREE.Group();
  private gunGroup = new THREE.Group();
  /**
   * The parts that move relative to the weapon rather than with it: the
   * magazine and its floor plate, and whichever part identifies the action.
   *
   * Created once, added to `gunGroup` once, and never re-created — `build`
   * re-parents the relevant meshes into them and resets their transforms. The
   * split is what keeps the animation code legible three months from now:
   * `root` is the hands and the camera (sway, bob, kick, the reload dip),
   * `gunGroup` is the arm (the knife swing), and these two are the mechanism.
   * Anything animating a moving part belongs here; anything animating where the
   * player is holding the gun belongs further out.
   */
  private magGroup = new THREE.Group();
  private actionGroup = new THREE.Group();
  private muzzle = new THREE.Object3D();
  private flash: THREE.Mesh;
  private coreMat: THREE.MeshBasicMaterial;
  private flashLight: THREE.PointLight;
  /** Count of geometries/materials shared across weapons — see `disposeParts`. */
  private sharedGeo = 0;
  private sharedMat = 0;

  private shells = new ShellPool();
  /** Where the case leaves this weapon, and how big it is. Set by `build`. */
  private shellPort = new THREE.Vector3();
  private shellCalibre = 0.012;
  /** Whether this weapon ejects at all, and whether it throws a plastic hull. */
  private ejects = false;
  private shotgunHull = false;
  private ejectPos = new THREE.Vector3();
  private ejectRot = new THREE.Quaternion();
  /** Per-weapon flash size and duration. Set by `build`. */
  private flashScale = 1;
  private flashDur = 42;

  private weapon: WeaponDef;
  private parts: THREE.Object3D[] = [];
  private geometries: THREE.BufferGeometry[] = [];
  private materials: THREE.Material[] = [];

  /** Spring state for the kick. */
  private kickZ = 0;
  private kickZVel = 0;
  private kickPitch = 0;
  private kickPitchVel = 0;
  private kickYaw = 0;
  private kickYawVel = 0;
  private kickRoll = 0;

  private swayX = 0;
  private swayY = 0;
  private bobPhase = 0;
  private bobX = 0;
  private bobY = 0;
  private landDip = 0;

  private reloadT = 0;
  private reloadDur = 0;
  private switchT = 0;
  private switchDur = 0;
  private meleeT = 0;

  /**
   * The cycling action: one stroke per shot, plus a longer one at the end of a
   * reload for the weapons that still have to chamber a round.
   *
   * `actionDur` is clamped inside the weapon's cycle time for the same reason
   * the flash and the gunshot are — a held trigger that restarts the stroke
   * before it has returned leaves the part hanging halfway out, which reads as a
   * broken model rather than as a fast weapon.
   */
  private actionT = 0;
  private actionDur = 0.09;
  private actionKind: ActionKind = 'none';
  /** How far the moving part travels, metres. Set by `build` from the weapon. */
  private actionTravel = 0;
  /** True when this weapon has a detachable magazine to drop and replace. */
  private hasMag = false;
  /** Shells fed one at a time during a reload; 0 for a magazine weapon. */
  private tubeShells = 0;

  private flashUntil = 0;
  private visible = true;
  private baseFov: number;

  constructor(fov: number) {
    this.baseFov = fov;
    // A narrow FOV on the view model keeps the gun from distorting at the edges
    // while the world camera stays wide.
    this.camera = new THREE.PerspectiveCamera(Math.min(70, fov * 0.86), 1, 0.01, 12);
    this.scene.add(this.root);
    this.root.add(this.gunGroup);
    this.gunGroup.add(this.muzzle);
    // Added here and never removed: `build` re-parents meshes into them and
    // resets their transforms, so a weapon swap cannot orphan them.
    this.gunGroup.add(this.magGroup);
    this.gunGroup.add(this.actionGroup);

    // Lighting for the view model is fixed and flattering — it never changes
    // with the world, so the weapon is always readable.
    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(-0.6, 0.9, 0.5);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc0e8, 0.6);
    rim.position.set(0.8, -0.2, -0.7);
    this.scene.add(rim);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.42));

    // Muzzle flash: three additive layers under one node, so a single random
    // roll and scale per shot varies the whole thing at once.
    //
    //   • a warm bloom cross — two quads at 90°, which reads from any angle
    //     without needing a billboard shader
    //   • a hot near-white core cross rotated 45° off the bloom, so the two
    //     together make an eight-point star instead of a plus sign
    //   • a short cone of burning gas down the bore, which is what gives the
    //     flash depth rather than leaving it a decal pinned to the muzzle
    const flashGeo = new THREE.PlaneGeometry(0.15, 0.15);
    const flashMat = new THREE.MeshBasicMaterial({
      color: 0xffe6a0,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.flash = new THREE.Mesh(flashGeo, flashMat);
    const flashB = new THREE.Mesh(flashGeo, flashMat);
    flashB.rotation.z = Math.PI / 2;
    this.flash.add(flashB);
    // Clear of the barrel tip, so the depth test against the barrel itself does
    // not eat the rear half of every quad.
    this.flash.position.z = -0.014;

    const coreGeo = new THREE.PlaneGeometry(0.058, 0.058);
    this.coreMat = new THREE.MeshBasicMaterial({
      color: 0xfff6df,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    const core = new THREE.Mesh(coreGeo, this.coreMat);
    core.rotation.z = Math.PI / 4;
    const coreB = new THREE.Mesh(coreGeo, this.coreMat);
    coreB.rotation.z = Math.PI / 2;
    core.add(coreB);
    this.flash.add(core);

    // Open-ended, so the base is not a bright disc hanging in mid-air. Rotating
    // −90° about X takes the cone's +Y apex to −Z, i.e. straight down the barrel.
    const gasGeo = new THREE.ConeGeometry(0.028, 0.15, 9, 1, true);
    const gas = new THREE.Mesh(gasGeo, this.coreMat);
    gas.rotation.x = -Math.PI / 2;
    gas.position.z = -0.075;
    this.flash.add(gas);

    this.muzzle.add(this.flash);
    this.geometries.push(flashGeo, coreGeo, gasGeo);
    this.materials.push(flashMat, this.coreMat);
    // Everything pushed so far is shared across weapons and outlives a rebuild.
    this.sharedGeo = this.geometries.length;
    this.sharedMat = this.materials.length;

    this.flashLight = new THREE.PointLight(0xffd894, 0, 6, 2);
    this.muzzle.add(this.flashLight);

    this.scene.add(this.shells.group);

    this.weapon = weaponById(0);
    this.build(this.weapon);
  }

  setFov(fov: number): void {
    this.baseFov = fov;
    this.camera.fov = Math.min(70, fov * 0.86);
    this.camera.updateProjectionMatrix();
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  setVisible(on: boolean): void {
    this.visible = on;
    this.root.visible = on;
  }

  get currentWeapon(): WeaponDef {
    return this.weapon;
  }

  /* ── Geometry ─────────────────────────────────────────────────────────── */

  private disposeParts(): void {
    // `removeFromParent` rather than `gunGroup.remove`: by the time a rebuild
    // happens the animated parts live under `magGroup` or `actionGroup`, and
    // asking the wrong parent to remove a child is a silent no-op — the previous
    // weapon's magazine would stay in the scene, hanging inside the new model.
    for (const p of this.parts) p.removeFromParent();
    this.parts.length = 0;
    // The flash layers are shared across weapons, so only dispose what this
    // build created — everything past the shared prefix the constructor pushed.
    for (let i = this.geometries.length - 1; i >= this.sharedGeo; i--) {
      this.geometries[i]!.dispose();
      this.geometries.pop();
    }
    for (let i = this.materials.length - 1; i >= this.sharedMat; i--) {
      this.materials[i]!.dispose();
      this.materials.pop();
    }
  }

  /**
   * Assembles the weapon out of primitives.
   *
   * Layout convention: −Z is forward (into the screen), matching the camera, so
   * the barrel extends along negative Z and the muzzle sits at its tip.
   *
   * Materials are Phong rather than Lambert specifically so the metal has a
   * highlight. Lambert is purely diffuse, which makes every surface read as matte
   * plastic no matter what colour it is — a gun you are looking at for the entire
   * match needs a specular roll across the receiver as it moves to look like an
   * object rather than a shape.
   *
   * The per-class detail below is not decoration either. A charging handle, a
   * pump, a bolt knob and a scope are how you tell at a glance which weapon is in
   * your hands, and the silhouette is doing that job in peripheral vision while
   * you are actually looking at the crosshair.
   */
  private build(w: WeaponDef): void {
    this.disposeParts();
    const v = w.viz;

    // Flash size from the bore and the charge behind the shot. Both numbers are
    // already in the table for other reasons, and a 12-gauge throwing the same
    // fireball as a 9 mm is one of the things that makes every weapon in a
    // browser shooter feel like the same weapon with a different damage number.
    this.flashScale = 0.5 + v.barrelR * 22 + w.sfx.gain * 0.55;
    // A bigger charge burns longer, but the flash still has to finish inside the
    // weapon's own cycle time — the same constraint the sound model is held to.
    // Past that it stops strobing per shot and becomes a lamp on the muzzle,
    // which is exactly how sustained fire loses its rhythm.
    this.flashDur = Math.min(cycleTime(w) * 550, 26 + w.sfx.gain * 30);

    // The ejection port: right of the receiver, level with the bore. A knife has
    // nothing to throw; everything else does, and the shotgun throws a plastic
    // hull rather than brass, which is decided by fire mode because its tube
    // means `magLen` is zero and cannot be the test.
    this.ejects = w.fireMode !== 'melee';
    this.shotgunHull = w.fireMode === 'pump';
    this.shellCalibre = v.barrelR;
    this.shellPort.set(v.bodyW * 0.55, v.bodyH * 0.1, -v.bodyLen * 0.45);

    // Reset every animated node. A swap mid-stroke or mid-swing would otherwise
    // leave the new weapon's magazine sitting wherever the old one's happened to
    // stop, and a knife put away halfway through a cut would hand the next
    // weapon its rotation.
    this.gunGroup.position.set(0, 0, 0);
    this.gunGroup.rotation.set(0, 0, 0);
    this.magGroup.position.set(0, 0, 0);
    this.magGroup.rotation.set(0, 0, 0);
    this.magGroup.visible = true;
    this.actionGroup.position.set(0, 0, 0);
    this.actionGroup.rotation.set(0, 0, 0);
    this.actionT = 0;
    this.meleeT = 0;

    this.hasMag = v.magLen > 0;
    // Tube-fed weapons take one shell at a time, so their reload has to be paced
    // by how many go in rather than being one continuous motion. The count is
    // the magazine size, which makes the rhythm of the animation the rhythm of
    // the weapon rather than a number picked to look busy.
    this.tubeShells = w.fireMode === 'pump' ? w.magSize : 0;
    this.actionKind =
      w.fireMode === 'melee'
        ? 'none'
        : w.fireMode === 'pump'
          ? 'pump'
          : w.fireMode === 'bolt'
            ? 'bolt'
            : 'slide';
    // Stroke length. A pump runs a fifth of the barrel's length, a bolt draws
    // about a case, and a self-loader's charging handle barely moves at all —
    // the mechanism it is attached to is inside the receiver, so what the player
    // sees is a twitch, not a stroke. Capped absolutely as well as
    // proportionally, because the Longshot's 0.56 m barrel would otherwise pull
    // its bolt a hand's width clear of the gun.
    this.actionTravel =
      this.actionKind === 'pump'
        ? Math.min(0.085, v.barrelLen * 0.2)
        : this.actionKind === 'bolt'
          ? Math.min(0.07, v.bodyLen * 0.13)
          : Math.min(0.022, v.bodyLen * 0.07);
    // One stroke per shot, inside the cycle time — see the field comment. The
    // floor is there so the division in `update` can never see a zero.
    this.actionDur = Math.max(
      0.03,
      Math.min(cycleTime(w) * 0.85, this.actionKind === 'slide' ? 0.075 : 0.34),
    );

    // Realistic tactical materials with authentic specular response
    const bodyMat = new THREE.MeshPhongMaterial({
      color: v.color,
      specular: 0x4e5560,
      shininess: 45,
    });
    const accentMat = new THREE.MeshPhongMaterial({
      color: v.accent,
      specular: 0x788290,
      shininess: 65,
    });
    const darkMat = new THREE.MeshPhongMaterial({
      color: 0x121418,
      specular: 0x555e6c,
      shininess: 85,
    });
    const gripMat = new THREE.MeshPhongMaterial({
      color: 0x181a1d,
      specular: 0x101214,
      shininess: 12,
    });
    const brassMat = new THREE.MeshPhongMaterial({
      color: 0xd4a43b,
      specular: 0xfff0b0,
      shininess: 110,
    });
    const chromeMat = new THREE.MeshPhongMaterial({
      color: 0x98a0aa,
      specular: 0xf0f4f8,
      shininess: 120,
    });
    const opticLensMat = new THREE.MeshPhongMaterial({
      color: 0x18302c,
      specular: 0x80ffd0,
      shininess: 140,
      transparent: true,
      opacity: 0.85,
    });
    const reticleRedMat = new THREE.MeshBasicMaterial({ color: 0xff2515 });
    const reticleGreenMat = new THREE.MeshBasicMaterial({ color: 0x15ff55 });
    const gloveMat = new THREE.MeshPhongMaterial({
      color: 0x242830,
      specular: 0x20242a,
      shininess: 16,
    });
    const gloveArmor = new THREE.MeshPhongMaterial({
      color: 0x111316,
      specular: 0x4a5260,
      shininess: 60,
    });
    this.materials.push(
      bodyMat,
      accentMat,
      darkMat,
      gripMat,
      brassMat,
      chromeMat,
      opticLensMat,
      reticleRedMat,
      reticleGreenMat,
      gloveMat,
      gloveArmor,
    );

    const add = (
      geo: THREE.BufferGeometry,
      mat: THREE.Material,
      x: number,
      y: number,
      z: number,
      rx = 0,
      ry = 0,
      rz = 0,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.rotation.set(rx, ry, rz);
      this.gunGroup.add(m);
      this.parts.push(m);
      this.geometries.push(geo);
      return m;
    };

    if (w.fireMode === 'melee') {
      // ── Tactical Combat Knife ──────────────────────────────────────────────
      const bladeLen = v.barrelLen;
      // Ergonomic G10 handle with finger choil
      add(new THREE.BoxGeometry(0.028, 0.036, 0.11), gripMat, 0, 0, 0.02);
      // Contoured handle scales and torx screws
      for (let i = 0; i < 3; i++) {
        add(new THREE.BoxGeometry(0.03, 0.008, 0.016), darkMat, 0, 0, -0.01 + i * 0.028);
        add(new THREE.CylinderGeometry(0.003, 0.003, 0.031, 6), chromeMat, 0, 0, -0.01 + i * 0.028, 0, 0, Math.PI / 2);
      }
      // Tactical crossguard with thumb jimping
      add(new THREE.BoxGeometry(0.066, 0.015, 0.018), darkMat, 0, 0.002, -0.04);
      add(new THREE.BoxGeometry(0.026, 0.006, 0.01), chromeMat, 0, 0.011, -0.04);

      // Two-tone combat Tanto / Bowie blade
      const bladeGeo = new THREE.CylinderGeometry(0.0012, 0.022, bladeLen, 4, 1);
      bladeGeo.scale(0.38, 1, 1);
      const blade = add(bladeGeo, chromeMat, 0, 0.006, -0.045 - bladeLen * 0.5, Math.PI / 2, 0, 0);
      blade.rotation.z = 0.02;

      // Dark spine & blood fuller groove
      add(new THREE.BoxGeometry(0.006, 0.013, bladeLen * 0.78), darkMat, 0, 0.01, -0.052 - bladeLen * 0.44);
      add(new THREE.BoxGeometry(0.008, 0.004, bladeLen * 0.52), chromeMat, 0, 0.007, -0.05 - bladeLen * 0.38);

      // Lanyard pommel loop at base of handle
      add(new THREE.CylinderGeometry(0.008, 0.008, 0.016, 8), darkMat, 0, -0.004, 0.08, Math.PI / 2);

      // Grip hand for knife
      const gripHandY = -0.015;
      const gripHandZ = 0.02;
      add(new THREE.BoxGeometry(0.054, 0.082, 0.075), gloveMat, 0.006, gripHandY, gripHandZ);
      add(new THREE.BoxGeometry(0.058, 0.022, 0.04), gloveArmor, 0.006, gripHandY + 0.038, gripHandZ);
      add(new THREE.BoxGeometry(0.02, 0.022, 0.046), gloveMat, -0.025, gripHandY + 0.032, gripHandZ - 0.004, 0.2);
      add(new THREE.BoxGeometry(0.058, 0.066, 0.14), gloveMat, 0.016, gripHandY - 0.038, gripHandZ + 0.085, -0.34);
      add(new THREE.BoxGeometry(0.062, 0.018, 0.03), gloveArmor, 0.016, gripHandY - 0.025, gripHandZ + 0.07, -0.34);

      this.muzzle.position.set(0, 0.01, -0.04 - bladeLen);
      return;
    }

    // ── Firearms ─────────────────────────────────────────────────────────
    const halfBody = v.bodyLen * 0.5;
      const barrelZ = -v.bodyLen - v.barrelLen * 0.5;
      const muzzleZ = -v.bodyLen - v.barrelLen;
      const axisY = v.bodyH * 0.06;

      // Lower receiver with flared magwell contour
      add(new THREE.BoxGeometry(v.bodyW * 0.96, v.bodyH * 0.58, v.bodyLen), bodyMat, 0, -v.bodyH * 0.22, -halfBody);
      // Upper receiver with realistic chamfer
      add(new THREE.BoxGeometry(v.bodyW * 0.88, v.bodyH * 0.44, v.bodyLen * 0.94), accentMat, 0, v.bodyH * 0.28, -halfBody);

      // CNC Machined Picatinny Top Rail with precision slots
      add(new THREE.BoxGeometry(v.bodyW * 0.52, v.bodyH * 0.12, v.bodyLen * 0.84), darkMat, 0, v.bodyH * 0.55, -v.bodyLen * 0.46);
      const teeth = Math.max(4, Math.round(v.bodyLen * 18));
      for (let i = 0; i < teeth; i++) {
        const t = (i + 0.5) / teeth;
        add(
          new THREE.BoxGeometry(v.bodyW * 0.56, v.bodyH * 0.09, v.bodyLen * 0.018),
          accentMat,
          0,
          v.bodyH * 0.61,
          -v.bodyLen * (0.06 + t * 0.82),
        );
      }

      // Ejection port with dust cover plate & visible brass bolt carrier
      add(new THREE.BoxGeometry(0.005, v.bodyH * 0.32, v.bodyLen * 0.22), darkMat, v.bodyW * 0.48, v.bodyH * 0.24, -v.bodyLen * 0.58);
      add(new THREE.BoxGeometry(0.006, v.bodyH * 0.18, v.bodyLen * 0.16), chromeMat, v.bodyW * 0.46, v.bodyH * 0.24, -v.bodyLen * 0.58);
      add(new THREE.CylinderGeometry(0.006, 0.006, 0.018, 8), brassMat, v.bodyW * 0.45, v.bodyH * 0.24, -v.bodyLen * 0.57, Math.PI / 2);
      // Brass deflector bump behind ejection port
      add(new THREE.BoxGeometry(0.012, v.bodyH * 0.24, 0.022), bodyMat, v.bodyW * 0.46, v.bodyH * 0.24, -v.bodyLen * 0.44, 0, 0.25, 0);

      // Barrel & gas block assembly
      const barrelGeo = new THREE.CylinderGeometry(v.barrelR, v.barrelR, v.barrelLen, 14);
      add(barrelGeo, darkMat, 0, axisY, barrelZ, Math.PI / 2);

      // M-LOK / Tactical handguard with cooling vents
      if (v.barrelLen > 0.14) {
        const guardLen = v.barrelLen * 0.66;
        const guardZ = -v.bodyLen - guardLen * 0.5 - 0.01;
        // Hexagonal profile handguard
        add(new THREE.BoxGeometry(v.bodyW * 0.84, v.bodyH * 0.6, guardLen), bodyMat, 0, axisY - v.bodyH * 0.03, guardZ);
        // Top gas tube inside handguard
        add(new THREE.CylinderGeometry(v.barrelR * 0.45, v.barrelR * 0.45, guardLen * 0.95, 8), chromeMat, 0, axisY + v.bodyH * 0.25, guardZ, Math.PI / 2);
        // Low-profile gas block
        add(new THREE.BoxGeometry(v.bodyW * 0.48, v.bodyH * 0.35, 0.025), darkMat, 0, axisY + v.bodyH * 0.1, -v.bodyLen - guardLen * 0.9);

        // Side M-LOK ventilation slots
        const vents = Math.max(3, Math.round(guardLen * 22));
        for (let i = 0; i < vents; i++) {
          const t = (i + 0.5) / vents;
          add(new THREE.BoxGeometry(v.bodyW * 0.88, v.bodyH * 0.16, guardLen * 0.08), darkMat, 0, axisY + v.bodyH * 0.04, -v.bodyLen - 0.015 - t * guardLen * 0.92);
          add(new THREE.BoxGeometry(v.bodyW * 0.88, v.bodyH * 0.16, guardLen * 0.08), darkMat, 0, axisY - v.bodyH * 0.12, -v.bodyLen - 0.015 - t * guardLen * 0.92);
        }
      }

      // Tactical Multi-Port Compensator / Muzzle Brake with vents
      add(new THREE.CylinderGeometry(v.barrelR * 1.6, v.barrelR * 1.5, 0.054, 12), darkMat, 0, axisY, muzzleZ + 0.027, Math.PI / 2);
      // Side exhaust ports
      add(new THREE.BoxGeometry(v.barrelR * 3.6, v.barrelR * 0.55, 0.014), chromeMat, 0, axisY, muzzleZ + 0.034);
      add(new THREE.BoxGeometry(v.barrelR * 3.6, v.barrelR * 0.55, 0.014), chromeMat, 0, axisY, muzzleZ + 0.018);
      // Crown ring
      add(new THREE.CylinderGeometry(v.barrelR * 1.3, v.barrelR * 1.65, 0.012, 12), accentMat, 0, axisY, muzzleZ + 0.006, Math.PI / 2);

      // ── Tactical PMAG / Magazine ──────────────────────────────────────────
      if (v.magLen > 0) {
        const mag = add(
          new THREE.BoxGeometry(v.bodyW * 0.76, v.magLen, v.bodyLen * 0.22),
          gripMat,
          0,
          -v.bodyH * 0.5 - v.magLen * 0.42,
          -v.bodyLen * 0.42,
        );
        mag.rotation.x = -0.13;

        // PMAG Waffle Ribs & Witness window
        const ribCount = Math.max(3, Math.round(v.magLen * 25));
        for (let i = 0; i < ribCount; i++) {
          const t = (i + 0.5) / ribCount;
          const rib = add(
            new THREE.BoxGeometry(v.bodyW * 0.82, v.magLen * 0.035, v.bodyLen * 0.24),
            darkMat,
            0,
            -v.bodyH * 0.5 - v.magLen * (0.15 + t * 0.7),
            -v.bodyLen * 0.42 - (t * 0.015),
          );
          rib.rotation.x = -0.13;
          this.magGroup.add(rib);
        }

        // Witness window with visible brass rounds
        const windowMesh = add(
          new THREE.BoxGeometry(v.bodyW * 0.78, v.magLen * 0.35, 0.008),
          darkMat,
          v.bodyW * 0.39,
          -v.bodyH * 0.5 - v.magLen * 0.48,
          -v.bodyLen * 0.42,
        );
        windowMesh.rotation.x = -0.13;
        const brassRound = add(
          new THREE.CylinderGeometry(0.004, 0.004, v.magLen * 0.28, 6),
          brassMat,
          v.bodyW * 0.38,
          -v.bodyH * 0.5 - v.magLen * 0.48,
          -v.bodyLen * 0.42,
        );
        brassRound.rotation.x = -0.13;

        // Reinforced baseplate
        const plate = add(
          new THREE.BoxGeometry(v.bodyW * 0.84, v.magLen * 0.1, v.bodyLen * 0.26),
          darkMat,
          0,
          -v.bodyH * 0.5 - v.magLen * 0.94,
          -v.bodyLen * 0.42 - v.magLen * 0.07,
        );
        plate.rotation.x = -0.13;

        this.magGroup.add(mag, windowMesh, brassRound, plate);
      }

      // ── Ergonomic Grip & Trigger Assembly ────────────────────────────────
      const grip = add(
        new THREE.BoxGeometry(v.bodyW * 0.82, 0.125, 0.054),
        gripMat,
        0,
        -v.bodyH * 0.5 - 0.058,
        -v.bodyLen * 0.14,
      );
      grip.rotation.x = 0.22;
      // Stippling panels on grip sides
      const stippleL = add(new THREE.BoxGeometry(0.004, 0.09, 0.04), darkMat, v.bodyW * 0.42, -v.bodyH * 0.5 - 0.058, -v.bodyLen * 0.14);
      stippleL.rotation.x = 0.22;
      const stippleR = add(new THREE.BoxGeometry(0.004, 0.09, 0.04), darkMat, -v.bodyW * 0.42, -v.bodyH * 0.5 - 0.058, -v.bodyLen * 0.14);
      stippleR.rotation.x = 0.22;

      // Enlarged combat trigger guard
      add(new THREE.BoxGeometry(v.bodyW * 0.52, 0.009, 0.055), darkMat, 0, -v.bodyH * 0.5 - 0.04, -v.bodyLen * 0.28);
      add(new THREE.BoxGeometry(v.bodyW * 0.52, 0.04, 0.009), darkMat, 0, -v.bodyH * 0.5 - 0.02, -v.bodyLen * 0.31);
      // Skeletonized curved combat trigger
      add(new THREE.BoxGeometry(v.bodyW * 0.18, 0.026, 0.008), chromeMat, 0, -v.bodyH * 0.5 - 0.022, -v.bodyLen * 0.26, -0.2);

      // ── Tactical Stock ───────────────────────────────────────────────────
      if (v.stock) {
        // Buffer tube with position holes
        add(new THREE.CylinderGeometry(v.bodyH * 0.19, v.bodyH * 0.19, 0.12, 10), darkMat, 0, -0.006, 0.06, Math.PI / 2);
        // Crane stock cheek weld body
        add(new THREE.BoxGeometry(v.bodyW * 0.74, v.bodyH * 0.74, 0.13), bodyMat, 0, -0.016, 0.08);
        // Top cheek riser
        add(new THREE.BoxGeometry(v.bodyW * 0.62, v.bodyH * 0.2, 0.1), gripMat, 0, v.bodyH * 0.36, 0.08);
        // Ribbed rubber recoil buttpad
        add(new THREE.BoxGeometry(v.bodyW * 0.9, v.bodyH * 1.25, 0.022), gripMat, 0, -0.022, 0.148);
        for (let i = 0; i < 4; i++) {
          add(new THREE.BoxGeometry(v.bodyW * 0.86, v.bodyH * 0.12, 0.005), darkMat, 0, -0.06 + i * 0.028, 0.16);
        }
      }

      // ── Fire-Mode Actions ────────────────────────────────────────────────
      if (w.fireMode === 'pump') {
        const pump = add(
          new THREE.BoxGeometry(v.bodyW * 1.08, v.bodyH * 0.7, v.barrelLen * 0.32),
          gripMat,
          0,
          axisY - v.bodyH * 0.48,
          -v.bodyLen - v.barrelLen * 0.34,
        );
        // Grooved pump traction ridges
        for (let i = 0; i < 5; i++) {
          const rib = add(
            new THREE.BoxGeometry(v.bodyW * 1.12, v.bodyH * 0.72, 0.01),
            darkMat,
            0,
            axisY - v.bodyH * 0.48,
            -v.bodyLen - v.barrelLen * (0.2 + i * 0.032),
          );
          this.actionGroup.add(rib);
        }
        this.actionGroup.add(pump);
        // Extended magazine tube under barrel with dual clamp
        add(new THREE.CylinderGeometry(v.barrelR * 0.85, v.barrelR * 0.85, v.barrelLen * 0.88, 10), darkMat, 0, axisY - v.barrelR * 2.1, -v.bodyLen - v.barrelLen * 0.44, Math.PI / 2);
        add(new THREE.BoxGeometry(v.bodyW * 0.6, v.barrelR * 3.5, 0.02), darkMat, 0, axisY - v.barrelR * 1.1, -v.bodyLen - v.barrelLen * 0.82);
      } else if (w.fireMode === 'bolt') {
        // Swept bolt handle with knurled tactical knob
        const boltHandle = add(
          new THREE.CylinderGeometry(0.006, 0.006, 0.065, 8),
          chromeMat,
          v.bodyW * 0.62,
          v.bodyH * 0.12,
          -v.bodyLen * 0.3,
          0,
          0,
          Math.PI / 2 - 0.38,
        );
        const boltKnob = add(
          new THREE.SphereGeometry(0.015, 10, 8),
          darkMat,
          v.bodyW * 0.62 + 0.034,
          v.bodyH * 0.12 - 0.012,
          -v.bodyLen * 0.3,
        );
        const boltSleeve = add(
          new THREE.CylinderGeometry(0.014, 0.014, 0.08, 10),
          chromeMat,
          0,
          v.bodyH * 0.22,
          -v.bodyLen * 0.35,
          Math.PI / 2,
        );
        this.actionGroup.add(boltHandle, boltKnob, boltSleeve);
      } else {
        // Ambidextrous charging handle wings
        const charging = add(
          new THREE.BoxGeometry(0.038, v.bodyH * 0.16, 0.016),
          accentMat,
          v.bodyW * 0.38,
          v.bodyH * 0.44,
          -v.bodyLen * 0.12,
        );
        const latch = add(
          new THREE.BoxGeometry(0.014, v.bodyH * 0.12, 0.012),
          darkMat,
          v.bodyW * 0.48,
          v.bodyH * 0.44,
          -v.bodyLen * 0.12,
        );
        this.actionGroup.add(charging, latch);
      }

      // ── Sights & Tactical Optics ─────────────────────────────────────────
      if (w.scoped) {
        // ── High-Magnification Sniper Optic (Longshot) ───────────────────────
        const scopeY = v.bodyH * 1.05;
        const scopeZ = -v.bodyLen * 0.52;
        // Main 34mm tube
        add(new THREE.CylinderGeometry(0.024, 0.024, 0.22, 16), darkMat, 0, scopeY, scopeZ, Math.PI / 2);
        // Objective bell & sunshade forward
        add(new THREE.CylinderGeometry(0.033, 0.026, 0.045, 16), darkMat, 0, scopeY, scopeZ - 0.125, Math.PI / 2);
        add(new THREE.CylinderGeometry(0.033, 0.033, 0.035, 16), accentMat, 0, scopeY, scopeZ - 0.16, Math.PI / 2);
        // Eyepiece bell back
        add(new THREE.CylinderGeometry(0.029, 0.024, 0.038, 16), darkMat, 0, scopeY, scopeZ + 0.12, Math.PI / 2);
        // Knurled magnification zoom ring
        add(new THREE.CylinderGeometry(0.027, 0.027, 0.02, 16), gripMat, 0, scopeY, scopeZ + 0.085, Math.PI / 2);
        // Tactical Target Turrets (Top Elevation & Right Windage)
        add(new THREE.CylinderGeometry(0.012, 0.012, 0.026, 12), darkMat, 0, scopeY + 0.026, scopeZ, 0, 0, 0);
        add(new THREE.CylinderGeometry(0.012, 0.012, 0.026, 12), darkMat, 0.026, scopeY, scopeZ, 0, 0, Math.PI / 2);
        // Cantilever dual-ring mounting base with locking nuts
        add(new THREE.BoxGeometry(0.034, 0.028, 0.02), accentMat, 0, scopeY - 0.028, scopeZ - 0.06);
        add(new THREE.BoxGeometry(0.034, 0.028, 0.02), accentMat, 0, scopeY - 0.028, scopeZ + 0.05);
        add(new THREE.BoxGeometry(0.026, 0.016, 0.16), darkMat, 0, scopeY - 0.036, scopeZ);
        // Rear anti-reflective emerald multi-coated glass disc
        add(new THREE.CircleGeometry(0.024, 16), opticLensMat, 0, scopeY, scopeZ + 0.139);

        // Folded tactical bipod on forearm
        add(new THREE.BoxGeometry(v.bodyW * 0.6, 0.018, 0.03), darkMat, 0, axisY - v.bodyH * 0.32, -v.bodyLen - 0.06);
        add(new THREE.CylinderGeometry(0.005, 0.005, 0.14, 8), darkMat, -v.bodyW * 0.35, axisY - v.bodyH * 0.32, -v.bodyLen - 0.12, Math.PI / 2);
        add(new THREE.CylinderGeometry(0.005, 0.005, 0.14, 8), darkMat, v.bodyW * 0.35, axisY - v.bodyH * 0.32, -v.bodyLen - 0.12, Math.PI / 2);
      } else if (w.slot === 'primary') {
        // ── Modern Holographic / Reflex Sight (Ranger / Vector / Breacher) ──
        const sightY = v.bodyH * 0.88;
        const sightZ = -v.bodyLen * 0.42;
        // Sight Picatinny mount base
        add(new THREE.BoxGeometry(v.bodyW * 0.62, 0.016, 0.08), darkMat, 0, sightY - 0.02, sightZ);
        // Protective aluminum rectangular hood
        add(new THREE.BoxGeometry(v.bodyW * 0.68, 0.052, 0.075), accentMat, 0, sightY + 0.018, sightZ);
        // Inner optical viewport cutout
        add(new THREE.BoxGeometry(v.bodyW * 0.54, 0.042, 0.078), darkMat, 0, sightY + 0.018, sightZ);
        // Optical glass lens with emerald multi-coating
        const glass = add(new THREE.PlaneGeometry(v.bodyW * 0.5, 0.038), opticLensMat, 0, sightY + 0.018, sightZ + 0.02);
        glass.rotation.x = -0.06;
        // Illuminated glowing red holographic center reticle dot!
        add(new THREE.CircleGeometry(0.0035, 10), reticleRedMat, 0, sightY + 0.018, sightZ + 0.021);
        add(new THREE.RingGeometry(0.008, 0.01, 14), reticleRedMat, 0, sightY + 0.018, sightZ + 0.021);
        // Elevation & windage adjustment dials on sight hood
        add(new THREE.CylinderGeometry(0.005, 0.005, 0.008, 8), chromeMat, v.bodyW * 0.36, sightY + 0.02, sightZ, 0, 0, Math.PI / 2);
        add(new THREE.CylinderGeometry(0.005, 0.005, 0.008, 8), chromeMat, 0, sightY + 0.046, sightZ);
      } else {
        // ── High-Visibility Combat Sights (Sidearm) ──────────────────────────
        // Rear anti-glare notched aperture
        add(new THREE.BoxGeometry(0.028, 0.022, 0.012), darkMat, 0, v.bodyH * 0.78, -v.bodyLen * 0.1);
        add(new THREE.BoxGeometry(0.008, 0.014, 0.014), bodyMat, 0, v.bodyH * 0.84, -v.bodyLen * 0.1);
        // High-vis green fiber-optic dots on rear notch
        add(new THREE.CircleGeometry(0.002, 6), reticleGreenMat, -0.009, v.bodyH * 0.82, -v.bodyLen * 0.092);
        add(new THREE.CircleGeometry(0.002, 6), reticleGreenMat, 0.009, v.bodyH * 0.82, -v.bodyLen * 0.092);

        // Front sight post with high-vis red fiber-optic rod
        add(new THREE.BoxGeometry(0.009, 0.024, 0.012), darkMat, 0, v.bodyH * 0.78, -v.bodyLen * 0.88);
        add(new THREE.CylinderGeometry(0.0025, 0.0025, 0.01, 6), reticleRedMat, 0, v.bodyH * 0.84, -v.bodyLen * 0.88, Math.PI / 2);
      }

      this.muzzle.position.set(0, axisY, muzzleZ);

    // ── Operator Tactical Hands & Combat Gloves ──────────────────────────────
    const gripHandY = -v.bodyH * 0.5 - 0.06;
    const gripHandZ = -v.bodyLen * 0.13;
    // Palm & main glove body
    add(new THREE.BoxGeometry(0.054, 0.082, 0.075), gloveMat, 0.006, gripHandY, gripHandZ);
    // Molded carbon fiber knuckle armor protector
    add(new THREE.BoxGeometry(0.058, 0.022, 0.04), gloveArmor, 0.006, gripHandY + 0.038, gripHandZ);
    // Segmented thumb wrapped over grip
    add(new THREE.BoxGeometry(0.02, 0.022, 0.046), gloveMat, -0.025, gripHandY + 0.032, gripHandZ - 0.004, 0.2);
    // Tactical wrist cuff with retention strap
    add(new THREE.BoxGeometry(0.058, 0.066, 0.14), gloveMat, 0.016, gripHandY - 0.038, gripHandZ + 0.085, -0.34);
    add(new THREE.BoxGeometry(0.062, 0.018, 0.03), gloveArmor, 0.016, gripHandY - 0.025, gripHandZ + 0.07, -0.34);

    if (v.magLen > 0 || v.stock) {
      // Support hand on handguard with tactical segmented fingers
      const supZ = -v.bodyLen - v.barrelLen * 0.34;
      const supY = -v.bodyH * 0.5 - 0.03;
      add(new THREE.BoxGeometry(0.052, 0.076, 0.088), gloveMat, -0.012, supY, supZ);
      add(new THREE.BoxGeometry(0.058, 0.024, 0.078), gloveArmor, -0.004, supY + 0.038, supZ, 0, 0, 0.12);
      add(new THREE.BoxGeometry(0.052, 0.062, 0.11), gloveMat, -0.026, supY - 0.032, supZ + 0.08, -0.3, 0, 0.2);
    }
  }

  /** Swaps the weapon and starts the raise animation. */
  setWeapon(id: number): void {
    const w = weaponById(id);
    if (w.id === this.weapon.id) return;
    this.weapon = w;
    this.build(w);
    this.switchDur = w.switchTime;
    this.switchT = w.switchTime;
    // Reset transient state so a swap mid-recoil does not inherit the kick.
    this.kickZ = 0;
    this.kickZVel = 0;
    this.kickPitch = 0;
    this.kickPitchVel = 0;
    this.kickYaw = 0;
    this.kickYawVel = 0;
    this.reloadT = 0;
    this.reloadDur = 0;
    // The flash too, and not just for tidiness: `flashUntil` was set against the
    // *old* weapon's duration, and `build` has just replaced it. Left alone, a
    // swap mid-flash divides a stale deadline by a shorter duration, and the
    // fade computes a `remain` above 1 — an additive overbright for a frame.
    this.flashUntil = 0;
    (this.flash.material as THREE.MeshBasicMaterial).opacity = 0;
    this.coreMat.opacity = 0;
    this.flashLight.intensity = 0;
  }

  /* ── Events ───────────────────────────────────────────────────────────── */

  /**
   * One trigger pull. `spreadFactor` scales the kick a little so a hot barrel
   * feels progressively less controllable.
   */
  fire(nowLocal: number, spreadFactor: number): void {
    const w = this.weapon;
    const heat = 1 + spreadFactor * 0.35;

    if (w.fireMode === 'melee') {
      this.meleeT = MELEE_SWING;
      return;
    }

    // Cycle the action. One stroke per trigger pull, restarted rather than
    // queued: at 900 rpm the previous stroke is still travelling, and a queue
    // would run the mechanism further and further behind the shots it belongs to.
    this.actionT = this.actionDur;

    // Impulse into the spring. Velocity, not position — pushing position makes
    // rapid fire look like a stutter, pushing velocity accumulates smoothly.
    this.kickZVel += 3.1 * heat * (0.55 + w.recoilV * 22);
    this.kickPitchVel += w.recoilV * 46 * heat;
    this.kickYawVel += (Math.random() * 2 - 1) * w.recoilH * 42 * heat;
    this.kickRoll += (Math.random() * 2 - 1) * 0.02;

    this.flashUntil = nowLocal + this.flashDur;
    const mat = this.flash.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.92;
    this.coreMat.opacity = 1;
    // Random roll and scale so consecutive flashes never look identical.
    this.flash.rotation.z = Math.random() * Math.PI;
    const s = this.flashScale * (0.8 + Math.random() * 0.55);
    this.flash.scale.set(s, s, s);
    this.flashLight.color.setHex(0xffaa55);
    this.flashLight.intensity = 4.8 * this.flashScale;

    if (this.ejects) {
      // Read the gun's live transform rather than last frame's: `fire` runs from
      // input handling, before this frame's animation, and a case that spawns a
      // frame behind a swinging weapon visibly starts off the port.
      this.gunGroup.updateWorldMatrix(true, false);
      this.ejectPos.copy(this.shellPort).applyMatrix4(this.gunGroup.matrixWorld);
      this.gunGroup.getWorldQuaternion(this.ejectRot);
      this.shells.spawn(this.ejectPos, this.ejectRot, this.shellCalibre, this.shotgunHull);
    }
  }

  startReload(duration: number): void {
    this.reloadDur = Math.max(0.15, duration);
    this.reloadT = this.reloadDur;
  }

  cancelReload(): void {
    this.reloadT = 0;
  }

  /** Called when the player lands, to dip the hands. */
  land(impactSpeed: number): void {
    this.landDip = Math.min(0.05, impactSpeed * 0.0028);
  }

  /**
   * One stroke of the action: `0 → 1` of the way through it in, `0 → 1 → 0` of
   * the travel out.
   *
   * The asymmetry is the whole point. A gas or recoil-operated action is thrown
   * back by the shot and returned by a spring, so it leaves fast and comes home
   * slower. A pump or a bolt is worked by a hand, which accelerates into the
   * stroke, dwells at the rear while the case clears, and then pushes forward
   * again. A symmetric sine for both would give every weapon in the game the
   * same rhythm — the mechanical equivalent of voicing them all off one `freq`,
   * which is the mistake the audio model was already rebuilt to stop making.
   */
  private strokeShape(p: number): number {
    if (this.actionKind === 'slide') {
      // Snap out over the first fifth, ride the spring home over the rest.
      return p < 0.2 ? p / 0.2 : 1 - (p - 0.2) / 0.8;
    }
    // Hand-worked: ease back, dwell at the rear, ease forward.
    if (p < 0.42) {
      const t = p / 0.42;
      return t * t * (3 - 2 * t);
    }
    if (p < 0.56) return 1;
    const t = (p - 0.56) / 0.44;
    return 1 - t * t * (3 - 2 * t);
  }

  /* ── Per-frame ────────────────────────────────────────────────────────── */

  /**
   * @param dt          seconds since last frame
   * @param lookDx      yaw change this frame, radians (for sway)
   * @param lookDy      pitch change this frame, radians
   * @param speed       horizontal speed, m/s
   * @param onGround    whether the player is grounded
   * @param wantAds     whether the player is holding aim
   * @param bobEnabled  view-bob setting
   * @param nowLocal    performance.now()
   */
  update(
    dt: number,
    lookDx: number,
    lookDy: number,
    speed: number,
    onGround: boolean,
    wantAds: boolean,
    bobEnabled: boolean,
    nowLocal: number,
  ): void {
    const w = this.weapon;

    // ADS transition. Uses the weapon's own adsTime so a sniper feels heavy.
    const adsRate = 1 / Math.max(0.04, w.adsTime);
    const target = wantAds && this.reloadT <= 0 && this.switchT <= 0 ? 1 : 0;
    if (this.adsFactor < target) this.adsFactor = Math.min(target, this.adsFactor + dt * adsRate);
    else if (this.adsFactor > target) this.adsFactor = Math.max(target, this.adsFactor - dt * adsRate);

    // Recoil spring. Stiffness comes from the weapon's recovery rate so a
    // high-recovery SMG settles fast and a sniper wallows.
    const k = w.recoilRecovery * w.recoilRecovery * 0.9;
    const c = 2 * Math.sqrt(k) * 0.85;
    const stepSpring = (pos: number, vel: number): [number, number] => {
      const acc = -k * pos - c * vel;
      const nv = vel + acc * dt;
      return [pos + nv * dt, nv];
    };
    [this.kickZ, this.kickZVel] = stepSpring(this.kickZ, this.kickZVel);
    [this.kickPitch, this.kickPitchVel] = stepSpring(this.kickPitch, this.kickPitchVel);
    [this.kickYaw, this.kickYawVel] = stepSpring(this.kickYaw, this.kickYawVel);
    this.kickRoll *= Math.exp(-9 * dt);

    // Export the camera-visible part of the kick. Aiming halves it, which is
    // the mechanical reason ADS is worth the speed penalty.
    const camScale = 1 - this.adsFactor * 0.5;
    this.recoilPitch = this.kickPitch * 0.42 * camScale;
    this.recoilYaw = this.kickYaw * 0.42 * camScale;

    // Sway: the gun chases the camera with a first-order lag.
    const swayTargetX = clamp(-lookDx * 2.6, -1, 1) * SWAY_AMOUNT;
    const swayTargetY = clamp(-lookDy * 2.6, -1, 1) * SWAY_AMOUNT;
    const swayK = 1 - Math.exp(-SWAY_RATE * dt);
    this.swayX += (swayTargetX - this.swayX) * swayK;
    this.swayY += (swayTargetY - this.swayY) * swayK;

    // Bob: figure-eight, phase advanced by distance travelled.
    if (bobEnabled && onGround && speed > 0.5) {
      this.bobPhase += speed * dt * 1.9;
      const amp = BOB_AMOUNT * Math.min(1, speed / 7) * (1 - this.adsFactor * 0.75);
      this.bobX = Math.sin(this.bobPhase) * amp;
      // Doubled frequency vertically is what makes it read as footfalls.
      this.bobY = -Math.abs(Math.sin(this.bobPhase * 2)) * amp * 0.8;
    } else {
      const decay = Math.exp(-8 * dt);
      this.bobX *= decay;
      this.bobY *= decay;
    }
    this.landDip *= Math.exp(-7 * dt);

    // Airborne tilt: the gun drops a touch while falling.
    const airTilt = onGround ? 0 : 0.05;

    // Reload: lower, roll away, come back. A single curve drives all of it.
    let reloadDrop = 0;
    let reloadRoll = 0;
    let reloadYaw = 0;
    /** How far through the reload, `0 → 1`, or −1 when none is running. */
    let reloadP = -1;
    if (this.reloadT > 0) {
      this.reloadT = Math.max(0, this.reloadT - dt);
      const p = 1 - this.reloadT / this.reloadDur;
      reloadP = p;
      // Fast down, hold, fast up.
      const curve = p < 0.22 ? p / 0.22 : p > 0.78 ? (1 - p) / 0.22 : 1;
      const e = curve * curve * (3 - 2 * curve);
      reloadDrop = e * 0.14;
      reloadRoll = e * 0.55;
      reloadYaw = e * 0.2;
    }

    // Switch: raise from below.
    let switchDrop = 0;
    let switchRoll = 0;
    if (this.switchT > 0) {
      this.switchT = Math.max(0, this.switchT - dt);
      const p = 1 - this.switchT / this.switchDur;
      const e = 1 - (1 - p) * (1 - p) * (1 - p);
      switchDrop = (1 - e) * 0.26;
      switchRoll = (1 - e) * 0.7;
    }

    /* ── The mechanism ────────────────────────────────────────────────────────
       Everything above this moves the whole weapon, which is the hands holding
       it. What follows moves parts of it against each other, which is the gun
       working — and that is the difference between a model that recoils and a
       model that cycles. Neither substitutes for the other: a rifle that jumps
       on every shot but whose bolt never moves reads as a prop being shaken.

       Two nodes carry all of it, and both are written every frame even when
       nothing is animating, so a cancelled reload or a weapon swap can never
       leave a part stranded halfway out of the receiver.
       ─────────────────────────────────────────────────────────────────────── */
    let actionZ = 0;
    let actionLift = 0;
    let magY = 0;
    let magZ = 0;
    let magRoll = 0;
    let magVisible = true;

    if (this.actionT > 0) {
      this.actionT = Math.max(0, this.actionT - dt);
      const p = 1 - this.actionT / this.actionDur;
      actionZ = this.strokeShape(p) * this.actionTravel;
      // A bolt handle lifts before it draws and drops after it closes, so the
      // rotation leads and trails the travel instead of tracking it — hence the
      // 1.6× on the phase, which finishes the lift-and-drop arc early.
      if (this.actionKind === 'bolt') {
        actionLift = Math.sin(Math.min(1, p * 1.6) * Math.PI) * 0.85;
      }
    }

    if (reloadP >= 0) {
      const p = reloadP;
      if (this.hasMag) {
        // Drop, swap, insert, seat. The empty magazine is gone before the hand
        // does anything else, and the last beat is a tap on the base of the
        // fresh one — which is the moment a player reads as "loaded", well
        // before the timer they cannot see actually expires.
        if (p < 0.16) {
          const t = p / 0.16;
          // Squared, not linear: it is falling out under gravity, not being
          // lowered on a string.
          magY = -0.34 * t * t;
          magZ = 0.05 * t * t;
          magRoll = 0.9 * t * t;
        } else if (p < 0.44) {
          // Off-screen entirely while the other hand fetches a fresh one.
          // Cheaper and more honest than animating a magazine that does not
          // exist yet through the floor of the frame.
          magVisible = false;
        } else if (p < 0.74) {
          const t = (p - 0.44) / 0.3;
          const e = t * t * (3 - 2 * t);
          magY = -0.34 * (1 - e);
          magZ = 0.05 * (1 - e);
          magRoll = 0.9 * (1 - e);
        } else if (p < 0.86) {
          // Seat tap: one damped bounce against the magazine well.
          const t = (p - 0.74) / 0.12;
          magY = -Math.sin(t * Math.PI * 2) * 0.012 * (1 - t);
        }
        // A bolt gun still has to chamber a round out of the fresh magazine, so
        // the tail of its reload is a full stroke of the action rather than
        // nothing at all. `max` against the per-shot values so a reload begun
        // while the bolt is still travelling cannot rewind it.
        if (this.actionKind === 'bolt' && p >= 0.84) {
          const t = Math.min(1, (p - 0.84) / 0.16);
          actionZ = Math.max(actionZ, this.strokeShape(t) * this.actionTravel);
          actionLift = Math.max(actionLift, Math.sin(Math.min(1, t * 1.6) * Math.PI) * 0.85);
        }
      } else if (this.tubeShells > 0) {
        // Tube fed: shells through the loading gate one at a time, then a pump
        // stroke to chamber. There is no gate mesh to animate, so what sells it
        // is the forend rocking once per shell — the count, and therefore the
        // tempo, comes straight off the magazine size.
        const feedEnd = 0.78;
        if (p < feedEnd) {
          const shell = (p / feedEnd) * this.tubeShells;
          actionZ = Math.abs(Math.sin(shell * Math.PI)) * this.actionTravel * 0.16;
        } else {
          const t = Math.min(1, (p - feedEnd) / (1 - feedEnd));
          actionZ = Math.max(actionZ, this.strokeShape(t) * this.actionTravel);
        }
      }
    }

    /* Knife swing. Three phases rather than one sine, because a symmetric arc
       has no moment of contact in it: the blade is fastest at the exact middle
       of the sweep and decelerates for as long as it accelerated, which reads as
       a wave rather than as a cut. A wind-up that pulls the blade back and turns
       the edge into line, a fast linear slash across and down, and a slower
       recovery gives the swing a point where the damage obviously happens — and
       since the server resolves the hit on the trigger pull, that point needs to
       be near the front of the animation rather than in the middle of it. */
    let meleeYaw = 0;
    let meleePitch = 0;
    let meleeRoll = 0;
    let meleeX = 0;
    let meleeY = 0;
    if (this.meleeT > 0) {
      this.meleeT = Math.max(0, this.meleeT - dt);
      const p = 1 - this.meleeT / MELEE_SWING;
      if (p < 0.24) {
        // Wind-up: back, right and up, rolling the edge over.
        const t = p / 0.24;
        const e = t * t * (3 - 2 * t);
        meleeYaw = e * 0.5;
        meleePitch = -e * 0.34;
        meleeRoll = -e * 0.6;
        meleeX = e * 0.05;
        meleeY = e * 0.035;
      } else if (p < 0.46) {
        // The cut: across and down, through the rest pose and out the far side.
        // Linear on purpose — an eased slash is a slash in slow motion.
        const t = (p - 0.24) / 0.22;
        meleeYaw = 0.5 - t * 1.55;
        meleePitch = -0.34 + t * 0.62;
        meleeRoll = -0.6 + t * 1.35;
        meleeX = 0.05 - t * 0.13;
        meleeY = 0.035 - t * 0.115;
      } else {
        // Recovery: everything eases back to rest from where the cut finished.
        const t = (p - 0.46) / 0.54;
        const k = (1 - t) * (1 - t) * (1 - t);
        meleeYaw = -1.05 * k;
        meleePitch = 0.28 * k;
        meleeRoll = 0.75 * k;
        meleeX = -0.08 * k;
        meleeY = -0.08 * k;
      }
    }

    // Compose. ADS blends the whole rest pose toward the sight line.
    const a = this.adsFactor;
    const px = HIP_POS.x + (ADS_POS.x - HIP_POS.x) * a;
    const py = HIP_POS.y + (ADS_POS.y - HIP_POS.y) * a;
    const pz = HIP_POS.z + (ADS_POS.z - HIP_POS.z) * a;

    this.root.position.set(
      px + this.swayX + this.bobX * (1 - a * 0.6),
      py + this.swayY + this.bobY - reloadDrop - switchDrop - this.landDip - airTilt * 0.4,
      pz + this.kickZ * 0.012 * (1 - a * 0.45),
    );
    this.root.rotation.set(
      this.kickPitch * 0.5 + airTilt + reloadDrop * 1.5,
      this.swayX * 1.8 + reloadYaw + this.kickYaw * 0.4,
      this.kickRoll + reloadRoll + switchRoll + this.swayX * 2.2,
    );

    // The knife swing is the arm rather than the hands, so it goes one level in
    // from the sway and bob above. Written unconditionally, for every weapon, so
    // swapping out of the knife mid-cut cannot hand the next one its rotation.
    this.gunGroup.position.set(meleeX, meleeY, 0);
    this.gunGroup.rotation.set(meleePitch, meleeYaw, meleeRoll);

    // And the mechanism, damped by how far into the sights the player is. A part
    // thrashing across a sight picture is exactly the motion that stops someone
    // being able to aim, and settling the view is the entire reason to aim down
    // sights in the first place — so the gun visibly works at the hip and calms
    // down when it matters.
    const mech = 1 - a * 0.45;
    this.magGroup.position.set(0, magY * mech, magZ * mech);
    this.magGroup.rotation.set(magRoll * mech, 0, 0);
    this.magGroup.visible = magVisible;
    this.actionGroup.position.set(0, 0, actionZ * mech);
    this.actionGroup.rotation.set(0, 0, actionLift * mech);

    // Scoped weapons hide the model entirely at full zoom — the scope overlay
    // takes over, and a rifle body across the screen would just be in the way.
    const scopeHide = w.scoped && a > 0.82;
    this.root.visible = this.visible && !scopeHide;

    // Fade the flash out. The decay is deliberately not linear: powder burns out
    // fast, and a linear ramp over 50 ms reads as a lamp being dimmed rather than
    // as something igniting. The white core goes first and the light fastest of
    // all, so what is left at the end of the flash is the warm bloom.
    const mat = this.flash.material as THREE.MeshBasicMaterial;
    if (mat.opacity > 0 || this.coreMat.opacity > 0) {
      if (nowLocal >= this.flashUntil) {
        mat.opacity = 0;
        this.coreMat.opacity = 0;
        this.flashLight.intensity = 0;
      } else {
        const remain = (this.flashUntil - nowLocal) / this.flashDur;
        const sq = remain * remain;
        mat.opacity = 0.92 * sq;
        this.coreMat.opacity = sq * remain;
        this.flashLight.intensity = 3.2 * this.flashScale * sq;
      }
    }

    this.shells.update(dt);
  }

  /** World-space muzzle position, for spawning tracers from the right place. */
  muzzleWorld(out: THREE.Vector3): THREE.Vector3 {
    this.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  /** FOV multiplier the world camera should be using right now. */
  worldFovMult(): number {
    const w = this.weapon;
    return 1 + (w.adsFovMult - 1) * this.adsFactor;
  }

  dispose(): void {
    this.disposeParts();
    for (const g of this.geometries) g.dispose();
    for (const m of this.materials) m.dispose();
    this.geometries.length = 0;
    this.materials.length = 0;
    this.shells.dispose();
  }
}
