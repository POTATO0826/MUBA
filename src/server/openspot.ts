import {
  BASE_PRICE_FEEDS,
  DEFAULT_RPC_URL,
  decodeRoundData,
  type RpcCall,
} from "../data/history.ts";
import type { RoomOpen } from "../data/room.ts";
import { LIVE_SYMS } from "../data/universe.ts";

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE OPENING PRINT — read once, server-side, when a room is created
 * ────────────────────────────────────────────────────────────────────────────
 *
 * ## The bug this exists to remove
 *
 * `src/engine/tape.ts` opened every duel's price walk on `meta(sym).px` — a row
 * in `src/data/universe.ts`, written down once, never moved since. By September
 * 2026 that fixture said ETH $4,182.60 against a live print of $2,450.76 (+70%),
 * BTC $96,410 against $79,561 (+21%), SOL $214.40 against ~$101.87 (+110%). The
 * seeded walk on top of it is legitimate and stays — see `series()` — but its
 * *origin* was a 2024 guess presented as a price, and the owner is right that
 * a venue this app already polls every thirty seconds should be supplying it.
 *
 * ## Why the capture is here and not in the engine or the client
 *
 * Three constraints meet at this file, and only one arrangement satisfies all
 * three:
 *
 *  1. **`test/determinism.test.ts` forbids `src/engine/**` and
 *     `src/state/match.ts` from naming a market source.** Rightly: a tape that
 *     could fetch is a tape whose shape depends on what a remote host felt like
 *     saying at render time. So the engine takes the open as an argument and
 *     this module may not be imported by it.
 *  2. **Both seats must walk the identical tape.** If each client read its own
 *     spot, two players thirty seconds apart would open on two prices and the
 *     duel would be decided by whose poll landed first. So the read happens
 *     exactly once, on the server, at room creation, and is frozen into the
 *     room next to `seed` — the field whose docblock has explained this since
 *     before there was anything but a seed to explain.
 *  3. **A number that is not live must say so.** So the answer is `RoomOpen`
 *     with a `source` and an `at`, or it is `null`, and `null` is *not* quietly
 *     the old fixture — see `openFor()` in `src/data/room.ts`.
 *
 * ## Two sources, in this order, and why that order
 *
 * **The book first** (`MarketSnapshot.spot`, i.e. Thetanuts
 * `getMarketData().prices`). Not because it is truer than the oracle, but
 * because it is the number the option book is quoted *around*: when a room
 * opens on it, the tape, the strikes on the pick screen and the premiums in the
 * arena all agree, and there is no second price to explain.
 *
 * **Chainlink second**, read straight off the Base aggregator. This is the
 * fallback and it is not a lesser one — it is the feed that *settles* the
 * option (through the TWAP consumer `src/data/history.ts` documents), and it is
 * reachable independently of the book. As of 2026-09-05 it is the only one of
 * the two that answers from this machine at all: `mainnet.base.org` returns
 * ETH $2,450.76 / BTC $79,561.30 / XRP $1.3990 / BNB $724.21 while the pricing
 * host does not resolve. A room opened today therefore gets a real Chainlink
 * open rather than a practice tape, which is the whole reason the fallback is
 * an oracle read and not a constant.
 *
 * **And nothing third.** There is no "if both fail, use the reference" branch
 * in this file, and adding one would undo the point of it. Both failing is
 * `null`, and `null` reaches the screen as `PRACTICE_TAPE_CHIP`.
 *
 * ## What it costs, and why it is batched
 *
 * The public Base endpoint rate-limits hard, and the numbers are not close.
 * Measured against `mainnet.base.org` on 2026-09-05, reading the same seven
 * feeds three ways:
 *
 *     one call at a time, 14 calls          1 of 7 symbols answered, 1156 ms
 *     the same, warm (decimals cached)      0–4 of 7, run to run
 *     ONE batched request of 7 eth_calls    5 of 7 answered, 496 ms
 *
 * So the transport is a **batch**: one HTTP request carrying every `eth_call`,
 * which Base caps at {@link MAX_BATCH} entries (`-32014 maximum 10 calls in 1
 * batch`). Three other things fall out of the same measurement:
 *
 *  - Each feed's `decimals()` and `latestRoundData()` are **interleaved into
 *    one batch**, not sent as two batches back to back. Splitting them costs
 *    everything: seven `decimals()` in one request answered 5 of 7, and the
 *    seven round reads sent 400 ms behind them answered **0 of 7**. The limiter
 *    is a bucket over a window, so a budget spent on scale reads is a budget
 *    not spent on prices. `decimals()` is also cached per aggregator for the
 *    life of the process — a live feed does not change its scale; the day one
 *    does, it is a new address — so a warm capture is one entry per symbol.
 *  - Refusals land on the **tail** of a batch, which would mean AVAX and BNB
 *    never getting a live open while ETH always did. So whatever missed is
 *    retried once, after {@link RETRY_MS}, **in reverse order**.
 *  - The whole capture is cached for {@link CAPTURE_TTL_MS}, so a burst of room
 *    creations is one read.
 *
 * A per-symbol failure is **absence, not zero and not an error**: the symbol is
 * simply missing from `px`, `openFor` reports it `live: false`, and the rest of
 * the capture stands. A rate-limited SOL must not cost ETH its real open.
 *
 * **And the honest caveat.** Even batched and retried, the *public* endpoint is
 * erratic — probed on 2026-09-05 it answered 5 of 10 entries on one request and
 * 0 of 2 on another two seconds later, with no pattern. That is what `null` and
 * `PRACTICE_TAPE_CHIP` are for, and it is why a failed capture is deliberately
 * not cached. A keyed Base endpoint passed as `rpcUrl` (or a `batch` of the
 * caller's own) removes the whole problem; this module reads no environment
 * variable to find one, exactly like `src/data/history.ts`.
 *
 * ## What it never does
 *
 * It returns no strike, no expiry, no premium and nothing a player's position
 * is derived from. It answers one question — *what was this asset actually
 * worth when this room opened* — and the only thing downstream of it is the
 * first element of a chart array and a provenance label. It also never throws:
 * a dead RPC and a dead book are both `null`, because a room that cannot be
 * opened because a price feed is busy would be a worse product than a room that
 * says its tape is a practice one.
 */

/** `keccak256("decimals()")[0:4]`. */
const SEL_DECIMALS = "0x313ce567";

/** `keccak256("latestRoundData()")[0:4]` — the same selector `src/data/history.ts`
 *  uses to anchor its round walk, and the tuple `decodeRoundData` decodes. */
const SEL_LATEST_ROUND = "0xfeaf968c";

/**
 * How many `eth_call`s go in one JSON-RPC batch.
 *
 * Ten, because that is Base's cap: an eleventh entry fails the whole request
 * with `-32014 maximum 10 calls in 1 batch`. The live board is seven feeds, so
 * in practice every phase is a single request.
 */
export const MAX_BATCH = 10;

/**
 * How long to wait before retrying the entries a batch refused.
 *
 * Long enough for a token bucket to refill, short enough that a room POST is
 * not noticeably slower for it. It is only ever paid when something was
 * actually refused.
 */
export const RETRY_MS = 400;

/**
 * How many `eth_call`s are in flight at once on the **fallback** transport —
 * the one built from a single-call `RpcCall`, which is what a test injects and
 * what a caller with its own RPC helper would pass. The batched default does
 * not use it.
 */
export const LANES = 4;

/**
 * How long one capture is reused.
 *
 * Thirty seconds, matching `REFRESH_MS` in `src/data/thetanuts.tsx` — the rate
 * the rest of the app already considers "now". Two rooms created inside the
 * same half-minute share an opening print, which is correct: they were opened
 * against the same market.
 */
export const CAPTURE_TTL_MS = 30_000;

export const CHAINLINK_LABEL = "Chainlink · Base 8453";
export const BOOK_LABEL = "thetanuts · base 8453";

/** The shape this module needs out of a market snapshot, and no more — so it
 *  never has to import `src/server/thetanuts.ts` and cannot drift into
 *  depending on the rest of that envelope. */
export interface SpotEnvelope {
  ok: boolean;
  at?: number;
  spot?: Record<string, number>;
}

/** One `eth_call` to place in a batch. */
export interface RpcRequest {
  method: string;
  params: readonly unknown[];
}

/**
 * Many calls, one transport, **result-per-entry and never a rejection**.
 *
 * `undefined` in slot `i` means entry `i` did not answer — refused, throttled,
 * malformed, or the whole request failed. That contract is what lets the caller
 * treat a rate-limited SOL as an absent symbol instead of as an outage, without
 * a try/catch per feed.
 */
export type BatchCall = (reqs: readonly RpcRequest[]) => Promise<readonly unknown[]>;

export interface OpenSpotDeps {
  /** The market snapshot, already read by whoever owns the service. Omitted
   *  means "no book" — which is a legitimate configuration, not a fault. */
  snapshot?: () => Promise<SpotEnvelope>;
  /** Batched JSON-RPC transport. Omitted means `jsonRpcBatch(rpcUrl)`, built
   *  lazily so importing this module in a test opens no socket. */
  batch?: BatchCall;
  /** A single-call transport to build the batch from, for a caller that already
   *  has one. Ignored when `batch` is given. */
  rpc?: RpcCall;
  /** Ignored when `batch` or `rpc` is given. */
  rpcUrl?: string;
  /** Which symbols to capture. Defaults to the live board. */
  syms?: readonly string[];
  /** Aggregator proxy per symbol. Defaults to the Base table. */
  feeds?: Readonly<Record<string, string>>;
  /** Backoff before the retry pass. `0` disables the wait, not the retry. */
  retryMs?: number;
  now?: () => number;
}

/**
 * A {@link BatchCall} over one HTTP POST per {@link MAX_BATCH} entries.
 *
 * Results are matched back **by `id`**, not by position: a JSON-RPC server is
 * free to answer out of order, and Base does when some entries are refused.
 * A transport-level failure resolves to all-`undefined` rather than rejecting,
 * because a dead endpoint and a fully-throttled one are the same thing to the
 * caller: nothing answered.
 */
export function jsonRpcBatch(url: string = DEFAULT_RPC_URL): BatchCall {
  return async (reqs) => {
    const out: unknown[] = new Array(reqs.length).fill(undefined);
    for (let start = 0; start < reqs.length; start += MAX_BATCH) {
      const slice = reqs.slice(start, start + MAX_BATCH);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            slice.map((r, i) => ({ jsonrpc: "2.0", id: start + i, ...r })),
          ),
        });
        if (!res.ok) continue;
        const body = (await res.json()) as unknown;
        for (const row of Array.isArray(body) ? body : [body]) {
          const r = row as { id?: unknown; result?: unknown; error?: unknown };
          if (typeof r.id !== "number" || r.error !== undefined) continue;
          out[r.id] = r.result;
        }
      } catch {
        // Leave this slice undefined; the other slices may still have answered.
      }
    }
    return out;
  };
}

/** Adapt a single-call transport to the batch contract: waves of {@link LANES},
 *  a rejection becoming an `undefined` slot rather than failing its neighbours. */
function fromSingle(rpc: RpcCall): BatchCall {
  return async (reqs) => {
    const out: unknown[] = new Array(reqs.length).fill(undefined);
    for (let i = 0; i < reqs.length; i += LANES) {
      await Promise.all(
        reqs.slice(i, i + LANES).map(async (r, j) => {
          try {
            out[i + j] = await rpc(r.method, r.params);
          } catch {
            /* absent, not fatal */
          }
        }),
      );
    }
    return out;
  };
}

const ethCall = (to: string, data: string): RpcRequest => ({
  method: "eth_call",
  params: [{ to, data }, "latest"],
});

/**
 * Read live spot for `syms` off the Chainlink aggregators on Base.
 *
 * Exported for its own test rather than for a second caller. Resolves to the
 * symbols that answered — possibly none, never a rejection.
 */
export async function chainlinkSpot(deps: OpenSpotDeps = {}): Promise<Record<string, number>> {
  const batch =
    deps.batch ?? (deps.rpc ? fromSingle(deps.rpc) : jsonRpcBatch(deps.rpcUrl ?? DEFAULT_RPC_URL));
  const feeds = deps.feeds ?? BASE_PRICE_FEEDS;
  const syms = deps.syms ?? LIVE_SYMS;

  // Deduped by address, not by symbol: `BASE_PRICE_FEEDS` deliberately carries
  // both `ETH` and `ETH/USD` pointing at one aggregator, and reading it twice
  // would spend a batch entry on an answer we already have.
  const wanted: { sym: string; proxy: string }[] = [];
  const seen = new Set<string>();
  for (const sym of syms) {
    const proxy = feeds[sym];
    if (!proxy || seen.has(proxy.toLowerCase())) continue;
    seen.add(proxy.toLowerCase());
    wanted.push({ sym, proxy });
  }
  if (wanted.length === 0) return {};

  const wait = deps.retryMs ?? RETRY_MS;
  const px: Record<string, number> = {};

  /**
   * One pass over `batchOf`, returning whatever did not answer.
   *
   * Both calls a feed needs — `decimals()` when its scale is not yet known, and
   * `latestRoundData()` — go into the SAME batch, adjacent, rather than into
   * two batches one after the other. That is not a micro-optimisation, it is
   * the difference between reading a price and reading nothing. Measured
   * against `mainnet.base.org` on 2026-09-05: seven `decimals()` in one batch
   * answered 5 of 7, and the seven `latestRoundData()` sent 400 ms behind them
   * answered **0 of 7** — the whole second request refused. The limiter is a
   * bucket over a window, so a scarce budget spent on scale reads is a budget
   * not spent on prices. Interleaved, whatever gets through gets through as a
   * complete pair at the head of the list, and the tail is what the retry is
   * for.
   */
  const pass = async (batchOf: readonly { sym: string; proxy: string }[]) => {
    if (batchOf.length === 0) return [];
    const reqs: RpcRequest[] = [];
    const slot: { entry: (typeof batchOf)[number]; dec: number; round: number }[] = [];
    for (const entry of batchOf) {
      const known = decimalsCache.has(entry.proxy.toLowerCase());
      const dec = known ? -1 : reqs.push(ethCall(entry.proxy, SEL_DECIMALS)) - 1;
      const round = reqs.push(ethCall(entry.proxy, SEL_LATEST_ROUND)) - 1;
      slot.push({ entry, dec, round });
    }

    const got = await batch(reqs);
    const missed: { sym: string; proxy: string }[] = [];
    for (const { entry, dec, round } of slot) {
      const key = entry.proxy.toLowerCase();
      if (dec >= 0) {
        const n = decodeDecimals(got[dec]);
        if (n !== null) decimalsCache.set(key, n);
      }
      const decimals = decimalsCache.get(key);
      const answer = decimals === undefined ? null : decodeRoundData(got[round], decimals);
      // `decodeRoundData` already rejects a non-positive or non-finite answer,
      // so a feed mid-migration reporting 0 lands here as absent rather than as
      // a $0.00 open.
      if (answer) px[entry.sym] = answer.point.px;
      else missed.push(entry);
    }
    return missed;
  };

  const missed = await pass(wanted);

  // One retry, reversed. The endpoint refuses the TAIL of a batch, so reading
  // the misses in the same order would make the same names lose twice — AVAX
  // and BNB would carry a seeded open forever while ETH always went live.
  if (missed.length > 0) {
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await pass([...missed].reverse());
  }

  return px;
}

/** `decimals()` per aggregator, cached for the life of the process — a live
 *  feed does not change its scale, and re-reading it doubles the entry count on
 *  the one thing that is actually scarce. */
const decimalsCache = new Map<string, number>();

function decodeDecimals(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  let n: number;
  try {
    n = Number(BigInt(raw));
  } catch {
    return null;
  }
  if (!Number.isInteger(n) || n < 0 || n > 36) return null;
  return n;
}

let cached: { open: RoomOpen; at: number } | null = null;
let inFlight: Promise<RoomOpen | null> | null = null;

/**
 * The opening print for a room being created right now — book first, oracle
 * second, `null` if neither answered.
 *
 * Concurrent callers share one read, the same way `createMarketService` shares
 * one refresh: two people opening a room in the same instant should be one
 * round trip, not two.
 */
export async function captureOpen(deps: OpenSpotDeps = {}): Promise<RoomOpen | null> {
  const now = deps.now ?? (() => Date.now());
  if (cached && now() - cached.at < CAPTURE_TTL_MS) return cached.open;
  if (inFlight) return inFlight;

  const job = read(deps, now)
    .then((open) => {
      // A failed capture is deliberately NOT cached. A practice tape is the
      // honest answer for the room that hit the outage, not a sentence the next
      // thirty seconds of rooms have to repeat after the venue came back.
      if (open) cached = { open, at: now() };
      return open;
    })
    .catch(() => null)
    .finally(() => {
      inFlight = null;
    });
  inFlight = job;
  return job;
}

async function read(deps: OpenSpotDeps, now: () => number): Promise<RoomOpen | null> {
  if (deps.snapshot) {
    try {
      const env = await deps.snapshot();
      const spot = env.ok ? env.spot : undefined;
      if (spot) {
        const px = positive(spot);
        // An `ok` envelope carrying an empty price map is a book that answered
        // and had nothing to say, which is not an open. Fall through to the
        // oracle rather than freezing a room on `{}`.
        if (Object.keys(px).length > 0) {
          return { px, source: "book", at: env.at ?? now(), label: BOOK_LABEL };
        }
      }
    } catch {
      // The book is one of two sources and the other one is independent of it.
    }
  }

  const px = await chainlinkSpot(deps);
  if (Object.keys(px).length === 0) return null;
  return { px, source: "chainlink", at: now(), label: CHAINLINK_LABEL };
}

/** Keep only entries that are a real, positive, finite price. Zero is how a
 *  snapshot spells "this asset has a feed but no market price" (PAXG), and a
 *  zero open would draw a flat tape at the floor. */
function positive(spot: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [sym, v] of Object.entries(spot)) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) out[sym] = v;
  }
  return out;
}

/** Test seam — module state, so tests need a way back to a cold start. */
export function _resetOpenSpot(): void {
  cached = null;
  inFlight = null;
  decimalsCache.clear();
}
