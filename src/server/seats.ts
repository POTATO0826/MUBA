/**
 * Who is actually sitting at the table: the duel's seats, read from the escrow.
 *
 * `src/server/attest.ts` decides who won a duel and signs a verdict the escrow
 * pays against. Until this module existed, it learned *who was playing* from
 * the request body — first from nothing at all, then (finding X-1) from an
 * EIP-191 signature by `a`, which proves the caller controls the address they
 * name and nothing else. The residual that signature leaves is the whole
 * reason this file exists:
 *
 *   > `b` is a real player with a real key, and in the intended flow `a` hands
 *   > `b` the room link. So `b` knows the match key before `a`'s client locks.
 *   > `b` searches the ≤ 4 096 reachable slips offline for one that wins,
 *   > signs a lock **as themselves in the `a` seat**, posts it first, and
 *   > first-write-wins pins it. Every signature check passes — `b` really does
 *   > control `b` — and the server then honestly signs a verdict paying `b`.
 *
 * No larger signature closes that, because nothing about the request can: the
 * body is the attacker's own. The only witness that cannot be forged is the
 * escrow itself, which learned both seats the expensive way — `a` paid a stake
 * to `open`, `b` paid a stake to `join`. So this module reads the seats out of
 * the contract's own storage and hands them back, and `lock()` compares rather
 * than believes.
 *
 * ## The read: the `duels` getter, not the events
 *
 * `DuelEscrow` declares `mapping(bytes32 => Duel) public duels`
 * (contracts/DuelEscrow.sol:189), so solc generates a free public getter that
 * returns the whole packed struct — `(a, b, invited, stake, fullAt, status,
 * aWithdrawn, bWithdrawn)`. That is one `eth_call` against latest state, and it
 * is strictly better than scanning `DuelOpened`/`DuelJoined`:
 *
 *  - **It answers the question that is actually being asked.** Logs say a seat
 *    was *once* taken; the getter says what the duel *is* right now. A duel
 *    that has been settled or refunded looks identical in the logs to one still
 *    waiting for a verdict, and only the second of those is worth locking.
 *  - **No range, no pagination, no reorg window.** A log scan needs a
 *    `fromBlock` — and picking one is a choice between missing an old duel and
 *    asking a throttled RPC for the world. State has no such parameter.
 *  - **`eth_getLogs` is the first call a public RPC rate-limits.** `eth_call`
 *    is the cheapest thing we could possibly ask for.
 *
 * The cost is that a getter cannot tell us anything the struct dropped, which
 * is nothing we need: `a`, `b` and `status` are exactly the fields the seat
 * question is about.
 *
 * ## Read-only, structurally
 *
 * The transport seam is one method — `call({ to, data })`. `JsonRpcProvider`
 * satisfies it; so does an object literal in a test. There is no signer here,
 * no `sendTransaction`, no key: **nothing in this file can move funds even if
 * every line of it is wrong**, the same discipline `server/thetanuts.ts` states
 * for the market client. `ATTESTOR_PRIVATE_KEY` is `attest.ts`'s alone and is
 * not read, imported or referenced here.
 *
 * ## Never throws, and a miss is typed
 *
 * Every failure — no configuration, a dead RPC, a wrong-chain RPC, an address
 * with no contract at it, an unparseable response, a duel id nobody has opened
 * — comes back as `{ ok: false, reason }`. `attest.ts` decides what a given
 * miss means for a lock; this module's only job is to report the chain
 * faithfully or admit that it could not. It deliberately does **not** decide
 * that an `OPEN` duel is unlockable or that a `SETTLED` one is too late: those
 * are policy, they belong next to the lock they refuse, and burying them here
 * would make the reader untestable against the states it did not like.
 *
 * Shape and style are `news.ts`'s and `attest.ts`'s: injectable deps, a bounded
 * oldest-evicting cache built with the same `put` (news.ts:317), and a clock
 * that a test can hold still.
 */

import { Interface, JsonRpcProvider, ZeroAddress, getAddress } from "ethers";

// ─────────────────────────────────────────────────────────────────────────────
// The ABI — one function, transcribed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The generated getter for `duels`, in the order solc lays the struct out
 * (contracts/DuelEscrow.sol:145-152, and `contracts/out/DuelEscrow.json`'s ABI
 * entry for `duels`). Field ORDER is the whole contract here — the decoder is
 * positional, so swapping `a` and `b` in this string would silently swap the
 * seats and hand the X-1 attacker exactly what the module exists to deny.
 * `test/seats.test.ts` therefore builds its fixtures from the committed
 * artifact's own ABI rather than from this line.
 */
const DUELS_SIGNATURE =
  "function duels(bytes32) view returns (address a, address b, address invited, uint128 stake, uint64 fullAt, uint8 status, bool aWithdrawn, bool bWithdrawn)";

const DUELS = new Interface([DUELS_SIGNATURE]);

/**
 * `Status` (contracts/DuelEscrow.sol:110-116), by ordinal. `NONE` is the zero
 * value, which is what an unused id decodes to — every field of an unwritten
 * mapping slot reads back as zero, so "this duel does not exist" and "this duel
 * has no opener" are the same answer and are handled as one.
 */
export const SEAT_STATUSES = ["NONE", "OPEN", "FULL", "SETTLED", "REFUNDED"] as const;
export type SeatStatus = (typeof SEAT_STATUSES)[number];

/**
 * Base mainnet, the only chain the escrow is ever deployed to (plan 5: "no
 * testnet exists"). It is passed to `JsonRpcProvider` as the EXPECTED network
 * rather than as a static one: ethers then verifies it against the endpoint and
 * throws on a mismatch, which this module turns into a refusal. An `RPC_URL`
 * pointed at the wrong chain would otherwise read a different chain's storage
 * for the same duel id — most likely finding nothing, but conceivably finding
 * someone else's duel — and that must fail closed, not resolve.
 *
 * Deliberately a local constant and not an import of `attest.ts`'s
 * `BASE_CHAIN_ID`: `attest.ts` imports this module, and a cycle between the two
 * would buy nothing. The value is not money-critical here (a wrong one refuses
 * reads; it cannot mis-sign anything).
 */
const BASE_CHAIN_ID = 8453;

// ─────────────────────────────────────────────────────────────────────────────
// Tuning
// ─────────────────────────────────────────────────────────────────────────────

/**
 * How long a duel that has both seats stays cached.
 *
 * Aggressive on purpose, and safe because of an immutability the contract
 * guarantees: `d.a` is written once by `open` and `d.b` once by `join`, and
 * **no function anywhere in the escrow ever writes either again**. So a cached
 * `(a, b)` pair cannot go stale in the way that matters. What can move
 * underneath it is `status`, FULL → SETTLED/REFUNDED, and the worst a stale
 * FULL can do is let a lock be stored for a duel that has just left FULL. That
 * costs nobody anything: a duel leaves FULL exactly once, so the verdict such a
 * lock would earn is one the escrow will refuse to pay — it is a wasted commit,
 * not a wrong one.
 */
export const SEATS_TTL_MS = 600_000;

/**
 * How long a duel that is still waiting for its opponent stays cached.
 *
 * Short, because this is the one entry that is *expected* to change: `b` may
 * land in the very next block, and a lock refused for a full ten minutes after
 * the opponent actually joined would look exactly like a broken server. Three
 * seconds is roughly a Base block and a half.
 */
export const SEATS_OPEN_TTL_MS = 3_000;

/**
 * How long "no such duel" stays cached.
 *
 * Shorter still. A client that opens on chain and locks in the same breath will
 * race the RPC's view of its own transaction, and the honest retry has to be
 * able to succeed. This is the interval a squatter would also have to wait out,
 * which is why it is seconds rather than minutes.
 */
export const SEATS_MISS_TTL_MS = 2_000;

/**
 * A read that has not answered by now is treated as unreachable.
 *
 * `JsonRpcProvider`'s own timeout is measured in minutes, and this read sits
 * inside an HTTP request a player is waiting on. Failing closed after four
 * seconds gives them a refusal they can retry; a hung fetch gives them nothing
 * at all. Transport failures are never cached, so the retry is a real one.
 */
export const SEAT_READ_TIMEOUT_MS = 4_000;

/** Bounded and oldest-evicting, exactly as both news caches and attest's lock
 *  store: a long-lived server must not hold one entry per duel it has seen. */
const CACHE_MAX = 200;

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The transport, reduced to the one method a read needs.
 *
 * `ethers.JsonRpcProvider` satisfies this structurally, and so does
 * `{ call: async () => "0x…" }` in a test — which is what makes every branch
 * below provable offline, months before the escrow is deployed. Narrowing the
 * seam this far is also a guarantee in itself: a `SeatProvider` cannot send a
 * transaction, because it has no method that could.
 */
export interface SeatProvider {
  call(tx: { to: string; data: string }): Promise<string>;
}

/** Why a read could not answer. Typed, because `attest.ts` dispositions each
 *  one differently and a string typo must not silently become a new policy. */
export type SeatMissReason =
  /** No escrow address, or nothing to read it with. The caller must treat this
   *  as "seat binding is switched off", never as "the seats are wrong". */
  | "seats not configured"
  /** Well-formed, but this is not a duel id. */
  | "bad duelId"
  /** The escrow has never heard of this duel — `Status.NONE`. */
  | "seats not on chain"
  /** The RPC did not answer, answered an error, or is on the wrong chain. */
  | "chain unreachable"
  /** It answered something that is not a `Duel` — no contract at the address,
   *  a truncated result, an impossible status ordinal. */
  | "bad chain response";

export interface SeatsOk {
  ok: true;
  /** The opener, EIP-55 checksummed. Set for every status but `NONE`. */
  a: string;
  /** The joiner, checksummed — `null` until someone joins. A `cancel`led duel
   *  is `REFUNDED` with `b` still null, which is why this is not implied by
   *  the status. */
  b: string | null;
  status: SeatStatus;
}

export interface SeatsMiss {
  ok: false;
  reason: SeatMissReason;
}

export type SeatsEnvelope = SeatsOk | SeatsMiss;

export interface SeatReaderDeps {
  /** Injected in tests. Omitted in production, where a read-only
   *  `JsonRpcProvider` is built lazily from `rpcUrl`. */
  provider?: SeatProvider;
  /** The deployed escrow. Defaults to `THETADUEL_ESCROW`. */
  escrow?: string;
  /** Defaults to `RPC_URL`. There is deliberately no fallback to a public
   *  endpoint — see `createSeatReader`. */
  rpcUrl?: string;
  /** Defaults to `SEAT_READ_TIMEOUT_MS`. Injected only so a test can prove the
   *  hung-RPC branch in milliseconds instead of four seconds. */
  timeoutMs?: number;
  now?: () => number;
}

export interface SeatReader {
  /**
   * False when there is no escrow address, or no way to reach a chain. The
   * caller's disposition for an unconfigured reader is "skip the check
   * entirely", so this flag is load-bearing: it is the difference between the
   * demo-without-staking path and a server that refuses every lock.
   */
  configured: boolean;
  /** The escrow being read, checksummed — `null` when unconfigured. Exposed so
   *  a caller can log or surface WHICH deployment answered. */
  escrow: string | null;
  /** Read one duel's seats. Never throws; never writes; never signs. */
  read(duelId: string): Promise<SeatsEnvelope>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cache
// ─────────────────────────────────────────────────────────────────────────────

interface CacheEntry {
  at: number;
  value: SeatsEnvelope;
}

/** Lifted from `news.ts:317` (and `attest.ts`) unchanged, so all three caches
 *  behave identically: delete-then-set moves a refreshed entry to the back
 *  rather than leaving it where it would be evicted while hot. */
function put<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > CACHE_MAX) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
  }
}

/**
 * How long a given answer may be reused — the whole cache policy, in one place
 * so it can be read as a policy rather than reconstructed from call sites.
 *
 * A zero means "do not cache at all", and every transport failure gets one:
 * caching a dead RPC would turn a blip into an outage that outlives it, and
 * refusing honest locks is exactly what this module must not do for longer than
 * it has to.
 */
function ttlFor(value: SeatsEnvelope): number {
  if (value.ok) return value.status === "OPEN" ? SEATS_OPEN_TTL_MS : SEATS_TTL_MS;
  return value.reason === "seats not on chain" ? SEATS_MISS_TTL_MS : 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Environment
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Read at call time, defensively, and never at import — `attest.ts:656`'s
 * `envKey` idiom for the same three reasons: a process started without an
 * environment must boot, a test must be able to construct this thing without
 * one, and nothing here may throw on a runtime that has no `process`.
 */
function envVar(name: string): string {
  try {
    return (
      (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name] ?? ""
    ).trim();
  } catch {
    return "";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The reader
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a seat reader.
 *
 * **There is no public-RPC fallback**, and that is a decision rather than an
 * omission. `server/thetanuts.ts` falls back to `https://mainnet.base.org` for
 * the market book because a throttled book is better than no book. Here the
 * opposite is true: a throttled read fails closed and refuses an honest
 * player's lock, so a reader with no `RPC_URL` reports itself unconfigured and
 * lets the caller keep its signature-only behaviour, which is a coherent mode.
 * Half-configured — an escrow address and a rate-limited public endpoint — is
 * not.
 */
export function createSeatReader(deps: SeatReaderDeps = {}): SeatReader {
  const now = deps.now ?? (() => Date.now());
  const timeoutMs = deps.timeoutMs ?? SEAT_READ_TIMEOUT_MS;
  const rpcUrl = (deps.rpcUrl ?? envVar("RPC_URL")).trim();

  // A malformed `THETADUEL_ESCROW` is a configuration problem, and the honest
  // reading of it is "there is no escrow" — not "read from a mangled address".
  let escrow: string | null = null;
  const escrowRaw = (deps.escrow ?? envVar("THETADUEL_ESCROW")).trim();
  if (escrowRaw) {
    try {
      escrow = getAddress(escrowRaw);
    } catch {
      escrow = null;
    }
  }

  // An injected provider is a transport in its own right; otherwise there has
  // to be a URL to build one from.
  const configured = escrow !== null && (deps.provider !== undefined || rpcUrl !== "");

  const cache = new Map<string, CacheEntry>();

  /**
   * Built once, lazily, on first read — never at import, mirroring `attest.ts`'s
   * signer. `index.ts` constructs the whole server at boot and a process with no
   * chain configured must start cleanly rather than throw on a URL it will never
   * use. `undefined` means "not built yet", `null` means "cannot be built".
   */
  let cachedProvider: SeatProvider | null | undefined;

  function provider(): SeatProvider | null {
    if (deps.provider) return deps.provider;
    if (cachedProvider !== undefined) return cachedProvider;
    try {
      cachedProvider = rpcUrl ? new JsonRpcProvider(rpcUrl, BASE_CHAIN_ID) : null;
    } catch {
      cachedProvider = null;
    }
    return cachedProvider;
  }

  /**
   * Race the read against a wall clock, so a hung fetch becomes a refusal.
   * `null` is the timeout; a rejection propagates and is caught by the caller.
   * The timer is always cleared, so a fast answer does not leave a handle
   * holding a test process open.
   */
  async function withTimeout(p: Promise<string>): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        p,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function read(duelIdRaw: string): Promise<SeatsEnvelope> {
    try {
      if (!configured || escrow === null) return { ok: false, reason: "seats not configured" };

      // Lower-cased before it is used as a cache key and before it goes on the
      // wire, so the same duel asked for twice in two casings is one entry and
      // one call. `attest.ts` derives it with `ethers.id`, which is already
      // lower case; a hand-typed one might not be.
      const duelId = duelIdRaw.trim().toLowerCase();
      if (!/^0x[0-9a-f]{64}$/.test(duelId)) return { ok: false, reason: "bad duelId" };

      const hit = cache.get(duelId);
      if (hit && now() - hit.at < ttlFor(hit.value)) return hit.value;

      const p = provider();
      if (!p) return { ok: false, reason: "seats not configured" };

      const raw = await withTimeout(p.call({ to: escrow, data: DUELS.encodeFunctionData("duels", [duelId]) }));
      if (raw === null) return { ok: false, reason: "chain unreachable" };

      // `decodeFunctionResult` throws on anything that is not eight ABI words —
      // `"0x"` from an address with no contract at it, a revert string that got
      // this far, a truncated response from a proxy that mangles them. All of
      // those are "I do not know who is playing", and the only safe answer to
      // that is a refusal.
      let out: ReturnType<typeof DUELS.decodeFunctionResult>;
      try {
        out = DUELS.decodeFunctionResult("duels", raw);
      } catch {
        return { ok: false, reason: "bad chain response" };
      }

      const statusOrdinal = Number(out[5]);
      if (!Number.isInteger(statusOrdinal) || statusOrdinal < 0 || statusOrdinal >= SEAT_STATUSES.length) {
        // A status this contract cannot produce means the thing at that address
        // is not this contract. Refuse rather than guess.
        return { ok: false, reason: "bad chain response" };
      }
      const status = SEAT_STATUSES[statusOrdinal]!;

      let a: string;
      let bRaw: string;
      try {
        a = getAddress(String(out[0]));
        bRaw = getAddress(String(out[1]));
      } catch {
        return { ok: false, reason: "bad chain response" };
      }

      // An unused mapping slot decodes to all zeroes, which is exactly
      // `Status.NONE` with a zero opener. Both spellings of "no such duel" land
      // here, and the caller never has to reason about a seat that is the zero
      // address.
      if (status === "NONE") {
        const miss: SeatsEnvelope = { ok: false, reason: "seats not on chain" };
        put(cache, duelId, { at: now(), value: miss });
        return miss;
      }
      // A live duel with no opener cannot exist: `open` writes `d.a` and nothing
      // clears it. Something other than this escrow answered — refuse, and do
      // not cache an answer we do not understand.
      if (a === ZeroAddress) return { ok: false, reason: "bad chain response" };

      const value: SeatsEnvelope = { ok: true, a, b: bRaw === ZeroAddress ? null : bRaw, status };
      put(cache, duelId, { at: now(), value });
      return value;
    } catch {
      // A provider that rejects — network down, 429, wrong chain id, a URL that
      // resolves to nothing — is unreachable. The message is dropped rather than
      // forwarded: it can carry the RPC URL, and the URL carries an API key.
      return { ok: false, reason: "chain unreachable" };
    }
  }

  return { configured, escrow, read };
}
