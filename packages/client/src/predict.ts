/**
 * Client-side prediction and reconciliation.
 *
 * The local player moves the instant a key goes down, without waiting for the
 * server, because a round trip of even 40 ms makes controls feel like glue. The
 * price is that the client is guessing, and every snapshot is the server telling
 * us what actually happened one round trip ago.
 *
 * The loop:
 *   1. Each tick, stamp the input with a sequence number, run the *shared*
 *      movement code locally, and keep the command in a pending list.
 *   2. When a snapshot arrives it carries `ackSeq` — the last command the server
 *      consumed — plus the authoritative state after consuming it.
 *   3. Drop every acked command, rewind the local state to the server's, and
 *      replay the still-pending commands through the same shared movement code.
 *
 * Because step 3 runs the identical function the server ran, the replay lands
 * exactly where the server will end up, and the two only disagree when the
 * server injected something we could not know about — a knockback, a teleport,
 * a spawn. That disagreement is the *error*, and how it is applied is the whole
 * difference between netcode that feels solid and netcode that feels like ice:
 *
 *   • Large error (> SNAP_DIST): something discontinuous happened. Snap. Trying
 *     to smooth a respawn across the map produces a player sliding through
 *     walls at 40 m/s.
 *   • Small error: almost certainly float drift or a one-tick timing difference.
 *     Snapping here is what causes the classic prediction jitter, so instead the
 *     error is stored as a decaying visual offset — the simulation is corrected
 *     immediately and *exactly*, while the camera walks to the truth over about
 *     100 ms. The player never sees a pop and the collision state is never wrong.
 */

import {
  EYE_HEIGHT,
  EYE_HEIGHT_CROUCH,
  PLAYER_HEIGHT,
  PLAYER_CROUCH_HEIGHT,
  TICK_DT,
  copyInputCmd,
  newInputCmd,
  stepMovement,
  v3,
  type Box,
  type InputCmd,
  type MoveState,
  type SelfState,
  type Vec3,
} from '@oneshot/shared';

/** Beyond this positional error the correction is applied instantly. */
const SNAP_DIST = 1.6;
/** Below this the error is ignored entirely — it is float noise. */
const DEAD_ZONE = 0.0012;
/** Time constant for walking the visual offset back to zero. */
const SMOOTH_RATE = 14;
/** Hard cap on stored commands; ~2.7 s at 60 Hz, far past any playable ping. */
const MAX_PENDING = 160;

export interface PredictHooks {
  /** Movement speed multiplier for the weapon/stance the client believes it has. */
  speedMult(): number;
}

export class Predictor {
  /** Authoritative-plus-replay simulation state. This is the *real* position. */
  readonly state: MoveState = {
    pos: v3(0, 0.05, 0),
    vel: v3(0, 0, 0),
    onGround: false,
    crouching: false,
    height: PLAYER_HEIGHT,
  };

  /** Visual-only offset, decayed to zero. Added to `state.pos` for rendering. */
  readonly visualError: Vec3 = v3(0, 0, 0);

  /** Monotonic input sequence. Starts at 1 so 0 can mean "nothing acked". */
  seq = 0;

  /** Commands sent but not yet acknowledged, oldest first. */
  readonly pending: InputCmd[] = [];

  /** Set for one frame after a snapshot forced a hard snap. */
  snappedThisFrame = false;

  /** Diagnostics: magnitude of the last correction the server demanded, in m. */
  lastError = 0;
  /** Rolling count of replayed commands — a direct read on effective latency. */
  replayCount = 0;

  private hooks: PredictHooks;
  private brushes: readonly Box[] = [];
  /** Scratch command reused by the tick path so stepping allocates nothing. */
  private scratch: InputCmd = newInputCmd();
  /** Free list so a 60 Hz input stream does not allocate a command per tick. */
  private pool: InputCmd[] = [];

  constructor(hooks: PredictHooks) {
    this.hooks = hooks;
  }

  setWorld(brushes: readonly Box[]): void {
    this.brushes = brushes;
  }

  /** Hard reset — used on join and on map change. */
  reset(x: number, y: number, z: number): void {
    this.state.pos.x = x;
    this.state.pos.y = y;
    this.state.pos.z = z;
    this.state.vel.x = 0;
    this.state.vel.y = 0;
    this.state.vel.z = 0;
    this.state.onGround = false;
    this.state.crouching = false;
    this.state.height = PLAYER_HEIGHT;
    this.visualError.x = 0;
    this.visualError.y = 0;
    this.visualError.z = 0;
    this.recycleAll();
    this.lastError = 0;
    this.replayCount = 0;
  }

  /**
   * Advances the local simulation by one tick with the player's current intent.
   * `fill` writes the command; doing it through a callback keeps input handling
   * out of here and avoids an intermediate allocation.
   */
  tick(fill: (cmd: InputCmd) => void, dead: boolean): InputCmd {
    const cmd = this.take();
    this.seq = (this.seq + 1) >>> 0;
    cmd.seq = this.seq;
    fill(cmd);

    if (dead) {
      // A corpse still sends commands — the server needs the view angles for the
      // death camera and needs to see the respawn button — but it must not move.
      cmd.forward = 0;
      cmd.right = 0;
      cmd.buttons = 0;
    } else {
      stepMovement(this.state, cmd, this.brushes, this.hooks.speedMult(), TICK_DT);
    }

    this.pending.push(cmd);
    // Overflow means the server has gone quiet. Drop the oldest rather than grow
    // without bound; if it comes back, the next snapshot resyncs us anyway.
    while (this.pending.length > MAX_PENDING) this.release(this.pending.shift()!);
    return cmd;
  }

  /**
   * Folds an authoritative snapshot into the local state.
   *
   * Returns the number of commands replayed, which is a useful proxy for how
   * much prediction is actually doing at the current ping.
   */
  reconcile(self: SelfState, ackSeq: number, dead: boolean): number {
    this.snappedThisFrame = false;

    // Remember where we currently *think* we are, so the correction can be
    // expressed as a visual delta rather than a jump.
    const prevX = this.state.pos.x;
    const prevY = this.state.pos.y;
    const prevZ = this.state.pos.z;

    // Discard everything the server has already consumed.
    let cut = 0;
    while (cut < this.pending.length && seqLE(this.pending[cut]!.seq, ackSeq)) cut++;
    if (cut > 0) {
      for (let i = 0; i < cut; i++) this.release(this.pending[i]!);
      this.pending.splice(0, cut);
    }

    // Rewind to truth.
    this.state.pos.x = self.x;
    this.state.pos.y = self.y;
    this.state.pos.z = self.z;
    this.state.vel.x = self.vx;
    this.state.vel.y = self.vy;
    this.state.vel.z = self.vz;

    let replayed = 0;
    if (!dead) {
      const mult = this.hooks.speedMult();
      for (let i = 0; i < this.pending.length; i++) {
        stepMovement(this.state, this.pending[i]!, this.brushes, mult, TICK_DT);
        replayed++;
      }
    } else {
      this.recycleAll();
    }
    this.replayCount = replayed;

    // Compare the replayed result against what we were showing.
    const ex = prevX - this.state.pos.x;
    const ey = prevY - this.state.pos.y;
    const ez = prevZ - this.state.pos.z;
    const err = Math.hypot(ex, ey, ez);
    this.lastError = err;

    if (err > SNAP_DIST || dead) {
      // Respawn, teleport, or a desync too big to hide: take it on the chin.
      this.visualError.x = 0;
      this.visualError.y = 0;
      this.visualError.z = 0;
      this.snappedThisFrame = true;
    } else if (err > DEAD_ZONE) {
      // Absorb the whole correction into the visual offset. The simulation is
      // already exactly right; only the camera lags, and only briefly.
      this.visualError.x = ex;
      this.visualError.y = ey;
      this.visualError.z = ez;
    }

    return replayed;
  }

  /** Decays the visual offset. Frame-rate independent; call once per frame. */
  smooth(dt: number): void {
    const e = this.visualError;
    if (e.x === 0 && e.y === 0 && e.z === 0) return;
    // Exponential decay toward zero: the same curve `damp` uses, written out
    // because we want the bare multiplier rather than an interpolated value.
    const k = Math.exp(-SMOOTH_RATE * dt);
    e.x *= k;
    e.y *= k;
    e.z *= k;
    // Snap the tail to zero so it does not sit at 1e-9 forever.
    if (Math.abs(e.x) < 1e-5) e.x = 0;
    if (Math.abs(e.y) < 1e-5) e.y = 0;
    if (Math.abs(e.z) < 1e-5) e.z = 0;
  }

  /** Rendered eye position: simulation truth plus the decaying error. */
  eyePosition(out: Vec3): Vec3 {
    const crouchT = this.crouchFraction();
    out.x = this.state.pos.x + this.visualError.x;
    out.y =
      this.state.pos.y +
      this.visualError.y +
      EYE_HEIGHT +
      (EYE_HEIGHT_CROUCH - EYE_HEIGHT) * crouchT;
    out.z = this.state.pos.z + this.visualError.z;
    return out;
  }

  /** 0 = standing, 1 = fully crouched. Derived from the collider height so the
   *  camera follows the same curve the collision does. */
  crouchFraction(): number {
    const span = PLAYER_HEIGHT - PLAYER_CROUCH_HEIGHT;
    if (span <= 0) return 0;
    const t = (PLAYER_HEIGHT - this.state.height) / span;
    return t < 0 ? 0 : t > 1 ? 1 : t;
  }

  /** Horizontal speed, for view bob and the speed readout. */
  get speedXZ(): number {
    return Math.hypot(this.state.vel.x, this.state.vel.z);
  }

  /* ── Command pool ─────────────────────────────────────────────────────── */

  private take(): InputCmd {
    const c = this.pool.pop();
    if (c) return c;
    return newInputCmd();
  }

  private release(c: InputCmd): void {
    if (this.pool.length < MAX_PENDING) this.pool.push(c);
  }

  private recycleAll(): void {
    for (const c of this.pending) this.release(c);
    this.pending.length = 0;
  }

  /** Copies the newest pending command, for callers that need to inspect it. */
  latest(out: InputCmd): boolean {
    const c = this.pending[this.pending.length - 1];
    if (!c) return false;
    copyInputCmd(out, c);
    return true;
  }

  /**
   * Restores the local state from a snapshot without replay, used while dead so
   * the death camera sits at the body rather than wherever prediction drifted.
   */
  hardSet(self: SelfState): void {
    this.state.pos.x = self.x;
    this.state.pos.y = self.y;
    this.state.pos.z = self.z;
    this.state.vel.x = 0;
    this.state.vel.y = 0;
    this.state.vel.z = 0;
    this.visualError.x = 0;
    this.visualError.y = 0;
    this.visualError.z = 0;
    this.recycleAll();
  }
}

/**
 * Sequence comparison that survives the u32 wrap in the wire format.
 * Straight `<=` would break once seq crosses 2^32, roughly 2.3 years of
 * continuous play — cheap enough to just do correctly.
 */
function seqLE(a: number, b: number): boolean {
  return ((b - a) >>> 0) < 0x80000000;
}
