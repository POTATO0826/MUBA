/**
 * A duel room: what the two players agree on before the tape runs.
 *
 * Shared between the Bun server (`src/server/rooms.ts`) and the client
 * (`src/state/room.ts`), so the wire shape is declared once.
 */

import type { GameMode } from "../types.ts";

export type RoomSeat = "host" | "guest";

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
