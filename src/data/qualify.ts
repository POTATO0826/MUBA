/**
 * The asset gate — which underlyings the game may actually deal today.
 *
 * Thetanuts is an **altcoin options protocol**. Any code that hardcodes
 * `"ETH" | "BTC"` has mistaken one quote source for the whole market. There are
 * three different asset sets on Base and they are not the same size
 * (`tnuts-test/FINDINGS.md` §3):
 *
 * | Set | Members | What it means |
 * |---|---|---|
 * | Price feeds (8) | ETH BTC SOL DOGE XRP BNB PAXG AVAX | a Chainlink feed exists |
 * | Market prices (7) | the above, minus PAXG | spot is readable |
 * | MM pricing (2) | ETH BTC | market makers stream two-sided quotes |
 *
 * **MM pricing is not the gate.** It is a *quality* signal. The resting order
 * book (`fetchOrders`) is a separate source that covers more assets — AVAX is
 * on the board today, bid-only — so gating on MM pricing would silently
 * amputate the protocol's own breadth. It grades instead: see {@link Grade}.
 *
 * ## Why this is a probe and not a list
 *
 * A hardcoded qualified set goes stale by construction, and that is exactly the
 * bug that made AVAX the broken default asset: a name on a list is not a book.
 * Everything here is a *measurement* of one captured response, which is why it
 * can be run in front of a room (`scripts/probe-assets.ts`) rather than
 * asserted at one.
 *
 * ## Pure, and outside the engine guard
 *
 * No clock, no socket, no module state — `at` is an argument, the book is an
 * argument. `test/determinism.test.ts` bans `src/engine/**` from importing live
 * market sources; this module lives in `src/data/` and is *injected* into the
 * engine as a value (plan6 §B4), never imported by it. It also imports nothing
 * from `src/server/thetanuts.ts`: that module pulls in the SDK and ethers at
 * the top level, and this one is meant to be free to run anywhere, including a
 * browser bundle.
 *
 * @see plan6-real-parlay.md §7
 */

// ─────────────────────────────────────────────────────────────────────────────
// The thresholds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimum fillable resting orders on an asset.
 *
 * Six is "enough for ≥1 card in ≥3 tiers": the parlay deals cards out of delta
 * buckets, and a book of two orders collapses to one bucket and one card, which
 * is a round with no choice in it.
 */
export const MIN_ORDERS = 6;

/**
 * Minimum orders carrying a usable delta.
 *
 * Below this the delta buckets come out empty. A row with no delta cannot be
 * bucketed into a tier at all — `rawApiData.greeks` is **undocumented**
 * (FINDINGS §5.7), it is genuinely absent on live orders (5 of the 14 BTC
 * orders in the frozen capture have `delta: null`), and a tier assembled from
 * rows we cannot bucket is a tier we invented.
 */
export const MIN_GREEKED = 4;

/**
 * Minimum summed fillable depth, in USD.
 *
 * 25 × `MAX_FILL_USDC` ($2, `src/desk/fill.ts`) — a fill must not move the book
 * it was quoted from. **This is the condition that is cheap to skip and
 * expensive to skip.** An asset backed by $3 of resting depth previews fine,
 * fills partially or not at all, and turns a duel into a support ticket. The
 * other three conditions fail loudly in a test; this one fails quietly in front
 * of a player.
 */
export const MIN_DEPTH_USDC = 50;

// ─────────────────────────────────────────────────────────────────────────────
// Output shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How good a qualified asset's book is — a difficulty label, never a gate.
 *
 * - `DEEP` — has MM pricing. All 8 cards usually dealt, tight spreads.
 * - `THIN` — resting orders and greeks, no MM pricing. 3–6 cards, wider
 *   spreads, one side may be missing.
 *
 * A THIN asset is a harder round, not a broken one, and it is the kind of
 * difficulty that teaches something true about liquidity. Render it on the
 * lobby card and the slice reveal rather than hiding it.
 */
export type Grade = "DEEP" | "THIN";

/**
 * Which of the four conditions an asset failed. All four are necessary, so a
 * report may carry more than one.
 *
 * - `SPOT`   — no readable market price (this is what excludes PAXG)
 * - `ORDERS` — fewer than {@link MIN_ORDERS} fillable resting orders
 * - `GREEKS` — fewer than {@link MIN_GREEKED} of them carry a usable delta
 * - `DEPTH`  — summed fillable depth below {@link MIN_DEPTH_USDC}
 */
export type FailedCondition = "SPOT" | "ORDERS" | "GREEKS" | "DEPTH";

/** Human sentences for {@link FailedCondition}, so the lobby can say *why* a
 *  sector is greyed instead of just greying it. */
export const CONDITION_REASON: Record<FailedCondition, string> = {
  SPOT: "no market price",
  ORDERS: "not enough resting orders",
  GREEKS: "no usable deltas",
  DEPTH: "not enough depth",
};

/** One asset, measured. Produced for every price-feed asset, qualified or not —
 *  the rejects are the interesting half of the probe output. */
export interface AssetReport {
  /** The bare symbol, aliases already collapsed: `ETH`, never `ETH/USD`. */
  underlying: string;
  /** The Chainlink feed address the alias collapse keyed on, lowercased. */
  feed: string;
  /** USD spot from `getMarketData().prices`, or `null` when absent. PAXG has a
   *  price feed and no market price, so this is `null` rather than `0`. */
  spot: number | null;
  /** Fillable resting orders — condition 2. */
  orders: number;
  /** Of those, how many carry a usable delta — condition 3. */
  greeked: number;
  /** Summed fillable depth in USD — condition 4. Collateral is valued, not
   *  counted: four tokens at three decimal scales are live on this book. */
  depthUsd: number;
  /** Whether `getPricingArray` returned rows for this asset. Grades, never
   *  gates. */
  mmPricing: boolean;
  /** Empty when the asset qualifies. */
  failed: readonly FailedCondition[];
  qualified: boolean;
  /** Only meaningful when {@link qualified}. `THIN` for a rejected asset is not
   *  a claim about it. */
  grade: Grade;
}

/** A qualified asset, with the grade the UI renders beside it. */
export interface QualifiedAsset {
  underlying: string;
  grade: Grade;
  spot: number;
  orders: number;
  greeked: number;
  depthUsd: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Input shape
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What the gate reads: one **raw** `fetchOrders()` + `getMarketData()` capture,
 * plus the bundled chain config. `test/fixtures/orders.json` is exactly this.
 *
 * ## Why raw, and not the built `MarketSnapshot`
 *
 * Two of the four conditions are unanswerable after `buildSnapshot`:
 *
 *  - `availableAmount` (condition 4) is aggregated into a per-level `size`
 *    string (`"10.0k"`) and a 0–100 bar width. Neither sums back to dollars.
 *  - `rawApiData.priceFeed` (the alias collapse) is resolved to a symbol and
 *    discarded, so a dedupe *by address* is no longer possible — the built
 *    snapshot has already made that decision and there is nothing left to check.
 *
 * A built snapshot also trims its `orders` to the 40 rows the blotter ships, so
 * counting them would measure the view, not the book.
 *
 * Every field is optional and every type is widened, so that (a) the real
 * `RawMarket` from `src/server/thetanuts.ts` is structurally assignable with no
 * import and no adapter — `test/qualify.test.ts` asserts that at compile time —
 * and (b) a truncated or garbage response degrades to `[]` instead of throwing.
 */
export interface QualifySnapshot {
  orders?: readonly QualifyOrder[] | null;
  /** `getMarketData().prices` — USD spot per asset. */
  prices?: Record<string, unknown> | null;
  chainConfig?: {
    /** 10 keys over 8 assets: `ETH/USD` and `ETH` are the *same address*. */
    priceFeeds?: Record<string, string> | null;
    tokens?: Record<string, { address?: string; symbol?: string; decimals?: number }> | null;
  } | null;
  /** `getPricingArray` output per underlying. A non-empty array grades the
   *  asset `DEEP`. Absent means the pricing host was unreachable, which grades
   *  everything `THIN` — a degradation, and an honest one: we cannot claim a
   *  tight two-sided book we did not read. */
  mmPricing?: Record<string, readonly unknown[] | null | undefined> | null;
}

/** One entry of `fetchOrders()`, narrowed to the five fields the gate reads. */
export interface QualifyOrder {
  /** Remaining fillable size, in **collateral** units (6dp for USDC, 18dp for
   *  aBasWETH, 8dp for cbBTC). Not a contract count. */
  availableAmount?: string | bigint | number | null;
  rawApiData?: {
    collateral?: string;
    /** The Chainlink feed address — how an order names its underlying. */
    priceFeed?: string;
    strikes?: readonly string[] | null;
    orderExpiryTimestamp?: number;
    /** Undocumented. Shape-checked here, never trusted. */
    greeks?: unknown;
  } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Alias collapse — this happens first, or ETH appears twice
// ─────────────────────────────────────────────────────────────────────────────

/** `ETH/USD` → `ETH`. The alias suffix is the only thing that differs. */
function bare(symbol: string): string {
  return symbol.replace(/\/USD$/i, "");
}

/**
 * Feed address → one symbol, deduplicated **by address**.
 *
 * `priceFeeds` has 10 keys over 8 distinct assets: `ETH/USD` and `ETH` hold the
 * *identical* address, likewise BTC (FINDINGS §5.6). Deduplicating by key would
 * put ETH on the reel twice and make it twice as likely to be dealt — a silent
 * bias in what the game offers, introduced by a naming convention in someone
 * else's config.
 *
 * The bare symbol wins the collision, so orders resolve to `ETH` rather than
 * `ETH/USD`. Insertion order of the first key to claim an address is preserved,
 * which is what makes the probe table's row order deterministic.
 *
 * Mirrors `feedSymbols` in `src/server/thetanuts.ts` deliberately rather than
 * importing it: that module loads the SDK and ethers at the top level, and this
 * one must stay free of both. The two are asserted equivalent in
 * `test/qualify.test.ts`.
 */
export function feedIndex(feeds: Record<string, string> | null | undefined): Map<string, string> {
  const byAddress = new Map<string, string>();
  for (const [symbol, address] of Object.entries(feeds ?? {})) {
    if (typeof address !== "string" || address === "") continue;
    const key = address.toLowerCase();
    const name = bare(String(symbol));
    const held = byAddress.get(key);
    // Shorter wins: `ETH` over `ETH/USD` even if the alias was listed first.
    if (held === undefined || name.length < held.length) byAddress.set(key, name);
  }
  return byAddress;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Default when a collateral token is not in the chain config: USDC's 6dp. */
const FALLBACK_COLLATERAL_DECIMALS = 6;

/**
 * `"10000000000"` at 6dp → `10000`. Total: garbage yields `0`, never a throw
 * and never `NaN`. `BigInt("1.5")` throws and `BigInt(null)` returns `0n`, so
 * neither is trusted without the guard.
 */
function fromUnits(raw: string | bigint | number | null | undefined, decimals: number): number {
  if (raw === null || raw === undefined) return 0;
  let units: number;
  try {
    units = typeof raw === "number" ? raw : Number(BigInt(raw));
  } catch {
    units = Number(raw);
  }
  if (!Number.isFinite(units) || units <= 0) return 0;
  const scale = Number.isFinite(decimals) && decimals >= 0 && decimals <= 36 ? decimals : FALLBACK_COLLATERAL_DECIMALS;
  return units / 10 ** scale;
}

/** Collateral token address → its decimals and USD value per unit. `usd: null`
 *  is "we could not price this token", which is counted at face value by the
 *  caller and is a different statement from "it is worth a dollar". */
interface CollateralToken {
  decimals: number;
  usd: number | null;
}

/**
 * Value the collateral, do not count it.
 *
 * Four collateral tokens are live on this book at three decimal scales, and
 * `availableAmount` is denominated in whichever one the maker posted. Summing
 * the integers directly would make 3.96 aBasWETH (`3962153509675578870`) look
 * like four quintillion dollars of depth and qualify a dead asset.
 *
 * Strip the Aave-on-Base `aBas` wrapper, then a `cb`/`W` wrapper prefix, and
 * look the rest up in the live spot map. Anything still naming USD is a dollar.
 * A token we cannot price is counted at face value — wrong units, but it is the
 * conservative direction only for stables, so it is recorded and not relied on.
 */
function collateralIndex(
  tokens: Record<string, { address?: string; symbol?: string; decimals?: number }> | null | undefined,
  spot: Record<string, number>,
): Map<string, CollateralToken> {
  const out = new Map<string, CollateralToken>();
  for (const token of Object.values(tokens ?? {})) {
    const address = token?.address;
    if (typeof address !== "string" || address === "") continue;
    const symbol = String(token?.symbol ?? "");
    const stripped = symbol.replace(/^aBas/, "").replace(/^(cb|W)/, "").toUpperCase();
    const price = spot[stripped];
    const usd =
      typeof price === "number" && Number.isFinite(price) && price > 0
        ? price
        : symbol.toUpperCase().includes("USD")
          ? 1
          : null;
    const decimals =
      typeof token?.decimals === "number" && Number.isFinite(token.decimals)
        ? token.decimals
        : FALLBACK_COLLATERAL_DECIMALS;
    out.set(address.toLowerCase(), { decimals, usd });
  }
  return out;
}

/**
 * A delta we can bucket a card with, or `null`.
 *
 * `rawApiData.greeks` is undocumented — the shipped `.d.ts` types it, the docs
 * never mention it, so nothing obliges it to keep its shape. Three rejections,
 * all of which have shipped from some API somewhere: a non-number, a
 * non-finite number (`NaN` out of a bad divide, `Infinity`), and a magnitude
 * above 1, which no vanilla or spread delta can hold and which would land the
 * card in a tier that does not exist.
 *
 * `0` is accepted. A far-OTM option really does have a delta of zero, and that
 * is a bucket, not a missing value.
 */
export function usableDelta(greeks: unknown): number | null {
  if (!greeks || typeof greeks !== "object") return null;
  const delta = (greeks as { delta?: unknown }).delta;
  if (typeof delta !== "number" || !Number.isFinite(delta)) return null;
  if (Math.abs(delta) > 1) return null;
  return delta;
}

/**
 * `getMarketData().prices`, normalised: alias keys collapsed, non-numbers
 * dropped, non-positive prices dropped. A spot of `0` is not a readable price,
 * it is a broken feed, and pricing a card off it divides by zero.
 */
function spotIndex(prices: Record<string, unknown> | null | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [symbol, value] of Object.entries(prices ?? {})) {
    const price =
      typeof value === "number" ? value : Number((value as { price?: unknown } | null)?.price);
    if (!Number.isFinite(price) || price <= 0) continue;
    const name = bare(String(symbol));
    // First writer wins so an alias cannot overwrite the bare key's price.
    if (out[name] === undefined) out[name] = price;
  }
  return out;
}

/** MM pricing per underlying, alias keys collapsed. `true` only for a
 *  non-empty array: `getPricingArray` returns `[]` rather than throwing for the
 *  six unsupported assets (FINDINGS §5.5), so emptiness is the signal. */
function mmIndex(
  mmPricing: Record<string, readonly unknown[] | null | undefined> | null | undefined,
): Set<string> {
  const out = new Set<string>();
  for (const [symbol, rows] of Object.entries(mmPricing ?? {})) {
    if (Array.isArray(rows) && rows.length > 0) out.add(bare(String(symbol)));
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The gate
// ─────────────────────────────────────────────────────────────────────────────

/** Running tally per asset while the orders are walked. */
interface Tally {
  orders: number;
  greeked: number;
  depthUsd: number;
}

/**
 * Every price-feed asset, measured against the book — qualified and rejected
 * alike, with the conditions each rejection failed.
 *
 * This is the function `scripts/probe-assets.ts` prints and the one the lobby
 * reads to grey a sector *with a reason*. {@link qualifiedUnderlyings} is a
 * projection of it.
 *
 * @param snap One raw capture. Anything unusable degrades to `[]`.
 * @param at   Optional wall clock in **milliseconds**. When supplied, orders
 *             whose `orderExpiryTimestamp` has passed are not counted as
 *             fillable — filling a stale order reverts `Signer Not Authorized`,
 *             so an asset propped up by expired orders is not playable. Omitted
 *             means "do not judge expiry", which keeps the function total and
 *             keeps a frozen fixture from ageing out of its own tests.
 */
export function probeAssets(
  snap: QualifySnapshot | null | undefined,
  at?: number,
): readonly AssetReport[] {
  const feeds = feedIndex(snap?.chainConfig?.priceFeeds);
  if (feeds.size === 0) return [];

  const spot = spotIndex(snap?.prices);
  const tokens = collateralIndex(snap?.chainConfig?.tokens, spot);
  const mm = mmIndex(snap?.mmPricing);
  const expiredBefore = typeof at === "number" && Number.isFinite(at) ? at / 1000 : null;

  // Seeded from the feed map so an asset with zero orders still gets a row.
  // A silently missing asset and a rejected one are different claims, and the
  // rejected one is the useful one.
  const tally = new Map<string, Tally>();
  for (const symbol of feeds.values()) {
    if (!tally.has(symbol)) tally.set(symbol, { orders: 0, greeked: 0, depthUsd: 0 });
  }

  const orders = Array.isArray(snap?.orders) ? snap.orders : [];
  for (const entry of orders) {
    const api = entry?.rawApiData;
    if (!api) continue;

    // The alias collapse is load-bearing right here: an order naming the
    // `ETH/USD` address and one naming `ETH` are the same instrument, and both
    // must land in the same tally.
    const symbol = feeds.get(String(api.priceFeed ?? "").toLowerCase());
    if (!symbol) continue;

    // Fillable, four ways. Each of these is an order the book will serve and a
    // fill will not get:
    //   - no strike: names no instrument (`buildSnapshot` skips these too)
    //   - no remaining collateral: nothing left to take
    //   - past its own expiry: reverts `Signer Not Authorized`
    if (!Array.isArray(api.strikes) || api.strikes.length === 0) continue;
    if (expiredBefore !== null) {
      const expiry = api.orderExpiryTimestamp;
      if (typeof expiry === "number" && Number.isFinite(expiry) && expiry <= expiredBefore) continue;
    }
    const token = tokens.get(String(api.collateral ?? "").toLowerCase());
    const usd = fromUnits(entry.availableAmount, token?.decimals ?? FALLBACK_COLLATERAL_DECIMALS) * (token?.usd ?? 1);
    if (usd <= 0) continue;

    const row = tally.get(symbol) ?? { orders: 0, greeked: 0, depthUsd: 0 };
    row.orders += 1;
    row.depthUsd += usd;
    if (usableDelta(api.greeks) !== null) row.greeked += 1;
    tally.set(symbol, row);
  }

  const reports: AssetReport[] = [];
  const seen = new Set<string>();
  for (const [feed, symbol] of feeds) {
    // Two feed keys, one address, one row — the dedupe, made visible.
    if (seen.has(symbol)) continue;
    seen.add(symbol);

    const row = tally.get(symbol) ?? { orders: 0, greeked: 0, depthUsd: 0 };
    const price = spot[symbol];
    const readable = typeof price === "number" && Number.isFinite(price) && price > 0;

    // All four are necessary. They are collected rather than short-circuited so
    // the probe can say everything that is wrong with an asset in one pass —
    // "no market price" and "no orders either" is a different story from
    // "priced, quoted, and $3 deep".
    const failed: FailedCondition[] = [];
    if (!readable) failed.push("SPOT");
    if (row.orders < MIN_ORDERS) failed.push("ORDERS");
    if (row.greeked < MIN_GREEKED) failed.push("GREEKS");
    if (row.depthUsd < MIN_DEPTH_USDC) failed.push("DEPTH");

    reports.push({
      underlying: symbol,
      feed,
      spot: readable ? price : null,
      orders: row.orders,
      greeked: row.greeked,
      // 2dp: this is dollars, and a depth figure printed to 14 decimals in a
      // demo reads as a number nobody checked.
      depthUsd: Math.round(row.depthUsd * 100) / 100,
      mmPricing: mm.has(symbol),
      failed,
      qualified: failed.length === 0,
      grade: mm.has(symbol) ? "DEEP" : "THIN",
    });
  }
  return reports;
}

/**
 * The graded, qualified set — what a lobby offers and what the reel deals from.
 *
 * An asset is playable this round if the live book can actually produce cards
 * for it. Four conditions, all necessary, checked against the snapshot:
 *
 *   1. spot is readable       — `getMarketData().prices` has it (excludes PAXG)
 *   2. resting orders exist   — at least {@link MIN_ORDERS} fillable orders
 *   3. greeks are present     — on at least {@link MIN_GREEKED} of them, because
 *                               a row with no delta cannot be bucketed into a tier
 *   4. depth is real          — summed `availableAmount` ≥ {@link MIN_DEPTH_USDC}
 */
export function qualifiedAssets(
  snap: QualifySnapshot | null | undefined,
  at?: number,
): readonly QualifiedAsset[] {
  return probeAssets(snap, at)
    .filter((r) => r.qualified)
    .map((r) => ({
      underlying: r.underlying,
      grade: r.grade,
      spot: r.spot ?? 0,
      orders: r.orders,
      greeked: r.greeked,
      depthUsd: r.depthUsd,
    }));
}

/**
 * The names only — the argument `spinSlice(book, qualified, seed)` takes.
 *
 * The engine never decides which assets exist. That is a fact about the book,
 * and the book is injected.
 */
export function qualifiedUnderlyings(
  snap: QualifySnapshot | null | undefined,
  at?: number,
): readonly string[] {
  return qualifiedAssets(snap, at).map((a) => a.underlying);
}

/** The grade of one underlying, or `null` when it did not qualify. For a lobby
 *  card that already knows its asset and only wants the badge. */
export function gradeOf(
  snap: QualifySnapshot | null | undefined,
  underlying: string,
  at?: number,
): Grade | null {
  const found = probeAssets(snap, at).find((r) => r.underlying === underlying);
  return found?.qualified ? found.grade : null;
}
