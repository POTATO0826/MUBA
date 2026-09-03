import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { mockMarketSource } from "../src/data/market.ts";

let container: HTMLDivElement;
let root: Root;

function mount() {
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

/** Click a contract-pool card by its ticker. */
function pickTicker(sym: string) {
  const card = Array.from(container.querySelectorAll<HTMLElement>("div")).find((d) =>
    (d.textContent ?? "").startsWith(`${sym} · `),
  );
  if (!card) throw new Error(`no pool card for ${sym}`);
  act(() => card.click());
}

describe("navigation", () => {
  beforeEach(mount);

  test("opens on the lobby", () => {
    expect(text()).toContain("Battle the book, not the market.");
    expect(text()).toContain("BIGGEST WINS 24H");
    expect(text()).toContain("Featured cases");
  });

  test("every top-level tab renders", () => {
    click("Battles");
    expect(text()).toContain("Open battles");
    expect(text()).toContain("▶ Random demo");

    click("Duel attack");
    expect(text()).toContain("Combined payoff at expiry");
    expect(text()).toContain("MM pricing");

    click("Rewards");
    expect(text()).toContain("Case library");
    expect(text()).toContain("FREE CRYPTO BATTLES");

    click("Home");
    expect(text()).toContain("Battle the book, not the market.");
  });

  test("the wallet button toggles between connect and address", () => {
    expect(text()).toContain("Connect wallet");
    click("Connect wallet");
    expect(text()).toContain("0x71c…4Af2");
    expect(text()).not.toContain("Connect wallet");
  });
});

describe("lobby builder", () => {
  beforeEach(mount);

  test("the prize steppers move the pool and the entry with it", () => {
    click("Battles");
    click("Create battle");
    expect(text()).toContain("ENTRY PER PLAYER");
    expect(text()).toContain("2.50 ETH"); // half of the default 5.00 pool

    click("+");
    expect(text()).toContain("2.75 ETH");
    expect(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe("5.50");

    click("−");
    expect(text()).toContain("2.50 ETH");
  });

  test("switching market swaps the draftable universe", () => {
    click("Battles");
    click("Create battle");
    expect(text()).toContain("MIXED UNIVERSE · 18 ACTIVE");

    clickContaining("Web3 crypto");
    expect(text()).toContain("CRYPTO UNIVERSE · 9 ACTIVE");
    expect(text()).not.toContain("NVDA");

    clickContaining("Stocks");
    expect(text()).toContain("STOCK UNIVERSE · 9 ACTIVE");
    expect(text()).toContain("NVDA");
  });

  test("dropping an asset shrinks the active count", () => {
    click("Battles");
    click("Create battle");
    clickContaining("Stocks");
    expect(text()).toContain("STOCK UNIVERSE · 9 ACTIVE");

    clickContaining("NVDASEMIS");
    expect(text()).toContain("STOCK UNIVERSE · 8 ACTIVE");
  });

  test("the picks stepper is clamped to 2–4", () => {
    click("Battles");
    click("Create battle");
    const picksNote = () => text().includes("draft turns");
    expect(picksNote()).toBe(true);
    expect(text()).toContain("10 draft turns"); // 3 picks → 3*2+4

    // Two "+" buttons on the row of steppers; the first is PICKS EACH.
    const plus = buttons().filter((b) => (b.textContent ?? "").trim() === "+");
    act(() => plus[1]!.click());
    expect(text()).toContain("12 draft turns"); // 4 picks
    act(() => plus[1]!.click());
    expect(text()).toContain("12 draft turns"); // clamped at 4
  });
});

describe("match flow", () => {
  beforeEach(mount);

  test("publish → draft → study → parlay → live", () => {
    click("Battles");
    click("Create battle");
    clickContaining("Publish lobby");

    // Draft
    expect(text()).toContain("Draft · Room #4471");
    expect(text()).toContain("PICK & BAN · 0 OF 3");
    expect(text()).toContain("Contract pool");

    pickTicker("NVDA");
    expect(text()).toContain("PICK & BAN · 1 OF 3");
    pickTicker("AAPL");
    pickTicker("TSLA");
    expect(text()).toContain("PICKS COMPLETE");
    expect(text()).toContain("3 picks · 0 bans");

    click("Confirm picks → case study");
    expect(text()).toContain("Case study");
    expect(text()).toContain("STUDY PHASE · NO BETS YET");

    click("Done studying → parlay");
    expect(text()).toContain("Parlay selection");
    expect(text()).toContain("BLIND · OPPONENT SLIP HIDDEN");

    click("Lock parlay → fight");
    expect(text()).toContain("Live fight · Room #4471");
    expect(text()).toContain("TAPE ×64");
  });

  test("a picked ticker can be un-picked, and banning releases it", () => {
    click("Battles");
    click("Create battle");
    clickContaining("Publish lobby");

    pickTicker("NVDA");
    expect(text()).toContain("1 picks · 0 bans");
    pickTicker("NVDA");
    expect(text()).toContain("0 picks · 0 bans");

    pickTicker("AAPL");
    expect(text()).toContain("1 picks · 0 bans");
    click("BAN"); // first card on the board is NVDA
    expect(text()).toContain("1 picks · 1 bans");
  });

  test("direction buttons flip the target sign on a leg", () => {
    click("Battles");
    click("Create battle");
    clickContaining("Publish lobby");
    pickTicker("NVDA");
    pickTicker("AAPL");
    pickTicker("TSLA");
    click("Confirm picks → case study");
    click("Done studying → parlay");

    expect(text()).toContain("+4.0%"); // NVDA defaults to over
    click("UNDER");
    expect(text()).toContain("−4.0%");
    expect(text()).toContain("wins if it closes below target");
  });
});

describe("rewards", () => {
  beforeEach(mount);

  test("shows the season track, missions and every case with its picture", () => {
    click("Rewards");
    expect(text()).toContain("RANK 07");
    expect(text()).toContain("SHARK");
    expect(text()).toContain("DAILY MISSIONS");
    expect(text()).toContain("2 / 4");
    // Skew Hunter needs SHARK (held); only Whale Box (ORCA) is out of reach.
    expect(text()).toContain("7 / 8 unlocked");
    // One <pre> per case card carries its ASCII art.
    const art = Array.from(container.querySelectorAll("pre")).filter((p) => (p.textContent ?? "").length > 40);
    expect(art.length).toBe(8);
  });

  test("cases above the player's tier are locked", () => {
    click("Rewards");
    expect(text()).toContain("LOCKED · ORCA");
    expect(text()).toContain("Reach ORCA to open");
    // Skew Hunter needs SHARK, which the player has.
    expect(text()).not.toContain("LOCKED · SHARK");
  });

  test("tag filters narrow the library", () => {
    click("Rewards");
    click("WHALE");
    expect(text()).toContain("1 shown");
    expect(text()).toContain("Whale Box");
    expect(text()).not.toContain("Weekly Grind");
    click("ALL");
    expect(text()).toContain("8 shown");
  });

  test("the wheel opens as a dialog and closes again", () => {
    click("Rewards");
    click("Spin the wheel");
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("FREE CRYPTO BATTLE · SPIN");
    expect(dialog?.textContent).toContain("UNDER THE POINTER");
    // Claim is disabled until the reel stops.
    const claim = buttons().find((b) => (b.textContent ?? "").includes("Claim"));
    expect(claim?.disabled).toBe(true);

    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    act(() => close!.click());
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe("duel attack", () => {
  beforeEach(mount);

  test("the pricing table follows the selected underlying", () => {
    click("Duel attack");
    expect(text()).toContain("4,000");
    expect(text()).not.toContain("96,000");

    click("BTC");
    expect(text()).toContain("96,000");
    expect(text()).toContain("90–104k");
  });

  test("payoff stats are computed, not hard-coded", () => {
    click("Duel attack");
    expect(text()).toContain("MAX PROFIT");
    expect(text()).toContain("MAX LOSS");
    expect(text()).toContain("-0.41 Ξ"); // the debit, when both spreads expire worthless
    expect(text()).toContain("BREAKEVEN");
    expect(text()).toContain("WIN ZONE");
  });
});
