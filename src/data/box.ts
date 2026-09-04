/**
 * The box the player draws — and the live strike ladder it snaps to.
 *
 * > The box the player draws *is* the option. Its dimensions are the price, and
 * > the price comes from Thetanuts, not from us.
 *
 * This module is plan 7 steps 1–2, the pure half: a {@link Box} is three
 * numbers and a date, and everything that constrains it is **measured off the
 * live book** rather than chosen by us. There is no default increment, no
 * minimum tick, no house-set granularity. If the market quotes strikes $20
 * apart the player may draw a $20 box; if it quotes them $3,500 apart, they
 * may not.
 *
 * ## The ladder is derived first, and everything else is derived from it
 *
 * plan7 §2.5's third rule: *derive the ladder first, then fit the chart to it,
 * or they drift by a pixel and the box stops lining up with what it snaps to.*
 * So {@link deriveLadder} is the only function here that reads the book, and
 * snapping ({@link snapBox}), the minimum box height ({@link minBoxHeight}),
 * the wing default ({@link defaultWing}) and the chart's y-axis
 * ({@link ladderBounds}) are all pure functions **of a ladder**. A caller that
 * computes any of them some other way has reintroduced the drift.
 *
 * ## Irregular by construction
 *
 * Real ladders are not evenly spaced. The frozen capture's ETH 5 Sep ladder is
 * `2420 · 2440 · 2460 · 2480 · 2550 · 2650` — three $20 rungs and then $70 and
 * $100 — and BTC's is `78500 … 81500` at $500 and then a $3,500 jump to 85000.
 * Nothing here rounds to a constant increment, and
 * `test/box.test.ts` asserts that an irregular ladder snaps irregularly.
 *
 * The consequence is the nicest constraint in the mode: **the minimum box
 * height is one rung of the local ladder**, so precision is available exactly
 * where the market is liquid and coarse where it is not (plan7 §2.4). It is a
 * fact about the book, not a difficulty setting.
 *
 * ## Purity, and why the SDK is not imported here
 *
 * No clock, no socket, no module state — `at` is an argument and the book is an
 * argument, exactly as in {@link file://./qualify.ts}. It also imports neither
 * `src/server/thetanuts.ts` nor `@thetanuts-finance/thetanuts-client`, both of
 * which pull the SDK and ethers in at the top level; this module is meant to be
 * free to run anywhere, including a browser bundle.
 *
 * The SDK's own `validateCondor` therefore is not called from here. The
 * equal-wing invariant it checks (`s2 − s1 === s4 − s3`) is instead guaranteed
 * *by construction* — `boxToCondor` builds `s1` and `s4` from one wing width in
 * exact integer arithmetic — and `test/box.test.ts` runs the real named export
 * over every reachable box on every fixture ladder to prove the construction
 * and the SDK agree. That is strictly stronger than a runtime call, and it is
 * still the execution layer's job to call the SDK function on
 * `condorStrikeNumbers(spec)` before a quote and before a fill (plan7 §1).
 *
 * @see plan7-box-builder-arena.md §0.2, §2.2, §2.4, §2.5, §4.2
 * @see src/data/condor.ts — the instrument the box becomes
 */

import { feedIndex } from "./qualify.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The encoding
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Strikes are **8dp decimal strings** — the encoding `rawApiData.strikes` ships
 * and the one `MarketSlice.strikeLo/strikeHi` already use (`src/types.ts`):
 * a base-10 integer of hundred-millionths, so `"265000000000"` is $2,650.
 *
 * Every comparison in this file is therefore exact integer work on `bigint` and
 * never a float round trip. That matters more than it looks: the equal-wing
 * invariant is an *equality* between two differences, and two differences of
 * floats are not reliably equal.
 */
export const STRIKE_DECIMALS = 8;

/** `10n ** 8n`. The only scale constant in this module. */
export const STRIKE_SCALE = 100_000_000n;

/**
 * An 8dp decimal string → units, or `null`.
 *
 * Deliberately strict: an optional sign, then digits, nothing else. `"2650"`
 * parses — as **$0.0000265**, because that is what the encoding says it is. A
 * caller holding a human dollar figure wants {@link priceToStrike}, and the
 * reason that function exists is so no view ever hand-writes the zeros.
 */
export function parseStrike(raw: string | bigint | number | null | undefined): bigint | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === "bigint") return raw;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return null;
    return BigInt(raw);
  }
  const text = raw.trim();
  if (!/^-?\d+$/.test(text)) return null;
  try {
    return BigInt(text);
  } catch {
    return null;
  }
}

/** Units → the canonical 8dp decimal string. */
export function formatStrike(units: bigint): string {
  return units.toString();
}

/**
 * Units → human dollars, for an axis label or an SDK boundary.
 *
 * `buildCondorRFQ` takes `strike1..strike4` as *human-readable* numbers
 * (`CondorRFQParams`, SDK 0.3.0), and `validateCondor` takes `number[]`, so
 * this is the conversion at the edge — never in the middle.
 */
export function strikeUsd(raw: string | bigint | null | undefined): number | null {
  const units = parseStrike(raw);
  if (units === null) return null;
  return Number(units) / Number(STRIKE_SCALE);
}

/**
 * Human dollars → an 8dp decimal string, rounded to the nearest unit.
 *
 * This is the pixel-to-price edge: a drag gives a dollar figure and the ladder
 * speaks in units, and this is the single place the two meet.
 */
export function priceToStrike(price: number): string | null {
  if (!Number.isFinite(price)) return null;
  return formatStrike(BigInt(Math.round(price * Number(STRIKE_SCALE))));
}

// ─────────────────────────────────────────────────────────────────────────────
// Input shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the ladder reads: one **raw** `fetchOrders()` capture plus the bundled
 * chain config. `test/fixtures/orders.json` is exactly this, and the real
 * `RawMarket` from `src/server/thetanuts.ts` is structurally assignable with no
 * import and no adapter — `test/box.test.ts` asserts that at compile time.
 *
 * Widened and all-optional for the same two reasons `QualifySnapshot` is
 * (`src/data/qualify.ts`): a checked-in JSON fixture must be assignable, and a
 * truncated or garbage response must degrade to `[]` rather than throw. The
 * duplication with `QualifyOrder` is deliberate and for the reason that module
 * gives — neither may drag the SDK into a browser bundle.
 */
export interface LadderSnapshot {
  orders?: readonly LadderOrder[] | null;
  chainConfig?: {
    /** 10 keys over 8 assets: `ETH/USD` and `ETH` are the *same address*. */
    priceFeeds?: Record<string, string> | null;
  } | null;
}

/** One entry of `fetchOrders()`, narrowed to the fields a ladder reads. */
export interface LadderOrder {
  order?: {
    /**
     * The **option's** expiry, unix seconds — the column of the time axis.
     *
     * Distinct from `rawApiData.orderExpiryTimestamp`, which is when the
     * *signature* goes stale; the frozen capture has 1788595200 against
     * 1788514414. Only this one names the contract the box is a claim on.
     */
    expiry?: string | bigint | number | null;
  } | null;
  /** Remaining fillable size, in collateral units. Zero is not a live order. */
  availableAmount?: string | bigint | number | null;
  rawApiData?: {
    /** The Chainlink feed address — how an order names its underlying. */
    priceFeed?: string;
    /** 8dp decimal strings. A multi-leg order contributes all of them. */
    strikes?: readonly string[] | null;
    /** The signature's own expiry. A stale order reverts `Signer Not Authorized`. */
    orderExpiryTimestamp?: number;
  } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The ladder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A box needs a floor and a ceiling, so an expiry quoting one strike is not a
 * column the expiry selector may offer. The wings may sit off the ladder
 * (see {@link defaultWing}), so two is genuinely enough.
 */
export const MIN_LADDER_STRIKES = 2;

/**
 * One underlying, one expiry, and the strikes the book is actually quoting
 * there — ascending, deduplicated.
 *
 * `prices` is derived *from* `strikes`, in the same order, and exists so the
 * chart's y-axis and the snap target are the same numbers rather than two
 * computations of the same intent (plan7 §2.5).
 */
export interface StrikeLadder {
  underlying: string;
  /** Unix seconds. One of the book's real expiries. */
  expiry: number;
  /** Ascending, deduplicated, 8dp decimal strings. */
  strikes: readonly string[];
  /** `strikes`, in dollars, same order. The y-axis. */
  prices: readonly number[];
}

/** Total, non-throwing positive-integer read for `availableAmount`. */
function hasSize(raw: string | bigint | number | null | undefined): boolean {
  if (raw === null || raw === undefined) return false;
  try {
    if (typeof raw === "bigint") return raw > 0n;
    if (typeof raw === "number") return Number.isFinite(raw) && raw > 0;
    return BigInt(raw.trim()) > 0n;
  } catch {
    return Number(raw) > 0;
  }
}

/** Total, non-throwing unix-seconds read for the option expiry. */
function toSeconds(raw: string | bigint | number | null | undefined): number | null {
  if (raw === null || raw === undefined) return null;
  const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.trunc(n);
}

/**
 * Every `(underlying, expiry)` ladder the book supports, ascending by
 * underlying then expiry.
 *
 * ## What counts as a strike that "carries a live order"
 *
 * An order contributes **all** of its strikes: a resting SPREAD at
 * `[79500, 80000]` is a maker quoting both of those levels, and a four-strike
 * structure quotes four. What we are measuring is where the venue has a price,
 * not how many single-leg lines exist.
 *
 * ## Why the ladder does not filter by side
 *
 * The player is always a buyer (plan7 §5), so it is tempting to keep only the
 * orders a buyer can lift — `order.isBuyer === false`. That would be wrong
 * here, and expensively so: 23 of the 30 orders in the frozen capture are maker
 * *bids*, and dropping them empties the ETH 5 Sep ladder entirely, which is the
 * single most interesting ladder on the book.
 *
 * A resting order at a strike proves the venue quotes that strike and that a
 * maker will price it. **Which side you can lift is a question for the fill
 * path** — `previewFillOrder` on the OptionBook, or an MM's sealed bid over
 * RFQ (plan7 §3) — and not a question about where the axis has rungs. The
 * free-draw path can price any listed strike regardless of which side is
 * resting.
 *
 * @param snap One raw capture. Anything unusable degrades to `[]`.
 * @param at   Optional wall clock in **milliseconds**. When supplied, an order
 *             past its own signature expiry, and an expiry already in the past,
 *             are both dropped — a strike propped up by a dead order is not a
 *             strike anyone can trade. Omitted means "do not judge expiry",
 *             which keeps the function total and keeps a frozen fixture from
 *             ageing out of its own tests.
 */
export function deriveLadders(
  snap: LadderSnapshot | null | undefined,
  at?: number,
): readonly StrikeLadder[] {
  const feeds = feedIndex(snap?.chainConfig?.priceFeeds);
  if (feeds.size === 0) return [];

  const now = typeof at === "number" && Number.isFinite(at) ? at / 1000 : null;
  const orders = Array.isArray(snap?.orders) ? snap.orders : [];

  /** `underlying   expiry` → the distinct strikes quoted there. */
  const buckets = new Map<string, Set<bigint>>();

  for (const entry of orders) {
    const api = entry?.rawApiData;
    if (!api) continue;

    // The alias collapse is load-bearing: an order naming the `ETH/USD` feed
    // address and one naming `ETH` are the same instrument and the same ladder.
    const underlying = feeds.get(String(api.priceFeed ?? "").toLowerCase());
    if (!underlying) continue;

    if (!Array.isArray(api.strikes) || api.strikes.length === 0) continue;
    if (!hasSize(entry.availableAmount)) continue;

    const expiry = toSeconds(entry.order?.expiry);
    if (expiry === null) continue;

    if (now !== null) {
      if (expiry <= now) continue;
      const signature = api.orderExpiryTimestamp;
      if (typeof signature === "number" && Number.isFinite(signature) && signature <= now) continue;
    }

    const key = `${underlying} ${expiry}`;
    let rungs = buckets.get(key);
    if (!rungs) {
      rungs = new Set<bigint>();
      buckets.set(key, rungs);
    }
    for (const raw of api.strikes) {
      const units = parseStrike(raw);
      if (units === null || units <= 0n) continue;
      rungs.add(units);
    }
  }

  const ladders: StrikeLadder[] = [];
  for (const [key, rungs] of buckets) {
    const [underlying = "", expiryText = ""] = key.split(" ");
    const expiry = Number(expiryText);
    const sorted = [...rungs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (sorted.length === 0) continue;
    ladders.push({
      underlying,
      expiry,
      strikes: sorted.map(formatStrike),
      // Derived here and nowhere else, so the axis cannot disagree with the rungs.
      prices: sorted.map((u) => Number(u) / Number(STRIKE_SCALE)),
    });
  }

  ladders.sort((a, b) => a.underlying.localeCompare(b.underlying) || a.expiry - b.expiry);
  return ladders;
}

/** The one ladder a chart is drawn for, or `null` when that column is empty. */
export function deriveLadder(
  snap: LadderSnapshot | null | undefined,
  underlying: string,
  expiry: number,
  at?: number,
): StrikeLadder | null {
  return (
    deriveLadders(snap, at).find((l) => l.underlying === underlying && l.expiry === expiry) ?? null
  );
}

/**
 * The expiry selector's whole vocabulary: this underlying's real expiries,
 * ascending, and only those with enough rungs to hold a box.
 *
 * plan7 §2.2 — *there is no 2h or 4h option*. The set is roughly tomorrow, the
 * day after, then weeklies, and it comes from the book. A date that is not in
 * this array cannot be dragged to, chosen, or submitted, because
 * {@link snapBox} takes its expiry from the ladder rather than from the box.
 */
export function liveExpiries(
  snap: LadderSnapshot | null | undefined,
  underlying: string,
  at?: number,
): readonly number[] {
  return deriveLadders(snap, at)
    .filter((l) => l.underlying === underlying && l.strikes.length >= MIN_LADDER_STRIKES)
    .map((l) => l.expiry);
}

/**
 * The y-axis, in dollars — the ladder's own extent.
 *
 * plan7 §2.5: *derive the ladder first, then fit the chart to it.* A chart that
 * computes its scale from the price history instead will not line the rungs up
 * with the strikes the box snaps to.
 */
export function ladderBounds(ladder: StrikeLadder): { lo: number; hi: number } | null {
  const lo = ladder.prices[0];
  const hi = ladder.prices[ladder.prices.length - 1];
  if (lo === undefined || hi === undefined) return null;
  return { lo, hi };
}

/** The ladder as units, parsed once. Internal to the snapping math. */
function rungs(ladder: StrikeLadder): bigint[] {
  const out: bigint[] = [];
  for (const s of ladder.strikes) {
    const u = parseStrike(s);
    if (u !== null) out.push(u);
  }
  return out;
}

/** Index of an exact rung, or `-1`. */
export function ladderIndex(ladder: StrikeLadder, strike: string | bigint | null | undefined): number {
  const units = parseStrike(strike);
  if (units === null) return -1;
  return rungs(ladder).findIndex((u) => u === units);
}

/**
 * Nearest rung to a raw price, as an index. Ties resolve **downward**, so the
 * snap is deterministic on every machine — a box dropped exactly between 2550
 * and 2650 lands on 2550, always.
 */
function nearestIndex(ordered: readonly bigint[], units: bigint): number {
  let best = -1;
  let bestGap = 0n;
  for (let i = 0; i < ordered.length; i++) {
    const rung = ordered[i];
    if (rung === undefined) continue;
    const gap = rung > units ? rung - units : units - rung;
    if (best === -1 || gap < bestGap) {
      best = i;
      bestGap = gap;
    }
  }
  return best;
}

/**
 * Snap one price to the nearest live strike.
 *
 * **This is where irregularity comes from and it is not a special case.** The
 * ladder's own gaps decide the result: on `2420 · 2440 · 2460 · 2480 · 2550 ·
 * 2650`, a drag to 2500 travels $20 to 2480 while a drag to 2600 travels $50
 * to 2550. Nothing rounds to a constant increment, because the book does not
 * quote on one.
 */
export function snapStrike(
  ladder: StrikeLadder,
  raw: string | bigint | null | undefined,
): string | null {
  const ordered = rungs(ladder);
  const units = parseStrike(raw);
  if (units === null) return null;
  const i = nearestIndex(ordered, units);
  const rung = ordered[i];
  return rung === undefined ? null : formatStrike(rung);
}

/** {@link snapStrike} for a caller holding dollars rather than units. */
export function snapPrice(ladder: StrikeLadder, price: number): string | null {
  const raw = priceToStrike(price);
  return raw === null ? null : snapStrike(ladder, raw);
}

/**
 * The smallest box that can be drawn with its floor on this rung: **one rung of
 * the local ladder**, as an 8dp decimal string.
 *
 * plan7 §2.4 and §9 — *minimum box height is derived from the live ladder, not
 * a constant.* There is no `MIN_BOX_HEIGHT` in this file to import, and that is
 * the point: the answer is $500 at BTC 81000 and $3,500 at BTC 81500, on the
 * same ladder, at the same instant, because that is what the book is quoting.
 *
 * `null` when the floor is not a rung, or is the top rung and so has no box
 * above it.
 */
export function minBoxHeight(
  ladder: StrikeLadder,
  floor: string | bigint | null | undefined,
): string | null {
  const ordered = rungs(ladder);
  const i = ladderIndex(ladder, floor);
  if (i < 0 || i >= ordered.length - 1) return null;
  const here = ordered[i];
  const next = ordered[i + 1];
  if (here === undefined || next === undefined) return null;
  return formatStrike(next - here);
}

// ─────────────────────────────────────────────────────────────────────────────
// The box
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the player drew. Three numbers and a date.
 *
 * Every field is already snapped once this has come out of {@link snapBox};
 * a `Box` that has not been through the snapper is a raw drag, not a position.
 */
export interface Box {
  underlying: string;
  /** Inner zone — the band that pays maximum. `= s2`, 8dp decimal string. */
  floor: string;
  /** `= s3`. */
  ceiling: string;
  /**
   * Wing width, `s2 − s1 == s4 − s3`. Snapped, auto-set by default (plan7 §4.2).
   *
   * **This number is the maximum payout**, per contract, in dollars — a long
   * call condor pays exactly the wing width between `s2` and `s3`. Which is
   * why plan7 §4.2 insists it be readable even when it is not draggable:
   * hiding the handle is fine, hiding the consequence is not, and the
   * consequence here is the entire upside. See `condorEconomics` in
   * `src/data/condor.ts`.
   */
  wing: string;
  /** Unix seconds. One of the live expiries — never a free-dragged value. */
  expiry: number;
}

/**
 * `~25%` of the zone width, as a divisor — the softer half of the wing default.
 *
 * A zone fraction, and only that. It sizes a *wing*, which is a distance in
 * dollars; it is not a rate, a multiple or a payback, and no payout number in
 * this codebase is allowed to be a constant (plan7 §4.4).
 */
export const WING_ZONE_DIVISOR = 4n;

/**
 * Every wing width the ladder can express for this zone, ascending.
 *
 * A wing is a *distance*, measured down from `s2` and up from `s3`, and the
 * on-chain invariant is that the two are equal. So the candidates are the
 * distances the ladder itself offers at either end: `floor − rung` for every
 * rung below, and `rung − ceiling` for every rung above. Every one of these is
 * a real increment somebody is quoting, which is what "snapped" means for a
 * width on an irregular ladder — there is no constant tick to round to.
 *
 * A candidate that appears at **both** ends puts all four strikes on the
 * ladder, which is the shape the OptionBook can fill outright (plan7 §3.1); one
 * that appears at only one end still satisfies the equal-wing invariant exactly
 * and is priced through RFQ, where any strike is reachable (§3.2).
 * {@link wingLandsOnLadder} tells the execution layer which it is holding.
 */
export function wingCandidates(
  ladder: StrikeLadder,
  floor: string | bigint | null | undefined,
  ceiling: string | bigint | null | undefined,
): readonly string[] {
  const ordered = rungs(ladder);
  const lo = parseStrike(floor);
  const hi = parseStrike(ceiling);
  if (lo === null || hi === null) return [];
  const widths = new Set<bigint>();
  for (const rung of ordered) {
    if (rung < lo) widths.add(lo - rung);
    if (rung > hi) widths.add(rung - hi);
  }
  return [...widths].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(formatStrike);
}

/** True when both outer strikes land on rungs — i.e. the whole condor is listed. */
export function wingLandsOnLadder(
  ladder: StrikeLadder,
  floor: string | bigint | null | undefined,
  ceiling: string | bigint | null | undefined,
  wing: string | bigint | null | undefined,
): boolean {
  const lo = parseStrike(floor);
  const hi = parseStrike(ceiling);
  const w = parseStrike(wing);
  if (lo === null || hi === null || w === null || w <= 0n) return false;
  return ladderIndex(ladder, lo - w) >= 0 && ladderIndex(ladder, hi + w) >= 0;
}

/**
 * The wing the player gets when they have not set one: the larger of **one
 * local strike increment** and **~25% of the zone width**, snapped to a width
 * the ladder can express (plan7 §4.2).
 *
 * `max` rather than either alone, because the two fail in opposite directions.
 * A $20 zone on the dense part of the ETH ladder wants a whole rung, not $5; a
 * $230 zone spanning the whole ladder wants a quarter of itself, not the $20
 * rung it happens to start on.
 */
export function defaultWing(
  ladder: StrikeLadder,
  floor: string | bigint | null | undefined,
  ceiling: string | bigint | null | undefined,
): string | null {
  const ordered = rungs(ladder);
  const lo = parseStrike(floor);
  const hi = parseStrike(ceiling);
  if (lo === null || hi === null || hi <= lo) return null;

  // One local increment: the rung below the floor, else the rung above the
  // ceiling, else the zone itself. All three are the ladder's own numbers.
  const fi = ordered.findIndex((u) => u === lo);
  const ci = ordered.findIndex((u) => u === hi);
  const below = fi > 0 ? lo - (ordered[fi - 1] ?? lo) : 0n;
  const above = ci >= 0 && ci < ordered.length - 1 ? (ordered[ci + 1] ?? hi) - hi : 0n;
  const increment = below > 0n ? below : above > 0n ? above : hi - lo;

  const quarter = (hi - lo) / WING_ZONE_DIVISOR;
  const target = increment > quarter ? increment : quarter;
  return snapWing(ladder, lo, hi, target);
}

/**
 * Snap a wing width to one the ladder can express.
 *
 * Nearest {@link wingCandidates} entry to `target`. Ties break toward a
 * candidate that puts both outer strikes on the ladder — the fully-listed
 * condor is the one the OptionBook can fill — and then toward the narrower
 * wing, so the tie-break is deterministic rather than insertion-ordered.
 *
 * When the ladder offers no candidate at all (the zone spans the whole ladder,
 * so there is no rung outside it) the zone width itself is used. It is still a
 * ladder-derived number, it keeps `s1 > 0` for any real strike, and it keeps
 * this function total.
 */
export function snapWing(
  ladder: StrikeLadder,
  floor: string | bigint | null | undefined,
  ceiling: string | bigint | null | undefined,
  target: string | bigint | null | undefined,
): string | null {
  const lo = parseStrike(floor);
  const hi = parseStrike(ceiling);
  const want = parseStrike(target);
  if (lo === null || hi === null || hi <= lo) return null;

  const candidates = wingCandidates(ladder, lo, hi)
    .map(parseStrike)
    .filter((u): u is bigint => u !== null && u > 0n && u < lo);

  if (candidates.length === 0) {
    const fallback = hi - lo;
    return fallback > 0n && fallback < lo ? formatStrike(fallback) : null;
  }
  if (want === null || want <= 0n) return formatStrike(candidates[0] as bigint);

  let best = candidates[0] as bigint;
  let bestGap = best > want ? best - want : want - best;
  let bestListed = wingLandsOnLadder(ladder, lo, hi, best);
  for (const c of candidates.slice(1)) {
    const gap = c > want ? c - want : want - c;
    const listed = wingLandsOnLadder(ladder, lo, hi, c);
    if (gap < bestGap || (gap === bestGap && listed && !bestListed)) {
      best = c;
      bestGap = gap;
      bestListed = listed;
    }
  }
  return formatStrike(best);
}

/**
 * A raw drag → a box that exists on the book.
 *
 * Total: it never throws and always returns a `Box`. Four things happen, in
 * this order, and each is the ladder's decision rather than ours.
 *
 * 1. **Underlying and expiry come from the ladder, not the box.** This is the
 *    structural answer to plan7 §2.2 and §9's *"no free-dragged date can be
 *    submitted"*: there is no code path from a dragged date to an expiry,
 *    because the expiry is a property of the column the ladder was derived for.
 * 2. **Floor and ceiling snap to the nearest rung**, ties downward. A price
 *    that does not parse falls back to the ladder's own extremes rather than
 *    to a guess.
 * 3. **The minimum height is enforced as "at least one rung apart"** — which
 *    *is* the local minimum height, since consecutive rungs are exactly one
 *    increment apart. An inverted or collapsed box is pushed up one rung; a
 *    box collapsed onto the top rung is pulled down one instead, so the result
 *    is always a real zone.
 * 4. **The wing is snapped, or defaulted** — and it is returned on the box, in
 *    the open, because it sets the maximum payout (§4.2).
 *
 * A ladder with fewer than {@link MIN_LADDER_STRIKES} rungs cannot hold a box;
 * the underlying and expiry are still corrected so the caller's state stays
 * coherent, and {@link isPlayable} then answers `false`.
 */
export function snapBox(raw: Box, ladder: StrikeLadder): Box {
  const ordered = rungs(ladder);
  const n = ordered.length;
  if (n < MIN_LADDER_STRIKES) {
    return { ...raw, underlying: ladder.underlying, expiry: ladder.expiry };
  }

  const rawFloor = parseStrike(raw.floor);
  const rawCeiling = parseStrike(raw.ceiling);
  let fi = rawFloor === null ? 0 : nearestIndex(ordered, rawFloor);
  let ci = rawCeiling === null ? n - 1 : nearestIndex(ordered, rawCeiling);

  if (ci <= fi) {
    if (fi < n - 1) ci = fi + 1;
    else {
      fi = n - 2;
      ci = n - 1;
    }
  }

  const floor = formatStrike(ordered[fi] as bigint);
  const ceiling = formatStrike(ordered[ci] as bigint);
  const asked = parseStrike(raw.wing);
  const wing =
    (asked !== null && asked > 0n ? snapWing(ladder, floor, ceiling, asked) : null) ??
    defaultWing(ladder, floor, ceiling) ??
    "";

  return { underlying: ladder.underlying, floor, ceiling, wing, expiry: ladder.expiry };
}

/**
 * Why this box cannot be played, in one sentence, or `null` when it can.
 *
 * The reason exists so the UI can grey a control *and say why* — plan7 §2.1
 * asks for exactly that of non-tradable underlyings, and the same courtesy is
 * cheap for every other rejection. {@link isPlayable} is this function with the
 * sentence thrown away.
 */
export function boxProblem(b: Box, ladder: StrikeLadder): string | null {
  if (ladder.strikes.length < MIN_LADDER_STRIKES) return "this expiry has no strike ladder";
  if (b.underlying !== ladder.underlying) return "the box is drawn on a different underlying";
  // plan7 §2.1: `prepare_request_rfq`'s underlying enum is ETH and BTC, and
  // nothing else can be RFQ'd. Other qualified assets render greyed, with this.
  if (b.underlying !== "ETH" && b.underlying !== "BTC") {
    return `${b.underlying} has no condor market — ETH and BTC only`;
  }
  if (b.expiry !== ladder.expiry) return "the expiry is not this column's expiry";

  const fi = ladderIndex(ladder, b.floor);
  const ci = ladderIndex(ladder, b.ceiling);
  if (fi < 0) return "the floor is not a live strike";
  if (ci < 0) return "the ceiling is not a live strike";
  if (ci <= fi) return "the ceiling must sit above the floor";

  const lo = parseStrike(b.floor);
  const wing = parseStrike(b.wing);
  if (lo === null || wing === null || wing <= 0n) return "the wing width is not set";
  if (wing >= lo) return "the wing is wider than the floor";

  return null;
}

/**
 * Can this box become a condor the venue will price?
 *
 * Call this before {@link boxToCondor}, which throws on a box that cannot.
 * Everything it checks is a fact about the live ladder except the ETH/BTC
 * restriction, which is a fact about the RFQ entry point.
 */
export function isPlayable(b: Box, ladder: StrikeLadder): boolean {
  return boxProblem(b, ladder) === null;
}
