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
import {
  deriveLadder,
  liveExpiries,
  snapBox,
  strikeUsd,
  wingCandidates,
  type LadderSnapshot,
  type StrikeLadder,
} from "../src/data/box.ts";
import {
  boxToCondor,
  condorEconomics,
  type CondorEconomics,
  type CondorSpec,
} from "../src/data/condor.ts";
import { emptyHistory, type PriceHistory } from "../src/data/history.ts";
import {
  listedZones,
  zoneBox,
  zoneWingUsd,
  type ListedZone,
} from "../src/data/ranger.ts";
import {
  PRACTICE_TAPE_CHIP,
  PRACTICE_TAPE_NOTE,
  liveOpenChip,
  type RoomView,
} from "../src/data/room.ts";
import { stateAge } from "../src/theme.ts";
import { MAX_FILL_USDC } from "../src/desk/fill.ts";
import {
  BoxBuilder,
  FIELD_NOTES,
  FILL_CAP_USD,
  HISTORY_PCT,
  MAX_LOSS_COPY,
  MAX_PANEL_CONTRACTS,
  NO_HISTORY_PCT,
  SETTLEMENT_COPY,
  SIZE_COPY,
  TAIL_PCT,
  WING_COPY,
  axisScaleCopy,
  boardAxis,
  decodeBoxPick,
  encodeBoxPick,
  expiryLabel,
  fillCapCopy,
  labelledRungPrices,
  listedFill,
  positionEconomics,
  positionWingUsd,
  rungGapCopy,
  segments,
  shortAge,
  type ListedFill,
} from "../src/views/BoxBuilder.tsx";
import { FIELD_INFO_HIT, TICKET_DELAY_MS } from "../src/ui/TradeTicket.tsx";

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

/** ETH 5 Sep is `2420 · 2440 · 2460 · 2480 · 2550 · 2650`. Read off the fixture
 *  rather than typed, so a recapture moves the assertions with it. */
const ETH_LADDER_RUNGS = (deriveLadder(FIXTURE, "ETH", ETH_EXPIRIES[0] as number, NOW)?.strikes
  .length ?? 0) as number;

/**
 * A room with both seats filled and nothing locked yet — the state in which a
 * box is still a draft.
 *
 * Shaped by hand rather than read from the server because the only thing these
 * tests need from it is the lock button; `test/boxduel.test.tsx` drives the
 * real store for everything about the transport.
 */
const LOCKED_ROOM: RoomView = {
  id: "box-edit",
  joinPath: "/room/box-edit",
  host: "0x1111111111111111111111111111111111111111",
  guest: "0x2222222222222222222222222222222222222222",
  stakeUsdc: 5,
  durationMinutes: 10,
  lobbyName: "edit limits",
  seed: 424242,
  open: null,
  mode: "box",
  picks: [null, null],
  revealed: false,
  ready: [true, true],
  readyBothAt: NOW,
  updatedAt: NOW,
};

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

// ─────────────────────────────────────────────────────────────────────────────
// The board — the axes, the cells, the zoom and the handles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * happy-dom lays nothing out, so every rect is 0×0 and `priceAtClientY` — which
 * refuses a zero-height plot rather than dividing by it — returns `null` for
 * every pointer. Stubbing one rect is what lets the *arithmetic* of a drag be
 * tested at all; nothing here asserts a pixel, only which rung a price lands on.
 *
 * 300px tall over the ETH 5 Sep default window of $2,420–$2,540 makes the map
 * from clientY to price exactly `2540 − (y / 300) × 120`, so the rungs sit at
 * y = 300 (2420), 250 (2440), 200 (2460) and 150 (2480).
 */
const PLOT_RECT = { top: 0, left: 0, width: 600, height: 300 };

function withPlotRect<T>(run: () => T): T {
  const real = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function stub(this: HTMLElement) {
    return {
      ...PLOT_RECT,
      right: PLOT_RECT.left + PLOT_RECT.width,
      bottom: PLOT_RECT.top + PLOT_RECT.height,
      x: PLOT_RECT.left,
      y: PLOT_RECT.top,
      toJSON: () => ({}),
    } as DOMRect;
  } as typeof real;
  try {
    return run();
  } finally {
    HTMLElement.prototype.getBoundingClientRect = real;
  }
}

/** The clientY at which a given ETH price sits, under {@link PLOT_RECT}. */
const yFor = (price: number, lo = 2420, hi = 2540): number =>
  ((hi - price) / (hi - lo)) * PLOT_RECT.height;

let pointerId = 0;
function pointer(el: Element, type: string, clientX: number, clientY: number) {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId }),
    );
  });
}

/** Grab a handle, move once, release — the shape of every edit. */
function dragHandle(handle: Element, from: [number, number], to: [number, number]) {
  pointerId += 1;
  pointer(handle, "pointerdown", from[0], from[1]);
  pointer(handle, "pointermove", to[0], to[1]);
  pointer(handle, "pointerup", to[0], to[1]);
}

/** The box's own label, which is the floor and ceiling it is drawn at. */
const boxLabel = () =>
  container.querySelector('[data-role="box"]')?.textContent?.trim() ?? "";

/** Draw the default test box: ETH 2,420 – 2,480, two rung clicks. */
function drawBox() {
  const rungs = all("[data-rung]");
  click(rungs[0] as Element);
  click(rungs[3] as Element);
}

describe("the price axis, down the right", () => {
  test("every rung of the ladder is on the axis at the default zoom — none is dropped", () => {
    mount(<BoxBuilder {...BASE} />);
    // The ladder has six rungs and the default window shows four of them. All
    // six are still on the axis: a strike that left the board silently would be
    // one the player can no longer draw on and was never told about.
    expect(all("[data-rung]").length).toBe(ETH_LADDER_RUNGS);
    const off = all("[data-rung][data-offscreen]");
    expect(off.length).toBeGreaterThan(0);
    expect(off.every((el) => el.getAttribute("data-offscreen") === "above")).toBe(true);
    // …and each one says where it went, and that it can be got back.
    expect(off[0]?.getAttribute("title")).toContain("outside the current zoom");
  });

  test("the rungs off the board are counted in words, with the way back", () => {
    mount(<BoxBuilder {...BASE} />);
    const note = container.querySelector('[data-role="offscreen-rungs"]')?.textContent ?? "";
    expect(note).toContain("rungs above");
    expect(note).toContain("Fit ladder");
  });

  test("Fit ladder puts every rung back on the board and the notice goes", () => {
    mount(<BoxBuilder {...BASE} />);
    click(container.querySelector('[data-role="fit-ladder"]') as Element);
    expect(all("[data-rung][data-offscreen]").length).toBe(0);
    expect(container.querySelector('[data-role="offscreen-rungs"]')).toBeNull();
    // The header stops claiming a window once the window is the ladder.
    expect(container.querySelector('[data-role="window"]')).toBeNull();
  });

  test("the extent shown in the header is the ladder's, not the window's", () => {
    mount(<BoxBuilder {...BASE} />);
    // Two facts, two readouts: how much the venue quotes, and how much is on
    // screen. Collapsing them is what let a 28%-wide axis pass for a chart.
    expect(container.querySelector('[data-role="ladder-extent"]')?.textContent).toContain(
      "$2,420–$2,650",
    );
    expect(container.querySelector('[data-role="window"]')?.textContent).toContain("showing");
  });

  test("the live price is a pill on the axis, in cents, and never drawn where it is not", () => {
    mount(<BoxBuilder {...BASE} spot={() => 2450.75} />);
    const pill = container.querySelector('[data-role="spot-pill"]');
    expect(pill?.textContent).toBe("$2,450.75");
    expect(pill?.getAttribute("data-offscreen")).toBeNull();
  });

  test("the board opens on spot, so spot is never off it until the player moves", () => {
    // Worth pinning because it is the point of anchoring the window on the
    // market: whatever the ladder looks like, the price you are trading around
    // is on screen when the board opens.
    for (const at of [78_600, 80_100, 86_800]) {
      mountOnBtc({ spot: () => at });
      expect(container.querySelector('[data-role="spot-pill"]')?.getAttribute("data-offscreen")).toBeNull();
      act(() => root.unmount());
      container.remove();
      root = undefined as unknown as Root;
    }
  });

  test("once panned away, spot pins to the edge and says so rather than lying about its height", () => {
    // The same rule `fitToLadder` follows for a print: never move a price to
    // make it fit. Panning to the top of BTC's ladder leaves a spot of 78,600
    // below the board — so the pill goes to the bottom edge with an arrow,
    // instead of being drawn at a height it is not at.
    mountOnBtc({ spot: () => 78_600 });
    const top = all("[data-rung][data-offscreen='above']").at(-1);
    expect(top).toBeDefined();
    click(top as Element);
    const pill = container.querySelector('[data-role="spot-pill"]');
    expect(pill?.getAttribute("data-offscreen")).toBe("below");
    expect(pill?.textContent).toContain("↓");
    expect(pill?.getAttribute("title")).toContain("outside the current zoom");
  });
});

describe("the time axis, along the bottom", () => {
  test("labels the book's real expiry columns and nothing else", () => {
    mount(<BoxBuilder {...BASE} />);
    const labelled = all("[data-axis-expiry]").map((el) =>
      Number(el.getAttribute("data-axis-expiry")),
    );
    expect(labelled.length).toBeGreaterThan(0);
    // Every label is an expiry `liveExpiries` returned. There is no column on
    // this axis that the book did not put there.
    for (const e of labelled) expect(ETH_EXPIRIES).toContain(e);
  });

  test("the labels are wall clock, and the clock is the book's own 08:00 UTC", () => {
    mount(<BoxBuilder {...BASE} />);
    const first = all("[data-axis-expiry]")[0];
    expect(first?.textContent).toContain("08:00 UTC");
    // §2.2 — the owner's reference runs ten-second columns and this venue has
    // none. The axis says so rather than letting the spacing imply a cadence.
    expect(text()).toContain("no intraday expiry in this product");
  });

  test("no fabricated cadence: the gaps between columns are irregular", () => {
    mount(<BoxBuilder {...BASE} />);
    click(all("[data-expiry]").at(-1) as Element);
    const labelled = all("[data-axis-expiry]").map((el) =>
      Number(el.getAttribute("data-axis-expiry")),
    );
    const gaps = labelled.slice(1).map((e, i) => e - (labelled[i] as number));
    // Tomorrow, the day after, then weeklies. Evenly spaced columns would be
    // promising dates that do not exist.
    expect(new Set(gaps).size).toBeGreaterThan(1);
  });

  test("NOW carries a real clock time, so the axis reads as a countdown", () => {
    mount(<BoxBuilder {...BASE} />);
    expect(container.querySelector('[data-role="time-axis"]')?.textContent).toMatch(
      /NOW\d{2}:\d{2} UTC/,
    );
  });
});

describe("the cell grid", () => {
  test("draws a cell per rung band per column, and marks what is drawable", () => {
    mount(<BoxBuilder {...BASE} />);
    const cells = all("[data-cell]");
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.every((c) => c.getAttribute("data-buyable") === "draw")).toBe(true);
  });

  test("without a registry nothing is claimed to be on the book", () => {
    // The same orders, byte for byte. With no way to resolve the product there
    // is no listed cell, because a four-strike order is not proof of a zone.
    mount(<BoxBuilder {...BASE} />);
    expect(all("[data-listed-cell]").length).toBe(0);
  });

  test("a listed zone is drawn at its own edges, as the cell that fills off the book", () => {
    mountOnBtc();
    const listed = all("[data-listed-cell]");
    expect(listed.length).toBeGreaterThan(0);
    expect(listed.every((c) => c.getAttribute("data-buyable") === "book")).toBe(true);
    // One per (column, zone) — and the count is the book's, not a layout's.
    // The capture lists 80,000–81,000 on BTC 5 Sep and 6 Sep.
    expect(listed.map((c) => c.getAttribute("data-listed-cell"))).toContain(
      "1788595200-8000000000000-8100000000000",
    );
  });

  test("the three states are named where they are drawn", () => {
    mount(<BoxBuilder {...BASE} />);
    const legend = container.querySelector('[data-role="cell-legend"]')?.textContent ?? "";
    expect(legend).toContain("on the book — fills now");
    expect(legend).toContain("drawable — priced on demand");
    expect(legend).toContain("no strikes — nothing to draw");
  });

  test("a cell carries no price and no odds — that number does not exist for it", () => {
    // The reference this was drawn from prints odds in every cell. Doing that
    // here would mean pricing several hundred structures nobody has quoted,
    // which is either an invented model or an invented number (§4.4). A cell
    // says whether it is buyable and nothing more.
    mount(<BoxBuilder {...BASE} />);
    for (const cell of [...all("[data-cell]"), ...all("[data-listed-cell]")]) {
      expect(cell.textContent).toBe("");
    }
  });

  test("the range a column has no strike in is hatched, not left blank", () => {
    // The book does not quote the same range on every date. On this capture BTC
    // lists $78,500–$87,000 on 5 Sep and only $74,000–$79,000 on 11 Sep, so
    // looking at the 11 Sep board most of the 5 Sep column is a band nobody
    // quotes on that date. Blank would read as "drawable, just empty"; it is
    // not drawable at all.
    mountOnBtc();
    click(all("[data-expiry]").at(2) as Element);
    const dead = all('[data-buyable="none"]');
    expect(dead.length).toBeGreaterThan(0);
    expect(dead.some((d) => (d.getAttribute("title") ?? "").includes("no strike"))).toBe(true);
    // …and it is a region, never a claim about a price: no numbers inside it.
    expect(dead.every((d) => d.textContent === "")).toBe(true);
  });
});

describe("zoom is a view, never a pick", () => {
  test("the same two rungs quote the same strikes at any zoom level", () => {
    // The property the duel rests on: two seats looking at different rectangles
    // of the same board must post the same position.
    const zoomed: number[][] = [];
    mount(<BoxBuilder {...BASE} onQuote={(_s, strikes) => zoomed.push([...strikes])} />);
    drawBox();
    act(() => root.unmount());
    container.remove();

    const fitted: number[][] = [];
    mount(<BoxBuilder {...BASE} onQuote={(_s, strikes) => fitted.push([...strikes])} />);
    click(container.querySelector('[data-role="fit-ladder"]') as Element);
    drawBox();

    expect(zoomed.length).toBe(1);
    expect(fitted).toEqual(zoomed);
  });

  test("zooming does not redraw, requote or move the box", () => {
    const quotes: number[][] = [];
    mount(<BoxBuilder {...BASE} onQuote={(_s, strikes) => quotes.push([...strikes])} />);
    drawBox();
    const before = boxLabel();
    expect(quotes.length).toBe(1);

    click(container.querySelector('[data-role="fit-ladder"]') as Element);
    // Same box, same strikes, and above all no second price call: the viewport
    // cannot reach the position.
    expect(boxLabel()).toBe(before);
    expect(quotes.length).toBe(1);
  });

  test("zoom out stops at the ladder and the control says so", () => {
    mount(<BoxBuilder {...BASE} />);
    const out = () => container.querySelector('[data-role="zoom-out"]') as HTMLButtonElement;
    expect(out().disabled).toBe(false);
    for (let i = 0; i < 12; i += 1) if (!out().disabled) click(out());
    // There is nothing above the ladder — outside it the venue quotes nothing,
    // so a wider view would be empty space with no box drawable in it.
    expect(out().disabled).toBe(true);
    expect(all("[data-rung][data-offscreen]").length).toBe(0);
  });

  test("clicking a rung the zoom has covered brings the board back to it", () => {
    mount(<BoxBuilder {...BASE} />);
    const off = all("[data-rung][data-offscreen]");
    expect(off.length).toBeGreaterThan(0);
    click(off[0] as Element);
    // That rung is now on the board — which is what makes "every rung stays
    // reachable" true rather than aspirational.
    const strike = off[0]?.getAttribute("data-rung");
    const now = all("[data-rung]").find((el) => el.getAttribute("data-rung") === strike);
    expect(now?.getAttribute("data-offscreen")).toBeNull();
  });
});

describe("editing a committed box", () => {
  test("the handles exist while the box is a draft, and say what they do", () => {
    mount(<BoxBuilder {...BASE} />);
    drawBox();
    const kinds = all("[data-handle]").map((el) => el.getAttribute("data-handle"));
    expect(kinds.sort()).toEqual([
      "ceiling",
      "corner-ceiling",
      "corner-floor",
      "expiry",
      "floor",
      "move",
    ]);
    // There is no left handle, and that is the design rather than an omission:
    // the box starts at now because it is a prediction (§2.3).
    expect(kinds).not.toContain("start");
  });

  test("dragging the ceiling lands it on a rung", () => {
    withPlotRect(() => {
      mount(<BoxBuilder {...BASE} />);
      drawBox();
      expect(boxLabel()).toBe("$2,420 – $2,480");
      const handle = container.querySelector('[data-handle="ceiling"]') as Element;
      dragHandle(handle, [300, yFor(2480)], [300, yFor(2441)]);
      // 2,441 is not a strike. 2,440 is, and it is the one the venue quotes
      // nearest — nothing rounds to an increment of ours.
      expect(boxLabel()).toBe("$2,420 – $2,440");
    });
  });

  test("the ceiling stops one rung above the floor and cannot cross it", () => {
    withPlotRect(() => {
      mount(<BoxBuilder {...BASE} />);
      drawBox();
      const handle = container.querySelector('[data-handle="ceiling"]') as Element;
      // Drag it well below the floor. The clamp is the ladder's minimum box —
      // one rung — which `minBoxHeight` also states in dollars on screen.
      dragHandle(handle, [300, yFor(2480)], [300, yFor(2400)]);
      expect(boxLabel()).toBe("$2,420 – $2,440");
    });
  });

  test("the floor stops one rung below the ceiling and cannot cross it", () => {
    withPlotRect(() => {
      mount(<BoxBuilder {...BASE} />);
      drawBox();
      const handle = container.querySelector('[data-handle="floor"]') as Element;
      dragHandle(handle, [300, yFor(2420)], [300, yFor(2600)]);
      expect(boxLabel()).toBe("$2,460 – $2,480");
    });
  });

  test("moving keeps the box's height in rungs and stops at the end of the ladder", () => {
    withPlotRect(() => {
      mount(<BoxBuilder {...BASE} />);
      drawBox(); // 2420–2480, three rungs tall
      const body = container.querySelector('[data-handle="move"]') as Element;
      dragHandle(body, [300, yFor(2450)], [300, yFor(2470)]);
      // One rung up: 2440–2550 — still three rungs, and the ceiling has landed
      // on the next strike the book quotes rather than $20 higher.
      expect(boxLabel()).toBe("$2,440 – $2,550");
    });
  });

  test("a move cannot walk the box off the ladder", () => {
    withPlotRect(() => {
      mount(<BoxBuilder {...BASE} />);
      drawBox();
      const body = container.querySelector('[data-handle="move"]') as Element;
      dragHandle(body, [300, yFor(2450)], [300, 0]);
      // Slid as far as it goes and no further: the top rung is the top rung.
      const label = boxLabel();
      expect(label.endsWith("$2,650")).toBe(true);
      expect(container.querySelector('[data-role="box"]')).not.toBeNull();
    });
  });

  test("an edit re-quotes exactly once, and never during the drag", () => {
    withPlotRect(() => {
      const quotes: number[][] = [];
      mount(<BoxBuilder {...BASE} onQuote={(_s, strikes) => quotes.push([...strikes])} />);
      drawBox();
      expect(quotes.length).toBe(1);
      const handle = container.querySelector('[data-handle="ceiling"]') as Element;
      pointerId += 1;
      pointer(handle, "pointerdown", 300, yFor(2480));
      pointer(handle, "pointermove", 300, yFor(2460));
      pointer(handle, "pointermove", 300, yFor(2440));
      // §4.1 — a drag paints an outline and calls nothing.
      expect(quotes.length).toBe(1);
      pointer(handle, "pointerup", 300, yFor(2440));
      expect(quotes.length).toBe(2);
    });
  });

  test("an edited box is still a snapped box — the wire format cannot drift", () => {
    withPlotRect(() => {
      const specs: CondorSpec[] = [];
      mount(<BoxBuilder {...BASE} onQuote={(spec) => specs.push(spec)} />);
      drawBox();
      dragHandle(
        container.querySelector('[data-handle="ceiling"]') as Element,
        [300, yFor(2480)],
        [300, yFor(2440)],
      );
      // Both boxes came out of `snapBox`, so both encode and decode. There is
      // no second way to build a `Box` in the view, which is what keeps editing
      // from desynchronising `encodeBoxPick`.
      expect(specs.length).toBe(2);
      for (const spec of specs) {
        const box = {
          underlying: spec.underlying,
          floor: spec.strikes[1],
          ceiling: spec.strikes[2],
          wing: "1",
          expiry: spec.expiry,
        };
        expect(decodeBoxPick(encodeBoxPick(box))).toEqual(box);
      }
    });
  });

  test("a locked box has no handles at all, and says why", () => {
    // The rectangle the opponent is playing against is not a draft any more.
    mount(
      <BoxBuilder
        {...BASE}
        room={LOCKED_ROOM}
        seat="host"
        onLock={() => {}}
      />,
    );
    drawBox();
    click(all("button").find((b) => b.textContent === "Lock this box") as Element);
    expect(all("[data-handle]").length).toBe(0);
    expect(container.querySelector('[data-role="edit-hint"]')?.textContent).toContain(
      "can no longer be moved or resized",
    );
  });
});

describe("the wing, which is the maximum payout", () => {
  test("steps only through widths the ladder can express", () => {
    mount(<BoxBuilder {...BASE} />);
    drawBox();
    // 2420–2480 on a ladder whose rungs above are 2550 and 2650: the ladder
    // expresses $70 and $170 here, and nothing between them.
    expect(container.querySelector('[data-role="wing-value"]')?.textContent).toBe("$70");
    click(container.querySelector('[data-role="wing-up"]') as Element);
    expect(container.querySelector('[data-role="wing-value"]')?.textContent).toBe("$170");
    // The wing IS the max payout — plan 7 measured the same of a listed zone —
    // so stepping it steps the upside, and the panel shows that it did.
    expect(container.querySelector('[data-role="max-payout"]')?.textContent).toBe(
      "$170.00 per contract",
    );
  });

  test("the stepper stops at the ends rather than wrapping or inventing a width", () => {
    mount(<BoxBuilder {...BASE} />);
    drawBox();
    const up = () => container.querySelector('[data-role="wing-up"]') as HTMLButtonElement;
    const down = () => container.querySelector('[data-role="wing-down"]') as HTMLButtonElement;
    expect(down().disabled).toBe(true); // already the narrowest
    click(up());
    expect(up().disabled).toBe(true); // and now the widest
    expect(container.querySelector('[data-role="wing-value"]')?.textContent).toBe("$170");
  });

  test("on a listed zone the wing is the maker's and the stepper is off", () => {
    mountOnBtc();
    click(all("[data-zone]")[0] as Element);
    expect(
      (container.querySelector('[data-role="wing-up"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(text()).toContain("wings are the maker's");
    expect(text()).toContain("its wings came with it");
  });
});

describe("the board with no book behind it", () => {
  test("is built rather than fallen through — and blames nobody", () => {
    mount(<BoxBuilder {...BASE} snapshot={{ orders: [], chainConfig: FIXTURE.chainConfig }} />);
    const card = container.querySelector('[data-role="no-board"]');
    expect(card).not.toBeNull();
    expect(card?.textContent).toContain("No live expiries on ETH");
    expect(card?.textContent).toContain("comes from resting orders");
    // It says what is missing, never why. Guessing at a cause is how this repo
    // once blamed the venue for a local DNS block.
    expect(card?.textContent).not.toMatch(/outage|down|unreachable|error/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Four bugs the arena carried, and the four sentences that close them
//
// Each test below fails on the code as it stood. They are grouped because they
// share one shape: a screen asserting something the data behind it did not say.
// ─────────────────────────────────────────────────────────────────────────────

/** A `PriceHistory` shaped exactly as `createHistorySource` returns one. The
 *  suite above has its own copy inside a closure; this is the same builder. */
function historyLine(points: readonly { t: number; px: number }[], at: number): PriceHistory {
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

describe("the eighth money bug — one instrument answers the money questions", () => {
  /**
   * The exact state the UI can reach, built with the UI's own functions.
   *
   * `wingCandidates` is what the stepper offers, `snapBox` is the only thing in
   * `BoxBuilder` that builds a `Box`, and `endEdit` carries the wing across a
   * band drag — so a box on the listed band carrying a wing that is *not* the
   * maker's is a box a player can hold. Nothing here is synthesised.
   */
  function widenedOntoListed() {
    const zone = listedZones(BOOKED, NOW)[0] as ListedZone;
    const ladder = deriveLadder(BOOKED, zone.underlying, zone.expiry, NOW) as StrikeLadder;
    const drawn = zoneBox(zone);
    const wings = wingCandidates(ladder, drawn.floor, drawn.ceiling);
    // The widest width the ladder expresses at this band — $4,000 against the
    // maker's $500, which is the audit's own pair.
    const wide = wings.find((w) => strikeUsd(w) === 4000) as string;
    return { zone, box: snapBox({ ...drawn, wing: wide }, ladder) };
  }

  test("a wider wing still matches the listed zone — the match is on the band alone", () => {
    // Not a defect: a listed zone's wings are the maker's and the player does
    // not choose them, which is what `LISTED_WING_COPY` says on screen. This
    // test pins the premise the bug rests on so the fix cannot be mistaken for
    // "make the wing filter".
    const { zone, box } = widenedOntoListed();
    expect(strikeUsd(box.wing)).toBe(4000);
    expect(zoneWingUsd(zone)).toBe(500);
    expect(listedFill(box, BOOKED, NOW)?.zone.index).toBe(zone.index);
  });

  test("max payout comes from the order that pays it, not from the drawing", () => {
    const { box } = widenedOntoListed();
    const match = listedFill(box, BOOKED, NOW) as ListedFill;
    const spec = boxToCondor(box);

    // The shape of the bug, stated so it cannot come back quietly: the drawn
    // box's own arithmetic promises eight times what the order settles.
    expect(condorEconomics(spec, 120, 1).maxPayout).toBe(4000);
    expect(condorEconomics(spec, 120, 1).payoutMultiple).toBeCloseTo(4000 / 120, 6);

    // What the screen prints now. The premium was previewed against
    // `match.zone.order`, so the ceiling has to be that order's wing or the
    // ratio between them is a ratio of two different contracts.
    const econ = positionEconomics(spec, match, 120, 1) as CondorEconomics;
    expect(econ.maxPayout).toBe(500);
    expect(econ.maxLoss).toBe(120);
    expect(econ.payoutMultiple).toBeCloseTo(500 / 120, 6);
  });

  test("with no match the box is still the condor the player drew", () => {
    // The fix must not quietly re-price the unlisted path, which is most boxes.
    const { box } = widenedOntoListed();
    const spec = boxToCondor(box);
    expect((positionEconomics(spec, null, 120, 1) as CondorEconomics).maxPayout).toBe(4000);
    expect(positionEconomics(null, null, 120, 1)).toBeNull();
  });

  test("the wing the panel prints is the wing the position has", () => {
    const { zone, box } = widenedOntoListed();
    const match = listedFill(box, BOOKED, NOW) as ListedFill;
    // The row sits directly under "its wings came with it", so printing the
    // drawing's wing there made that sentence false about the number above it.
    expect(positionWingUsd(box, match)).toBe(zoneWingUsd(zone));
    expect(positionWingUsd(box, null)).toBe(4000);
    expect(positionWingUsd(null, null)).toBeNull();
  });

  test("on screen, a picked zone prices off the maker's wing end to end", () => {
    mountOnBtc({ premium: 120 });
    click(all("[data-zone]")[0] as Element);
    expect(container.querySelector('[data-role="wing-value"]')?.textContent).toBe("$500");
    expect(container.querySelector('[data-role="max-payout"]')?.textContent).toBe(
      "$500.00 per contract",
    );
    expect(container.querySelector('[data-role="payout-multiple"]')?.textContent).toBe(
      `${(500 / 120).toFixed(2)}× the premium`,
    );
    expect(container.querySelector('[data-role="max-loss"]')?.textContent).toBe("$120.00");
  });
});

describe("the ladder's heading claims only what the caller said", () => {
  test("with no provenance it asserts none", () => {
    // The bug: this read `LIVE STRIKES` unconditionally, on a path
    // `useLiveMarket` reaches with a stale ladder by design.
    mount(<BoxBuilder {...BASE} />);
    expect(text()).toContain("ETH · STRIKES");
    expect(text()).not.toContain("LIVE STRIKES");
    expect(container.querySelector('[data-role="ladder-age"]')).toBeNull();
  });

  test("a live read says LIVE, and carries no age because it does not need one", () => {
    mount(<BoxBuilder {...BASE} feed={{ state: "live", at: NOW - 8_000 }} />);
    expect(text()).toContain("ETH · LIVE STRIKES");
    expect(container.querySelector('[data-role="ladder-age"]')).toBeNull();
  });

  test("a stale read says STALE and always beside its age", () => {
    // `theme.ts`: for STALE "the age is the disclosure; the word alone is not".
    mount(<BoxBuilder {...BASE} feed={{ state: "stale", at: NOW - 45 * 60_000 }} />);
    expect(text()).toContain("ETH · STALE STRIKES");
    expect(container.querySelector('[data-role="ladder-age"]')?.textContent).toBe(
      stateAge(NOW - 45 * 60_000, NOW) ?? "",
    );
  });

  test("a stale read with no timestamp says STALE without inventing a duration", () => {
    mount(<BoxBuilder {...BASE} feed={{ state: "stale", at: 0 }} />);
    expect(text()).toContain("ETH · STALE STRIKES");
    expect(container.querySelector('[data-role="ladder-age"]')).toBeNull();
  });
});

describe("the room's opening print, rendered rather than merely captured", () => {
  const ROOM: RoomView = {
    id: "r1",
    joinPath: "/room/r1",
    host: "0x1111111111111111111111111111111111111111",
    guest: "0x2222222222222222222222222222222222222222",
    stakeUsdc: 10,
    durationMinutes: 5,
    lobbyName: "kz",
    seed: 42,
    open: null,
    mode: "box",
    picks: [null, null],
    revealed: false,
    ready: [true, true],
    readyBothAt: NOW,
    updatedAt: NOW,
  };

  test("no captured open is a practice tape, and it says both halves", () => {
    // `openFor` was built so a screen cannot render a reference price where a
    // live one is implied. Nothing in this file destructured it, so the whole
    // disclosure was invisible.
    mount(<BoxBuilder {...BASE} room={ROOM} seat="host" onLock={() => {}} />);
    const chip = container.querySelector('[data-role="room-open"]');
    expect(chip?.getAttribute("data-open-live")).toBe("false");
    expect(chip?.textContent).toBe(PRACTICE_TAPE_CHIP);
    expect(container.querySelector('[data-role="practice-tape"]')?.textContent).toBe(
      PRACTICE_TAPE_NOTE,
    );
  });

  test("a real captured open says so, names the feed, and drops the practice note", () => {
    const open = {
      px: { ETH: 2453.17 },
      source: "chainlink" as const,
      at: NOW - 12_000,
      label: "Chainlink · Base 8453",
    };
    mount(<BoxBuilder {...BASE} room={{ ...ROOM, open }} seat="host" onLock={() => {}} />);
    const chip = container.querySelector('[data-role="room-open"]');
    expect(chip?.getAttribute("data-open-live")).toBe("true");
    expect(chip?.textContent).toContain(liveOpenChip(open));
    expect(chip?.textContent).toContain("$2,453.17");
    expect(container.querySelector('[data-role="practice-tape"]')).toBeNull();
  });

  test("a capture with no price for the asset on screen is still a practice tape", () => {
    // `openFor` answers per symbol, not per capture — BTC has a feed here and
    // the chart opens on ETH's ladder.
    const open = {
      px: { BTC: 79_644 },
      source: "chainlink" as const,
      at: NOW - 12_000,
      label: "Chainlink · Base 8453",
    };
    mount(<BoxBuilder {...BASE} room={{ ...ROOM, open }} seat="host" onLock={() => {}} />);
    expect(
      container.querySelector('[data-role="room-open"]')?.getAttribute("data-open-live"),
    ).toBe("false");
  });
});

describe("a chart that is blank because of the book says so", () => {
  test("every print outside the ladder leaves a sentence, not a silence", () => {
    // The ETH 5 Sep ladder runs 2420-2650. A price line entirely at $9,000 is
    // BTC's 25 Sep column in miniature: real prints, a real ladder, and no
    // overlap between them. `hasLine` is false, so the "clipped" clause that
    // would have explained it was gated off by the very fact it describes.
    const points = Array.from({ length: 12 }, (_, i) => ({
      t: NOW - (20 - i) * 60_000,
      px: 9_000,
    }));
    mount(<BoxBuilder {...BASE} history={historyLine(points, NOW)} />);
    const note = container.querySelector('[data-role="no-coverage"]');
    expect(note).not.toBeNull();
    expect(note?.textContent).toContain("All 12 prints are outside this expiry's ladder");
    // It names the band, because the band is the answer.
    expect(note?.textContent).toContain("The book quotes ETH at");
    // And it blames the book rather than the chart — the direction this repo
    // has got wrong before (`docs/asset-gate.md`).
    expect(note?.textContent).toContain("because of the book, not the chart");
    expect(note?.textContent).not.toMatch(/outage|down|unreachable|error/i);
  });

  test("the two causes never merge into one number", () => {
    // Reporting them together would blame the venue for a viewport, which is
    // exactly the pair the clipped/hidden split already keeps apart.
    const points = Array.from({ length: 6 }, (_, i) => ({
      t: NOW - (20 - i) * 60_000,
      px: 9_000,
    }));
    const note = (() => {
      mount(<BoxBuilder {...BASE} history={historyLine(points, NOW)} />);
      return container.querySelector('[data-role="no-coverage"]')?.textContent ?? "";
    })();
    expect(note).toContain("outside this expiry's ladder");
    expect(note).not.toContain("outside this zoom");
  });

  test("no history at all makes no claim about coverage", () => {
    mount(<BoxBuilder {...BASE} />);
    expect(container.querySelector('[data-role="no-coverage"]')).toBeNull();
  });

  test("a drawable line says nothing about coverage either", () => {
    const points = Array.from({ length: 20 }, (_, i) => ({
      t: NOW - (30 - i) * 60_000,
      px: 2450 + i,
    }));
    mount(<BoxBuilder {...BASE} history={historyLine(points, NOW)} />);
    expect(container.querySelector('[data-role="no-coverage"]')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The controls a trade needs, and the sentences a discrete instrument owes
// ─────────────────────────────────────────────────────────────────────────────

describe("position size — the half of a ticket that was missing", () => {
  test("the panel carries a size control at all", () => {
    // `contracts` was a prop defaulting to 1 whose only caller forwarded its own
    // default, so there was no way to say how much to buy.
    mount(<BoxBuilder {...BASE} />);
    expect(container.querySelector('[data-role="size-input"]')).not.toBeNull();
    expect(container.querySelector('[data-role="size-up"]')).not.toBeNull();
    expect(container.querySelector('[data-role="size-down"]')).not.toBeNull();
  });

  test("both dollar figures scale with it and the multiple does not", () => {
    // The invariant that says the units agree: premium and ceiling are two
    // totals over one position, so their ratio is size-free.
    mountOnBtc({ premium: 120 });
    click(all("[data-zone]")[0] as Element);
    expect(container.querySelector('[data-role="max-loss"]')?.textContent).toBe("$120.00");
    expect(container.querySelector('[data-role="max-payout"]')?.textContent).toBe(
      "$500.00 per contract",
    );

    click(container.querySelector('[data-role="size-up"]') as Element);
    click(container.querySelector('[data-role="size-up"]') as Element);
    expect(container.querySelector('[data-role="size-input"]') as HTMLInputElement).toHaveProperty(
      "value",
      "3",
    );
    expect(container.querySelector('[data-role="max-loss"]')?.textContent).toBe("$360.00");
    // "per contract" drops away the moment the position is not one contract.
    expect(container.querySelector('[data-role="max-payout"]')?.textContent).toBe("$1,500.00");
    expect(container.querySelector('[data-role="payout-multiple"]')?.textContent).toBe(
      `${(500 / 120).toFixed(2)}× the premium`,
    );
  });

  test("the size cannot go below one or past the panel's own bound", () => {
    mount(<BoxBuilder {...BASE} />);
    expect(
      (container.querySelector('[data-role="size-down"]') as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(MAX_PANEL_CONTRACTS).toBeGreaterThan(1);
  });

  test("the fill cap is stated in dollars, and it is the code's cap", () => {
    // `MAX_FILL_USDC` is checked in `runFill` before a dependency is touched,
    // so the panel is reporting a bound rather than imposing one.
    expect(FILL_CAP_USD).toBe(Number(MAX_FILL_USDC) / 1_000_000);
    expect(fillCapCopy(null)).toContain("$2.00 a press");
    expect(fillCapCopy(0.5)).toContain("4 contracts");
    // A box that costs more than the cap says so plainly rather than offering a
    // button that cannot fire.
    expect(fillCapCopy(120)).toContain("none at all");
    mountOnBtc({ premium: 120 });
    click(all("[data-zone]")[0] as Element);
    expect(container.querySelector('[data-role="fill-cap"]')?.textContent).toContain(
      "none at all",
    );
  });

  test("no depth limit is claimed, because none was measured", () => {
    // `availableAmount` is in the collateral token's own decimals and this
    // screen holds no map to convert it. Inventing a cap from it is the shape
    // of every money bug in this repo.
    mount(<BoxBuilder {...BASE} />);
    expect(text()).toContain("does not convert it — so no depth limit is claimed here");
  });
});

describe("zoom says what it is doing, including when it can do nothing", () => {
  test("the state is on screen beside the controls", () => {
    mount(<BoxBuilder {...BASE} />);
    expect(container.querySelector('[data-role="zoom-state"]')?.textContent).toMatch(
      /showing \d+ of \d+ rungs/,
    );
  });

  test("a control that cannot move is disabled rather than enabled and inert", () => {
    // The bug: `+` was gated on `view.steps <= MIN_ZOOM_STEPS`, which on a
    // coarse column is false while `zoomTo` still clamps to the identical
    // window. Enabled and doing nothing is indistinguishable from broken.
    mount(<BoxBuilder {...BASE} />);
    const inBtn = container.querySelector('[data-role="zoom-in"]') as HTMLButtonElement;
    const outBtn = container.querySelector('[data-role="zoom-out"]') as HTMLButtonElement;
    const before = container.querySelector('[data-role="window"]')?.textContent ?? null;
    if (!inBtn.disabled) {
      click(inBtn);
      expect(container.querySelector('[data-role="window"]')?.textContent).not.toBe(before);
    }
    // Whatever the ladder allows, an enabled control must actually move it.
    for (const b of [inBtn, outBtn]) {
      if (b.disabled) continue;
      const was = container.querySelector('[data-role="window"]')?.textContent ?? "";
      click(b);
      const now = container.querySelector('[data-role="window"]')?.textContent ?? "";
      expect(now === was).toBe(false);
    }
  });
});

describe("the strikes are visible before the drag, and their discreteness is said", () => {
  test("every rung is a gridline, and its price is on the ONE price axis", () => {
    // CHANGED, deliberately. This used to assert the gridlines carried price
    // text, and they did — which gave the board two price axes printing the
    // same numbers, one down each edge, and stacked `$2,400` on `$2,360` on
    // `$2,350` on any dense window. The property being protected was never
    // "the text is inside the plot"; it was **the snap targets are readable
    // before a drag rather than discoverable only by drawing a box**, and that
    // is asserted here more strongly than it was: every rung's price is on the
    // right-hand rail, and every one of them is a button that draws from it.
    mount(<BoxBuilder {...BASE} />);
    const lines = all("[data-gridline]");
    expect(lines.length).toBeGreaterThan(1);
    // A line still names its strike, so a test can address one without prose.
    expect(lines.every((l) => (l.getAttribute("data-gridline") ?? "").length > 0)).toBe(true);
    // And it carries no price of its own. The duplicate axis is gone.
    expect(lines.some((l) => /\$[\d,]/.test(l.textContent ?? ""))).toBe(false);
    const rungs = all("[data-rung]");
    expect(rungs.length).toBeGreaterThanOrEqual(lines.length);
    // The price is the accessible name whether or not the digits are printed,
    // so a thinned rung is thinned on screen and nowhere else.
    expect(rungs.every((r) => /\$[\d,]/.test(r.getAttribute("aria-label") ?? ""))).toBe(true);
    expect(rungs.some((r) => /\$[\d,]/.test(r.textContent ?? ""))).toBe(true);
  });

  test("the panel answers 'why can I not size it to the cent' in both directions", () => {
    mount(<BoxBuilder {...BASE} />);
    const said = container.querySelector('[data-role="precision"]')?.textContent ?? "";
    // The instrument really is discrete …
    expect(said).toContain("Strikes are discrete");
    expect(said).toContain("strikes, ");
    expect(said).toContain("apart at the median");
    // … and the precise path really does exist, and is honestly not wired here.
    expect(said).toContain("quoted on request at any strikes");
    expect(said).toContain("not wired into this screen in this build");
  });

  test("the gap sentence is the ladder's own arithmetic, not a constant", () => {
    const eth = deriveLadder(FIXTURE, "ETH", liveExpiries(FIXTURE, "ETH", NOW)[0] as number, NOW);
    expect(rungGapCopy(eth)).toContain(`${eth?.prices.length} strikes`);
    expect(rungGapCopy(null)).toBeNull();
  });
});

describe("the axis explains its own shape rather than looking broken", () => {
  test("the two halves of the time axis are stated, and named as two scales", () => {
    // CHANGED, because the axis changed. It used to be one linear scale from
    // the oldest print to the chosen expiry, and the sentence said so. It is
    // two now — time on the left of NOW, equal columns on the right — and a
    // chart whose halves have different scales has to say so or it is lying by
    // omission. The half of the old assertion that must survive is the one
    // about the prints, because that is the promise the left half still keeps.
    const points = Array.from({ length: 20 }, (_, i) => ({
      t: NOW - (30 - i) * 60_000,
      px: 2450 + i,
    }));
    mount(<BoxBuilder {...BASE} history={historyLine(points, NOW)} />);
    const said = container.querySelector('[data-role="axis-scale"]')?.textContent ?? "";
    expect(said).toContain("of history, linear in time");
    expect(said).toContain("the prints stay where they were made");
    // And the new half: the columns are the book's dates, equally wide, and the
    // even spacing is explicitly not a cadence.
    expect(said).toContain("gets an equal column");
    expect(said).toContain("Column width is not time");
  });

  test("a clipped line says why it starts where it starts", () => {
    const points = [
      ...Array.from({ length: 8 }, (_, i) => ({ t: NOW - (30 - i) * 60_000, px: 9_000 })),
      ...Array.from({ length: 8 }, (_, i) => ({ t: NOW - (20 - i) * 60_000, px: 2450 + i })),
    ];
    mount(<BoxBuilder {...BASE} history={historyLine(points, NOW)} />);
    expect(text()).toContain("begins where the price entered the board");
  });

  test("no line, no claim about a left half — but the columns still explain themselves", () => {
    // CHANGED for the same reason. The property was "do not claim history that
    // did not arrive", and it holds: with no line the sentence says nothing
    // about the past. What it does still say is that the columns are equal and
    // that their width is not time, which is true with or without a price feed
    // and is the thing a player could otherwise misread.
    mount(<BoxBuilder {...BASE} />);
    const said = container.querySelector('[data-role="axis-scale"]')?.textContent ?? "";
    expect(said).not.toContain("of history");
    expect(said).not.toContain("prints");
    expect(said).toContain("gets an equal column");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Teaching behind the ⓘ, disclosure on the panel
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A pointer arriving, the way a browser actually delivers it.
 *
 * React does not listen for `pointerenter`; it delegates `pointerover` at the
 * root and synthesises the enter/leave pair from it. Dispatching a bare
 * non-bubbling `pointerenter` would reach nothing, and the test would pass on a
 * handler that never fires in a browser. `test/ticket.test.tsx` says the same
 * at more length, over the same hook.
 */
function hover(el: HTMLElement, pointerType: string) {
  el.dispatchEvent(
    Object.assign(new MouseEvent("pointerover", { bubbles: true, relatedTarget: null }), {
      pointerType,
    }),
  );
}

function unhover(el: HTMLElement, pointerType: string) {
  el.dispatchEvent(
    Object.assign(new MouseEvent("pointerout", { bubbles: true, relatedTarget: null }), {
      pointerType,
    }),
  );
}

const info = (id: string) =>
  container.querySelector(`[data-field-info="${id}"]`) as HTMLButtonElement | null;
const tip = () => container.querySelector("[data-trade-ticket]");

/** A drawn ETH box with nothing priced — the state the panel is hardest in,
 *  because most figures are dashes whose only content is *why*. */
function drawEthBox() {
  mount(<BoxBuilder {...BASE} />);
  const rungs = all("[data-rung]");
  click(rungs[0] as Element);
  click(rungs[3] as Element);
}

describe("the panel reads as figures, with the teaching behind an ⓘ", () => {
  test("no definition is on the panel until one is asked for", () => {
    // The owner's complaint, as an assertion: three headings should not be
    // buried in six paragraphs. Every line named here is timeless — it would be
    // true of another box on another book on another day — which is the whole
    // test for whether a sentence was allowed to move behind a gesture.
    drawEthBox();
    const said = text();
    expect(said).not.toContain(MAX_LOSS_COPY);
    expect(said).not.toContain(SIZE_COPY);
    expect(said).not.toContain(WING_COPY);
    for (const line of FIELD_NOTES.maxPayout) expect(said).not.toContain(line);
    // And nothing is open: the panel is absent, not merely transparent.
    expect(tip()).toBeNull();
  });

  test("every disclosure is on the panel with no interaction at all", () => {
    // The other pile, and the reason it is a different pile. Each of these is a
    // fact about THIS box against THIS build right now, and a player who never
    // hovers has to read all of them: why a figure is a dash, what this build
    // will actually sign, and the depth limit it deliberately does not claim.
    drawEthBox();
    const said = text();
    expect(said).toContain("Nothing has priced this box yet, so there is no cost to scale.");
    expect(said).toContain("Nothing has priced this box yet, so there is no figure to print.");
    expect(said).toContain("Buying is capped at $2.00 a press in this build");
    expect(said).toContain("does not convert it — so no depth limit is claimed here");
    expect(said).toContain("widths at this band");
    // "Lands in", never "stays within" — the one line that is both teaching and
    // disclosure, and it stayed visible because a player who believes the price
    // must STAY in the band draws a box far too wide and pays for range they
    // did not need. The longer version is behind the ⓘ; this is not.
    expect(container.querySelector('[data-role="settlement"]')?.textContent).toBe(SETTLEMENT_COPY);
    expect(said).not.toContain("stays within");
  });

  test("a mouse hover reveals one figure's definition, and a leave takes it back", async () => {
    drawEthBox();
    const btn = info("box:maxLoss") as HTMLButtonElement;
    act(() => {
      hover(btn, "mouse");
    });
    // Not immediately. The settle delay is the trade ticket's own, unmodified,
    // so a pointer crossing four ⓘ on its way to the Review button opens none.
    expect(tip()).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, TICKET_DELAY_MS + 40));
    });
    expect(tip()?.textContent).toContain(MAX_LOSS_COPY);
    act(() => {
      unhover(btn, "mouse");
    });
    expect(tip()).toBeNull();
  });

  test("the keyboard reaches every ⓘ, opens it with no delay, and traps nothing", () => {
    // The panel's hover ticket is deliberately out of the tab order, because
    // the card it describes is already a button and is the trigger. These are
    // not that: `MAX LOSS` is a span and a dollar figure is a span, so without
    // a real focusable control the explanation would be pointer-only.
    drawEthBox();
    const labels: [string, string][] = [
      ["box", "PRICE BAND"],
      ["box:wing", "WING WIDTH"],
      ["box:size", "SIZE"],
      ["box:maxLoss", "MAX LOSS"],
      ["box:maxPayout", "MAX PAYOUT"],
    ];
    for (const [id, label] of labels) {
      const btn = info(id);
      expect(btn).not.toBeNull();
      expect((btn as HTMLButtonElement).tagName).toBe("BUTTON");
      // A real name, and it names its own field: five controls all called
      // "More info" is a tab order that says nothing.
      expect(btn?.getAttribute("aria-label")).toBe(`What ${label} means`);
      expect(btn?.getAttribute("tabindex")).toBeNull();
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    }

    const btn = info("box:size") as HTMLButtonElement;
    act(() => {
      btn.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    const open = tip();
    expect(open?.textContent).toContain(SIZE_COPY);
    // It is a tooltip, it is announced with the control that opened it, and Tab
    // moves past it rather than into it.
    expect(open?.getAttribute("role")).toBe("tooltip");
    expect(open?.getAttribute("tabindex")).toBeNull();
    expect(btn.getAttribute("aria-describedby")).toBe("ticket-box:size");
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      btn.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(tip()).toBeNull();
  });

  test("a touch pins the note, and a second touch puts it away", () => {
    // A touch fires `pointerover` and then `pointerout` on release, so hovering
    // it would flash. There is no `onClick` on these for the same reason: the
    // compatibility click that follows a tap would re-toggle what the pointer
    // path just opened, inside one gesture.
    drawEthBox();
    const btn = info("box:wing") as HTMLButtonElement;
    act(() => {
      hover(btn, "touch");
    });
    expect(tip()?.textContent).toContain(WING_COPY);
    act(() => {
      unhover(btn, "touch");
    });
    expect(tip()).not.toBeNull();
    act(() => {
      hover(btn, "touch");
    });
    expect(tip()).toBeNull();
  });

  test("the ⓘ is not shrunk to fit a dense row", () => {
    // The pull in a column of ten-pixel labels is to make the control ten
    // pixels too. A hit target is not typography.
    drawEthBox();
    const btn = info("box:maxLoss") as HTMLButtonElement;
    expect(btn.style.width).toBe(`${FIELD_INFO_HIT}px`);
    expect(btn.style.height).toBe(`${FIELD_INFO_HIT}px`);
    expect(FIELD_INFO_HIT).toBeGreaterThanOrEqual(24);
  });

  test("a note carries no figure, so it carries no provenance either", () => {
    // The trade ticket tags every number with who said it. A definition is
    // nobody's quote, so a note has no rows, no source tags and no footer — and
    // if one ever grew a figure, this is the test that would say so.
    drawEthBox();
    act(() => {
      hover(info("box:maxPayout") as HTMLButtonElement, "touch");
    });
    const p = tip() as HTMLElement;
    expect(p.getAttribute("data-ticket-state")).toBe("note");
    expect(p.querySelectorAll("[data-ticket-row]").length).toBe(0);
    expect(p.querySelectorAll("[data-ticket-source]").length).toBe(0);
    expect(p.querySelectorAll("[data-ticket-footer]").length).toBe(0);
    for (const line of FIELD_NOTES.maxPayout) expect(p.textContent).toContain(line);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The x-axis: time on the left of NOW, listed dates on the right
// ─────────────────────────────────────────────────────────────────────────────

describe("boardAxis", () => {
  /** Sep 5, 6, 11 and 18 at 08:00 UTC — daily, then weeklies, which is the real
   *  shape the single linear axis could not draw. */
  const DATES = [1_788_595_200, 1_788_681_600, 1_789_113_600, 1_789_718_400];
  const NOW_MS = 1_788_500_000_000;
  const T1 = (DATES[3] as number) * 1000 + 60_000;

  const withPast = () =>
    boardAxis({ t0: NOW_MS - 10 * 3_600_000, now: NOW_MS, drawn: DATES, t1: T1 });

  test("every listed date gets an equal column, whatever the gap between them", () => {
    // The whole point. Sep 5→6 is one day and Sep 11→18 is seven, and on the
    // old axis that meant tomorrow got 3% of the board and next week got half.
    // A column is a date, not a duration.
    const a = withPast();
    const widths = a.stops.map((s, i) => s.pct - (i === 0 ? a.nowPct : (a.stops[i - 1] as { pct: number }).pct));
    for (const w of widths) expect(w).toBeCloseTo(widths[0] as number, 8);
    expect(widths[0]).toBeGreaterThan(0);
  });

  test("the seam is NOW, and the past keeps its own linear scale", () => {
    // The one thing that may not be re-spaced. Two prints an hour apart have to
    // stay an hour apart relative to each other, or the chart is claiming the
    // oracle published on a schedule it did not.
    const t0 = NOW_MS - 10 * 3_600_000;
    const a = boardAxis({ t0, now: NOW_MS, drawn: DATES, t1: T1 });
    expect(a.x(t0)).toBe(0);
    expect(a.x(NOW_MS)).toBeCloseTo(a.nowPct, 8);
    // Half the history is half the history's width — a uniform scale, which is
    // not the same thing as a re-spacing.
    expect(a.x(t0 + 5 * 3_600_000)).toBeCloseTo(a.nowPct / 2, 8);
    // Quarter, three quarters: the ratios survive.
    expect(a.x(t0 + 2.5 * 3_600_000)).toBeCloseTo(a.nowPct / 4, 8);
  });

  test("with no history the past is a sliver rather than half an empty board", () => {
    const a = boardAxis({ t0: NOW_MS, now: NOW_MS, drawn: DATES, t1: T1 });
    expect(a.nowPct).toBe(NO_HISTORY_PCT);
    expect(a.nowPct).toBeLessThan(HISTORY_PCT);
    // And the seam does not move when a different date is chosen, which is the
    // bug the fixed share fixes: it used to be however much history happened to
    // have arrived, measured against however far out the expiry was.
    const near = boardAxis({ t0: NOW_MS - 3_600_000, now: NOW_MS, drawn: [DATES[0] as number], t1: T1 });
    const far = boardAxis({ t0: NOW_MS - 3_600_000, now: NOW_MS, drawn: DATES, t1: T1 });
    expect(near.nowPct).toBe(far.nowPct);
  });

  test("an expiry lands on its own column edge, and the map is monotone", () => {
    const a = withPast();
    for (const [i, e] of DATES.entries()) {
      expect(a.x(e * 1000)).toBeCloseTo((a.stops[i] as { pct: number }).pct, 8);
    }
    let last = -1;
    for (let t = NOW_MS - 10 * 3_600_000; t <= T1; t += 3_600_000) {
      const x = a.x(t);
      expect(x).toBeGreaterThanOrEqual(last);
      expect(x).toBeLessThanOrEqual(100);
      last = x;
    }
  });

  test("the tail past the last column is real room, not an off-board edge", () => {
    // The box's right edge has to read as an edge rather than as the plot
    // running out of width.
    const a = withPast();
    expect(100 - (a.stops[3] as { pct: number }).pct).toBeCloseTo(TAIL_PCT, 8);
    expect(a.x(T1)).toBeCloseTo(100, 6);
  });

  test("a pointer is in a column, never at an instant between two dates", () => {
    // The inverse is ordinal now. It used to map x back to a timestamp and hunt
    // for the nearest expiry, which was fine on a uniform axis and hopeless on
    // the real one: Sep 5 and Sep 6 were four pixels apart.
    const a = withPast();
    const mid = (i: number) => {
      const left = i === 0 ? a.nowPct : (a.stops[i - 1] as { pct: number }).pct;
      return (left + (a.stops[i] as { pct: number }).pct) / 200;
    };
    for (let i = 0; i < DATES.length; i += 1) expect(a.columnAt(mid(i))).toBe(i);
    // Left of the divider is still the first column: a drag that started in the
    // history cannot land on a date that is not offered.
    expect(a.columnAt(0)).toBe(0);
    // And the tail reports past-the-end, which is what lets a drag reach for
    // the next date the book quotes rather than inventing one.
    expect(a.columnAt(1)).toBe(DATES.length);
  });

  test("no columns is not a crash", () => {
    const a = boardAxis({ t0: NOW_MS - 3_600_000, now: NOW_MS, drawn: [], t1: T1 });
    expect(a.stops.length).toBe(0);
    expect(a.x(NOW_MS)).toBeCloseTo(a.nowPct, 8);
    expect(a.x(T1)).toBeCloseTo(100, 6);
    expect(a.columnAt(0.5)).toBe(0);
  });
});

describe("axisScaleCopy", () => {
  const DATES = [1_788_595_200, 1_788_681_600, 1_789_113_600, 1_789_718_400];

  test("names the real gap, so equal columns cannot read as an even cadence", () => {
    // The disclosure the equal columns cost. Sep 5 to Sep 18 is thirteen days
    // across three column boundaries, and the sentence says both numbers.
    const said = axisScaleCopy({ pastMs: 3_600_000, drawn: DATES }) ?? "";
    expect(said).toContain("Column width is not time");
    expect(said).toContain("Sep 5 to Sep 18");
    expect(said).toContain("not 3 equal steps");
    expect(said).toContain("of history, linear in time");
  });

  test("claims no history when none arrived", () => {
    const said = axisScaleCopy({ pastMs: 0, drawn: DATES }) ?? "";
    expect(said).not.toContain("history");
    expect(said).toContain("gets an equal column");
  });

  test("one column has no spread to state, and states none", () => {
    const said = axisScaleCopy({ pastMs: 0, drawn: [DATES[0] as number] }) ?? "";
    expect(said).toContain("1 date the book lists");
    expect(said).not.toContain("equal steps");
  });

  test("no columns, no sentence", () => {
    expect(axisScaleCopy({ pastMs: 3_600_000, drawn: [] })).toBeNull();
  });
});

describe("labelledRungPrices", () => {
  /** A window 340px tall over $2,000–$2,400. */
  const band = { lo: 2000, hi: 2400 } as const;

  test("keeps every price when the ladder is sparse enough to fit", () => {
    const prices = [2000, 2100, 2200, 2300, 2400];
    expect(labelledRungPrices(prices, band).sort((a, b) => a - b)).toEqual(prices);
  });

  test("guarantees a gap rather than dropping every other one", () => {
    // The old rule was a count — "past twenty in the window, label every other
    // one" — and it is the wrong measure on an irregular ladder. Here the
    // bottom half is $5 apart and the top half is $100 apart: a count thins
    // both, a gap thins only the half that needed it.
    const dense = Array.from({ length: 41 }, (_, i) => 2000 + i * 5);
    const sparse = [2300, 2400];
    const kept = labelledRungPrices([...dense, ...sparse], band);
    // Nothing kept is closer than the gap to its neighbour, measured the way
    // the axis measures it.
    const ys = kept.map((p) => ((1 - (p - band.lo) / (band.hi - band.lo)) * 340));
    for (let i = 1; i < ys.length; i += 1) {
      expect((ys[i] as number) - (ys[i - 1] as number)).toBeGreaterThanOrEqual(15 - 1e-9);
    }
    // The sparse end survives intact — it never collided with anything.
    for (const p of sparse) expect(kept).toContain(p);
    // And the dense end is thinned rather than emptied.
    expect(kept.length).toBeGreaterThan(sparse.length);
    expect(kept.length).toBeLessThan(dense.length);
  });

  test("a rung outside the window is not labelled here at all", () => {
    // Off-window rungs are parked on the axis edge in their own fixed stack,
    // which is this same gap by another route, so they are never this
    // function's business.
    expect(labelledRungPrices([1000, 2200, 9999], band)).toEqual([2200]);
  });
});
