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
  prize: number;
  lobbyName: string;
  seed: number;
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

function view(room: Room): RoomView {
  return {
    id: room.id,
    joinPath: `/room/${room.id}`,
    host: room.host,
    guest: room.guest,
    prize: room.prize,
    lobbyName: room.lobbyName,
    seed: room.seed,
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
  prize: unknown;
  lobbyName: unknown;
}): RoomResult {
  const now = Date.now();
  sweep(now);

  const host = normalizeAddress(input.address);
  if (!host) return fail("BAD_ADDRESS");

  // A full table is a bug or an attack, not a user error the host can fix by
  // retrying — refuse rather than evicting someone else's live duel.
  if (rooms.size >= MAX_ROOMS) return fail("BAD_REQUEST");

  const prize =
    typeof input.prize === "number" && Number.isFinite(input.prize) && input.prize > 0
      ? input.prize
      : 5;

  const lobbyName =
    typeof input.lobbyName === "string" && input.lobbyName.trim()
      ? input.lobbyName.trim().slice(0, 40)
      : "Room";

  const room: Room = {
    id: crypto.randomUUID(),
    host,
    guest: null,
    prize,
    lobbyName,
    // Any integer works; the salts multiply it. Kept small enough to stay exact.
    seed: Math.floor(Math.random() * 1_000_000),
    ready: [false, false],
    readyBothAt: null,
    createdAt: now,
    updatedAt: now,
  };

  rooms.set(room.id, room);
  return { ok: true, room: view(room) };
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

/** Test seam — the store is module state, so tests need a way to reset it. */
export function _resetRooms(): void {
  rooms.clear();
}

export function _roomCount(): number {
  return rooms.size;
}
