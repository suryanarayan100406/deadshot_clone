/**
 * The pre-match staging room.
 *
 * A lobby whose only content is a list of names does not answer the question people
 * actually have before a match, which is *who am I about to play with*. So this is a
 * room: everyone in it stands on a lit pad, holding the weapon they picked, with their
 * name over their head and a crown on the host. You can see at a glance how many of
 * you there are, who is ready, and what you are all going to look like when the doors
 * open — because these are the same characters the match draws, from the same
 * `buildCharacter()` and posed through the same `JOINT` table and `poseWeapon()`.
 *
 * Three things this module deliberately does *not* own:
 *
 *  - **The renderer.** It exposes a scene and a camera and nothing else. `main.ts`
 *    already owns one WebGL context, one shader cache and one shadow map, and a
 *    second renderer on a second canvas would double all three to draw twelve boxy
 *    figures. Whoever is holding the renderer decides which scene gets the frame.
 *  - **Any file.** Every surface here is a Three.js primitive and every piece of text
 *    is a canvas texture, in keeping with the project's rule that it ships with no
 *    assets at all. The "crown" is a torus and four cones.
 *  - **Server truth.** It is handed a roster and told to draw it. Ready state, host,
 *    bots and team are all somebody else's decision — see `lobby.ts`.
 */

import * as THREE from 'three';
import {
  HEAD_BOX,
  MATERIALS,
  MAX_PLAYERS,
  PLAYER_HEIGHT,
  RF,
  type MatKey,
  type RosterEntry,
} from '@oneshot/shared';

import {
  JOINT,
  NEUTRAL_COLOR,
  TEAM_COLORS,
  buildCharacter,
  labelTexture,
  poseWeapon,
  type CharacterRig,
} from './actors';

/** Vertical field of view. Narrow, because a wide one bends the ends of the line. */
const FOV = 46;
/** Metres between shoulders when there is room for it. */
const SPACING = 1.18;
/** The line never grows past this, however many people are in it. */
const MAX_SPAN = 11.5;
/** How far the ends of the line come forward, as a fraction of its width. */
const ARC = 0.16;
/** Nearest and furthest the camera is ever pushed. */
const CAM_NEAR = 4.6;
const CAM_FAR = 15;
/** Eye height and the height it looks at — chest, so faces sit high in frame. */
const CAM_Y = 2.05;
const LOOK_Y = 1.12;

const PAD_R = 0.62;
const READY_PAD = 0x27502f;
const WAIT_PAD = 0x24272d;
const READY_RIM = 0x8fe0a0;
const WAIT_RIM = 0x4b515c;

/** Label colours. Green reads as "done", amber as "waiting on you". */
const CSS_READY = '#8fe0a0';
const CSS_NOT_READY = '#e2a34a';
const CSS_WAIT = '#c8cad1';
const CSS_BOT = '#8d8f97';
const CSS_SELF = '#ffffff';

/** One person in the room: a body, the pad under it, and the labels over it. */
interface Slot {
  /** Positioned by `layout()`; everything else hangs off it. */
  root: THREE.Group;
  rig: CharacterRig;
  padMat: THREE.MeshLambertMaterial;
  rimMat: THREE.MeshBasicMaterial;
  crown: THREE.Group;
  name: THREE.Sprite;
  status: THREE.Sprite;
  /** Idle animations are offset per person so nobody breathes in unison. */
  phase: number;
  /**
   * Facing, as `layout()` decided it.
   *
   * Held separately from `rig.group.rotation.y` on purpose: the idle pose adds a slow
   * sway to it every frame, so reading the yaw back off the object would fold last
   * frame's sway into this frame's base and turn a gentle shift of weight into a
   * character revolving slowly on the spot.
   */
  yaw: number;
  /* Last applied state. Labels are canvas textures, so repainting one that has not
     changed would rebuild it four times a second for as long as the lobby is open. */
  nameKey: string;
  statusKey: string;
  bodyColor: number;
  weapon: number;
  ready: boolean;
  used: boolean;
}

/**
 * Pose a character standing around waiting.
 *
 * Same skeleton as `Actor.poseAlive`, different question: there is no gait, no network
 * pitch and no crouch, but there *is* a difference between somebody who has readied up
 * and somebody who has not — the first stands square with the weapon up, the second
 * shifts their weight and lets it hang. That difference is the whole point of drawing
 * bodies instead of a list, so it is the one thing exaggerated a little.
 */
function poseIdle(rig: CharacterRig, weapon: number, t: number, ready: boolean, yaw: number): void {
  const breathe = Math.sin(t * 1.6) * 0.013;
  const shift = Math.sin(t * 0.47) * 0.03;
  const sway = Math.sin(t * 0.38 + 0.7) * 0.045;
  const nod = Math.sin(t * 0.71) * 0.03;
  const look = Math.sin(t * 0.29) * (ready ? 0.1 : 0.26);

  rig.group.rotation.set(0, yaw + sway, 0);

  rig.torso.position.set(shift * 0.5, JOINT.torsoY + breathe, 0);
  rig.torso.rotation.set(ready ? 0.01 : 0.05, 0, -shift * 0.35);
  rig.hips.position.set(shift * 0.7, JOINT.hipsY + breathe * 0.35, 0);
  rig.hips.rotation.set(0, 0, -shift * 0.5);

  rig.head.position.set(shift * 0.35, PLAYER_HEIGHT - HEAD_BOX * 0.5 + breathe * 0.6, 0);
  rig.head.rotation.set(nod, look, 0);

  const shoulderY = JOINT.shoulderY + breathe * 0.5;
  // Waiting puts the weight on one leg and turns the other foot out; ready squares up.
  rig.legL.position.set(JOINT.legX + shift * 0.15, JOINT.legHipY, 0);
  rig.legR.position.set(-JOINT.legX + shift * 0.15, JOINT.legHipY, 0);
  rig.legL.rotation.set(ready ? 0 : 0.04, ready ? 0 : 0.12, ready ? -0.02 : -0.08);
  rig.legR.rotation.set(0, 0, ready ? 0.02 : 0.04);

  if (ready) {
    rig.armR.position.set(-JOINT.armX, shoulderY, 0);
    rig.armR.rotation.set(1.22 + breathe * 1.8, -0.22, -0.12);
    rig.armL.position.set(JOINT.armX, shoulderY, 0);
    rig.armL.rotation.set(1.30 + breathe * 2.0, 0.42, 0.32);
    poseWeapon(rig, weapon, 0.02 + Math.sin(t * 1.6 + 0.4) * 0.015, 1);
  } else {
    rig.armR.position.set(-JOINT.armX, shoulderY, 0);
    rig.armR.rotation.set(0.94 + breathe * 1.5, -0.18, -0.10);
    rig.armL.position.set(JOINT.armX, shoulderY, 0);
    rig.armL.rotation.set(1.08 + breathe * 1.8, 0.36, 0.26);
    poseWeapon(rig, weapon, -0.24 + Math.sin(t * 1.6 + 0.4) * 0.02, 1);
  }
}

export class LobbyStage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 120);

  private slots: Slot[] = [];
  private shadows: boolean;
  private aspect = 16 / 9;
  /** How many slots `layout()` last placed — the rest are hidden, not destroyed. */
  private count = 0;
  private selfId = -1;
  /** Where the camera is parked, before the slow drift is added. */
  private camZ = CAM_NEAR;

  /** Shared across every slot, so twelve pads are two geometries, not twenty-four. */
  private padGeo = new THREE.CylinderGeometry(PAD_R, PAD_R * 0.94, 0.06, 28);
  private rimGeo = new THREE.TorusGeometry(PAD_R, 0.022, 6, 36);
  private crownBandGeo = new THREE.TorusGeometry(0.115, 0.022, 6, 16);
  private crownSpikeGeo = new THREE.ConeGeometry(0.032, 0.1, 6);
  private crownMat = new THREE.MeshPhongMaterial({
    color: 0xf2c14e,
    specular: 0xfff0c0,
    shininess: 60,
  });
  /** The one light whose shadow costs anything, kept so the setting can turn it off. */
  private keyLight: THREE.DirectionalLight | null = null;
  /** Everything built once for the room, freed together. */
  private owned: THREE.BufferGeometry[] = [];
  private ownedMats: THREE.Material[] = [];

  constructor(shadows: boolean) {
    this.shadows = shadows;
    this.scene.background = new THREE.Color(0x0c0e12);
    // Close fog: the bay should end in darkness rather than in a visible wall join.
    this.scene.fog = new THREE.Fog(0x0c0e12, 12, 34);
    this.buildRoom();
    this.buildLights();
    this.camera.rotation.order = 'YXZ';
    this.layout();
  }

  /* ── Room ─────────────────────────────────────────────────────────────── */

  /**
   * A hangar bay, built out of boxes and cylinders.
   *
   * The map palette is reused rather than reinvented so the room looks like it belongs
   * to the same game as the map behind the menu. Nothing in here is collidable and
   * nothing needs to be: no player is ever simulated in this scene.
   */
  private buildRoom(): void {
    const mats = new Map<MatKey, THREE.MeshLambertMaterial>();
    const mat = (key: MatKey): THREE.MeshLambertMaterial => {
      const hit = mats.get(key);
      if (hit) return hit;
      const made = new THREE.MeshLambertMaterial({ color: MATERIALS[key].color });
      mats.set(key, made);
      this.ownedMats.push(made);
      return made;
    };

    /** A box, positioned by its footprint centre and its *bottom* — as map brushes are. */
    const slab = (
      x: number,
      y: number,
      z: number,
      sx: number,
      sy: number,
      sz: number,
      key: MatKey,
      receive = false,
    ): THREE.Mesh => {
      const g = new THREE.BoxGeometry(sx, sy, sz);
      this.owned.push(g);
      const m = new THREE.Mesh(g, mat(key));
      m.position.set(x, y + sy / 2, z);
      m.receiveShadow = receive && this.shadows;
      this.scene.add(m);
      return m;
    };

    /** A cylinder along one axis. Pipes, barrels, tanks, lamp housings. */
    const tube = (
      x: number,
      y: number,
      z: number,
      r: number,
      len: number,
      key: MatKey,
      axis: 'x' | 'y' | 'z' = 'y',
    ): THREE.Mesh => {
      const g = new THREE.CylinderGeometry(r, r, len, 14);
      this.owned.push(g);
      const m = new THREE.Mesh(g, mat(key));
      m.position.set(x, y, z);
      if (axis === 'x') m.rotation.z = Math.PI / 2;
      else if (axis === 'z') m.rotation.x = Math.PI / 2;
      this.scene.add(m);
      return m;
    };

    // Floor, and a darker painted band the line stands on.
    slab(0, -0.4, 2, 34, 0.4, 30, 'concrete', true);
    slab(0, 0, 0, 26, 0.012, 4.2, 'concreteDark');
    // Hazard stripes at the front edge of the band — four short blocks, not a texture.
    for (let i = -5; i <= 5; i++) slab(i * 1.5, 0.012, 2.35, 0.62, 0.01, 0.16, 'accent');

    // Shell: back wall, sides, ceiling.
    slab(0, 0, -7.2, 34, 8.4, 0.6, 'concreteDark');
    slab(-14, 0, 2, 0.6, 8.4, 30, 'concreteDark');
    slab(14, 0, 2, 0.6, 8.4, 30, 'concreteDark');
    slab(0, 7.6, 2, 34, 0.5, 30, 'concreteDark');

    // Wall structure: pilasters, a mid rail, and a service catwalk above the line.
    for (const x of [-9.5, -4.6, 4.6, 9.5]) slab(x, 0, -6.8, 0.7, 7.6, 0.28, 'concrete');
    slab(0, 3.5, -6.75, 30, 0.22, 0.34, 'metal');
    slab(0, 5.1, -5.6, 26, 0.18, 1.9, 'metal');
    for (let i = -6; i <= 6; i++) slab(i * 2, 5.28, -5.6, 0.09, 0.9, 0.09, 'metal');
    slab(0, 6.18, -4.72, 26, 0.1, 0.12, 'metal');

    // Roof trusses and pipe runs — the "look up and it keeps going" layer.
    for (let i = 0; i < 7; i++) {
      const z = -6 + i * 2.1;
      slab(0, 6.7, z, 32, 0.26, 0.22, 'metal');
      slab(0, 6.4, z, 0.5, 0.3, 0.22, 'rust');
    }
    for (const [x, r] of [
      [-11.2, 0.22],
      [-10.6, 0.13],
      [11.2, 0.22],
      [10.7, 0.15],
    ] as const) {
      tube(x, 6.2, 2, r, 30, 'rust', 'z');
    }
    tube(0, 7.05, -3.4, 0.16, 32, 'metal', 'x');

    // Lights: a housing and a bright face. No point lights — the face is what sells it,
    // and the key light below is doing the actual work.
    const lampMat = new THREE.MeshBasicMaterial({ color: 0xe8eef6 });
    this.ownedMats.push(lampMat);
    for (const z of [-3.6, 0.4, 4.4]) {
      slab(0, 6.05, z, 9, 0.3, 0.5, 'metal');
      const g = new THREE.BoxGeometry(8.4, 0.06, 0.34);
      this.owned.push(g);
      const face = new THREE.Mesh(g, lampMat);
      face.position.set(0, 6.02, z);
      this.scene.add(face);
    }

    // Back wall: lockers, a control window, cable conduit.
    for (let i = 0; i < 8; i++) {
      const x = -12.4 + i * 0.86;
      slab(x, 0, -6.4, 0.8, 2.05, 0.5, 'metal');
      slab(x + 0.3, 1.55, -6.14, 0.12, 0.05, 0.03, 'accent');
    }
    slab(8.6, 2.3, -6.5, 5.4, 2.1, 0.35, 'metal');
    slab(8.6, 2.55, -6.32, 5, 1.5, 0.06, 'glass');
    for (const y of [4.2, 4.42]) tube(-2, y, -6.5, 0.07, 12, 'accent', 'x');

    // Ground clutter, kept behind and beside the line so it never crowds a face.
    const crate = (x: number, z: number, s: number, key: MatKey): void => {
      slab(x, 0, z, s, s * 0.82, s * 0.9, key);
      slab(x, s * 0.82, z, s * 0.7, s * 0.1, s * 0.64, 'metal');
    };
    crate(-11.4, -1.4, 1.5, 'wood');
    crate(-10.2, -2.6, 1.2, 'rust');
    crate(11.6, -1.1, 1.6, 'rust');
    crate(10.4, -2.8, 1.1, 'wood');
    for (const [x, z] of [
      [-12.6, 1.2],
      [-12.1, 2.4],
      [12.4, 1.6],
      [12.9, 2.9],
      [12.2, -3.6],
    ] as const) {
      tube(x, 0.44, z, 0.29, 0.88, 'rust');
      tube(x, 0.89, z, 0.3, 0.05, 'metal');
    }
    // A stack of pipe on the left, chocked so it does not read as floating.
    for (let i = 0; i < 3; i++) tube(-8.4 + i * 0.62, 0.3, -5.4, 0.3, 3.2, 'metal', 'x');
    for (let i = 0; i < 2; i++) tube(-8.1 + i * 0.62, 0.88, -5.4, 0.3, 3.2, 'metal', 'x');
  }

  private buildLights(): void {
    // Cool ambient from the roof, warm bounce off the concrete.
    this.scene.add(new THREE.HemisphereLight(0x9fb4cc, 0x3d3630, 0.62));

    const key = new THREE.DirectionalLight(0xfff2dc, 1.15);
    key.position.set(5.5, 8.5, 7.5);
    key.castShadow = this.shadows;
    key.shadow.mapSize.set(1024, 1024);
    const c = key.shadow.camera;
    c.left = -10;
    c.right = 10;
    c.top = 7;
    c.bottom = -2;
    c.near = 1;
    c.far = 34;
    c.updateProjectionMatrix();
    key.shadow.bias = -0.0012;
    this.keyLight = key;
    this.scene.add(key);

    // Rim light from behind, so a dark silhouette still separates from a dark wall.
    const rim = new THREE.DirectionalLight(0x7fa8d8, 0.5);
    rim.position.set(-6, 4.5, -7);
    this.scene.add(rim);
  }

  /* ── Slots ────────────────────────────────────────────────────────────── */

  /**
   * Grow the pool to `n` people.
   *
   * Rigs are built once and reused: a roster arrives four times a second, and sixty
   * boxes per character is not something to allocate on a packet. Slots past the
   * current count are hidden rather than freed for the same reason — somebody leaving
   * and rejoining is the common case, not the rare one.
   */
  private ensure(n: number): void {
    while (this.slots.length < n && this.slots.length < MAX_PLAYERS) {
      const root = new THREE.Group();
      const rig = buildCharacter(this.shadows);
      root.add(rig.group);

      const padMat = new THREE.MeshLambertMaterial({ color: WAIT_PAD });
      const pad = new THREE.Mesh(this.padGeo, padMat);
      pad.position.y = 0.03;
      pad.receiveShadow = this.shadows;
      root.add(pad);

      const rimMat = new THREE.MeshBasicMaterial({ color: WAIT_RIM });
      const rim = new THREE.Mesh(this.rimGeo, rimMat);
      rim.rotation.x = Math.PI / 2;
      rim.position.y = 0.062;
      root.add(rim);

      const crown = this.buildCrown();
      crown.position.y = PLAYER_HEIGHT + 0.13;
      crown.visible = false;
      root.add(crown);

      const name = this.buildSprite();
      name.position.y = PLAYER_HEIGHT + 0.3;
      root.add(name);

      const status = this.buildSprite();
      status.position.y = PLAYER_HEIGHT + 0.54;
      root.add(status);

      root.visible = false;
      this.scene.add(root);

      this.slots.push({
        root,
        rig,
        padMat,
        rimMat,
        crown,
        name,
        status,
        // Irrational-ish stride so the offsets do not land back in phase.
        phase: this.slots.length * 2.399,
        yaw: Math.PI,
        nameKey: '',
        statusKey: '',
        bodyColor: -1,
        weapon: -1,
        ready: false,
        used: false,
      });
    }
  }

  /**
   * The host's crown: a ring and four points, in gold.
   *
   * A canvas icon would have been fewer lines, but a flat badge among solid bodies
   * looks like a mistake, and this is the one marker that has to be legible from any
   * angle without reading a word of it.
   */
  private buildCrown(): THREE.Group {
    const g = new THREE.Group();
    const ring = new THREE.Mesh(this.crownBandGeo, this.crownMat);
    ring.rotation.x = Math.PI / 2;
    g.add(ring);

    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const point = new THREE.Mesh(this.crownSpikeGeo, this.crownMat);
      point.position.set(Math.cos(a) * 0.115, 0.055, Math.sin(a) * 0.115);
      g.add(point);
    }
    return g;
  }

  private buildSprite(): THREE.Sprite {
    const m = new THREE.SpriteMaterial({
      transparent: true,
      depthTest: true,
      depthWrite: false,
      fog: false,
    });
    this.ownedMats.push(m);
    const s = new THREE.Sprite(m);
    s.center.set(0.5, 0);
    s.visible = false;
    return s;
  }

  /** Point a sprite at a piece of text, skipping the repaint when nothing changed. */
  private setSprite(sprite: THREE.Sprite, text: string, css: string, height: number): void {
    const mat = sprite.material as THREE.SpriteMaterial;
    if (!text) {
      sprite.visible = false;
      return;
    }
    sprite.visible = true;
    const tex = labelTexture(text, css);
    mat.map = tex;
    mat.needsUpdate = true;
    const img = tex.image as HTMLCanvasElement;
    sprite.scale.set((img.width / img.height) * height, height, 1);
  }

  /* ── Server state ─────────────────────────────────────────────────────── */

  setSelf(id: number): void {
    this.selfId = id;
  }

  setShadows(on: boolean): void {
    if (on === this.shadows) return;
    this.shadows = on;
    // Only the bodies cast: the room is static and its shadows would be baked into a
    // texture in any other project, and the pads sit flat on the floor where a
    // shadow of them would be invisible anyway.
    for (const slot of this.slots) {
      slot.rig.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.castShadow = on;
      });
    }
    if (this.keyLight) this.keyLight.castShadow = on;
  }

  /**
   * Draw this roster.
   *
   * Order is stable — team then id — so nobody swaps places on the pad because a
   * packet arrived. In team modes that also groups the two sides, which is the only
   * way to read a team lobby at a glance.
   */
  setRoster(entries: readonly RosterEntry[], teamMode: boolean, hostId: number): void {
    const rows = [...entries]
      .sort((a, b) => (teamMode ? a.team - b.team : 0) || a.id - b.id)
      .slice(0, MAX_PLAYERS);
    this.ensure(rows.length);

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      const row = rows[i];
      if (!row) {
        slot.used = false;
        slot.root.visible = false;
        continue;
      }

      const bot = (row.flags & RF.BOT) !== 0;
      const ready = (row.flags & RF.READY) !== 0;
      const isSelf = row.id === this.selfId;
      slot.used = true;
      slot.root.visible = true;
      slot.ready = ready;

      // Team colour if there are sides, otherwise the neutral suit. Bots stay neutral
      // and grey-labelled: a lobby that dresses filler up as people is lying to you.
      const color = teamMode && !bot ? (TEAM_COLORS[row.team] ?? NEUTRAL_COLOR) : NEUTRAL_COLOR;
      if (color !== slot.bodyColor) {
        slot.bodyColor = color;
        slot.rig.bodyMat.color.setHex(color);
      }

      if (row.weapon !== slot.weapon) slot.weapon = row.weapon;

      const nameCss = isSelf ? CSS_SELF : bot ? CSS_BOT : teamMode ? cssOf(color) : CSS_WAIT;
      const nameText = isSelf ? `${row.name} (you)` : row.name;
      const nameKey = `${nameText}|${nameCss}`;
      if (nameKey !== slot.nameKey) {
        slot.nameKey = nameKey;
        this.setSprite(slot.name, nameText, nameCss, 0.17);
      }

      const statusText = bot ? 'BOT' : ready ? 'READY' : 'NOT READY';
      const statusCss = bot ? CSS_BOT : ready ? CSS_READY : CSS_NOT_READY;
      const statusKey = `${statusText}|${statusCss}`;
      if (statusKey !== slot.statusKey) {
        slot.statusKey = statusKey;
        this.setSprite(slot.status, statusText, statusCss, 0.13);
      }

      slot.padMat.color.setHex(ready ? READY_PAD : WAIT_PAD);
      slot.rimMat.color.setHex(ready ? READY_RIM : WAIT_RIM);
      slot.crown.visible = !bot && row.id === hostId;
    }

    if (rows.length !== this.count) {
      this.count = rows.length;
      this.layout();
    }
  }

  /** Nobody in the room. Bodies stay built; they are simply not drawn. */
  clear(): void {
    for (const s of this.slots) {
      s.used = false;
      s.root.visible = false;
      s.nameKey = '';
      s.statusKey = '';
    }
    this.count = 0;
  }

  /* ── Layout ───────────────────────────────────────────────────────────── */

  resize(aspect: number): void {
    if (!(aspect > 0) || aspect === this.aspect) return;
    this.aspect = aspect;
    this.layout();
  }

  /**
   * Place the line and pull the camera back far enough to hold it.
   *
   * Derived from the aspect rather than fixed, because a line that fits on a desktop
   * runs off both sides of a phone — and a lobby whose ends are cropped is worse than
   * a lobby drawn small, since the cropped players are invisible rather than distant.
   */
  private layout(): void {
    const n = this.count;
    const span = Math.min(MAX_SPAN, SPACING * Math.max(0, n - 1));
    const arc = span * ARC;

    const halfFov = ((FOV / 2) * Math.PI) / 180;
    // Half the width the camera can see at one metre, plus a margin for the body at
    // each end and the nameplate hanging off it.
    const perMetre = Math.tan(halfFov) * this.aspect;
    const needWide = (span / 2 + 1.15) / Math.max(0.2, perMetre);
    const needTall = 1.5 / Math.tan(halfFov);
    this.camZ = Math.min(CAM_FAR, Math.max(CAM_NEAR, Math.max(needWide, needTall) + arc));

    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i]!;
      if (i >= n) continue;
      // -0.5 … +0.5 across the line, and 0 when there is only one of you.
      const t = n > 1 ? i / (n - 1) - 0.5 : 0;
      const x = t * span;
      // The ends step forward, so a full lobby curls around the camera instead of
      // running away to either side.
      const z = Math.abs(t) * 2 * arc;
      slot.root.position.set(x, 0, z);
      // Everyone turns to face the lens. Yaw 0 looks down -Z, so this is the yaw whose
      // forward vector points at the camera — see `dirFromAngles` in shared.
      slot.yaw = Math.atan2(x, z - this.camZ);
      slot.rig.group.rotation.y = slot.yaw;
    }

    this.camera.aspect = this.aspect;
    this.camera.updateProjectionMatrix();
  }

  /* ── Frame ────────────────────────────────────────────────────────────── */

  /**
   * Animate. Called at the menu's framerate, not the match's — nothing in here is
   * worth a discrete GPU spinning up.
   */
  update(dt: number, nowLocal: number): void {
    const t = nowLocal / 1000;

    for (const slot of this.slots) {
      if (!slot.used) continue;
      poseIdle(slot.rig, slot.weapon, t + slot.phase, slot.ready, slot.yaw);
      if (slot.crown.visible) {
        slot.crown.rotation.y += dt * 0.6;
        slot.crown.position.y = PLAYER_HEIGHT + 0.13 + Math.sin(t * 1.3) * 0.012;
      }
    }

    // A slow drift, so a still room does not look like a paused one.
    const drift = Math.sin(t * 0.11);
    this.camera.position.set(drift * 0.5, CAM_Y + Math.sin(t * 0.17) * 0.05, this.camZ);
    this.camera.lookAt(drift * 0.18, LOOK_Y, 0);
  }

  dispose(): void {
    for (const slot of this.slots) slot.rig.dispose();
    this.slots.length = 0;
    for (const g of this.owned) g.dispose();
    this.owned.length = 0;
    for (const m of this.ownedMats) m.dispose();
    this.ownedMats.length = 0;
    this.padGeo.dispose();
    this.rimGeo.dispose();
    this.crownBandGeo.dispose();
    this.crownSpikeGeo.dispose();
    this.crownMat.dispose();
  }
}

/** `0xrrggbb` as the CSS the label canvas wants. */
function cssOf(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}
