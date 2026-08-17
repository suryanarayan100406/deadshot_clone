export * from './brand';
export * from './constants';
export * from './math';
export * from './collision';
export * from './movement';
export * from './weapons';
export * from './maps';
export * from './bitio';
export * from './protocol';
export * from './combat';

/** Game modes. */
export const MODE = {
  FFA: 0,
  TDM: 1,
} as const;

export const MODE_NAMES: Record<number, string> = {
  0: 'Free For All',
  1: 'Team Deathmatch',
};
