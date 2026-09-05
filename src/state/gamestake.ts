import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Contract, JsonRpcProvider, getAddress, parseEther } from "ethers";
import { BASE_SEPOLIA } from "../data/base-network.ts";
import type { WalletSource } from "../data/wallet.ts";
import {
  GAME_STAKE_ABI,
  GAME_STAKE_ADDRESS,
  ZERO_ADDRESS,
  gameStakeBlocker,
  seatsTaken,
  type MatchState,
} from "../utils/gamestake.ts";

/**
 * One duel's pot, on chain.
 *
 * This is the whole of what `/testing` learned to do, lifted out of the console
 * so a real screen can use it: resolve the deployed address, read the match,
 * keep reading it, and offer the two writes with the contract's own reasons
 * attached. The console keeps its own layout; what moves is the behaviour.
 *
 * ## Why a hook and not a service
 *
 * Both halves of a duel are watching state only the OTHER player can change —
 * seat two arrives when the opponent's wallet confirms, in a different browser,
 * with nothing to tell this one. So the read has to be a subscription with a
 * bound on staleness, and that is a component's lifetime, not a module's.
 *
 * ## Failure disposition
 *
 * Everything degrades to "cannot act, and here is why" rather than to a throw.
 * A dead RPC, an unconfigured address and a wallet on the wrong chain all end
 * in a `blockers` string, because the alternative — a live-looking button over
 * a broken read — is how someone signs a transaction that was never going to
 * work.
 */

/** How often the pot is re-read while a screen is watching it. */
const POLL_MS = 12_000;

export interface GameStakePot {
  /** The contract this hook is bound to, once known. */
  address: string;
  /** The match being watched, or `null` when there is nothing to watch yet. */
  matchId: string | null;
  /** The on-chain row, or `null` before the first successful read. */
  state: MatchState | null;
  /** Everything staked by both seats. `0n` until read. */
  pool: bigint;
  /** 0, 1 or 2. */
  seats: number;
  /** True once the pot has been paid out. */
  paid: boolean;
  /** True when the connected wallet holds one of the two on-chain seats. */
  seated: boolean;
  /** A write is in flight. */
  busy: boolean;
  /** The last write's hash, while it matters. */
  txHash: string | null;
  /** The last failure worth showing, or `null`. */
  error: string | null;
  /** Why each write cannot run, or `null` when it can. */
  blockers: { stake: string | null; pay: string | null };
  /** Put ETH in. `amountEth` is human text — "0.001". */
  stake(amountEth: string): Promise<void>;
  /** Send the whole pot to `winner`, which must be a seated address. */
  payWinner(winner: string): Promise<void>;
  /** Read the row again now. */
  refresh(): void;
}

function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { shortMessage?: unknown; reason?: unknown; message?: unknown };
    for (const value of [e.shortMessage, e.reason, e.message]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return "The request failed. Check the network, the amount and your wallet, then retry.";
}

export function useGameStake(matchId: string | null, wallet: WalletSource): GameStakePot {
  const [address, setAddress] = useState<string>(GAME_STAKE_ADDRESS);
  const [state, setState] = useState<MatchState | null>(null);
  const [busy, setBusy] = useState(false);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  /**
   * The address comes from the server, so a redeploy is a restart rather than a
   * rebuild. The compiled-in constant is the fallback, not the source of truth.
   */
  useEffect(() => {
    let live = true;
    void fetch("/api/config")
      .then((r) => r.json())
      .then((body: { gameStake?: unknown }) => {
        if (!live) return;
        if (typeof body.gameStake === "string" && body.gameStake.trim()) {
          setAddress(body.gameStake.trim());
        }
      })
      .catch(() => {
        /* keep the fallback */
      });
    return () => {
      live = false;
    };
  }, []);

  /**
   * Re-read on a bound, not on an event.
   *
   * Seat two is written by the opponent's wallet in another browser. There is no
   * message that reaches this client, so the only honest guarantee is that the
   * row on screen is at most one interval old.
   */
  useEffect(() => {
    const timer = setInterval(() => setTick((n) => n + 1), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  /** Latest match id, so a resolved read can tell whether it is still wanted. */
  const wanted = useRef<string | null>(matchId);
  wanted.current = matchId;

  useEffect(() => {
    if (!matchId || !address) {
      setState(null);
      return;
    }
    let live = true;
    void (async () => {
      try {
        const provider = new JsonRpcProvider(BASE_SEPOLIA.rpcUrl, BASE_SEPOLIA.chainId, {
          staticNetwork: true,
        });
        const contract = new Contract(address, GAME_STAKE_ABI, provider);
        const row = await contract.getFunction("matches")(matchId);
        // A read that resolved after the screen moved on must not overwrite the
        // row for a different duel.
        if (!live || wanted.current !== matchId) return;
        setState({
          player1: String(row.player1 ?? row[0]),
          player2: String(row.player2 ?? row[1]),
          pool: BigInt(row.pool ?? row[2]),
          paid: Boolean(row.paid ?? row[3]),
        });
      } catch (e) {
        if (!live) return;
        // A failed read leaves the last good row in place and says why; it must
        // not blank the pot, because a blank pot reads as "nothing staked".
        setError(messageOf(e));
      }
    })();
    return () => {
      live = false;
    };
  }, [address, matchId, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const me = wallet.identity.address;
  const seated = useMemo(() => {
    if (!state || !me) return false;
    const mine = me.toLowerCase();
    return state.player1.toLowerCase() === mine || state.player2.toLowerCase() === mine;
  }, [state, me]);

  const walletBlocker =
    wallet.id === "mock"
      ? "Connect a real wallet — the mock wallet cannot sign."
      : !wallet.identity.connected
        ? "Connect your wallet to stake."
        : wallet.identity.chainId !== BASE_SEPOLIA.chainId
          ? `Switch to Base Sepolia (84532). Current chain: ${wallet.identity.chainId ?? "unknown"}.`
          : !matchId
            ? "This duel has no match id yet."
            : null;

  const blockers = useMemo(
    () => ({
      stake: walletBlocker ?? gameStakeBlocker("stake", state, me),
      pay: walletBlocker ?? gameStakeBlocker("winnerTakesAll", state, me),
    }),
    [walletBlocker, state, me],
  );

  const write = useCallback(
    async (run: (contract: Contract) => Promise<{ hash: string; wait(): Promise<unknown> }>) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      setTxHash(null);
      try {
        const signer = await wallet.getSigner();
        if (!signer) throw new Error("Connect a real wallet first.");
        const contract = new Contract(address, GAME_STAKE_ABI, signer);
        const tx = await run(contract);
        setTxHash(tx.hash);
        await tx.wait();
        refresh();
      } catch (e) {
        setError(messageOf(e));
      } finally {
        setBusy(false);
      }
    },
    [address, busy, refresh, wallet],
  );

  const stake = useCallback(
    async (amountEth: string) => {
      if (!matchId) return;
      let value: bigint;
      try {
        value = parseEther(amountEth.trim());
      } catch {
        setError("Enter a valid ETH amount.");
        return;
      }
      if (value <= 0n) {
        setError("Stake must be more than zero.");
        return;
      }
      await write((c) => c.getFunction("stake")(matchId, { value }));
    },
    [matchId, write],
  );

  const payWinner = useCallback(
    async (winner: string) => {
      if (!matchId) return;
      let checksummed: string;
      try {
        checksummed = getAddress(winner.trim());
      } catch {
        setError("The winner is not a valid address.");
        return;
      }
      await write((c) => c.getFunction("winnerTakesAll")(matchId, checksummed));
    },
    [matchId, write],
  );

  return {
    address,
    matchId,
    state,
    pool: state?.pool ?? 0n,
    seats: seatsTaken(state),
    paid: state?.paid ?? false,
    seated,
    busy,
    txHash,
    error,
    blockers,
    stake,
    payWinner,
    refresh,
  };
}

/** Re-exported so a screen needs one import to render an empty seat. */
export { ZERO_ADDRESS };
