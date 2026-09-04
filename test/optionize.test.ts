/**
 * IV, from the book to the card face — the units, pinned.
 *
 * The FULL card face prints `Δ 0.34 · θ −0.4 · IV 58%`. Three numbers cross
 * three module boundaries to get there and exactly one of them changes units on
 * the way, which is the only interesting thing about this file:
 *
 *   server   `greeksOf().iv`   a FRACTION      0.582
 *   row      `PricingRow.iv`   a display STRING in percent   "58.2%"
 *   quote    `OptionQuote.iv`  a FRACTION again              0.582
 *   face     `IV ${round(iv * 100)}%`                        "IV 58%"
 *
 * Drop the ÷100 and the face prints `IV 5800%`; apply it twice and it prints
 * `IV 0%`. Both are worse than the dash they replaced, because a dash is honest
 * about not knowing and a mis-scaled number is a lie told beside a real strike.
 * So this file asserts the round trip end to end — a row goes in, the string the
 * face would render comes out — rather than asserting the fraction alone, which
 * would still pass if the face's own ×100 disappeared.
 *
 * The second half is absence. `undefined` is a first-class answer: a row with
 * no greeks yields a quote with no IV, the face draws a faint dash, and — the
 * part worth a test of its own — the strike is still quoted. IV is a thing the
 * card *says*, never a thing the leg is priced off, so its absence must never
 * cost a leg its option.
 */

import { describe, expect, test } from "bun:test";
import { faceText } from "../src/components/ParlayCardFace.tsx";
import {
  optionizeTier,
  quoteFor,
  type OptionBook,
  type OptionQuote,
} from "../src/desk/optionize.ts";
import type { PricingRow } from "../src/types.ts";

const SPOT = 4_000;

/** One quotable call. Everything but `iv` is held fixed so a failure can only
 *  be about the field under test. */
function row(iv: string, over: Partial<PricingRow> = {}): PricingRow {
  return {
    type: "CALL",
    strike: "4,200",
    expiry: "27 SEP",
    bid: "0.0902",
    ask: "0.0948",
    iv,
    delta: "0.49",
    depth: 71,
    size: "9.8k",
    ...over,
  };
}

const bookOf = (rows: readonly PricingRow[]): OptionBook => ({
  at: 0,
  source: "live",
  spot: { ETH: SPOT },
  chain: { ETH: rows },
});

/** What the FULL face would print for this quote's IV. The face reads
 *  `FaceValues.iv`, so the quote's field is handed to it verbatim — which is
 *  the assertion: no consumer gets to rescale on the way past. */
function facePrints(quote: OptionQuote): string {
  return faceText("iv", "FULL", {
    stance: "bull",
    strike: quote.strike,
    spot: quote.spot,
    prob: quote.impliedProb,
    mult: quote.multiplier,
    premium: quote.premium,
    iv: quote.iv,
  })!.value;
}

describe("OptionQuote.iv — units", () => {
  test("a percent string on the row becomes a fraction on the quote", () => {
    const q = quoteFor(bookOf([row("58.2%")]), "ETH", "EVEN", "bull")!;
    expect(q).not.toBeNull();
    expect(q.iv).toBe(0.582);
  });

  test("and the face prints the percent back, unrounded off by a factor", () => {
    const q = quoteFor(bookOf([row("58.2%")]), "ETH", "EVEN", "bull")!;
    // The contract's own example: `IV 58%`.
    expect(facePrints(q)).toBe("IV 58%");
  });

  test("the fraction is a fraction — a crypto IV is not 5800 and not 0.0058", () => {
    for (const [text, expected] of [
      ["46.2%", 0.462],
      ["55.1%", 0.551],
      ["70.3%", 0.703],
      ["112.5%", 1.125],
    ] as const) {
      const q = quoteFor(bookOf([row(text)]), "ETH", "EVEN", "bull")!;
      expect(q.iv).toBe(expected);
    }
  });

  test("the seeded table's own strings survive the trip", () => {
    // `src/data/market.ts` writes `"56.8%"` by hand; the live builder writes
    // `` `${(iv * 100).toFixed(1)}%` ``. One decoder reads both, on purpose.
    const q = quoteFor(bookOf([row("56.8%")]), "ETH", "EVEN", "bull")!;
    expect(q.iv).toBe(0.568);
    expect(facePrints(q)).toBe("IV 57%");
  });
});

describe("OptionQuote.iv — absence", () => {
  test("a row with no IV yields a quote with no IV, and the face dashes", () => {
    const q = quoteFor(bookOf([row("—")]), "ETH", "EVEN", "bull")!;
    expect(q.iv).toBeUndefined();
    expect(facePrints(q)).toBe("IV —");
  });

  test("absence never costs the row its strike", () => {
    const q = quoteFor(bookOf([row("—")]), "ETH", "EVEN", "bull")!;
    expect(q.strike).toBe(4_200);
    expect(q.premium).toBe(0.0948);
    expect(q.impliedProb).toBeCloseTo(0.49, 10);
  });

  test("no zero, no placeholder, no computed substitute", () => {
    for (const text of ["—", "", "0%", "-12%", "n/a"]) {
      const q = quoteFor(bookOf([row(text)]), "ETH", "EVEN", "bull")!;
      expect(q.iv).toBeUndefined();
    }
  });

  test("a bare number is refused rather than guessed at", () => {
    // `"58.2"` could mean 58.2% or 5820%, and nothing in the string says which.
    // Refusing is what keeps a future producer's format change from silently
    // printing a wrong number instead of an honest dash.
    for (const text of ["58.2", "0.582"]) {
      expect(quoteFor(bookOf([row(text)]), "ETH", "EVEN", "bull")!.iv).toBeUndefined();
    }
  });
});

describe("OptionQuote.iv — it is the CHOSEN row's IV", () => {
  test("the IV travels with the strike the tier picked, not the first row", () => {
    // EVEN's target is ~0.55, so the 0.52-delta row wins over the 0.19 one —
    // and the IV that arrives must be that row's, not its neighbour's.
    const chain = [
      row("46.2%", { strike: "4,600", delta: "0.19", ask: "0.0441" }),
      row("61.0%", { strike: "4,100", delta: "0.52", ask: "0.0902" }),
    ];
    const q = optionizeTier("EVEN", "bull", chain, SPOT, "ETH")!;
    expect(q.strike).toBe(4_100);
    expect(q.iv).toBe(0.61);
  });

  test("a put's IV is read the same way — the sign lives on delta alone", () => {
    const chain = [
      row("64.4%", { type: "PUT", strike: "3,800", delta: "−0.34", ask: "0.0446" }),
    ];
    const q = optionizeTier("SHARP", "bear", chain, SPOT, "ETH")!;
    expect(q.side).toBe("PUT");
    expect(q.delta).toBeLessThan(0);
    expect(q.iv).toBe(0.644);
  });
});
