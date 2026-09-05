import { FEED_STATE, MONO } from "../theme.ts";
import type { MarketSource } from "./market.ts";

/**
 * Live spot, standing *beside* the seeded board.
 *
 * ## What this module is for
 *
 * THETADUEL deals from a board of 18 seeded assets (`data/universe.ts`) whose
 * prices drive a replayable tape. Thetanuts publishes a live USD spot for
 * roughly seven assets — ETH, BTC, SOL, DOGE, XRP, BNB, AVAX, PAXG in the
 * price-feed map, six of which carried an actual price in the capture frozen
 * into `test/fixtures/orders.json`. Four of those are also on our board. The
 * other fourteen board names (nine equities, five long-tail tokens) have zero
 * Thetanuts presence and never will.
 *
 * So the *normal* answer here is `null`, and that is the single most important
 * thing about this file. `null` is not an error, not a loading state and not a
 * gap to be filled with a dash: it means this asset simply has no live print,
 * and the surface renders exactly the DOM it rendered before live data existed.
 *
 * ## The rule the whole phase exists to keep
 *
 * **Live sits beside seeded. It never replaces it.**
 *
 * The duel settles off the seeded tape — `pctAt` and four absolute price locks
 * in `test/determinism.test.ts` pin that, and `universe.ts` is untouchable
 * because those locks live on its series. If a live print ever *substituted*
 * for a seeded one, the number on screen would stop being the number the match
 * pays on, and the screen would be lying in the most expensive way available.
 * So every annotation is additive and self-labelling:
 *
 *     $4,182.60 seeded · $2,522.13 live
 *
 * plus one honesty chip on the surface saying `LIVE SPOT · SEEDED TAPE`, so a
 * reader who sees two numbers knows immediately which one the game runs on.
 *
 * ## Why it lives in `src/data/` and not `src/engine/`
 *
 * `test/determinism.test.ts` scans `src/engine/*` and `src/state/match.ts` for
 * any reach-through to the live market. This module reads `MarketSource`, so it
 * is live-market code by definition and must stay outside that boundary. It is
 * imported by views only. Nothing in settlement may ever import it — if that
 * import is ever written, the guard fails, and the guard is right.
 *
 * Everything here is pure and synchronous: it fetches nothing of its own. The
 * network already resolved before the `MarketSource` was constructed
 * (`data/thetanuts.tsx`), which is what lets a view read a live price during
 * render without learning that a network exists.
 */

/**
 * The one chip that makes the pairing legible.
 *
 * Rendered on any surface that is showing at least one live annotation, and
 * *not* rendered when there are none — a screen with no live numbers on it
 * should not carry a badge claiming live numbers, and suppressing it is also
 * what keeps the all-`null` case byte-identical to today's DOM.
 */
export const SPOT_CHIP = "LIVE SPOT · SEEDED TAPE";

/**
 * The chip's dress, defined once so the reel and the pick screen cannot drift
 * apart.
 *
 * It wears the vocabulary's LIVE colour (`FEED_STATE.live`, `src/theme.ts`),
 * because that is the claim it is making: this surface is carrying at least one
 * live print. The same colour tints the live half of every `seeded · live` pair
 * below, the footer's provenance line and `/desk`'s feed pill, and it is one
 * constant in one place so those four cannot drift apart either.
 *
 * `modeTag` in `data/modes.ts` set this precedent: a style that belongs to a
 * datum rather than to a view lives with the datum.
 */
export const LIVE_COLOR = FEED_STATE.live.color;

export const spotChipSx =
  `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${LIVE_COLOR};` +
  `border:1px solid ${LIVE_COLOR}4d;background:${LIVE_COLOR}14;border-radius:6px;padding:6px 8px`;

/**
 * The two assets with a real options book, and therefore the only two with
 * greeks worth quoting as a second opinion. Spot is broader than this — SOL and
 * DOGE have price feeds and no book — which is why `spotFor` does not consult
 * this list.
 */
export const BOOK_ASSETS: readonly string[] = ["ETH", "BTC"];

/**
 * Live USD spot for a board symbol, or `null` — and `null` is the common case.
 *
 * Two lookups, because the alias collapse happens on the server and this
 * accessor must not depend on that having happened. `buildSnapshot` strips the
 * `/USD` suffix (`ETH/USD` and `ETH` are literally the same Chainlink address —
 * FINDINGS §3, and `feedSymbols` dedupes them so one instrument cannot split
 * across two rows), so a live source answers to the bare symbol. The suffixed
 * probe is the belt to that braces: if a future snapshot ever arrives
 * un-normalised, the annotation still resolves rather than silently going dark.
 *
 * A non-positive or non-finite price is treated as a miss, not as a fact. Zero
 * is the shape a failed upstream read takes, and `$0.00 live` beside a seeded
 * price is a worse lie than no annotation at all.
 */
export function spotFor(sym: string, source: MarketSource): number | null {
  if (!sym) return null;
  const bare = sym.trim().toUpperCase();
  return usable(source.spot(bare)) ?? usable(source.spot(`${bare}/USD`));
}

function usable(px: number | null | undefined): number | null {
  return typeof px === "number" && Number.isFinite(px) && px > 0 ? px : null;
}

/**
 * A price for the spot line, to the cent.
 *
 * Deliberately *not* `fmtPx` from the engine's tape. `fmtPx` rounds anything
 * over 1,000 to whole units, which is right for a tape print scrolling past and
 * wrong here: the moment a seeded number sits next to a live one, the cents are
 * the difference between "these are two readings" and "these are two guesses".
 * Both halves of the pair get the same precision, so neither looks more or less
 * authoritative than the other.
 *
 * The sub-dollar branches mirror `fmtPx` exactly, because PEPE at `1.12e-5` is
 * the one place where more decimals is the *less* readable choice.
 */
export function fmtSpot(v: number): string {
  if (v < 0.001) return v.toExponential(2);
  if (v < 1) return v.toFixed(4);
  return v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/**
 * `$4,182.60 seeded · $2,522.13 live`, or `null` when there is no live print.
 *
 * `null` is the caller's cue to render precisely what it rendered before this
 * module existed — no annotation, no dash, no placeholder. The word "seeded"
 * only appears when there is something to distinguish it *from*; on its own a
 * seeded number needs no disclaimer, because the whole board is seeded and the
 * footer has said so since the first commit.
 */
export function spotPair(seeded: number, live: number | null): string | null {
  if (live === null) return null;
  return `${seededTag(seeded)} · ${liveTag(live)}`;
}

/**
 * `$4,182.60 seeded` — the pair's left half.
 *
 * Split out so a caller that wants to colour the two halves differently (the
 * pick screen renders seeded in the dim it always used and live in the live
 * green) still produces a `textContent` identical, character for character, to
 * `spotPair`. One string, two ways of dressing it, and one thing to assert on.
 */
export function seededTag(seeded: number): string {
  return `$${fmtSpot(seeded)} seeded`;
}

/**
 * `$2,522.13 live`, or `null` — the pair's right half on its own.
 *
 * For surfaces too narrow for the full pair (the spin reel's 124px tiles), where
 * the seeded price is already on the line directly above and the surface's
 * honesty chip has said which is which. Same rule, less room.
 */
export function liveTag(live: number): string;
export function liveTag(live: number | null): string | null;
export function liveTag(live: number | null): string | null {
  return live === null ? null : `$${fmtSpot(live)} live`;
}

/**
 * The book's delta for the level nearest a leg's line — a second opinion on a
 * tier's implied probability, or `null`.
 *
 * ## Why delta, and why "second opinion" and not "the answer"
 *
 * A parlay tier states a probability outright: SHARP is 15%, because SHARP's
 * `TIER_BANDS` bracket is `[0.10, 0.20)` and `tierProb` takes its midpoint.
 * (This paragraph used to cite `TIERS.SHARP.prob` at `0.25`. `TIERS` was a
 * hand-written payout table; it was deleted in plan 6 and must not return —
 * a tier is a |delta| band now, and the band is the whole of what it means.)
 * Where that band sits is a measurement against the book rather than a
 * game-design decision, and nothing here touches, imports or restates it.
 *
 * But the live book has an opinion of its own. An option's delta is, to a very
 * good first approximation, the market's probability that the option finishes
 * in the money. So the resting Base book will quote a number for "ETH above
 * here by expiry" that was priced by people with money at risk, and putting it
 * beside the tier's is informative in exactly the way a second opinion is:
 * advisory, additive, and clearly attributed.
 *
 * ## Why moneyness and not the strike
 *
 * The leg's strike is on the *seeded* scale — ETH seeded at 4,182.60, so a
 * SHARP bull line sits near 4,558. The live book's strikes are on the *live*
 * scale, which was around 2,522 in the frozen capture. Comparing those two
 * numbers directly is meaningless. What does carry across is the ratio: a leg
 * asking for +9% is asking the same thing of either tape, so the target is
 * `moneyness × live spot`, and the nearest live strike on the matching side is
 * the level that answers it.
 *
 * ## Every reason this returns `null`
 *
 *  - the asset is not ETH or BTC (nothing else has a book at all);
 *  - there is no live spot, so there is no scale to map the moneyness onto —
 *    this is also what keeps the advisory off the mock source, whose `spot()`
 *    returns `null` for everything while its seeded pricing table does carry
 *    deltas;
 *  - no level on the matching side is a single-strike option (multi-strike
 *    rows quote a range, `2,100–2,600`, and a range has no one line to compare);
 *  - no candidate level carried greeks. `rawApiData.greeks` is undocumented and
 *    genuinely absent sometimes, and `greeksOf` reports that honestly as `null`
 *    rather than inventing a delta. An unscoreable book shows no advisory.
 */
export function bookDelta(
  sym: string,
  stance: "bull" | "bear",
  moneyness: number,
  source: MarketSource,
): number | null {
  const u = sym.trim().toUpperCase();
  if (!BOOK_ASSETS.includes(u)) return null;
  if (!Number.isFinite(moneyness) || moneyness <= 0) return null;

  const live = spotFor(u, source);
  if (live === null) return null;
  const target = live * moneyness;

  const want = stance === "bull" ? "CALL" : "PUT";
  let best: number | null = null;
  let bestGap = Infinity;
  for (const row of source.pricing(u)) {
    if (row.type !== want) continue;
    const strike = parseStrike(row.strike);
    if (strike === null) continue;
    const delta = parseDelta(row.delta);
    if (delta === null) continue;
    const gap = Math.abs(strike - target);
    if (gap < bestGap) {
      bestGap = gap;
      best = delta;
    }
  }
  // The magnitude, not the sign: a put's delta is negative and its *chance of
  // landing* is not. The card already says which way it is betting.
  return best === null ? null : Math.abs(best);
}

/** `book Δ 0.31 (second opinion)`, or `null`. The view renders this verbatim. */
export function bookDeltaNote(
  sym: string,
  stance: "bull" | "bear",
  moneyness: number,
  source: MarketSource,
): string | null {
  const d = bookDelta(sym, stance, moneyness, source);
  return d === null ? null : `book Δ ${d.toFixed(2)} (second opinion)`;
}

/**
 * `"4,000"` → `4000`. `"2,100–2,600"` → `null`: a multi-strike level quotes a
 * range and has no single line for a leg to be compared against.
 */
function parseStrike(s: string): number | null {
  if (s.includes("–") || s.includes("-")) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * `"−0.34"` → `-0.34`, `"—"` → `null`.
 *
 * The leading character matters: the seeded table writes a typographic minus
 * (U+2212) and the live builder writes `toFixed(2)`'s ASCII hyphen, and
 * `Number("−0.34")` is `NaN`. Reading only one of the two would silently drop
 * every put on one side of the seam.
 */
function parseDelta(s: string): number | null {
  const n = Number(s.replace("−", "-"));
  return Number.isFinite(n) ? n : null;
}
