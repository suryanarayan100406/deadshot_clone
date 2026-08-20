import {
  ACCEL_AIR,
  ACCEL_GROUND,
  FRICTION_GROUND,
  FRICTION_STOP_SPEED,
  GRAVITY,
  JUMP_SPEED,
  MAX_FALL_SPEED,
  PLAYER_CROUCH_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_RADIUS,
  SPEED_CROUCH,
  SPEED_SPRINT,
  SPEED_WALK,
  STAMINA_COOLDOWN,
  STAMINA_DRAIN_RATE,
  STAMINA_MAX,
  STAMINA_RECOVER_RATE,
  STEP_HEIGHT,
  TICK_DT,
} from './constants';
import { canFit, moveWithCollision, type Box, type MoveResult } from './collision';
import type { Vec3 } from './math';

/** Button bitfield shared by the wire protocol and the simulation. */
export const BTN = {
  JUMP: 1 << 0,
  CROUCH: 1 << 1,
  SPRINT: 1 << 2,
  FIRE: 1 << 3,
  ADS: 1 << 4,
  RELOAD: 1 << 5,
} as const;

/** One tick of player intent. The server trusts the axes and angles, never position. */
export interface InputCmd {
  seq: number;
  /** -1 back … +1 forward */
  forward: number;
  /** -1 left … +1 right */
  right: number;
  buttons: number;
  yaw: number;
  pitch: number;
}

export function newInputCmd(): InputCmd {
  return { seq: 0, forward: 0, right: 0, buttons: 0, yaw: 0, pitch: 0 };
}

export function copyInputCmd(dst: InputCmd, src: InputCmd): InputCmd {
  dst.seq = src.seq;
  dst.forward = src.forward;
  dst.right = src.right;
  dst.buttons = src.buttons;
  dst.yaw = src.yaw;
  dst.pitch = src.pitch;
  return dst;
}

/** The part of a player that movement owns. Client prediction and the server both
 *  keep one of these and advance it with `stepMovement`. */
export interface MoveState {
  pos: Vec3;
  vel: Vec3;
  onGround: boolean;
  crouching: boolean;
  /** Current body height — animates between standing and crouching. */
  height: number;
  /** Current sprint stamina (0..1). */
  stamina?: number;
  /** Cooldown time remaining before stamina begins recharging. */
  staminaCooldown?: number;
}

/** Quake-style acceleration: only ever adds speed up to `wishSpeed` along `wishDir`,
 *  which is what makes air-strafing work without special-casing it. */
function accelerate(
  vel: Vec3,
  wx: number,
  wz: number,
  wishSpeed: number,
  accel: number,
  dt: number,
): void {
  const current = vel.x * wx + vel.z * wz;
  const add = wishSpeed - current;
  if (add <= 0) return;
  let gain = accel * dt;
  if (gain > add) gain = add;
  vel.x += wx * gain;
  vel.z += wz * gain;
}

function applyFriction(vel: Vec3, dt: number): void {
  const speed = Math.sqrt(vel.x * vel.x + vel.z * vel.z);
  if (speed < 1e-4) {
    vel.x = 0;
    vel.z = 0;
    return;
  }
  const control = speed < FRICTION_STOP_SPEED ? FRICTION_STOP_SPEED : speed;
  let next = speed - control * FRICTION_GROUND * dt;
  if (next < 0) next = 0;
  const scale = next / speed;
  vel.x *= scale;
  vel.z *= scale;
}

/**
 * Advance one player by one tick. This is the single authority on movement:
 * the server calls it to simulate, and the client calls it to predict and to replay
 * unacknowledged inputs during reconciliation. Determinism between the two is the
 * whole reason it lives in `shared`.
 *
 * `speedMult` lets weapon state slow the player (ADS, sniper handling) without this
 * function knowing anything about weapons.
 */
export function stepMovement(
  s: MoveState,
  cmd: InputCmd,
  brushes: readonly Box[],
  speedMult = 1,
  dt: number = TICK_DT,
): MoveResult {
  const wantJump = (cmd.buttons & BTN.JUMP) !== 0;
  const wantCrouch = (cmd.buttons & BTN.CROUCH) !== 0;
  const wantSprint = (cmd.buttons & BTN.SPRINT) !== 0;

  // ── Crouch state ─────────────────────────────────────────────────────────
  // Going down is always allowed; standing up requires headroom.
  if (wantCrouch) {
    s.crouching = true;
    s.height = PLAYER_CROUCH_HEIGHT;
  } else if (s.crouching) {
    if (canFit(s.pos.x, s.pos.y, s.pos.z, PLAYER_RADIUS, PLAYER_HEIGHT, brushes)) {
      s.crouching = false;
      s.height = PLAYER_HEIGHT;
    } else {
      s.height = PLAYER_CROUCH_HEIGHT;
    }
  } else {
    s.height = PLAYER_HEIGHT;
  }

  // ── Desired direction ────────────────────────────────────────────────────
  const sy = Math.sin(cmd.yaw);
  const cy = Math.cos(cmd.yaw);
  // forward = (-sin y, 0, -cos y), right = (cos y, 0, -sin y)
  let wx = -sy * cmd.forward + cy * cmd.right;
  let wz = -cy * cmd.forward - sy * cmd.right;

  const wishLen = Math.sqrt(wx * wx + wz * wz);

  // ── Stamina & Sprint Calculation ──────────────────────────────────────────
  let curStamina = s.stamina ?? STAMINA_MAX;
  let curCooldown = s.staminaCooldown ?? 0;

  let isSprinting = false;
  if (curCooldown > 0) {
    curCooldown = Math.max(0, curCooldown - dt);
  } else if (wantSprint && cmd.forward > 0 && !s.crouching && curStamina > 0) {
    isSprinting = true;
    curStamina = Math.max(0, curStamina - STAMINA_DRAIN_RATE * dt);
    if (curStamina <= 0) {
      curStamina = 0;
      curCooldown = STAMINA_COOLDOWN;
      isSprinting = false;
    }
  } else if (!wantSprint || cmd.forward <= 0 || s.crouching) {
    if (curStamina < STAMINA_MAX) {
      curStamina = Math.min(STAMINA_MAX, curStamina + STAMINA_RECOVER_RATE * dt);
    }
  }

  s.stamina = curStamina;
  s.staminaCooldown = curCooldown;

  let base = s.crouching ? SPEED_CROUCH : isSprinting ? SPEED_SPRINT : SPEED_WALK;
  base *= speedMult;
  const wishSpeed = wishLen > 1e-5 ? base * Math.min(1, wishLen) : 0;
  if (wishLen > 1e-5) {
    wx /= wishLen;
    wz /= wishLen;
  }

  // ── Accelerate ───────────────────────────────────────────────────────────
  const grounded = s.onGround;
  if (grounded) {
    applyFriction(s.vel, dt);
    if (wishSpeed > 0) accelerate(s.vel, wx, wz, wishSpeed, ACCEL_GROUND, dt);
  } else if (wishSpeed > 0) {
    accelerate(s.vel, wx, wz, wishSpeed, ACCEL_AIR, dt);
  }

  // ── Vertical ─────────────────────────────────────────────────────────────
  if (grounded && wantJump) {
    s.vel.y = JUMP_SPEED;
    s.onGround = false;
  } else {
    s.vel.y -= GRAVITY * dt;
    if (s.vel.y < -MAX_FALL_SPEED) s.vel.y = -MAX_FALL_SPEED;
  }

  // ── Integrate + resolve ──────────────────────────────────────────────────
  const res = moveWithCollision(
    s.pos,
    s.vel,
    PLAYER_RADIUS,
    s.height,
    brushes,
    dt,
    grounded ? STEP_HEIGHT : 0,
  );
  s.onGround = res.onGround;
  return res;
}
