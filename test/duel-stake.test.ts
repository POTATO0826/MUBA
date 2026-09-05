/**
 * The USDC side bet, exercised without a chain.
 *
 * `src/desk/escrow.ts` is the second module in this app that can spend money,
 * and the first one that can spend *someone else's* — a player's stake, on Base
 * mainnet, against an unaudited contract with no admin and no rescue path. So
 * every branch of it is driven here through an injected `EscrowDeps`: a spy that
 * records the exact order in which each sequence touches the world, and can be
 * made to fail anywhere.
 *
 * What these tests are really pinning:
 *
 *  - the **approval is exact**, never `MaxUint256`, and is skipped entirely when
 *    the standing allowance already covers the stake;
 *  - the **guard runs before the network** — an under-minimum stake, an
 *    unconfigured escrow and the mock wallet are all refused before a single dep
 *    is touched;
 *  - the **mock wallet never approves and never transacts**;
 *  - **every failure lands in PTS-only** — every escrow code has a path into
 *    `phase: "failed"`, and the duel goes ahead in all of them;
 *  - the verdict is **frozen on arrival**, because it is an EIP-712 signature
 *    over three fields and a helpful normalisation of any of them recovers to a
 *    stranger;
 *  - `ledger.settle` fires **first and unconditionally** — the PTS result does
 *    not depend on a chain, a server, or a claim ever being pressed;
 *  - the **1100 ms `OPP_READY_MS` timer is untouched** for PTS-only play;
 *  - with the flag off — and with the flag ON but no escrow deployed, and on the
 *    mock wallet — the room renders the same DOM it rendered before any of this
 *    existed, compared as strings rather than by eye.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { App } from "../src/App.tsx";
import { mockMarketSource } from "../src/data/market.ts";
import type { WalletSource } from "../src/data/wallet.ts";
import {
  BPS,
  classifyLockRefusal,
  DEFAULT_STAKE_USDC,
  ESCROW_COPY,
  LARGE_STAKE_USDC,
  MAX_UINT256,
  MIN_STAKE_USDC,
  RAKE_BPS,
  REFUND_TIMEOUT_HOURS,
  ZERO_ADDRESS,
  buildLockMessage,
  cancelDuel,
  canonicalPicks,
  classifyEscrowError,
  commitLock,
  freezeVerdict,
  isAddress,
  joinDuel,
  openDuel,
  parseStakeUsdc,
  payoutOf,
  refundDuel,
  requestVerdict,
  settleDuel,
  stakeUnavailableReason,
  stakingAvailable,
  usd,
  type EscrowCode,
  type EscrowDeps,
  type EscrowStep,
  type OnChainDuel,
  type RefereeDeps,
  type StakeConfig,
  type Verdict,
} from "../src/desk/escrow.ts";
import { canonicalPicks as serverCanonicalPicks, lockMessage } from "../src/server/attest.ts";
import { OPP_READY_MS } from "../src/state/match.ts";
import { NO_STAKE, useDuelStake, type DuelStake, type StakeOptions } from "../src/state/stake.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ESCROW = "0x00000000000000000000000000000000000E5C70";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const ME = "0x1111111111111111111111111111111111111111";
const THEM = "0x2222222222222222222222222222222222222222";
const DUEL_ID = "0x" + "ab".repeat(32);
const HASH = "0x" + "cd".repeat(32);
const APPROVE_HASH = "0x" + "ef".repeat(32);
const SIGNER = { address: ME };

/** 4 Sep 2026, UTC. Every clock in this file is this instant. */
const NOW = Date.UTC(2026, 8, 4);

const STAKE = 1_000000n;

interface Call {
  name: string;
  args: readonly unknown[];
}

interface Fake {
  deps: EscrowDeps;
  calls: Call[];
  steps: EscrowStep[];
  /** Just the names, for order assertions. */
  names(): string[];
  onStep: (s: EscrowStep) => void;
}

/**
 * A whole escrow, as functions. Nothing here opens a socket, and every override
 * is a place a test makes the sequence fail.
 */
function fake(over: Partial<EscrowDeps> & { allowance?: bigint; balance?: bigint } = {}): Fake {
  const calls: Call[] = [];
  const steps: EscrowStep[] = [];
  const rec =
    <T,>(name: string, value: (...a: unknown[]) => T) =>
    (...args: unknown[]): T => {
      calls.push({ name, args });
      return value(...args);
    };

  const allowance = over.allowance ?? 0n;
  const balance = over.balance ?? 1_000_000_000n;

  const base: EscrowDeps = {
    walletId: "injected",
    escrow: ESCROW,
    now: () => NOW,
    getSigner: rec("getSigner", async () => SIGNER) as EscrowDeps["getSigner"],
    address: rec("address", async () => ME) as EscrowDeps["address"],
    stakeToken: rec("stakeToken", async () => USDC) as EscrowDeps["stakeToken"],
    allowanceOf: rec("allowanceOf", async () => allowance) as EscrowDeps["allowanceOf"],
    balanceOf: rec("balanceOf", async () => balance) as EscrowDeps["balanceOf"],
    approve: rec("approve", async () => ({ hash: APPROVE_HASH })) as EscrowDeps["approve"],
    open: rec("open", async () => ({ hash: HASH })) as EscrowDeps["open"],
    join: rec("join", async () => ({ hash: HASH })) as EscrowDeps["join"],
    settle: rec("settle", async () => ({ hash: HASH })) as EscrowDeps["settle"],
    refund: rec("refund", async () => ({ hash: HASH })) as EscrowDeps["refund"],
    cancel: rec("cancel", async () => ({ hash: HASH })) as EscrowDeps["cancel"],
    duelOf: rec("duelOf", async () => null) as EscrowDeps["duelOf"],
  };

  // Overrides are wrapped too, so a failing dep still shows up in the call log.
  const deps = { ...base } as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(over)) {
    if (key === "allowance" || key === "balance") continue;
    deps[key] =
      typeof value === "function" ? rec(key, value as (...a: unknown[]) => unknown) : value;
  }

  return {
    deps: deps as unknown as EscrowDeps,
    calls,
    steps,
    names: () => calls.map((c) => c.name),
    onStep: (s) => steps.push(s),
  };
}

const argsOf = (f: Fake, name: string): readonly unknown[] =>
  f.calls.find((c) => c.name === name)?.args ?? [];

const errOf = (o: { status: string; error?: { code: EscrowCode } }): EscrowCode | null =>
  o.status === "failed" ? (o.error?.code ?? null) : null;

// ─────────────────────────────────────────────────────────────────────────────
// The money arithmetic
// ─────────────────────────────────────────────────────────────────────────────

describe("the numbers agree with the contract", () => {
  test("payout + rake == 2 x stake, exactly, with no dust", () => {
    // The same values the adversarial review drove through the real EVM
    // (`.rev/a3-rakemath.ts`), plus the two boundaries.
    for (const stake of [
      MIN_STAKE_USDC,
      MIN_STAKE_USDC + 1n,
      100_007n,
      123_457n,
      999_999n,
      1_000_001n,
      2_500_001n,
      7_000_003n,
      10n ** 12n + 7n,
      2n ** 100n + 1n,
    ]) {
      const pot = stake * 2n;
      const rake = (pot * RAKE_BPS) / BPS;
      expect(payoutOf(stake) + rake).toBe(pot);
      // The floor always favours the winner, never the house.
      expect(rake * BPS).toBeLessThanOrEqual(pot * RAKE_BPS);
    }
  });

  test("the constants are the contract's", () => {
    expect(RAKE_BPS).toBe(400n);
    expect(BPS).toBe(10_000n);
    expect(MIN_STAKE_USDC).toBe(100_000n);
    expect(REFUND_TIMEOUT_HOURS).toBe(6);
    // Uncapped, by the owner's explicit decision. $20 is a warning line, and a
    // warning line must not be reachable as a limit.
    expect(LARGE_STAKE_USDC).toBe(20_000000n);
    expect(DEFAULT_STAKE_USDC).toBeGreaterThanOrEqual(MIN_STAKE_USDC);
  });

  test("a stake is parsed as decimal text, never through a float", () => {
    expect(parseStakeUsdc("0.10")).toBe(100_000n);
    expect(parseStakeUsdc("$1.00")).toBe(1_000000n);
    expect(parseStakeUsdc("25")).toBe(25_000000n);
    expect(parseStakeUsdc("0.07")).toBe(70_000n); // 0.07 * 1e6 is 70000.00000000001
    expect(parseStakeUsdc(" 3.5 ")).toBe(3_500000n);
    // Seven decimals is refused rather than rounded: USDC has six, and dropping
    // a digit silently changes what somebody typed.
    expect(parseStakeUsdc("1.0000001")).toBeNull();
    expect(parseStakeUsdc("")).toBeNull();
    expect(parseStakeUsdc(".")).toBeNull();
    expect(parseStakeUsdc("abc")).toBeNull();
    expect(parseStakeUsdc("-1")).toBeNull();
  });

  test("no screen can print one quantity in two units", () => {
    // `usd` only ever formats USDC base units. There is no PTS conversion here
    // and there is deliberately no function that would perform one.
    expect(usd(1_000000n)).toBe("$1.00");
    expect(usd(1_920000n)).toBe("$1.92");
    expect(usd(payoutOf(1_000000n))).toBe("$1.92");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The gate — review finding X-1
// ─────────────────────────────────────────────────────────────────────────────

describe("the gate: a flag alone cannot turn real money on", () => {
  const on: StakeConfig = { enabled: true, escrow: ESCROW, chainId: 8453 };

  test("all three conditions are required", () => {
    expect(stakingAvailable(on, "injected")).toBe(true);
    // The flag off.
    expect(stakingAvailable({ ...on, enabled: false }, "injected")).toBe(false);
    // The flag ON but nothing deployed — X-1's interlock, and the one this
    // phase exists to hold while on-chain seat binding lands in parallel.
    expect(stakingAvailable({ ...on, escrow: "" }, "injected")).toBe(false);
    expect(stakingAvailable({ ...on, escrow: "0xnot-an-address" }, "injected")).toBe(false);
    expect(stakingAvailable({ ...on, escrow: ESCROW.slice(0, -2) }, "injected")).toBe(false);
    // The mock wallet can never sign and must never approve.
    expect(stakingAvailable(on, "mock")).toBe(false);
    expect(stakingAvailable(on, undefined)).toBe(false);
  });

  test("the refusal is explained only when the flag is actually on", () => {
    expect(stakeUnavailableReason({ ...on, enabled: false }, "injected")).toBeNull();
    expect(stakeUnavailableReason(on, "injected")).toBeNull();
    expect(stakeUnavailableReason({ ...on, escrow: "" }, "injected")).toContain(
      "no escrow contract configured",
    );
    expect(stakeUnavailableReason(on, "mock")).toContain("mock wallet cannot sign");
  });

  test("an unconfigured escrow is refused before any dep is touched", async () => {
    const f = fake({ escrow: "" });
    const out = await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    expect(errOf(out)).toBe("ESCROW_UNCONFIGURED");
    expect(f.names()).toEqual([]);
    expect(f.steps).toEqual(["guard"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// open / join — the sequence, in order
// ─────────────────────────────────────────────────────────────────────────────

describe("openDuel walks the sequence in the fixed order", () => {
  test("the happy path: guard, signer, allowance, exact approve, send", async () => {
    const f = fake();
    const out = await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);

    expect(out.status).toBe("ok");
    expect(f.steps).toEqual(["guard", "signer", "allowance", "approve", "send", "done"]);
    expect(f.names()).toEqual([
      "getSigner",
      "address",
      "stakeToken",
      "balanceOf",
      "allowanceOf",
      "approve",
      "open",
    ]);
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.hash).toBe(HASH);
    expect(out.explorer).toBe(`https://basescan.org/tx/${HASH}`);
    expect(out.approvalSkipped).toBe(false);
  });

  test("the approval is EXACTLY the stake and never MaxUint256", async () => {
    const f = fake();
    await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);

    const [token, spender, amount] = argsOf(f, "approve");
    expect(token).toBe(USDC);
    expect(spender).toBe(ESCROW);
    expect(amount).toBe(STAKE);
    expect(amount).not.toBe(MAX_UINT256);
    // Not merely "not MaxUint256" — not one base unit more than the stake, in
    // any of the approvals this suite can provoke.
    for (const s of [MIN_STAKE_USDC, 3_330000n, 100_000000n]) {
      const g = fake();
      await openDuel(DUEL_ID, s, g.deps, g.onStep);
      expect(argsOf(g, "approve")[2]).toBe(s);
    }
  });

  test("a sufficient standing allowance sends no approval at all", async () => {
    const f = fake({ allowance: STAKE });
    const out = await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    expect(out.status).toBe("ok");
    if (out.status !== "ok") throw new Error("unreachable");
    expect(out.approvalSkipped).toBe(true);
    expect(f.names()).not.toContain("approve");
    expect(f.steps).not.toContain("approve");
  });

  test("the token approved is the one the ESCROW names, not a hard-coded address", async () => {
    // Review finding 5-1: the constructor accepts any non-zero token and there
    // is no rescue path, so the deployment's own answer is the only one worth
    // approving against.
    const OTHER = "0x4200000000000000000000000000000000000006";
    const f = fake({ stakeToken: async () => OTHER });
    await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    expect(argsOf(f, "approve")[0]).toBe(OTHER);
  });

  test("the open seat is spelled as the zero address by default", async () => {
    const f = fake();
    await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    expect(argsOf(f, "open")).toEqual([DUEL_ID, STAKE, ZERO_ADDRESS]);
  });

  test("a stake under MIN_STAKE is refused above the network", async () => {
    const f = fake();
    const out = await openDuel(DUEL_ID, MIN_STAKE_USDC - 1n, f.deps, f.onStep);
    expect(errOf(out)).toBe("STAKE_TOO_SMALL");
    expect(f.names()).toEqual([]);
  });

  test("a malformed duel id never reaches a signature", async () => {
    const f = fake();
    expect(errOf(await openDuel("0xnope", STAKE, f.deps, f.onStep))).toBe("ESCROW_UNCONFIGURED");
    expect(f.names()).toEqual([]);
  });

  test("joinDuel is the same preamble and a different call", async () => {
    const f = fake();
    const out = await joinDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    expect(out.status).toBe("ok");
    expect(f.names()).toContain("join");
    expect(f.names()).not.toContain("open");
    expect(argsOf(f, "approve")[2]).toBe(STAKE);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The mock wallet
// ─────────────────────────────────────────────────────────────────────────────

describe("the mock wallet never approves and never transacts", () => {
  const sequences = [
    ["openDuel", (d: EscrowDeps) => openDuel(DUEL_ID, STAKE, d)],
    ["joinDuel", (d: EscrowDeps) => joinDuel(DUEL_ID, STAKE, d)],
    ["refundDuel", (d: EscrowDeps) => refundDuel(DUEL_ID, d)],
    ["cancelDuel", (d: EscrowDeps) => cancelDuel(DUEL_ID, d)],
    [
      "settleDuel",
      (d: EscrowDeps) =>
        settleDuel(
          { duelId: DUEL_ID, winner: ME, deadline: NOW / 1000 + 600, signature: "0x00" },
          d,
        ),
    ],
  ] as const;

  for (const [name, run] of sequences) {
    test(`${name} refuses the mock tier before getSigner is even called`, async () => {
      const f = fake({ walletId: "mock" });
      const out = await run(f.deps);
      expect(errOf(out)).toBe("SIGNER_REQUIRED");
      // Not one dep. No signer, no allowance read, and above all no approval.
      expect(f.names()).toEqual([]);
    });
  }

  test("mounted in the app, the mock tier renders no side bet at all", () => {
    // `stakingAvailable` is the gate the room asks, and the mock never passes it
    // however the flags are set.
    expect(stakingAvailable({ enabled: true, escrow: ESCROW, chainId: 8453 }, "mock")).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every failure lands in PTS-only
// ─────────────────────────────────────────────────────────────────────────────

describe("every failure degrades to PTS-only", () => {
  /** One thrown thing per code, in the shape the chain or the SDK produces it. */
  const THROWN: Record<EscrowCode, unknown> = {
    SIGNER_REQUIRED: new Error("SIGNER_REQUIRED: no signer"),
    ESCROW_UNCONFIGURED: new Error("unused — raised, never thrown"),
    STAKE_TOO_SMALL: Object.assign(new Error("execution reverted: stake too small"), {
      code: "CALL_EXCEPTION",
    }),
    INSUFFICIENT_BALANCE: new Error("transfer amount exceeds balance"),
    INSUFFICIENT_ALLOWANCE: new Error("ERC20: insufficient allowance"),
    DUEL_TAKEN: Object.assign(new Error("execution reverted: duel exists"), {
      code: "CALL_EXCEPTION",
    }),
    DUEL_NOT_OPEN: Object.assign(new Error("execution reverted: not open"), {
      code: "CALL_EXCEPTION",
    }),
    NOT_FULL: Object.assign(new Error("execution reverted: not full"), { code: "CALL_EXCEPTION" }),
    VERDICT_EXPIRED: Object.assign(new Error("execution reverted: verdict expired"), {
      code: "CALL_EXCEPTION",
    }),
    ATTESTOR_DOWN: new Error("unused — raised by the referee path"),
    SEATS_UNBOUND: new Error("unused — raised by the referee path"),
    OPPONENT_NOT_JOINED: new Error("unused — raised by the referee path"),
    CHAIN_UNREACHABLE: new Error("unused — raised by the referee path"),
    REJECTED: Object.assign(new Error("user rejected action"), { code: "ACTION_REJECTED" }),
    CONTRACT_REVERT: new Error("execution reverted"),
    NETWORK: new Error("fetch failed"),
    RATE_LIMIT: Object.assign(new Error("could not coalesce error"), { code: "SERVER_ERROR" }),
  };

  test("classifyEscrowError maps each shape onto its own code", () => {
    for (const code of Object.keys(THROWN) as EscrowCode[]) {
      // These five are raised by this module or mapped from the referee's own
      // refusal strings; nothing throws them.
      if (
        code === "ESCROW_UNCONFIGURED" ||
        code === "ATTESTOR_DOWN" ||
        code === "SEATS_UNBOUND" ||
        code === "OPPONENT_NOT_JOINED" ||
        code === "CHAIN_UNREACHABLE"
      )
        continue;
      expect(classifyEscrowError(THROWN[code], "send").code).toBe(code);
    }
  });

  test("every code carries a message, a recovery and a recognised action", () => {
    for (const code of Object.keys(ESCROW_COPY) as EscrowCode[]) {
      const copy = ESCROW_COPY[code];
      expect(copy.message.length).toBeGreaterThan(8);
      expect(copy.recovery.length).toBeGreaterThan(8);
      expect(["connect", "switch", "retry", "refresh", "fund", "none"]).toContain(copy.action);
    }
  });

  test("all but two say, in the same breath, that the duel goes ahead", () => {
    // The two that do not are the two where the money is already in the
    // contract and the duel has already been played: a settle that cannot land
    // and a verdict that has expired are not "play anyway" situations, they are
    // "your principal is still there" situations.
    const chainSide: EscrowCode[] = ["NOT_FULL", "VERDICT_EXPIRED"];
    for (const code of Object.keys(ESCROW_COPY) as EscrowCode[]) {
      if (chainSide.includes(code)) continue;
      expect(ESCROW_COPY[code].recovery).toContain("PTS pool");
    }
    for (const code of chainSide) {
      expect(ESCROW_COPY[code].recovery.toLowerCase()).toContain("stake");
    }
  });

  test("a revert at the send step never claims the money moved", async () => {
    const f = fake({
      open: async () => {
        throw THROWN.DUEL_TAKEN;
      },
    });
    const out = await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    expect(errOf(out)).toBe("DUEL_TAKEN");
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.recovery).toContain("Nothing was spent");
    expect(out.error.step).toBe("send");
  });

  test("a signer on the wrong chain is told to switch, not to connect", async () => {
    const f = fake({
      getSigner: async () => {
        throw new Error("wallet is on chain 1, expected 8453");
      },
    });
    const out = await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.action).toBe("switch");
    expect(out.error.message).toContain("not on Base");
    expect(f.names()).not.toContain("approve");
  });

  test("a disconnected wallet is told to connect", async () => {
    const f = fake({ getSigner: async () => null });
    const out = await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.action).toBe("connect");
    expect(f.names()).not.toContain("approve");
  });

  test("an underfunded wallet is refused before the approval is sent", async () => {
    const f = fake({ balance: STAKE - 1n });
    const out = await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    expect(errOf(out)).toBe("INSUFFICIENT_BALANCE");
    expect(f.names()).not.toContain("approve");
    expect(f.names()).not.toContain("open");
  });

  test("a throttled RPC is not reported as a contract revert", async () => {
    const f = fake({
      open: async () => {
        throw THROWN.RATE_LIMIT;
      },
    });
    const out = await openDuel(DUEL_ID, STAKE, f.deps, f.onStep);
    expect(errOf(out)).toBe("RATE_LIMIT");
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.throttled).toBe(true);
    expect(out.error.recovery).toContain("RPC_URL");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// settle / refund / cancel
// ─────────────────────────────────────────────────────────────────────────────

describe("the verdict is frozen, checked and relayed", () => {
  const live = (): Verdict => ({
    duelId: DUEL_ID,
    winner: ME,
    deadline: Math.floor(NOW / 1000) + 600,
    signature: "0x" + "11".repeat(65),
  });

  test("relaying passes the four fields through unchanged", async () => {
    const f = fake();
    const out = await settleDuel(live(), f.deps, f.onStep);
    expect(out.status).toBe("ok");
    const [v] = argsOf(f, "settle") as [Verdict];
    expect(v.duelId).toBe(DUEL_ID);
    expect(v.winner).toBe(ME);
    expect(v.signature).toBe(live().signature);
    // Frozen: a later "normalisation" is a TypeError at the line that did it,
    // not a digest that recovers to a stranger.
    expect(Object.isFrozen(v)).toBe(true);
    expect(() => {
      (v as { winner: string }).winner = THEM;
    }).toThrow();
  });

  test("freezeVerdict does not mutate the caller's object", () => {
    const v = live();
    const frozen = freezeVerdict(v);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(Object.isFrozen(v)).toBe(false);
  });

  test("an expired verdict never reaches the chain", async () => {
    const f = fake();
    const out = await settleDuel(
      { ...live(), deadline: Math.floor(NOW / 1000) - 1 },
      f.deps,
      f.onStep,
    );
    expect(errOf(out)).toBe("VERDICT_EXPIRED");
    expect(f.names()).toEqual([]);
  });

  test("a refunded duel reports NOT_FULL and points at the stake, not at a retry", async () => {
    const f = fake({
      settle: async () => {
        throw Object.assign(new Error("execution reverted: not full"), {
          code: "CALL_EXCEPTION",
        });
      },
    });
    const out = await settleDuel(live(), f.deps, f.onStep);
    expect(errOf(out)).toBe("NOT_FULL");
    if (out.status !== "failed") throw new Error("unreachable");
    // Review finding 4-1: after the timeout a loser's refund forces a draw.
    expect(out.error.recovery).toContain(`${REFUND_TIMEOUT_HOURS}-hour`);
  });

  test("refund and cancel need no approval and no amount", async () => {
    const r = fake();
    expect((await refundDuel(DUEL_ID, r.deps, r.onStep)).status).toBe("ok");
    expect(r.names()).toEqual(["getSigner", "refund"]);
    expect(r.names()).not.toContain("approve");

    const c = fake();
    expect((await cancelDuel(DUEL_ID, c.deps, c.onStep)).status).toBe("ok");
    expect(c.names()).toEqual(["getSigner", "cancel"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The referee, and the message it will not sign a lie over
// ─────────────────────────────────────────────────────────────────────────────

describe("the lock message is byte-identical to the server's", () => {
  const picks = { TSLA: "safe-bear", AMD: "safe-bull", META: "wild-bull" };

  test("canonicalPicks matches src/server/attest.ts", () => {
    expect(canonicalPicks(picks)).toBe(serverCanonicalPicks(picks));
    // Key order in the object must not change the string — that is the whole
    // point of canonicalising it.
    expect(canonicalPicks({ META: "wild-bull", AMD: "safe-bull", TSLA: "safe-bear" })).toBe(
      canonicalPicks(picks),
    );
  });

  test("buildLockMessage matches lockMessage, including the open-seat spelling", () => {
    const key = "kz-semis:424242";
    expect(buildLockMessage(key, ME, THEM, picks)).toBe(lockMessage(key, ME, THEM, picks));
    expect(buildLockMessage(key, ME, null, picks)).toBe(lockMessage(key, ME, null, picks));
    expect(buildLockMessage(key, ME, null, picks)).toContain(`b:${ZERO_ADDRESS}`);
    // Five lines, no trailing newline.
    expect(buildLockMessage(key, ME, THEM, picks).split("\n").length).toBe(5);
    expect(buildLockMessage(key, ME, THEM, picks).endsWith("\n")).toBe(false);
  });

  test("a lock the server refuses is an ATTESTOR_DOWN, not a crash", async () => {
    const referee: RefereeDeps = {
      signMessage: async () => "0xsig",
      postLock: async () => ({ ok: false, reason: "attestor not configured" }),
      postAttest: async () => ({ ok: false }),
    };
    const out = await commitLock("kz-semis:1", ME, THEM, {}, referee);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error.code).toBe("ATTESTOR_DOWN");
    expect(out.error.recovery).toContain(`${REFUND_TIMEOUT_HOURS} hours`);
  });

  test("a lock signs exactly the message it commits", async () => {
    const signed: string[] = [];
    const posted: unknown[] = [];
    const referee: RefereeDeps = {
      signMessage: async (m) => {
        signed.push(m);
        return "0xsig";
      },
      postLock: async (b) => {
        posted.push(b);
        return { ok: true, duelId: DUEL_ID, commit: "0xcommit" };
      },
      postAttest: async () => ({ ok: false }),
    };
    const out = await commitLock("kz-semis:424242", ME, THEM, picks, referee);
    expect(out.ok).toBe(true);
    expect(signed[0]).toBe(lockMessage("kz-semis:424242", ME, THEM, picks));
    expect(posted[0]).toMatchObject({ matchKey: "kz-semis:424242", a: ME, b: THEM, sig: "0xsig" });
  });

  test("a dead referee is ATTESTOR_DOWN, and the copy is the six-hour refund", async () => {
    const referee: RefereeDeps = {
      signMessage: async () => "0xsig",
      postAttest: async () => {
        throw new Error("fetch failed");
      },
      postLock: async () => ({ ok: false }),
    };
    const out = await requestVerdict("kz-semis:1", referee);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error.code).toBe("ATTESTOR_DOWN");
    expect(out.error.recovery).toContain("refunds automatically after 6 hours");
  });

  test("an unjoined duel is refused locally — the one mistake that cannot be retried", async () => {
    // `/api/lock` is first-write-wins. A slip pinned with no on-chain joiner
    // names an opponent the chain has never seen and leaves the duel
    // permanently unsettleable, so this is refused before it is sent.
    const posted: unknown[] = [];
    const referee: RefereeDeps = {
      signMessage: async () => "0xsig",
      postLock: async (b) => {
        posted.push(b);
        return { ok: true, duelId: DUEL_ID };
      },
      postAttest: async () => ({ ok: false }),
    };
    for (const b of [null, ZERO_ADDRESS, "", "0xnope"]) {
      const out = await commitLock("kz-semis:1", ME, b, {}, referee);
      expect(out.ok).toBe(false);
      if (out.ok) throw new Error("unreachable");
      expect(out.error.code).toBe("OPPONENT_NOT_JOINED");
    }
    // Nothing was signed and nothing was posted.
    expect(posted).toEqual([]);
  });

  test("the two seats must be different addresses", async () => {
    const referee: RefereeDeps = {
      signMessage: async () => "0xsig",
      postLock: async () => ({ ok: true, duelId: DUEL_ID }),
      postAttest: async () => ({ ok: false }),
    };
    const out = await commitLock("kz-semis:1", ME, ME, {}, referee);
    expect(out.ok).toBe(false);
    if (out.ok) throw new Error("unreachable");
    expect(out.error.code).toBe("SEATS_UNBOUND");
  });

  test("every refusal string the server can answer with maps to a typed code", () => {
    // Transcribed from the disposition table in `src/server/attest.ts`.
    expect(classifyLockRefusal("opponent has not joined on chain")).toBe("OPPONENT_NOT_JOINED");
    expect(classifyLockRefusal("not a seat in this duel")).toBe("SEATS_UNBOUND");
    expect(classifyLockRefusal("opponent is not the on-chain seat")).toBe("SEATS_UNBOUND");
    expect(classifyLockRefusal("seats not on chain")).toBe("SEATS_UNBOUND");
    expect(classifyLockRefusal("duel is closed on chain")).toBe("SEATS_UNBOUND");
    expect(classifyLockRefusal("chain unreachable")).toBe("CHAIN_UNREACHABLE");
    expect(classifyLockRefusal("bad chain response")).toBe("CHAIN_UNREACHABLE");
    // Anything unrecognised still fails closed, with the six-hour refund copy.
    expect(classifyLockRefusal("attestor not configured")).toBe("ATTESTOR_DOWN");
  });

  test("a refusal is surfaced with its own copy, never as a retry-forever spinner", async () => {
    for (const [reason, code] of [
      ["opponent has not joined on chain", "OPPONENT_NOT_JOINED"],
      ["not a seat in this duel", "SEATS_UNBOUND"],
      ["chain unreachable", "CHAIN_UNREACHABLE"],
    ] as const) {
      const referee: RefereeDeps = {
        signMessage: async () => "0xsig",
        postLock: async () => ({ ok: false, reason }),
        postAttest: async () => ({ ok: false }),
      };
      const out = await commitLock("kz-semis:1", ME, THEM, {}, referee);
      if (out.ok) throw new Error("unreachable");
      expect(out.error.code).toBe(code);
      expect(out.error.detail).toBe(reason);
      // Every one of them tells the player their money comes back.
      expect(out.error.recovery).toContain(`${REFUND_TIMEOUT_HOURS}`);
    }
  });

  test("a verdict comes back frozen", async () => {
    const referee: RefereeDeps = {
      signMessage: async () => "0xsig",
      postLock: async () => ({ ok: true, duelId: DUEL_ID }),
      postAttest: async () => ({
        ok: true,
        duelId: DUEL_ID,
        winner: ME,
        deadline: Math.floor(NOW / 1000) + 600,
        signature: "0xsig65",
      }),
    };
    const out = await requestVerdict("kz-semis:1", referee);
    if (!out.ok) throw new Error("unreachable");
    expect(Object.isFrozen(out.verdict)).toBe(true);
    expect(out.verdict.winner).toBe(ME);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The six-state machine
// ─────────────────────────────────────────────────────────────────────────────

let hookRoot: Root | null = null;
let hookHost: HTMLDivElement | null = null;

/** Drive `useDuelStake` with no App, no wallet layer and no chain. */
async function drive(
  walletId: string,
  options: StakeOptions,
): Promise<{ read: () => DuelStake; flush: () => Promise<void> }> {
  const box: { current: DuelStake | null } = { current: null };
  const wallet = { id: walletId, getSigner: async () => SIGNER };
  const Probe = () => {
    box.current = useDuelStake(wallet, options);
    return null;
  };
  hookHost = document.createElement("div");
  document.body.appendChild(hookHost);
  hookRoot = createRoot(hookHost);
  await act(async () => {
    hookRoot!.render(createElement(Probe));
  });
  return {
    read: () => box.current!,
    flush: async () => {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));
      });
    },
  };
}

afterEach(async () => {
  if (hookRoot) {
    const r = hookRoot;
    await act(async () => r.unmount());
    hookRoot = null;
  }
  hookHost?.remove();
  hookHost = null;
});

const ON: StakeConfig = { enabled: true, escrow: ESCROW, chainId: 8453 };

describe("the six-state machine", () => {
  test("idle → approving → staking → confirming → staked", async () => {
    // The chain answers OPEN-for-nobody at first, then FULL once the poll runs.
    let duel: OnChainDuel | null = null;
    const f = fake({
      duelOf: async () => duel,
      open: async () => {
        duel = { status: "OPEN", a: ME, b: ZERO_ADDRESS, stake: STAKE, fullAt: 0 };
        return { hash: HASH };
      },
    });

    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      referee: () => ({
        signMessage: async () => "0xsig",
        postLock: async () => ({ ok: true, duelId: DUEL_ID }),
        postAttest: async () => ({ ok: false }),
      }),
      duelId: async () => DUEL_ID,
      pollMs: 5,
      now: () => NOW,
    });

    expect(read().phase).toBe("idle");
    expect(read().available).toBe(true);
    expect(read().live).toBe(false);

    await act(async () => read().begin("kz-semis:424242"));
    await flush();

    // The opener holds a seat but the pot is not full yet.
    expect(read().phase).toBe("confirming");
    expect(read().seat).toBe("a");
    expect(read().hash).toBe(HASH);
    expect(read().live).toBe(true);
    expect(read().joined).toBe(false);

    // `DuelJoined`, seen by the poller.
    duel = { status: "FULL", a: ME, b: THEM, stake: STAKE, fullAt: Math.floor(NOW / 1000) };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(read().phase).toBe("staked");
    expect(read().joined).toBe(true);
    expect(read().live).toBe(true);
  });

  test("joining an open duel goes straight to staked, at the opener's stake", async () => {
    const f = fake({
      duelOf: async () => ({ status: "OPEN", a: THEM, b: ZERO_ADDRESS, stake: 5_000000n, fullAt: 0 }),
    });
    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
      now: () => NOW,
    });
    await act(async () => read().begin("kz-semis:424242"));
    await flush();

    expect(read().phase).toBe("staked");
    expect(read().seat).toBe("b");
    // The joiner matches the stake the OPENER booked, not this browser's own
    // create-form figure: the contract takes `d.stake` and anything else
    // reverts.
    expect(argsOf(f, "approve")[2]).toBe(5_000000n);
    expect(f.names()).toContain("join");
    expect(f.names()).not.toContain("open");
  });

  test("a failure anywhere lands in `failed`, which is PTS-only", async () => {
    const f = fake({
      open: async () => {
        throw Object.assign(new Error("execution reverted: duel exists"), {
          code: "CALL_EXCEPTION",
        });
      },
    });
    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
      now: () => NOW,
    });
    await act(async () => read().begin("kz-semis:424242"));
    await flush();

    expect(read().phase).toBe("failed");
    expect(read().error?.code).toBe("DUEL_TAKEN");
    // The whole point: no seat is held, so the room resumes the ordinary game
    // and the opponent's ready comes back from the 1100 ms timer.
    expect(read().live).toBe(false);
    expect(read().joined).toBe(false);
  });

  test("the flag off leaves the machine inert and constructs no deps", async () => {
    let built = 0;
    const f = fake();
    const { read, flush } = await drive("injected", {
      config: { enabled: false, escrow: ESCROW, chainId: 8453 },
      deps: () => {
        built += 1;
        return f.deps;
      },
      duelId: async () => DUEL_ID,
    });
    expect(read().available).toBe(false);
    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    expect(read().phase).toBe("idle");
    expect(built).toBe(0);
    expect(f.names()).toEqual([]);
  });

  test("the flag ON with no escrow is equally inert, and says why", async () => {
    let built = 0;
    const f = fake();
    const { read, flush } = await drive("injected", {
      config: { enabled: true, escrow: "", chainId: 8453 },
      deps: () => {
        built += 1;
        return f.deps;
      },
      duelId: async () => DUEL_ID,
    });
    expect(read().available).toBe(false);
    expect(read().unavailable).toContain("no escrow contract configured");
    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    expect(built).toBe(0);
    expect(f.names()).toEqual([]);
  });

  test("the mock wallet never reaches a dep, whatever the config says", async () => {
    const f = fake({ walletId: "mock" });
    const { read, flush } = await drive("mock", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
    });
    expect(read().available).toBe(false);
    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    expect(f.names()).toEqual([]);
    expect(read().phase).toBe("idle");
  });

  test("the amount is owner-settable and survives a reset", async () => {
    const { read } = await drive("injected", { config: ON, deps: () => fake().deps });
    expect(read().amount).toBe(DEFAULT_STAKE_USDC);
    await act(async () => read().setAmount(7_500000n));
    expect(read().amount).toBe(7_500000n);
    await act(async () => read().reset());
    expect(read().amount).toBe(7_500000n);
    expect(read().phase).toBe("idle");
  });

  test("claim asks the referee, then relays, then shows a hash", async () => {
    const f = fake({
      duelOf: async () => ({
        status: "FULL",
        a: ME,
        b: THEM,
        stake: STAKE,
        fullAt: Math.floor(NOW / 1000),
      }),
    });
    const order: string[] = [];
    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
      now: () => NOW,
      referee: () => ({
        signMessage: async () => "0xsig",
        postLock: async () => ({ ok: true, duelId: DUEL_ID }),
        postAttest: async () => {
          order.push("attest");
          return {
            ok: true,
            duelId: DUEL_ID,
            winner: ME,
            deadline: Math.floor(NOW / 1000) + 600,
            signature: "0xsig65",
          };
        },
      }),
    });

    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    expect(read().phase).toBe("staked");

    await act(async () => read().claim("kz-semis:424242"));
    await flush();
    expect(read().claimPhase).toBe("claimed");
    expect(read().claimHash).toBe(HASH);
    // The referee is asked BEFORE the chain is written to — a relay without a
    // verdict would be a transaction with nothing to prove.
    expect(order).toEqual(["attest"]);
    expect(f.names().indexOf("settle")).toBeGreaterThan(-1);
  });

  test("a referee that never answers leaves the stake claimable, not lost", async () => {
    const f = fake({
      duelOf: async () => ({
        status: "FULL",
        a: ME,
        b: THEM,
        stake: STAKE,
        fullAt: Math.floor(NOW / 1000),
      }),
    });
    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
      now: () => NOW,
      referee: () => ({
        signMessage: async () => "0xsig",
        postLock: async () => ({ ok: true, duelId: DUEL_ID }),
        postAttest: async () => {
          throw new Error("fetch failed");
        },
      }),
    });
    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    await act(async () => read().claim("kz-semis:424242"));
    await flush();

    expect(read().claimPhase).toBe("failed");
    expect(read().claimError?.code).toBe("ATTESTOR_DOWN");
    expect(read().claimError?.recovery).toContain("refunds automatically after 6 hours");
    // Nothing was relayed, so nothing was spent beyond the stake already held.
    expect(f.names()).not.toContain("settle");
  });

  test("past the timeout, the stake can be pulled back without a server", async () => {
    const fullAt = Math.floor(NOW / 1000) - REFUND_TIMEOUT_HOURS * 3600 - 60;
    const f = fake({
      duelOf: async () => ({ status: "FULL", a: ME, b: THEM, stake: STAKE, fullAt }),
    });
    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
      now: () => NOW,
    });
    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    expect(read().refundable).toBe(true);

    await act(async () => read().refund());
    await flush();
    expect(read().claimPhase).toBe("claimed");
    expect(f.names()).toContain("refund");
  });

  test("the opener locks, and only once the joiner has paid", async () => {
    let duel: OnChainDuel | null = null;
    const f = fake({
      duelOf: async () => duel,
      open: async () => {
        duel = { status: "OPEN", a: ME, b: ZERO_ADDRESS, stake: STAKE, fullAt: 0 };
        return { hash: HASH };
      },
    });
    const posted: { a: string; b: string | null }[] = [];
    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
      pollMs: 5,
      now: () => NOW,
      referee: () => ({
        signMessage: async () => "0xsig",
        postLock: async (b) => {
          posted.push({ a: b.a, b: b.b });
          return { ok: true, duelId: DUEL_ID };
        },
        postAttest: async () => ({ ok: false }),
      }),
    });

    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    expect(read().phase).toBe("confirming");

    // The parlay locks while the duel is still OPEN. Nothing may be posted:
    // `/api/lock` is first-write-wins, and a lock naming no joiner would leave
    // the duel permanently unsettleable.
    await act(async () => read().commit("kz-semis:424242", { TSLA: "safe-bull" }));
    await flush();
    expect(posted).toEqual([]);
    expect(read().locked).toBe(false);

    // The joiner pays. Now — and only now — the slip goes.
    duel = { status: "FULL", a: ME, b: THEM, stake: STAKE, fullAt: Math.floor(NOW / 1000) };
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    await flush();
    expect(read().phase).toBe("staked");
    expect(read().locked).toBe(true);
    // Ordered, and read off the contract: `a` opened, `b` joined.
    expect(posted).toEqual([{ a: ME, b: THEM }]);
  });

  test("a joiner never posts a lock — the opener does, by design", async () => {
    const f = fake({
      duelOf: async () => ({ status: "OPEN", a: THEM, b: ZERO_ADDRESS, stake: STAKE, fullAt: 0 }),
    });
    const posted: unknown[] = [];
    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
      now: () => NOW,
      referee: () => ({
        signMessage: async () => "0xsig",
        postLock: async (b) => {
          posted.push(b);
          return { ok: true, duelId: DUEL_ID };
        },
        postAttest: async () => ({ ok: false }),
      }),
    });

    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    expect(read().seat).toBe("b");

    await act(async () => read().commit("kz-semis:424242", { TSLA: "safe-bull" }));
    await flush();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(posted).toEqual([]);
    expect(read().locked).toBe(false);
  });

  test("a refused lock is typed and says the stake still comes back", async () => {
    const f = fake({
      duelOf: async () => ({
        status: "FULL",
        a: ME,
        b: THEM,
        stake: STAKE,
        fullAt: Math.floor(NOW / 1000),
      }),
    });
    const { read, flush } = await drive("injected", {
      config: ON,
      deps: () => f.deps,
      duelId: async () => DUEL_ID,
      now: () => NOW,
      referee: () => ({
        signMessage: async () => "0xsig",
        postLock: async () => ({ ok: false, reason: "chain unreachable" }),
        postAttest: async () => ({ ok: false }),
      }),
    });
    await act(async () => read().begin("kz-semis:424242"));
    await flush();
    expect(read().seats).toEqual({ a: ME, b: THEM });

    await act(async () => read().commit("kz-semis:424242", { TSLA: "safe-bull" }));
    await flush();
    expect(read().locked).toBe(false);
    expect(read().lockError?.code).toBe("CHAIN_UNREACHABLE");
    expect(read().lockError?.recovery).toContain("6 hours");
  });

  test("NO_STAKE is inert in every direction", () => {
    expect(NO_STAKE.available).toBe(false);
    expect(NO_STAKE.phase).toBe("idle");
    expect(NO_STAKE.live).toBe(false);
    expect(() => {
      NO_STAKE.begin("x");
      NO_STAKE.commit("x", {});
      NO_STAKE.claim("x");
      NO_STAKE.refund();
      NO_STAKE.reset();
    }).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The app, rendered — flag-off identity, and the 1100 ms timer
// ─────────────────────────────────────────────────────────────────────────────

const realFetch = globalThis.fetch;

/** A wallet that is NOT the mock tier, so the config is actually fetched. Held
 *  as one constant so that every render below differs only in the config the
 *  server serves — otherwise the header's address alone would fail the
 *  comparison for reasons that have nothing to do with staking. */
const WALLET: WalletSource = {
  id: "injected",
  identity: {
    address: ME,
    chainId: 8453,
    walletName: "Test wallet",
    connected: true,
    connecting: false,
    wrongNetwork: false,
  },
  connect: async () => {},
  disconnect: async () => {},
  openAccount: async () => {},
  switchToBase: async () => {},
  getSigner: async () => SIGNER as never,
};

function serveConfig(body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    })) as unknown as typeof globalThis.fetch;
}

/** Mount the whole app in a lobby room and return its HTML with all effects
 *  settled. `ready` presses the ready button first, which is where an honest
 *  refusal is allowed to appear. */
async function roomParts(
  opts: { wallet?: WalletSource; ready?: boolean } = {},
): Promise<{ html: string; panel: string }> {
  window.history.replaceState(null, "", "/match/kz-semis/room?seed=424242");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      createElement(App, {
        source: mockMarketSource,
        wallet: opts.wallet,
        route: { tab: "room", lobbyId: "kz-semis", seed: 424242 },
      }),
    );
  });
  // Let the config fetch (and its rejection) settle before reading the DOM.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  if (opts.ready) {
    const button = Array.from(host.querySelectorAll("button")).find((b) =>
      (b.textContent ?? "").includes("Ready up"),
    );
    if (!button) throw new Error("no ready button in the room");
    await act(async () => button.click());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
  const html = host.innerHTML;
  const panel = host.querySelector<HTMLElement>("[data-side-bet]")?.textContent ?? "";
  await act(async () => root.unmount());
  host.remove();
  window.history.replaceState(null, "", "/");
  return { html, panel };
}

/** The HTML alone — the shape every identity comparison below uses. */
async function roomHtml(opts: { wallet?: WalletSource; ready?: boolean } = {}): Promise<string> {
  return (await roomParts(opts)).html;
}

describe("the room with staking off renders today's DOM", () => {
  test("no flag, flag-on-with-no-escrow and the mock wallet all match the baseline byte for byte", async () => {
    // Today's app: the room as it renders with no config route at all.
    globalThis.fetch = (async () => {
      throw new Error("no server");
    }) as unknown as typeof globalThis.fetch;
    const baseline = await roomHtml({ wallet: WALLET });

    // 1. The flag off. Opt-IN means the absence of the flag is the absence of
    //    the feature.
    serveConfig({ escrow: ESCROW, chainId: 8453, features: { stake: false } });
    expect(await roomHtml({ wallet: WALLET })).toBe(baseline);

    // 2. The flag ON, but no escrow deployed — review finding X-1's interlock.
    //    A flag on its own is not allowed to change a pixel, let alone move
    //    money.
    serveConfig({ escrow: "", chainId: 8453, features: { stake: true } });
    expect(await roomHtml({ wallet: WALLET })).toBe(baseline);

    // 3. The flag ON with an escrow, on the mock wallet. The mock never
    //    approves and must never transact, so there is nothing to enable — and
    //    the config is not even fetched.
    serveConfig({ escrow: ESCROW, chainId: 8453, features: { stake: true } });
    const onMock = await roomHtml();
    globalThis.fetch = (async () => {
      throw new Error("no server");
    }) as unknown as typeof globalThis.fetch;
    expect(onMock).toBe(await roomHtml());

    globalThis.fetch = realFetch;
  });

  test("the assertion is not vacuous — the flag on with an escrow does change the room", async () => {
    globalThis.fetch = (async () => {
      throw new Error("no server");
    }) as unknown as typeof globalThis.fetch;
    const baseline = await roomHtml({ wallet: WALLET });

    serveConfig({ escrow: ESCROW, chainId: 8453, features: { stake: true } });
    const on = await roomHtml({ wallet: WALLET });

    expect(on).not.toBe(baseline);
    // The plan's sentence, verbatim, in its own unit and with no rate beside it.
    expect(on).toContain("Side bet: $1.00 USDC each, on-chain. Separate from the PTS pool.");
    expect(on).toContain("SIDE BET · ON-CHAIN");
    expect(baseline).not.toContain("Side bet");

    globalThis.fetch = realFetch;
  });

  test("the flag on with no escrow refuses at the point of action, honestly", async () => {
    serveConfig({ escrow: "", chainId: 8453, features: { stake: true } });
    const pressed = await roomHtml({ wallet: WALLET, ready: true });
    expect(pressed).toContain("no escrow contract configured");
    expect(pressed).toContain("SIDE BET · UNAVAILABLE");
    globalThis.fetch = realFetch;
  });

  test("no quantity is ever printed in two units", async () => {
    serveConfig({ escrow: ESCROW, chainId: 8453, features: { stake: true } });
    const { html, panel } = await roomParts({ wallet: WALLET });

    // The room still shows the PTS pool’s own notional figures, and the side
    // bet still shows dollars. What must not exist is a bridge between them.
    // (`Ξ`, not `ETH`: the pool is notional and only PTS moves, so the unit
    // word was itself a claim — see `state/match.ts`'s `prizeLabel`. The glyph
    // is what changed; the separation this test is about did not.)
    expect(html).toContain("4.80 Ξ");
    expect(panel).toContain("$1.00");

    // The panel names the PTS pool exactly once, and only to say the two are
    // separate. That sentence is the plan’s, verbatim.
    const MANDATED = "Side bet: $1.00 USDC each, on-chain. Separate from the PTS pool.";
    expect(panel).toContain(MANDATED);
    const rest = panel.split(MANDATED).join("");

    // Everywhere else in the panel: no ETH, no points, no rate. A conversion
    // would have to name the other unit somewhere, and it never does.
    for (const other of ["ETH", "Ξ", "PTS", "point", "≈", "worth", "equals", "convert"]) {
      expect(rest.includes(other)).toBe(false);
    }

    globalThis.fetch = realFetch;
  });
});

describe("the 1100 ms opponent timer is a pinned behaviour", () => {
  test("PTS-only play still fills the second seat after OPP_READY_MS", async () => {
    globalThis.fetch = (async () => {
      throw new Error("no server");
    }) as unknown as typeof globalThis.fetch;

    window.history.replaceState(null, "", "/match/kz-semis/room?seed=424242");
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        createElement(App, {
          source: mockMarketSource,
          route: { tab: "room", lobbyId: "kz-semis", seed: 424242 },
        }),
      );
    });

    expect(host.textContent).toContain("0/2 READY");
    await act(async () => {
      await new Promise((r) => setTimeout(r, OPP_READY_MS + 150));
    });
    expect(host.textContent).toContain("1/2 READY");

    await act(async () => root.unmount());
    host.remove();
    window.history.replaceState(null, "", "/");
    globalThis.fetch = realFetch;
  });

  test("the constant itself has not moved", () => {
    expect(OPP_READY_MS).toBe(1100);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Settle ordering — the ledger goes first, always
// ─────────────────────────────────────────────────────────────────────────────

describe("ledger.settle fires first and unconditionally", () => {
  test("App.settle names no chain call — the PTS result cannot depend on one", async () => {
    // A source scan, in the spirit of `test/determinism.test.ts`: the settle
    // callback in `src/App.tsx` must reach `ledger.settle` and `actions.settle`
    // and nothing else. A claim, an attest or an escrow call inside it would
    // make the points, the XP and the rank wait on a network.
    const src = await Bun.file(join(import.meta.dir, "..", "src", "App.tsx")).text();
    const start = src.indexOf("const settle = useCallback(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("const lobby = derived.lobby;", start));
    expect(body).toContain("ledger.settle({");
    expect(body).toContain("actions.settle();");
    for (const forbidden of ["stake.claim", "stake.settle", "escrow", "/api/attest", "await "]) {
      expect(body).not.toContain(forbidden);
    }
    // And the ledger call comes before the navigation, so the record exists by
    // the time `Result` mounts.
    expect(body.indexOf("ledger.settle({")).toBeLessThan(body.indexOf("actions.settle();"));
  });

  test("the ledger's own exports are untouched by staking", async () => {
    const ledger = await Bun.file(
      join(import.meta.dir, "..", "src", "state", "ledger.ts"),
    ).text();
    // No USDC, no escrow, no verdict, no rate. The ledger has not learned that
    // a second currency exists.
    for (const forbidden of ["USDC", "usdc", "escrow", "Escrow", "duelId", "/api/", "0x"]) {
      expect(ledger).not.toContain(forbidden);
    }
    // `enter` and `settle` are byte for byte what they were before this phase.
    expect(ledger).toContain(
      "const enter = useCallback((stake: number) => setPoints((p) => p - stake), []);",
    );
    expect(ledger).toContain(
      [
        "  const settle = useCallback(({ sweep, ...rest }: SettleInput) => {",
        "    const record: SettledRecord = { ...rest, xp: xpForMatch(rest.mode, sweep, rest.won) };",
        "    setPoints((p) => p + record.points);",
        "    setHistory((h) => [record, ...h]);",
        "  }, []);",
      ].join("\n"),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Odds and ends
// ─────────────────────────────────────────────────────────────────────────────

describe("address shapes", () => {
  test("isAddress accepts only 0x + 40 hex", () => {
    expect(isAddress(ESCROW)).toBe(true);
    expect(isAddress(ZERO_ADDRESS)).toBe(true);
    expect(isAddress("")).toBe(false);
    expect(isAddress("0x")).toBe(false);
    expect(isAddress(ESCROW.slice(0, -1))).toBe(false);
    expect(isAddress(`${ESCROW}0`)).toBe(false);
    expect(isAddress(null)).toBe(false);
    expect(isAddress(42)).toBe(false);
  });
});
