import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { LOBBIES, bookFor, bookOf } from "../src/data/lobbies.ts";
import { mockMarketSource, type MarketSource } from "../src/data/market.ts";
import type { NewsSource, WireItem } from "../src/data/news.ts";
import { MODES, MODE_SALT } from "../src/data/modes.ts";
import type { Grade, QualifiedAsset } from "../src/data/qualify.ts";
import { GRADE_BLURB, SECTOR_ORDER, bookForSectors } from "../src/data/sectors.ts";
import { CreateLobby } from "../src/views/CreateLobby.tsx";
import { MULT_MIN, multiplierFor, type OptionBook } from "../src/desk/optionize.ts";
import { edgeOf, scoreOf, settle } from "../src/engine/match.ts";
import {
  PARLAY_CARDS,
  PRICE_DECIMALS,
  REFERENCE_MOVE,
  buildLeg,
  multipleAt,
  tierOdds,
  tierProb,
  vanillaPayout,
  type LiveCard,
} from "../src/engine/parlay.ts";
import { xpForMatch } from "../src/engine/rank.ts";
import { spinCase } from "../src/engine/spin.ts";
import { LOCK_MS } from "../src/components/MatchSpin.tsx";
import { OPP_READY_MS, TAPE_STEP, useMatch, type LobbyForm } from "../src/state/match.ts";
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

    click("Live arena");
    // One mode, and it is the box arena. `FIND A DIFFERENCE` and `PARLAY` were
    // the two entries here until plan 7 §8 step 6 retired both screens; the
    // hub's own docblock and `MODES` are the assertion's other half.
    expect(text()).toContain("DRAW A BOX");
    expect(text()).not.toContain("FIND A DIFFERENCE");
    expect(text()).toContain("ACTIVE DUELS");
    expect(window.location.pathname).toBe("/arena");

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
    expect(text()).toContain("Majors sprint");
    expect(text()).toContain("6 open · 6 shown");
    const kz = lobbyCards().find((c) => c.dataset.lobby === "kz-semis")!;
    expect(kz.textContent).toContain("CRYPTO");
    expect(kz.textContent).toContain("3 LEGS");
    expect(kz.textContent).toContain("4.80 Ξ");
    expect(kz.textContent).toContain("Accept match · 2.40 Ξ");
  });

  // The card's background art is `CardArt` again — the generative dot/line
  // patterns, seeded by the lobby id. A wave of this board replaced them with a
  // chrome candlestick ornament; the owner asked for the background back and
  // for the chrome to move onto the label chips, so `ChromeCandles.tsx` is gone
  // and these assertions describe the patterns that are actually drawn.
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
      const css = Array.from(a.querySelectorAll<SVGElement>("path")).filter((p) =>
        (p.getAttribute("style") ?? "").includes("vcFlow"),
      ).length;
      expect(smil + css).toBeGreaterThan(0);
      expect(a.dataset.pattern).toBeTruthy();
      // Decoration only.
      expect(a.getAttribute("aria-hidden")).not.toBeNull();
      expect(a.style.pointerEvents).toBe("none");
    }
    // Same lobby, same picture — the art is a function of the id.
    const kz = () => container.querySelector('[data-art="kz-semis"] svg')?.innerHTML;
    const before = kz();
    remount("/battles");
    expect(kz()).toBe(before);
    // No tilt on the cards; the picture moves, the card does not.
    expect(container.querySelector("[data-tilt]")).toBeNull();
  });

  // The chrome material lives on the LABELS now: each chip is a near-black
  // badge whose shape is a gradient rim and whose only bright thing is one
  // narrow ice specular sliding along it. What these guard is that the shine is
  // decoration — inert, out of the a11y tree, never sharing a gradient with the
  // chip beside it — and that the label survives it.
  test("every lobby chip is a chrome badge with its own gradient and its label intact", () => {
    mount("/battles");
    const chips = Array.from(
      container.querySelectorAll<HTMLElement>('[data-lobby="kz-semis"] [data-chip]'),
    );
    // Mode, legs, market and at least one sector.
    expect(chips.length).toBeGreaterThanOrEqual(4);

    const ids: string[] = [];
    for (const chip of chips) {
      const shine = chip.querySelector<HTMLElement>("[aria-hidden]")!;
      expect(shine).not.toBeNull();
      expect(shine.style.pointerEvents).toBe("none");
      // One travelling specular per chip, and it is drawn rather than declared.
      expect(chip.querySelectorAll("animateTransform")).toHaveLength(1);
      // The label is the point: the shine must never be the only thing in here.
      expect(chip.textContent!.trim().length).toBeGreaterThan(0);
      ids.push(...Array.from(chip.querySelectorAll<SVGElement>("defs [id]")).map((n) => n.id));
    }
    // Exactly one gradient each, and no two chips pointing at the same one.
    expect(ids).toHaveLength(chips.length);
    expect(new Set(ids).size).toBe(ids.length);

    // The card still reads as it read.
    const kz = lobbyCards().find((c) => c.dataset.lobby === "kz-semis")!;
    expect(kz.textContent).toContain("CRYPTO");
    expect(kz.textContent).toContain("3 LEGS");
    expect(kz.textContent).toContain("Majors sprint");

    // Same lobby, same markup — ids come from the lobby id, not from `useId()`,
    // whose counter is module-global and climbs across roots.
    const before = chips[0]!.outerHTML;
    remount("/battles");
    expect(
      container.querySelector<HTMLElement>('[data-lobby="kz-semis"] [data-chip]')!.outerHTML,
    ).toBe(before);
  });

  test("under reduced motion a chip ships one parked lit frame", () => {
    const real = globalThis.matchMedia;
    try {
      globalThis.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof real;
      mount("/battles");
      const chips = Array.from(container.querySelectorAll<HTMLElement>("[data-chip]"));
      expect(chips.length).toBeGreaterThanOrEqual(24);
      for (const chip of chips) {
        // Nothing to still: the clock was never rendered. (CSS cannot stop
        // SMIL, so the stylesheet's reduced-motion block is no help here.)
        expect(chip.querySelectorAll("animate, animateTransform")).toHaveLength(0);
        // …and the smear is parked ON the chip, so the still frame is the lit
        // one rather than an empty badge.
        const parked = chip.querySelector<SVGElement>("svg > g")!;
        expect(parked.getAttribute("transform")).toBe("translate(65 0)");
      }
    } finally {
      globalThis.matchMedia = real;
    }
  });

  test("each card carries three lines of match details it reveals on hover", () => {
    mount("/battles");
    const details = container.querySelector<HTMLElement>('[data-details="kz-semis"]')!;
    expect(details.children).toHaveLength(3);
    expect(details.textContent).toContain("kazuo.eth · CRYPTO · 3 legs");
    expect(details.textContent).toContain("4.80 Ξ pool · 2.40 Ξ each");
    expect(details.textContent).toContain("most legs wins");
    // Hidden until hover; the stylesheet's :hover rule reveals it.
    expect(details.className).toContain("vc-lobby-details");
  });

  test("the book filter narrows the board", () => {
    mount("/battles");
    click("CRYPTO");
    // Every lobby is crypto now: plan 6 §B3 retired the equity board, so the
    // CRYPTO filter and ALL are the same set.
    expect(lobbyCards()).toHaveLength(6);
    expect(text()).toContain("6 shown");

    // FOLLOW-UP, and the reason it is a follow-up: `src/views/Battles.tsx`
    // hardcodes a STOCKS / CRYPTO / MIXED filter row and was outside this
    // change's file grant. Two of its three chips can now only ever show an
    // empty board. The fix is to derive the row from the markets the lobbies
    // actually carry; until then this asserts the honest current behaviour
    // rather than pretending the chip is gone.
    click("STOCKS");
    expect(lobbyCards()).toHaveLength(0);
    expect(text()).toContain("0 shown");

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
    // No market-preset row to press any more — the builder opens on the whole
    // live book, which is the only book there is.
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

  test("the builder offers the live book and nothing else", () => {
    // The owner's complaint, at the screen they made it about: "the create
    // lobby section [has] a lot of old irrelevant stuff". SEMIS, BIG TECH, OLD
    // WORLD and their nine equities are gone, and so are the ALL STOCKS /
    // FULL BOARD presets that only made sense over them.
    mount("/create");
    const offered = Array.from(
      container.querySelectorAll<HTMLElement>("[data-sector]"),
    ).map((el) => el.dataset.sector);
    expect(offered).toEqual([...SECTOR_ORDER]);
    expect(offered).toEqual(["MAJORS", "MEME"]);

    const screen = text();
    for (const gone of ["NVDA", "TSLA", "AAPL", "AMD", "META", "GLD", "COIN", "PEPE", "AAVE"]) {
      expect(screen).not.toContain(gone);
    }
    for (const gone of ["SEMIS", "BIG TECH", "OLD WORLD", "ALL STOCKS", "FULL BOARD"]) {
      expect(screen).not.toContain(gone);
    }
  });

  test("composing MEME on its own narrows the book and publishes it", () => {
    // The book is whatever the group gathers out of the live board — read it
    // off the data rather than pinning a number by hand.
    const book = bookForSectors(["MEME"]);

    mount("/create");
    // Opens on the whole board; drop MAJORS and MEME stands alone.
    expect(sectorChip("MAJORS").getAttribute("aria-pressed")).toBe("true");
    clickSector("MAJORS");

    expect(marketTag()).toBe("CRYPTO");
    expect(sectorChip("MEME").getAttribute("aria-pressed")).toBe("true");
    expect(sectorChip("MAJORS").getAttribute("aria-pressed")).toBe("false");
    expect(bookLine()).toContain(`book: ${book.length} names`);
    for (const sym of book) expect(bookLine()).toContain(sym);

    // One name cannot fill the default three legs, so widen it back out and
    // publish the composition.
    clickSector("MAJORS");
    act(() => publish().click());

    expect(text()).toContain("Open battles");
    const mine = lobbyCards()[0]!;
    expect(mine.dataset.lobby).toBe("mine-1");
    expect(mine.textContent).toContain("CRYPTO"); // the derived market
    expect(mine.textContent).toContain("MAJORS");
    expect(mine.textContent).toContain("MEME");
  });

  test("the room counts the lobby's own sector book", () => {
    mount("/battles");
    acceptLobby(); // kz-semis: MAJORS
    expect(text()).toContain(`The book is ${bookForSectors(["MAJORS"]).length} names`);
  });

  test("a book too small for the legs gates Publish until a sector is added", () => {
    mount("/create");
    click("+"); // legs 3 → 4, while the whole board is still selected
    expect(text()).toContain("2 to 4");
    expect(publish().disabled).toBe(false);

    // Dropping groups never re-clamps the legs, so the selection can undershoot.
    clickSector("MAJORS");
    expect(bookLine()).toContain(`book: ${bookForSectors(["MEME"]).length} names`);
    expect(publish().disabled).toBe(true);
    expect(gateNote()).toContain("4 legs");

    clickSector("MAJORS"); // back over the line
    expect(publish().disabled).toBe(false);
    expect(container.querySelector("[data-gate]")).toBeNull();
  });

  test("cards wear their book, spelled out — there is no collapsed preset chip", () => {
    mount("/battles");
    // Resting face only — the hover pane below carries the full book, so the
    // chip assertions have to look at the body or they prove nothing.
    const face = (id: string) =>
      lobbyCards().find((c) => c.dataset.lobby === id)!.querySelector(".vc-lobby-body")!.textContent ?? "";

    expect(face("kz-semis")).toContain("MAJORS");
    expect(face("kz-semis")).not.toContain("ALL STOCKS");
    expect(face("kz-semis")).not.toContain("FULL BOARD");

    expect(face("lx-degen")).toContain("MAJORS");
    expect(face("lx-degen")).toContain("MEME");
    expect(face("lx-degen")).not.toContain("ALL CRYPTO");

    // Hover still spells the whole book out, still in three lines.
    const details = container.querySelector<HTMLElement>('[data-details="lx-degen"]')!;
    expect(details.children).toHaveLength(3);
    expect(details.children[0]!.textContent).toContain("MAJORS + MEME");
  });

  test("the sector book feeds the reel: kz-semis at 424242 deals SOL · XRP · BNB", () => {
    // RE-PINNED at plan 6 §B3 — this read TSLA · AMD · META off a nine-equity
    // book that Thetanuts could never fill. `spinCase` indexes into the book,
    // so retiring the board necessarily re-deals the seed; what the lock still
    // guarantees is that the reel and the lobby agree on the same list in the
    // same order.
    const dealt = spinCase(bookForSectors(["MAJORS"]), 3, 424242).syms;
    expect(dealt).toEqual(["SOL", "XRP", "BNB"]);
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
    const arena = spinCase(bookForSectors(["MAJORS", "MEME"]), 3, 424242).syms;
    const salt = 2 + 424242 * 3 + MODE_SALT.BLITZ;
    const scale = MODES.BLITZ.targetScale;
    const mine = arena.map((s) => buildLeg(s, "over", "EVEN", scale));
    const theirs = arena.map((s) => buildLeg(s, "under", "EVEN", scale));

    // Only the settle print moves. Fifteen minutes of tape is not a prefix of
    // the day's read: the same slip, read at 56 ticks and at 10,800, has moved
    // a different distance and the tape has turned over in between.
    //
    // This used to pin `scoreOf(theirs, BLITZ) === 0` against `=== 1` on the
    // day's read, off an arena of DEFI+MEME fiction (ARB/LINK/UNI/AAVE/PEPE).
    // Retiring that board re-dealt the arena to ETH/BNB/SOL, where both windows
    // happen to land one leg each and the difference shows up in conviction
    // instead. The claim the test exists for is unchanged and still asserted
    // below; only the arithmetic it lands on moved.
    const shortEdge = edgeOf(mine, salt, MODES.BLITZ.settleAt);
    const dayEdge = edgeOf(mine, salt, MODES.NORMAL.settleAt);
    expect(shortEdge).not.toBe(dayEdge);
    expect(shortEdge).toBeLessThan(dayEdge);
    expect(scoreOf(theirs, salt, MODES.BLITZ.settleAt)).toBeGreaterThanOrEqual(0);

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
    // Plan 6 retired the invented odds table: a tier is now a |delta| band and a
    // multiplier is 1/prob, so this slip reads (1/.35)(1/.75)(1/.15) = 25.40 where
    // the fiction read 47.52. The seeded LINES are untouched — `TIER_MOVE` still
    // places them — so the replay locks still hold; only the odds moved.
    expect(testid("combined-mult")?.textContent).toBe("×25.40");
  });
});

describe("the room", () => {
  test("pressing a card puts you in the lobby with the other player, not straight into the spin", () => {
    mount("/battles");
    acceptLobby();
    expect(dialog()).toBeNull();
    expect(window.location.pathname).toBe("/match/kz-semis/room");
    expect(text()).toContain("Majors sprint");
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
    expect(dialog()?.getAttribute("aria-label")).toBe("Majors sprint spin");
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

    expect(dialog()?.getAttribute("aria-label")).toBe("Majors sprint spin");
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
    // There is no equity with a Base price feed, so this book is empty — the
    // reel could not deal one if it tried.
    expect(bookFor("STOCK")).toEqual([]);
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

  // ── the slice reveal (plan6 §9 item 19, second half) ──────────────────────

  const testid = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  /**
   * A source that can actually be measured: a qualified asset, and a book with
   * fillable orders behind it. Everything `spinSlice` reads arrives through
   * this object — the engine asks a market nothing.
   */
  function gatedSource(): MarketSource {
    const EXPIRY = 1_788_595_200;
    const srow = (type: "CALL" | "PUT", strike: number, delta: string): PricingRow => ({
      type,
      strike: strike.toLocaleString("en-US"),
      expiry: "12 SEP",
      bid: "0.09",
      ask: "0.11",
      iv: "58.2%",
      delta,
      depth: 40,
      size: "10.0k",
      structure: type,
      order: {
        order: { price: "1", isBuyer: false, expiry: String(EXPIRY) },
        rawApiData: { strikes: [String(strike * 10 ** 8)], isCall: type === "CALL" },
      },
    });
    const rows = [
      srow("CALL", 1900, "0.70"),
      srow("CALL", 2000, "0.55"),
      srow("CALL", 2100, "0.30"),
      srow("CALL", 2200, "0.18"),
      srow("PUT", 1850, "-0.20"),
    ];
    return {
      id: "thetanuts · base 8453",
      meta: { ok: true, source: "live", fetchedAt: 1_788_500_000_000 },
      underlyings: () => ["ETH"],
      pricing: (u) => (u === "ETH" ? rows : []),
      mmPricing: () => [],
      orders: () => [],
      spot: (u) => (u === "ETH" ? 2000 : null),
      // The asset gate's answer, as a source carries it. ETH has MM pricing on
      // Base, which is what grades it DEEP — a difficulty label, never a gate.
      qualified: () => [
        { underlying: "ETH", grade: "DEEP", spot: 2000, orders: 9, greeked: 6, depthUsd: 1_180_000 },
      ],
    };
  }

  test("the locked board reveals the arena the seed dealt, graded", async () => {
    mount("/battles", undefined, gatedSource());
    acceptLobby();
    await readyBoth();

    // While the reel is still moving the arena is a spoiler, not news.
    expect(testid("slice-reveal")).toBeNull();

    click("Skip ↦");

    const reveal = testid("slice-reveal")!;
    expect(reveal).not.toBeNull();
    // The one qualified name is the only one the reel could deal an arena on.
    expect(reveal.textContent).toContain("ETH");
    // The DEEP/THIN badge, from `ui/LobbyCards.tsx`'s own `GradeTag` — the same
    // chip the lobby card wears, so the word is learned once.
    expect(reveal.textContent).toContain("ETH DEEP");
    // An expiry and a strike WINDOW — never a single line, which would be a
    // strike chosen for the player.
    expect(reveal.textContent).toContain("exp ");
    const window_ = testid("slice-window")!.textContent ?? "";
    expect(window_).toMatch(/^\$[\d,.]+ – \$[\d,.]+$/);
    const [lo, hi] = window_.split(" – ").map((s) => Number(s.replace(/[$,]/g, "")));
    expect(hi!).toBeGreaterThan(lo!);
  });

  test("no qualified book, no reveal — and the reel still locks", async () => {
    // The seeded source measures nothing (`qualified: () => []`), so there is no
    // arena to state. Saying nothing is the correct render; an invented arena
    // would be the house dealing a market that is not there.
    mount("/battles");
    await acceptAndSkip();
    expect(text()).toContain("locked");
    expect(testid("slice-reveal")).toBeNull();
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
   *  same way the app derives it: kz-semis is a 3-leg MAJORS lobby. */
  const dealt = spinCase(bookForSectors(["MAJORS"]), 3, 424242).syms;

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
    expect(text()).toContain("Build your parlay · Majors sprint");
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
      // SAFE sits in the [0.65, 0.85) delta band, so 1/0.75 = ×1.33.
      expect(sec.textContent).toContain("×1.33");
      // DEGEN is the [0.05, 0.25) band; 1/0.15 = ×6.67.
      expect(sec.textContent).toContain("×6.67");
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
    // Plan 6 retired the invented odds table: a tier is now a |delta| band and a
    // multiplier is 1/prob, so this slip reads (1/.35)(1/.75)(1/.15) = 25.40 where
    // the fiction read 47.52. The seeded LINES are untouched — `TIER_MOVE` still
    // places them — so the replay locks still hold; only the odds moved.
    expect(mult()).toBe("×25.40");
    expect(prob()).toBe("3.9%"); // .35 × .75 × .15, the band midpoints
    expect(text()).toContain("SHARP↓ SAFE↑ DEGEN↑");
    expect(text()).toContain("closes below");
    expect(text()).toContain("closes above");

    pick(syms[2]!, "even-bull"); // swaps the DEGEN leg for an EVEN one
    // (1/.35)(1/.75)(1/.55) = 6.93, and .35 × .75 × .55 = 14%. Swapping the
    // long shot out lifts the slip back over the 10% loud line — the threshold
    // itself is asserted in test/parlay.test.ts, on `summarize`.
    expect(mult()).toBe("×6.93");
    expect(prob()).toBe("14%");
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
    expect(text()).toContain("Live duel · Majors sprint");
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

    // The ladder's sector chips are the live groups now — SEMIS and BIG TECH
    // were filters over a board that no longer exists (plan 6 §B3).
    chip("MAJORS");
    expect(metricHead()).toBe("WINS · MAJORS · ALL MODES");
    const majors = boardSize();
    expect(majors).toBeGreaterThan(0);
    expect(majors).toBeLessThan(14);

    // OR within the group: a second sector can only widen the pool.
    chip("MEME");
    expect(metricHead()).toBe("WINS · MAJORS+MEME · ALL MODES");
    const both = boardSize();
    expect(both).toBeGreaterThan(majors);
    expect(both).toBeLessThanOrEqual(14);

    // AND across groups: a mode on top can only narrow it.
    chip("BLITZ");
    expect(metricHead()).toBe("WINS · MAJORS+MEME · BLITZ");
    expect(boardSize()).toBeLessThan(both);
    expect(boardSize()).toBeGreaterThan(0);

    clearSelection();
    expect(metricHead()).toBe("WINS · ALL SECTORS · ALL MODES");
    expect(boardSize()).toBe(14);

    // A legal pair nobody specialises in says so rather than going blank —
    // and the way out is inside the message. (Was OLD WORLD; the equity groups
    // are retired, and MEME × QUICK is the empty cell on the live taxonomy.)
    chip("MEME");
    chip("QUICK");
    expect(container.querySelector("[data-ladder-empty]")).not.toBeNull();
    expect(boardSize()).toBe(0);
    expect(text()).toContain("NO PLAYER SPECIALISES IN MEME");

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
    // `dr-mixed` deals ETH, BNB, SOL and BTC on this seed. The unpriced case
    // used to be free — the lobby dealt NVDA and AMD, which no exchange on
    // earth was going to quote. Now that every dealt name is one Thetanuts has
    // a feed for, the gap has to come from the SNAPSHOT: a live route that
    // answered for ETH and SOL and not for BNB is the ordinary case this
    // behaviour exists for, and it is the honest way to reach it.
    const partial = { ETH: 2522.13, SOL: 104.0853111 };
    mount("/match/dr-mixed/parlay?seed=424242", undefined, live(partial));

    expect(slipLegs()).toEqual(["ETH", "BNB", "SOL", "BTC"]);
    expect(testid("spot-ETH")).not.toBeNull();
    expect(testid("spot-SOL")).not.toBeNull();
    expect(testid("spot-BNB")).toBeNull();
    expect(testid("spot-BTC")).toBeNull();
    // No dash, no placeholder, no "—": the old line, unchanged. BNB's seeded
    // reference is 718.18 at ±5.0%, from this repo's own frozen capture.
    expect(legPicker("BNB")?.textContent).toContain("$718.18 · base ±5.0%");
    // Scoped to the seeded·live SPOT pair rather than the bare words: the card
    // face legitimately says "no live premium" about a different quantity, and a
    // substring check would read that as a spot annotation.
    expect(legPicker("BNB")?.textContent).not.toContain("seeded ·");
    expect(legPicker("BNB")?.textContent).not.toMatch(/·\s*\$[\d,.]+\s*live/);
  });

  test("with nothing priced on the board the pick screen is byte-identical", () => {
    // A live source that prices none of the dealt names must produce exactly
    // the DOM the seeded source does — same markup, same order.
    mount("/match/kz-semis/parlay?seed=424242", undefined, live({}));
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
    // SHARP is the [0.25, 0.45) band; its midpoint reads 35%. Plan 6 §E3/§E4.1
    // pins the delta face as the phrase `35% chance` — one quantity, one term —
    // so the tilde form the tier table used is gone from the card.
    expect(card.textContent).toContain("35% chance");
    expect(card.textContent).toContain("book Δ 0.21 (second opinion)");
    // The tier's own multiplier is untouched — the advisory is a sibling line,
    // not an input.
    // SHARP's band midpoint: 1/0.35 = ×2.86.
    expect(card.textContent).toContain("×2.86");
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
    // The pinned slip: the band model prices it identically with the book live
    // and without it, which is the property this test exists for.
    expect(price()).toBe("×25.40");
    expect(price(live())).toBe("×25.40");
    // Remounted so `afterEach` has something to tear down.
    mount("/");
  });

  // ── the reel ──────────────────────────────────────────────────────────────

  test("the reel annotates the pointer and its tiles, and says nothing about the rest", () => {
    mount("/match/mi-majors?seed=1", undefined, live());
    const d = dialog()!;

    expect(d.querySelector('[data-testid="spot-chip"]')?.textContent).toBe("LIVE SPOT · SEEDED TAPE");
    // ETH is under the pointer on the first frame: the seeded headline keeps its
    // wobble above, and the pair is stated underneath. (Was BTC — the strip is
    // the six-name MAJORS book now rather than the three-name seeded L1 group,
    // so the pointer lands a tile earlier.)
    expect(testid("pointer-spot")?.textContent).toBe("$4,182.60 seeded · $2,522.13 live");
    // The 124px tiles take the right half only — the accent price above them is
    // the seeded one and the chip has said so.
    expect(d.textContent).toContain("$81,004.04 live");
    expect(d.textContent).toContain("$104.09 live");
  });

  test("an unpriced reel is the reel that always shipped", () => {
    // A snapshot that priced nothing — `/api/market` up and empty. No live
    // print anywhere on the strip, so the reel is the one that always shipped.
    mount("/match/kz-semis?seed=424242", undefined, live({}));
    const d = dialog()!;
    expect(d.querySelector('[data-testid="spot-chip"]')).toBeNull();
    expect(testid("pointer-spot")).toBeNull();
    expect(d.textContent).not.toContain("live");
    expect(d.textContent).not.toContain("seeded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// plan6 §9 item 2, AT THE SOURCE — where a leg's multiplier comes from
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The failure this block exists to catch is precise, and it is not a rendering
 * bug: **one surface looking right while every other surface does not.**
 *
 * `useMatch` is where a leg is priced. The pick screen, the slip, the duel, the
 * result screen, `summarize`, `settle` and the escrow all read that leg — so a
 * multiplier that is only correct because one component re-read the dealt card
 * and printed *that* is correct on exactly one screen. Every assertion here
 * therefore reads `derived.myLegs` off the hook and never the DOM: the pick
 * screen is not mounted at all.
 *
 * The book is injected the way `App` injects it — a plain frozen value, one
 * argument wide. Nothing in this block reaches a network and nothing in
 * `src/state/match.ts` could.
 */
describe("a market-priced leg carries the dealt card's number — at the source", () => {
  const SPOT = 2000;
  const EXPIRY = 1_788_595_200;

  /** One fillable live row, the shape the market builder produces. */
  function liveRow(o: {
    type: "CALL" | "PUT";
    strike: number;
    delta: number;
    ask: number;
  }): PricingRow {
    return {
      type: o.type,
      strike: o.strike.toLocaleString("en-US"),
      expiry: "12 SEP",
      bid: (o.ask * 0.98).toFixed(4),
      ask: o.ask.toFixed(4),
      iv: "58.2%",
      delta: o.delta.toFixed(2),
      depth: 40,
      size: "10.0k",
      structure: o.type,
      order: {
        order: { price: "1", isBuyer: false, expiry: String(EXPIRY) },
        rawApiData: {
          strikes: [String(Math.round(o.strike * 10 ** PRICE_DECIMALS))],
          isCall: o.type === "CALL",
        },
      },
    };
  }

  /**
   * SAFE bull, SHARP bull and DEGEN bear are backed; EVEN is backed on neither
   * side. That hole is load-bearing below: a tier the book does not back must
   * keep its seeded leg rather than borrow the nearest listed delta, which is
   * what the retired `optionizeTier` path did.
   */
  const CHAIN = [
    liveRow({ type: "CALL", strike: 1900, delta: 0.7, ask: 60 }),
    liveRow({ type: "CALL", strike: 2100, delta: 0.3, ask: 20 }),
    liveRow({ type: "PUT", strike: 1850, delta: -0.2, ask: 15 }),
  ];

  const BOOK: OptionBook = {
    at: 1_788_500_000_000,
    source: "live",
    spot: { ETH: SPOT },
    chain: { ETH: CHAIN },
  };

  /** A NORMAL, three-leg MAJORS lobby, and the first seed whose spin deals ETH
   *  into its arena — searched rather than pinned, so this test does not add a
   *  second replay contract beside `test/determinism.test.ts`'s. */
  const LOBBY = LOBBIES.find((l) => l.id === "kz-semis")!;
  const SEED = (() => {
    for (let s = 1; s < 5000; s++) {
      if (spinCase(bookOf(LOBBY), LOBBY.legs, s).syms.includes("ETH")) return s;
    }
    throw new Error("no seed in 1..5000 deals ETH — the MAJORS book must have changed");
  })();

  /** The hook under test, rendered by nothing. `container`/`root` are the
   *  module's own, so the shared `afterEach` tears this down. */
  let match: ReturnType<typeof useMatch> | null = null;
  function Probe({ book }: { book?: OptionBook }) {
    match = useMatch({ tab: "parlay", lobbyId: LOBBY.id, seed: SEED }, { book });
    return null;
  }
  function mountProbe(book?: OptionBook) {
    match = null;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root.render(<Probe book={book} />);
    });
  }
  /** Pick a card for ETH and hand back the leg the hook priced. */
  function legAfterPicking(cardId: string) {
    act(() => match!.actions.pick("ETH", cardId));
    return match!.derived.myLegs.find((l) => l.sym === "ETH")!;
  }

  /** The card the fixture book deals for SHARP BULLISH, built here from the
   *  same row the hook was handed — so the expectation is the engine's answer
   *  and not a literal that could only pin today's arithmetic. */
  const SHARP_CARD: LiveCard = {
    ...PARLAY_CARDS.find((c) => c.id === "sharp-bull")!,
    underlying: "ETH",
    strike: "2,100",
    strikeAt: 2100,
    expiry: "12 SEP",
    expiryAt: EXPIRY,
    prob: 0.3,
    premium: 20,
    mult: 0,
    mark: null,
    row: CHAIN[1]!,
  };

  test("`derived.myLegs` carries `multipleAt`, not the retired clamped ratio and not the seeded odds", () => {
    mountProbe(BOOK);
    const leg = legAfterPicking("sharp-bull");

    const expected = multipleAt(SHARP_CARD, SPOT, REFERENCE_MOVE, vanillaPayout);
    // Worked by hand too: ETH 2,000 +25% settles at 2,500; a 2,100 call is worth
    // 400 there; at a premium of 20 that is ×20.
    expect(expected).toBeCloseTo(20, 8);
    expect(leg.mult).toBeCloseTo(expected, 10);

    // …and it is neither of the two numbers it used to be. `multiplierFor` reads
    // 0.25 × 2100/2000 ÷ 20 = 0.013 and clamps up to MULT_MIN — the hand-rolled
    // ratio plan 6 §9.2 retired, and what `optionize()` put on this leg until
    // now. `tierOdds("SHARP")` = 1/0.35 = ×2.86 is the seeded fallback.
    expect(multiplierFor(2100, 20, SPOT)).toBeCloseTo(MULT_MIN, 10);
    expect(leg.mult).not.toBeCloseTo(MULT_MIN, 2);
    expect(leg.mult).not.toBeCloseTo(tierOdds("SHARP"), 2);
  });

  test("the other four numbers move with it — delta, listed strike, live spot, and the tape threshold", () => {
    mountProbe(BOOK);
    const leg = legAfterPicking("sharp-bull");

    // The option's own |delta|, not the band midpoint. This is the number
    // `summarize` and `degeneracyScore` read, so it reaches every surface that
    // prints combined odds.
    expect(leg.prob).toBeCloseTo(0.3, 10);
    expect(leg.prob).not.toBeCloseTo(tierProb("SHARP"), 3);
    // A strike the venue lists, on the live scale, and the spot it was quoted
    // against.
    expect(leg.strike).toBeCloseTo(2100, 10);
    expect(leg.px).toBeCloseTo(SPOT, 10);
    // The hinge: the strike written as the percentage move `legState` already
    // understands. 2,100 over a 2,000 spot is +5%.
    expect(leg.t).toBeCloseTo(5, 10);
    // Same bet, same ticker, same direction — the seed's decisions are untouched.
    expect(leg.tier).toBe("SHARP");
    expect(leg.dir).toBe("over");
  });

  test("a tier the book does not back keeps its seeded leg — no nearest-delta substitute", () => {
    mountProbe(BOOK);
    // Nothing in CHAIN falls in EVEN's [0.45, 0.65) band on either side. The old
    // path took the nearest listed delta anyway and flagged the miss; the card
    // path does not deal that card at all, and the leg stays what the seed made.
    const leg = legAfterPicking("even-bull");
    expect(leg.mult).toBeCloseTo(tierOdds("EVEN"), 10);
    expect(leg.prob).toBeCloseTo(tierProb("EVEN"), 10);
    expect(leg.strike).toBeCloseTo(buildLeg("ETH", "over", "EVEN").strike, 10);
  });

  test("with no book every leg is the seeded leg, byte for byte", () => {
    mountProbe();
    const leg = legAfterPicking("sharp-bull");
    expect(leg).toEqual(buildLeg("ETH", "over", "SHARP"));
  });

  test("a ticker the book has never heard of stays seeded even while ETH is priced", () => {
    mountProbe(BOOK);
    act(() => match!.actions.pick("ETH", "sharp-bull"));
    for (const leg of match!.derived.myLegs) {
      if (leg.sym === "ETH") continue;
      // Unpicked tickers preview at EVEN bullish, and no chain backs them.
      expect(leg.mult).toBeCloseTo(tierOdds(leg.tier), 10);
      expect(leg.prob).toBeCloseTo(tierProb(leg.tier), 10);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The grade nobody measured
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THIN is a **verdict**: resting orders and greeks, no market-maker feed. It is
 * amber, it has a blurb about spreads and missing sides, and it is a true and
 * useful thing to tell a host. Printing it for an asset that was never measured
 * would be a measurement nobody made — the same class of claim as an invented
 * multiplier, one screen over.
 *
 * The builder's live-book row used to default every miss to THIN. It cannot miss
 * on the happy path — the chips are filtered from the same qualified list the
 * grades are built from — so the branch is reached only when the two disagree,
 * and the realistic way they disagree is a payload from `/api/market` that
 * carries an underlying with no `grade` field on it. `QualifiedAsset.grade` is
 * typed, and the wire is not.
 */
describe("the lobby builder's live book grades only what was graded", () => {
  const FORM: LobbyForm = {
    name: "T",
    sectors: ["MAJORS"],
    market: "MIXED",
    mode: "NORMAL",
    legs: 2,
    prize: 5,
    prizeText: "5.00",
  };

  const asset = (underlying: string, grade: Grade | undefined): QualifiedAsset => ({
    underlying,
    // The hole this test is about: a wire row that named no grade.
    grade: grade as Grade,
    spot: 2000,
    orders: 12,
    greeked: 12,
    depthUsd: 5000,
  });

  function mountBuilder(live: readonly QualifiedAsset[]) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    const noop = () => {};
    act(() => {
      root.render(
        <CreateLobby
          form={FORM}
          entryLabel="2.50 ETH"
          prizeLabel="5.00 ETH"
          onName={noop}
          onMarket={noop}
          onToggleSector={noop}
          onMode={noop}
          onLegsUp={noop}
          onLegsDown={noop}
          onPrizeInput={noop}
          onPrizeBlur={noop}
          onPrizeUp={noop}
          onPrizeDown={noop}
          onPublish={noop}
          onBack={noop}
          live={live}
        />,
      );
    });
  }

  test("an ungraded asset reads NOT GRADED, and its graded neighbour is unaffected", () => {
    mountBuilder([asset("ETH", undefined), asset("BTC", "DEEP")]);

    const eth = container.querySelector<HTMLElement>('[data-live-asset="ETH"]')!;
    expect(eth.dataset.grade).toBe("none");
    expect(eth.textContent).toContain("NOT GRADED");
    // The whole point: not a fabricated verdict, and not THIN's blurb either.
    expect(eth.textContent).not.toContain("THIN");
    expect(eth.title).toContain("not graded");
    expect(eth.title).not.toContain("resting orders only");

    const btc = container.querySelector<HTMLElement>('[data-live-asset="BTC"]')!;
    expect(btc.dataset.grade).toBe("DEEP");
    expect(btc.textContent).toContain("DEEP");
    expect(btc.title).toContain(GRADE_BLURB.DEEP);
  });

  test("a real THIN is still printed as THIN — the verdict survives", () => {
    // The honest render must not have deleted the grade it exists to protect.
    mountBuilder([asset("ETH", "THIN")]);
    const eth = container.querySelector<HTMLElement>('[data-live-asset="ETH"]')!;
    expect(eth.dataset.grade).toBe("THIN");
    expect(eth.textContent).toContain("THIN");
    expect(eth.textContent).not.toContain("NOT GRADED");
    expect(eth.title).toContain(GRADE_BLURB.THIN);
  });
});
