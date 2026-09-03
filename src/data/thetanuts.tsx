import { useEffect, useState, type ReactNode } from "react";
import type { OrderRow, PricingRow } from "../types.ts";
import { mockMarketSource, type MarketSource } from "./market.ts";

/**
 * The live Thetanuts book, behind the existing `MarketSource` interface.
 *
 * `MarketSource` is synchronous and the network is not, so this fetches once
 * into a snapshot and hands down a source built over it. The views never learn
 * that the data arrived late — which is the whole point of the interface being
 * there.
 *
 * Reads go through our own `/api/market` rather than straight to Thetanuts:
 * `pricing.thetanuts.finance` sends no CORS headers, so a browser fetch to it
 * fails outright. See `src/server/thetanuts.ts`.
 */

interface Wire {
  ok: boolean;
  at?: number;
  underlyings?: string[];
  pricing?: Record<string, PricingRow[]>;
  orders?: OrderRow[];
  error?: string;
}

/** Re-read the book on this cadence. The server caches for 15s behind it. */
const REFRESH_MS = 30_000;

function sourceFrom(wire: Wire): MarketSource {
  const pricing = wire.pricing ?? {};
  const underlyings = wire.underlyings ?? [];
  const orders = wire.orders ?? [];
  return {
    // The footer prints this, so the provenance line updates itself.
    id: "thetanuts · base 8453",
    underlyings: () => underlyings,
    pricing: (underlying) => pricing[underlying] ?? [],
    orders: () => orders,
  };
}

export interface LiveMarketState {
  source: MarketSource;
  /** True while the first read is still in flight. */
  loading: boolean;
  /** Why the live book is unavailable, or `null`. Non-null means `source` is
   *  the mock and the screen is showing fixtures. */
  error: string | null;
}

export function useLiveMarket(): LiveMarketState {
  const [state, setState] = useState<LiveMarketState>({
    // Start on the mock so the first paint has a full pricing table rather than
    // an empty one — it is replaced the moment the real book lands.
    source: mockMarketSource,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let live = true;

    const read = async () => {
      try {
        const res = await fetch("/api/market");
        const wire = (await res.json()) as Wire;
        if (!live) return;
        if (!wire.ok) {
          // Keep whatever is on screen; say why rather than blanking the table.
          setState((s) => ({ ...s, loading: false, error: wire.error ?? "Book unavailable." }));
          return;
        }
        setState({ source: sourceFrom(wire), loading: false, error: null });
      } catch {
        if (live) {
          setState((s) => ({ ...s, loading: false, error: "Could not reach the book." }));
        }
      }
    };

    void read();
    const timer = setInterval(() => void read(), REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);

  return state;
}

/** Render-prop wrapper, so `client.tsx` reads as a stack of boundaries. */
export function LiveMarket({ children }: { children: (m: LiveMarketState) => ReactNode }) {
  const market = useLiveMarket();
  return <>{children(market)}</>;
}
