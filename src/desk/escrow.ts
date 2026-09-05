import { DUEL_ESCROW_ABI } from "../utils/duelescrow.ts";
import {
  ALCHEMY_HINT,
  BASESCAN_TX,
  MAX_UINT256,
  PUBLIC_BASE_RPC,
  looksThrottled,
  usdText,
  type FillAction,
} from "./fill.ts";
import {
  BASE_SEPOLIA_CHAIN_ID,
  baseExplorerTx,
  baseNetworkByChainId,
} from "../data/base-network.ts";

/**
 * The USDC side bet: two players lock equal stakes in `DuelEscrow` on Base, the
 * server's referee key signs a verdict, the winner relays it and is paid.
 *
 * ## Why this file sits beside `fill.ts` and not in `src/wallet/`
 *
 * `src/wallet/` is the wallet-*tier* directory: every module in it is either a
 * `WalletSource` implementation (mock, injected, AppKit) or the boot config that
 * chooses between them. An escrow client is not a wallet — it is the second
 * money-moving sequence in the app, and the first one already lives here.
 * Concretely, this module reuses four things from `./fill.ts` — `usdText`,
 * `looksThrottled`, `ALCHEMY_HINT` and the `FillAction` recovery vocabulary — so
 * that a dollar figure, a throttle and a "connect a wallet" button read
 * identically whether the money is buying an option or backing a duel. Housing
 * it in `src/wallet/` would have bought a cross-directory import of the desk to
 * get them, or a copy of each, and neither is worth the tidier-sounding path.
 *
 * `src/desk/` is therefore read here as "the guarded on-chain sequences", which
 * is what it has actually been since P3.
 *
 * ## The four rules, inherited from `fill.ts` and re-earned here
 *
 * 1. **Opt-IN, twice over.** Nothing here runs unless `/api/config` says
 *    `features.stake` (`THETADUEL_STAKE=on` exactly, `index.ts`) **and** the same
 *    config names a deployed `escrow` address. The second condition is not
 *    belt-and-braces: see the gating note below.
 * 2. **Exact approvals, never `MaxUint256`.** `approve` is called with the
 *    stake and nothing else, and only when the standing allowance is short.
 * 3. **The mock wallet never approves and never transacts.** Refused above
 *    `getSigner`, exactly as `runFill` refuses it.
 * 4. **Every failure degrades to PTS-only.** This is the rule that is specific
 *    to staking. A fill that fails is a fill that did not happen; a *duel* that
 *    fails to stake is still a duel — the PTS game is untouched, the tape still
 *    runs, XP and rank still move. So every outcome here is a value, never a
 *    throw, and every error's copy says what happened to the side bet **and**
 *    that the duel is unaffected.
 *
 * ## PTS and USDC are parallel and non-convertible
 *
 * The PTS ledger (`src/state/ledger.ts`) is not touched by anything in this
 * file, and nothing in this file is denominated in points. There is no exchange
 * rate between them, no screen shows one, and no quantity is ever printed in
 * both units. `stakePointsFor`'s ×1000 bridge is the PTS game's internal ETH
 * fiction and has nothing to do with USDC; the two systems share a duel and
 * nothing else.
 *
 * ## The gating rule — adversarial review finding X-1
 *
 * `docs/reviews/escrow-adversarial-review.md` X-1: while `POST /api/lock` took
 * `a`, `b` and `picks` from an unauthenticated request body, a counterparty
 * could search the ≤ 4 096 reachable slips offline, commit a winning one naming
 * themselves, and the escrow would pay it — correctly, because its only payee
 * constraint (`winner ∈ {a, b}`) held. The contract cannot fix that and neither
 * can this module.
 *
 * What this module does instead is refuse to be enable-able by a flag alone:
 * `THETADUEL_STAKE=on` switches nothing on unless `/api/config` also carries a
 * non-empty `escrow` address, which only exists once someone has deployed the
 * contract with a specific attestor — i.e. once the server that will referee has
 * been chosen deliberately. `stakingAvailable()` below is that check, it is the
 * single gate the UI asks, and it fails closed on every ambiguity: no config, no
 * escrow, a malformed address, the mock wallet, or a config route that never
 * answers.
 *
 * This module deliberately does **not** import `src/server/seats.ts`. That is
 * the real fix for X-1 and it has now landed: with an escrow configured,
 * `/api/lock` reads the escrow's own `duels` getter and **compares** the claimed
 * seats to the chain, in order. Requiring a configured escrow here is the
 * interlock that keeps a flag flip from getting ahead of it, and the two work
 * together — the client refuses to offer a side bet without an escrow, and the
 * server refuses to sign a verdict for seats the escrow does not confirm.
 *
 * What the seat binding demands of the flow in this file, and `commitLock`
 * enforces before it sends anything:
 *
 *   open ─► join confirmed on chain ─► lock (posted by the OPENER, seats in
 *   order) ─► the duel plays ─► attest ─► settle
 *
 * The lock is consumed over HTTP only; nothing here imports the server module,
 * which the determinism guard now names.
 *
 * ## Where the facts come from
 *
 * Every constant and every revert string below is transcribed from
 * `contracts/DuelEscrow.sol` and pinned by executable tests. The prior
 * adversarial review remains useful background but predates the $20 cap.
 * The five values and behaviours that shape this sequence:
 *
 *  - `MIN_STAKE = 100_000` ($0.10) and `MAX_STAKE = 20_000_000` ($20.00).
 *    Both bounds are checked before a wallet prompt and again on chain.
 *  - `RAKE_BPS = 400`, and `payout + rake == 2 × stake` **exactly** for every
 *    stake — verified on chain for 14 values and swept over 250 000 (review §3).
 *    So `payoutOf` here can be integer arithmetic with no dust term.
 *  - `TIMEOUT = 6 hours`, refund is a **pull**, and the first pull moves the duel
 *    to `REFUNDED` — which closes `settle` forever (review §4-1). That is why the
 *    winner's copy says *claim within 6 hours*: after the timeout a loser who
 *    refunds first forces a draw. No principal is at risk either way.
 *  - `open` requires the id to be unused, and ids are never recycled. A squatted
 *    id (review §6-1) surfaces here as `DUEL_TAKEN`, which is a denial of
 *    service on one room and never a path to anyone's money.
 *  - The stake token is read off the escrow's own `usdc()` rather than
 *    hard-coded. Review finding 5-1: the constructor accepts any non-zero
 *    address and there is no rescue path, so the token this contract will
 *    actually pull is the only token worth approving.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The bounds
// ─────────────────────────────────────────────────────────────────────────────

/** `contracts/DuelEscrow.sol:154` — `MIN_STAKE`, $0.10 of USDC at 6dp. */
export const MIN_STAKE_WEI = 1_000_000_000_000_000n;

/** Contract-enforced maximum: $20.00 per player. */
export const MAX_STAKE_WEI = (1n << 128n) - 1n;

/** What the create form opens on: $1.00. Small enough to rehearse the whole
 *  path for the price of a coffee, large enough to be visibly real. */
export const DEFAULT_STAKE_WEI = MIN_STAKE_WEI;

/** Temporary aliases for callers being migrated from the old USDC escrow. */
export const MIN_STAKE_USDC = MIN_STAKE_WEI;
export const MAX_STAKE_USDC = MAX_STAKE_WEI;
export const LARGE_STAKE_USDC = MAX_STAKE_WEI;
export const DEFAULT_STAKE_USDC = DEFAULT_STAKE_WEI;

/** `RAKE_BPS` / `BPS` — 4% of the pot, to the treasury, on settlement only. */
export const RAKE_BPS = 0n;
export const BPS = 10_000n;

/** `TIMEOUT`, in hours. Every piece of refund copy in the app reads this. */
export const REFUND_TIMEOUT_HOURS = 6;

/** How often the room asks the chain whether the second seat has filled. */
export const JOIN_POLL_MS = 4_000;

export { BASESCAN_TX, MAX_UINT256, PUBLIC_BASE_RPC, usdText };
export const BASE_CHAIN_ID = BASE_SEPOLIA_CHAIN_ID;

/** BaseScan for an address — the escrow's own page, linked so a player can read
 *  the contract holding their money before they send it. */
export const BASESCAN_ADDRESS = "https://basescan.org/address/";

/**
 * What the winner is actually paid: the pot, less 4%.
 *
 * Integer arithmetic in the contract's own order of operations
 * (`pot * RAKE_BPS / BPS`, floored), so the number on screen is the number the
 * chain will transfer rather than a rounding of it. The review's property sweep
 * confirms the floor always favours the winner.
 */
export function payoutOf(stake: bigint): bigint {
  return stake * 2n;
}

/** The open seat: `invited = 0` means "first comer", and an unknown `b` on a
 *  lock is spelled this way so that `""`, `null` and the zero address all
 *  produce one signable string rather than three. */
export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** `0x` + 40 hex. The only shape this module will treat as an address. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** `0x` + 64 hex — a `bytes32` duel id. */
const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;

export const isAddress = (v: unknown): v is string =>
  typeof v === "string" && ADDRESS_RE.test(v);

/**
 * `"0.10"` → `100_000n`. `null` for anything that is not a stake.
 *
 * Parsed as decimal text rather than through `Number`, because the whole point
 * of the figure is that it is the amount approved: `parseFloat("0.07") * 1e6` is
 * `70000.00000000001`, and a stake is not a place to discover floating point.
 * Extra decimals are refused rather than rounded — USDC has six, and silently
 * dropping a seventh is silently changing what someone typed.
 */
export function parseStakeEth(raw: string): bigint | null {
  const text = raw.trim().replace(/\s*ETH$/i, "");
  if (!/^\d*(\.\d*)?$/.test(text) || text === "" || text === ".") return null;
  const [whole = "", frac = ""] = text.split(".");
  if (frac.length > 18) return null;
  return BigInt(whole || "0") * 1_000_000_000_000_000_000n +
    BigInt((frac || "0").padEnd(18, "0"));
}

export const parseStakeUsdc = parseStakeEth;

/** The label the panels print: `$1.00`, `$0.10`, `$12.5`. */
export function eth(amount: bigint): string {
  const whole = amount / 1_000_000_000_000_000_000n;
  const fraction = (amount % 1_000_000_000_000_000_000n)
    .toString()
    .padStart(18, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction ? `.${fraction}` : ""} ETH`;
}

/** Backward-compatible formatter name; values are native ETH wei. */
export const usd = eth;

// ─────────────────────────────────────────────────────────────────────────────
// The gate
// ─────────────────────────────────────────────────────────────────────────────

/** `/api/config`, narrowed to the three fields staking reads. */
export interface StakeConfig {
  /** `features.stake` — `THETADUEL_STAKE=on` exactly. */
  enabled: boolean;
  /** `THETADUEL_ESCROW`. Empty means nothing is deployed. */
  escrow: string;
  chainId: number;
}

/** Opt-IN means the absence of an answer is the absence of the feature. */
export const STAKE_OFF: StakeConfig = { enabled: false, escrow: "", chainId: BASE_SEPOLIA_CHAIN_ID };

/**
 * The one question the UI asks before it will offer a side bet.
 *
 * Three conditions, all required, in the order they fail closed:
 *
 *  1. the operator set `THETADUEL_STAKE=on`;
 *  2. the same server names a deployed escrow — **finding X-1's interlock**, the
 *     reason a flag alone cannot turn real money on;
 *  3. the wallet can actually sign. The mock never approves and never transacts
 *     (`src/wallet/mock.ts`), so on the mock tier there is nothing to enable and
 *     the panel is not drawn at all.
 *
 * Anything else — an unreachable config route, a truncated address, a wallet
 * that has not connected — leaves this `false`, and `false` renders exactly the
 * DOM the room and the result screen rendered before this file existed.
 */
export function stakingAvailable(config: StakeConfig, walletId: string | undefined): boolean {
  if (!config.enabled) return false;
  if (config.chainId !== BASE_SEPOLIA_CHAIN_ID) return false;
  if (!isAddress(config.escrow)) return false;
  if (!walletId || walletId === "mock") return false;
  return true;
}

/**
 * Why the side bet is not on offer, in one honest sentence, or `null` when it
 * is.
 *
 * Only ever shown when the flag itself is on: with the flag off there is no
 * feature to explain the absence of, and a line of copy about a switch nobody
 * flipped would be noise on the default build. With the flag on and the escrow
 * missing, silence would be worse than noise — an operator would think they had
 * enabled something they had not.
 */
export function stakeUnavailableReason(
  config: StakeConfig,
  walletId: string | undefined,
): string | null {
  if (!config.enabled) return null;
  if (config.chainId !== BASE_SEPOLIA_CHAIN_ID)
    return "Stake unavailable: this build only permits Base Sepolia (84532).";
  if (!isAddress(config.escrow))
    return (
      "Stake unavailable: this server has THETADUEL_STAKE=on but no escrow contract " +
      "configured. Staking stays off until THETADUEL_ESCROW names a deployed DuelEscrow — " +
      "a flag on its own is not allowed to move money."
    );
  if (walletId === "mock")
    return (
      "Stake unavailable: the mock wallet cannot sign, and must not. Connect a real " +
      "wallet on Base Sepolia to stake test ETH. The duel plays either way."
    );
  if (!walletId) return null;
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Shapes
// ─────────────────────────────────────────────────────────────────────────────

/** `Status` in `contracts/DuelEscrow.sol:110-116`, by ordinal. */
export const DUEL_STATUS = ["NONE", "OPEN", "FULL", "SETTLED", "REFUNDED"] as const;
export type DuelStatus = (typeof DUEL_STATUS)[number];

/** One duel as the chain holds it — the fields the UI reads back. */
export interface OnChainDuel {
  status: DuelStatus;
  a: string;
  b: string;
  stake: bigint;
  /** Unix seconds the duel became FULL, or 0 while OPEN. */
  fullAt: number;
}

/**
 * The attestor's verdict, exactly as `settle` takes it.
 *
 * Frozen the instant it arrives from `/api/attest`, for the same reason
 * `freezeOrder` freezes a resting order: this is a signature over
 * `(duelId, winner, deadline)` and a helpful normalisation of any one of them —
 * lower-casing the winner, widening the deadline — produces a digest that
 * recovers to a stranger and a transaction that reverts
 * `bad attestor signature`.
 */
export interface Verdict {
  duelId: string;
  winner: string;
  deadline: number;
  signature: string;
}

export function freezeVerdict(v: Verdict): Readonly<Verdict> {
  return Object.freeze({ ...v });
}

/** The steps a staking sequence walks. The room's button reads these. */
export type EscrowStep =
  | "guard"
  | "signer"
  | "allowance"
  | "approve"
  | "send"
  | "wait"
  | "done";

/**
 * The eighteen ways a side bet ends badly.
 *
 * Eighteen and no nineteenth, for `fill.ts`'s reason: a code with no copy is a
 * spinner nobody can clear. Every one of them lands the room in PTS-only.
 */
export type EscrowCode =
  | "SIGNER_REQUIRED"
  | "ESCROW_UNCONFIGURED"
  | "STAKE_TOO_SMALL"
  | "STAKE_TOO_LARGE"
  | "INSUFFICIENT_BALANCE"
  | "INSUFFICIENT_ALLOWANCE"
  | "DUEL_TAKEN"
  | "DUEL_NOT_OPEN"
  | "NOT_FULL"
  | "VERDICT_EXPIRED"
  | "ATTESTOR_DOWN"
  | "SEATS_UNBOUND"
  | "OPPONENT_NOT_JOINED"
  | "CHAIN_UNREACHABLE"
  | "REJECTED"
  | "CONTRACT_REVERT"
  | "NETWORK"
  | "RATE_LIMIT";

export interface EscrowError {
  code: EscrowCode;
  message: string;
  recovery: string;
  action: FillAction;
  detail?: string;
  throttled?: boolean;
  step: EscrowStep;
}

export type EscrowOutcome =
  | {
      status: "ok";
      /** The transaction that landed. Empty only for a step that sent none. */
      hash: string;
      explorer: string;
      /** True when the standing allowance already covered the stake and no
       *  approval transaction was sent — so the receipt can say "1 tx" or
       *  "2 tx" honestly. */
      approvalSkipped: boolean;
    }
  | { status: "cancelled" }
  | { status: "failed"; error: EscrowError };

/**
 * Every impure thing a staking sequence needs, as parameters.
 *
 * The same testability story as `FillDeps`: nothing below opens a socket, finds
 * a wallet or reaches a contract on its own. `test/stake.test.ts` drives all six
 * sequences and every code over a fake escrow with no chain in reach.
 */
export interface EscrowDeps {
  /** `"mock"` is refused before `getSigner` is called. */
  walletId?: string;
  /** The deployed `DuelEscrow`. Checked for shape before anything is sent. */
  escrow: string;
  /** Must be Base Sepolia (84532). */
  chainId?: number;
  /**
   * `WalletSource.getSigner()`'s contract, unchanged from `runFill`: `null`
   * means not connected, a **throw** means connected on the wrong chain. The
   * two have different recoveries, so they must stay distinguishable.
   */
  getSigner(): Promise<unknown | null>;
  /** The connected address and the `a` seat of a lock. */
  address(): Promise<string | null>;
  /** Native Base Sepolia ETH balance, in wei. */
  balanceOf(owner: string): Promise<bigint>;
  open(duelId: string, stake: bigint, invited: string): Promise<{ hash?: string } | null>;
  join(duelId: string, stake: bigint): Promise<{ hash?: string } | null>;
  settle(verdict: Readonly<Verdict>): Promise<{ hash?: string } | null>;
  refund(duelId: string): Promise<{ hash?: string } | null>;
  cancel(duelId: string): Promise<{ hash?: string } | null>;
  /** One duel, read back. `null` when the id has never been used. */
  duelOf(duelId: string): Promise<OnChainDuel | null>;
  now?(): number;
}

/** `/api/lock` and `/api/attest`, as this module consumes them. Separate from
 *  `EscrowDeps` because the referee is a server, not a chain, and the two fail
 *  in completely different ways. */
export interface RefereeDeps {
  /** `a`'s EIP-191 personal signature over `buildLockMessage(...)`. */
  signMessage(message: string): Promise<string>;
  postLock(body: {
    matchKey: string;
    picks: Readonly<Record<string, string>>;
    a: string;
    b: string | null;
    sig: string;
  }): Promise<{ ok: boolean; duelId?: string; commit?: string; reason?: string }>;
  postAttest(matchKey: string): Promise<{
    ok: boolean;
    duelId?: string;
    winner?: string;
    deadline?: number;
    signature?: string;
    reason?: string;
  }>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The error map
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The sentence that always follows a staking failure, in every one of the
 * eighteen cases.
 *
 * It is a constant rather than eighteen hand-written variations because it is
 * the single most important thing on the screen and it must not drift: the game
 * is not on chain, the chain is a side bet, and losing the side bet loses the
 * player nothing they were playing for.
 */
export const PTS_FALLBACK =
  "The duel goes ahead on the PTS pool exactly as it always has — nothing about the match, " +
  "your points, your XP or your rank depends on the chain.";

export const ESCROW_COPY: Record<
  EscrowCode,
  { message: string; recovery: string; action: FillAction }
> = {
  SIGNER_REQUIRED: {
    message: "No wallet can sign the stake.",
    recovery: `Connect a wallet on Base Sepolia to stake testnet ETH. ${PTS_FALLBACK}`,
    action: "connect",
  },
  ESCROW_UNCONFIGURED: {
    message: "No escrow contract is configured on this server.",
    recovery:
      "THETADUEL_ESCROW has to name a deployed DuelEscrow before anything can be staked — " +
      `a feature flag on its own is not allowed to move money. ${PTS_FALLBACK}`,
    action: "none",
  },
  STAKE_TOO_SMALL: {
    message: `The escrow will not take less than ${usd(MIN_STAKE_USDC)}.`,
    recovery: `MIN_STAKE is a constant in the contract, not a form rule. ${PTS_FALLBACK}`,
    action: "none",
  },
  STAKE_TOO_LARGE: {
    message: `The escrow will not take more than ${usd(MAX_STAKE_USDC)}.`,
    recovery: `MAX_STAKE is enforced by the contract, not only by the form. ${PTS_FALLBACK}`,
    action: "none",
  },
  INSUFFICIENT_BALANCE: {
    message: "The wallet does not hold enough testnet ETH on Base Sepolia.",
    recovery: `Fund it from a Base Sepolia faucet and try again. Nothing was spent. ${PTS_FALLBACK}`,
    action: "fund",
  },
  INSUFFICIENT_ALLOWANCE: {
    message: "The approval did not take.",
    recovery:
      "Press the side bet again — the approval is re-sent for the exact stake, never an " +
      `unlimited one. ${PTS_FALLBACK}`,
    action: "retry",
  },
  DUEL_TAKEN: {
    message: "That duel id is already on chain.",
    recovery:
      "Someone opened this room's id first. Nothing was spent, and no stake of yours is " +
      `reachable by them — it is one room denied, not money moved. ${PTS_FALLBACK}`,
    action: "none",
  },
  DUEL_NOT_OPEN: {
    message: "The other seat is gone.",
    recovery:
      "The duel was cancelled or filled before this transaction landed. Nothing was spent. " +
      PTS_FALLBACK,
    action: "none",
  },
  NOT_FULL: {
    message: "This duel can no longer be settled.",
    recovery:
      `It was already settled, or a player pulled their stake back after the ${REFUND_TIMEOUT_HOURS}-hour ` +
      "timeout, which closes settlement for good. If you have a stake in it, refund it — " +
      "the escrow still holds your side.",
    action: "none",
  },
  VERDICT_EXPIRED: {
    message: "That verdict has expired.",
    recovery: "Ask for a fresh one and relay again. The stake is untouched and still claimable.",
    action: "retry",
  },
  ATTESTOR_DOWN: {
    message: "The referee did not sign a verdict.",
    recovery:
      `Your stake refunds automatically after ${REFUND_TIMEOUT_HOURS} hours — the escrow's timeout needs no ` +
      `server and no cooperation from the other player. ${PTS_FALLBACK}`,
    action: "retry",
  },
  SEATS_UNBOUND: {
    message: "The referee will not take this room's word for who is playing.",
    recovery:
      "With an escrow configured, a lock is checked against the escrow's own seats: `a` must be " +
      "the address that opened the duel and `b` the address that joined it, in that order. " +
      `This lock did not match, so no verdict will be signed and both stakes refund after the ${REFUND_TIMEOUT_HOURS}-hour ` +
      `timeout. ${PTS_FALLBACK}`,
    action: "none",
  },
  OPPONENT_NOT_JOINED: {
    message: "The other seat has not been paid for yet.",
    recovery:
      "A lock can only be committed once the join transaction has landed — pinning it earlier " +
      "would name an opponent the chain has never seen and leave the duel permanently " +
      `unsettleable. The stake is safe and refunds after ${REFUND_TIMEOUT_HOURS} hours if nobody joins. ${PTS_FALLBACK}`,
    action: "retry",
  },
  CHAIN_UNREACHABLE: {
    message: "The referee could not read the escrow.",
    recovery:
      "It refuses the lock rather than believing this browser — falling back to an unchecked " +
      "lock is exactly the hole the seat binding closes, and a throttled RPC is the easiest way " +
      `to provoke one. Try again; the stake refunds after ${REFUND_TIMEOUT_HOURS} hours regardless. ${PTS_FALLBACK}`,
    action: "retry",
  },
  REJECTED: {
    message: "You dismissed the wallet prompt.",
    recovery: `Nothing was spent. ${PTS_FALLBACK}`,
    action: "retry",
  },
  CONTRACT_REVERT: {
    message: "The escrow rejected the transaction.",
    recovery: `Beyond gas, nothing was spent. ${PTS_FALLBACK}`,
    action: "retry",
  },
  NETWORK: {
    message: "The call never completed.",
    recovery: `Check the connection and try the side bet again. ${PTS_FALLBACK}`,
    action: "retry",
  },
  RATE_LIMIT: {
    message: "The Base RPC is throttling.",
    recovery: `${ALCHEMY_HINT} ${PTS_FALLBACK}`,
    action: "retry",
  },
};

function detailOf(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 240 ? `${message.slice(0, 237)}…` : message;
}

/**
 * Anything thrown → one of the codes below.
 *
 * **Order matters.** The contract's own revert strings are tested first and
 * verbatim (`duel exists`, `not open`, `not full`, `verdict expired`,
 * `stake too small`), because they are unambiguous and because several of them
 * contain words — "stake", "open", "full" — that the generic buckets below
 * would otherwise swallow. Wallet rejection is tested next: ethers reports it as
 * `ACTION_REJECTED`, and left to the generic path a user changing their mind
 * would be told the contract reverted.
 */
export function classifyEscrowError(error: unknown, step: EscrowStep): EscrowError {
  const detail = detailOf(error);
  const code = (error as { code?: unknown })?.code;
  const text = `${String(code ?? "")} ${detail}`;
  const throttled = looksThrottled(error);

  const at = (c: EscrowCode, over?: Partial<EscrowError>): EscrowError => ({
    code: c,
    ...ESCROW_COPY[c],
    detail,
    step,
    ...(throttled ? { throttled: true } : {}),
    ...over,
  });

  // The contract's own words, first and exactly.
  if (/duel exists/i.test(text)) return at("DUEL_TAKEN");
  if (/not open|cannot join own duel|not invited/i.test(text)) return at("DUEL_NOT_OPEN");
  if (/not full|not refundable|already refunded|winner not a player/i.test(text))
    return at("NOT_FULL");
  if (/verdict expired/i.test(text)) return at("VERDICT_EXPIRED");
  if (/stake too small/i.test(text)) return at("STAKE_TOO_SMALL");
  if (/stake too large/i.test(text)) return at("STAKE_TOO_LARGE");
  if (/bad attestor signature|malleable signature|invalid signature|bad signature/i.test(text))
    return at("CONTRACT_REVERT");

  // A human changing their mind is not a fault.
  if (/ACTION_REJECTED|user (rejected|denied)|rejected the request|4001/i.test(text))
    return at("REJECTED");

  if (/SIGNER_REQUIRED|no signer|signer is required|unknown account/i.test(text))
    return at("SIGNER_REQUIRED");

  // Throttling before the generic network bucket, and before the revert
  // default: `CALL_EXCEPTION` with no revert data is a throttle wearing a
  // revert's clothes, and the two recoveries are completely different.
  if (throttled && !/execution reverted/i.test(text)) return at("RATE_LIMIT");

  if (/insufficient allowance|allowance|transfer(From)? failed/i.test(text))
    return at("INSUFFICIENT_ALLOWANCE");
  if (/insufficient (funds|balance)|exceeds balance|transfer amount exceeds/i.test(text))
    return at("INSUFFICIENT_BALANCE");
  if (/NETWORK_ERROR|TIMEOUT|ECONNRESET|ENOTFOUND|fetch failed|network|timeout/i.test(text))
    return at("NETWORK");

  return at("CONTRACT_REVERT");
}

/** A code raised here rather than caught from below. */
function raise(code: EscrowCode, step: EscrowStep, over?: Partial<EscrowError>): EscrowOutcome {
  return { status: "failed", error: { code, ...ESCROW_COPY[code], step, ...over } };
}

const receiptOf = (r: { hash?: string } | null | undefined): string => r?.hash ?? "";

const outcome = (hash: string, approvalSkipped: boolean, chainId: number = BASE_SEPOLIA_CHAIN_ID): EscrowOutcome => ({
  status: "ok",
  hash,
  explorer: baseExplorerTx(chainId, hash),
  approvalSkipped,
});

export type OnEscrowStep = (step: EscrowStep, info?: { hash?: string; amount?: bigint }) => void;

// ─────────────────────────────────────────────────────────────────────────────
// The shared preamble: guard → signer → exact allowance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Everything `open` and `join` do before they differ, which is nearly all of it.
 *
 * Returns either a `EscrowOutcome` (the sequence ended here, badly) or the two
 * facts the caller needs: the connected address and whether an approval
 * transaction had to be sent.
 */
async function stakePreamble(
  stake: bigint,
  deps: EscrowDeps,
  onStep: OnEscrowStep,
): Promise<{ failed: EscrowOutcome } | { address: string; approvalSkipped: boolean }> {
  // ── guard ──────────────────────────────────────────────────────────────────
  // Nothing above this line touches `deps`. The stake floor and the escrow's
  // shape are checked before a wallet is asked for anything, which is what makes
  // "the mock never approves" a property of the code rather than of the UI.
  onStep("guard");
  if (!isAddress(deps.escrow)) return { failed: raise("ESCROW_UNCONFIGURED", "guard") };
  if ((deps.chainId ?? BASE_SEPOLIA_CHAIN_ID) !== BASE_SEPOLIA_CHAIN_ID) {
    return {
      failed: raise("SIGNER_REQUIRED", "guard", {
        message: "The stake is restricted to Base Sepolia.",
        recovery: `Switch to Base Sepolia (84532). ${PTS_FALLBACK}`,
        action: "switch",
      }),
    };
  }
  if (typeof stake !== "bigint" || stake < MIN_STAKE_USDC)
    return { failed: raise("STAKE_TOO_SMALL", "guard") };
  if (stake > MAX_STAKE_WEI)
    return { failed: raise("STAKE_TOO_LARGE", "guard") };

  // ── signer ─────────────────────────────────────────────────────────────────
  onStep("signer");
  if (deps.walletId === "mock") {
    return {
      failed: raise("SIGNER_REQUIRED", "signer", {
        message: "The mock wallet cannot stake — and must not.",
        recovery:
          "Install a browser wallet, or set WALLETCONNECT_PROJECT_ID, and reload. The mock is " +
          `the fallback that keeps the app playable with no wallet at all. ${PTS_FALLBACK}`,
        action: "connect",
      }),
    };
  }

  let signer: unknown | null;
  try {
    signer = await deps.getSigner();
  } catch (error) {
    // Connected, wrong chain — `getSigner` throws rather than returning `null`
    // for exactly this case, so the two recoveries stay distinguishable.
    return {
      failed: {
        status: "failed",
        error: {
          ...classifyEscrowError(error, "signer"),
          code: "SIGNER_REQUIRED",
          message: "The wallet is not on Base.",
          recovery: `Switch the wallet to ${
            baseNetworkByChainId(deps.chainId ?? BASE_SEPOLIA_CHAIN_ID)?.name ?? "Base Sepolia"
          } (${deps.chainId ?? BASE_SEPOLIA_CHAIN_ID}) and try again. ${PTS_FALLBACK}`,
          action: "switch",
        },
      },
    };
  }
  if (!signer) return { failed: raise("SIGNER_REQUIRED", "signer") };

  let address: string | null;
  try {
    address = await deps.address();
  } catch (error) {
    return { failed: { status: "failed", error: classifyEscrowError(error, "signer") } };
  }
  if (!isAddress(address)) return { failed: raise("SIGNER_REQUIRED", "signer") };

  // ── native balance ─────────────────────────────────────────────────────────
  onStep("allowance", { amount: stake });
  try {
    const balance = await deps.balanceOf(address);
    if (balance < stake) return { failed: raise("INSUFFICIENT_BALANCE", "allowance") };
  } catch (error) {
    return { failed: { status: "failed", error: classifyEscrowError(error, "allowance") } };
  }

  // Native ETH needs no ERC-20 approval, so staking is always one transaction.
  return { address, approvalSkipped: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// The five sequences
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Open a duel and lock the first stake.
 *
 * **This never throws.** Every exit is an `EscrowOutcome`, because a rejected
 * promise here is a room that never leaves "staking" on a screen someone is
 * presenting from — and, worse, a room that never falls back to the PTS game.
 *
 *  1. `guard`     — stake floor and escrow shape, before any dep is touched.
 *  2. `signer`    — mock refused, `null` → connect, throw → wrong chain.
 *  3. `allowance` — balance, then the standing allowance.
 *  4. `approve`   — **exactly** the stake, and only if short.
 *  5. `send`      — `open(duelId, stake, invited)`.
 *  6. `done`      — hash + BaseScan.
 *
 * `invited` is the zero address by default: the room link is what invites the
 * other player, and naming an address the app does not yet know would lock the
 * seat against them. Review finding 6-1 is the standing caveat — a predictable
 * duel id can be squatted, which is a denial of service on one room and never a
 * path to anyone's money; the mitigation is a per-room nonce in the match key,
 * which `parseMatchKey` in `src/server/attest.ts` already accepts.
 */
export async function openDuel(
  duelId: string,
  stake: bigint,
  deps: EscrowDeps,
  onStep: OnEscrowStep = () => {},
  invited: string = ZERO_ADDRESS,
): Promise<EscrowOutcome> {
  if (!BYTES32_RE.test(duelId)) return raise("ESCROW_UNCONFIGURED", "guard");
  const pre = await stakePreamble(stake, deps, onStep);
  if ("failed" in pre) return pre.failed;

  onStep("send", { amount: stake });
  try {
    const receipt = await deps.open(duelId, stake, isAddress(invited) ? invited : ZERO_ADDRESS);
    const hash = receiptOf(receipt);
    onStep("done", { hash });
    return outcome(hash, pre.approvalSkipped, deps.chainId);
  } catch (error) {
    return { status: "failed", error: classifyEscrowError(error, "send") };
  }
}

/** Match an open duel's stake. Identical preamble; `join` takes no amount, so
 *  the stake is read off the duel and passed here only to size the approval. */
export async function joinDuel(
  duelId: string,
  stake: bigint,
  deps: EscrowDeps,
  onStep: OnEscrowStep = () => {},
): Promise<EscrowOutcome> {
  if (!BYTES32_RE.test(duelId)) return raise("ESCROW_UNCONFIGURED", "guard");
  const pre = await stakePreamble(stake, deps, onStep);
  if ("failed" in pre) return pre.failed;

  onStep("send", { amount: stake });
  try {
    const receipt = await deps.join(duelId, stake);
    const hash = receiptOf(receipt);
    onStep("done", { hash });
    return outcome(hash, pre.approvalSkipped, deps.chainId);
  } catch (error) {
    return { status: "failed", error: classifyEscrowError(error, "send") };
  }
}

/**
 * Relay the attestor's verdict and be paid.
 *
 * `settle` is **permissionless** — the signature is the authority, not the
 * caller — so the winner never waits on the server to pay gas. No approval is
 * involved: the escrow already holds both stakes.
 *
 * The verdict is frozen on arrival. It is an EIP-712 signature over
 * `(duelId, winner, deadline)`, and a "helpful" normalisation of any of the
 * three produces a digest that recovers to a stranger.
 *
 * **Timing, per review finding 4-1.** `settle` has no timeout of its own; it is
 * closed by the first `refund`. So a winner who waits past the escrow's six
 * hours can be forced into a draw by a loser who refunds first — the winner
 * loses the 0.92 × stake profit, nobody's principal moves, and no third party
 * gains. Every caller of this function must have already told the player to
 * claim within six hours.
 */
export async function settleDuel(
  verdict: Verdict,
  deps: EscrowDeps,
  onStep: OnEscrowStep = () => {},
): Promise<EscrowOutcome> {
  onStep("guard");
  if (!isAddress(deps.escrow)) return raise("ESCROW_UNCONFIGURED", "guard");
  if (!BYTES32_RE.test(verdict.duelId) || !isAddress(verdict.winner) || !verdict.signature)
    return raise("ATTESTOR_DOWN", "guard");

  const now = deps.now ?? (() => Date.now());
  if (verdict.deadline * 1000 <= now()) return raise("VERDICT_EXPIRED", "guard");

  onStep("signer");
  if (deps.walletId === "mock") return raise("SIGNER_REQUIRED", "signer");
  let signer: unknown | null;
  try {
    signer = await deps.getSigner();
  } catch (error) {
    return { status: "failed", error: classifyEscrowError(error, "signer") };
  }
  if (!signer) return raise("SIGNER_REQUIRED", "signer");

  const frozen = freezeVerdict(verdict);
  onStep("send");
  try {
    const receipt = await deps.settle(frozen);
    const hash = receiptOf(receipt);
    onStep("done", { hash });
    return outcome(hash, true, deps.chainId);
  } catch (error) {
    return { status: "failed", error: classifyEscrowError(error, "send") };
  }
}

/**
 * Pull your own stake back after the timeout.
 *
 * The escape hatch that makes the trust model survivable: no signature, no
 * server, no cooperation from the other player. Each player withdraws their own
 * stake exactly once, and no rake is taken on a refund.
 */
export async function refundDuel(
  duelId: string,
  deps: EscrowDeps,
  onStep: OnEscrowStep = () => {},
): Promise<EscrowOutcome> {
  return sendSimple(duelId, deps, onStep, (id) => deps.refund(id));
}

/** Withdraw from a duel nobody joined. Opener only, `OPEN` only. */
export async function cancelDuel(
  duelId: string,
  deps: EscrowDeps,
  onStep: OnEscrowStep = () => {},
): Promise<EscrowOutcome> {
  return sendSimple(duelId, deps, onStep, (id) => deps.cancel(id));
}

/** `refund` and `cancel` differ only in which contract call they make: no
 *  approval, no amount, one guard and one signer check. */
async function sendSimple(
  duelId: string,
  deps: EscrowDeps,
  onStep: OnEscrowStep,
  call: (id: string) => Promise<{ hash?: string } | null>,
): Promise<EscrowOutcome> {
  onStep("guard");
  if (!isAddress(deps.escrow)) return raise("ESCROW_UNCONFIGURED", "guard");
  if (!BYTES32_RE.test(duelId)) return raise("ESCROW_UNCONFIGURED", "guard");

  onStep("signer");
  if (deps.walletId === "mock") return raise("SIGNER_REQUIRED", "signer");
  let signer: unknown | null;
  try {
    signer = await deps.getSigner();
  } catch (error) {
    return { status: "failed", error: classifyEscrowError(error, "signer") };
  }
  if (!signer) return raise("SIGNER_REQUIRED", "signer");

  onStep("send");
  try {
    const receipt = await call(duelId);
    const hash = receiptOf(receipt);
    onStep("done", { hash });
    return outcome(hash, true, deps.chainId);
  } catch (error) {
    return { status: "failed", error: classifyEscrowError(error, "send") };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The referee, over HTTP
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `canonicalPicks`, transcribed from `src/server/attest.ts:359-364`.
 *
 * Transcribed rather than imported, deliberately and for the same reason the
 * adversarial review transcribed the EIP-712 domain instead of importing it:
 * `src/server/attest.ts` is a **server** module — it imports `ethers.Wallet` and
 * reads `ATTESTOR_PRIVATE_KEY` — and pulling it into the browser bundle to reuse
 * two pure string functions would drag the referee's whole module graph into the
 * client. `test/stake.test.ts` cross-checks these two functions against the
 * server's own, so drift in either file fails a test rather than a payment.
 */
export function canonicalPicks(picks: Readonly<Record<string, string>>): string {
  const sorted = Object.keys(picks).sort();
  const out: Record<string, string> = {};
  for (const k of sorted) out[k] = picks[k]!;
  return JSON.stringify(out);
}

/**
 * The exact string seat `a` signs to authorise a lock — `lockMessage()` in
 * `src/server/attest.ts:410-423`, byte for byte.
 *
 *     THETADUEL_LOCK_V1
 *     matchKey:kz-semis:424242
 *     a:0x2222…
 *     b:0x3333…            (or the zero address for an open seat)
 *     picks:{"AMD":"safe-bull",…}
 *
 * Five `\n`-joined lines, no trailing newline. Addresses must arrive already
 * EIP-55 checksummed — the caller has a signer and therefore has `getAddress`;
 * this function will not silently normalise, because a normalisation that
 * disagreed with the server's would produce a signature that verifies to a
 * stranger and a lock the server refuses.
 */
export const LOCK_MESSAGE_PREFIX = "THETADUEL_LOCK_V1";

export function buildLockMessage(
  matchKey: string,
  a: string,
  b: string | null,
  picks: Readonly<Record<string, string>>,
): string {
  return [
    LOCK_MESSAGE_PREFIX,
    `matchKey:${matchKey}`,
    `a:${a}`,
    `b:${b ?? ZERO_ADDRESS}`,
    `picks:${canonicalPicks(picks)}`,
  ].join("\n");
}

export type LockResult =
  | { ok: true; duelId: string; commit: string }
  | { ok: false; error: EscrowError };

/**
 * `/api/lock`'s refusal strings → one of this module's codes.
 *
 * Transcribed from the disposition table in `src/server/attest.ts` (the module
 * docstring, point 3). Every one of them is a *closed* failure: the referee will
 * not sign, so no verdict exists, so the escrow's six-hour timeout is what
 * returns the money. The copy for each says so.
 */
export function classifyLockRefusal(reason: string): EscrowCode {
  const text = reason.toLowerCase();
  if (text.includes("has not joined")) return "OPPONENT_NOT_JOINED";
  if (
    text.includes("not a seat") ||
    text.includes("not the on-chain seat") ||
    text.includes("seats not on chain") ||
    text.includes("closed on chain")
  )
    return "SEATS_UNBOUND";
  if (text.includes("chain unreachable") || text.includes("bad chain response"))
    return "CHAIN_UNREACHABLE";
  return "ATTESTOR_DOWN";
}

/**
 * Commit the slip, signed — **as the on-chain opener, after the joiner has
 * paid**.
 *
 * Commit-then-derive is the settlement design: the verdict is not a pure
 * function of `(lobby, seed)` — your slip is whatever you picked — so the picks
 * have to be pinned *before* the tape can be watched, and first-write-wins is
 * what stops a losing player re-locking a winning slip afterwards.
 *
 * ## The seat rules this function enforces before it sends anything
 *
 * `src/server/seats.ts` landed the real fix for review finding X-1: with an
 * escrow configured, `/api/lock` reads the escrow's `duels` getter and
 * **compares** the claimed seats to the chain rather than believing them. Three
 * consequences, and this function refuses locally rather than making the server
 * refuse remotely, because a refused lock consumes nothing but a round trip and
 * a *wrong* one wastes the player's one chance to pin their slip:
 *
 *  1. **Ordered, opener first.** `a` must be the address that called `open` and
 *     `b` the address that called `join`. An unordered comparison would close
 *     nothing — the whole attack is the counterparty swapping the seats, and
 *     `{b, a}` equals `{a, b}`.
 *  2. **Only after the join has landed.** A duel still `OPEN` is refused
 *     `"opponent has not joined on chain"`, deliberately: a lock pinned with no
 *     joiner would name an opponent the chain has never seen and would leave the
 *     duel permanently unsettleable. So `b` here must be a real, non-zero
 *     address read back off the contract — never `null`, never the zero address,
 *     and never this browser's guess.
 *  3. **The opener locks.** A joiner-posted lock is refused by design, so the
 *     caller must only reach this function from seat `a`.
 *
 * A failure is not fatal to the duel and is not even fatal to the money: an
 * unlocked duel simply never gets a verdict, and the escrow refunds both stakes
 * unconditionally after six hours.
 */
export async function commitLock(
  matchKey: string,
  a: string,
  b: string | null,
  picks: Readonly<Record<string, string>>,
  referee: RefereeDeps,
): Promise<LockResult> {
  const fail = (code: EscrowCode, over?: Partial<EscrowError>): LockResult => ({
    ok: false,
    error: { code, ...ESCROW_COPY[code], step: "send", ...over },
  });
  if (!isAddress(a)) return fail("SIGNER_REQUIRED");
  // Rule 2, locally: an unjoined duel has no `b` to name, and naming none is
  // the one mistake that cannot be retried out of.
  if (!isAddress(b) || b.toLowerCase() === ZERO_ADDRESS) return fail("OPPONENT_NOT_JOINED");
  if (a.toLowerCase() === b.toLowerCase()) return fail("SEATS_UNBOUND");
  try {
    const sig = await referee.signMessage(buildLockMessage(matchKey, a, b, picks));
    const body = await referee.postLock({ matchKey, picks, a, b, sig });
    if (!body.ok || !body.duelId) {
      const reason = body.reason ?? "lock refused";
      return fail(classifyLockRefusal(reason), { detail: reason });
    }
    return { ok: true, duelId: body.duelId, commit: body.commit ?? "" };
  } catch (error) {
    const classified = classifyEscrowError(error, "send");
    // A dismissed signature prompt is a decision, not a fault — but the money
    // consequence is the referee having nothing to sign, so the recovery copy
    // has to be the referee's.
    if (classified.code === "REJECTED") return { ok: false, error: classified };
    return fail("ATTESTOR_DOWN", { detail: classified.detail });
  }
}

export type VerdictResult =
  | { ok: true; verdict: Readonly<Verdict> }
  | { ok: false; error: EscrowError };

/**
 * Ask the referee who won.
 *
 * `POST /api/attest` takes a match key and **nothing else** — the server
 * re-derives the winner from the committed picks and the seed and signs that.
 * A `winner` in the request body is ignored by construction, which is the one
 * property that keeps the server from paying whoever asks.
 *
 * The returned verdict is frozen before it leaves this function.
 */
export async function requestVerdict(
  matchKey: string,
  referee: RefereeDeps,
): Promise<VerdictResult> {
  const fail = (code: EscrowCode, detail?: string): VerdictResult => ({
    ok: false,
    error: { code, ...ESCROW_COPY[code], step: "send", detail },
  });
  try {
    const body = await referee.postAttest(matchKey);
    if (!body.ok || !body.duelId || !body.winner || !body.signature || !body.deadline) {
      return fail("ATTESTOR_DOWN", body.reason ?? "no verdict");
    }
    return {
      ok: true,
      verdict: freezeVerdict({
        duelId: body.duelId,
        winner: body.winner,
        deadline: body.deadline,
        signature: body.signature,
      }),
    };
  } catch (error) {
    return fail("ATTESTOR_DOWN", detailOf(error));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The live adapter — the only place ethers and the ABI are named
// ─────────────────────────────────────────────────────────────────────────────

/** Human-readable ABI, transcribed from `contracts/DuelEscrow.sol`'s externals.
 *  `duels` is the public mapping's generated getter; its tuple order is the
 *  `Duel` struct's field order and must not be rearranged. */
export const ESCROW_ABI = DUEL_ESCROW_ABI;

/** Just the wallet seam staking needs, so this module does not import the whole
 *  `WalletSource` surface (and so a test can pass two functions). */
export interface StakeWallet {
  readonly id: string;
  getSigner(): Promise<unknown | null>;
}

/**
 * `keccak256(utf8Bytes(matchKey))` — the escrow's documented client rule
 * (`contracts/DuelEscrow.sol:89-91`), spelled `ethers.id`.
 *
 * Behind a dynamic import for `fill.ts`'s reason: **evaluation**, not bytes.
 * Nothing in ethers runs until an operator has set `THETADUEL_STAKE=on`, named
 * an escrow, and a player has pressed a side bet.
 */
export async function duelIdFor(matchKey: string): Promise<string> {
  const { id } = await import("ethers");
  return id(matchKey);
}

/**
 * `EscrowDeps` wired to the real contract, in the browser, next to the wallet.
 *
 * The contracts are built **lazily, after the signer arrives**, exactly as
 * `createLiveFillDeps` builds its client: a signer is step 2 of every sequence,
 * and there is nothing to construct before it.
 */
export function createLiveEscrowDeps(
  wallet: StakeWallet,
  escrow: string,
  chainId: number = BASE_SEPOLIA_CHAIN_ID,
): EscrowDeps {
  if (chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`DuelEscrow only supports Base Sepolia (${BASE_SEPOLIA_CHAIN_ID})`);
  }
  /** Set by `getSigner`; every later dep reads it. */
  let contract: Record<string, (...args: unknown[]) => Promise<unknown>> | null = null;
  let account: string | null = null;

  const need = () => {
    if (!contract) throw new Error("SIGNER_REQUIRED");
    return contract;
  };

  /** A transaction response → the mined receipt, or the response itself when a
   *  test double hands one back directly. `hash` is the same field on both. */
  const mined = async (tx: unknown): Promise<{ hash?: string } | null> => {
    const t = tx as { wait?: () => Promise<{ hash?: string } | null>; hash?: string } | null;
    if (t && typeof t.wait === "function") return (await t.wait()) ?? { hash: t.hash };
    return t;
  };

  let signerRef: unknown = null;

  const bindSigner = async (): Promise<unknown | null> => {
    const signer = await wallet.getSigner();
    if (!signer) return null;
    const { Contract } = await import("ethers");
    signerRef = signer;
    contract = new Contract(
      escrow,
      ESCROW_ABI as unknown as string[],
      signer as never,
    ) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
    account = await (signer as { getAddress(): Promise<string> }).getAddress();
    return signer;
  };

  return {
    walletId: wallet.id,
    escrow,
    chainId,

    async getSigner() {
      return bindSigner();
    },

    async address() {
      return account;
    },

    async balanceOf(owner) {
      const signer = signerRef as {
        provider?: { getBalance(address: string): Promise<bigint> };
      };
      if (!signer.provider) throw new Error("NETWORK_ERROR: signer has no provider");
      return signer.provider.getBalance(owner);
    },

    async open(duelId, stake) {
      return mined(await need().stake!(duelId, { value: stake }));
    },
    async join(duelId, stake) {
      return mined(await need().stake!(duelId, { value: stake }));
    },
    async settle(verdict) {
      return mined(
        await need().winStake!(verdict.duelId, verdict.winner, verdict.deadline, verdict.signature),
      );
    },
    async refund(duelId) {
      return mined(await need().refund!(duelId));
    },
    async cancel(duelId) {
      return mined(await need().cancel!(duelId));
    },

    async duelOf(duelId) {
      if (!contract && !(await bindSigner())) return null;
      const raw = (await need().duels!(duelId)) as unknown as readonly unknown[];
      const status = DUEL_STATUS[Number(raw[5])] ?? "NONE";
      if (status === "NONE") return null;
      return {
        status,
        a: String(raw[0]),
        b: String(raw[1]),
        stake: BigInt(String(raw[3])),
        fullAt: Number(raw[4]),
      };
    },
  };
}

/**
 * `RefereeDeps` over the two real routes.
 *
 * Both answer HTTP 200 with a typed envelope whatever happens (`attest.ts`'s
 * contract), so `ok` is the only decision — but a *missing* server is still a
 * thrown fetch, and that is what the callers above turn into `ATTESTOR_DOWN`
 * and the six-hour refund copy.
 */
export function createLiveRefereeDeps(signMessage: (m: string) => Promise<string>): RefereeDeps {
  const post = async (path: string, body: unknown) => {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  };
  return {
    signMessage,
    async postLock(body) {
      return (await post("/api/lock", body)) as never;
    },
    async postAttest(matchKey) {
      return (await post("/api/attest", { matchKey })) as never;
    },
  };
}
