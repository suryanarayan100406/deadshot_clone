/**
 * Branding. Change these four values and the whole game re-brands.
 * Deliberately NOT the original game's name or wordmark — see docs/RESEARCH.md §9.
 */
export const BRAND = {
  /** Shown as the bold part of the wordmark. */
  nameFirst: 'ONE',
  /** Shown as the second half of the wordmark; the O carries the scope reticle. */
  nameSecond: 'SHOT',
  suffix: '.io',
  tagline: 'Multiplayer Online FPS',
  discord: '#',
} as const;

export const FULL_NAME = `${BRAND.nameFirst}${BRAND.nameSecond}${BRAND.suffix}`;
