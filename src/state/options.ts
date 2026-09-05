import { useEffect, useMemo, useState } from "react";
import type { MarketSource } from "../data/market.ts";
import { BOOK_ASSETS } from "../data/spot.ts";
import type { OptionBook } from "../desk/optionize.ts";
import type { PricingRow } from "../types.ts";

/**
 * The kill switch, and the book it turns into.
 *
 * Two jobs, one hook, because they are the same decision: `features.options` is
 * what makes a match's cards market-priced, and a book with nothing quotable in
 * it is the same as the flag being off — both answer `undefined`, and
 * `undefined` is what makes `src/state/match.ts` deal exactly the legs it has
 * always dealt.
 *
 * The flag is OPT-OUT (`THETADUEL_OPTIONS=off`), the shape `THETADUEL_MARKET`
 * uses, and for the same reason: nothing below reads a wallet, and nothing below
 * can sign. It was opt-in until the default was measured — a clone with the flag
 * unset showed all 24 cards reading `MAX LOSS —` beneath a home page promising
 * live Thetanuts pricing, which is a worse claim about the venue than a live card
 * is. The reasons this hook answers `undefined` are unchanged; only the default
 * moved. See the flag's own paragraph in `index.ts`.
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
 * flag to enable. Same here, and the reason survived the flag becoming opt-out
 * intact: a seeded source publishes no spot and no chain, so `bookOf` would hand
 * back `undefined` however the answer came out. Skipping the call is what keeps
 * the default build — and every existing test, all of which mount on
 * `mockMarketSource` — free of a network round trip whose answer it would
 * discard. `enabled` therefore stays `false` over a fixture even though the
 * server would now say `true`, and that is not a stale default: it is the same
 * `undefined` by a shorter route.
 *
 * Everything that fails leaves this at `undefined` too: no server, a 500, a body
 * that is not JSON, a `features` block with no `options` key. `=== true`
 * exactly — a flag that does not reach us is not a flag we assume. That is what
 * keeps a static build (no server to ask) on the seeded cards rather than on a
 * half-priced screen.
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
    //
    // "The surface says so" was aspirational when it was written and is a fact
    // now. For a long while nothing in `src/` read this field at all and `at`
    // was never rendered anywhere, so a book whose refresh had failed dealt its
    // cards under a green LIVE chip — real strikes wearing a timestamp nobody
    // could see, which `src/theme.ts` calls "the one genuinely dangerous state".
    // `src/views/ParlayPick.tsx` reads both now: `source` picks the chip's word
    // and its colour, and `at` becomes the age printed beside STALE, because the
    // age is the disclosure and the word alone is not.
    source: source.meta.source === "stale" ? "stale" : "live",
    spot,
    chain,
  };
}
