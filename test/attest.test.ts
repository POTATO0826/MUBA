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
  BASE_CHAIN_ID,
  DEADLINE_SECONDS,
  VERDICT_DOMAIN_NAME,
  VERDICT_DOMAIN_VERSION,
  LOCK_MESSAGE_PREFIX,
  VERDICT_TYPES,
  createAttestService,
  deriveVerdict,
  lockMessage,
  type AttestEnvelope,
  type AttestFail,
  type AttestOk,
  type AttestService,
  type LockEnvelope,
  type LockOk,
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
const WINNING_SLIP: Record<string, string> = { TSLA: "safe-bear", AMD: "safe-bull", META: "safe-bull" };
const LOSING_SLIP: Record<string, string> = { TSLA: "safe-bull", AMD: "safe-bull", META: "safe-bull" };

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

/** A service on the throwaway key, a fake clock and a fake escrow address. */
function harness(at = T0): Harness {
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
    svc: createAttestService({ signer, escrow: ESCROW, now: () => clock }),
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
function locked(h: Harness, picks: Record<string, string> = WINNING_SLIP, b: string | null = B): LockOk {
  return okLock(h.svc.lock(lockBody(SEAT_A, { picks, b })));
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
  chainId: BigInt(BASE_CHAIN_ID),
  verifyingContract,
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the fixture duel is the one the rest of the repo pins", () => {
  test("kz-semis at seed 424242 deals TSLA, AMD, META", () => {
    // If this changes, the two slips below stop being a win and a loss and
    // every "verdict flips" assertion becomes vacuous.
    expect([...ARENA]).toEqual(["TSLA", "AMD", "META"]);
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
  test("a first lock returns the duel id, the commit and no note", () => {
    const res = locked(harness());
    expect(res.duelId).toBe(id(MATCH_KEY));
    expect(res.duelId).toBe(keccak256(toUtf8Bytes(MATCH_KEY)));
    expect(res.matchKey).toBe(MATCH_KEY);
    expect(res.commit).toMatch(/^0x[0-9a-f]{64}$/);
    expect(res.note).toBeUndefined();
  });

  test("a second lock on the same match returns the FIRST payload and says so", () => {
    const h = harness();
    const first = locked(h, WINNING_SLIP);

    // Different picks, different seats, later in time, and PROPERLY SIGNED by
    // the seat it claims — the whole point is that none of it can touch what is
    // already committed. Authentication (X-1) and idempotency are separate
    // defences and this asserts the second one on its own.
    h.advance(60_000);
    const second = okLock(h.svc.lock(lockBody(SEAT_S, { picks: LOSING_SLIP, b: A })));

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
    locked(h, LOSING_SLIP);
    h.svc.lock(lockBody(SEAT_S, { picks: WINNING_SLIP, b: A }));

    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(res.winner).toBe(expectedWinner(LOSING_SLIP));
    expect(res.winner).toBe(B);
  });

  test("a malformed second lock cannot evict the first either", () => {
    const h = harness();
    const first = locked(h);
    h.svc.lock({ matchKey: MATCH_KEY, picks: { NOPE: "safe-bull" }, a: STRANGER });
    h.svc.lock({ matchKey: MATCH_KEY });
    expect(okLock(h.svc.lock(lockBody(SEAT_A, { picks: LOSING_SLIP }))).commit).toBe(first.commit);
  });

  test("the commit is canonical: key order in the request cannot change it", () => {
    const forwards = locked(harness(), { TSLA: "safe-bear", AMD: "safe-bull", META: "safe-bull" });
    const backwards = locked(harness(), { META: "safe-bull", AMD: "safe-bull", TSLA: "safe-bear" });
    expect(backwards.commit).toBe(forwards.commit);
    // …but a different slip is a different commit.
    expect(locked(harness(), LOSING_SLIP).commit).not.toBe(forwards.commit);
  });
});

describe("lock refuses everything it cannot re-derive", () => {
  const fails = (body: unknown): string => {
    const res = harness().svc.lock(body);
    if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res)}`);
    return res.reason;
  };

  test("an unknown lobby — a room published in someone's own browser is unsettleable", () => {
    // `mine-1` exists in exactly one tab (state/match.ts:298). The server cannot
    // re-derive its book, its legs or its mode, so it must not sign for it.
    expect(fails({ matchKey: `mine-1:${SEED}`, picks: WINNING_SLIP, a: A, b: B })).toContain(
      "unknown lobby",
    );
    expect(fails({ matchKey: `not-a-lobby:${SEED}`, picks: WINNING_SLIP, a: A, b: B })).toContain(
      "unknown lobby",
    );
  });

  test("a seed outside the range the game can deal", () => {
    // `newSeed` mints 100000..999999 (engine/spin.ts:52-54). `parseRoute` would
    // read `?seed=7` out of a hand-typed URL; a duel with USDC behind it is not
    // where that gets accepted.
    for (const seed of [7, 99_999, 1_000_000, 424_242_424]) {
      expect(fails({ matchKey: `${LOBBY_ID}:${seed}`, picks: WINNING_SLIP, a: A, b: B })).toBe("bad seed");
    }
    expect(fails({ matchKey: `${LOBBY_ID}:-424242`, picks: WINNING_SLIP, a: A, b: B })).toBe("bad seed");
    expect(fails({ matchKey: `${LOBBY_ID}:4242.42`, picks: WINNING_SLIP, a: A, b: B })).toBe("bad seed");
  });

  test("a pick id that is not one of the eight cards", () => {
    for (const bad of ["safe-bulll", "SAFE-BULL", "", "godmode"]) {
      const picks = { ...WINNING_SLIP, TSLA: bad };
      expect(fails({ matchKey: MATCH_KEY, picks, a: A, b: B })).toContain("unknown card");
    }
    // Every real card id passes the same gate.
    for (const card of PARLAY_CARDS) {
      const res = harness().svc.lock(lockBody(SEAT_A, { picks: { ...WINNING_SLIP, TSLA: card.id } }));
      expect(res.ok).toBe(true);
    }
  });

  test("keys that are not exactly the symbols this seed dealt", () => {
    const want = "picks must cover exactly";
    // A leg short: the client would have previewed it at EVEN/over — a preview
    // is not a position and a partial slip is not settleable.
    expect(fails({ matchKey: MATCH_KEY, picks: { TSLA: "safe-bull", AMD: "safe-bull" }, a: A, b: B })).toContain(want);
    // One leg too many: a caller widening the commit past the arena.
    expect(
      fails({ matchKey: MATCH_KEY, picks: { ...WINNING_SLIP, NVDA: "safe-bull" }, a: A, b: B }),
    ).toContain(want);
    // The right count, the wrong tickers.
    expect(
      fails({ matchKey: MATCH_KEY, picks: { NVDA: "safe-bull", AAPL: "safe-bull", MSFT: "safe-bull" }, a: A, b: B }),
    ).toContain(want);
    // And the arena of a DIFFERENT seed in the same lobby.
    const other = spinCase(bookOf(LOBBY), LOBBY.legs, 424243).syms;
    if (JSON.stringify([...other].sort()) !== JSON.stringify([...ARENA].sort())) {
      const picks = Object.fromEntries(other.map((s) => [s, "safe-bull"]));
      expect(fails({ matchKey: MATCH_KEY, picks, a: A, b: B })).toContain(want);
    }
  });

  test("a missing or unparseable committing address", () => {
    expect(fails({ matchKey: MATCH_KEY, picks: WINNING_SLIP })).toBe("missing a");
    expect(fails({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: "0xnope" })).toBe("bad a");
    expect(fails({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: "0xnope" })).toBe("bad b");
    // The zero address is never a seat that can be paid.
    expect(fails({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: `0x${"0".repeat(40)}` })).toBe("bad a");
  });

  test("a match key that is not one", () => {
    expect(fails({ picks: WINNING_SLIP, a: A })).toBe("missing matchKey");
    expect(fails({ matchKey: "   ", picks: WINNING_SLIP, a: A })).toBe("missing matchKey");
    expect(fails({ matchKey: 424242, picks: WINNING_SLIP, a: A })).toBe("missing matchKey");
    expect(fails({ matchKey: `${LOBBY_ID}:${SEED}<script>`, picks: WINNING_SLIP, a: A })).toBe("bad matchKey");
    expect(fails({ matchKey: `${"x".repeat(200)}:${SEED}`, picks: WINNING_SLIP, a: A })).toBe("matchKey too long");
    expect(fails({ matchKey: LOBBY_ID, picks: WINNING_SLIP, a: A })).toBe("bad matchKey");
  });

  test("addresses come back checksummed, whatever case they arrived in", async () => {
    const h = harness();
    // Lower-case in the body, checksummed in the signed message — the
    // canonical message normalises, so one signature covers both spellings and
    // a client is not forced to reproduce EIP-55 casing to be believed.
    okLock(
      h.svc.lock({
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
  const refused = (body: unknown): string => {
    const res = harness().svc.lock(body);
    if (res.ok) throw new Error(`expected a refusal, got ${JSON.stringify(res)}`);
    return res.reason;
  };

  test("a lock signed by `a` is accepted, over the exact message a client can rebuild", () => {
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
      `picks:${JSON.stringify({ AMD: "safe-bull", META: "safe-bull", TSLA: "safe-bear" })}`,
    ].join("\n");

    const rebuilt = lockMessage(MATCH_KEY, A, B, WINNING_SLIP);
    expect(rebuilt).toBe(expected);
    expect(rebuilt.split("\n")).toHaveLength(5);
    expect(rebuilt.startsWith(`${LOCK_MESSAGE_PREFIX}\n`)).toBe(true);
    expect(rebuilt.endsWith("\n")).toBe(false);

    const body = lockBody(SEAT_A);
    expect(verifyMessage(expected, body["sig"] as string)).toBe(A);
    expect(okLock(harness().svc.lock(body)).commit).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("no signature at all is refused — this is the whole of X-1", () => {
    for (const sig of [undefined, null, ""]) {
      expect(refused({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B, sig })).toBe(
        "missing signature",
      );
    }
    // And the exploit body verbatim: B searches for a winning slip and names
    // themselves `a`, with nothing to prove it.
    expect(refused({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: B, b: A })).toBe("missing signature");
  });

  test("a signature that is not 65 bytes of hex is refused before it reaches ethers", () => {
    for (const sig of ["0x", "0xdeadbeef", `0x${"ab".repeat(64)}`, `0x${"ab".repeat(66)}`, `0x${"zz".repeat(65)}`, 42, {}, []]) {
      expect(refused({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B, sig })).toBe("bad signature");
    }
  });

  test("well-shaped 65 bytes that recover to nobody are a bad signature, not a crash", () => {
    // `r = s = 0`, `v = 27`: the right length and the right `v`, but no point
    // on the curve. ethers throws; the route must not.
    expect(refused({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B, sig: `0x${"00".repeat(64)}1b` })).toBe(
      "bad signature",
    );
  });

  test("a signature by the wrong key is refused", () => {
    // B signs, but the body claims A. This is the impersonation the finding is
    // about, and it is the one thing a signature can prove is false.
    const forged = { ...lockBody(SEAT_B, { b: A }), a: A, b: B };
    expect(refused(forged)).toBe("signature is not a's");
    // The attestor's own key does not get a pass either.
    expect(refused({ ...lockBody(SEAT_A), sig: ATTESTOR.signMessageSync(lockMessage(MATCH_KEY, A, B, WINNING_SLIP)) })).toBe(
      "signature is not a's",
    );
  });

  test("picks tampered with after signing are refused", () => {
    // The attacker's real position: a valid signature over the slip they were
    // willing to sign, pointed at the winning slip they found offline.
    const body = lockBody(SEAT_A, { picks: LOSING_SLIP });
    expect(refused({ ...body, picks: WINNING_SLIP })).toBe("signature is not a's");
    // Even a single leg moved — the picks are bound whole, canonically.
    expect(refused({ ...body, picks: { ...LOSING_SLIP, TSLA: "safe-bear" } })).toBe("signature is not a's");
  });

  test("the match key cannot be swapped after signing", () => {
    const other = `${LOBBY_ID}:424243`;
    const body = lockBody(SEAT_A, { picks: WINNING_SLIP });
    // A signature harvested from one duel replayed onto another. The arena of
    // seed 424243 may differ, so drive the refusal past the picks gate by
    // signing for the OTHER key and posting it at this one.
    const forSeedTwo = lockBody(SEAT_A, { matchKey: other, picks: WINNING_SLIP });
    expect(refused({ ...forSeedTwo, matchKey: MATCH_KEY })).toBe("signature is not a's");
    expect(okLock(harness().svc.lock(body)).duelId).toBe(id(MATCH_KEY));
  });

  test("the opponent seat cannot be swapped after signing", () => {
    // `b` is who gets paid when the slip loses, so it is money and it is bound.
    const body = lockBody(SEAT_A, { b: B });
    expect(refused({ ...body, b: STRANGER })).toBe("signature is not a's");
    // Including dropping it entirely: a lock signed for a taken seat is not a
    // lock for an open one.
    const { b: _dropped, ...withoutB } = body;
    expect(refused(withoutB)).toBe("signature is not a's");
    // And the reverse — signed open, posted taken.
    expect(refused({ ...lockBody(SEAT_A, { b: null }), b: B })).toBe("signature is not a's");
  });

  test("an open second seat is signed as the zero address, and `\"\"` or `null` mean the same", () => {
    const open = lockBody(SEAT_A, { b: null });
    expect(lockMessage(MATCH_KEY, A, null, WINNING_SLIP)).toContain(`b:0x${"0".repeat(40)}`);
    for (const b of [undefined, null, "", `0x${"0".repeat(40)}`]) {
      const h = harness();
      const res = h.svc.lock(b === undefined ? open : { ...open, b });
      expect(res.ok).toBe(true);
    }
  });

  test("a refused lock does not consume first-write-wins", () => {
    // The property that keeps the fix from becoming its own denial of service:
    // an attacker spraying unsigned or forged locks must not be able to burn
    // the seat, or to evict a commit once one is stored.
    const h = harness();
    h.svc.lock({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B }); // unsigned
    h.svc.lock({ ...lockBody(SEAT_B, { b: A }), a: A }); // forged
    h.svc.lock({ ...lockBody(SEAT_A), sig: `0x${"11".repeat(65)}` }); // junk
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(false);

    // The seat is still free, and the honest lock takes it — note-free, which
    // is how a FIRST write is spelled.
    const good = okLock(h.svc.lock(lockBody(SEAT_A, { picks: LOSING_SLIP })));
    expect(good.note).toBeUndefined();
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(true);
    // …and what is stored is the honest payload, not any of the three above.
    const probe = okLock(h.svc.lock(lockBody(SEAT_S, { picks: WINNING_SLIP, b: A })));
    expect(probe.note).toBe("already locked");
    expect(probe.commit).toBe(good.commit);
  });

  test("nothing is ever signed for a duel whose lock was refused", async () => {
    const h = harness();
    h.svc.lock({ matchKey: MATCH_KEY, picks: WINNING_SLIP, a: A, b: B });
    expect(await h.svc.attest({ matchKey: MATCH_KEY })).toEqual({ ok: false, reason: "not locked" });
    expect(h.signed).toEqual([]);
    expect(okStatus(h.svc.status(id(MATCH_KEY))).locked).toBe(false);
  });

  test("the signed message is order-independent in exactly the way the commit is", () => {
    // A client that builds its picks object in arena order and a server that
    // sorts must still agree on one string, or every honest lock fails.
    const forwards = lockMessage(MATCH_KEY, A, B, { TSLA: "safe-bull", AMD: "safe-bear", META: "safe-bull" });
    const backwards = lockMessage(MATCH_KEY, A, B, { META: "safe-bull", AMD: "safe-bear", TSLA: "safe-bull" });
    expect(backwards).toBe(forwards);
    // A signature made over one ordering authorises the other ordering's body.
    const sig = SEAT_A.signMessageSync(forwards);
    const res = harness().svc.lock({
      matchKey: MATCH_KEY,
      picks: { META: "safe-bull", AMD: "safe-bear", TSLA: "safe-bull" },
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
    const res = okLock(h.svc.lock(lockBody(SEAT_A, { matchKey: NONCE_KEY })));
    expect(res.matchKey).toBe(NONCE_KEY);
    // The duel id is keccak over the WHOLE key, so a nonced room is a different
    // duel on chain — which is the entire point.
    expect(res.duelId).toBe(id(NONCE_KEY));
    expect(res.duelId).not.toBe(id(MATCH_KEY));
    // …and the nonce touches nothing else: same seed, same arena, same winner.
    expect(res.commit).toBe(okLock(harness().svc.lock(lockBody(SEAT_A))).commit);
    const verdict = okAttest(await h.svc.attest({ matchKey: NONCE_KEY }));
    expect(verdict.winner).toBe(expectedWinner(WINNING_SLIP));
  });

  test("two rooms on one seed are two independent duels", () => {
    const h = harness();
    okLock(h.svc.lock(lockBody(SEAT_A, { matchKey: `${MATCH_KEY}:roomAlpha` })));
    // A second room, same lobby and seed: first-write-wins does not collide,
    // because the nonce is in the key.
    const second = okLock(h.svc.lock(lockBody(SEAT_A, { matchKey: `${MATCH_KEY}:roomBravo`, picks: LOSING_SLIP })));
    expect(second.note).toBeUndefined();
    expect(okStatus(h.svc.status(id(`${MATCH_KEY}:roomAlpha`))).locked).toBe(true);
    expect(okStatus(h.svc.status(id(`${MATCH_KEY}:roomBravo`))).locked).toBe(true);
  });

  test("the nonce must begin with a letter, so a seed is never read as one", () => {
    // A trailing all-digit segment is the SEED, always — which is what keeps
    // every key the app mints today parsing exactly as it did before.
    const h = harness();
    for (const bad of [`${MATCH_KEY}:123456`, `${MATCH_KEY}:ab`, `${MATCH_KEY}:-nonce`, `${MATCH_KEY}:9lives`]) {
      const res = h.svc.lock(lockBody(SEAT_A, { matchKey: bad }));
      // Fail-closed: the whole `lobby:seed` head is then read as a lobby id,
      // and there is no such lobby.
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.reason).toContain("unknown lobby");
    }
  });

  test("a two-segment key is never mistaken for lobby-plus-nonce", () => {
    // `kz-semis:abcd` has a nonce-shaped tail and no seed. It must stay a bad
    // seed, not become a lobby with a nonce and no seed at all.
    const res = harness().svc.lock(lockBody(SEAT_A, { matchKey: `${LOBBY_ID}:abcd` }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("bad seed");
  });

  test("the nonce is inside the signed message, like every other field", () => {
    const body = lockBody(SEAT_A, { matchKey: NONCE_KEY });
    // Stripping the nonce from a signed body is a different room and a
    // different duel id, and the signature does not follow it there.
    const res = harness().svc.lock({ ...body, matchKey: MATCH_KEY });
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
    // Base mainnet. The contract reads `block.chainid`, so this is the one
    // domain field no source read can confirm — it is pinned here instead.
    expect(BASE_CHAIN_ID).toBe(8453);
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
    locked(h, WINNING_SLIP);
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));

    // 1. Transcribed from the Solidity, line for line.
    const domainSeparator = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          keccak256(toUtf8Bytes(DOMAIN_TYPE_STRING!)),
          keccak256(toUtf8Bytes(CONTRACT_DOMAIN_NAME!)),
          keccak256(toUtf8Bytes(CONTRACT_DOMAIN_VERSION!)),
          BigInt(BASE_CHAIN_ID),
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
    locked(h, WINNING_SLIP);
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
    locked(h, WINNING_SLIP);
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
    locked(h);
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
    locked(h);
    const res = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(DEADLINE_SECONDS).toBe(1_800);
    expect(res.deadline).toBe(Math.floor(T0 / 1000) + 1_800);
    expect(Number.isSafeInteger(res.deadline)).toBe(true);
  });

  test("the escrow address the service signs against is the domain it was given", async () => {
    const h = harness();
    locked(h);
    await h.svc.attest({ matchKey: MATCH_KEY });
    expect(h.signed).toHaveLength(1);
    expect(h.signed[0]!.domain).toEqual({
      name: CONTRACT_DOMAIN_NAME!,
      version: CONTRACT_DOMAIN_VERSION!,
      // The literal, not `BASE_CHAIN_ID` — the constant is the thing being
      // pinned. The contract binds its domain to `block.chainid`, so a verdict
      // signed for any chain but Base mainnet recovers to a stranger on chain.
      chainId: 8453,
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
    locked(win, WINNING_SLIP);
    const winRes = okAttest(await win.svc.attest({ matchKey: MATCH_KEY }));

    const lose = harness();
    locked(lose, LOSING_SLIP);
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
    locked(h, LOSING_SLIP); // derives to B
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
    locked(h, WINNING_SLIP, null);
    const res = await h.svc.attest({ matchKey: MATCH_KEY });
    expect(res).toEqual({ ok: false, reason: "duel has no opponent seat" });
    expect(h.signed).toEqual([]);
  });

  test("attest re-validates the match key it is handed", async () => {
    const h = harness();
    locked(h);
    for (const body of [{}, { matchKey: "" }, { matchKey: `mine-1:${SEED}` }, { matchKey: `${LOBBY_ID}:7` }]) {
      const res = await h.svc.attest(body);
      expect(res.ok).toBe(false);
    }
    expect(h.signed).toEqual([]);
  });

  test("two calls in the same instant return the identical signature", async () => {
    const h = harness();
    locked(h);
    const first = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    const second = okAttest(await h.svc.attest({ matchKey: MATCH_KEY }));
    expect(second).toEqual(first);
    expect(h.signed).toHaveLength(1);
  });

  test("a call near expiry re-signs the same winner with a fresh deadline", async () => {
    // The winner is a pure derivation and can never move; the deadline is wall
    // clock and a stale one is a signature the relay may not land in time.
    const h = harness();
    locked(h);
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
    locked(h);
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

    locked(h, LOSING_SLIP);
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

  test("the id is read case-insensitively, as a hash spelling and not a value", () => {
    const h = harness();
    locked(h);
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
      post({ matchKey: MATCH_KEY, picks: { TSLA: "nope" }, a: A }),
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
    locked(h);
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
      const svc = createAttestService({ escrow: ESCROW, now: () => T0 });
      return {
        lock: svc.lock(lockBody(SEAT_A)),
        status: svc.status(id(MATCH_KEY)),
        attest: svc.attest({ matchKey: MATCH_KEY }),
      };
    });
    expect(res.lock).toEqual(NOT_CONFIGURED);
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
      now: () => T0,
    });
    okLock(svc.lock(lockBody(SEAT_A)));
    expect(await svc.attest({ matchKey: MATCH_KEY })).toEqual({
      ok: false,
      reason: "escrow not configured",
    });
  });
});
