/**
 * Every tunable that the simulation depends on. Client and server both import this
 * file, so there is exactly one copy of each number in the codebase.
 */

// ── Timing ───────────────────────────────────────────────────────────────────
/** Physics ticks per second. Client prediction runs at this rate too. */
export const TICK_RATE = 60;
export const TICK_DT = 1 / TICK_RATE;
export const TICK_MS = 1000 / TICK_RATE;

/** Authoritative snapshots per second. */
export const SNAPSHOT_RATE = 20;
export const SNAPSHOT_MS = 1000 / SNAPSHOT_RATE;

/** How far in the past remote actors are rendered, to hide jitter. */
export const INTERP_DELAY_MS = 100;

/** Length of the server-side position history used for lag compensation. */
export const LAGCOMP_HISTORY_MS = 1000;
/** Hard cap on how far back a client may ask the server to rewind. */
export const LAGCOMP_MAX_REWIND_MS = 500;

/** Drop a client that sends nothing for this long. */
export const CLIENT_TIMEOUT_MS = 10_000;

// ── Player body ──────────────────────────────────────────────────────────────
export const PLAYER_RADIUS = 0.4;
export const PLAYER_HEIGHT = 1.8;
export const PLAYER_CROUCH_HEIGHT = 1.15;
/** Eye position measured up from the feet, standing. */
export const EYE_HEIGHT = 1.68;
export const EYE_HEIGHT_CROUCH = 1.05;
/** Edge of a cube-ish head hitbox at the crown. */
export const HEAD_BOX = 0.3;

export const MAX_HEALTH = 100;

// ── Movement ─────────────────────────────────────────────────────────────────
export const GRAVITY = 22.0;
export const JUMP_SPEED = 7.4;

export const SPEED_WALK = 6.2;
export const SPEED_SPRINT = 8.8;
export const SPEED_CROUCH = 3.0;

export const ACCEL_GROUND = 90.0;
export const ACCEL_AIR = 26.0;
export const FRICTION_GROUND = 11.0;
/** Below this speed friction stops scaling and just kills the remainder. */
export const FRICTION_STOP_SPEED = 1.6;

/** Stairs and crate lips up to this height are walked over, not jumped. */
export const STEP_HEIGHT = 0.35;
/** Thickness of the sliver probed below the feet to detect standing. */
export const GROUND_PROBE = 0.06;
/** Pushed out of surfaces by this much so we never resolve to exactly touching. */
export const SKIN = 0.0015;

/** Terminal fall speed, and the fall speed above which landing hurts. */
export const MAX_FALL_SPEED = 60;
export const FALL_DAMAGE_SPEED = 19;
export const FALL_DAMAGE_PER_SPEED = 4.2;

// ── Camera / view ────────────────────────────────────────────────────────────
export const FOV_DEFAULT = 80;
export const PITCH_LIMIT = Math.PI / 2 - 0.02;

// ── Combat ───────────────────────────────────────────────────────────────────
export const RESPAWN_DELAY_MS = 2200;
/** Grace period after spawning during which a player takes no damage. */
export const SPAWN_PROTECT_MS = 900;
/** Seconds without taking damage before health starts coming back. */
export const REGEN_DELAY = 5.0;
export const REGEN_PER_SEC = 14;

// ── Match ────────────────────────────────────────────────────────────────────
export const FFA_KILL_LIMIT = 30;
export const TDM_KILL_LIMIT = 75;
export const MATCH_TIME_MS = 10 * 60 * 1000;
export const MAX_PLAYERS = 12;
/** Bots are spawned to keep the lobby at this size. */
export const TARGET_LOBBY_SIZE = 8;

// ── Lobby ────────────────────────────────────────────────────────────────────
/**
 * How long between someone pressing Start and the match actually beginning.
 *
 * Long enough that nobody is caught looking at a menu when the round starts, and
 * short enough that it is not a punishment for being the first one ready. It is
 * also the window in which the host can change their mind, which is why the
 * countdown is cancellable rather than a point of no return.
 */
export const LOBBY_COUNTDOWN_MS = 5000;
/**
 * Humans needed before a full ready-up starts the match on its own.
 *
 * One player readying up alone must *not* trip the auto-start: a solo host is
 * the normal case for someone setting up a private room and waiting for friends,
 * and starting the moment they click Ready would make the lobby impossible to
 * wait in. They can still press Start whenever they want.
 */
export const LOBBY_AUTOSTART_MIN = 2;

// ── Teams ────────────────────────────────────────────────────────────────────
export const TEAM_NONE = 0;
export const TEAM_A = 1;
export const TEAM_B = 2;

// ── View model timing ────────────────────────────────────────────────────────
/**
 * Length of the knife swing animation, seconds.
 *
 * It lives here rather than in the client because it is a *contract with the
 * weapon table*, not a rendering detail: the swing has a wind-up, a cut and a
 * recovery, and a held melee that retriggers before the recovery finishes leaves
 * the blade snapping back to the wind-up from mid-arc. So this has to stay
 * inside the Blade's own cycle time — the same constraint the muzzle flash and
 * the percussive part of the gunshot are held to, and the test suite asserts it
 * for the same reason: raising the knife's rate of fire would break the
 * animation and nothing at runtime would say so.
 */
export const MELEE_SWING = 0.32;
