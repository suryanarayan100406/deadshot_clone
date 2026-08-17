/**
 * Bots.
 *
 * A bot is a `ServerPlayer` with no socket. Instead of receiving `InputCmd`s over
 * the wire, its controller synthesises one every tick — same struct, same
 * simulation path, same weapon state machine. Nothing downstream knows the
 * difference, which means bots exercise exactly the code real players do.
 *
 * The behaviour is deliberately simple and readable: pick a target, walk a
 * waypoint loop when there is none, and when there is one, close to a preferred
 * range while strafing. Aim is smoothed toward the target with a per-bot error
 * cone and a reaction delay so they miss like people do rather than snapping.
 */

import {
  BTN,
  EYE_HEIGHT,
  PITCH_LIMIT,
  TICK_DT,
  clamp,
  losClear,
  makeRng,
  v3,
  wrapAngle,
  type Box,
  type GameMap,
  type InputCmd,
} from '@oneshot/shared';
import type { ServerPlayer } from './player.js';

export interface BotSkill {
  /** How fast the view converges on the target, radians/sec of correction gain. */
  turnRate: number;
  /** Radius of the persistent aim error cone, radians. */
  aimError: number;
  /** Seconds before a newly-spotted target is engaged. */
  reaction: number;
  /** Chance per second of jumping while fighting. */
  jumpiness: number;
  /** Preferred engagement distance, metres. */
  preferredRange: number;
  /** Fraction of the time the trigger is held once on target. */
  triggerDiscipline: number;
}

export const SKILLS: Record<string, BotSkill> = {
  easy: {
    turnRate: 3.4,
    aimError: 0.055,
    reaction: 0.5,
    jumpiness: 0.15,
    preferredRange: 16,
    triggerDiscipline: 0.55,
  },
  normal: {
    turnRate: 6.0,
    aimError: 0.03,
    reaction: 0.3,
    jumpiness: 0.4,
    preferredRange: 14,
    triggerDiscipline: 0.75,
  },
  hard: {
    turnRate: 9.5,
    aimError: 0.014,
    reaction: 0.17,
    jumpiness: 0.7,
    preferredRange: 12,
    triggerDiscipline: 0.9,
  },
};

const BOT_NAMES = [
  'Ash',
  'Baker',
  'Cinder',
  'Dune',
  'Echo',
  'Flint',
  'Ghost',
  'Halo',
  'Iron',
  'Jinx',
  'Kilo',
  'Lynx',
  'Mako',
  'Nomad',
  'Onyx',
  'Pilot',
  'Quartz',
  'Rook',
  'Scout',
  'Talon',
  'Umber',
  'Vex',
  'Wraith',
  'Zephyr',
];

let nameCursor = 0;
export function nextBotName(): string {
  const base = BOT_NAMES[nameCursor % BOT_NAMES.length]!;
  const round = Math.floor(nameCursor / BOT_NAMES.length);
  nameCursor++;
  return round === 0 ? base : `${base}${round + 1}`;
}

const selfEye = v3();
const targetEye = v3();

export class Bot {
  readonly player: ServerPlayer;
  readonly skill: BotSkill;
  private rng: () => number;

  private cmd: InputCmd = { seq: 0, forward: 0, right: 0, buttons: 0, yaw: 0, pitch: 0 };

  private targetId = -1;
  private retargetIn = 0;
  private seenFor = 0;
  private lostFor = 0;

  /** Persistent aim bias, re-rolled when a new target is acquired. */
  private errYaw = 0;
  private errPitch = 0;

  private strafe = 1;
  private strafeIn = 0;
  private wanderX = 0;
  private wanderZ = 0;
  private wanderIn = 0;
  private stuckFor = 0;
  private lastX = 0;
  private lastZ = 0;
  private reloadCooldown = 0;

  constructor(player: ServerPlayer, skill: BotSkill, seed: number) {
    this.player = player;
    this.skill = skill;
    this.rng = makeRng(seed);
    this.yaw = player.yaw;
    this.pitch = 0;
    this.wanderIn = 0;
  }

  private yaw = 0;
  private pitch = 0;

  /** Called once per tick before the shared movement step. */
  think(
    enemies: readonly ServerPlayer[],
    brushes: readonly Box[],
    map: GameMap,
    seq: number,
  ): InputCmd {
    const p = this.player;
    const c = this.cmd;
    c.seq = seq;
    c.forward = 0;
    c.right = 0;
    c.buttons = 0;

    if (!p.alive) {
      c.yaw = this.yaw;
      c.pitch = this.pitch;
      return c;
    }

    const dt = TICK_DT;
    this.retargetIn -= dt;
    this.strafeIn -= dt;
    this.wanderIn -= dt;
    this.reloadCooldown -= dt;

    // ── Target selection ─────────────────────────────────────────────────────
    selfEye.x = p.move.pos.x;
    selfEye.y = p.eyeY;
    selfEye.z = p.move.pos.z;

    let target = this.resolveTarget(enemies);
    if (this.retargetIn <= 0 || !target) {
      const picked = this.pickTarget(enemies, brushes);
      if (picked && picked !== target) {
        this.errYaw = (this.rng() * 2 - 1) * this.skill.aimError;
        this.errPitch = (this.rng() * 2 - 1) * this.skill.aimError * 0.6;
        this.seenFor = 0;
      }
      target = picked;
      this.targetId = target ? target.id : -1;
      this.retargetIn = 0.45 + this.rng() * 0.5;
    }

    let visible = false;
    let dist = 0;
    if (target) {
      targetEye.x = target.move.pos.x;
      targetEye.y = target.eyeY;
      targetEye.z = target.move.pos.z;
      dist = Math.hypot(targetEye.x - selfEye.x, targetEye.z - selfEye.z);
      visible = dist < 90 && losClear(selfEye, targetEye, brushes);
    }

    if (visible) {
      this.seenFor += dt;
      this.lostFor = 0;
    } else {
      this.lostFor += dt;
      if (this.lostFor > 1.6) this.seenFor = 0;
    }

    // ── Aim ──────────────────────────────────────────────────────────────────
    let wantYaw = this.yaw;
    let wantPitch = this.pitch;

    if (target && (visible || this.lostFor < 0.8)) {
      // Lead a moving target slightly; hitscan needs almost none, but a touch of
      // lead makes bots track strafing players instead of trailing them.
      const lead = 0.06;
      const tx = targetEye.x + target.move.vel.x * lead;
      const ty = targetEye.y - 0.15 + target.move.vel.y * lead;
      const tz = targetEye.z + target.move.vel.z * lead;
      const dx = tx - selfEye.x;
      const dy = ty - selfEye.y;
      const dz = tz - selfEye.z;
      const flat = Math.hypot(dx, dz) || 1e-5;
      // Inverse of dirFromAngles: dir = (-sin y * cp, sin p, -cos y * cp)
      wantYaw = Math.atan2(-dx, -dz) + this.errYaw;
      wantPitch = Math.atan2(dy, flat) + this.errPitch;
    } else if (this.wanderX !== 0 || this.wanderZ !== 0) {
      const dx = this.wanderX - p.move.pos.x;
      const dz = this.wanderZ - p.move.pos.z;
      if (Math.hypot(dx, dz) > 0.5) wantYaw = Math.atan2(-dx, -dz);
      wantPitch *= 0.9;
    }

    const gain = Math.min(1, this.skill.turnRate * dt);
    this.yaw = wrapAngle(this.yaw + wrapAngle(wantYaw - this.yaw) * gain);
    this.pitch = clamp(this.pitch + (wantPitch - this.pitch) * gain, -PITCH_LIMIT, PITCH_LIMIT);
    c.yaw = this.yaw;
    c.pitch = this.pitch;

    // ── Movement ─────────────────────────────────────────────────────────────
    if (target && visible) {
      const err = Math.abs(wrapAngle(wantYaw - this.yaw));
      const range = this.skill.preferredRange;
      if (dist > range * 1.25) c.forward = 1;
      else if (dist < range * 0.45) c.forward = -1;
      else c.forward = this.rng() < 0.25 ? 0.35 : 0;

      if (this.strafeIn <= 0) {
        this.strafe = this.rng() < 0.5 ? -1 : 1;
        this.strafeIn = 0.5 + this.rng() * 1.1;
      }
      c.right = this.strafe;
      if (c.forward > 0.9 && dist > 26) c.buttons |= BTN.SPRINT;
      if (this.rng() < this.skill.jumpiness * dt) c.buttons |= BTN.JUMP;

      // ── Fire ───────────────────────────────────────────────────────────────
      const w = p.weapon;
      const onTarget = err < 0.045 + (w.spreadBase + p.spread) * 2 + 0.6 / Math.max(4, dist);
      const inRange = dist < w.range * 0.9;
      const ready = this.seenFor >= this.skill.reaction;
      if (ready && onTarget && inRange && this.rng() < this.skill.triggerDiscipline) {
        c.buttons |= BTN.FIRE;
      }
      // Aim down sights at range with anything that benefits.
      if (dist > 18 && w.adsFovMult < 0.95 && ready) c.buttons |= BTN.ADS;
      if (dist < 3.2 && p.loadout.length > 2 && p.slot !== 2) {
        // Close enough to knife: handled by the room's switch request path.
        this.wantSlot = 2;
      } else if (p.slot === 2 && dist > 5) {
        this.wantSlot = 0;
      } else {
        this.wantSlot = -1;
      }
    } else {
      // ── Wander ─────────────────────────────────────────────────────────────
      if (this.wanderIn <= 0 || this.reachedWander(p)) this.newWaypoint(map);
      const dx = this.wanderX - p.move.pos.x;
      const dz = this.wanderZ - p.move.pos.z;
      if (Math.hypot(dx, dz) > 0.6) {
        c.forward = 1;
        c.buttons |= BTN.SPRINT;
      }
      this.wantSlot = p.slot === 0 ? -1 : 0;
    }

    // ── Unstick ──────────────────────────────────────────────────────────────
    const moved = Math.hypot(p.move.pos.x - this.lastX, p.move.pos.z - this.lastZ);
    this.lastX = p.move.pos.x;
    this.lastZ = p.move.pos.z;
    if (c.forward !== 0 || c.right !== 0) {
      if (moved < 0.012) this.stuckFor += dt;
      else this.stuckFor = 0;
    } else {
      this.stuckFor = 0;
    }
    if (this.stuckFor > 0.4) {
      c.buttons |= BTN.JUMP;
      this.yaw = wrapAngle(this.yaw + (this.rng() < 0.5 ? 1 : -1) * 0.9);
      this.wanderIn = 0;
      this.stuckFor = 0;
    }

    // ── Reload ───────────────────────────────────────────────────────────────
    const a = p.ammoState;
    const w = p.weapon;
    if (
      w.magSize > 0 &&
      a.reserve > 0 &&
      this.reloadCooldown <= 0 &&
      (a.mag === 0 || (!visible && a.mag < w.magSize * 0.4))
    ) {
      c.buttons |= BTN.RELOAD;
      this.reloadCooldown = 0.6;
    }

    return c;
  }

  /** Slot the bot wants to be holding, or -1 for "no change". Read by the room. */
  wantSlot = -1;

  private resolveTarget(enemies: readonly ServerPlayer[]): ServerPlayer | null {
    if (this.targetId < 0) return null;
    for (const e of enemies) {
      if (e.id === this.targetId) return e.alive ? e : null;
    }
    return null;
  }

  private pickTarget(
    enemies: readonly ServerPlayer[],
    brushes: readonly Box[],
  ): ServerPlayer | null {
    let best: ServerPlayer | null = null;
    let bestScore = -Infinity;
    for (const e of enemies) {
      if (!e.alive || e === this.player) continue;
      const dx = e.move.pos.x - this.player.move.pos.x;
      const dz = e.move.pos.z - this.player.move.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 95) continue;

      targetEye.x = e.move.pos.x;
      targetEye.y = e.eyeY;
      targetEye.z = e.move.pos.z;
      const clear = losClear(selfEye, targetEye, brushes);

      // Prefer close, visible targets; heavily prefer whoever just shot us.
      let score = 100 - d;
      if (clear) score += 90;
      if (e.id === this.player.lastAttacker) score += 45;
      if (e.id === this.targetId) score += 18;
      if (e.health < 45) score += 20;
      if (score > bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  private reachedWander(p: ServerPlayer): boolean {
    return Math.hypot(this.wanderX - p.move.pos.x, this.wanderZ - p.move.pos.z) < 1.6;
  }

  private newWaypoint(map: GameMap): void {
    // Aim for a spawn point: they are, by construction, reachable open ground.
    const s = map.spawns[Math.floor(this.rng() * map.spawns.length) % map.spawns.length]!;
    this.wanderX = s.x + (this.rng() * 2 - 1) * 3;
    this.wanderZ = s.z + (this.rng() * 2 - 1) * 3;
    this.wanderIn = 5 + this.rng() * 6;
  }
}

export { EYE_HEIGHT };
