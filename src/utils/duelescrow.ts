import { formatEther, id, isAddress } from "ethers";

/** Verified DuelEscrow deployment on Base Sepolia. */
export const BASE_SEPOLIA_DUEL_ESCROW_ADDRESS = "0xc683A484FC42eD99c48ad8E19F841388536deB3E" as const;

export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;
export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org" as const;

/**
 * Remix deployment ABI in equivalent human-readable form. Ethers accepts
 * this form directly and it keeps the browser bundle free of bytecode and
 * compiler metadata.
 */
export const DUEL_ESCROW_ABI = [
  "constructor(address attestor_)",
  "fallback() payable",
  "receive() payable",
  "function BASE_SEPOLIA_CHAIN_ID() view returns (uint256)",
  "function DOMAIN_SEPARATOR() view returns (bytes32)",
  "function MIN_STAKE() view returns (uint128)",
  "function TIMEOUT() view returns (uint64)",
  "function VERDICT_TYPEHASH() view returns (bytes32)",
  "function attestor() view returns (address)",
  "function duels(bytes32 duelId) view returns (address a, address b, address invited, uint128 stake, uint64 fullAt, uint8 status, bool aWithdrawn, bool bWithdrawn)",
  "function pool(bytes32 duelId) view returns (uint256)",
  "function stake(bytes32 duelId) payable",
  "function winStake(bytes32 duelId, address winner, uint64 deadline, bytes sig)",
  "function loseStake(bytes32 duelId)",
  "function refund(bytes32 duelId)",
  "function cancel(bytes32 duelId)",
  "event Staked(bytes32 indexed duelId, address indexed player, uint256 amount, uint8 seat)",
  "event DuelSettled(bytes32 indexed duelId, address indexed winner, uint256 payout)",
  "event DuelForfeited(bytes32 indexed duelId, address indexed loser, address indexed winner, uint256 payout)",
  "event DuelRefunded(bytes32 indexed duelId, address indexed player, uint256 amount)",
  "event DuelCancelled(bytes32 indexed duelId, address indexed player, uint256 amount)",
] as const;

export const DUEL_STATUS = ["NONE", "OPEN", "FULL", "SETTLED", "REFUNDED"] as const;

export const DUEL_ESCROW_FUNCTIONS = [
  { name: "BASE_SEPOLIA_CHAIN_ID", kind: "read", control: "Network lock" },
  { name: "DOMAIN_SEPARATOR", kind: "read", control: "Contract facts" },
  { name: "MIN_STAKE", kind: "read", control: "Contract facts" },
  { name: "TIMEOUT", kind: "read", control: "Contract facts" },
  { name: "VERDICT_TYPEHASH", kind: "read", control: "Contract facts" },
  { name: "attestor", kind: "read", control: "Contract facts" },
  { name: "duels", kind: "read", control: "Duel lookup" },
  { name: "pool", kind: "read", control: "Duel pool" },
  { name: "stake", kind: "write", control: "Open or join" },
  { name: "winStake", kind: "write", control: "Winner takes all" },
  { name: "loseStake", kind: "write", control: "Forfeit to opponent" },
  { name: "refund", kind: "write", control: "Refund after timeout" },
  { name: "cancel", kind: "write", control: "Cancel open duel" },
] as const;

/** Accept an exact bytes32 or derive one from a human-readable test key. */
export function duelIdFromInput(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a duel key or bytes32 duel id.");
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  return id(value);
}

export function validContractAddress(address: string): boolean {
  return isAddress(address.trim());
}

/** `Status` in contracts/DuelEscrow.sol, by ordinal. */
export const STATUS_NONE = 0;
export const STATUS_OPEN = 1;
export const STATUS_FULL = 2;
export const STATUS_SETTLED = 3;
export const STATUS_REFUNDED = 4;

/** `TIMEOUT` — six hours, in seconds. */
export const DUEL_TIMEOUT_SECONDS = 21_600;

/** One row of the escrow's `duels` mapping, as the console reads it. */
export interface DuelState {
  a: string;
  b: string;
  stake: bigint;
  fullAt: bigint;
  status: number;
  aWithdrawn: boolean;
  bWithdrawn: boolean;
}

export type DuelWrite = "stake" | "winStake" | "loseStake" | "refund" | "cancel";

function sameAddress(left: string | null, right: string): boolean {
  if (!left) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/**
 * Why a write would revert, or `null` if the contract would accept it.
 *
 * This is a transcription of the `require`s in contracts/DuelEscrow.sol, and it
 * exists because a duel key is single-use through one lifecycle while the
 * console's key field is free text. Open a duel, cancel it, and the key is
 * permanently `REFUNDED`: `stake` then fails "duel not open", `cancel` the same,
 * `refund` fails "never filled" because a cancelled duel has `fullAt == 0`, and
 * both settlement paths fail "duel not full". Every button on the page is dead
 * and none of them can say why — the wallet cannot even estimate gas, so what
 * the user actually sees is a generic "this transaction may fail".
 *
 * Reading the state first turns that into a sentence. The check is advisory by
 * construction: it can only ever disable a button the chain would have rejected
 * anyway, so a stale or unavailable read must fall through to `null` and let the
 * contract remain the authority. Passing `duel: null` — no read yet, or a failed
 * one — therefore blocks nothing.
 *
 * `nowSeconds` is a parameter rather than a `Date.now()` so the timeout branch
 * is testable, and because the value that actually decides `refund` is the
 * block timestamp, which this cannot know.
 */
export function duelWriteBlocker(
  method: DuelWrite,
  duel: DuelState | null,
  caller: string | null,
  nowSeconds: number,
  intendedStakeWei?: bigint | null,
): string | null {
  if (!duel) return null;

  const isA = sameAddress(caller, duel.a);
  const isB = sameAddress(caller, duel.b);
  const seated = isA || isB;
  const spent =
    duel.status === STATUS_SETTLED || duel.status === STATUS_REFUNDED
      ? "This duel key is spent — its duel reached a terminal state and can never move again. Enter a new duel key."
      : null;

  if (method === "stake") {
    if (duel.status === STATUS_NONE) return null;
    if (duel.status === STATUS_OPEN) {
      if (isA) {
        return "You opened this duel. Seat two must be a different wallet, staking the exact same amount.";
      }
      // `require(msg.value == d.stake)` — the one revert this card's own copy
      // promises to prevent, and the only precondition that depends on a form
      // field rather than on chain state. Unknown amount gates nothing.
      if (intendedStakeWei != null && intendedStakeWei !== duel.stake) {
        return `Seat two must match the opener exactly: stake ${formatEther(duel.stake)} ETH, not ${formatEther(intendedStakeWei)}.`;
      }
      return null;
    }
    if (duel.status === STATUS_FULL) return "Both seats are taken. This duel is full.";
    return spent;
  }

  if (method === "cancel") {
    if (duel.status !== STATUS_OPEN) {
      return spent ?? "Cancel needs an open duel that nobody has joined yet.";
    }
    return isA ? null : "Only the wallet that opened the duel can cancel it.";
  }

  if (method === "winStake" || method === "loseStake") {
    if (duel.status !== STATUS_FULL) {
      return spent ?? "Settlement needs a full duel — both seats must have staked.";
    }
    if (method === "loseStake" && !seated) {
      return "Only a seated player can forfeit.";
    }
    return null;
  }

  // refund
  if (duel.status === STATUS_SETTLED) {
    return "This duel is already settled — the pool was paid out. Refund is the escape hatch for a duel that never settled.";
  }
  if (duel.status !== STATUS_FULL && duel.status !== STATUS_REFUNDED) {
    return "Refund needs a duel that filled. Cancel an unjoined duel instead.";
  }
  if (duel.fullAt === 0n) {
    return "This duel never filled, so there is nothing to refund. A cancelled duel already returned its stake.";
  }
  if (!seated) return "Only a seated player can claim a refund.";
  if ((isA && duel.aWithdrawn) || (isB && duel.bWithdrawn)) {
    return "This wallet has already withdrawn from this duel.";
  }
  const unlocksAt = Number(duel.fullAt) + DUEL_TIMEOUT_SECONDS;
  if (nowSeconds <= unlocksAt) {
    const minutes = Math.ceil((unlocksAt - nowSeconds) / 60);
    return `The six-hour timeout has not expired. Refund unlocks in about ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  }
  return null;
}

/**
 * The series the console defaults through, and how far it looks.
 *
 * A duel key is just a label. `duelIdFromInput` hashes it to the `bytes32`
 * `duelId` the contract keys its `duels` mapping by, so "thetaduel-test-1" and
 * its hash are the same duel — the text exists only so two people can agree on
 * one duel by saying a word to each other instead of a 64-character hash.
 *
 * The consequence, and the reason this constant exists: a key is not a form
 * field that resets. It names a permanent slot in contract storage, and that
 * slot moves NONE -> OPEN -> FULL -> SETTLED/REFUNDED and then never again.
 * Defaulting the console to a fixed key therefore works exactly once; every
 * later visit lands on a duel that has already finished.
 */
export const TEST_KEY_PREFIX = "thetaduel-test-";
export const TEST_KEY_SCAN = 12;

/**
 * Can a duel in this state still be opened or joined?
 *
 * `OPEN` counts, and that is the point rather than an oversight: the console
 * has to land BOTH players on the same key without them coordinating. If it
 * only accepted `NONE`, the moment player A opened a duel the key would stop
 * qualifying and player B's tab would skip past it to a fresh one, so the two
 * would sit in different duels forever.
 */
export function isKeyStartable(status: number): boolean {
  return status === STATUS_NONE || status === STATUS_OPEN;
}
