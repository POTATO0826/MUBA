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

describe("arena hub", () => {
  beforeEach(mount);

  test("the hub is the landing screen and offers both modes", () => {
    expect(text()).toContain("PARLAY");
    expect(text()).toContain("FIND A DIFFERENCE");
    expect(text()).toContain("ACTIVE DUELS");
  });

  test("both modes are locked until a wallet connects", () => {
    // An address is the seat at the table. Without one there is nothing to
    // stake and nothing to name a player by.
    const modeButtons = buttons().filter((b) =>
      (b.textContent ?? "").includes("ENTER ARENA"),
    );
    expect(modeButtons).toHaveLength(2);
    expect(modeButtons.every((b) => b.disabled)).toBe(true);
    expect(text()).toContain("Connect a wallet to enter");
  });

  test("connecting unlocks the modes", () => {
    click("Connect");
    const modeButtons = buttons().filter((b) =>
      (b.textContent ?? "").includes("ENTER ARENA"),
    );
    expect(modeButtons.every((b) => b.disabled)).toBe(false);
    expect(text()).not.toContain("Connect a wallet to enter");
  });
});

describe("arena builder", () => {
  beforeEach(() => {
    mount();
    click("Connect");
    clickContaining("PARLAY");
  });

  test("entering a mode opens the builder for that mode", () => {
    expect(text()).toContain("Create duel");
    expect(text()).toContain("PARLAY · RFQ");
    expect(text()).toContain("STAKE PER PLAYER (USDC)");
  });

  test("the stake steppers move the stake and the pot with it", () => {
    // The host sets a stake, not a pot. The pot is both stakes, so it must
    // move at twice the rate.
    expect(text()).toContain("20.00 USDC");

    click("+");
    expect(text()).toContain("30.00 USDC");
    expect(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe(
      "15.00",
    );

    click("−");
    expect(text()).toContain("20.00 USDC");
  });

  test("the stake stepper walks down to the 0.50 floor and stops", () => {
    const stake = () =>
      container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value;

    for (let i = 0; i < 19; i++) click("−");
    expect(stake()).toBe("0.50");
    click("−");
    expect(stake()).toBe("0.50");
    expect(text()).toContain("1.00 USDC");
  });

  test("duration reads in minutes, not a tape multiplier", () => {
    expect(text()).toContain("DURATION (MINUTES)");
    expect(text()).toContain("1 minute duel");
    expect(text()).not.toContain("TAPE SPEED");
  });

  test("no invite link exists before the arena does", () => {
    // A link rendered ahead of its room is a link that 404s for the friend who
    // opens it.
    expect(text()).not.toContain("INVITE LINK");
    expect(container.querySelector("input[readonly]")).toBeNull();
  });

  test("back returns to the arena", () => {
    clickContaining("Arena");
    expect(text()).toContain("ACTIVE DUELS");
  });
});

describe("mode boards", () => {
  beforeEach(mount);

  test("the parlay board explains the one-underlying limit", () => {
    click("Parlay");
    expect(text()).toContain("Parlay · RFQ");
    expect(text()).toContain("One RFQ carries one underlying");
  });

  test("the find-a-difference board hides every edge before a lock", () => {
    click("Find a difference");
    expect(text()).toContain("Find a difference");
    expect(text()).toContain("Both picks stay hidden until both players lock");
  });

  test("a board with no duel says where to get one", () => {
    click("Parlay");
    expect(text()).toContain("Open a duel from the arena");
  });
});
