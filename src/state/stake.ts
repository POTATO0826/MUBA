import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_STAKE_USDC,
  JOIN_POLL_MS,
  MIN_STAKE_USDC,
  REFUND_TIMEOUT_HOURS,
  STAKE_OFF,
  ZERO_ADDRESS,
  commitLock,
  createLiveEscrowDeps,
  createLiveRefereeDeps,
  duelIdFor,
  joinDuel,
  openDuel,
  refundDuel,
  requestVerdict,
  settleDuel,
  stakeUnavailableReason,
  stakingAvailable,
  type EscrowDeps,
  type EscrowError,
  type EscrowStep,
  type OnChainDuel,
  type RefereeDeps,
  type StakeConfig,
  type StakeWallet,
  type Verdict,
} from "../desk/escrow.ts";

/**
 * The USDC side bet, as a hook: config, the six-state machine, and the claim.
 *
 * ## PTS is not in this file
 *
 * `src/state/ledger.ts` is untouched by everything here — `enter` and `settle`
 * are byte-identical to what they were before staking existed, and nothing below
 * imports the ledger, reads a point balance or writes one. That is the plan's
 * non-negotiable: **PTS and USDC are parallel and non-convertible**, there is no
 * rate between them, and no screen prints one quantity in both units. The two
 * systems share a duel and nothing else.
 *
 * ## Why the machine lives here and not in `state/match.ts`
 *
 * Two reasons, and the first is a hard rule. `test/determinism.test.ts`'s source
 * scan forbids the strings `/api/lock` and `/api/attest` anywhere in
 * `src/state/match.ts` — settlement must stay a pure function of
 * `(lobby, seed, picks)` and a referee call inside the match state would be
 * exactly the reach-through the guard exists to catch. The second is that the
 * side bet is genuinely orthogonal: the match runs identically whether this hook
 * ever leaves `idle`.
 *
 * `match.ts` gains exactly one additive seam — `useMatch(route, { liveSeats })`,
 * which suppresses the fake `OPP_READY_MS` timer once a real seat is held on
 * chain — and one additive action, `oppReady`, which the join poller calls.
 * Default `liveSeats` is `false`, so PTS-only play and every existing test keep
 * the 1100 ms timer exactly.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The config gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask the server whether the side bet is switched on, and whether there is an
 * escrow to switch it on *to*.
 *
 * Shaped exactly like `useTradeConfig` in `src/views/Parlay.tsx`, deliberately:
 * read at mount rather than baked in, because `THETADUEL_STAKE=on` is a
 * per-process decision and `/api/config` is `no-store`; and the mock tier never
 * even asks, because the mock cannot sign and must not approve, so there is
 * nothing for the flag to enable and the default build makes no network call it
 * would only ignore the answer to.
 *
 * Everything that fails leaves this at `STAKE_OFF`, which renders exactly the
 * DOM the app rendered before this file existed.
 */
export function useStakeConfig(walletId: string | undefined): StakeConfig {
  const [config, setConfig] = useState<StakeConfig>(STAKE_OFF);

  useEffect(() => {
    if (!walletId || walletId === "mock") return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        const body = (await res.json()) as {
          escrow?: string;
          chainId?: number;
          features?: { stake?: boolean };
        };
        if (!live) return;
        setConfig({
          enabled: body.features?.stake === true,
          escrow: typeof body.escrow === "string" ? body.escrow : "",
          chainId: typeof body.chainId === "number" ? body.chainId : STAKE_OFF.chainId,
        });
      } catch {
        // Fail closed, silently: a static build has no server to ask and is not
        // misconfigured.
      }
    })();
    return () => {
      live = false;
    };
  }, [walletId]);

  return config;
}

// ─────────────────────────────────────────────────────────────────────────────
// The six-state machine
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The room's ready button, as six states.
 *
 *   idle ─► approving ─► staking ─► confirming ─► staked
 *              └────────────┴────────────┴──────────► failed
 *
 * `failed` is not a dead end and is not an error screen: it is **PTS-only**, the
 * game exactly as it has always been. Every one of the escrow module's codes
 * lands here, the duel goes ahead, and the copy says so. That is the phase's
 * whole reason for existing — a side bet that cannot be placed must never be
 * able to stop a match.
 *
 *  - `approving` — an exact-amount USDC approval is in the wallet.
 *  - `staking`   — `open` or `join` has been submitted.
 *  - `confirming`— our stake is held; the other seat has not filled yet. Only
 *                  reachable from `open`; a `join` completes the pot and goes
 *                  straight to `staked`.
 *  - `staked`    — both stakes are in the escrow and the duel is settleable.
 */
export type StakePhase = "idle" | "approving" | "staking" | "confirming" | "staked" | "failed";

/** The claim, on the result screen. Separate from `StakePhase` because it
 *  happens an entire match later and fails for entirely different reasons. */
export type ClaimPhase = "idle" | "signing" | "relaying" | "claimed" | "failed";

export interface DuelStake {
  // ── the gate ──
  /** The flag is on, an escrow is deployed, and the wallet can sign. */
  available: boolean;
  /** Why not, when the flag is on but something else is missing. `null`
   *  otherwise — with the flag off there is no absence to explain. */
  unavailable: string | null;
  /** The escrow address `/api/config` named, for the BaseScan link. */
  escrow: string;

  // ── the amount ──
  /** Per-player side bet, USDC 6dp. Owner-settable in the create form. */
  amount: bigint;
  setAmount: (next: bigint) => void;

  // ── the machine ──
  phase: StakePhase;
  error: EscrowError | null;
  /** An on-chain seat is held. This is what suppresses the fake opponent
   *  timer — see `useMatch(route, { liveSeats })`. */
  live: boolean;
  /** The chain says both stakes are in. The room turns this into `oppReady`. */
  joined: boolean;
  duelId: string | null;
  /** The staking transaction, once one has landed. */
  hash: string | null;
  /** True when the standing allowance already covered the stake. */
  approvalSkipped: boolean;
  /** Unix seconds the duel filled — the base for the six-hour timeout. */
  fullAt: number | null;
  /** Whether this wallet opened the duel or joined it. */
  seat: "a" | "b" | null;
  /**
   * The two seats **as the escrow holds them**: `a` paid to `open`, `b` paid to
   * `join`. Read back off the contract, never assembled from what this browser
   * believes — that distinction is the whole of review finding X-1's fix, and
   * `/api/lock` now compares against exactly these two addresses, in this order.
   */
  seats: { a: string; b: string } | null;

  /** The ready press. Opens the duel, or joins one that is already open. */
  begin: (matchKey: string) => void;
  /**
   * The parlay lock: commit the slip to the referee, signed.
   *
   * A no-op unless a stake is live — and, when one is, **deferred until the
   * escrow says the duel is FULL and this wallet is the opener**. The picks are
   * held until then and the lock fires by itself; see the effect below for why
   * the wait is not optional.
   */
  commit: (matchKey: string, picks: Readonly<Record<string, string>>) => void;
  /** The slip is committed and the referee will sign a verdict for it. */
  locked: boolean;
  /** Why the lock was refused — typed, and always a closed failure: no verdict
   *  will be signed, so the six-hour refund is what returns the money. */
  lockError: EscrowError | null;
  /** Back to `idle`, keeping the amount. Called on leaving a room. */
  reset: () => void;

  // ── the claim ──
  claimPhase: ClaimPhase;
  claimError: EscrowError | null;
  claimHash: string | null;
  /** The verdict the referee signed, once it has one. */
  verdict: Readonly<Verdict> | null;
  /** `CLAIM $N`. Asks the referee for a verdict, then relays it. */
  claim: (matchKey: string) => void;
  /** After the six-hour timeout, pull our own stake back. */
  refund: () => void;
  /** Whether the timeout has passed, so the refund button can appear. */
  refundable: boolean;
}

export interface StakeOptions {
  /** Injected by `test/stake.test.ts`, so the machine is driven with no chain,
   *  no wallet and no socket in reach. */
  config?: StakeConfig;
  deps?: (escrow: string) => EscrowDeps;
  referee?: () => RefereeDeps;
  duelId?: (matchKey: string) => Promise<string>;
  now?: () => number;
  pollMs?: number;
}

const NO_STAKE_BASE = {
  available: false,
  unavailable: null,
  escrow: "",
  phase: "idle",
  error: null,
  live: false,
  joined: false,
  duelId: null,
  hash: null,
  approvalSkipped: false,
  fullAt: null,
  seat: null,
  seats: null,
  locked: false,
  lockError: null,
  claimPhase: "idle",
  claimError: null,
  claimHash: null,
  verdict: null,
  refundable: false,
} as const;

/**
 * One duel's side bet.
 *
 * Called by `App` **before** `useMatch`, because `useMatch` needs `live` to know
 * whether to fake the opponent's ready. That ordering is why `begin` takes the
 * match key as an argument rather than the hook taking it as a parameter: the
 * key is derived state and would not exist yet.
 */
export function useDuelStake(
  wallet: StakeWallet | undefined,
  options: StakeOptions = {},
): DuelStake {
  const fetched = useStakeConfig(options.config ? undefined : wallet?.id);
  const config = options.config ?? fetched;
  const walletId = wallet?.id;

  const available = stakingAvailable(config, walletId);
  const unavailable = stakingAvailable(config, walletId)
    ? null
    : stakeUnavailableReason(config, walletId);

  const [amount, setAmount] = useState<bigint>(DEFAULT_STAKE_USDC);
  const [phase, setPhase] = useState<StakePhase>("idle");
  const [error, setError] = useState<EscrowError | null>(null);
  const [duelId, setDuelId] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [approvalSkipped, setApprovalSkipped] = useState(false);
  const [seat, setSeat] = useState<"a" | "b" | null>(null);
  const [seats, setSeats] = useState<{ a: string; b: string } | null>(null);
  const [fullAt, setFullAt] = useState<number | null>(null);
  const [locked, setLocked] = useState(false);
  const [lockError, setLockError] = useState<EscrowError | null>(null);

  const [claimPhase, setClaimPhase] = useState<ClaimPhase>("idle");
  const [claimError, setClaimError] = useState<EscrowError | null>(null);
  const [claimHash, setClaimHash] = useState<string | null>(null);
  const [verdict, setVerdict] = useState<Readonly<Verdict> | null>(null);

  const now = options.now ?? (() => Date.now());
  const pollMs = options.pollMs ?? JOIN_POLL_MS;

  /** One in-flight sequence at a time. A double-press must not send two
   *  approvals, and a stale sequence must not write over a newer one. */
  const runId = useRef(0);

  /**
   * The slip, waiting for the chain.
   *
   * `commit` cannot fire when the parlay locks, because `/api/lock` refuses a
   * duel that is still OPEN — `"opponent has not joined on chain"` — and pinning
   * one early with no joiner would leave the duel permanently unsettleable. So
   * the picks are parked here and the effect below sends them the moment the
   * escrow reports FULL. A duel that never fills never locks, and refunds.
   */
  const [pending, setPending] = useState<{
    matchKey: string;
    picks: Readonly<Record<string, string>>;
  } | null>(null);

  /**
   * The deps, rebuilt only when the wallet or the escrow changes. `null` when
   * staking is not available at all — which is also the reason nothing in the
   * live adapter is ever constructed on the default build.
   */
  const deps = useMemo<EscrowDeps | null>(() => {
    if (!available || !wallet) return null;
    return options.deps ? options.deps(config.escrow) : createLiveEscrowDeps(wallet, config.escrow);
    // `options.deps` is a test seam and is stable per test by construction.
  }, [available, wallet, config.escrow, options.deps]);

  const referee = useMemo<RefereeDeps | null>(() => {
    if (!available || !wallet) return null;
    if (options.referee) return options.referee();
    return createLiveRefereeDeps(async (message: string) => {
      const signer = (await wallet.getSigner()) as {
        signMessage(m: string): Promise<string>;
      } | null;
      if (!signer) throw new Error("SIGNER_REQUIRED");
      return signer.signMessage(message);
    });
  }, [available, wallet, options.referee]);

  const idOf = options.duelId ?? duelIdFor;

  const reset = useCallback(() => {
    runId.current += 1;
    setPhase("idle");
    setError(null);
    setDuelId(null);
    setHash(null);
    setApprovalSkipped(false);
    setSeat(null);
    setSeats(null);
    setFullAt(null);
    setLocked(false);
    setLockError(null);
    setPending(null);
    setClaimPhase("idle");
    setClaimError(null);
    setClaimHash(null);
    setVerdict(null);
  }, []);

  /** `EscrowStep` → `StakePhase`. The one place the two vocabularies meet. */
  const stepPhase = useCallback((step: EscrowStep) => {
    if (step === "approve") setPhase("approving");
    else if (step === "send") setPhase("staking");
  }, []);

  const begin = useCallback(
    (matchKey: string) => {
      if (!deps) return;
      const mine = (runId.current += 1);
      const stale = () => runId.current !== mine;

      setError(null);
      setPhase("approving");

      void (async () => {
        let id: string;
        try {
          id = await idOf(matchKey);
        } catch {
          if (!stale()) {
            setPhase("failed");
            setError({
              code: "NETWORK",
              message: "Could not derive this duel's id.",
              recovery:
                "The side bet is off for this match. The duel goes ahead on the PTS pool " +
                "exactly as it always has.",
              action: "none",
              step: "guard",
            });
          }
          return;
        }
        if (stale()) return;
        setDuelId(id);

        // Which side of the duel are we? Read the chain rather than guess: the
        // room link is symmetric, both players press the same button, and
        // whoever gets there first is `a`.
        let existing: OnChainDuel | null = null;
        try {
          existing = await deps.duelOf(id);
        } catch {
          // A failed read is not a reason to refuse — `open` will tell us
          // `duel exists` if we guessed wrong, and that is a clean refusal that
          // spends nothing.
          existing = null;
        }
        if (stale()) return;

        const me = (await deps.address().catch(() => null))?.toLowerCase() ?? null;
        if (stale()) return;

        if (existing?.status === "FULL") {
          setSeat(existing.a.toLowerCase() === me ? "a" : "b");
          setSeats({ a: existing.a, b: existing.b });
          setFullAt(existing.fullAt);
          setPhase("staked");
          return;
        }
        if (existing?.status === "OPEN" && existing.a.toLowerCase() === me) {
          setSeat("a");
          setPhase("confirming");
          return;
        }

        const joining = existing?.status === "OPEN";
        // A joiner matches the stake the opener booked, not the one this
        // browser's create form happens to hold: the contract takes `d.stake`
        // and an approval for anything less simply reverts.
        const stake = joining ? existing!.stake : amount;
        const outcome = joining
          ? await joinDuel(id, stake, deps, (s) => !stale() && stepPhase(s))
          : await openDuel(id, stake, deps, (s) => !stale() && stepPhase(s), ZERO_ADDRESS);
        if (stale()) return;

        if (outcome.status !== "ok") {
          setPhase("failed");
          setError(outcome.status === "failed" ? outcome.error : null);
          return;
        }
        setHash(outcome.hash);
        setApprovalSkipped(outcome.approvalSkipped);
        setSeat(joining ? "b" : "a");

        if (!joining) {
          // An open still needs the other seat; the poller below watches for it.
          setPhase("confirming");
          return;
        }

        // A join completes the pot — but the seats are read back off the
        // contract rather than assembled here. `d.a` is whoever paid to open,
        // and this browser only *believes* it knows who that was; `/api/lock`
        // compares against the contract, in order, so the contract is the only
        // source worth carrying.
        const filled = await deps.duelOf(id).catch(() => null);
        if (stale()) return;
        if (filled) {
          setSeats({ a: filled.a, b: filled.b });
          setFullAt(filled.fullAt);
        } else {
          setFullAt(Math.floor(now() / 1000));
        }
        setPhase("staked");
      })();
    },
    [amount, deps, idOf, now, stepPhase],
  );

  /**
   * `DuelJoined`, by polling `duels(duelId)`.
   *
   * Polling rather than an event subscription because the browser has no
   * WebSocket RPC configured (`RPC_URL` is server-only and secret) and a filter
   * over the public endpoint is exactly the burst that gets throttled. The read
   * is one `eth_call` every four seconds, and only while a stake of ours is
   * genuinely open — never on the default build, never in PTS-only play, and
   * never once the duel is full.
   */
  useEffect(() => {
    if (!deps || phase !== "confirming" || !duelId) return;
    let live = true;
    const read = async () => {
      try {
        const d = await deps.duelOf(duelId);
        if (!live || !d) return;
        if (d.status === "FULL") {
          // `DuelJoined`, in the only form this browser can trust: the seats as
          // the contract wrote them.
          setSeats({ a: d.a, b: d.b });
          setFullAt(d.fullAt);
          setPhase("staked");
        } else if (d.status === "SETTLED" || d.status === "REFUNDED") {
          setSeats({ a: d.a, b: d.b });
          setPhase("staked");
        }
      } catch {
        // A throttled read is not a state change. Try again on the next tick.
      }
    };
    void read();
    const t = setInterval(() => void read(), pollMs);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [deps, phase, duelId, pollMs]);

  /**
   * Park the slip. The lock itself is fired by the effect below.
   *
   * It cannot be sent here, and the reason is the seat binding that landed in
   * `src/server/seats.ts`: with an escrow configured, `/api/lock` reads the
   * escrow's own `duels` getter and refuses a duel that is still OPEN with
   * `"opponent has not joined on chain"`. Pinning a slip before the joiner has
   * paid would name an opponent the chain has never seen — and because the lock
   * is first-write-wins, that mistake is unrecoverable: the duel could never be
   * settled afterwards. So the picks wait.
   */
  const commit = useCallback(
    (matchKey: string, picks: Readonly<Record<string, string>>) => {
      if (!deps || !referee) return;
      setPending({ matchKey, picks });
    },
    [deps, referee],
  );

  /**
   * The lock, sent the moment the chain will accept it.
   *
   * Three conditions, all from `src/server/attest.ts`'s disposition table, and
   * all of them checked here so an honest player does not burn their one
   * first-write-wins attempt on a request the server was always going to
   * refuse:
   *
   *  1. the escrow says the duel is **FULL** — both stakes paid;
   *  2. this wallet is the **opener**. The comparison the server makes is
   *     ORDERED, `a` is the address that called `open`, and a joiner-posted lock
   *     is refused by design. In this game the seats are not interchangeable
   *     either: `a` is the seat whose picks are committed;
   *  3. `a` and `b` are the addresses **read back off the contract**, not the
   *     ones this browser assembled.
   *
   * A joiner therefore never locks, and a duel whose second seat never fills
   * never locks either — it refunds after six hours, which is the outcome the
   * copy promises.
   */
  useEffect(() => {
    if (!deps || !referee || locked) return;
    if (phase !== "staked" || seat !== "a" || !seats) return;
    if (!pending) return;
    const job = pending;
    let live = true;
    void (async () => {
      const out = await commitLock(job.matchKey, seats.a, seats.b, job.picks, referee);
      if (!live) return;
      // Sent, once. Clearing the job whatever the answer is the point: the
      // route is first-write-wins, so a retry could only ever confirm what the
      // first attempt already decided.
      setPending(null);
      if (out.ok) setLocked(true);
      else setLockError(out.error);
    })();
    return () => {
      live = false;
    };
  }, [deps, referee, phase, seat, seats, locked, pending]);

  const claim = useCallback(
    (matchKey: string) => {
      if (!deps || !referee) return;
      setClaimError(null);
      setClaimPhase("signing");
      void (async () => {
        const asked = await requestVerdict(matchKey, referee);
        if (!asked.ok) {
          setClaimPhase("failed");
          setClaimError(asked.error);
          return;
        }
        setVerdict(asked.verdict);
        setClaimPhase("relaying");
        const relayed = await settleDuel(asked.verdict, deps);
        if (relayed.status === "ok") {
          setClaimHash(relayed.hash);
          setClaimPhase("claimed");
          return;
        }
        setClaimPhase("failed");
        setClaimError(relayed.status === "failed" ? relayed.error : null);
      })();
    },
    [deps, referee],
  );

  const refund = useCallback(() => {
    if (!deps || !duelId) return;
    setClaimError(null);
    setClaimPhase("relaying");
    void (async () => {
      const out = await refundDuel(duelId, deps);
      if (out.status === "ok") {
        setClaimHash(out.hash);
        setClaimPhase("claimed");
        return;
      }
      setClaimPhase("failed");
      setClaimError(out.status === "failed" ? out.error : null);
    })();
  }, [deps, duelId]);

  const live = phase === "staking" || phase === "confirming" || phase === "staked";
  const refundable =
    fullAt !== null && now() / 1000 > fullAt + REFUND_TIMEOUT_HOURS * 3600 && phase === "staked";

  return {
    available,
    unavailable,
    escrow: config.escrow,
    amount,
    setAmount,
    phase,
    error,
    live,
    joined: phase === "staked",
    duelId,
    hash,
    approvalSkipped,
    fullAt,
    seat,
    seats,
    begin,
    commit,
    locked,
    lockError,
    reset,
    claimPhase,
    claimError,
    claimHash,
    verdict,
    claim,
    refund,
    refundable,
  };
}

/**
 * The inert side bet.
 *
 * What `App` uses when no wallet layer is wired at all, and what every view
 * treats as "render nothing extra". Exported so a test — or a story — can mount
 * `Room` and `Result` in exactly their pre-staking shape without constructing a
 * machine first.
 */
export const NO_STAKE: DuelStake = {
  ...NO_STAKE_BASE,
  amount: DEFAULT_STAKE_USDC,
  setAmount: () => {},
  begin: () => {},
  commit: () => {},
  reset: () => {},
  claim: () => {},
  refund: () => {},
};

/** The floor, re-exported so the create form does not import the escrow module
 *  just to name one constant. */
export { MIN_STAKE_USDC };
