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
import { usdc } from "../src/data/stake.ts";
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
  NOTIONAL_STAKE_COPY,
  NO_FILL_COPY,
  PICK_VERSION,
  REVEAL_COPY,
  STAKES_OFF_COPY,
  decodeBoxPick,
  encodeBoxPick,
  noFillCopy,
  stakeBasisLine,
  type DuelCustody,
} from "../src/views/BoxBuilder.tsx";
import { Create } from "../src/views/Create.tsx";
import { Hub } from "../src/views/Hub.tsx";
import { RoomLobby } from "../src/views/RoomLobby.tsx";
import { INITIAL_STATE } from "../src/state/battle.ts";
import type { Room } from "../src/state/room.ts";
import type { WalletIdentity } from "../src/data/wallet.ts";

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

    // The rule, in the words a player reads. Both halves that `duelOutcome`
    // actually proves — no verdict, no tiebreak — and nothing about a refund,
    // because with no custody there are no stakes to refund.
    expect(body).toContain(NO_FILL_COPY);
    expect(body).toContain("no verdict is signed");
    expect(body).toContain("There is no tiebreak");
    expect(body).toContain("Nothing was staked");
    expect(body).not.toContain("six-hour refund");

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
// Custody — the screen may not promise money that nothing holds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The tripwire, and why it is a scan of the rendered screen rather than of the
 * source.
 *
 * `room.stakeUsdc` is an in-memory number on the room store. No approval, no
 * transfer, no escrow — `useDuelStake` is wired to the seeded match flow only,
 * and `DuelEscrow` is compiled and adversarially reviewed but not deployed. The
 * screen nevertheless used to print "winner takes $20.00" on every duel and, at
 * the reveal, "DuelEscrow's six-hour refund returns both stakes, rake-free": a
 * mechanism, a window and a rake, named confidently, for money nobody took from
 * a contract that is not on chain.
 *
 * A source scan would only guard the constants that exist today. What has to be
 * guarded is *the screen* — any sentence added anywhere on it, by anyone, in any
 * duel state. So this mounts the real component in all four states a player can
 * be in and greps what a player would actually read.
 *
 * The one exemption is the node whose entire job is to **deny** custody:
 * `data-role="notional-stake"` says "no USDC is approved, transferred or
 * escrowed", which a regex cannot tell from a promise. It is subtracted from the
 * text and separately asserted to be present, so the exemption cannot be used to
 * smuggle anything back in.
 *
 * ## Four screens, not one
 *
 * The duel strip was where this was first caught, and it was never the only
 * place. `Hub` told a player who had not connected anything that "the arena
 * stakes real USDC on Base" and headed every room card with a `$20.00 pot`;
 * `Create` headed the figure WINNER TAKES and closed with "Both stakes — $10.00
 * from each player. Settled in USDC."; `RoomLobby` printed WINNER TAKES $20.00
 * beside the seats. All four now share `stakeBasisLine`, the two denial
 * constants and the `custody` seam, and all four are scanned here — because a
 * promise deleted from one screen and left standing on the next is not deleted.
 */
/**
 * The words a promise about custody is made of.
 *
 * Three of these were added when the scan reached the other three screens,
 * because the list as it stood would have let two of the four real sentences
 * through — proof that a word list drawn from one screen's mistakes does not
 * generalise on its own:
 *
 *  - `" pot"` (with the space, so `spot` is not a hit) for the hub card's
 *    `$20.00 pot`, which `"the pot"` missed for want of an article.
 *  - `"real usdc"` for `The arena stakes real USDC on Base`, the flattest form
 *    the untruth took and the one none of the original eight words matched.
 *  - `"settled in"` for `Settled in USDC`, which was only caught by accident,
 *    via the `both stakes` in the same sentence.
 */
const CUSTODY_PROMISES = [
  "winner takes",
  "refund",
  "rake",
  "escrow",
  "both stakes",
  " pot",
  "held in",
  "returns both",
  "real usdc",
  "settled in",
];

/** The only two sentences allowed to contain a banned word, because their
 *  entire job is to deny the thing the word names. */
const DENIALS = [NOTIONAL_STAKE_COPY, STAKES_OFF_COPY];

describe("custody is claimed only when something holds the stake", () => {
  /**
   * The screen's whole text minus the sentences that deny custody.
   *
   * Every exempted node has to be one of `DENIALS` verbatim, so the exemption
   * is a fixed list of two argued-for sentences rather than an attribute anyone
   * can spray on a promise. `least` guards the other direction: a screen that
   * shows an amount and no denial at all would otherwise pass by saying nothing.
   */
  function readableWithoutTheDenial(least = 1): string {
    const nodes = [...container.querySelectorAll('[data-role="notional-stake"]')];
    expect(nodes.length).toBeGreaterThanOrEqual(least);
    let body = text();
    for (const node of nodes) {
      const denial = node.textContent ?? "";
      expect(DENIALS).toContain(denial);
      body = body.split(denial).join(" ");
    }
    return body;
  }

  /** Grep one mounted screen and report the state and the words together, so a
   *  failure names both rather than printing the whole page. */
  function scan(label: string, least = 1) {
    const body = readableWithoutTheDenial(least).toLowerCase();
    const found = CUSTODY_PROMISES.filter((p) => body.includes(p));
    expect({ state: label, promises: found }).toEqual({ state: label, promises: [] });
  }

  test("no state of an unstaked duel promises money to anyone", () => {
    // Every state a player can read the strip in, including the bystander who
    // opened the invite link and never gets a lock button.
    const states: { label: string; ui: () => React.ReactElement }[] = [
      {
        label: "before either box is locked",
        ui: () => {
          const id = openRoom();
          return <BoxBuilder {...BASE} room={view(id)} seat="host" onLock={() => {}} />;
        },
      },
      {
        label: "locked, waiting on the other seat",
        ui: () => {
          const id = openRoom();
          pickRoom(id, HOST, drawAndLock(view(id), "host", [0, 3]));
          return <BoxBuilder {...BASE} room={view(id)} seat="host" onLock={() => {}} />;
        },
      },
      {
        label: "both boxes in",
        ui: () => {
          const id = openRoom();
          pickRoom(id, HOST, drawAndLock(view(id), "host", [0, 3]));
          pickRoom(id, GUEST, drawAndLock(view(id), "guest", [1, 4]));
          return <BoxBuilder {...BASE} room={view(id)} seat="host" onLock={() => {}} />;
        },
      },
      {
        label: "watching, not playing",
        ui: () => {
          const id = openRoom();
          return <BoxBuilder {...BASE} room={view(id)} seat={null} />;
        },
      },
    ];

    for (const state of states) {
      const ui = state.ui();
      mount(ui);
      scan(state.label);
      // The stake itself is still shown — it is a real setting both seats
      // agreed to, and hiding it would make the create screen's field look
      // like it did nothing. It is shown labelled.
      expect(text()).toContain(`${usdc(10)} each, notional`);
      unmount();
    }
  });

  test("the reveal's refund sentence exists only for a duel an escrow holds", () => {
    const held: DuelCustody = {
      escrow: "0x00000000000000000000000000000000000dead0",
      refundHours: 6,
    };

    // Unstaked: the true halves survive untouched, the refund does not.
    expect(NO_FILL_COPY).toContain("no verdict is signed");
    expect(NO_FILL_COPY).toContain("There is no tiebreak");
    expect(NO_FILL_COPY).toContain("nothing to return");
    expect(NO_FILL_COPY).not.toContain("refund");
    expect(noFillCopy(null)).toBe(NO_FILL_COPY);

    // Escrowed: the same two true halves, plus the refund the escrow can pay.
    // Proves the branch is a live seam and not dead code kept for comfort.
    expect(noFillCopy(held)).toContain("no verdict is signed");
    expect(noFillCopy(held)).toContain("There is no tiebreak");
    expect(noFillCopy(held)).toContain("6-hour refund returns both stakes, rake-free");

    // And the same asymmetry in the strip.
    expect(stakeBasisLine(10, null)).toBe(`${usdc(10)} each, notional · nothing is held`);
    expect(stakeBasisLine(10, held)).toBe(`${usdc(10)} each · winner takes ${usdc(20)}`);
  });

  test("custody, when it is real, reaches the screen", () => {
    const id = openRoom();
    pickRoom(id, HOST, drawAndLock(view(id), "host", [0, 3]));
    pickRoom(id, GUEST, drawAndLock(view(id), "guest", [1, 4]));
    mount(
      <BoxBuilder
        {...BASE}
        room={view(id)}
        seat="host"
        onLock={() => {}}
        custody={{ escrow: "0x00000000000000000000000000000000000dead0", refundHours: 6 }}
      />,
    );
    // The promise comes back, and the disclaimer goes away — one switch, and
    // the escrow address is what throws it.
    expect(text()).toContain(`winner takes ${usdc(20)}`);
    expect(text()).toContain("6-hour refund returns both stakes, rake-free");
    expect(container.querySelector('[data-role="notional-stake"]')).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The other three screens that claimed custody of the same money
  // ───────────────────────────────────────────────────────────────────────────

  const DISCONNECTED: WalletIdentity = {
    address: null,
    chainId: null,
    walletName: null,
    connected: false,
    connecting: false,
    wrongNetwork: false,
  };

  const CONNECTED: WalletIdentity = {
    ...DISCONNECTED,
    address: HOST,
    chainId: 8453,
    walletName: "MetaMask",
    connected: true,
  };

  const noop = () => {};

  function hub(
    identity: WalletIdentity,
    rooms: readonly RoomView[],
    custody: DuelCustody | null = null,
  ) {
    return (
      <Hub
        identity={identity}
        rooms={rooms}
        custody={custody}
        onEnterMode={noop}
        onOpenRoom={noop}
        onConnect={noop}
        onDisconnect={noop}
        onRefresh={noop}
      />
    );
  }

  function create(custody: DuelCustody | null = null) {
    return (
      <Create
        state={INITIAL_STATE}
        entryLabel={usdc(10)}
        prizeLabel={usdc(20)}
        inviteUrl={null}
        creating={false}
        createError={null}
        walletConnected
        custody={custody}
        onBack={noop}
        onStakeInput={noop}
        onStakeBlur={noop}
        onStakeUp={noop}
        onStakeDown={noop}
        onLobbyName={noop}
        onDuration={noop}
        onCreateArena={noop}
        onOpenLobby={noop}
      />
    );
  }

  /** A `useRoom` return with nothing but the two fields the lobby branches on. */
  function roomState(seat: Room["seat"], started: boolean): Room {
    return {
      room: null,
      inviteUrl: null,
      arrivedFromLink: false,
      seat,
      started,
      error: null,
      busy: false,
      create: async () => {},
      open: async () => {},
      pick: async () => {},
      join: async () => {},
      ready: async () => {},
      leave: noop,
      dismissError: noop,
    };
  }

  test("the hub promises nothing, connected or not", () => {
    const id = openRoom();
    const states: { label: string; ui: () => React.ReactElement }[] = [
      // The worst placement the untruth had: read before a player has committed
      // to anything, while they are deciding whether to connect a wallet.
      { label: "no wallet, no duels", ui: () => hub(DISCONNECTED, []) },
      { label: "no wallet, duels listed", ui: () => hub(DISCONNECTED, [view(id)]) },
      { label: "connected, duels listed", ui: () => hub(CONNECTED, [view(id)]) },
    ];

    for (const state of states) {
      mount(state.ui());
      scan(state.label);
      unmount();
    }

    // The card still carries the amount, labelled — same sentence as the strip.
    mount(hub(CONNECTED, [view(id)]));
    expect(text()).toContain(stakeBasisLine(10, null));
    unmount();
  });

  test("the create screen prices a setting, not a transfer", () => {
    mount(create());
    scan("create, before the arena exists");
    // Twice the stake is arithmetic and stays on screen; the claim about where
    // it goes is what left.
    expect(text()).toContain(usdc(20));
    expect(text()).toContain(stakeBasisLine(10, null));
    // The button is not a price tag. "Create arena & link · $10.00" reads as a
    // charge, and pressing it writes a row in a `Map`.
    expect(button("Create arena & link")).toBeDefined();
    unmount();
  });

  test("the room lobby promises nothing from any seat", () => {
    const id = openRoom();
    const states: { label: string; ui: () => React.ReactElement }[] = [
      {
        label: "host, both ready",
        ui: () => (
          <RoomLobby
            room={view(id)}
            state={roomState("host", true)}
            walletConnected
            onEnterDuel={noop}
          />
        ),
      },
      {
        label: "guest, both ready",
        ui: () => (
          <RoomLobby
            room={view(id)}
            state={roomState("guest", true)}
            walletConnected
            onEnterDuel={noop}
          />
        ),
      },
      {
        label: "bystander on the invite link",
        ui: () => (
          <RoomLobby
            room={view(id)}
            state={roomState(null, true)}
            walletConnected={false}
            onEnterDuel={noop}
          />
        ),
      },
    ];

    for (const state of states) {
      mount(state.ui());
      scan(state.label);
      expect(text()).toContain(stakeBasisLine(10, null).toUpperCase());
      unmount();
    }
  });

  test("all three screens hand the promise back when an escrow really holds it", () => {
    const id = openRoom();
    const held: DuelCustody = {
      escrow: "0x00000000000000000000000000000000000dead0",
      refundHours: 6,
    };

    // One seam, one switch, three screens — and the switch is an address, not a
    // flag, so nothing here can be turned on by optimism.
    mount(hub(CONNECTED, [view(id)], held));
    expect(text()).toContain(`winner takes ${usdc(20)}`);
    expect(container.querySelector('[data-role="notional-stake"]')).toBeNull();
    unmount();

    mount(create(held));
    expect(text()).toContain("WINNER TAKES");
    expect(text()).toContain("Both stakes");
    expect(container.querySelector('[data-role="notional-stake"]')).toBeNull();
    unmount();

    mount(
      <RoomLobby
        room={view(id)}
        state={roomState("host", true)}
        walletConnected
        custody={held}
        onEnterDuel={noop}
      />,
    );
    expect(text()).toContain("WINNER TAKES");
    expect(text()).toContain(usdc(20));
    expect(container.querySelector('[data-role="notional-stake"]')).toBeNull();
    unmount();
  });

  test("App hands the arena no custody, because the arena has none", async () => {
    // The seam's only caller. If this ever becomes `custody={stake}` or a
    // literal, that is a claim about money and it must be argued for here
    // first — `stake` is the *seeded match's* side bet and pointing the arena
    // at it would have the arena claim custody of another duel's money.
    const app = await Bun.file(join(import.meta.dir, "..", "src", "App.tsx")).text();
    const passes = [...app.matchAll(/custody=\{([^}]*)\}/g)].map((m) => m[1]!.trim());
    expect(passes).toEqual(["null"]);
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
