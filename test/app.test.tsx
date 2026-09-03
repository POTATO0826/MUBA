import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { bookFor } from "../src/data/lobbies.ts";
import { mockMarketSource } from "../src/data/market.ts";
import { LOCK_MS } from "../src/components/MatchSpin.tsx";
import { OPP_READY_MS } from "../src/state/match.ts";

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

function remount(path: string) {
  act(() => root.unmount());
  container.remove();
  mount(path);
}

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  // The app writes the match into the address bar; the next test starts clean.
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
const lobbyCards = () => Array.from(container.querySelectorAll<HTMLElement>("[data-lobby]"));

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Take the seat on a fixture lobby: into the room. */
function acceptLobby(id = "kz-semis") {
  const card = lobbyCards().find((c) => c.dataset.lobby === id)!;
  act(() => card.querySelector("button")!.click());
}

/** In the room: ready up, wait for the other seat, start the spin. */
async function readyBoth() {
  clickContaining("Ready up");
  await act(async () => {
    await sleep(OPP_READY_MS + 150);
  });
  click("Both ready → lucky spin");
}

/** Accept the first fixture lobby (kazuo's 3-leg stocks lobby), ready both, jump the reel. */
async function acceptAndSkip() {
  acceptLobby();
  await readyBoth();
  click("Skip ↦");
}

/** The tickers sitting in the spin's slots. An unfilled slot reads "?". */
const slotSyms = () =>
  Array.from(container.querySelectorAll<HTMLElement>("[data-slot]")).map((d) => d.lastElementChild?.textContent ?? "");

/** The tickers on your slip, in row order. */
const slipLegs = () => Array.from(container.querySelectorAll<HTMLElement>("[data-leg]")).map((d) => d.dataset.leg);

describe("landing", () => {
  test("opens on home with the hero, the payoffs, and a taste of the board", () => {
    mount();
    expect(text()).toContain("Battle the book, not the market.");
    expect(text()).toContain("BIGGEST PAYOFFS 24H");
    expect(text()).toContain("Open lobbies");
    expect(lobbyCards()).toHaveLength(4); // a taste, not the whole board
    expect(window.location.pathname).toBe("/");
  });

  test("every top-level tab renders", () => {
    mount();
    click("Battles");
    expect(text()).toContain("Open battles");
    expect(text()).toContain("+ Create lobby");

    click("Options desk");
    expect(text()).toContain("Combined payoff at expiry");
    expect(text()).toContain("MM pricing");

    click("Home");
    expect(text()).toContain("Battle the book, not the market.");
  });

  test("the wallet button toggles between connect and address", () => {
    mount();
    expect(text()).toContain("Connect wallet");
    click("Connect wallet");
    expect(text()).toContain("0x71c…4Af2");
    expect(text()).not.toContain("Connect wallet");
  });

  test("the home board links through to battles", () => {
    mount();
    click("All lobbies →");
    expect(text()).toContain("Open battles");
    expect(window.location.pathname).toBe("/battles");
  });
});

describe("the board", () => {
  test("shows every lobby as a card with its host, book, legs and pool", () => {
    mount("/battles");
    expect(lobbyCards()).toHaveLength(6);
    expect(text()).toContain("kazuo.eth");
    expect(text()).toContain("Semis sprint");
    expect(text()).toContain("6 open · 6 shown");
    const kz = lobbyCards().find((c) => c.dataset.lobby === "kz-semis")!;
    expect(kz.textContent).toContain("STOCKS");
    expect(kz.textContent).toContain("3 LEGS");
    expect(kz.textContent).toContain("4.80 Ξ");
    expect(kz.textContent).toContain("Accept match · 2.40 Ξ");
  });

  test("every card carries its own animated artwork, seeded by the lobby", () => {
    mount("/battles");
    const art = Array.from(container.querySelectorAll<HTMLElement>("[data-art]"));
    expect(art).toHaveLength(6);
    expect(new Set(art.map((a) => a.dataset.art)).size).toBe(6);
    for (const a of art) {
      // A real drawing, not an empty frame…
      expect(a.querySelectorAll("path, circle, polygon").length).toBeGreaterThanOrEqual(9);
      // …and it moves: SMIL on the shapes, or a CSS flow on the strokes.
      const smil = a.querySelectorAll("animate, animateTransform").length;
      const css = Array.from(a.querySelectorAll<SVGElement>("path")).filter((p) => (p.getAttribute("style") ?? "").includes("vcFlow")).length;
      expect(smil + css).toBeGreaterThan(0);
      expect(a.dataset.pattern).toBeTruthy();
    }
    // Same lobby, same picture — the art is a function of the id.
    const kz = () => container.querySelector('[data-art="kz-semis"] svg')?.innerHTML;
    const before = kz();
    remount("/battles");
    expect(kz()).toBe(before);
    // No tilt on the cards any more; the picture moves, the card does not.
    expect(container.querySelector("[data-tilt]")).toBeNull();
  });

  test("each card carries three lines of match details it reveals on hover", () => {
    mount("/battles");
    const details = container.querySelector<HTMLElement>('[data-details="kz-semis"]')!;
    expect(details.children).toHaveLength(3);
    expect(details.textContent).toContain("kazuo.eth · STOCKS · 3 legs");
    expect(details.textContent).toContain("4.80 Ξ pool · 2.40 Ξ each");
    expect(details.textContent).toContain("most legs wins");
    // Hidden until hover; the stylesheet's :hover rule reveals it.
    expect(details.className).toContain("vc-lobby-details");
  });

  test("the book filter narrows the board", () => {
    mount("/battles");
    click("CRYPTO");
    expect(lobbyCards()).toHaveLength(2);
    expect(text()).toContain("2 shown");
    click("ALL");
    expect(lobbyCards()).toHaveLength(6);
  });

  test("a published lobby goes to the top of the board and waits for a seat", () => {
    mount("/battles");
    click("+ Create lobby");
    expect(text()).toContain("Create lobby");
    expect(window.location.pathname).toBe("/create");

    const name = container.querySelector<HTMLInputElement>("input:not([inputmode])")!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(name, "My tail box");
      name.dispatchEvent(new Event("input", { bubbles: true }));
    });
    clickContaining("CRYPTO");
    click("+"); // legs 3 → 4
    clickContaining("Publish lobby");

    expect(text()).toContain("Open battles");
    expect(lobbyCards()).toHaveLength(7);
    const mine = lobbyCards()[0]!;
    expect(mine.dataset.lobby).toBe("mine-1");
    expect(mine.textContent).toContain("My tail box");
    expect(mine.textContent).toContain("CRYPTO");
    expect(mine.textContent).toContain("4 LEGS");
    expect(mine.textContent).toContain("YOURS · WAITING FOR P2");
    expect(mine.textContent).toContain("Waiting for opponent…");
    expect(mine.querySelector("button")).toBeNull(); // nothing to do yet
  });

  test("the prize steppers move the pool and the entry with it", () => {
    mount("/create");
    expect(text()).toContain("2.50 ETH"); // half of the default 5.00 pool
    const plus = buttons().filter((b) => (b.textContent ?? "").trim() === "+");
    act(() => plus[1]!.click()); // the second "+" is the prize
    expect(text()).toContain("2.75 ETH");
    expect(container.querySelector<HTMLInputElement>('input[inputmode="decimal"]')?.value).toBe("5.50");
  });
});

describe("the room", () => {
  test("pressing a card puts you in the lobby with the other player, not straight into the spin", () => {
    mount("/battles");
    acceptLobby();
    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe("/match/kz-semis/room");
    expect(text()).toContain("Semis sprint");
    expect(container.querySelector('[data-seat="You"]')).not.toBeNull();
    expect(container.querySelector('[data-seat="kazuo.eth"]')).not.toBeNull();
    expect(text()).toContain("0/2 READY");
    expect(text()).toContain("Ready up · 2.40 ETH entry");
    const begin = buttons().find((b) => (b.textContent ?? "").includes("Waiting for both players"));
    expect(begin?.disabled).toBe(true);
  });

  test("the spin waits for both seats to ready up", async () => {
    mount("/battles");
    acceptLobby();
    clickContaining("Ready up");
    expect(container.querySelector('[data-seat="You"]')?.textContent).toContain("READY");
    expect(text()).toContain("1/2 READY");
    // The other player has not readied yet, so the spin cannot start.
    expect(buttons().find((b) => (b.textContent ?? "").includes("Waiting for both players"))?.disabled).toBe(true);
    expect(dialog()).toBeNull();

    await act(async () => {
      await sleep(OPP_READY_MS + 150);
    });
    expect(text()).toContain("2/2 READY");
    click("Both ready → lucky spin");
    expect(dialog()?.getAttribute("aria-label")).toBe("Semis sprint spin");
    expect(window.location.pathname).toBe("/match/kz-semis");
  });

  test("readying up is when the entry leaves the balance", () => {
    mount("/battles");
    expect(text()).toContain("5,000 PTS");
    acceptLobby(); // kz-semis: 4.80 pool, 2.40 entry -> 2,400 pts
    click("Battles");
    expect(text()).toContain("5,000 PTS"); // a seat, not yet an entry
    click("Battles"); // still on the board; re-enter the room via the card
    acceptLobby();
    clickContaining("Ready up");
    click("Battles");
    expect(text()).toContain("2,600 PTS");
  });

  test("leaving the room gives the seat back", () => {
    mount("/battles");
    acceptLobby();
    click("Leave lobby");
    expect(text()).toContain("Open battles");
    expect(window.location.pathname).toBe("/battles");
    const kz = lobbyCards().find((c) => c.dataset.lobby === "kz-semis")!;
    expect(kz.textContent).toContain("OPEN · WAITING FOR P2");
    expect(kz.textContent).toContain("1/2");
  });
});

describe("the spin", () => {
  test("once both are ready the reel spins once per leg and fills exactly that many slots, no duplicates", async () => {
    mount("/battles");
    acceptLobby();
    await readyBoth();

    expect(dialog()?.getAttribute("aria-label")).toBe("Semis sprint spin");
    expect(text()).toContain("you vs kazuo.eth");
    expect(window.location.search).toMatch(/^\?seed=\d{6}$/);

    expect(slotSyms()).toHaveLength(3);
    expect(text()).toContain("spinning the book…");
    // Nothing to press: no claim button, ever.
    expect(buttons().some((b) => (b.textContent ?? "").includes("Claim"))).toBe(false);

    click("Skip ↦");
    expect(text()).toContain("locked");
    expect(text()).toContain("Opening the case study…");

    const syms = slotSyms();
    expect(syms.every((s) => s !== "?")).toBe(true);
    expect(new Set(syms).size).toBe(3);
  });

  test("the reel only deals from the lobby's own book", async () => {
    mount("/battles");
    acceptLobby("mi-majors"); // crypto, 2 legs
    await readyBoth();
    click("Skip ↦");
    const syms = slotSyms();
    expect(syms).toHaveLength(2);
    for (const s of syms) expect(bookFor("CRYPTO")).toContain(s);
    expect(bookFor("STOCK")).not.toContain(syms[0]);
  });

  test("the same seed deals the same tickers", () => {
    mount("/match/kz-semis/parlay?seed=424242");
    const first = slipLegs();
    expect(first).toHaveLength(3);
    remount("/match/kz-semis/parlay?seed=424242");
    expect(slipLegs()).toEqual(first);
  });

  test("closing the spin lands back on the board", async () => {
    mount("/battles");
    await acceptAndSkip();
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
    act(() => close!.click());
    expect(dialog()).toBeNull();
    expect(text()).toContain("Open battles");
    expect(window.location.pathname).toBe("/battles");
  });

  test("a match address with no lobby behind it lands on the board", () => {
    mount("/match/nope/parlay?seed=1");
    expect(text()).toContain("Open battles");
    expect(window.location.pathname).toBe("/battles");
  });

  test("once the last leg lands the case study opens on its own, on those tickers", async () => {
    mount("/battles");
    await acceptAndSkip();
    const dealt = slotSyms();
    expect(dialog()).not.toBeNull(); // the locked board holds for a beat
    await act(async () => {
      await sleep(LOCK_MS + 150);
    });
    expect(dialog()).toBeNull();
    expect(text()).toContain("Case study");
    for (const s of dealt) expect(text()).toContain(s);
    expect(window.location.pathname).toBe("/match/kz-semis/study");
  });
});

describe("the case study", () => {
  test("shows the dealt charts, a news line per ticker, and the desk talking", () => {
    mount("/match/kz-semis/study?seed=424242");
    expect(text()).toContain("Case study");
    expect(text()).toContain("STUDY PHASE · BOTH PLAYERS READING");
    expect(text()).toContain("NEWS WIRE · DESK CHATTER");
    expect(text()).toContain("kazuo.eth is reading this too");

    const news = container.querySelectorAll('[data-brief="news"]');
    const desk = container.querySelectorAll('[data-brief="desk"]');
    expect(news).toHaveLength(3); // one per leg
    expect(desk).toHaveLength(2); // one exchange
    expect(text()).toContain("COACH");
    // Three sparklines, one per dealt ticker.
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3);
  });

  test("the wire is the same wire every time for a seed", () => {
    mount("/match/kz-semis/study?seed=424242");
    const first = Array.from(container.querySelectorAll("[data-brief]")).map((b) => b.textContent);
    remount("/match/kz-semis/study?seed=424242");
    expect(Array.from(container.querySelectorAll("[data-brief]")).map((b) => b.textContent)).toEqual(first);
  });
});

describe("the parlay picks", () => {
  const pickers = () => Array.from(container.querySelectorAll<HTMLElement>("[data-leg-picker]"));
  const cards = () => Array.from(container.querySelectorAll<HTMLButtonElement>("[data-parlay]"));
  const pick = (sym: string, id: string) =>
    act(() => cards().find((c) => c.dataset.parlay === `${sym}:${id}`)!.click());
  const lock = () => buttons().find((b) => /Lock parlay|Pick \d+ more/.test(b.textContent ?? ""))!;
  const mult = () => container.querySelector('[data-testid="combined-mult"]')?.textContent;
  const prob = () => container.querySelector('[data-testid="implied-prob"]')?.textContent;

  test("every dealt ticker has its own eight cards", () => {
    mount("/match/kz-semis/parlay?seed=424242");
    expect(text()).toContain("Build your parlay · Semis sprint");
    expect(text()).toContain("BLIND · OPPONENT SLIP HIDDEN");
    expect(pickers()).toHaveLength(3);
    expect(cards()).toHaveLength(24); // 8 per ticker
    for (const sec of pickers()) {
      const sym = sec.dataset.legPicker!;
      for (const tier of ["safe", "even", "sharp", "degen"]) {
        for (const stance of ["bull", "bear"]) {
          expect(cards().some((c) => c.dataset.parlay === `${sym}:${tier}-${stance}`)).toBe(true);
        }
      }
      expect(sec.textContent).toContain("×1.2");
      expect(sec.textContent).toContain("×11.0");
      expect(sec.textContent).toContain("↑ BULL");
      expect(sec.textContent).toContain("↓ BEAR");
    }
  });

  test("the lock waits until every ticker has a pick", () => {
    mount("/match/kz-semis/parlay?seed=424242");
    const syms = slipLegs() as string[];
    expect(lock().disabled).toBe(true);
    expect(lock().textContent).toContain("Pick 3 more");
    expect(mult()).toBe("—");

    pick(syms[0]!, "sharp-bear");
    expect(lock().disabled).toBe(true);
    expect(lock().textContent).toContain("Pick 2 more");
    pick(syms[1]!, "safe-bull");
    pick(syms[2]!, "degen-bull");
    expect(lock().disabled).toBe(false);
    expect(lock().textContent).toContain("Lock parlay → duel");
  });

  test("the slip's odds are the product of the picks, per ticker, and update on every change", () => {
    mount("/match/kz-semis/parlay?seed=424242");
    const syms = slipLegs() as string[];
    pick(syms[0]!, "sharp-bear"); // 3.6
    pick(syms[1]!, "safe-bull"); // 1.2
    pick(syms[2]!, "degen-bull"); // 11
    expect(mult()).toBe("×47.52");
    expect(prob()).toBe("1.4%"); // .25 × .7 × .08
    expect(text()).toContain("SHARP↓ SAFE↑ DEGEN↑");
    expect(text()).toContain("closes below");
    expect(text()).toContain("closes above");

    pick(syms[2]!, "even-bull"); // 11 → 1.9
    expect(mult()).toBe("×8.21");
    expect(prob()).toBe("8.8%"); // .25 × .7 × .5, one decimal under the 10% line
  });

  test("the opponent's picks stay hidden until both lock", () => {
    mount("/match/kz-semis/parlay?seed=424242");
    expect(text()).toContain("•••••");
    expect(text()).toContain("Revealed when both slips lock.");
  });

  test("locking starts the duel on both slips", () => {
    mount("/match/kz-semis/parlay?seed=424242");
    for (const sym of slipLegs()) pick(sym!, "even-bull");
    act(() => lock().click());
    expect(text()).toContain("Live duel · Semis sprint");
    expect(text()).toContain("EVEN↑ EVEN↑ EVEN↑");
    expect(text()).toContain("kazuo.eth");
    expect(text()).toContain("HIDDEN UNTIL SETTLED");
    expect(text()).not.toContain("Settle → result"); // the tape has not played yet
    expect(window.location.pathname).toBe("/match/kz-semis/duel");
  });
});

describe("the result", () => {
  test("names the winner and summarises what each player chose", () => {
    mount("/match/kz-semis/result?seed=424242");
    expect(text()).toMatch(/takes? the pool/);
    expect(text()).toContain("4.80 ETH");
    expect(text()).toContain("Coach · match summary");
    expect(text()).toContain("WHAT EACH PLAYER CHOSE");
    expect(container.querySelector('[data-summary="You"]')).not.toBeNull();
    expect(container.querySelector('[data-summary="kazuo.eth"]')).not.toBeNull();
    expect(text()).toContain("WHAT DECIDED IT");
    expect(text()).toContain("LESSON FOR NEXT DUEL");
    expect(text()).toMatch(/PTS/);

    click("Back to battles");
    expect(text()).toContain("Open battles");
  });

  test("rematch opens the lobby builder", () => {
    mount("/match/kz-semis/result?seed=424242");
    click("Rematch · new lobby");
    expect(text()).toContain("Create lobby");
  });
});
