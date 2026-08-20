/**
 * The heads-up display: everything the player reads without looking away.
 *
 * Two rules shape this file.
 *
 * **The DOM is only touched when a value actually changes.** A HUD updated
 * naively re-writes forty text nodes at 144 fps and spends more time in style
 * recalculation than the renderer spends drawing the level. So every readout
 * caches what it last wrote and returns early — the steady state of this module
 * during normal play is a few dozen numeric comparisons per frame and no layout
 * work at all.
 *
 * **Nothing here is interactive.** The stylesheet sets `pointer-events: none` on
 * `#hud` and everything inside it, with the single exception of the chat input.
 * The canvas needs every mouse event it can get — a HUD element swallowing a
 * click would eat a shot — so the HUD is strictly write-only. Anything the player
 * clicks lives in the menu instead.
 *
 * Transient elements (killfeed rows, notices, damage arrows) are pooled or
 * expired on a timer rather than left to accumulate, because a forty-minute
 * match otherwise ends with a few thousand dead nodes in the tree.
 */

import {
  AF,
  MAX_HEALTH,
  RF,
  TEAM_A,
  TEAM_B,
  weaponById,
  type MatchMsg,
  type RosterEntry,
} from '@oneshot/shared';
import { CROSSHAIR_COLORS, type SettingsStore } from './settings';
import { suicideIcon, weaponIcon } from './weaponart';

/** Killfeed rows live this long before fading out. */
const KILLFEED_MS = 5200;
const KILLFEED_MAX = 5;
/** Chat lines are kept longer — people read them. */
const CHAT_MS = 9000;
const CHAT_MAX = 6;
const NOTICE_MS = 2000;
/** Pooled damage-direction arrows. More than four attackers at once is rare. */
const DIR_POOL = 6;
/** Pooled floating damage numbers. Twelve covers a shotgun blast into a crowd. */
const DMG_NUM_POOL = 12;
/** How far a number rises from the hit, in CSS pixels, and over how long. */
const DMG_RISE_PX = 46;
const DMG_DRIFT_MS = 900;
/** Held at full opacity this long after the last hit, then faded out. */
const DMG_HOLD_MS = 420;
const DMG_FADE_MS = 380;
/** The scale bump each landed hit gives the number it lands on. */
const DMG_POP_MS = 140;
/**
 * Further hits on the same victim inside this window add into the number that is
 * already floating instead of spawning a second one.
 *
 * This is what makes the readout legible rather than decorative. The Breacher
 * fires nine pellets in one shot and the Vector fires fifteen rounds a second —
 * one number per hit would stack nine on a single pixel, or emit fifteen a second
 * that each fade before they can be read. Merged, you get one number counting up,
 * which is also the more useful information: how much that target has taken.
 */
const DMG_MERGE_MS = 300;
/** ...but a held trigger must not keep one number alive and growing forever. */
const DMG_CHAIN_MS = 1500;
/** Radar half-extent in metres. Sized so the whole 60 m map nearly fits. */
const RADAR_RANGE = 34;
/** How long a shot keeps an enemy visible on the radar. */
const RADAR_PING_MS = 2100;

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`HUD: missing #${id} in the document`);
  return found as T;
}

/** Re-triggers a CSS animation on an element that is already showing. */
function restartAnimation(node: HTMLElement, cls: string): void {
  node.classList.remove(cls);
  // Reading a layout property forces the style flush that makes the browser
  // treat the re-add as a new animation rather than a no-op.
  void node.offsetWidth;
  node.classList.add(cls);
}

interface Timed {
  node: HTMLElement;
  until: number;
  fading: boolean;
}

export interface RadarSelf {
  x: number;
  z: number;
  yaw: number;
}

/**
 * Projects a world point to a position in the viewport, as fractions across it
 * (`0,0` top-left, `1,1` bottom-right). Returns false when the point is behind
 * the camera — where the perspective divide mirrors it to a meaningless place on
 * screen.
 *
 * Fractions rather than pixels so that the viewport size has exactly one owner:
 * the HUD, which needs it for culling anyway. The camera belongs to `main.ts`, so
 * the HUD is handed this function rather than importing Three.js — nothing in
 * this file knows the scene exists.
 */
export type ScreenProjector = (
  x: number,
  y: number,
  z: number,
  out: { x: number; y: number },
) => boolean;

/** A floating damage number. Pooled: `victim < 0` marks the slot free. */
interface DamageNum {
  node: HTMLElement;
  victim: number;
  total: number;
  /** Frozen world anchor — where the victim was when the hit landed. */
  wx: number;
  wy: number;
  wz: number;
  /** Start of the rise, of the current pop, and the time of the last hit. */
  born: number;
  popAt: number;
  lastHitAt: number;
  head: boolean;
  killed: boolean;
  /** Last values written to the DOM, so a number that has not moved costs nothing. */
  cText: string;
  cTransform: string;
  cOpacity: string;
  cClass: string;
}

export class Hud {
  private settings: SettingsStore;

  private hud = el('hud');
  private crosshair = el('crosshair');
  private hitmarkerEl = el('hitmarker');
  private scopeEl = el('scope');
  private vignette = el('dmg-vignette');
  private dirs = el('dmg-dirs');
  private dmgNumsEl = el('dmg-nums');
  private scoreA = el('score-a');
  private scoreB = el('score-b');
  private clock = el('clock');
  private modeLabel = el('mode-label');
  private radarCanvas = el<HTMLCanvasElement>('radar-canvas');
  private radarCtx: CanvasRenderingContext2D;
  private killfeedEl = el('killfeed');
  private noticeEl = el('notice');
  private streakEl = el('streak');
  private healthEl = el('health');
  private healthFill = el('health-fill');
  private healthNum = el('health-num');
  private ammoEl = el('ammo');
  private ammoMag = el('ammo-mag');
  private ammoReserve = el('ammo-reserve');
  private weaponName = el('weapon-name');
  private reloadHint = el('reload-hint');
  private slotEls: HTMLElement[];
  private statsEl = el('stats');
  private statFps = el('stat-fps');
  private statPing = el('stat-ping');
  private chatlog = el('chatlog');
  private chatinput = el<HTMLInputElement>('chatinput');
  private deathscreen = el('deathscreen');
  private deathKiller = el('death-killer');
  private deathWeapon = el('death-weapon');
  private deathCount = el('death-count');
  private scoreboard = el('scoreboard');
  private sbMode = el('sb-mode');
  private sbRoom = el('sb-room');
  private sbRows = el('sb-rows');
  private matchoverEl = el('matchover');
  private moWinner = el('mo-winner');
  private toastEl = el('toast');
  private loadingEl = el('loading');

  /* Cached last-written values. Everything below exists purely so the DOM is
     left alone when a value has not moved. */
  private cHealth = -1;
  private cHealthClass = '';
  private cMag = -1;
  private cReserve = -1;
  private cWeapon = -1;
  private cReloading = false;
  private cAmmoLow = false;
  private cScoreA = -1;
  private cScoreB = -1;
  private cClock = '';
  private cClockLow = false;
  private cFps = -1;
  private cPing = -1;
  private cSlot = -1;
  private cStreak = -1;
  private cGap = -1;
  private cLen = -1;
  private cThick = -1;
  private cCol = '';
  private cScope = false;
  private cDot = false;
  private cVignette = -1;
  private cDeathCount = '';
  private cLoadout: number[] = [];

  private teamMode = false;
  private selfId = -1;
  private vignetteLevel = 0;
  private dirPool: HTMLElement[] = [];
  private dirNext = 0;
  private dmgNums: DamageNum[] = [];
  private project: ScreenProjector | null = null;
  /** Reused by every projection this frame, so the pass allocates nothing. */
  private projected = { x: 0, y: 0 };
  private viewW = 1;
  private viewH = 1;
  private feed: Timed[] = [];
  private chatLines: Timed[] = [];
  private notices: Timed[] = [];
  private toasts: Timed[] = [];
  /** Ids that fired recently, and when the ping expires. Radar visibility. */
  private pings = new Map<number, number>();
  private now = 0;

  /** Viewpoint the current radar pass projects against, set by `radarBegin`. */
  private radarSelfX = 0;
  private radarSelfZ = 0;
  private radarSelfYaw = 0;
  private mapHalf = 30;

  constructor(settings: SettingsStore) {
    this.settings = settings;
    this.slotEls = Array.from(document.querySelectorAll<HTMLElement>('#slots .slot'));

    const ctx = this.radarCanvas.getContext('2d');
    if (!ctx) throw new Error('HUD: 2D canvas context unavailable for the radar');
    this.radarCtx = ctx;

    for (let i = 0; i < DIR_POOL; i++) {
      const d = document.createElement('div');
      d.className = 'dmg-dir';
      this.dirs.appendChild(d);
      this.dirPool.push(d);
    }

    for (let i = 0; i < DMG_NUM_POOL; i++) {
      const node = document.createElement('div');
      node.className = 'dmg-num';
      this.dmgNumsEl.appendChild(node);
      this.dmgNums.push({
        node,
        victim: -1,
        total: 0,
        wx: 0,
        wy: 0,
        wz: 0,
        born: 0,
        popAt: 0,
        lastHitAt: 0,
        head: false,
        killed: false,
        cText: '',
        cTransform: '',
        cOpacity: '',
        cClass: 'dmg-num',
      });
    }

    settings.onChange(() => this.applySettings());
    this.applySettings();
  }

  /* ── Lifecycle ────────────────────────────────────────────────────────── */

  setVisible(on: boolean): void {
    this.hud.classList.toggle('hidden', !on);
    if (!on) {
      this.hideScoreboard();
      this.hideDeath();
      this.hideMatchOver();
      this.closeChat();
    }
  }

  hideLoading(): void {
    this.loadingEl.classList.add('gone');
  }

  setSelfId(id: number): void {
    this.selfId = id;
  }

  /**
   * Hands the HUD a world-to-screen projector. Only the floating damage numbers
   * use it — they are anchored to the world, not to the crosshair.
   */
  setProjector(fn: ScreenProjector): void {
    this.project = fn;
  }

  /** Viewport size in CSS pixels, for culling projections that land off screen. */
  setViewport(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
  }

  /** Called on join, and whenever the mode or room changes. */
  setContext(mode: number, room: string, mapName: string): void {
    this.teamMode = mode === 1;
    const label = this.teamMode ? 'Team Deathmatch' : 'Free For All';
    this.hud.classList.toggle('ffa', !this.teamMode);
    this.modeLabel.textContent = `${label} · ${mapName}`;
    this.sbMode.textContent = label;
    this.sbRoom.textContent = room;
  }

  private applySettings(): void {
    const s = this.settings.values;
    this.statsEl.classList.toggle('hidden', !s.showStats);
    // Force the crosshair to be rewritten on the next frame.
    this.cGap = -1;
    this.cLen = -1;
    this.cThick = -1;
    this.cCol = '';
    const wantDot = s.crosshairStyle === 1 || s.crosshairStyle === 2;
    if (wantDot !== this.cDot) {
      this.cDot = wantDot;
      this.crosshair.classList.toggle('dot', wantDot);
    }
  }

  /* ── Crosshair ────────────────────────────────────────────────────────── */

  /**
   * @param spread01   current cone as a fraction of the weapon's maximum
   * @param adsFactor  0 = hip, 1 = aimed
   * @param onTarget   whether the shot would currently land on an enemy
   */
  setCrosshair(spread01: number, adsFactor: number, onTarget: boolean): void {
    const s = this.settings.values;
    // "Dot only" hides the ticks by giving them zero length.
    const dotOnly = s.crosshairStyle === 1;

    let len = dotOnly ? 0 : s.crosshairSize;
    let gap = s.crosshairGap;
    if (s.crosshairDynamic) {
      // Bloom the gap with the cone so the crosshair is an honest readout of
      // where bullets will actually go.
      gap += spread01 * 26;
      len += spread01 * 4;
    }
    // Aiming tightens it, both because the cone shrinks and because a smaller
    // reticle is easier to place precisely.
    gap *= 1 - adsFactor * 0.45;

    const gapPx = Math.round(gap);
    const lenPx = Math.round(len);
    const thick = s.crosshairThickness;
    const col = CROSSHAIR_COLORS[s.crosshairColor] ?? CROSSHAIR_COLORS[0]!;

    if (gapPx !== this.cGap) {
      this.cGap = gapPx;
      this.crosshair.style.setProperty('--gap', `${gapPx}px`);
    }
    if (lenPx !== this.cLen) {
      this.cLen = lenPx;
      this.crosshair.style.setProperty('--len', `${lenPx}px`);
    }
    if (thick !== this.cThick) {
      this.cThick = thick;
      this.crosshair.style.setProperty('--thick', `${thick}px`);
    }
    if (col !== this.cCol) {
      this.cCol = col;
      this.crosshair.style.setProperty('--col', col);
    }
    // The `hit` class swaps in the danger colour via CSS, so the tint follows
    // the theme rather than being hard-coded here.
    this.crosshair.classList.toggle('hit', onTarget);
  }

  setScope(on: boolean): void {
    if (on === this.cScope) return;
    this.cScope = on;
    this.scopeEl.classList.toggle('hidden', !on);
    // The reticle would sit on top of the scope crosshairs; hide it instead.
    this.crosshair.style.opacity = on ? '0' : '';
  }

  hitmarker(head: boolean, killed: boolean): void {
    this.hitmarkerEl.classList.toggle('kill', killed || head);
    restartAnimation(this.hitmarkerEl, 'show');
  }

  /**
   * Registers damage we dealt, to float a number over the target.
   *
   * The anchor is a world point rather than a screen point, so the number stays
   * over the enemy it belongs to instead of over the crosshair. That matters as
   * soon as there is more than one target: a number at the crosshair tells you
   * that *something* took damage, while a number over a body tells you which.
   *
   * @param victim  who was hit, so repeated hits on one target merge
   * @param amount  damage applied, already after falloff and multipliers
   * @param wx/wy/wz  where the victim appeared to be when the hit landed
   */
  damageNumber(
    victim: number,
    amount: number,
    head: boolean,
    killed: boolean,
    wx: number,
    wy: number,
    wz: number,
  ): void {
    if (amount <= 0) return;
    const now = this.now;

    for (const d of this.dmgNums) {
      if (d.victim !== victim) continue;
      if (now - d.lastHitAt > DMG_MERGE_MS || now - d.born > DMG_CHAIN_MS) continue;
      d.total += amount;
      // Sticky: one headshot in a burst should still read as a headshot.
      d.head = d.head || head;
      d.killed = d.killed || killed;
      d.lastHitAt = now;
      d.popAt = now;
      // The anchor follows the target through a burst, so the number does not
      // trail behind someone who is running.
      d.wx = wx;
      d.wy = wy;
      d.wz = wz;
      return;
    }

    // No number to merge into: claim a free slot, or else the oldest one.
    let slot = this.dmgNums[0]!;
    for (const d of this.dmgNums) {
      if (d.victim < 0) {
        slot = d;
        break;
      }
      if (d.born < slot.born) slot = d;
    }
    slot.victim = victim;
    slot.total = amount;
    slot.head = head;
    slot.killed = killed;
    slot.born = now;
    slot.popAt = now;
    slot.lastHitAt = now;
    slot.wx = wx;
    slot.wy = wy;
    slot.wz = wz;
  }

  /* ── Damage feedback ──────────────────────────────────────────────────── */

  /**
   * @param relAngle radians from the player's forward direction to the attacker,
   *                 positive clockwise on screen (so +π/2 is directly right)
   * @param severity 0..1 fraction of health just lost
   */
  damaged(relAngle: number, severity: number): void {
    this.vignetteLevel = Math.min(1, this.vignetteLevel + 0.35 + severity * 1.2);

    const d = this.dirPool[this.dirNext]!;
    this.dirNext = (this.dirNext + 1) % DIR_POOL;
    d.style.transform = `rotate(${relAngle}rad)`;
    restartAnimation(d, 'show');
  }

  /* ── Numeric readouts ─────────────────────────────────────────────────── */

  setHealth(health: number): void {
    const h = Math.max(0, Math.round(health));
    if (h === this.cHealth) return;
    this.cHealth = h;
    this.healthNum.textContent = String(h);
    this.healthFill.style.width = `${(h / MAX_HEALTH) * 100}%`;
    const cls = h <= 25 ? 'crit' : h <= 55 ? 'warn' : '';
    if (cls !== this.cHealthClass) {
      this.healthEl.classList.remove('warn', 'crit');
      if (cls) this.healthEl.classList.add(cls);
      this.cHealthClass = cls;
    }
  }

  setAmmo(weaponId: number, mag: number, reserve: number, reloading: boolean): void {
    const w = weaponById(weaponId);
    const melee = w.magSize === 0;

    if (weaponId !== this.cWeapon) {
      this.cWeapon = weaponId;
      this.weaponName.textContent = w.name;
    }
    if (mag !== this.cMag) {
      this.cMag = mag;
      this.ammoMag.textContent = melee ? '∞' : String(mag);
      const low = !melee && mag <= Math.max(1, Math.ceil(w.magSize * 0.25));
      if (low !== this.cAmmoLow) {
        this.cAmmoLow = low;
        this.ammoEl.classList.toggle('low', low);
      }
    }
    if (reserve !== this.cReserve) {
      this.cReserve = reserve;
      this.ammoReserve.textContent = melee ? '' : `/ ${reserve}`;
    }
    if (reloading !== this.cReloading) {
      this.cReloading = reloading;
      this.reloadHint.classList.toggle('hidden', !reloading);
    }
  }

  /** The three loadout slots, and which one is up. */
  setSlots(loadout: readonly number[], activeSlot: number): void {
    // Names only change on join, so rewrite them only when the loadout differs.
    let same = loadout.length === this.cLoadout.length;
    if (same) {
      for (let i = 0; i < loadout.length; i++) {
        if (loadout[i] !== this.cLoadout[i]) {
          same = false;
          break;
        }
      }
    }
    if (!same) {
      this.cLoadout = [...loadout];
      for (let i = 0; i < this.slotEls.length; i++) {
        const span = this.slotEls[i]!.querySelector('span');
        const id = loadout[i];
        if (span) span.textContent = id === undefined ? '—' : weaponById(id).name;
      }
    }
    if (activeSlot !== this.cSlot) {
      this.cSlot = activeSlot;
      for (let i = 0; i < this.slotEls.length; i++) {
        this.slotEls[i]!.classList.toggle('on', i === activeSlot);
      }
    }
  }

  setStats(fps: number, ping: number): void {
    const f = Math.round(fps);
    if (f !== this.cFps) {
      this.cFps = f;
      this.statFps.textContent = `${f} fps`;
    }
    const p = Math.round(ping);
    if (p !== this.cPing) {
      this.cPing = p;
      this.statPing.textContent = `${p} ms`;
    }
  }

  setMatch(m: MatchMsg): void {
    if (m.scoreA !== this.cScoreA) {
      this.cScoreA = m.scoreA;
      this.scoreA.textContent = String(m.scoreA);
    }
    if (m.scoreB !== this.cScoreB) {
      this.cScoreB = m.scoreB;
      this.scoreB.textContent = String(m.scoreB);
    }

    const secs = Math.max(0, Math.ceil(m.timeLeft / 1000));
    const text = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    if (text !== this.cClock) {
      this.cClock = text;
      this.clock.textContent = text;
    }
    const low = secs <= 30;
    if (low !== this.cClockLow) {
      this.cClockLow = low;
      this.clock.classList.toggle('low', low);
    }
  }

  setStreak(n: number): void {
    if (n === this.cStreak) return;
    this.cStreak = n;
    // Streaks only become interesting at three; below that it is just noise.
    if (n >= 3) {
      this.streakEl.textContent = `${n} kill streak`;
      this.streakEl.classList.add('on');
    } else {
      this.streakEl.classList.remove('on');
    }
  }

  /* ── Killfeed ─────────────────────────────────────────────────────────── */

  /**
   * One kill. Passing `killer` as an empty string marks it as a suicide or a
   * death with no attacker (fall damage), which draws a skull instead of a gun.
   */
  addKill(opts: {
    victim: string;
    killer: string;
    weaponId: number;
    head: boolean;
    back: boolean;
    killerIsSelf: boolean;
    victimIsSelf: boolean;
  }): void {
    const row = document.createElement('div');
    row.className = 'kf';

    const parts: string[] = [];
    if (opts.killer) {
      parts.push(`<span class="who${opts.killerIsSelf ? ' me' : ''}">${escapeHtml(opts.killer)}</span>`);
    }
    parts.push(`<span class="icon">${opts.killer ? weaponIcon(opts.weaponId) : suicideIcon()}</span>`);
    if (opts.head) parts.push('<span class="tag head">HS</span>');
    if (opts.back) parts.push('<span class="tag back">BACK</span>');
    parts.push(`<span class="who${opts.victimIsSelf ? ' me' : ''}">${escapeHtml(opts.victim)}</span>`);
    row.innerHTML = parts.join('');

    this.killfeedEl.appendChild(row);
    this.feed.push({ node: row, until: this.now + KILLFEED_MS, fading: false });
    // Retire the oldest immediately when the feed is full rather than letting it
    // grow and push the radar off screen.
    while (this.feed.length > KILLFEED_MAX) {
      const old = this.feed.shift()!;
      old.node.remove();
    }
  }

  /* ── Notices and toasts ───────────────────────────────────────────────── */

  notice(text: string, kind: 'gold' | 'red' | 'plain' = 'plain', small = false): void {
    const line = document.createElement('div');
    line.className = `notice-line${kind === 'plain' ? '' : ` ${kind}`}${small ? ' small' : ''}`;
    line.textContent = text;
    this.noticeEl.appendChild(line);
    this.notices.push({ node: line, until: this.now + NOTICE_MS, fading: false });
    // The stack is centred and animated; more than three at once is unreadable.
    while (this.notices.length > 3) this.notices.shift()!.node.remove();
  }

  toast(text: string, kind: 'info' | 'err' | 'ok' = 'info'): void {
    const t = document.createElement('div');
    t.className = `toast${kind === 'info' ? '' : ` ${kind}`}`;
    t.textContent = text;
    this.toastEl.appendChild(t);
    // 2.6 s delay + 0.35 s fade in the stylesheet; remove just after.
    this.toasts.push({ node: t, until: this.now + 3050, fading: false });
    while (this.toasts.length > 3) this.toasts.shift()!.node.remove();
  }

  /* ── Chat ─────────────────────────────────────────────────────────────── */

  addChat(name: string, text: string): void {
    const line = document.createElement('div');
    line.className = 'chat-line';
    line.innerHTML = `<b>${escapeHtml(name)}</b> ${escapeHtml(text)}`;
    this.chatlog.appendChild(line);
    this.chatLines.push({ node: line, until: this.now + CHAT_MS, fading: false });
    while (this.chatLines.length > CHAT_MAX) this.chatLines.shift()!.node.remove();
  }

  /** System line — join/leave notices and local errors. */
  addSystem(text: string): void {
    this.addChat('•', text);
  }

  openChat(): void {
    this.chatinput.classList.remove('hidden');
    this.chatinput.value = '';
    this.chatinput.focus();
  }

  closeChat(): void {
    this.chatinput.blur();
    this.chatinput.value = '';
    this.chatinput.classList.add('hidden');
  }

  get chatOpen(): boolean {
    return !this.chatinput.classList.contains('hidden');
  }

  get chatText(): string {
    return this.chatinput.value.trim();
  }

  get chatElement(): HTMLInputElement {
    return this.chatinput;
  }

  /* ── Overlays ─────────────────────────────────────────────────────────── */

  showDeath(killer: string, weaponId: number, suicide: boolean): void {
    this.deathKiller.textContent = suicide || !killer ? 'the fall' : killer;
    this.deathWeapon.textContent = suicide || !killer ? '' : `· ${weaponById(weaponId).name}`;
    this.deathscreen.classList.remove('hidden');
  }

  /** Countdown on the death card, in seconds. */
  setRespawnIn(seconds: number): void {
    const text = seconds <= 0 ? '0.0' : seconds.toFixed(1);
    if (text === this.cDeathCount) return;
    this.cDeathCount = text;
    this.deathCount.textContent = text;
  }

  hideDeath(): void {
    this.deathscreen.classList.add('hidden');
  }

  showScoreboard(): void {
    this.scoreboard.classList.remove('hidden');
  }

  hideScoreboard(): void {
    this.scoreboard.classList.add('hidden');
  }

  get scoreboardVisible(): boolean {
    return !this.scoreboard.classList.contains('hidden');
  }

  showMatchOver(text: string): void {
    this.moWinner.textContent = text;
    this.matchoverEl.classList.remove('hidden');
  }

  hideMatchOver(): void {
    this.matchoverEl.classList.add('hidden');
  }

  /**
   * Rebuilds the scoreboard rows.
   *
   * Only called when the roster message arrives (about once a second) or when
   * the scoreboard is opened, never per frame.
   */
  setRoster(entries: readonly RosterEntry[]): void {
    // Sort a copy: the caller's array is the live roster.
    const rows = [...entries].sort((a, b) => {
      if (this.teamMode && a.team !== b.team) return a.team - b.team;
      if (b.kills !== a.kills) return b.kills - a.kills;
      return a.deaths - b.deaths;
    });

    const html: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i]!;
      // `RF`, not `AF`. Roster flags and actor flags are different bytes with
      // different meanings, and this loop read the actor ones for a while: bot
      // there is bit 6, dead is bit 3, so every test silently came back false and
      // the scoreboard quietly stopped labelling bots or dimming the dead.
      const classes = ['sb-row'];
      if (r.id === this.selfId) classes.push('me');
      if (r.flags & RF.DEAD) classes.push('dead');
      if (this.teamMode) classes.push(r.team === TEAM_A ? 'ta' : r.team === TEAM_B ? 'tb' : '');
      const bot = r.flags & RF.BOT ? '<span class="bot">BOT</span>' : '';
      html.push(
        `<div class="${classes.join(' ').trim()}">` +
          `<span>${i + 1}</span>` +
          `<span class="nm">${escapeHtml(r.name)}${bot}</span>` +
          `<span>${r.kills}</span>` +
          `<span>${r.deaths}</span>` +
          `<span class="pg">${r.flags & RF.BOT ? '—' : `${r.ping}`}</span>` +
          `</div>`,
      );
    }
    this.sbRows.innerHTML = html.join('');
  }

  /* ── Radar ────────────────────────────────────────────────────────────── */

  /** Marks a player as having just fired, making them briefly radar-visible. */
  pingActor(id: number): void {
    this.pings.set(id, this.now + RADAR_PING_MS);
  }

  /** Map half-extent in metres, so the radar can draw the real bounds. */
  setMapHalf(half: number): void {
    this.mapHalf = half;
  }

  /**
   * Clears the radar, stores the viewpoint, and draws the static parts.
   *
   * The canvas is rotated so the player's facing is always up — a north-locked
   * radar forces a mental rotation every time you read it, which in a shooter is
   * time you do not have.
   */
  radarBegin(self: RadarSelf): void {
    this.radarSelfX = self.x;
    this.radarSelfZ = self.z;
    this.radarSelfYaw = self.yaw;

    const ctx = this.radarCtx;
    const w = this.radarCanvas.width;
    const h = this.radarCanvas.height;
    const cx = w / 2;
    const cy = h / 2;

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Clip to the dial so blips near the edge cannot spill onto the page.
    ctx.save();
    ctx.beginPath();
    ctx.arc(cx, cy, cx - 1, 0, Math.PI * 2);
    ctx.clip();

    // World → radar. Rotating by +yaw brings the facing direction to the top:
    // yaw 0 looks down −Z, world Z maps straight to canvas Y, and a canvas
    // rotation of +yaw carries −Z to screen-up. `radarBlip` does the same
    // transform by hand so its dots stay circular.
    ctx.translate(cx, cy);
    ctx.rotate(self.yaw);
    const k = cx / RADAR_RANGE;
    ctx.scale(k, k);
    ctx.translate(-self.x, -self.z);

    // Map bounds, so the player can tell where the walls are.
    ctx.lineWidth = 1.2 / k;
    ctx.strokeStyle = 'rgba(255,255,255,0.16)';
    const s = this.mapHalf;
    ctx.strokeRect(-s, -s, s * 2, s * 2);

    ctx.restore();
    ctx.setTransform(1, 0, 0, 1, 0, 0);

    // Own marker: a triangle at the centre, always pointing up.
    ctx.save();
    ctx.translate(cx, cy);
    ctx.beginPath();
    ctx.moveTo(0, -9);
    ctx.lineTo(6.5, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-6.5, 7);
    ctx.closePath();
    ctx.fillStyle = '#f2c14e';
    ctx.fill();
    ctx.restore();
  }

  /**
   * One blip. Returns silently for anything out of range.
   *
   * `friendly` blips are always drawn; enemies only appear if they have fired
   * recently. Full enemy positions on a radar removes most of the reason to
   * listen, and listening is half of playing a shooter well.
   */
  radarBlip(id: number, x: number, z: number, friendly: boolean, dead: boolean): void {
    if (dead) return;
    if (!friendly) {
      const until = this.pings.get(id);
      if (until === undefined || until < this.now) return;
    }

    const ctx = this.radarCtx;
    const w = this.radarCanvas.width;
    const cx = w / 2;
    const cy = w / 2;
    const k = cx / RADAR_RANGE;

    // Rotate the relative offset by hand rather than transforming the context —
    // the dot itself must stay circular and unrotated.
    const dx = x - this.radarSelfX;
    const dz = z - this.radarSelfZ;
    const c = Math.cos(this.radarSelfYaw);
    const s = Math.sin(this.radarSelfYaw);
    const rx = dx * c - dz * s;
    const rz = dx * s + dz * c;

    const px = cx + rx * k;
    const py = cy + rz * k;
    // Keep the dot inside the dial, clamped to the rim if the target is beyond
    // radar range but still worth knowing about.
    const dist = Math.hypot(px - cx, py - cy);
    const limit = cx - 8;
    let fx = px;
    let fy = py;
    let edge = false;
    if (dist > limit) {
      if (dist > cx * 1.9) return;
      const t = limit / dist;
      fx = cx + (px - cx) * t;
      fy = cy + (py - cy) * t;
      edge = true;
    }

    ctx.beginPath();
    ctx.arc(fx, fy, edge ? 3.4 : 5, 0, Math.PI * 2);
    ctx.fillStyle = friendly ? '#5fa8e8' : '#e0524a';
    ctx.globalAlpha = edge ? 0.55 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.55)';
    ctx.stroke();
  }

  /* ── Per-frame ────────────────────────────────────────────────────────── */

  /** Advances timers and animated overlays. `nowLocal` is `performance.now()`. */
  update(dt: number, nowLocal: number): void {
    this.now = nowLocal;

    // Damage vignette: fast rise handled by `damaged`, slow decay here.
    if (this.vignetteLevel > 0) {
      this.vignetteLevel = Math.max(0, this.vignetteLevel - dt * 1.35);
      // Quantise before writing: the CSS transition does the smoothing, and
      // writing a new opacity every frame defeats it.
      const q = Math.round(Math.min(1, this.vignetteLevel) * 10) / 10;
      if (q !== this.cVignette) {
        this.cVignette = q;
        this.vignette.style.opacity = String(q);
      }
    }

    this.expire(this.feed, 'out', 320);
    this.expire(this.chatLines, 'out', 420);
    this.expireHard(this.notices);
    this.expireHard(this.toasts);
    this.placeDamageNumbers();

    if (this.pings.size > 0) {
      for (const [id, until] of this.pings) {
        if (until < nowLocal) this.pings.delete(id);
      }
    }
  }

  /**
   * Places the floating damage numbers, and retires the ones that have faded.
   *
   * These are the one thing in this file rewritten every frame. They have to be:
   * each is pinned to a point in the world, so its screen position changes
   * whenever the camera moves, which is always. The cost is bounded and cheap —
   * at most twelve elements, and only `transform` and `opacity`, which the
   * compositor animates without touching layout. The written values are still
   * compared first, so a number over a stationary target while the player stands
   * still writes nothing at all.
   */
  private placeDamageNumbers(): void {
    const now = this.now;
    const project = this.project;

    for (const d of this.dmgNums) {
      if (d.victim < 0) continue;

      const sinceHit = now - d.lastHitAt;
      const fade =
        sinceHit <= DMG_HOLD_MS ? 1 : 1 - (sinceHit - DMG_HOLD_MS) / DMG_FADE_MS;
      if (fade <= 0) {
        d.victim = -1;
        this.writeDmg(d, d.cText, d.cTransform, '0', d.cClass);
        continue;
      }

      // Hidden rather than clamped to the edge: a number pinned to the border
      // reads as a hit on something that is not there.
      const visible = project ? project(d.wx, d.wy, d.wz, this.projected) : false;
      if (!visible) {
        this.writeDmg(d, d.cText, d.cTransform, '0', d.cClass);
        continue;
      }
      const sx = this.projected.x * this.viewW;
      const sy = this.projected.y * this.viewH;
      if (sx < -160 || sx > this.viewW + 160 || sy < -160 || sy > this.viewH + 160) {
        this.writeDmg(d, d.cText, d.cTransform, '0', d.cClass);
        continue;
      }

      // Rise fast then ease off, so the number clears the body it came from
      // immediately and is still readable while it drifts.
      const rise = Math.pow(Math.min(1, (now - d.born) / DMG_DRIFT_MS), 0.7) * DMG_RISE_PX;
      const sincePop = now - d.popAt;
      const pop =
        sincePop < DMG_POP_MS ? 1 + Math.sin((sincePop / DMG_POP_MS) * Math.PI) * 0.26 : 1;

      const x = Math.round(sx);
      const y = Math.round(sy - rise);
      this.writeDmg(
        d,
        String(Math.round(d.total)),
        `translate3d(${x}px, ${y}px, 0) scale(${pop.toFixed(3)})`,
        fade >= 1 ? '1' : fade.toFixed(2),
        d.killed ? 'dmg-num kill' : d.head ? 'dmg-num head' : 'dmg-num',
      );
    }
  }

  /** Writes only what changed. Called for every live damage number every frame. */
  private writeDmg(
    d: DamageNum,
    text: string,
    transform: string,
    opacity: string,
    cls: string,
  ): void {
    if (text !== d.cText) {
      d.cText = text;
      d.node.textContent = text;
    }
    if (transform !== d.cTransform) {
      d.cTransform = transform;
      d.node.style.transform = transform;
    }
    if (opacity !== d.cOpacity) {
      d.cOpacity = opacity;
      d.node.style.opacity = opacity;
    }
    if (cls !== d.cClass) {
      d.cClass = cls;
      d.node.className = cls;
    }
  }

  /** Fades an entry out with a CSS class, then removes it. */
  private expire(list: Timed[], fadeClass: string, fadeMs: number): void {
    for (let i = 0; i < list.length; i++) {
      const item = list[i]!;
      if (!item.fading && this.now >= item.until) {
        item.fading = true;
        item.until = this.now + fadeMs;
        item.node.classList.add(fadeClass);
      } else if (item.fading && this.now >= item.until) {
        item.node.remove();
        list.splice(i, 1);
        i--;
      }
    }
  }

  /** For elements whose stylesheet animation already ends in `forwards`. */
  private expireHard(list: Timed[]): void {
    for (let i = 0; i < list.length; i++) {
      if (this.now >= list[i]!.until) {
        list[i]!.node.remove();
        list.splice(i, 1);
        i--;
      }
    }
  }

  /** Wipes every transient element. Called when leaving a match. */
  resetTransient(): void {
    for (const f of this.feed) f.node.remove();
    for (const c of this.chatLines) c.node.remove();
    for (const n of this.notices) n.node.remove();
    this.feed.length = 0;
    this.chatLines.length = 0;
    this.notices.length = 0;
    this.pings.clear();
    this.vignetteLevel = 0;
    this.vignette.style.opacity = '0';
    this.cVignette = 0;
    // Pooled, so these are freed rather than removed. Hidden immediately: a
    // number left mid-fade would still be on screen behind the next menu.
    for (const d of this.dmgNums) {
      d.victim = -1;
      d.node.style.opacity = '0';
      d.cOpacity = '0';
    }
    this.setStreak(0);
    this.hideDeath();
    this.hideMatchOver();
    this.hideScoreboard();
    // Invalidate the caches so a rejoin repopulates every readout.
    this.cHealth = -1;
    this.cMag = -1;
    this.cReserve = -1;
    this.cWeapon = -1;
    this.cSlot = -1;
    this.cScoreA = -1;
    this.cScoreB = -1;
    this.cClock = '';
    this.cLoadout = [];
    this.sbRows.innerHTML = '';
  }
}

/**
 * Escapes text before it goes near innerHTML.
 *
 * Player names and chat arrive from other people over the network. The server
 * strips control characters, but it does not and should not strip angle
 * brackets — so the sanitising has to happen at the point of insertion, here.
 */
function escapeHtml(text: string): string {
  let out = '';
  for (const ch of text) {
    switch (ch) {
      case '&':
        out += '&amp;';
        break;
      case '<':
        out += '&lt;';
        break;
      case '>':
        out += '&gt;';
        break;
      case '"':
        out += '&quot;';
        break;
      case "'":
        out += '&#39;';
        break;
      default:
        out += ch;
    }
  }
  return out;
}
