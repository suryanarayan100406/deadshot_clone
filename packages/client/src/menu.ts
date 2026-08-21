/**
 * Main menu, weapon picker, settings, help and pause.
 *
 * This is the one part of the interface that *is* interactive, and it is
 * deliberately kept apart from the HUD for that reason: the HUD must never
 * intercept a click, and the menu must never be pointer-locked. Nothing here
 * runs per frame — every method is event-driven, so an open settings panel costs
 * nothing while the game keeps rendering behind it.
 *
 * The settings panel is generated from `SETTINGS_SCHEMA` rather than written out
 * in markup. Adding a slider is then one entry in a table, and it is impossible
 * for a control to drift out of sync with the value it edits, because both come
 * from the same declaration.
 */

import {
  PARTY_CODE_MAX,
  WEAPONS,
  cycleTime,
  randomPartyCode,
  sanitizePartyCode,
  type WeaponDef,
} from '@oneshot/shared';
import {
  SETTINGS_SCHEMA,
  type Control,
  type Settings,
  type SettingsStore,
  type TabKey,
} from './settings';
import { weaponSvg } from './weaponart';

export interface PlayConfig {
  name: string;
  mode: number;
  primary: string;
  /**
   * Party code, or empty for a public match. The server treats a named room as a
   * party: everyone who types the same code lands in the same match and, in team
   * deathmatch, on the same side.
   *
   * Set from the button that was pressed, never from the state of the code box —
   * see `Intent`.
   */
  room: string;
}

/**
 * Which button the player pressed, and therefore what `PlayConfig.room` becomes.
 *
 * There used to be one PLAY button that sent whatever was in the code box, and the
 * code box is *persisted*: it is written on every keystroke, by the create button,
 * and by an invite link. So one afternoon of playing with friends left a code in
 * storage that every future press of PLAY silently rejoined — the player asked for
 * a game and got last week's private room, already in progress and full of bots,
 * with nothing anywhere saying why. Naming the intention and deriving the room from
 * it makes that mistake unrepresentable: quick match cannot see the box, and
 * neither of the other two can be reached without pressing them.
 */
type Intent = 'quick' | 'create' | 'join';

export interface MenuHooks {
  onPlay(cfg: PlayConfig): void;
  onResume(): void;
  /** Leave the match and come back to the menu. */
  onQuit(): void;
}

/** Human-readable class per weapon, for the detail card. */
const WEAPON_CLASS: Record<string, string> = {
  ranger: 'Assault Rifle',
  vector: 'Submachine Gun',
  breacher: 'Shotgun',
  longshot: 'Sniper Rifle',
  sidearm: 'Pistol',
  blade: 'Melee',
};

/** One line of flavour that also states the weapon's actual role. */
const WEAPON_NOTE: Record<string, string> = {
  ranger: 'Even-handed at every range. Four body shots, three with a head hit.',
  vector: 'Fastest fire rate in the game and it shows — deadly inside 18 m, wasteful past 40.',
  breacher: 'Nine pellets a shell. Lethal in a doorway, close to useless across the yard.',
  longshot: 'One hit anywhere above the waist. Slow to cycle and slower to aim.',
  sidearm: 'The fallback. Quick to draw, quick to reload, honest damage up close.',
  blade: 'Moves you 18% faster. A hit from behind is always a kill.',
};

/** Random name parts, so an empty name box still produces something usable. */
const NAME_A = [
  'Swift', 'Iron', 'Silent', 'Rapid', 'Hollow', 'Crimson', 'Vapor', 'Cobalt',
  'Rogue', 'Static', 'Amber', 'Feral', 'Onyx', 'Blunt', 'Prime',
];
const NAME_B = [
  'Fox', 'Rook', 'Ember', 'Wolf', 'Drift', 'Spark', 'Vector', 'Crow',
  'Talon', 'Echo', 'Ridge', 'Vault', 'Wraith', 'Cinder', 'Bolt',
];

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)]!;
}

function randomName(): string {
  return `${pick(NAME_A)}${pick(NAME_B)}${Math.floor(Math.random() * 90) + 10}`;
}

function el<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Menu: missing #${id} in the document`);
  return found as T;
}

/**
 * Peak values across the whole weapon table, so a stat bar means "relative to
 * the best in the game" rather than an arbitrary constant that goes stale the
 * moment a weapon is retuned.
 */
const PEAK = {
  burst: Math.max(...WEAPONS.map((w) => w.damage * w.pellets)),
  rpm: Math.max(...WEAPONS.map((w) => w.rpm)),
  reach: Math.max(...WEAPONS.map((w) => w.falloffStart)),
  mobility: Math.max(...WEAPONS.map((w) => w.moveMult)),
  mag: Math.max(...WEAPONS.map((w) => w.magSize)),
};

export class Menu {
  private settings: SettingsStore;
  private hooks: MenuHooks;

  private menu = el('menu');
  private nameInput = el<HTMLInputElement>('name-input');
  private roomInput = el<HTMLInputElement>('room-input');
  private roomNew = el<HTMLButtonElement>('room-new');
  private playJoin = el<HTMLButtonElement>('play-join');
  private partyNote = el('party-note');
  private modeSelect = el('mode-select');
  private weaponSelect = el('weapon-select');
  private weaponCard = el('weapon-card');
  private play = el<HTMLButtonElement>('play');
  private playSub = el('play-sub');
  private online = el('online');
  private footBuild = el('foot-build');

  private settingsModal = el('settings-modal');
  private settingsTabs = el('settings-tabs');
  private settingsBody = el('settings-body');
  private helpModal = el('help-modal');
  private pauseModal = el('pause-modal');

  private primary: string;
  private mode: number;
  private tab: TabKey = 'game';
  /** True when settings was opened from the pause menu and should return to it. */
  private pausePending = false;
  /**
   * False while a connection is in flight, so no second match can be asked for.
   * Held as state rather than read back off `play.disabled`, because Join has a
   * reason of its own to be off and the two have to compose.
   */
  private playEnabled = true;
  private autoJoinCode = '';
  /** Rebinding functions for every control on the open settings tab. */
  private syncers: Array<(s: Settings) => void> = [];

  constructor(settings: SettingsStore, hooks: MenuHooks) {
    this.settings = settings;
    this.hooks = hooks;

    // Restore the last session's choices, falling back to something valid.
    this.mode = settings.get('mode') === 1 ? 1 : 0;
    const savedPrimary = settings.get('primary');
    this.primary = WEAPONS.some((w) => w.key === savedPrimary && w.slot === 'primary')
      ? savedPrimary
      : 'ranger';

    this.nameInput.value = settings.get('name');
    this.nameInput.placeholder = randomName();
    this.roomInput.value = settings.get('room');
    // Set here rather than left in the markup so the field cannot accept a code
    // longer than the server will key a room by. A `maxlength` attribute that
    // disagreed with `PARTY_CODE_MAX` would silently truncate on the way in.
    this.roomInput.maxLength = PARTY_CODE_MAX;
    // After the field is wired up but before anything reads it, so an invite
    // link is already in place when the play button labels itself.
    this.prefillFromLink();

    this.buildWeaponPicker();
    this.bindMode();
    this.bindName();
    this.bindParty();
    this.bindButtons();
    this.bindModals();
    this.buildSettings();

    this.selectWeapon(this.primary);
    this.syncMode();
    this.syncParty();
    this.setBuild();

    // Keep the open settings panel truthful if anything else changes a value
    // (the reset button, or a keybind that toggles a setting mid-match).
    settings.onChange((s) => {
      for (const fn of this.syncers) fn(s);
    });
  }

  /** If the player arrived via an invite link, take them directly into the lobby. */
  checkAutoJoin(): void {
    if (this.autoJoinCode) {
      this.submit('join');
    }
  }

  /* ── Visibility ───────────────────────────────────────────────────────── */

  show(): void {
    this.menu.classList.remove('hidden');
  }

  hide(): void {
    this.menu.classList.add('hidden');
    this.closeAllModals();
  }

  get visible(): boolean {
    return !this.menu.classList.contains('hidden');
  }

  /* ── Weapon picker ────────────────────────────────────────────────────── */

  private buildWeaponPicker(): void {
    this.weaponSelect.className = 'weapons';
    const primaries = WEAPONS.filter((w) => w.slot === 'primary');
    for (const w of primaries) {
      const btn = document.createElement('button');
      btn.className = 'wpn';
      btn.type = 'button';
      btn.dataset.key = w.key;
      btn.setAttribute('aria-label', `${w.name} — ${WEAPON_CLASS[w.key] ?? ''}`);
      // The SVG is generated from the same proportions as the 3D model, so the
      // button is a small picture of the gun you will actually be holding.
      btn.innerHTML = `${weaponSvg(w.id)}<em>${w.name}</em>`;
      btn.addEventListener('click', () => this.selectWeapon(w.key));
      // Hovering previews the card without committing — comparing four weapons
      // by clicking each one is needlessly slow.
      btn.addEventListener('mouseenter', () => this.renderCard(w));
      btn.addEventListener('mouseleave', () => this.renderCard(this.currentWeapon()));
      this.weaponSelect.appendChild(btn);
    }
  }

  private currentWeapon(): WeaponDef {
    return WEAPONS.find((w) => w.key === this.primary) ?? WEAPONS[0]!;
  }

  private selectWeapon(key: string): void {
    this.primary = key;
    this.settings.set('primary', key);
    for (const btn of this.weaponSelect.querySelectorAll<HTMLElement>('.wpn')) {
      btn.classList.toggle('on', btn.dataset.key === key);
    }
    this.renderCard(this.currentWeapon());
  }

  private renderCard(w: WeaponDef): void {
    const bar = (label: string, frac: number, value: string) =>
      `<div class="wc-stat"><b>${label}</b><i><u style="width:${Math.round(
        Math.max(0.04, Math.min(1, frac)) * 100,
      )}%"></u></i><span>${value}</span></div>`;

    // Damage per trigger pull, which is the number that actually matters — a
    // shotgun's per-pellet damage tells you nothing on its own.
    const burst = w.damage * w.pellets;
    // Spread is an angle; invert it so more accurate reads as a longer bar.
    const accuracy = 1 - Math.min(1, w.spreadBase / 0.04);
    const shotsToKill = Math.max(1, Math.ceil(100 / burst));

    this.weaponCard.innerHTML =
      `<div class="wc-name">${w.name}</div>` +
      `<div class="wc-class">${WEAPON_CLASS[w.key] ?? w.fireMode}</div>` +
      `<div class="wc-art">${weaponSvg(w.id)}</div>` +
      `<div class="wc-stats">` +
      bar('Damage', burst / PEAK.burst, String(burst)) +
      bar('Rate', w.rpm / PEAK.rpm, `${w.rpm}`) +
      bar('Range', w.falloffStart / PEAK.reach, `${Math.round(w.falloffStart)}m`) +
      bar('Accuracy', accuracy, `${Math.round(accuracy * 100)}%`) +
      bar('Mobility', w.moveMult / PEAK.mobility, `${Math.round(w.moveMult * 100)}%`) +
      bar('Magazine', w.magSize / PEAK.mag, `${w.magSize}`) +
      `</div>` +
      `<div class="wc-note">${WEAPON_NOTE[w.key] ?? ''} ` +
      `<b>${shotsToKill}</b> shot${shotsToKill === 1 ? '' : 's'} to kill, ` +
      `${(cycleTime(w) * 1000).toFixed(0)} ms between them.</div>`;
  }

  /* ── Mode and name ────────────────────────────────────────────────────── */

  private bindMode(): void {
    for (const btn of this.modeSelect.querySelectorAll<HTMLElement>('button[data-mode]')) {
      btn.addEventListener('click', () => {
        this.mode = btn.dataset.mode === '1' ? 1 : 0;
        this.settings.set('mode', this.mode);
        this.syncMode();
      });
    }
  }

  private syncMode(): void {
    for (const btn of this.modeSelect.querySelectorAll<HTMLElement>('button[data-mode]')) {
      btn.classList.toggle('on', (btn.dataset.mode === '1' ? 1 : 0) === this.mode);
    }
    // Just the mode. This line used to append the party code as well, back when
    // pressing the button below might send you to that room — which was the bug,
    // not a labelling problem. Quick match no longer reads the box at all, so
    // mentioning it here would be advertising something that cannot happen.
    this.playSub.textContent = this.mode === 1 ? 'Team Deathmatch' : 'Free For All';
  }

  private bindName(): void {
    this.nameInput.addEventListener('input', () => {
      this.settings.set('name', this.nameInput.value);
    });
    // Enter in the name box takes the default action, which is a quick match. It
    // is deliberately not "whatever the code box says": the two fields are far
    // apart on screen and a keystroke in one must not commit the other.
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.nameInput.blur();
        this.submit('quick');
      }
    });
  }

  /** The name to join with — falls back to the placeholder we already showed. */
  private resolvedName(): string {
    const typed = this.nameInput.value.trim();
    if (typed) return typed.slice(0, 16);
    const suggested = this.nameInput.placeholder;
    this.nameInput.value = suggested;
    this.settings.set('name', suggested);
    return suggested;
  }

  /* ── Party ────────────────────────────────────────────────────────────────
     A party is a named room, and the code is its name. Everyone who types the same
     characters lands in the same room — same map, same mode, same side in team
     deathmatch — because on the server that code *is* the room's identity.

     There are two buttons here rather than one, and the split is the point.
     `Create` invents a code and opens the room it names; `Join` sends the code in
     the box and refuses to do anything without one. Neither is reachable by
     accident, and quick match — the button above — never consults the box at all.
     Before that split, a blank box meant "public match" and a filled one meant
     "that room", so the difference between a public game and somebody's week-old
     private lobby was a field the player had probably forgotten they had filled in.

     A private room opens in its lobby instead of a live match, because the people
     in it arrive one at a time and somebody has to still be there when the last of
     them loads. That is also where bots are decided: a public room fills itself, a
     private one stays empty until the host says otherwise.

     Everything is normalised on the way in rather than validated on the way out, so
     there is no error state to design and no way to end up alone in a room called
     `Foxtrot ` because of a trailing space.
     ─────────────────────────────────────────────────────────────────────── */

  private bindParty(): void {
    this.roomInput.addEventListener('input', () => {
      const clean = sanitizePartyCode(this.roomInput.value);
      // Only write back when the cleaning actually changed something, or the
      // caret jumps to the end on every keystroke.
      if (clean !== this.roomInput.value) this.roomInput.value = clean;
      this.settings.set('room', clean);
      this.syncParty();
    });
    // Enter in the code box means the button beside it, not the big one above.
    this.roomInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.roomInput.blur();
        this.submit('join');
      }
    });
    this.roomNew.addEventListener('click', () => {
      // One click, not two: generating a code and then having to press play as
      // well is a step with nothing in it, and the lobby it opens is where the
      // code is displayed, copied and shared anyway.
      this.submit('create');
    });
  }

  /**
   * Keep the party controls honest about what they would do.
   *
   * Join is disabled with an empty box because an empty code sanitizes to `''`,
   * which the server reads as "any public room" — so a Join pressed with nothing
   * typed would quietly become a quick match, which is the same class of silent
   * substitution the whole intent split exists to remove. Better to refuse.
   */
  private syncParty(): void {
    const code = sanitizePartyCode(this.roomInput.value);
    const can = this.playEnabled && code !== '';
    this.playJoin.disabled = !can;
    this.playJoin.style.pointerEvents = can ? '' : 'none';
    this.partyNote.textContent = code
      ? `Join puts you in ${code} — same lobby and same map as everyone else with that code.`
      : 'Create a lobby to get a code you can share, or type a code to join theirs.';
  }

  /**
   * Honour a `?party=CODE` or `?room=CODE` link.
   *
   * Takes the player straight into the lobby staging room automatically.
   * The query is dropped from the address bar afterwards so a later
   * refresh does not quietly put somebody's party code back in front of them.
   */
  private prefillFromLink(): void {
    let code: string;
    try {
      const params = new URLSearchParams(location.search);
      code = sanitizePartyCode(params.get('party') ?? params.get('room') ?? '');
    } catch {
      return;
    }
    if (!code) return;
    this.roomInput.value = code;
    this.settings.set('room', code);
    this.autoJoinCode = code;
    try {
      history.replaceState(null, '', location.pathname);
    } catch {
      // A sandboxed frame can refuse this. The prefill still happened, which is
      // the part that matters.
    }
  }

  /**
   * Ask to be put in a match.
   *
   * The room comes from the intent and nothing else. `create` writes its new code
   * back into the box on the way past — not because anything downstream reads it,
   * but because the code is about to be shared out loud and the player should be
   * able to see it, and because a refresh then still has it for a Join.
   */
  private submit(intent: Intent): void {
    const room =
      intent === 'quick'
        ? ''
        : intent === 'create'
          ? randomPartyCode()
          : sanitizePartyCode(this.roomInput.value);

    // Belt and braces against the one path that could reintroduce the original
    // bug: Join with an empty box would send `''`, which is a public match. The
    // button is already disabled in that state; this makes it impossible rather
    // than merely unreachable, since a keyboard Enter arrives here too.
    if (intent === 'join' && !room) return;

    if (intent === 'create') {
      this.roomInput.value = room;
      this.settings.set('room', room);
      this.syncParty();
    }

    this.hooks.onPlay({
      name: this.resolvedName(),
      mode: this.mode,
      primary: this.primary,
      room,
    });
  }

  /* ── Buttons ──────────────────────────────────────────────────────────── */

  private bindButtons(): void {
    this.play.addEventListener('click', () => this.submit('quick'));
    this.playJoin.addEventListener('click', () => this.submit('join'));
    el('open-settings').addEventListener('click', () => this.openSettings());
    el('open-help').addEventListener('click', () => this.openModal(this.helpModal));

    el('pause-resume').addEventListener('click', () => {
      this.closePause();
      this.hooks.onResume();
    });
    el('pause-settings').addEventListener('click', () => this.openSettings());
    el('pause-quit').addEventListener('click', () => {
      this.closeAllModals();
      this.hooks.onQuit();
    });
  }

  /**
   * Disables every way into a match while connecting, with an explanation on the
   * quick-match button.
   *
   * All three, not just the one that was pressed: a connection is in flight and a
   * second `onPlay` would open a second socket to a different room, leaving the
   * first one's welcome to arrive into a session that has already moved on.
   */
  setPlayEnabled(on: boolean, subtext?: string): void {
    this.playEnabled = on;
    for (const btn of [this.play, this.roomNew]) {
      btn.disabled = !on;
      btn.style.opacity = on ? '' : '0.55';
      btn.style.pointerEvents = on ? '' : 'none';
    }
    if (subtext !== undefined) this.playSub.textContent = subtext;
    else this.syncMode();
    // Join's own gate is stricter, so it decides for itself in both directions.
    this.syncParty();
  }

  /** `null` when the count is unknown, which shows as offline. */
  setOnline(count: number | null): void {
    const label = this.online.querySelector('span');
    this.online.classList.toggle('up', count !== null);
    this.online.classList.toggle('down', count === null);
    if (label) {
      label.textContent =
        count === null
          ? 'Offline'
          : `${count} player${count === 1 ? '' : 's'} online`;
    }
  }

  private setBuild(): void {
    // No build system stamps a version in, so derive something honest and
    // stable from what is actually true at runtime.
    this.footBuild.textContent = `Build M1 · ${WEAPONS.length} weapons · original work, not affiliated with any other game`;
  }

  /* ── Modals ───────────────────────────────────────────────────────────── */

  private bindModals(): void {
    for (const modal of document.querySelectorAll<HTMLElement>('.modal')) {
      // Clicking the backdrop — but not the card — dismisses.
      modal.addEventListener('mousedown', (e) => {
        if (e.target === modal) this.closeModal(modal);
      });
      for (const closer of modal.querySelectorAll<HTMLElement>('[data-close]')) {
        closer.addEventListener('click', () => this.closeModal(modal));
      }
    }
  }

  private openModal(modal: HTMLElement): void {
    modal.classList.remove('hidden');
  }

  private closeModal(modal: HTMLElement): void {
    modal.classList.add('hidden');
    // Closing settings from the pause menu should return to the pause menu, not
    // drop the player straight back into a match they did not ask to resume.
    if (modal === this.settingsModal && this.pausePending) {
      this.pausePending = false;
      this.openModal(this.pauseModal);
    }
  }

  openSettings(): void {
    // Remember whether we came from the pause menu so we can go back to it.
    if (!this.pauseModal.classList.contains('hidden')) {
      this.pausePending = true;
      this.pauseModal.classList.add('hidden');
    }
    this.openModal(this.settingsModal);
    this.renderTab(this.tab);
  }

  openPause(): void {
    this.openModal(this.pauseModal);
  }

  closePause(): void {
    this.pauseModal.classList.add('hidden');
  }

  get pauseOpen(): boolean {
    return !this.pauseModal.classList.contains('hidden');
  }

  get anyModalOpen(): boolean {
    return (
      !this.settingsModal.classList.contains('hidden') ||
      !this.helpModal.classList.contains('hidden') ||
      !this.pauseModal.classList.contains('hidden')
    );
  }

  /** Escape handling. Returns true if it consumed the key. */
  closeTopModal(): boolean {
    // Innermost first: settings can be layered over pause.
    for (const m of [this.settingsModal, this.helpModal, this.pauseModal]) {
      if (!m.classList.contains('hidden')) {
        this.closeModal(m);
        return true;
      }
    }
    return false;
  }

  private closeAllModals(): void {
    this.pausePending = false;
    for (const m of [this.settingsModal, this.helpModal, this.pauseModal]) {
      m.classList.add('hidden');
    }
  }

  /* ── Settings panel ───────────────────────────────────────────────────── */

  private buildSettings(): void {
    for (const btn of this.settingsTabs.querySelectorAll<HTMLElement>('button[data-tab]')) {
      btn.addEventListener('click', () => this.renderTab(btn.dataset.tab as TabKey));
    }
    el('settings-reset').addEventListener('click', () => {
      this.settings.reset();
      this.renderTab(this.tab);
    });
  }

  private renderTab(tab: TabKey): void {
    this.tab = tab;
    for (const btn of this.settingsTabs.querySelectorAll<HTMLElement>('button[data-tab]')) {
      btn.classList.toggle('on', btn.dataset.tab === tab);
    }

    // Controls are rebuilt per tab rather than all at once and hidden. The
    // panel is small, and a rebuild guarantees every control reflects the
    // current value the moment it appears.
    this.settingsBody.replaceChildren();
    this.syncers.length = 0;
    for (const control of SETTINGS_SCHEMA[tab]) {
      this.settingsBody.appendChild(this.buildControl(control));
    }
    // Push current values into the freshly built controls.
    for (const fn of this.syncers) fn(this.settings.values);
  }

  private buildControl(c: Control): HTMLElement {
    if (c.kind === 'group') {
      const h = document.createElement('div');
      h.className = 'sgroup-title';
      h.textContent = c.label;
      return h;
    }

    const row = document.createElement('div');
    row.className = 'srow';

    const label = document.createElement('label');
    label.textContent = c.label;
    if (c.hint) {
      const small = document.createElement('small');
      small.textContent = c.hint;
      label.appendChild(small);
    }
    row.appendChild(label);

    switch (c.kind) {
      case 'slider': {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(c.min);
        input.max = String(c.max);
        input.step = String(c.step);
        const out = document.createElement('output');
        // `input` rather than `change`, so the readout tracks the drag live.
        input.addEventListener('input', () => {
          const v = Number(input.value);
          this.settings.set(c.key, v as never);
          out.textContent = c.format(v);
        });
        row.append(input, out);
        this.syncers.push((s) => {
          const v = s[c.key] as number;
          input.value = String(v);
          out.textContent = c.format(v);
        });
        break;
      }

      case 'toggle': {
        const sw = document.createElement('button');
        sw.type = 'button';
        sw.className = 'switch';
        sw.setAttribute('role', 'switch');
        sw.addEventListener('click', () => {
          const next = !(this.settings.values[c.key] as boolean);
          this.settings.set(c.key, next as never);
          sw.classList.toggle('on', next);
          sw.setAttribute('aria-checked', String(next));
        });
        row.appendChild(sw);
        this.syncers.push((s) => {
          const v = s[c.key] as boolean;
          sw.classList.toggle('on', v);
          sw.setAttribute('aria-checked', String(v));
        });
        break;
      }

      case 'select': {
        const sel = document.createElement('select');
        for (const o of c.options) {
          const opt = document.createElement('option');
          opt.value = String(o.value);
          opt.textContent = o.label;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
          this.settings.set(c.key, Number(sel.value) as never);
        });
        row.appendChild(sel);
        this.syncers.push((s) => {
          sel.value = String(s[c.key] as number);
        });
        break;
      }

      case 'swatch': {
        const wrap = document.createElement('div');
        wrap.className = 'swatches';
        const buttons: HTMLElement[] = [];
        c.colors.forEach((color, i) => {
          const b = document.createElement('button');
          b.type = 'button';
          b.className = 'swatch';
          b.style.background = color;
          b.setAttribute('aria-label', `Crosshair colour ${i + 1}`);
          b.addEventListener('click', () => this.settings.set(c.key, i as never));
          wrap.appendChild(b);
          buttons.push(b);
        });
        row.appendChild(wrap);
        this.syncers.push((s) => {
          const active = s[c.key] as number;
          buttons.forEach((b, i) => b.classList.toggle('on', i === active));
        });
        break;
      }
    }

    return row;
  }
}
