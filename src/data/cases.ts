import type { CaseDef } from "../types.ts";
import { C } from "../theme.ts";

/**
 * The reward cases.
 *
 * Each case names its own book in `eligibleAssets`. The reel is drawn from that
 * list and nothing else, which is what keeps a LOW VAR case from dealing PEPE
 * and a HEDGE case from dealing a meme coin. A list must be at least
 * `legCount` long, because the same ticker never fills two slots.
 */

/** Every name on the board. Only the whale case draws from all of it. */
const FULL_BOOK = [
  "NVDA", "AAPL", "TSLA", "XOM", "JPM", "AMD", "META", "GLD", "COIN",
  "BTC", "ETH", "SOL", "ARB", "LINK", "UNI", "AAVE", "DOGE", "PEPE",
];

/** The four cards on the lobby; also the head of the library. */
export const FEATURED_CASES: readonly CaseDef[] = [
  {
    id: "eth-vol-box",
    name: "ETH Vol Box",
    tag: "STRUCTURED",
    tc: C.accent,
    legCount: 4,
    blurb: "Long call spread against a short put spread. Wins on drift, dies on chop.",
    cost: "0.41 Ξ",
    max: "1.86 Ξ",
    w: ["#1c2a12", "rgba(200,255,0,.22)", 145],
    eligibleAssets: ["ETH", "BTC", "SOL", "ARB", "LINK", "UNI"],
  },
  {
    id: "btc-ranger",
    name: "BTC Ranger",
    tag: "BASE ONLY",
    tc: C.amber,
    legCount: 2,
    blurb: "Pays if BTC stays inside the band until expiry. Reverts on breakout.",
    cost: "0.28 Ξ",
    max: "1.12 Ξ",
    w: ["#2a1f0d", "rgba(245,158,11,.22)", 120],
    eligibleAssets: ["BTC", "ETH", "SOL", "LINK"],
  },
  {
    id: "skew-hunter",
    name: "Skew Hunter",
    tag: "HIGH VAR",
    tc: C.violet,
    legCount: 6,
    blurb: "Buys the wings where MM skew is fattest. Rare, large outcomes.",
    cost: "0.64 Ξ",
    max: "5.40 Ξ",
    w: ["#221436", "rgba(167,139,250,.24)", 165],
    tier: "SHARK",
    eligibleAssets: ["SOL", "ARB", "LINK", "UNI", "AAVE", "DOGE", "PEPE", "COIN", "TSLA"],
  },
  {
    id: "weekly-grind",
    name: "Weekly Grind",
    tag: "LOW VAR",
    tc: C.blue,
    legCount: 3,
    blurb: "Short-dated theta collection. Small, frequent, boring wins.",
    cost: "0.12 Ξ",
    max: "0.31 Ξ",
    w: ["#0c2230", "rgba(56,189,248,.2)", 130],
    // The quiet end of the board only. No meme coins, no single-name beta.
    eligibleAssets: ["AAPL", "XOM", "JPM", "GLD", "META", "BTC"],
  },
];

export const CASE_LIBRARY: readonly CaseDef[] = [
  ...FEATURED_CASES,
  {
    id: "gamma-sprint",
    name: "Gamma Sprint",
    tag: "STRUCTURED",
    tc: C.accent,
    legCount: 4,
    blurb: "Straddle bought two days before expiry. Pure realized-vol bet.",
    cost: "0.33 Ξ",
    max: "2.40 Ξ",
    w: ["#1c2a12", "rgba(200,255,0,.18)", 200],
    eligibleAssets: ["NVDA", "AMD", "TSLA", "COIN", "ETH", "SOL"],
  },
  {
    id: "downside-vault",
    name: "Downside Vault",
    tag: "HEDGE",
    tc: C.red,
    legCount: 2,
    blurb: "Put ladder financed by a covered call. Insurance with a coupon.",
    cost: "0.19 Ξ",
    max: "0.88 Ξ",
    w: ["#2e1215", "rgba(248,113,113,.2)", 110],
    eligibleAssets: ["AAPL", "JPM", "XOM", "GLD", "META", "NVDA"],
  },
  {
    id: "dual-asset",
    name: "Dual Asset",
    tag: "MIXED",
    tc: C.muted,
    legCount: 5,
    blurb: "ETH calls against BTC puts. Trades the correlation, not direction.",
    cost: "0.52 Ξ",
    max: "3.10 Ξ",
    w: ["#1a1a1f", "rgba(161,161,170,.16)", 155],
    eligibleAssets: ["ETH", "BTC", "NVDA", "AAPL", "GLD", "SOL", "TSLA"],
  },
  {
    id: "whale-box",
    name: "Whale Box",
    tag: "WHALE",
    tc: C.accent,
    legCount: 8,
    blurb: "10 ETH entry. The whole book on the reel, eight legs, one payoff.",
    cost: "10.0 Ξ",
    max: "46.0 Ξ",
    w: ["#252a10", "rgba(200,255,0,.3)", 175],
    tier: "ORCA",
    eligibleAssets: FULL_BOOK,
  },
];

const BY_ID = new Map(CASE_LIBRARY.map((c) => [c.id, c]));

export function caseById(id: string | null | undefined): CaseDef | null {
  return id ? (BY_ID.get(id) ?? null) : null;
}

/** "0.41 Ξ" → 0.41. Cost and max are display strings on the case. */
export const eth = (s: string): number => parseFloat(s);

/** Max payout over open cost — the case's own multiplier, shown as ODDS. */
export const caseOdds = (c: CaseDef): number => eth(c.max) / eth(c.cost);

/**
 * What a run stakes, in points. Points are the demo's unit of account, so the
 * ETH open cost maps onto them at a fixed 1 Ξ = 1,000 pts. This is the number
 * the parlay multiplier applies to.
 */
export const stakePointsFor = (c: CaseDef): number => Math.round(eth(c.cost) * 1000);
