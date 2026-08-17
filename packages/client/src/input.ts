/**
 * Raw device input → look angles + a shared-simulation `InputCmd`.
 *
 * Two deliberate design points:
 *
 * 1. **Mouse deltas accumulate, they are never sampled.** A 1000 Hz mouse fires
 *    many `mousemove` events between two 60 Hz ticks. Reading only the latest
 *    one throws away most of the motion and makes fast flicks undershoot, so
 *    deltas are summed and drained once per tick.
 *
 * 2. **Buttons are edge-aware at the source.** `justPressed` survives until the
 *    tick that consumes it, so a click that lands between ticks is never lost.
 *    Without this, a fast tap on a 60 Hz sim can vanish entirely.
 *
 * Look angles live here rather than in the predictor because they are pure
 * client authority: the server accepts whatever yaw/pitch you send (clamped),
 * so there is nothing to predict or reconcile.
 */

import { BTN, PITCH_LIMIT, clamp, type InputCmd } from '@oneshot/shared';
import type { SettingsStore } from './settings';

/** Physical keys we care about, mapped to a stable action name. */
const KEY_ACTIONS: Record<string, string> = {
  KeyW: 'fwd',
  ArrowUp: 'fwd',
  KeyS: 'back',
  ArrowDown: 'back',
  KeyA: 'left',
  ArrowLeft: 'left',
  KeyD: 'right',
  ArrowRight: 'right',
  Space: 'jump',
  ShiftLeft: 'sprint',
  ShiftRight: 'sprint',
  ControlLeft: 'crouch',
  ControlRight: 'crouch',
  KeyC: 'crouch',
  KeyR: 'reload',
  KeyQ: 'lastWeapon',
  KeyE: 'use',
  Digit1: 'slot1',
  Digit2: 'slot2',
  Digit3: 'slot3',
  Tab: 'scoreboard',
  KeyT: 'chat',
  Slash: 'chat',
  Enter: 'chat',
  KeyV: 'melee',
  KeyF: 'melee',
};

/**
 * Mouse held/edge bitmask, `1 << MouseEvent.button`. Named, because the raw
 * numbers do not line up with the button numbers: right-click is button 2 and
 * therefore bit 4, and a bare `& 2` reads exactly like "right button" while
 * actually testing the middle wheel. That mistake silently disabled aiming down
 * sights — and with it the zoom, the tightened spread and the sniper scope —
 * because the button that sets bit 4 was checked against bit 2 and never matched.
 */
const MOUSE_LEFT = 1 << 0;
const MOUSE_RIGHT = 1 << 2;

export class InputManager {
  /** Look angles, in the shared math convention: yaw 0 looks down −Z. */
  yaw = 0;
  pitch = 0;

  /** Set while the pointer is locked to the canvas — i.e. we are really playing. */
  get locked(): boolean {
    return document.pointerLockElement === this.canvas;
  }

  /** True when a text field owns the keyboard; movement keys must go dead. */
  typing = false;

  /** True while the scoreboard key is held. */
  get scoreboardHeld(): boolean {
    return this.held.has('scoreboard');
  }

  private canvas: HTMLCanvasElement;
  private settings: SettingsStore;

  private held = new Set<string>();
  private pressedEdge = new Set<string>();
  private mouseHeld = 0;
  private mousePressedEdge = 0;

  private dx = 0;
  private dy = 0;
  private wheel = 0;

  /** ADS/sprint latches, only used when the matching toggle setting is on. */
  private adsLatch = false;
  private sprintLatch = false;

  /** Slot the player asked for this tick, or −1. Consumed by the caller. */
  private slotRequest = -1;
  private lastSlot = 0;
  private currentSlot = 0;

  private onEsc: (() => void) | null = null;
  private onChatKey: (() => void) | null = null;
  private onLockChange: ((locked: boolean) => void) | null = null;

  private disposers: Array<() => void> = [];

  constructor(canvas: HTMLCanvasElement, settings: SettingsStore) {
    this.canvas = canvas;
    this.settings = settings;
    this.bind();
  }

  /* ── Wiring ───────────────────────────────────────────────────────────── */

  private bind(): void {
    const add = <K extends keyof WindowEventMap>(
      target: EventTarget,
      type: K | string,
      fn: (e: never) => void,
      opts?: AddEventListenerOptions,
    ) => {
      target.addEventListener(type, fn as EventListener, opts);
      this.disposers.push(() => target.removeEventListener(type, fn as EventListener, opts));
    };

    add(window, 'keydown', (e: KeyboardEvent) => this.onKeyDown(e));
    add(window, 'keyup', (e: KeyboardEvent) => this.onKeyUp(e));
    add(this.canvas, 'mousedown', (e: MouseEvent) => this.onMouseDown(e));
    add(window, 'mouseup', (e: MouseEvent) => this.onMouseUp(e));
    add(window, 'mousemove', (e: MouseEvent) => this.onMouseMove(e));
    add(this.canvas, 'wheel', (e: WheelEvent) => this.onWheel(e), { passive: false });
    add(document, 'pointerlockchange', () => this.onPointerLockChange());
    add(this.canvas, 'contextmenu', (e: Event) => e.preventDefault());
    // Losing focus mid-strafe would otherwise leave the key stuck down forever.
    add(window, 'blur', () => this.releaseAll());
  }

  dispose(): void {
    for (const off of this.disposers) off();
    this.disposers.length = 0;
  }

  setHandlers(h: {
    onEscape?: () => void;
    onChatKey?: () => void;
    onLockChange?: (locked: boolean) => void;
  }): void {
    if (h.onEscape) this.onEsc = h.onEscape;
    if (h.onChatKey) this.onChatKey = h.onChatKey;
    if (h.onLockChange) this.onLockChange = h.onLockChange;
  }

  /* ── Pointer lock ─────────────────────────────────────────────────────── */

  requestLock(): void {
    if (this.locked) return;
    // Safari and Firefox return void here; Chrome returns a promise that
    // rejects if the user just left lock ("lock too soon" guard).
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => {});
  }

  releaseLock(): void {
    if (this.locked) document.exitPointerLock();
  }

  private onPointerLockChange(): void {
    const locked = this.locked;
    if (!locked) this.releaseAll();
    this.onLockChange?.(locked);
  }

  private releaseAll(): void {
    this.held.clear();
    this.mouseHeld = 0;
    this.dx = 0;
    this.dy = 0;
    this.adsLatch = false;
    this.sprintLatch = false;
  }

  /* ── Keyboard ─────────────────────────────────────────────────────────── */

  private onKeyDown(e: KeyboardEvent): void {
    if (e.code === 'Escape') {
      this.onEsc?.();
      return;
    }

    const action = KEY_ACTIONS[e.code];

    if (this.typing) {
      // While the chat box is focused only Escape/Enter matter, and the chat
      // widget itself handles those on the input element.
      return;
    }

    // Tab would move focus out of the canvas; Space would scroll.
    if (action === 'scoreboard' || e.code === 'Space') e.preventDefault();
    if (!action) return;

    if (action === 'chat') {
      if (e.repeat) return;
      e.preventDefault();
      this.onChatKey?.();
      return;
    }

    if (e.repeat) return;
    this.held.add(action);
    this.pressedEdge.add(action);

    if (action === 'sprint' && this.settings.get('toggleSprint')) {
      this.sprintLatch = !this.sprintLatch;
    }

    if (action === 'slot1') this.requestSlot(0);
    else if (action === 'slot2') this.requestSlot(1);
    else if (action === 'slot3') this.requestSlot(2);
    else if (action === 'melee') this.requestSlot(2);
    else if (action === 'lastWeapon') this.requestSlot(this.lastSlot);
  }

  private onKeyUp(e: KeyboardEvent): void {
    const action = KEY_ACTIONS[e.code];
    if (!action) return;
    this.held.delete(action);
  }

  /* ── Mouse ────────────────────────────────────────────────────────────── */

  private onMouseDown(e: MouseEvent): void {
    if (!this.locked) return;
    e.preventDefault();
    const bit = 1 << e.button;
    this.mouseHeld |= bit;
    this.mousePressedEdge |= bit;

    if (e.button === 2 && this.settings.get('toggleAds')) {
      this.adsLatch = !this.adsLatch;
    }
  }

  private onMouseUp(e: MouseEvent): void {
    this.mouseHeld &= ~(1 << e.button);
  }

  private onMouseMove(e: MouseEvent): void {
    if (!this.locked) return;
    // movementX/Y are already relative under pointer lock, and are the only
    // values that keep working once the cursor hits a screen edge.
    this.dx += e.movementX;
    this.dy += e.movementY;
  }

  private onWheel(e: WheelEvent): void {
    if (!this.locked) return;
    e.preventDefault();
    this.wheel += Math.sign(e.deltaY);
  }

  /* ── Slots ────────────────────────────────────────────────────────────── */

  private requestSlot(slot: number): void {
    if (slot < 0 || slot > 2 || slot === this.currentSlot) return;
    this.slotRequest = slot;
  }

  /** Called by the game once the server confirms the active slot. */
  notifySlot(slot: number): void {
    if (slot === this.currentSlot) return;
    this.lastSlot = this.currentSlot;
    this.currentSlot = slot;
  }

  /** Returns the requested slot once, then forgets it. */
  takeSlotRequest(): number {
    // The wheel cycles through the loadout; resolve it here so both paths
    // funnel into the same single-slot request.
    if (this.wheel !== 0) {
      const dir = this.wheel > 0 ? 1 : -1;
      this.wheel = 0;
      this.requestSlot((this.currentSlot + dir + 3) % 3);
    }
    const s = this.slotRequest;
    this.slotRequest = -1;
    return s;
  }

  /* ── Per-tick output ──────────────────────────────────────────────────── */

  /**
   * Applies accumulated mouse motion to the look angles.
   *
   * Called once per rendered frame rather than once per tick: turning should
   * feel as smooth as the display, and the resulting angles are simply sampled
   * by whichever tick comes next.
   */
  applyLook(adsFactor: number): void {
    if (this.dx === 0 && this.dy === 0) return;
    const s = this.settings.values;
    // Blend the ADS multiplier by how far into the zoom we actually are, so
    // sensitivity does not pop the instant the button goes down.
    const scale = s.sensitivity * (1 + (s.adsSensitivity - 1) * adsFactor);
    this.yaw -= this.dx * scale;
    this.pitch += (s.invertY ? this.dy : -this.dy) * scale;
    this.pitch = clamp(this.pitch, -PITCH_LIMIT, PITCH_LIMIT);
    // Keep yaw in a sane range so f32 precision never degrades over a session.
    if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
    else if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    this.dx = 0;
    this.dy = 0;
  }

  /** Fills `cmd` with the current intent. `seq` is assigned by the caller. */
  fillCommand(cmd: InputCmd): void {
    const holdSprint = this.settings.get('toggleSprint') ? this.sprintLatch : this.held.has('sprint');
    const holdAds = this.settings.get('toggleAds') ? this.adsLatch : (this.mouseHeld & MOUSE_RIGHT) !== 0;

    let forward = 0;
    if (this.held.has('fwd')) forward += 1;
    if (this.held.has('back')) forward -= 1;
    let right = 0;
    if (this.held.has('right')) right += 1;
    if (this.held.has('left')) right -= 1;

    let buttons = 0;
    if (this.held.has('jump')) buttons |= BTN.JUMP;
    if (this.held.has('crouch')) buttons |= BTN.CROUCH;
    if (holdSprint) buttons |= BTN.SPRINT;
    // Include the edge so a tap shorter than a tick still registers.
    if ((this.mouseHeld & MOUSE_LEFT) !== 0 || (this.mousePressedEdge & MOUSE_LEFT) !== 0) buttons |= BTN.FIRE;
    if (holdAds) buttons |= BTN.ADS;
    if (this.held.has('reload') || this.pressedEdge.has('reload')) buttons |= BTN.RELOAD;

    cmd.forward = forward;
    cmd.right = right;
    cmd.buttons = buttons;
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
  }

  /** Clears one-shot edges. Call immediately after `fillCommand` is consumed. */
  endTick(): void {
    this.pressedEdge.clear();
    this.mousePressedEdge = 0;
  }

  /** True if the primary trigger is down right now (used for view kick). */
  get firing(): boolean {
    return (this.mouseHeld & MOUSE_LEFT) !== 0;
  }

  /** True if a mouse button was pressed since the last `endTick`. */
  clickedThisFrame(): boolean {
    return this.mousePressedEdge !== 0;
  }
}
