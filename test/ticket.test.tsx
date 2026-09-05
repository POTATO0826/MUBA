/**
 * The trade ticket — what a card says it is when you look at it properly.
 *
 * Two things are under test and they are different kinds of thing:
 *
 *  1. **The content** (`src/desk/ticket.ts`, pure). What may be said about a
 *     contract the venue listed, what may be said about a card the game wrote,
 *     and — the part that matters most — that the second is never dressed as
 *     the first. Provenance is asserted per row, not per panel: a computed
 *     gamma beside a published delta is only honest while the reader can tell
 *     which is which.
 *  2. **The interaction** (`src/ui/TradeTicket.tsx`, rendered). Hover, keyboard
 *     focus and tap all reach the same panel; nothing is trapped; the panel is
 *     placed beside its trigger rather than over it.
 *
 * The greeks come off `PricingRow.greeks`, which is `src/data/greeks.ts`'s
 * output — this suite is that engine's first rendered consumer, so the two
 * rules `docs/greeks.md` §7 states about a renderer are asserted here rather
 * than assumed: a computed set is never labelled the venue's, and a theta never
 * appears without the window it is quoted against.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  DASH,
  bandLabel,
  cardTicket,
  expiryStamp,
  fieldNote,
  fine,
  instrumentName,
  liveTicket,
  seededTicket,
  ticketGreeks,
  timeLeft,
  type CardTicketInput,
} from "../src/desk/ticket.ts";
import { DUEL_WINDOW } from "../src/desk/optionize.ts";
import { decayOver } from "../src/data/greeks.ts";
import { TICKET_ACCENT, TICKET_DELAY_MS, useTradeTicket } from "../src/ui/TradeTicket.tsx";
import {
  buildLeg,
  tierProb,
  TIER_BANDS,
  TIER_ORDER,
  type LiveCard,
  type Tier,
} from "../src/engine/parlay.ts";
import type { PricingRow, RowGreeks } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — one dealt ETH call, with the greek set the engine produces
// ─────────────────────────────────────────────────────────────────────────────

/** 5 Sep 2026, 00:00 UTC. */
const NOW = Date.UTC(2026, 8, 5, 0, 0, 0);
/** 12 Sep 2026, 08:00 UTC — the venue lists expiries at 08:00 UTC. */
const EXPIRY = Math.floor(Date.UTC(2026, 8, 12, 8, 0, 0) / 1000);

const GREEKS: RowGreeks = {
  source: "model",
  // Inside SHARP's `[0.10, 0.20)` band. It was 0.3612 while the ladder ran
  // SAFE `[0.65, 0.85)`; 0.36 buckets into SAFE now, and a fixture whose delta
  // contradicts its own tier is the exact mismatch this suite exists to catch.
  delta: 0.1612,
  gamma: 0.001184,
  thetaPerDay: -0.4213,
  thetaPerYear: -0.4213 * 365,
  vegaPerPoint: 0.9412,
  rhoPerPoint: 0,
  modelPrice: 6.71,
  vol: 0.582,
  volSource: "own",
  years: 7 / 365,
};

const ROW: PricingRow = {
  type: "CALL",
  strike: "2,460",
  expiry: "12 SEP",
  bid: "6.10",
  ask: "6.70",
  iv: "58.2%",
  delta: "0.16",
  depth: 40,
  size: "10.0k",
  greeks: GREEKS,
} as unknown as PricingRow;

const CARD: LiveCard = {
  id: "sharp-bull",
  tier: "SHARP",
  stance: "bull",
  label: "SHARP · BULLISH",
  underlying: "ETH",
  strike: "2,460",
  strikeAt: 2460,
  expiry: "12 SEP",
  expiryAt: EXPIRY,
  prob: 0.1612,
  premium: 6.7,
  odds: 1 / 0.1612,
  payoutMult: 90.54,
  mark: null,
  row: ROW,
} as unknown as LiveCard;

const LEG = buildLeg("ETH", "over", "SHARP");

const BASE: CardTicketInput = {
  sym: "ETH",
  tier: "SHARP",
  stance: "bull",
  id: "ETH:sharp-bull",
  card: CARD,
  leg: LEG,
  spot: 2453,
  now: NOW,
  reason: "no-book",
};

const rowOf = (t: { rows: readonly { key: string; value: string; note: string; source: unknown }[] }, key: string) =>
  t.rows.find((r) => r.key === key);

// ─────────────────────────────────────────────────────────────────────────────
// Formatting — the two places a scale has ever gone wrong here
// ─────────────────────────────────────────────────────────────────────────────

describe("the ticket's own number formatting", () => {
  test("goes all the way down rather than dropping to exponential", () => {
    // `fmtPx` is the tape's formatter and gives up below 0.001, which is where
    // both the duel-window theta and BTC's gamma live. `3.9e-5 dollars` is not
    // a figure anyone reads off a ticket.
    expect(fine(2460)).toBe("2,460");
    expect(fine(6.7)).toBe("6.70");
    expect(fine(0.0012)).toBe("0.0012");
    expect(fine(0.0000390)).toBe("0.000039");
    expect(fine(0)).toBe("0.00");
  });

  test("time left is two units and never three", () => {
    expect(timeLeft(0)).toBe("expired");
    expect(timeLeft(-1)).toBe("expired");
    expect(timeLeft(42 * 60_000)).toBe("42m");
    expect(timeLeft((18 * 60 + 40) * 60_000)).toBe("18h 40m");
    expect(timeLeft((6 * 24 * 60 + 21 * 60) * 60_000)).toBe("6d 21h");
  });

  test("the expiry stamp is UTC and says so", () => {
    // The venue lists at 08:00 UTC; a local render would move the date for half
    // the world and the ticket would disagree with the book.
    expect(expiryStamp(EXPIRY)).toBe("Sat 12 Sep 2026 · 08:00 UTC");
  });

  test("the instrument is named the way the venue names one", () => {
    // `MmQuote.ticker` on the live feed is literally `ETH-5SEP26-2380-C`.
    expect(instrumentName("ETH", EXPIRY, 2460, "C")).toBe("ETH-12SEP26-2460-C");
    expect(instrumentName("BTC", EXPIRY, 79500, "P")).toBe("BTC-12SEP26-79500-P");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The live ticket
// ─────────────────────────────────────────────────────────────────────────────

describe("a card the book dealt reads as the contract it is", () => {
  const t = liveTicket({ ...BASE, card: CARD });

  test("the head is the contract, not the tier", () => {
    expect(t.state).toBe("live");
    expect(t.title).toBe("ETH-12SEP26-2460-C");
    // The tier is the game's word; the band under it is the real thing.
    expect(t.subtitle).toContain("SHARP");
    expect(t.subtitle).toContain(bandLabel("SHARP"));
    expect(bandLabel("SHARP")).toBe("|Δ| 0.10–0.20");
  });

  test("it carries everything a person needs to place the trade", () => {
    for (const key of [
      "contract",
      "expiry",
      "moneyness",
      "maxLoss",
      "breakeven",
      "maxPayout",
      "reference",
      "delta",
      "gamma",
      "theta",
      "vega",
      "iv",
    ]) {
      expect(rowOf(t, key)).toBeDefined();
    }
  });

  test("the premium is stated AS the max loss, and the breakeven is derived from it", () => {
    expect(rowOf(t, "maxLoss")?.value).toBe("$6.70 per contract");
    expect(rowOf(t, "maxLoss")?.note).toContain("the whole of what you can lose");
    // Strike plus premium, on the money.
    expect(rowOf(t, "breakeven")?.value).toBe("$2,466.70");
  });

  test("a long call's ceiling is uncapped and a long put's is its strike", () => {
    expect(rowOf(t, "maxPayout")?.value).toBe("uncapped");
    const put = liveTicket({
      ...BASE,
      stance: "bear",
      card: { ...CARD, stance: "bear" } as LiveCard,
    });
    expect(rowOf(put, "maxPayout")?.value).toBe("$2,453.30 per contract");
    expect(rowOf(put, "breakeven")?.value).toBe("$2,453.30");
  });

  test("delta is the venue's, and it is linked to the tier's band", () => {
    const d = rowOf(t, "delta");
    expect(d?.source).toBe("venue");
    expect(d?.note).toContain("16% odds");
    expect(d?.note).toContain(bandLabel("SHARP"));
    expect(d?.note).toContain("|Δ| 0.10–0.20");
  });

  test("moneyness names the distance the price has to travel", () => {
    // 2,453 against a 2,460 strike is inside the card face's own half-percent
    // ATM band, so the two surfaces agree about one strike.
    expect(rowOf(t, "moneyness")?.value).toBe("$2,453 · ATM · 0.29% to the strike");
    const far = liveTicket({ ...BASE, spot: 2100, card: CARD });
    expect(rowOf(far, "moneyness")?.value).toContain("OTM");
    expect(rowOf(far, "moneyness")?.note).toContain("below the strike");
  });

  test("the breakeven keeps its cents", () => {
    // Seventy cents on the one figure that is a decision boundary.
    expect(rowOf(t, "breakeven")?.value).toBe("$2,466.70");
  });

  test("implied vol keeps the digit the venue published", () => {
    expect(rowOf(t, "iv")?.value).toBe("58.2%");
    expect(rowOf(t, "iv")?.source).toBe("venue");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// docs/greeks.md §7 — the two rules a renderer must follow
// ─────────────────────────────────────────────────────────────────────────────

describe("provenance is per figure, never per panel", () => {
  const t = liveTicket({ ...BASE, card: CARD });

  test("what the venue said and what we computed carry different tags", () => {
    // The venue publishes a delta and an IV. It publishes no gamma, no theta
    // and no vega for anything a player sees; those three are ours.
    expect(rowOf(t, "delta")?.source).toBe("venue");
    expect(rowOf(t, "iv")?.source).toBe("venue");
    expect(rowOf(t, "gamma")?.source).toBe("model");
    expect(rowOf(t, "theta")?.source).toBe("model");
    expect(rowOf(t, "vega")?.source).toBe("model");
    // And no computed figure is ever labelled the venue's.
    for (const key of ["gamma", "theta", "vega"]) {
      expect(rowOf(t, key)?.source).not.toBe("venue");
    }
  });

  test("a composed set is refused outright rather than shown with a caveat", () => {
    // A spread's delta is a NET of two vanillas and this panel renders delta as
    // odds. §5 of the doc: the mistake that nearly shipped.
    expect(ticketGreeks({ ...GREEKS, source: "model-composed" })).toBeNull();
    // So is a vanilla priced off a neighbour's vol — one strike's published
    // delta beside another strike's borrowed vol is a muddle no tag fixes.
    expect(ticketGreeks({ ...GREEKS, volSource: "smile" })).toBeNull();
    expect(ticketGreeks(undefined)).toBeNull();
    expect(ticketGreeks(GREEKS)).toBe(GREEKS);
  });

  test("a strike with no usable greeks dashes with the reason, and invents nothing", () => {
    const bare = liveTicket({
      ...BASE,
      card: { ...CARD, row: { ...ROW, greeks: undefined, iv: "—" } } as LiveCard,
    });
    expect(rowOf(bare, "greeks")?.value).toBe(DASH);
    expect(rowOf(bare, "greeks")?.source).toBeNull();
    expect(rowOf(bare, "greeks")?.note).toContain("no implied volatility");
    expect(rowOf(bare, "iv")?.value).toBe(DASH);
    // And the three rows that would have been computed are simply not there.
    expect(rowOf(bare, "gamma")).toBeUndefined();
    expect(rowOf(bare, "theta")).toBeUndefined();
    expect(rowOf(bare, "vega")).toBeUndefined();
  });
});

describe("theta always names its window — both of them", () => {
  const t = liveTicket({ ...BASE, card: CARD });

  test("the figure is per calendar day and says so on the same line", () => {
    // There is no field called `theta`. `thetaPerDay` is the venue's own
    // convention and the only one safe to print unqualified — and it is
    // qualified anyway.
    const th = rowOf(t, "theta");
    expect(th?.value).toBe("−$0.4213 per calendar day");
    expect(th?.value).toContain("per calendar day");
  });

  test("the duel window is printed beside it, at its true 10,800× smaller scale", () => {
    const perTape = decayOver(
      {
        price: GREEKS.modelPrice,
        delta: GREEKS.delta,
        gamma: GREEKS.gamma,
        vegaPerPoint: GREEKS.vegaPerPoint,
        vegaPerUnitVol: GREEKS.vegaPerPoint * 100,
        thetaPerYear: GREEKS.thetaPerYear,
        thetaPerDay: GREEKS.thetaPerDay,
        rhoPerPoint: GREEKS.rhoPerPoint,
      },
      DUEL_WINDOW.tape,
    );
    // The bug this repo already fixed once: printing the per-day figure as the
    // duel's loss overstates it by exactly this ratio.
    expect(GREEKS.thetaPerDay / perTape).toBeCloseTo(DUEL_WINDOW.day / DUEL_WINDOW.tape, 6);
    expect(DUEL_WINDOW.day / DUEL_WINDOW.tape).toBeCloseTo(10800, 6);
    const note = rowOf(t, "theta")?.note ?? "";
    expect(note).toContain("8-second tape");
    expect(note).toContain(fine(Math.abs(perTape)));
  });

  test("vega names its scale too — per point, never per 1.00 of vol", () => {
    expect(rowOf(t, "vega")?.value).toBe("$0.9412 per IV point");
  });

  test("gamma names the move it is per", () => {
    // Six decimals rather than four: gamma is ~1e-3 on ETH and ~1e-4 on BTC,
    // and `0.0012` throws away the digit that tells them apart.
    expect(rowOf(t, "gamma")?.value).toBe("Γ 0.001184 per $1");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seeded ticket — the failure this whole shape invites
// ─────────────────────────────────────────────────────────────────────────────

describe("a card the game wrote is never dressed as a contract", () => {
  const t = seededTicket({ ...BASE, card: null, reason: "no-book" });

  test("it opens by saying there is nothing to buy", () => {
    expect(t.state).toBe("seeded");
    expect(t.banner).toContain("Not a quote");
    expect(t.banner).toContain("nothing here to buy");
  });

  test("every money figure is a dash with a reason, and none is invented", () => {
    for (const key of ["contract", "expiry", "maxLoss", "breakeven", "maxPayout", "greeks", "iv"]) {
      const r = rowOf(t, key);
      expect(r?.value).toBe(DASH);
      expect(r?.source).toBeNull();
      // A dash that explains nothing is a blank. Each says what the figure does
      // when it exists — the teaching, in one clause.
      expect((r?.note ?? "").length).toBeGreaterThan(20);
    }
  });

  test("the chance on the face is named as a band midpoint, not a delta", () => {
    // This is the substitution the owner's screenshot makes: the chance on a
    // SAFE card is `tierProb("SAFE")`, and no option's delta is behind it.
    // Derived from the constant rather than typed out, so a re-cut of the
    // ladder moves the assertion with the card instead of failing it — what
    // this test pins is the WORDING, `… · band midpoint`, which is the whole
    // disclosure.
    const safe = seededTicket({
      ...BASE,
      card: null,
      tier: "SAFE",
      leg: buildLeg("ETH", "over", "SAFE"),
      reason: "no-book",
    });
    const d = rowOf(safe, "delta");
    expect(d?.value).toBe(`${Math.round(tierProb("SAFE") * 100)}% · band midpoint`);
    expect(d?.value).toBe("40% · band midpoint");
    expect(d?.source).toBe("game");
    expect(d?.note).toContain("not any option's delta");
  });

  /**
   * This used to assert the opposite: that a seeded SAFE ticket carries an extra
   * footer sentence saying SAFE can never fill. It could not, then — the ladder
   * ran SAFE `[0.65, 0.85)` over a book whose largest listed |delta| is under
   * 0.50 — and `SAFE_UNFILLABLE` was that sentence.
   *
   * `TIER_BANDS` was re-cut onto the range the venue actually quotes, `SAFE` is
   * `[0.30, 0.50)` and fills off live orders, and the constant is retired. The
   * test is inverted rather than deleted, because "SAFE is special-cased in the
   * footer" is exactly the state that must not quietly come back: an empty SAFE
   * tier now means what an empty DEGEN tier means, and gets the same sentence.
   */
  test("no tier is special-cased in the footer — SAFE reads like the rest", () => {
    const seeded = (tier: Tier) =>
      seededTicket({
        ...BASE,
        card: null,
        tier,
        leg: buildLeg("ETH", "over", tier),
        reason: "no-book",
      });
    const safe = seeded("SAFE");
    for (const t2 of TIER_ORDER) {
      expect(seeded(t2).footer).toHaveLength(safe.footer.length);
      expect(seeded(t2).footer.join(" ")).not.toContain("can never fill");
    }
    // The band it names is its own, and it is one the book can reach.
    expect(safe.subtitle).toContain(bandLabel("SAFE"));
    expect(TIER_BANDS.SAFE[1]).toBeLessThanOrEqual(0.5);
  });

  test("the three reasons a slot is seeded are three different sentences", () => {
    const say = (reason: CardTicketInput["reason"]) =>
      seededTicket({ ...BASE, card: null, reason }).footer[0] ?? "";
    expect(say("no-book")).toContain("No live Thetanuts book reached this screen");
    expect(say("no-chain")).toContain("carries no option chain for ETH");
    expect(say("not-dealt")).toContain("no resting call falls in SHARP's band");
    // A screen that never got a book must not claim the book carried no chain.
    expect(say("no-book")).not.toContain("carries no option chain");
  });

  test("the seeded line is labelled as this build's own, against the live price", () => {
    const line = rowOf(t, "line");
    expect(line?.source).toBe("game");
    expect(line?.note).toContain("seeded");
    expect(line?.note).toContain("not off the live");
    expect(line?.value).toContain("above");
  });

  test("a dealt-but-empty slot is its own state, not the seeded one", () => {
    const dead = seededTicket({ ...BASE, card: null, reason: "not-dealt" });
    expect(dead.state).toBe("not-dealt");
    expect(dead.banner).toContain("Not dealt");
  });

  test("cardTicket picks the ticket off the card and nothing else", () => {
    expect(cardTicket(BASE).state).toBe("live");
    expect(cardTicket({ ...BASE, card: null }).state).toBe("seeded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The panel, and the three ways in
// ─────────────────────────────────────────────────────────────────────────────

let container: HTMLDivElement;
let root: Root;

function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(ui));
}

afterEach(() => {
  if (!root) return;
  act(() => root.unmount());
  container.remove();
  root = undefined as unknown as Root;
});

/** A trigger wired exactly as a parlay card is. */
function Harness({ card }: { card: LiveCard | null }) {
  const ticket = useTradeTicket();
  const tk = cardTicket({ ...BASE, card, reason: "no-book" });
  return (
    <div>
      <button data-trigger="" {...ticket.bind(tk)}>
        card
      </button>
      <button
        data-ticket-toggle={tk.id}
        onClick={(e) => ticket.pin(tk, e.currentTarget)}
        aria-expanded={ticket.openId === tk.id}
      >
        i
      </button>
      {ticket.panel}
    </div>
  );
}

/**
 * A pointer arriving on an element, the way the browser actually delivers it.
 *
 * React does not listen for `pointerenter`; it delegates `pointerover` at the
 * root and synthesises enter/leave from the pair of targets. Dispatching a bare
 * non-bubbling `pointerenter` therefore reaches nothing, and a test that did it
 * would pass on a handler that never fires in a browser.
 */
function hover(el: HTMLElement, pointerType: string) {
  el.dispatchEvent(
    Object.assign(new MouseEvent("pointerover", { bubbles: true, relatedTarget: null }), {
      pointerType,
    }),
  );
}

function unhover(el: HTMLElement) {
  el.dispatchEvent(
    Object.assign(new MouseEvent("pointerout", { bubbles: true, relatedTarget: null }), {
      pointerType: "mouse",
    }),
  );
}

const panel = () => container.querySelector("[data-trade-ticket]");
const trigger = () => container.querySelector("[data-trigger]") as HTMLElement;
const toggle = () => container.querySelector("[data-ticket-toggle]") as HTMLElement;

describe("the ticket opens by hover, by keyboard and by tap", () => {
  test("nothing is open until something asks", () => {
    mount(<Harness card={CARD} />);
    expect(panel()).toBeNull();
  });

  test("a mouse hover opens it after the settle delay, and a leave closes it", async () => {
    mount(<Harness card={CARD} />);
    act(() => {
      hover(trigger(), "mouse");
    });
    // Not immediately: a pointer crossing a row of cards must not strobe eight
    // panels on its way past.
    expect(panel()).toBeNull();
    await act(async () => {
      await new Promise((r) => setTimeout(r, TICKET_DELAY_MS + 40));
    });
    expect(panel()).not.toBeNull();
    act(() => {
      unhover(trigger());
    });
    expect(panel()).toBeNull();
  });

  test("keyboard focus opens it with no delay, and blur closes it", () => {
    // The whole keyboard path: Tab lands on the card, the ticket is there
    // immediately, Tab moves on and it goes. Nothing is captured and nothing is
    // prevented — the panel is not focusable and is not in the tab order, so a
    // Tab from the card reaches the next card rather than the panel.
    mount(<Harness card={CARD} />);
    act(() => {
      trigger().dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    const p = panel();
    expect(p).not.toBeNull();
    expect(p?.getAttribute("tabindex")).toBeNull();
    // And the trigger points at it, so a screen reader announces the ticket
    // with the card rather than leaving it orphaned.
    expect(trigger().getAttribute("aria-describedby")).toBe(`ticket-${BASE.id}`);
    act(() => {
      trigger().dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(panel()).toBeNull();
  });

  test("a tap pins it, and tapping the same control again closes it", () => {
    mount(<Harness card={CARD} />);
    act(() => {
      toggle().click();
    });
    expect(panel()).not.toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    act(() => {
      toggle().click();
    });
    expect(panel()).toBeNull();
  });

  test("a pinned panel survives a pointer leaving the trigger", () => {
    mount(<Harness card={CARD} />);
    act(() => {
      toggle().click();
    });
    act(() => {
      unhover(trigger());
    });
    expect(panel()).not.toBeNull();
  });

  test("Escape closes a pinned panel", () => {
    mount(<Harness card={CARD} />);
    act(() => {
      toggle().click();
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(panel()).toBeNull();
  });

  test("a non-mouse pointer pins rather than hovering", () => {
    // A touch fires pointerenter and then pointerleave on release; hovering it
    // would flash the panel and then take it away.
    mount(<Harness card={CARD} />);
    act(() => {
      hover(trigger(), "touch");
    });
    expect(panel()).not.toBeNull();
    act(() => {
      unhover(trigger());
    });
    expect(panel()).not.toBeNull();
  });
});

describe("what the rendered panel actually says", () => {
  const open = (card: LiveCard | null) => {
    mount(<Harness card={card} />);
    act(() => {
      toggle().click();
    });
    return panel() as HTMLElement;
  };

  test("a live card's panel carries the contract, the money and the greeks", () => {
    const p = open(CARD);
    expect(p.getAttribute("data-ticket-state")).toBe("live");
    const said = p.textContent ?? "";
    expect(said).toContain("ETH-12SEP26-2460-C");
    expect(said).toContain("$6.70 per contract");
    expect(said).toContain("$2,466.70");
    expect(said).toContain("58.2%");
    expect(said).toContain("per calendar day");
    expect(said).toContain("8-second tape");
    // Provenance is on screen, not merely in the data.
    expect(p.querySelectorAll('[data-ticket-source="venue"]').length).toBeGreaterThan(0);
    expect(p.querySelectorAll('[data-ticket-source="model"]').length).toBe(3);
  });

  test("a seeded card's panel says it is not a quote, before any figure", () => {
    const p = open(null);
    expect(p.getAttribute("data-ticket-state")).toBe("seeded");
    const banner = p.querySelector("[data-ticket-banner]")?.textContent ?? "";
    expect(banner).toContain("Not a quote");
    // No `model` tag anywhere: there is no contract to model.
    expect(p.querySelectorAll('[data-ticket-source="model"]').length).toBe(0);
    expect(p.querySelectorAll('[data-ticket-source="venue"]').length).toBe(0);
    // And no dollar premium anywhere on it.
    expect(p.querySelector('[data-ticket-value="maxLoss"]')?.textContent).toBe(DASH);
  });

  test("the panel is a tooltip, described by the trigger, and not in the tab order", () => {
    const p = open(CARD);
    expect(p.getAttribute("role")).toBe("tooltip");
    expect(p.getAttribute("tabindex")).toBeNull();
    expect(p.id).toBe(`ticket-${BASE.id}`);
  });

  test("reduced motion is honoured through the shared class rather than a new keyframe", () => {
    // `.vc-tip` animates opacity only and is switched off entirely under
    // `prefers-reduced-motion` in `styles.css`.
    expect(open(CARD).className).toContain("vc-tip");
  });
});

describe("a field note is a definition, and never a quote", () => {
  /**
   * The one thing that could go wrong here is a figure creeping onto a note.
   * The panel shape is the same one that carries a listed contract's premium
   * three rows away on the parlay screen, and a reader has learned to read it
   * as one — so a note that grew a `value` and a `source` tag would be an
   * invented number wearing the venue's clothes. It cannot, because it has no
   * rows at all, and this is the test that keeps it that way.
   */
  test("it is one paragraph and its continuations, with nothing else", () => {
    const n = fieldNote({ id: "box:maxLoss", label: "MAX LOSS", lines: ["first", "second"] });
    expect(n.state).toBe("note");
    expect(n.id).toBe("box:maxLoss");
    expect(n.title).toBe("MAX LOSS");
    expect(n.banner).toBe("first");
    expect(n.body).toEqual(["second"]);
    expect(n.rows.length).toBe(0);
    expect(n.footer.length).toBe(0);
    // Said out loud on the panel, because the same shape carries live quotes
    // elsewhere in this app.
    expect(n.subtitle).toBe("WHAT THIS FIGURE MEANS");
  });

  test("a single line leaves the body empty rather than repeating itself", () => {
    const n = fieldNote({ id: "box:size", label: "SIZE", lines: ["only"] });
    expect(n.banner).toBe("only");
    expect(n.body).toEqual([]);
  });

  test("it borrows none of the state vocabulary's colours", () => {
    // LIVE is green because a listed contract is live. A definition is not a
    // market state and must not read as one.
    expect(TICKET_ACCENT.note).not.toBe(TICKET_ACCENT.live);
    expect(TICKET_ACCENT.note).not.toBe(TICKET_ACCENT.seeded);
    expect(TICKET_ACCENT.note).not.toBe(TICKET_ACCENT["not-dealt"]);
  });
});
