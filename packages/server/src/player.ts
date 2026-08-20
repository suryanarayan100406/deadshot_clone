import {
  AMMO_REFILL_MAGS_PER_KILL,
  BTN,
  DEFAULT_LOADOUT,
  EYE_HEIGHT,
  EYE_HEIGHT_CROUCH,
  MAX_HEALTH,
  PLAYER_HEIGHT,
  TEAM_NONE,
  WEAPON_BY_KEY,
  cycleTime,
  newInputCmd,
  v3,
  weaponById,
  type GameEvent,
  type InputCmd,
  type MoveState,
  type WeaponDef,
} from '@oneshot/shared';
import type { WebSocket } from 'ws';

/** Per-slot ammunition. Index matches `loadout`. */
interface AmmoState {
  mag: number;
  reserve: number;
}

let nextId = 1;

export class ServerPlayer {
  readonly id: number;
  name: string;
  team = TEAM_NONE;
  readonly isBot: boolean;
  socket: WebSocket | null;

  move: MoveState = {
    pos: v3(0, 0.05, 0),
    vel: v3(),
    onGround: false,
    crouching: false,
    height: PLAYER_HEIGHT,
  };
  yaw = 0;
  pitch = 0;

  health = MAX_HEALTH;
  alive = true;
  kills = 0;
  deaths = 0;
  streak = 0;
  bestStreak = 0;

  loadout: WeaponDef[];
  slot = 0;
  ammo: AmmoState[];
  /** Absolute ms timestamps. */
  nextFireAt = 0;
  reloadEndAt = 0;
  switchEndAt = 0;
  burstLeft = 0;
  nextBurstAt = 0;
  /** Accumulated bloom, radians. */
  spread = 0;
  ads = 0;

  respawnAt = 0;
  spawnProtectUntil = 0;
  lastDamageAt = -1e9;
  lastAttacker = -1;

  // ── Networking ────────────────────────────────────────────────────────────
  inputQueue: InputCmd[] = [];
  lastInput: InputCmd = newInputCmd();
  prevButtons = 0;
  lastAckedSeq = 0;
  ping = 0;
  lastPacketAt = 0;
  /** Events destined only for this client (hitmarkers, damage direction). */
  events: GameEvent[] = [];
  /** Set when the roster changes so we resend it promptly. */
  rosterDirty = true;

  // ── Lobby ─────────────────────────────────────────────────────────────────
  /**
   * Readied up in the pre-match lobby.
   *
   * Cleared by the room when a match begins rather than left standing, so the
   * next lobby does not open with everybody already ready from the last one —
   * which would leave the host's Start armed for a round nobody had agreed to
   * yet, since consent is exactly what that button is gated on.
   */
  ready = false;

  constructor(name: string, isBot: boolean, socket: WebSocket | null, primaryKey?: string) {
    this.id = nextId++;
    if (nextId > 60000) nextId = 1;
    this.name = name;
    this.isBot = isBot;
    this.socket = socket;

    const primary = (primaryKey && WEAPON_BY_KEY[primaryKey]) || WEAPON_BY_KEY[DEFAULT_LOADOUT[0]]!;
    this.loadout = [primary, WEAPON_BY_KEY[DEFAULT_LOADOUT[1]]!, WEAPON_BY_KEY[DEFAULT_LOADOUT[2]]!];
    this.ammo = this.loadout.map((w) => ({ mag: w.magSize, reserve: w.reserveSize }));
  }

  get weapon(): WeaponDef {
    return this.loadout[this.slot]!;
  }

  get ammoState(): AmmoState {
    return this.ammo[this.slot]!;
  }

  get eyeY(): number {
    return this.move.pos.y + (this.move.crouching ? EYE_HEIGHT_CROUCH : EYE_HEIGHT);
  }

  get reloading(): boolean {
    return this.reloadEndAt > 0;
  }

  setLoadoutPrimary(key: string): void {
    const w = WEAPON_BY_KEY[key];
    if (!w || w.slot !== 'primary') return;
    this.loadout[0] = w;
    this.ammo[0] = { mag: w.magSize, reserve: w.reserveSize };
  }

  resetForSpawn(x: number, y: number, z: number, yaw: number, now: number): void {
    this.move.pos.x = x;
    this.move.pos.y = y;
    this.move.pos.z = z;
    this.move.vel.x = 0;
    this.move.vel.y = 0;
    this.move.vel.z = 0;
    this.move.onGround = false;
    this.move.crouching = false;
    this.move.height = PLAYER_HEIGHT;
    this.yaw = yaw;
    this.pitch = 0;
    this.health = MAX_HEALTH;
    this.alive = true;
    this.slot = 0;
    this.ammo = this.loadout.map((w) => ({ mag: w.magSize, reserve: w.reserveSize }));
    this.spread = 0;
    this.ads = 0;
    this.reloadEndAt = 0;
    this.burstLeft = 0;
    this.nextFireAt = now;
    this.switchEndAt = now;
    this.streak = 0;
    this.lastDamageAt = -1e9;
  }

  /** Begin a reload if one makes sense. */
  tryReload(now: number): boolean {
    if (this.reloading) return false;
    const w = this.weapon;
    if (w.magSize <= 0) return false;
    const a = this.ammoState;
    if (a.mag >= w.magSize || a.reserve <= 0) return false;
    this.reloadEndAt = now + w.reloadTime * 1000;
    return true;
  }

  finishReloadIfDue(now: number): void {
    if (!this.reloading || now < this.reloadEndAt) return;
    const w = this.weapon;
    const a = this.ammoState;
    const want = w.magSize - a.mag;
    const take = Math.min(want, a.reserve);
    a.mag += take;
    a.reserve -= take;
    this.reloadEndAt = 0;
    this.nextFireAt = Math.max(this.nextFireAt, now);
  }

  /**
   * Resupply for a kill, paid into every slot's reserve.
   *
   * Reserve ammunition is otherwise a one-way countdown that only resets on
   * death, so the player who never dies is the one who ends up holding a knife —
   * the mode punishing exactly what it scores. Paying it out of kills keeps an
   * aggressive player supplied without handing free ammunition to someone
   * emptying magazines into a wall.
   *
   * Capped at the starting reserve so it tops up rather than stockpiles.
   */
  refillOnKill(): void {
    for (let i = 0; i < this.loadout.length; i++) {
      const w = this.loadout[i]!;
      if (w.magSize <= 0) continue;
      const a = this.ammo[i]!;
      const gain = Math.max(1, Math.round(w.magSize * AMMO_REFILL_MAGS_PER_KILL));
      a.reserve = Math.min(w.reserveSize, a.reserve + gain);
    }
  }

  switchTo(slot: number, now: number): boolean {
    if (slot < 0 || slot >= this.loadout.length || slot === this.slot) return false;
    this.slot = slot;
    this.reloadEndAt = 0;
    this.burstLeft = 0;
    this.spread = 0;
    this.ads = 0;
    this.switchEndAt = now + this.loadout[slot]!.switchTime * 1000;
    this.nextFireAt = this.switchEndAt;
    return true;
  }

  /** True on the tick a button transitions from up to down. */
  pressed(button: number, buttons: number): boolean {
    return (buttons & button) !== 0 && (this.prevButtons & button) === 0;
  }

  /** Live spread cone half-angle, accounting for stance and motion. */
  currentSpread(): number {
    const w = this.weapon;
    let s = w.spreadBase + this.spread;
    const hspeed = Math.hypot(this.move.vel.x, this.move.vel.z);
    s += w.spreadMove * Math.min(1, hspeed / 6.2);
    if (!this.move.onGround) s += w.spreadAir;
    if (this.ads > 0.5) s *= w.adsSpreadMult;
    return Math.min(s, w.spreadMax + w.spreadAir + w.spreadMove);
  }

  /** Movement multiplier from weapon handling and aiming. */
  speedMult(): number {
    const w = this.weapon;
    return w.moveMult + (w.adsMoveMult - w.moveMult) * this.ads;
  }

  decayCombatState(dt: number, buttons: number): void {
    const w = this.weapon;
    const target = (buttons & BTN.ADS) !== 0 && this.alive ? 1 : 0;
    const rate = w.adsTime > 0 ? dt / w.adsTime : 1;
    this.ads += (target - this.ads) * Math.min(1, rate * 3);
    if (this.ads < 0.001) this.ads = 0;
    if (this.ads > 0.999) this.ads = 1;

    this.spread -= w.spreadRecovery * dt;
    if (this.spread < 0) this.spread = 0;
  }

  /**
   * Book-keeping after a shot leaves the barrel.
   *
   * The next-fire time accumulates from the previous scheduled shot rather than
   * from `now`, so a 900 rpm weapon keeps its true rate instead of being rounded
   * up to a whole tick every time. If the gun has been idle longer than one cycle
   * the schedule restarts from `now`, otherwise a long pause would bank up shots.
   */
  onShotFired(now: number): void {
    const w = this.weapon;
    this.spread = Math.min(this.spread + w.spreadPerShot, w.spreadMax);
    const cycle = cycleTime(w) * 1000;
    const base = this.nextFireAt > now - cycle ? this.nextFireAt : now;
    this.nextFireAt = base + cycle;
  }

  weaponIdOf(slot = this.slot): number {
    return this.loadout[slot]!.id;
  }

  send(data: Uint8Array): void {
    const s = this.socket;
    if (!s || s.readyState !== 1) return;
    try {
      s.send(data, { binary: true });
    } catch {
      /* socket died mid-send; the close handler will clean up */
    }
  }
}

export { weaponById };
