import { useEffect, useRef, useState, type ReactNode } from "react";
import type { MmQuote, OrderRow, PricingRow } from "../types.ts";
import { mockMarketSource, type MarketSource } from "./market.ts";

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
interface Wire {
  ok?: boolean;
  at?: number;
  underlyings?: string[];
  spot?: Record<string, number>;
  pricing?: Record<string, PricingRow[]>;
  /** Absent whenever the pricing host was unreachable — a second feed, on a
   *  second host, that fails on its own. The book still arrives. */
  mmPricing?: Record<string, MmQuote[]>;
  orders?: OrderRow[];
  greeksSeen?: number;
  note?: string;
  reason?: string;
}

/** Re-read the book on this cadence. The server caches for 15s behind it, so
 *  two clients polling out of phase still cost about one upstream read. */
export const REFRESH_MS = 30_000;

/** A snapshot the client actually holds, live or stale. */
function sourceFrom(wire: Wire, stale: boolean): MarketSource {
  const pricing = wire.pricing ?? {};
  const mmPricing = wire.mmPricing ?? {};
  const spot = wire.spot ?? {};
  const underlyings = wire.underlyings ?? [];
  const orders = wire.orders ?? [];
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
  };
}

export interface LiveMarketState {
  source: MarketSource;
  /** True while the first read is still in flight. */
  loading: boolean;
  /** Why the live book is degraded, or `null`. Non-null with a `mock` source
   *  means the screen is showing fixtures; non-null with a `stale` source
   *  means the rows are real but old. */
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
          degrade(
            wire.reason === "disabled"
              ? "Live market is switched off."
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
          error: stale ? (wire.note ?? "Book is stale.") : null,
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
