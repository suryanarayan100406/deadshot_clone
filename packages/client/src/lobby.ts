/**
 * The pre-match staging room.
 *
 * A party is a group of people who arrive one at a time, so there has to be
 * somewhere to stand while the rest of them load. This is that somewhere: the
 * people, an invite code, and a host who decides when to go.
 *
 * This used to be a card pinned to the right-hand edge, on the reasoning that the
 * players are already spawned on the map and may as well walk around while they
 * wait. That reasoning was wrong, and the complaint that killed it was exactly the
 * one you would expect: you could not see who you were about to play with. A list
 * of names does not answer "who is here" — it answers "how many". So the lobby is
 * now a takeover, and the middle of it is the room itself, with everybody standing
 * in it holding the weapon they picked.
 *
 * Three things this class deliberately does not own:
 *
 * - **The renderer.** `LobbyStage` hands out a scene and a camera; `main.ts` owns
 *   the one WebGL context and draws them. This layer is HTML on top, transparent
 *   through the middle so the room shows through.
 * - **Authority.** Every button sends an intent and repaints from the server's
 *   answer, so a refused request corrects itself on the next packet rather than
 *   leaving the UI describing a room that does not exist. `LF.CAN_START` is read,
 *   never re-derived: the client's opinion of whether a match may start is not
 *   the one that counts.
 * - **A clock.** The countdown digit is interpolated locally between packets
 *   because the lobby packet arrives four times a second and a number that
 *   changes on a 250 ms grid reads as a stutter, but the *deadline* comes from
 *   the server every time.
 */

// Types only: this module never touches Three.js, it just hands the stage's scene
// and camera to whoever owns the renderer.
import type * as THREE from 'three';

import {
  LF,
  MAX_PLAYERS,
  MODE,
  MODE_NAMES,
  PHASE,
  RF,
  type LobbyMsg,
  type RosterEntry,
} from '@oneshot/shared';

import { LobbyStage } from './lobbystage';

export interface LobbyHooks {
  /** Host pressed Start (or Cancel — the server treats it as a toggle). */
  onStart(): void;
  /** Host flipped bot fill. */
  onBots(on: boolean): void;
  /** Anyone flipped their own ready state. */
  onReady(): void;
  /** Somebody wants out before the match begins. */
  onLeave(): void;
  /**
   * The screen opened or closed. The game uses this to stop fighting over the
   * pointer: a screen with buttons on it cannot share the cursor with a locked
   * one, and the player must not be walking around behind it either.
   */
  onVisibility(open: boolean): void;
  /** Short confirmation, routed to the HUD's toast so there is one style of them. */
  onToast(text: string, kind: 'info' | 'err' | 'ok'): void;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Lobby: missing #${id} in the document`);
  return found as T;
}

/** Nothing on screen. The state a client in a public room sits in forever. */
const CLOSED: LobbyMsg = { phase: PHASE.LIVE, hostId: 0, flags: 0, countdown: 0 };

export class LobbyScreen {
  private hooks: LobbyHooks;
  private stage: LobbyStage;

  private root = el('lobby-screen');
  private modeEl = el('lb-mode');
  private mapEl = el('lb-map');
  private codeEl = el('lb-code');
  private inviteRow = el('lb-invite');
  private countEl = el('lb-count');
  private tallyEl = el('lb-tally');
  private noteEl = el('lb-note');
  private botsRow = el('lb-bots-row');
  private botsSwitch = el<HTMLButtonElement>('lb-bots');
  private readyBtn = el<HTMLButtonElement>('lb-ready');
  private startBtn = el<HTMLButtonElement>('lb-start');
  private leaveBtn = el<HTMLButtonElement>('lb-leave');
  private copyBtn = el<HTMLButtonElement>('lb-copy');
  private cdEl = el('lb-countdown');
  private cdSecs = el('lb-cd-secs');

  private state: LobbyMsg = CLOSED;
  private roster: readonly RosterEntry[] = [];
  private selfId = -1;
  private teamMode = false;
  private room = '';
  /** What the screen last reported through `onVisibility`, so edges fire once. */
  private reportedOpen = false;
  /**
   * Local deadline for the countdown, in `performance.now()` terms, or 0.
   *
   * Derived from the packet rather than sent as one: an absolute server time would
   * need a clock offset to be useful, and the offset's error would show up as the
   * one number on screen everybody is staring at.
   */
  private cdEnd = 0;
  /** Last digit painted, so `update()` touches the DOM once a second, not 60 times. */
  private cdShown = -1;

  constructor(hooks: LobbyHooks, shadows: boolean) {
    this.hooks = hooks;
    this.stage = new LobbyStage(shadows);

    this.startBtn.addEventListener('click', () => this.hooks.onStart());
    this.readyBtn.addEventListener('click', () => this.hooks.onReady());
    this.leaveBtn.addEventListener('click', () => this.hooks.onLeave());
    this.botsSwitch.addEventListener('click', () => {
      // Reports the value being asked for, not the one on screen: the switch is
      // repainted from the server's answer, so a rejected request corrects itself.
      this.hooks.onBots((this.state.flags & LF.BOTS) === 0);
    });
    this.copyBtn.addEventListener('click', () => void this.copyInvite());
  }

  /* ── What main.ts draws ───────────────────────────────────────────────────── */

  get scene(): THREE.Scene {
    return this.stage.scene;
  }

  get camera(): THREE.PerspectiveCamera {
    return this.stage.camera;
  }

  /* ── Context ──────────────────────────────────────────────────────────────── */

  /** Called once per match on the welcome packet. */
  setContext(mode: number, mapName: string, room: string, selfId: number): void {
    // The mode id rather than its label, so nothing here depends on the spelling
    // of a string that exists to be read by a human.
    this.modeEl.textContent = MODE_NAMES[mode] ?? 'Match';
    this.mapEl.textContent = mapName;
    this.teamMode = mode === MODE.TDM;
    this.room = room;
    this.selfId = selfId;
    this.codeEl.textContent = room || '—';
    // A public room has no code to share, and offering to copy one would be a
    // promise the server cannot keep: anyone typing it lands somewhere else.
    this.inviteRow.classList.toggle('hidden', room === '');
    this.stage.setSelf(selfId);
    this.render();
  }

  /* ── Server state ─────────────────────────────────────────────────────────── */

  setLobby(m: LobbyMsg): void {
    this.state = m;
    this.cdEnd = m.countdown > 0 ? performance.now() + m.countdown : 0;
    this.render();
  }

  setRoster(entries: readonly RosterEntry[]): void {
    this.roster = entries;
    if (this.open) this.render();
  }

  /** Back to nothing on screen when the match is left. */
  reset(): void {
    this.state = CLOSED;
    this.roster = [];
    this.cdEnd = 0;
    this.stage.clear();
    this.render();
  }

  /* ── Visibility ───────────────────────────────────────────────────────────── */

  /**
   * True while the room is gathering.
   *
   * There is no collapsed state to distinguish any more, which is why this is the
   * only visibility question the rest of the client has to ask. A public room is
   * `LIVE` from the moment it is built, so quick-match players never see this at
   * all — join-in-progress has no consent step to wait on.
   */
  get open(): boolean {
    return this.state.phase === PHASE.LOBBY;
  }

  /* ── Per-frame ────────────────────────────────────────────────────────────── */

  /** Pose the room and tick the countdown. Only called while `open`. */
  update(dt: number, nowLocal: number): void {
    this.stage.update(dt, nowLocal);

    // Floored at 1 rather than 0 while a deadline is set. The server flips the
    // phase when the countdown expires, so this only ever covers the packet in
    // flight — and "Starting in 1…" for that gap is honest, where a 0 that
    // reverts to "waiting on 2 players" is a visible stutter at the one moment
    // everybody is watching the number.
    const secs = this.cdEnd > 0 ? Math.max(1, Math.ceil((this.cdEnd - nowLocal) / 1000)) : 0;
    if (secs === this.cdShown) return;
    this.cdShown = secs;
    this.cdEl.classList.toggle('hidden', secs <= 0);
    this.cdSecs.textContent = String(secs);
    // The note carries the same number, so it has to be repainted with it. Cheap:
    // this runs once a second at most, and only while a countdown is running.
    this.renderChrome(secs);
  }

  resize(aspect: number): void {
    this.stage.resize(aspect);
  }

  setShadows(on: boolean): void {
    this.stage.setShadows(on);
  }

  dispose(): void {
    this.stage.dispose();
  }

  /* ── Render ───────────────────────────────────────────────────────────────── */

  private render(): void {
    const open = this.open;
    this.root.classList.toggle('hidden', !open);

    if (open) {
      const secs = this.state.countdown > 0 ? Math.ceil(this.state.countdown / 1000) : 0;
      this.cdShown = secs;
      this.cdEl.classList.toggle('hidden', secs <= 0);
      this.cdSecs.textContent = String(secs);
      this.stage.setRoster(this.roster, this.teamMode, this.state.hostId);
      this.renderChrome(secs);
    }

    if (open !== this.reportedOpen) {
      this.reportedOpen = open;
      // Leaving the lobby leaves twelve characters posed in a scene nothing is
      // drawing. Dropping them here rather than in `reset()` covers the ordinary
      // exit too: the match starting, which never calls `reset`.
      if (!open) this.stage.clear();
      this.hooks.onVisibility(open);
    }
  }

  private renderChrome(secs: number): void {
    const isHost = this.selfId === this.state.hostId;
    const canStart = (this.state.flags & LF.CAN_START) !== 0;

    let humans = 0;
    let ready = 0;
    let hostName = '';
    let iAmReady = false;
    for (const r of this.roster) {
      if ((r.flags & RF.BOT) !== 0) continue;
      humans++;
      if ((r.flags & RF.READY) !== 0) {
        ready++;
        if (r.id === this.selfId) iAmReady = true;
      }
      if ((r.flags & RF.HOST) !== 0) hostName = r.name;
    }

    this.countEl.textContent = `${this.roster.length} / ${MAX_PLAYERS}`;
    this.tallyEl.textContent = humans > 0 ? `${ready} of ${humans} ready` : 'Nobody here yet';
    this.tallyEl.classList.toggle('all', humans > 0 && ready === humans);

    // Bots are the host's decision, so everyone can see the setting and only the
    // host can move it — a locked switch explains the room, a hidden one does not.
    const bots = (this.state.flags & LF.BOTS) !== 0;
    this.botsSwitch.classList.toggle('on', bots);
    this.botsSwitch.setAttribute('aria-checked', String(bots));
    this.botsRow.classList.toggle('locked', !isHost);

    this.readyBtn.classList.toggle('on', iAmReady);
    this.readyBtn.textContent = iAmReady ? 'Ready ✓' : 'Ready';

    this.startBtn.classList.toggle('hidden', !isHost);
    this.startBtn.textContent = secs > 0 ? 'Cancel' : 'Start match';
    // Disabled rather than absent while the room is not all-ready. The host has to
    // be able to see that the button is theirs and that something is holding it —
    // hiding it would read as "you are not the host", which is a different problem
    // with a different fix.
    const blocked = !canStart && secs <= 0;
    this.startBtn.disabled = blocked;
    this.startBtn.title = blocked ? 'Everyone has to be ready first' : '';

    this.noteEl.classList.toggle('counting', secs > 0);
    this.noteEl.textContent = this.noteText(secs, humans, ready, isHost, hostName, canStart);
  }

  private noteText(
    secs: number,
    humans: number,
    ready: number,
    isHost: boolean,
    hostName: string,
    canStart: boolean,
  ): string {
    if (secs > 0) return `Starting in ${secs}…`;
    if (humans <= 1) {
      return this.room
        ? 'Only you so far. Send the code to a friend, or ready up and start on your own.'
        : 'Waiting for players.';
    }
    const waiting = humans - ready;
    if (isHost) {
      return canStart
        ? 'Everyone is ready. Start when you like.'
        : `Waiting on ${waiting} ${waiting === 1 ? 'player' : 'players'} to ready up.`;
    }
    if (!canStart) {
      return waiting === 1 && !this.amReady()
        ? 'Everyone else is ready — you are the last one.'
        : `Waiting on ${waiting} ${waiting === 1 ? 'player' : 'players'} to ready up.`;
    }
    return hostName ? `Everyone is ready. ${hostName} starts the match.` : 'Everyone is ready.';
  }

  private amReady(): boolean {
    const me = this.roster.find((r) => r.id === this.selfId);
    return me ? (me.flags & RF.READY) !== 0 : false;
  }

  /* ── Invite ───────────────────────────────────────────────────────────────── */

  /**
   * Copy a joinable link.
   *
   * A link rather than the bare code because the code alone needs explaining, and
   * because `?party=` is read back on load — so what lands in the friend's clipboard
   * is a thing they can click, not an instruction.
   *
   * The clipboard API is refused outright in insecure contexts and can reject on a
   * permissions prompt, so the fallback selects the code and says so: the player
   * still gets to copy something, which is more use than an error.
   */
  private async copyInvite(): Promise<void> {
    const link = `${location.origin}${location.pathname}?party=${encodeURIComponent(this.room)}`;
    try {
      await navigator.clipboard.writeText(link);
      this.hooks.onToast('Invite link copied', 'ok');
    } catch {
      const range = document.createRange();
      range.selectNodeContents(this.codeEl);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      this.hooks.onToast('Press Ctrl+C to copy the code', 'info');
    }
  }
}
