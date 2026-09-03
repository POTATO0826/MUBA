import type { CaseDef, Direction, Leg, LegOutcome } from "../types.ts";
import { caseOdds } from "../data/cases.ts";
import { meta } from "../data/universe.ts";
import { legState } from "./match.ts";
import { fmtPx } from "./tape.ts";

/**
 * Parlays: a condition per leg, a multiplier that is the product of the legs,
 * and a payout only when every leg hits.
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
  /** Implied hit rate, so the summary bar can multiply them out. */
  prob: number;
  /** Multiplies the asset's base target to get the leg's target. */
  scale: number;
  blurb: string;
}

export const TIERS: Record<Tier, TierSpec> = {
  SAFE: { mult: 1.2, prob: 0.7, scale: 0.35, blurb: "wide band" },
  EVEN: { mult: 1.9, prob: 0.5, scale: 1, blurb: "base target" },
  SHARP: { mult: 3.6, prob: 0.25, scale: 1.8, blurb: "tight, directional" },
  DEGEN: { mult: 11, prob: 0.08, scale: 3.2, blurb: "tail" },
};

/**
 * Partial credit: when N-1 of N legs hit, the stake comes back instead of going
 * to zero. Off by default — the point of a parlay is that every leg must hit.
 */
export const PARTIAL_CREDIT = false;

/** Below this implied probability the summary goes loud. */
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
  /** Product of the leg multipliers. */
  parlayMult: number;
  /** The case's own odds — max payout over open cost. */
  floor: number;
  /** What actually pays: the parlay, but never below the case. */
  effectiveMult: number;
  /** Never above the case's own implied probability. */
  prob: number;
  potentialPoints: number;
  /** True when the parlay is sitting on the case floor. */
  floored: boolean;
  /** True when `prob` is below `LOUD_BELOW`. */
  loud: boolean;
}

/**
 * The summary bar's numbers.
 *
 * The case's ODDS is a floor: a parlay can only raise the multiplier and lower
 * the probability from the base case. Below the floor the case pays its own
 * odds regardless of how the legs are tiered.
 */
export function summarize(
  legs: readonly ParlayLeg[],
  c: CaseDef,
  stakePoints: number,
): ParlaySummary {
  const parlayMult = parlayMultiplier(legs);
  const floor = caseOdds(c);
  const effectiveMult = Math.max(floor, parlayMult);
  const prob = Math.min(1 / floor, impliedProbability(legs));
  return {
    parlayMult,
    floor,
    effectiveMult,
    prob,
    potentialPoints: Math.round(stakePoints * effectiveMult),
    floored: parlayMult < floor,
    loud: prob < LOUD_BELOW,
  };
}

/** "BTC closes above 100,266 (+4.0%) by Fri expiry". */
export function conditionText(leg: ParlayLeg): string {
  const verb = leg.dir === "over" ? "closes above" : "closes below";
  const sign = leg.dir === "over" ? "+" : "−";
  return `${leg.sym} ${verb} ${fmtPx(leg.strike)} (${sign}${leg.t.toFixed(1)}%) by Fri expiry`;
}

export interface CaseVerdict {
  outcomes: readonly LegOutcome[];
  hits: number;
  allHit: boolean;
  /** Partial credit fired: N-1 legs hit and the stake came back. */
  refunded: boolean;
  points: number;
  /** Total absolute move across the legs that landed. */
  edge: number;
  read: string;
  lesson: string;
}

/** Settle a case run at print `pos`. */
export function settleCase(
  legs: readonly ParlayLeg[],
  salt: number,
  pos: number,
  stakePoints: number,
  effectiveMult: number,
  partialCredit: boolean = PARTIAL_CREDIT,
): CaseVerdict {
  const outcomes = legs.map((l) => legState(l, salt, pos));
  const hits = outcomes.filter((o) => o.won).length;
  const allHit = legs.length > 0 && hits === legs.length;
  const refunded = !allHit && partialCredit && hits === legs.length - 1;
  const points = allHit ? Math.round(stakePoints * effectiveMult) : refunded ? stakePoints : 0;
  const edge = outcomes.reduce((a, o) => a + (o.won ? Math.abs(o.pct) : 0), 0);

  return {
    outcomes,
    hits,
    allHit,
    refunded,
    points,
    edge,
    read: readCase(legs, outcomes, allHit),
    lesson: lessonFor(legs, outcomes, allHit),
  };
}

/** Rule-based commentary over the position — no model call. */
function readCase(
  legs: readonly ParlayLeg[],
  outcomes: readonly LegOutcome[],
  allHit: boolean,
): string {
  if (!legs.length) return "";
  const settled = legs.map((l, i) => ({ ...l, st: outcomes[i]! }));
  const overs = legs.filter((l) => l.dir === "over").length;
  const unders = legs.length - overs;
  const degen = legs.filter((l) => l.tier === "DEGEN").length;
  const shape =
    overs === legs.length ? "all-in bull" : unders === legs.length ? "all-in bear" : "hedged";

  const biggest = [...settled].sort((a, b) => Math.abs(b.st.pct) - Math.abs(a.st.pct))[0]!;
  const nearMiss = [...settled]
    .filter((l) => !l.st.won)
    .sort((a, b) => Math.abs(Math.abs(a.st.pct) - a.t) - Math.abs(Math.abs(b.st.pct) - b.t))[0];

  let read =
    `A ${shape} position: ${overs} over, ${unders} under` +
    (degen ? `, ${degen} on the tail` : "") +
    `. ${biggest.sym} was the biggest mover at ${biggest.st.pct >= 0 ? "+" : ""}` +
    `${biggest.st.pct.toFixed(1)}%` +
    (biggest.st.won ? ", and it paid. " : ", but it went the wrong way. ");

  if (allHit) {
    read += `Every leg closed beyond its line. The case paid in full.`;
  } else if (nearMiss) {
    read +=
      `${nearMiss.sym} missed its ${nearMiss.tier} line by ` +
      `${Math.abs(Math.abs(nearMiss.st.pct) - nearMiss.t).toFixed(1)} points — ` +
      `one leg short is the whole parlay short.`;
  }
  return read;
}

function lessonFor(
  legs: readonly ParlayLeg[],
  outcomes: readonly LegOutcome[],
  allHit: boolean,
): string {
  if (allHit) {
    return "It paid — now check whether it paid because the read was right or because the tape was kind. A hedged position that pays on a one-way tape got lucky.";
  }
  const missedDegen = legs.some((l, i) => l.tier === "DEGEN" && !outcomes[i]!.won);
  if (missedDegen) {
    return "A DEGEN leg is an 8% line. It belongs on a case whose base odds already cover the stake, not on one that needs every leg to make the floor.";
  }
  const oneWay = legs.every((l) => l.dir === legs[0]!.dir);
  if (oneWay) {
    return "Every leg the same direction is one bet in several coats. Flip one leg and a wrong-way tape costs you a leg, not the case.";
  }
  return "Read the study charts for drift before tiering up. A SHARP line on a name that has been chopping is a SAFE line's payout at a DEGEN line's odds.";
}
