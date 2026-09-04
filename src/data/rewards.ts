/** Season progression fixtures. */

/**
 * The platform's cut of a copied transaction, paid to the trader being copied.
 * One literal, shared by the Result copy-trade panel and the ladder's copy
 * heat column so the two can never print different percentages.
 */
export const COPY_FEE = 0.035;

/** Divisions inside a tier, LOW → HIGH. `SHARK III` is the entry band. */
export const DIVISIONS = ["III", "II", "I"] as const;

export type Division = (typeof DIVISIONS)[number];

/**
 * Season tiers. The five names and their XP thresholds are pinned — every
 * fixture, test and copy line downstream keys off them.
 *
 * The copy-trade fields are additive (plan 4 §2): copy-trade unlocks at SHARK,
 * `copierBase` is the tier's baseline follower count before the per-player
 * seeded jitter in `copyEconomicsFor`, and `feeShare` is `COPY_FEE` for an
 * unlocked tier and 0 below it, so a locked tier's projection is 0 by
 * arithmetic rather than by a branch.
 */
export const TIERS = [
  { name: "MINNOW", xp: 0, copyUnlocked: false, copierBase: 0, feeShare: 0 },
  { name: "FISH", xp: 500, copyUnlocked: false, copierBase: 0, feeShare: 0 },
  { name: "SHARK", xp: 1500, copyUnlocked: true, copierBase: 40, feeShare: COPY_FEE },
  { name: "ORCA", xp: 3000, copyUnlocked: true, copierBase: 160, feeShare: COPY_FEE },
  { name: "WHALE", xp: 6000, copyUnlocked: true, copierBase: 520, feeShare: COPY_FEE },
] as const;

export type TierName = (typeof TIERS)[number]["name"];

/**
 * One season tier. Named `RankTier` (and re-exported as `RANK_TIERS` from
 * `engine/rank.ts`) because `engine/parlay.ts` already owns `Tier`/`TIERS` for
 * parlay cards — rank code never says plain `Tier`.
 */
export type RankTier = (typeof TIERS)[number];

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
  { id: "win", label: "Win a duel", xp: 200, done: true },
  { id: "crypto", label: "Spin a crypto leg", xp: 50, done: true },
  { id: "stocks", label: "Play a stocks lobby", xp: 80, done: false },
  { id: "degen", label: "Lock a DEGEN parlay", xp: 30, done: false },
] as const;

export const tierIndex = (name: string): number => TIERS.findIndex((t) => t.name === name);

type Tier = RankTier;

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
