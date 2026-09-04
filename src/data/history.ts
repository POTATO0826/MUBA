/**
 * Price history behind the box builder's strike grid — read from Chainlink on
 * Base, which is the feed that settles the option.
 *
 * ## Why this file exists at all
 *
 * The Thetanuts SDK has no candles. It publishes current spot
 * (`getMarketData().prices`, already carried by `MarketSource.spot`) and a
 * forward-only websocket, and nothing else. Plan 7 §2.5 lists three ways to get
 * the line that goes behind the strike ladder:
 *
 *   1. a public exchange API (Binance, Coinbase) — easiest, third-party;
 *   2. Chainlink historical rounds on Base — the settlement oracle itself;
 *   3. spot polled forward from session start — empty on first load.
 *
 * **This module implements (2), and the reason is not purity.** A condor
 * settles against a Chainlink print. If the chart behind the box is drawn from
 * Binance, then on a fast wick the picture a player drew against and the number
 * that decided the duel are two different numbers, and the difference is not
 * theoretical — it is a support message from someone who watched their box get
 * hit on screen and lose on chain. Drawing the same feed that settles removes
 * the whole class of that complaint.
 *
 * ## The honest disagreement, stated where it cannot be missed
 *
 * Same feed is not the same number. `SETTLEMENT_NOTE` below is the sentence the
 * UI must be able to show, and here is the mechanism behind it: Thetanuts does
 * not read the aggregator's spot answer at expiry, it reads it through
 * `HistoricalPriceConsumerV3_TWAP` — `chainConfig.twapConsumer`, which on Base
 * is `0xE909fb38767e0ac5F7a347DF9Dd4222217E10816` — and that consumer smooths
 * the print over a per-option TWAP window (`getTWAP` / `getTwapPeriod` in the
 * SDK, §2.3). So:
 *
 *   - the aggregator answers this module draws ARE the settlement inputs;
 *   - the settlement print is a *time-weighted average* of them, not the last
 *     one, so a chart tick and a settlement can still differ at the margin;
 *   - and the smoothing exists precisely to make the last tick un-manipulable,
 *     which is a feature, not drift.
 *
 * That is the most defensible chart available short of drawing the TWAP itself,
 * which cannot be done without an option address per point.
 *
 * ## How the history is actually read, and what it costs
 *
 * Measured against Base mainnet (`https://mainnet.base.org`, 4 Sep 2026):
 *
 *   - `getRoundData` walking round ids backwards works and decodes correctly,
 *     but it is **one `eth_call` per point**, and the public Base RPC caps JSON
 *     batches at 10 (`-32014 maximum 10 calls in 1 batch`) and rate-limits hard
 *     (`-32016 over rate limit` on 117 of 119 calls issued over 3.6s). A
 *     120-point chart that way is a rate-limit incident per player.
 *   - The same rounds are emitted by the underlying aggregator as
 *     `AnswerUpdated(int256 indexed answer, uint256 indexed roundId, uint256
 *     updatedAt)`. **One `eth_getLogs` returns a whole window of them.** Base's
 *     public RPC caps a log range at 10,000 blocks (`-32614`), which at 2s
 *     blocks is ~5.5 hours per call. Six windows returned 290 ETH points over
 *     32.9 hours in ~2.9s, and 395 BTC points over the same span.
 *
 * So logs are the transport and the round walk is the fallback, and both read
 * the identical rounds — `decodeAnswerUpdated` and `decodeRoundData` are two
 * decoders over one source of truth, not two sources. Run through this module
 * against the same endpoint, the difference is stark and reproducible: the log
 * path spent **9 calls for 291 ETH points over 33.2 hours**, the forced round
 * walk **41 calls for 9 points over 1.8 hours** (31 of 40 rounds throttled).
 *
 * **Cost per chart: `3 + windows` RPC calls** (decimals, aggregator, block
 * number, then one per window), default 9, cached for `HISTORY_TTL_MS`.
 * Granularity is *measured and reported* rather than claimed: Chainlink updates
 * on a deviation threshold with a heartbeat ceiling, so the gaps are irregular
 * by construction — 270s median and 1232s max for ETH in the capture above.
 * `meta.granularity` carries what this particular read actually got.
 *
 * ## Three rules this module keeps
 *
 * **It never throws at the boundary.** `history()` always resolves to a
 * `PriceHistory`; a dead RPC is `ok: false` with an empty `points` and a note,
 * exactly as `createMarketService` and `createNewsService` answer 200 with a
 * typed envelope. A chart that cannot be drawn must cost the screen its chart
 * and nothing else — the ladder, the box and the quote are all independent of
 * this file.
 *
 * **It is scale-agnostic.** §2.5: the ladder is derived first and the chart is
 * fitted to it. Nothing here computes an axis. `observed` reports the range the
 * data happens to occupy, labelled descriptive, and `fitToLadder` reports what
 * falls outside a band the *caller* chose. If this module ever grows a `scale`,
 * `ticks` or `domain` export, the chart and the ladder have started computing
 * two axes and they will drift by a pixel.
 *
 * **It is context, not a control.** No export here returns a strike, a box, a
 * price band or an expiry, and nothing in a player's position may be derived
 * from a point on this line. `test/history.test.ts` freezes the export list so
 * that stays true by accident-proof rather than by intention.
 *
 * ## Where it runs
 *
 * In the browser, directly. The Base public RPC answers preflight `204` with
 * `access-control-allow-origin: *` (verified), so unlike
 * `pricing.thetanuts.finance` this needs no server route — which matters,
 * because the Thetanuts SDK must never enter the client bundle
 * (`src/data/thetanuts.tsx`) and this module imports nothing at all. A server
 * caller that holds a private endpoint passes it as `rpcUrl`; this file reads
 * no environment variable, so `test/secrets.test.ts` has nothing to catch.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Provenance — the two strings a screen showing this data must be able to print
// ─────────────────────────────────────────────────────────────────────────────

/** Names the feed. §9 requires the price source to be named, not implied. */
export const PRICE_SOURCE = "Chainlink · Base 8453";

/**
 * The settlement-feed disagreement, acknowledged in one sentence a player can
 * read. §9 requires this to be said out loud somewhere; saying it here means
 * every surface that draws the line has it to hand and none of them has to
 * invent its own wording.
 */
export const SETTLEMENT_NOTE =
  "Chart and settlement read the same Chainlink feed. Settlement takes a TWAP of it, so the last tick and the settlement print can differ slightly.";

// ─────────────────────────────────────────────────────────────────────────────
// Tuning — every one of these is a measurement, not a preference
// ─────────────────────────────────────────────────────────────────────────────

/** Base public RPC: `eth_getLogs is limited to a 10,000 range` (`-32614`). */
export const WINDOW_BLOCKS = 10_000;

/** ~2s blocks, so one window is ~5.5h and six is ~33h — a day and a half of
 *  context behind expiries that are 1–20 days out. */
export const DEFAULT_WINDOWS = 6;

/** A ceiling on what any caller can ask for. Twelve windows is ~66h for 15 RPC
 *  calls; past that the public endpoint starts throttling and the chart is not
 *  worth an outage. */
export const MAX_WINDOWS = 12;

/**
 * Points the `rounds` fallback will fetch, and the batch it fetches them in.
 *
 * Deliberately shallow. One `eth_call` per point plus a documented batch cap of
 * 10 and an aggressive rate limiter is why this path is a fallback: 40 points
 * is a usable line, 120 is a rate-limit incident.
 */
export const ROUND_BUDGET = 40;
export const ROUND_BATCH = 5;

/** Chainlink prints every few minutes at best; polling faster than this asks
 *  the chain for an answer it has not changed. */
export const HISTORY_TTL_MS = 60_000;

/** The public endpoint. Public by construction — no key, no secret, and CORS
 *  open, which is what lets the browser read it with no route of ours in the
 *  middle. A server caller passes its own through `deps.rpcUrl`. */
export const DEFAULT_RPC_URL = "https://mainnet.base.org";

// Function selectors, computed with `ethers.id(...)` and verified against Base.
// `aggregator()` is `0x245a7bfc`; `0xf9120af6` is `setAggregator(address)` and
// reverts, which is a cheap mistake to make and an expensive one to debug.
const SEL_DECIMALS = "0x313ce567";
const SEL_AGGREGATOR = "0x245a7bfc";
const SEL_LATEST_ROUND = "0xfeaf968c";
const SEL_GET_ROUND = "0x9a6fc8f5";

/** `keccak256("AnswerUpdated(int256,uint256,uint256)")`. */
export const ANSWER_UPDATED_TOPIC =
  "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f";

/**
 * `chainConfig.priceFeeds` for Base 8453, mirrored.
 *
 * The SDK's chain config is the authority and this is a copy of it, which is
 * ordinarily how a list goes stale — so it does not get to be trusted on its
 * own. `test/history.test.ts` imports `CHAIN_CONFIGS_BY_ID[8453].priceFeeds`
 * from the SDK and asserts this table equals it key for key; the day Thetanuts
 * rotates a feed, that test fails rather than this chart quietly drawing the
 * wrong asset.
 *
 * The copy exists because the SDK may not be imported by client code — it pulls
 * axios, viem and ethers, ~1MB the browser bundle does not carry
 * (`src/data/thetanuts.tsx`). Any caller that *does* hold a real `chainConfig`
 * should pass it: `createHistorySource({ feeds: client.chainConfig.priceFeeds })`
 * skips this table entirely.
 *
 * Both spellings are kept, deliberately. `ETH` and `ETH/USD` are literally the
 * same address (FINDINGS §3) and a caller that has not normalised its symbol
 * must still resolve.
 */
export const BASE_PRICE_FEEDS: Readonly<Record<string, string>> = Object.freeze({
  ETH: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  BTC: "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
  SOL: "0x975043adBb80fc32276CbF9Bbcfd4A601a12462D",
  DOGE: "0x8422f3d3CAFf15Ca682939310d6A5e619AE08e57",
  XRP: "0x9f0C1dD78C4CBdF5b9cf923a549A201EdC676D34",
  BNB: "0x4b7836916781CAAfbb7Bd1E5FDd20ED544B453b1",
  PAXG: "0x5213eBB69743b85644dbB6E25cdF994aFBb8cF31",
  AVAX: "0xE70f2D34Fd04046aaEC26a198A35dD8F2dF5cd92",
  "ETH/USD": "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
  "BTC/USD": "0x64c911996D3c6aC71f9b455B1E8E7266BcbD848F",
});

// ─────────────────────────────────────────────────────────────────────────────
// Output shapes
// ─────────────────────────────────────────────────────────────────────────────

/** One oracle print. `t` is ms since epoch (the round's `updatedAt`, which is
 *  the time the answer became true on chain), `px` is USD. */
export interface HistoryPoint {
  readonly t: number;
  readonly px: number;
}

/** Which of the two decoders produced the points. Both read the same rounds. */
export type HistoryTransport = "logs" | "rounds";

/** The feed the line was drawn from, spelled out so a footer can name it. */
export interface FeedRef {
  /** The symbol as resolved — `ETH`, never `eth` or `ETH/USD`. */
  readonly symbol: string;
  /** `chainConfig.priceFeeds[symbol]` — the proxy Thetanuts settles against. */
  readonly proxy: string;
  /** The phase aggregator behind the proxy, when it was resolvable. This is
   *  what emits `AnswerUpdated`; `null` means the logs path was unavailable. */
  readonly aggregator: string | null;
  /** From `decimals()`, not assumed. USD feeds are 8, and a feed that ever is
   *  not would otherwise be off by orders of magnitude in silence. */
  readonly decimals: number;
}

/**
 * What this read actually got, measured.
 *
 * Chainlink updates on a deviation threshold with a heartbeat ceiling, so there
 * is no such thing as "the" interval — the gaps are irregular by design, and a
 * module that printed a nominal candle size would be inventing one. These are
 * the numbers from the points in hand.
 */
export interface Granularity {
  readonly points: number;
  readonly medianGapMs: number;
  readonly maxGapMs: number;
  /** Oldest to newest, ms. How much history the chart is actually showing. */
  readonly spanMs: number;
}

/**
 * Where history stops and the future begins.
 *
 * §2.3 makes this data rather than decoration: the divider is a real line, and
 * the box's right edge may never land left of it, because the box is a
 * prediction about the future. `at` is the divider. `lastPrintAt` is when the
 * oracle last spoke, which is normally minutes earlier — the gap between them
 * is honest empty space, and a chart that runs its line flat to the divider is
 * drawing a price nobody published.
 */
export interface NowBoundary {
  /** The divider, ms. Nothing may be drawn right of this and no box edge may
   *  be placed left of it. */
  readonly at: number;
  /** `updatedAt` of the newest point, or `null` when there are none. */
  readonly lastPrintAt: number | null;
  /** `at - lastPrintAt`. How much of the right edge is legitimately blank. */
  readonly staleMs: number | null;
}

export interface HistoryMeta {
  /** False when nothing usable was read. `points` is then empty. */
  readonly ok: boolean;
  readonly source: "chainlink" | "empty";
  readonly transport: HistoryTransport | null;
  readonly feed: FeedRef | null;
  /** When this read happened, ms. */
  readonly fetchedAt: number;
  /** RPC calls this read spent. Exposed because §2.5's cost warning is only
   *  keepable if the cost is visible — a chart that quietly costs 60 calls is
   *  how a public endpoint gets throttled in front of players. */
  readonly rpcCalls: number;
  readonly granularity: Granularity | null;
  /** Why, when there is a why — a partial window, a fallback, an outage. */
  readonly note?: string;
}

export interface PriceHistory {
  readonly meta: HistoryMeta;
  /** Ascending by `t`, deduped, and never containing a point at or after
   *  `now.at`. Empty is a legitimate answer. */
  readonly points: readonly HistoryPoint[];
  readonly now: NowBoundary;
  /**
   * The price range these points happen to occupy.
   *
   * **Descriptive, not prescriptive.** §2.5: the strike ladder is derived
   * first and the chart is fitted to it, so this is a fact about the data and
   * never an axis. A caller that has a ladder must use the ladder's band and
   * `fitToLadder`; this is for the one case where there is no ladder yet.
   */
  readonly observed: { readonly lo: number; readonly hi: number } | null;
}

export interface HistorySource {
  /** Provenance for a footer — `"chainlink · base 8453"`. */
  readonly id: string;
  /** Always resolves. A dead RPC is data, not an exception. */
  history(underlying: string): Promise<PriceHistory>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Transport
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One JSON-RPC call. The only impure edge in this file, and it is a parameter,
 * so every test drives the real caching and fallback paths over a fake and no
 * socket can open.
 *
 * It may reject; every caller in here is wrapped.
 */
export type RpcCall = (method: string, params: readonly unknown[]) => Promise<unknown>;

/** A `RpcCall` over `fetch`. No key, no header, no environment read. */
export function jsonRpc(url: string = DEFAULT_RPC_URL): RpcCall {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: (id += 1), method, params }),
    });
    if (!res.ok) throw new Error(`rpc ${method}: http ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (body.error) throw new Error(`rpc ${method}: ${body.error.message ?? "error"}`);
    return body.result;
  };
}

export interface HistoryDeps {
  /** Omitted means `jsonRpc(rpcUrl)`, built lazily so importing this module in
   *  a test costs nothing. */
  rpc?: RpcCall;
  /** Ignored when `rpc` is supplied. A server caller with a private endpoint
   *  passes it here; this module never reads one from the environment. */
  rpcUrl?: string;
  /** `client.chainConfig.priceFeeds` when the caller has one. Defaults to the
   *  mirrored `BASE_PRICE_FEEDS`. */
  feeds?: Readonly<Record<string, string>>;
  now?: () => number;
  /** Log windows to walk back, clamped to `MAX_WINDOWS`. */
  windows?: number;
  ttlMs?: number;
  /** `"auto"` (default) tries logs and falls back to the round walk. The other
   *  two force one decoder, which is what makes each testable on its own. */
  transport?: HistoryTransport | "auto";
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers — decoding, measuring, and the two things the UI asks of this
// ─────────────────────────────────────────────────────────────────────────────

/** `true` when `t` is strictly after the divider.
 *
 *  This is the §2.3 rule in one function: the box's right edge must satisfy it,
 *  and an expiry that does not is not a prediction. Equality is false on
 *  purpose — an expiry at exactly "now" has already happened. */
export function isFuture(t: number, boundary: NowBoundary): boolean {
  return Number.isFinite(t) && t > boundary.at;
}

/**
 * The points that fall inside a band the *ladder* chose, and how many did not.
 *
 * This is the whole of the shared-y-axis contract on this side of the seam. The
 * caller derives its band from the strike ladder, hands it here, and clips —
 * prices are never rescaled, moved or clamped, because a clamped point is a
 * price that was never printed. `clipped` is how the chart knows to say the
 * line runs off the top rather than pretending it flattened.
 */
export function fitToLadder(
  history: PriceHistory,
  lo: number,
  hi: number,
): { readonly points: readonly HistoryPoint[]; readonly clipped: number } {
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
    return { points: history.points, clipped: 0 };
  }
  const points = history.points.filter((p) => p.px >= lo && p.px <= hi);
  return { points, clipped: history.points.length - points.length };
}

/** Median and max gap over the points in hand, or `null` below two points. */
export function measure(points: readonly HistoryPoint[]): Granularity | null {
  if (points.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a && b) gaps.push(b.t - a.t);
  }
  if (gaps.length === 0) return null;
  gaps.sort((x, y) => x - y);
  const first = points[0];
  const last = points[points.length - 1];
  return {
    points: points.length,
    medianGapMs: gaps[Math.floor(gaps.length / 2)] ?? 0,
    maxGapMs: gaps[gaps.length - 1] ?? 0,
    spanMs: first && last ? last.t - first.t : 0,
  };
}

/** An empty answer, which is a legitimate one. Shaped identically to a full
 *  one so no caller needs a second branch to render nothing. */
export function emptyHistory(at: number, note?: string): PriceHistory {
  return {
    meta: {
      ok: false,
      source: "empty",
      transport: null,
      feed: null,
      fetchedAt: at,
      rpcCalls: 0,
      granularity: null,
      ...(note === undefined ? {} : { note }),
    },
    points: [],
    now: { at, lastPrintAt: null, staleMs: null },
    observed: null,
  };
}

/** One 32-byte word of an ABI return, or `null` if the string is short. */
function word(hex: string, index: number): bigint | null {
  const body = hex.startsWith("0x") ? hex.slice(2) : hex;
  const start = index * 64;
  if (body.length < start + 64) return null;
  const slice = body.slice(start, start + 64);
  if (!/^[0-9a-fA-F]{64}$/.test(slice)) return null;
  return BigInt(`0x${slice}`);
}

/** Two's-complement, because a Chainlink answer is `int256`. Negative prices
 *  are nonsense for a USD pair and are dropped upstream, but decoding one as
 *  1.1e77 instead of a negative would not be. */
function toInt256(v: bigint): bigint {
  return v >= 1n << 255n ? v - (1n << 256n) : v;
}

function scale(answer: bigint, decimals: number): number {
  return Number(answer) / 10 ** decimals;
}

/** The shape of one `eth_getLogs` entry this module reads. */
export interface RawLog {
  readonly topics?: readonly string[];
  readonly data?: string;
}

/**
 * `AnswerUpdated` → a point, or `null`.
 *
 * `topics[1]` is the answer (indexed `int256`), `topics[2]` the aggregator's
 * round id, and `data` the single non-indexed word, `updatedAt` in seconds.
 * Verified against `latestRoundData` on the live ETH/USD feed: both give
 * 2448.09306508 at round 1599.
 *
 * A non-positive or non-finite answer is a miss, not a fact — the same rule
 * `spotFor` keeps in `src/data/spot.ts`, and for the same reason: `$0.00` on a
 * chart is a worse lie than a gap.
 */
export function decodeAnswerUpdated(log: RawLog, decimals: number): HistoryPoint | null {
  const topics = log.topics;
  if (!topics || topics.length < 2) return null;
  const rawAnswer = topics[1];
  const data = log.data;
  if (typeof rawAnswer !== "string" || typeof data !== "string") return null;
  const answer = word(rawAnswer, 0);
  const updatedAt = word(data, 0);
  if (answer === null || updatedAt === null) return null;
  const px = scale(toInt256(answer), decimals);
  const t = Number(updatedAt) * 1000;
  if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(t) || t <= 0) return null;
  return { t, px };
}

/** One decoded `latestRoundData()` / `getRoundData(uint80)` return. */
export interface RoundData {
  readonly roundId: bigint;
  readonly point: HistoryPoint;
}

/**
 * A five-word round tuple → a point, or `null`.
 *
 * Word order is `(roundId, answer, startedAt, updatedAt, answeredInRound)`.
 * `startedAt` is deliberately unread: it is when the round opened, and the
 * price only became true at `updatedAt`.
 */
export function decodeRoundData(hex: unknown, decimals: number): RoundData | null {
  if (typeof hex !== "string") return null;
  const roundId = word(hex, 0);
  const answer = word(hex, 1);
  const updatedAt = word(hex, 3);
  if (roundId === null || answer === null || updatedAt === null) return null;
  const px = scale(toInt256(answer), decimals);
  const t = Number(updatedAt) * 1000;
  if (!Number.isFinite(px) || px <= 0 || !Number.isFinite(t) || t <= 0) return null;
  return { roundId, point: { t, px } };
}

/**
 * Split a proxy round id into its phase and the phase aggregator's own round.
 *
 * A proxy round id is `phaseId << 64 | aggregatorRoundId`, which is what lets
 * the walk below compute the previous ids arithmetically instead of discovering
 * them one call at a time. Verified live: the ETH proxy reported
 * `55340232221128656447`, phase 3 round 1599, and the aggregator's own
 * `AnswerUpdated` for the same print carried round id 1599.
 */
export function splitRoundId(roundId: bigint): { phase: bigint; round: bigint } {
  return { phase: roundId >> 64n, round: roundId & ((1n << 64n) - 1n) };
}

/** Ascending, deduped by timestamp, and stripped of anything at or after the
 *  divider. A chart may not draw the future; that half of the canvas belongs to
 *  the box. */
export function normalise(points: readonly HistoryPoint[], nowMs: number): readonly HistoryPoint[] {
  const byTime = new Map<number, HistoryPoint>();
  for (const p of points) {
    if (p.t >= nowMs) continue;
    byTime.set(p.t, p);
  }
  return [...byTime.values()].sort((a, b) => a.t - b.t);
}

// ─────────────────────────────────────────────────────────────────────────────
// The source
// ─────────────────────────────────────────────────────────────────────────────

const hexQuantity = (n: number): string => `0x${Math.max(0, Math.floor(n)).toString(16)}`;

/** `getRoundData(uint80)` calldata for one proxy round id. */
function encodeGetRound(roundId: bigint): string {
  return SEL_GET_ROUND + roundId.toString(16).padStart(64, "0");
}

/** What one asset's read produced, before it is dressed as a `PriceHistory`. */
interface Read {
  points: HistoryPoint[];
  transport: HistoryTransport | null;
  aggregator: string | null;
  notes: string[];
}

/**
 * The history source.
 *
 * Both impure edges — the RPC and the clock — are parameters, and the real
 * transport is built lazily inside the first read, so importing this module
 * opens nothing.
 */
export function createHistorySource(deps: HistoryDeps = {}): HistorySource {
  const now = deps.now ?? (() => Date.now());
  const feeds = deps.feeds ?? BASE_PRICE_FEEDS;
  const ttlMs = deps.ttlMs ?? HISTORY_TTL_MS;
  const windows = Math.max(1, Math.min(MAX_WINDOWS, Math.floor(deps.windows ?? DEFAULT_WINDOWS)));
  const mode = deps.transport ?? "auto";

  let transport: RpcCall | null = deps.rpc ?? null;
  const rpc: RpcCall = (method, params) => {
    transport ??= jsonRpc(deps.rpcUrl);
    return transport(method, params);
  };

  /** `decimals()` per feed. It cannot change under a live proxy without a
   *  migration, and re-reading it on every poll is one wasted call a minute. */
  const decimalsByProxy = new Map<string, number>();
  const cache = new Map<string, { at: number; value: PriceHistory }>();
  const inFlight = new Map<string, Promise<PriceHistory>>();

  /** Every RPC in this file goes through here: it counts, and it never throws.
   *  `null` is "that call did not answer", which is always a degradation and
   *  never an exception. */
  function caller(count: { calls: number }) {
    return async (method: string, params: readonly unknown[]): Promise<unknown> => {
      count.calls += 1;
      try {
        return await rpc(method, params);
      } catch {
        return null;
      }
    };
  }

  function feedFor(underlying: string): { symbol: string; proxy: string } | null {
    const bare = underlying.trim().toUpperCase();
    if (!bare) return null;
    const proxy = feeds[bare] ?? feeds[`${bare}/USD`];
    return proxy ? { symbol: bare, proxy } : null;
  }

  async function readDecimals(
    call: ReturnType<typeof caller>,
    proxy: string,
  ): Promise<number | null> {
    const cached = decimalsByProxy.get(proxy);
    if (cached !== undefined) return cached;
    const raw = await call("eth_call", [{ to: proxy, data: SEL_DECIMALS }, "latest"]);
    const value = typeof raw === "string" ? word(raw, 0) : null;
    if (value === null) return null;
    const decimals = Number(value);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 30) return null;
    decimalsByProxy.set(proxy, decimals);
    return decimals;
  }

  /**
   * The fast path: one `eth_getLogs` per ~5.5h window, walking back from head.
   *
   * A window that errors is skipped rather than fatal — the public endpoint
   * throttles per call, and five good windows are a chart while one bad one is
   * a note.
   */
  async function readLogs(
    call: ReturnType<typeof caller>,
    aggregator: string,
    decimals: number,
    out: Read,
  ): Promise<void> {
    const headRaw = await call("eth_blockNumber", []);
    if (typeof headRaw !== "string") {
      out.notes.push("block number unavailable");
      return;
    }
    const head = Number(BigInt(headRaw));
    if (!Number.isFinite(head) || head <= 0) {
      out.notes.push("block number unusable");
      return;
    }

    let missed = 0;
    for (let w = 0; w < windows; w += 1) {
      const to = head - w * WINDOW_BLOCKS;
      const from = to - (WINDOW_BLOCKS - 1);
      if (to <= 0) break;
      const logs = await call("eth_getLogs", [
        {
          address: aggregator,
          topics: [ANSWER_UPDATED_TOPIC],
          fromBlock: hexQuantity(Math.max(0, from)),
          toBlock: hexQuantity(to),
        },
      ]);
      if (!Array.isArray(logs)) {
        missed += 1;
        continue;
      }
      for (const log of logs as RawLog[]) {
        const point = decodeAnswerUpdated(log, decimals);
        if (point) out.points.push(point);
      }
    }
    if (missed > 0) out.notes.push(`${missed} of ${windows} windows unavailable`);
    if (out.points.length > 0) out.transport = "logs";
  }

  /**
   * The fallback: walk round ids backwards from `latestRoundData`.
   *
   * Sound but expensive — one `eth_call` per point, against an endpoint that
   * caps batches at 10 and rate-limits below that. Bounded at `ROUND_BUDGET`,
   * issued `ROUND_BATCH` at a time, and stopped at the phase boundary: round 1
   * of a phase is the oldest id this arithmetic can reach, and reaching past it
   * would mean guessing at a previous aggregator's round count.
   */
  async function readRounds(
    call: ReturnType<typeof caller>,
    proxy: string,
    decimals: number,
    out: Read,
  ): Promise<void> {
    const latest = decodeRoundData(
      await call("eth_call", [{ to: proxy, data: SEL_LATEST_ROUND }, "latest"]),
      decimals,
    );
    if (!latest) {
      out.notes.push("latest round unavailable");
      return;
    }
    out.points.push(latest.point);

    const { phase, round } = splitRoundId(latest.roundId);
    const ids: bigint[] = [];
    for (let k = 1n; k < BigInt(ROUND_BUDGET) && round - k >= 1n; k += 1n) {
      ids.push((phase << 64n) | (round - k));
    }

    for (let i = 0; i < ids.length; i += ROUND_BATCH) {
      const batch = ids.slice(i, i + ROUND_BATCH);
      const answers = await Promise.all(
        batch.map((roundId) =>
          call("eth_call", [{ to: proxy, data: encodeGetRound(roundId) }, "latest"]),
        ),
      );
      for (const answer of answers) {
        const decoded = decodeRoundData(answer, decimals);
        if (decoded) out.points.push(decoded.point);
      }
    }
    if (out.points.length > 0) out.transport = "rounds";
    if (ids.length + 1 > out.points.length) {
      out.notes.push(`${ids.length + 1 - out.points.length} of ${ids.length + 1} rounds unavailable`);
    }
  }

  async function read(underlying: string): Promise<PriceHistory> {
    const at = now();
    const feed = feedFor(underlying);
    if (!feed) {
      // Not a Chainlink asset on Base — the ordinary answer for most of the
      // board, and worth zero RPC calls. §2.1: SUI lands here, as it should.
      return emptyHistory(at, `no Chainlink feed for ${underlying.trim().toUpperCase()}`);
    }

    const count = { calls: 0 };
    const call = caller(count);
    const out: Read = { points: [], transport: null, aggregator: null, notes: [] };

    const decimals = await readDecimals(call, feed.proxy);
    if (decimals === null) {
      // The RPC is unreachable or the address is not a feed. Either way there
      // is no scale to read prices on, and guessing 8 is how a chart draws
      // 24.48 for a $2,448 asset.
      const empty = emptyHistory(at, "feed decimals unavailable");
      return { ...empty, meta: { ...empty.meta, rpcCalls: count.calls } };
    }

    if (mode !== "rounds") {
      const raw = await call("eth_call", [{ to: feed.proxy, data: SEL_AGGREGATOR }, "latest"]);
      // `aggregator()` reverts on some proxy revisions; that is a fallback, not
      // a failure, and the round walk reads the proxy directly.
      const address = typeof raw === "string" && raw.length >= 42 ? `0x${raw.slice(-40)}` : null;
      out.aggregator = address && !/^0x0+$/.test(address) ? address : null;
      if (out.aggregator) await readLogs(call, out.aggregator, decimals, out);
      else out.notes.push("aggregator unresolved");
    }

    if (out.points.length === 0 && mode !== "logs") {
      if (mode === "auto") out.notes.push("logs unavailable — fell back to round walk");
      await readRounds(call, feed.proxy, decimals, out);
    }

    const points = normalise(out.points, at);
    const last = points[points.length - 1] ?? null;
    const prices = points.map((p) => p.px);
    const note = out.notes.join("; ");

    return {
      meta: {
        ok: points.length > 0,
        source: points.length > 0 ? "chainlink" : "empty",
        transport: out.transport,
        feed: {
          symbol: feed.symbol,
          proxy: feed.proxy,
          aggregator: out.aggregator,
          decimals,
        },
        fetchedAt: at,
        rpcCalls: count.calls,
        granularity: measure(points),
        ...(note === "" ? {} : { note }),
      },
      points,
      now: {
        at,
        lastPrintAt: last ? last.t : null,
        staleMs: last ? at - last.t : null,
      },
      observed:
        prices.length > 0 ? { lo: Math.min(...prices), hi: Math.max(...prices) } : null,
    };
  }

  return {
    id: "chainlink · base 8453",

    /**
     * Cached for `ttlMs`, with concurrent callers sharing one read — two
     * players opening the builder at once is one set of RPC calls, not two.
     * The cached value keeps its original `fetchedAt`, so a footer's age chip
     * tells the truth about how old the line is.
     */
    async history(underlying: string): Promise<PriceHistory> {
      const key = underlying.trim().toUpperCase();
      const hit = cache.get(key);
      if (hit && now() - hit.at < ttlMs) return hit.value;

      const running = inFlight.get(key);
      if (running) return running;

      const job = read(key)
        .then((value) => {
          // A failed read is not cached: an empty chart should retry on the
          // next poll rather than be pinned there for a minute. An asset with
          // no feed at all *is* cached — it cost no call, that answer cannot
          // change, and re-deciding it every frame is pure work.
          if (value.meta.ok || value.meta.rpcCalls === 0) {
            cache.set(key, { at: now(), value });
          }
          return value;
        })
        .catch(() => emptyHistory(now(), "history read failed"))
        .finally(() => {
          inFlight.delete(key);
        });

      inFlight.set(key, job);
      return job;
    },
  };
}
