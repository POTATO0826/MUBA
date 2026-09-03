/**
 * A duel room: what the two players agree on before the tape runs.
 *
 * Shared between the Bun server (`src/server/rooms.ts`) and the client
 * (`src/state/room.ts`), so the wire shape is declared once.
 */

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
  prize: number;
  lobbyName: string;
  /**
   * Tape seed, fixed when the room is created.
   *
   * `studySalt`/`fightSalt` in `src/state/selectors.ts` derive from it, so both
   * players' random walks are the same walk. Without a shared seed each side
   * would be watching its own tape and the result would be meaningless.
   */
  seed: number;
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
  | "BAD_ADDRESS"
  | "BAD_REQUEST";

export const ROOM_ERROR_STATUS: Record<RoomErrorCode, number> = {
  NOT_FOUND: 404,
  // 409, not 400: the request was well formed, it just lost the race.
  ROOM_FULL: 409,
  OWN_ROOM: 400,
  NOT_A_PLAYER: 403,
  BAD_ADDRESS: 400,
  BAD_REQUEST: 400,
};

export const ROOM_ERROR_MESSAGE: Record<RoomErrorCode, string> = {
  NOT_FOUND: "That room has expired or never existed.",
  ROOM_FULL: "Someone just took this duel. Ask for a fresh link.",
  OWN_ROOM: "You opened this room — send the link to someone else.",
  NOT_A_PLAYER: "You are not in this duel.",
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
