import type { Direction, Leg } from "../types.ts";
import { meta } from "../data/universe.ts";
import { fmtPx } from "./tape.ts";

/**
 * Parlays: each leg gets its own line and direction, picked from a card, and
 * the parlay is the combination — the way a sportsbook builds one game at a
 * time. The multiplier is the product of the legs, and a parlay only pays when
 * every leg lands.
 *
 * Settlement is untouched. `legState` still decides a leg on `{sym, dir, t}`;
 * a tier only changes how far `t` sits from the asset's base target. SAFE is a
 * fraction of the base move, DEGEN is several times it. That keeps the whole
 * tier system expressible in the leg shape the tape already settles.
 */

export type Tier = "SAFE" | "EVEN" | "SHARP" | "DEGEN";

export const TIER_ORDER: readonly Tier[] = ["SAFE", "EVEN", "SHARP", "DEGEN"];

export interface TierSpec {
  /** Payout multiplier for the leg. */
  mult: number;
  /** Implied hit rate, so the summary can multiply them out. */
  prob: number;
  /** Multiplies the asset's base target to get the leg's target. */
  scale: number;
  risk: string;
}

export const TIERS: Record<Tier, TierSpec> = {
  SAFE: { mult: 1.2, prob: 0.7, scale: 0.35, risk: "low risk" },
  EVEN: { mult: 1.9, prob: 0.5, scale: 1, risk: "even" },
  SHARP: { mult: 3.6, prob: 0.25, scale: 1.8, risk: "high risk" },
  DEGEN: { mult: 11, prob: 0.08, scale: 3.2, risk: "tail risk" },
};

/** Below this implied probability the card goes loud. */
export const LOUD_BELOW = 0.1;

export interface ParlayLeg extends Leg {
  tier: Tier;
  /** The asset's own target, before the tier scaled it. */
  baseT: number;
  mult: number;
  prob: number;
  /** Reference spot, for the condition string. */
  px: number;
  /** The price the leg must close beyond. */
  strike: number;
}

export function buildLeg(sym: string, dir: Direction, tier: Tier): ParlayLeg {
  const u = meta(sym);
  const spec = TIERS[tier];
  const t = +(u.t * spec.scale).toFixed(2);
  const strike = u.px * (1 + (dir === "over" ? t : -t) / 100);
  return {
    sym,
    dir,
    t,
    sector: u.sector,
    tier,
    baseT: u.t,
    mult: spec.mult,
    prob: spec.prob,
    px: u.px,
    strike,
  };
}

/** The product of the leg multipliers. Nothing else. */
export function parlayMultiplier(legs: readonly ParlayLeg[]): number {
  return legs.reduce((acc, l) => acc * l.mult, 1);
}

/** The product of the leg hit rates. */
export function impliedProbability(legs: readonly ParlayLeg[]): number {
  return legs.reduce((acc, l) => acc * l.prob, 1);
}

export interface ParlaySummary {
  mult: number;
  prob: number;
  potentialPoints: number;
  /** True when `prob` is below `LOUD_BELOW`. */
  loud: boolean;
}

export function summarize(legs: readonly ParlayLeg[], stakePoints: number): ParlaySummary {
  const mult = parlayMultiplier(legs);
  const prob = impliedProbability(legs);
  return { mult, prob, potentialPoints: Math.round(stakePoints * mult), loud: prob < LOUD_BELOW };
}

/** "BTC closes above 100,266 (+4.0%) by Fri expiry". */
export function conditionText(leg: ParlayLeg): string {
  const verb = leg.dir === "over" ? "closes above" : "closes below";
  const sign = leg.dir === "over" ? "+" : "−";
  return `${leg.sym} ${verb} ${fmtPx(leg.strike)} (${sign}${leg.t.toFixed(1)}%) by Fri expiry`;
}

// ---------- the cards ----------

export type Stance = "bull" | "bear";

/** One pick for one leg: a tier and a stance. */
export interface ParlayCard {
  id: string;
  tier: Tier;
  stance: Stance;
  label: string;
}

/** Four tiers, bullish and bearish each. Eight cards per leg. */
export const PARLAY_CARDS: readonly ParlayCard[] = TIER_ORDER.flatMap((tier) =>
  (["bull", "bear"] as const).map((stance) => ({
    id: `${tier.toLowerCase()}-${stance}`,
    tier,
    stance,
    label: `${tier} · ${stance === "bull" ? "BULLISH" : "BEARISH"}`,
  })),
);

export function cardById(id: string | null | undefined): ParlayCard | null {
  return id ? (PARLAY_CARDS.find((c) => c.id === id) ?? null) : null;
}

/** One leg from one pick. */
export function legForCard(sym: string, card: ParlayCard): ParlayLeg {
  return buildLeg(sym, card.stance === "bull" ? "over" : "under", card.tier);
}

/** The slip a pick per ticker produces. Every ticker must have one. */
export function legsForPicks(
  syms: readonly string[],
  picks: Readonly<Record<string, ParlayCard>>,
): readonly ParlayLeg[] {
  return syms.map((sym) => legForCard(sym, picks[sym]!));
}

/** "SAFE↑ EVEN↓ DEGEN↑" — the slip, one glyph per leg. */
export function slipLabel(legs: readonly ParlayLeg[]): string {
  return legs.map((l) => `${l.tier}${l.dir === "over" ? "↑" : "↓"}`).join(" ");
}
