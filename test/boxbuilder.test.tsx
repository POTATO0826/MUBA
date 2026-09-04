/**
 * The arena, as a screen — plan 7 steps 1–2.
 *
 * `test/box.test.ts` proves the ladder and the instrument are right. This file
 * proves the *screen* keeps the four promises that are about rendering rather
 * than arithmetic, and that no amount of correct data can discharge:
 *
 *  1. **The expiry columns are `liveExpiries` and nothing else** (§2.2). A date
 *     that is not in that array must not be drawable, clickable or submittable.
 *  2. **One expiry, one number, shown once** (§4.3, §9). The picker *offers*
 *     dates; exactly one place *states* the position's date.
 *  3. **Max loss is printed above the upside figure** (plan6 §A7, §4.3), and
 *     the payout multiple is absent rather than placeheld until a real premium
 *     exists (§4.4).
 *  4. **One quote per released box, never per pixel** (§4.1).
 *
 * Everything runs against `fixtures/orders.json` — the same frozen real capture
 * the data layer is tested on — with the clock pinned to just before the
 * capture's own order signatures expire, so the fixture is *live* rather than
 * a book the ladder is right to empty.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { liveExpiries, type LadderSnapshot } from "../src/data/box.ts";
import type { CondorSpec } from "../src/data/condor.ts";
import { emptyHistory, type PriceHistory } from "../src/data/history.ts";
import {
  BoxBuilder,
  expiryLabel,
  segments,
  shortAge,
  type ListedFill,
} from "../src/views/BoxBuilder.tsx";

const FIXTURE = (await Bun.file(join(import.meta.dir, "fixtures", "orders.json")).json()) as
  LadderSnapshot & { prices: Record<string, number> };

/**
 * 4 Sep 2026, 05:33 UTC — inside the capture's own validity window.
 *
 * The fixture's orders carry `orderExpiryTimestamp: 1788514414` and the ladder
 * drops an order whose signature has gone stale, so a test that let the wall
 * clock through would be asserting against an empty book from 2027 onwards.
 * Pinning it is what makes the fixture a *live* book for the length of a test.
 */
const NOW = 1_788_500_000_000;

/**
 * The props every mount starts from.
 *
 * `tradeEnabled: false` is not a test convenience — it is the state a build
 * without `THETADUEL_TRADE=on` ships in, so this suite exercises the shipped
 * default. It also means no test asks `/api/config` for it, which is the only
 * network call this component can make.
 */
const BASE = { snapshot: FIXTURE, now: NOW, tradeEnabled: false } as const;

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(ui));
}

afterEach(() => {
  // The pure-helper suites below never mount, so this has to be total.
  if (!root) return;
  act(() => root.unmount());
  container.remove();
  root = undefined as unknown as Root;
});

const text = () => container.textContent ?? "";
const all = (selector: string) => [...container.querySelectorAll(selector)];
const click = (el: Element) => act(() => (el as HTMLElement).click());

/** The ETH expiries the *book* has, at `NOW`. The screen may show these and
 *  nothing else, so every column assertion is against this and never a list
 *  typed out here. */
const ETH_EXPIRIES = liveExpiries(FIXTURE, "ETH", NOW);

// ─────────────────────────────────────────────────────────────────────────────
// The pure helpers
// ─────────────────────────────────────────────────────────────────────────────

describe("expiryLabel", () => {
  test("is UTC, so both players in a duel read one date", () => {
    // 1789113600 = 2026-09-11T08:00:00Z. A local-time render would show
    // "Sep 10" west of UTC and "Sep 11" east of it, for one contract.
    expect(expiryLabel(1_789_113_600)).toBe("Sep 11");
    expect(expiryLabel(1_788_595_200)).toBe("Sep 5");
  });
});

describe("segments", () => {
  const p = (t: number, px: number) => ({ t, px });

  test("cuts the line where the oracle went quiet", () => {
    // 60s median, then a 20-minute hole. Drawing through it would paint
    // twenty minutes of prices nobody published.
    const points = [p(0, 10), p(60_000, 11), p(120_000, 12), p(1_320_000, 13), p(1_380_000, 14)];
    const runs = segments(points, 60_000);
    expect(runs.length).toBe(2);
    expect(runs[0]?.length).toBe(3);
    expect(runs[1]?.length).toBe(2);
  });

  test("the threshold is the data's own median, not a constant", () => {
    // The identical gaps, against a feed whose median gap is ten minutes,
    // are one continuous line.
    const points = [p(0, 10), p(60_000, 11), p(120_000, 12), p(1_320_000, 13), p(1_380_000, 14)];
    expect(segments(points, 600_000).length).toBe(1);
  });

  test("drops a run of one — a lone point cannot be placed in time", () => {
    expect(segments([p(0, 10), p(9_999_999, 11)], 1_000)).toEqual([]);
  });

  test("no measurement means no cutting", () => {
    expect(segments([p(0, 10), p(9_999_999, 11)], null).length).toBe(1);
  });
});

describe("shortAge", () => {
  test("seconds under 90, minutes above", () => {
    expect(shortAge(45_000)).toBe("45s");
    expect(shortAge(600_000)).toBe("10 min");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The screen
// ─────────────────────────────────────────────────────────────────────────────

describe("BoxBuilder", () => {
  test("renders with no history at all, and no error", () => {
    mount(<BoxBuilder {...BASE} />);
    // The grid and the box machinery are there; the line is simply absent.
    expect(container.querySelector('[data-role="plot"]')).not.toBeNull();
    expect(all("[data-rung]").length).toBeGreaterThan(0);
    expect(container.querySelector('[data-role="history"]')).toBeNull();
    expect(text()).not.toContain("History:");
  });

  test("the expiry columns are liveExpiries and nothing else", () => {
    mount(<BoxBuilder {...BASE} />);
    const offered = all("[data-expiry]").map((el) => Number(el.getAttribute("data-expiry")));
    expect(offered).toEqual([...ETH_EXPIRIES]);
    // §2.2 — the book quotes tomorrow, the day after, then weeklies. Evenly
    // spaced daily columns would promise dates that do not exist, so the gaps
    // between the offered dates must be irregular.
    const gaps = offered.slice(1).map((e, i) => e - (offered[i] ?? 0));
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  test("one expiry, one number, shown once", () => {
    mount(<BoxBuilder {...BASE} />);
    // The picker offers four dates. Exactly one place on the screen states one
    // as a fact about the position, and it says "by", never a range.
    expect(text().match(/by Sep/g)?.length).toBe(1);
    expect(text()).not.toMatch(/Sep \d+\s*[–-]\s*Sep \d+/);
  });

  test("choosing a different expiry restates one date, still once", () => {
    mount(<BoxBuilder {...BASE} />);
    const last = all("[data-expiry]").at(-1);
    expect(last).toBeDefined();
    click(last as Element);
    expect(text().match(/by Sep/g)?.length).toBe(1);
    expect(text()).toContain(`by ${expiryLabel(ETH_EXPIRIES.at(-1) as number)}`);
  });

  test("two rung clicks fire exactly one quote, for a snapped four-strike condor", () => {
    const quotes: { spec: CondorSpec; strikes: readonly number[] }[] = [];
    mount(
      <BoxBuilder
        {...BASE}
        onQuote={(spec, strikes) => quotes.push({ spec, strikes })}
      />,
    );

    const rungs = all("[data-rung]");
    // ETH 5 Sep is 2420 · 2440 · 2460 · 2480 · 2550 · 2650 — irregular by
    // construction, which is why the box is drawn off the rungs themselves.
    expect(rungs.length).toBe(6);

    // The first click only arms the floor: no box, and above all no quote.
    click(rungs[0] as Element);
    expect(quotes.length).toBe(0);

    click(rungs[3] as Element);
    expect(quotes.length).toBe(1);

    const [first] = quotes;
    expect(first?.spec.product).toBe("CALL_CONDOR");
    expect(first?.spec.isLong).toBe(true);
    expect(first?.spec.underlying).toBe("ETH");
    expect(first?.spec.expiry).toBe(ETH_EXPIRIES[0] as number);
    const strikes = first?.strikes ?? [];
    expect(strikes.length).toBe(4);
    // Ascending, with equal wings — the invariant `validateCondor` checks.
    expect(strikes[1]).toBe(2420);
    expect(strikes[2]).toBe(2480);
    expect((strikes[1] as number) - (strikes[0] as number)).toBe(
      (strikes[3] as number) - (strikes[2] as number),
    );
  });

  test("the panel shows the wing width, because it is the whole upside", () => {
    mount(<BoxBuilder {...BASE} />);
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[3] as Element);
    expect(text()).toContain("WING WIDTH");
    // The wing is a real ladder increment, in dollars, and on screen — §4.2.
    const payout = container.querySelector('[data-role="max-payout"]')?.textContent ?? "";
    expect(payout).toMatch(/^\$\d/);
  });

  test("max loss is printed above the upside figure", () => {
    mount(<BoxBuilder {...BASE} premium={12.5} />);
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[3] as Element);

    const nodes = all('[data-role="max-loss"], [data-role="max-payout"]');
    expect(nodes.map((n) => n.getAttribute("data-role"))).toEqual(["max-loss", "max-payout"]);
    expect(nodes[0]?.textContent).toBe("$12.50");
  });

  test("max loss stays above the upside on the confirm step too", () => {
    mount(<BoxBuilder {...BASE} premium={12.5} />);
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[3] as Element);
    const review = all("button").find((b) => b.textContent === "Review this box");
    expect(review).toBeDefined();
    click(review as Element);

    expect(text()).toContain("CONFIRM");
    const nodes = all('[data-role="max-loss"], [data-role="max-payout"]');
    expect(nodes.map((n) => n.getAttribute("data-role"))).toEqual(["max-loss", "max-payout"]);
    // Still one date, still stated once — the rule holds at every detail level.
    expect(text().match(/by Sep/g)?.length).toBe(1);
  });

  test("no premium means no multiple — absent, not placeheld", () => {
    mount(<BoxBuilder {...BASE} />);
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[3] as Element);
    expect(container.querySelector('[data-role="payout-multiple"]')).toBeNull();
    expect(text()).not.toContain("× the premium");
  });

  test("the multiple is max payout ÷ premium, and nothing else", () => {
    // The box is 2420–2480 on a ladder whose next rung up is 2550, so the
    // default wing is that $70 increment and the max payout is $70 per
    // contract. At a $5 premium the multiple is 14.00 — arithmetic off the
    // ladder and the fill, not a payback rate from a table in this repo.
    mount(<BoxBuilder {...BASE} premium={5} />);
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[3] as Element);
    const multiple = container.querySelector('[data-role="payout-multiple"]')?.textContent ?? "";
    expect(multiple).toBe("14.00× the premium");
  });

  test("buying is inert without the trade flag", () => {
    mount(
      <BoxBuilder {...BASE} premium={5} onConfirm={() => {
        throw new Error("a build without features.trade must not reach a signature");
      }} />,
    );
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[3] as Element);
    click(all("button").find((b) => b.textContent === "Review this box") as Element);

    const buy = all("button").find((b) => b.textContent === "Buy this box") as HTMLButtonElement;
    expect(buy.disabled).toBe(true);
    click(buy); // a disabled button fires nothing; the throw above is the assertion
    expect(text()).toContain("Buying is switched off in this build");
  });

  test("settlement copy is terminal, and the banned words are absent", () => {
    mount(<BoxBuilder {...BASE} />);
    const body = text();
    expect(body).toContain("lands in your box at expiry");
    expect(body).not.toContain("stays within");
    // §7 and §9 — the screen is the chain and the ticket, and it says so.
    expect(body).toContain("options chain and the order ticket");
    expect(body).not.toMatch(/\bRFQ\b/);
    expect(body).not.toMatch(/\bSUI\b/);
    expect(body).not.toMatch(/moneyness/i);
    expect(body).not.toMatch(/implied volatility/i);
  });

  test("an asset with a book but no condor market is greyed, with the reason", () => {
    mount(<BoxBuilder {...BASE} qualified={["ETH", "BTC", "SOL"]} />);
    const sol = container.querySelector('[data-asset="SOL"]') as HTMLButtonElement;
    expect(sol.disabled).toBe(true);
    expect(sol.getAttribute("title")).toContain("no condor market");
  });

  test("an empty book says so, rather than drawing a chart with nothing in it", () => {
    mount(<BoxBuilder {...BASE} snapshot={{ orders: [], chainConfig: FIXTURE.chainConfig }} />);
    expect(text()).toContain("No live expiries on ETH");
    expect(container.querySelector('[data-role="plot"]')).toBeNull();
  });

  // ── The history seam ────────────────────────────────────────────────────

  /** A `PriceHistory` shaped exactly as `createHistorySource` returns one. */
  function historyOf(points: readonly { t: number; px: number }[], at: number): PriceHistory {
    const last = points[points.length - 1];
    const base = emptyHistory(at);
    return {
      ...base,
      meta: {
        ...base.meta,
        ok: points.length > 0,
        source: "chainlink",
        transport: "logs",
        granularity: { points: points.length, medianGapMs: 60_000, maxGapMs: 60_000, spanMs: 0 },
      },
      points: [...points],
      now: { at, lastPrintAt: last?.t ?? null, staleMs: last ? at - last.t : null },
      observed: null,
    };
  }

  test("history draws behind the grid, and names its feed", () => {
    const points = Array.from({ length: 30 }, (_, i) => ({
      t: NOW - (30 - i) * 60_000,
      px: 2450 + i,
    }));
    mount(<BoxBuilder {...BASE} history={historyOf(points, NOW)} />);
    expect(container.querySelector('[data-role="history"]')).not.toBeNull();
    // §9 — the price source is named, and the settlement disagreement is said.
    expect(text()).toContain("Chainlink · Base 8453");
    expect(text()).toContain("TWAP");
  });

  test("prints outside the ladder are clipped and counted, never rescaled", () => {
    // The ETH 5 Sep ladder runs 2420–2650. Two prints at $9,000 are real
    // prices that do not belong on this axis; moving them would be a lie.
    const points = [
      ...Array.from({ length: 10 }, (_, i) => ({ t: NOW - (20 - i) * 60_000, px: 2450 + i })),
      { t: NOW - 9 * 60_000, px: 9_000 },
      { t: NOW - 8 * 60_000, px: 9_000 },
    ];
    mount(<BoxBuilder {...BASE} history={historyOf(points, NOW)} />);
    expect(text()).toContain("2 prints ran outside the ladder");
    expect(text()).toContain("clipped, never rescaled");
  });

  test("the blank right edge is stated rather than filled in", () => {
    const points = Array.from({ length: 10 }, (_, i) => ({
      t: NOW - (30 - i) * 60_000,
      px: 2450 + i,
    }));
    // Last print is 21 minutes before the divider.
    mount(<BoxBuilder {...BASE} history={historyOf(points, NOW)} />);
    expect(text()).toContain("The feed last printed 21 min before now");
    expect(container.querySelector('[data-role="last-print"]')).not.toBeNull();
  });

  test("the divider is history's own boundary, not the wall clock", () => {
    // History read a second late. The divider must move with the data it
    // normalised the points against, or the newest print lands in the future.
    const at = NOW + 1_000;
    const points = [{ t: NOW - 60_000, px: 2450 }, { t: NOW - 30_000, px: 2455 }];
    mount(<BoxBuilder {...BASE} history={historyOf(points, at)} />);
    const divider = container.querySelector('[data-role="now-divider"]') as HTMLElement;
    const lastPrint = container.querySelector('[data-role="last-print"]') as HTMLElement;
    const pct = (el: HTMLElement) => Number.parseFloat(el.style.left);
    expect(pct(lastPrint)).toBeLessThan(pct(divider));
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// The listed path — plan7 §3.1, on screen
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The chain's implementation registry for the two four-strike orders in the
 * capture, which the capture itself does not carry.
 *
 * `0x9980ec85…` is `RANGER` on Base (`docs/plan7-measurements.md`, and
 * `tnuts-test/FINDINGS.md`). Lowercase, because that is how the SDK ships the
 * map. Without it the screen resolves no product and offers no listed fill —
 * which is itself one of the assertions below.
 */
const REGISTRY = {
  "0x9980ec85bc6fe07340adb36c76fa093bb6d4fcbc": { name: "RANGER" },
} as const;

const BOOKED: LadderSnapshot = {
  ...FIXTURE,
  chainConfig: { ...FIXTURE.chainConfig, optionImplementations: REGISTRY },
};

/** The screen, on the one column of the fixture that has a zone: BTC, 5 Sep. */
function mountOnBtc(props: Partial<React.ComponentProps<typeof BoxBuilder>> = {}) {
  mount(<BoxBuilder {...BASE} snapshot={BOOKED} {...props} />);
  click(container.querySelector('[data-asset="BTC"]') as Element);
}

describe("the listed zone, on screen", () => {
  test("the column's zones are drawn as a short list, not as an invisible rule", () => {
    // §3.1 promised snap-to-listed as the default. What the book actually
    // carries is one zone on this column, so the strip shows one chip — and the
    // shortness of it is the honest part.
    mountOnBtc();
    const chips = all("[data-zone]");
    expect(chips.length).toBe(1);
    expect(chips[0]?.textContent).toBe("$80,000 – $81,000");
    expect(text()).toContain("the one zone a maker has listed here");
  });

  test("no registry means no strip at all — the product cannot be resolved", () => {
    // The same orders, byte for byte. Without the implementation registry there
    // is nothing authoritative to ask what they are, and the screen claims
    // nothing rather than reading the strike shape.
    mount(<BoxBuilder {...BASE} />);
    click(container.querySelector('[data-asset="BTC"]') as Element);
    expect(container.querySelector('[data-role="listed-zones"]')).toBeNull();
  });

  test("clicking a zone fires one quote, and it is a RANGER off the book", () => {
    const quotes: { spec: CondorSpec; match: ListedFill | null }[] = [];
    mountOnBtc({ onQuote: (spec, _strikes, match) => quotes.push({ spec, match }) });

    click(all("[data-zone]")[0] as Element);
    expect(quotes.length).toBe(1);

    const [only] = quotes;
    expect(only?.match).not.toBeNull();
    // The instrument is the maker's zone, not the condor this screen builds for
    // the other path — and it carries the payout flag the SDK needs, or it
    // would be priced as a condor (FINDINGS, "the 4-strike discriminator trap").
    expect(only?.match?.spec.product).toBe("RANGER");
    expect(only?.match?.spec.payoutType).toBe("ranger");
    expect(only?.match?.spec.isLong).toBe(true);
    // The row itself travels, so the caller can hand it to `previewFillOrder`.
    expect(only?.match?.zone.order).toBe(
      (BOOKED.orders ?? [])[only?.match?.zone.index as number] as object,
    );
    expect(only?.match?.zone.expiry).toBe(only?.spec.expiry);
  });

  test("the chip draws the zone's own band and the maker's own wing", () => {
    mountOnBtc();
    click(all("[data-zone]")[0] as Element);
    expect(text()).toContain("$80,000 – $81,000");
    // $500 is `callUpper − callLower` on the resting order. It is also the most
    // this can pay, which is why it is on screen (§4.2).
    expect(text()).toContain("$500");
    expect(container.querySelector('[data-role="max-payout"]')?.textContent).toBe(
      "$500.00 per contract",
    );
  });

  test("says it fills off the book, that the wings are the maker's, and that there are no greeks", () => {
    mountOnBtc();
    click(all("[data-zone]")[0] as Element);
    const body = text();
    expect(body).toContain("fills straight off the book");
    expect(body).toContain("wings are the maker's");
    // §2.4's delta shading cannot apply to a listed zone, and the screen says
    // why rather than leaving a gap where a figure would be.
    expect(body).toContain("no greeks for a listed zone");
    expect(body).not.toContain("No listed zone matches this box");
    // §7 — the word is still nowhere on the screen.
    expect(body).not.toMatch(/\bRFQ\b/);
  });

  test("a box that matches nothing says so, and hands the caller no fill", () => {
    const quotes: (ListedFill | null)[] = [];
    mountOnBtc({ onQuote: (_spec, _strikes, match) => quotes.push(match) });

    // 78500 → 79000. Both edges are rungs of the live ladder, one increment
    // apart. Nobody has listed it, which is the ordinary case on a ladder this
    // coarse — 2 of 82 drawable bands exist on the book.
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[1] as Element);

    expect(quotes).toEqual([null]);
    expect(text()).toContain("No listed zone matches this box");
    expect(text()).not.toContain("fills straight off the book");
  });

  test("an expiry with nothing listed says that too, rather than showing an empty strip", () => {
    mountOnBtc();
    // 11 Sep carries orders but no zone. Draw on it and the panel is explicit.
    const later = all("[data-expiry]").at(2);
    click(later as Element);
    expect(container.querySelector('[data-role="listed-zones"]')).toBeNull();
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[1] as Element);
    expect(text()).toContain("The book lists no zone at all on this expiry");
  });

  test("a listed zone that does not contain the current price says so", () => {
    // BTC spot on the capture is 81004.04 and the only listed band tops out at
    // 81000. On the live book ETH's two nearest expiries are the same story,
    // and a player drawing around today's price has nothing to land on.
    mountOnBtc({ spot: () => FIXTURE.prices.BTC as number });
    expect(text()).toContain("None of the listed zones on this expiry contains the current price");
  });

  test("a zone containing spot makes no such claim", () => {
    mountOnBtc({ spot: () => 80_500 });
    expect(text()).not.toContain("None of the listed zones");
  });

  test("the confirm step names the instrument the fill will actually be", () => {
    mountOnBtc({ premium: 20 });
    click(all("[data-zone]")[0] as Element);
    click(all("button").find((b) => b.textContent === "Review this box") as Element);

    const instrument = container.querySelector('[data-role="instrument"]')?.textContent ?? "";
    expect(instrument).toContain("listed zone");
    // The same four strikes are a condor's too. Calling it one here is the slip
    // the SDK itself makes, and the last place anyone would look for it.
    expect(instrument).not.toContain("condor");
    // $500 ÷ $20 = 25.00, off a real premium and the maker's own wing.
    expect(container.querySelector('[data-role="payout-multiple"]')?.textContent).toBe(
      "25.00× the premium",
    );
  });

  test("an unmatched box still confirms as the condor it would have to be", () => {
    mountOnBtc({ premium: 20 });
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[1] as Element);
    click(all("button").find((b) => b.textContent === "Review this box") as Element);
    expect(container.querySelector('[data-role="instrument"]')?.textContent).toContain(
      "long call condor",
    );
  });

  test("confirming a listed box hands the fill through, not just the condor", () => {
    const seen: (ListedFill | null)[] = [];
    mountOnBtc({ premium: 20, tradeEnabled: true, onConfirm: (_s, _k, m) => seen.push(m) });
    click(all("[data-zone]")[0] as Element);
    click(all("button").find((b) => b.textContent === "Review this box") as Element);
    click(all("button").find((b) => b.textContent === "Buy this box") as Element);
    expect(seen.length).toBe(1);
    expect(seen[0]?.spec.product).toBe("RANGER");
  });
});
