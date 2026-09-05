/**
 * A duel room: what the two players agree on before the tape runs.
 *
 * Shared between the Bun server (`src/server/rooms.ts`) and the client
 * (`src/state/room.ts`), so the wire shape is declared once.
 */

import type { GameMode } from "../types.ts";
import { meta } from "./universe.ts";

export type RoomSeat = "host" | "guest";

/**
 * Where a captured opening price came from.
 *
 * Both values are a real print off a real venue. They are kept apart because
 * they are not the same claim and a screen must be able to say which it is
 * showing:
 *
 *  - `"book"` — the Thetanuts market snapshot's `spot`, i.e.
 *    `getMarketData().prices`. This is the number the option book itself is
 *    quoted around, so a strike, a premium and this open all agree.
 *  - `"chainlink"` — `latestRoundData()` on the Base aggregator behind the
 *    asset, read straight off `mainnet.base.org`. This is the feed that
 *    *settles* the option (through a TWAP consumer — see the honesty note in
 *    `src/data/history.ts`), which is why it is the fallback rather than a
 *    second-best: when the book is unreachable it is still the truest price
 *    available, and it is reachable independently of the book.
 *
 * There is no third member on purpose. "The seeded reference" is not a source,
 * it is the absence of one, and it is spelled `open === null`.
 */
export type OpenSource = "book" | "chainlink";

/**
 * The prices a room's tapes open on, captured once when the room was created.
 *
 * ## Why this is stored rather than read
 *
 * Same reason as {@link RoomView.seed}, and it is worth stating in full because
 * getting it wrong is silent. Both seats must watch the *same* tape. The walk
 * itself is a pure function of `(sym, salt, open)` — `src/engine/tape.ts` — so
 * a shared `seed` already gives both sides the same *shape*. If each client
 * then read its own live spot to open on, the two tapes would be the same shape
 * at two different price levels, thirty seconds apart, and the duel would be
 * decided by whose poll landed first. Capturing once, server-side, at creation,
 * is what makes the open as shared as the seed is.
 *
 * ## Why it is not the seeded reference
 *
 * It used to be. `engine/tape.ts` opened every walk on `meta(sym).px`, an
 * eighteen-row fixture in `src/data/universe.ts` whose ETH row says $4,182.60.
 * Measured against Base on 2026-09-05 the live prints were ETH $2,450.76, BTC
 * $79,561.30, SOL ~$101.87 — the fixture was 70%, 21% and 110% out. The tape
 * therefore drew a walk from a price no venue had quoted in about two years,
 * and the duel's legs read `ETH closes above 4,392` next to a live spot of
 * $2,453 on the same screen.
 *
 * ## What `null` means, and why it is not a fallback
 *
 * `null` means **nothing real could be read when this room opened** — no book,
 * no oracle. It is not an error and it is not a loading state; the room still
 * opens and still plays. What it must never do is quietly become
 * `meta(sym).px`, because a stale number rendered as a live one is exactly the
 * bug this field was added to remove, and swapping one silent fixture for
 * another silent fixture would be no improvement at all.
 *
 * So the reference price is still what the tape walks in that case — there is
 * nothing else to walk — but it arrives through {@link openFor}, which cannot
 * hand a caller a bare number. It returns the price and the fact of where it
 * came from together, so a screen that renders the price without the label has
 * to go out of its way to do it.
 */
export interface RoomOpen {
  /**
   * USD per symbol, exactly as read. Only symbols that actually answered are
   * present — a feed that was rate-limited or has no market price is **absent**
   * rather than zero, the same convention `MarketSnapshot.spot` keeps for PAXG.
   */
  px: Readonly<Record<string, number>>;
  source: OpenSource;
  /**
   * When the capture was read, ms. Deliberately **not** the room's `createdAt`:
   * a snapshot served from a 15s cache is up to 15s old and the screen is
   * entitled to say so, the same way the market footer's age chip does.
   */
  at: number;
  /** Provenance, ready to render: `"Chainlink · Base 8453"`, `"thetanuts · base 8453"`. */
  label: string;
}

/**
 * The opening print for one symbol in one room, and whether it is a live one.
 *
 * **This is the honesty seam, and the return type is the whole point.** There
 * is no path here that yields a bare `number`, so no caller can render a
 * reference price where a live one is implied without first destructuring the
 * flag that says which it is. `docs/reality-check.md` catalogues six money bugs
 * in this repo and every one of them is a number that meant something other
 * than what the screen claimed; this shape is a refusal to add a seventh.
 *
 * `live: false` is an ordinary answer, not a failure. It is what a room opened
 * with no reachable venue gets, and it is also what an asset with no feed gets
 * inside an otherwise-live capture — NVDA has no Chainlink aggregator on Base
 * and never will.
 */
export function openFor(
  open: RoomOpen | null,
  sym: string,
): { px: number; live: boolean; source: OpenSource | null; at: number | null } {
  const px = open?.px[sym];
  if (open && typeof px === "number" && Number.isFinite(px) && px > 0) {
    return { px, live: true, source: open.source, at: open.at };
  }
  return { px: meta(sym).px, live: false, source: null, at: null };
}

/**
 * The chip a screen must show when it is drawing a tape that opened on the
 * seeded reference rather than on a real print.
 *
 * A constant rather than a string per screen, for the same reason `SPOT_CHIP`
 * in `src/data/spot.ts` is one: three screens wording the same disclosure three
 * ways is how one of them ends up wording it weakly.
 */
export const PRACTICE_TAPE_CHIP = "PRACTICE TAPE · NO LIVE OPEN";

/** The one-line explanation that sits under {@link PRACTICE_TAPE_CHIP}. */
export const PRACTICE_TAPE_NOTE =
  "No venue answered when this room opened, so the tape walks from a stored " +
  "reference price, not from today's market. The duel is still fair — both " +
  "seats watch the identical tape — but the prices on it are not live.";

/** The chip for the other case: a real captured open. `at` renders as an age. */
export function liveOpenChip(open: RoomOpen): string {
  return `LIVE OPEN · ${open.label}`;
}

export interface RoomView {
  id: string;
  /** Path to share. The client turns it into an absolute URL with its own
   *  origin, so the server never has to know how it is being reached. */
  joinPath: string;
  /** Lowercased wallet address of whoever opened the room. */
  host: string;
  /** Lowercased wallet address of the challenger, `null` until the slot is claimed. */
  guest: string | null;
  /**
   * The stake each seat *names*, in USDC — **a setting, not a transfer.**
   *
   * Nothing on the arena path takes it: no approval, no transfer, no escrow.
   * `useDuelStake` reaches the seeded match flow only, and `DuelEscrow` is
   * compiled and reviewed but not deployed, so no winner takes anything here.
   * The screens say so out loud (`NOTIONAL_STAKE_COPY`), and a test greps the
   * rendered DOM to keep them saying it. This comment said "the winner takes
   * both" for a long time, which is how the screens came to say it too.
   */
  stakeUsdc: number;
  /** How long the tape runs, in whole minutes. */
  durationMinutes: number;
  lobbyName: string;
  /**
   * Tape seed, fixed when the room is created.
   *
   * `studySalt`/`fightSalt` in `src/state/selectors.ts` derive from it, so both
   * players' random walks are the same walk. Without a shared seed each side
   * would be watching its own tape and the result would be meaningless.
   */
  seed: number;
  /**
   * The prices this room's tapes open on, captured once at creation — or `null`
   * when no venue answered. See {@link RoomOpen}; read it through
   * {@link openFor}, never directly.
   *
   * It sits beside `seed` because it is the same kind of thing: half of the
   * pair `(seed, open)` that both seats derive their walk from. `seed` alone
   * fixed the shape; this fixes where the shape starts.
   */
  open: RoomOpen | null;
  /** Which mode this room plays. */
  mode: GameMode;
  /**
   * `[host, guest]` submitted picks, mode-specific and opaque to the store.
   *
   * Hidden until both seats submit — a duel where you can read the other side's
   * answer first is not a duel. The server nulls the opponent's entry in the
   * view it returns until both are in.
   */
  picks: [string | null, string | null];
  /** True once both picks are in. Only then does the view carry both. */
  revealed: boolean;
  /** `[host, guest]` readiness. */
  ready: [boolean, boolean];
  /**
   * When both sides first read ready — the agreed start instant, set once and
   * never moved. Both clients race to report readiness; only the first write
   * lands, so they anchor the countdown to the same millisecond.
   */
  readyBothAt: number | null;
  updatedAt: number;
}

/** Every way a room transition can be refused, and the status each maps to. */
export type RoomErrorCode =
  | "NOT_FOUND"
  | "ROOM_FULL"
  | "OWN_ROOM"
  | "NOT_A_PLAYER"
  | "ALREADY_PICKED"
  | "BAD_ADDRESS"
  | "BAD_REQUEST";

export const ROOM_ERROR_STATUS: Record<RoomErrorCode, number> = {
  NOT_FOUND: 404,
  // 409, not 400: the request was well formed, it just lost the race.
  ROOM_FULL: 409,
  OWN_ROOM: 400,
  NOT_A_PLAYER: 403,
  ALREADY_PICKED: 409,
  BAD_ADDRESS: 400,
  BAD_REQUEST: 400,
};

export const ROOM_ERROR_MESSAGE: Record<RoomErrorCode, string> = {
  NOT_FOUND: "That room has expired or never existed.",
  ROOM_FULL: "Someone just took this duel. Ask for a fresh link.",
  OWN_ROOM: "You opened this room — send the link to someone else.",
  NOT_A_PLAYER: "You are not in this duel.",
  ALREADY_PICKED: "You already locked a pick for this duel.",
  BAD_ADDRESS: "Connect a wallet first.",
  BAD_REQUEST: "Malformed request.",
};

export type RoomResult =
  | { ok: true; room: RoomView }
  | { ok: false; code: RoomErrorCode; error: string };

/** Which seat an address sits in, or `null` if it is not in the room. */
export function seatOf(room: RoomView, address: string | null): RoomSeat | null {
  if (!address) return null;
  const a = address.toLowerCase();
  if (room.host === a) return "host";
  if (room.guest === a) return "guest";
  return null;
}

export function bothReady(room: RoomView): boolean {
  return room.ready[0] && room.ready[1];
}
