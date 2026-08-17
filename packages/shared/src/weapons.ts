/**
 * Weapon data. Every number the combat system uses lives here — nothing is baked
 * into logic — so the whole game can be retuned from this one file.
 */

export type WeaponSlot = 'primary' | 'secondary' | 'melee';
export type FireMode = 'auto' | 'single' | 'burst' | 'bolt' | 'pump' | 'melee';

export interface WeaponDef {
  id: number;
  key: string;
  name: string;
  slot: WeaponSlot;
  fireMode: FireMode;

  /** Damage per bullet (per pellet for shotguns). */
  damage: number;
  /** Multiplier applied to a head hitbox hit. */
  headMult: number;
  pellets: number;
  rpm: number;

  /** Damage stays full to `falloffStart`, ramps down to `minMult` at `falloffEnd`. */
  falloffStart: number;
  falloffEnd: number;
  minMult: number;
  /** Bullets stop existing past this range. */
  range: number;

  magSize: number;
  reserveSize: number;
  reloadTime: number;
  /** Time to bring the weapon up after switching to it. */
  switchTime: number;

  /** Spread cone half-angle, radians. */
  spreadBase: number;
  spreadPerShot: number;
  spreadMax: number;
  /** Radians recovered per second once you stop firing. */
  spreadRecovery: number;
  /** Extra spread while airborne / while moving at full tilt. */
  spreadAir: number;
  spreadMove: number;

  /** Camera kick per shot, radians. */
  recoilV: number;
  recoilH: number;
  recoilRecovery: number;

  adsTime: number;
  /** FOV multiplier while aiming. Lower = more zoom. */
  adsFovMult: number;
  adsSpreadMult: number;
  /** Movement speed while hip-firing / while aiming. */
  moveMult: number;
  adsMoveMult: number;
  /** True for weapons that draw a scope overlay instead of a viewmodel. */
  scoped: boolean;

  burstCount: number;
  burstDelay: number;

  /** Procedural viewmodel proportions, metres. */
  viz: {
    bodyLen: number;
    bodyH: number;
    bodyW: number;
    barrelLen: number;
    barrelR: number;
    magLen: number;
    stock: boolean;
    color: number;
    accent: number;
  };
  /**
   * Procedural audio character.
   *
   * These are not mixer settings — they are a physical description of the shot,
   * and `client/audio.ts` builds a layered event out of them: a transient click,
   * a noise blast under a downward filter sweep, a low punch, the mechanical
   * action, and a room tail. Describing the gun rather than the mix is what lets
   * one synthesiser cover a 9 mm and a 12-gauge without special cases.
   */
  sfx: {
    /** Fundamental of the low punch, Hz. Bigger bore, lower number. */
    body: number;
    /** Where the blast's filter sweep *starts*, Hz — the shot's brightness. */
    crack: number;
    /** Length of the percussive part of the shot, seconds. */
    punch: number;
    /** Length of the room tail, seconds. Zero for none. */
    tail: number;
    /** Soft-clip drive, 0–1. This is the difference between a pop and a bang. */
    grit: number;
    /** Level of the bolt/slide clack, 0–1, and where it sits, Hz. */
    mech: number;
    mechFreq: number;
    /** Overall level, 0–1. */
    gain: number;
  };
}

function def(d: WeaponDef): WeaponDef {
  return d;
}

export const WEAPONS: readonly WeaponDef[] = [
  def({
    id: 0,
    key: 'ranger',
    name: 'Ranger',
    slot: 'primary',
    fireMode: 'auto',
    damage: 28,
    headMult: 1.7,
    pellets: 1,
    rpm: 640,
    falloffStart: 34,
    falloffEnd: 70,
    minMult: 0.62,
    range: 300,
    magSize: 30,
    reserveSize: 180,
    reloadTime: 2.1,
    switchTime: 0.42,
    spreadBase: 0.0022,
    spreadPerShot: 0.0042,
    spreadMax: 0.052,
    spreadRecovery: 0.075,
    spreadAir: 0.028,
    spreadMove: 0.012,
    recoilV: 0.0125,
    recoilH: 0.004,
    recoilRecovery: 9.0,
    adsTime: 0.2,
    adsFovMult: 0.72,
    adsSpreadMult: 0.28,
    moveMult: 1.0,
    adsMoveMult: 0.52,
    scoped: false,
    burstCount: 0,
    burstDelay: 0,
    viz: {
      bodyLen: 0.5,
      bodyH: 0.1,
      bodyW: 0.062,
      barrelLen: 0.3,
      barrelR: 0.019,
      magLen: 0.19,
      stock: true,
      color: 0x2c2f33,
      accent: 0x4a4f55,
    },
    // Sharp, mid-bodied, controlled — the reference against which the other
    // five are voiced. `punch` sits just inside the 94 ms cycle so the percussive
    // part of each shot finishes before the next one starts; the tail is allowed
    // to run longer than that only because overlapping tails duck each other,
    // which is what turns sustained fire into a rhythm instead of one long roar.
    sfx: {
      body: 165,
      crack: 5200,
      punch: 0.075,
      tail: 0.2,
      grit: 0.55,
      mech: 0.5,
      mechFreq: 3000,
      gain: 0.62,
    },
  }),
  def({
    id: 1,
    key: 'vector',
    name: 'Vector',
    slot: 'primary',
    fireMode: 'auto',
    damage: 18,
    headMult: 1.6,
    pellets: 1,
    rpm: 900,
    falloffStart: 18,
    falloffEnd: 42,
    minMult: 0.5,
    range: 200,
    magSize: 35,
    reserveSize: 210,
    reloadTime: 1.9,
    switchTime: 0.34,
    spreadBase: 0.0055,
    spreadPerShot: 0.0044,
    spreadMax: 0.07,
    spreadRecovery: 0.1,
    spreadAir: 0.03,
    spreadMove: 0.009,
    recoilV: 0.0082,
    recoilH: 0.0052,
    recoilRecovery: 11.0,
    adsTime: 0.15,
    adsFovMult: 0.82,
    adsSpreadMult: 0.34,
    moveMult: 1.06,
    adsMoveMult: 0.62,
    scoped: false,
    burstCount: 0,
    burstDelay: 0,
    viz: {
      bodyLen: 0.34,
      bodyH: 0.095,
      bodyW: 0.058,
      barrelLen: 0.14,
      barrelR: 0.016,
      magLen: 0.22,
      stock: false,
      color: 0x33363a,
      accent: 0x5a6068,
    },
    // Fifteen rounds a second. Everything is short on purpose: `punch` has to
    // clear the 66 ms cycle, and the tail is the shortest of any firearm here
    // because at that rate even a ducked one starts to smear into a drone. The
    // character has to live in the click, so `mech` is high and `body` low.
    sfx: {
      body: 210,
      crack: 6200,
      punch: 0.052,
      tail: 0.1,
      grit: 0.42,
      mech: 0.62,
      mechFreq: 3900,
      gain: 0.5,
    },
  }),
  def({
    id: 2,
    key: 'breacher',
    name: 'Breacher',
    slot: 'primary',
    fireMode: 'pump',
    damage: 14,
    headMult: 1.25,
    pellets: 9,
    rpm: 75,
    falloffStart: 9,
    falloffEnd: 24,
    minMult: 0.18,
    range: 60,
    magSize: 6,
    reserveSize: 36,
    reloadTime: 3.0,
    switchTime: 0.5,
    spreadBase: 0.036,
    spreadPerShot: 0.0,
    spreadMax: 0.036,
    spreadRecovery: 0.1,
    spreadAir: 0.014,
    spreadMove: 0.004,
    recoilV: 0.052,
    recoilH: 0.008,
    recoilRecovery: 6.0,
    adsTime: 0.26,
    adsFovMult: 0.9,
    adsSpreadMult: 0.66,
    moveMult: 0.97,
    adsMoveMult: 0.5,
    scoped: false,
    burstCount: 0,
    burstDelay: 0,
    viz: {
      bodyLen: 0.46,
      bodyH: 0.105,
      bodyW: 0.07,
      barrelLen: 0.42,
      barrelR: 0.026,
      magLen: 0.0,
      stock: true,
      color: 0x3a2a20,
      accent: 0x6b5140,
    },
    // A 12-gauge: the low punch does most of the work, the sweep starts dark so
    // it thumps rather than snaps, and the pump is loud enough to be a tell —
    // hearing a Breacher cycle behind you should be information.
    sfx: {
      body: 92,
      crack: 3800,
      punch: 0.145,
      tail: 0.44,
      grit: 0.82,
      mech: 0.78,
      mechFreq: 1900,
      gain: 0.95,
    },
  }),
  def({
    id: 3,
    key: 'longshot',
    name: 'Longshot',
    slot: 'primary',
    fireMode: 'bolt',
    damage: 100,
    headMult: 1.5,
    pellets: 1,
    rpm: 45,
    falloffStart: 200,
    falloffEnd: 300,
    minMult: 0.9,
    range: 400,
    magSize: 5,
    reserveSize: 30,
    reloadTime: 3.2,
    switchTime: 0.62,
    spreadBase: 0.03,
    spreadPerShot: 0.02,
    spreadMax: 0.09,
    spreadRecovery: 0.09,
    spreadAir: 0.05,
    spreadMove: 0.03,
    recoilV: 0.075,
    recoilH: 0.006,
    recoilRecovery: 5.0,
    adsTime: 0.34,
    adsFovMult: 0.25,
    adsSpreadMult: 0.0,
    moveMult: 0.9,
    adsMoveMult: 0.36,
    scoped: true,
    burstCount: 0,
    burstDelay: 0,
    viz: {
      bodyLen: 0.58,
      bodyH: 0.098,
      bodyW: 0.058,
      barrelLen: 0.56,
      barrelR: 0.017,
      magLen: 0.1,
      stock: true,
      color: 0x2a3128,
      accent: 0x4d5a48,
    },
    // The loudest thing on the map, and it should be: a hard supersonic crack
    // over a long tail. The brightest sweep of the six, so it cuts through a
    // firefight, with enough tail to say where it came from.
    sfx: {
      body: 76,
      crack: 7400,
      punch: 0.165,
      tail: 0.58,
      grit: 0.7,
      mech: 0.58,
      mechFreq: 2300,
      gain: 1.0,
    },
  }),
  def({
    id: 4,
    key: 'sidearm',
    name: 'Sidearm',
    slot: 'secondary',
    fireMode: 'single',
    damage: 26,
    headMult: 1.8,
    pellets: 1,
    rpm: 400,
    falloffStart: 16,
    falloffEnd: 40,
    minMult: 0.55,
    range: 150,
    magSize: 12,
    reserveSize: 84,
    reloadTime: 1.5,
    switchTime: 0.26,
    spreadBase: 0.0026,
    spreadPerShot: 0.0075,
    spreadMax: 0.055,
    spreadRecovery: 0.11,
    spreadAir: 0.022,
    spreadMove: 0.01,
    recoilV: 0.018,
    recoilH: 0.005,
    recoilRecovery: 12.0,
    adsTime: 0.16,
    adsFovMult: 0.85,
    adsSpreadMult: 0.3,
    moveMult: 1.1,
    adsMoveMult: 0.7,
    scoped: false,
    burstCount: 0,
    burstDelay: 0,
    viz: {
      bodyLen: 0.2,
      bodyH: 0.088,
      bodyW: 0.045,
      barrelLen: 0.07,
      barrelR: 0.014,
      magLen: 0.11,
      stock: false,
      color: 0x2b2e31,
      accent: 0x585e64,
    },
    // Dry and tight. Almost no tail — a pistol in the open is a flat crack, and
    // the prominent slide gives it the mechanical snap it lives on.
    sfx: {
      body: 190,
      crack: 5600,
      punch: 0.058,
      tail: 0.12,
      grit: 0.5,
      mech: 0.68,
      mechFreq: 3400,
      gain: 0.55,
    },
  }),
  def({
    id: 5,
    key: 'blade',
    name: 'Blade',
    slot: 'melee',
    fireMode: 'melee',
    damage: 55,
    headMult: 1.0,
    pellets: 1,
    rpm: 120,
    falloffStart: 3,
    falloffEnd: 3.2,
    minMult: 1,
    range: 3.0,
    magSize: 0,
    reserveSize: 0,
    reloadTime: 0,
    switchTime: 0.22,
    spreadBase: 0,
    spreadPerShot: 0,
    spreadMax: 0,
    spreadRecovery: 0,
    spreadAir: 0,
    spreadMove: 0,
    recoilV: 0.01,
    recoilH: 0.02,
    recoilRecovery: 10,
    adsTime: 0.1,
    adsFovMult: 1,
    adsSpreadMult: 1,
    moveMult: 1.18,
    adsMoveMult: 1.18,
    scoped: false,
    burstCount: 0,
    burstDelay: 0,
    viz: {
      bodyLen: 0.1,
      bodyH: 0.05,
      bodyW: 0.03,
      barrelLen: 0.26,
      barrelR: 0.012,
      magLen: 0,
      stock: false,
      color: 0x22262a,
      accent: 0xb8bec6,
    },
    // Not a gunshot at all — the synthesiser takes the melee branch and reads
    // these as a swing: `crack` becomes the whoosh centre and `mech` the ring of
    // the blade. `tail` is zero because a knife has no report to echo.
    sfx: {
      body: 520,
      crack: 2600,
      punch: 0.13,
      tail: 0,
      grit: 0.12,
      mech: 0.34,
      mechFreq: 5200,
      gain: 0.42,
    },
  }),
];

export const WEAPON_BY_KEY: Record<string, WeaponDef> = Object.fromEntries(
  WEAPONS.map((w) => [w.key, w]),
);

export function weaponById(id: number): WeaponDef {
  return WEAPONS[id] ?? WEAPONS[0]!;
}

/** Seconds between shots. */
export function cycleTime(w: WeaponDef): number {
  return 60 / w.rpm;
}

/** Damage after range falloff, before the headshot multiplier. */
export function damageAtRange(w: WeaponDef, dist: number): number {
  if (dist <= w.falloffStart) return w.damage;
  if (dist >= w.falloffEnd) return w.damage * w.minMult;
  const t = (dist - w.falloffStart) / (w.falloffEnd - w.falloffStart);
  return w.damage * (1 + (w.minMult - 1) * t);
}

/** Backstab: a melee hit from behind the victim is lethal. */
export const MELEE_BACKSTAB_DAMAGE = 100;
/** Dot product below which a melee hit counts as a backstab. */
export const MELEE_BACKSTAB_DOT = -0.35;

/**
 * Magazines of reserve ammunition returned for a kill.
 *
 * Without this the reserve is a one-way countdown: it only ever refills on
 * death, so a player who is doing *well* is the one who runs dry and ends up
 * holding a knife. That punishes exactly the behaviour the mode is scored on.
 * Paying the resupply out of kills instead means an aggressive player is never
 * starved, while someone spraying at walls still has to manage what they have.
 *
 * Kept fractional so it tops up rather than fully reloads — two kills buys three
 * Ranger magazines, one kill buys one and a half shotgun tubes.
 */
export const AMMO_REFILL_MAGS_PER_KILL = 1.5;

/** Loadout: one primary plus the fixed secondary and melee. */
export const DEFAULT_LOADOUT = ['ranger', 'sidearm', 'blade'] as const;
