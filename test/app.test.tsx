import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { mockMarketSource } from "../src/data/market.ts";

let container: HTMLDivElement;
let root: Root;

/** Mount at a path. The app reads its route once, on mount. */
function mount(path = "/") {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<App source={mockMarketSource} />);
  });
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // The app writes the run into the address bar; the next test starts clean.
  window.history.replaceState(null, "", "/");
});

const text = () => container.textContent ?? "";

function buttons(): HTMLButtonElement[] {
  return Array.from(container.querySelectorAll("button"));
}

/** Click the first button whose visible label is exactly `label`. */
function click(label: string) {
  const el = buttons().find((b) => (b.textContent ?? "").trim() === label);
  if (!el) throw new Error(`no button labelled "${label}" — have: ${buttons().map((b) => `"${(b.textContent ?? "").trim()}"`).join(", ")}`);
  act(() => el.click());
}

/** Click the first button whose label contains `fragment`. */
function clickContaining(fragment: string) {
  const el = buttons().find((b) => (b.textContent ?? "").includes(fragment));
  if (!el) throw new Error(`no button containing "${fragment}"`);
  act(() => el.click());
}

const dialog = () => container.querySelector<HTMLElement>('[role="dialog"]');
const claimButton = () => buttons().find((b) => (b.textContent ?? "").startsWith("Claim"));

/** Open the first case on the grid and jump the reel to its landing. */
function openAndSkip() {
  click("Open case · 0.41 Ξ");
  click("Skip ↦");
}

/** The tickers the builder shows, in row order. */
const builderLegs = () =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-leg]")).map((d) => d.dataset.leg);

/** The tickers sitting in the spin's slots. An unfilled slot reads "?". */
const slotSyms = () =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-slot]")).map(
    (d) => d.lastElementChild?.textContent ?? "",
  );

/** Battle-era vocabulary. None of it may reach the screen. */
const FORBIDDEN = /battle|draft|\bban\b|opponent/i;

describe("landing", () => {
  test("opens on the case library — there is no lobby table to reach", () => {
    mount();
    expect(text()).toContain("Case library");
    expect(text()).toContain("7 / 8 unlocked · 8 shown");
    expect(text()).not.toContain("Open battles");
    expect(buttons().map((b) => b.textContent)).not.toContain("Battles");
    expect(window.location.pathname).toBe("/");
  });

  test("every top-level tab renders", () => {
    mount();
    click("Home");
    expect(text()).toContain("Open the case. Hold the legs. Take the payoff.");
    expect(text()).toContain("BIGGEST PAYOFFS 24H");
    expect(text()).toContain("Featured cases");

    click("Options desk");
    expect(text()).toContain("Combined payoff at expiry");
    expect(text()).toContain("MM pricing");

    click("Cases");
    expect(text()).toContain("Case library");
  });

  test("the wallet button toggles between connect and address", () => {
    mount();
    expect(text()).toContain("Connect wallet");
    click("Connect wallet");
    expect(text()).toContain("0x71c…4Af2");
    expect(text()).not.toContain("Connect wallet");
  });

  test("tag filters narrow the library", () => {
    mount();
    click("WHALE");
    expect(text()).toContain("1 shown");
    expect(text()).toContain("Whale Box");
    expect(text()).not.toContain("Weekly Grind");
    click("ALL");
    expect(text()).toContain("8 shown");
  });

  test("every case shows its picture and its leg count", () => {
    mount();
    const art = Array.from(container.querySelectorAll("pre")).filter((p) => (p.textContent ?? "").length > 40);
    expect(art.length).toBe(8);
    expect(text()).toContain("4 LEGS");
    expect(text()).toContain("8 LEGS");
  });
});

describe("opening a case", () => {
  test("a card spins once per leg and fills exactly that many slots, no duplicates", () => {
    mount();
    click("Open case · 0.41 Ξ"); // ETH Vol Box, 4 legs
    expect(dialog()?.getAttribute("aria-label")).toBe("ETH Vol Box spin");
    expect(window.location.pathname).toBe("/case/eth-vol-box");
    expect(window.location.search).toMatch(/^\?seed=\d{6}$/);

    expect(slotSyms()).toHaveLength(4);
    expect(text()).toContain("spinning the book…");
    expect(claimButton()?.disabled).toBe(true);

    click("Skip ↦");
    expect(text()).toContain("locked");
    expect(claimButton()?.disabled).toBe(false);

    const syms = slotSyms();
    expect(syms).toHaveLength(4);
    expect(syms.every((s) => s !== "?")).toBe(true);
    expect(new Set(syms).size).toBe(4);
  });

  test("the reel only deals from the case's own book", () => {
    mount();
    clickContaining("Open case · 0.12 Ξ"); // Weekly Grind: the quiet end, no memes
    click("Skip ↦");
    const syms = slotSyms();
    expect(syms).toHaveLength(3);
    for (const s of syms) expect(["AAPL", "XOM", "JPM", "GLD", "META", "BTC"]).toContain(s);
    expect(syms).not.toContain("PEPE");
  });

  test("locked cases are not openable — from the card or from a link", () => {
    mount();
    const whale = container.querySelector<HTMLElement>('[data-case="whale-box"]');
    expect(whale?.textContent).toContain("LOCKED · reach ORCA to open");
    expect(whale?.querySelector("button")).toBeNull();
    act(() => whale!.click());
    expect(dialog()).toBeNull();
    expect(text()).toContain("Case library");

    act(() => root.unmount());
    container.remove();
    mount("/case/whale-box?seed=123456");
    expect(dialog()).toBeNull();
    expect(text()).toContain("Case library");
    expect(window.location.pathname).toBe("/");
  });

  test("the same seed replays the same spin", () => {
    mount("/case/eth-vol-box/parlay?seed=424242");
    const first = builderLegs();
    expect(first).toHaveLength(4);

    act(() => root.unmount());
    container.remove();
    mount("/case/eth-vol-box/parlay?seed=424242");
    expect(builderLegs()).toEqual(first);
  });

  test("one free re-roll per open, then it is spent", () => {
    mount();
    openAndSkip();
    const seedBefore = window.location.search;

    click("Spin again");
    expect(dialog()).not.toBeNull();
    expect(window.location.search).not.toBe(seedBefore);
    expect(claimButton()?.disabled).toBe(true); // a fresh reel

    click("Skip ↦");
    const spent = buttons().find((b) => (b.textContent ?? "").startsWith("Spin again"));
    expect(spent?.textContent).toContain("used");
    expect(spent?.disabled).toBe(true);
    expect(spent?.title).toContain("One free re-roll");
  });

  test("closing the spin lands back on the library", () => {
    mount();
    click("Open case · 0.41 Ξ");
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    act(() => close!.click());
    expect(dialog()).toBeNull();
    expect(text()).toContain("Case library");
    expect(window.location.pathname).toBe("/");
  });

  test("claiming the spin opens the parlay builder on those legs", () => {
    mount();
    openAndSkip();
    const dealt = slotSyms();
    click("Claim → parlay");
    expect(text()).toContain("Build the parlay · ETH Vol Box");
    expect(builderLegs()).toEqual(dealt);
    expect(window.location.pathname).toBe("/case/eth-vol-box/parlay");
  });
});

describe("parlay builder", () => {
  const mult = () => container.querySelector('[data-testid="combined-mult"]')?.textContent;
  const prob = () => container.querySelector('[data-testid="implied-prob"]')?.textContent;
  const rows = () => Array.from(container.querySelectorAll<HTMLElement>("[data-leg]"));
  const tierIn = (row: HTMLElement, tier: string) => {
    const b = Array.from(row.querySelectorAll("button")).find((x) => x.textContent === tier);
    act(() => b!.click());
  };

  test("one row per leg, and the rule stated plainly", () => {
    mount("/case/eth-vol-box/parlay?seed=424242");
    expect(rows()).toHaveLength(4);
    expect(text()).toContain("4 LEGS · ALL MUST HIT");
    expect(text()).toContain("All 4 legs must hit for the case to pay. One miss pays zero.");
    expect(text()).toContain("by Fri expiry");
  });

  test("the multiplier is the product of the leg multipliers and updates on every change", () => {
    mount("/case/eth-vol-box/parlay?seed=424242");
    // Four legs default to EVEN: 1.9^4.
    expect(mult()).toBe("×13.03");

    tierIn(rows()[0]!, "DEGEN"); // 11 × 1.9^3
    expect(mult()).toBe("×75.45");
    expect(prob()).toBe("1.0%"); // 0.08 × 0.5^3, well under the loud line
    expect(text()).toContain("Under a 10% line");

    tierIn(rows()[0]!, "SHARP"); // 3.6 × 1.9^3
    expect(mult()).toBe("×24.69");
  });

  test("the case's own odds are the floor", () => {
    mount("/case/eth-vol-box/parlay?seed=424242");
    for (const r of rows()) tierIn(r, "SAFE"); // 1.2^4 = 2.07, under the 4.54 floor
    expect(mult()).toBe("×4.54"); // 1.86 / 0.41
    expect(text()).toContain("on the case floor");
    // Probability can only come down from the case, never up.
    expect(prob()).toBe("22%");
  });

  test("direction flips the condition", () => {
    mount("/case/eth-vol-box/parlay?seed=424242");
    const first = rows()[0]!;
    expect(first.textContent).toContain("closes above");
    const under = Array.from(first.querySelectorAll("button")).find((b) => b.textContent?.includes("under"));
    act(() => under!.click());
    expect(rows()[0]!.textContent).toContain("closes below");
  });

  test("locking leads to the case study on the spun legs, then the tape", () => {
    mount("/case/eth-vol-box/parlay?seed=424242");
    const legs = builderLegs();
    click("Lock parlay → case study");
    expect(text()).toContain("Case study");
    expect(text()).toContain("STUDY PHASE · TAPE NOT STARTED");
    for (const sym of legs) expect(text()).toContain(sym!);
    expect(window.location.pathname).toBe("/case/eth-vol-box/study");

    click("Done studying → run the tape");
    expect(text()).toContain("Running the tape · ETH Vol Box");
    expect(text()).toContain("Your position");
    expect(text()).not.toContain("Settle → result"); // the tape has not played yet
  });
});

describe("settlement", () => {
  test("a settled case reports points, every leg, and a coach read", () => {
    mount("/case/eth-vol-box/settled?seed=424242");
    expect(text()).toMatch(/PTS/);
    expect(text()).toMatch(/The case paid in full|The case expired short/);
    expect(text()).toContain("HOW IT SETTLED");
    expect(text()).toContain("LESSON FOR NEXT CASE");
    expect(text()).toContain("Your legs");
    expect(text()).toContain("of 4 legs");

    click("Back to cases");
    expect(text()).toContain("Case library");
  });

  test("the balance moves when a case opens", () => {
    mount();
    expect(text()).toContain("5,000 PTS");
    click("Open case · 0.41 Ξ"); // 410 pts leave the balance
    expect(text()).toContain("4,590 PTS");
  });
});

describe("copy", () => {
  test("no battle-era vocabulary reaches any screen", () => {
    mount();
    expect(text()).not.toMatch(FORBIDDEN);
    click("Home");
    expect(text()).not.toMatch(FORBIDDEN);
    click("Options desk");
    expect(text()).not.toMatch(FORBIDDEN);
    click("Cases");
    openAndSkip();
    expect(text()).not.toMatch(FORBIDDEN);
    click("Claim → parlay");
    expect(text()).not.toMatch(FORBIDDEN);
    click("Lock parlay → case study");
    expect(text()).not.toMatch(FORBIDDEN);
    click("Done studying → run the tape");
    expect(text()).not.toMatch(FORBIDDEN);

    act(() => root.unmount());
    container.remove();
    mount("/case/eth-vol-box/settled?seed=424242");
    expect(text()).not.toMatch(FORBIDDEN);
  });
});
