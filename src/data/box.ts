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
 * the wing default ({@link defaultWing}), the ladder's full extent
 * ({@link ladderBounds}) and the chart's y-axis ({@link chartWindow}) are all
 * pure functions **of a ladder**. A caller that computes any of them some other
 * way has reintroduced the drift.
 *
 * The y-axis and the extent were the same function until the arena was looked
 * at on a screen: a day and a half of real price movement is 4.3% wide and some
 * columns of the ladder are 28%, so the line rendered flat. {@link chartWindow}
 * is the fix and its docblock carries the measurements. The invariant survives
 * unchanged — one scale, derived from the ladder, read by everybody — because
 * what moved was the scale's *input*, not the number of scales.
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
    /**
     * Implementation address → product, keyed by **lowercase** address — the
     * chain's own registry, 46 entries on Base, carried verbatim.
     *
     * The ladder never reads it. {@link file://./ranger.ts} does, and it is the
     * only thing on a snapshot that can say what a four-strike order *is*:
     * `validateCondor` and `validateRanger` accept the identical arrays
     * (`dist/index.js:16838`, `:16871`), so the strikes decide nothing. The
     * same registry is what `classifyOrder` in `src/server/thetanuts.ts` looks
     * an order up in, and this is that map travelling rather than a second copy
     * of it.
     *
     * Optional because the frozen capture in `test/fixtures/orders.json`
     * predates our reading it, and absent is answered honestly: a snapshot with
     * no registry yields **no** listed zones, rather than a guess from the
     * strike shape.
     */
    optionImplementations?: Record<string, { name?: string | null } | null | undefined> | null;
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
    /**
     * The deployed option-implementation contract this order is an instance of
     * — **the field that says what the product actually is**, looked up in
     * `chainConfig.optionImplementations`. Read only by
     * {@link file://./ranger.ts}; the ladder is an axis and does not care what
     * product quoted a rung.
     */
    implementation?: string | null;
    /**
     * Which side the *maker* is on, as the API ships it.
     *
     * `false` means the maker is not the buyer, so the taker is — the side
     * plan7 §5 permits. Measured rather than assumed: over 9,766 settled
     * four-strike zone positions the maker is recorded on the other side
     * 5,635 times and on this one never (`docs/plan7-measurements.md` §3.2).
     *
     * The SDK derives `order.isBuyer` as the complement of this
     * (`dist/index.js:3360`); this file reads the raw field rather than the
     * derived one, because the measurements flag a suspected polarity inversion
     * in a consumer of `isBuyer` and there is no reason to inherit that
     * question here.
     */
    isLong?: boolean | null;
  } | null;
  /**
   * `previewFillOrder`'s `pricePerContract` for this order, in dollars — the
   * **only** premium the arena is allowed to show for a listed zone, and the
   * reason `LadderBookOrder.quote` exists on the far side.
   *
   * The ladder itself never reads it: an axis has no price. {@link file://./ranger.ts}
   * does, through `zoneQuote`, and that is the one reader in this repo.
   *
   * Widened and all-optional like every other field here, for the same two
   * reasons: a checked-in fixture must be assignable, and a truncated response
   * must degrade to "not quoted" rather than throw. Absent, `null` and
   * unparseable are one answer — no premium, so no multiple.
   */
  quote?: {
    /** Premium per contract, US dollars. */
    premium?: string | number | null;
    /** `numContracts > 0n` — the book-depth guard. `false` is an ordinary
     *  reading of a thin book, not an error. */
    fillable?: boolean | null;
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
 * The option expiry of an order that is **live at `at`**, or `null`.
 *
 * The whole of the liveness rule, in one place: remaining size, a readable
 * option expiry, that expiry still ahead of the clock, and a signature that has
 * not gone stale. It is exported because {@link file://./ranger.ts} must apply
 * the *same* rule — a listed zone the ladder has already dropped as dead would
 * be a fill the arena offers on an axis it is not drawing, and two copies of
 * this test would eventually disagree about which.
 *
 * @param at Wall clock in **milliseconds**. Omitted means "do not judge
 *           expiry", which keeps the function total and keeps a frozen fixture
 *           from ageing out of its own tests.
 */
export function liveExpiryOf(
  entry: LadderOrder | null | undefined,
  at?: number,
): number | null {
  if (!entry?.rawApiData) return null;
  if (!hasSize(entry.availableAmount)) return null;

  const expiry = toSeconds(entry.order?.expiry);
  if (expiry === null) return null;

  const now = typeof at === "number" && Number.isFinite(at) ? at / 1000 : null;
  if (now !== null) {
    if (expiry <= now) return null;
    const signature = entry.rawApiData.orderExpiryTimestamp;
    if (typeof signature === "number" && Number.isFinite(signature) && signature <= now) return null;
  }
  return expiry;
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
    // Size, expiry and signature staleness, all through the one rule
    // `src/data/ranger.ts` also applies — see {@link liveExpiryOf}.
    const expiry = liveExpiryOf(entry, at);
    if (expiry === null) continue;

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
 * The ladder's full extent, in dollars — the widest the chart may ever be.
 *
 * plan7 §2.5: *derive the ladder first, then fit the chart to it.* A chart that
 * computes its scale from the price history instead will not line the rungs up
 * with the strikes the box snaps to.
 *
 * This used to be the y-axis outright, and {@link chartWindow} explains at
 * length why it is now the *ceiling* on the y-axis rather than the y-axis
 * itself. It is still the only thing that decides how far out the board may
 * reach, because outside it the venue quotes nothing and there is nothing to
 * draw.
 */
export function ladderBounds(ladder: StrikeLadder): { lo: number; hi: number } | null {
  const lo = ladder.prices[0];
  const hi = ladder.prices[ladder.prices.length - 1];
  if (lo === undefined || hi === undefined) return null;
  return { lo, hi };
}

// ─────────────────────────────────────────────────────────────────────────────
// The viewport — one scale, but not the whole ladder
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The window may never hold fewer rungs than this, however deep the player
 * zooms.
 *
 * Two is the arithmetic floor — a box needs a floor and a ceiling — and three
 * is the *playable* floor, because a board showing exactly the two rungs you
 * are between offers no alternative to compare against. On a ladder with fewer
 * than three rungs the whole ladder is the window and this is simply not
 * reached.
 */
export const MIN_WINDOW_RUNGS = 3;

/**
 * The default half-height of the window, counted in the ladder's **own median
 * rung gap**.
 *
 * Three, and the number was measured rather than picked. Against the frozen
 * capture's ladders and the live 33-hour Chainlink line (ETH ranged $106.87,
 * 4.30%, on 2026-09-05), the price line's height as a fraction of the plot goes:
 *
 * ```
 *                     full ladder    steps=2    steps=3    steps=4
 *   ETH 5 Sep             46%          81%        86%        67%
 *   BTC 6 Sep             93%          91%        93%        93%
 *   BTC 5 Sep             40%          86%        57%        43%
 *   mean over the board   33%          47%        45%        38%
 * ```
 *
 * `steps=2` looks marginally better on that mean and is the wrong answer: it
 * buys the extra height by throwing prints away. It clips **46% of the last 33
 * hours** off ETH's near column and 54% off BTC 6 Sep, where `steps=3` keeps
 * 100% and 92%. A taller line drawn from half the data is not a better chart,
 * it is the same lie as rescaling, told by omission — so the default is the
 * widest setting that still makes the line legible, not the tightest one that
 * fits.
 */
export const DEFAULT_ZOOM_STEPS = 3;

/**
 * The deepest zoom, in the same unit: half-height of one median rung gap, so
 * the window spans two.
 *
 * Below this there is nothing to reveal. The rungs *are* the resolution of this
 * product — you cannot draw a box between two prices the venue does not quote —
 * so zooming past a single gap magnifies empty space and takes the neighbouring
 * rungs off the board. {@link MIN_WINDOW_RUNGS} holds the same line from the
 * other side.
 */
export const MIN_ZOOM_STEPS = 1;

/**
 * A price window over the ladder — the chart's y-axis, and the only one.
 *
 * `below` and `above` are the rungs this window is *not* showing. They exist so
 * the screen can say so and offer a way back to them: a rung that has silently
 * left the board is a strike the player can no longer draw on and was never
 * told about.
 */
export interface PriceWindow {
  lo: number;
  hi: number;
  /** Rungs beneath `lo`. */
  below: number;
  /** Rungs above `hi`. */
  above: number;
}

/**
 * The ladder's own increment: the **median** gap between consecutive rungs.
 *
 * Median rather than mean because real ladders are lopsided by construction —
 * ETH 5 Sep is `2420 · 2440 · 2460 · 2480 · 2550 · 2650`, whose gaps are
 * `20 20 20 70 100`. The mean of those is 46 and describes no part of the
 * ladder; the median is 20 and is exactly the increment the venue is quoting
 * where it is quoting densely, which is where the player is going to draw.
 *
 * `0` for a ladder with fewer than two rungs, which callers read as "there is
 * no increment here, so there is nothing to zoom into".
 */
export function ladderStep(ladder: StrikeLadder): number {
  const gaps: number[] = [];
  for (let i = 1; i < ladder.prices.length; i += 1) {
    const a = ladder.prices[i - 1];
    const b = ladder.prices[i];
    if (a === undefined || b === undefined) continue;
    const gap = b - a;
    if (Number.isFinite(gap) && gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 0;
  gaps.sort((x, y) => x - y);
  return gaps[Math.floor(gaps.length / 2)] ?? 0;
}

/**
 * The longest unbroken run of rungs no further apart than {@link ladderStep} —
 * the ladder's dense core.
 *
 * This is the ladder's own statement about where the market is, and it is the
 * anchor of last resort when nobody has told us the spot price. A maker lists
 * strikes tightly where they expect the price to be and sparsely where they do
 * not, so the tight cluster *is* the venue's opinion of the current level. It
 * costs no external input, which is the point: the board still opens somewhere
 * sensible with no spot feed at all.
 *
 * `null` on a ladder too short to have a gap.
 */
export function ladderCore(ladder: StrikeLadder): { lo: number; hi: number } | null {
  const step = ladderStep(ladder);
  const prices = ladder.prices;
  if (step <= 0 || prices.length < 2) return null;

  let bestStart = 0;
  let bestEnd = 0;
  let start = 0;
  for (let i = 1; i < prices.length; i += 1) {
    const a = prices[i - 1];
    const b = prices[i];
    if (a === undefined || b === undefined) continue;
    if (b - a > step) {
      if (i - 1 - start > bestEnd - bestStart) {
        bestStart = start;
        bestEnd = i - 1;
      }
      start = i;
    }
  }
  if (prices.length - 1 - start > bestEnd - bestStart) {
    bestStart = start;
    bestEnd = prices.length - 1;
  }
  const lo = prices[bestStart];
  const hi = prices[bestEnd];
  return lo === undefined || hi === undefined ? null : { lo, hi };
}

/**
 * The one y-axis: a window over the ladder, centred on the market.
 *
 * ## Why this replaced `ladderBounds`
 *
 * The chart's band used to be the ladder's entire extent, and the docblocks
 * said so — *"always `ladderBounds`, never anything else"*. That rule was
 * right about the thing it was defending (one scale, derived from the ladder,
 * never from the history) and wrong about the scale it picked, and the
 * difference only shows up on a screenshot.
 *
 * Measured on 2026-09-05, live: the whole 33-hour Chainlink window is **$106.87
 * on ETH and $3,440.89 on BTC — 4.3% of spot for both**. The ladder is not
 * 4.3% wide. ETH's 11 Sep column quotes three rungs, `2200 · 2650 · 2900`, so
 * its extent is $700 and a day and a half of real price movement renders as
 * **15% of the plot height** — the flat squiggle the owner reported. It is not
 * uniformly bad, which is why it survived review for so long: the same chart is
 * 46% on ETH's near column, where the rungs are $20 apart.
 *
 * So the fix is not a constant. It is to make the window a function of *how
 * finely the venue is quoting here*, which is {@link ladderStep}.
 *
 * ## The rule
 *
 * 1. `anchor` is the market: spot when it is finite and inside the ladder,
 *    otherwise the midpoint of {@link ladderCore}. `centre` overrides both and
 *    is how a player's pan reaches this function.
 * 2. Half-height is `steps × ladderStep`, floored at whatever it takes to keep
 *    {@link MIN_WINDOW_RUNGS} rungs on the board.
 * 3. The window is then **shifted, not shrunk**, to sit inside the ladder, and
 *    finally clamped to it. Shifting rather than shrinking is what keeps a box
 *    near the top of the ladder from being drawn on a two-rung board.
 * 4. `steps` at or above the ladder's own width in steps returns exactly
 *    {@link ladderBounds}. `Infinity` is therefore the documented way to ask
 *    for the old behaviour, and it is what the screen's "Fit ladder" control
 *    passes.
 *
 * ## What is still true of §2.5
 *
 * Everything that mattered. There is exactly **one** band, produced here and
 * nowhere else, and every consumer — grid rows, strike labels, the box, the
 * opponent's box, the history clip and the pointer arithmetic — reads that one
 * value. The drift §2.5 forbids is two independently computed scales, and that
 * is still impossible. What changed is this function's *input*, from "the
 * ladder's extent" to "a window over the ladder", and the ladder is still
 * derived first and still decides everything.
 *
 * ## What this costs, said plainly
 *
 * A narrower window clips more history, and `fitToLadder` clips rather than
 * rescales, so prints outside it are dropped and counted. At `steps = 3`
 * nothing on the frozen capture's ETH columns is lost that the full ladder kept
 * (100% either way); at `steps = 2` almost half the line goes. That asymmetry
 * is the whole reason {@link DEFAULT_ZOOM_STEPS} is 3, and a player who zooms
 * deeper is shown the count of what they are no longer seeing.
 *
 * ## Determinism between two seats
 *
 * The default board is a pure function of the ladder and the anchor, so two
 * players holding the same snapshot open on the same board. Spot ticks, so the
 * anchor is **snapped to a rung by the caller** before it arrives here: the
 * window then moves only when spot crosses a rung midpoint — $20 to $100 of
 * travel, not a cent — instead of drifting under the cursor. Two seats can
 * still disagree within one rung of a crossing, and when they do they disagree
 * about the *viewport only*. The box, its strikes, its wing, its expiry and the
 * string `encodeBoxPick` produces contain no viewport term at all, which is the
 * property that actually has to hold.
 *
 * Total: never throws, and returns a usable window for a one-rung ladder
 * (`lo === hi`, which {@link file://../views/BoxBuilder.tsx} `yPct` renders on
 * the middle line rather than dividing by zero).
 */
export function chartWindow(
  ladder: StrikeLadder,
  anchor: number | null | undefined,
  steps: number = DEFAULT_ZOOM_STEPS,
  centre?: number | null,
): PriceWindow | null {
  const full = ladderBounds(ladder);
  if (!full) return null;

  const prices = ladder.prices;
  const outside = (lo: number, hi: number): PriceWindow => ({
    lo,
    hi,
    below: prices.filter((p) => p < lo).length,
    above: prices.filter((p) => p > hi).length,
  });

  const step = ladderStep(ladder);
  // No increment means one rung, or a ladder that lost its extremes. Either
  // way there is no window narrower than the whole of it.
  if (step <= 0 || !Number.isFinite(steps) || steps <= 0) return outside(full.lo, full.hi);

  const core = ladderCore(ladder);
  const fallback = core ? (core.lo + core.hi) / 2 : (full.lo + full.hi) / 2;
  const wanted =
    typeof centre === "number" && Number.isFinite(centre)
      ? centre
      : typeof anchor === "number" && Number.isFinite(anchor) && anchor >= full.lo && anchor <= full.hi
        ? anchor
        : fallback;

  // The min-rungs floor is measured from the anchor, so it is the distance to
  // the MIN_WINDOW_RUNGS-th nearest rung — the smallest window that can still
  // hold that many.
  const gaps = prices
    .map((p) => Math.abs(p - wanted))
    .sort((x, y) => x - y);
  const floor = gaps[Math.min(MIN_WINDOW_RUNGS, gaps.length) - 1] ?? 0;
  const half = Math.max(steps * step, floor);
  if (!Number.isFinite(half) || half <= 0) return outside(full.lo, full.hi);

  let lo = wanted - half;
  let hi = wanted + half;
  // Shift, then clamp. A window pushed off the bottom of the ladder keeps its
  // height by sliding up, and only gives height back when the ladder itself is
  // shorter than the window.
  if (lo < full.lo) {
    hi = Math.min(full.hi, hi + (full.lo - lo));
    lo = full.lo;
  }
  if (hi > full.hi) {
    lo = Math.max(full.lo, lo - (hi - full.hi));
    hi = full.hi;
  }
  return outside(lo, hi);
}

/**
 * The `steps` at which the window is the whole ladder — the shallowest zoom
 * worth offering.
 *
 * There is nothing above it: the ladder is the extent of what the venue quotes,
 * so a wider view would be empty space with no rung in it and no box drawable
 * anywhere. The screen clamps its zoom control to this, which is why zooming
 * out cannot strand a player in a region where nothing is listed.
 */
export function maxZoomSteps(ladder: StrikeLadder): number {
  const full = ladderBounds(ladder);
  const step = ladderStep(ladder);
  if (!full || step <= 0) return MIN_ZOOM_STEPS;
  return Math.max(MIN_ZOOM_STEPS, (full.hi - full.lo) / (2 * step));
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
 * ladder; one that appears at only one end still satisfies the equal-wing
 * invariant exactly. Either is priced on demand by a maker, where any strike is
 * reachable (plan7 §3.2).
 *
 * **Four listed strikes are not a listed structure**, and this used to be read
 * as though they were. The OptionBook has never carried a single condor — not
 * one, in 15,740 positions (`docs/plan7-measurements.md` §3.3) — so a box whose
 * four corners each sit on a rung is still an instrument nobody has created.
 * The only question that answers "can this fill off the book" is whether a
 * matching order is resting there, which is `matchListedZone` in
 * {@link file://./ranger.ts} and not anything in this file.
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

/**
 * True when both outer strikes land on rungs.
 *
 * A statement about the *ladder*, and only that: it says every one of the four
 * strikes is a level the venue quotes somewhere. It does **not** say the
 * structure is listed, and it must not be rendered as though it did — see
 * {@link wingCandidates}. It survives because it is a genuinely useful tie-break
 * for {@link snapWing}: a wing the ladder can express at both ends is the one a
 * maker is most likely to price.
 */
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
 * candidate that puts both outer strikes on the ladder — every strike a level
 * the venue already quotes is the wing a maker is likeliest to price — and then
 * toward the narrower wing, so the tie-break is deterministic rather than
 * insertion-ordered.
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
