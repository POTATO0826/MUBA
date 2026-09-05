import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LadderBook, MmQuote, OrderRow, PricingRow } from "../types.ts";
import { NO_LADDER, NO_QUALIFIED, mockMarketSource, type MarketSource } from "./market.ts";
import type { QualifiedAsset } from "./qualify.ts";

/**
 * The live Thetanuts book, behind the existing `MarketSource` interface.
 *
 * `MarketSource` is synchronous and the network is not, so this fetches into a
 * snapshot and hands down a source built over it. The views never learn that
 * the data arrived late — which is the whole point of the interface being
 * there.
 *
 * Reads go through our own `/api/market` rather than straight to Thetanuts:
 * `pricing.thetanuts.finance` sends no CORS headers, so a browser fetch to it
 * fails outright. See `src/server/thetanuts.ts`.
 *
 * **The SDK is not imported here and must never be.** It pulls axios, viem and
 * ethers as hard dependencies; this module talks to one JSON route and nothing
 * else, which is what keeps ~1MB of chain tooling out of the client bundle.
 *
 * ## Three rules this hook exists to keep
 *
 *  - **Mock first.** The first paint is the seeded pricing table, not an empty
 *    one. The live book replaces it the moment it lands.
 *  - **Stale beats blank.** A failed refresh keeps the last good rows on
 *    screen and re-labels them `stale`; only a first read that never succeeded
 *    falls back to the mock.
 *  - **Off means off.** `THETADUEL_MARKET=off` reaches the client as
 *    `features.market: false` on `/api/config`, and this hook then opens no
 *    socket at all — not one poll, not one first read.
 */

/** The `/api/market` envelope. Every field optional: the route always answers
 *  200 and `ok` is the only thing worth trusting before reading the rest. */
export interface Wire {
  ok?: boolean;
  at?: number;
  underlyings?: string[];
  spot?: Record<string, number>;
  pricing?: Record<string, PricingRow[]>;
  /** Absent whenever the pricing host was unreachable — a second feed, on a
   *  second host, that fails on its own. The book still arrives. */
  mmPricing?: Record<string, MmQuote[]>;
  orders?: OrderRow[];
  /** The asset gate, measured server-side beside the book it grades. Absent on
   *  an envelope from a server that predates it; `[]` means "measured, nothing
   *  qualified", which is the ordinary answer on a thin or unreachable book. */
  qualified?: QualifiedAsset[];
  /** The strike ladder's raw input, narrowed server-side. Absent on an envelope
   *  from a server that predates it, which is exactly the `ladder()`-absent
   *  state on the far side; an empty `orders` array means the book was read and
   *  had nothing a ladder can use. */
  ladder?: LadderBook;
  greeksSeen?: number;
  note?: string;
  reason?: string;
  /**
   * Why the read failed, when the server actually knows — mirroring
   * `MarketFailureCause` in `src/server/thetanuts.ts`. Hand-mirrored rather
   * than imported, like every other field on this interface: importing a server
   * module here would pull the SDK, axios and ethers into the client bundle,
   * which is the rule this whole file exists to keep.
   *
   * **Absent is the normal case.** The server emits it only for a cause it
   * measured; an ordinary failure carries `reason` alone and this stays
   * undefined. Read `cause` before `reason`, never instead of the envelope's
   * `ok`.
   */
  cause?: string;
  /**
   * One short sentence about *this network*, written by the server, for the
   * footer's error line.
   *
   * It rides on successful envelopes too, which is the unusual part and the
   * important one: a board that works only because the server resolved around
   * the machine's DNS filter is real data obtained by an unusual route, and the
   * footer says so for as long as that is true. It is NOT `note` — `note` means
   * stale and would paint live rows amber and label them old.
   */
  advisory?: string;
}

/** The one `cause` this client changes its wording for. Mirrors
 *  `MarketFailureCause` in `src/server/thetanuts.ts`; `test/market-route.test.ts`
 *  drives a real envelope through both sides so the two cannot drift. */
export const NETWORK_FILTER = "network-filter";

/** Re-read the book on this cadence. The server caches for 15s behind it, so
 *  two clients polling out of phase still cost about one upstream read. */
export const REFRESH_MS = 30_000;

/**
 * A snapshot the client actually holds, live or stale.
 *
 * Exported for `test/market-route.test.ts`, which drives one frozen capture the
 * whole way — `buildSnapshot` → envelope → `Response.json()` → here → a real
 * strike ladder — so nothing between the server and the arena can quietly drop
 * a field the ladder needs. It is not part of the app's API; `useLiveMarket` is.
 */
export function sourceFrom(wire: Wire, stale: boolean): MarketSource {
  const pricing = wire.pricing ?? {};
  const mmPricing = wire.mmPricing ?? {};
  const spot = wire.spot ?? {};
  const underlyings = wire.underlyings ?? [];
  const orders = wire.orders ?? [];
  // Hoisted out of the accessor so the array keeps ONE identity for the life of
  // this source. `qualifiedAssetsOf(source)` is called in render, and a fresh
  // array per call would re-run every memo hanging off the lobby's live groups.
  const qualified = wire.qualified ?? NO_QUALIFIED;
  // Hoisted for the same reason, and it matters more here: `BoxBuilder` keys its
  // expiry set and its ladder on this object's identity through `useMemo`, and
  // a fresh object per call would re-derive the whole ladder on every render of
  // a drag.
  const ladder = wire.ladder ?? NO_LADDER;
  const note = wire.note;
  return {
    // The footer prints this, so the provenance line updates itself.
    id: "thetanuts · base 8453",
    meta: {
      ok: true,
      source: stale ? "stale" : "live",
      fetchedAt: wire.at ?? 0,
      ...(note === undefined ? {} : { note }),
    },
    underlyings: () => underlyings,
    pricing: (underlying) => pricing[underlying] ?? [],
    // Empty is not a failure state here: only ETH and BTC have MM pricing, and
    // a snapshot built while the pricing host was down carries none at all.
    mmPricing: (underlying) => mmPricing[underlying] ?? [],
    orders: () => orders,
    // A miss is `null`, never 0: Thetanuts prices 7 assets and the board has
    // 18, so "no live spot" is the common case and must not read as "$0".
    spot: (underlying) => {
      const px = spot[underlying];
      return typeof px === "number" && Number.isFinite(px) ? px : null;
    },
    // Measured on the server, against the raw capture — see `MarketSnapshot.
    // qualified`. It is NOT recomputed here: the gate needs `availableAmount`
    // and `rawApiData.priceFeed`, and both are consumed by `buildSnapshot`
    // before anything reaches this wire.
    //
    // A stale source keeps the stale gate, deliberately. The rows and the gate
    // that graded them are one reading of one moment; re-serving the rows under
    // a fresher-looking empty gate would grey every live group while their own
    // prices are still on screen, which reads as a bug rather than as age. The
    // `stale` label on `meta` is what discloses the age, once, for all of it.
    qualified: () => qualified,
    // Narrowed on the server, off the same capture, and NOT rebuilt here: the
    // ladder needs `rawApiData.strikes`, `rawApiData.priceFeed`, `order.expiry`
    // and `availableAmount`, and all four are consumed by `buildSnapshot`
    // before `orders` above exists. See `MarketSource.ladder`.
    //
    // A stale source keeps the stale book, exactly as it keeps the stale gate.
    // The rows, the gate and the ladder are one reading of one moment; the
    // `stale` label on `meta` discloses the age, once, for all three.
    ladder: () => ladder,
  };
}

export interface LiveMarketState {
  source: MarketSource;
  /** True while the first read is still in flight. */
  loading: boolean;
  /**
   * What the footer prints in amber, or `null`.
   *
   * Three readings, and the source beside it says which:
   *   - with a `mock` source — the screen is showing fixtures, and this is why;
   *   - with a `stale` source — the rows are real but old;
   *   - with a **`live`** source — the rows are real and current, and this is
   *     an advisory about how they were obtained. Today that is exactly one
   *     thing: the server had to resolve the book's host around this network's
   *     DNS filter. A green chip and an amber sentence is the honest pairing —
   *     the data is live, the route to it was not the normal one.
   */
  error: string | null;
}

const START: LiveMarketState = {
  // Start on the mock so the first paint has a full pricing table rather than
  // an empty one — it is replaced the moment the real book lands.
  source: mockMarketSource,
  loading: true,
  error: null,
};

export function useLiveMarket(): LiveMarketState {
  const [state, setState] = useState<LiveMarketState>(START);
  /** The last envelope that came back `ok`. Kept so a failed refresh can
   *  re-serve those exact rows under a `stale` label instead of blanking. */
  const lastGood = useRef<Wire | null>(null);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | null = null;

    /** Degrade without losing the board: stale rows if we ever had any, the
     *  mock if we never did. */
    const degrade = (message: string) => {
      const good = lastGood.current;
      setState({
        source: good ? sourceFrom({ ...good, note: message }, true) : mockMarketSource,
        loading: false,
        error: message,
      });
    };

    const read = async () => {
      try {
        const res = await fetch("/api/market");
        const wire = (await res.json()) as Wire;
        if (!live) return;
        if (!wire.ok) {
          // A classified failure is shown in the server's own words and NOT
          // wrapped in "Book unavailable — …". The generic wrapper is what this
          // teammate actually saw ("Book unavailable — HTTP request failed"),
          // and it named neither the cause nor the fix; when the server has
          // measured the cause, its sentence is the whole message.
          degrade(
            wire.reason === "disabled"
              ? "Live market is switched off."
              : wire.cause === NETWORK_FILTER && wire.advisory
                ? wire.advisory
                : `Book unavailable — ${wire.reason ?? "no reason given"}.`,
          );
          return;
        }
        // The server has its own stale path: when its 15s refresh fails it
        // re-serves the last good snapshot `ok: true` with a `note` and the
        // ORIGINAL `at`. That is still stale, and must not be painted green
        // just because it arrived. The note is the signal.
        const stale = Boolean(wire.note);
        lastGood.current = wire;
        setState({
          source: sourceFrom(wire, stale),
          loading: false,
          // Live rows with an advisory are still LIVE — the chip stays green
          // and the amber prose beside it says how they got here. Staleness
          // wins when both are true, because "these numbers are old" is the
          // more urgent of the two claims.
          error: stale ? (wire.note ?? "Book is stale.") : (wire.advisory ?? null),
        });
      } catch {
        // A dropped socket, a 502 from a reverse proxy, a body that is not
        // JSON: all the same outcome, and none of them worth a stack trace.
        if (live) degrade("Could not reach the book.");
      }
    };

    // The feature gate is read once, before any market traffic. `/api/config`
    // is `no-store` server-side, so flipping the switch takes effect on the
    // next reload rather than after a cache expires.
    void (async () => {
      let enabled = true;
      try {
        const res = await fetch("/api/config");
        const cfg = (await res.json()) as { features?: { market?: boolean } };
        enabled = cfg.features?.market !== false;
      } catch {
        // Config unreachable is not a reason to refuse to try the book: the
        // route is opt-OUT, and the market route answers `ok:false` on its own
        // if the switch is actually off.
        enabled = true;
      }
      if (!live) return;
      if (!enabled) {
        setState({ source: mockMarketSource, loading: false, error: null });
        return;
      }
      await read();
      if (!live) return;
      timer = setInterval(() => void read(), REFRESH_MS);
    })();

    return () => {
      live = false;
      if (timer !== null) clearInterval(timer);
    };
  }, []);

  return state;
}

/** Render-prop wrapper, so `client.tsx` reads as a stack of boundaries. */
export function LiveMarket({ children }: { children: (m: LiveMarketState) => ReactNode }) {
  const market = useLiveMarket();
  return <>{children(market)}</>;
}
