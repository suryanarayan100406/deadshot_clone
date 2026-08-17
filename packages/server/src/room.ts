/**
 * A room is one match: one map, one mode, up to `MAX_PLAYERS` participants (humans
 * and bots mixed), and one authoritative 60 Hz simulation.
 *
 * The tick is the only place the world changes. Everything else — socket handlers,
 * bot controllers — either enqueues intent or reads state.
 *
 * Ordering inside `step()`:
 *   1. per-player: drain up to 3 queued inputs, running movement then weapons
 *   2. record the position history frame for lag compensation
 *   3. regen, respawns, match state
 *
 * Shots resolved in (1) rewind against a history whose newest frame is the previous
 * tick. That is one tick of extra latency inside a rewind that is already 100 ms or
 * more, so it sits well below the noise floor and it keeps the tick single-pass.
 */

import {
  AF,
  BTN,
  EV,
  FALL_DAMAGE_PER_SPEED,
  FALL_DAMAGE_SPEED,
  FFA_KILL_LIMIT,
  INTERP_DELAY_MS,
  LAGCOMP_MAX_REWIND_MS,
  LF,
  LOBBY_ACT,
  LOBBY_AUTOSTART_MIN,
  LOBBY_COUNTDOWN_MS,
  MATCH_TIME_MS,
  MAX_HEALTH,
  MAX_PLAYERS,
  MELEE_BACKSTAB_DAMAGE,
  MELEE_BACKSTAB_DOT,
  MODE,
  PHASE,
  PITCH_LIMIT,
  REGEN_DELAY,
  REGEN_PER_SEC,
  RESPAWN_DELAY_MS,
  RF,
  SNAPSHOT_MS,
  SPAWN_PROTECT_MS,
  TARGET_LOBBY_SIZE,
  TDM_KILL_LIMIT,
  TEAM_A,
  TEAM_B,
  TEAM_NONE,
  TICK_DT,
  TICK_RATE,
  ByteWriter,
  applySpread,
  clamp,
  copyInputCmd,
  damageAtRange,
  dirFromAngles,
  encodeLobby,
  encodeMatch,
  encodeRoster,
  encodeSnapshot,
  encodeWelcome,
  makeHitbox,
  makeRng,
  mapById,
  mapColliders,
  newInputCmd,
  stepMovement,
  traceShot,
  v3,
  writeHitboxes,
  type ActorState,
  type Box,
  type GameEvent,
  type GameMap,
  type Hitbox,
  type InputCmd,
  type RosterEntry,
  type SelfState,
  type Spawn,
  type WeaponDef,
} from '@oneshot/shared';
import { Bot, SKILLS, nextBotName } from './bots.js';
import { History, type Sample } from './lagcomp.js';
import { ServerPlayer } from './player.js';

const MAX_INPUTS_PER_TICK = 3;
const INPUT_QUEUE_CAP = 40;
const ROSTER_INTERVAL_MS = 500;
const MATCH_INTERVAL_MS = 500;
const POST_MATCH_MS = 8000;
const BOT_MANAGE_INTERVAL = 30;
const CORPSE_LINGER_MS = 900;
/** Safety net so a human who never sends C_RESPAWN is not stuck spectating. */
const AUTO_RESPAWN_MS = 8000;

/** Damage accumulated per victim within one trigger pull (shotguns). */
interface PendingHit {
  victim: ServerPlayer;
  damage: number;
  head: boolean;
  hits: number;
}

const dir = v3();
const spreadDir = v3();
const victimFwd = v3();
/** Strip control characters so nobody can inject newlines into a chat log. */
function sanitizeChat(text: string): string {
  let s = '';
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c < 0x20 || c === 0x7f) continue;
    s += ch;
  }
  return s.slice(0, 100).trim();
}

export class Room {
  readonly id: string;
  readonly mode: number;
  readonly map: GameMap;
  readonly colliders: Box[];
  /**
   * True when a client asked for this room by name, i.e. it is a party.
   *
   * The distinction changes exactly one thing, and it is the whole point of
   * parties: in a public lobby a joining human goes wherever the teams are
   * thinner, but in a party room the humans typed the same code because they want
   * to play *together*, so balance is the wrong objective and they are kept on
   * one side until that side is half the lobby.
   */
  readonly party: boolean;

  players = new Map<number, ServerPlayer>();
  private bots = new Map<number, Bot>();

  private history = new History();
  private samples: Sample[] = [];
  private hitboxPool: Hitbox[] = [];
  private shotBoxes: Hitbox[] = [];
  private pending: PendingHit[] = [];
  private enemyScratch: ServerPlayer[] = [];

  private rng = makeRng(0x51f3a2);
  private writer = new ByteWriter(8192);

  tick = 0;
  private lastSnapshotAt = 0;
  private lastRosterAt = 0;
  private lastMatchAt = 0;
  private lastLobbyAt = 0;
  private matchEndsAt: number;
  private overAt = 0;
  scoreA = 0;
  scoreB = 0;

  // ── Lobby ──────────────────────────────────────────────────────────────────

  /**
   * One of `PHASE`.
   *
   * A party opens in `LOBBY` and a public room does not, which is the whole
   * difference between the two flows: pressing Play is a request for a game right
   * now, and typing a code is a request to gather.
   */
  phase: number;

  /**
   * The human who can start the match, or 0 when nobody is here.
   *
   * Whoever arrives first, and reassigned the moment they leave. There is no
   * election and no claim: a lobby whose host has quit and which nobody can start
   * is a room full of people with nothing to press, which is a worse outcome than
   * any unfairness in how the role gets handed over.
   */
  hostId = 0;

  /**
   * Whether bots may fill this room.
   *
   * Off in a party, on in a public lobby, and that default *is* the fix for
   * uninvited bots. A private room is somebody's group, and filling it to eight
   * with strangers-shaped robots the moment the first friend connects is the
   * behaviour a player would describe as "random bots keep joining my game" —
   * they never asked for them and, before this, could not decline them.
   */
  botsEnabled: boolean;

  /** When the countdown ends, or 0 when none is running. */
  startAt = 0;
  /** Set when lobby state changes, so the packet goes out on the next flush. */
  private lobbyDirty = true;

  /** Events every client sees in the next snapshot. */
  private globalEvents: GameEvent[] = [];
  private chatLog: GameEvent[] = [];

  /** Injected by the server so the match packet can report a global count. */
  playersOnlineProvider: () => number = () => this.players.size;

  private coast: InputCmd = newInputCmd();
  private botSeq = 1;

  constructor(id: string, mode: number, mapId: number, now: number, party = false) {
    this.id = id;
    this.mode = mode;
    this.party = party;
    this.map = mapById(mapId);
    this.colliders = mapColliders(this.map);
    this.matchEndsAt = now + MATCH_TIME_MS;
    this.lastSnapshotAt = now;
    this.lastRosterAt = now;
    this.lastMatchAt = now;
    this.lastLobbyAt = now;
    // A party gathers first; a public room is already in progress by definition.
    this.phase = party ? PHASE.LOBBY : PHASE.LIVE;
    this.botsEnabled = !party;
    for (let i = 0; i < 64; i++) this.hitboxPool.push(makeHitbox());
  }

  // ── Membership ─────────────────────────────────────────────────────────────

  get humanCount(): number {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }

  get isFull(): boolean {
    return this.humanCount >= MAX_PLAYERS;
  }

  get killLimit(): number {
    return this.mode === MODE.TDM ? TDM_KILL_LIMIT : FFA_KILL_LIMIT;
  }

  get isOver(): boolean {
    return this.overAt > 0;
  }

  /** True while the room is gathering rather than playing a scored match. */
  get inLobby(): boolean {
    return this.phase === PHASE.LOBBY;
  }

  private lobbyFlags(): number {
    return (this.botsEnabled ? LF.BOTS : 0) | (this.party ? LF.PARTY : 0);
  }

  add(p: ServerPlayer, now: number): void {
    p.team = this.mode === MODE.TDM ? this.teamFor(p) : TEAM_NONE;
    this.players.set(p.id, p);
    p.lastPacketAt = now;
    p.ready = false;
    this.spawn(p, now);
    this.markRosterDirty();
    if (!p.isBot) {
      // First human in the room runs it. Bots are skipped for the obvious reason
      // and one less obvious one: a bot host could never press Start, so a lobby
      // that handed the role to one would deadlock.
      if (this.hostId === 0) this.hostId = p.id;
      this.lobbyDirty = true;
      p.send(
        encodeWelcome({
          id: p.id,
          mapId: this.map.id,
          mode: this.mode,
          tickRate: TICK_RATE,
          serverTime: now >>> 0,
          room: this.id,
        }),
      );
      this.sendRoster();
      this.sendMatch(now);
      this.sendLobby(now);
    }
  }

  remove(id: number): void {
    if (!this.players.delete(id)) return;
    this.bots.delete(id);
    for (const p of this.players.values()) {
      if (p.lastAttacker === id) p.lastAttacker = -1;
    }
    if (this.hostId === id) this.promoteHost();
    this.markRosterDirty();
  }

  /**
   * Hand the room to the longest-standing remaining human, or to nobody.
   *
   * Lowest id wins, which is join order, because ids are handed out in sequence.
   * `hostId = 0` when the last human leaves is what lets an empty party room be
   * re-hosted by whoever comes back rather than staying orphaned.
   */
  private promoteHost(): void {
    let next = 0;
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      if (next === 0 || p.id < next) next = p.id;
    }
    this.hostId = next;
    this.lobbyDirty = true;
    // A countdown started by somebody who has now left still runs: the other
    // players in the room were already told the match was about to begin, and
    // silently cancelling it would leave them waiting on a promise that vanished.
  }

  private markRosterDirty(): void {
    for (const p of this.players.values()) p.rosterDirty = true;
  }

  /**
   * The side a joining player belongs on.
   *
   * In a public lobby this is pure balance. In a party room it is the opposite:
   * the humans came here from a shared code, so the default is to keep them
   * together on Alpha, and `thinnerTeam` — which is exactly right for strangers —
   * is what used to guarantee the failure. Two friends joining an empty team
   * match got a coin flip for the first and "whichever side is emptier" for the
   * second, which is *always* the other one. Playing with a friend was therefore
   * impossible by construction, not merely unlikely.
   *
   * The cap is what keeps that from becoming a different bug. A stack big enough
   * to fill a side would otherwise leave nobody to play against, so past half the
   * lobby the overflow crosses over and a large private group self-balances into a
   * real match instead of a firing squad.
   *
   * Bots always balance, which does more than hand the party an opposition: once
   * Bravo is the larger side the fill starts landing on Alpha as well, so two
   * friends in a six-player match get a bot teammate and an even 3v3 rather than
   * a 2v4 against everything in the room.
   */
  private teamFor(p: ServerPlayer): number {
    if (!this.party || p.isBot) return this.thinnerTeam();
    let humansOnA = 0;
    for (const o of this.players.values()) {
      if (!o.isBot && o.team === TEAM_A) humansOnA++;
    }
    return humansOnA < Math.floor(MAX_PLAYERS / 2) ? TEAM_A : TEAM_B;
  }

  private thinnerTeam(): number {
    let a = 0;
    let b = 0;
    for (const p of this.players.values()) {
      if (p.team === TEAM_A) a++;
      else if (p.team === TEAM_B) b++;
    }
    // On a tie, a party room breaks toward Bravo: the humans are gathering on
    // Alpha, so that is the side a bot is least useful on.
    if (a === b) return this.party ? TEAM_B : this.rng() < 0.5 ? TEAM_A : TEAM_B;
    return a < b ? TEAM_A : TEAM_B;
  }

  /** Top the lobby up with bots, and retire them when humans need the slots. */
  private manageBots(now: number): void {
    const humans = this.humanCount;
    // Nobody here, or nobody wants them: retire the lot. Both cases go down the
    // same path deliberately — turning bots off has to be immediate, because the
    // player who turned them off is looking at the room while they do it.
    if (humans === 0 || !this.botsEnabled) {
      if (this.bots.size > 0) for (const id of [...this.bots.keys()]) this.remove(id);
      return;
    }
    const want = Math.max(0, Math.min(TARGET_LOBBY_SIZE, MAX_PLAYERS) - humans);

    while (this.bots.size > want) {
      // Retire the bot with the fewest kills so the scoreboard stays sensible.
      let worst: Bot | null = null;
      for (const b of this.bots.values()) {
        if (!worst || b.player.kills < worst.player.kills) worst = b;
      }
      if (!worst) break;
      this.remove(worst.player.id);
    }

    const primaries = ['ranger', 'ranger', 'vector', 'breacher', 'longshot'];
    while (this.bots.size < want) {
      const tier = this.rng();
      const skill = tier < 0.3 ? SKILLS.easy : tier < 0.82 ? SKILLS.normal : SKILLS.hard;
      const key = primaries[Math.floor(this.rng() * primaries.length) % primaries.length];
      const p = new ServerPlayer(nextBotName(), true, null, key);
      this.bots.set(p.id, new Bot(p, skill, (p.id * 2654435761) >>> 0));
      this.add(p, now);
    }
  }

  // ── Spawning ───────────────────────────────────────────────────────────────

  /** Pick the spawn furthest from the nearest living enemy. */
  private pickSpawn(p: ServerPlayer): Spawn {
    const spawns = this.map.spawns;
    let best = spawns[0];
    let bestScore = -Infinity;
    for (const s of spawns) {
      let nearest = Infinity;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        if (this.mode === MODE.TDM && o.team === p.team) continue;
        const d = Math.hypot(o.move.pos.x - s.x, o.move.pos.z - s.z);
        if (d < nearest) nearest = d;
      }
      const score = (nearest === Infinity ? 1000 : nearest) + this.rng() * 4;
      if (score > bestScore) {
        bestScore = score;
        best = s;
      }
    }
    return best;
  }

  private spawn(p: ServerPlayer, now: number): void {
    const s = this.pickSpawn(p);
    p.resetForSpawn(s.x, s.y, s.z, s.yaw, now);
    p.spawnProtectUntil = now + SPAWN_PROTECT_MS;
    p.respawnAt = 0;
    p.inputQueue.length = 0;
    this.globalEvents.push({ kind: EV.SPAWN, a: p.id });
  }

  // ── Incoming client intent ─────────────────────────────────────────────────

  pushInputs(p: ServerPlayer, cmds: readonly InputCmd[]): void {
    let added = 0;
    for (const c of cmds) {
      // Redundant re-sends of already-consumed commands are dropped here.
      if (c.seq <= p.lastAckedSeq) continue;
      if (p.inputQueue.length >= INPUT_QUEUE_CAP) p.inputQueue.shift();
      p.inputQueue.push(c);
      added++;
    }
    if (added > 1 || p.inputQueue.length > 1) p.inputQueue.sort((a, b) => a.seq - b.seq);
  }

  requestSwitch(p: ServerPlayer, slot: number, now: number): void {
    if (!p.alive) return;
    p.switchTo(slot, now);
  }

  requestRespawn(p: ServerPlayer, now: number): void {
    if (p.alive || now < p.respawnAt) return;
    this.spawn(p, now);
  }

  pushChat(p: ServerPlayer, text: string): void {
    const clean = sanitizeChat(text);
    if (!clean) return;
    this.chatLog.push({ kind: EV.CHAT, a: p.id, text: clean });
    if (this.chatLog.length > 8) this.chatLog.shift();
  }

  // ── Simulation ─────────────────────────────────────────────────────────────

  step(now: number): void {
    this.tick++;
    if (this.tick % BOT_MANAGE_INTERVAL === 1) this.manageBots(now);

    for (const p of this.players.values()) {
      p.finishReloadIfDue(now);

      if (!p.alive) {
        if (p.respawnAt > 0 && now >= p.respawnAt) {
          // Bots respawn immediately; humans get a death cam until they ask, or
          // until the safety net fires.
          if (p.isBot || now >= p.respawnAt + AUTO_RESPAWN_MS) this.spawn(p, now);
        }
        p.prevButtons = 0;
        continue;
      }

      const bot = this.bots.get(p.id);
      if (bot) {
        const cmd = bot.think(this.enemiesOf(p), this.colliders, this.map, this.botSeq++);
        if (bot.wantSlot >= 0 && bot.wantSlot !== p.slot) p.switchTo(bot.wantSlot, now);
        this.applyCommand(p, cmd, now);
        continue;
      }

      let processed = 0;
      while (processed < MAX_INPUTS_PER_TICK && p.inputQueue.length > 0) {
        const cmd = p.inputQueue.shift() as InputCmd;
        p.lastAckedSeq = cmd.seq;
        copyInputCmd(p.lastInput, cmd);
        this.applyCommand(p, cmd, now);
        processed++;
      }
      if (processed === 0) {
        // No fresh intent: hold position rather than sliding on the last command.
        copyInputCmd(this.coast, p.lastInput);
        this.coast.forward = 0;
        this.coast.right = 0;
        this.coast.buttons = p.lastInput.buttons & BTN.CROUCH;
        this.applyCommand(p, this.coast, now);
      }
    }

    this.history.record(now, this.players.values());
    this.regen(now);
    this.updateMatch(now);
  }

  private enemiesOf(p: ServerPlayer): ServerPlayer[] {
    const out = this.enemyScratch;
    out.length = 0;
    for (const o of this.players.values()) {
      if (o === p) continue;
      if (this.mode === MODE.TDM && o.team === p.team) continue;
      out.push(o);
    }
    return out;
  }

  private applyCommand(p: ServerPlayer, cmd: InputCmd, now: number): void {
    p.yaw = cmd.yaw;
    p.pitch = clamp(cmd.pitch, -PITCH_LIMIT, PITCH_LIMIT);

    const res = stepMovement(p.move, cmd, this.colliders, p.speedMult(), TICK_DT);
    if (res.landed && res.impactSpeed > FALL_DAMAGE_SPEED) {
      const dmg = (res.impactSpeed - FALL_DAMAGE_SPEED) * FALL_DAMAGE_PER_SPEED;
      this.damage(p, p, Math.round(dmg), false, now, true);
    }

    p.decayCombatState(TICK_DT, cmd.buttons);
    if (p.alive) this.updateWeapon(p, cmd, now);
    p.prevButtons = cmd.buttons;
  }

  // ── Weapons ────────────────────────────────────────────────────────────────

  private updateWeapon(p: ServerPlayer, cmd: InputCmd, now: number): void {
    const w = p.weapon;
    const a = p.ammoState;

    if (p.pressed(BTN.RELOAD, cmd.buttons) && p.tryReload(now)) {
      this.globalEvents.push({ kind: EV.RELOAD, a: p.id });
    }

    // A burst already in flight keeps firing without the trigger held.
    if (p.burstLeft > 0 && !p.reloading && now >= p.nextBurstAt) {
      p.burstLeft--;
      p.nextBurstAt = now + w.burstDelay * 1000;
      this.fire(p, now);
      return;
    }

    if (p.reloading || now < p.switchEndAt || now < p.nextFireAt) return;

    if (w.magSize > 0 && a.mag <= 0) {
      // Auto-reload on a dry trigger pull, which is what players expect.
      if ((cmd.buttons & BTN.FIRE) !== 0 && a.reserve > 0 && p.tryReload(now)) {
        this.globalEvents.push({ kind: EV.RELOAD, a: p.id });
      }
      return;
    }

    const wantsFire =
      w.fireMode === 'auto' ? (cmd.buttons & BTN.FIRE) !== 0 : p.pressed(BTN.FIRE, cmd.buttons);
    if (!wantsFire) return;

    if (w.fireMode === 'burst' && w.burstCount > 1) {
      p.burstLeft = w.burstCount - 1;
      p.nextBurstAt = now + w.burstDelay * 1000;
    }
    this.fire(p, now);
  }

  /** Build the lag-compensated hitbox set for one shot. */
  private buildHitboxes(shooter: ServerPlayer, now: number, rewindMs: number): Hitbox[] {
    const n = this.history.rewind(now - rewindMs, this.samples);
    while (this.hitboxPool.length < n * 2) this.hitboxPool.push(makeHitbox());

    const boxes = this.shotBoxes;
    boxes.length = 0;
    let used = 0;
    for (let i = 0; i < n; i++) {
      const s = this.samples[i];
      if (s.id === shooter.id || !s.alive) continue;
      const other = this.players.get(s.id);
      if (!other || !other.alive) continue;
      if (this.mode === MODE.TDM && other.team === shooter.team) continue;
      if (now < other.spawnProtectUntil) continue;
      const head = this.hitboxPool[used++];
      const body = this.hitboxPool[used++];
      writeHitboxes(head, body, s.id, s.x, s.y, s.z, s.height);
      boxes.push(head, body);
    }
    return boxes;
  }

  private fire(p: ServerPlayer, now: number): void {
    const w = p.weapon;
    const a = p.ammoState;
    if (w.magSize > 0) {
      if (a.mag <= 0) return;
      a.mag--;
    }

    const ox = p.move.pos.x;
    const oy = p.eyeY;
    const oz = p.move.pos.z;
    dirFromAngles(dir, p.yaw, p.pitch);

    // Rewind the world to what the shooter was seeing when they pulled. Bots read
    // the live server state, so they are not compensated at all.
    const rewindMs = p.isBot ? 0 : clamp(p.ping * 0.5 + INTERP_DELAY_MS, 0, LAGCOMP_MAX_REWIND_MS);
    const boxes = this.buildHitboxes(p, now, rewindMs);

    const spread = p.currentSpread();
    this.pending.length = 0;

    let tracerX = ox + dir.x * w.range;
    let tracerY = oy + dir.y * w.range;
    let tracerZ = oz + dir.z * w.range;
    const pellets = Math.max(1, w.pellets);

    for (let pellet = 0; pellet < pellets; pellet++) {
      applySpread(spreadDir, dir.x, dir.y, dir.z, spread, this.rng);
      const hit = traceShot(
        ox,
        oy,
        oz,
        spreadDir.x,
        spreadDir.y,
        spreadDir.z,
        this.colliders,
        boxes,
        w.range,
      );
      if (pellet === 0) {
        tracerX = hit.x;
        tracerY = hit.y;
        tracerZ = hit.z;
      }

      if (hit.hitWorld) {
        this.globalEvents.push({
          kind: EV.IMPACT,
          x: hit.x,
          y: hit.y,
          z: hit.z,
          nx: hit.nx,
          ny: hit.ny,
          nz: hit.nz,
          flag: 0,
        });
        continue;
      }
      if (hit.hitId < 0) continue;

      const victim = this.players.get(hit.hitId);
      if (!victim || !victim.alive) continue;

      let dmg = damageAtRange(w, hit.t);
      if (hit.head) dmg *= w.headMult;
      if (w.fireMode === 'melee' && this.isBackstab(p, victim)) dmg = MELEE_BACKSTAB_DAMAGE;

      let entry: PendingHit | null = null;
      for (const e of this.pending) {
        if (e.victim === victim) {
          entry = e;
          break;
        }
      }
      if (!entry) {
        entry = { victim, damage: 0, head: false, hits: 0 };
        this.pending.push(entry);
      }
      entry.damage += dmg;
      entry.hits++;
      if (hit.head) entry.head = true;

      this.globalEvents.push({
        kind: EV.IMPACT,
        x: hit.x,
        y: hit.y,
        z: hit.z,
        nx: 0,
        ny: 0,
        nz: 0,
        flag: hit.head ? 2 : 1,
      });
    }

    this.globalEvents.push({
      kind: EV.SHOT,
      a: p.id,
      b: w.id,
      x: ox,
      y: oy,
      z: oz,
      nx: tracerX,
      ny: tracerY,
      nz: tracerZ,
    });

    for (const e of this.pending) this.damage(p, e.victim, e.damage, e.head, now, false);
    this.pending.length = 0;

    p.onShotFired(now);
  }

  private isBackstab(attacker: ServerPlayer, victim: ServerPlayer): boolean {
    dirFromAngles(victimFwd, victim.yaw, 0);
    const dx = attacker.move.pos.x - victim.move.pos.x;
    const dz = attacker.move.pos.z - victim.move.pos.z;
    const len = Math.hypot(dx, dz) || 1;
    const dot = (dx / len) * victimFwd.x + (dz / len) * victimFwd.z;
    return dot < MELEE_BACKSTAB_DOT;
  }

  // ── Damage / scoring ───────────────────────────────────────────────────────

  private damage(
    attacker: ServerPlayer,
    victim: ServerPlayer,
    amount: number,
    head: boolean,
    now: number,
    selfInflicted: boolean,
  ): void {
    if (!victim.alive || amount <= 0) return;
    if (!selfInflicted && now < victim.spawnProtectUntil) return;
    if (this.mode === MODE.TDM && !selfInflicted && attacker.team === victim.team) return;

    const applied = Math.min(victim.health, Math.round(amount));
    victim.health -= applied;
    victim.lastDamageAt = now;
    if (!selfInflicted) victim.lastAttacker = attacker.id;

    const killed = victim.health <= 0;

    if (!selfInflicted) {
      attacker.events.push({
        kind: EV.HIT_CONFIRM,
        a: victim.id,
        b: applied,
        flag: (head ? 1 : 0) | (killed ? 2 : 0),
      });
      // Direction to the attacker, so the victim's HUD can point at them.
      const ang = Math.atan2(
        -(attacker.move.pos.x - victim.move.pos.x),
        -(attacker.move.pos.z - victim.move.pos.z),
      );
      victim.events.push({ kind: EV.DAMAGED, a: attacker.id, b: applied, x: ang });
    }

    if (killed) this.kill(attacker, victim, head, selfInflicted, now);
  }

  private kill(
    attacker: ServerPlayer,
    victim: ServerPlayer,
    head: boolean,
    selfInflicted: boolean,
    now: number,
  ): void {
    victim.alive = false;
    victim.health = 0;
    victim.deaths++;
    victim.streak = 0;
    victim.respawnAt = now + RESPAWN_DELAY_MS;
    victim.move.vel.x = 0;
    victim.move.vel.y = 0;
    victim.move.vel.z = 0;
    victim.burstLeft = 0;
    victim.reloadEndAt = 0;
    victim.inputQueue.length = 0;

    if (selfInflicted || attacker === victim) {
      // Fall damage / self-inflicted: costs a point in FFA, nothing in TDM.
      if (this.mode === MODE.FFA) victim.kills = Math.max(0, victim.kills - 1);
      this.globalEvents.push({ kind: EV.KILL, a: victim.id, b: victim.id, c: 255, flag: 4 });
    } else {
      const weapon: WeaponDef = attacker.weapon;
      let flag = head ? 1 : 0;
      if (weapon.fireMode === 'melee' && this.isBackstab(attacker, victim)) flag |= 2;

      attacker.kills++;
      attacker.streak++;
      attacker.refillOnKill();
      if (attacker.streak > attacker.bestStreak) attacker.bestStreak = attacker.streak;
      if (this.mode === MODE.TDM) {
        if (attacker.team === TEAM_A) this.scoreA++;
        else if (attacker.team === TEAM_B) this.scoreB++;
      }
      this.globalEvents.push({ kind: EV.KILL, a: victim.id, b: attacker.id, c: weapon.id, flag });
    }

    this.globalEvents.push({ kind: EV.DEATH, a: victim.id });
    this.markRosterDirty();
  }

  private regen(now: number): void {
    for (const p of this.players.values()) {
      if (!p.alive || p.health >= MAX_HEALTH) continue;
      if ((now - p.lastDamageAt) / 1000 < REGEN_DELAY) continue;
      p.health = Math.min(MAX_HEALTH, p.health + REGEN_PER_SEC * TICK_DT);
    }
  }

  // ── Match state ────────────────────────────────────────────────────────────

  private updateMatch(now: number): void {
    if (this.overAt > 0) {
      if (now - this.overAt > POST_MATCH_MS) this.resetMatch(now);
      return;
    }
    if (now >= this.matchEndsAt) {
      this.overAt = now;
      return;
    }
    if (this.mode === MODE.TDM) {
      if (this.scoreA >= TDM_KILL_LIMIT || this.scoreB >= TDM_KILL_LIMIT) this.overAt = now;
      return;
    }
    for (const p of this.players.values()) {
      if (p.kills >= FFA_KILL_LIMIT) {
        this.overAt = now;
        return;
      }
    }
  }

  private resetMatch(now: number): void {
    this.scoreA = 0;
    this.scoreB = 0;
    this.overAt = 0;
    this.matchEndsAt = now + MATCH_TIME_MS;
    for (const p of this.players.values()) {
      p.kills = 0;
      p.deaths = 0;
      p.streak = 0;
      p.bestStreak = 0;
      this.spawn(p, now);
    }
    this.markRosterDirty();
  }

  // ── Outbound ───────────────────────────────────────────────────────────────

  flush(now: number): void {
    if (now - this.lastSnapshotAt >= SNAPSHOT_MS - 0.5) {
      this.lastSnapshotAt = now;
      this.sendSnapshots(now);
      this.globalEvents.length = 0;
      this.chatLog.length = 0;
    }
    if (now - this.lastRosterAt >= ROSTER_INTERVAL_MS) {
      this.lastRosterAt = now;
      this.sendRoster();
    }
    if (now - this.lastMatchAt >= MATCH_INTERVAL_MS) {
      this.lastMatchAt = now;
      this.sendMatch(now);
    }
  }

  private actorScratch: ActorState[] = [];
  private eventScratch: GameEvent[] = [];
  private selfScratch: SelfState = {
    x: 0,
    y: 0,
    z: 0,
    vx: 0,
    vy: 0,
    vz: 0,
    flags: 0,
    health: 0,
    weapon: 0,
    magAmmo: 0,
    reserveAmmo: 0,
    reloadLeft: 0,
    kills: 0,
    deaths: 0,
    streak: 0,
    respawnIn: 0,
  };

  private flagsFor(p: ServerPlayer, now: number): number {
    let f = 0;
    if (p.move.onGround) f |= AF.ON_GROUND;
    if (p.move.crouching) f |= AF.CROUCH;
    if (p.ads > 0.5) f |= AF.ADS;
    if (!p.alive) f |= AF.DEAD;
    if (p.reloading) f |= AF.RELOADING;
    if (p.isBot) f |= AF.BOT;
    if (p.alive && now < p.spawnProtectUntil) f |= AF.SPAWN_PROTECTED;
    if (p.alive && (p.lastInput.buttons & BTN.FIRE) !== 0) f |= AF.FIRING;
    return f;
  }

  private sendSnapshots(now: number): void {
    for (const viewer of this.players.values()) {
      if (viewer.isBot || !viewer.socket) {
        viewer.events.length = 0;
        continue;
      }

      const actors = this.actorScratch;
      actors.length = 0;
      for (const p of this.players.values()) {
        if (p === viewer) continue;
        // Corpses linger a moment for the death animation, then stop being sent.
        if (!p.alive && p.respawnAt > 0 && now > p.respawnAt - RESPAWN_DELAY_MS + CORPSE_LINGER_MS) {
          continue;
        }
        actors.push({
          id: p.id,
          x: p.move.pos.x,
          y: p.move.pos.y,
          z: p.move.pos.z,
          yaw: p.yaw,
          pitch: p.pitch,
          flags: this.flagsFor(p, now),
          health: p.health,
          weapon: p.weapon.id,
          team: p.team,
          speed: Math.hypot(p.move.vel.x, p.move.vel.z),
        });
      }

      const s = this.selfScratch;
      s.x = viewer.move.pos.x;
      s.y = viewer.move.pos.y;
      s.z = viewer.move.pos.z;
      s.vx = viewer.move.vel.x;
      s.vy = viewer.move.vel.y;
      s.vz = viewer.move.vel.z;
      s.flags = this.flagsFor(viewer, now);
      s.health = viewer.health;
      s.weapon = viewer.weapon.id;
      s.magAmmo = viewer.ammoState.mag;
      s.reserveAmmo = viewer.ammoState.reserve;
      s.reloadLeft = viewer.reloading ? Math.max(0, (viewer.reloadEndAt - now) / 1000) : 0;
      s.kills = viewer.kills;
      s.deaths = viewer.deaths;
      s.streak = viewer.streak;
      s.respawnIn = viewer.alive ? 0 : Math.max(0, (viewer.respawnAt - now) / 1000);

      const evs = this.eventScratch;
      evs.length = 0;
      for (const e of this.globalEvents) evs.push(e);
      for (const e of viewer.events) evs.push(e);
      for (const e of this.chatLog) evs.push(e);
      viewer.events.length = 0;

      viewer.send(encodeSnapshot(this.writer, now, viewer.lastAckedSeq, s, actors, evs));
    }
  }

  private sendRoster(): void {
    const entries: RosterEntry[] = [];
    for (const p of this.players.values()) {
      entries.push({
        id: p.id,
        name: p.name,
        team: p.team,
        kills: p.kills,
        deaths: p.deaths,
        ping: Math.round(p.ping),
        flags: (p.isBot ? 1 : 0) | (p.alive ? 0 : 2),
      });
    }
    entries.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || a.id - b.id);
    const packet = encodeRoster(entries);
    for (const p of this.players.values()) {
      if (p.isBot) continue;
      p.send(packet);
      p.rosterDirty = false;
    }
  }

  private sendMatch(now: number): void {
    let leader = 0;
    if (this.mode === MODE.FFA) {
      for (const p of this.players.values()) if (p.kills > leader) leader = p.kills;
    }
    const packet = encodeMatch({
      timeLeft: Math.max(0, this.matchEndsAt - now),
      scoreA: this.mode === MODE.TDM ? this.scoreA : leader,
      scoreB: this.mode === MODE.TDM ? this.scoreB : 0,
      limit: this.killLimit,
      over: this.overAt > 0 ? 1 : 0,
      playersOnline: this.playersOnlineProvider(),
    });
    for (const p of this.players.values()) if (!p.isBot) p.send(packet);
  }
}
