import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { bookFor } from "../src/data/lobbies.ts";
import { mockMarketSource, type MarketSource } from "../src/data/market.ts";
import type { NewsSource, WireItem } from "../src/data/news.ts";
import { MODES, MODE_SALT } from "../src/data/modes.ts";
import { bookForSectors } from "../src/data/sectors.ts";
import { edgeOf, scoreOf, settle } from "../src/engine/match.ts";
import { buildLeg } from "../src/engine/parlay.ts";
import { xpForMatch } from "../src/engine/rank.ts";
import { spinCase } from "../src/engine/spin.ts";
import { LOCK_MS } from "../src/components/MatchSpin.tsx";
import { OPP_READY_MS, TAPE_STEP } from "../src/state/match.ts";
import type { Mode, PricingRow, SectorKey } from "../src/types.ts";

let container: HTMLDivElement;
let root: Root;

/** Mount at a path. The app reads its route once, on mount. Passing no news
 *  source leaves the App on its seeded default, so nothing here hits a network.
 *  `source` likewise defaults to the seeded book — every test that does not name
 *  one is asserting the app as it renders with no live data at all. */
function mount(path = "/", newsSource?: NewsSource, source: MarketSource = mockMarketSource) {
  window.history.replaceState(null, "", path);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<App source={source} newsSource={newsSource} />);
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

/** Past the rank gate: open the sequence, park it synchronously. */
function throughRank() {
  click("Next → your rank");
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
      // A real drawing, not an empty frame… (`rect` since the ornament became
      // ChromeCandles: capsules are rounded rects, not paths.)
      expect(a.querySelectorAll("path, circle, polygon, rect").length).toBeGreaterThanOrEqual(9);
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

  // The ornament is `ChromeRally`: one chrome instrument per card, revealed by
  // a cold specular travelling along each capsule. It is decoration and nothing
  // else, so what these guard is that it stays inert, stays deterministic, and
  // never collides with the ornament on the card beside it.
  test("the chrome rally draws on every card, on both surfaces, and stays inert", () => {
    mount("/battles");
    const art = Array.from(container.querySelectorAll<HTMLElement>("[data-art]"));
    expect(art).toHaveLength(6);
    for (const a of art) {
      expect(a.dataset.pattern).toBe("chrome-rally");
      // Never in the way of a click, never in the accessibility tree.
      expect(a.getAttribute("aria-hidden")).not.toBeNull();
      expect(a.style.pointerEvents).toBe("none");
      // Per capsule: a body, a halo, a specular core and a rim, plus the
      // hairlines, four ticks and the streak's two rects. The rally's six
      // capsules are the thinner of the two objects and still clear this.
      expect(a.querySelectorAll("rect").length).toBeGreaterThanOrEqual(28);
      // One falling specular per capsule, plus the streak and its pool.
      expect(a.querySelectorAll("animateTransform").length).toBeGreaterThanOrEqual(8);
    }
    // The board is no longer six copies of one picture: the object is chosen
    // from the lobby's market (CRYPTO → candles, STOCK → tape, MIXED → a bit of
    // its id's hash), so both objects are on screen at once.
    const objects = new Set(art.map((a) => a.dataset.object));
    expect(objects).toEqual(new Set(["candles", "tape"]));
    expect(container.querySelector<HTMLElement>('[data-art="mi-majors"]')!.dataset.object).toBe("candles");
    expect(container.querySelector<HTMLElement>('[data-art="kz-semis"]')!.dataset.object).toBe("tape");

    // The home board renders the same card, so it gets the same ornament.
    remount("/");
    const home = Array.from(container.querySelectorAll<HTMLElement>("[data-art]"));
    expect(home).toHaveLength(4);
    expect(home.every((a) => a.dataset.pattern === "chrome-rally")).toBe(true);
  });

  test("two cards never share a gradient id, and neither redraws differently", () => {
    mount("/battles");
    const idsOf = (lobby: string) =>
      Array.from(container.querySelectorAll<SVGElement>(`[data-art="${lobby}"] defs [id]`)).map((n) => n.id);

    const a = idsOf("kz-semis");
    const b = idsOf("mi-majors");
    expect(a.length).toBeGreaterThanOrEqual(11); // 9 gradients + one clip per capsule
    expect(new Set(a).size).toBe(a.length);
    expect(a.some((id) => b.includes(id))).toBe(false);
    // Each card points only at its own defs.
    const markup = container.querySelector<HTMLElement>('[data-art="kz-semis"]')!.innerHTML;
    expect(markup).toContain("url(#cc-kz-semis-body)");
    expect(markup).not.toContain("url(#cc-mi-majors-");

    // Two renders, identical DOM — no `useId`, no `Math.random`, no clock.
    const before = container.querySelector<HTMLElement>('[data-art="mi-majors"]')!.innerHTML;
    remount("/battles");
    expect(container.querySelector<HTMLElement>('[data-art="mi-majors"]')!.innerHTML).toBe(before);

    // …and the card it decorates still says everything it said before.
    const kz = lobbyCards().find((c) => c.dataset.lobby === "kz-semis")!;
    expect(kz.textContent).toContain("Semis sprint");
    expect(kz.textContent).toContain("PRIZE POOL");
    expect(kz.textContent).toContain("ENTRY");
    expect(kz.textContent).toContain("Accept match · 2.40 Ξ");
  });

  test("under reduced motion the rally ships as one parked frame", () => {
    const real = globalThis.matchMedia;
    try {
      globalThis.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof real;
      mount("/battles");
      const art = Array.from(container.querySelectorAll<HTMLElement>("[data-art]"));
      expect(art).toHaveLength(6);
      for (const a of art) {
        // Nothing to still: the clocks were never rendered. (CSS cannot stop
        // SMIL, so the stylesheet's reduced-motion block is no help here.)
        expect(a.querySelectorAll("animate, animateTransform")).toHaveLength(0);
        // The light is parked at each capsule's waist rather than left at its
        // head, so the still frame is the lit frame, not a dark one. (The
        // halo and the core share one carrier group, hence `> g` and not
        // `> rect`.) Six capsules for the rally, nine for the tape.
        const parked = Array.from(a.querySelectorAll("g[clip-path] > g"));
        expect(parked.length).toBeGreaterThanOrEqual(6);
        expect(parked.every((r) => (r.getAttribute("transform") ?? "").startsWith("translate(0 "))).toBe(true);
      }
    } finally {
      globalThis.matchMedia = real;
    }
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

describe("sectors", () => {
  /** The chips are addressed by key, the same way CreateLobby stamps them. */
  const sectorChip = (k: SectorKey) =>
    container.querySelector<HTMLButtonElement>(`[data-sector="${k}"]`)!;
  const clickSector = (k: SectorKey) => act(() => sectorChip(k).click());
  /** The market the builder derives from the current selection — the tag
   *  sitting next to the "Create lobby" heading. */
  const marketTag = () => container.querySelector("h2")?.nextElementSibling?.textContent ?? "";
  const bookLine = () => container.querySelector("[data-book]")?.textContent ?? "";
  const gateNote = () => container.querySelector("[data-gate]")?.textContent ?? "";
  const publish = () => buttons().find((b) => (b.textContent ?? "").includes("Publish lobby"))!;

  test("composing MEME + BIG TECH derives MIXED and publishes that book", () => {
    // The book is whatever the two groups gather out of the universe — read it
    // off the data rather than pinning a number by hand.
    const book = bookForSectors(["TECH", "MEME"]);

    mount("/create");
    clickContaining("CRYPTO"); // preset first, so MIXED is a real change
    expect(marketTag()).toBe("CRYPTO");
    clickSector("MAJORS");
    clickSector("DEFI"); // MEME alone
    expect(marketTag()).toBe("CRYPTO");
    clickSector("TECH"); // …plus a stock group

    expect(marketTag()).toBe("MIXED");
    expect(sectorChip("TECH").getAttribute("aria-pressed")).toBe("true");
    expect(sectorChip("MEME").getAttribute("aria-pressed")).toBe("true");
    expect(sectorChip("MAJORS").getAttribute("aria-pressed")).toBe("false");
    expect(bookLine()).toContain(`book: ${book.length} names`);
    for (const sym of book) expect(bookLine()).toContain(sym);

    act(() => publish().click());

    expect(text()).toContain("Open battles");
    const mine = lobbyCards()[0]!;
    expect(mine.dataset.lobby).toBe("mine-1");
    expect(mine.textContent).toContain("MIXED"); // the derived market, not the preset
    expect(mine.textContent).toContain("BIG TECH");
    expect(mine.textContent).toContain("MEME");
  });

  test("the room counts the lobby's own sector book", () => {
    mount("/battles");
    acceptLobby(); // kz-semis: SEMIS + BIG TECH + OLD WORLD
    expect(text()).toContain(`The book is ${bookForSectors(["SEMIS", "TECH", "MACRO"]).length} names`);
  });

  test("a book too small for the legs gates Publish until a sector is added", () => {
    mount("/create");
    click("+"); // legs 3 → 4, while the full board is still selected
    expect(text()).toContain("2 to 4");
    expect(publish().disabled).toBe(false);

    // Dropping groups never re-clamps the legs, so the selection can undershoot.
    for (const k of ["SEMIS", "TECH", "MACRO", "MAJORS", "DEFI"] as const) clickSector(k);
    expect(bookLine()).toContain(`book: ${bookForSectors(["MEME"]).length} names`);
    expect(publish().disabled).toBe(true);
    expect(gateNote()).toContain("4 legs");

    clickSector("DEFI"); // back over the line
    expect(publish().disabled).toBe(false);
    expect(container.querySelector("[data-gate]")).toBeNull();
  });

  test("cards wear their book: a preset collapses to one chip, a composition spells itself out", () => {
    mount("/battles");
    // Resting face only — the hover pane below carries the full book, so the
    // chip assertions have to look at the body or they prove nothing.
    const face = (id: string) =>
      lobbyCards().find((c) => c.dataset.lobby === id)!.querySelector(".vc-lobby-body")!.textContent ?? "";

    expect(face("kz-semis")).toContain("ALL STOCKS"); // SEMIS + TECH + MACRO is the STOCK preset
    expect(face("kz-semis")).not.toContain("OLD WORLD");

    expect(face("lx-degen")).toContain("DEFI");
    expect(face("lx-degen")).toContain("MEME");
    expect(face("lx-degen")).not.toContain("ALL CRYPTO");

    // Hover still spells the whole book out, still in three lines.
    const details = container.querySelector<HTMLElement>('[data-details="kz-semis"]')!;
    expect(details.children).toHaveLength(3);
    expect(details.children[0]!.textContent).toContain("SEMIS + BIG TECH + OLD WORLD");
  });

  test("the sector book feeds the reel: kz-semis at 424242 still deals TSLA · AMD · META", () => {
    const dealt = spinCase(bookForSectors(["SEMIS", "TECH", "MACRO"]), 3, 424242).syms;
    expect(dealt).toEqual(["TSLA", "AMD", "META"]);
    mount("/match/kz-semis/parlay?seed=424242");
    expect(slipLegs()).toEqual([...dealt]);
  });
});

describe("modes", () => {
  /** Resting card face. The hover pane carries the full line too, so a
   *  negative assertion has to scope to the body or it proves nothing. */
  const face = (id: string) =>
    lobbyCards().find((c) => c.dataset.lobby === id)!.querySelector(".vc-lobby-body")!.textContent ?? "";
  const modeBtns = () => Array.from(container.querySelectorAll<HTMLButtonElement>("[data-mode]"));
  const modeBtn = (m: Mode) => modeBtns().find((b) => b.dataset.mode === m)!;
  const pressed = () => modeBtns().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.dataset.mode);
  const boostLine = () => container.querySelector<HTMLElement>("[data-boost]");
  const testid = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  test("every card wears the window it is played on", () => {
    mount("/battles");
    expect(face("lx-degen")).toContain("BLITZ");
    expect(face("lx-degen")).toContain("15M");
    expect(face("kz-semis")).toContain("NORMAL · 24H");
    expect(face("kz-semis")).not.toContain("BLITZ");

    // The window folds into the third hover line rather than adding a fourth.
    const details = container.querySelector<HTMLElement>('[data-details="lx-degen"]')!;
    expect(details.children).toHaveLength(3);
    expect(details.children[2]!.textContent).toContain("BLITZ · 15 MIN window");
    expect(details.children[2]!.textContent).toContain("most legs wins");
  });

  test("the builder picks a mode, and the payout boost follows it", () => {
    mount("/create");
    expect(modeBtns().map((b) => b.dataset.mode)).toEqual(["BLITZ", "QUICK", "NORMAL"]);
    // The house edition is the default: base targets, base odds, no clock.
    expect(pressed()).toEqual(["NORMAL"]);
    expect(boostLine()).toBeNull();

    act(() => modeBtn("BLITZ").click());
    expect(pressed()).toEqual(["BLITZ"]);
    expect(boostLine()?.textContent).toContain("×1.35");

    act(() => modeBtn("NORMAL").click());
    expect(pressed()).toEqual(["NORMAL"]);
    expect(boostLine()).toBeNull();
  });

  test("the mode is the window: the same slip on the same seed settles on a different scoreboard", () => {
    // lx-degen's own arena and salt, built the way `derived` builds them — a
    // ticker nobody picked previews at EVEN ↑, and the mode scales the line.
    const arena = spinCase(bookForSectors(["DEFI", "MEME"]), 3, 424242).syms;
    const salt = 2 + 424242 * 3 + MODE_SALT.BLITZ;
    const scale = MODES.BLITZ.targetScale;
    const mine = arena.map((s) => buildLeg(s, "over", "EVEN", scale));
    const theirs = arena.map((s) => buildLeg(s, "under", "EVEN", scale));

    // Only the settle print moves. Fifteen minutes of tape is not a prefix of
    // the day's read — the opponent's book has not landed a leg yet at 56.
    expect(scoreOf(theirs, salt, MODES.BLITZ.settleAt)).toBe(0);
    expect(scoreOf(theirs, salt, MODES.NORMAL.settleAt)).toBe(1);
    expect(edgeOf(mine, salt, MODES.BLITZ.settleAt)).not.toBe(edgeOf(mine, salt, MODES.NORMAL.settleAt));

    const blitz = settle(mine, theirs, arena, salt, MODES.BLITZ.settleAt, "You", "lexa");
    const normal = settle(mine, theirs, arena, salt, MODES.NORMAL.settleAt, "You", "lexa");
    expect(blitz.scoreLine).not.toBe(normal.scoreLine);
    expect(blitz.decider).not.toBe(normal.decider);

    // And the duel screen says which window it is playing, in the same numbers.
    mount("/match/lx-degen/duel?seed=424242");
    expect(text()).toContain("BLITZ · 15 MIN · TAPE ×402");
    remount("/match/kz-semis/duel?seed=424242");
    expect(text()).toContain("NORMAL · 24 HOURS · TAPE ×10,800");
  });

  test("a timed mode puts a clock on the pick screen, an untimed one does not", () => {
    mount("/match/lx-degen/parlay?seed=424242");
    const clock = testid("pick-clock")!;
    expect(clock).not.toBeNull();
    expect(clock.textContent).toMatch(/^\d+:\d{2}$/);
    expect(clock.getAttribute("style")).toContain("monospace");
    expect(testid("pick-clock-note")?.textContent).toContain("lock at EVEN");

    remount("/match/kz-semis/parlay?seed=424242");
    expect(testid("pick-clock")).toBeNull();
    expect(testid("pick-clock-note")).toBeNull();
  });

  test("a slip left unpicked locks itself once the clock runs out", async () => {
    mount("/match/lx-degen/parlay?seed=424242");
    expect(testid("pick-clock")).not.toBeNull();

    const realNow = Date.now;
    try {
      // Past the 20-second deadline. The match's own 120ms interval is what
      // notices — the same tick that would have counted the clock down.
      Date.now = () => realNow.call(Date) + 60_000;
      await act(async () => {
        await sleep(150);
      });
    } finally {
      Date.now = realNow;
    }

    expect(window.location.pathname).toBe("/match/lx-degen/duel");
    expect(text()).toContain("Live duel · Friday tail");
    // Expired is the button's own transition: every unpicked leg went EVEN ↑.
    expect(text()).toContain("EVEN↑ EVEN↑ EVEN↑");
  });

  test("the window premium rides a Blitz slip and leaves NORMAL's odds where they were", () => {
    mount("/match/lx-degen/parlay?seed=424242");
    expect(testid("odds-boost")?.textContent).toContain("+35%");

    remount("/match/kz-semis/parlay?seed=424242");
    expect(testid("odds-boost")).toBeNull();
    // …and the pinned NORMAL slip still prices exactly as it always did.
    const cards = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-parlay]"));
    const pick = (sym: string, id: string) =>
      act(() => cards.find((c) => c.dataset.parlay === `${sym}:${id}`)!.click());
    const syms = slipLegs() as string[];
    pick(syms[0]!, "sharp-bear");
    pick(syms[1]!, "safe-bull");
    pick(syms[2]!, "degen-bull");
    expect(testid("combined-mult")?.textContent).toBe("×47.52");
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
  const STUDY = "/match/kz-semis/study?seed=424242";
  /** The study screen has no slip to read the arena off, so it is derived the
   *  same way the app derives it: kz-semis is a 3-leg STOCK lobby. */
  const dealt = spinCase(bookFor("STOCK"), 3, 424242).syms;

  const wireRows = (kind?: string) =>
    Array.from(container.querySelectorAll<HTMLElement>(kind ? `[data-wire="${kind}"]` : "[data-wire]"));
  const wireSyms = () => wireRows().map((r) => r.dataset.wireSym);
  const pane = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`)?.textContent ?? "";

  // ── the wire filter ───────────────────────────────────────────────────────
  // One piece of state, two handles: the case card above the terminal and the
  // sym chip on a wire row inside it.
  const caseCard = (sym: string) => container.querySelector<HTMLElement>(`[data-case="${sym}"]`)!;
  const clickCase = (sym: string) => act(() => caseCard(sym).click());
  const pressed = (sym: string) => caseCard(sym).getAttribute("aria-pressed");
  /** The row's own sym chip — the handle that sits inside the click target. */
  const chipIn = (row: HTMLElement) => row.querySelector<HTMLElement>("[data-wire-chip]")!;
  const rowById = (id: string) => container.querySelector<HTMLElement>(`[data-wire-id="${id}"]`)!;
  const filterChip = () => container.querySelector<HTMLElement>('[data-testid="wire-filter"]');
  /** The whole terminal's markup — the detail pane's parent is the panel. */
  const terminal = () => container.querySelector<HTMLElement>('[data-testid="wire-detail"]')!.parentElement!.innerHTML;

  /** A live source held open, so the swap can be released inside `act()`. */
  function heldWire(items: readonly WireItem[]): { source: NewsSource; release: () => void } {
    let release: (() => void) | null = null;
    const source: NewsSource = {
      id: "live-stub",
      wire: () =>
        new Promise((resolve) => {
          release = () => resolve({ ok: true, source: "live", fetchedAt: 1_700_000_100_000, items });
        }),
    };
    return { source, release: () => release!() };
  }

  test("shows the dealt charts, a news line per ticker, and the desk talking", () => {
    mount(STUDY);
    expect(text()).toContain("Case study");
    expect(text()).toContain("STUDY PHASE · BOTH PLAYERS READING");
    expect(text()).toContain("NEWS WIRE · DESK CHATTER");
    expect(text()).toContain("kazuo.eth is reading this too");

    const news = wireRows("news");
    const desk = container.querySelectorAll('[data-brief="desk"]');
    // The terminal files several stories per ticker, never fewer than one each.
    expect(news.length).toBeGreaterThanOrEqual(dealt.length);
    for (const sym of dealt) expect(wireSyms()).toContain(sym);
    expect(desk).toHaveLength(2); // one exchange
    expect(text()).toContain("COACH");
    // Three sparklines, one per dealt ticker.
    expect(container.querySelectorAll("svg").length).toBeGreaterThanOrEqual(3);
  });

  test("the wire is the same wire every time for a seed", () => {
    mount(STUDY);
    const first = Array.from(container.querySelectorAll("[data-wire]")).map((b) => b.textContent);
    remount(STUDY);
    expect(Array.from(container.querySelectorAll("[data-wire]")).map((b) => b.textContent)).toEqual(first);
  });

  test("the detail pane is already filed before anything is clicked", () => {
    mount(STUDY);
    // The top row auto-opens, so an empty pane is structurally impossible.
    expect(pane("wire-detail").length).toBeGreaterThan(0);
    expect(pane("wire-dateline").length).toBeGreaterThan(0);
    expect(pane("wire-signature")).toContain("(END)");
  });

  test("clicking a headline opens it in the detail pane", () => {
    mount(STUDY);
    const before = pane("wire-dateline");
    const row = wireRows("news").at(-1)!;
    const sym = row.dataset.wireSym!;
    act(() => row.click());
    const after = pane("wire-dateline");
    expect(after).not.toBe(before);
    expect(after).toContain(sym);
    expect(pane("wire-detail")).toContain(after);
  });

  test("the source chip reads SEEDED with no live wire injected", () => {
    mount(STUDY);
    expect(pane("wire-status")).toBe("SEEDED");
  });

  test("a live news source swaps the feed in and flips the chip to LIVE", async () => {
    // Held open until the test releases it, so the seeded first paint can be
    // asserted before the swap — and so the swap lands inside act().
    const items: readonly WireItem[] = [
      {
        id: "live-1",
        kind: "news",
        sym: dealt[0]!,
        ts: 1_700_000_100_000,
        time: "09:28:00",
        headline: "Wire Desk Confirms The Live Feed Is Up",
        publisher: "REUTERS",
        body: "The live source answered, so these rows replaced the seeded ones.",
        bodyKind: "wire",
        link: "https://example.invalid/live-1",
        dateline: `9/1/26 09:28:00: ${dealt[0]}: Wire Desk Confirms The Live Feed Is Up`,
        signature: "(END) REUTERS / 09-01-26 0928ET / Copyright (c) 2026 Thomson Reuters.",
      },
      {
        id: "live-2",
        kind: "news",
        sym: null,
        ts: 1_700_000_000_000,
        time: "09:26:40",
        headline: "Market Wide Line With No Ticker Attached",
        publisher: "BLOOMBERG",
        body: "A market-wide row renders under MKT rather than a sym chip.",
        bodyKind: "wire",
        link: null,
        dateline: "9/1/26 09:26:40: MKT: Market Wide Line With No Ticker Attached",
        signature: "(END) BLOOMBERG / 09-01-26 0926ET / Copyright (c) 2026 Bloomberg L.P.",
      },
    ];
    const live = heldWire(items);

    mount(STUDY, live.source);
    expect(pane("wire-status")).toBe("SEEDED"); // seeded until the live one answers
    expect(wireRows("news").length).toBeGreaterThanOrEqual(dealt.length);

    await act(async () => live.release());

    expect(pane("wire-status")).toBe("LIVE");
    expect(wireRows("news")).toHaveLength(2);
    expect(text()).toContain("Wire Desk Confirms The Live Feed Is Up");
    expect(wireSyms()).toContain("MKT");
  });

  test("a case card narrows the wire to its own ticker, and a second press hands it back", () => {
    mount(STUDY);
    const whole = wireSyms();
    // A wire worth filtering: more than one name on it, and the desk talking.
    expect(new Set(whole).size).toBeGreaterThan(1);
    expect(container.querySelectorAll('[data-brief="desk"]')).toHaveLength(2);
    expect(filterChip()).toBeNull();
    expect(pressed(dealt[0]!)).toBe("false");

    clickCase(dealt[0]!);

    expect(wireRows().length).toBeGreaterThan(0);
    // The asset, full stop: no other ticker, no desk chatter, no MKT rows.
    expect(new Set(wireSyms())).toEqual(new Set([dealt[0]]));
    expect(container.querySelectorAll('[data-brief="desk"]')).toHaveLength(0);
    // …and the terminal says so, in the header, next to the source chip.
    expect(pane("wire-filter")).toContain(dealt[0]!);
    expect(pane("wire-status")).toBe("SEEDED");
    expect(pressed(dealt[0]!)).toBe("true");
    // The pane is still filed — the first surviving row took over.
    expect(pane("wire-dateline")).toContain(dealt[0]!);

    clickCase(dealt[0]!);

    expect(wireSyms()).toEqual(whole);
    expect(filterChip()).toBeNull();
    expect(pressed(dealt[0]!)).toBe("false");
  });

  test("the sym chip is the other handle on the same switch, and it never moves the open story", () => {
    mount(STUDY);
    // Two rows on the SAME ticker: open the first, then press the SECOND one's
    // chip. Both rows survive the filter, so if the chip's click reached the
    // row under it the pane would swing to the other story — which is exactly
    // what the assertion below would catch. Pressing the open row's own chip
    // would prove nothing, since re-selecting it is a no-op.
    const news = wireRows("news");
    const sym = news[0]!.dataset.wireSym!;
    const same = news.filter((r) => r.dataset.wireSym === sym);
    expect(same.length).toBeGreaterThan(1);
    const openerId = same[0]!.dataset.wireId!;
    const otherId = same[1]!.dataset.wireId!;

    act(() => rowById(openerId).click());
    const opened = pane("wire-dateline");
    expect(opened).toContain(sym);

    act(() => chipIn(rowById(otherId)).click());

    // The chip filtered the wire…
    expect(new Set(wireSyms())).toEqual(new Set([sym]));
    expect(pane("wire-filter")).toContain(sym);
    // …and the card above it knows, because there is only one piece of state.
    expect(pressed(sym)).toBe("true");
    // …but the click stopped at the chip: the row under it never selected.
    expect(pane("wire-dateline")).toBe(opened);
    expect(rowById(openerId).getAttribute("aria-selected")).toBe("true");
    expect(rowById(otherId).getAttribute("aria-selected")).toBe("false");

    act(() => chipIn(rowById(otherId)).click());

    expect(filterChip()).toBeNull();
    expect(pressed(sym)).toBe("false");
    expect(pane("wire-dateline")).toBe(opened);
  });

  test("switching tickers switches the wire, and the header chip is the way out", () => {
    mount(STUDY);
    clickCase(dealt[0]!);
    expect(new Set(wireSyms())).toEqual(new Set([dealt[0]]));

    clickCase(dealt[1]!);

    expect(new Set(wireSyms())).toEqual(new Set([dealt[1]]));
    expect(pressed(dealt[0]!)).toBe("false");
    expect(pressed(dealt[1]!)).toBe("true");
    // The story that was open belonged to the old ticker, so the pane fell
    // through to the new ticker's top row rather than blanking.
    expect(pane("wire-dateline")).toContain(dealt[1]!);

    act(() => filterChip()!.click());

    expect(filterChip()).toBeNull();
    expect(pressed(dealt[1]!)).toBe("false");
    expect(container.querySelectorAll('[data-brief="desk"]')).toHaveLength(2);
  });

  test("a ticker the feed filed nothing on says so rather than going blank", async () => {
    // One live row, on the first dealt name only — the other two cards are
    // filtering a wire that has nothing to give them.
    const live = heldWire([
      {
        id: "live-1",
        kind: "news",
        sym: dealt[0]!,
        ts: 1_700_000_100_000,
        time: "09:28:00",
        headline: "Wire Desk Confirms The Live Feed Is Up",
        publisher: "REUTERS",
        body: "The live source answered, so these rows replaced the seeded ones.",
        bodyKind: "wire",
        link: null,
        dateline: `9/1/26 09:28:00: ${dealt[0]}: Wire Desk Confirms The Live Feed Is Up`,
        signature: "(END) REUTERS / 09-01-26 0928ET / Copyright (c) 2026 Thomson Reuters.",
      },
    ]);

    mount(STUDY, live.source);
    await act(async () => live.release());
    expect(wireRows("news")).toHaveLength(1);

    clickCase(dealt[1]!);

    expect(wireRows()).toHaveLength(0);
    expect(pane("wire-empty")).toBe(`NO ${dealt[1]} STORIES ON THE WIRE`);
    // The detail pane draws its own quiet line rather than throwing on a
    // story that is not there.
    expect(pane("wire-detail")).toContain("The wire is quiet");
    expect(container.querySelector('[data-testid="wire-dateline"]')).toBeNull();

    // …and the wire that does have stories is one press away.
    clickCase(dealt[0]!);
    expect(container.querySelector('[data-testid="wire-empty"]')).toBeNull();
    expect(wireRows()).toHaveLength(1);
  });

  test("clearing the filter puts the terminal back node for node", () => {
    mount(STUDY);
    const before = terminal();

    clickCase(dealt[0]!);
    expect(terminal()).not.toBe(before);

    clickCase(dealt[0]!);
    expect(terminal()).toBe(before);
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

    throughRank();
    click("Back to battles");
    expect(text()).toContain("Open battles");
  });

  test("rematch opens the lobby builder", () => {
    mount("/match/kz-semis/result?seed=424242");
    throughRank();
    click("Rematch · new lobby");
    expect(text()).toContain("Create lobby");
  });
});

describe("the rank moment", () => {
  /** The same settled result the debrief tests read — a NORMAL, 3-leg lobby. */
  const RESULT = "/match/kz-semis/result?seed=424242";
  const labels = () => buttons().map((b) => (b.textContent ?? "").trim());
  const sequence = () => container.querySelector<HTMLElement>("[data-rank-sequence]");
  const copyPanel = () => container.querySelector<HTMLElement>("[data-rank-copy]")?.textContent ?? "";
  const nextSub = () => container.querySelector<HTMLElement>("[data-next-sub]")?.textContent ?? "";

  test("the exits are sealed until the rank moment has played", () => {
    mount(RESULT);
    // One way out of the debrief, and it is not a way off the screen.
    expect(labels()).toContain("Next → your rank");
    expect(labels()).not.toContain("Back to battles");
    expect(labels()).not.toContain("Rematch · new lobby");
    expect(labels()).not.toContain("View the full ladder →");
    expect(sequence()).toBeNull();
    expect(container.querySelector("[data-rank-exits]")).toBeNull();
    expect(container.querySelector("[data-rank-overlay]")).toBeNull();

    click("Next → your rank");
    const overlay = container.querySelector<HTMLElement>("[data-rank-overlay]");
    expect(overlay).not.toBeNull();
    expect(overlay?.getAttribute("role")).toBe("dialog");
    expect(overlay?.getAttribute("aria-modal")).toBe("true");
    expect(overlay?.style.position).toBe("fixed");
    click("Skip ↦");

    expect(sequence()).not.toBeNull();
    expect(container.querySelector("[data-rank-exits]")).not.toBeNull();
    expect(labels()).toContain("Back to battles");
    expect(labels()).toContain("Rematch · new lobby");
    expect(labels()).toContain("View the full ladder →");
    // …and the bar that opened the moment is spent, sub-line and all.
    expect(labels()).not.toContain("Next → your rank");
    expect(container.querySelector("[data-next-sub]")).toBeNull();
  });

  test("the debrief dims through the gate, and is never unmounted", () => {
    mount(RESULT);
    const debrief = container.querySelector<HTMLElement>("[data-debrief]")!;
    expect(Number(debrief.style.opacity)).toBe(1);

    click("Next → your rank");
    // The same node, restyled — React never tore the debrief down.
    expect(container.querySelector("[data-debrief]")).toBe(debrief);
    expect(Number(debrief.style.opacity)).toBeGreaterThan(0);
    expect(Number(debrief.style.opacity)).toBeLessThan(1);
    expect(text()).toMatch(/takes? the pool/);
    expect(text()).toContain("WHAT DECIDED IT");
    expect(text()).toContain("Coach · match summary");
    expect(container.querySelector('[data-summary="You"]')).not.toBeNull();

    click("Skip ↦");
    expect(container.querySelector("[data-debrief]")).toBe(debrief);
    expect(Number(debrief.style.opacity)).toBe(1); // lit again, still reading
    expect(text()).toMatch(/takes? the pool/);
    expect(text()).toContain("WHAT DECIDED IT");
  });

  test("the moment names the band, counts the XP and slides the ladder position", () => {
    mount(RESULT);
    throughRank();

    const seq = sequence()!;
    const label = seq.dataset.rank ?? "";
    // A tier and a division numeral: "SHARK II".
    expect(label).toMatch(/^(MINNOW|FISH|SHARK|ORCA|WHALE) (I|II|III)$/);
    expect(seq.textContent).toContain(label);
    expect(seq.textContent).toContain("XP");
    expect(seq.textContent).toContain("LADDER POSITION");

    // The bar and the numeral both parked on their end state.
    expect(container.querySelector("[data-rank-bar]")).not.toBeNull();
    expect(Number(container.querySelector<HTMLElement>("[data-rank-xp]")?.dataset.rankXp)).toBeGreaterThan(0);
    expect(container.querySelector<HTMLElement>("[data-rank-ladder]")?.textContent).toMatch(/#\d+\s*→\s*#\d+/);
  });

  test("the copy-trade panel prices the fee and takes exactly one of its two states", () => {
    mount(RESULT);
    throughRank();

    const copy = copyPanel();
    expect(copy).toContain("3.5% PER COPIED TRANSACTION");
    expect(copy).toContain("COPIERS");
    // Unlocked or still climbing — one of the two, never both, never neither.
    const states = ["COPY-TRADE ACTIVE", "UNLOCK COPY-TRADE"].filter((s) => copy.includes(s));
    expect(states).toHaveLength(1);
  });

  test("the same result path plays the same rank moment twice", () => {
    mount(RESULT);
    throughRank();
    const first = copyPanel();
    const label = sequence()!.dataset.rank;
    expect(first.length).toBeGreaterThan(0);

    remount(RESULT);
    throughRank();
    expect(copyPanel()).toBe(first);
    expect(sequence()!.dataset.rank).toBe(label);
  });

  test(
    "the pending line is the XP the settled match actually paid",
    async () => {
      // A result opened by its address is a replay: nothing went through the
      // ledger, so there is a season line but nothing pending on it.
      mount(RESULT);
      expect(nextSub()).toContain("XP PENDING");
      expect(nextSub()).toContain("+0 XP");

      // Played for real, the line is `xpForMatch` on the lobby's own mode.
      // lx-degen is the BLITZ fixture — 56 prints of tape rather than 200,
      // which is the only window that settles inside a test's patience.
      remount("/match/lx-degen/parlay?seed=424242");
      const realNow = Date.now;
      try {
        // Past the 20-second pick clock: every leg auto-locks at EVEN ↑.
        Date.now = () => realNow.call(Date) + 60_000;
        await act(async () => {
          await sleep(150);
        });
      } finally {
        Date.now = realNow;
      }
      expect(window.location.pathname).toBe("/match/lx-degen/duel");

      // The tape runs TAPE_STEP prints per 120ms tick, from zero.
      await act(async () => {
        await sleep((MODES.BLITZ.settleAt / TAPE_STEP) * 120 + 600);
      });
      click("Settle → result");

      // What the ledger banked, read off the screen rather than re-derived:
      // the header names the winner and prints the leg count either way.
      const won = text().includes("You take the pool");
      const myScore = Number(text().match(/(\d+) legs? vs \d+/)?.[1]);
      expect(Number.isFinite(myScore)).toBe(true);
      const expected = xpForMatch("BLITZ", won && myScore === 3, won);

      expect(nextSub()).toContain(`+${expected} XP PENDING`);
      // …and the moment counts out that same figure.
      throughRank();
      expect(sequence()!.textContent).toContain(`+${expected} XP`);
    },
    15_000,
  );
});

describe("the ladder", () => {
  /** The whole board: three plinths plus every table row. The page splits the
   *  ranked list in two, so neither half alone is the count to assert on. */
  const podium = () => Array.from(container.querySelectorAll<HTMLElement>("[data-podium]"));
  const rankRows = () => Array.from(container.querySelectorAll<HTMLElement>("[data-rank-row]"));
  const rowIds = () => rankRows().map((r) => r.dataset.rankRow ?? "");
  const boardSize = () => podium().length + rankRows().length;
  const leader = () => container.querySelector<HTMLElement>('[data-podium="1"]')?.textContent ?? "";
  /** The metric column's header. Addressed by its own attribute rather than by
   *  `[title]`: the risk chips on every row and plinth carry a title too, so
   *  "the only titled node on the page" stopped being true when the ladder
   *  grew a copy-trader surface. The title itself still carries the
   *  untruncated text the column may be eliding. */
  const metricHead = () =>
    container.querySelector<HTMLElement>("[data-metric-head]")?.getAttribute("title") ?? "";
  const nudge = () => container.querySelector<HTMLElement>("[data-you-nudge]")?.textContent ?? "";
  const drawers = () => Array.from(container.querySelectorAll<HTMLElement>("[data-ladder-drawer]"));

  /** Row A. Labels come from `FILTER_LABEL`, so they are the visible strings. */
  function pickFilter(label: string) {
    const el = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-ladder-filters] button"),
    ).find((b) => (b.textContent ?? "").trim() === label);
    if (!el) throw new Error(`no ladder filter "${label}"`);
    act(() => el.click());
  }

  /** Row B. A chip's text is its label with the qualifying count welded on
   *  ("SEMIS4"), so match the front of it — and only inside the revealed row,
   *  which is where `data-ladder-selection` lives. */
  function chip(label: string) {
    const el = Array.from(
      container.querySelectorAll<HTMLButtonElement>("[data-ladder-selection] button"),
    ).find((b) => (b.textContent ?? "").startsWith(label));
    if (!el) throw new Error(`no ladder chip "${label}"`);
    act(() => el.click());
  }

  function clearSelection() {
    const el = container.querySelector<HTMLButtonElement>("[data-ladder-clear]");
    if (!el) throw new Error("no clear × on the ladder");
    act(() => el.click());
  }

  test("/ranks opens on the ladder itself, not a bounce to the board", () => {
    mount("/ranks");
    // A cold /ranks is not a match address: it must not redirect to battles.
    expect(window.location.pathname).toBe("/ranks");
    expect(container.querySelector("[data-ladder]")).not.toBeNull();

    expect(text()).toContain("The ladder");
    expect(text()).toContain("3.5%"); // rank is income, priced on the page
    expect(text()).toContain("RANKED");
    expect(text()).toContain("COPIERS ACTIVE");
    // The copy desk is denominated in dollars — fee revenue and copy capital,
    // both of them money, neither of them the PTS ledger.
    expect(text()).toContain("FEES / 24H");
    expect(text()).toContain("COPY CAPITAL");
    expect(text()).toMatch(/\$[\d,.]+[KM]?/);

    // Thirteen personas plus your row: three on plinths, the rest in the table.
    expect(podium()).toHaveLength(3);
    expect(rankRows()).toHaveLength(11);
    // Your row is drawn once, wherever it lands — plinth or table, never both.
    expect(container.querySelectorAll("[data-you]")).toHaveLength(1);
  });

  test("the ladder is a tab like any other, and the others still work", () => {
    mount();
    click("Ranking");
    expect(window.location.pathname).toBe("/ranks");
    expect(text()).toContain("The ladder");

    click("Battles");
    expect(window.location.pathname).toBe("/battles");
    expect(text()).toContain("Open battles");
  });

  test("each filter re-ranks the same fourteen players", () => {
    mount("/ranks");
    const heads: string[] = [];
    const leaders: string[] = [];

    for (const label of ["COPY HEAT", "GAIN 12M", "SECTOR × MODE", "WIN RATE", "EARNINGS"]) {
      pickFilter(label);
      // Nobody is invented and nobody is dropped — the board is re-sorted.
      expect(boardSize()).toBe(14);
      expect(podium()).toHaveLength(3);
      // …and re-numbered from the top every time.
      expect(container.querySelector('[data-podium="1"]')).not.toBeNull();
      expect(container.querySelector('[data-podium="3"]')).not.toBeNull();
      heads.push(metricHead());
      leaders.push(leader());
    }

    // The metric column says which question is being answered, and the five
    // questions are five different questions.
    expect(new Set(heads).size).toBe(5);
    // …and at least two of them have a different answer at #1.
    expect(new Set(leaders).size).toBeGreaterThan(1);
  });

  test("sector × mode composes: OR inside a group, AND across them", () => {
    mount("/ranks");
    pickFilter("SECTOR × MODE");
    expect(container.querySelector("[data-ladder-selection]")).not.toBeNull();
    // Empty means ALL — the default board is the whole ladder.
    expect(metricHead()).toBe("WINS · ALL SECTORS · ALL MODES");
    expect(boardSize()).toBe(14);

    chip("SEMIS");
    expect(metricHead()).toBe("WINS · SEMIS · ALL MODES");
    const semis = boardSize();
    expect(semis).toBeGreaterThan(0);
    expect(semis).toBeLessThan(14);

    // OR within the group: a second sector can only widen the pool.
    chip("BIG TECH");
    expect(metricHead()).toBe("WINS · SEMIS+BIG TECH · ALL MODES");
    const both = boardSize();
    expect(both).toBeGreaterThan(semis);
    expect(both).toBeLessThan(14);

    // AND across groups: a mode on top can only narrow it.
    chip("BLITZ");
    expect(metricHead()).toBe("WINS · SEMIS+BIG TECH · BLITZ");
    expect(boardSize()).toBeLessThan(both);
    expect(boardSize()).toBeGreaterThan(0);

    clearSelection();
    expect(metricHead()).toBe("WINS · ALL SECTORS · ALL MODES");
    expect(boardSize()).toBe(14);

    // A legal pair nobody specialises in says so rather than going blank —
    // and the way out is inside the message.
    chip("OLD WORLD");
    expect(container.querySelector("[data-ladder-empty]")).not.toBeNull();
    expect(boardSize()).toBe(0);
    expect(text()).toContain("NO PLAYER SPECIALISES IN OLD WORLD");

    clearSelection();
    expect(container.querySelector("[data-ladder-empty]")).toBeNull();
    expect(boardSize()).toBe(14);
  });

  test("the pin answers 'where am I' in the units of the live column", () => {
    mount("/ranks");
    // Off the podium, so the bar is there — and your row stays in the table.
    expect(container.querySelector("[data-you-pin]")).not.toBeNull();
    expect(container.querySelectorAll("[data-you]")).toHaveLength(1);
    // COPY HEAT counts copiers, so the gap is quoted in copiers.
    expect(nudge()).toContain("TO OVERTAKE");
    expect(nudge()).toContain("COPIERS");

    pickFilter("WIN RATE");
    expect(container.querySelector("[data-you-pin]")).not.toBeNull();
    expect(container.querySelectorAll("[data-you]")).toHaveLength(1);
    // WIN RATE is a percentage, and the nudge is in percentage points.
    expect(nudge()).toMatch(/\d+\.\d% TO OVERTAKE /);
  });

  test("a row opens a drawer, and a re-rank closes it", () => {
    mount("/ranks");
    expect(drawers()).toHaveLength(0);

    const row = rankRows()[0]!;
    const id = row.dataset.rankRow ?? "";
    act(() => row.click());

    const open = container.querySelector<HTMLElement>(`[data-ladder-drawer="${id}"]`);
    expect(open).not.toBeNull();
    expect(drawers()).toHaveLength(1); // one at a time
    expect(open?.textContent).toContain("SECTOR SHARE");
    expect(open?.textContent).toContain("MODE SHARE");
    // The fee the whole page is about, priced per transaction.
    expect(open?.textContent).toContain("3.5%");

    // After a re-rank that row may not even be on the board, so the drawer
    // goes with the ranking that opened it.
    pickFilter("EARNINGS");
    expect(drawers()).toHaveLength(0);
  });

  test("the same ladder is the same ladder on every mount", () => {
    mount("/ranks");
    const ids = rowIds();
    const plinths = podium().map((p) => p.dataset.podium);
    expect(ids).toHaveLength(11);

    remount("/ranks");
    expect(rowIds()).toEqual(ids);
    expect(podium().map((p) => p.dataset.podium)).toEqual(plinths);
  });

  test("the result links straight to the board it just moved you on", () => {
    mount("/match/kz-semis/result?seed=424242");
    throughRank();
    click("View the full ladder →");

    expect(window.location.pathname).toBe("/ranks");
    expect(text()).toContain("The ladder");
    expect(container.querySelectorAll("[data-rank-row]")).toHaveLength(11);
    expect(container.querySelectorAll("[data-you]")).toHaveLength(1);
  });
});

/**
 * Hybrid anchoring (plan5 §P4): live spot ANNOTATES the seeded board.
 *
 * Every assertion here is one of two shapes — "the live number appeared beside
 * the seeded one", or "with no live number the screen is precisely the screen it
 * always was". There is deliberately no test asserting that a live number
 * replaced a seeded one, because that must never happen: the tape the duel
 * settles on is `universe.ts`, and `test/determinism.test.ts` pins four of its
 * prices absolutely.
 */
describe("hybrid anchoring — live spot beside the seeded tape", () => {
  const testid = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const legPicker = (sym: string) =>
    container.querySelector<HTMLElement>(`[data-leg-picker="${sym}"]`);

  /** Six priced assets — the shape a real `/api/market` snapshot arrives in. */
  const LIVE_SPOT: Record<string, number> = {
    ETH: 2522.13,
    BTC: 81004.04,
    SOL: 104.0853111,
    XRP: 1.4517,
    BNB: 718.17701211,
    AVAX: 7.498,
  };

  const prow = (type: PricingRow["type"], strike: string, delta: string): PricingRow => ({
    type,
    strike,
    expiry: "27 SEP",
    bid: "0.1",
    ask: "0.11",
    iv: "55.0%",
    delta,
    depth: 50,
    size: "1.0k",
  });

  /** Live ETH levels, on the LIVE scale — 2,400s, not 4,000s. */
  const ETH_ROWS = [
    prow("CALL", "2,400", "0.62"),
    prow("CALL", "2,600", "0.38"),
    prow("CALL", "2,800", "0.21"),
    prow("PUT", "2,400", "-0.31"),
  ];

  function live(
    spot: Record<string, number> = LIVE_SPOT,
    pricing: Record<string, PricingRow[]> = { ETH: ETH_ROWS },
  ): MarketSource {
    return {
      id: "thetanuts · base 8453",
      meta: { ok: true, source: "live", fetchedAt: 1_788_500_000_000 },
      underlyings: () => Object.keys(pricing),
      pricing: (u) => pricing[u] ?? [],
      mmPricing: () => [],
      orders: () => [],
      spot: (u) => {
        const px = spot[u];
        return typeof px === "number" && Number.isFinite(px) ? px : null;
      },
    };
  }

  // ── the pick screen ───────────────────────────────────────────────────────

  test("a ticker header carries both numbers, named, and the chip says which is which", () => {
    // `mi-majors` deals ETH and BTC on this seed — both priced, both books.
    mount("/match/mi-majors/parlay?seed=1", undefined, live());

    expect(testid("spot-chip")?.textContent).toBe("LIVE SPOT · SEEDED TAPE");
    expect(testid("spot-ETH")?.textContent).toContain("$4,182.60 seeded · $2,522.13 live");
    expect(testid("spot-BTC")?.textContent).toContain("$96,410.00 seeded · $81,004.04 live");
    // The seeded target is still the seeded target — the annotation is additive.
    expect(testid("spot-ETH")?.textContent).toContain("base ±5.0%");
  });

  test("a name with no live print renders the line it has always rendered", () => {
    // `dr-mixed` deals AMD, SOL, NVDA and ETH: two equities Thetanuts has never
    // heard of, beside two assets it prices.
    mount("/match/dr-mixed/parlay?seed=424242", undefined, live());

    expect(testid("spot-ETH")).not.toBeNull();
    expect(testid("spot-SOL")).not.toBeNull();
    expect(testid("spot-NVDA")).toBeNull();
    expect(testid("spot-AMD")).toBeNull();
    // No dash, no placeholder, no "—": the old line, unchanged.
    expect(legPicker("NVDA")?.textContent).toContain("$118.40 · base ±4.0%");
    expect(legPicker("NVDA")?.textContent).not.toContain("live");
    expect(legPicker("NVDA")?.textContent).not.toContain("seeded");
  });

  test("with nothing priced on the board the pick screen is byte-identical", () => {
    // `kz-semis` is three equities. A live source that prices none of them must
    // produce exactly the DOM the seeded source does — same markup, same order.
    mount("/match/kz-semis/parlay?seed=424242", undefined, live());
    const syms = slipLegs() as string[];
    const withLive = syms.map((s) => legPicker(s!)!.innerHTML);
    expect(testid("spot-chip")).toBeNull();

    act(() => root.unmount());
    container.remove();
    mount("/match/kz-semis/parlay?seed=424242");
    expect(syms.map((s) => legPicker(s!)!.innerHTML)).toEqual(withLive);
  });

  // ── the second opinion ────────────────────────────────────────────────────

  test("the book's delta sits beside the tier's percentage without touching it", () => {
    mount("/match/mi-majors/parlay?seed=1", undefined, live());

    // ETH SHARP bull asks for +9%: 4,559.03 seeded, and the same +9% of the
    // live 2,522.13 is 2,749.12 — nearest live call is the 2,800 at Δ0.21.
    const card = container.querySelector<HTMLElement>('[data-parlay="ETH:sharp-bull"]')!;
    expect(card.textContent).toContain("~25%");
    expect(card.textContent).toContain("book Δ 0.21 (second opinion)");
    // The tier's own multiplier is untouched — the advisory is a sibling line,
    // not an input.
    expect(card.textContent).toContain("×3.6");
  });

  test("no book, no advisory — spot alone is not enough", () => {
    // BTC is priced here and has no pricing rows: annotated, unadvised.
    mount("/match/mi-majors/parlay?seed=1", undefined, live());
    expect(testid("spot-BTC")).not.toBeNull();
    expect(testid("book-delta-BTC:sharp-bull")).toBeNull();
  });

  test("an unscoreable book degrades to silence, and the spot line survives it", () => {
    // Every row quoted, no greeks — `rawApiData.greeks` is undocumented and
    // sometimes simply absent.
    mount("/match/mi-majors/parlay?seed=1", undefined, live(LIVE_SPOT, { ETH: [prow("CALL", "2,800", "—")] }));
    expect(testid("spot-ETH")).not.toBeNull();
    expect(testid("spot-chip")).not.toBeNull();
    expect(container.querySelector("[data-testid^='book-delta-']")).toBeNull();
  });

  test("the seeded book carries deltas and still shows no advisory", () => {
    // The mock's ETH chain has a full delta column. It has no spot, and that is
    // the whole gate — a seeded delta must never read as the book's opinion.
    mount("/match/mi-majors/parlay?seed=1");
    expect(container.querySelector("[data-testid^='book-delta-']")).toBeNull();
    expect(testid("spot-chip")).toBeNull();
  });

  test("the pinned slip prices the same with the book live as without it", () => {
    const price = (source?: MarketSource) => {
      mount("/match/kz-semis/parlay?seed=424242", undefined, source);
      const syms = slipLegs() as string[];
      const cards = Array.from(container.querySelectorAll<HTMLButtonElement>("[data-parlay]"));
      const pick = (sym: string, id: string) =>
        act(() => cards.find((c) => c.dataset.parlay === `${sym}:${id}`)!.click());
      pick(syms[0]!, "sharp-bear");
      pick(syms[1]!, "safe-bull");
      pick(syms[2]!, "degen-bull");
      const out = testid("combined-mult")?.textContent;
      act(() => root.unmount());
      container.remove();
      return out;
    };
    // `×47.52` is the fixture the whole odds engine is pinned on.
    expect(price()).toBe("×47.52");
    expect(price(live())).toBe("×47.52");
    // Remounted so `afterEach` has something to tear down.
    mount("/");
  });

  // ── the reel ──────────────────────────────────────────────────────────────

  test("the reel annotates the pointer and its tiles, and says nothing about the rest", () => {
    mount("/match/mi-majors?seed=1", undefined, live());
    const d = dialog()!;

    expect(d.querySelector('[data-testid="spot-chip"]')?.textContent).toBe("LIVE SPOT · SEEDED TAPE");
    // BTC is under the pointer on the first frame: the seeded headline keeps its
    // wobble above, and the pair is stated underneath.
    expect(testid("pointer-spot")?.textContent).toBe("$96,410.00 seeded · $81,004.04 live");
    // The 124px tiles take the right half only — the accent price above them is
    // the seeded one and the chip has said so.
    expect(d.textContent).toContain("$2,522.13 live");
    expect(d.textContent).toContain("$104.09 live");
  });

  test("an unpriced reel is the reel that always shipped", () => {
    // `kz-semis` again: three equities, no live prints anywhere on the strip.
    mount("/match/kz-semis?seed=424242", undefined, live());
    const d = dialog()!;
    expect(d.querySelector('[data-testid="spot-chip"]')).toBeNull();
    expect(testid("pointer-spot")).toBeNull();
    expect(d.textContent).not.toContain("live");
    expect(d.textContent).not.toContain("seeded");
  });
});
