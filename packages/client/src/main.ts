/**
 * Client entry point — the one place every subsystem meets.
 *
 * Everything else in `src/` is deliberately passive: the HUD writes DOM, the
 * predictor steps the movement model, the net layer moves bytes. None of them
 * know about each other. This file owns the clock, and it is the only file that
 * does, which is why the ordering below is written out rather than implied.
 *
 * ── Frame shape ───────────────────────────────────────────────────────────────
 *
 *   1. mouse look, once per *rendered* frame (never quantised to the tick rate)
 *   2. zero or more fixed 60 Hz simulation steps
 *   3. one input packet, carrying the newest unacknowledged commands
 *   4. visual smoothing, animation, interpolation
 *   5. two render passes: the world, then the gun over a cleared depth buffer
 *
 * Look is sampled *before* the fixed steps so a command always carries the
 * freshest angles available. Rendering happens after, so what you see is the
 * result of what you just did.
 *
 * ── Prediction parity ─────────────────────────────────────────────────────────
 *
 * The server is authoritative, so anything the client predicts has to be
 * predicted *the same way*, not merely a similar way. Three things are mirrored
 * here from `server/src/room.ts` and `server/src/player.ts` on purpose:
 *
 *   • **Per-tick ordering.** Angles, then movement, then combat decay, then the
 *     weapon. `speedMult()` is therefore asked for a value derived from the
 *     *previous* tick's aim state — exactly as the server does it. Getting this
 *     backwards produces a drift that only shows up while aiming and walking,
 *     which is the worst possible time to notice it.
 *   • **The aim-down-sights integrator.** `predAds` is a separate value from
 *     `viewModel.adsFactor`. The view model ramps linearly because that looks
 *     right; the server uses a first-order lag. Only `predAds` is allowed near
 *     the movement code.
 *   • **The spread model.** Replicated so the crosshair is an honest readout of
 *     the cone the server will actually roll inside, rather than a decoration
 *     that happens to grow when you shoot.
 *
 * ── Firing ────────────────────────────────────────────────────────────────────
 *
 * `EV.SHOT` from the server is the source of truth for every visual. Local
 * prediction exists only to get there first: it fires the flash, the report and
 * the tracer immediately, then counts the shot as pending. The server's
 * confirmation cancels one pending shot and draws nothing, so a predicted shot
 * is seen once. A shot the client *didn't* predict still plays in full, so no
 * bullet is ever silent — and an unconfirmed shot expires, so a refused one
 * cannot leave the magazine reading low forever.
 *
 * Recoil is added to the outgoing command, not just to the camera. The server
 * derives shot direction from the angles we report, so a camera-only kick would
 * make recoil pure theatre — you would shoot where the gun used to be pointing.
 */

import * as THREE from 'three';
import {
  AF,
  BTN,
  DEFAULT_LOADOUT,
  EV,
  LOBBY_ACT,
  MAPS,
  MAX_HEALTH,
  MAX_PLAYERS,
  MODE,
  MODE_NAMES,
  PITCH_LIMIT,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  SPEED_WALK,
  TEAM_A,
  TEAM_B,
  TEAM_NONE,
  TICK_DT,
  TICK_MS,
  WEAPON_BY_KEY,
  clamp,
  cycleTime,
  dirFromAngles,
  makeHitbox,
  mapById,
  mapColliders,
  raycastWorld,
  traceShot,
  v3,
  weaponById,
  wrapAngle,
  writeHitboxes,
  type Box,
  type GameEvent,
  type GameMap,
  type Hitbox,
  type LobbyMsg,
  type MatchMsg,
  type RosterEntry,
  type Snapshot,
  type Vec3,
  type WelcomeMsg,
} from '@oneshot/shared';

import './styles.css';

import { ActorPool } from './actors';
import { AudioEngine } from './audio';
import { Effects } from './effects';
import { Hud } from './hud';
import { InputManager } from './input';
import { LobbyScreen } from './lobby';
import { Menu, type PlayConfig } from './menu';
import { Net, type NetStatus } from './net';
import { Predictor } from './predict';
import { SettingsStore, type Settings } from './settings';
import { ViewModel } from './viewmodel';
import { World } from './world';

/** How long a predicted shot waits for its confirmation before being written off. */
const SHOT_CONFIRM_MS = 900;
/** Predicted shots in flight at once. Two full seconds of the fastest weapon. */
const SHOT_QUEUE = 32;
/** A local reload suppresses the server's `EV.RELOAD` echo for this long. */
const RELOAD_ECHO_MS = 700;
/** Longest simulation catch-up after a stall, in ticks. */
const MAX_CATCHUP = 8;
/** Metres of ground travel between footsteps, walking and sprinting. */
const STRIDE_WALK = 2.15;
const STRIDE_SPRINT = 1.85;
/** Menu backdrop framerate — the 3D scene behind the menu is not the point. */
const MENU_FPS = 30;
/** Menu player-count poll. */
const ONLINE_POLL_MS = 20_000;

type Phase = 'menu' | 'connecting' | 'playing';

function chatName(name: string): string {
  return name || 'player';
}

class Game {
  /* ── Rendering ────────────────────────────────────────────────────────── */

  private canvas = document.getElementById('view') as HTMLCanvasElement | null;
  private renderer: THREE.WebGLRenderer;
  private camera: THREE.PerspectiveCamera;
  /** Reused for one-off camera-direction queries, so they allocate nothing. */
  private aimScratch = new THREE.Vector3();

  /* ── Subsystems ───────────────────────────────────────────────────────── */

  private settings = new SettingsStore();
  private world: World;
  private actors: ActorPool;
  private effects = new Effects();
  private viewModel: ViewModel;
  private hud: Hud;
  private input: InputManager;
  private audio: AudioEngine;
  private net: Net;
  private predictor: Predictor;
  private menu: Menu;
  private lobby: LobbyScreen;

  /* ── Session ──────────────────────────────────────────────────────────── */

  private phase: Phase = 'menu';
  private selfId = -1;
  private myName = '';
  private myTeam = TEAM_NONE;
  private mode: number = MODE.FFA;
  private teamMode = false;
  private room = 'main';
  private loadout: number[] = [0, 4, 5];
  private activeSlot = 0;
  private colliders: readonly Box[] = [];

  /* ── Authoritative state, last seen ───────────────────────────────────── */

  private alive = false;
  private health = MAX_HEALTH;
  private serverMag = 0;
  private serverReserve = 0;
  private serverWeapon = -1;
  private reloadLeft = 0;
  private respawnIn = 0;
  private matchOver = false;
  private roster: RosterEntry[] = [];
  private names = new Map<number, string>();

  /* ── Prediction, mirrored from the server's own model ─────────────────── */

  /** Server-shaped aim-down-sights value. Feeds movement, never the camera. */
  private predAds = 0;
  /** Server-shaped accumulated spread from firing. */
  private predSpread = 0;
  private prevButtons = 0;
  private lastButtons = 0;
  private nextLocalFireAt = 0;
  private reloadPredictUntil = 0;
  private reloadEchoUntil = 0;
  /** Slot we have asked the server for but not yet seen confirmed. */
  private switchWantId = -1;
  private switchSentAt = 0;
  private respawnSentAt = 0;

  /** Ring of predicted-shot timestamps awaiting confirmation. */
  private shotAt = new Float64Array(SHOT_QUEUE);
  private shotHead = 0;
  private shotTail = 0;

  /* ── Loop ─────────────────────────────────────────────────────────────── */

  private raf = 0;
  private lastFrame = 0;
  private accum = 0;
  private nextRenderAt = 0;
  private fps = 0;
  private stepDist = 0;

  /* ── Settings actually pushed into the renderer ───────────────────────── */

  private appliedResolution = -1;
  private appliedShadows = -1;
  private appliedFov = -1;

  /* ── Scratch. Allocated once; the frame loop must not create garbage. ── */

  private eye: Vec3 = v3();
  private aim: Vec3 = v3();
  private hitboxPool: Hitbox[] = Array.from({ length: MAX_PLAYERS * 2 }, () => makeHitbox());
  private hitboxLive: Hitbox[] = [];
  private onTarget = false;

  constructor() {
    if (!this.canvas) throw new Error('main: missing <canvas id="view"> in the document');

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    // Two passes share one frame, so clearing is done by hand between them.
    this.renderer.autoClear = false;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    const s = this.settings.values;

    // Far plane clears the sky dome's 400 m radius; `YXZ` makes the Euler
    // triple mean (pitch, yaw, roll), which is what the shared angle
    // convention assumes.
    this.camera = new THREE.PerspectiveCamera(s.fov, 1, 0.05, 600);
    this.camera.rotation.order = 'YXZ';

    this.world = new World({ shadows: s.shadows });
    this.actors = new ActorPool(s.shadows > 0);
    this.viewModel = new ViewModel(s.fov);
    this.hud = new Hud(this.settings);
    // The floating damage numbers are anchored to points in the world, so the HUD
    // needs to project through the live camera. The scratch vector is captured by
    // the closure rather than reallocated, so the per-frame pass allocates
    // nothing; the camera is read through `this`, so a later camera swap follows.
    const ndc = new THREE.Vector3();
    this.hud.setProjector((x, y, z, out) => {
      ndc.set(x, y, z).project(this.camera);
      // Behind the camera the divide is by a negative w, which mirrors the point
      // to a plausible-looking but wrong place on screen. `z > 1` is the tell.
      if (ndc.z > 1) return false;
      out.x = ndc.x * 0.5 + 0.5;
      out.y = 0.5 - ndc.y * 0.5;
      return true;
    });
    this.input = new InputManager(this.canvas, this.settings);
    this.audio = new AudioEngine(this.settings);

    // Actors and effects are Groups, and `World.clear()` only unhooks meshes, so
    // they survive a map change without being re-parented.
    this.world.scene.add(this.actors.root);
    this.world.scene.add(this.effects.root);

    this.net = new Net({
      onWelcome: (m) => this.onWelcome(m),
      onSnapshot: (snap) => this.onSnapshot(snap),
      onRoster: (r) => this.onRoster(r),
      onMatch: (m) => this.onMatch(m),
      onLobby: (m) => this.onLobby(m),
      onStatus: (st, detail) => this.onStatus(st, detail),
    });

    this.predictor = new Predictor({
      // Asked once per tick from inside `Predictor.tick`, before this tick's
      // buttons have been folded in — matching the server's ordering.
      speedMult: () => {
        const w = this.viewModel.currentWeapon;
        return w.moveMult + (w.adsMoveMult - w.moveMult) * this.predAds;
      },
    });

    this.menu = new Menu(this.settings, {
      onPlay: (cfg) => this.startMatch(cfg),
      onResume: () => this.resume(),
      onQuit: () => this.quit(),
    });

    this.lobby = new LobbyScreen(
      {
        onStart: () => this.net.sendLobby(LOBBY_ACT.START),
        onBots: (on) => this.net.sendLobby(LOBBY_ACT.BOTS, on ? 1 : 0),
        onMap: (mapId) => this.net.sendLobby(LOBBY_ACT.MAP, mapId),
        onReady: () => this.net.sendLobby(LOBBY_ACT.READY),
        onLeave: () => this.quit(),
        // The screen owns no input state; it only says when it is up, and the
        // pointer lock is decided in one place — here — as it is for chat and the
        // pause menu. The HUD goes with it: a crosshair floating over the staging
        // room is the kind of detail that reads as unfinished.
        onVisibility: (open) => {
          if (open) this.input.releaseLock();
          else this.relock();
          if (this.phase === 'playing') this.hud.setVisible(!open);
        },
        onToast: (text, kind) => this.hud.toast(text, kind),
      },
      s.shadows > 0,
    );

    this.bindInput();
    this.bindChat();
    this.bindWindow();

    this.settings.onChange((next) => this.applySettings(next));

    // One map in M1, preloaded so pressing Play never waits on geometry.
    this.loadMap(MAPS[0]!);
    this.applySettings(s);
    this.resize();

    this.hud.hideLoading();
    void this.pollOnline();
    window.setInterval(() => void this.pollOnline(), ONLINE_POLL_MS);

    this.lastFrame = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Wiring
     ═══════════════════════════════════════════════════════════════════════ */

  private bindInput(): void {
    this.input.setHandlers({
      onEscape: () => this.onEscape(),
      onChatKey: () => this.openChat(),
      onLockChange: (locked) => this.onLockChange(locked),
    });

    // Clicking the view re-acquires the lock. Browsers refuse a lock request
    // that is not tied to a gesture, and the request made when the match began
    // was a whole round-trip ago — this is the reliable path back in.
    this.canvas!.addEventListener('mousedown', () => {
      if (this.phase !== 'playing') return;
      if (this.menu.anyModalOpen || this.hud.chatOpen || this.lobby.open) return;
      if (!this.input.locked) this.input.requestLock();
    });
  }

  private bindChat(): void {
    // `input.ts` routes Escape to us before it checks whether a text field has
    // the keyboard, so these two keys stop here rather than bubbling to the
    // window listener and being handled a second time.
    this.hud.chatElement.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        const text = this.hud.chatText;
        this.closeChat();
        if (text) this.net.sendChat(text);
        this.relock();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.closeChat();
        this.relock();
      }
    });
  }

  private bindWindow(): void {
    window.addEventListener('resize', () => this.resize());
    // A tab switch stops `requestAnimationFrame`; drop the accumulated time so
    // coming back does not fire a burst of catch-up ticks against stale input.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        this.accum = 0;
        // Not while the lobby is up: the clock is pinned there, so there is
        // nothing to be away from, and pausing would bury the roster.
        if (this.phase === 'playing' && !this.menu.anyModalOpen && !this.lobby.open) {
          this.menu.openPause();
        }
      } else {
        this.lastFrame = performance.now();
      }
    });
    window.addEventListener('beforeunload', () => this.net.disconnect());
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Settings
     ═══════════════════════════════════════════════════════════════════════ */

  private applySettings(s: Settings): void {
    if (s.resolution !== this.appliedResolution) {
      this.appliedResolution = s.resolution;
      this.resize();
    }
    if (s.shadows !== this.appliedShadows) {
      this.appliedShadows = s.shadows;
      this.world.setShadowQuality(s.shadows);
      this.actors.setShadows(s.shadows > 0);
      this.lobby.setShadows(s.shadows > 0);
      this.renderer.shadowMap.enabled = s.shadows > 0;
    }
    if (s.fov !== this.appliedFov) {
      this.appliedFov = s.fov;
      this.viewModel.setFov(s.fov);
    }
    this.viewModel.setVisible(s.viewmodel);
    this.effects.setEnabled(s.particles);
  }

  private resize(): void {
    const w = Math.max(1, window.innerWidth);
    const h = Math.max(1, window.innerHeight);
    const scale = clamp(this.settings.get('resolution'), 0.5, 1);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    // The stylesheet owns the canvas's layout size, so `updateStyle` is false —
    // letting the renderer write inline width/height would fight the CSS.
    this.renderer.setPixelRatio(dpr * scale);
    this.renderer.setSize(w, h, false);

    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewModel.resize(w / h);
    // The staging room derives its camera distance from the aspect rather than
    // just its FOV: a line of twelve people that fits on a desktop runs off both
    // sides of a phone, and a lobby with its ends cropped is worse than one drawn
    // small.
    this.lobby.resize(w / h);
    // CSS pixels, not the drawing buffer: the HUD is DOM laid out over the canvas.
    this.hud.setViewport(w, h);
    // Point sprites are sized in device pixels, so the particle shader needs the
    // drawing buffer's height, not the CSS height — and the FOV alongside it, so
    // the term is correct before the first frame rather than after the first time
    // the player aims (`setCameraFov` only pushes a value when one changes).
    this.effects.setViewportHeight(this.canvas!.height || h);
    this.effects.setCameraFov(this.camera.fov);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Map
     ═══════════════════════════════════════════════════════════════════════ */

  private loadMap(map: GameMap): void {
    this.world.load(map, this.settings.get('shadows'));
    this.colliders = mapColliders(map);
    this.predictor.setWorld(this.colliders);
    this.hud.setMapHalf(map.half);
    this.effects.clear();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Match lifecycle
     ═══════════════════════════════════════════════════════════════════════ */

  private startMatch(cfg: PlayConfig): void {
    if (this.phase !== 'menu') return;

    // Browsers only let an AudioContext start from a gesture, and this call is
    // inside the Play click.
    this.audio.unlock();
    this.audio.ui('click');

    this.myName = cfg.name;
    this.mode = cfg.mode === 1 ? MODE.TDM : MODE.FFA;
    this.teamMode = this.mode === MODE.TDM;
    // Cleared rather than carried: joining a party adopts *its* mode, so a code
    // typed while Team Deathmatch was selected can land in a free-for-all and vice
    // versa. Leaving last match's team in place would tint this one's players by a
    // side that no longer exists until the first snapshot corrected it.
    this.myTeam = TEAM_NONE;

    const primary = WEAPON_BY_KEY[cfg.primary] ?? WEAPON_BY_KEY['ranger']!;
    const secondary = WEAPON_BY_KEY[DEFAULT_LOADOUT[1]]!;
    const melee = WEAPON_BY_KEY[DEFAULT_LOADOUT[2]]!;
    this.loadout = [primary.id, secondary.id, melee.id];
    this.activeSlot = 0;

    this.phase = 'connecting';
    // An empty room asks the server for any lobby with space; a party code asks
    // for that specific one. This used to send a hardcoded `'main'`, which is a
    // *named* room as far as the server is concerned — so every player in the
    // world shared one 12-slot lobby, the auto-lobby overflow path never ran, and
    // the thirteenth player was simply refused the connection.
    this.net.connect({ name: cfg.name, primary: cfg.primary, mode: this.mode, room: cfg.room });
  }

  private onWelcome(m: WelcomeMsg): void {
    this.selfId = m.id;
    this.room = m.room;
    this.mode = m.mode;
    this.teamMode = m.mode === MODE.TDM;

    const map = mapById(m.mapId) ?? MAPS[0]!;
    if (this.world.currentMap?.id !== map.id) this.loadMap(map);

    this.hud.setSelfId(m.id);
    this.hud.setContext(m.mode, m.room, map.name);
    this.lobby.setContext(m.mode, map.name, m.room, m.id, map.id);
    this.actors.setContext(this.myTeam, this.teamMode);
    this.names.set(m.id, this.myName);

    this.viewModel.setWeapon(this.loadout[0]!);
    this.serverWeapon = this.loadout[0]!;
    this.hud.setSlots(this.loadout, 0);

    // Stay on the menu until the first snapshot lands: entering now would show
    // one frame of a player standing at the origin before the spawn arrives.
    this.menu.setPlayEnabled(false, 'Joining…');
  }

  /** Called from the first snapshot, once we know where we actually are. */
  private enterPlaying(): void {
    this.phase = 'playing';
    this.matchOver = false;
    this.accum = 0;
    this.stepDist = 0;
    this.predAds = 0;
    this.predSpread = 0;
    this.prevButtons = 0;
    this.lastButtons = 0;
    this.shotHead = 0;
    this.shotTail = 0;
    this.nextLocalFireAt = 0;
    this.reloadPredictUntil = 0;
    this.reloadEchoUntil = 0;
    this.switchWantId = -1;
    this.lastFrame = performance.now();

    this.menu.hide();
    this.menu.setPlayEnabled(true);
    this.hud.resetTransient();
    // Not unconditionally visible: the lobby packet arrives before the first
    // snapshot, so the staging room may already be up, and a crosshair over it
    // would sit in the middle of somebody's chest.
    this.hud.setVisible(!this.lobby.open);
    this.hud.setSlots(this.loadout, this.activeSlot);
    this.hud.addSystem(`Joined ${MODE_NAMES[this.mode] ?? 'the match'} · ${this.room}`);
    this.hud.notice(MODE_NAMES[this.mode] ?? 'Match', 'plain', true);

    // `relock`, not `requestLock`: the lobby packet arrives before the first
    // snapshot, so by the time we get here the staging room may already be up,
    // and grabbing the pointer would leave its buttons unclickable.
    this.relock();
  }

  private resume(): void {
    // `relock`, not `requestLock`: Escape works while the staging room is up, so
    // Resume can be pressed with the lobby behind the pause menu — and taking the
    // pointer there would leave READY unclickable with no way to get it back.
    this.relock();
  }

  private quit(): void {
    // Order matters: `leaveToMenu` sets the phase, which is what tells the
    // status handler that the close it is about to see was deliberate.
    this.leaveToMenu();
    this.net.disconnect();
  }

  private leaveToMenu(): void {
    this.phase = 'menu';
    this.selfId = -1;
    this.alive = false;
    this.matchOver = false;
    this.roster.length = 0;
    this.names.clear();

    this.input.releaseLock();
    this.input.typing = false;
    // `setVisible(false)` also dismisses the scoreboard, death card, end card
    // and chat box, so none of them can survive into the menu.
    this.hud.setVisible(false);
    this.hud.resetTransient();
    this.lobby.reset();
    this.actors.clear();
    this.effects.clear();
    this.menu.show();
    this.menu.setPlayEnabled(true);
    void this.pollOnline();
  }

  private onStatus(status: NetStatus, detail?: string): void {
    switch (status) {
      case 'connecting':
        this.menu.setPlayEnabled(false, 'Connecting…');
        break;
      case 'joining':
        this.menu.setPlayEnabled(false, 'Joining…');
        break;
      case 'live':
        break;
      case 'closed':
      case 'error': {
        // A close we asked for has already been handled by `quit`.
        if (this.phase === 'menu') {
          this.menu.setPlayEnabled(true);
          return;
        }
        this.leaveToMenu();
        this.audio.ui('error');
        this.hud.toast(detail ?? (status === 'error' ? 'Connection failed' : 'Disconnected'), 'err');
        break;
      }
      default:
        break;
    }
  }

  private async pollOnline(): Promise<void> {
    try {
      const envHost = ((import.meta.env.VITE_SERVER_HOST || import.meta.env.VITE_SERVER_URL || '') as string).trim();
      let endpoint = '/api/status';
      if (envHost) {
        const cleaned = envHost.replace(/^https?:\/\//i, '').replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
        const proto = location.protocol === 'https:' || /^https:/i.test(envHost) || /^wss:/i.test(envHost) ? 'https:' : 'http:';
        endpoint = `${proto}//${cleaned}/api/status`;
      }
      const res = await fetch(endpoint, { cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const body = (await res.json()) as { players?: unknown };
      this.menu.setOnline(typeof body.players === 'number' ? body.players : 0);
    } catch {
      this.menu.setOnline(null);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Interface routing
     ═══════════════════════════════════════════════════════════════════════ */

  private onEscape(): void {
    if (this.hud.chatOpen) {
      this.closeChat();
      this.relock();
      return;
    }
    if (this.menu.anyModalOpen) {
      this.menu.closeTopModal();
      if (!this.menu.anyModalOpen) this.relock();
      return;
    }
    if (this.phase === 'playing') this.pause();
  }

  private pause(): void {
    // Open first, release second: the lock-change handler uses "a modal is
    // already open" to tell a deliberate pause from an unexpected lock loss.
    this.menu.openPause();
    this.input.releaseLock();
  }

  private onLockChange(locked: boolean): void {
    if (locked) return;
    if (this.phase !== 'playing') return;
    if (this.menu.anyModalOpen || this.hud.chatOpen || this.lobby.open) return;
    // The lock went away on its own — a browser Escape, or focus moving off the
    // page. Pause, rather than leaving the player unable to move and unable to
    // see why.
    this.menu.openPause();
  }

  private openChat(): void {
    if (this.phase !== 'playing' || this.hud.chatOpen) return;
    if (this.menu.anyModalOpen) return;
    this.hud.openChat();
    // Movement keys have to go dead while a text field owns the keyboard,
    // otherwise typing "wasd" walks you into the open.
    this.input.typing = true;
    this.input.releaseLock();
  }

  private closeChat(): void {
    this.hud.closeChat();
    this.input.typing = false;
  }

  private relock(): void {
    if (this.phase !== 'playing') return;
    // The staging room counts as a modal for this purpose: it has buttons on it,
    // and a locked pointer cannot press them.
    if (this.menu.anyModalOpen || this.lobby.open) return;
    this.input.requestLock();
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Weapons
     ═══════════════════════════════════════════════════════════════════════ */

  private requestSlot(slot: number): void {
    if (this.phase !== 'playing' || !this.alive) return;
    const id = this.loadout[slot];
    if (id === undefined || id === this.viewModel.currentWeapon.id) return;

    this.activeSlot = slot;
    this.switchWantId = id;
    this.switchSentAt = performance.now();

    this.viewModel.setWeapon(id);
    this.viewModel.cancelReload();
    this.audio.swap(id);
    this.input.notifySlot(slot);
    this.hud.setSlots(this.loadout, slot);
    this.net.sendSwitch(slot);

    // A fresh weapon starts from its own cone rather than inheriting the last
    // one's heat, and cannot fire until it is up.
    this.predSpread = 0;
    this.reloadPredictUntil = 0;
    this.resetShotQueue();
    this.nextLocalFireAt = this.switchSentAt + weaponById(id).switchTime * 1000;
  }

  /**
   * Reconciles the weapon the server says we are holding with the one on screen.
   *
   * A predicted switch is allowed a short grace period before being overruled,
   * so the model does not flick back to the old gun for one round trip — but the
   * grace period expires, so a dropped switch cannot leave the view lying.
   */
  private syncWeapon(id: number): void {
    const prev = this.serverWeapon;
    this.serverWeapon = id;

    if (this.switchWantId >= 0) {
      if (id === this.switchWantId) this.switchWantId = -1;
      else if (performance.now() - this.switchSentAt < 700) return;
      else this.switchWantId = -1;
    }

    if (id !== this.viewModel.currentWeapon.id) {
      this.viewModel.setWeapon(id);
      if (prev !== id && prev >= 0) this.audio.swap(id);
      this.predSpread = 0;
      this.resetShotQueue();
    }

    const slot = this.loadout.indexOf(id);
    if (slot >= 0 && slot !== this.activeSlot) {
      this.activeSlot = slot;
      this.input.notifySlot(slot);
    }
    this.hud.setSlots(this.loadout, this.activeSlot);
  }

  /* ── Predicted-shot bookkeeping ───────────────────────────────────────── */

  private get pendingShots(): number {
    return this.shotTail - this.shotHead;
  }

  private pushShot(nowLocal: number): void {
    if (this.pendingShots >= SHOT_QUEUE) this.shotHead++;
    this.shotAt[this.shotTail % SHOT_QUEUE] = nowLocal;
    this.shotTail++;
  }

  private resetShotQueue(): void {
    this.shotHead = 0;
    this.shotTail = 0;
  }

  /** Writes off shots the server never acknowledged, oldest first. */
  private expireShots(nowLocal: number): void {
    while (
      this.pendingShots > 0 &&
      nowLocal - this.shotAt[this.shotHead % SHOT_QUEUE]! > SHOT_CONFIRM_MS
    ) {
      this.shotHead++;
    }
  }

  /** Magazine as the player should see it: authoritative, minus what we predicted. */
  private displayMag(): number {
    return Math.max(0, this.serverMag - this.pendingShots);
  }

  /* ── The server's own spread model, replicated ────────────────────────── */

  private currentSpread(): number {
    const w = this.viewModel.currentWeapon;
    let s = w.spreadBase + this.predSpread;
    s += w.spreadMove * Math.min(1, this.predictor.speedXZ / SPEED_WALK);
    if (!this.predictor.state.onGround) s += w.spreadAir;
    // A hard threshold, not a blend — the server tests `ads > 0.5`.
    if (this.predAds > 0.5) s *= w.adsSpreadMult;
    return Math.min(s, w.spreadMax + w.spreadAir + w.spreadMove);
  }

  /** 0..1 against the weapon's own worst case, for the crosshair. */
  private spreadFraction(): number {
    const w = this.viewModel.currentWeapon;
    const ceiling = w.spreadMax + w.spreadAir + w.spreadMove;
    if (ceiling <= 0) return 0;
    return Math.min(1, this.currentSpread() / ceiling);
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Fixed-step simulation
     ═══════════════════════════════════════════════════════════════════════ */

  private stepFixed(nowLocal: number): void {
    const dead = !this.alive;
    // Movement keys must not leak through a menu, and a lock we do not hold
    // means keys could be stuck down from before it was lost. The staging room
    // is in that list for a reason worth stating: the server still simulates you
    // on the map behind it, so without this you spend the whole lobby walking
    // around blind and can end up in a wall when it closes.
    const frozen =
      !this.input.locked || this.hud.chatOpen || this.menu.anyModalOpen || this.lobby.open;

    const wasGround = this.predictor.state.onGround;
    const fallSpeed = Math.max(0, -this.predictor.state.vel.y);

    const cmd = this.predictor.tick((c) => {
      this.input.fillCommand(c);
      if (frozen) {
        c.forward = 0;
        c.right = 0;
        c.buttons = 0;
      }
      // Recoil rides on the reported angles, so the shot really does go where
      // the gun is pointing. The spring recovers to zero, which is what makes
      // this a climb-and-settle pattern rather than permanent displacement.
      c.yaw += this.viewModel.recoilYaw;
      c.pitch = clamp(c.pitch + this.viewModel.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT);
    }, dead);

    this.input.endTick();

    // Server order: angles and movement are done; now combat decay, then the
    // weapon. `speedMult()` above therefore saw the previous tick's aim state.
    this.decayPredCombat(cmd.buttons);

    if (dead) {
      this.maybeRespawn(cmd.buttons, nowLocal);
    } else {
      this.predictFire(cmd, nowLocal);
      this.footsteps(wasGround, fallSpeed);
    }

    this.prevButtons = cmd.buttons;
    this.lastButtons = cmd.buttons;
  }

  /** `ServerPlayer.decayCombatState`, reproduced exactly. */
  private decayPredCombat(buttons: number): void {
    const w = this.viewModel.currentWeapon;
    const target = (buttons & BTN.ADS) !== 0 && this.alive ? 1 : 0;
    const rate = w.adsTime > 0 ? TICK_DT / w.adsTime : 1;
    this.predAds += (target - this.predAds) * Math.min(1, rate * 3);
    if (this.predAds < 0.001) this.predAds = 0;
    if (this.predAds > 0.999) this.predAds = 1;

    this.predSpread -= w.spreadRecovery * TICK_DT;
    if (this.predSpread < 0) this.predSpread = 0;
  }

  private maybeRespawn(buttons: number, nowLocal: number): void {
    if (this.respawnIn > 0) return;
    if ((buttons & (BTN.FIRE | BTN.JUMP)) === 0) return;
    if (nowLocal - this.respawnSentAt < 400) return;
    this.respawnSentAt = nowLocal;
    this.net.sendRespawn();
  }

  /**
   * Local fire and reload prediction.
   *
   * Deliberately conservative: it predicts only what it is certain the server
   * will also do. Anything it declines to predict still happens, one round trip
   * later, driven by `EV.SHOT` — so a miss here costs latency, never a lost
   * bullet.
   */
  private predictFire(cmd: { buttons: number }, nowLocal: number): void {
    const w = this.viewModel.currentWeapon;
    const pressed = (cmd.buttons & BTN.FIRE) !== 0;
    const edge = pressed && (this.prevButtons & BTN.FIRE) === 0;
    const reloadEdge =
      (cmd.buttons & BTN.RELOAD) !== 0 && (this.prevButtons & BTN.RELOAD) === 0;
    const reloading = this.reloadLeft > 0 || nowLocal < this.reloadPredictUntil;

    if (reloadEdge && !reloading && w.magSize > 0) {
      if (this.displayMag() < w.magSize && this.serverReserve > 0) {
        this.reloadPredictUntil = nowLocal + w.reloadTime * 1000;
        this.reloadEchoUntil = nowLocal + RELOAD_ECHO_MS;
        this.viewModel.startReload(w.reloadTime);
        this.audio.reload(w.id);
        this.resetShotQueue();
        return;
      }
    }

    if (reloading || nowLocal < this.nextLocalFireAt) return;

    // Only automatics keep firing on a held trigger. Burst is unreachable in the
    // M1 weapon table; if one is ever added, its follow-up shots arrive from the
    // server rather than being guessed at here.
    const wantShot = w.fireMode === 'auto' ? pressed : edge;
    if (!wantShot) return;

    if (w.magSize > 0 && this.displayMag() <= 0) {
      if (edge) this.audio.empty();
      // Let the server's auto-reload have it; retrying every tick would be a
      // clicking noise, not feedback.
      this.nextLocalFireAt = nowLocal + 220;
      return;
    }

    this.fireLocally(w.id, nowLocal);
  }

  private fireLocally(weaponId: number, nowLocal: number): void {
    const w = weaponById(weaponId);

    this.viewModel.fire(nowLocal, this.spreadFraction());
    this.audio.shot(weaponId, this.eye.x, this.eye.y, this.eye.z, true);
    this.effects.shake.add(w.recoilV * 0.32 + 0.004);

    if (w.fireMode !== 'melee') {
      // Trace along the exact angles we just reported, against the same
      // colliders the server uses, so the tracer ends where the bullet did.
      const eye = this.predictor.eyePosition(this.eye);
      const dir = dirFromAngles(this.aim, this.input.yaw + this.viewModel.recoilYaw,
        clamp(this.input.pitch + this.viewModel.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT));
      const hit = traceShot(
        eye.x, eye.y, eye.z,
        dir.x, dir.y, dir.z,
        this.colliders,
        this.hitboxLive,
        w.range,
      );
      this.effects.tracer(eye.x, eye.y, eye.z, hit.x, hit.y, hit.z, true);
    }

    // Server-shaped bookkeeping so the crosshair blooms on the same schedule.
    this.predSpread = Math.min(this.predSpread + w.spreadPerShot, w.spreadMax);
    this.nextLocalFireAt = nowLocal + (60 / w.rpm) * 1000;
    if (w.magSize > 0) this.pushShot(nowLocal);
  }

  private footsteps(wasGround: boolean, fallSpeed: number): void {
    const st = this.predictor.state;

    if (!wasGround && st.onGround) {
      this.viewModel.land(fallSpeed);
      this.audio.footstep(true);
      this.effects.landDust(st.pos.x, st.pos.y, st.pos.z, Math.min(1, fallSpeed / 12));
      this.effects.shake.add(Math.min(0.022, fallSpeed * 0.0011));
      this.stepDist = 0;
      return;
    }

    if (!st.onGround) {
      // Land with a step almost due, so movement reads as continuous.
      this.stepDist = STRIDE_WALK * 0.65;
      return;
    }

    const speed = this.predictor.speedXZ;
    if (speed < 0.6) return;
    this.stepDist += speed * TICK_DT;
    const stride = speed > 7.5 ? STRIDE_SPRINT : STRIDE_WALK;
    if (this.stepDist >= stride) {
      this.stepDist -= stride;
      // Crouching is quiet — that is the whole reason to give up the speed.
      if (!st.crouching) this.audio.footstep(speed > 7.5);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Network events
     ═══════════════════════════════════════════════════════════════════════ */

  private onSnapshot(snap: Snapshot): void {
    const self = snap.self;

    if (this.phase === 'connecting') {
      this.predictor.hardSet(self);
      this.alive = (self.flags & AF.DEAD) === 0;
      this.health = self.health;
      this.serverMag = self.magAmmo;
      this.serverReserve = self.reserveAmmo;
      this.serverWeapon = self.weapon;
      this.enterPlaying();
    }

    const wasAlive = this.alive;
    this.alive = (self.flags & AF.DEAD) === 0;
    this.health = self.health;
    this.respawnIn = self.respawnIn;

    if (this.alive) this.predictor.reconcile(self, snap.ackSeq, false);
    else this.predictor.hardSet(self);

    // A magazine that grew, or a different gun, means every predicted shot is
    // either long since applied or moot.
    if (self.magAmmo > this.serverMag || self.weapon !== this.serverWeapon) {
      this.resetShotQueue();
      this.reloadPredictUntil = 0;
    }
    this.serverMag = self.magAmmo;
    this.serverReserve = self.reserveAmmo;
    this.reloadLeft = self.reloadLeft;
    this.syncWeapon(self.weapon);

    this.actors.ingest(snap.actors, snap.serverTime, this.selfId);

    for (const e of snap.events) this.handleEvent(e);

    this.hud.setStreak(self.streak);

    if (!wasAlive && this.alive) this.onRespawned();
  }

  private onRespawned(): void {
    this.hud.hideDeath();
    this.audio.spawn();
    this.predAds = 0;
    this.predSpread = 0;
    this.resetShotQueue();
    this.reloadPredictUntil = 0;
    this.nextLocalFireAt = 0;
    this.stepDist = 0;
    this.relock();
  }

  private onRoster(entries: RosterEntry[]): void {
    this.roster = entries;
    this.names.clear();
    for (const e of entries) this.names.set(e.id, e.name);

    const me = entries.find((e) => e.id === this.selfId);
    if (me) {
      this.myName = me.name;
      if (me.team !== this.myTeam) {
        this.myTeam = me.team;
        this.actors.setContext(this.myTeam, this.teamMode);
      }
    }

    this.actors.setNames(entries);
    this.hud.setRoster(entries);
    this.lobby.setRoster(entries);
  }

  private onLobby(m: LobbyMsg): void {
    if (m.mapId !== undefined) {
      const map = mapById(m.mapId);
      if (map && this.world.currentMap?.id !== map.id) {
        this.loadMap(map);
        this.hud.setContext(this.mode, this.room, map.name);
        this.lobby.setMap(map.id, map.name);
        this.hud.toast(`Map changed to ${map.name}`, 'info');
      }
    }
    this.lobby.setLobby(m);
  }

  private onMatch(m: MatchMsg): void {
    this.hud.setMatch(m);
    this.menu.setOnline(m.playersOnline);

    if (m.over && !this.matchOver) {
      this.matchOver = true;
      this.hud.showMatchOver(this.matchOverText(m));
      this.hud.showScoreboard();
      this.audio.matchEnd(this.didWin(m));
      this.input.releaseLock();
    } else if (!m.over && this.matchOver) {
      this.matchOver = false;
      this.hud.hideMatchOver();
      this.hud.hideScoreboard();
      this.hud.resetTransient();
      this.relock();
    }
  }

  private topScorer(): RosterEntry | null {
    let best: RosterEntry | null = null;
    for (const e of this.roster) {
      if (!best || e.kills > best.kills || (e.kills === best.kills && e.deaths < best.deaths)) {
        best = e;
      }
    }
    return best;
  }

  private didWin(m: MatchMsg): boolean {
    if (this.teamMode) {
      if (m.scoreA === m.scoreB) return false;
      return this.myTeam === TEAM_A ? m.scoreA > m.scoreB : m.scoreB > m.scoreA;
    }
    return this.topScorer()?.id === this.selfId;
  }

  private matchOverText(m: MatchMsg): string {
    if (this.teamMode) {
      if (m.scoreA === m.scoreB) return 'Draw';
      const winner = m.scoreA > m.scoreB ? 'Alpha' : 'Bravo';
      if (this.myTeam === TEAM_A || this.myTeam === TEAM_B) {
        return `${winner} wins — ${this.didWin(m) ? 'you won' : 'you lost'}`;
      }
      return `${winner} wins`;
    }
    const top = this.topScorer();
    if (!top) return 'Match over';
    return top.id === this.selfId ? 'You win' : `${chatName(top.name)} wins`;
  }

  /* ── Event fan-out ────────────────────────────────────────────────────── */

  private nameOf(id: number): string {
    if (id < 0) return '';
    const known = this.names.get(id);
    if (known) return known;
    const fromActor = this.actors.nameOf(id);
    if (fromActor) return fromActor;
    return id === this.selfId ? this.myName : 'player';
  }

  private handleEvent(e: GameEvent): void {
    switch (e.kind) {
      case EV.SHOT:
        this.onShot(e);
        break;
      case EV.IMPACT:
        this.onImpact(e);
        break;
      case EV.HIT_CONFIRM: {
        const flag = e.flag ?? 0;
        const head = (flag & 1) !== 0;
        const killed = (flag & 2) !== 0;
        this.hud.hitmarker(head, killed);
        this.audio.hitmarker(head, killed);
        // `a` is the victim: this event is only ever sent to the attacker.
        this.floatDamage(e.a ?? -1, e.b ?? 0, head, killed);
        break;
      }
      case EV.DAMAGED: {
        // The server sends the world angle from victim to attacker; the HUD
        // wants it relative to where we are looking, clockwise on screen.
        const rel = wrapAngle(this.input.yaw - (e.x ?? 0));
        const severity = Math.min(1, (e.b ?? 0) / MAX_HEALTH);
        this.hud.damaged(rel, severity);
        this.audio.hurt();
        this.effects.shake.add(0.006 + severity * 0.028);
        break;
      }
      case EV.KILL:
        this.onKill(e);
        break;
      case EV.DEATH:
        this.onDeath(e);
        break;
      case EV.RELOAD:
        if (e.a === this.selfId) {
          const w = this.viewModel.currentWeapon;
          // Suppress the echo of a reload we already started locally.
          if (performance.now() >= this.reloadEchoUntil) {
            this.reloadPredictUntil = performance.now() + w.reloadTime * 1000;
            this.viewModel.startReload(w.reloadTime);
            this.audio.reload(w.id);
          }
          this.resetShotQueue();
        }
        break;
      case EV.SPAWN:
        if (e.a !== this.selfId) {
          const a = this.actors.get(e.a ?? -1);
          if (a) this.effects.landDust(a.x, a.y, a.z, 0.4);
        }
        break;
      case EV.CHAT:
        this.hud.addChat(chatName(this.nameOf(e.a ?? -1)), e.text ?? '');
        break;
      default:
        break;
    }
  }

  /**
   * Floats a damage number over whoever we just hit.
   *
   * Anchored to the victim's *rendered* position, not their authoritative one.
   * That is deliberate: remote players are drawn 100 ms behind the server, so the
   * rendered body is the one the player was aiming at when they fired, and the
   * number belongs over that. Anchoring to the true position would sit the number
   * slightly ahead of the enemy on screen — which would read as a miss.
   */
  private floatDamage(victim: number, amount: number, head: boolean, killed: boolean): void {
    const a = this.actors.get(victim);
    if (a) {
      const height = (a.flags & AF.CROUCH) !== 0 ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
      // Over the head for a headshot, upper chest otherwise. Both clear the model,
      // and the number rises from there anyway.
      const y = a.y + (head ? height : height * 0.72);
      this.hud.damageNumber(victim, amount, head, killed, a.x, y, a.z);
      return;
    }
    // No body to anchor to. Dead players keep theirs, so this only happens if the
    // victim disconnected in the same tick — but the damage should still be
    // reported, so it goes out in front of the camera instead of being dropped.
    this.camera.getWorldDirection(this.aimScratch);
    this.hud.damageNumber(
      victim,
      amount,
      head,
      killed,
      this.camera.position.x + this.aimScratch.x * 6,
      this.camera.position.y + this.aimScratch.y * 6,
      this.camera.position.z + this.aimScratch.z * 6,
    );
  }

  private onShot(e: GameEvent): void {
    const shooter = e.a ?? -1;
    const weaponId = e.b ?? 0;
    const w = weaponById(weaponId);
    const nowLocal = performance.now();

    if (shooter === this.selfId) {
      // Prediction already played this one in full. Cancel it and stop — drawing
      // a second tracer for one bullet is worse than a slightly stale endpoint.
      if (this.pendingShots > 0) {
        this.shotHead++;
        return;
      }
      // A shot we did not predict. Play everything, so no bullet is silent.
      this.viewModel.fire(nowLocal, this.spreadFraction());
      this.audio.shot(weaponId, e.x ?? 0, e.y ?? 0, e.z ?? 0, true);
      if (w.fireMode !== 'melee') {
        this.effects.tracer(e.x ?? 0, e.y ?? 0, e.z ?? 0, e.nx ?? 0, e.ny ?? 0, e.nz ?? 0, true);
      }
      return;
    }

    const ox = e.x ?? 0;
    const oy = e.y ?? 0;
    const oz = e.z ?? 0;
    this.audio.shot(weaponId, ox, oy, oz, false);
    if (w.fireMode !== 'melee') {
      const tx = e.nx ?? 0;
      const ty = e.ny ?? 0;
      const tz = e.nz ?? 0;
      this.effects.tracer(ox, oy, oz, tx, ty, tz, false);
      let dx = tx - ox;
      let dy = ty - oy;
      let dz = tz - oz;
      const len = Math.hypot(dx, dy, dz);
      if (len > 0.001) {
        dx /= len;
        dy /= len;
        dz /= len;
        this.effects.muzzleFlash(ox, oy, oz, dx, dy, dz, w.sfx.gain, cycleTime(w));
        this.effects.muzzleSmoke(ox, oy, oz, dx, dy, dz, w.sfx.gain);
      }
    }
    // Firing is what puts an enemy on the radar, and only briefly.
    this.hud.pingActor(shooter);
  }

  private onImpact(e: GameEvent): void {
    const x = e.x ?? 0;
    const y = e.y ?? 0;
    const z = e.z ?? 0;
    const flag = e.flag ?? 0;

    // `flag` doubles as the audio material: 0 world, 1 body, 2 head.
    this.audio.impact(x, y, z, flag);

    if (flag === 0) {
      this.effects.impactWorld(x, y, z, e.nx ?? 0, e.ny ?? 1, e.nz ?? 0);
      return;
    }

    // Body hits carry no surface normal, so spray back toward the viewer —
    // which is also the only direction anyone is watching from.
    let nx = this.eye.x - x;
    let ny = this.eye.y - y;
    let nz = this.eye.z - z;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0.001) {
      nx /= len;
      ny /= len;
      nz /= len;
    } else {
      nx = 0;
      ny = 1;
      nz = 0;
    }
    this.effects.impactFlesh(x, y, z, nx, ny, nz, flag === 2);
  }

  private onKill(e: GameEvent): void {
    const victim = e.a ?? -1;
    const killer = e.b ?? -1;
    const flag = e.flag ?? 0;
    const selfInflicted = (flag & 4) !== 0 || victim === killer;
    const head = (flag & 1) !== 0;
    const back = (flag & 2) !== 0;
    const weaponId = (e.c ?? 255) === 255 ? 0 : e.c!;

    this.hud.addKill({
      victim: chatName(this.nameOf(victim)),
      killer: selfInflicted ? '' : chatName(this.nameOf(killer)),
      weaponId,
      head,
      back,
      killerIsSelf: !selfInflicted && killer === this.selfId,
      victimIsSelf: victim === this.selfId,
    });

    if (!selfInflicted && killer === this.selfId && victim !== this.selfId) {
      const what = back ? 'Backstab' : head ? 'Headshot' : 'Eliminated';
      this.hud.notice(`${what} · ${chatName(this.nameOf(victim))}`, head || back ? 'gold' : 'plain');
    }

    if (victim === this.selfId) {
      this.hud.showDeath(selfInflicted ? '' : this.nameOf(killer), weaponId, selfInflicted);
    }
  }

  private onDeath(e: GameEvent): void {
    const id = e.a ?? -1;
    const a = this.actors.get(id);
    if (a) this.effects.deathBurst(a.x, a.y, a.z);

    if (id === this.selfId) {
      this.audio.died();
      this.effects.shake.add(0.05);
      this.hud.setStreak(0);
      this.resetShotQueue();
      this.reloadPredictUntil = 0;
      this.predSpread = 0;
      this.predAds = 0;
      this.respawnSentAt = 0;
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════
     Frame
     ═══════════════════════════════════════════════════════════════════════ */

  private frame = (nowLocal: number): void => {
    this.raf = requestAnimationFrame(this.frame);

    // Framerate cap, and a much lower one behind the menu — a gently orbiting
    // backdrop is not worth a discrete GPU spinning up. The staging room is in
    // the same category: nobody is aiming at anything in there.
    const cap =
      this.phase === 'playing' && !this.lobby.open ? this.settings.get('fpsCap') : MENU_FPS;
    if (cap > 0) {
      // A little slack, or a 60 Hz cap on a 60 Hz display aliases to 30.
      if (nowLocal + 0.6 < this.nextRenderAt) return;
      this.nextRenderAt = Math.max(nowLocal, this.nextRenderAt) + 1000 / cap;
    } else {
      this.nextRenderAt = nowLocal;
    }

    let dt = (nowLocal - this.lastFrame) / 1000;
    this.lastFrame = nowLocal;
    if (!(dt > 0)) dt = 0;
    if (dt > 0.25) dt = 0.25;

    // Smoothed, because a raw per-frame reciprocal is unreadable.
    this.fps += ((dt > 0 ? 1 / dt : 0) - this.fps) * 0.08;

    if (this.phase === 'playing') this.playFrame(dt, nowLocal);
    else this.menuFrame(dt, nowLocal);

    // Posed on top of whichever of those ran. Gated on `lobby.open` rather than
    // the phase because the phase is `playing` either way — the server has us
    // spawned in the map the whole time the staging room is up — and there is
    // only one thing that decides whether the room is on screen.
    if (this.lobby.open) this.lobby.update(dt, nowLocal);

    this.render();
  };

  private playFrame(dt: number, nowLocal: number): void {
    // 1 — look, at full frame rate.
    const eye0 = this.predictor.eyePosition(this.eye);
    const yaw0 = this.input.yaw;
    const pitch0 = this.input.pitch;
    this.input.applyLook(this.viewModel.adsFactor);
    this.applyAimAssist(dt, eye0);
    const lookDx = this.input.yaw - yaw0;
    const lookDy = this.input.pitch - pitch0;

    const slot = this.input.takeSlotRequest();
    if (slot >= 0) this.requestSlot(slot);

    // 2 — fixed steps. Clamped so the frame after a hitch is not a freeze.
    this.expireShots(nowLocal);
    this.accum += dt * 1000;
    if (this.accum > TICK_MS * MAX_CATCHUP) this.accum = TICK_MS * MAX_CATCHUP;
    let steps = 0;
    while (this.accum >= TICK_MS && steps < MAX_CATCHUP) {
      this.accum -= TICK_MS;
      this.stepFixed(nowLocal);
      steps++;
    }

    // 3 — one packet per frame, carrying the newest unacked commands.
    if (steps > 0) this.net.sendInputs(this.predictor.pending);

    // 4 — visuals.
    this.predictor.smooth(dt);
    const eye = this.predictor.eyePosition(this.eye);
    const wantAds = (this.lastButtons & BTN.ADS) !== 0;

    this.viewModel.update(
      dt,
      lookDx,
      lookDy,
      this.predictor.speedXZ,
      this.predictor.state.onGround,
      wantAds && this.alive,
      this.settings.get('viewBob'),
      nowLocal,
    );

    this.actors.update(this.net.now(), dt, nowLocal);
    this.effects.update(dt, this.settings.get('screenShake'));
    this.world.followShadow(eye.x, eye.z);
    this.audio.setListener(eye.x, eye.y, eye.z, this.input.yaw);

    this.updateCamera(eye);
    this.buildHitboxes();
    this.traceCrosshair(eye);
    this.actorPass();
    this.updateHud(dt, nowLocal);
  }

  private menuFrame(dt: number, nowLocal: number): void {
    const map = this.world.currentMap;
    if (map) {
      // A slow orbit of the map. Visible only where the menu backdrop lets it
      // through, which is exactly as much of it as should be visible.
      const t = nowLocal * 0.00004;
      const r = map.half * 0.78;
      const px = Math.cos(t) * r;
      const pz = Math.sin(t) * r;
      const py = map.half * 0.42;
      this.camera.position.set(px, py, pz);
      const dx = -px;
      const dy = 2.4 - py;
      const dz = -pz;
      this.camera.rotation.set(Math.atan2(dy, Math.hypot(dx, dz)), Math.atan2(-dx, -dz), 0);
      this.setCameraFov(this.settings.get('fov'));
      this.world.followShadow(0, 0);
    }
    this.effects.update(dt, 0);
    this.hud.update(dt, nowLocal);
  }

  private setCameraFov(fov: number): void {
    if (Math.abs(this.camera.fov - fov) < 0.01) return;
    this.camera.fov = fov;
    this.camera.updateProjectionMatrix();
    // World particles are sized in pixels, so their scale depends on the FOV as
    // much as on the viewport: a scope that magnifies four times has to magnify
    // the sparks at the far end with it.
    this.effects.setCameraFov(fov);
  }

  private updateCamera(eye: Vec3): void {
    const shake = this.effects.shake;
    this.camera.position.set(eye.x, eye.y, eye.z);
    // Shake is added here and nowhere else: it must never reach the command, or
    // the player would be shooting at a wobble.
    this.camera.rotation.set(
      clamp(this.input.pitch + this.viewModel.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT) +
        shake.offsetPitch,
      this.input.yaw + this.viewModel.recoilYaw + shake.offsetYaw,
      shake.offsetRoll,
    );
    this.setCameraFov(this.settings.get('fov') * this.viewModel.worldFovMult());
  }

  /**
   * Rebuilds the hitbox list the local trace shoots at.
   *
   * The pool is permanent and the working list is truncated rather than
   * reallocated, so a firefight does not hand the collector anything.
   */
  private buildHitboxes(): void {
    this.hitboxLive.length = 0;
    let n = 0;
    this.actors.forEach((a) => {
      if (n + 2 > this.hitboxPool.length) return;
      if (a.dead) return;
      if ((a.flags & AF.DEAD) !== 0) return;
      // Teammates are not targets, so they must not tint the crosshair.
      if (this.teamMode && this.myTeam !== TEAM_NONE && a.team === this.myTeam) return;
      const height = (a.flags & AF.CROUCH) !== 0 ? PLAYER_CROUCH_HEIGHT : PLAYER_HEIGHT;
      const head = this.hitboxPool[n]!;
      const body = this.hitboxPool[n + 1]!;
      writeHitboxes(head, body, a.id, a.x, a.y, a.z, height);
      this.hitboxLive.push(head, body);
      n += 2;
    });
  }

  /** Is the crosshair actually on someone? Cheap, and worth knowing. */
  private traceCrosshair(eye: Vec3): void {
    if (!this.alive || this.hitboxLive.length === 0) {
      this.onTarget = false;
      return;
    }
    const w = this.viewModel.currentWeapon;
    const dir = dirFromAngles(
      this.aim,
      this.input.yaw + this.viewModel.recoilYaw,
      clamp(this.input.pitch + this.viewModel.recoilPitch, -PITCH_LIMIT, PITCH_LIMIT),
    );
    const hit = traceShot(
      eye.x, eye.y, eye.z,
      dir.x, dir.y, dir.z,
      this.colliders,
      this.hitboxLive,
      w.range,
    );
    this.onTarget = hit.hitId >= 0;
  }

  /**
   * Smooth target magnetism / auto-aim assistance.
   *
   * Finds the best visible enemy target near the crosshair, checks line of sight
   * against world colliders, and smoothly pulls the camera look angles towards
   * the enemy upper chest / head. Scoped / ADS weapons receive crisp snap & tracking.
   */
  private applyAimAssist(dt: number, eye: Vec3): void {
    if (!this.alive || !this.settings.get('aimAssist')) return;
    const strength = this.settings.get('aimAssistStrength') ?? 0.5;
    if (strength <= 0.01) return;

    const w = this.viewModel.currentWeapon;
    const ads = this.viewModel.adsFactor;
    // Only assist when deliberately aiming down sights, NEVER during free navigation/hip-fire
    if (ads < 0.45) return;
    const isScoped = w.scoped && ads > 0.6;

    const yaw = this.input.yaw;
    const pitch = this.input.pitch;
    const fwd = dirFromAngles(this.aim, yaw, pitch);

    let bestDYaw = 0;
    let bestDPitch = 0;
    let bestAngDist = 0;
    let hasTarget = false;
    let bestScore = Infinity;

    // Angle cone: subtle and tight, authentic to modern competitive FPS games
    const maxAngleRad = (isScoped ? 4.0 : ads > 0.2 ? 6.0 : 4.5) * (Math.PI / 180);
    const minDot = Math.cos(maxAngleRad);

    this.actors.forEach((a) => {
      if (a.dead || (a.flags & AF.DEAD) !== 0) return;
      if (this.teamMode && this.myTeam !== TEAM_NONE && a.team === this.myTeam) return;

      const crouch = (a.flags & AF.CROUCH) !== 0;
      const targetH = crouch ? PLAYER_CROUCH_HEIGHT * 0.8 : PLAYER_HEIGHT * 0.82;
      const tx = a.x;
      const ty = a.y + targetH;
      const tz = a.z;

      const dx = tx - eye.x;
      const dy = ty - eye.y;
      const dz = tz - eye.z;
      const dist = Math.hypot(dx, dy, dz);
      if (dist < 0.6 || dist > w.range) return;

      const ndx = dx / dist;
      const ndy = dy / dist;
      const ndz = dz / dist;

      const dot = fwd.x * ndx + fwd.y * ndy + fwd.z * ndz;
      if (dot < minDot) return;

      // Line-of-sight test against map geometry
      const hit = raycastWorld(eye.x, eye.y, eye.z, ndx, ndy, ndz, this.colliders, dist);
      if (hit && hit.t < dist - 0.3) return;

      // Desired angles to look directly at target
      const targetYaw = Math.atan2(-dx, -dz);
      const horizDist = Math.hypot(dx, dz);
      const targetPitch = Math.atan2(dy, horizDist);

      const dYaw = wrapAngle(targetYaw - yaw);
      const dPitch = clamp(targetPitch - pitch, -PITCH_LIMIT, PITCH_LIMIT);
      const angDist = Math.hypot(dYaw, dPitch);

      // Score prioritizing targets closer to crosshair
      const score = angDist * (1 + dist / 60);
      if (score < bestScore) {
        bestScore = score;
        bestDYaw = dYaw;
        bestDPitch = dPitch;
        bestAngDist = angDist;
        hasTarget = true;
      }
    });

    if (hasTarget) {
      // Gentle, natural magnetic friction and micro-aim tracking
      const proximity = Math.max(0, 1.0 - bestAngDist / maxAngleRad);
      const baseRate = isScoped ? 2.4 : ads > 0.2 ? 3.2 : 1.8;
      const maxPull = isScoped ? 0.06 : ads > 0.2 ? 0.08 : 0.05;
      const pull = Math.min(maxPull, dt * baseRate * strength * Math.pow(proximity, 2.0));

      this.input.yaw = wrapAngle(this.input.yaw + bestDYaw * pull);
      this.input.pitch = clamp(this.input.pitch + bestDPitch * pull, -PITCH_LIMIT, PITCH_LIMIT);
    }
  }

  /**
   * One pass over the interpolated actors, doing both jobs that need them:
   * their footstep audio and their radar blips.
   */
  private actorPass(): void {
    this.hud.radarBegin({ x: this.eye.x, z: this.eye.z, yaw: this.input.yaw });
    this.actors.forEach((a) => {
      const friendly = this.teamMode && this.myTeam !== TEAM_NONE && a.team === this.myTeam;
      this.hud.radarBlip(a.id, a.x, a.z, friendly, a.dead);
      if (a.dead) return;
      if (a.stepThisFrame) this.audio.footstepAt(a.x, a.y, a.z);
      if (a.landedThisFrame) {
        this.audio.footstepAt(a.x, a.y, a.z);
        this.effects.landDust(a.x, a.y, a.z, 0.5);
      }
    });
  }

  private updateHud(dt: number, nowLocal: number): void {
    const w = this.viewModel.currentWeapon;
    const ads = this.viewModel.adsFactor;
    const reloading = this.reloadLeft > 0 || nowLocal < this.reloadPredictUntil;

    this.hud.setCrosshair(this.spreadFraction(), ads, this.onTarget && this.alive);
    this.hud.setScope(w.scoped && ads > 0.65);
    this.hud.setHealth(this.health);
    this.hud.setStamina(this.predictor.state.stamina ?? 1.0, (this.predictor.state.staminaCooldown ?? 0) > 0);
    this.hud.setAmmo(w.id, this.displayMag(), this.serverReserve, reloading);
    this.hud.setStats(this.fps, this.net.rtt);

    if (!this.alive) this.hud.setRespawnIn(this.respawnIn);

    // Scoreboard follows Tab, except once the match is decided — then it stays.
    const wantBoard = this.matchOver || this.input.scoreboardHeld;
    if (wantBoard !== this.hud.scoreboardVisible) {
      if (wantBoard) this.hud.showScoreboard();
      else this.hud.hideScoreboard();
    }

    this.hud.update(dt, nowLocal);
    this.net.tickCounters(nowLocal);
  }

  /**
   * Two passes, one frame.
   *
   * The world is drawn first; then the depth buffer is cleared and the gun is
   * drawn on top with its own near plane. That is what lets the view model
   * occupy a metre of space in front of the eye without ever clipping into a
   * wall the player is standing against.
   *
   * The staging room takes the whole frame instead of either pass. It is a
   * separate scene and camera drawn by this same renderer — one GL context, one
   * shader cache, one shadow map — which is why `LobbyStage` owns no renderer of
   * its own. Nothing of the match is drawn underneath it: the room is opaque,
   * and a hidden view model behind a wall of geometry is pure cost.
   */
  private render(): void {
    const r = this.renderer;
    r.clear();

    if (this.lobby.open) {
      r.render(this.lobby.scene, this.lobby.camera);
      return;
    }

    r.render(this.world.scene, this.camera);

    if (this.phase === 'playing' && this.alive && this.settings.get('viewmodel')) {
      r.clearDepth();
      r.render(this.viewModel.scene, this.viewModel.camera);
    }
  }

  /* ═══════════════════════════════════════════════════════════════════════ */

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.net.disconnect();
    this.input.dispose();
    this.viewModel.dispose();
    this.effects.dispose();
    this.lobby.dispose();
    this.world.clear();
    this.renderer.dispose();
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Boot

   A failure here means a black page, so it is reported in the document rather
   than only in the console — a WebGL context refusal is the single most likely
   thing to go wrong on someone else's machine, and "nothing happened" is the
   least useful way to find out.
   ────────────────────────────────────────────────────────────────────────── */

function fatal(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  const loading = document.getElementById('loading');
  loading?.classList.remove('gone');
  if (loading) {
    loading.innerHTML = '';
    const box = document.createElement('div');
    box.style.cssText =
      'max-width:34rem;padding:1.5rem;text-align:center;font:400 16px/1.5 "Open Sans",Verdana,sans-serif;color:#e2e2e2';
    const title = document.createElement('div');
    title.style.cssText = 'font-weight:700;font-size:21px;margin-bottom:.6rem';
    title.textContent = 'Could not start';
    const body = document.createElement('div');
    body.style.cssText = 'color:#bebebe';
    body.textContent = message;
    const hint = document.createElement('div');
    hint.style.cssText = 'color:#bebebe;margin-top:.8rem;font-size:14px';
    hint.textContent =
      'This game needs WebGL. Check that hardware acceleration is enabled in your browser settings.';
    box.append(title, body, hint);
    loading.appendChild(box);
  }
  console.error(err);
}

try {
  const game = new Game();
  // Handy from the console, and the only global this file creates.
  (window as unknown as { game: Game }).game = game;
} catch (err) {
  fatal(err);
}
