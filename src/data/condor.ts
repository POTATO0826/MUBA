/**
 * The instrument the box becomes: a long `CALL_CONDOR`.
 *
 * A four-strike condor `s1 < s2 < s3 < s4` pays maximum when settlement lands
 * between `s2` and `s3`, decays linearly through the wings, and is worth
 * nothing outside `s1`/`s4`. That is exactly the box, and the mapping is the
 * whole trick:
 *
 * ```
 *             ┌──────────────┐
 *            /                \
 *     ______/                  \______
 *     s1        s2        s3        s4
 *               └── your box ──┘
 * ```
 *
 * | Box handle | Strike |
 * |---|---|
 * | price floor   | `s2` |
 * | price ceiling | `s3` |
 * | wing width    | `s2 − s1` and `s4 − s3`, equal, enforced |
 *
 * ## Not RANGER **here** — and the word "here" is doing real work
 *
 * `RANGER` has the same payoff shape and Thetanuts calls it unique to them, so
 * it is the obvious choice. It cannot be *minted*: `client.ranger` exposes only
 * `payout`, `close`, `split`, `transfer`, `reclaimCollateral` and
 * `returnExcessCollateral` — **there is no create method anywhere in SDK 0.3.0**,
 * and no `buildRangerRFQ` either. A RangerOption can be managed, never created.
 * So on the RFQ path, which mints, `CALL_CONDOR` is the only instrument.
 *
 * plan7 §1 states that as *"do not use RANGER"* without qualification, and that
 * is too strong by exactly one venue. On the **OptionBook** you do not create an
 * option, you fill an order a maker already created — and a zone is the only
 * thing there is to fill. The census settles it: zero condors have ever been
 * listed, 9,766 zone positions have traded, ~39 a day
 * (`docs/plan7-measurements.md` §3). `src/data/ranger.ts` owns that path.
 *
 * The two files are deliberately not one. Their four strikes look identical and
 * the SDK will price one as the other given half a chance
 * (`isRanger: true`, or a condor's payout on a zone), so the type that says
 * which is which is the guard.
 *
 * ## Long only, at the type level
 *
 * {@link CondorSpec.isLong} is the literal type `true`, not `boolean`. A short
 * leg is therefore not something this module declines to build — it is
 * something no caller can spell, because `{ isLong: false }` is not assignable
 * to the spec (plan7 §5, asserted with `@ts-expect-error` in `test/box.test.ts`).
 * That matters more than a runtime guard would: max loss is the premium paid,
 * on every box, with no exception to check and no collateral to post.
 *
 * The SDK's `calculateCollateralRequired(n, 'CALL_CONDOR', strikes)` returns
 * `n × (s2 − s1)` — the **seller's** obligation. Reading it for a buy is the
 * mistake plan7 §5 names, so it is not called here. Note that the seller's
 * worst case and the buyer's best case are the same number by construction,
 * which is why {@link maxPayout} arrives at the same wing width from the payoff
 * function itself.
 *
 * *(SDK note, in the FINDINGS tradition: plan7 §5 quotes the collateral formula
 * as `(strike2 − strike1) × numContracts / 1e8`. The shipped 0.3.0 code takes
 * strikes as human floats and divides by nothing — `dist/index.js`'s `default`
 * branch of `calculateCollateralRequired`. The `/1e8` belongs to an older doc.)*
 *
 * @see plan7-box-builder-arena.md §0.2, §1, §4.2, §4.4, §5
 * @see src/data/box.ts — the ladder the box was snapped to
 */

import {
  formatStrike,
  parseStrike,
  strikeUsd,
  type Box,
} from "./box.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The instrument
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two underlyings a condor can actually be created for.
 *
 * plan7 §2.1 — `prepare_request_rfq`'s underlying enum is `['ETH','BTC']` and
 * nothing else can be RFQ'd, even though the OptionBook lists more assets and
 * `qualifiedUnderlyings` will happily name them. **SUI is not a Thetanuts asset
 * and appears nowhere.**
 */
export const CONDOR_UNDERLYINGS = ["ETH", "BTC"] as const;

export type CondorUnderlying = (typeof CONDOR_UNDERLYINGS)[number];

export function isCondorUnderlying(symbol: string): symbol is CondorUnderlying {
  return (CONDOR_UNDERLYINGS as readonly string[]).includes(symbol);
}

/** The instrument the box becomes. */
export interface CondorSpec {
  readonly product: "CALL_CONDOR";
  readonly underlying: CondorUnderlying;
  /** `[s1, s2, s3, s4]` ascending, 8dp decimal strings. */
  readonly strikes: readonly [string, string, string, string];
  readonly expiry: number;
  /**
   * Always `true`, as a literal type rather than a value.
   *
   * This is the field `CondorRFQParams.isLong` and the OptionBook's buy side
   * both read, and it is the compile-time form of plan7 §5: there is no way to
   * construct this object with a short leg.
   */
  readonly isLong: true;
}

/**
 * Box → instrument. Pure arithmetic on the box's own numbers.
 *
 * `s1 = floor − wing` and `s4 = ceiling + wing` are built from **one** wing
 * value in exact `bigint` arithmetic, so `s2 − s1 === s4 − s3` holds
 * identically rather than approximately. That construction is what makes the
 * SDK's `validateCondor` a formality rather than a filter — and
 * `test/box.test.ts` runs the real named export over every reachable box on
 * every fixture ladder to prove the two agree.
 *
 * @throws when the box cannot form a condor — an unparseable field, a
 * non-tradable underlying, a collapsed zone, or a wing that would put `s1` at
 * or below zero. Call `isPlayable(box, ladder)` first; a silently wrong
 * `CondorSpec` reaching a fill is worse than a throw, because it is a real
 * signature on the wrong instrument.
 */
export function boxToCondor(b: Box): CondorSpec {
  if (!isCondorUnderlying(b.underlying)) {
    throw new Error(`boxToCondor: ${b.underlying || "(none)"} has no condor market`);
  }
  const s2 = parseStrike(b.floor);
  const s3 = parseStrike(b.ceiling);
  const wing = parseStrike(b.wing);
  if (s2 === null || s3 === null || wing === null) {
    throw new Error("boxToCondor: floor, ceiling and wing must all be 8dp decimal strings");
  }
  if (s3 <= s2) throw new Error("boxToCondor: the ceiling must sit above the floor");
  if (wing <= 0n) throw new Error("boxToCondor: the wing width must be positive");
  const s1 = s2 - wing;
  if (s1 <= 0n) throw new Error("boxToCondor: the wing is wider than the floor");
  if (!Number.isFinite(b.expiry) || b.expiry <= 0) {
    throw new Error("boxToCondor: the expiry must be unix seconds from a live expiry");
  }
  const s4 = s3 + wing;

  return {
    product: "CALL_CONDOR",
    underlying: b.underlying,
    strikes: [formatStrike(s1), formatStrike(s2), formatStrike(s3), formatStrike(s4)],
    expiry: Math.trunc(b.expiry),
    isLong: true,
  };
}

/**
 * The four strikes as **human-readable numbers**, ascending — the exact array
 * the SDK boundary wants.
 *
 * `validateCondor(strikes: number[])` is a named export (it is *not* on
 * `client.utils`), and `buildCondorRFQ`'s `strike1..strike4` are documented as
 * "human-readable". This is the only place units become floats, and it is at
 * the edge, which is where plan7 §1's *"run it before every quote and every
 * fill"* is discharged:
 *
 * ```ts
 * import { validateCondor } from "@thetanuts-finance/thetanuts-client";
 * const check = validateCondor(condorStrikeNumbers(spec));
 * if (!check.valid) throw new Error(check.error);
 * ```
 */
export function condorStrikeNumbers(spec: CondorSpec): [number, number, number, number] {
  const [s1, s2, s3, s4] = spec.strikes;
  return [strikeUsd(s1) ?? 0, strikeUsd(s2) ?? 0, strikeUsd(s3) ?? 0, strikeUsd(s4) ?? 0];
}

/**
 * The same invariant `validateCondor` checks, in exact integer arithmetic and
 * with no SDK import — so `src/data/**` stays free of ethers and this can run
 * in a browser bundle.
 *
 * The SDK's version sorts, converts to floats and compares within a `1e-4`
 * tolerance. This one does not need a tolerance, which is the point.
 */
export function validateSpec(spec: CondorSpec): { valid: boolean; error?: string } {
  const units = spec.strikes.map(parseStrike);
  const [s1, s2, s3, s4] = units;
  if (s1 == null || s2 == null || s3 == null || s4 == null) {
    return { valid: false, error: "Condor requires exactly 4 strikes" };
  }
  if (!(s1 < s2 && s2 < s3 && s3 < s4)) {
    return { valid: false, error: "Condor strikes must be strictly ascending" };
  }
  if (s1 <= 0n) return { valid: false, error: "Condor strikes must be positive" };
  if (s2 - s1 !== s4 - s3) return { valid: false, error: "Condor spread widths must be equal" };
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// The economics — computed, never invented
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The wing width in dollars, which is also the **maximum payout per contract**.
 *
 * A long call condor is `+C(s1) − C(s2) − C(s3) + C(s4)`. Inside the zone that
 * collapses to `(S − s1) − (S − s2) = s2 − s1`: flat, and exactly one wing
 * wide. So the wing is not decoration and not a smoothing parameter — **it is
 * the upside**, and plan7 §4.2's insistence that its value be readable even
 * when the handle is hidden follows directly.
 */
export function wingUsd(spec: CondorSpec): number {
  const [s1, s2] = spec.strikes;
  const lower = strikeUsd(s1);
  const inner = strikeUsd(s2);
  if (lower === null || inner === null) return 0;
  return inner - lower;
}

/** The inner zone in dollars — the band the panel prints as `$2,600 – $2,750`. */
export function zoneUsd(spec: CondorSpec): { floor: number; ceiling: number } {
  const [, s2, s3] = spec.strikes;
  return { floor: strikeUsd(s2) ?? 0, ceiling: strikeUsd(s3) ?? 0 };
}

/**
 * What the position is worth per contract if settlement prints at `price`.
 *
 * Terminal, and only terminal. plan7 §2.3: the TWAP consumer smooths the
 * settlement print against manipulation, it does not average over the option's
 * life. Price does not have to *stay* in the band, it has to **land** there —
 * which is why the copy says "lands in your box at expiry" and never "stays
 * within your box", and why the left edge of the box is not a real handle.
 */
export function condorPayoff(spec: CondorSpec, price: number): number {
  const [s1, s2, s3, s4] = condorStrikeNumbers(spec);
  const wing = s2 - s1;
  if (!Number.isFinite(price) || wing <= 0) return 0;
  if (price <= s1 || price >= s4) return 0;
  if (price >= s2 && price <= s3) return wing;
  if (price < s2) return price - s1;
  return s4 - price;
}

/**
 * The most this position can pay, in dollars.
 *
 * Read off {@link condorPayoff}'s own maximum — the flat top of the shape —
 * rather than off `calculateCollateralRequired`, which is the seller's
 * obligation and not our player's (plan7 §5). The two agree, because one side's
 * worst case is the other's best case.
 */
export function maxPayout(spec: CondorSpec, numContracts: number): number {
  if (!Number.isFinite(numContracts) || numContracts <= 0) return 0;
  return wingUsd(spec) * numContracts;
}

/**
 * `max_payout ÷ premium_paid`, and nothing else.
 *
 * plan7 §4.4 — *reward from precision is real, not a rule.* A tighter box is a
 * cheaper contract, so the multiple is higher; that happens because the market
 * charges less for it, not because a table in this repo says a tight box pays
 * 8x. There is no payback rate to find in this file, and `test/box.test.ts`
 * greps both source files for one.
 *
 * `null` when there is no premium yet — an un-quoted box has no multiple, and
 * a placeholder here is exactly the invented number the rule forbids.
 * Difficulty shading (`SHARP`, `DEGEN`) is styling **over** this number and can
 * never be an input to it.
 */
export function payoutMultiple(
  spec: CondorSpec,
  premiumPerContractUsd: number,
  numContracts: number,
): number | null {
  return multipleOf(
    maxPayout(spec, numContracts),
    premiumPerContractUsd * (Number.isFinite(numContracts) ? numContracts : 0),
  );
}

/**
 * The division itself, over two dollar figures — the one implementation of
 * `max payout ÷ premium paid` in the repo.
 *
 * Split out of {@link payoutMultiple} so the listed-zone path
 * (`src/data/ranger.ts`) can answer the same question about an instrument that
 * is *not* a condor without a second copy of the arithmetic. A second copy is
 * exactly how an invented rate gets in: one of them acquires a floor, or a cap,
 * or a difficulty argument, and nobody notices which.
 *
 * `null` whenever the answer would be a placeholder rather than a fact — no
 * premium yet, or nothing to win.
 */
export function multipleOf(ceiling: number, premiumPaid: number): number | null {
  if (!Number.isFinite(premiumPaid) || premiumPaid <= 0) return null;
  if (!Number.isFinite(ceiling) || ceiling <= 0) return null;
  return ceiling / premiumPaid;
}

/**
 * Everything the parameters panel prints about money, in one call.
 *
 * **Every dollar figure here is a POSITION total** — the whole of `contracts`
 * contracts, not one of them. That sentence is the fix for a defect this shape
 * carried silently: `maxPayout` was the wing scaled by the contract count while
 * `maxLoss` was the premium unscaled, so `payoutMultiple` — one divided by the
 * other — came out inflated by exactly `numContracts`. It stayed invisible
 * because `contracts` defaults to one everywhere and no caller has ever passed
 * another value; the first line that sizes a box would have found it, on a
 * figure the screen prints in bold. `basketPayoff` in `src/engine/parlay.ts`
 * scales its premium correctly and is the shape this now matches.
 *
 * `contracts` is on the result for the same reason: a panel is entitled to say
 * what position its totals are over, and a caller reading these fields should
 * not have to remember which argument it passed.
 */
export interface CondorEconomics {
  /**
   * **The premium, always. 100%.** Long only means there is no other answer,
   * and plan7 §4.3 and plan6 §A7 both require it printed above the upside
   * figure, at every detail level, ungated.
   *
   * The premium per contract, scaled by {@link CondorEconomics.contracts} — a
   * total, like every other dollar figure on this shape.
   */
  maxLoss: number;
  /** Wing width × contracts. See {@link maxPayout}. */
  maxPayout: number;
  /** {@link payoutMultiple}. `null` until a real premium exists. Scale-free:
   *  the same answer at one contract and at a hundred, which is the property
   *  that says the numerator and the denominator are in the same unit. */
  payoutMultiple: number | null;
  /** The wing, in dollars — surfaced so the panel can print it (§4.2). Per
   *  contract, and the only field here that is: it is a property of the
   *  instrument rather than of the position. */
  wing: number;
  /** The inner zone, for the `$2,600 – $2,750` line. */
  zone: { floor: number; ceiling: number };
  /** The position every total above was computed over. Zero when the caller
   *  passed a count that is not one. */
  contracts: number;
}

/**
 * @param premiumPerContractUsd The **actual** premium for ONE contract —
 * `previewFillOrder`'s `pricePerContract` on the OptionBook path, or a
 * decrypted offer's on the RFQ path. Never a mid, never an estimate (plan7 §9),
 * and never a position total: {@link economics} says why the unit is in the
 * parameter's name now.
 */
export function condorEconomics(
  spec: CondorSpec,
  premiumPerContractUsd: number,
  numContracts: number,
): CondorEconomics {
  return economics(wingUsd(spec), zoneUsd(spec), premiumPerContractUsd, numContracts);
}

/**
 * The same panel, for any zone-bound long structure — the condor above, or a
 * listed `RANGER` off the OptionBook (`src/data/ranger.ts`).
 *
 * Both instruments answer the money questions from the identical two facts: the
 * wing is the maximum per contract, and the premium is the whole of the risk.
 * What differs between them is what you may *say* about them — a listed zone's
 * wing is the maker's rather than the player's, and it publishes no greeks —
 * and that difference belongs in the copy, not in the arithmetic.
 *
 * ## Both inputs are per contract; every output is a total
 *
 * `wing` is the maximum for ONE contract, `premiumPerContractUsd` is the cost
 * of ONE contract, and `numContracts` scales both into the position figures the
 * panel prints. That symmetry is the whole correction: the ceiling used to be
 * scaled and the premium not, which inflated the multiple by the contract count
 * — silently, because nothing has ever passed a count other than one. The unit
 * is in the parameter's name so a caller holding a position total cannot hand
 * it over without noticing.
 *
 * The two callers to check when reading this. `zoneEconomics`
 * (`src/data/ranger.ts`) passes `zoneQuote`, which is `previewFillOrder`'s
 * `pricePerContract` — per contract, correct. `boxEconomics`
 * (`src/desk/boxauction.ts`) holds `offerPremiumUsd`, which is a decrypted
 * offer's whole `offerAmount` in dollars — a **position total**, and the same
 * number as the per-contract one only while the position is one contract. It
 * used to hand that straight over, which double-counted the size on any request
 * bigger than one; it now divides by its own `numContracts` first, and says at
 * its own definition why the division lives there and not in `offerPremiumUsd`.
 *
 * @param wing        Wing width in dollars. The maximum per contract.
 * @param zone        The inner band, in dollars, for the `$2,600 – $2,750` line.
 * @param premiumPerContractUsd The **actual** premium for ONE contract — never
 *                    a mid, never an estimate, and never a position total.
 * @param numContracts The position both figures are scaled to.
 */
export function economics(
  wing: number,
  zone: { floor: number; ceiling: number },
  premiumPerContractUsd: number,
  numContracts: number,
): CondorEconomics {
  const perContract =
    Number.isFinite(premiumPerContractUsd) && premiumPerContractUsd > 0 ? premiumPerContractUsd : 0;
  const contracts = Number.isFinite(numContracts) && numContracts > 0 ? numContracts : 0;
  const ceiling = Number.isFinite(wing) && wing > 0 ? wing * contracts : 0;
  // Two totals over one position, so the division below is scale-free — which
  // is the property that says the units agree.
  const paid = perContract * contracts;
  return {
    maxLoss: paid,
    maxPayout: ceiling,
    payoutMultiple: multipleOf(ceiling, paid),
    wing: Number.isFinite(wing) ? wing : 0,
    zone,
    contracts,
  };
}
