/**
 * The referee, offline.
 *
 * `src/server/attest.ts` is the only module in the repo that holds the attestor
 * key and the only one that decides who won a duel. Everything below runs the
 * real service — the real `parseMatchKey`, the real commit store, the real
 * mirror of `useMatch`'s `derived`, the real `signTypedData` — with exactly two
 * things replaced: the signer is a throwaway `Wallet` that exists only in this
 * file, and the clock is a variable. No chain, no key file, no network.
 *
 * Three properties are worth more than the rest, and each has its own section:
 *
 *   1. **First write wins.** A second `/api/lock` on the same match returns the
 *      FIRST payload untouched. Without that, a player who watched the tape run
 *      could re-lock a winning slip and the server would cheerfully sign it.
 *
 *   2. **The digest is the contract's digest.** The domain strings and the
 *      struct type below are read out of `contracts/DuelEscrow.sol` itself, the
 *      digest is rebuilt from them by hand *and* by `TypedDataEncoder`, and the
 *      attestor is recovered from the service's own signature against that
 *      independently built digest. This is the one thing in the whole phase that
 *      is offline-testable and burns real money if it is wrong: a signature over
 *      a digest the escrow does not compute is rejected on chain *after* both
 *      stakes are locked, leaving the six-hour timeout as the only way out.
 *
 *   3. **The winner is derived, never read.** `/api/attest` takes a match key
 *      and nothing else; a `winner` in the body is ignored. The same seed with
 *      two different committed slips produces two different winners, and the
 *      test computes both independently from the same pure engine functions the
 *      client rendered the result screen with.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AbiCoder,
  Signature,
  TypedDataEncoder,
  Interface,
  Wallet,
  concat,
  getAddress,
  getBytes,
  id,
  keccak256,
  recoverAddress,
  toUtf8Bytes,
  verifyMessage,
  verifyTypedData,
} from "ethers";
import { LOBBIES, bookOf } from "../src/data/lobbies.ts";
import { MODES, MODE_SALT } from "../src/data/modes.ts";
import { settle } from "../src/engine/match.ts";
import { PARLAY_CARDS, cardById, legForCard, type ParlayCard } from "../src/engine/parlay.ts";
import { seededRandom, spinCase } from "../src/engine/spin.ts";
import {
  SEAT_STATUSES,
  createSeatReader,
  type SeatProvider,
  type SeatReader,
} from "../src/server/seats.ts";
import {
  SCORE_DP,
  duelScore,
  type FilledLeg,
  type Usd,
  type UsdPerContract,
} from "../src/engine/score.ts";
import {
  SIGNING_CHAIN_ID,
  DEADLINE_SECONDS,
  FILLS_MESSAGE_PREFIX,
  MARK_MAX_LAG_MS,
  MAX_ENDS_AT_SKEW_MS,
  VERDICT_DOMAIN_NAME,
  VERDICT_DOMAIN_VERSION,
  LOCK_MESSAGE_PREFIX,
  VERDICT_TYPES,
  canonicalLegs,
  createAttestService,
  deriveVerdict,
  fillsCommitOf,
  fillsMessage,
  lockMessage,
  marksFromSnapshot,
  usdMarksFromSnapshot,
  type AttestEnvelope,
  type AttestFail,
  type AttestOk,
  type AttestService,
  type LockEnvelope,
  type LockOk,
  type MarkSnapshot,
  type MarkSource,
  type StatusEnvelope,
  type StatusOk,
  type TypedDataSigner,
} from "../src/server/attest.ts";

// ─── the throwaway attestor ──────────────────────────────────────────────────

/**
 * A key that exists nowhere but this file, derived from a sentence so the suite
 * stays deterministic without a fixture to keep in sync. It signs typed data in
 * memory and is never written, logged or funded — the production attestor is a
 * different EOA entirely, read from `ATTESTOR_PRIVATE_KEY` inside the service.
 */
const ATTESTOR = new Wallet(id("thetaduel test attestor — not a real key"));

/** A stand-in deployment. All-digit, so its checksum form is its literal form
 *  and nothing here can drift on case. */
const ESCROW = "0x1111111111111111111111111111111111111111";

/**
 * The three seats, as KEYS rather than literal addresses.
 *
 * They used to be `0x2222…`-style literals, which was enough while `/api/lock`
 * believed whatever `a` a request claimed. It no longer does (finding X-1): a
 * lock carries an EIP-191 signature by `a` over the canonical message, so a
 * seat in this file has to be something that can actually sign. Same shape as
 * `ATTESTOR` — derived from a sentence, in memory, never written or funded.
 */
const SEAT_A = new Wallet(id("thetaduel test seat a"));
const SEAT_B = new Wallet(id("thetaduel test seat b"));
const SEAT_S = new Wallet(id("thetaduel test stranger"));

const A = SEAT_A.address;
const B = SEAT_B.address;
const STRANGER = SEAT_S.address;

/** A round wall-clock instant, so every deadline in the file is readable. */
const T0 = 1_756_000_000_000;

// ─── the fixture duel ────────────────────────────────────────────────────────

/**
 * `kz-semis` at seed 424242 — the same lobby and seed `test/app.test.tsx` and
 * `test/determinism.test.ts` pin, so a change that re-deals this match breaks
 * those suites first and this one for the same reason.
 */
const LOBBY_ID = "kz-semis";
const SEED = 424242;
const MATCH_KEY = `${LOBBY_ID}:${SEED}`;
const LOBBY = LOBBIES.find((l) => l.id === LOBBY_ID)!;
const ARENA = spinCase(bookOf(LOBBY), LOBBY.legs, SEED).syms;

/** Two slips on that one seed, chosen because they land on opposite sides of
 *  `settle`. Nothing about them is asserted from memory — every test that uses
 *  one re-derives its winner below. */
const WINNING_SLIP: Record<string, string> = { SOL: "safe-bear", XRP: "safe-bull", BNB: "safe-bull" };
const LOSING_SLIP: Record<string, string> = { SOL: "safe-bull", XRP: "safe-bull", BNB: "safe-bull" };

/**
 * The client's verdict, recomputed here from the pure engine — NOT from
 * `deriveVerdict`, which is the thing under test.
 *
 * This is a second transcription of `src/state/match.ts`'s `derived` memo
 * (:361-406). Two independent transcriptions agreeing is the only offline
 * evidence that the server pays the player the result screen said won.
 */
function independentlyDerivedMeWins(seed: number, picks: Record<string, string>): boolean {
  const spec = MODES[LOBBY.mode];
  const arena = spinCase(bookOf(LOBBY), LOBBY.legs, seed).syms;

  const oppRandom = seededRandom(seed ^ 0x5bd1e995);
  const oppPicks: Record<string, ParlayCard> = {};
  for (const sym of arena) {
    oppPicks[sym] = PARLAY_CARDS[Math.floor(oppRandom() * PARLAY_CARDS.length)]!;
  }

  const myLegs = arena.map((sym) => legForCard(sym, cardById(picks[sym])!, spec.targetScale));
  const oppLegs = arena.map((sym) => legForCard(sym, oppPicks[sym]!, spec.targetScale));
  const fightSalt = 2 + seed * 3 + MODE_SALT[spec.key];

  return settle(myLegs, oppLegs, arena, fightSalt, spec.settleAt, "You", "Opponent").meWins;
}

/** Whoever that verdict pays, given which seat committed the slip. */
const expectedWinner = (picks: Record<string, string>, a = A, b = B): string =>
  independentlyDerivedMeWins(SEED, picks) ? a : b;

// ─── harness ─────────────────────────────────────────────────────────────────

interface SignedCall {
  domain: { name: string; version: string; chainId: number | bigint; verifyingContract: string };
  types: Record<string, readonly { name: string; type: string }[]>;
  value: Record<string, unknown>;
}

interface Harness {
  svc: AttestService;
  /** Every `signTypedData` the service made, in order — so a test can assert on
   *  what was signed, not merely on what came back. */
  signed: SignedCall[];
  /** Move the fake clock. Milliseconds. */
  advance(ms: number): void;
}

/**
 * A service on the throwaway key, a fake clock and a fake escrow address.
 *
 * `seats` is the second argument rather than a second harness because every
 * property in this file — first-write-wins, the signature, the digest, the
 * derivation — has to hold identically with and without a chain behind it.
 * Defaulting it to `null` is what keeps the whole suite above chain-free.
 */
function harness(
  at = T0,
  seats: SeatReader | null = null,
  marks: MarkSource | null = null,
): Harness {
  let clock = at;
  const signed: SignedCall[] = [];

  const signer: TypedDataSigner = {
    getAddress: () => ATTESTOR.getAddress(),
    signTypedData: (domain, types, value) => {
      signed.push({ domain, types, value });
      return ATTESTOR.signTypedData(
        domain,
        types as unknown as Record<string, { name: string; type: string }[]>,
        value,
      );
    },
  };

  return {
    // Passing `seats` EXPLICITLY — `null` by default — says out loud that this
    // service does no chain read. It is not decoration: omitting the field
    // entirely would have the service build a seat reader from the environment,
    // and `bun test` runs with `.env` loaded, so a developer with a real
    // `RPC_URL` and `THETADUEL_ESCROW` exported would silently be running this
    // suite against Base.
    // `marks` is passed explicitly for the same reason `seats` is, and it is
    // `null` by default: omitting it would have the service build a market
    // source over the live Thetanuts pricing host on the first duel-clock
    // attest. Every test in this file that means "no book" therefore says so,
    // and every test that means "this book" hands over a frozen one.
    svc: createAttestService({ signer, escrow: ESCROW, seats, marks, now: () => clock }),
    signed,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

/** Narrow an envelope, and fail with the reason rather than a type error. */
function okLock(e: LockEnvelope): LockOk {
  if (!e.ok) throw new Error(`lock failed: ${e.reason}`);
  return e;
}
function okAttest(e: AttestEnvelope): AttestOk {
  if (!e.ok) throw new Error(`attest failed: ${e.reason}`);
  return e;
}
function okStatus(e: StatusEnvelope): StatusOk {
  if (!e.ok) throw new Error(`status failed: ${e.reason}`);
  return e;
}

/**
 * A lock body, signed by whichever seat is claiming `a`.
 *
 * Everything the service authenticates goes through here, so a test that wants
 * to attack the signature does it by tampering with the RESULT of this call —
 * which is exactly the attacker's position: they have a valid signature over
 * one payload and want it to authorise another.
 */
function lockBody(
  wallet: Wallet,
  opts: { matchKey?: string; picks?: Record<string, string>; b?: string | null } = {},
): Record<string, unknown> {
  const matchKey = opts.matchKey ?? MATCH_KEY;
  const picks = opts.picks ?? WINNING_SLIP;
  const b = opts.b === undefined ? B : opts.b;
  return {
    matchKey,
    picks,
    a: wallet.address,
    ...(b ? { b } : {}),
    sig: wallet.signMessageSync(lockMessage(matchKey, wallet.address, b, picks)),
  };
}

/** A committed duel, ready to attest. Seat `a` signs its own lock. */
async function locked(
  h: Harness,
  picks: Record<string, string> = WINNING_SLIP,
  b: string | null = B,
): Promise<LockOk> {
  return okLock(await h.svc.lock(lockBody(SEAT_A, { picks, b })));
}

const post = (body: unknown): Request =>
  new Request("http://localhost/api/lock", { method: "POST", body: JSON.stringify(body) });

// ─── the contract's own constants ────────────────────────────────────────────

/**
 * Read out of `contracts/DuelEscrow.sol`, not out of `attest.ts`.
 *
 * The whole point of this file's money test is that neither side is allowed to
 * be the definition of the other. The contract folds three literal strings into
 * its `DOMAIN_SEPARATOR` at construction (:231-239) and one into
 * `VERDICT_TYPEHASH` (:161-162); those four strings are lifted here verbatim and
 * every digest below is built from them.
 */
const SOURCE = readFileSync(join(import.meta.dir, "..", "contracts", "DuelEscrow.sol"), "utf8");

const VERDICT_TYPE_STRING = /keccak256\(\s*"(Verdict\([^"]*\))"\s*\)/.exec(SOURCE)?.[1] ?? "";

/** The three `keccak256("…")` literals inside the constructor's `abi.encode`,
 *  in the order solc hashes them: the domain type, the name, the version. */
const DOMAIN_LITERALS = [
  ...SOURCE.slice(SOURCE.indexOf("DOMAIN_SEPARATOR = keccak256(")).matchAll(/keccak256\("([^"]*)"\)/g),
].map((m) => m[1]!);
const [DOMAIN_TYPE_STRING, CONTRACT_DOMAIN_NAME, CONTRACT_DOMAIN_VERSION] = DOMAIN_LITERALS;

/**
 * `Verdict(bytes32 duelId,address winner,uint64 deadline)` → the ethers types
 * object. Derived from the contract's string rather than typed out again, so a
 * field renamed or reordered in Solidity changes what this test signs against
 * and the comparison below fails — which is exactly the drift that would
 * otherwise be discovered on mainnet.
 */
function typesFromTypeString(typeString: string): Record<string, { name: string; type: string }[]> {
  const m = /^(\w+)\((.*)\)$/.exec(typeString);
  if (!m) throw new Error(`not a struct type string: ${typeString}`);
  const fields = m[2]!.split(",").map((f) => {
    const [type, name] = f.trim().split(/\s+/);
    return { name: name!, type: type! };
  });
  return { [m[1]!]: fields };
}

const CONTRACT_TYPES = typesFromTypeString(VERDICT_TYPE_STRING);

const contractDomain = (verifyingContract: string) => ({
  name: CONTRACT_DOMAIN_NAME!,
  version: CONTRACT_DOMAIN_VERSION!,
  // The contract uses `block.chainid`, which no source read can produce. Base
  // mainnet is the only chain it is ever deployed to (plan 5: "no testnet
  // exists"), and the assertion that this constant IS 8453 is its own test.
  chainId: BigInt(SIGNING_CHAIN_ID),
  verifyingContract,
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the fixture duel is the one the rest of the repo pins", () => {
  test("kz-semis at seed 424242 deals SOL, XRP, BNB", () => {
    // If this changes, the two slips below stop being a win and a loss and
    // every "verdict flips" assertion becomes vacuous.
    expect([...ARENA]).toEqual(["SOL", "XRP", "BNB"]);
    expect(Object.keys(WINNING_SLIP).sort()).toEqual([...ARENA].sort());
    expect(Object.keys(LOSING_SLIP).sort()).toEqual([...ARENA].sort());
  });

  test("the two slips genuinely land on opposite sides of settle", () => {
    expect(independentlyDerivedMeWins(SEED, WINNING_SLIP)).toBe(true);
    expect(independentlyDerivedMeWins(SEED, LOSING_SLIP)).toBe(false);
  });

  test("deriveVerdict agrees with an independent transcription of the client memo", () => {
    // The server's mirror of `useMatch`'s `derived` against a second one written
    // out in this file. Two transcriptions agreeing is what stands between the
    // result screen and the escrow paying someone else.
    for (const picks of [WINNING_SLIP, LOSING_SLIP]) {
      const d = deriveVerdict(LOBBY, SEED, picks);
      expect(d.meWins).toBe(independentlyDerivedMeWins(SEED, picks));
      expect([...d.arena]).toEqual([...ARENA]);
      expect(d.fightSalt).toBe(2 + SEED * 3 + MODE_SALT[MODES[LOBBY.mode].key]);
      expect(d.studySalt).toBe(1 + SEED * 3 + MODE_SALT[MODES[LOBBY.mode].key]);
      expect(d.settleAt).toBe(MODES[LOBBY.mode].settleAt);
    }
  });
});

describe("lock commits a slip, first write wins", () => {
  test("a first lock returns the duel id, the commit and no note", async () => {
    const res = await locked(harness());
    expect(res.duelId).toBe(id(MATCH_KEY));
    expect(res.duelId).toBe(keccak256(toUtf8Bytes(MATCH_KEY)));
    expect(res.matchKey).toBe(MATCH_KEY);
    expect(res.commit).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.note).toBeUndefined();
  });

  test("a second lock on the same match returns the FIRST payload and says so", async () => {
    const h = harness();
    const first = await locked(h, WINNING_SLIP);

    // Different picks, different seats, later in time, and PROPERLY SIGNED by
    // the seat it claims — the whole point is that none of it can touch what is
    // already committed. Authentication (X-1) and idempotency are separate
    // defences and this asserts the second one on its own.
    h.advance(60_000);
    const second = okLock(await h.svc.lock(lockBody(SEAT_S, { picks: LOSING_SLIP, b: A })));

    expect(second.commit).toBe(first.commit);
    expect(second.duelId).toBe(first.duelId);
    expect(second.matchKey).toBe(first.matchKey);
    expect(second.note).toBe("already locked");
  });

  test("the re-lock cannot change who gets paid", async () => {
    // The idempotency above is bookkeeping; this is the money consequence of it.
    // A player who watched the tape decide against them re-locks the winning
    // slip under their own address, and the verdict does not move.
    const h = harness();
    await locked(h, LOSING_SLIP);
    await h.svc.lock(lockBody(SEAT_S, { picks: WINNING_SLIP, b: A }));

    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(res.winner).toBe(expectedWinner(LOSING_SLIP));
    expect(res.winner).toBe(B);
  });

  test("a malformed second lock cannot evict the first either", async () => {
    const h = harness();
    const first = await locked(h);
    await h.svc.lock({ matchKey: MATCH_KEY, picks: { NOPE: "safe-bull" }, a: STRANGER });
    await h.svc.lock({ matchKey: MATCH_KEY });
    expect(okLock(await h.svc.lock(lockBody(SEAT_A, { picks: LOSING_SLIP }))).commit).toBe(first.commit);
  });

  test("the commit is canonical: key order in the request cannot change it", async () => {
    const forwards = await locked(harness(), { SOL: "safe-bear", XRP: "safe-bull", BNB: "safe-bull" });
    const backwards = await locked(harness(), { BNB: "safe-bull", XRP: "safe-bull", SOL: "safe-bear" });
    expect(backwards.commit).toBe(forwards.commit);
    // …but a different slip is a different commit.
    expect((await locked(harness(), LOSING_SLIP)).commit).not.toBe(forwards.commit);
  });
});

describe("lock refuses everything it cannot re-derive", () => {
  const fails = async (body: unknown): Promise<string> => {
    const res = await harness().svc.lock(body);
    if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res)}`);
    return res.reason;
  };

  test("an unknown lobby — a room published in someone's own browser is unsettleable", async () => {
    // `mine-1` exists in exactly one tab (state/match.ts:298). The server cannot
    // re-derive its book, its legs or its mode, so it must not sign for it.
    expect(await fails({ matchKey: `mine-1:${SEED}`, picks: WINNING_SLIP, a: A, b: B })).toContain(
      "unknown lobby",
    );
    expect(await fails({ matchKey: `not-a-lobby:${SEED}`, picks: WINNING_SLIP, a: A, b: B })).toContain(
      "unknown lobby",
    );
  });

  test("a seed outside the range the game can deal", async () => {
    // `newSeed` mints 100000..999999 (engine/spin.ts:52-54). `parseRoute` would
    // read `?seed=7` out of a hand-typed URL; a duel with USDC behind it is not
    // where that gets accepted.
    for (const seed of [7, 99_999, 1_000_000, 424_242_424]) {
      expect(await fails({ matchKey: `${LOBBY_ID}:${seed}`, picks: WINNING_SLIP, a: A, b: B })).toBe("bad seed");
    }
    expect(await fails({ matchKey: `${LOBBY_ID}:-424242`, picks: WINNING_SLIP, a: A, b: B })).toBe("bad seed");
    expect(await fails({ matchKey: `${LOBBY_ID}:4242.42`, picks: WINNING_SLIP, a: A, b: B })).toBe("bad seed");
  });

  test("a pick id that is not one of the eight cards", async () => {
    for (const bad of ["safe-bulll", "SAFE-BULL", "", "godmode"]) {
      const picks = { ...WINNING_SLIP, SOL: bad };
      expect(await fails({ matchKey: MATCH_KEY, picks, a: A, b: B })).toContain("unknown card");
    }
    // Every real card id passes the same gate.
    for (const card of PARLAY_CARDS) {
      const res = await harness().svc.lock(lockBody(SEAT_A, { picks: { ...WINNING_SLIP, SOL: card.id } }));
      expect(res.ok).toBe(true);
    }
  });

  test("keys that are not exactly the symbols this seed dealt", async () => {
    const want = "picks must cover exactly";
    // A leg short: the client would have previewed it at EVEN/over — a preview
    // is not a position and a partial slip is not settleable.
    expect(await fails({ matchKey: MATCH_KEY, picks: { SOL: "safe-bull", XRP: "safe-bull" }, a: A, b: B })).toContain(want);
    // One leg too many: a caller widening the commit past the arena.
    expect(
      await fails({ matchKey: MATCH_KEY, picks: { ...WINNING_SLIP, AVAX: "safe-bull" }, a: A, b: B }),
    ).toContain(want);
    // The right count, the wrong tickers.
    expect(
      await fails({ matchKey: MATCH_KEY, picks: { ETH: "safe-bull", BTC: "safe-bull", AVAX: "safe-bull" }, a: A, b: B }),
    ).toContain(want);
    // And the arena of a DIFFERENT seed in the same lobby.
    const other = spinCase(bookOf(LOBBY), LOBBY.legs, 424243).syms;
    if (JSON.stringify([...other].sort()) !== JSON.stringify([...ARENA].sort())) {
      const picks = Object.fromEntries(other.map((s) => [s, "safe-bull"]));
      expect(await fails({ matchKey: MATCH_KEY, picks, a: A, b: B })).toContain(want);
    }
  });

  test("a missing or unparseable committing address", async () => {
    expect(await fails({ matchKey: MATCH_KEY, picks: WINNING_SLIP })).toBe("missing a");
    expect(await fails({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: "0xnope" })).toBe("bad a");
    expect(await fails({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: "0xnope" })).toBe("bad b");
    // The zero address is never a seat that can be paid.
    expect(await fails({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: `0x${"0".repeat(40)}` })).toBe("bad a");
  });

  test("a match key that is not one", async () => {
    expect(await fails({ picks: WINNING_SLIP, a: A })).toBe("missing matchKey");
    expect(await fails({ matchKey: "   ", picks: WINNING_SLIP, a: A })).toBe("missing matchKey");
    expect(await fails({ matchKey: 424242, picks: WINNING_SLIP, a: A })).toBe("missing matchKey");
    expect(await fails({ matchKey: `${LOBBY_ID}:${SEED}<script>`, picks: WINNING_SLIP, a: A })).toBe("bad matchKey");
    expect(await fails({ matchKey: `${"x".repeat(200)}:${SEED}`, picks: WINNING_SLIP, a: A })).toBe("matchKey too long");
    expect(await fails({ matchKey: LOBBY_ID, picks: WINNING_SLIP, a: A })).toBe("bad matchKey");
  });

  test("addresses come back checksummed, whatever case they arrived in", async () => {
    const h = harness();
    // Lower-case in the body, checksummed in the signed message — the
    // canonical message normalises, so one signature covers both spellings and
    // a client is not forced to reproduce EIP-55 casing to be believed.
    okLock(
      await h.svc.lock({
        ...lockBody(SEAT_A, { picks: LOSING_SLIP }),
        a: A.toLowerCase(),
        b: B.toLowerCase(),
      }),
    );
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(res.winner).toBe(getAddress(B));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * FINDING X-1 — the lock must prove it is `a`'s.
 *
 * `docs/reviews/escrow-adversarial-review.md`. Commit-then-derive pinned the
 * slip but not its owner: `a`, `b` and `picks` all arrived unauthenticated, so
 * anyone who knew the match key could search the ≤ 4 096 reachable slips
 * offline for a winning one, `POST` it naming themselves `a`, and this server
 * would honestly sign a verdict paying them — which the escrow would honour,
 * because its only payee rule is `winner ∈ {a, b}` and that held.
 *
 * Each test below is one step of that exploit, refused.
 */
describe("the lock is authenticated — X-1", () => {
  const refused = async (body: unknown): Promise<string> => {
    const res = await harness().svc.lock(body);
    if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res)}`);
    return res.reason;
  };

  test("a lock signed by `a` is accepted, over the exact message a client can rebuild", async () => {
    // The five-line layout, written out here from the docstring rather than
    // imported, so a change to `lockMessage` that a client could not follow
    // fails right here instead of on a live duel.
    const expected = [
      "THETADUEL_LOCK_V1",
      `matchKey:${MATCH_KEY}`,
      `a:${A}`,
      `b:${B}`,
      // Canonical picks: keys sorted, no whitespace — the same serialisation
      // the commit hashes, so the thing signed is the thing committed.
      `picks:${JSON.stringify({ BNB: "safe-bull", SOL: "safe-bear", XRP: "safe-bull" })}`,
    ].join("\n");

    const rebuilt = lockMessage(MATCH_KEY, A, B, WINNING_SLIP);
    expect(rebuilt).toBe(expected);
    expect(rebuilt.split("\n")).toHaveLength(5);
    expect(rebuilt.startsWith(`${LOCK_MESSAGE_PREFIX}\n`)).toBe(true);
    expect(rebuilt.endsWith("\n")).toBe(false);

    const body = lockBody(SEAT_A);
    expect(verifyMessage(expected, body["sig"] as string)).toBe(A);
    expect(okLock(await harness().svc.lock(body)).commit).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("no signature at all is refused — this is the whole of X-1", async () => {
    for (const sig of [undefined, null, ""]) {
      expect(await refused({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B, sig })).toBe(
        "missing signature",
      );
    }
    // And the exploit body verbatim: B searches for a winning slip and names
    // themselves `a`, with nothing to prove it.
    expect(await refused({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: B, b: A })).toBe("missing signature");
  });

  test("a signature that is not 65 bytes of hex is refused before it reaches ethers", async () => {
    for (const sig of ["0x", "0xdeadbeef", `0x${"ab".repeat(64)}`, `0x${"ab".repeat(66)}`, `0x${"zz".repeat(65)}`, 42, {}, []]) {
      expect(await refused({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B, sig })).toBe("bad signature");
    }
  });

  test("well-shaped 65 bytes that recover to nobody are a bad signature, not a crash", async () => {
    // `r = s = 0`, `v = 27`: the right length and the right `v`, but no point
    // on the curve. ethers throws; the route must not.
    expect(await refused({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B, sig: `0x${"00".repeat(64)}1b` })).toBe(
      "bad signature",
    );
  });

  test("a signature by the wrong key is refused", async () => {
    // B signs, but the body claims A. This is the impersonation the finding is
    // about, and it is the one thing a signature can prove is false.
    const forged = { ...lockBody(SEAT_B, { b: A }), a: A, b: B };
    expect(await refused(forged)).toBe("signature is not a's");
    // The attestor's own key does not get a pass either.
    expect(await refused({ ...lockBody(SEAT_A), sig: ATTESTOR.signMessageSync(lockMessage(MATCH_KEY, A, B, WINNING_SLIP)) })).toBe(
      "signature is not a's",
    );
  });

  test("picks tampered with after signing are refused", async () => {
    // The attacker's real position: a valid signature over the slip they were
    // willing to sign, pointed at the winning slip they found offline.
    const body = lockBody(SEAT_A, { picks: LOSING_SLIP });
    expect(await refused({ ...body, picks: WINNING_SLIP })).toBe("signature is not a's");
    // Even a single leg moved — the picks are bound whole, canonically.
    expect(await refused({ ...body, picks: { ...LOSING_SLIP, SOL: "safe-bear" } })).toBe("signature is not a's");
  });

  test("the match key cannot be swapped after signing", async () => {
    const other = `${LOBBY_ID}:424243`;
    const body = lockBody(SEAT_A, { picks: WINNING_SLIP });
    // A signature harvested from one duel replayed onto another. The arena of
    // seed 424243 may differ, so drive the refusal past the picks gate by
    // signing for the OTHER key and posting it at this one.
    const forSeedTwo = lockBody(SEAT_A, { matchKey: other, picks: WINNING_SLIP });
    expect(await refused({ ...forSeedTwo, matchKey: MATCH_KEY })).toBe("signature is not a's");
    expect(okLock(await harness().svc.lock(body)).duelId).toBe(id(MATCH_KEY));
  });

  test("the opponent seat cannot be swapped after signing", async () => {
    // `b` is who gets paid when the slip loses, so it is money and it is bound.
    const body = lockBody(SEAT_A, { b: B });
    expect(await refused({ ...body, b: STRANGER })).toBe("signature is not a's");
    // Including dropping it entirely: a lock signed for a taken seat is not a
    // lock for an open one.
    const { b: _dropped, ...withoutB } = body;
    expect(await refused(withoutB)).toBe("signature is not a's");
    // And the reverse — signed open, posted taken.
    expect(await refused({ ...lockBody(SEAT_A, { b: null }), b: B })).toBe("signature is not a's");
  });

  test("an open second seat is signed as the zero address, and `\"\"` or `null` mean the same", async () => {
    const open = lockBody(SEAT_A, { b: null });
    expect(lockMessage(MATCH_KEY, A, null, WINNING_SLIP)).toContain(`b:0x${"0".repeat(40)}`);
    for (const b of [undefined, null, "", `0x${"0".repeat(40)}`]) {
      const h = harness();
      const res = await h.svc.lock(b === undefined ? open : { ...open, b });
      expect(res.ok).toBe(true);
    }
  });

  test("a refused lock does not consume first-write-wins", async () => {
    // The property that keeps the fix from becoming its own denial of service:
    // an attacker spraying unsigned or forged locks must not be able to burn
    // the seat, or to evict a commit once one is stored.
    const h = harness();
    await h.svc.lock({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B }); // unsigned
    await h.svc.lock({ ...lockBody(SEAT_B, { b: A }), a: A }); // forged
    await h.svc.lock({ ...lockBody(SEAT_A), sig: `0x${"11".repeat(65)}` }); // junk
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(false);

    // The seat is still free, and the honest lock takes it — note-free, which
    // is how a FIRST write is spelled.
    const good = okLock(await h.svc.lock(lockBody(SEAT_A, { picks: LOSING_SLIP })));
    expect(good.note).toBeUndefined();
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(true);
    // …and what is stored is the honest payload, not any of the three above.
    const probe = okLock(await h.svc.lock(lockBody(SEAT_S, { picks: WINNING_SLIP, b: A })));
    expect(probe.note).toBe("already locked");
    expect(probe.commit).toBe(good.commit);
  });

  test("nothing is ever signed for a duel whose lock was refused", async () => {
    const h = harness();
    await h.svc.lock({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B });
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({ ok: false, reason: "not locked" });
    expect(h.signed).toEqual([]);
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(false);
  });

  test("the signed message is order-independent in exactly the way the commit is", async () => {
    // A client that builds its picks object in arena order and a server that
    // sorts must still agree on one string, or every honest lock fails.
    const forwards = lockMessage(MATCH_KEY, A, B, { SOL: "safe-bull", XRP: "safe-bear", BNB: "safe-bull" });
    const backwards = lockMessage(MATCH_KEY, A, B, { BNB: "safe-bull", XRP: "safe-bear", SOL: "safe-bull" });
    expect(backwards).toBe(forwards);
    // A signature made over one ordering authorises the other ordering's body.
    const sig = SEAT_A.signMessageSync(forwards);
    const res = await harness().svc.lock({
      matchKey: MATCH_KEY,
      picks: { BNB: "safe-bull", XRP: "safe-bear", SOL: "safe-bull" },
      a: A,
      b: B,
      sig,
    });
    expect(res.ok).toBe(true);
    // …but a different slip is a different message and a different signature.
    expect(lockMessage(MATCH_KEY, A, B, LOSING_SLIP)).not.toBe(forwards);
  });

  test("the refusal is still a 200 with a typed reason", async () => {
    const h = harness();
    const res = await h.svc.handleLock(post({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "missing signature" });
  });
});

/**
 * FINDING 6-1 — a match key may carry a per-room nonce.
 *
 * `lobbyId:seed` is 6 × 900 000 keys, and the reviewer recovered a preimage
 * from an on-chain `duelId` in 30 ms and squatted the id so the real room could
 * never `open()`. The grammar below is the server half of the fix: an optional
 * third segment that the derivation ignores and an outsider cannot guess.
 */
describe("a match key may carry a per-room nonce — 6-1", () => {
  const NONCE_KEY = `${MATCH_KEY}:r7f3a91c4`;

  test("a nonced key locks and settles exactly like the bare one", async () => {
    const h = harness();
    const res = okLock(await h.svc.lock(lockBody(SEAT_A, { matchKey: NONCE_KEY })));
    expect(res.matchKey).toBe(NONCE_KEY);
    // The duel id is keccak over the WHOLE key, so a nonced room is a different
    // duel on chain — which is the entire point.
    expect(res.duelId).toBe(id(NONCE_KEY));
    expect(res.duelId).not.toBe(id(MATCH_KEY));
    // …and the nonce touches nothing else: same seed, same arena, same winner.
    expect(res.commit).toBe(okLock(await harness().svc.lock(lockBody(SEAT_A))).commit);
    const verdict = okAttest(await h.svc.attest({ matchKey: NONCE_KEY }));
    expect(verdict.winner).toBe(expectedWinner(WINNING_SLIP));
  });

  test("two rooms on one seed are two independent duels", async () => {
    const h = harness();
    okLock(await h.svc.lock(lockBody(SEAT_A, { matchKey: `${MATCH_KEY}:roomAlpha` })));
    // A second room, same lobby and seed: first-write-wins does not collide,
    // because the nonce is in the key.
    const second = okLock(await h.svc.lock(lockBody(SEAT_A, { matchKey: `${MATCH_KEY}:roomBravo`, picks: LOSING_SLIP })));
    expect(second.note).toBeUndefined();
    expect(okStatus(h.svc.status(id(`${MATCH_KEY}:roomAlpha`))).locked).toBe(true);
    expect(okStatus(h.svc.status(id(`${MATCH_KEY}:roomBravo`))).locked).toBe(true);
  });

  test("the nonce must begin with a letter, so a seed is never read as one", async () => {
    // A trailing all-digit segment is the SEED, always — which is what keeps
    // every key the app mints today parsing exactly as it did before.
    const h = harness();
    for (const bad of [`${MATCH_KEY}:123456`, `${MATCH_KEY}:ab`, `${MATCH_KEY}:-nonce`, `${MATCH_KEY}:9lives`]) {
      const res = await h.svc.lock(lockBody(SEAT_A, { matchKey: bad }));
      // Fail-closed: the whole `lobby:seed` head is then read as a lobby id,
      // and there is no such lobby.
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain("unknown lobby");
    }
  });

  test("a two-segment key is never mistaken for lobby-plus-nonce", async () => {
    // `kz-semis:abcd` has a nonce-shaped tail and no seed. It must stay a bad
    // seed, not become a lobby with a nonce and no seed at all.
    const res = await harness().svc.lock(lockBody(SEAT_A, { matchKey: `${LOBBY_ID}:abcd` }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad seed");
  });

  test("the nonce is inside the signed message, like every other field", async () => {
    const body = lockBody(SEAT_A, { matchKey: NONCE_KEY });
    // Stripping the nonce from a signed body is a different room and a
    // different duel id, and the signature does not follow it there.
    const res = await harness().svc.lock({ ...body, matchKey: MATCH_KEY });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("signature is not a's");
  });
});

describe("the digest the server signs is the digest the escrow checks", () => {
  test("the contract's own strings were read, not assumed", () => {
    // If this file's regexes ever stop matching, every assertion below would
    // silently compare empty strings to empty strings.
    expect(VERDICT_TYPE_STRING).toBe("Verdict(bytes32 duelId,address winner,uint64 deadline)");
    expect(DOMAIN_TYPE_STRING).toBe(
      "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    expect(CONTRACT_DOMAIN_NAME).toBe("THETADUEL");
    expect(CONTRACT_DOMAIN_VERSION).toBe("1");
  });

  test("attest.ts's transcription of the domain and the struct equals the contract's", () => {
    expect(VERDICT_DOMAIN_NAME).toBe(CONTRACT_DOMAIN_NAME!);
    expect(VERDICT_DOMAIN_VERSION).toBe(CONTRACT_DOMAIN_VERSION!);
    // Field names, order and types all enter the typehash: one rename is a
    // different digest and a signature the escrow rejects.
    expect(VERDICT_TYPES as unknown as Record<string, { name: string; type: string }[]>).toEqual(
      CONTRACT_TYPES,
    );
    expect(TypedDataEncoder.from(CONTRACT_TYPES).encodeType("Verdict")).toBe(VERDICT_TYPE_STRING);
    // Base Sepolia — the SIGNING chain, and the chain `contracts/deploy.ts`
    // will deploy the escrow to. The contract reads `block.chainid`, so this is
    // the one domain field no source read can confirm; it is pinned here
    // instead. It read 8453 while the app signed on mainnet, and this
    // assertion is the thing that would have caught it staying there.
    expect(SIGNING_CHAIN_ID).toBe(84532);
  });

  /**
   * THE MONEY TEST.
   *
   * Three independent constructions of one digest have to agree: a hand
   * transcription of the Solidity in `settle` (:326-332), `TypedDataEncoder`
   * over the contract's own strings, and — via `recoverAddress` — whatever the
   * service actually put its key over. Get this wrong and the escrow rejects the
   * signature with both stakes already locked.
   */
  test("the service's signature recovers the attestor over a hand-built EIP-712 digest", async () => {
    const h = harness();
    await locked(h, WINNING_SLIP);
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));

    // 1. Transcribed from the Solidity, line for line.
    const domainSeparator = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          keccak256(toUtf8Bytes(DOMAIN_TYPE_STRING!)),
          keccak256(toUtf8Bytes(CONTRACT_DOMAIN_NAME!)),
          keccak256(toUtf8Bytes(CONTRACT_DOMAIN_VERSION!)),
          BigInt(SIGNING_CHAIN_ID),
          ESCROW,
        ],
      ),
    );
    const structHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "address", "uint64"],
        [keccak256(toUtf8Bytes(VERDICT_TYPE_STRING)), res.duelId, res.winner, BigInt(res.deadline)],
      ),
    );
    const handBuilt = keccak256(concat(["0x1901", domainSeparator, structHash]));

    // 2. The same thing through ethers, from the same contract strings.
    const viaEncoder = TypedDataEncoder.hash(contractDomain(ESCROW), CONTRACT_TYPES, {
      duelId: res.duelId,
      winner: res.winner,
      deadline: BigInt(res.deadline),
    });
    expect(viaEncoder).toBe(handBuilt);

    // 3. And what the attestor's key was actually put over. `settle` compares
    // `_recover(digest, sig)` to `attestor`; this is that comparison, offline.
    expect(recoverAddress(handBuilt, res.signature)).toBe(ATTESTOR.address);
  });

  test("verifyTypedData recovers the attestor from the returned signature", async () => {
    const h = harness();
    await locked(h, WINNING_SLIP);
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));

    const recovered = verifyTypedData(
      contractDomain(ESCROW),
      CONTRACT_TYPES,
      { duelId: res.duelId, winner: res.winner, deadline: BigInt(res.deadline) },
      res.signature,
    );
    expect(recovered).toBe(ATTESTOR.address);
    expect(res.signature).toMatch(/^0x[0-9a-f]{130}$/);
  });

  test("the signature is bound to this duel, this winner and this deadline", async () => {
    const h = harness();
    await locked(h, WINNING_SLIP);
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));

    const recoverWith = (value: Record<string, unknown>) =>
      recoverAddress(TypedDataEncoder.hash(contractDomain(ESCROW), CONTRACT_TYPES, value), res.signature);

    const base = { duelId: res.duelId, winner: res.winner, deadline: BigInt(res.deadline) };
    // Any tampered field recovers to a stranger, which is what makes replay
    // across duels, winners, expiries and deployments impossible on chain.
    expect(recoverWith({ ...base, duelId: id("some-other:424242") })).not.toBe(ATTESTOR.address);
    expect(recoverWith({ ...base, winner: STRANGER })).not.toBe(ATTESTOR.address);
    expect(recoverWith({ ...base, deadline: BigInt(res.deadline + 1) })).not.toBe(ATTESTOR.address);
    expect(
      recoverAddress(
        TypedDataEncoder.hash(contractDomain(STRANGER), CONTRACT_TYPES, base),
        res.signature,
      ),
    ).not.toBe(ATTESTOR.address);
  });

  test("the signature shape is one the contract's _recover accepts", async () => {
    // `_recover` (DuelEscrow.sol:444-461) rejects three shapes outright: any
    // length but 65 bytes, an `s` in the upper half of the curve order, and a
    // `v` outside {27, 28}. ethers only ever produces the canonical form — this
    // asserts that rather than assuming it, because each one is a rejection
    // that would arrive with both stakes already locked.
    const h = harness();
    await locked(h);
    const { signature } = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));

    const sig = Signature.from(signature);
    expect(getBytes(signature)).toHaveLength(65);
    expect(BigInt(sig.s)).toBeLessThanOrEqual(
      0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n,
    );
    expect([27, 28]).toContain(sig.v);
  });

  test("the deadline is thirty minutes out, in whole seconds", async () => {
    const h = harness();
    await locked(h);
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(DEADLINE_SECONDS).toBe(1_800);
    expect(res.deadline).toBe(Math.floor(T0 / 1000) + 1_800);
    expect(Number.isSafeInteger(res.deadline)).toBe(true);
  });

  test("the escrow address the service signs against is the domain it was given", async () => {
    const h = harness();
    await locked(h);
    await h.svc.attest({ matchKey: MATCH_KEY });
    expect(h.signed).toHaveLength(1);
    expect(h.signed[0]!.domain).toEqual({
      name: CONTRACT_DOMAIN_NAME!,
      version: CONTRACT_DOMAIN_VERSION!,
      // The literal, not `SIGNING_CHAIN_ID` — the constant is the thing being
      // pinned, so a test that read it back would agree with itself no matter
      // what it held. The contract binds its domain to `block.chainid`, so a
      // verdict signed for any chain but the one the escrow is deployed to
      // recovers to a stranger on chain. 84532 is Base Sepolia.
      chainId: 84532,
      verifyingContract: ESCROW,
    });
    expect(h.signed[0]!.types).toEqual(CONTRACT_TYPES);
  });
});

describe("the winner is derived, never read", () => {
  test("the same seed with two different committed slips pays two different seats", async () => {
    // One service per commit, because first-write-wins means one match key can
    // only ever hold one slip. Same seed, same seats, same clock — the slip is
    // the only variable, and it moves the money.
    const win = harness();
    await locked(win, WINNING_SLIP);
    const winRes = okAttest(await win.svc.attest({ matchKey: MATCH_KEY }));

    const lose = harness();
    await locked(lose, LOSING_SLIP);
    const loseRes = okAttest(await lose.svc.attest({ matchKey: MATCH_KEY }));

    expect(winRes.winner).toBe(A);
    expect(loseRes.winner).toBe(B);
    expect(winRes.winner).not.toBe(loseRes.winner);
    // Same duel id either way — it is `keccak256(utf8Bytes(matchKey))` and the
    // picks are not in the match key.
    expect(winRes.duelId).toBe(loseRes.duelId);
    // And both agree with the independent derivation.
    expect(winRes.winner).toBe(expectedWinner(WINNING_SLIP));
    expect(loseRes.winner).toBe(expectedWinner(LOSING_SLIP));
  });

  test("a winner in the request body is ignored", async () => {
    const h = harness();
    await locked(h, LOSING_SLIP); // derives to B
    for (const claimed of [A, STRANGER, ATTESTOR.address, `0x${"0".repeat(40)}`]) {
      const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY, winner: claimed }));
      expect(res.winner).toBe(B);
    }
    // Nor does anything else in the body reach the derivation: the picks the
    // service settles are the committed ones, not these.
    const res = okAttest(
      await h.svc.attest({ matchKey: MATCH_KEY, winner: A, picks: WINNING_SLIP, a: STRANGER, b: STRANGER }),
    );
    expect(res.winner).toBe(B);
  });

  test("nothing is signed before a lock", async () => {
    const h = harness();
    const res = await h.svc.attest({ matchKey: MATCH_KEY });
    expect(res.ok).toBe(false);
    expect(res).toEqual({ ok: false, reason: "not locked" });
    expect(res).not.toHaveProperty("signature");
    expect(h.signed).toEqual([]);
  });

  test("nothing is signed for a duel with an empty second seat", async () => {
    const h = harness();
    await locked(h, WINNING_SLIP, null);
    const res = await h.svc.attest({ matchKey: MATCH_KEY });
    expect(res).toEqual({ ok: false, reason: "duel has no opponent seat" });
    expect(h.signed).toEqual([]);
  });

  test("attest re-validates the match key it is handed", async () => {
    const h = harness();
    await locked(h);
    for (const body of [{}, { matchKey: "" }, { matchKey: `mine-1:${SEED}` }, { matchKey: `${LOBBY_ID}:7` }]) {
      const res = await h.svc.attest(body);
      expect(res.ok).toBe(false);
    }
    expect(h.signed).toEqual([]);
  });

  test("two calls in the same instant return the identical signature", async () => {
    const h = harness();
    await locked(h);
    const first = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    const second = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(second).toEqual(first);
    expect(h.signed).toHaveLength(1);
  });

  test("a call near expiry re-signs the same winner with a fresh deadline", async () => {
    // The winner is a pure derivation and can never move; the deadline is wall
    // clock and a stale one is a signature the relay may not land in time.
    const h = harness();
    await locked(h);
    const first = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));

    h.advance(29 * 60_000); // 60s of validity left, under the refresh floor
    const second = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));

    expect(second.winner).toBe(first.winner);
    expect(second.deadline).toBeGreaterThan(first.deadline);
    expect(second.signature).not.toBe(first.signature);
    expect(recoverAddress(
      TypedDataEncoder.hash(contractDomain(ESCROW), CONTRACT_TYPES, {
        duelId: second.duelId,
        winner: second.winner,
        deadline: BigInt(second.deadline),
      }),
      second.signature,
    )).toBe(ATTESTOR.address);
  });

  test("a lock older than its TTL is no longer settleable", async () => {
    const h = harness();
    await locked(h);
    h.advance(86_400_001);
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({ ok: false, reason: "not locked" });
  });
});

describe("status reports only what this process knows", () => {
  test("unlocked, locked, then attested", async () => {
    const h = harness();
    const duelId = id(MATCH_KEY);

    const before = okStatus(h.svc.status(duelId));
    expect(before).toEqual({ ok: true, duelId, locked: false, attested: false });

    await locked(h, LOSING_SLIP);
    expect(okStatus(h.svc.status(duelId))).toEqual({ ok: true, duelId, locked: true, attested: false });

    await h.svc.attest({ matchKey: MATCH_KEY });
    expect(okStatus(h.svc.status(duelId))).toEqual({
      ok: true,
      duelId,
      locked: true,
      attested: true,
      winner: B,
    });
  });

  test("a duel id that is not one is refused rather than answered", () => {
    const h = harness();
    for (const bad of ["", "0x", id(MATCH_KEY).slice(0, 40), "not-a-hash", `${id(MATCH_KEY)}00`]) {
      expect(h.svc.status(bad)).toEqual({ ok: false, reason: "bad duelId" });
    }
  });

  test("the id is read case-insensitively, as a hash spelling and not a value", async () => {
    const h = harness();
    await locked(h);
    expect(okStatus(h.svc.status(id(MATCH_KEY).toUpperCase())).locked).toBe(true);
  });
});

describe("every route answers HTTP 200 with a typed envelope", () => {
  const bodyOf = async (res: Response): Promise<Record<string, unknown>> => {
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json; charset=utf-8");
    // A verdict must never be cached by anything between here and the relay.
    expect(res.headers.get("cache-control")).toBe("no-store");
    return (await res.json()) as Record<string, unknown>;
  };

  test("a good lock and a good attest", async () => {
    const h = harness();
    const lockRes = await bodyOf(await h.svc.handleLock(post(lockBody(SEAT_A))));
    expect(lockRes["ok"]).toBe(true);
    expect(lockRes["duelId"]).toBe(id(MATCH_KEY));

    const attestBody = await bodyOf(await h.svc.handleAttest(post({ matchKey: MATCH_KEY })));
    expect(attestBody["ok"]).toBe(true);
    expect(attestBody["winner"]).toBe(A);
    expect(typeof attestBody["signature"]).toBe("string");
  });

  test("a refusal is still a 200 with ok:false and a reason", async () => {
    const h = harness();
    for (const req of [
      post({}),
      post({ matchKey: `mine-1:${SEED}`, picks: WINNING_SLIP, a: A }),
      post({ matchKey: MATCH_KEY, picks: { SOL: "nope" }, a: A }),
    ]) {
      const body = await bodyOf(await h.svc.handleLock(req));
      expect(body["ok"]).toBe(false);
      expect(typeof body["reason"]).toBe("string");
    }
    const body = await bodyOf(await h.svc.handleAttest(post({ matchKey: MATCH_KEY })));
    expect(body).toEqual({ ok: false, reason: "not locked" });
  });

  test("a body that is not JSON at all is a request problem, not a crash", async () => {
    const h = harness();
    const junk = () => new Request("http://localhost/api/lock", { method: "POST", body: "<not json" });
    expect(await bodyOf(await h.svc.handleLock(junk()))).toEqual({ ok: false, reason: "bad body" });
    expect(await bodyOf(await h.svc.handleAttest(junk()))).toEqual({ ok: false, reason: "bad body" });
    // A JSON array and a JSON scalar are not bodies either.
    expect(await bodyOf(await h.svc.handleLock(post([1, 2, 3])))).toEqual({ ok: false, reason: "bad body" });
    expect(await bodyOf(await h.svc.handleLock(post("matchKey")))).toEqual({ ok: false, reason: "bad body" });
  });

  test("status answers from the query string, missing id included", async () => {
    const h = harness();
    await locked(h);
    const good = await bodyOf(h.svc.handleStatus(new URL(`http://localhost/api/duel-status?duelId=${id(MATCH_KEY)}`)));
    expect(good).toEqual({ ok: true, duelId: id(MATCH_KEY), locked: true, attested: false });

    const missing = await bodyOf(h.svc.handleStatus(new URL("http://localhost/api/duel-status")));
    expect(missing).toEqual({ ok: false, reason: "bad duelId" });
  });

  test("no envelope ever carries key material", async () => {
    const h = harness();
    const bodies: string[] = [];
    bodies.push(await (await h.svc.handleLock(post(lockBody(SEAT_A)))).text());
    bodies.push(await (await h.svc.handleAttest(post({ matchKey: MATCH_KEY }))).text());
    bodies.push(await h.svc.handleStatus(new URL(`http://localhost/api/duel-status?duelId=${id(MATCH_KEY)}`)).text());

    for (const body of bodies) {
      expect(body).not.toContain(ATTESTOR.privateKey);
      expect(body).not.toContain(ATTESTOR.privateKey.slice(2));
      expect(body).not.toContain("ATTESTOR_PRIVATE_KEY");
      // The address of the referee is not secret, but it has no business in a
      // player-facing envelope either — the escrow already knows it.
      expect(body).not.toContain(ATTESTOR.address);
    }
  });
});

describe("an unconfigured server degrades instead of crashing", () => {
  /** Run `fn` with `ATTESTOR_PRIVATE_KEY` genuinely absent — Bun loads `.env`
   *  into `process.env` for the test run, so a developer's own key would
   *  otherwise decide whether this test tests anything. */
  function withoutKey<T>(fn: () => T): T {
    const saved = process.env["ATTESTOR_PRIVATE_KEY"];
    delete process.env["ATTESTOR_PRIVATE_KEY"];
    try {
      return fn();
    } finally {
      if (saved !== undefined) process.env["ATTESTOR_PRIVATE_KEY"] = saved;
    }
  }

  const NOT_CONFIGURED: AttestFail = { ok: false, reason: "attestor not configured" };

  test("all three routes answer NOT_CONFIGURED with no key in the environment", async () => {
    // Every call is made inside the one window, because the service resolves
    // its signer once, on first use, and caches the answer.
    const res = withoutKey(() => {
      const svc = createAttestService({ escrow: ESCROW, seats: null, now: () => T0 });
      return {
        lock: svc.lock(lockBody(SEAT_A)),
        status: svc.status(id(MATCH_KEY)),
        attest: svc.attest({ matchKey: MATCH_KEY }),
      };
    });
    // The two promises are STARTED inside the window and awaited outside it —
    // both refuse before their first `await`, so the key is genuinely absent at
    // the only moment either of them looks for it.
    expect(await res.lock).toEqual(NOT_CONFIGURED);
    expect(res.status).toEqual(NOT_CONFIGURED);
    expect(await res.attest).toEqual(NOT_CONFIGURED);
  });

  test("a malformed key is a configuration problem, not a 500", async () => {
    const saved = process.env["ATTESTOR_PRIVATE_KEY"];
    process.env["ATTESTOR_PRIVATE_KEY"] = "not-a-private-key";
    try {
      const svc = createAttestService({ escrow: ESCROW, now: () => T0 });
      const res = await svc.handleAttest(post({ matchKey: MATCH_KEY }));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(NOT_CONFIGURED);
    } finally {
      if (saved === undefined) delete process.env["ATTESTOR_PRIVATE_KEY"];
      else process.env["ATTESTOR_PRIVATE_KEY"] = saved;
    }
  });

  test("a configured attestor with no deployed escrow refuses to sign", async () => {
    // Signing against the zero address would produce a verdict bound to a
    // deployment that does not exist — a signature nobody can ever relay.
    const svc = createAttestService({
      signer: ATTESTOR,
      escrow: "",
      seats: null,
      now: () => T0,
    });
    okLock(await svc.lock(lockBody(SEAT_A)));
    expect(await svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "escrow not configured",
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * FINDING X-1, THE RESIDUAL — the seats are read from the chain.
 *
 * The signature above proves the caller controls the address they name. It
 * cannot prove that address is *playing this duel*, and the person best placed
 * to exploit that is the opponent: `b` was handed the room link, so `b` knows
 * the match key, can search the ≤ 4 096 reachable slips offline for one that
 * wins, and can sign a perfectly valid lock naming **themselves** in the `a`
 * seat. Every check in the previous section passes. First-write-wins then pins
 * it, `/api/attest` honestly derives a verdict from those picks, and the escrow
 * pays it — because `b` really is a player and `winner ∈ {a, b}` really does
 * hold.
 *
 * `src/server/seats.ts` reads the two seats out of the escrow's own `duels`
 * getter, where they were written by transactions that cost real USDC, and
 * `lock()` compares instead of believing. Every test below is one row of the
 * disposition table in `attest.ts`'s docstring, and the chain is a four-line
 * fake — the escrow is not deployed, and none of this needs it to be.
 */
describe("the seats are bound to the chain — X-1's residual", () => {
  const DUEL_ID = id(MATCH_KEY);

  /** The committed artifact's own interface, so the fake chain answers exactly
   *  what a real node would and the reader's transcribed signature is under
   *  test rather than assumed. */
  const ESCROW_ABI = new Interface(
    (
      JSON.parse(
        readFileSync(join(import.meta.dir, "..", "contracts", "out", "DuelEscrow.json"), "utf8"),
      ) as { abi: ConstructorParameters<typeof Interface>[0] }
    ).abi,
  );

  const ZERO = `0x${"0".repeat(40)}`;

  /** One `duels(duelId)` answer. `status` is named, and its ordinal comes from
   *  the reader's own list, which `test/seats.test.ts` pins to the enum in
   *  `DuelEscrow.sol`. */
  const duelsResult = (a: string, b: string, status: (typeof SEAT_STATUSES)[number]): string =>
    ESCROW_ABI.encodeFunctionResult("duels", [
      a,
      b,
      ZERO,
      100_000n,
      1_756_000_000,
      SEAT_STATUSES.indexOf(status),
      false,
      false,
    ]);

  interface FakeChain {
    seats: SeatReader;
    /** One entry per `eth_call`. Assertions that this is EMPTY are half the
     *  point: they are what proves a refusal happened before the network, and
     *  what proves the unconfigured path never reaches for a chain at all. */
    calls: string[];
  }

  function chainAnswers(answer: () => Promise<string>, escrowAddress = ESCROW): FakeChain {
    const calls: string[] = [];
    const provider: SeatProvider = {
      call: (tx) => {
        calls.push(tx.data);
        return answer();
      },
    };
    return {
      calls,
      seats: createSeatReader({ provider, escrow: escrowAddress, rpcUrl: "", now: () => T0 }),
    };
  }

  /** A chain that always answers with one duel row. */
  function chainSays(a: string, b: string, status: (typeof SEAT_STATUSES)[number] = "FULL"): FakeChain {
    return chainAnswers(() => Promise.resolve(duelsResult(a, b, status)));
  }

  /** A service whose seat reader is that fake chain. */
  const on = (chain: FakeChain): Harness => harness(T0, chain.seats);

  const refusal = (e: LockEnvelope): string => {
    if (e.ok) throw new Error(`expected a refusal, got ${JSON.stringify(e)}`);
    return e.reason;
  };

  test("a lock whose seats are the chain's seats is accepted, and reads the chain once", async () => {
    const chain = chainSays(A, B);
    const h = on(chain);

    const res = okLock(await h.svc.lock(lockBody(SEAT_A, { b: B })));
    expect(res.note).toBeUndefined();
    expect(chain.calls).toEqual([ESCROW_ABI.encodeFunctionData("duels", [DUEL_ID])]);

    // …and the duel settles exactly as it does with no chain in the picture.
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(expectedWinner(WINNING_SLIP));
  });

  test("THE EXPLOIT: the joiner cannot lock as the opener", async () => {
    // The whole of X-1's residual, executed. The chain says A opened and B
    // joined. B — who controls B, knows the match key, and has searched the
    // slips offline — signs a flawless lock naming themselves `a`.
    const chain = chainSays(A, B);
    const h = on(chain);
    const exploit = lockBody(SEAT_B, { picks: WINNING_SLIP, b: A });

    // Everything about that body is honest except the seat it claims.
    expect(verifyMessage(lockMessage(MATCH_KEY, B, A, WINNING_SLIP), exploit["sig"] as string)).toBe(B);
    expect(refusal(await h.svc.lock(exploit))).toBe("not a seat in this duel");

    // Nothing was stored, nothing was signed, and the seat is still A's.
    expect(okStatus(h.svc.status(DUEL_ID)).locked).toBe(false);
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({ ok: false, reason: "not locked" });
    expect(h.signed).toEqual([]);

    // A locks their own slip afterwards and is paid on it.
    const good = okLock(await h.svc.lock(lockBody(SEAT_A, { picks: WINNING_SLIP, b: B })));
    expect(good.note).toBeUndefined();
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(A);
  });

  test("the seats are matched IN ORDER — an unordered comparison would close nothing", async () => {
    // The design decision, asserted rather than commented. `{b, a}` and `{a, b}`
    // are the same set, so a membership test would bless the exploit above
    // verbatim. The escrow's own semantics are ordered — `open` writes `d.a`,
    // `join` writes `d.b` — and so is the game: `a` is the seat whose picks were
    // committed and which plays the seeded opponent. The room's opener locks.
    const swapped = lockBody(SEAT_B, { b: A });
    expect(new Set([B, A])).toEqual(new Set([A, B]));
    expect(refusal(await on(chainSays(A, B)).svc.lock(swapped))).toBe("not a seat in this duel");
    // …and the same body IS accepted by the chain that actually says so.
    expect((await on(chainSays(B, A)).svc.lock(swapped)).ok).toBe(true);
  });

  test("a stranger who genuinely controls their address is still not a player", async () => {
    const chain = chainSays(A, B);
    expect(refusal(await on(chain).svc.lock(lockBody(SEAT_S, { b: B })))).toBe("not a seat in this duel");
  });

  test("the opponent seat must be the on-chain joiner too", async () => {
    // `b` is who gets paid when the committed slip loses, so a lock naming the
    // wrong one would have the server sign a verdict the escrow refuses
    // (`winner not a player`) and strand the duel until the six-hour refund.
    const chain = chainSays(A, B);
    expect(refusal(await on(chain).svc.lock(lockBody(SEAT_A, { b: STRANGER })))).toBe(
      "opponent is not the on-chain seat",
    );
    // Including omitting it: the chain says there are two seats.
    expect(refusal(await on(chain).svc.lock(lockBody(SEAT_A, { b: null })))).toBe(
      "opponent is not the on-chain seat",
    );
  });

  test("a duel nobody has opened on chain has no seats to bind to", async () => {
    const chain = chainAnswers(() => Promise.resolve(`0x${"0".repeat(64 * 8)}`));
    expect(refusal(await on(chain).svc.lock(lockBody(SEAT_A, { b: B })))).toBe("seats not on chain");
  });

  test("a duel still waiting for its opponent is refused, not pinned", async () => {
    // Storing this would fix `b: null` under first-write-wins and make the duel
    // permanently unsettleable — `/api/attest` has nobody to pay. A refusal
    // costs the client a retry once its `join` has landed.
    const open = chainSays(A, ZERO, "OPEN");
    expect(refusal(await on(open).svc.lock(lockBody(SEAT_A, { b: B })))).toBe(
      "opponent has not joined on chain",
    );
    expect(refusal(await on(open).svc.lock(lockBody(SEAT_A, { b: null })))).toBe(
      "opponent has not joined on chain",
    );
  });

  test("a duel that is already over is refused", async () => {
    // A duel leaves FULL exactly once, so no verdict signed from here could
    // ever be paid.
    for (const status of ["SETTLED", "REFUNDED"] as const) {
      expect(refusal(await on(chainSays(A, B, status)).svc.lock(lockBody(SEAT_A, { b: B })))).toBe(
        "duel is closed on chain",
      );
    }
  });

  test("an unreachable chain FAILS CLOSED — it never falls back to the body", async () => {
    // The most important row of the table. If a refusal here degraded into
    // "trust the request", an attacker who can make one RPC call time out —
    // a burst against a throttled endpoint will do — would restore the whole
    // exploit, precisely when nobody is watching.
    const down = chainAnswers(() => Promise.reject(new Error("ECONNREFUSED")));
    const h = on(down);
    // The body that a live chain accepts…
    expect(refusal(await h.svc.lock(lockBody(SEAT_A, { b: B })))).toBe("chain unreachable");
    // …and the exploit body. Both refused; neither is stored.
    expect(refusal(await h.svc.lock(lockBody(SEAT_B, { b: A })))).toBe("chain unreachable");
    expect(okStatus(h.svc.status(DUEL_ID)).locked).toBe(false);
    expect(h.signed).toEqual([]);

    // Anything that is not a duel row is the same answer, for the same reason.
    for (const junk of ["0x", `0x${"11".repeat(31)}`]) {
      const bad = chainAnswers(() => Promise.resolve(junk));
      expect(refusal(await on(bad).svc.lock(lockBody(SEAT_A, { b: B })))).toBe("bad chain response");
    }
  });

  test("a refused seat check does not consume first-write-wins", async () => {
    // The property that keeps the fix from becoming its own denial of service —
    // the same one the signature section asserts, now for the chain half.
    const chain = chainSays(A, B);
    const h = on(chain);
    await h.svc.lock(lockBody(SEAT_B, { picks: WINNING_SLIP, b: A })); // the exploit
    await h.svc.lock(lockBody(SEAT_S, { b: B })); // a stranger
    await h.svc.lock(lockBody(SEAT_A, { b: STRANGER })); // the wrong opponent
    expect(okStatus(h.svc.status(DUEL_ID)).locked).toBe(false);

    const good = okLock(await h.svc.lock(lockBody(SEAT_A, { picks: LOSING_SLIP, b: B })));
    expect(good.note).toBeUndefined();
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(expectedWinner(LOSING_SLIP));
  });

  test("the chain is consulted last, and only for a lock that could otherwise be stored", async () => {
    // Recovery is local and free; an `eth_call` is neither. Nothing an
    // unauthenticated stranger sends may make this process talk to an RPC.
    const chain = chainSays(A, B);
    const h = on(chain);
    await h.svc.lock({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B }); // unsigned
    await h.svc.lock({ ...lockBody(SEAT_B, { b: A }), a: A }); // forged
    await h.svc.lock({ matchKey: `nope:${SEED}`, picks: WINNING_SLIP, a: A, b: B }); // no such lobby
    expect(chain.calls).toEqual([]);

    // A real lock reads once…
    okLock(await h.svc.lock(lockBody(SEAT_A, { b: B })));
    expect(chain.calls).toHaveLength(1);
    // …and a repeat lock is answered from the commit store, not the chain.
    const again = okLock(await h.svc.lock(lockBody(SEAT_A, { picks: LOSING_SLIP, b: B })));
    expect(again.note).toBe("already locked");
    expect(chain.calls).toHaveLength(1);
  });

  test("with no escrow configured, nothing is read and the old behaviour is exact", async () => {
    // The demo-without-staking path, asserted explicitly so that a later edit
    // cannot quietly make a chain mandatory. The reader here is REAL — it just
    // has no escrow address, so it reports itself unconfigured and the service
    // skips it entirely rather than refusing every lock.
    const chain = chainAnswers(() => Promise.resolve(duelsResult(A, B, "FULL")), "");
    expect(chain.seats.configured).toBe(false);
    const h = on(chain);

    // The exploit body itself is accepted here — which is exactly the residual
    // this whole section closes, and exactly why staking requires the escrow.
    const res = okLock(await h.svc.lock(lockBody(SEAT_B, { picks: WINNING_SLIP, b: A })));
    expect(res.note).toBeUndefined();
    expect(res.duelId).toBe(DUEL_ID);
    expect(chain.calls).toEqual([]);
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(B);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The duel clock — plan 6 §C
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything below settles a duel on **marks**, not on the tape.
 *
 * An option expires on a Friday; a duel lasts four minutes. The repo runs both
 * clocks and lets them measure different things, and this is the first one: the
 * attestor reads ONE market snapshot at the duel's declared end and scores both
 * committed slates off it with `src/engine/score.ts`. The expiry clock is the
 * OptionBook's business and nothing here can touch it — the player keeps the
 * position they bought whichever way the pot went.
 *
 * The book is frozen in this file. There is no network in any test below: a
 * `MarkSource` is four lines, the service is handed one explicitly, and the
 * default in `harness` is `null` so a test that forgets gets "no market source"
 * rather than a live read of Base.
 */

/** Four minutes past the lock — the duel length plan 6 §C is written around. */
const ENDS_AT = T0 + 240_000;
/** When the snapshot was taken: after the end, comfortably inside the lag. */
const SNAP_AT = ENDS_AT + 500;
/** When the attestor calls. */
const AFTER = ENDS_AT + 1_000;

const ETH = "ETH-27SEP26-4400-C";
const BTC = "BTC-27SEP26-70000-P";

/** The frozen book both slates are marked against. ETH up from 0.25, BTC up
 *  from 2.00 — the same two moves `test/score.test.ts` hand-computes.
 *
 *  Every number in this file is **US dollars** (`src/engine/score.ts` §Units):
 *  dollars per contract for a mark, dollars for a premium. They are small
 *  because they are the score fixture's numbers, not because a mark is small —
 *  the arithmetic under test is a ratio and does not care, and the tests that
 *  care about the conversion itself live in `test/score.test.ts` and in the
 *  reducer section at the foot of this file. */
const MARKS: Record<string, number> = { [ETH]: 0.5, [BTC]: 2.25 };

/** `MARKS` as the score wants it: dollars per contract, branded. */
const marksMap = (m: Record<string, number> = MARKS): Map<string, UsdPerContract> =>
  new Map(Object.entries(m).map(([k, v]) => [k, v as UsdPerContract]));

/** A dollar mark read back out of a map, as a plain number.
 *
 *  The brand's job is to make a *producer* write its conversion down; an
 *  assertion is a reader, and `expect(x).toBe(276.9)` should not need a cast to
 *  say what it means. So the widening happens here, once, rather than at seven
 *  assertion sites where it would read as noise. */
const dollars = (v: UsdPerContract | undefined): number | undefined => v;

const filled = (
  instrument: string,
  entryMark: number,
  contracts: number,
  premium: number,
): FilledLeg => ({
  instrument,
  entryMark: entryMark as UsdPerContract,
  contracts,
  premium: premium as Usd,
});

/**
 * The two baskets, and the whole point of §C1 in two lines.
 *
 *   GOOD  ETH  (0.50 − 0.25) × 2 = +0.50 on premium 0.50  →  score 1.00
 *   BIG   BTC  (2.25 − 2.00) × 6 = +1.50 on premium 3.00  →  score 0.50
 *
 * BIG makes three times the money and loses, because it risked six times as
 * much to do it. Asserted below rather than trusted.
 */
const GOOD: readonly FilledLeg[] = [filled(ETH, 0.25, 2, 0.5)];
const BIG: readonly FilledLeg[] = [filled(BTC, 2, 6, 3)];

/** A basket the frozen book has no mark for. */
const UNMARKABLE: readonly FilledLeg[] = [filled("DOGE-27SEP26-1-C", 0.1, 4, 1)];

// ─── a frozen book, and a count of how often it was read ─────────────────────

interface Book {
  source: MarkSource;
  /** How many times the service actually read it. The freeze test is entirely
   *  this number. */
  reads(): number;
  /** Change what the NEXT read would return. Used to prove that a frozen
   *  snapshot is never re-read, however the book moves afterwards. */
  set(at: number, marks: Record<string, number>): void;
}

function book(at = SNAP_AT, marks: Record<string, number> = MARKS): Book {
  let reads = 0;
  let current: MarkSnapshot = { at, marks: marksMap(marks) };
  return {
    source: {
      read: async () => {
        reads += 1;
        return current;
      },
    },
    reads: () => reads,
    set: (nextAt, nextMarks) => {
      current = { at: nextAt, marks: marksMap(nextMarks) };
    },
  };
}

/** A book that answers with a typed refusal, like the real source does when the
 *  pricing host is down. */
function deadBook(reason: string): Book {
  let reads = 0;
  return {
    source: {
      read: async () => {
        reads += 1;
        return { reason };
      },
    },
    reads: () => reads,
    set: () => {},
  };
}

// ─── building a duel-clock lock ──────────────────────────────────────────────

interface FillsOpts {
  endsAt?: number;
  aLegs?: readonly FilledLeg[];
  bLegs?: readonly FilledLeg[];
  /** Who signs each slate. Defaults to the seat that owns it — a test that
   *  wants one player stating the other's fills overrides these. */
  aSigner?: Wallet;
  bSigner?: Wallet;
  /** What each slate's signature is actually over, when that must differ from
   *  what is sent. */
  signMatchKey?: string;
  signEndsAt?: number;
}

/** The `fills` block of a lock body, each slate signed by its own seat. */
function fillsBlock(o: FillsOpts = {}): Record<string, unknown> {
  const endsAt = o.endsAt ?? ENDS_AT;
  const aLegs = o.aLegs ?? GOOD;
  const bLegs = o.bLegs ?? BIG;
  const mk = o.signMatchKey ?? MATCH_KEY;
  const se = o.signEndsAt ?? endsAt;
  const aw = o.aSigner ?? SEAT_A;
  const bw = o.bSigner ?? SEAT_B;
  return {
    endsAt,
    a: { legs: aLegs, sig: aw.signMessageSync(fillsMessage(mk, A, se, aLegs)) },
    b: { legs: bLegs, sig: bw.signMessageSync(fillsMessage(mk, B, se, bLegs)) },
  };
}

/**
 * A whole lock body on the duel clock: picks, both slates, and `a`'s six-line
 * signature binding the lot.
 *
 * `fills` is taken as a value rather than built here so that a test can hand
 * over a tampered block and still get a signature over the UNTAMPERED one —
 * which is the attacker's actual position.
 */
function duelLockBody(
  fills: Record<string, unknown>,
  opts: {
    picks?: Record<string, string>;
    b?: string | null;
    /** What `a` signs the sixth line over. Defaults to a commit over `fills`. */
    signCommit?: string | null;
    matchKey?: string;
  } = {},
): Record<string, unknown> {
  const matchKey = opts.matchKey ?? MATCH_KEY;
  const picks = opts.picks ?? WINNING_SLIP;
  const b = opts.b === undefined ? B : opts.b;
  const commit =
    opts.signCommit !== undefined
      ? opts.signCommit
      : fillsCommitOf(
          fills["endsAt"] as number,
          (fills["a"] as { legs: readonly FilledLeg[] }).legs,
          (fills["b"] as { legs: readonly FilledLeg[] }).legs,
        );
  return {
    matchKey,
    picks,
    a: A,
    ...(b ? { b } : {}),
    fills,
    sig: SEAT_A.signMessageSync(lockMessage(matchKey, A, b, picks, commit)),
  };
}

/** A harness with a frozen book, already advanced past the duel's end. */
function duelHarness(b: Book = book()): Harness & { book: Book } {
  const h = harness(T0, null, b.source);
  return { ...h, book: b };
}

// ─────────────────────────────────────────────────────────────────────────────

describe("the duel clock scores marks, and the tape is not consulted", () => {
  test("the fixture baskets are what §C1 says they are", () => {
    // Stated before anything depends on it: BIG makes more money, GOOD has the
    // better return, and the tape — on WINNING_SLIP — pays A. So a verdict of B
    // below can only have come from the marks.
    const marks = marksMap();
    expect(duelScore(GOOD, marks)).toBe(1);
    expect(duelScore(BIG, marks)).toBe(0.5);
    expect(expectedWinner(WINNING_SLIP)).toBe(A);
  });

  test("a lock that commits two slates comes back with a fillsCommit", async () => {
    const h = duelHarness();
    const res = okLock(await h.svc.lock(duelLockBody(fillsBlock())));
    expect(res.fillsCommit).toBe(fillsCommitOf(ENDS_AT, GOOD, BIG));
    // The picks commit is unchanged — the two commitments are independent, and
    // the picks one is still what a pre-phase-C client would compute.
    expect(res.commit).toBe(okLock(await harness().svc.lock(lockBody(SEAT_A))).commit);
  });

  test("THE VERDICT MOVES: the marks pay B where the tape would have paid A", async () => {
    // Same seed, same committed picks. On the tape this duel pays A. On the
    // duel clock A holds the mediocre basket and loses. If this returned A, the
    // attestor would still be replaying the tape.
    const h = duelHarness();
    await h.svc.lock(duelLockBody(fillsBlock({ aLegs: BIG, bLegs: GOOD })));
    h.advance(AFTER - T0);
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(res.winner).toBe(B);
    expect(expectedWinner(WINNING_SLIP)).toBe(A);
  });

  test("and the other way round, on identical picks", async () => {
    const h = duelHarness();
    await h.svc.lock(duelLockBody(fillsBlock({ aLegs: GOOD, bLegs: BIG })));
    h.advance(AFTER - T0);
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(A);
  });

  test("the smaller basket beats the bigger one — return on premium, not P&L", async () => {
    // BIG's P&L is +1.50 against GOOD's +0.50. Whoever holds GOOD wins anyway.
    for (const [aLegs, bLegs, winner] of [
      [GOOD, BIG, A],
      [BIG, GOOD, B],
    ] as const) {
      const h = duelHarness();
      await h.svc.lock(duelLockBody(fillsBlock({ aLegs, bLegs })));
      h.advance(AFTER - T0);
      expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(winner);
    }
  });

  test("the signature is a real EIP-712 verdict over the duel-clock winner", async () => {
    // The duel clock changes what the winner IS; it changes nothing about what
    // a verdict is. Same domain, same struct, same recovery as the tape path.
    const h = duelHarness();
    await h.svc.lock(duelLockBody(fillsBlock({ aLegs: BIG, bLegs: GOOD })));
    h.advance(AFTER - T0);
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(
      recoverAddress(
        TypedDataEncoder.hash(contractDomain(ESCROW), CONTRACT_TYPES, {
          duelId: res.duelId,
          winner: res.winner,
          deadline: BigInt(res.deadline),
        }),
        res.signature,
      ),
    ).toBe(ATTESTOR.address);
    expect(res.winner).toBe(B);
  });

  test("a duel that has not ended yet is not scored", async () => {
    const h = duelHarness();
    await h.svc.lock(duelLockBody(fillsBlock()));
    h.advance(239_999); // one millisecond short
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "duel has not ended",
    });
    expect(h.signed).toEqual([]);
    expect(h.book.reads()).toBe(0); // the book is not even consulted
  });
});

describe("ONE snapshot, both players, frozen after the first read", () => {
  test("the book is read exactly once, and both slates are scored off that read", async () => {
    const h = duelHarness();
    await h.svc.lock(duelLockBody(fillsBlock({ aLegs: GOOD, bLegs: BIG })));
    h.advance(AFTER - T0);
    okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    // One read for two players. A per-player read would be two, and the second
    // could straddle the book's 15-second refresh.
    expect(h.book.reads()).toBe(1);
  });

  test("THE RETRY ATTACK: a losing player cannot call again until the sign flips", async () => {
    // The failure this freeze exists to prevent. A holds the mediocre basket
    // and loses. The book then moves decisively in A's favour — ETH collapses,
    // BTC rips — and A calls again. And again after the deadline refresh, which
    // is the one path that genuinely re-signs.
    const b = book();
    const h = duelHarness(b);
    await h.svc.lock(duelLockBody(fillsBlock({ aLegs: BIG, bLegs: GOOD })));
    h.advance(AFTER - T0);

    const first = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(first.winner).toBe(B);

    b.set(SNAP_AT + 60_000, { [ETH]: 0.001, [BTC]: 99 });
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(B);

    h.advance(29 * 60_000); // past DEADLINE_REFRESH_BELOW_SECONDS — a real re-sign
    const late = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(late.winner).toBe(B);
    expect(late.signature).not.toBe(first.signature); // a new deadline…
    expect(b.reads()).toBe(1); // …over the same frozen snapshot
  });

  test("an empty book is refused BEFORE it can be frozen", async () => {
    // A soft read failure wearing a timestamp. Freezing it would refuse this
    // duel permanently on one bad read, so it is refused and not stored — and a
    // later good read still settles the duel.
    const b = book(SNAP_AT, {});
    const h = duelHarness(b);
    await h.svc.lock(duelLockBody(fillsBlock({ aLegs: GOOD, bLegs: BIG })));
    h.advance(AFTER - T0);

    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "market snapshot has no marks",
    });
    expect(h.signed).toEqual([]);

    b.set(SNAP_AT + 1_000, MARKS);
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(A);
    expect(b.reads()).toBe(2);
  });

  test("first-write-wins pins the SLATES too, not only the picks", async () => {
    // Otherwise the duel clock would reopen the exact hole commit-then-derive
    // closes: watch the book, then re-lock a basket that already won.
    const h = duelHarness();
    const first = okLock(await h.svc.lock(duelLockBody(fillsBlock({ aLegs: BIG, bLegs: GOOD }))));

    const relock = okLock(await h.svc.lock(duelLockBody(fillsBlock({ aLegs: GOOD, bLegs: BIG }))));
    expect(relock.fillsCommit).toBe(first.fillsCommit);
    expect(relock.note).toBe("already locked");

    h.advance(AFTER - T0);
    // Scored on the FIRST slates: A holds BIG and still loses.
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(B);
  });
});

describe("sign nothing — plan 6 §C3, and there is no tiebreak", () => {
  /** A duel-clock harness that has already locked the given baskets and moved
   *  the clock past the end. */
  async function ready(
    aLegs: readonly FilledLeg[],
    bLegs: readonly FilledLeg[],
    b: Book = book(),
  ): Promise<Harness & { book: Book }> {
    const h = duelHarness(b);
    okLock(await h.svc.lock(duelLockBody(fillsBlock({ aLegs, bLegs }))));
    h.advance(AFTER - T0);
    return h;
  }

  test("scores level to 6dp sign nothing", async () => {
    //   A  ETH: (0.50 − 0.25) × 2 = +0.50 on 1.00  →  0.5
    //   B  BTC: (2.25 − 2.00) × 4 = +1.00 on 2.00  →  0.5
    // Two genuinely different positions with the same return. No coin flip.
    const h = await ready([filled(ETH, 0.25, 2, 1)], [filled(BTC, 2, 4, 2)]);
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: `scores level to ${SCORE_DP}dp`,
    });
    expect(h.signed).toEqual([]);
  });

  test("a difference below the sixth decimal is also a tie", async () => {
    //   B  (0.25 × 8) ÷ 4.000001 = 0.49999987… — inside 6dp of A's 0.5
    const h = await ready(
      [filled(ETH, 0.25, 2, 1)],
      [filled(BTC, 2, 8, 4), filled(ETH, 0.5, 8, 0.000001)],
    );
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: `scores level to ${SCORE_DP}dp`,
    });
  });

  test("an unmarkable leg signs nothing, and the refusal names it", async () => {
    // Named on purpose: a player can check "DOGE-27SEP26-1-C had no mark"
    // against the same public book. "No verdict" is not checkable by anybody.
    for (const [aLegs, bLegs] of [
      [GOOD, UNMARKABLE],
      [UNMARKABLE, BIG],
      [UNMARKABLE, UNMARKABLE],
    ] as const) {
      const h = await ready(aLegs, bLegs);
      expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
        ok: false,
        reason: "unmarkable leg: DOGE-27SEP26-1-C",
      });
      expect(h.signed).toEqual([]);
    }
  });

  test("a partially marked basket is refused, not scored on the legs that marked", async () => {
    // The tempting bug: A's losing leg is the one with no mark, so dropping it
    // would hand A the duel.
    const h = await ready([filled(ETH, 0.25, 4, 1), filled("SOL-27SEP26-200-C", 9, 4, 1)], BIG);
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "unmarkable leg: SOL-27SEP26-200-C",
    });
  });

  test("a STALE snapshot signs nothing", async () => {
    // Past MARK_MAX_LAG_MS the marks describe an hour of news nobody was
    // playing. The refund is the honest answer.
    const h = await ready(GOOD, BIG, book(ENDS_AT + MARK_MAX_LAG_MS + 1));
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "market snapshot is stale",
    });
    expect(h.signed).toEqual([]);
    // And the boundary is inclusive on the good side, so an honest player who
    // took a wallet prompt is not refunded out of a pot they won.
    const edge = await ready(GOOD, BIG, book(ENDS_AT + MARK_MAX_LAG_MS));
    expect(okAttest(await edge.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(A);
  });

  test("a snapshot from BEFORE the duel ended signs nothing", async () => {
    // Scoring a duel on marks that predate its end is scoring a different duel.
    const h = await ready(GOOD, BIG, book(ENDS_AT - 1));
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "market snapshot predates the duel",
    });
    expect(h.signed).toEqual([]);
  });

  test("no market source at all signs nothing — it never falls back to the tape", async () => {
    // The most important of the refusals: with no book, the honest answer is the
    // refund. Falling back to `deriveVerdict` here would pay a winner nobody's
    // marks chose, on a duel whose players bought real options.
    const h = harness(T0, null, null);
    okLock(await h.svc.lock(duelLockBody(fillsBlock({ aLegs: GOOD, bLegs: BIG }))));
    h.advance(AFTER - T0);
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "no market source",
    });
    expect(h.signed).toEqual([]);
  });

  test("a book that refuses passes its reason through, and signs nothing", async () => {
    const h = await ready(GOOD, BIG, deadBook("market unreachable"));
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "market unreachable",
    });
    expect(h.signed).toEqual([]);
  });

  test("a book that THROWS is a refusal, not a crash and not a fallback", async () => {
    const exploding: MarkSource = {
      read: async () => {
        throw new Error("ECONNRESET");
      },
    };
    const h = harness(T0, null, exploding);
    okLock(await h.svc.lock(duelLockBody(fillsBlock({ aLegs: GOOD, bLegs: BIG }))));
    h.advance(AFTER - T0);
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "market unreachable",
    });
    expect(h.signed).toEqual([]);
  });

  test("a snapshot with no timestamp signs nothing", async () => {
    const undated: MarkSource = {
      read: async () => ({ at: Number.NaN, marks: marksMap() }),
    };
    const h = harness(T0, null, undated);
    okLock(await h.svc.lock(duelLockBody(fillsBlock({ aLegs: GOOD, bLegs: BIG }))));
    h.advance(AFTER - T0);
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "market snapshot has no timestamp",
    });
  });

  test("EVERY refusal leaves no verdict behind — the refund path stays open", async () => {
    // The escrow's six-hour timeout needs nothing at all from this server. What
    // it needs is that this server never signs the wrong thing, so a refusal
    // must leave `status` reading `attested: false` — a client that saw `true`
    // would sit waiting for a payout that does not exist.
    const h = await ready(GOOD, UNMARKABLE);
    const duelId = id(MATCH_KEY);
    await h.svc.attest({ matchKey: MATCH_KEY });
    const st = okStatus(h.svc.status(duelId));
    expect(st.locked).toBe(true);
    expect(st.attested).toBe(false);
    expect(st.winner).toBeUndefined();

    const res = await h.svc.handleAttest(
      new Request("http://localhost/api/attest", {
        method: "POST",
        body: JSON.stringify({ matchKey: MATCH_KEY }),
      }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "unmarkable leg: DOGE-27SEP26-1-C" });
  });
});

describe("the slates are the players' own, and the request cannot state them", () => {
  test("each seat signs its own slate — a cannot state b's fills", async () => {
    // If `a` could write `b`'s entry marks, `a` could hand itself the duel by
    // giving `b` a basket that had already lost.
    const h = duelHarness();
    const forged = fillsBlock({ aLegs: GOOD, bLegs: BIG, bSigner: SEAT_A });
    expect(await h.svc.lock(duelLockBody(forged))).toEqual({
      ok: false,
      reason: "b fills are not b's",
    });
    // And nothing was stored, so the seat is still free for an honest lock.
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(false);
  });

  test("nor can b state a's", async () => {
    const h = duelHarness();
    expect(await h.svc.lock(duelLockBody(fillsBlock({ aSigner: SEAT_B })))).toEqual({
      ok: false,
      reason: "a fills are not a's",
    });
  });

  test("a stranger's signature on either slate is refused", async () => {
    const h = duelHarness();
    expect(await h.svc.lock(duelLockBody(fillsBlock({ aSigner: SEAT_S })))).toEqual({
      ok: false,
      reason: "a fills are not a's",
    });
    expect(await h.svc.lock(duelLockBody(fillsBlock({ bSigner: SEAT_S })))).toEqual({
      ok: false,
      reason: "b fills are not b's",
    });
  });

  test("legs tampered with after signing are refused", async () => {
    // The attacker's real position: a valid signature over one basket, and a
    // wish for it to authorise another.
    const h = duelHarness();
    const honest = fillsBlock({ aLegs: GOOD, bLegs: BIG });
    const tampered = {
      ...honest,
      a: { ...(honest["a"] as object), legs: [filled(ETH, 0.01, 200, 0.01)] },
    };
    expect(await h.svc.lock(duelLockBody(tampered))).toEqual({
      ok: false,
      reason: "a fills are not a's",
    });
  });

  test("a slate signed for another match, or another end time, does not travel", async () => {
    const h = duelHarness();
    expect(await h.svc.lock(duelLockBody(fillsBlock({ signMatchKey: `${LOBBY_ID}:999999` })))).toEqual({
      ok: false,
      reason: "a fills are not a's",
    });
    expect(await h.svc.lock(duelLockBody(fillsBlock({ signEndsAt: ENDS_AT + 1 })))).toEqual({
      ok: false,
      reason: "a fills are not a's",
    });
  });

  test("the slate message is order-independent in exactly the way the score is", async () => {
    // `canonicalLegs` sorts, so the order the fills happened in — which is book
    // depth, not a decision — cannot change the string that was signed.
    const legs = [filled(BTC, 2, 6, 3), filled(ETH, 0.25, 2, 0.5)];
    const reversed = [...legs].reverse();
    expect(canonicalLegs(legs)).toBe(canonicalLegs(reversed));
    expect(fillsMessage(MATCH_KEY, A, ENDS_AT, legs)).toBe(
      fillsMessage(MATCH_KEY, A, ENDS_AT, reversed),
    );

    // …so a slate signed in one order locks when sent in the other.
    const h = duelHarness();
    const sig = SEAT_A.signMessageSync(fillsMessage(MATCH_KEY, A, ENDS_AT, legs));
    const fills = {
      endsAt: ENDS_AT,
      a: { legs: reversed, sig },
      b: { legs: BIG, sig: SEAT_B.signMessageSync(fillsMessage(MATCH_KEY, B, ENDS_AT, BIG)) },
    };
    expect(okLock(await h.svc.lock(duelLockBody(fills))).fillsCommit).toBe(
      fillsCommitOf(ENDS_AT, legs, BIG),
    );
  });

  test("the slate message is the five-line string a client can rebuild", () => {
    const msg = fillsMessage(MATCH_KEY, A, ENDS_AT, GOOD);
    expect(msg.split("\n")).toEqual([
      FILLS_MESSAGE_PREFIX,
      `matchKey:${MATCH_KEY}`,
      `seat:${A}`,
      `endsAt:${ENDS_AT}`,
      `legs:${canonicalLegs(GOOD)}`,
    ]);
    expect(msg.endsWith("\n")).toBe(false);
    // And it is a different prefix from the lock's, because a different person
    // signs it: seat `b` signs a slate and never signs a lock.
    expect(FILLS_MESSAGE_PREFIX).not.toBe(LOCK_MESSAGE_PREFIX);
    expect(verifyMessage(msg, SEAT_A.signMessageSync(msg))).toBe(A);
  });

  test("a's lock signature binds the slates — they cannot be added or stripped", async () => {
    // The sixth line. A five-line message is never equal to a six-line one, so
    // an attacker can neither bolt slates onto a signed tape lock nor strip them
    // off a signed duel-clock one: the server rebuilds whichever the REQUEST's
    // shape calls for, and recovery must land on `a` exactly.
    const h = duelHarness();

    // Bolted on: a body carrying fills, signed over the five-line message.
    expect(await h.svc.lock(duelLockBody(fillsBlock(), { signCommit: null }))).toEqual({
      ok: false,
      reason: "signature is not a's",
    });

    // Stripped off: a body with no fills, signed over the six-line message.
    const sixLine = SEAT_A.signMessageSync(
      lockMessage(MATCH_KEY, A, B, WINNING_SLIP, fillsCommitOf(ENDS_AT, GOOD, BIG)),
    );
    expect(
      await h.svc.lock({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B, sig: sixLine }),
    ).toEqual({ ok: false, reason: "signature is not a's" });

    // Swapped: a different pair of slates under a signature over the first pair.
    const swapped = duelLockBody(fillsBlock({ aLegs: BIG, bLegs: GOOD }), {
      signCommit: fillsCommitOf(ENDS_AT, GOOD, BIG),
    });
    expect(await h.svc.lock(swapped)).toEqual({ ok: false, reason: "signature is not a's" });

    // None of the three consumed the seat.
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(false);
  });

  test("the fills commit binds the end time as well as both baskets", () => {
    expect(fillsCommitOf(ENDS_AT, GOOD, BIG)).not.toBe(fillsCommitOf(ENDS_AT + 1, GOOD, BIG));
    expect(fillsCommitOf(ENDS_AT, GOOD, BIG)).not.toBe(fillsCommitOf(ENDS_AT, BIG, GOOD));
    expect(fillsCommitOf(ENDS_AT, GOOD, BIG)).toBe(fillsCommitOf(ENDS_AT, [...GOOD], [...BIG]));
  });

  test("a duel clock needs both seats — an open b cannot have a basket", async () => {
    const h = duelHarness();
    expect(await h.svc.lock(duelLockBody(fillsBlock(), { b: null }))).toEqual({
      ok: false,
      reason: "fills need both seats",
    });
  });

  test("a malformed slate is refused with a reason, never normalised into one", async () => {
    const h = duelHarness();
    const base = fillsBlock();
    const aSlate = base["a"] as Record<string, unknown>;
    const bad: ReadonlyArray<[unknown, string]> = [
      [{ ...base, a: { ...aSlate, legs: [] } }, "a filled nothing"],
      [{ ...base, a: { ...aSlate, legs: "nope" } }, "bad a legs"],
      [
        {
          ...base,
          a: { ...aSlate, legs: Array.from({ length: 13 }, () => filled(ETH, 0.25, 1, 1)) },
        },
        "too many a legs",
      ],
      [{ ...base, a: { ...aSlate, legs: [{ ...GOOD[0]!, instrument: "" }] } }, "bad a instrument"],
      // A price that arrived as a string is a client bug: coercing it would put
      // a different double in the score than the one that was signed.
      [{ ...base, a: { ...aSlate, legs: [{ ...GOOD[0]!, premium: "0.50" }] } }, "bad a premium"],
      [{ ...base, a: { ...aSlate, legs: [{ ...GOOD[0]!, contracts: 0 }] } }, "bad a contracts"],
      [{ ...base, a: { ...aSlate, legs: [{ ...GOOD[0]!, entryMark: -1 }] } }, "bad a entryMark"],
      [{ ...base, a: { ...aSlate, legs: [{ ...GOOD[0]!, premium: Number.NaN }] } }, "bad a premium"],
      [{ ...base, a: { ...aSlate, sig: "0xdead" } }, "bad a fills signature"],
      [{ ...base, a: { ...aSlate, sig: undefined } }, "missing a fills signature"],
      [{ ...base, a: undefined }, "missing a fills"],
      [{ ...base, b: undefined }, "missing b fills"],
      [{ ...base, endsAt: "soon" }, "bad endsAt"],
      [{ ...base, endsAt: ENDS_AT + 0.5 }, "bad endsAt"],
      [{ ...base, endsAt: T0 + MAX_ENDS_AT_SKEW_MS + 1 }, "bad endsAt"],
      [{ ...base, endsAt: T0 - MAX_ENDS_AT_SKEW_MS - 1 }, "bad endsAt"],
      ["not an object", "bad fills"],
      [42, "bad fills"],
      [[], "bad fills"],
    ];
    for (const [fills, reason] of bad) {
      const res = await h.svc.lock({ ...duelLockBody(base), fills });
      expect(`${reason} → ${(res as AttestFail).reason}`).toBe(`${reason} → ${reason}`);
    }
    // Not one of them stored anything.
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(false);
    expect(h.book.reads()).toBe(0);
  });
});

describe("THE MONEY TEST, on the duel clock: the request states nothing", () => {
  test("a client-supplied winner is ignored, exactly as on the tape", async () => {
    // The same assertion as the tape path's, re-run where the winner now comes
    // from marks. `/api/attest` trusts one field of the body and it is the
    // match key.
    const h = duelHarness();
    await h.svc.lock(duelLockBody(fillsBlock({ aLegs: BIG, bLegs: GOOD }))); // derives to B
    h.advance(AFTER - T0);
    for (const claimed of [A, STRANGER, ATTESTOR.address, `0x${"0".repeat(40)}`]) {
      expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY, winner: claimed })).winner).toBe(B);
    }
  });

  test("nor can the request supply the marks, the slates, the scores or the end time", async () => {
    // Every input the verdict is computed from, offered in the body at once. The
    // server reads its own book, its own committed slates and its own clock.
    const h = duelHarness();
    await h.svc.lock(duelLockBody(fillsBlock({ aLegs: BIG, bLegs: GOOD })));
    h.advance(AFTER - T0);
    const res = okAttest(
      await h.svc.attest({
        matchKey: MATCH_KEY,
        winner: A,
        marks: { [ETH]: 99, [BTC]: 0.0001 },
        snapshot: { at: AFTER, marks: { [ETH]: 99 } },
        fills: fillsBlock({ aLegs: GOOD, bLegs: BIG }),
        endsAt: T0,
        picks: LOSING_SLIP,
        a: STRANGER,
        b: STRANGER,
        aScore: 99,
        bScore: -1,
      }),
    );
    expect(res.winner).toBe(B);
    expect(h.book.reads()).toBe(1); // its own book, read once
  });

  test("the clock the duel is scored against is the COMMITTED one", async () => {
    // `endsAt` was signed by both seats at lock time and hashed into `a`'s lock
    // signature. A later request naming an earlier end cannot re-open a window.
    const h = duelHarness();
    await h.svc.lock(duelLockBody(fillsBlock()));
    expect(await h.svc.attest({ matchKey: MATCH_KEY, endsAt: T0 })).toEqual({
      ok: false,
      reason: "duel has not ended",
    });
    expect(h.signed).toEqual([]);
  });
});

describe("the tape path survives phase C untouched", () => {
  test("a lock with no slates settles on the tape and never reads a book", async () => {
    // Plan 6 §8: "reverts cleanly — tape path still present". The seeded game
    // still plays here, and a server whose duels all settle on the tape reads
    // no market data at all.
    const b = book();
    const h = duelHarness(b);
    await locked(h, WINNING_SLIP);
    h.advance(AFTER - T0);
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(
      expectedWinner(WINNING_SLIP),
    );
    expect(b.reads()).toBe(0);
  });

  test("a tape lock carries no fillsCommit, and its message is still five lines", async () => {
    const h = duelHarness();
    expect(okLock(await h.svc.lock(lockBody(SEAT_A))).fillsCommit).toBeUndefined();
    expect(lockMessage(MATCH_KEY, A, B, WINNING_SLIP).split("\n")).toHaveLength(5);
    expect(
      lockMessage(MATCH_KEY, A, B, WINNING_SLIP, fillsCommitOf(ENDS_AT, GOOD, BIG)).split("\n"),
    ).toHaveLength(6);
  });

  test("`fills: null` and `fills: undefined` are the tape, not a malformed duel", async () => {
    for (const fills of [null, undefined]) {
      const b = book();
      const h = duelHarness(b);
      expect(okLock(await h.svc.lock({ ...lockBody(SEAT_A), fills })).fillsCommit).toBeUndefined();
      h.advance(AFTER - T0);
      expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(
        expectedWinner(WINNING_SLIP),
      );
      expect(b.reads()).toBe(0);
    }
  });

  test("which clock settles a duel is decided by the COMMIT, never by the request", async () => {
    // A tape lock cannot be talked onto the duel clock by an attest body, and a
    // duel-clock lock cannot be talked back onto the tape. There is no flag.
    const h = duelHarness();
    await locked(h, WINNING_SLIP);
    h.advance(AFTER - T0);
    expect(
      okAttest(await h.svc.attest({ matchKey: MATCH_KEY, fills: fillsBlock(), endsAt: ENDS_AT }))
        .winner,
    ).toBe(expectedWinner(WINNING_SLIP));
    expect(h.book.reads()).toBe(0);
  });
});

describe("the snapshot reducer fails closed", () => {
  test("an MM chain yields instrument → mark", () => {
    const marks = marksFromSnapshot({
      mmPricing: {
        ETH: [{ ticker: "ETH-3SEP26-2100-C", mark: "0.4212", bid: "0.41", ask: "0.43" }],
        BTC: [{ ticker: "BTC-3SEP26-70000-P", mark: "1.5", bid: "1.4", ask: "1.6" }],
      },
    });
    expect(marks.get("ETH-3SEP26-2100-C")).toBe(0.4212);
    expect(marks.get("BTC-3SEP26-70000-P")).toBe(1.5);
    expect(marks.size).toBe(2);
  });

  test("a lone bid or ask is NEVER a mark", () => {
    // A one-sided level has no fair value, and treating it as one would
    // systematically flatter whichever player held the thin leg.
    const marks = marksFromSnapshot({
      orders: [
        { instrument: "X-C", bid: "1.2" },
        { instrument: "Y-C", ask: "3.4" },
        { instrument: "Z-C", px: "9.9", size: "10" },
      ],
    });
    expect(marks.size).toBe(0);
  });

  test("`mark` wins over `mid`, and `mid` is only a fallback", () => {
    expect(marksFromSnapshot({ orders: [{ instrument: "X-C", mark: "1", mid: "2" }] }).get("X-C")).toBe(1);
    expect(marksFromSnapshot({ orders: [{ instrument: "X-C", mid: "2" }] }).get("X-C")).toBe(2);
  });

  test("the first writer wins per instrument, and mmPricing is visited first", () => {
    // A quote's own mark must never be overwritten by a neighbouring row's
    // midpoint.
    const marks = marksFromSnapshot({
      mmPricing: { ETH: [{ ticker: "X-C", mark: "1" }] },
      pricing: { ETH: [{ ticker: "X-C", mark: "2" }] },
      orders: [{ instrument: "X-C", mark: "3" }],
    });
    expect(marks.get("X-C")).toBe(1);
  });

  test("anything it does not recognise contributes NO mark", () => {
    // Fail closed, in one list: a row with no mark is a leg with no mark, which
    // is a duel that signs nothing and refunds. There is no path from "the
    // snapshot changed shape" to "somebody was paid on a wrong number".
    for (const snapshot of [
      null,
      undefined,
      42,
      "a string",
      [],
      {},
      { mmPricing: null },
      { mmPricing: { ETH: "not rows" } },
      { mmPricing: { ETH: [null, 7, "x"] } },
      { mmPricing: { ETH: [{ mark: "1" }] } }, //               no name
      { mmPricing: { ETH: [{ ticker: "", mark: "1" }] } }, //   empty name
      { mmPricing: { ETH: [{ ticker: "X-C" }] } }, //           no mark
      { mmPricing: { ETH: [{ ticker: "X-C", mark: "—" }] } }, // the "no MM price" sentinel
      { mmPricing: { ETH: [{ ticker: "X-C", mark: "1.2 (stale)" }] } },
      { mmPricing: { ETH: [{ ticker: "X-C", mark: "-1" }] } },
      { mmPricing: { ETH: [{ ticker: "X-C", mark: Number.NaN }] } },
      { mmPricing: { ETH: [{ ticker: "X-C", mark: null }] } },
      { mmPricing: { ETH: [{ ticker: "X-C", mark: {} }] } },
    ]) {
      expect(marksFromSnapshot(snapshot).size).toBe(0);
    }
  });

  test("a numeric mark is taken as-is, and zero is a real price", () => {
    // A worthless option is worth zero, which is a mark. Only a *missing* one is
    // unmarkable.
    expect(marksFromSnapshot({ orders: [{ instrument: "X-C", mark: 0 }] }).get("X-C")).toBe(0);
    expect(marksFromSnapshot({ orders: [{ instrument: "X-C", mark: 0.5 }] }).get("X-C")).toBe(0.5);
  });

  test("a reduced snapshot drives a real verdict end to end", async () => {
    // The two halves joined: the reducer's output IS the map the score reads,
    // and the instrument key is the book's own name for the thing, verbatim.
    //
    // `usdMarksFromSnapshot`, and `markUsd` rather than `mark`, because the map
    // the score reads is dollars — see the reducer's own describe block below.
    const reduced = usdMarksFromSnapshot({
      mmPricing: {
        ETH: [{ ticker: ETH, mark: "0.0002", markUsd: "0.5" }],
        BTC: [{ ticker: BTC, mark: "0.00003", markUsd: "2.25" }],
      },
    });
    const source: MarkSource = { read: async () => ({ at: SNAP_AT, marks: reduced }) };
    const h = harness(T0, null, source);
    okLock(await h.svc.lock(duelLockBody(fillsBlock({ aLegs: BIG, bLegs: GOOD }))));
    h.advance(AFTER - T0);
    expect(okAttest(await h.svc.attest({ matchKey: MATCH_KEY })).winner).toBe(B);
  });
});

/**
 * ─── the DOLLAR reducer, which is the only one the duel clock may use ────────
 *
 * `marksFromSnapshot` above reads the venue's own numbers in the venue's own
 * units, and those units are not one currency: a market-maker `markPrice` is
 * quoted in units of the underlying (FINDINGS §1) while a `mid` off the signed
 * order book is already USDC per contract. Both are honest readings of the book
 * and neither is money the same way, so the score — which divides by a USDC
 * premium — cannot use either.
 *
 * `usdMarksFromSnapshot` therefore reads **one field, `markUsd`**, which the
 * server wrote by multiplying a mark by the spot that same market-maker quote
 * was made against. It copies; it never converts. Everything else contributes
 * nothing, and nothing is a refund.
 */
describe("usdMarksFromSnapshot reads dollars, and only dollars", () => {
  test("markUsd is what it takes, keyed by the market maker's own ticker", () => {
    const marks = usdMarksFromSnapshot({
      mmPricing: {
        ETH: [{ ticker: "ETH-3SEP26-2100-C", mark: "0.1166", spot: "2375.7600", markUsd: "277.0136" }],
        BTC: [{ ticker: "BTC-3SEP26-70000-P", mark: "0.0100", spot: "81004.0400", markUsd: "810.0404" }],
      },
    });
    expect(dollars(marks.get("ETH-3SEP26-2100-C"))).toBe(277.0136);
    expect(dollars(marks.get("BTC-3SEP26-70000-P"))).toBe(810.0404);
    expect(marks.size).toBe(2);
  });

  test("a mark with no markUsd contributes NOTHING — no spot, no score", () => {
    // The row is perfectly good and perfectly unscoreable: the market maker
    // quoted a price and published no spot to value it in dollars, so the
    // server wrote no `markUsd`. Reaching for `mark` here would divide ETH by
    // USDC; reaching for a spot elsewhere in the snapshot would join two feeds
    // read at two instants. Both are refused by reading one field.
    const marks = usdMarksFromSnapshot({
      mmPricing: { ETH: [{ ticker: "ETH-3SEP26-2100-C", mark: "0.1166", spot: "—" }] },
    });
    expect(marks.size).toBe(0);
    expect(dollars(marks.get("ETH-3SEP26-2100-C"))).toBeUndefined();
  });

  test("neither `mark` nor `mid` nor a bid is ever a dollar mark", () => {
    // Every field a well-meaning edit might fall back to, refused in one list.
    // `mid` is the sharpest of them: it IS dollars (the order book prices in
    // USDC), so a fallback to it would be right for order-book rows and wrong
    // for market-maker ones, which is the worst kind of nearly-working.
    for (const row of [
      { ticker: "X-C", mark: "1.5" },
      { ticker: "X-C", mid: "1.5" },
      { ticker: "X-C", bid: "1.4", ask: "1.6" },
      { ticker: "X-C", mark: "1.5", spot: "2000" },
      { ticker: "X-C", markUsd: "—" },
      { ticker: "X-C", markUsd: "3000 USD" },
      { ticker: "X-C", markUsd: Number.NaN },
      { ticker: "X-C", markUsd: null },
      { ticker: "X-C", markUsd: "-1" },
      { markUsd: "1.5" }, //             no name
      { ticker: "", markUsd: "1.5" }, // empty name
    ]) {
      expect(usdMarksFromSnapshot({ mmPricing: { ETH: [row] } }).size).toBe(0);
    }
  });

  test("a numeric zero is a real dollar price; a missing one is not a price", () => {
    expect(dollars(usdMarksFromSnapshot({ mmPricing: { ETH: [{ ticker: "X-C", markUsd: 0 }] } }).get("X-C"))).toBe(0);
    expect(dollars(usdMarksFromSnapshot({ mmPricing: { ETH: [{ ticker: "X-C", markUsd: 0.5 }] } }).get("X-C"))).toBe(0.5);
  });

  test("it fails closed on every shape it does not recognise", () => {
    for (const snapshot of [
      null,
      undefined,
      42,
      "a string",
      [],
      {},
      { mmPricing: null },
      { mmPricing: { ETH: "not rows" } },
      { mmPricing: { ETH: [null, 7, "x"] } },
    ]) {
      expect(usdMarksFromSnapshot(snapshot).size).toBe(0);
    }
  });

  test("a pricing row joins on markTicker, which is the MM's name and not the book's", () => {
    // The namespace defect, in the reducer. An order-book row names itself
    // `ETH-3SEP-2100-C` (no year) under `instrument`, and that name marks
    // nothing. The same row carries `markTicker` — the ticker of the MM quote
    // whose mark it borrowed — and THAT is the key a fill can copy and score by.
    const marks = usdMarksFromSnapshot({
      pricing: {
        ETH: [
          {
            instrument: "ETH-3SEP-2100-C",
            markTicker: "ETH-3SEP26-2100-C",
            mark: "0.1166",
            markUsd: "277.0136",
          },
        ],
      },
    });
    expect(dollars(marks.get("ETH-3SEP26-2100-C"))).toBe(277.0136);
    expect(dollars(marks.get("ETH-3SEP-2100-C"))).toBeUndefined();
  });

  test("first writer wins, and mmPricing is still visited first", () => {
    const marks = usdMarksFromSnapshot({
      mmPricing: { ETH: [{ ticker: "X-C", markUsd: "1" }] },
      pricing: { ETH: [{ markTicker: "X-C", markUsd: "2" }] },
      orders: [{ instrument: "X-C", markUsd: "3" }],
    });
    expect(dollars(marks.get("X-C"))).toBe(1);
  });

  test("the two reducers disagree by a factor of spot, and the types keep them apart", () => {
    // Both read the same row. One returns the venue's 0.1166, the other the
    // 276.91 dollars that is; the difference is the whole defect, and it is
    // 2,375× — not a rounding error, a different currency.
    const snapshot = {
      mmPricing: { ETH: [{ ticker: "ETH-3SEP26-2100-C", mark: "0.1166", markUsd: "277.0136" }] },
    };
    expect(marksFromSnapshot(snapshot).get("ETH-3SEP26-2100-C")).toBe(0.1166);
    expect(dollars(usdMarksFromSnapshot(snapshot).get("ETH-3SEP26-2100-C"))).toBe(277.0136);
    // `marksFromSnapshot` returns `Map<string, number>` and `MarkSnapshot.marks`
    // wants `ReadonlyMap<string, UsdPerContract>`, so the wrong one of these two
    // cannot be wired into a `MarkSource` without an `as` a reviewer would have
    // to explain. That is a compile-time assertion; this line is the note that
    // it exists.
    expect(marksFromSnapshot(snapshot).size).toBe(1);
  });

  test("an unconvertible book signs nothing — the whole path, end to end", async () => {
    // Every mark present, every spot missing, so nothing is in dollars. The
    // attestor must refuse, and the six-hour refund does the rest. This is the
    // state a duel on a quote with no published spot is in, and it must never
    // become a signature.
    const reduced = usdMarksFromSnapshot({
      mmPricing: {
        ETH: [{ ticker: ETH, mark: "0.5" }],
        BTC: [{ ticker: BTC, mark: "2.25" }],
      },
    });
    expect(reduced.size).toBe(0);

    const source: MarkSource = { read: async () => ({ at: SNAP_AT, marks: reduced }) };
    const h = harness(T0, null, source);
    okLock(await h.svc.lock(duelLockBody(fillsBlock())));
    h.advance(AFTER - T0);
    // An empty book is refused before the freeze, so the refusal is the
    // snapshot's and not the score's — and either way nothing is signed.
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "market snapshot has no marks",
    });
    expect(h.signed).toEqual([]);
  });

  test("one leg convertible and one not still signs nothing", async () => {
    // The partial case, which is the dangerous one: a book with marks in it
    // looks healthy, and scoring the legs it happens to cover would hand the
    // duel to whichever player's unquoted leg was the missing one.
    const reduced = usdMarksFromSnapshot({
      mmPricing: {
        ETH: [{ ticker: ETH, markUsd: "0.5" }],
        BTC: [{ ticker: BTC, mark: "2.25" }], // quoted, no spot, no dollars
      },
    });
    expect(reduced.size).toBe(1);

    const source: MarkSource = { read: async () => ({ at: SNAP_AT, marks: reduced }) };
    const h = harness(T0, null, source);
    okLock(await h.svc.lock(duelLockBody(fillsBlock({ aLegs: GOOD, bLegs: BIG }))));
    h.advance(AFTER - T0);
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: `unmarkable leg: ${BTC}`,
    });
    expect(h.signed).toEqual([]);
  });
});
