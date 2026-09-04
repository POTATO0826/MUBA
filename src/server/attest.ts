/**
 * The settlement referee: commit the picks, then derive the verdict.
 *
 * `contracts/DuelEscrow.sol` pays the winner of a duel against one EIP-712
 * signature from the attestor key. This module is the only thing in the repo
 * that holds that key, and the only thing that decides who won. Four rules
 * follow from that, and everything below is arranged around them:
 *
 *  1. **The server never reads a winner from a request.** `/api/attest` takes a
 *     `matchKey` and nothing else. The winner is re-derived here, from the
 *     seed and the committed picks, using the same pure engine functions the
 *     client rendered the result screen with.
 *
 *  2. **The verdict is NOT a pure function of `(lobby, seed)`** — plan 5 §P5.
 *     The opponent's slip is (`oppLegs` falls straight out of the seed), but
 *     *your* slip is whatever you picked, and a duel between two different
 *     slips on the same seed has two different winners. So the picks have to
 *     reach the server before they can be settled, and they have to be pinned
 *     before the outcome is knowable: hence **commit-then-derive**.
 *
 *     `POST /api/lock` commits `{matchKey, picks, a, b, sig}` **first-write-
 *     wins**.
 *     A second lock on the same match — different picks, different addresses,
 *     any picks at all — returns the FIRST payload untouched and says so. That
 *     one property is what stops a losing player from re-locking a winning slip
 *     after watching the tape. `POST /api/attest` then re-derives and signs.
 *
 *  3. **The lock is signed by `a`** — finding X-1 of the adversarial review
 *     (`docs/reviews/escrow-adversarial-review.md`).
 *
 *     Commit-then-derive pins the slip, but for a while nothing proved *whose*
 *     slip it was: `a`, `b` and `picks` all came straight out of an
 *     unauthenticated request body. Because the outcome is a pure function of
 *     `(lobby, seed, picks)` over ≤ 4 096 reachable slips, anyone who knew the
 *     match key could search offline for a winning slip, `POST` it naming
 *     **themselves** `a` and a real player `b`, and this module would then
 *     honestly sign a verdict paying them. The escrow would pay it correctly —
 *     its only payee constraint is `winner ∈ {a, b}`, and that held.
 *
 *     So a lock now carries `sig`: a 65-byte **EIP-191 personal signature** by
 *     `a` over a canonical message binding the match, the picks and both seats.
 *     The message is built by `lockMessage()` below and is exactly:
 *
 *         THETADUEL_LOCK_V1\n
 *         matchKey:<matchKey verbatim>\n
 *         a:<a, EIP-55 checksummed>\n
 *         b:<b checksummed, or the zero address for an open seat>\n
 *         picks:<canonicalPicks(picks)>
 *
 *     — five `\n`-joined lines, no trailing newline, signed with
 *     `personal_sign` / `wallet.signMessage`. Every field the server would
 *     otherwise have taken on trust is inside it, in its **normalised** form
 *     (the same canonical pick ordering the commit hashes, addresses
 *     checksummed), so a client can reproduce the string byte for byte and a
 *     man in the middle cannot re-point a valid signature at other picks,
 *     another match or a different opponent. `verifyMessage` must recover
 *     exactly `a` or the lock is refused — and a refused lock writes nothing,
 *     so it can neither evict a stored commit nor consume first-write-wins for
 *     a later valid one.
 *
 *     What this closes: nobody can lock a match naming an address they do not
 *     control. **What it does not close on its own** — the counterparty can
 *     still claim the `a` seat, because `b` is a real address with a real key
 *     and in the intended flow `a` hands them the room link. That is point 4,
 *     and it is why a signature alone was never going to be enough. The rest
 *     stays open:
 *
 *       - *Operator collusion.* This is still not commit-reveal: the server
 *         sees the picks in the clear and holds the only key that signs
 *         verdicts, so a dishonest operator can always collude with a player.
 *         That residual is stated in the contract's natspec (`TRUST MODEL`,
 *         note 1) and in the README, and the escape hatch is the escrow's
 *         unconditional six-hour refund, which needs no cooperation from this
 *         server at all.
 *       - *Smart-contract wallets.* `verifyMessage` is ECDSA recovery, so an
 *         EIP-1271 / ERC-6492 signature from a smart-contract wallet is
 *         refused rather than mis-verified. It fails closed; supporting it
 *         means an on-chain `isValidSignature` call, which is P6 work.
 *
 *  4. **The seats are read from the chain, not from the body** — the residual
 *     of X-1, and the hard prerequisite for staking.
 *
 *     Point 3 proves the caller controls the address they name. It cannot prove
 *     that address is *playing this duel*, and the person best placed to
 *     exploit that gap is the opponent: `b` knows the match key, can search the
 *     ≤ 4 096 slips offline for one that wins, and can sign a perfectly valid
 *     lock naming **themselves** in the `a` seat. Every check in point 3
 *     passes. No larger signature fixes it, because every field of the request
 *     belongs to the attacker.
 *
 *     The one witness that cannot be forged is the escrow, where both seats
 *     were bought with a stake: `a` paid to `open`, `b` paid to `join`.
 *     `src/server/seats.ts` reads them back out of the contract's `duels`
 *     getter, and `lock()` **compares instead of believing**. The full
 *     disposition, which is the security-relevant part of this module:
 *
 *     | escrow (`THETADUEL_ESCROW` + `RPC_URL`) | on-chain state | lock |
 *     |---|---|---|
 *     | not configured | — | accepted on the signature alone, exactly as before |
 *     | configured | duel is `FULL`, seats match `a`/`b` in order | accepted |
 *     | configured | claimed `a` is not the on-chain opener | `"not a seat in this duel"` |
 *     | configured | `a` matches, claimed `b` is not the on-chain joiner | `"opponent is not the on-chain seat"` |
 *     | configured | id never opened (`NONE`) | `"seats not on chain"` |
 *     | configured | still `OPEN` — nobody has joined | `"opponent has not joined on chain"` |
 *     | configured | `SETTLED` or `REFUNDED` | `"duel is closed on chain"` |
 *     | configured | RPC unreachable, wrong chain, unparseable | `"chain unreachable"` / `"bad chain response"` |
 *
 *     Four things about that table are load-bearing:
 *
 *       - **Unconfigured is byte-identical to the old behaviour.** A demo with
 *         no escrow and no RPC is the PTS-only app, and it must keep working
 *         with no chain anywhere near it. `test/attest.test.ts` asserts that
 *         path explicitly so a later edit cannot quietly start requiring one.
 *       - **The match is ORDERED — `a` is the on-chain opener.** Comparing the
 *         two seats as an unordered set would close nothing at all: the whole
 *         attack is `b` swapping the seats, and `{b, a}` equals `{a, b}`. The
 *         asymmetry is real rather than a convention: the escrow writes `d.a`
 *         in `open` and `d.b` in `join` and never rewrites either, and in this
 *         game the seats are not interchangeable either — `a` is the seat whose
 *         picks were committed and whose slip is played against the *seeded*
 *         opponent, while `b` is betting against it. So the room's opener is
 *         the player who locks. A joiner who locks is refused, by design.
 *       - **A configured escrow makes `/api/lock` the staked path only.** With
 *         an escrow set, a lock for a duel that was never opened on chain is
 *         refused — there is nothing to settle and nothing to pay. PTS-only
 *         duels never call this route.
 *       - **It fails CLOSED.** If the escrow is configured and the chain cannot
 *         be reached, the lock is refused rather than falling back to trusting
 *         the body. Falling back would be worse than never having read the
 *         chain: an attacker who can make one RPC time out — a burst of
 *         requests against a throttled endpoint will do — would restore the
 *         exact hole this closes, and would do it precisely when nobody is
 *         watching. A refused lock costs an honest player a retry; a trusted
 *         body costs them their stake.
 *
 *  5. **A match key may carry a per-room nonce** — finding 6-1.
 *
 *     `matchKey` is `` `${lobbyId}:${seed}` `` (`state/match.ts:429`), which is
 *     six lobbies × 900 000 seeds: the reviewer recovered a preimage from an
 *     on-chain `duelId` by brute force in 30 ms, then squatted the id so the
 *     real room could never `open()`. `parseMatchKey` therefore also accepts an
 *     optional third segment — `` `${lobbyId}:${seed}:${nonce}` `` — that the
 *     derivation ignores entirely and that only has to be unguessable. The
 *     nonce must begin with a letter, which is what keeps the seed segment
 *     unambiguous: a tail of pure digits is always the seed, never a nonce.
 *     Minting one belongs to whatever mints a room; the grammar lives here so
 *     that adopting it needs no change to this module.
 *
 *  6. **Two clocks — a duel is settled on marks, an option settles at expiry.**
 *     Plan 6 §C. This is what the verdict is now computed FROM; every rule
 *     above about who may ask for one is untouched.
 *
 *     An option expires on a Friday and a duel lasts four minutes, so the
 *     verdict cannot be the option's settlement. It is instead the **duel
 *     clock**: `src/engine/score.ts`'s `duelScore` — Σ (mark_now − mark_entry) ×
 *     contracts ÷ Σ premium_paid — computed for both seats off **one** market
 *     snapshot, taken at or after the duel's declared end. The option itself
 *     keeps running on the **expiry clock**, on chain, and the player keeps the
 *     position they bought whichever way the pot went. Nothing is simulated on
 *     either clock.
 *
 *     What the attestor reads, in order, and nothing else:
 *
 *       a. the committed slates — pinned by the same first-write-wins commit
 *          that pins the picks, each one carrying its OWN seat's EIP-191
 *          signature so neither player can state the other's position;
 *       b. one market snapshot, from this server's own market source, taken at
 *          or after `endsAt` and within `MARK_MAX_LAG_MS` of it;
 *       c. nothing from the request but the match key.
 *
 *     **The first in-window snapshot is FROZEN onto the lock and reused for
 *     every later call.** Without that, a losing player could simply call the
 *     route again after the next book refresh until the sign flipped — the
 *     duel would be decided by whoever retried most patiently. Freezing makes
 *     the verdict a function of the commit and one snapshot, permanently, which
 *     is also what makes it reproducible by anybody holding both.
 *
 *     **Sign nothing** — plan 6 §C3 — when the two scores are level to 6dp,
 *     when either basket has a leg the snapshot cannot mark, when the snapshot
 *     is stale or predates the duel's end, or when there is no snapshot at all.
 *     There is deliberately no tiebreak: the escrow's unconditional six-hour
 *     refund returns both stakes rake-free, needs nothing from this server, and
 *     is a better answer than a coin flip over real money.
 *
 *     **The residual, stated plainly.** A committed slate is the player's own
 *     assertion about a fill: this server does not read the OptionBook to
 *     confirm the contracts or the premium. It is bound (each seat signs its
 *     own slate; `a` signs a commitment to both), pinned before the outcome is
 *     knowable (first-write-wins), and seat-checked on chain (point 4) — but a
 *     player who lies about their own entry mark is lying to a referee that
 *     cannot yet check. The mitigation is the same one the operator-collusion
 *     residual has and the same one the contract's natspec names: the six-hour
 *     refund, plus a counterparty who can see the same public book. Verifying a
 *     slate against the OptionBook's own fill events is P6 work, not a rewrite
 *     of this rule.
 *
 *     **The tape path is still here and is still the default.** A lock with no
 *     slates settles exactly as it did before — `deriveVerdict` off `(lobby,
 *     seed, picks)` — which is what the seeded game plays. The duel clock is
 *     reached only by a lock that committed two slates, so this phase reverts by
 *     deleting a branch (plan 6 §8: "tape path still present").
 *
 * Shape and style are `src/server/news.ts`'s, deliberately:
 *  - **Injectable.** `createAttestService({ signer, now, escrow, seats })` —
 *    the tests pass a throwaway `Wallet`, a fake clock and a seat reader over a
 *    fake provider, and never touch a chain or a key file.
 *  - **Never throws at the route.** Every handler answers HTTP 200 with a typed
 *    envelope; `ok` is the client's only decision.
 *  - **Bounded, oldest-evicting cache** with a TTL (`put`, mirroring
 *    news.ts:317).
 *
 * The determinism guard (`test/determinism.test.ts`) forbids `/api/attest` and
 * `/api/lock` inside `src/engine/**` and `src/state/match.ts`. It says nothing
 * about this direction: a server module importing the pure engine is exactly
 * what makes the server's verdict the same verdict the player saw. The arrow
 * runs attest ← engine and never back.
 */

import { LOBBIES, YOU, bookOf, canPlay, opponentOf } from "../data/lobbies.ts";
import { MODES, MODE_SALT } from "../data/modes.ts";
import { settle } from "../engine/match.ts";
import { PARLAY_CARDS, cardById, legForCard, type ParlayCard, type ParlayLeg } from "../engine/parlay.ts";
import { SCORE_DP, duelOutcome, type FilledLeg } from "../engine/score.ts";
import { seededRandom, spinCase } from "../engine/spin.ts";
import { Wallet, ZeroAddress, getAddress, id, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
import { createSeatReader, type SeatReader } from "./seats.ts";
import { createMarketService } from "./thetanuts.ts";
import type { LobbyDef } from "../types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// The EIP-712 domain — must equal the contract's, byte for byte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `DuelEscrow`'s constructor folds these four fields into `DOMAIN_SEPARATOR`
 * (contracts/DuelEscrow.sol:231-239): the literal `"THETADUEL"`, the literal
 * `"1"`, `block.chainid` and `address(this)`.
 *
 * `chainId` is hard-coded to Base mainnet because the escrow is only ever
 * deployed there (plan 5: "no testnet exists"), and a wrong chain id produces a
 * signature that recovers to a stranger — money lost, silently. It is a
 * constant here so that it can only be wrong in one place, and
 * `test/attest.test.ts` recomputes the digest against these exact values.
 */
export const VERDICT_DOMAIN_NAME = "THETADUEL";
export const VERDICT_DOMAIN_VERSION = "1";
export const BASE_CHAIN_ID = 8453;

/**
 * The struct `settle` checks: contracts/DuelEscrow.sol:161-162,
 * `keccak256("Verdict(bytes32 duelId,address winner,uint64 deadline)")`. Field
 * names, order and types all enter the typehash — one rename is a different
 * digest, so this list is transcribed and never "tidied".
 */
export const VERDICT_TYPES = {
  Verdict: [
    { name: "duelId", type: "bytes32" },
    { name: "winner", type: "address" },
    { name: "deadline", type: "uint64" },
  ],
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a committed lock stays settleable.
 *
 * Generous on purpose, unlike news.ts's 30-minute snapshot TTL: that one bounds
 * the gap between two page loads, this one bounds the gap between locking a
 * slip and a signature actually landing on chain — which can include a wallet
 * prompt, a failed transaction, a re-broadcast, and a player wandering off. The
 * escrow's own refund timeout is six hours (`TIMEOUT`), so twenty-four hours
 * here comfortably outlives every duel this server can still usefully settle.
 */
export const LOCK_TTL_MS = 86_400_000;

/** Bounded and oldest-evicting, like both news caches: a long-lived dev server
 *  must not accumulate one entry per duel it has ever seen. */
const CACHE_MAX = 200;

/** Seconds of validity on a signed verdict. Plan 5 §P5: `deadline = now+30min`.
 *  Long enough to relay through a congested block, short enough that a leaked
 *  signature for a duel that later refunds is worthless. */
export const DEADLINE_SECONDS = 1_800;

/**
 * Below this many seconds of remaining life, a repeat `/api/attest` re-signs
 * with a fresh deadline instead of replaying the cached signature.
 *
 * The decision this encodes: **the winner is cached forever, the signature is
 * cached only while it is still useful.** The winner is a pure derivation, so
 * re-deriving it can never change it — caching it is an optimisation, not a
 * guarantee. The deadline is wall-clock, so a signature handed back verbatim
 * ten minutes before it expires is a signature the relay may not land in time.
 * Two calls in the same instant therefore return the identical signature (which
 * is what `test/attest.test.ts` asserts), and a call near expiry returns the
 * same winner with a new deadline and a new signature. Both are correct; only
 * the winner is ever allowed to be stable.
 */
export const DEADLINE_REFRESH_BELOW_SECONDS = 300;

/**
 * The seed range `newSeed` produces: `100000 + floor(random() * 900000)` —
 * `src/engine/spin.ts:52-54`, "six digits so it reads cleanly in a URL".
 *
 * `parseRoute` will happily read `?seed=7` out of a hand-typed URL
 * (`src/lib/route.ts:49-50`), but nothing in the app ever *mints* such a seed,
 * and a duel with real USDC behind it is not the place to accept a seed the
 * game could not have dealt. Locks outside the range are refused.
 */
export const SEED_MIN = 100_000;
export const SEED_MAX = 999_999;

/** Sanity bound on the one attacker-controlled string, as news.ts:928. */
const MAX_MATCHKEY_LEN = 128;

// ── the duel clock (point 6) ─────────────────────────────────────────────────

/**
 * How far past the duel's declared end a market snapshot may be taken and still
 * be the snapshot this duel is scored on.
 *
 * Ten minutes, and the two bounds pull in opposite directions. Too tight and an
 * honest player who took a wallet prompt, lost a transaction and retried gets a
 * refund instead of the pot they won. Too loose and the marks stop describing
 * the window the duel actually ran in — a basket scored an hour late is scored
 * on an hour of news nobody was playing.
 *
 * A snapshot that misses this window signs nothing, which is the six-hour
 * refund, which costs each player exactly their own stake back. That is the
 * failure this constant is allowed to have.
 */
export const MARK_MAX_LAG_MS = 600_000;

/**
 * The furthest a committed `endsAt` may sit from the lock that carries it.
 *
 * A duel is minutes long and is locked around its start, so anything outside a
 * day in either direction is not a duel this server could settle — and an
 * `endsAt` far in the future would pin a lock that can never reach its own
 * scoring window. Same order as `LOCK_TTL_MS`, for the same reason.
 */
export const MAX_ENDS_AT_SKEW_MS = LOCK_TTL_MS;

/** Legs per slate. The spin deals at most a handful; this is a bound on a
 *  request body, not a game rule. */
const MAX_FILLED_LEGS = 12;

/** Instrument names are book identifiers (`ETH-27SEP-4400-C`), not prose. */
const MAX_INSTRUMENT_LEN = 64;

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/** The failure envelope, shared by all three routes. Still HTTP 200. */
export interface AttestFail {
  ok: false;
  reason: string;
}

export interface LockOk {
  ok: true;
  /** `keccak256(utf8Bytes(matchKey))` — the escrow's documented client rule
   *  (contracts/DuelEscrow.sol:89-91), spelled `ethers.id` here. */
  duelId: string;
  /** `keccak256` over the canonical JSON of the committed picks. The client can
   *  show it; its real job is to make "what did you commit?" answerable without
   *  the server having to hand the picks back. */
  commit: string;
  matchKey: string;
  /**
   * `keccak256` over the canonical form of both committed slates and the
   * duel's declared end — present only when this lock committed them, i.e.
   * only on the duel clock (module docstring, point 6). Absent means this duel
   * settles on the tape, exactly as every lock did before phase C.
   *
   * It is the same line seat `a` signed inside the lock message, so a client
   * can check that what the server pinned is what it committed to.
   */
  fillsCommit?: string;
  /** Present only on a repeat lock — the payload is the FIRST one. */
  note?: string;
}

export type LockEnvelope = LockOk | AttestFail;

export interface AttestOk {
  ok: true;
  duelId: string;
  /** Checksummed address of whichever seat the derivation put ahead. */
  winner: string;
  /** Unix seconds. The escrow rejects a verdict past it. */
  deadline: number;
  /** 65-byte EIP-712 signature over `VERDICT_TYPES` in the escrow's domain. */
  signature: string;
}

export type AttestEnvelope = AttestOk | AttestFail;

/**
 * The app-level view of a duel. It reads NOTHING on chain — plan 5 §P6 polls
 * the chain itself for `DuelJoined`. This says only what this process knows:
 * whether the picks were committed here and whether a verdict was signed here.
 */
export interface StatusOk {
  ok: true;
  duelId: string;
  locked: boolean;
  attested: boolean;
  winner?: string;
}

export type StatusEnvelope = StatusOk | AttestFail;

/**
 * The minimum an attestor has to be. `ethers.Wallet` satisfies it; so does a
 * throwaway test key, and so would a KMS-backed signer later, which is the
 * reason this is structural rather than `Wallet`.
 */
export interface TypedDataSigner {
  getAddress(): Promise<string>;
  signTypedData(
    domain: { name: string; version: string; chainId: number | bigint; verifyingContract: string },
    types: Record<string, readonly { name: string; type: string }[]>,
    value: Record<string, unknown>,
  ): Promise<string>;
}

/**
 * One market snapshot, reduced to the only thing the duel clock wants from it:
 * when it was taken, and what every instrument in it was marked at.
 *
 * `at` is not decoration. It is what makes "stale" decidable, and staleness is
 * one of the four reasons this module signs nothing.
 */
export interface MarkSnapshot {
  /** When the snapshot was built, ms. */
  at: number;
  /** Instrument name, as the book spells it, → mark price per contract. */
  marks: ReadonlyMap<string, number>;
}

/**
 * Where the verdict's marks come from — **the server's own read of the book,
 * never the request**.
 *
 * One method, structurally typed, exactly as `SeatProvider` is one `call`: the
 * real implementation wraps this process's market service, a test hands over a
 * frozen fixture, and neither can reach the other's code path by accident. A
 * miss is typed rather than thrown, like every other read in this file.
 */
export interface MarkSource {
  read(): Promise<MarkSnapshot | { reason: string }>;
}

export interface AttestDeps {
  /** Injected in tests. Omitted in production, where the real signer is built
   *  lazily from `ATTESTOR_PRIVATE_KEY` on first use. */
  signer?: TypedDataSigner;
  /**
   * The duel clock's marks — module docstring, point 6.
   *
   * Same three-valued convention as `seats`:
   *
   *  - **omitted** — build one lazily over this process's own market service,
   *    on the FIRST duel-clock attest and never before. A server whose duels
   *    all settle on the tape therefore builds nothing and reads nothing, which
   *    is today's behaviour byte for byte.
   *  - **a source** — use it. A test injects a frozen snapshot.
   *  - **`null`** — there is no market source; every duel-clock attest signs
   *    nothing. Tests that mean "no book" say so out loud, for the same reason
   *    `seats: null` exists: `bun test` runs with `.env` loaded and a suite that
   *    silently started reading Base because of an operator's shell would be
   *    flaky and a privacy surprise.
   */
  marks?: MarkSource | null;
  now?: () => number;
  /** The `verifyingContract` half of the domain. Defaults to
   *  `THETADUEL_ESCROW`; injected in tests so no deployment is needed. */
  escrow?: string;
  /**
   * Where `lock()` learns who is actually playing — module docstring, point 4.
   *
   * Three values, three meanings, and the distinction matters:
   *
   *  - **omitted** — build one from the environment (`THETADUEL_ESCROW` +
   *    `RPC_URL`). If either is missing the reader reports itself unconfigured
   *    and the seat check is skipped. This is production.
   *  - **a reader** — use it. A test injects one over a fake provider.
   *  - **`null`** — seat binding is explicitly off.
   *
   * `null` exists for the test suite and is not a hole: `bun test` runs in a
   * shell that may well have a real `RPC_URL` and a real `THETADUEL_ESCROW`
   * exported — `.env` is loaded automatically — and a suite that silently
   * started calling Base because of an operator's shell would be both flaky and
   * a genuine privacy surprise. Tests that mean "no chain" say so out loud.
   */
  seats?: SeatReader | null;
}

export interface AttestService {
  /**
   * `POST /api/lock`. Always resolves, always 200.
   *
   * Body: `{ matchKey, picks, a, b?, sig, fills? }`. `sig` is `a`'s EIP-191
   * personal signature over `lockMessage(matchKey, a, b, picks, fillsCommit)` —
   * module docstring, point 3. Without it the lock is refused
   * `"missing signature"`. When an escrow is configured, `a` and `b` must also
   * be the duel's on-chain seats — point 4.
   *
   * `fills` is OPTIONAL and is what selects the clock (point 6). Omitted, the
   * duel settles on the tape exactly as it did before phase C. Present, it is
   * `{ endsAt, a: { legs, sig }, b: { legs, sig } }`, each slate signed by its
   * OWN seat over `fillsMessage(matchKey, seat, endsAt, legs)`, and the duel
   * settles on `duelScore` against one snapshot this server reads for itself.
   */
  handleLock(req: Request): Promise<Response>;
  /** `POST /api/attest`. Always resolves, always 200. */
  handleAttest(req: Request): Promise<Response>;
  /** `GET /api/duel-status?duelId=0x…`. Synchronous — it only reads memory. */
  handleStatus(url: URL): Response;
  /**
   * The same work without the HTTP envelope, for tests and in-process callers.
   *
   * Asynchronous because of the seat read (point 4), and asynchronous even when
   * no escrow is configured and no read happens: one signature is one contract
   * for every caller, and a route whose safety depends on which branch it took
   * is a route somebody eventually calls on the wrong branch.
   */
  lock(body: unknown): Promise<LockEnvelope>;
  attest(body: unknown): Promise<AttestEnvelope>;
  status(duelId: string): StatusEnvelope;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

/** One committed duel. Keyed by `duelId`, because that is what the status route
 *  and the chain both speak; `matchKey` rides along for the derivation. */
interface LockEntry {
  at: number;
  matchKey: string;
  lobbyId: string;
  seed: number;
  /** Card id per dealt symbol — exactly the symbols the seed dealt. */
  picks: Readonly<Record<string, string>>;
  commit: string;
  /** The committing player: the seat whose picks these are. */
  a: string;
  /** The opponent seat, or `null` while it is still open. */
  b: string | null;
  /**
   * The duel clock's committed input, or absent for a tape-settled duel
   * (module docstring, point 6). Both slates arrive in one lock, each already
   * verified against its own seat's signature, and are pinned by the same
   * first-write-wins rule as the picks — a slate cannot be revised after the
   * marks are knowable, which is the whole reason commit-then-derive exists.
   */
  fills?: {
    /** The duel's declared end, ms. The instant the snapshot must be at or
     *  after. */
    endsAt: number;
    a: readonly FilledLeg[];
    b: readonly FilledLeg[];
    commit: string;
  };
  /**
   * The snapshot this duel is scored on, FROZEN by the first attest that found
   * one inside the window and never re-read.
   *
   * This is a correctness property, not a cache. Re-reading would let a losing
   * player call the route again after every book refresh until the sign
   * flipped; the duel would go to whoever retried longest. Frozen, the verdict
   * is a function of the commit and one snapshot — permanently, and
   * reproducibly by anyone holding both.
   */
  marks?: MarkSnapshot;
  /** Filled by the first successful attest and never cleared. */
  verdict?: { winner: string; deadline: number; signature: string };
}

/**
 * `Map` iterates in insertion order, so "oldest" is the first key. The `delete`
 * before the `set` moves a refreshed entry to the back rather than leaving it
 * at the front where it would be evicted while hot. Lifted verbatim from
 * `news.ts:317` so the two caches behave identically.
 */
function put<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Derivation — a faithful mirror of `useMatch`'s `derived`
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The canonical serialisation the commit hashes.
 *
 * Keys sorted lexicographically, not in arena order: arena order is itself a
 * function of the seed, so sorting keeps the commit computable by anyone who
 * has the picks alone. `JSON.stringify` over a rebuilt object is stable given
 * sorted keys — no whitespace, no key reordering, no locale.
 */
export function canonicalPicks(picks: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(picks).sort();
  const out: Record<string, string> = {};
  for (const k of sorted) out[k] = picks[k]!;
  return JSON.stringify(out);
}

export const commitOf = (picks: Readonly<Record<string, string>>): string =>
  keccak256(toUtf8Bytes(canonicalPicks(picks)));

// ─────────────────────────────────────────────────────────────────────────────
// The lock authentication message — X-1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Versioned, so a future field can be added without any chance that a signature
 * over the old layout verifies against the new one. It is the first line of the
 * message rather than a separate field precisely so that it cannot be omitted.
 */
export const LOCK_MESSAGE_PREFIX = "THETADUEL_LOCK_V1";

/**
 * The exact string `a` signs with `personal_sign` to authorise a lock.
 *
 *     THETADUEL_LOCK_V1
 *     matchKey:kz-semis:424242
 *     a:0x2222222222222222222222222222222222222222
 *     b:0x3333333333333333333333333333333333333333
 *     picks:{"AMD":"safe-bull","META":"safe-bull","TSLA":"safe-bear"}
 *
 * Five lines joined with `\n`, no trailing newline. Three decisions in it are
 * load-bearing and would each be a hole if they went the other way:
 *
 *  - **Every trusted field is bound.** `matchKey`, both seats and the picks are
 *    all in the message, so a signature captured off one lock cannot be
 *    replayed onto different picks, another match or a different opponent. The
 *    prefix line keeps it from ever colliding with some other message this key
 *    is asked to sign.
 *  - **The picks are the canonical serialisation**, not the request's key
 *    order — the same `canonicalPicks` the commit hashes. The client and the
 *    server therefore agree on the string without agreeing on JSON key order,
 *    and the thing signed is the thing committed.
 *  - **Addresses are EIP-55 checksummed** and an open `b` seat is spelled as
 *    the zero address. Both are normalisations, so `a` sending lower-case, or
 *    `b` as `""`, `null` or `0x000…0`, all produce one signable string rather
 *    than four.
 *
 * Exported because a client has to reproduce it byte for byte, and
 * `test/attest.test.ts` signs with it. Throws on an address that is not one —
 * the callers below have already checksummed theirs.
 *
 * **The sixth line, and why the version does not bump.** A lock that commits
 * two filled slates (module docstring, point 6) appends one more line —
 * `fills:<fillsCommit>` — so that `a` binds the duel clock's inputs as tightly
 * as the picks. It is an addition rather than `..._V2` because the V1 layout is
 * unchanged for every message V1 could ever produce: a lock with no slates
 * still builds exactly five lines, byte for byte, so no existing client and no
 * stored signature moves. And the two layouts cannot be confused, in either
 * direction — a five-line message is never equal to a six-line one, the server
 * builds whichever the REQUEST's own shape calls for, and recovery must land on
 * `a` exactly. So an attacker cannot strip the slates off a signed six-line
 * lock (the server would rebuild five lines and recover a stranger) and cannot
 * bolt slates onto a signed five-line one (the reverse, for the same reason).
 */
export function lockMessage(
  matchKey: string,
  a: string,
  b: string | null,
  picks: Readonly<Record<string, string>>,
  fillsCommit?: string | null,
): string {
  const lines = [
    LOCK_MESSAGE_PREFIX,
    `matchKey:${matchKey}`,
    `a:${getAddress(a)}`,
    `b:${b ? getAddress(b) : ZeroAddress}`,
    `picks:${canonicalPicks(picks)}`,
  ];
  if (fillsCommit) lines.push(`fills:${fillsCommit}`);
  return lines.join("\n");
}

// ─────────────────────────────────────────────────────────────────────────────
// The filled slates — the duel clock's committed input
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Versioned for the same reason `LOCK_MESSAGE_PREFIX` is, and *separate* from
 * it because the two messages are signed by different people: the lock is `a`'s
 * authority to commit the duel, a slate is one seat's own statement of what it
 * filled. Seat `b` signs a slate and never signs a lock.
 */
export const FILLS_MESSAGE_PREFIX = "THETADUEL_FILLS_V1";

/**
 * The canonical serialisation of one seat's filled legs.
 *
 * Two normalisations, and both are load-bearing:
 *
 *  - **Field order is fixed and alphabetical**, rebuilt field by field rather
 *    than passed through, so a client's key order cannot change the string.
 *  - **Legs are sorted** by instrument and then by their own serialisation, so
 *    the order the fills happened in — which is book depth, not a decision —
 *    cannot change the string either. The score is a sum, so sorting cannot
 *    change the answer.
 *
 * Numbers go through `JSON.stringify`, which since ES2015 emits the shortest
 * representation that round-trips: `JSON.parse` of it is bit-identical to the
 * double that was signed. So a client that sends the doubles it signed gets the
 * same string back out of this function, and one that "tidies" a price into a
 * different double gets a refused signature rather than a silent rescoring.
 */
export function canonicalLegs(legs: readonly FilledLeg[]): string {
  const rows = legs.map((l) => ({
    contracts: l.contracts,
    entryMark: l.entryMark,
    instrument: l.instrument,
    premium: l.premium,
  }));
  const keyed = rows.map((r) => ({ r, s: JSON.stringify(r) }));
  keyed.sort((x, y) => (x.r.instrument < y.r.instrument ? -1 : x.r.instrument > y.r.instrument ? 1 : x.s < y.s ? -1 : x.s > y.s ? 1 : 0));
  return `[${keyed.map((k) => k.s).join(",")}]`;
}

/**
 * The exact string ONE SEAT signs to state what it filled.
 *
 *     THETADUEL_FILLS_V1
 *     matchKey:kz-semis:424242
 *     seat:0x2222222222222222222222222222222222222222
 *     endsAt:1756000240000
 *     legs:[{"contracts":2,"entryMark":0.4,"instrument":"ETH-27SEP-4400-C","premium":0.9}]
 *
 * Five `\n`-joined lines, no trailing newline, `personal_sign`. It binds the
 * match, the seat, the scoring instant and the positions, so a slate cannot be
 * replayed onto another duel, another seat, another end time or another basket.
 *
 * **Each seat signs its own.** That is the whole point of a second message: if
 * `a` could state `b`'s entry marks, `a` could hand itself the duel by writing
 * `b` a basket that had already lost. Every field of `b`'s slate is therefore
 * inside a signature only `b` can produce, and the server checks both before it
 * stores either.
 */
export function fillsMessage(
  matchKey: string,
  seat: string,
  endsAt: number,
  legs: readonly FilledLeg[],
): string {
  return [
    FILLS_MESSAGE_PREFIX,
    `matchKey:${matchKey}`,
    `seat:${getAddress(seat)}`,
    `endsAt:${endsAt}`,
    `legs:${canonicalLegs(legs)}`,
  ].join("\n");
}

/**
 * What the lock message's sixth line carries: one hash over the duel's declared
 * end and both canonical slates.
 *
 * A hash rather than the slates inline, because the picks line is already the
 * long one and a lock message a wallet has to render should stay readable. The
 * slates themselves are verified against their own signatures either way, so
 * this line's job is narrower: it stops the pair of them being swapped,
 * reordered or dropped underneath `a`'s signature.
 */
export function fillsCommitOf(
  endsAt: number,
  aLegs: readonly FilledLeg[],
  bLegs: readonly FilledLeg[],
): string {
  return keccak256(
    toUtf8Bytes(
      JSON.stringify({ endsAt, a: canonicalLegs(aLegs), b: canonicalLegs(bLegs) }),
    ),
  );
}

/** What one match's seed deals. `state/match.ts:364-365`: the book is the
 *  lobby's sectors, and `canPlay` is what keeps `spinCase` from throwing. */
function arenaOf(lobby: LobbyDef, seed: number): readonly string[] {
  return spinCase(bookOf(lobby), lobby.legs, seed).syms;
}

/**
 * The opponent's slip, drawn from the same seed the tickers were.
 *
 * Mirrors `state/match.ts:369-371` exactly:
 *
 *     const oppRandom = seededRandom(state.seed ^ 0x5bd1e995);
 *     for (const sym of arena)
 *       oppPicks[sym] = PARLAY_CARDS[Math.floor(oppRandom() * PARLAY_CARDS.length)]!;
 *
 * Two things about that loop are load-bearing and easy to lose in a rewrite:
 * the stream is drawn **once per arena symbol in arena order**, so re-ordering
 * the loop re-deals the opponent; and the XOR constant `0x5bd1e995` is what
 * separates the opponent's stream from the spin's own (`seededRandom(seed)`).
 */
function oppPicksFor(seed: number, arena: readonly string[]): Record<string, ParlayCard> {
  const oppRandom = seededRandom(seed ^ 0x5bd1e995);
  const oppPicks: Record<string, ParlayCard> = {};
  for (const sym of arena) {
    oppPicks[sym] = PARLAY_CARDS[Math.floor(oppRandom() * PARLAY_CARDS.length)]!;
  }
  return oppPicks;
}

export interface DerivedVerdict {
  arena: readonly string[];
  myLegs: readonly ParlayLeg[];
  oppLegs: readonly ParlayLeg[];
  /** `1 + seed*3 + MODE_SALT[mode]` — the briefs window. Not used by the
   *  verdict; computed and returned so the mirror is visibly complete. */
  studySalt: number;
  /** `2 + seed*3 + MODE_SALT[mode]` — the tape the duel settles on. */
  fightSalt: number;
  settleAt: number;
  meWins: boolean;
}

/**
 * Re-derive one duel's outcome from `(lobby, seed, committed picks)`.
 *
 * Every line below is a transcription of `src/state/match.ts`'s `derived` memo,
 * cited to the line it mirrors. Where the two could drift they would drift
 * silently — the client would show one winner and the escrow would pay another
 * — so the mirror is written out longhand rather than factored into something
 * clever, and it imports the *same* pure functions rather than reimplementing
 * any of them.
 */
export function deriveVerdict(
  lobby: LobbyDef,
  seed: number,
  picks: Readonly<Record<string, string>>,
): DerivedVerdict {
  // :361 — the mode spec drives the salts, the settle print, every leg's
  // target and the payout. Board lobbies always carry a mode.
  const spec = MODES[lobby.mode];

  // :364-365 — the tickers.
  const arena = arenaOf(lobby, seed);

  // :369-371 — the opponent's picks, from the same seed.
  const oppPicks = oppPicksFor(seed, arena);

  // :373-377 — your picks, resolved from card id to card. `cardById` is the
  // same lookup the client used; the lock validated every id, so the `null`
  // branch here is unreachable and throwing is the honest thing to do if it
  // somehow is not.
  const myPicks: Record<string, ParlayCard> = {};
  for (const sym of arena) {
    const c = cardById(picks[sym]);
    if (!c) throw new Error(`no card for ${sym}`);
    myPicks[sym] = c;
  }

  // :381-385 — one leg per ticker at the mode's target scale. The client has a
  // second branch there (`buildLeg(sym, "over", "EVEN", …)`) for a ticker with
  // no pick yet; it cannot arise here, because `/api/lock` refuses a commit
  // whose keys are not exactly the arena. A partial slip is never settleable.
  const myLegs: readonly ParlayLeg[] = arena.map((sym) =>
    legForCard(sym, myPicks[sym]!, spec.targetScale),
  );
  // :386-388 — the same construction over the seeded opponent.
  const oppLegs: readonly ParlayLeg[] = arena.map((sym) =>
    legForCard(sym, oppPicks[sym]!, spec.targetScale),
  );

  // :395-396 — `MODE_SALT` moves the whole window rather than shortening the
  // same one, so the same seed in a different mode is a genuinely different
  // draw. `MODE_SALT.NORMAL === 0` keeps the identity mode byte-identical.
  const studySalt = 1 + seed * 3 + MODE_SALT[spec.key];
  const fightSalt = 2 + seed * 3 + MODE_SALT[spec.key];

  // :404-407 — the duel settles on the FIGHT salt at the mode's settle print.
  // `opponentOf` (:356) is the host for every board lobby. The two names only
  // shape the prose in the verdict; `meWins` is the only field that decides
  // money, and it reads score → edge → drift (engine/match.ts:143-145).
  const opponent = opponentOf(lobby);
  const verdict = settle(
    myLegs,
    oppLegs,
    arena,
    fightSalt,
    spec.settleAt,
    YOU.name,
    opponent ? opponent.name : "Opponent",
  );

  return {
    arena,
    myLegs,
    oppLegs,
    studySalt,
    fightSalt,
    settleAt: spec.settleAt,
    meWins: verdict.meWins,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Request validation
// ─────────────────────────────────────────────────────────────────────────────

/** A `matchKey` split into the pair it encodes. `state/match.ts:429` builds it
 *  as `` `${state.lobbyId ?? "none"}:${state.seed}` ``. */
interface ParsedKey {
  lobby: LobbyDef;
  seed: number;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const CARD_IDS: ReadonlySet<string> = new Set(PARLAY_CARDS.map((c) => c.id));

/**
 * A per-room nonce, if the key carries one — finding 6-1.
 *
 * Leading letter, then 3-31 more of the same alphabet the match key already
 * allows. The leading letter is the whole disambiguation rule: a final segment
 * of pure digits is the SEED and can never be read as a nonce, so every key
 * the app mints today parses exactly as it did before this existed.
 */
const NONCE_RE = /^[A-Za-z][A-Za-z0-9_-]{3,31}$/;

/**
 * Parse and validate `matchKey`.
 *
 * Split on the LAST colon: lobby ids are `[a-z-]+` today and the seed is always
 * digits, but splitting from the right means a lobby id that ever grows a colon
 * still parses the seed correctly rather than silently reading a different one.
 *
 * An optional trailing `:${nonce}` is stripped first (finding 6-1) and then
 * ignored: the nonce exists to make the key — and therefore the `duelId` an
 * outsider would have to squat — unguessable, and nothing about the derivation
 * may depend on it. `duelId` is `keccak256` over the WHOLE key, nonce included,
 * so two rooms on one seed are still two different duels.
 */
function parseMatchKey(raw: unknown): ParsedKey | { reason: string } {
  if (typeof raw !== "string") return { reason: "missing matchKey" };
  const matchKey = raw.trim();
  if (!matchKey) return { reason: "missing matchKey" };
  if (matchKey.length > MAX_MATCHKEY_LEN) return { reason: "matchKey too long" };
  if (!/^[A-Za-z0-9_.:-]+$/.test(matchKey)) return { reason: "bad matchKey" };

  // Strip a nonce only when what is left still has a colon to split — so a
  // two-segment key is never mistaken for a lobby and a nonce with no seed.
  let core = matchKey;
  const tailCut = matchKey.lastIndexOf(":");
  if (tailCut > 0 && NONCE_RE.test(matchKey.slice(tailCut + 1)) && matchKey.lastIndexOf(":", tailCut - 1) > 0) {
    core = matchKey.slice(0, tailCut);
  }

  const cut = core.lastIndexOf(":");
  if (cut <= 0 || cut === core.length - 1) return { reason: "bad matchKey" };
  const lobbyId = core.slice(0, cut);
  const seedRaw = core.slice(cut + 1);

  const lobby = LOBBIES.find((l) => l.id === lobbyId) ?? null;
  // Only board lobbies are settleable. A lobby you published in your own
  // browser (`mine-1`, state/match.ts:298) exists nowhere but that tab, so the
  // server cannot re-derive its book, its legs or its mode — and a verdict it
  // cannot re-derive is a verdict it must not sign.
  if (!lobby) return { reason: `unknown lobby: ${lobbyId}` };
  if (!canPlay(lobby)) return { reason: `lobby cannot fill its legs: ${lobbyId}` };

  if (!/^\d+$/.test(seedRaw)) return { reason: "bad seed" };
  const seed = Number(seedRaw);
  if (!Number.isSafeInteger(seed) || seed < SEED_MIN || seed > SEED_MAX) {
    return { reason: "bad seed" };
  }

  return { lobby, seed };
}

/** Checksum an address, or say why it is not one. `null` is the open seat. */
function readAddress(
  raw: unknown,
  field: string,
  optional: boolean,
): { address: string | null } | { reason: string } {
  if (raw === undefined || raw === null || raw === "") {
    return optional ? { address: null } : { reason: `missing ${field}` };
  }
  if (typeof raw !== "string") return { reason: `bad ${field}` };
  let checksummed: string;
  try {
    checksummed = getAddress(raw.trim());
  } catch {
    return { reason: `bad ${field}` };
  }
  if (checksummed === ZeroAddress) {
    return optional ? { address: null } : { reason: `bad ${field}` };
  }
  return { address: checksummed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading a slate off a request
// ─────────────────────────────────────────────────────────────────────────────

/** A finite double inside a sane range, or `null`. Rejects `NaN`, both
 *  infinities and the string forms — a price that arrived as `"0.40"` is a
 *  client bug, and quietly coercing it would put a different double in the
 *  score than the one that was signed. */
function finiteNumber(raw: unknown, opts: { min: number; max: number }): number | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  if (raw < opts.min || raw > opts.max) return null;
  return raw;
}

/**
 * One seat's legs, validated field by field.
 *
 * Every bound refuses to invent rather than to normalise: a leg with no
 * contracts is not a position, a leg with no premium would make the score's
 * denominator a lie about what was risked, and `1e12` is a bound on a request
 * body rather than a market opinion. `src/engine/score.ts` re-checks all of
 * this — it is pure and cannot assume a caller — so this layer exists to give
 * a client a reason rather than to be the only gate.
 */
function readLegs(raw: unknown, who: string): readonly FilledLeg[] | { reason: string } {
  if (!Array.isArray(raw)) return { reason: `bad ${who} legs` };
  if (raw.length === 0) return { reason: `${who} filled nothing` };
  if (raw.length > MAX_FILLED_LEGS) return { reason: `too many ${who} legs` };

  const legs: FilledLeg[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return { reason: `bad ${who} leg` };
    const instrument = entry["instrument"];
    if (typeof instrument !== "string" || !instrument || instrument.length > MAX_INSTRUMENT_LEN) {
      return { reason: `bad ${who} instrument` };
    }
    const entryMark = finiteNumber(entry["entryMark"], { min: 0, max: 1e12 });
    const contracts = finiteNumber(entry["contracts"], { min: Number.MIN_VALUE, max: 1e12 });
    const premium = finiteNumber(entry["premium"], { min: Number.MIN_VALUE, max: 1e12 });
    if (entryMark === null) return { reason: `bad ${who} entryMark` };
    if (contracts === null) return { reason: `bad ${who} contracts` };
    if (premium === null) return { reason: `bad ${who} premium` };
    legs.push({ instrument, entryMark, contracts, premium });
  }
  return legs;
}

/** A 65-byte hex signature, or why it is not one. Shared by the lock's own
 *  `sig` and by each slate's. */
function readSig(raw: unknown, who: string): string | { reason: string } {
  if (raw === undefined || raw === null || raw === "") return { reason: `missing ${who} signature` };
  if (typeof raw !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(raw.trim())) {
    return { reason: `bad ${who} signature` };
  }
  return raw.trim();
}

interface ParsedFills {
  endsAt: number;
  a: readonly FilledLeg[];
  b: readonly FilledLeg[];
  commit: string;
}

/**
 * The whole `fills` block of a lock body, or the reason it is not one.
 *
 * `undefined` — the block is absent — is not a failure and is not represented
 * here: `lock()` treats it as "this duel settles on the tape" and never calls
 * this function. That is what keeps the pre-phase-C path byte-identical.
 *
 * Both slates are authenticated HERE, against the seats the lock names, before
 * anything is stored. `a`'s slate must recover to `a` and `b`'s to `b`: a lock
 * in which one player states the other's fills is refused, not stored and
 * scored later.
 */
function readFills(
  raw: unknown,
  matchKey: string,
  a: string,
  b: string | null,
  at: number,
): ParsedFills | { reason: string } {
  if (!isRecord(raw)) return { reason: "bad fills" };

  // A duel clock needs two baskets to compare. An open `b` seat cannot have
  // one, so a slate-carrying lock is a two-seat lock by construction.
  if (!b) return { reason: "fills need both seats" };

  const endsAt = finiteNumber(raw["endsAt"], {
    min: at - MAX_ENDS_AT_SKEW_MS,
    max: at + MAX_ENDS_AT_SKEW_MS,
  });
  if (endsAt === null || !Number.isSafeInteger(endsAt)) return { reason: "bad endsAt" };

  const slates: Record<"a" | "b", readonly FilledLeg[]> = { a: [], b: [] };
  for (const [seatKey, seat] of [["a", a] as const, ["b", b] as const]) {
    const slate = raw[seatKey];
    if (!isRecord(slate)) return { reason: `missing ${seatKey} fills` };

    const legs = readLegs(slate["legs"], seatKey);
    if ("reason" in legs) return legs;

    const sig = readSig(slate["sig"], `${seatKey} fills`);
    if (typeof sig !== "string") return sig;

    let recovered: string;
    try {
      recovered = verifyMessage(fillsMessage(matchKey, seat, endsAt, legs), sig);
    } catch {
      return { reason: `bad ${seatKey} fills signature` };
    }
    // Both sides checksummed by construction, so this compares values.
    if (recovered !== seat) return { reason: `${seatKey} fills are not ${seatKey}'s` };

    slates[seatKey] = legs;
  }

  return {
    endsAt,
    a: slates.a,
    b: slates.b,
    commit: fillsCommitOf(endsAt, slates.a, slates.b),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The marks — this server's own read of the book
// ─────────────────────────────────────────────────────────────────────────────

/** A number the book published, whether it arrived as a number or as one of the
 *  snapshot's formatted strings. Strict: no `parseFloat` prefix-matching, so
 *  `"1.2 (stale)"` is not silently 1.2. */
function marketNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null;
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reduce a market snapshot to `instrument → mark`.
 *
 * Written **structurally, against `unknown`**, and that is deliberate rather
 * than lazy: the snapshot is another module's shape and it is still growing
 * (plan 6 §A1 puts a `mark` on every pricing row). Reading it by duck-typing
 * means a field that moves cannot break this file's typecheck — and, far more
 * importantly, **every mismatch fails closed**: a row this function does not
 * recognise contributes no mark, a leg with no mark is unmarkable, and an
 * unmarkable leg signs nothing and refunds. There is no path here from "the
 * snapshot changed shape" to "somebody was paid on a wrong number".
 *
 * Three rules about what counts as a mark:
 *
 *  - `mark` first, `mid` only as a fallback. A mid is the honest mark for an
 *    asset with no market-maker pricing (only ETH and BTC have any), because a
 *    resting book publishes no fair value.
 *  - **Never a lone `bid` or `ask`.** A one-sided level is not a mark, and
 *    treating it as one would systematically flatter whichever player held the
 *    thin leg.
 *  - **First writer wins per instrument**, and the sources are visited
 *    mark-bearing first, so a quote's own mark is never overwritten by a
 *    neighbouring row's midpoint.
 */
export function marksFromSnapshot(snapshot: unknown): Map<string, number> {
  const marks = new Map<string, number>();
  if (!isRecord(snapshot)) return marks;

  const take = (row: unknown): void => {
    if (!isRecord(row)) return;
    const nameRaw = row["ticker"] ?? row["instrument"];
    if (typeof nameRaw !== "string" || !nameRaw) return;
    const name = nameRaw.trim();
    if (!name || marks.has(name)) return;
    const value = marketNumber(row["mark"]) ?? marketNumber(row["mid"]);
    if (value === null) return;
    marks.set(name, value);
  };

  // Each field is either an array of rows or a per-underlying record of them;
  // both are walked, because which one a snapshot uses is not this module's
  // business. `mmPricing` is visited first — it is the only field documented to
  // carry the SDK's own `markPrice`, verbatim.
  const walk = (field: unknown): void => {
    if (Array.isArray(field)) {
      for (const row of field) take(row);
    } else if (isRecord(field)) {
      for (const rows of Object.values(field)) {
        if (Array.isArray(rows)) for (const row of rows) take(row);
      }
    }
  };

  walk(snapshot["mmPricing"]);
  walk(snapshot["pricing"]);
  walk(snapshot["orders"]);
  return marks;
}

/**
 * The production mark source: this process's own market service, reduced.
 *
 * Built lazily and only on the first duel-clock attest, so a server whose duels
 * all settle on the tape never constructs it and never reads the book — the
 * pre-phase-C behaviour, unchanged and unpaid-for.
 *
 * It is its own service instance rather than the one `index.ts` holds, which
 * costs a second 15-second TTL cache on a route that fires roughly once per
 * duel. `AttestDeps.marks` exists so that a caller which already has a market
 * service can hand it over instead, and that is the intended wiring the day
 * anyone cares about the second cache.
 */
function envMarkSource(): MarkSource {
  const market = createMarketService();
  return {
    async read(): Promise<MarkSnapshot | { reason: string }> {
      let envelope: unknown;
      try {
        envelope = await market.snapshot();
      } catch {
        // The service contracts never to throw; if it ever does, that is a
        // refusal, not a crash, and certainly not a fallback to trusting a
        // client's numbers.
        return { reason: "market unreachable" };
      }
      if (!isRecord(envelope) || envelope["ok"] !== true) {
        const reason = isRecord(envelope) && typeof envelope["reason"] === "string"
          ? envelope["reason"]
          : "no market snapshot";
        return { reason };
      }
      const at = typeof envelope["at"] === "number" ? envelope["at"] : NaN;
      if (!Number.isFinite(at)) return { reason: "market snapshot has no timestamp" };
      return { at, marks: marksFromSnapshot(envelope) };
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Seat binding — the residual of X-1
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compare a lock's claimed seats against the escrow's, and say why not.
 *
 * `null` means the lock may proceed; anything else is the refusal, verbatim.
 * The whole disposition table from the module docstring's point 4 is here, in
 * one function, in the order the checks matter:
 *
 *  1. the chain has to have answered at all (fail closed),
 *  2. the duel has to be one that can still be settled,
 *  3. the claimed `a` has to be the on-chain OPENER — ordered, not a set
 *     membership test, because the attack is exactly a swap,
 *  4. the claimed `b` has to be the on-chain joiner.
 *
 * Module-level and dependency-free on purpose: it takes a reader and three
 * strings and returns a refusal, so `test/attest.test.ts` can drive every row
 * of the table with a four-line fake provider and no service at all.
 */
async function checkSeats(
  reader: SeatReader,
  duelId: string,
  a: string,
  b: string | null,
): Promise<AttestFail | null> {
  const seats = await reader.read(duelId);

  if (!seats.ok) {
    // Every miss is a refusal — there is no branch here that falls back to
    // trusting the body, and adding one would undo the entire fix. A reader
    // that has become unconfigured mid-flight (it cannot, today) lands here
    // too, which is the safe direction.
    return { ok: false, reason: seats.reason };
  }

  // A duel with no opponent has nobody to pay if the committed slip loses, and
  // storing such a lock would pin `b: null` under first-write-wins and make the
  // duel permanently unsettleable. Refusing is also the honest answer to a
  // client that raced its own `join` transaction: retry, and a refused lock
  // costs it nothing.
  if (seats.status === "OPEN") return { ok: false, reason: "opponent has not joined on chain" };

  // SETTLED or REFUNDED. A duel leaves FULL exactly once, so no verdict signed
  // from here could ever be paid; committing picks for it would be theatre.
  if (seats.status !== "FULL") return { ok: false, reason: "duel is closed on chain" };

  // THE X-1 REFUSAL. `b` signing as themselves in the `a` seat gets this far
  // with a perfect signature and dies here, because the escrow remembers who
  // paid to open and who paid to join.
  if (a !== seats.a) return { ok: false, reason: "not a seat in this duel" };
  if (b !== seats.b) return { ok: false, reason: "opponent is not the on-chain seat" };

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// The service
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `ATTESTOR_PRIVATE_KEY` is read HERE and nowhere else in the repo
 * (`test/secrets.test.ts` holds that line for the bundle, and `.env.example`
 * says so). It is read at call time rather than module load so that a process
 * started without it can be given one by a restart, and so that a test can
 * neither depend on nor disturb it.
 */
function envKey(): string {
  try {
    return (
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.ATTESTOR_PRIVATE_KEY ?? ""
    ).trim();
  } catch {
    return "";
  }
}

function envEscrow(): string {
  try {
    return (
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
        ?.THETADUEL_ESCROW ?? ""
    ).trim();
  } catch {
    return "";
  }
}

export function createAttestService(deps: AttestDeps = {}): AttestService {
  const now = deps.now ?? (() => Date.now());
  const locks = new Map<string, LockEntry>();

  /**
   * The real signer, built once, lazily, on first use — never at import.
   *
   * Lazy matters: `index.ts` constructs this service at boot, and a process
   * with no attestor key must start cleanly and simply refuse the three routes,
   * exactly as a process with no `RPC_URL` still serves the mock market.
   *
   * `undefined` means "not built yet", `null` means "built and there is no
   * key". Nothing here logs the key, returns it, or puts it in an envelope; the
   * only thing that ever leaves this closure is a signature and an address.
   */
  let cachedSigner: TypedDataSigner | null | undefined;

  function signer(): TypedDataSigner | null {
    if (deps.signer) return deps.signer;
    if (cachedSigner !== undefined) return cachedSigner;
    const key = envKey();
    if (!key) {
      cachedSigner = null;
      return null;
    }
    try {
      // `Wallet` is a plain static import (this module already imports `id` and
      // `getAddress` from the same package, so there is nothing to defer). What
      // is deferred is CONSTRUCTION: the key is parsed on first use, inside this
      // try, so a malformed value degrades these three routes rather than
      // throwing at import time and taking the whole server down with it.
      cachedSigner = new Wallet(key);
    } catch {
      // A malformed key is a configuration problem, not a request problem, and
      // the message must never carry the value.
      cachedSigner = null;
    }
    return cachedSigner;
  }

  const NOT_CONFIGURED: AttestFail = { ok: false, reason: "attestor not configured" };

  const configured = (): boolean => signer() !== null;

  /**
   * The seat reader, built once, lazily, on the same terms as the signer.
   *
   * `null` means seat binding is off and `lock()` keeps its pre-X-1 behaviour.
   * The environment is read here rather than in `AttestDeps` so that a process
   * given `THETADUEL_ESCROW` and `RPC_URL` after a restart picks them up, and
   * so that the escrow the seats are read from is the same environment variable
   * the verdict domain is built from — one address, one place it can be wrong.
   */
  let cachedSeats: SeatReader | null | undefined;

  function seats(): SeatReader | null {
    // An injected reader that reports itself unconfigured means the same thing
    // as no reader at all — "there is no escrow to check against" — and must
    // NOT become a refusal on every lock. Normalising it here rather than at the
    // call site keeps that disposition in one place, and lets a test hand the
    // service a real reader over a real fake provider and still assert that the
    // unconfigured path never touches it.
    if (deps.seats !== undefined) return deps.seats && deps.seats.configured ? deps.seats : null;
    if (cachedSeats !== undefined) return cachedSeats;
    try {
      const reader = createSeatReader();
      cachedSeats = reader.configured ? reader : null;
    } catch {
      cachedSeats = null;
    }
    return cachedSeats;
  }

  /**
   * The duel clock's mark source, on the same three-valued convention as the
   * seat reader — and built at the LAST possible moment.
   *
   * `undefined` means "not built yet", `null` means "explicitly none". The lazy
   * construction is what keeps a tape-only server from ever touching the book:
   * this function is called from one place, inside the duel-clock branch of
   * `attest`, which no lock reaches unless it committed two slates.
   */
  let cachedMarks: MarkSource | null | undefined;

  function markSource(): MarkSource | null {
    if (deps.marks !== undefined) return deps.marks;
    if (cachedMarks !== undefined) return cachedMarks;
    try {
      cachedMarks = envMarkSource();
    } catch {
      cachedMarks = null;
    }
    return cachedMarks;
  }

  // ── lock ──────────────────────────────────────────────────────────────────

  /** The stored commit for a duel, if there is a live one. Called twice by
   *  `lock` — see the note on the second call. */
  function liveLock(duelId: string): LockEntry | null {
    const existing = locks.get(duelId);
    return existing && now() - existing.at < LOCK_TTL_MS ? existing : null;
  }

  const alreadyLocked = (duelId: string, entry: LockEntry): LockOk => ({
    ok: true,
    duelId,
    commit: entry.commit,
    matchKey: entry.matchKey,
    ...(entry.fills ? { fillsCommit: entry.fills.commit } : {}),
    note: "already locked",
  });

  async function lock(body: unknown): Promise<LockEnvelope> {
    if (!configured()) return NOT_CONFIGURED;
    if (!isRecord(body)) return { ok: false, reason: "bad body" };

    const key = parseMatchKey(body["matchKey"]);
    if ("reason" in key) return { ok: false, reason: key.reason };
    const matchKey = String(body["matchKey"]).trim();
    const duelId = id(matchKey);

    // FIRST WRITE WINS. Before anything else is validated, because the whole
    // point is that a second commit cannot influence the stored one — not its
    // picks, not its addresses, and not by being malformed either.
    const existing = liveLock(duelId);
    if (existing) return alreadyLocked(duelId, existing);

    const a = readAddress(body["a"], "a", false);
    if ("reason" in a) return { ok: false, reason: a.reason };
    // The open seat: a duel can be locked before someone takes it. `/api/attest`
    // is what refuses to sign one, since there would be no address to pay.
    const b = readAddress(body["b"], "b", true);
    if ("reason" in b) return { ok: false, reason: b.reason };

    const rawPicks = body["picks"];
    if (!isRecord(rawPicks)) return { ok: false, reason: "missing picks" };
    const picks: Record<string, string> = {};
    for (const [sym, cardId] of Object.entries(rawPicks)) {
      if (typeof cardId !== "string" || !CARD_IDS.has(cardId)) {
        return { ok: false, reason: `unknown card: ${String(cardId)}` };
      }
      picks[sym] = cardId;
    }

    // The keys must be EXACTLY the symbols this seed dealt — not a subset, not
    // a superset, not a rename. A slip with a leg missing is not settleable
    // (the client would have previewed it at EVEN/over, state/match.ts:384) and
    // an extra key is a caller trying to widen the commit past the arena.
    const arena = arenaOf(key.lobby, key.seed);
    const got = Object.keys(picks).sort();
    const want = [...arena].sort();
    if (got.length !== want.length || got.some((s, i) => s !== want[i])) {
      return { ok: false, reason: `picks must cover exactly: ${want.join(",")}` };
    }

    // THE SLATES — the duel clock's committed input, module docstring point 6.
    // ABSENT is the normal case and is not a failure: a lock with no `fills`
    // settles on the tape exactly as every lock did before phase C, and never
    // reaches a market snapshot. Present, both slates are authenticated against
    // their own seats here, before `a`'s signature is even looked at, so that
    // the commitment `a` signs below is over slates that have already been
    // proved to belong to the players they name.
    const fillsRaw = body["fills"];
    let fills: ParsedFills | null = null;
    if (fillsRaw !== undefined && fillsRaw !== null) {
      const parsed = readFills(fillsRaw, matchKey, a.address!, b.address, now());
      if ("reason" in parsed) return { ok: false, reason: parsed.reason };
      fills = parsed;
    }

    // AUTHENTICATION — X-1. Last, and deliberately so: everything above has
    // already been normalised, so what is verified is what would be stored,
    // and nothing an unauthenticated caller sends can be quietly reinterpreted
    // after the recovery succeeds. A refusal here returns before `put`, so a
    // bad signature neither evicts a stored commit nor consumes first-write-
    // wins — the next caller with a good one still gets the seat.
    const sigRaw = body["sig"];
    if (sigRaw === undefined || sigRaw === null || sigRaw === "") {
      return { ok: false, reason: "missing signature" };
    }
    if (typeof sigRaw !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(sigRaw.trim())) {
      return { ok: false, reason: "bad signature" };
    }
    const message = lockMessage(matchKey, a.address!, b.address, picks, fills?.commit ?? null);
    let recovered: string;
    try {
      recovered = verifyMessage(message, sigRaw.trim());
    } catch {
      // A well-shaped 65 bytes can still be uninvertible (`r`/`s` out of range,
      // a `v` that is neither 27 nor 28). That is a bad signature, not a crash.
      return { ok: false, reason: "bad signature" };
    }
    // Both sides are checksummed — `getAddress` above, `verifyMessage` by
    // construction — so this is a value comparison and not a case comparison.
    if (recovered !== a.address) return { ok: false, reason: "signature is not a's" };

    // SEAT BINDING — the residual of X-1, module docstring point 4. After the
    // signature deliberately: recovery is local, cheap and refuses everything a
    // stranger can send, so only a caller who genuinely controls `a` can make
    // this process talk to an RPC at all. It is also the last gate, so a duel
    // whose seats do not match has still had every cheaper reason reported
    // first — a client debugging its own body never gets "not a seat" when the
    // real problem was its picks.
    const reader = seats();
    if (reader) {
      const seatFail = await checkSeats(reader, duelId, a.address!, b.address);
      if (seatFail) return seatFail;
    }

    // FIRST WRITE WINS, again — and this second look is not redundant.
    // Everything above the seat read is synchronous, so before it there was no
    // instant at which two locks for one duel could both be in flight. The
    // `await` creates one: two valid locks arriving together would both pass
    // the check at the top and the second `put` would overwrite the first,
    // which is precisely the property this route exists to hold. The recheck
    // closes that window; Bun's single event loop makes it sufficient, because
    // nothing can interleave between here and the `put` below.
    const raced = liveLock(duelId);
    if (raced) return alreadyLocked(duelId, raced);

    const commit = commitOf(picks);
    put(locks, duelId, {
      at: now(),
      matchKey,
      lobbyId: key.lobby.id,
      seed: key.seed,
      picks,
      commit,
      a: a.address!,
      b: b.address,
      ...(fills ? { fills } : {}),
    });

    return { ok: true, duelId, commit, matchKey, ...(fills ? { fillsCommit: fills.commit } : {}) };
  }

  // ── attest ────────────────────────────────────────────────────────────────

  /**
   * WHO WON — the two clocks, in the one function that decides money.
   *
   * Returns a winner or a refusal, and **a refusal is a first-class answer**: a
   * duel this function will not call is a duel the escrow refunds in six hours,
   * rake-free, without this server's cooperation. It is never a coin flip and
   * never a fallback to something easier to compute.
   *
   * The branch is the commit's own shape, not a flag: a lock that committed two
   * slates settles on the duel clock, and one that did not settles on the tape.
   * Nothing in the request selects between them, so no caller can ask for the
   * path that suits it.
   */
  async function decideWinner(
    entry: LockEntry,
    key: ParsedKey,
  ): Promise<{ winner: string } | AttestFail> {
    // `attest` has already refused an empty second seat; this is the narrowing.
    const b = entry.b!;

    // ── the tape path — the seeded game, unchanged ──────────────────────────
    // Plan 6 §8 requires phase C to revert cleanly, and this is what makes it
    // true: the pre-phase-C derivation is still here, still the default, and
    // still the only thing a lock without slates can reach.
    if (!entry.fills) {
      try {
        return { winner: deriveVerdict(key.lobby, key.seed, entry.picks).meWins ? entry.a : b };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason: `derive failed: ${reason}` };
      }
    }

    // ── the duel clock ─────────────────────────────────────────────────────
    const { endsAt } = entry.fills;

    // Scoring a duel that has not finished would be scoring a different duel.
    if (now() < endsAt) return { ok: false, reason: "duel has not ended" };

    let snapshot = entry.marks;
    if (!snapshot) {
      const source = markSource();
      if (!source) return { ok: false, reason: "no market source" };

      let read: MarkSnapshot | { reason: string };
      try {
        read = await source.read();
      } catch {
        return { ok: false, reason: "market unreachable" };
      }
      if ("reason" in read) return { ok: false, reason: read.reason };
      if (!Number.isFinite(read.at)) return { ok: false, reason: "market snapshot has no timestamp" };

      // THE WINDOW. Before the end, the marks describe a duel still in progress;
      // far after it, they describe news nobody was playing. Either way the
      // honest answer is the refund — see MARK_MAX_LAG_MS.
      if (read.at < endsAt) return { ok: false, reason: "market snapshot predates the duel" };
      if (read.at - endsAt > MARK_MAX_LAG_MS) return { ok: false, reason: "market snapshot is stale" };

      // A snapshot with nothing in it is a soft read failure wearing a
      // timestamp. Refusing it BEFORE the freeze is the point: freezing an
      // empty book would refuse this duel permanently on one bad read.
      if (read.marks.size === 0) return { ok: false, reason: "market snapshot has no marks" };

      // FROZEN — see `LockEntry.marks`. Every later call is scored on this one.
      snapshot = { at: read.at, marks: read.marks };
      entry.marks = snapshot;
    }

    // ONE SNAPSHOT, BOTH PLAYERS. `duelOutcome` takes a single marks map for two
    // slates, so there is no expressible way to score them against different
    // books — `src/engine/score.ts` makes that structural rather than a rule
    // somebody has to keep.
    const outcome = duelOutcome(entry.fills.a, entry.fills.b, snapshot.marks);

    if (outcome.noVerdict) {
      // Plan 6 §C3: no tiebreak. Naming the leg matters — a player can check
      // "ETH-27SEP-4400-C had no mark" against the same public book, and cannot
      // check "no verdict".
      const unmarkable = [...outcome.aDetail.unmarkable, ...outcome.bDetail.unmarkable];
      return {
        ok: false,
        reason: unmarkable.length
          ? `unmarkable leg: ${unmarkable[0]}`
          : `scores level to ${SCORE_DP}dp`,
      };
    }

    return { winner: outcome.aWins ? entry.a : b };
  }

  async function attest(body: unknown): Promise<AttestEnvelope> {
    const sign = signer();
    if (!sign) return NOT_CONFIGURED;

    const escrowRaw = deps.escrow ?? envEscrow();
    if (!escrowRaw) return { ok: false, reason: "escrow not configured" };
    let verifyingContract: string;
    try {
      verifyingContract = getAddress(escrowRaw);
    } catch {
      return { ok: false, reason: "escrow not configured" };
    }

    if (!isRecord(body)) return { ok: false, reason: "bad body" };
    const key = parseMatchKey(body["matchKey"]);
    if ("reason" in key) return { ok: false, reason: key.reason };
    const matchKey = String(body["matchKey"]).trim();
    const duelId = id(matchKey);

    const entry = locks.get(duelId);
    if (!entry || now() - entry.at >= LOCK_TTL_MS) {
      return { ok: false, reason: "not locked" };
    }
    if (!entry.b) return { ok: false, reason: "duel has no opponent seat" };

    // The winner: derived, never read. `body` has exactly one field this
    // function trusts, and it is the match key. Whether that derivation runs on
    // the tape or on the duel clock is decided by what was COMMITTED, never by
    // what was requested.
    const decided = await decideWinner(entry, key);
    if (!("winner" in decided)) return decided;
    const { winner } = decided;

    const nowSec = Math.floor(now() / 1000);

    // Replay the cached signature while it is still comfortably in date — see
    // DEADLINE_REFRESH_BELOW_SECONDS. The winner below is re-derived every time
    // regardless, so a cache hit can never be a stale verdict; it is only ever
    // a stale deadline, which is exactly what this check is for.
    const cached = entry.verdict;
    if (cached && cached.winner === winner && cached.deadline - nowSec > DEADLINE_REFRESH_BELOW_SECONDS) {
      return { ok: true, duelId, winner: cached.winner, deadline: cached.deadline, signature: cached.signature };
    }

    const deadline = nowSec + DEADLINE_SECONDS;
    let signature: string;
    try {
      signature = await sign.signTypedData(
        {
          name: VERDICT_DOMAIN_NAME,
          version: VERDICT_DOMAIN_VERSION,
          chainId: BASE_CHAIN_ID,
          verifyingContract,
        },
        VERDICT_TYPES as unknown as Record<string, readonly { name: string; type: string }[]>,
        { duelId, winner, deadline: BigInt(deadline) },
      );
    } catch {
      // Deliberately opaque: a signer error can carry key material in its
      // message, and no caller can act on the detail anyway.
      return { ok: false, reason: "signing failed" };
    }

    entry.verdict = { winner, deadline, signature };
    return { ok: true, duelId, winner, deadline, signature };
  }

  // ── status ────────────────────────────────────────────────────────────────

  function status(duelIdRaw: string): StatusEnvelope {
    if (!configured()) return NOT_CONFIGURED;
    const duelId = duelIdRaw.trim().toLowerCase();
    if (!/^0x[0-9a-f]{64}$/.test(duelId)) return { ok: false, reason: "bad duelId" };
    const entry = locks.get(duelId);
    const live = entry && now() - entry.at < LOCK_TTL_MS ? entry : null;
    if (!live) return { ok: true, duelId, locked: false, attested: false };
    return {
      ok: true,
      duelId,
      locked: true,
      attested: live.verdict !== undefined,
      ...(live.verdict ? { winner: live.verdict.winner } : {}),
    };
  }

  // ── routes ────────────────────────────────────────────────────────────────

  const json = (body: LockEnvelope | AttestEnvelope | StatusEnvelope): Response =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
    });

  /** A JSON body that is not JSON is a request problem, not a crash. */
  async function readBody(req: Request): Promise<unknown> {
    try {
      return await req.json();
    } catch {
      return null;
    }
  }

  async function handleLock(req: Request): Promise<Response> {
    try {
      return json(await lock(await readBody(req)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return json({ ok: false, reason: `error: ${reason}` });
    }
  }

  async function handleAttest(req: Request): Promise<Response> {
    try {
      return json(await attest(await readBody(req)));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return json({ ok: false, reason: `error: ${reason}` });
    }
  }

  function handleStatus(url: URL): Response {
    try {
      return json(status(url.searchParams.get("duelId") ?? ""));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return json({ ok: false, reason: `error: ${reason}` });
    }
  }

  return { handleLock, handleAttest, handleStatus, lock, attest, status };
}
