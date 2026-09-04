/**
 * The seats, read from a chain that does not exist yet.
 *
 * `src/server/seats.ts` is the answer to the residual of finding X-1: a lock
 * proves the caller controls the address it names, and only the escrow can say
 * whether that address is *playing this duel*. The escrow is not deployed, so
 * everything here runs against a fake `call` — but the two ends that would
 * silently drift are pinned to the real artifact rather than to each other:
 *
 *   1. **The call and the answer are encoded by the COMMITTED ABI.** Every
 *      fixture below is built with `contracts/out/DuelEscrow.json`'s own
 *      `Interface`, never by hand and never with the signature string
 *      `seats.ts` transcribed. If that transcription ever disagrees with the
 *      compiled contract — a field reordered, a type widened, `a` and `b`
 *      swapped, which is the one mistake that would hand the X-1 attacker
 *      exactly what he wants — the decode fails here, offline, before a
 *      deployment could make it expensive.
 *
 *   2. **The status ordinals are read out of `DuelEscrow.sol`.** `Status` is a
 *      Solidity enum, so its meaning is entirely positional; a new member
 *      inserted in the middle would renumber every one after it, and a reader
 *      that still believed `2 === FULL` would happily bind seats on a duel that
 *      is something else entirely.
 *
 * What cannot be tested here, and is listed in the report rather than faked: a
 * real `eth_call` against a real deployment. Everything between the request
 * body and the RPC boundary is exercised; the RPC boundary itself is a fake.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Interface, ZeroAddress, getAddress, id, type InterfaceAbi } from "ethers";
import {
  SEATS_MISS_TTL_MS,
  SEATS_OPEN_TTL_MS,
  SEATS_TTL_MS,
  SEAT_STATUSES,
  createSeatReader,
  type SeatProvider,
  type SeatsEnvelope,
  type SeatsOk,
} from "../src/server/seats.ts";

// ─── the contract's own ABI and enum ─────────────────────────────────────────

const CONTRACTS = join(import.meta.dir, "..", "contracts");

const ARTIFACT = JSON.parse(readFileSync(join(CONTRACTS, "out", "DuelEscrow.json"), "utf8")) as {
  abi: InterfaceAbi;
};

/** The committed contract's interface — the thing a real node would speak. */
const ESCROW = new Interface(ARTIFACT.abi);

const SOURCE = readFileSync(join(CONTRACTS, "DuelEscrow.sol"), "utf8");

/** `enum Status { NONE, OPEN, … }`, in declaration order, straight from the
 *  source. Position is meaning for a Solidity enum. */
const SOURCE_STATUSES = (/enum Status \{([^}]*)\}/.exec(SOURCE)?.[1] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// ─── fixtures ────────────────────────────────────────────────────────────────

/** Checksummed by `getAddress` rather than typed out: a hand-written EIP-55
 *  address is a coin flip, and ethers refuses a wrong one. */
const A = getAddress(`0x${"aa".repeat(20)}`);
const B = getAddress(`0x${"bb".repeat(20)}`);
/** All-digit, so its checksum form is its literal form — as in attest.test.ts. */
const ESCROW_ADDRESS = "0x1111111111111111111111111111111111111111";

const DUEL_ID = id("kz-semis:424242");
const OTHER_ID = id("kz-semis:424243");

const T0 = 1_756_000_000_000;

type StatusName = (typeof SEAT_STATUSES)[number];

interface DuelRow {
  a?: string;
  b?: string;
  invited?: string;
  stake?: bigint;
  fullAt?: number;
  status?: StatusName | number;
  aWithdrawn?: boolean;
  bWithdrawn?: boolean;
}

/** One `duels(bytes32)` answer, ABI-encoded exactly as the deployed contract
 *  would return it. The ordinal is looked up in the SOURCE's enum, so the
 *  fixture and the reader agree only if both agree with the contract. */
function duelsResult(row: DuelRow = {}): string {
  const status = typeof row.status === "number" ? row.status : SOURCE_STATUSES.indexOf(row.status ?? "FULL");
  return ESCROW.encodeFunctionResult("duels", [
    row.a ?? A,
    row.b ?? B,
    row.invited ?? ZeroAddress,
    row.stake ?? 100_000n,
    row.fullAt ?? 1_756_000_000,
    status,
    row.aWithdrawn ?? false,
    row.bWithdrawn ?? false,
  ]);
}

/** The zero slot: what an id nobody has opened decodes to. Every field of an
 *  unwritten mapping entry reads back as zero, including the status. */
const UNUSED_SLOT = `0x${"0".repeat(64 * 8)}`;

// ─── the fake chain ──────────────────────────────────────────────────────────

interface FakeChain {
  provider: SeatProvider;
  /** Every `call` made, in order — so a test can assert that no call happened
   *  at all, which is half the disposition table. */
  calls: { to: string; data: string }[];
}

/**
 * A provider that answers with whatever `answer` returns for the call number.
 *
 * It is a bare object literal on purpose: `SeatProvider` is one method, so this
 * is the entire surface `seats.ts` is allowed to touch. There is no
 * `sendTransaction` here to accidentally call, which is the point of narrowing
 * the seam that far in the first place.
 */
function chain(answer: string | ((n: number) => string | Promise<string>)): FakeChain {
  const calls: { to: string; data: string }[] = [];
  return {
    calls,
    provider: {
      call: (tx) => {
        calls.push({ to: tx.to, data: tx.data });
        if (typeof answer === "string") return Promise.resolve(answer);
        return Promise.resolve(answer(calls.length - 1));
      },
    },
  };
}

/** A reader over a fake chain, with a clock a test can move. */
function reader(fake: FakeChain, at = { t: T0 }) {
  return createSeatReader({
    provider: fake.provider,
    escrow: ESCROW_ADDRESS,
    now: () => at.t,
  });
}

function okSeats(e: SeatsEnvelope): SeatsOk {
  if (!e.ok) throw new Error(`read failed: ${e.reason}`);
  return e;
}

function missReason(e: SeatsEnvelope): string {
  if (e.ok) throw new Error(`expected a miss, got ${JSON.stringify(e)}`);
  return e.reason;
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the reader speaks the committed contract's ABI", () => {
  test("the artifact really was read, so nothing below is vacuous", () => {
    expect(SOURCE_STATUSES).toEqual(["NONE", "OPEN", "FULL", "SETTLED", "REFUNDED"]);
    expect(ESCROW.getFunction("duels")).toBeTruthy();
  });

  test("the status names and ordinals are the contract's, in the contract's order", () => {
    // A member inserted into the middle of the Solidity enum renumbers every
    // one after it. This is the assertion that would catch that.
    expect(SEAT_STATUSES.join(",")).toBe(SOURCE_STATUSES.join(","));
  });

  test("the calldata is exactly what the artifact encodes for duels(duelId)", async () => {
    const fake = chain(duelsResult());
    await reader(fake).read(DUEL_ID);

    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]!.to).toBe(ESCROW_ADDRESS);
    expect(fake.calls[0]!.data).toBe(ESCROW.encodeFunctionData("duels", [DUEL_ID]));
    // Selector + one word, and nothing else on the wire.
    expect(fake.calls[0]!.data).toHaveLength(2 + 8 + 64);
  });

  test("the seats are decoded in the contract's field order, not a plausible one", async () => {
    // The mistake this exists to catch: `a` and `b` transposed in the
    // transcribed signature. Both are addresses, so nothing else would notice —
    // and a transposed reader would bless exactly the swap X-1 is about.
    const seats = okSeats(await reader(chain(duelsResult({ a: A, b: B }))).read(DUEL_ID));
    expect(seats.a).toBe(A);
    expect(seats.b).toBe(B);
    expect(seats.status).toBe("FULL");
  });

  test("addresses come back EIP-55 checksummed", async () => {
    const lower = A.toLowerCase();
    const seats = okSeats(await reader(chain(duelsResult({ a: lower }))).read(DUEL_ID));
    expect(seats.a).toBe(A);
    expect(seats.a).not.toBe(lower);
  });
});

describe("every duel state the escrow can be in", () => {
  test("FULL — both seats, which is the only state a lock can bind to", async () => {
    const seats = okSeats(await reader(chain(duelsResult({ status: "FULL" }))).read(DUEL_ID));
    expect(seats).toEqual({ ok: true, a: A, b: B, status: "FULL" });
  });

  test("OPEN — the opener is known and `b` is null, not the zero address", async () => {
    // `join` has not run, so `d.b` is still zero. A caller must never have to
    // compare against `0x000…0` to notice that nobody has joined.
    const seats = okSeats(await reader(chain(duelsResult({ status: "OPEN", b: ZeroAddress }))).read(DUEL_ID));
    expect(seats).toEqual({ ok: true, a: A, b: null, status: "OPEN" });
  });

  test("SETTLED and REFUNDED are reported, not hidden", async () => {
    // Policy lives next to the lock that refuses; the reader's job is to report
    // the chain faithfully, including states nobody should be locking on.
    for (const status of ["SETTLED", "REFUNDED"] as const) {
      const seats = okSeats(await reader(chain(duelsResult({ status }))).read(DUEL_ID));
      expect(seats.status).toBe(status);
      expect(seats.a).toBe(A);
    }
  });

  test("a cancelled duel is REFUNDED with no joiner at all", async () => {
    // `cancel` (DuelEscrow.sol) moves an unjoined duel straight to REFUNDED, so
    // a null `b` is NOT implied by the status and must not be inferred from it.
    const seats = okSeats(await reader(chain(duelsResult({ status: "REFUNDED", b: ZeroAddress }))).read(DUEL_ID));
    expect(seats).toEqual({ ok: true, a: A, b: null, status: "REFUNDED" });
  });

  test("an id nobody has opened is a typed miss, not an empty duel", async () => {
    // The zero slot: status NONE and three zero addresses. Answering `a: 0x0`
    // here would be worse than useless — a caller comparing addresses would be
    // comparing against a value anyone can put in a request body.
    expect(missReason(await reader(chain(UNUSED_SLOT)).read(DUEL_ID))).toBe("seats not on chain");
    expect(missReason(await reader(chain(duelsResult({ status: "NONE" }))).read(DUEL_ID))).toBe(
      "seats not on chain",
    );
  });
});

describe("a chain it cannot read is a refusal, never a guess", () => {
  test("a provider that rejects is `chain unreachable`", async () => {
    const calls: number[] = [];
    const provider: SeatProvider = {
      call: () => {
        calls.push(1);
        return Promise.reject(new Error("fetch failed: https://base.example/v2/SUPER_SECRET_KEY"));
      },
    };
    const r = createSeatReader({ provider, escrow: ESCROW_ADDRESS, now: () => T0 });
    const res = await r.read(DUEL_ID);
    expect(res).toEqual({ ok: false, reason: "chain unreachable" });
    // The RPC URL carries an API key and the provider's message carries the URL.
    // Nothing from that error may reach an envelope a player can read.
    expect(JSON.stringify(res)).not.toContain("SUPER_SECRET");
  });

  test("a transport failure is NOT cached — the retry has to be a real one", async () => {
    // A blip that outlived itself would refuse honest locks long after the RPC
    // came back. Only "no such duel" is worth remembering.
    const fake = chain((n) => (n === 0 ? Promise.reject(new Error("429")) : duelsResult()));
    const r = reader(fake);
    expect(missReason(await r.read(DUEL_ID))).toBe("chain unreachable");
    expect(okSeats(await r.read(DUEL_ID)).a).toBe(A);
    expect(fake.calls).toHaveLength(2);
  });

  test("a read that never answers times out into the same refusal", async () => {
    // A hung fetch inside a request a player is waiting on is worse than a
    // refusal: they get nothing and can do nothing. `timeoutMs` is injected so
    // this costs milliseconds instead of the production four seconds.
    const provider: SeatProvider = { call: () => new Promise<string>(() => {}) };
    const r = createSeatReader({ provider, escrow: ESCROW_ADDRESS, timeoutMs: 10, now: () => T0 });
    expect(missReason(await r.read(DUEL_ID))).toBe("chain unreachable");
  });

  test("an address with no contract at it answers `0x`, and that is not a duel", async () => {
    expect(missReason(await reader(chain("0x")).read(DUEL_ID))).toBe("bad chain response");
  });

  test("a truncated or nonsense answer is refused rather than half-decoded", async () => {
    for (const junk of [`0x${"11".repeat(31)}`, `0x${"22".repeat(96)}1234`, "not hex at all"]) {
      expect(missReason(await reader(chain(junk)).read(DUEL_ID))).toBe("bad chain response");
    }
  });

  test("a status ordinal this contract cannot produce means it is not this contract", async () => {
    for (const ordinal of [SEAT_STATUSES.length, 42, 255]) {
      expect(missReason(await reader(chain(duelsResult({ status: ordinal }))).read(DUEL_ID))).toBe(
        "bad chain response",
      );
    }
  });

  test("a live status with a zero opener is impossible, so it is refused", async () => {
    // The contract writes `d.a` in `open` and never clears it. A FULL duel with
    // no opener is a proxy, a mock or a mistake — never a duel.
    expect(missReason(await reader(chain(duelsResult({ a: ZeroAddress, status: "FULL" }))).read(DUEL_ID))).toBe(
      "bad chain response",
    );
  });

  test("a duel id that is not one never reaches the network", async () => {
    const fake = chain(duelsResult());
    const r = reader(fake);
    for (const bad of ["", "0x", DUEL_ID.slice(0, -1), `${DUEL_ID}00`, "kz-semis:424242"]) {
      expect(missReason(await r.read(bad))).toBe("bad duelId");
    }
    expect(fake.calls).toEqual([]);
  });

  test("nothing the provider can do makes the reader throw", async () => {
    const throwers: SeatProvider[] = [
      {
        call: () => {
          throw new Error("synchronous explosion");
        },
      },
      { call: () => Promise.reject("a string, not an Error") },
      { call: () => Promise.resolve(undefined as unknown as string) },
      { call: () => Promise.resolve(null as unknown as string) },
    ];
    for (const provider of throwers) {
      const res = await createSeatReader({ provider, escrow: ESCROW_ADDRESS, now: () => T0 }).read(DUEL_ID);
      expect(res.ok).toBe(false);
    }
  });
});

describe("unconfigured is a mode, and it is inert", () => {
  test("no escrow address means no reader, and no call is ever made", async () => {
    const fake = chain(duelsResult());
    const r = createSeatReader({ provider: fake.provider, escrow: "", rpcUrl: "", now: () => T0 });
    expect(r.configured).toBe(false);
    expect(r.escrow).toBeNull();
    expect(missReason(await r.read(DUEL_ID))).toBe("seats not configured");
    expect(fake.calls).toEqual([]);
  });

  test("a malformed escrow address is no escrow, not a mangled one", async () => {
    for (const bad of ["0xnope", "not-an-address", "0x1234"]) {
      const r = createSeatReader({ provider: chain(duelsResult()).provider, escrow: bad, now: () => T0 });
      expect(r.configured).toBe(false);
      expect(missReason(await r.read(DUEL_ID))).toBe("seats not configured");
    }
  });

  test("an escrow with no RPC and no provider is unconfigured too", async () => {
    // The half-configured case: an address to read, nothing to read it with.
    // There is deliberately no public-endpoint fallback — a throttled read
    // fails closed and refuses honest locks, which is worse than not binding.
    const r = createSeatReader({ escrow: ESCROW_ADDRESS, rpcUrl: "", now: () => T0 });
    expect(r.configured).toBe(false);
    expect(missReason(await r.read(DUEL_ID))).toBe("seats not configured");
  });

  test("a configured reader says which deployment it is reading", async () => {
    const r = createSeatReader({ provider: chain(duelsResult()).provider, escrow: ESCROW_ADDRESS.toLowerCase() });
    expect(r.configured).toBe(true);
    expect(r.escrow).toBe(ESCROW_ADDRESS);
  });
});

describe("the cache is bounded, and it caches what cannot change", () => {
  test("a duel with both seats is read once and reused", async () => {
    const fake = chain(duelsResult());
    const at = { t: T0 };
    const r = reader(fake, at);

    expect(okSeats(await r.read(DUEL_ID)).a).toBe(A);
    expect(okSeats(await r.read(DUEL_ID)).a).toBe(A);
    // Same duel asked for in a different casing is the same cache entry.
    expect(okSeats(await r.read(DUEL_ID.toUpperCase().replace("0X", "0x"))).a).toBe(A);
    expect(fake.calls).toHaveLength(1);

    // …and it does not outlive its TTL, long as that is.
    at.t += SEATS_TTL_MS;
    await r.read(DUEL_ID);
    expect(fake.calls).toHaveLength(2);
  });

  test("`b` cannot change once it is set, which is what makes the long TTL safe", async () => {
    // The reason a joined duel may be cached for ten minutes: `open` writes
    // `d.a` once, `join` writes `d.b` once, and no function in the escrow ever
    // writes either again. Only `status` moves, and a stale FULL can at worst
    // store a commit for a duel that just left FULL — a wasted commit, never a
    // wrong payee.
    expect(SEATS_TTL_MS).toBeGreaterThan(SEATS_OPEN_TTL_MS);
    expect(/d\.b = msg\.sender;/.test(SOURCE)).toBe(true);
    expect(SOURCE.match(/d\.b = /g) ?? []).toHaveLength(1);
    expect(SOURCE.match(/d\.a = /g) ?? []).toHaveLength(1);
  });

  test("a duel still waiting for its opponent is cached only briefly", async () => {
    const fake = chain((n) => duelsResult(n === 0 ? { status: "OPEN", b: ZeroAddress } : { status: "FULL" }));
    const at = { t: T0 };
    const r = reader(fake, at);

    expect(okSeats(await r.read(DUEL_ID)).status).toBe("OPEN");
    at.t += SEATS_OPEN_TTL_MS - 1;
    expect(okSeats(await r.read(DUEL_ID)).status).toBe("OPEN");
    expect(fake.calls).toHaveLength(1);

    // The opponent lands, and the reader notices within a block or two rather
    // than making an honest lock wait out a ten-minute entry.
    at.t += 1;
    expect(okSeats(await r.read(DUEL_ID)).status).toBe("FULL");
    expect(fake.calls).toHaveLength(2);
  });

  test("`no such duel` is cached for seconds, so opening and locking can race", async () => {
    const fake = chain((n) => (n === 0 ? UNUSED_SLOT : duelsResult()));
    const at = { t: T0 };
    const r = reader(fake, at);

    expect(missReason(await r.read(DUEL_ID))).toBe("seats not on chain");
    at.t += SEATS_MISS_TTL_MS - 1;
    expect(missReason(await r.read(DUEL_ID))).toBe("seats not on chain");
    expect(fake.calls).toHaveLength(1);

    at.t += 1;
    expect(okSeats(await r.read(DUEL_ID)).a).toBe(A);
    expect(SEATS_MISS_TTL_MS).toBeLessThan(SEATS_TTL_MS);
  });

  test("the cache is bounded and evicts oldest-first", async () => {
    // A long-lived server must not hold one entry per duel it has ever seen.
    // 200 is the ceiling both news caches and the lock store use.
    const fake = chain(duelsResult());
    const r = reader(fake);

    const first = id("duel-0");
    await r.read(first);
    for (let i = 1; i <= 200; i += 1) await r.read(id(`duel-${i}`));
    expect(fake.calls).toHaveLength(201);

    // The oldest entry is gone; a hot one is not.
    await r.read(first);
    expect(fake.calls).toHaveLength(202);
    await r.read(id("duel-200"));
    expect(fake.calls).toHaveLength(202);
  });

  test("two duels are two entries, and neither answers for the other", async () => {
    const fake = chain((n) => duelsResult(n === 0 ? { a: A, b: B } : { a: B, b: A }));
    const r = reader(fake);
    expect(okSeats(await r.read(DUEL_ID)).a).toBe(A);
    expect(okSeats(await r.read(OTHER_ID)).a).toBe(B);
    expect(fake.calls).toHaveLength(2);
  });
});
