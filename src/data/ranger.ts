/**
 * The listed zone — `RANGER` — and how a drawn box finds one on the book.
 *
 * plan7 §3.1 says *"snap-to-listed is the default. Ship this first… the arena
 * works on day one regardless of what market makers do"*, and names the thing
 * to snap to: a listed condor. **There are none.** Not one condor has ever been
 * created through the OptionBook, across its entire 15,740-position history;
 * all 26 that exist on Base were minted through RFQ
 * (`docs/plan7-measurements.md` §3.3). §3.1's premise is false as written.
 *
 * What *is* listed, and what retail actually fills 39 times a day, is `RANGER`:
 * 9,766 positions, 62% of everything the book has ever traded, ~37 buyable
 * offers resting on ETH and BTC at any moment, $10,000 of depth per order, and
 * a real quote available from `previewFillOrder` with no signer and no spend.
 *
 * So this module is §3.1's *intent*, honoured with the instrument that exists:
 * **match the drawn box against a listed zone, and if one matches, the arena
 * can fill it off the book with no maker round trip at all.**
 *
 * ## Not a contradiction of plan7 §1 — a division of it
 *
 * §1 rules `RANGER` out because `client.ranger` has no create method and there
 * is no `buildRangerRFQ`. That is correct, and it stays correct: **a zone
 * cannot be minted.** It says nothing about *filling* one that a maker has
 * already created, which is a different verb on a different venue. The split
 * the book itself draws:
 *
 * | path | instrument | why |
 * |---|---|---|
 * | OptionBook, listed | `RANGER` | the only zone product ever listed there |
 * | OptionFactory, RFQ | `CALL_CONDOR` | the only zone product that can be minted |
 *
 * `src/data/condor.ts` owns the second. This file owns the first.
 *
 * ## The one thing that decides which is which
 *
 * `rawApiData.implementation`, looked up in `chainConfig.optionImplementations`.
 * **Never the strikes.** `validateCondor` and `validateRanger` accept the
 * identical arrays (`dist/index.js:16838`, `:16871`), and the SDK's own condor
 * convention — four ascending strikes with equal outer widths — is character for
 * character the ranger test, so a strike-shape heuristic is not a check, it is
 * our own arithmetic read back to us. That mistake has a number:
 * `docs/reviews/mcp-crosscheck.md` §BUG-2, where every symmetric condor on the
 * book was typed `RANGER` and given the wrong payout flag.
 *
 * The registry travels on the snapshot rather than being copied here. It is the
 * same map `classifyOrder` in `src/server/thetanuts.ts` resolves against, and a
 * second copy of an address table in a browser bundle is a table that will
 * eventually be a deployment behind. A snapshot with **no** registry yields no
 * listed zones — "I cannot tell" is the honest answer, and the arena's other
 * path is still there.
 *
 * ## Three things a listed zone is not, and the copy must say so
 *
 * 1. **The ladder is coarse.** Zones sit $50/$100 apart on ETH and $1,000 apart
 *    on BTC, ~3 per (underlying, expiry), on two assets. Snap-to-listed is not
 *    "draw any box"; it is "one of about three". Most drawable boxes match
 *    nothing, and {@link matchListedZone} returning `null` is the *ordinary*
 *    outcome, not an error.
 * 2. **A listed zone publishes no greeks** — 0 of 38 orders carried them on 32
 *    reads of the live book. So plan7 §2.4's `TIER_BANDS` delta shading cannot
 *    be applied to one. Nothing in this file reads, derives or invents a delta;
 *    there is no field here to hang one on, and `test/box.test.ts` greps this
 *    source to keep it that way.
 * 3. **The wings are the maker's.** A listed zone comes as it is: the player
 *    picks one, they do not size it. Since the wing *is* the maximum payout,
 *    that is a consequence worth stating rather than hiding (§4.2).
 *
 * ## Long only, unchanged
 *
 * Only an order the *taker* can buy is ever offered as a zone
 * ({@link isTakerBuyable}), and {@link RangerSpec.isLong} is the literal `true`,
 * so the sell side cannot be spelled here any more than it can in `condor.ts`.
 * Max loss stays the premium.
 *
 * @see docs/plan7-measurements.md §3 — the census this module is built on
 * @see plan7-box-builder-arena.md §1, §3.1, §4.2, §4.4, §5
 * @see src/data/condor.ts — the instrument the *unmatched* box becomes
 */

import {
  formatStrike,
  liveExpiryOf,
  parseStrike,
  strikeUsd,
  type Box,
  type LadderOrder,
  type LadderSnapshot,
} from "./box.ts";
import { economics, type CondorEconomics } from "./condor.ts";
import { feedIndex } from "./qualify.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The two namespaces, kept apart
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The UPPER_SNAKE `ProductName` — the key `chainConfig.optionImplementations`
 * uses, and the only string this module compares an order against.
 *
 * On Base it is deployed at `0x9980ec85…`, but that address is deliberately not
 * written down here: the registry maps it, and hard-coding it would be the
 * duplicate table this module exists to avoid.
 */
export const RANGER_PRODUCT = "RANGER";

/**
 * The lowercase `PayoutType` — a *different* union, and the SDK will not accept
 * one where it wants the other (FINDINGS, "two namespaces, do not conflate
 * them").
 *
 * It is on {@link RangerSpec} because forgetting it is the expensive mistake:
 * `calculatePayoutAtPrice` and `calculateMaxPayout` take an *order* shape,
 * which carries no type, and their own doc says four-strike orders **default to
 * a condor** unless the caller passes `isRanger: true`. A zone priced as a
 * condor is a wrong number that looks entirely reasonable.
 */
export const RANGER_PAYOUT_TYPE = "ranger";

/** A zone is four strikes. Anything else is a different instrument. */
export const RANGER_STRIKES = 4;

/**
 * Implementation address → product, keyed by **lowercase** address.
 *
 * Structurally the chain's own `optionImplementations`, widened so a fixture, a
 * truncated response and the real 46-entry map are all assignable.
 */
export type ImplementationRegistry = Record<
  string,
  { name?: string | null } | null | undefined
>;

/**
 * What the zone reader needs from a capture: the orders and the registry.
 *
 * Generic in the order type so a caller holding richer rows — `FillableOrder`,
 * or a raw `fetchOrders()` entry — gets **its own row back** on the match, and
 * can hand that straight to `previewFillOrder` and `fillOrder`. A match that
 * returned a copy would be a match you cannot fill.
 */
export interface ZoneBook<O extends LadderOrder = LadderOrder> {
  orders?: readonly O[] | null;
  chainConfig?: LadderSnapshot["chainConfig"];
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolving the product — from the registry, never from the strikes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The product an implementation address deploys, or `null`.
 *
 * `null` covers three cases that are all the same answer: no address, the zero
 * address (which the SDK's `buildContractOrder` itself refuses, on the grounds
 * that the option type is not deployed on this chain), and an address the
 * registry does not know — a deployment newer than the map we were handed,
 * which will happen, and whose only correct reading is "I do not know".
 */
export function productOf(
  implementation: string | null | undefined,
  registry: ImplementationRegistry | null | undefined,
): string | null {
  const key = String(implementation ?? "").trim().toLowerCase();
  if (key === "" || /^0x0*$/.test(key)) return null;
  const name = registry?.[key]?.name;
  return typeof name === "string" && name !== "" ? name : null;
}

/**
 * Is this order an instance of the listed zone product?
 *
 * One registry lookup and a string comparison. There is deliberately no
 * fallback to the strike shape: a four-strike order whose implementation we
 * cannot resolve is a condor **or** an iron condor **or** a ranger, and
 * pretending otherwise is BUG-2.
 */
export function isListedRanger(
  entry: LadderOrder | null | undefined,
  registry: ImplementationRegistry | null | undefined,
): boolean {
  return productOf(entry?.rawApiData?.implementation, registry) === RANGER_PRODUCT;
}

/**
 * Can the *player* buy this order?
 *
 * `rawApiData.isLong === false` means the maker is not the buyer, so the taker
 * is — measured over 9,766 settled zone positions, where the maker is on the
 * other side 5,635 times and on this one never (`docs/plan7-measurements.md`
 * §3.2). Anything else, `undefined` included, answers `false`: plan7 §5 permits
 * exactly one side, and "we could not tell" is not it.
 */
export function isTakerBuyable(entry: LadderOrder | null | undefined): boolean {
  return entry?.rawApiData?.isLong === false;
}

// ─────────────────────────────────────────────────────────────────────────────
// The zone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One listed zone, resting on the book right now.
 *
 * Note what is **not** on this object: no delta, no implied vol, no mark, no
 * premium. The book publishes no greeks for a zone and this module will not
 * invent any; the premium comes from `previewFillOrder` against
 * {@link ListedZone.order}, which is why the order itself is carried.
 */
export interface ListedZone<O extends LadderOrder = LadderOrder> {
  underlying: string;
  /** Unix seconds — the option's expiry, the column of the arena's time axis. */
  expiry: number;
  /**
   * `[callLower, callUpper, putLower, putUpper]`, ascending 8dp decimal
   * strings, verbatim from the order.
   *
   * The SDK's own convention for `ranger` (`index.d.ts:6480`), which is *not*
   * the iron condor's `[putLower, putUpper, callLower, callUpper]` — same four
   * numbers, different meanings, one union apart.
   */
  strikes: readonly [string, string, string, string];
  /** `callUpper` — the floor of the band that pays maximum. The box's floor. */
  floor: string;
  /** `putLower` — the ceiling of that band. The box's ceiling. */
  ceiling: string;
  /**
   * `callUpper − callLower === putUpper − putLower`, and therefore the maximum
   * payout per contract. **The maker's number, not the player's.**
   */
  wing: string;
  /** Remaining fillable size, in collateral units, verbatim. */
  availableAmount: string;
  /** Position in the capture's own `orders` array — for logs and for tests. */
  index: number;
  /** The row itself, unchanged, so the caller can quote and fill it. */
  order: O;
}

/**
 * Four raw strikes → the ranger invariants, in exact integer arithmetic.
 *
 * The same four checks the SDK throws on (`dist/index.js:10966`): exactly four
 * strikes, `callLower < callUpper`, equal spread widths, and `callUpper <
 * putLower` (the zone gap). Done here in `bigint` because the invariant is an
 * *equality between two differences*, and two differences of floats are not
 * reliably equal — the SDK's own version needs a `1e-4` tolerance for exactly
 * this reason.
 *
 * This is a check on an order the registry has **already** named a `RANGER`,
 * never a way of deciding that it is one.
 */
export function zoneStrikes(
  raw: readonly string[] | null | undefined,
): readonly [bigint, bigint, bigint, bigint] | null {
  if (!Array.isArray(raw) || raw.length !== RANGER_STRIKES) return null;
  const [a, b, c, d] = raw.map(parseStrike);
  if (a == null || b == null || c == null || d == null) return null;
  if (a <= 0n) return null;
  if (!(a < b)) return null;
  if (!(b < c)) return null;
  if (b - a !== d - c) return null;
  return [a, b, c, d];
}

/**
 * Every listed zone the book is quoting, ascending by underlying then expiry
 * then floor.
 *
 * Four gates, and every one of them is a fact rather than a preference:
 *
 * 1. the registry names the implementation `RANGER` — the only thing that can;
 * 2. the order is one the taker buys (plan7 §5);
 * 3. it is live at `at` — the *same* {@link liveExpiryOf} rule the strike
 *    ladder applies, so the arena can never offer a fill on a column it is not
 *    drawing;
 * 4. its strikes satisfy the ranger invariants.
 *
 * No registry means `[]`. An underlying the price feeds cannot name means the
 * row is skipped: a zone we cannot label is a zone we cannot match a box
 * against.
 *
 * There is no ETH/BTC restriction here, and that absence is deliberate. The
 * two-asset limit in `condor.ts` is a property of the RFQ entry point, which
 * mints; nothing is minted on this path, so the book's own answer stands. Today
 * the book's own answer *is* ETH and BTC, which is the point — it is measured,
 * not asserted.
 */
export function listedZones<O extends LadderOrder>(
  snap: ZoneBook<O> | null | undefined,
  at?: number,
): readonly ListedZone<O>[] {
  const registry = snap?.chainConfig?.optionImplementations;
  if (!registry) return [];

  const feeds = feedIndex(snap?.chainConfig?.priceFeeds);
  if (feeds.size === 0) return [];

  const orders = Array.isArray(snap?.orders) ? snap.orders : [];
  const zones: ListedZone<O>[] = [];

  for (let i = 0; i < orders.length; i++) {
    const entry = orders[i];
    if (!entry) continue;
    if (!isListedRanger(entry, registry)) continue;
    if (!isTakerBuyable(entry)) continue;

    const expiry = liveExpiryOf(entry, at);
    if (expiry === null) continue;

    const underlying = feeds.get(String(entry.rawApiData?.priceFeed ?? "").toLowerCase());
    if (!underlying) continue;

    const strikes = zoneStrikes(entry.rawApiData?.strikes);
    if (!strikes) continue;
    const [callLower, callUpper, putLower, putUpper] = strikes;

    zones.push({
      underlying,
      expiry,
      strikes: [
        formatStrike(callLower),
        formatStrike(callUpper),
        formatStrike(putLower),
        formatStrike(putUpper),
      ],
      floor: formatStrike(callUpper),
      ceiling: formatStrike(putLower),
      wing: formatStrike(callUpper - callLower),
      availableAmount: String(entry.availableAmount ?? ""),
      index: i,
      order: entry,
    });
  }

  zones.sort(
    (x, y) =>
      x.underlying.localeCompare(y.underlying) ||
      x.expiry - y.expiry ||
      compare(parseStrike(x.floor), parseStrike(y.floor)) ||
      compare(parseStrike(x.wing), parseStrike(y.wing)),
  );
  return zones;
}

/** `null`-tolerant `bigint` ordering, so the sort is total and deterministic. */
function compare(a: bigint | null, b: bigint | null): number {
  if (a === null || b === null) return 0;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The zones on one column of the arena — one underlying, one expiry.
 *
 * This is the honest shape of snap-to-listed and the screen should render it as
 * such: on the live book it returns one, two or three entries, and on ETH's two
 * nearest expiries it returns exactly one whose band does not contain spot.
 */
export function zonesFor<O extends LadderOrder>(
  snap: ZoneBook<O> | null | undefined,
  underlying: string,
  expiry: number,
  at?: number,
): readonly ListedZone<O>[] {
  return listedZones(snap, at).filter(
    (z) => z.underlying === underlying && z.expiry === expiry,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Matching a drawn box
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every listed zone the drawn box lands on: same underlying, same expiry, and a
 * band whose two edges are exactly the box's floor and ceiling.
 *
 * **Exact, in integer units, on both edges.** A "close enough" match would be a
 * different instrument with a different payout, sold to the player as the one
 * they drew — and on a $1,000 BTC ladder "close enough" is a thousand dollars
 * of band. If the box does not land on a zone it goes to the other path, which
 * is a normal Tuesday and not a failure.
 *
 * The wing does **not** filter, because the player does not choose it: a zone's
 * wings are the maker's. It orders instead — a zone whose wings match the box's
 * current wing comes first, then the narrower wing, so the caller taking
 * `[0]` gets the same answer on every machine. Two zones can share a band and
 * differ only in wing; the live book has exactly that on ETH 7 Sep, where
 * 2400–2500 is listed at both $20 and $40.
 */
export function matchListedZones<O extends LadderOrder>(
  box: Box | null | undefined,
  snap: ZoneBook<O> | null | undefined,
  at?: number,
): readonly ListedZone<O>[] {
  if (!box) return [];
  const floor = parseStrike(box.floor);
  const ceiling = parseStrike(box.ceiling);
  if (floor === null || ceiling === null) return [];
  const asked = parseStrike(box.wing);

  const hits = listedZones(snap, at).filter(
    (z) =>
      z.underlying === box.underlying &&
      z.expiry === box.expiry &&
      parseStrike(z.floor) === floor &&
      parseStrike(z.ceiling) === ceiling,
  );

  const exact = (z: ListedZone<O>): number =>
    asked !== null && parseStrike(z.wing) === asked ? 0 : 1;

  return [...hits].sort(
    (x, y) => exact(x) - exact(y) || compare(parseStrike(x.wing), parseStrike(y.wing)),
  );
}

/**
 * The one listed zone this box fills, or `null`.
 *
 * `null` is the common case and the arena should read it as *"this box needs a
 * maker"*, never as *"something went wrong"*. On the frozen capture's BTC
 * ladder, 1 of 36 drawable bands matches.
 */
export function matchListedZone<O extends LadderOrder>(
  box: Box | null | undefined,
  snap: ZoneBook<O> | null | undefined,
  at?: number,
): ListedZone<O> | null {
  return matchListedZones(box, snap, at)[0] ?? null;
}

/**
 * The zone as a box — what the player would have had to draw to land on it.
 *
 * The chips that let a player pick a listed zone are built from this, which is
 * why they cannot drift from what they fill: the box and the order are the same
 * four numbers.
 */
export function zoneBox(zone: ListedZone): Box {
  return {
    underlying: zone.underlying,
    floor: zone.floor,
    ceiling: zone.ceiling,
    wing: zone.wing,
    expiry: zone.expiry,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The instrument
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A listed zone, as the thing that gets filled.
 *
 * Distinct from `CondorSpec` on purpose. They carry the same four strikes and
 * the same payoff shape, and they are **not interchangeable**: one names a
 * product that can be minted and not listed, the other a product that can be
 * listed and not minted, and the SDK prices the second as the first unless it
 * is told. Giving them one type would make that mistake a keystroke away.
 */
export interface RangerSpec {
  readonly product: "RANGER";
  /** Always `"ranger"`. Carry it to every SDK payout call — see
   *  {@link RANGER_PAYOUT_TYPE}. */
  readonly payoutType: "ranger";
  /** Whatever the book listed it on. The registry decides, we do not. */
  readonly underlying: string;
  /** `[callLower, callUpper, putLower, putUpper]`, ascending 8dp strings. */
  readonly strikes: readonly [string, string, string, string];
  readonly expiry: number;
  /**
   * The literal `true`, not `boolean` — plan7 §5 at the type level. Only
   * taker-buyable orders become zones in the first place, so this is the second
   * of two locks on the same door.
   */
  readonly isLong: true;
}

/** Zone → instrument. Nothing is computed; the four strikes are the maker's. */
export function zoneToRanger(zone: ListedZone): RangerSpec {
  return {
    product: "RANGER",
    payoutType: RANGER_PAYOUT_TYPE,
    underlying: zone.underlying,
    strikes: zone.strikes,
    expiry: zone.expiry,
    isLong: true,
  };
}

/**
 * The four strikes as human-readable numbers — the encoding
 * `validateRanger(strikes: number[])` takes at the SDK boundary.
 *
 * The only place units become floats, and it is at the edge. Run the SDK's own
 * checker on this array before a quote and before a fill (plan7 §1); it will
 * agree with {@link zoneStrikes}, and the point of running it anyway is that we
 * are not the ones who get to decide that.
 */
export function rangerStrikeNumbers(spec: RangerSpec): [number, number, number, number] {
  const [a, b, c, d] = spec.strikes;
  return [strikeUsd(a) ?? 0, strikeUsd(b) ?? 0, strikeUsd(c) ?? 0, strikeUsd(d) ?? 0];
}

/** The same invariants as {@link zoneStrikes}, against a built spec. */
export function validateRangerSpec(spec: RangerSpec): { valid: boolean; error?: string } {
  const units = zoneStrikes(spec.strikes);
  if (!units) return { valid: false, error: "Ranger requires four ascending strikes" };
  const [a, b, c, d] = units;
  if (b - a !== d - c) {
    return { valid: false, error: "Ranger spread widths must be equal" };
  }
  if (!(b < c)) return { valid: false, error: "Ranger requires callUpper < putLower" };
  return { valid: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// The SDK's payout helpers — the only door, and it carries the flag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ## The 4-strike discriminator trap, closed rather than avoided
 *
 * `calculateMaxPayout` and `calculatePayoutAtPrice` take an *order*, and an
 * order carries no payout type. The SDK recovers one from the strike count
 * (`getPayoutTypeFromOptionType`, `index.js:11553`): four strikes and no flag is
 * `call_condor`. Four strikes plus `isRanger: true` is `ranger`. Nothing else
 * distinguishes them — `validateRanger` and `validateCondor` accept the
 * identical arrays, so no validator will ever catch the mistake, and the number
 * that comes back looks entirely reasonable.
 *
 * **It is a factor of two.** Read `calculateCollateral` (`index.js:11017`): a
 * condor's maximum is `K2 - K1`, one wing; a ranger's is `2 * (cU - cL)`, two.
 * A zone priced as a condor therefore reports **half** its collateral, silently,
 * on a number that is used to size money.
 *
 * Until now this repo satisfied plan7 §1 by never calling either helper at all,
 * which is a guarantee that lasts exactly as long as nobody adds a call. These
 * three functions are that guarantee made structural instead: the order shape
 * below cannot be spelled without `isRanger: true` (it is the literal type, the
 * same lock `RangerSpec.isLong` uses), and it is built from a `RangerSpec` by a
 * function that sets the flag itself. `test/box.test.ts` greps `src/` to keep
 * this the only place either helper is named.
 *
 * ## What these are NOT for
 *
 * They are not the arena's economics. `zoneEconomics` stays the source of the
 * numbers a player is shown, because the SDK's "max payout" for a ranger is the
 * **maker's collateral** (two wings) and not the taker's ceiling (one wing) —
 * its own `calculatePayout` never returns more than one wing at any settlement
 * price. Two different questions; this file answers the second and shows its
 * arithmetic ({@link zonePayoff}), and `test/box.test.ts` pins that our answer
 * and the SDK's agree at every price.
 */

/**
 * `optionType` for a zone.
 *
 * `0` is CALL. Under `isRanger: true` the value is **inert** — the SDK reads it
 * only to choose between the call and put variants of a type, and `ranger` has
 * neither — so this is a well-formed constant rather than a claim about the
 * instrument. `test/box.test.ts` pins the inertness against the shipped 0.3.0
 * instead of trusting this paragraph.
 */
export const RANGER_OPTION_TYPE = 0;

/**
 * The order shape the SDK's payout helpers take, with the discriminator
 * **required and `true`** rather than optional and forgettable.
 *
 * Mirrored structurally rather than imported, like every other SDK shape this
 * repo touches outside `desk/` — the whole seam is structural so a fixture is
 * assignable without the package present.
 */
export interface RangerPayoutOrder {
  readonly optionType: number;
  /** Units, 8dp — the same encoding `settlementPrice` uses. */
  readonly strikes: bigint[];
  /** The literal `true`. This is the whole point of the type. */
  readonly isRanger: true;
}

/**
 * The two helpers, structurally. `client.utils` satisfies this exactly
 * (`index.d.ts:6866`, `:6889`), and a test fake satisfies it in three lines.
 */
export interface RangerPayoutUtils {
  calculateMaxPayout(
    order: { optionType: number; strikes?: bigint[]; isIronCondor?: boolean; isRanger?: boolean },
    numContracts: bigint,
  ): bigint;
  calculatePayoutAtPrice(
    order: { optionType: number; strikes?: bigint[]; isIronCondor?: boolean; isRanger?: boolean },
    numContracts: bigint,
    settlementPrice: bigint,
  ): bigint;
}

/**
 * `RangerSpec` → the order the SDK prices, flag set.
 *
 * The only constructor of a {@link RangerPayoutOrder} in the repo, and the
 * reason a caller cannot reach the helpers with an unflagged four-strike order
 * by accident: to get the argument they have to come through here, and coming
 * through here sets the flag.
 */
export function rangerPayoutOrder(spec: RangerSpec): RangerPayoutOrder {
  return {
    optionType: RANGER_OPTION_TYPE,
    strikes: spec.strikes.map((s) => parseStrike(s) ?? 0n),
    isRanger: true,
  };
}

/**
 * The SDK's maximum payout for a zone — i.e. its **collateral**, two wings.
 *
 * `numContracts` is 18dp (`DECIMALS.SIZE`), the result 6dp USDC. Not what the
 * panel prints; see the section note above.
 */
export function rangerMaxPayout(
  utils: RangerPayoutUtils,
  spec: RangerSpec,
  numContracts: bigint,
): bigint {
  return utils.calculateMaxPayout(rangerPayoutOrder(spec), numContracts);
}

/**
 * The SDK's payout for a zone at one settlement price, in 6dp USDC.
 *
 * Agrees with {@link zonePayoff} at every price — that equality is a test, not
 * a comment, and it is the cross-check that says our own trapezoid is the
 * venue's and not a lookalike.
 */
export function rangerPayoutAtPrice(
  utils: RangerPayoutUtils,
  spec: RangerSpec,
  numContracts: bigint,
  settlementPrice: bigint,
): bigint {
  return utils.calculatePayoutAtPrice(rangerPayoutOrder(spec), numContracts, settlementPrice);
}

// ─────────────────────────────────────────────────────────────────────────────
// The economics — the market's numbers, never ours
// ─────────────────────────────────────────────────────────────────────────────

/** The wing in dollars, which is also the maximum per contract. */
export function zoneWingUsd(zone: ListedZone): number {
  return strikeUsd(zone.wing) ?? 0;
}

/** The band, in dollars — the `$80,000 – $81,000` line. */
export function zoneUsd(zone: ListedZone): { floor: number; ceiling: number } {
  return { floor: strikeUsd(zone.floor) ?? 0, ceiling: strikeUsd(zone.ceiling) ?? 0 };
}

/**
 * What the panel prints about money for a listed zone.
 *
 * Identical arithmetic to the condor's, through the identical
 * {@link economics} — max loss is the premium, the ceiling is the wing, the
 * multiple is one divided by the other. `premiumPaid` must be
 * `previewFillOrder`'s number against {@link ListedZone.order} and nothing
 * else: not a mid, not the resting `order.price`, not an estimate (plan7 §9).
 * Before that quote exists the multiple is `null` and the screen shows none.
 */
export function zoneEconomics(
  zone: ListedZone,
  premiumPaid: number,
  numContracts: number,
): CondorEconomics {
  return economics(zoneWingUsd(zone), zoneUsd(zone), premiumPaid, numContracts);
}

/**
 * The zone's **real** premium, per contract, in dollars — or `null`.
 *
 * The only source the arena's `premium` prop may have for a listed zone:
 * `previewFillOrder`'s own `pricePerContract`, read off the wire and parsed.
 * Not a mid, not a mark, not an estimate (plan7 §9), and not a division of two
 * rounded figures — the venue publishes this number and this reads it.
 *
 * `null` — never a zero, never a placeholder — for every way of not having a
 * quote, which are all the same answer to a player:
 *
 *  - the order was never quoted (the mock, a non-`RANGER` order, or an SDK
 *    `ORDER_EXPIRED` on a row the indexer is still serving);
 *  - `fillable === false`, i.e. `numContracts === 0n`: the maker's remaining
 *    collateral will not absorb the quote notional, so there is no size at
 *    which this box can be bought;
 *  - the figure is unparseable or non-positive.
 *
 * `zoneEconomics` then yields `payoutMultiple: null` and the panel renders no
 * multiple at all, which is plan7 §4.4's rule stated as arithmetic rather than
 * as a branch in a view.
 */
export function zoneQuote(zone: ListedZone): number | null {
  const quote = zone.order?.quote;
  if (!quote || quote.fillable === false) return null;
  const premium = Number(quote.premium);
  return Number.isFinite(premium) && premium > 0 ? premium : null;
}

/**
 * What one contract is worth if settlement prints at `price`.
 *
 * Terminal, and only terminal — the TWAP consumer smooths the settlement print
 * against manipulation, it does not average over the option's life (§2.3).
 *
 * Flat and maximal across the band, decaying linearly through equal wings, zero
 * outside them. That the shape coincides with the condor's is exactly why the
 * SDK mislabels one as the other, and why {@link RANGER_PAYOUT_TYPE} exists.
 */
export function zonePayoff(zone: ListedZone, price: number): number {
  const [a, b, c, d] = rangerStrikeNumbers(zoneToRanger(zone));
  const wing = b - a;
  if (!Number.isFinite(price) || wing <= 0) return 0;
  if (price <= a || price >= d) return 0;
  if (price >= b && price <= c) return wing;
  if (price < b) return price - a;
  return d - price;
}

/**
 * Does the current price sit inside this listed zone?
 *
 * Asked because of one of the more interesting facts in the census: on ETH's
 * two nearest expiries the single listed zone is 2300–2400 against a spot of
 * 2449, so **it does not contain spot at all**. That is a real statement about
 * where the maker wants risk, not a bug and not something to paper over — a
 * player drawing a box around today's price for tomorrow has nothing on the
 * book to snap to, and should be told so plainly.
 */
export function zoneCoversSpot(zone: ListedZone, spot: number | null | undefined): boolean {
  if (typeof spot !== "number" || !Number.isFinite(spot)) return false;
  const { floor, ceiling } = zoneUsd(zone);
  return spot >= floor && spot <= ceiling;
}
