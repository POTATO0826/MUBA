/**
 * The fill path, exercised without a chain.
 *
 * `src/desk/fill.ts` is the only module in this app that can spend money, and
 * the one place a mistake costs the owner USDC on Base mainnet rather than a
 * failing test. So every branch of it is driven here through an injected
 * `FillDeps` — a spy that records the exact order in which the sequence touches
 * the world, and can be made to fail anywhere.
 *
 * What these tests are really pinning:
 *
 *  - the **cap runs before the network**, so an over-cap amount cannot reach a
 *    signature at all;
 *  - the **approval is exact**, never `MaxUint256`;
 *  - the order is **frozen on arrival**, because mutating it invalidates the
 *    maker's EIP-712 signature and the resulting revert blames the wallet;
 *  - the **mock wallet never approves and never fills**;
 *  - with the flag off, `/desk` renders the same DOM it rendered before any of
 *    this existed — compared as strings, not by eye.
 */

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { MarketSource } from "../src/data/market.ts";
import { mockMarketSource } from "../src/data/market.ts";
import {
  ALCHEMY_HINT,
  FILL_COPY,
  FILL_LADDER,
  MAX_FILL_USDC,
  MAX_UINT256,
  TARGET_FILL_USDC,
  classifyFillError,
  freezeOrder,
  looksThrottled,
  orderIdentity,
  refFor,
  rowIdentity,
  runFill,
  splitLabel,
  usdText,
  type FillCode,
  type FillDeps,
  type FillOutcome,
  type FillQuote,
  type FillStep,
  type RawFillOrder,
  type RawFillPreview,
} from "../src/desk/fill.ts";
import { Parlay } from "../src/views/Parlay.tsx";
import type { OrderRow } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OTHER_TOKEN = "0x4200000000000000000000000000000000000006"; // WETH on Base, 18dp
const BOOK = "0x0000000000000000000000000000000000000B00";
const REFERRER = "0x000000000000000000000000000000000000FEE5";
const HASH = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abcd";

/** 4 Sep 2026, UTC. Every clock in this file is this instant. */
const NOW = Date.UTC(2026, 8, 4);
/** 27 Sep 2026 — three weeks of signature life, which is not the case under
 *  test anywhere except the expiry-buffer block. */
const EXPIRY_S = Date.UTC(2026, 8, 27) / 1000;

/** A signer stands in for an ethers `Signer`. `runFill` only ever checks that
 *  it is truthy — the signing happens inside the SDK, past the seam. */
const SIGNER = { address: "0xsigner" };

function makeOrder(over: Partial<RawFillOrder["rawApiData"]> = {}): RawFillOrder {
  return {
    order: {
      // 0.0714 at 8dp — the price the row prints.
      price: 7_140_000n,
      isBuyer: true,
      nonce: 4242n,
      expiry: BigInt(EXPIRY_S),
    },
    availableAmount: 10_000_000n,
    signature: "0xsignature",
    makerAddress: "0xmaker",
    rawApiData: {
      orderExpiryTimestamp: EXPIRY_S,
      // 4,400 at 8dp.
      strikes: ["440000000000"],
      isCall: true,
      optionBookAddress: BOOK,
      collateral: USDC,
      ...over,
    },
  };
}

/** The blotter row the server would have printed for `makeOrder()`. */
const ROW: OrderRow = {
  side: "BUY",
  instrument: "ETH-27SEP-4400-C",
  size: "10.0k",
  px: "0.0714",
  status: "OPEN",
  time: "27 SEP",
};

/** A preview that fills: 0.15 contracts for $0.0099 of USDC. */
function preview(over: Partial<RawFillPreview> = {}): RawFillPreview {
  return {
    numContracts: 150_000_000_000_000_000n,
    totalCollateral: 9_900n,
    collateralToken: USDC,
    ...over,
  };
}

interface Spy {
  deps: FillDeps;
  /** Every seam call, in order. This array *is* the sequence assertion. */
  calls: string[];
  previewArgs: [RawFillOrder, bigint, string | undefined][];
  allowanceArgs: [string, string, bigint][];
  fillArgs: [RawFillOrder, bigint, string | undefined][];
  confirmArgs: FillQuote[];
}

/**
 * A `FillDeps` that records everything and defaults to the happy path.
 *
 * Every override is a way to fail one step, which is how the error-map tests
 * reach nine distinct codes without a chain in sight.
 */
function spy(over: Partial<FillDeps> = {}): Spy {
  const calls: string[] = [];
  const previewArgs: Spy["previewArgs"] = [];
  const allowanceArgs: Spy["allowanceArgs"] = [];
  const fillArgs: Spy["fillArgs"] = [];
  const confirmArgs: FillQuote[] = [];

  const base: FillDeps = {
    walletId: "injected",
    referrer: REFERRER,
    usdc: USDC,
    now: () => NOW,
    getSigner: async () => SIGNER,
    refetchOrder: async () => makeOrder(),
    previewFillOrder: () => preview(),
    ensureAllowance: async () => null,
    fillOrder: async () => ({ hash: HASH }),
    confirm: async () => true,
  };
  const merged = { ...base, ...over };

  const deps: FillDeps = {
    ...merged,
    getSigner: async () => {
      calls.push("getSigner");
      return merged.getSigner();
    },
    refetchOrder: async (ref) => {
      calls.push("refetchOrder");
      return merged.refetchOrder(ref);
    },
    previewFillOrder: (order, amount, referrer) => {
      calls.push("previewFillOrder");
      previewArgs.push([order, amount, referrer]);
      return merged.previewFillOrder(order, amount, referrer);
    },
    confirm: async (quote) => {
      calls.push("confirm");
      confirmArgs.push(quote);
      return merged.confirm(quote);
    },
    ensureAllowance: async (token, spender, amount) => {
      calls.push("ensureAllowance");
      allowanceArgs.push([token, spender, amount]);
      return merged.ensureAllowance(token, spender, amount);
    },
    fillOrder: async (order, amount, referrer) => {
      calls.push("fillOrder");
      fillArgs.push([order, amount, referrer]);
      return merged.fillOrder(order, amount, referrer);
    },
  };

  return { deps, calls, previewArgs, allowanceArgs, fillArgs, confirmArgs };
}

/** Run one fill against a spy, collecting the emitted steps. */
async function run(
  s: Spy,
  amount: bigint = TARGET_FILL_USDC,
): Promise<{ outcome: FillOutcome; steps: FillStep[] }> {
  const steps: FillStep[] = [];
  const ref = refFor(ROW)!;
  const outcome = await runFill(ref, amount, s.deps, (step) => steps.push(step));
  return { outcome, steps };
}

/** Narrow to the failure branch with a readable message when it is not one. */
function failure(outcome: FillOutcome) {
  if (outcome.status !== "failed") {
    throw new Error(`expected a failure, got ${outcome.status}`);
  }
  return outcome.error;
}

// ─────────────────────────────────────────────────────────────────────────────
// The sequence
// ─────────────────────────────────────────────────────────────────────────────

describe("runFill — the sequence", () => {
  test("touches the world in exactly the order the plan fixes", async () => {
    const s = spy();
    const { outcome, steps } = await run(s);

    expect(outcome.status).toBe("filled");
    // The seam calls. Preview sits between the re-fetch and the confirm, and
    // the approval strictly between the confirm and the fill — a fill that
    // approved before a human said yes would be the bug this pins.
    expect(s.calls).toEqual([
      "getSigner",
      "refetchOrder",
      "previewFillOrder",
      "confirm",
      "ensureAllowance",
      "fillOrder",
    ]);
    // The steps the UI stepper draws, including the two that touch nothing.
    expect(steps).toEqual([
      "cap",
      "signer",
      "refetch",
      "expiry",
      "preview",
      "confirm",
      "allowance",
      "fill",
      "done",
    ]);
  });

  test("a fill reports its receipt, its BaseScan link and the order's nonce", async () => {
    const { outcome } = await run(spy());
    if (outcome.status !== "filled") throw new Error("expected a fill");
    expect(outcome.hash).toBe(HASH);
    expect(outcome.explorer).toBe(`https://basescan.org/tx/${HASH}`);
    expect(outcome.nonce).toBe("4242");
    expect(outcome.quote.usdcAmount).toBe(TARGET_FILL_USDC);
  });

  test("a fill with no transaction hash is not reported as a fill", async () => {
    const s = spy({ fillOrder: async () => ({}) });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("CONTRACT_REVERT");
    // The copy must not claim nothing was spent — it may well have landed.
    expect(error.recovery).toContain("may have landed");
  });
});

describe("runFill — the cap runs before the network", () => {
  test("an over-cap amount never touches a single dep", async () => {
    const s = spy();
    const { outcome, steps } = await run(s, MAX_FILL_USDC + 1n);

    expect(failure(outcome).code).toBe("SIZE");
    expect(failure(outcome).step).toBe("cap");
    // The whole point: no signer was asked for, no book was read, nothing was
    // approved. A UI clamp cannot make this claim; a check above the network
    // can.
    expect(s.calls).toEqual([]);
    expect(steps).toEqual(["cap"]);
  });

  test("a zero or negative notional is refused the same way", async () => {
    for (const amount of [0n, -1n]) {
      const s = spy();
      const error = failure((await run(s, amount)).outcome);
      expect(error.code).toBe("SIZE");
      expect(s.calls).toEqual([]);
    }
  });

  test("every rung of the ladder is under the cap", () => {
    for (const rung of FILL_LADDER) expect(rung <= MAX_FILL_USDC).toBe(true);
    expect(TARGET_FILL_USDC).toBe(10_000n); // $0.01, the owner's number
    expect(MAX_FILL_USDC).toBe(2_000000n); // $2.00
  });
});

describe("runFill — the mock wallet is inert", () => {
  test("it is refused before getSigner is even called", async () => {
    const s = spy({ walletId: "mock" });
    const { outcome, steps } = await run(s);

    const error = failure(outcome);
    expect(error.code).toBe("SIGNER_REQUIRED");
    expect(error.step).toBe("signer");
    expect(error.message).toContain("mock wallet cannot sign");
    // Never approves, never fills — and never even reaches the mock's own
    // `getSigner`, whose throw would otherwise be read as "wrong network".
    expect(s.calls).toEqual([]);
    expect(steps).toEqual(["cap", "signer"]);
  });
});

describe("runFill — the signer seam", () => {
  test("null means not connected, and the recovery is to connect", async () => {
    const s = spy({ getSigner: async () => null });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("SIGNER_REQUIRED");
    expect(error.action).toBe("connect");
    expect(s.calls).toEqual(["getSigner"]);
  });

  test("a throw means the wrong chain, and the recovery is to switch", async () => {
    const s = spy({
      getSigner: async () => {
        throw new Error("wallet is on chain 1, not 8453");
      },
    });
    const error = failure((await run(s)).outcome);
    // Same code — there is still no usable signer — but a different verb.
    // `WalletSource.getSigner` throws rather than returning null for exactly
    // this reason (`src/data/wallet.ts`).
    expect(error.code).toBe("SIGNER_REQUIRED");
    expect(error.action).toBe("switch");
    expect(error.message).toContain("not on Base");
  });
});

describe("runFill — the fresh order", () => {
  test("an order that has left the book is ORDER_EXPIRED, and nothing is signed", async () => {
    const s = spy({ refetchOrder: async () => null });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("ORDER_EXPIRED");
    expect(error.step).toBe("refetch");
    // The copy has to explain the misdirection, because the on-chain revert
    // for this case says "Signer Not Authorized" and points at the wallet.
    expect(error.recovery).toContain("Signer Not Authorized");
    expect(s.calls).toEqual(["getSigner", "refetchOrder"]);
  });

  test("the order is frozen on arrival — mutation throws rather than silently invalidating the signature", async () => {
    const s = spy();
    await run(s);

    const [previewed] = s.previewArgs[0]!;
    const [filled] = s.fillArgs[0]!;
    expect(Object.isFrozen(previewed)).toBe(true);
    expect(Object.isFrozen(filled)).toBe(true);
    // The same object all the way through: preview, confirm, approve and fill
    // must all be about one order.
    expect(filled).toBe(previewed);

    // Three levels deep, because that is how deep the mutable parts go. Each
    // of these would change the bytes the maker signed over.
    expect(() => {
      (filled.order as { price: bigint }).price = 1n;
    }).toThrow();
    expect(() => {
      (filled.rawApiData as { isCall: boolean }).isCall = false;
    }).toThrow();
    expect(() => {
      filled.rawApiData!.strikes!.push("1");
    }).toThrow();
    expect(filled.order.price).toBe(7_140_000n);
  });

  test("freezeOrder is idempotent and returns the same object", () => {
    const order = makeOrder();
    expect(freezeOrder(order)).toBe(order);
    expect(freezeOrder(order)).toBe(order);
  });
});

describe("runFill — the 60s expiry buffer", () => {
  test("an order expiring inside the buffer is refused before it is previewed", async () => {
    const s = spy({
      refetchOrder: async () => makeOrder({ orderExpiryTimestamp: NOW / 1000 + 30 }),
    });
    const { outcome, steps } = await run(s);
    const error = failure(outcome);
    expect(error.code).toBe("ORDER_EXPIRED");
    expect(error.step).toBe("expiry");
    expect(s.calls).toEqual(["getSigner", "refetchOrder"]);
    expect(steps).toEqual(["cap", "signer", "refetch", "expiry"]);
  });

  test("an order with more than a minute left proceeds", async () => {
    const s = spy({
      refetchOrder: async () => makeOrder({ orderExpiryTimestamp: NOW / 1000 + 120 }),
    });
    expect((await run(s)).outcome.status).toBe("filled");
  });

  test("an order that names no expiry at all is not blocked by the buffer", async () => {
    // Absence is not "expired". A book that stops sending the field must not
    // silently make every row unfillable.
    const s = spy({
      refetchOrder: async () => ({
        order: { price: 7_140_000n, isBuyer: true, nonce: 1n },
        rawApiData: { strikes: ["440000000000"], isCall: true, optionBookAddress: BOOK },
      }),
    });
    expect((await run(s)).outcome.status).toBe("filled");
  });
});

describe("runFill — the dust ladder", () => {
  test("climbs $0.01 → $0.10 → $1.00 when the maker will not absorb dust", async () => {
    const seen: bigint[] = [];
    const s = spy({
      previewFillOrder: (_order, amount) => {
        seen.push(amount);
        // The book rejects the two small rungs by quoting zero contracts —
        // which is an ordinary state on a thin book, not an exception.
        return amount >= 1_000_000n ? preview() : preview({ numContracts: 0n });
      },
    });
    const { outcome } = await run(s);

    expect(seen).toEqual([10_000n, 100_000n, 1_000_000n]);
    if (outcome.status !== "filled") throw new Error("expected a fill");
    expect(outcome.quote.usdcAmount).toBe(1_000_000n);
    // And the fill was submitted for the rung that actually previewed.
    expect(s.fillArgs[0]![1]).toBe(1_000_000n);
  });

  test("a ladder that never fills is SIZE, and nothing is approved", async () => {
    const s = spy({ previewFillOrder: () => preview({ numContracts: 0n }) });
    const { outcome } = await run(s);
    const error = failure(outcome);
    expect(error.code).toBe("SIZE");
    expect(error.step).toBe("preview");
    expect(s.calls).toEqual([
      "getSigner",
      "refetchOrder",
      "previewFillOrder",
      "previewFillOrder",
      "previewFillOrder",
    ]);
  });

  test("starting at the top rung does not climb past the cap", async () => {
    const seen: bigint[] = [];
    const s = spy({
      previewFillOrder: (_o, amount) => {
        seen.push(amount);
        return preview({ numContracts: 0n });
      },
    });
    await run(s, MAX_FILL_USDC);
    expect(seen).toEqual([MAX_FILL_USDC]);
  });
});

describe("runFill — the referrer rides every call", () => {
  test("preview and fill both carry it", async () => {
    const s = spy();
    await run(s);
    expect(s.previewArgs[0]![2]).toBe(REFERRER);
    expect(s.fillArgs[0]![2]).toBe(REFERRER);
  });

  test("an unset referrer threads undefined rather than an empty string", async () => {
    const s = spy({ referrer: undefined });
    await run(s);
    expect(s.previewArgs[0]![2]).toBeUndefined();
    expect(s.fillArgs[0]![2]).toBeUndefined();
  });
});

describe("runFill — the approval is exact", () => {
  test("ensureAllowance gets the preview's own totalCollateral, and never MaxUint256", async () => {
    const s = spy();
    await run(s);

    const [token, spender, amount] = s.allowanceArgs[0]!;
    // The token comes from the preview, the spender from the order itself —
    // the OptionBook the maker's signature is over, which outranks any chain
    // config or docs page.
    expect(token).toBe(USDC);
    expect(spender).toBe(BOOK);
    expect(amount).toBe(9_900n);
    expect(amount).not.toBe(MAX_UINT256);
    // And it is the number the human was shown.
    expect(s.confirmArgs[0]!.totalCollateral).toBe(amount);
  });

  test("a null return from ensureAllowance is SUCCESS, not failure", async () => {
    // FINDINGS "0.3.0 delta": `null` means "no approval was needed". Reading it
    // as a failure would report a phantom error on every fill after the first.
    const s = spy({ ensureAllowance: async () => null });
    const { outcome } = await run(s);
    if (outcome.status !== "filled") throw new Error("expected a fill");
    expect(outcome.approvalSkipped).toBe(true);
    expect(s.calls).toContain("fillOrder");
  });

  test("a receipt from ensureAllowance is also success, and is reported as two transactions", async () => {
    const s = spy({ ensureAllowance: async () => ({ hash: "0xapproval" }) });
    const { outcome } = await run(s);
    if (outcome.status !== "filled") throw new Error("expected a fill");
    expect(outcome.approvalSkipped).toBe(false);
  });

  test("an order that names no OptionBook is refused before anything is approved", async () => {
    const s = spy({
      refetchOrder: async () => makeOrder({ optionBookAddress: undefined }),
    });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("CONTRACT_REVERT");
    expect(error.step).toBe("allowance");
    expect(s.calls).not.toContain("ensureAllowance");
    expect(s.calls).not.toContain("fillOrder");
  });
});

describe("runFill — the collateral-decimals guard", () => {
  test("a non-USDC order is refused rather than filled with a mis-scaled amount", async () => {
    // The live Base book is collateralised in four tokens at three decimal
    // scales. "$0.01" against 18-decimal WETH is not one cent.
    const s = spy({ previewFillOrder: () => preview({ collateralToken: OTHER_TOKEN }) });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("SIZE");
    expect(error.message).toContain("not collateralised in USDC");
    expect(s.calls).not.toContain("ensureAllowance");
    expect(s.calls).not.toContain("fillOrder");
  });

  test("with no USDC address configured the guard stands down rather than blocking every fill", async () => {
    const s = spy({
      usdc: undefined,
      previewFillOrder: () => preview({ collateralToken: OTHER_TOKEN }),
    });
    expect((await run(s)).outcome.status).toBe("filled");
  });
});

describe("runFill — the confirm gate", () => {
  test("declining spends nothing and is not an error", async () => {
    const s = spy({ confirm: async () => false });
    const { outcome } = await run(s);
    expect(outcome.status).toBe("cancelled");
    expect(s.calls).not.toContain("ensureAllowance");
    expect(s.calls).not.toContain("fillOrder");
  });

  test("the quote handed to the gate is the quote that gets filled", async () => {
    const s = spy();
    const { outcome } = await run(s);
    if (outcome.status !== "filled") throw new Error("expected a fill");
    expect(s.confirmArgs[0]).toEqual(outcome.quote);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The error map
// ─────────────────────────────────────────────────────────────────────────────

describe("the typed error map — one case per code", () => {
  const cases: [FillCode, unknown][] = [
    ["SIGNER_REQUIRED", new Error("SIGNER_REQUIRED: no signer configured on this client")],
    ["ORDER_EXPIRED", new Error("execution reverted: Signer Not Authorized")],
    ["INSUFFICIENT_BALANCE", new Error("ERC20: transfer amount exceeds balance")],
    ["INSUFFICIENT_ALLOWANCE", new Error("ERC20: insufficient allowance")],
    ["SIZE", new Error("INVALID_PARAMS: numContracts must be greater than zero")],
    ["SLIPPAGE", new Error("execution reverted: slippage exceeded")],
    ["CONTRACT_REVERT", new Error("execution reverted (unknown custom error)")],
    ["NETWORK", Object.assign(new Error("fetch failed"), { code: "NETWORK_ERROR" })],
    ["RATE_LIMIT", Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION" })],
  ];

  for (const [code, error] of cases) {
    test(`${code} classifies, and carries copy plus a recovery`, () => {
      const mapped = classifyFillError(error, "fill");
      expect(mapped.code).toBe(code);
      expect(mapped.step).toBe("fill");
      expect(mapped.message.length).toBeGreaterThan(0);
      expect(mapped.recovery.length).toBeGreaterThan(0);
      expect(mapped.detail).toBeTruthy();
    });
  }

  test("every code in the union has copy — a code with no copy is a spinner", () => {
    const codes: FillCode[] = cases.map(([c]) => c);
    expect(new Set(codes).size).toBe(9);
    expect(Object.keys(FILL_COPY).sort()).toEqual([...codes].sort());
  });

  test('the stale-order revert beats the "signer" reading, because their recoveries are opposite', () => {
    // "Signer Not Authorized" is an order whose maker signature aged out —
    // reconnecting a wallet will never fix it. `SIGNER_REQUIRED` is a wallet
    // that is not there — refreshing the book will never fix that.
    expect(classifyFillError(new Error("Signer Not Authorized"), "fill").code).toBe("ORDER_EXPIRED");
    expect(classifyFillError(new Error("SIGNER_REQUIRED"), "fill").code).toBe("SIGNER_REQUIRED");
  });

  test("a throttled call is RATE_LIMIT and carries the Alchemy hint, not a revert diagnosis", () => {
    const mapped = classifyFillError(
      Object.assign(new Error("could not coalesce error"), { code: "CALL_EXCEPTION" }),
      "refetch",
    );
    expect(mapped.code).toBe("RATE_LIMIT");
    expect(mapped.throttled).toBe(true);
    expect(mapped.recovery).toBe(ALCHEMY_HINT);
  });

  test("a real revert is still a revert even when the error is throttle-shaped", () => {
    const mapped = classifyFillError(
      Object.assign(new Error("execution reverted: Insufficient Collateral"), {
        code: "CALL_EXCEPTION",
      }),
      "fill",
    );
    expect(mapped.code).not.toBe("RATE_LIMIT");
  });

  test("the error surfaces at the step it happened on", async () => {
    const s = spy({
      fillOrder: async () => {
        throw new Error("execution reverted: Signer Not Authorized");
      },
    });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("ORDER_EXPIRED");
    expect(error.step).toBe("fill");
  });

  test("a throw from ensureAllowance never reaches the fill", async () => {
    const s = spy({
      ensureAllowance: async () => {
        throw new Error("ERC20: insufficient allowance");
      },
    });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("INSUFFICIENT_ALLOWANCE");
    expect(s.calls).not.toContain("fillOrder");
  });

  test("runFill never throws, whatever a dep does", async () => {
    for (const key of ["refetchOrder", "previewFillOrder", "confirm", "fillOrder"] as const) {
      const s = spy({
        [key]: () => {
          throw new Error("boom");
        },
      } as Partial<FillDeps>);
      const { outcome } = await run(s);
      expect(outcome.status).toBe("failed");
    }
  });
});

describe("looksThrottled — ported from tnuts-test", () => {
  test("recognises the shapes the public Base RPC actually produces", () => {
    expect(looksThrottled({ code: "CALL_EXCEPTION" })).toBe(true);
    expect(looksThrottled({ code: "SERVER_ERROR" })).toBe(true);
    expect(looksThrottled(new Error("HTTP 429 Too Many Requests"))).toBe(true);
    expect(looksThrottled(new Error("missing revert data in call exception"))).toBe(true);
    // Two levels of wrapping: the SDK wraps ethers, ethers wraps the transport.
    expect(looksThrottled({ cause: { cause: { code: "RATE_LIMIT" } } })).toBe(true);
  });

  test("does not cry throttle at an ordinary revert", () => {
    expect(looksThrottled(new Error("execution reverted: Order Filled"))).toBe(false);
    expect(looksThrottled(null)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Row ↔ order identity
// ─────────────────────────────────────────────────────────────────────────────

describe("row identity — which order a blotter row names", () => {
  test("a live row and the order it was printed from agree", () => {
    expect(rowIdentity(ROW)).toBe("BUY|27SEP|4400|C|0.0714");
    expect(orderIdentity(makeOrder())).toBe(rowIdentity(ROW));
  });

  test("a seeded row names nothing — the mock book is unfillable by construction", () => {
    for (const row of mockMarketSource.orders()) {
      if (row.instrument.endsWith("RANGER")) {
        expect(rowIdentity(row)).toBeNull();
        expect(refFor(row)).toBeNull();
      }
    }
    expect(rowIdentity({ ...ROW, instrument: "ETH-27SEP-RANGER" })).toBeNull();
  });

  test("a different side, price, strike or expiry is a different order", () => {
    const base = rowIdentity(ROW);
    expect(rowIdentity({ ...ROW, side: "SELL" })).not.toBe(base);
    expect(rowIdentity({ ...ROW, px: "0.0715" })).not.toBe(base);
    expect(rowIdentity({ ...ROW, instrument: "ETH-27SEP-4600-C" })).not.toBe(base);
    expect(rowIdentity({ ...ROW, instrument: "ETH-27SEP-4400-P" })).not.toBe(base);
  });

  test("an order with no strikes or no expiry has no identity, so it can never be matched", () => {
    expect(orderIdentity({ order: { price: 1n, isBuyer: true } })).toBeNull();
    expect(
      orderIdentity({ order: { price: 1n, isBuyer: true }, rawApiData: { strikes: [] } }),
    ).toBeNull();
  });
});

describe("formatting — the number shown is the number spent", () => {
  test("USDC renders exactly, without a float round trip", () => {
    expect(usdText(10_000n)).toBe("0.01");
    expect(usdText(100_000n)).toBe("0.10");
    expect(usdText(1_000_000n)).toBe("1.00");
    expect(usdText(2_000000n)).toBe("2.00");
    // The case a `toFixed(4)` would round to "0.0100" and lie by a hundredth.
    expect(usdText(9_950n)).toBe("0.00995");
  });

  test("the referrer split is attribution, never revenue", () => {
    expect(splitLabel(0n)).toBe("SPLIT 0 bps — not yet whitelisted");
    expect(splitLabel(250n)).toBe("SPLIT 250 bps");
    expect(splitLabel(null)).toBe("SPLIT — unread");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The flag-off DOM
// ─────────────────────────────────────────────────────────────────────────────

/** A source that looks live enough for the blotter to be selectable: rows
 *  carry a preview, which is what makes them clickable at all. */
const liveSource: MarketSource = {
  id: "thetanuts · base 8453",
  meta: { ok: true, source: "live", fetchedAt: NOW },
  underlyings: () => ["ETH"],
  pricing: () => [],
  mmPricing: () => [],
  orders: () => [{ ...ROW, preview: { contracts: "0.1500", collateral: "0.99", fillable: true } }],
  spot: () => null,
};

/** Mount `Parlay` and return its HTML, with all effects settled. */
async function deskHtml(props: {
  source?: MarketSource;
  wallet?: { id: string; getSigner: () => Promise<unknown | null> };
  expandRow?: boolean;
}): Promise<string> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Parlay, {
        source: props.source ?? mockMarketSource,
        asset: "ETH",
        onAsset: () => {},
        wallet: props.wallet,
      }),
    );
  });
  // Let the config fetch (and its rejection) settle before reading the DOM.
  await act(async () => {});

  if (props.expandRow) {
    // The blotter row itself: the only clickable div carrying the instrument.
    // Rows are clickable only when the snapshot carried previews at all, which
    // is why `liveSource` gives its one row a `preview`.
    const row = Array.from(container.querySelectorAll<HTMLElement>("div")).find(
      (d) => d.style.cursor === "pointer" && (d.textContent ?? "").includes(ROW.instrument),
    );
    if (!row) throw new Error("no selectable book row on screen");
    await act(async () => row.click());
  }

  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return html;
}

describe("/desk with trading off renders today's DOM", () => {
  const realFetch = globalThis.fetch;

  /** Serve one `/api/config` body for the duration of a render. */
  function serveConfig(body: unknown) {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
  }

  test("no wallet at all is the baseline, and a wallet with the flag off matches it byte for byte", async () => {
    // Today's app: the desk as it renders with no wallet layer wired.
    globalThis.fetch = realFetch;
    const baseline = await deskHtml({});

    // A real wallet, but `THETADUEL_TRADE` unset. Opt-IN means the absence of
    // the flag is the same as the absence of the feature.
    serveConfig({ referrer: REFERRER, features: { trade: false } });
    const flagOff = await deskHtml({ wallet: { id: "injected", getSigner: async () => SIGNER } });
    expect(flagOff).toBe(baseline);

    // A config route that does not exist at all — a static build. Fail closed.
    globalThis.fetch = (async () => {
      throw new Error("no server");
    }) as unknown as typeof globalThis.fetch;
    const noServer = await deskHtml({ wallet: { id: "injected", getSigner: async () => SIGNER } });
    expect(noServer).toBe(baseline);

    globalThis.fetch = realFetch;
  });

  test("the mock wallet never turns trading on, even with the flag set", async () => {
    globalThis.fetch = realFetch;
    const baseline = await deskHtml({});

    // The mock cannot sign and must never approve or fill, so the flag has
    // nothing to enable — and the config is never even asked for.
    serveConfig({ referrer: REFERRER, features: { trade: true } });
    const onMock = await deskHtml({ wallet: { id: "mock", getSigner: async () => null } });
    expect(onMock).toBe(baseline);

    globalThis.fetch = realFetch;
  });

  test("the assertion is not vacuous — the flag on does change the screen", async () => {
    globalThis.fetch = realFetch;
    const baseline = await deskHtml({});

    // No referrer configured, so the footer strip reads nothing off chain and
    // this test opens no socket.
    serveConfig({ referrer: "", features: { trade: true } });
    const flagOn = await deskHtml({ wallet: { id: "injected", getSigner: async () => SIGNER } });

    expect(flagOn).not.toBe(baseline);
    expect(flagOn).toContain("Referrer attribution");
    expect(flagOn).toContain("Real fills are on the live book rows below");
    expect(baseline).toContain("Read-only preview. No signer connected.");

    globalThis.fetch = realFetch;
  });

  test("with the flag on, a live book row grows the fill flow", async () => {
    serveConfig({ referrer: "", features: { trade: true } });
    const html = await deskHtml({
      source: liveSource,
      wallet: { id: "injected", getSigner: async () => SIGNER },
      expandRow: true,
    });

    expect(html).toContain("Launch attack");
    expect(html).toContain("ETH-27SEP-4400-C");
    // The cap is stated on screen beside the clamped size buttons.
    expect(html).toContain("cap $2.00");

    globalThis.fetch = realFetch;
  });
});
