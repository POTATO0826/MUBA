import { describe, expect, test } from "bun:test";
import {
  BASE_CHAIN_ID,
  DEFAULT_STAKE_WEI,
  MIN_STAKE_WEI,
  cancelDuel,
  eth,
  joinDuel,
  openDuel,
  parseStakeEth,
  payoutOf,
  refundDuel,
  settleDuel,
  stakeUnavailableReason,
  stakingAvailable,
  type EscrowDeps,
  type EscrowOutcome,
  type EscrowStep,
} from "../src/desk/escrow.ts";

const ESCROW = "0x1111111111111111111111111111111111111111";
const PLAYER = "0x2222222222222222222222222222222222222222";
const WINNER = "0x3333333333333333333333333333333333333333";
const DUEL = `0x${"ab".repeat(32)}`;
const HASH = `0x${"cd".repeat(32)}`;

function errorCode(out: EscrowOutcome): string | null {
  return out.status === "failed" ? out.error.code : null;
}

function fake(overrides: Partial<EscrowDeps> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  const deps: EscrowDeps = {
    walletId: "injected",
    escrow: ESCROW,
    chainId: 84_532,
    async getSigner() { calls.push(["getSigner"]); return {}; },
    async address() { calls.push(["address"]); return PLAYER; },
    async balanceOf(owner) { calls.push(["balanceOf", owner]); return 10n ** 20n; },
    async open(id, amount, invited) { calls.push(["open", id, amount, invited]); return { hash: HASH }; },
    async join(id, amount) { calls.push(["join", id, amount]); return { hash: HASH }; },
    async settle(verdict) { calls.push(["settle", verdict]); return { hash: HASH }; },
    async refund(id) { calls.push(["refund", id]); return { hash: HASH }; },
    async cancel(id) { calls.push(["cancel", id]); return { hash: HASH }; },
    async duelOf() { return null; },
    now: () => 1_000_000,
    ...overrides,
  };
  const steps: EscrowStep[] = [];
  return { deps, calls, steps, onStep: (step: EscrowStep) => steps.push(step) };
}

describe("native Base Sepolia staking client", () => {
  test("uses 0.001 ETH as the exact default and minimum", () => {
    expect(BASE_CHAIN_ID).toBe(84_532);
    expect(MIN_STAKE_WEI).toBe(1_000_000_000_000_000n);
    expect(DEFAULT_STAKE_WEI).toBe(MIN_STAKE_WEI);
    expect(parseStakeEth("0.001")).toBe(MIN_STAKE_WEI);
    expect(parseStakeEth("0.001 ETH")).toBe(MIN_STAKE_WEI);
    expect(parseStakeEth("0.000999999999999999")).toBe(MIN_STAKE_WEI - 1n);
    expect(parseStakeEth("1.0000000000000000001")).toBeNull();
    expect(eth(MIN_STAKE_WEI)).toBe("0.001 ETH");
    expect(payoutOf(MIN_STAKE_WEI)).toBe(2_000_000_000_000_000n);
  });

  test("the feature only arms for a real wallet on chain 84532", () => {
    const config = { enabled: true, escrow: ESCROW, chainId: 84_532 };
    expect(stakingAvailable(config, "injected")).toBe(true);
    expect(stakingAvailable({ ...config, chainId: 8_453 }, "injected")).toBe(false);
    expect(stakingAvailable({ ...config, escrow: "" }, "injected")).toBe(false);
    expect(stakingAvailable(config, "mock")).toBe(false);
    expect(stakeUnavailableReason({ ...config, chainId: 8_453 }, "injected")).toContain(
      "only permits Base Sepolia",
    );
  });

  test("stake is one native-ETH transaction with no token approval", async () => {
    const f = fake();
    const out = await openDuel(DUEL, MIN_STAKE_WEI, f.deps, f.onStep);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.approvalSkipped).toBe(true);
    expect(out.explorer).toBe(`https://sepolia.basescan.org/tx/${HASH}`);
    expect(f.steps).toEqual(["guard", "signer", "allowance", "send", "done"]);
    expect(f.calls.map(([name]) => name)).toEqual(["getSigner", "address", "balanceOf", "open"]);
    expect(f.calls.find(([name]) => name === "open")?.[2]).toBe(MIN_STAKE_WEI);
  });

  test("any different wallet can take seat two by calling the same stake path", async () => {
    const f = fake();
    const out = await joinDuel(DUEL, MIN_STAKE_WEI, f.deps, f.onStep);
    expect(out.status).toBe("ok");
    expect(f.calls.map(([name]) => name)).toContain("join");
  });

  test("values below 0.001 ETH and non-Sepolia configs never touch a signer", async () => {
    const low = fake();
    expect(errorCode(await openDuel(DUEL, MIN_STAKE_WEI - 1n, low.deps, low.onStep)))
      .toBe("STAKE_TOO_SMALL");
    expect(low.calls).toEqual([]);

    const mainnet = fake({ chainId: 8_453 });
    expect(errorCode(await openDuel(DUEL, MIN_STAKE_WEI, mainnet.deps, mainnet.onStep)))
      .toBe("SIGNER_REQUIRED");
    expect(mainnet.calls).toEqual([]);
  });

  test("insufficient native test ETH stops before the transaction", async () => {
    const f = fake({ balanceOf: async () => MIN_STAKE_WEI - 1n });
    expect(errorCode(await openDuel(DUEL, MIN_STAKE_WEI, f.deps, f.onStep)))
      .toBe("INSUFFICIENT_BALANCE");
    expect(f.calls.map(([name]) => name)).not.toContain("open");
  });

  test("winStake relay preserves the signed winner and pays through one call", async () => {
    const f = fake();
    const verdict = { duelId: DUEL, winner: WINNER, deadline: 2_000, signature: "0x1234" };
    const out = await settleDuel(verdict, f.deps, f.onStep);
    expect(out.status).toBe("ok");
    const relayed = f.calls.find(([name]) => name === "settle")?.[1] as typeof verdict;
    expect(relayed).toEqual(verdict);
    expect(Object.isFrozen(relayed)).toBe(true);
  });

  test("refund and cancel remain single Sepolia transactions", async () => {
    const refund = fake();
    expect((await refundDuel(DUEL, refund.deps)).status).toBe("ok");
    expect(refund.calls.map(([name]) => name)).toContain("refund");
    const cancel = fake();
    expect((await cancelDuel(DUEL, cancel.deps)).status).toBe("ok");
    expect(cancel.calls.map(([name]) => name)).toContain("cancel");
  });

  test("the mock wallet cannot transact", async () => {
    const f = fake({ walletId: "mock" });
    expect(errorCode(await openDuel(DUEL, MIN_STAKE_WEI, f.deps))).toBe("SIGNER_REQUIRED");
    expect(f.calls).toEqual([]);
  });
});
