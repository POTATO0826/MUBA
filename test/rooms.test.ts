import { beforeEach, describe, expect, test } from "bun:test";
import { bothReady, seatOf } from "../src/data/room.ts";
import {
  _resetRooms,
  _roomCount,
  createRoom,
  joinRoom,
  readRoom,
  readyRoom,
} from "../src/server/rooms.ts";

const HOST = "0x71cB05fD1eA1B3d4a7C9e8F2b6D0a3C85e9d4Af2";
const A = "0xAaaA000000000000000000000000000000000001";
const B = "0xbBBb000000000000000000000000000000000002";

/** Create a room and return its view, failing the test if creation was refused. */
function open(address = HOST, prize = 2.5, lobbyName = "Test") {
  const r = createRoom({ address, prize, lobbyName });
  if (!r.ok) throw new Error(`createRoom refused: ${r.code}`);
  return r.room;
}

beforeEach(_resetRooms);

describe("createRoom", () => {
  test("lowercases the host address so comparisons are case-blind", () => {
    // Wallets hand back checksummed addresses; the same wallet reconnecting
    // must not read as a different player because of letter case.
    expect(open().host).toBe(HOST.toLowerCase());
  });

  test("refuses anything that is not a 20-byte hex address", () => {
    for (const bad of ["", "0x", "not-an-address", "0x71cB05", HOST + "00", 42, null]) {
      const r = createRoom({ address: bad, prize: 1, lobbyName: "x" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe("BAD_ADDRESS");
    }
  });

  test("falls back to a sane prize rather than storing NaN or a negative", () => {
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      expect(open(HOST, bad as number).prize).toBe(5);
    }
    expect(open(HOST, 0.25).prize).toBe(0.25);
  });

  test("clamps the lobby name and defaults an empty one", () => {
    expect(open(HOST, 1, "   ").lobbyName).toBe("Room");
    expect(open(HOST, 1, "x".repeat(80)).lobbyName).toHaveLength(40);
  });

  test("every room gets its own id and its own seed slot", () => {
    const ids = new Set([open().id, open().id, open().id]);
    expect(ids.size).toBe(3);
    expect(_roomCount()).toBe(3);
  });

  test("the share path carries the id", () => {
    const room = open();
    expect(room.joinPath).toBe(`/room/${room.id}`);
  });
});

describe("joinRoom", () => {
  test("the first caller takes the seat", () => {
    const room = open();
    const r = joinRoom(room.id, A);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.room.guest).toBe(A.toLowerCase());
  });

  test("the second caller loses the race with a conflict, not a crash", () => {
    // The whole point of the compare-and-set: one link, two clickers, one seat.
    const room = open();
    expect(joinRoom(room.id, A).ok).toBe(true);

    const second = joinRoom(room.id, B);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("ROOM_FULL");

    // And the winner is still the winner.
    const after = readRoom(room.id);
    if (after.ok) expect(after.room.guest).toBe(A.toLowerCase());
  });

  test("the host cannot fill their own challenger seat", () => {
    const room = open();
    const r = joinRoom(room.id, HOST);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("OWN_ROOM");
  });

  test("re-joining is a refresh, not a conflict", () => {
    // A second tab, or a poll that raced the join, must not read as an error.
    const room = open();
    expect(joinRoom(room.id, A).ok).toBe(true);
    expect(joinRoom(room.id, A).ok).toBe(true);
    expect(joinRoom(room.id, A.toLowerCase()).ok).toBe(true);
  });

  test("an unknown room is a 404-shaped refusal", () => {
    const r = joinRoom(crypto.randomUUID(), A);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("NOT_FOUND");
  });
});

describe("readyRoom", () => {
  test("only the two players can report ready", () => {
    const room = open();
    joinRoom(room.id, A);

    const outsider = readyRoom(room.id, B);
    expect(outsider.ok).toBe(false);
    if (!outsider.ok) expect(outsider.code).toBe("NOT_A_PLAYER");
  });

  test("each side flips its own bit", () => {
    const room = open();
    joinRoom(room.id, A);

    const host = readyRoom(room.id, HOST);
    if (host.ok) expect(host.room.ready).toEqual([true, false]);

    const guest = readyRoom(room.id, A);
    if (guest.ok) expect(guest.room.ready).toEqual([true, true]);
  });

  test("the start instant is stamped once and never moves", async () => {
    // Both clients race to report the second ready; whichever lands first fixes
    // the anchor, and a duplicate must not drag it forward or the two sides
    // would count down from different numbers.
    const room = open();
    joinRoom(room.id, A);
    readyRoom(room.id, HOST);

    const first = readyRoom(room.id, A);
    if (!first.ok) throw new Error("ready refused");
    const anchor = first.room.readyBothAt;
    expect(anchor).not.toBeNull();

    await Bun.sleep(5);
    const again = readyRoom(room.id, A);
    if (again.ok) expect(again.room.readyBothAt).toBe(anchor);

    const andAgain = readyRoom(room.id, HOST);
    if (andAgain.ok) expect(andAgain.room.readyBothAt).toBe(anchor);
  });

  test("no anchor while only one side is ready", () => {
    const room = open();
    joinRoom(room.id, A);
    const r = readyRoom(room.id, HOST);
    if (r.ok) expect(r.room.readyBothAt).toBeNull();
  });

  test("a host alone in the room can arm early without starting the duel", () => {
    // Readiness before an opponent arrives is harmless, but it must not read as
    // both-ready — otherwise a solo host would fall through into the fight.
    const room = open();
    const r = readyRoom(room.id, HOST);
    if (!r.ok) throw new Error("ready refused");
    expect(r.room.ready).toEqual([true, false]);
    expect(bothReady(r.room)).toBe(false);
    expect(r.room.readyBothAt).toBeNull();
  });
});

describe("seatOf", () => {
  test("names the seat regardless of address case", () => {
    const room = open();
    const joined = joinRoom(room.id, A);
    if (!joined.ok) throw new Error("join refused");

    expect(seatOf(joined.room, HOST)).toBe("host");
    expect(seatOf(joined.room, HOST.toLowerCase())).toBe("host");
    expect(seatOf(joined.room, A)).toBe("guest");
    expect(seatOf(joined.room, B)).toBeNull();
    expect(seatOf(joined.room, null)).toBeNull();
  });
});
