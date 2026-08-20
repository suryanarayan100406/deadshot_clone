/**
 * Persisted client settings.
 *
 * Everything the player can tune lives in one flat object so it round-trips
 * through `localStorage` as a single JSON blob. Loading is tolerant: an unknown
 * key is dropped, a missing key falls back to the default, and a value of the
 * wrong type or out of range is clamped rather than rejected. That way a stored
 * blob from an older build never bricks the game.
 *
 * Nothing here affects the simulation — the server owns that. These are input
 * feel, presentation and audio only.
 */

export interface Settings {
  /** Horizontal look sensitivity, radians of yaw per pixel at the base scale. */
  sensitivity: number;
  /** Multiplier applied to sensitivity while aiming down sights. */
  adsSensitivity: number;
  /** Invert vertical look. */
  invertY: boolean;
  /** Base vertical FOV in degrees. */
  fov: number;
  /** Hold right-mouse to aim (false) versus toggle on click (true). */
  toggleAds: boolean;
  /** Hold shift to sprint (false) versus toggle (true). */
  toggleSprint: boolean;
  /** Fire the moment the magazine refills instead of waiting for a new click. */
  autoReload: boolean;
  /** Auto-aim / aim assist magnetism on targets. */
  aimAssist: boolean;
  /** Strength of the auto-aim assist (0.2 to 2.0). */
  aimAssistStrength: number;

  /** Renderer scale: 1 = native, 0.75 = quarter fewer pixels, etc. */
  resolution: number;
  /** 0 = off, 1 = low, 2 = high. Drives shadow map size and cascade count. */
  shadows: number;
  /** Draw the view model (arms + gun). */
  viewmodel: boolean;
  /** Camera shake on firing and taking damage. */
  screenShake: number;
  /** Bob the camera while running. */
  viewBob: boolean;
  /** Muzzle flashes, impact sparks, blood puffs, tracers. */
  particles: boolean;
  /** Cap the render loop; 0 = uncapped (vsync only). */
  fpsCap: number;
  /** Show the fps / ping readout. */
  showStats: boolean;

  master: number;
  sfx: number;
  hitSound: boolean;

  crosshairStyle: number;
  crosshairSize: number;
  crosshairGap: number;
  crosshairThickness: number;
  crosshairDot: boolean;
  crosshairColor: number;
  crosshairDynamic: boolean;

  /** Remembered between sessions so the menu comes back the way you left it. */
  name: string;
  mode: number;
  primary: string;
  /**
   * Party code. Empty means "put me in any lobby with room"; anything else is a
   * private room that everyone typing the same code lands in, on the same team.
   *
   * Persisted for the same reason the name is: a party that agrees on a code
   * should not have to re-type it every time somebody reloads the page, and after
   * a disconnect the fastest possible path back to your friends is the play
   * button already pointing at them.
   */
  room: string;
}

export const CROSSHAIR_COLORS = [
  '#ffffff',
  '#00ff6a',
  '#00e5ff',
  '#f2c14e',
  '#e0524a',
  '#ff4fd8',
] as const;

export const DEFAULTS: Settings = {
  sensitivity: 0.0022,
  adsSensitivity: 0.75,
  invertY: false,
  fov: 80,
  toggleAds: false,
  toggleSprint: false,
  autoReload: true,
  aimAssist: true,
  aimAssistStrength: 1.0,

  resolution: 1,
  shadows: 1,
  viewmodel: true,
  screenShake: 1,
  viewBob: true,
  particles: true,
  fpsCap: 0,
  showStats: true,

  master: 0.7,
  sfx: 0.9,
  hitSound: true,

  crosshairStyle: 0,
  crosshairSize: 7,
  crosshairGap: 6,
  crosshairThickness: 2,
  crosshairDot: false,
  crosshairColor: 0,
  crosshairDynamic: true,

  name: '',
  mode: 0,
  primary: 'ranger',
  room: '',
};

/** Inclusive numeric bounds, used both to clamp on load and to build sliders. */
const RANGES: Partial<Record<keyof Settings, [number, number]>> = {
  sensitivity: [0.0002, 0.012],
  adsSensitivity: [0.2, 1.5],
  aimAssistStrength: [0.2, 2.0],
  fov: [60, 110],
  resolution: [0.5, 1],
  shadows: [0, 2],
  screenShake: [0, 2],
  fpsCap: [0, 360],
  master: [0, 1],
  sfx: [0, 1],
  crosshairStyle: [0, 2],
  crosshairSize: [0, 16],
  crosshairGap: [0, 20],
  crosshairThickness: [1, 5],
  crosshairColor: [0, CROSSHAIR_COLORS.length - 1],
  mode: [0, 1],
};

const STORAGE_KEY = 'oneshot.settings.v1';

export class SettingsStore {
  readonly values: Settings;
  private listeners: Array<(s: Settings) => void> = [];
  private saveTimer = 0;

  constructor() {
    this.values = { ...DEFAULTS };
    this.load();
  }

  /** Subscribe to any change. Called once per commit, not once per keystroke. */
  onChange(fn: (s: Settings) => void): void {
    this.listeners.push(fn);
  }

  get<K extends keyof Settings>(key: K): Settings[K] {
    return this.values[key];
  }

  set<K extends keyof Settings>(key: K, value: Settings[K]): void {
    const clamped = coerce(key, value);
    if (this.values[key] === clamped) return;
    this.values[key] = clamped;
    this.emit();
  }

  reset(): void {
    // Keep identity — name, last-used loadout and party code are not really
    // "settings". Resetting your sensitivity should not eject you from a lobby
    // your friends are already in.
    const { name, mode, primary, room } = this.values;
    Object.assign(this.values, DEFAULTS, { name, mode, primary, room });
    this.emit();
  }

  private emit(): void {
    for (const fn of this.listeners) fn(this.values);
    // Debounce: dragging a slider fires dozens of changes a second and
    // localStorage writes are synchronous.
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 240) as unknown as number;
  }

  private load(): void {
    let raw: string | null = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      return; // Private browsing or blocked storage: run on defaults.
    }
    if (!raw) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!parsed || typeof parsed !== 'object') return;
    const src = parsed as Record<string, unknown>;
    for (const key of Object.keys(DEFAULTS) as Array<keyof Settings>) {
      if (key in src) this.restore(key, src[key]);
    }
  }

  /**
   * Restores one stored value. Split out purely so the key is a single type
   * parameter rather than the whole union — writing through a union-typed index
   * has no type TypeScript will accept, because the target would have to satisfy
   * every value type at once.
   */
  private restore<K extends keyof Settings>(key: K, incoming: unknown): void {
    // A stored value of the wrong shape is discarded rather than coerced: this
    // is data from a possibly older build, and a silent default beats a
    // half-converted setting.
    if (typeof incoming !== typeof DEFAULTS[key]) return;
    this.values[key] = coerce(key, incoming as Settings[K]);
  }

  private save(): void {
    this.saveTimer = 0;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.values));
    } catch {
      /* Storage full or unavailable — the game plays fine without persistence. */
    }
  }
}

function coerce<K extends keyof Settings>(key: K, value: Settings[K]): Settings[K] {
  if (typeof value === 'number') {
    // Widened to plain `number` on purpose: narrowing `value` gives the type
    // `Settings[K] & number`, which nothing computed can be assigned back to
    // while `K` is still generic.
    let n: number = value;
    if (!Number.isFinite(n)) n = DEFAULTS[key] as unknown as number;
    const range = RANGES[key];
    if (range) n = Math.min(range[1], Math.max(range[0], n));
    return n as Settings[K];
  }
  if (typeof value === 'string') {
    return value.slice(0, 32) as Settings[K];
  }
  return value;
}

/** Resolved crosshair colour for the current setting. */
export function crosshairColor(s: Settings): string {
  return CROSSHAIR_COLORS[s.crosshairColor] ?? CROSSHAIR_COLORS[0];
}

/* ── Declarative schema for the settings UI ─────────────────────────────── */

export type Control =
  | { kind: 'slider'; key: keyof Settings; label: string; hint?: string; min: number; max: number; step: number; format: (v: number) => string }
  | { kind: 'toggle'; key: keyof Settings; label: string; hint?: string }
  | { kind: 'select'; key: keyof Settings; label: string; hint?: string; options: Array<{ label: string; value: number }> }
  | { kind: 'swatch'; key: keyof Settings; label: string; hint?: string; colors: readonly string[] }
  | { kind: 'group'; label: string };

export type TabKey = 'game' | 'video' | 'audio' | 'crosshair';

const pct = (v: number) => `${Math.round(v * 100)}%`;

export const SETTINGS_SCHEMA: Record<TabKey, Control[]> = {
  game: [
    {
      kind: 'slider',
      key: 'sensitivity',
      label: 'Mouse sensitivity',
      hint: 'Radians of turn per pixel of movement',
      min: 0.0002,
      max: 0.012,
      step: 0.0001,
      // Scaled to a friendly 0–100 dial rather than exposing radians.
      format: (v) => (v * 10000).toFixed(1),
    },
    {
      kind: 'slider',
      key: 'adsSensitivity',
      label: 'Aim sensitivity',
      hint: 'Multiplier applied while aiming down sights',
      min: 0.2,
      max: 1.5,
      step: 0.05,
      format: (v) => `${v.toFixed(2)}×`,
    },
    { kind: 'toggle', key: 'invertY', label: 'Invert vertical look' },
    { kind: 'group', label: 'Controls' },
    { kind: 'toggle', key: 'toggleAds', label: 'Toggle aim', hint: 'Click to aim instead of holding' },
    { kind: 'toggle', key: 'toggleSprint', label: 'Toggle sprint' },
    { kind: 'toggle', key: 'autoReload', label: 'Auto reload', hint: 'Reload automatically when the magazine runs dry' },
    { kind: 'group', label: 'Targeting & Auto-Aim' },
    { kind: 'toggle', key: 'aimAssist', label: 'Auto-aim assist', hint: 'Magnetically tracks targets near crosshair when aiming & scoping' },
    {
      kind: 'slider',
      key: 'aimAssistStrength',
      label: 'Auto-aim strength',
      hint: 'Magnetism strength when tracking targets',
      min: 0.2,
      max: 2.0,
      step: 0.1,
      format: (v) => `${(v * 100).toFixed(0)}%`,
    },
  ],
  video: [
    {
      kind: 'slider',
      key: 'fov',
      label: 'Field of view',
      min: 60,
      max: 110,
      step: 1,
      format: (v) => `${v | 0}°`,
    },
    {
      kind: 'slider',
      key: 'resolution',
      label: 'Render scale',
      hint: 'Lower to gain frames on a weak GPU',
      min: 0.5,
      max: 1,
      step: 0.05,
      format: pct,
    },
    {
      kind: 'select',
      key: 'shadows',
      label: 'Shadows',
      options: [
        { label: 'Off', value: 0 },
        { label: 'Low', value: 1 },
        { label: 'High', value: 2 },
      ],
    },
    {
      kind: 'select',
      key: 'fpsCap',
      label: 'Frame cap',
      options: [
        { label: 'Unlimited', value: 0 },
        { label: '60', value: 60 },
        { label: '120', value: 120 },
        { label: '144', value: 144 },
        { label: '240', value: 240 },
      ],
    },
    { kind: 'group', label: 'Presentation' },
    { kind: 'toggle', key: 'viewmodel', label: 'Show weapon' },
    { kind: 'toggle', key: 'viewBob', label: 'View bob' },
    { kind: 'toggle', key: 'particles', label: 'Particles' },
    {
      kind: 'slider',
      key: 'screenShake',
      label: 'Screen shake',
      min: 0,
      max: 2,
      step: 0.1,
      format: (v) => `${v.toFixed(1)}×`,
    },
    { kind: 'toggle', key: 'showStats', label: 'Show FPS and ping' },
  ],
  audio: [
    { kind: 'slider', key: 'master', label: 'Master volume', min: 0, max: 1, step: 0.05, format: pct },
    { kind: 'slider', key: 'sfx', label: 'Effects volume', min: 0, max: 1, step: 0.05, format: pct },
    { kind: 'toggle', key: 'hitSound', label: 'Hit marker sound' },
  ],
  crosshair: [
    {
      kind: 'select',
      key: 'crosshairStyle',
      label: 'Style',
      options: [
        { label: 'Cross', value: 0 },
        { label: 'Dot only', value: 1 },
        { label: 'Cross + dot', value: 2 },
      ],
    },
    { kind: 'swatch', key: 'crosshairColor', label: 'Colour', colors: CROSSHAIR_COLORS },
    { kind: 'slider', key: 'crosshairSize', label: 'Length', min: 0, max: 16, step: 1, format: (v) => `${v | 0}` },
    { kind: 'slider', key: 'crosshairGap', label: 'Gap', min: 0, max: 20, step: 1, format: (v) => `${v | 0}` },
    { kind: 'slider', key: 'crosshairThickness', label: 'Thickness', min: 1, max: 5, step: 1, format: (v) => `${v | 0}` },
    { kind: 'toggle', key: 'crosshairDynamic', label: 'Expand with spread', hint: 'Grow the gap as your accuracy drops' },
  ],
};
