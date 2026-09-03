import {
  clampDuration,
  clampStake,
  MIN_DURATION_MINUTES,
  MIN_STAKE_USDC,
} from "../data/stake.ts";
import type { GameMode } from "../types.ts";
import {
  ROOM_ERROR_MESSAGE,
  type RoomErrorCode,
  type RoomResult,
  type RoomView,
} from "../data/room.ts";

/**
 * Duel rooms, in memory.
 *
 * No database on purpose: a room lives for one duel, and Postgres would buy
 * durability nobody needs yet. What it does borrow from a real one is the
 * discipline — every transition is a compare-and-set that either wins or is
 * refused, never a read-then-write. Send one link to three friends and all
 * three click at once: exactly one becomes the guest, the other two get a 409.
 *
 * The cost of in-memory is that a server restart drops every room, and rooms do
 * not survive across processes. Swapping the `Map` for a table means
 * reimplementing these four functions and nothing above them.
 */

interface Room {
  id: string;
  host: string;
  guest: string | null;
  stakeUsdc: number;
  durationMinutes: number;
  lobbyName: string;
  seed: number;
  mode: GameMode;
  picks: [string | null, string | null];
  ready: [boolean, boolean];
  readyBothAt: number | null;
  createdAt: number;
  updatedAt: number;
}

const rooms = new Map<string, Room>();

/** Rooms are swept an hour after their last change. */
const ROOM_TTL_MS = 60 * 60 * 1000;
const MAX_ROOMS = 500;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function fail(code: RoomErrorCode): RoomResult {
  return { ok: false, code, error: ROOM_ERROR_MESSAGE[code] };
}

/** Both seats have submitted. */
function revealed(room: Room): boolean {
  return room.picks[0] !== null && room.picks[1] !== null;
}

function view(room: Room): RoomView {
  return {
    id: room.id,
    joinPath: `/room/${room.id}`,
    host: room.host,
    guest: room.guest,
    stakeUsdc: room.stakeUsdc,
    durationMinutes: room.durationMinutes,
    lobbyName: room.lobbyName,
    seed: room.seed,
    mode: room.mode,
    // Picks stay hidden until both are in. Returning the opponent's answer
    // early would let a player copy it.
    picks: revealed(room) ? [room.picks[0], room.picks[1]] : [null, null],
    revealed: revealed(room),
    ready: [room.ready[0], room.ready[1]],
    readyBothAt: room.readyBothAt,
    updatedAt: room.updatedAt,
  };
}

/** Drop rooms nobody has touched in an hour. Runs on every write, so there is
 *  no timer to leak. */
function sweep(now: number): void {
  for (const [id, room] of rooms) {
    if (now - room.updatedAt > ROOM_TTL_MS) rooms.delete(id);
  }
}

function normalizeAddress(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const a = raw.trim();
  return ADDRESS_RE.test(a) ? a.toLowerCase() : null;
}

export function createRoom(input: {
  address: unknown;
  stakeUsdc: unknown;
  durationMinutes: unknown;
  lobbyName: unknown;
  mode: unknown;
}): RoomResult {
  const now = Date.now();
  sweep(now);

  const host = normalizeAddress(input.address);
  if (!host) return fail("BAD_ADDRESS");

  // A full table is a bug or an attack, not a user error the host can fix by
  // retrying — refuse rather than evicting someone else's live duel.
  if (rooms.size >= MAX_ROOMS) return fail("BAD_REQUEST");

  // Clamped rather than rejected: the client already enforces the band, so a
  // value outside it is a stale tab or a hand-rolled request, not something the
  // host needs an error message about.
  const stakeUsdc = clampStake(
    typeof input.stakeUsdc === "number" && Number.isFinite(input.stakeUsdc)
      ? input.stakeUsdc
      : MIN_STAKE_USDC,
  );

  const durationMinutes = clampDuration(
    typeof input.durationMinutes === "number" && Number.isFinite(input.durationMinutes)
      ? input.durationMinutes
      : MIN_DURATION_MINUTES,
  );

  const lobbyName =
    typeof input.lobbyName === "string" && input.lobbyName.trim()
      ? input.lobbyName.trim().slice(0, 40)
      : "Room";

  const room: Room = {
    id: crypto.randomUUID(),
    host,
    guest: null,
    stakeUsdc,
    durationMinutes,
    lobbyName,
    // Any integer works; the salts multiply it. Kept small enough to stay exact.
    seed: Math.floor(Math.random() * 1_000_000),
    mode: input.mode === "spotdiff" ? "spotdiff" : "parlay",
    picks: [null, null],
    ready: [false, false],
    readyBothAt: null,
    createdAt: now,
    updatedAt: now,
  };

  rooms.set(room.id, room);
  return { ok: true, room: view(room) };
}

/**
 * Every room an address sits in, newest first.
 *
 * The hub lists these as "active duels". A room with no guest is still active —
 * it is waiting on the invite link.
 */
export function listRoomsFor(addressRaw: unknown): RoomView[] {
  sweep(Date.now());
  const address = normalizeAddress(addressRaw);
  if (!address) return [];
  return [...rooms.values()]
    .filter((r) => r.host === address || r.guest === address)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(view);
}

export function readRoom(id: string): RoomResult {
  const room = rooms.get(id);
  if (!room) return fail("NOT_FOUND");
  return { ok: true, room: view(room) };
}

/**
 * Claim the guest seat.
 *
 * The `guest !== null` check and the assignment are one synchronous step, which
 * is what makes this a compare-and-set on a single-threaded runtime. The same
 * shape against SQL is
 * `UPDATE rooms SET guest = ? WHERE id = ? AND guest IS NULL`.
 */
export function joinRoom(id: string, addressRaw: unknown): RoomResult {
  const now = Date.now();
  sweep(now);

  const address = normalizeAddress(addressRaw);
  if (!address) return fail("BAD_ADDRESS");

  const room = rooms.get(id);
  if (!room) return fail("NOT_FOUND");

  // Idempotent: re-joining from a second tab is not an error, it is a refresh.
  if (room.guest === address) return { ok: true, room: view(room) };

  if (room.host === address) return fail("OWN_ROOM");
  if (room.guest !== null) return fail("ROOM_FULL");

  room.guest = address;
  room.updatedAt = now;
  return { ok: true, room: view(room) };
}

/**
 * Mark one seat ready, and stamp the shared start instant when the second
 * arrives.
 *
 * `readyBothAt` is written only while null, so whichever client reports second
 * fixes the timestamp and a later duplicate cannot move it. Both sides then
 * count down from the same number.
 */
export function readyRoom(id: string, addressRaw: unknown): RoomResult {
  const now = Date.now();
  sweep(now);

  const address = normalizeAddress(addressRaw);
  if (!address) return fail("BAD_ADDRESS");

  const room = rooms.get(id);
  if (!room) return fail("NOT_FOUND");

  const seat = room.host === address ? 0 : room.guest === address ? 1 : -1;
  if (seat === -1) return fail("NOT_A_PLAYER");

  if (!room.ready[seat]) {
    room.ready[seat] = true;
    room.updatedAt = now;
  }

  if (room.ready[0] && room.ready[1] && room.readyBothAt === null) {
    room.readyBothAt = now;
    room.updatedAt = now;
  }

  return { ok: true, room: view(room) };
}

/**
 * Lock one seat's pick.
 *
 * A pick is write-once. Letting a player resubmit after the reveal would let
 * them change their answer once they can see the other side.
 */
export function pickRoom(id: string, addressRaw: unknown, pick: unknown): RoomResult {
  const now = Date.now();
  sweep(now);

  const address = normalizeAddress(addressRaw);
  if (!address) return fail("BAD_ADDRESS");
  if (typeof pick !== "string" || pick.length === 0 || pick.length > 400) {
    return fail("BAD_REQUEST");
  }

  const room = rooms.get(id);
  if (!room) return fail("NOT_FOUND");

  const seat = room.host === address ? 0 : room.guest === address ? 1 : -1;
  if (seat === -1) return fail("NOT_A_PLAYER");
  if (room.picks[seat] !== null) return fail("ALREADY_PICKED");

  room.picks[seat] = pick;
  room.updatedAt = now;
  return { ok: true, room: view(room) };
}

/** Test seam — the store is module state, so tests need a way to reset it. */
export function _resetRooms(): void {
  rooms.clear();
}

export function _roomCount(): number {
  return rooms.size;
}
