import { useEffect, useMemo, useState } from "react";
import type { MarketSource } from "../data/market.ts";
import { BOOK_ASSETS } from "../data/spot.ts";
import type { OptionBook } from "../desk/optionize.ts";
import type { PricingRow } from "../types.ts";

/**
 * The opt-in flag, and the book it turns into.
 *
 * Two jobs, one hook, because they are the same decision: `THETADUEL_OPTIONS=on`
 * is what makes a match's cards market-priced, and a book with nothing quotable
 * in it is the same as the flag being off — both answer `undefined`, and
 * `undefined` is what makes `src/state/match.ts` deal exactly the legs it has
 * always dealt.
 *
 * ## Why it is a separate file from `state/match.ts`
 *
 * Same rule `state/stake.ts` lives by. `test/determinism.test.ts` scans
 * `src/engine/*` and `src/state/match.ts` for any reach-through to the live
 * market; this hook reads a `MarketSource`, so it is live-market code by
 * definition and must stay outside that boundary. What crosses into the match is
 * the plain, frozen `OptionBook` value — data, not a source — threaded in from
 * `App` exactly the way `liveSeats` is.
 *
 * ## Why the mock never asks
 *
 * `useTradeConfig` (`src/views/Parlay.tsx`) and `useStakeConfig`
 * (`src/state/stake.ts`) both skip the config fetch when there is nothing for the
 * flag to enable. Same here: a seeded source has no chain and no spot, so the
 * flag could only ever resolve to "off", and skipping the call is what keeps the
 * default build — and every existing test, all of which mount on
 * `mockMarketSource` — free of a network call whose answer it would discard.
 *
 * Everything that fails leaves this at `undefined`: no server, a 500, a body
 * that is not JSON, a flag that is absent. Opt-in means the absence of the flag
 * is the absence of the feature.
 */
export function useOptionBook(source: MarketSource): OptionBook | undefined {
  const [enabled, setEnabled] = useState(false);
  const kind = source.meta.source;

  useEffect(() => {
    // Nothing to enable over a fixture. See above.
    if (kind === "mock") return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        const body = (await res.json()) as { features?: { options?: boolean } };
        if (live && body.features?.options === true) setEnabled(true);
      } catch {
        // Fail closed, silently: a static build has no server to ask and is not
        // misconfigured.
      }
    })();
    return () => {
      live = false;
    };
  }, [kind]);

  return useMemo(() => (enabled ? bookOf(source) : undefined), [enabled, source]);
}

/**
 * A `MarketSource` reduced to the plain data a match needs, or `undefined`.
 *
 * ETH and BTC only, and not because of a rule invented here: `BOOK_ASSETS` is
 * the two assets that have an options book at all (`src/data/spot.ts`), and the
 * other six price-feed assets return an empty chain rather than throwing. An
 * asset is carried only when it has **both** a live spot and at least one
 * pricing row — a strike with no spot to measure it against is not a line
 * anything can bet on.
 *
 * `undefined` when nothing qualifies, so a live source whose pricing host is
 * down is indistinguishable from the flag being off, which is the correct
 * degrade: the whole board goes back to seeded cards rather than half a slip
 * quoting a book that is not there.
 *
 * Exported so a test can build one without a React tree.
 */
export function bookOf(source: MarketSource): OptionBook | undefined {
  const spot: Record<string, number> = {};
  const chain: Record<string, readonly PricingRow[]> = {};

  for (const sym of BOOK_ASSETS) {
    const px = source.spot(sym);
    if (typeof px !== "number" || !Number.isFinite(px) || px <= 0) continue;
    const rows = source.pricing(sym);
    if (rows.length === 0) continue;
    spot[sym] = px;
    chain[sym] = rows;
  }

  if (Object.keys(chain).length === 0) return undefined;
  return {
    at: source.meta.fetchedAt,
    // A stale book is still a real book — the numbers are true, just old, and
    // the surface says so. `mock` never reaches here: it publishes no spot.
    source: source.meta.source === "stale" ? "stale" : "live",
    spot,
    chain,
  };
}
