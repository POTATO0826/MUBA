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
 *     control. **What it does not close, and the P6 work that will:**
 *
 *       - *The counterparty can still claim the `a` seat.* `b` is a real
 *         address with a real key; if `b` learns the match key before `a`'s
 *         client locks — and in the intended flow `a` hands them the room link
 *         — `b` can sign a lock of their own, as `a`, over a slip they searched
 *         for. The v2 fix is not a bigger signature: it is **binding the seats
 *         to the chain**, reading `a` and `b` out of the escrow's own
 *         `DuelOpened`/`DuelJoined` events instead of believing the body at
 *         all. Until then the per-room nonce (point 4) is what keeps the match
 *         key out of a stranger's hands, and the six-hour refund is what caps
 *         the damage.
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
 *  4. **A match key may carry a per-room nonce** — finding 6-1.
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
 * Shape and style are `src/server/news.ts`'s, deliberately:
 *  - **Injectable.** `createAttestService({ signer, now, escrow })` — the tests
 *    pass a throwaway `Wallet` and a fake clock and never touch a chain or a
 *    key file.
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
import { seededRandom, spinCase } from "../engine/spin.ts";
import { Wallet, ZeroAddress, getAddress, id, keccak256, toUtf8Bytes, verifyMessage } from "ethers";
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

export interface AttestDeps {
  /** Injected in tests. Omitted in production, where the real signer is built
   *  lazily from `ATTESTOR_PRIVATE_KEY` on first use. */
  signer?: TypedDataSigner;
  now?: () => number;
  /** The `verifyingContract` half of the domain. Defaults to
   *  `THETADUEL_ESCROW`; injected in tests so no deployment is needed. */
  escrow?: string;
}

export interface AttestService {
  /**
   * `POST /api/lock`. Always resolves, always 200.
   *
   * Body: `{ matchKey, picks, a, b?, sig }`. `sig` is `a`'s EIP-191 personal
   * signature over `lockMessage(matchKey, a, b, picks)` — module docstring,
   * point 3. Without it the lock is refused `"missing signature"`.
   */
  handleLock(req: Request): Promise<Response>;
  /** `POST /api/attest`. Always resolves, always 200. */
  handleAttest(req: Request): Promise<Response>;
  /** `GET /api/duel-status?duelId=0x…`. Synchronous — it only reads memory. */
  handleStatus(url: URL): Response;
  /** The same work without the HTTP envelope, for tests and in-process callers. */
  lock(body: unknown): LockEnvelope;
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
 */
export function lockMessage(
  matchKey: string,
  a: string,
  b: string | null,
  picks: Readonly<Record<string, string>>,
): string {
  return [
    LOCK_MESSAGE_PREFIX,
    `matchKey:${matchKey}`,
    `a:${getAddress(a)}`,
    `b:${b ? getAddress(b) : ZeroAddress}`,
    `picks:${canonicalPicks(picks)}`,
  ].join("\n");
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

  // ── lock ──────────────────────────────────────────────────────────────────

  function lock(body: unknown): LockEnvelope {
    if (!configured()) return NOT_CONFIGURED;
    if (!isRecord(body)) return { ok: false, reason: "bad body" };

    const key = parseMatchKey(body["matchKey"]);
    if ("reason" in key) return { ok: false, reason: key.reason };
    const matchKey = String(body["matchKey"]).trim();
    const duelId = id(matchKey);

    // FIRST WRITE WINS. Before anything else is validated, because the whole
    // point is that a second commit cannot influence the stored one — not its
    // picks, not its addresses, and not by being malformed either.
    const existing = locks.get(duelId);
    if (existing && now() - existing.at < LOCK_TTL_MS) {
      return {
        ok: true,
        duelId,
        commit: existing.commit,
        matchKey: existing.matchKey,
        note: "already locked",
      };
    }

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
    const message = lockMessage(matchKey, a.address!, b.address, picks);
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
    });

    return { ok: true, duelId, commit, matchKey };
  }

  // ── attest ────────────────────────────────────────────────────────────────

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
    // function trusts, and it is the match key.
    let meWins: boolean;
    try {
      meWins = deriveVerdict(key.lobby, key.seed, entry.picks).meWins;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason: `derive failed: ${reason}` };
    }
    const winner = meWins ? entry.a : entry.b;

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
      return json(lock(await readBody(req)));
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
