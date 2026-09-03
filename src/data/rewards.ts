/** Season progression fixtures for the case library. */

export const TIERS = [
  { name: "MINNOW", xp: 0 },
  { name: "FISH", xp: 500 },
  { name: "SHARK", xp: 1500 },
  { name: "ORCA", xp: 3000 },
  { name: "WHALE", xp: 6000 },
] as const;

export type TierName = (typeof TIERS)[number]["name"];

export const SEASON = { label: "SEASON 01", endsIn: "12D 06H" } as const;

export const PLAYER = {
  rank: 7,
  tier: "SHARK" as TierName,
  xp: 2340,
  hitRate: 0.58,
  streak: 4,
  streakMult: 1.4,
  casesOpened: 31,
} as const;

export const MISSIONS = [
  { id: "settle", label: "Settle a case", xp: 200, done: true },
  { id: "crypto", label: "Spin a crypto leg", xp: 50, done: true },
  { id: "lowvar", label: "Open a LOW VAR case", xp: 80, done: false },
  { id: "degen", label: "Lock a DEGEN leg", xp: 30, done: false },
] as const;

export const tierIndex = (name: string): number => TIERS.findIndex((t) => t.name === name);

type Tier = (typeof TIERS)[number];

/** The tier a player is in for a given XP total. */
export function tierFor(xp: number): Tier {
  let cur: Tier = TIERS[0];
  for (const t of TIERS) if (xp >= t.xp) cur = t;
  return cur;
}

/** The next tier above `xp`, or null at the top. */
export function nextTier(xp: number): Tier | null {
  return TIERS.find((t) => t.xp > xp) ?? null;
}

/** Name of the tier gating a case, or null when the player can open it. */
export function lockedBy(required: string | undefined, playerTier: string): string | null {
  if (!required) return null;
  return tierIndex(required) > tierIndex(playerTier) ? required : null;
}
