import { id, isAddress } from "ethers";

/**
 * `GameStake` — the two-function pot. Deployed on Base Sepolia.
 *
 * Verified live at this address on 2026-09-05: the dispatcher carries exactly
 * three selectors — `0xc0d64a87 stake(bytes32)`, `0x5f086696
 * winnerTakesAll(bytes32,address)` and `0x9fe9ada3 matches(bytes32)` — and its
 * revert strings ("no stake", "need 2 players") are this project's source
 * verbatim. Its runtime is 3404 bytes against the 1349 that
 * `contracts/out/GameStake.json` produces, which is the optimizer being off in
 * Remix rather than a different contract.
 */
export const GAME_STAKE_ADDRESS = "0xcd3dAC24e99E1Cb710B8243468e6D118215f3eAC" as const;

export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;
export const BASE_SEPOLIA_EXPLORER = "https://sepolia.basescan.org" as const;

/**
 * The real ABI of the deployed contract, in ethers' human-readable form.
 *
 * This is NOT the DuelEscrow ABI. They share a `stake(bytes32)` selector and
 * nothing else: `GameStake` has no attestor, no signature, no timeout, no
 * refund and no cancel, so handing DuelEscrow's ABI to this address produces a
 * contract object whose every other method reverts into the fallback.
 */
export const GAME_STAKE_ABI = [
  "function stake(bytes32 matchId) payable",
  "function winnerTakesAll(bytes32 matchId, address winner)",
  "function matches(bytes32 matchId) view returns (address player1, address player2, uint256 pool, bool paid)",
  "event Staked(bytes32 indexed matchId, address indexed player, uint256 amount, uint256 pool)",
  "event WinnerPaid(bytes32 indexed matchId, address indexed winner, uint256 amount)",
] as const;

/** One row of the `matches` mapping. */
export interface MatchState {
  player1: string;
  player2: string;
  pool: bigint;
  paid: boolean;
}

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Accept an exact bytes32, or hash a human-readable key into one. */
export function matchIdFromInput(input: string): string {
  const value = input.trim();
  if (!value) throw new Error("Enter a match key or bytes32 id.");
  if (/^0x[0-9a-fA-F]{64}$/.test(value)) return value;
  return id(value);
}

export function isGameStakeAddress(address: string): boolean {
  return isAddress(address.trim());
}

function sameAddress(left: string | null, right: string): boolean {
  if (!left) return false;
  return left.toLowerCase() === right.toLowerCase();
}

/** How many seats are taken. */
export function seatsTaken(state: MatchState | null): number {
  if (!state) return 0;
  if (state.player2 !== ZERO_ADDRESS) return 2;
  return state.player1 === ZERO_ADDRESS ? 0 : 1;
}

/**
 * Why a call would revert, or `null` if the contract would accept it.
 *
 * A transcription of the `require`s in contracts/GameStake.sol, and advisory in
 * exactly the same way the duel console's gate is: an unread match (`null`)
 * blocks nothing, because the chain is the authority and a client that guesses
 * wrong must guess in the direction of letting the transaction through.
 */
export function gameStakeBlocker(
  method: "stake" | "winnerTakesAll",
  state: MatchState | null,
  caller: string | null,
  winner?: string | null,
): string | null {
  if (!state) return null;

  const isP1 = sameAddress(caller, state.player1);
  const isP2 = sameAddress(caller, state.player2);
  const seats = seatsTaken(state);

  if (method === "stake") {
    if (state.paid) return "This match already paid out. Use a new match key.";
    if (seats === 2 && !isP1 && !isP2) {
      return "Both seats are taken. Only the two seated wallets can add to this pot.";
    }
    return null;
  }

  // winnerTakesAll
  if (state.paid) return "This match already paid out.";
  if (seats < 2) return "Both players must stake before the pot can be paid out.";
  if (winner != null && winner.trim()) {
    if (!isAddress(winner.trim())) return "Enter a valid winner address.";
    if (!sameAddress(winner.trim(), state.player1) && !sameAddress(winner.trim(), state.player2)) {
      return "The winner must be one of the two wallets that staked in this match.";
    }
  }
  return null;
}
