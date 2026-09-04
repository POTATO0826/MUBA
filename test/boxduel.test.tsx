/**
 * The duel — plan 7 §8 step 4, and §6/§6.1 as claims a test can fail.
 *
 * `test/boxbuilder.test.tsx` proves the solo builder. This file proves the four
 * things step 4 adds, and each one is a promise about *behaviour* that correct
 * arithmetic cannot discharge:
 *
 *  1. **A box locks on the existing transport**, encoded, and comes back the
 *     same box. The room store is the one `SpotDiff` used and is unchanged.
 *  2. **Blind means blind** (§6). Not "the screen does not render it" — the
 *     *server* does not return it. The test drives the real store and then
 *     greps the wire response for the encoded box.
 *  3. **Both boxes render on one chart at reveal** (§6), yours outlined and
 *     theirs filled, which is the moment §6 says the mode is for.
 *  4. **An unfilled side signs nothing** (§6.1). Asserted twice: against
 *     `duelOutcome`, which is where a verdict would be computed, and against
 *     the screen, which must not print a winner.
 *
 * The two seats are driven through the same component the app mounts, against
 * `RoomView`s the real `src/server/rooms.ts` produced — not hand-written wire
 * shapes, because a hand-written one would be free to be blind in a way the
 * server is not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { liveExpiries, type Box, type LadderSnapshot } from "../src/data/box.ts";
import type { RoomSeat, RoomView } from "../src/data/room.ts";
import {
  _resetRooms,
  createRoom,
  joinRoom,
  pickRoom,
  readRoom,
  readyRoom,
} from "../src/server/rooms.ts";
import {
  duelOutcome,
  type FilledLeg,
  type Usd,
  type UsdPerContract,
} from "../src/engine/score.ts";
import {
  BoxBuilder,
  NO_FILL_COPY,
  PICK_VERSION,
  REVEAL_COPY,
  decodeBoxPick,
  encodeBoxPick,
} from "../src/views/BoxBuilder.tsx";

const FIXTURE = (await Bun.file(join(import.meta.dir, "fixtures", "orders.json")).json()) as
  LadderSnapshot & { prices: Record<string, number> };

/** The same pinned instant `test/boxbuilder.test.tsx` uses — inside the frozen
 *  capture's own signature validity, so the fixture is a *live* book. */
const NOW = 1_788_500_000_000;

const HOST = "0x1111111111111111111111111111111111111111";
const GUEST = "0x2222222222222222222222222222222222222222";
const BYSTANDER = "0x3333333333333333333333333333333333333333";

const BASE = { snapshot: FIXTURE, now: NOW, tradeEnabled: false } as const;

let container: HTMLDivElement;
let root: Root | undefined;

function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(ui));
}

function unmount() {
  if (!root) return;
  act(() => root!.unmount());
  container.remove();
  root = undefined;
}

afterEach(unmount);

const text = () => container.textContent ?? "";
const all = (selector: string) => [...container.querySelectorAll(selector)];
const click = (el: Element) => act(() => (el as HTMLElement).click());
const button = (label: string) => all("button").find((b) => b.textContent === label);

// ─────────────────────────────────────────────────────────────────────────────
// The encoding
// ─────────────────────────────────────────────────────────────────────────────

describe("a box on the wire", () => {
  const box: Box = {
    underlying: "ETH",
    floor: "242000000000",
    ceiling: "248000000000",
    wing: "7000000000",
    expiry: 1_788_768_000,
  };

  test("round trips, field for field", () => {
    expect(decodeBoxPick(encodeBoxPick(box))).toEqual(box);
  });

  test("fits the store's 400-character pick, with room to spare", () => {
    // BTC is the widest ladder the fixture carries, so it is the longest an
    // encoded box can get. The store refuses anything over 400.
    const btc: Box = {
      underlying: "BTC",
      floor: "8500000000000",
      ceiling: "8850000000000",
      wing: "50000000000",
      expiry: 1_789_113_600,
    };
    expect(encodeBoxPick(btc).length).toBeLessThan(120);
    expect(encodeBoxPick(box).length).toBeLessThan(120);
  });

  test("strikes stay decimal strings — never a float round trip", () => {
    // `"242000000000"` is $2,420 in 8dp units. A JSON encode through a number
    // would be lossy at the top of the BTC ladder and silently so.
    const wire = encodeBoxPick(box);
    expect(wire.startsWith(`${PICK_VERSION}|ETH|`)).toBe(true);
    expect(wire).toContain("|242000000000|");
    expect(decodeBoxPick(wire)?.floor).toBe("242000000000");
  });

  test("anything that is not this encoding decodes to null, never to a guess", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "ETH-2400-C", // a pick from the mode this transport used to carry
      "b1|ETH|242000000000|248000000000|7000000000", // five fields
      "b2|ETH|242000000000|248000000000|7000000000|1788768000", // a future version
      "b1|ETH|24.2e10|248000000000|7000000000|1788768000", // not an integer string
      "b1||242000000000|248000000000|7000000000|1788768000", // no underlying
      "b1|ETH|242000000000|248000000000|7000000000|0", // no expiry
      "b1|ETH|242000000000|248000000000|7000000000|1788768000.5",
    ]) {
      expect(decodeBoxPick(bad)).toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Lock, blind, reveal — through the real store
// ─────────────────────────────────────────────────────────────────────────────

/** A room with both seats claimed and both ready — the state `RoomLobby`'s
 *  "Enter duel" button releases into. */
function openRoom(): string {
  const created = createRoom({
    address: HOST,
    stakeUsdc: 10,
    durationMinutes: 1,
    lobbyName: "Room #4471",
    mode: "box",
  });
  if (!created.ok) throw new Error("room refused");
  const id = created.room.id;
  if (!joinRoom(id, GUEST).ok) throw new Error("join refused");
  readyRoom(id, HOST);
  readyRoom(id, GUEST);
  return id;
}

function view(id: string): RoomView {
  const result = readRoom(id);
  if (!result.ok) throw new Error("room vanished");
  return result.room;
}

/**
 * Mount one seat, draw a box off two rungs of the live ladder, and lock it.
 *
 * Returns the string that went out. The clicks are the same ones
 * `test/boxbuilder.test.tsx` uses to draw a box, so this exercises the real
 * snapping path rather than a `Box` typed out in a test.
 */
function drawAndLock(room: RoomView, seat: RoomSeat, rungs: [number, number]): string {
  let sent: string | null = null;
  mount(<BoxBuilder {...BASE} room={room} seat={seat} onLock={(p) => (sent = p)} />);
  const ladder = all("[data-rung]");
  click(ladder[rungs[0]] as Element);
  click(ladder[rungs[1]] as Element);
  const lock = button("Lock this box");
  expect(lock).toBeDefined();
  expect((lock as HTMLButtonElement).disabled).toBe(false);
  click(lock as Element);
  unmount();
  if (sent === null) throw new Error("nothing was locked");
  return sent;
}

describe("lock, blind, reveal", () => {
  beforeEach(() => _resetRooms());

  test("a box locks, stays unreadable on the wire, and both appear together", () => {
    const id = openRoom();

    // ── The host draws 2420–2480 and locks it.
    const hostPick = drawAndLock(view(id), "host", [0, 3]);
    expect(decodeBoxPick(hostPick)?.underlying).toBe("ETH");

    const afterHost = pickRoom(id, HOST, hostPick);
    if (!afterHost.ok) throw new Error("the store refused a locked box");

    // ── §6: blind means the SERVER says nothing. Not that the screen hides it.
    expect(afterHost.room.revealed).toBe(false);
    expect(afterHost.room.picks).toEqual([null, null]);
    // The strongest form of the claim: the encoded box does not appear anywhere
    // in the bytes a client can fetch. A field added later that leaked it would
    // fail here rather than in a review.
    expect(JSON.stringify(view(id))).not.toContain(hostPick);
    expect(JSON.stringify(view(id))).not.toContain("242000000000");

    // ── And with that wire, the guest's screen has no second box to draw.
    mount(<BoxBuilder {...BASE} room={view(id)} seat="guest" onLock={() => {}} />);
    expect(container.querySelector('[data-role="opponent-box"]')).toBeNull();
    expect(text()).not.toContain(REVEAL_COPY);
    unmount();

    // ── The guest draws an overlapping 2440–2550 and locks it.
    const guestPick = drawAndLock(view(id), "guest", [1, 4]);
    const guestBox = decodeBoxPick(guestPick);
    expect(guestBox).not.toBeNull();
    expect(guestBox?.floor).not.toBe(decodeBoxPick(hostPick)?.floor);

    const afterGuest = pickRoom(id, GUEST, guestPick);
    if (!afterGuest.ok) throw new Error("the store refused the second box");
    expect(afterGuest.room.revealed).toBe(true);
    expect(afterGuest.room.picks).toEqual([hostPick, guestPick]);

    // ── §6: both boxes on ONE chart.
    mount(<BoxBuilder {...BASE} room={view(id)} seat="host" onLock={() => {}} />);
    const mine = container.querySelector('[data-role="box"]');
    const theirs = container.querySelector('[data-role="opponent-box"]');
    expect(mine).not.toBeNull();
    expect(theirs).not.toBeNull();
    // One plot, not two charts side by side.
    const plots = all('[data-role="plot"]');
    expect(plots.length).toBe(1);
    expect(plots[0]?.contains(mine as Node)).toBe(true);
    expect(plots[0]?.contains(theirs as Node)).toBe(true);

    // Yours outlined, theirs filled — the grammar §6 asks for, read off the
    // style rather than off a class name that could drift from it.
    const mineStyle = (mine as HTMLElement).getAttribute("style") ?? "";
    const theirsStyle = (theirs as HTMLElement).getAttribute("style") ?? "";
    expect(mineStyle).toContain("background: transparent");
    // An 8-digit hex — a colour with an alpha channel, i.e. an actual fill.
    expect(theirsStyle).toMatch(/background:\s*#[0-9a-f]{8}/i);
    expect(mineStyle).not.toMatch(/background:\s*#/);

    // The host's own box survived a mount with no local drawing state: it was
    // restored from the wire, which is what makes a refreshed tab show the
    // duel rather than an empty chart.
    expect(text()).toContain(REVEAL_COPY);
    expect(text()).toContain("$2,420");
  });

  test("a second lock from the same seat is refused by the store", () => {
    const id = openRoom();
    const pick = drawAndLock(view(id), "host", [0, 3]);
    expect(pickRoom(id, HOST, pick).ok).toBe(true);
    const again = pickRoom(id, HOST, pick);
    expect(again.ok).toBe(false);
    if (!again.ok) expect(again.code).toBe("ALREADY_PICKED");
  });

  test("once locked, the drawing surface stops accepting a new box", () => {
    const id = openRoom();
    mount(<BoxBuilder {...BASE} room={view(id)} seat="host" onLock={() => {}} />);
    const rungs = all("[data-rung]");
    click(rungs[0] as Element);
    click(rungs[3] as Element);
    expect(text()).toContain("$2,420 – $2,480");

    click(button("Lock this box") as Element);
    expect(text()).toContain("LOCKED · WAITING");

    // The rungs are still on screen — they are the axis — but they no longer
    // redraw the box, because the box on screen is the box on the wire.
    click(all("[data-rung]")[1] as Element);
    click(all("[data-rung]")[4] as Element);
    expect(text()).toContain("$2,420 – $2,480");
    expect(text()).not.toContain("$2,440 – $2,550");
  });

  test("a bystander is shown the duel and offered no lock", () => {
    const id = openRoom();
    // Someone who opened the invite link after the seats filled. `seatOf`
    // returns null for them and the store would refuse them NOT_A_PLAYER.
    mount(<BoxBuilder {...BASE} room={view(id)} seat={null} onLock={() => {}} />);
    expect(text()).toContain("Watching, not playing");
    expect(button("Lock this box")).toBeUndefined();
    expect(pickRoom(id, BYSTANDER, "b1|ETH|1|2|1|1788768000").ok).toBe(false);
  });

  test("with no room the arena is the solo builder it was", () => {
    mount(<BoxBuilder {...BASE} />);
    expect(container.querySelector('[data-role="duel"]')).toBeNull();
    expect(button("Lock this box")).toBeUndefined();
    // The step 1–3 surface is untouched.
    expect(all("[data-rung]").length).toBe(6);
    expect(button("Draw a box to continue")).toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6.1 — an unfilled side signs nothing
// ─────────────────────────────────────────────────────────────────────────────

describe("§6.1 — no fill, no verdict", () => {
  beforeEach(() => _resetRooms());

  const filled: FilledLeg = {
    instrument: "ETH-11SEP26-2420-C",
    entryMark: 10 as UsdPerContract,
    contracts: 1,
    premium: 5 as Usd,
  };
  const marks = new Map<string, UsdPerContract>([
    ["ETH-11SEP26-2420-C", 12 as UsdPerContract],
  ]);

  test("duelOutcome refuses to separate an unfilled slate, in either seat", () => {
    // Both unfilled — the state every duel in this build ends in, because
    // nothing here fills a box yet.
    expect(duelOutcome([], [], marks).noVerdict).toBe(true);
    // One side filled and the other not. This is the §6.1 case exactly, and the
    // filled side does NOT win by default: no verdict is signed at all.
    expect(duelOutcome([filled], [], marks).noVerdict).toBe(true);
    expect(duelOutcome([], [filled], marks).noVerdict).toBe(true);
    // And a leg the snapshot cannot mark is the same answer, not a zero.
    expect(duelOutcome([filled], [{ ...filled, instrument: "NOT-ON-THE-BOOK" }], marks).noVerdict)
      .toBe(true);
    // The control: two markable slates that differ do produce a verdict, so the
    // assertions above are about unfilled-ness and not about a function that
    // always refuses.
    const cheaper: FilledLeg = { ...filled, premium: 1 as Usd };
    const contested = duelOutcome([cheaper], [filled], marks);
    expect(contested.noVerdict).toBe(false);
    expect(contested.aWins).toBe(true);
  });

  test("the reveal says no verdict is signed, and names no winner", () => {
    const id = openRoom();
    const hostPick = drawAndLock(view(id), "host", [0, 3]);
    pickRoom(id, HOST, hostPick);
    const guestPick = drawAndLock(view(id), "guest", [1, 4]);
    pickRoom(id, GUEST, guestPick);

    mount(<BoxBuilder {...BASE} room={view(id)} seat="host" onLock={() => {}} />);
    const body = text();

    // The rule, in the words a player reads, and the refund path it points at.
    expect(body).toContain(NO_FILL_COPY);
    expect(body).toContain("six-hour refund");
    expect(body).toContain("There is no tiebreak");

    // No verdict means no verdict language. `SpotDiff` printed YOU WIN / YOU
    // LOSE / DRAW off a comparison it could always make; this screen cannot
    // make one and must not imply it did.
    for (const banned of ["YOU WIN", "YOU LOSE", "DRAW", "You won", "You lost", "Winner"]) {
      expect(body).not.toContain(banned);
    }
  });

  test("the two clocks are stated where the duel is, not only in the engine", () => {
    const id = openRoom();
    pickRoom(id, HOST, drawAndLock(view(id), "host", [0, 3]));
    pickRoom(id, GUEST, drawAndLock(view(id), "guest", [1, 4]));
    mount(<BoxBuilder {...BASE} room={view(id)} seat="guest" onLock={() => {}} />);
    // Plan 6 §C, unchanged: minutes on Δ mark for the pot, the option's own
    // expiry for the option.
    expect(text()).toContain("resolves in minutes");
    expect(text()).toContain("settles at its own expiry");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// §6 — same underlying, dealt rather than chosen
// ─────────────────────────────────────────────────────────────────────────────

describe("the dealt underlying", () => {
  test("a dealt asset pins both seats to one book", () => {
    expect(liveExpiries(FIXTURE, "BTC", NOW).length).toBeGreaterThan(0);
    mount(<BoxBuilder {...BASE} dealt="BTC" />);
    expect(text()).toContain("The duel dealt BTC");
    const eth = container.querySelector('[data-asset="ETH"]') as HTMLButtonElement;
    expect(eth.disabled).toBe(true);
    const btc = container.querySelector('[data-asset="BTC"]') as HTMLButtonElement;
    expect(btc.disabled).toBe(false);
  });

  test("an undrawable deal is ignored rather than stranding the player", () => {
    // Nothing but ETH and BTC can carry the instrument, so a deal of anything
    // else is not honoured — a duel pinned to an asset with no ladder is a duel
    // with no screen.
    mount(<BoxBuilder {...BASE} dealt="SOL" qualified={["ETH", "BTC", "SOL"]} />);
    expect(text()).not.toContain("The duel dealt");
    const eth = container.querySelector('[data-asset="ETH"]') as HTMLButtonElement;
    expect(eth.disabled).toBe(false);
  });
});
