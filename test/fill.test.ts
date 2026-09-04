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
// The other two thirds of the join, imported so this file can assert the whole
// of it rather than its own end: the server that writes a row's ticker and
// dollar mark, the reducer that keys the duel clock's map, and the score that
// only ever sees the result.
import { buildSnapshot } from "../src/server/thetanuts.ts";
import { usdMarksFromSnapshot } from "../src/server/attest.ts";
import { duelScore } from "../src/engine/score.ts";
import {
  ALCHEMY_HINT,
  DROP_COPY,
  FILL_COPY,
  FILL_LADDER,
  MAX_FILL_USDC,
  MAX_UINT256,
  PARTIAL_FILL_POLICY,
  TARGET_FILL_USDC,
  cardLabel,
  classifyFillError,
  contracts as contractText,
  filledLegsFor,
  createLiveFillDeps,
  freezeOrder,
  hydrateOrder,
  legFromCard,
  looksThrottled,
  orderIdentity,
  refFor,
  rowIdentity,
  runFill,
  runParlayFill,
  splitLabel,
  usdText,
  type FillCode,
  type FillDeps,
  type FillOutcome,
  type FillQuote,
  type FillStep,
  type ParlayFillLeg,
  type ParlayFillResult,
  type ParlayLegState,
  type ParlaySlipQuote,
  type RawFillOrder,
  type RawFillPreview,
} from "../src/desk/fill.ts";
import { Parlay, ParlayLegChip } from "../src/views/Parlay.tsx";
import type { OrderRow, PricingRow } from "../src/types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const OTHER_TOKEN = "0x4200000000000000000000000000000000000006"; // WETH on Base, 18dp
const BOOK = "0x0000000000000000000000000000000000000B00";
/** The address a compromised indexer would attach to an order to collect an
 *  approval it has no business collecting. Never approved — see BUG-3. */
const EVIL_BOOK = "0x00000000000000000000000000000000BADbAD00";
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

/**
 * A preview that fills: 0.15 contracts for $0.0099 of USDC.
 *
 * `numContracts` is **6dp** — `previewFillOrder` divides a USDC 6dp notional by
 * an 8dp price and the quotient is collateral-scaled (the SDK's own `@returns`:
 * "Number of contracts (6 decimals for USDC collateral)"). This stub used to
 * say `150_000_000_000_000_000n` and call it 0.15, which is 0.15 only at 18dp —
 * a scale nothing on this path produces. `150_000n` is what the real SDK
 * answers for a $0.01 notional against a $0.0667 contract.
 */
function preview(over: Partial<RawFillPreview> = {}): RawFillPreview {
  return {
    numContracts: 150_000n,
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
  /** The slip quotes handed to `confirmSlip`. Exactly one, for a whole slip. */
  slipArgs: ParlaySlipQuote[];
  /** `calls`, copied at the instant the slip gate was asked. What is NOT in
   *  here is the assertion: no approval and no fill may precede a confirm. */
  callsAtConfirm: string[];
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
  const slipArgs: ParlaySlipQuote[] = [];
  let callsAtConfirm: string[] = [];

  const base: FillDeps = {
    walletId: "injected",
    referrer: REFERRER,
    usdc: USDC,
    // The chain-configured OptionBook — the approval spender, and the anchor
    // every order's own `optionBookAddress` is checked against
    // (`docs/reviews/mcp-crosscheck.md` §BUG-3). The live adapter reads it off
    // `chainConfig` when it builds the client at step 2, so by step 7 it is
    // always there; a `FillDeps` without one refuses to approve anything, which
    // is its own test below.
    optionBook: BOOK,
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
      callsAtConfirm = [...calls];
      confirmArgs.push(quote);
      return merged.confirm(quote);
    },
    // Only wrapped when the caller actually supplied one, so a `FillDeps`
    // without it still exercises `runParlayFill`'s fallback to the single-leg
    // `confirm` gate — which must still be ONE confirmation, not N.
    ...(merged.confirmSlip
      ? {
          confirmSlip: async (slip: ParlaySlipQuote) => {
            calls.push("confirmSlip");
            callsAtConfirm = [...calls];
            slipArgs.push(slip);
            return merged.confirmSlip!(slip);
          },
        }
      : {}),
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

  return {
    deps,
    calls,
    previewArgs,
    allowanceArgs,
    fillArgs,
    confirmArgs,
    slipArgs,
    get callsAtConfirm() {
      return callsAtConfirm;
    },
  };
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

  test("the EARLIER of the two expiry fields binds, not the first one present", async () => {
    // An order runs on two clocks: `rawApiData.orderExpiryTimestamp` is when
    // the maker's signature dies, `order.expiry` is when the option settles.
    // The SDK's `fillOrder` checks BOTH (mcp-crosscheck OPPORTUNITY 10); this
    // used to take whichever was present first, which let a signature-valid
    // order with a nearly-settled option through. Here the signature has an
    // hour and the option has thirty seconds.
    const s = spy({
      refetchOrder: async () => {
        const fresh = makeOrder({ orderExpiryTimestamp: NOW / 1000 + 3600 });
        return { ...fresh, order: { ...fresh.order, expiry: BigInt(NOW / 1000 + 30) } };
      },
    });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("ORDER_EXPIRED");
    expect(error.step).toBe("expiry");
    expect(s.calls).not.toContain("previewFillOrder");
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
    // The token comes from the preview; the spender is the CHAIN-CONFIGURED
    // OptionBook, never the address the book's API attached to the order. See
    // `docs/reviews/mcp-crosscheck.md` §BUG-3 and the mismatch test below.
    expect(token).toBe(USDC);
    expect(spender).toBe(BOOK);
    expect(spender).toBe(s.deps.optionBook!);
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

  test("an order that names no OptionBook uses the chain's, exactly as the SDK does", async () => {
    // `resolveOptionBookTarget` (`dist/index.js:1561-1582`) returns the
    // canonical address unchanged when `rawApiData.optionBookAddress` is absent
    // — a missing claim is not a conflicting one. We mirror that.
    const s = spy({
      refetchOrder: async () => makeOrder({ optionBookAddress: undefined }),
    });
    expect((await run(s)).outcome.status).toBe("filled");
    expect(s.allowanceArgs[0]![1]).toBe(BOOK);
  });

  test("an order naming a DIFFERENT OptionBook is refused before anything is approved", async () => {
    // BUG-3. The threat the SDK names in its own source: a compromised API
    // redirects the fill "to an attacker contract that drains pre-existing
    // allowances". We approve before we fill, so the approval is the half worth
    // stealing — and this order never gets one.
    const s = spy({
      refetchOrder: async () => makeOrder({ optionBookAddress: EVIL_BOOK }),
    });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("CONTRACT_REVERT");
    expect(error.step).toBe("allowance");
    expect(error.message).toContain("different OptionBook");
    expect(error.detail).toContain(EVIL_BOOK);
    expect(s.calls).not.toContain("ensureAllowance");
    expect(s.calls).not.toContain("fillOrder");
  });

  test("the same address in a different case is not a mismatch", async () => {
    const s = spy({
      refetchOrder: async () => makeOrder({ optionBookAddress: BOOK.toUpperCase() }),
    });
    expect((await run(s)).outcome.status).toBe("filled");
    // The canonical spelling is what gets approved, not the order's.
    expect(s.allowanceArgs[0]![1]).toBe(BOOK);
  });

  test("with no chain-configured OptionBook nothing is approved at all", async () => {
    // No anchor means nothing to validate against. The old code approved to
    // whatever the order named in this situation; that is the doctrine BUG-3
    // reversed.
    const s = spy({ optionBook: undefined });
    const error = failure((await run(s)).outcome);
    expect(error.code).toBe("CONTRACT_REVERT");
    expect(error.step).toBe("allowance");
    expect(error.message).toContain("OptionBook address is unknown");
    expect(s.calls).not.toContain("ensureAllowance");
    expect(s.calls).not.toContain("fillOrder");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The live adapter — the one place the real SDK is constructed
// ─────────────────────────────────────────────────────────────────────────────

/**
 * BUG-1, pinned against the shipped SDK rather than against a description of it.
 *
 * This is the one test in the file that touches
 * `@thetanuts-finance/thetanuts-client` for real, and it can, because
 * `new ThetanutsClient(...)` opens no socket: it stores a provider (ethers'
 * `JsonRpcProvider` constructor is lazy) and builds its modules. What it *did*
 * do, before the fix, is throw — and it threw here, under `bun test`, with no
 * faking at all, because `test/setup.ts` registers happy-dom and happy-dom
 * gives us a real `window.localStorage`, exactly as a browser does.
 *
 * `docs/reviews/mcp-crosscheck.md` §BUG-1 for the mechanism: `rfqKeys` is
 * built eagerly in the constructor and `getDefaultStorageProvider()` throws
 * `INVALID_KEY` rather than falling back to localStorage, contrary to a stale
 * `.d.ts` doc comment.
 */
describe("createLiveFillDeps constructs a browser client that actually constructs", () => {
  test("the environment this test runs in is browser-shaped, which is the point", () => {
    // If this ever stops being true the test below stops proving anything.
    expect(typeof globalThis.window).toBe("object");
    expect(globalThis.window.localStorage).toBeTruthy();
  });

  test("getSigner builds the client instead of throwing INVALID_KEY", async () => {
    const deps = createLiveFillDeps({ id: "injected", getSigner: async () => SIGNER });
    // Before the fix this rejected with `InvalidKeyError` — and `runFill` step 2
    // reads a throw from `getSigner` as "connected, wrong chain", so the panel
    // told a user already on Base to switch to Base, forever.
    const signer = await deps.getSigner();
    expect(signer).toBe(SIGNER);
  });

  test("and it fills in both chain-config anchors the later steps depend on", async () => {
    const deps = createLiveFillDeps({ id: "injected", getSigner: async () => SIGNER });
    await deps.getSigner();
    // Base mainnet USDC and the chain-configured OptionBook, straight off
    // `client.chainConfig`. The second is the BUG-3 approval spender.
    expect(deps.usdc?.toLowerCase()).toBe(USDC.toLowerCase());
    expect(deps.optionBook).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  test("a wallet that cannot produce a signer builds no client at all", async () => {
    const deps = createLiveFillDeps({ id: "injected", getSigner: async () => null });
    expect(await deps.getSigner()).toBeNull();
    expect(deps.usdc).toBeUndefined();
    expect(deps.optionBook).toBeUndefined();
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
// The parlay — N independent fills, one transaction each
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A parlay has no atomic path: the seven physical multi-leg implementations on
 * Base are the zero address (FINDINGS §3), so a slip is N vanilla fills and the
 * only honest design is a declared degradation policy. These tests pin the four
 * properties that make that survivable rather than reckless:
 *
 *  - the cap is on the **sum**, checked above the network, so a slip cannot
 *    walk over a $2 bound one legal $1 step at a time;
 *  - a stale leg is dropped **before** the first signature, never after;
 *  - each leg approves **exactly its own** collateral, never `MaxUint256` and
 *    never one aggregate approval the failed legs would leave live;
 *  - a failed leg keeps what landed and the loop **continues** — nothing is
 *    unwound, because unwinding turns a failed leg into a realised loss.
 */

/** One slip leg. Every call gets a fresh order — `freezeOrder` freezes in
 *  place, and a shared fixture would carry that across tests. */
function pleg(id: string, over: Partial<ParlayFillLeg> = {}): ParlayFillLeg {
  return {
    id,
    label: `ETH-27SEP-4400-C·${id}`,
    order: makeOrder(),
    usdcAmount: TARGET_FILL_USDC,
    ...over,
  };
}

/** Drive one slip, collecting the ladder as it arrives. */
async function runSlip(
  s: Spy,
  legs: readonly ParlayFillLeg[],
): Promise<{
  result: ParlayFillResult;
  steps: FillStep[];
  ladders: readonly (readonly ParlayLegState[])[];
}> {
  const steps: FillStep[] = [];
  const ladders: (readonly ParlayLegState[])[] = [];
  const result = await runParlayFill(legs, s.deps, (ladder, step) => {
    ladders.push(ladder);
    steps.push(step);
  });
  return { result, steps, ladders };
}

/** Consecutive duplicates collapsed: the *phases* the sequence walked, rather
 *  than every ladder repaint inside them. */
function phases(steps: readonly FillStep[]): FillStep[] {
  return steps.filter((s, i) => s !== steps[i - 1]);
}

/** The leg state carrying this id, or a readable failure. */
function legState(result: ParlayFillResult, id: string): ParlayLegState {
  const found = result.legs.find((l) => l.id === id);
  if (!found) throw new Error(`no leg ${id} in [${result.legs.map((l) => l.id).join(", ")}]`);
  return found;
}

describe("runParlayFill — the sequence", () => {
  test("previews every leg first, confirms once, then fills one leg at a time", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result, steps } = await runSlip(s, [pleg("a"), pleg("b")]);

    expect(result.status).toBe("filled");
    // Both previews land BEFORE the confirmation, and each leg's approval is
    // immediately followed by its own fill — two transactions, in order, with
    // nothing batched and nothing atomic pretended.
    expect(s.calls).toEqual([
      "getSigner",
      "previewFillOrder",
      "previewFillOrder",
      "confirmSlip",
      "ensureAllowance",
      "fillOrder",
      "ensureAllowance",
      "fillOrder",
    ]);
    expect(phases(steps)).toEqual([
      "cap",
      "signer",
      "preview",
      "expiry",
      "confirm",
      "allowance",
      "fill",
      "allowance",
      "fill",
      "done",
    ]);
  });

  test("every landed leg carries its own hash, BaseScan link and nonce", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [pleg("a"), pleg("b")]);

    expect(result.filled).toHaveLength(2);
    for (const leg of result.filled) {
      expect(leg.status).toBe("filled");
      expect(leg.hash).toBe(HASH);
      // A hash nobody can open is not evidence. This is the artifact.
      expect(leg.explorer).toBe(`https://basescan.org/tx/${HASH}`);
      expect(leg.nonce).toBe("4242");
    }
    expect(result.spent).toBe(9_900n * 2n);
    expect(result.totalDebit).toBe(9_900n * 2n);
  });

  test("the ladder walks pending → previewed → approved → filled, and is reported at each step", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { ladders } = await runSlip(s, [pleg("a")]);

    // Every distinct status the one leg passed through, in the order seen.
    const seen: string[] = [];
    for (const ladder of ladders) {
      const status = ladder[0]!.status;
      if (status !== seen[seen.length - 1]) seen.push(status);
    }
    expect(seen).toEqual(["pending", "previewed", "approved", "filled"]);
    // And the ladder is copied out, not the same mutable array handed back —
    // a React caller that got one array twice would never re-render.
    expect(ladders[0]).not.toBe(ladders[1]);
  });

  test("the whole slip's max loss IS its debit, because every leg is a long option", async () => {
    const s = spy({ confirmSlip: async () => true });
    await runSlip(s, [pleg("a"), pleg("b"), pleg("c")]);
    const slip = s.slipArgs[0]!;
    expect(slip.maxLoss).toBe(slip.totalDebit);
    expect(slip.totalDebit).toBe(9_900n * 3n);
    expect(slip.totalContracts).toBe(150_000n * 3n);
  });

  test("runParlayFill never throws, whatever a dep does", async () => {
    for (const key of ["previewFillOrder", "confirmSlip", "ensureAllowance", "fillOrder"] as const) {
      const s = spy({
        confirmSlip: async () => true,
        [key]: () => {
          throw new Error("boom");
        },
      } as Partial<FillDeps>);
      const { result } = await runSlip(s, [pleg("a")]);
      expect(["refused", "none", "partial", "filled"]).toContain(result.status);
    }
  });
});

describe("runParlayFill — the cap is on the SUM, above the network", () => {
  test("three legs each under the cap, whose total steps over it, never touch a dep", async () => {
    // THE staircase. $1.00 is a legal leg size; three of them is $3.00 through
    // a $2.00 bound, and every individual check passes. A cap that only ever
    // sees one leg at a time is a cap with a staircase next to it.
    const s = spy({ confirmSlip: async () => true });
    const legs = [
      pleg("a", { usdcAmount: 1_000_000n }),
      pleg("b", { usdcAmount: 1_000_000n }),
      pleg("c", { usdcAmount: 1_000_000n }),
    ];
    for (const leg of legs) expect(leg.usdcAmount <= MAX_FILL_USDC).toBe(true);

    const { result, steps } = await runSlip(s, legs);

    expect(result.status).toBe("refused");
    expect(result.error!.code).toBe("SIZE");
    expect(result.error!.step).toBe("cap");
    expect(result.error!.message).toContain("3.00");
    // The whole point: no signer asked for, no book previewed, nothing
    // approved. A UI clamp cannot make this claim.
    expect(s.calls).toEqual([]);
    expect(steps).toEqual(["cap"]);
  });

  test("a single leg over the cap is refused before any dep too", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [pleg("a", { usdcAmount: MAX_FILL_USDC + 1n })]);
    expect(result.error!.code).toBe("SIZE");
    expect(result.error!.step).toBe("cap");
    expect(s.calls).toEqual([]);
  });

  test("a sum exactly at the cap is allowed — the bound is inclusive", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [
      pleg("a", { usdcAmount: 1_000_000n }),
      pleg("b", { usdcAmount: 1_000_000n }),
    ]);
    expect(result.status).toBe("filled");
  });

  test("zero, negative and empty slips are refused the same way", async () => {
    for (const legs of [[], [pleg("a", { usdcAmount: 0n })], [pleg("a", { usdcAmount: -1n })]]) {
      const s = spy({ confirmSlip: async () => true });
      const { result } = await runSlip(s, legs);
      expect(result.status).toBe("refused");
      expect(result.error!.code).toBe("SIZE");
      expect(s.calls).toEqual([]);
    }
  });

  test("the cap is re-checked on the PREVIEWED sum, before the confirmation", async () => {
    // Defence in depth against the one thing the pre-network check cannot see:
    // what the book actually quotes back. `previewFillOrder` sets
    // `totalCollateral` from the amount we passed (mcp-crosscheck OPPORTUNITY
    // 11), so today these agree — which is exactly why keeping the check costs
    // nothing for the day they do not.
    const s = spy({
      confirmSlip: async () => true,
      previewFillOrder: () => preview({ totalCollateral: 1_500_000n }),
    });
    const { result } = await runSlip(s, [pleg("a"), pleg("b")]);

    expect(result.status).toBe("refused");
    expect(result.error!.code).toBe("SIZE");
    expect(result.error!.step).toBe("cap");
    // Previewed, and then refused — with nothing confirmed, approved or filled.
    expect(s.calls).toEqual(["getSigner", "previewFillOrder", "previewFillOrder"]);
  });
});

describe("runParlayFill — the mock wallet is inert", () => {
  test("it is refused before getSigner is even called", async () => {
    const s = spy({ walletId: "mock", confirmSlip: async () => true });
    const { result, steps } = await runSlip(s, [pleg("a"), pleg("b")]);

    expect(result.status).toBe("refused");
    expect(result.error!.code).toBe("SIGNER_REQUIRED");
    expect(result.error!.message).toContain("mock wallet cannot sign");
    expect(s.calls).toEqual([]);
    expect(steps).toEqual(["cap", "signer"]);
  });
});

describe("runParlayFill — stale legs are dropped before the first signature", () => {
  test("a leg expiring inside the buffer never reaches an approval, and the slip carries on", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [
      pleg("fresh"),
      pleg("stale", { order: makeOrder({ orderExpiryTimestamp: NOW / 1000 + 30 }) }),
    ]);

    const stale = legState(result, "stale");
    expect(stale.status).toBe("dropped");
    expect(stale.dropped).toBe("EXPIRED");
    // Filling a stale order reverts "Signer Not Authorized", which reads as a
    // wallet fault and is not one. Dropping it before the signature is what
    // stops the player from paying gas to learn that.
    expect(DROP_COPY.EXPIRED).toContain("stale order reverts");

    expect(legState(result, "fresh").status).toBe("filled");
    expect(result.status).toBe("filled");
    // Exactly one approval and one fill — the stale leg reached neither.
    expect(s.allowanceArgs).toHaveLength(1);
    expect(s.fillArgs).toHaveLength(1);
    // And the drop was already visible on the confirm screen.
    expect(s.slipArgs[0]!.legs.map((l) => l.id)).toEqual(["fresh"]);
    expect(s.slipArgs[0]!.dropped.map((l) => l.id)).toEqual(["stale"]);
  });

  test("the EARLIER of the two expiry clocks binds, exactly as it does for one leg", async () => {
    const fresh = makeOrder({ orderExpiryTimestamp: NOW / 1000 + 3600 });
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [
      pleg("a", {
        // Signature good for an hour, option settles in thirty seconds.
        order: { ...fresh, order: { ...fresh.order, expiry: BigInt(NOW / 1000 + 30) } },
      }),
    ]);
    expect(result.status).toBe("refused");
    expect(result.error!.code).toBe("ORDER_EXPIRED");
    expect(s.calls).not.toContain("ensureAllowance");
  });

  test("a leg that names no expiry at all is not blocked by the buffer", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [
      pleg("a", {
        order: {
          order: { price: 7_140_000n, isBuyer: true, nonce: 1n },
          rawApiData: { strikes: ["440000000000"], isCall: true, optionBookAddress: BOOK },
        },
      }),
    ]);
    expect(result.status).toBe("filled");
  });

  test("a slip whose every leg goes stale is refused before the confirmation", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [
      pleg("a", { order: makeOrder({ orderExpiryTimestamp: NOW / 1000 + 30 }) }),
      pleg("b", { order: makeOrder({ orderExpiryTimestamp: NOW / 1000 + 10 }) }),
    ]);
    expect(result.status).toBe("refused");
    expect(result.error!.code).toBe("ORDER_EXPIRED");
    // No human is asked to confirm a slip with nothing in it.
    expect(s.calls).not.toContain("confirmSlip");
    expect(s.calls).not.toContain("ensureAllowance");
  });
});

describe("runParlayFill — legs the book will not honour are dropped, not fatal", () => {
  test("a leg the maker will not absorb is dropped and the rest fills", async () => {
    const s = spy({
      confirmSlip: async () => true,
      // The second leg is quoted zero contracts — an ordinary state on a thin
      // book, and not an exception.
      previewFillOrder: (order) =>
        order.order.nonce === 7n ? preview({ numContracts: 0n }) : preview(),
    });
    const thin = makeOrder();
    const { result } = await runSlip(s, [
      pleg("a"),
      pleg("thin", { order: { ...thin, order: { ...thin.order, nonce: 7n } } }),
    ]);

    expect(legState(result, "thin").status).toBe("dropped");
    expect(legState(result, "thin").dropped).toBe("NO_FILL");
    expect(result.status).toBe("filled");
    expect(s.fillArgs).toHaveLength(1);
  });

  test("a preview that throws drops its own leg and carries the mapped code", async () => {
    let seen = 0;
    const s = spy({
      confirmSlip: async () => true,
      previewFillOrder: () => {
        if (seen++ === 0) throw new Error("INVALID_PARAMS: numContracts must be greater than zero");
        return preview();
      },
    });
    const { result } = await runSlip(s, [pleg("bad"), pleg("good")]);

    const bad = legState(result, "bad");
    expect(bad.status).toBe("dropped");
    expect(bad.error!.code).toBe("SIZE");
    expect(legState(result, "good").status).toBe("filled");
  });

  test("a non-USDC leg is dropped rather than filled with a mis-scaled amount", async () => {
    let first = true;
    const s = spy({
      confirmSlip: async () => true,
      previewFillOrder: () => {
        const out = first ? preview({ collateralToken: OTHER_TOKEN }) : preview();
        first = false;
        return out;
      },
    });
    const { result } = await runSlip(s, [pleg("weth"), pleg("usdc")]);
    expect(legState(result, "weth").dropped).toBe("COLLATERAL");
    expect(s.allowanceArgs).toHaveLength(1);
    expect(s.allowanceArgs[0]![0]).toBe(USDC);
  });

  test("a leg naming a DIFFERENT OptionBook is dropped and never approved", async () => {
    // BUG-3, held per leg: one compromised order says nothing about the other
    // three, but it must never reach `ensureAllowance` — we approve before we
    // fill, so the approval is the half worth stealing.
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [
      pleg("evil", { order: makeOrder({ optionBookAddress: EVIL_BOOK }) }),
      pleg("good"),
    ]);

    const evil = legState(result, "evil");
    expect(evil.status).toBe("dropped");
    expect(evil.dropped).toBe("BOOK_MISMATCH");
    expect(evil.error!.detail).toContain(EVIL_BOOK);
    expect(s.allowanceArgs).toHaveLength(1);
    expect(s.allowanceArgs[0]![1]).toBe(BOOK);
    expect(legState(result, "good").status).toBe("filled");
  });

  test("with no chain-configured OptionBook the slip stops before it previews anything", async () => {
    const s = spy({ optionBook: undefined, confirmSlip: async () => true });
    const { result } = await runSlip(s, [pleg("a")]);
    expect(result.status).toBe("refused");
    expect(result.error!.message).toContain("OptionBook address is unknown");
    expect(s.calls).toEqual(["getSigner"]);
  });
});

describe("runParlayFill — one confirmation for the whole slip", () => {
  test("three legs, one gate, and it carries the list, the debit, the max loss and the policy", async () => {
    const s = spy({ confirmSlip: async () => true });
    await runSlip(s, [pleg("a"), pleg("b"), pleg("c")]);

    expect(s.calls.filter((c) => c === "confirmSlip")).toHaveLength(1);
    expect(s.calls.filter((c) => c === "confirm")).toHaveLength(0);

    const slip = s.slipArgs[0]!;
    expect(slip.legs.map((l) => l.id)).toEqual(["a", "b", "c"]);
    expect(slip.totalDebit).toBe(29_700n);
    expect(slip.maxLoss).toBe(29_700n);
    // §D2 — the policy is a value on the quote, so a confirm screen physically
    // cannot render the number without being handed the sentence beside it.
    expect(slip.policy).toBe(PARTIAL_FILL_POLICY);
    expect(slip.policy).toContain("you keep the ones that landed");
  });

  test("the policy reaches the player BEFORE the first signature", async () => {
    // The property, not the prose: at the instant the gate was asked, nothing
    // had been approved and nothing had been filled.
    const s = spy({ confirmSlip: async () => true });
    await runSlip(s, [pleg("a"), pleg("b")]);
    expect(s.callsAtConfirm).not.toContain("ensureAllowance");
    expect(s.callsAtConfirm).not.toContain("fillOrder");
    expect(s.callsAtConfirm[s.callsAtConfirm.length - 1]).toBe("confirmSlip");
  });

  test("without a slip gate it falls back to ONE aggregate confirm, not N of them", async () => {
    const s = spy();
    const { result } = await runSlip(s, [pleg("a"), pleg("b"), pleg("c")]);

    expect(result.status).toBe("filled");
    expect(s.calls.filter((c) => c === "confirm")).toHaveLength(1);
    // The aggregate is the whole slip, so the fallback cannot understate what
    // is about to be spent.
    expect(s.confirmArgs[0]!.totalCollateral).toBe(29_700n);
    expect(s.confirmArgs[0]!.usdcAmount).toBe(TARGET_FILL_USDC * 3n);
  });

  test("declining spends nothing, approves nothing and is not an error", async () => {
    const s = spy({ confirmSlip: async () => false });
    const { result } = await runSlip(s, [pleg("a"), pleg("b")]);

    expect(result.status).toBe("cancelled");
    expect(result.spent).toBe(0n);
    expect(s.calls).not.toContain("ensureAllowance");
    expect(s.calls).not.toContain("fillOrder");
  });
});

describe("runParlayFill — the approval is exact, per leg", () => {
  test("each leg approves its own totalCollateral — never MaxUint256, never the slip total", async () => {
    // Two legs at different sizes, so an aggregate approval would be visibly
    // the wrong number rather than coincidentally the right one.
    const s = spy({
      confirmSlip: async () => true,
      previewFillOrder: (_order, amount) =>
        preview({ totalCollateral: amount, numContracts: amount * 10n }),
    });
    const { result } = await runSlip(s, [
      pleg("small", { usdcAmount: 10_000n }),
      pleg("large", { usdcAmount: 100_000n }),
    ]);

    expect(result.status).toBe("filled");
    expect(s.allowanceArgs).toHaveLength(2);
    expect(s.allowanceArgs[0]![2]).toBe(10_000n);
    expect(s.allowanceArgs[1]![2]).toBe(100_000n);
    for (const [token, spender, amount] of s.allowanceArgs) {
      expect(token).toBe(USDC);
      // The CHAIN-CONFIGURED OptionBook, never the address an order named.
      expect(spender).toBe(BOOK);
      // The two failures worth naming: an infinite approval, and one aggregate
      // approval that the legs which never fill would leave live.
      expect(amount).not.toBe(MAX_UINT256);
      expect(amount).not.toBe(110_000n);
    }
  });

  test("MaxUint256 is never passed to ensureAllowance, at any slip size", async () => {
    for (const size of [1, 2, 3, 4]) {
      const s = spy({ confirmSlip: async () => true });
      const legs = Array.from({ length: size }, (_, i) => pleg(`l${i}`));
      await runSlip(s, legs);
      for (const [, , amount] of s.allowanceArgs) {
        expect(amount).not.toBe(MAX_UINT256);
        expect(amount).toBe(9_900n);
      }
    }
  });

  test("a null return from ensureAllowance is SUCCESS, and is reported as one transaction", async () => {
    const s = spy({ confirmSlip: async () => true, ensureAllowance: async () => null });
    const { result } = await runSlip(s, [pleg("a")]);
    expect(result.status).toBe("filled");
    expect(result.filled[0]!.approvalSkipped).toBe(true);
  });

  test("a receipt from ensureAllowance is also success, and is reported as two", async () => {
    const s = spy({
      confirmSlip: async () => true,
      ensureAllowance: async () => ({ hash: "0xapproval" }),
    });
    const { result } = await runSlip(s, [pleg("a")]);
    expect(result.filled[0]!.approvalSkipped).toBe(false);
  });

  test("every leg's order is frozen before it is previewed, and the same object is filled", async () => {
    const s = spy({ confirmSlip: async () => true });
    await runSlip(s, [pleg("a"), pleg("b")]);

    for (let i = 0; i < 2; i++) {
      const [previewed] = s.previewArgs[i]!;
      const [filled] = s.fillArgs[i]!;
      expect(Object.isFrozen(previewed)).toBe(true);
      expect(filled).toBe(previewed);
      // Any of these would change the bytes the maker signed over.
      expect(() => {
        (filled.order as { price: bigint }).price = 1n;
      }).toThrow();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rehydration — the browser's strings against the SDK's bigints
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The order exactly as the **browser** holds it.
 *
 * Not hand-written: put through the same replacer `/api/market` uses
 * (`src/server/thetanuts.ts`'s `handle()`), so this is byte-for-byte what a
 * `PricingRow.order` is by the time `legFromCard` puts it on a slip. JSON has
 * no bigint, so `price`, `nonce`, `expiry` and `availableAmount` all arrive as
 * decimal strings — the encoding `FillableOrder` declares.
 */
function wireOrder(over: Partial<RawFillOrder["rawApiData"]> = {}): RawFillOrder {
  return JSON.parse(
    JSON.stringify(makeOrder(over), (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
  ) as RawFillOrder;
}

/**
 * `previewFillOrder`, doing the SDK's own arithmetic.
 *
 * The two expressions that decide whether a wire order can be filled at all,
 * copied from `dist/index.js`: `calculateNumContracts` is
 * `usdcAmount × 100000000n / order.price` (:1625) and `calculateMaxContracts`
 * is `availableAmount × 100000000n / strike` (:1645). Both mix a bigint literal
 * with an order field, so a **string** in either place throws
 * `TypeError: Cannot mix BigInt and other types`, which is exactly what the
 * real 0.3.0 client does — measured against `test/fixtures/orders.json`:
 * "Invalid mix of BigInt and other type in multiplication".
 *
 * A stub that just returned a canned preview would pass whether or not the
 * order was rehydrated, which is the whole reason this one computes.
 */
function sdkPreview(order: RawFillOrder, usdcAmount: bigint): RawFillPreview {
  const strike = BigInt(order.rawApiData!.strikes![0]!);
  // @ts-expect-error — the point of the test: `string | bigint` against 1e8n is
  // what the SDK does and what a wire order fails at. TS is right to object.
  const maxContracts = (order.availableAmount! * 100_000000n) / strike;
  // @ts-expect-error — see above.
  const numContracts = (usdcAmount * 100_000000n) / order.order.price;
  return {
    numContracts: numContracts < maxContracts ? numContracts : maxContracts,
    totalCollateral: usdcAmount,
    collateralToken: USDC,
  };
}

describe("runParlayFill — the wire's strings are rehydrated before the SDK sees them", () => {
  test("a string-encoded order reaches previewFillOrder and fillOrder as bigints", async () => {
    // Against the pre-fix code this test fails at the first leg: `sdkPreview`
    // throws on `"7140000" * 100000000n`, the leg drops NO_FILL, and the slip
    // ends `none` having filled nothing. That was the live parlay path.
    const s = spy({ confirmSlip: async () => true, previewFillOrder: sdkPreview });
    const { result } = await runSlip(s, [
      { ...pleg("a"), order: wireOrder() },
      { ...pleg("b"), order: wireOrder() },
    ]);

    expect(result.status).toBe("filled");
    expect(result.dropped).toHaveLength(0);
    expect(result.filled).toHaveLength(2);

    for (let i = 0; i < 2; i++) {
      const [previewed] = s.previewArgs[i]!;
      const [filled] = s.fillArgs[i]!;
      // The four fields the SDK multiplies, as bigints and at their exact
      // values — not `0n`, and not a `Number` that would round a 77-digit
      // nonce.
      expect(typeof previewed.order.price).toBe("bigint");
      expect(previewed.order.price).toBe(7_140_000n);
      expect(previewed.order.expiry).toBe(BigInt(EXPIRY_S));
      expect(previewed.order.nonce).toBe(4242n);
      expect(previewed.availableAmount).toBe(10_000_000n);
      // Still one object from preview through fill, still frozen.
      expect(filled).toBe(previewed);
      expect(Object.isFrozen(previewed)).toBe(true);
      // Everything else carried through verbatim. `rawApiData`'s numbers stay
      // strings on purpose: the SDK runs `BigInt()` over them itself.
      expect(previewed.signature).toBe("0xsignature");
      expect(previewed.makerAddress).toBe("0xmaker");
      expect(previewed.rawApiData!.strikes).toEqual(["440000000000"]);
      expect(previewed.rawApiData!.optionBookAddress).toBe(BOOK);
      expect(previewed.order.isBuyer).toBe(true);
    }

    // Both of the SDK's expressions ran, on the rehydrated fields, and the
    // smaller won — which is the arithmetic, not a canned number:
    //   numContracts = 10_000 × 1e8 / 7_140_000     = 140_056
    //   maxContracts = 10_000_000 × 1e8 / 440000000000 =   2_272
    // The maker has $10 of collateral behind a $4,400 strike, so $0.01 of
    // notional is capped at 0.002272 contracts. `contracts()` renders that
    // "0.0023"; at the old 18dp it would have rendered "0.0000".
    expect(s.previewArgs[0]![1]).toBe(TARGET_FILL_USDC);
    expect(result.filled[0]!.quote!.numContracts).toBe(2_272n);
    expect(contractText(result.filled[0]!.quote!.numContracts)).toBe("0.0023");
  });

  test("an unparseable field drops the leg NO_FILL — it never becomes 0n", async () => {
    const bad = wireOrder();
    // A price the wire should never carry. Anything that is not a decimal
    // integer lands here: `""`, `"0x1f4"`, `"1e10"`, `" 12"`, `null`.
    (bad.order as { price: string }).price = "7.14e6";

    const s = spy({ confirmSlip: async () => true, previewFillOrder: sdkPreview });
    const { result } = await runSlip(s, [
      { ...pleg("a"), order: wireOrder() },
      { ...pleg("b"), order: bad },
      { ...pleg("c"), order: wireOrder() },
    ]);

    const dropped = legState(result, "b");
    expect(dropped.status).toBe("dropped");
    expect(dropped.dropped).toBe("NO_FILL");
    // Nothing was priced for it, so there is no quote to mistake for a zero —
    // this is the difference between "we could not read the order" and "the
    // book is thin", which a `?? 0n` would have erased.
    expect(dropped.quote).toBeUndefined();

    // It never reached the SDK at all: two previews for three legs.
    expect(s.previewArgs).toHaveLength(2);
    expect(s.fillArgs).toHaveLength(2);
    // ...and it was never approved. A leg we cannot price must not spend.
    expect(s.allowanceArgs).toHaveLength(2);

    // The rest of the slip is untouched, which is the graceful half of today's
    // behaviour and must stay.
    expect(result.status).toBe("filled");
    expect(result.filled.map((l) => l.id)).toEqual(["a", "c"]);
    expect(result.spent).toBe(TARGET_FILL_USDC * 2n);
    expect(result.totalDebit).toBe(TARGET_FILL_USDC * 2n);
  });

  test("every field the SDK multiplies fails closed on its own", () => {
    for (const mutate of [
      (o: RawFillOrder) => ((o.order as { price: string }).price = ""),
      (o: RawFillOrder) => ((o.order as { price: string }).price = "0x1f4"),
      (o: RawFillOrder) => ((o.order as { expiry: string }).expiry = "tomorrow"),
      (o: RawFillOrder) => ((o.order as { nonce: string }).nonce = "4_242"),
      (o: RawFillOrder) => ((o as { availableAmount: string }).availableAmount = "1e10"),
      (o: RawFillOrder) => ((o as { availableAmount: unknown }).availableAmount = null),
    ]) {
      const order = wireOrder();
      mutate(order);
      expect(hydrateOrder(order)).toBeNull();
    }
  });

  test("an order that is already bigints is returned unchanged, by identity", () => {
    // The single-leg path never needs rehydrating — `refetchOrder` is
    // `client.api.fetchOrders()` and hands over the SDK's own bigints — so this
    // must be a no-op there, and `freezeOrder` must still freeze the caller's
    // own object rather than a copy nobody else holds.
    const order = makeOrder();
    expect(hydrateOrder(order)).toBe(order);

    // Absent optional fields stay absent rather than becoming `0n` or `null`.
    const minimal: RawFillOrder = { order: { price: "7140000", isBuyer: true } };
    const live = hydrateOrder(minimal)!;
    expect(live.order.price).toBe(7_140_000n);
    expect("expiry" in live.order).toBe(false);
    expect("nonce" in live.order).toBe(false);
    expect("availableAmount" in live).toBe(false);
  });

  test("rehydration cannot move an order's identity — the same string, before and after", () => {
    // `orderIdentity` is what a fill matches an `OrderRow` on, and `OrderRow.side`
    // is byte-identical by contract. `units()` is `Number(BigInt(raw))`, so
    // `BigInt("7140000")` and `7140000n` are the same value and the string it
    // rebuilds cannot move. If this ever fails, every fill fails closed.
    const wire = wireOrder();
    const identity = orderIdentity(makeOrder());
    expect(identity).not.toBeNull();
    expect(orderIdentity(wire)).toBe(identity);
    expect(orderIdentity(hydrateOrder(wire)!)).toBe(identity);
    expect(rowIdentity(ROW)).toBe(identity);
  });
});

describe("runParlayFill — a failed leg keeps what landed and continues", () => {
  test("a mid-slip fill failure does not stop the legs after it, and unwinds nothing", async () => {
    let attempt = 0;
    const s = spy({
      confirmSlip: async () => true,
      fillOrder: async () => {
        // The middle leg reverts. The first is already on chain and the third
        // has not been tried.
        if (++attempt === 2) throw new Error("execution reverted: Signer Not Authorized");
        return { hash: HASH };
      },
    });
    const { result } = await runSlip(s, [pleg("a"), pleg("b"), pleg("c")]);

    expect(result.status).toBe("partial");
    expect(result.filled.map((l) => l.id)).toEqual(["a", "c"]);
    expect(result.failed.map((l) => l.id)).toEqual(["b"]);
    // The mapped code lands on the leg, at the step it happened on — §D3.
    expect(legState(result, "b").error!.code).toBe("ORDER_EXPIRED");
    expect(legState(result, "b").error!.step).toBe("fill");
    // Continued: all three were attempted, in order.
    expect(s.fillArgs).toHaveLength(3);
    expect(s.allowanceArgs).toHaveLength(3);
    // NOT unwound: no extra call of any kind went out after the failure.
    expect(s.calls.filter((c) => c === "fillOrder")).toHaveLength(3);
    // And the debit that was confirmed is not the money that moved.
    expect(result.totalDebit).toBe(29_700n);
    expect(result.spent).toBe(19_800n);
  });

  test("a failed approval fails only its own leg and never reaches that leg's fill", async () => {
    let approvals = 0;
    const s = spy({
      confirmSlip: async () => true,
      ensureAllowance: async () => {
        if (++approvals === 1) throw new Error("ERC20: insufficient allowance");
        return null;
      },
    });
    const { result } = await runSlip(s, [pleg("a"), pleg("b")]);

    expect(legState(result, "a").status).toBe("failed");
    expect(legState(result, "a").error!.code).toBe("INSUFFICIENT_ALLOWANCE");
    expect(legState(result, "a").error!.step).toBe("allowance");
    expect(legState(result, "b").status).toBe("filled");
    // One fill, for the leg that was approved.
    expect(s.fillArgs).toHaveLength(1);
    expect(result.status).toBe("partial");
  });

  test("a fill with no hash is not reported as a fill, and the slip continues", async () => {
    let attempt = 0;
    const s = spy({
      confirmSlip: async () => true,
      fillOrder: async () => (++attempt === 1 ? {} : { hash: HASH }),
    });
    const { result } = await runSlip(s, [pleg("a"), pleg("b")]);

    expect(legState(result, "a").status).toBe("failed");
    // It may well have landed, so the copy must not claim otherwise.
    expect(legState(result, "a").error!.recovery).toContain("may have landed");
    expect(legState(result, "b").status).toBe("filled");
  });

  test("every leg failing is `none`, and the money that moved is zero", async () => {
    const s = spy({
      confirmSlip: async () => true,
      fillOrder: async () => {
        throw new Error("execution reverted");
      },
    });
    const { result } = await runSlip(s, [pleg("a"), pleg("b")]);
    expect(result.status).toBe("none");
    expect(result.spent).toBe(0n);
    expect(result.filled).toHaveLength(0);
  });
});

describe("runParlayFill — the duel clock's join key is copied or absent, never composed", () => {
  /**
   * Two namespaces name the same option on Base and they do not agree: the
   * order book prints `ETH-3SEP-4400-C` and the market-maker chain prints
   * `ETH-3SEP26-2100-C`. `usdMarksFromSnapshot` keys only on the second, because
   * the market-maker quote is the only thing in the snapshot carrying a name, a
   * mark AND the spot to price it in dollars.
   *
   * So the rule this block pins is not "produce the right name" — it is
   * "produce the venue's name or admit you have none". A near-miss key pays the
   * wrong player quietly; an absent key refunds both, which is the direction
   * plan 6 §C3 already chose over a coin flip. The same rule now governs the
   * entry mark, which must be **dollars**: copied from the row's `markUsd` or
   * absent, never a venue mark passed off as money.
   */
  const MM_TICKER = "ETH-27SEP26-4400-C";
  /** 0.0716 ETH at a spot of 2,000 — the dollar price of one contract, which is
   *  what the server writes to `PricingRow.markUsd` and the only mark that may
   *  be divided by a USDC premium. */
  const ENTRY_USD = 143.2;

  test("a venue instrument and a DOLLAR mark ride through to the receipt, verbatim", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [
      pleg("a", { instrument: MM_TICKER, entryMarkUsd: ENTRY_USD }),
    ]);

    expect(result.status).toBe("filled");
    expect(result.filled[0]!.instrument).toBe(MM_TICKER);
    expect(result.filled[0]!.entryMarkUsd).toBe(ENTRY_USD);
    // Nothing landed in `unmarkable`, so the duel clock can read this basket.
    expect(result.unmarkable).toEqual([]);

    const scored = filledLegsFor(result);
    expect(scored).toHaveLength(1);
    // Character for character. The whole point is that this is an assignment.
    expect(scored[0]!.instrument).toBe(MM_TICKER);
    expect(scored[0]!.entryMark as number).toBe(ENTRY_USD);
    // 6dp contracts and 6dp USDC, converted to the units `FilledLeg` names.
    // `contracts` is what `duelScore` multiplies the mark move by, so the scale
    // is not cosmetic: at 18dp this same leg contributed 1.5e11 contracts of
    // PnL, and before the constant was fixed, 1.5e-13.
    expect(scored[0]!.contracts).toBeCloseTo(0.15, 10);
    expect(scored[0]!.premium as number).toBeCloseTo(0.0099, 10);
  });

  test("a leg with no venue name is reported unmarkable rather than given one", async () => {
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [pleg("a", { entryMarkUsd: ENTRY_USD })]);

    expect(result.status).toBe("filled");
    expect(result.filled[0]!.instrument).toBeUndefined();
    expect(result.unmarkable).toEqual(["ETH-27SEP-4400-C·a"]);
    // And it is NOT handed to the scorer under its display label — a label that
    // almost looks like a ticker is worse than none, because it invites a
    // lookup that silently misses.
    expect(filledLegsFor(result)).toEqual([]);
  });

  test("a leg with a name but no dollar mark is unmarkable too — both are required", async () => {
    // This is the "no spot" case in the shape it actually arrives in: the market
    // maker quoted the instrument, published no `underlyingPrice`, so the server
    // wrote a `mark` and no `markUsd`, so the card carried no dollar price. The
    // leg fills, the player holds the option, and the duel refunds.
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [pleg("a", { instrument: MM_TICKER })]);
    expect(result.unmarkable).toHaveLength(1);
    expect(filledLegsFor(result)).toEqual([]);
  });

  test("only LANDED legs are scored — a dropped or failed leg is neither scored nor blamed", async () => {
    const s = spy({
      confirmSlip: async () => true,
      fillOrder: async () => {
        throw new Error("execution reverted");
      },
    });
    const { result } = await runSlip(s, [
      pleg("a", { instrument: MM_TICKER, entryMarkUsd: ENTRY_USD }),
      pleg("stale", {
        instrument: MM_TICKER,
        entryMarkUsd: ENTRY_USD,
        order: makeOrder({ orderExpiryTimestamp: NOW / 1000 + 30 }),
      }),
    ]);
    expect(result.status).toBe("none");
    // Nothing landed, so nothing is scoreable and nothing is unmarkable —
    // "unmarkable" is a claim about positions held, not about attempts made.
    expect(result.unmarkable).toEqual([]);
    expect(filledLegsFor(result)).toEqual([]);
  });

  test("legFromCard copies the card's dollar mark and never fabricates an instrument", () => {
    const card = {
      id: "safe-bull",
      underlying: "ETH",
      strike: "4,400",
      expiry: "27 SEP",
      stance: "bull" as const,
      markUsd: ENTRY_USD,
      row: { order: makeOrder() },
    };
    const leg = legFromCard(card, TARGET_FILL_USDC)!;
    expect(leg.entryMarkUsd).toBe(ENTRY_USD);
    // No ticker on the card, so none on the leg. The label is a display string
    // in this app's own format and is deliberately not either venue's.
    expect(leg.instrument).toBeUndefined();
    expect(leg.label).toBe("ETH-27 SEP-4,400-C");

    // `null` is "no dollar price", not zero — a worthless option and an
    // unpriceable one are different answers.
    expect(legFromCard({ ...card, markUsd: null }, TARGET_FILL_USDC)!.entryMarkUsd).toBeUndefined();
  });

  test("the card seam has no field for a venue mark, so one cannot be passed off as money", () => {
    // Structural, not a convention. `FillableCard` declares `markUsd` and no
    // `mark`: the number `/desk` prints is in units of the underlying, and the
    // way to stop it being divided by a USDC premium is to give it nowhere to
    // sit on the way to `FilledLeg`. A `LiveCard` still carries its own `mark`
    // and still satisfies this interface — it just cannot hand that one over.
    const withVenueMark = {
      id: "safe-bull",
      underlying: "ETH",
      strike: "4,400",
      expiry: "27 SEP",
      stance: "bull" as const,
      mark: 0.0716, //   the venue's number, in ETH — carried, and ignored here
      markUsd: ENTRY_USD,
      row: { order: makeOrder() },
    };
    const leg = legFromCard(withVenueMark, TARGET_FILL_USDC)!;
    expect(leg.entryMarkUsd).toBe(ENTRY_USD);
    expect(leg.entryMarkUsd).not.toBe(0.0716);
  });

  /**
   * ── the whole join, end to end ──────────────────────────────────────────────
   *
   * The two defects met in one place, so this is where they are proved closed:
   * a real market-maker quote goes into `buildSnapshot`, comes out as a pricing
   * row carrying the MM's own ticker and a dollar mark, becomes a card, becomes
   * a leg, is filled, is reduced to a `FilledLeg`, and finally keys into the map
   * the SAME snapshot produces for the attestor — scoring a finite number.
   *
   * Against the code before this change every one of the last three steps was
   * impossible: the row had no ticker, so the leg had no instrument, so the map
   * lookup missed and every duel refunded.
   */
  test("a real MM ticker and dollar mark travel snapshot → card → fill → score", async () => {
    const EXPIRY_UNIX = 1_788_422_400;
    const STRIKE = 2100;
    const TICKER = "ETH-3SEP26-2100-C";

    /** One order resting on exactly the instrument the MM quotes, so the join
     *  has something to attach to. */
    const bookOrder = {
      order: {
        price: "7140000", //             0.0714 USDC per contract, 8dp
        // `isBuyer === true` IS the ask. Measured against the venue's own
        // two-sided quotes over 142 live orders: isBuyer=true rests at
        // 1.58-1.66x the MM mark and NEVER at or below its bid, while
        // isBuyer=false rests at 0.69-0.72x and never at or above the ask.
        // The SDK's own docs contradict each other here; the market does not.
        isBuyer: true, //                an ask: a player can buy it
        nonce: "4242",
        expiry: String(EXPIRY_UNIX), //  the OPTION's expiry, which is the join key
      },
      availableAmount: "10000000000",
      signature: "0xsignature",
      makerAddress: "0xmaker",
      rawApiData: {
        orderExpiryTimestamp: EXPIRY_UNIX,
        strikes: [String(STRIKE * 10 ** 8)],
        isCall: true,
        collateral: USDC,
        priceFeed: "0xfeed",
      },
    };

    const snapshot = buildSnapshot(
      {
        orders: [bookOrder],
        prices: { "ETH/USD": 2375.76 },
        chainConfig: { priceFeeds: { ETH: "0xfeed" }, contracts: { optionBook: null } },
        mmPricing: {
          ETH: [
            {
              ticker: TICKER,
              feeAdjustedBid: 0.1146,
              feeAdjustedAsk: 0.1194,
              markPrice: 0.116552,
              strike: STRIKE,
              expiry: EXPIRY_UNIX,
              isCall: true,
              underlying: "ETH",
              underlyingPrice: 2375.76,
            },
          ],
        },
      },
      NOW,
    );

    // 1. the row carries the MM's own name and the dollar price of a contract.
    const row = snapshot.pricing.ETH![0]!;
    expect(row.markTicker).toBe(TICKER);
    expect(row.mark).toBe("0.1166"); //      the venue's number, in ETH
    expect(row.markUsd).toBe("276.8996"); // 0.116552 × 2375.76, to 4dp
    expect(row.order).toBeDefined();

    // 2. a card built off that row → a leg. Both fields copied, neither made up.
    const leg = legFromCard(
      {
        id: "eth-2100-c",
        underlying: "ETH",
        strike: row.strike,
        expiry: row.expiry,
        stance: "bull",
        instrument: row.markTicker,
        markUsd: Number(row.markUsd),
        row: { order: row.order! },
      },
      TARGET_FILL_USDC,
    )!;
    expect(leg.instrument).toBe(TICKER);
    expect(leg.entryMarkUsd).toBe(276.8996);

    // 3. fill it, and reduce the receipt to what the duel clock scores.
    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [{ ...leg, order: makeOrder() }]);
    expect(result.unmarkable).toEqual([]);
    const scored = filledLegsFor(result);
    expect(scored).toHaveLength(1);

    // 4. THE LOOKUP THAT NEVER USED TO HIT. The map is the attestor's own
    //    reduction of the same snapshot, and the leg's key is in it.
    const marks = usdMarksFromSnapshot(snapshot);
    expect(marks.get(scored[0]!.instrument) as number).toBe(276.8996);

    // 5. and it therefore scores a number instead of refusing. Flat, because
    //    entry and scoring marks came from one snapshot — the point is that it
    //    is finite at all.
    const score = duelScore(scored, marks);
    expect(Number.isNaN(score)).toBe(false);
    expect(score).toBe(0);

    // The counterfactual, stated so the assertion above cannot be read as
    // trivially true: the order book's own name for the same option is a
    // different string, and it marks nothing.
    expect(snapshot.orders[0]!.instrument).not.toBe(TICKER);
    expect(marks.get(snapshot.orders[0]!.instrument)).toBeUndefined();
  });

  test("the same journey with no published spot ends unmarkable, not mis-scored", async () => {
    // One field removed from the quote — `underlyingPrice` — and the whole
    // chain fails closed: no `markUsd` on the row, no dollar mark on the card,
    // no `FilledLeg`, no verdict, both stakes refunded. The player still holds
    // the option; only the duel declines to price it.
    const EXPIRY_UNIX = 1_788_422_400;
    const snapshot = buildSnapshot(
      {
        orders: [],
        prices: { "ETH/USD": 2375.76 },
        chainConfig: { priceFeeds: { ETH: "0xfeed" }, contracts: { optionBook: null } },
        mmPricing: {
          ETH: [
            {
              ticker: "ETH-3SEP26-2100-C",
              feeAdjustedBid: 0.1146,
              feeAdjustedAsk: 0.1194,
              markPrice: 0.116552,
              strike: 2100,
              expiry: EXPIRY_UNIX,
              isCall: true,
              underlying: "ETH",
              // underlyingPrice deliberately absent
            },
          ],
        },
      },
      NOW,
    );
    const quote = snapshot.mmPricing.ETH![0]!;
    expect(quote.mark).toBe("0.1166");
    expect(quote.spot).toBe("—");
    expect(quote.markUsd).toBeUndefined();
    expect(usdMarksFromSnapshot(snapshot).size).toBe(0);

    const s = spy({ confirmSlip: async () => true });
    const { result } = await runSlip(s, [
      pleg("a", { instrument: "ETH-3SEP26-2100-C" }), // name, no dollar mark
    ]);
    expect(result.status).toBe("filled");
    expect(result.unmarkable).toHaveLength(1);
    expect(filledLegsFor(result)).toEqual([]);
  });
});

describe("legFromCard — a card the book cannot fill is not a smaller purchase", () => {
  const card = {
    id: "safe-bull",
    underlying: "ETH",
    strike: "4,400",
    expiry: "27 SEP",
    stance: "bull" as const,
  };

  test("a card with a resting order becomes a leg", () => {
    const leg = legFromCard({ ...card, row: { order: makeOrder() } }, TARGET_FILL_USDC);
    expect(leg).not.toBeNull();
    expect(leg!.id).toBe("safe-bull");
    expect(leg!.usdcAmount).toBe(TARGET_FILL_USDC);
  });

  test("a card with no order is null, not a leg with an absent order", () => {
    expect(legFromCard({ ...card, row: {} }, TARGET_FILL_USDC)).toBeNull();
  });

  test("the label names the instrument, and a bear card is a put", () => {
    expect(cardLabel({ ...card, row: {} })).toBe("ETH-27 SEP-4,400-C");
    expect(cardLabel({ ...card, stance: "bear", row: {} })).toBe("ETH-27 SEP-4,400-P");
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

/**
 * A source whose option chain carries fillable orders.
 *
 * `PricingRow.order` is what makes a level pressable — a level built from bids
 * or from MM pricing alone has nothing to buy. The mock sets it on nothing,
 * which is what keeps the seeded book unfillable by construction; this fixture
 * is the live shape.
 */
function chainRow(over: Partial<PricingRow> = {}): PricingRow {
  return {
    type: "CALL",
    strike: "4,400",
    expiry: "27 SEP",
    bid: "0.0710",
    ask: "0.0714",
    iv: "58.2%",
    delta: "0.70",
    depth: 60,
    size: "10.0k",
    order: makeOrder(),
    ...over,
  };
}

const slipSource: MarketSource = {
  id: "thetanuts · base 8453",
  meta: { ok: true, source: "live", fetchedAt: NOW },
  underlyings: () => ["ETH"],
  pricing: () => [
    chainRow(),
    chainRow({ strike: "4,600", delta: "0.45", ask: "0.0402" }),
    chainRow({ type: "PUT", strike: "4,200", delta: "−0.28", ask: "0.0255" }),
  ],
  mmPricing: () => [],
  orders: () => [ROW],
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

  test("a chain with fillable orders still renders today's DOM with the flag off", async () => {
    // The slip is opt-IN too: an order on a `PricingRow` is not consent, the
    // flag plus a wallet is.
    globalThis.fetch = realFetch;
    const baseline = await deskHtml({ source: slipSource });
    expect(baseline).not.toContain("+ SLIP");
    expect(baseline).not.toContain("Parlay slip");

    serveConfig({ referrer: "", features: { trade: false } });
    const flagOff = await deskHtml({
      source: slipSource,
      wallet: { id: "injected", getSigner: async () => SIGNER },
    });
    expect(flagOff).toBe(baseline);

    globalThis.fetch = realFetch;
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The slip on screen — §D2 and §D3 are pixels, not docblocks
// ─────────────────────────────────────────────────────────────────────────────

/** Mount `Parlay` live, hand back the container, and let the test drive it. */
async function mountDesk(source: MarketSource) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      createElement(Parlay, {
        source,
        asset: "ETH",
        onAsset: () => {},
        wallet: { id: "injected", getSigner: async () => SIGNER },
      }),
    );
  });
  await act(async () => {});
  const buttons = () => Array.from(container.querySelectorAll<HTMLElement>("button"));
  return {
    container,
    /** Click the first button whose text starts with `label`. */
    async click(label: string) {
      const button = buttons().find((b) => (b.textContent ?? "").trim().startsWith(label));
      if (!button) {
        throw new Error(
          `no button "${label}" on screen — have [${buttons()
            .map((b) => (b.textContent ?? "").trim())
            .join(" | ")}]`,
        );
      }
      await act(async () => button.click());
    },
    /** Every `+ SLIP` / `IN SLIP` toggle on the chain. */
    slipToggles: () =>
      buttons().filter((b) => /^(\+ SLIP|IN SLIP)$/.test((b.textContent ?? "").trim())),
    async unmount() {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

describe("the parlay slip, on screen", () => {
  const realFetch = globalThis.fetch;

  function serveTradeOn() {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ referrer: "", features: { trade: true } }), {
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
  }

  test("only levels with a resting order can be added to a slip", async () => {
    serveTradeOn();
    const desk = await mountDesk({
      ...slipSource,
      // Two levels, one of them quoted by market makers alone. A card that
      // quotes a number it cannot fill is the exact failure `order` deletes.
      pricing: () => [chainRow(), chainRow({ strike: "5,000", order: undefined })],
    });
    expect(desk.slipToggles()).toHaveLength(1);
    await desk.unmount();
    globalThis.fetch = realFetch;
  });

  test("the partial-fill policy is on screen before anything is pressed", async () => {
    // §D2. A player who meets this sentence for the first time with a wallet
    // prompt open has been surprised by their own position.
    serveTradeOn();
    const desk = await mountDesk(slipSource);
    expect(desk.container.innerHTML).toContain("Parlay slip");
    // Empty slip: the panel says what to press, and claims no policy about a
    // position that does not exist yet.
    expect(desk.container.innerHTML).not.toContain(PARTIAL_FILL_POLICY);

    await desk.click("+ SLIP");
    const html = desk.container.innerHTML;
    expect(html).toContain(PARTIAL_FILL_POLICY);
    expect(html).toContain("Review slip");
    await desk.unmount();
    globalThis.fetch = realFetch;
  });

  test("the slip states its total against the cap, and names the staircase when it steps over", async () => {
    serveTradeOn();
    const desk = await mountDesk(slipSource);
    for (let i = 0; i < 3; i++) await desk.click("+ SLIP");
    expect(desk.slipToggles().filter((b) => b.textContent === "IN SLIP")).toHaveLength(3);

    // Three legs at a cent is four cents — comfortably inside the bound.
    expect(desk.container.innerHTML).toContain("slip total $0.03");
    expect(desk.container.innerHTML).toContain("cap $2.00");

    // Three legs at a dollar each is $3.00 through a $2.00 bound, with every
    // individual leg legal. That is the staircase, and the screen names it.
    await desk.click("$1.00");
    const html = desk.container.innerHTML;
    expect(html).toContain("slip total $3.00");
    expect(html).toContain("staircase");

    await desk.unmount();
    globalThis.fetch = realFetch;
  });

  test("the slip re-scores as a game number, never beside a currency symbol", async () => {
    serveTradeOn();
    const desk = await mountDesk(slipSource);
    await desk.click("+ SLIP");
    await desk.click("+ SLIP");
    // 1/0.70 × 1/0.45 = 3.17. A degeneracy score, not a payout: a basket pays
    // the SUM of its legs, which is `basketPayoff`, not this.
    const html = desk.container.innerHTML;
    expect(html).toContain("degeneracy ×3.17");
    expect(html).not.toContain("$3.17");
    await desk.unmount();
    globalThis.fetch = realFetch;
  });

  test("the status ladder renders every terminal, with a link on filled and a code on failed", async () => {
    // §D3, rung by rung. The ladder doubles as the strongest "this is real"
    // artifact in a demo, so each terminal must carry its own evidence.
    const base = { id: "a", label: "ETH-27SEP-4400-C" };
    const quote: FillQuote = {
      usdcAmount: 10_000n,
      // 6dp — see `preview()`. The panel renders this through `contracts()`.
      numContracts: 150_000n,
      totalCollateral: 9_900n,
      collateralToken: USDC,
    };
    const rungs: [ParlayLegState, (html: string) => void][] = [
      [{ ...base, status: "pending" }, (h) => expect(h).toContain("PENDING")],
      [
        { ...base, status: "previewed", quote },
        (h) => {
          expect(h).toContain("PREVIEWED");
          // The exact collateral, not a `toFixed` that would round a
          // ninety-nine-hundredth of a dollar up to a cent it is not.
          expect(h).toContain("$0.0099");
          expect(h).toContain("0.1500 contracts");
        },
      ],
      [{ ...base, status: "approved", quote }, (h) => expect(h).toContain("APPROVED")],
      [
        {
          ...base,
          status: "filled",
          quote,
          hash: HASH,
          explorer: `https://basescan.org/tx/${HASH}`,
          approvalSkipped: true,
        },
        (h) => {
          expect(h).toContain("FILLED");
          // The link, openable, on the leg itself.
          expect(h).toContain(`href="https://basescan.org/tx/${HASH}"`);
          expect(h).toContain("on BaseScan");
          expect(h).toContain("1 tx (allowance sufficient)");
        },
      ],
      [
        { ...base, status: "dropped", dropped: "EXPIRED" },
        (h) => {
          expect(h).toContain("DROPPED");
          expect(h).toContain(DROP_COPY.EXPIRED);
        },
      ],
      [
        {
          ...base,
          status: "failed",
          error: classifyFillError(new Error("execution reverted: slippage exceeded"), "fill"),
        },
        (h) => {
          expect(h).toContain("FAILED");
          // The mapped code, not a raw revert string.
          expect(h).toContain("SLIPPAGE");
          expect(h).toContain("at FILL");
        },
      ],
    ];

    for (const [leg, assert] of rungs) {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => root.render(createElement(ParlayLegChip, { leg })));
      assert(container.innerHTML);
      await act(async () => root.unmount());
      container.remove();
    }
  });

  test("the slip says which legs the duel clock cannot score, before anything is signed", async () => {
    // A row with the venue's mark and nothing else: no market-maker ticker to
    // key a marks map by, and no dollar price to measure from. The screen says
    // so rather than letting a player discover it as a refund six hours later.
    serveTradeOn();
    const desk = await mountDesk({
      ...slipSource,
      pricing: () => [chainRow({ mark: "0.0712" })],
    });
    await desk.click("+ SLIP");
    const html = desk.container.innerHTML;
    expect(html).toContain("cannot be scored on the duel clock");
    // And the disclosure does not overclaim: the position itself is real.
    expect(html).toContain("settles at expiry regardless");
    await desk.unmount();
    globalThis.fetch = realFetch;
  });

  test("a row carrying BOTH the ticker and the dollar mark drops the warning", async () => {
    // The other side of the same disclosure, and the screen-level proof that
    // the join now closes: give the row what the server writes and the slip
    // stops saying it cannot be scored. Before this change no row could carry
    // either field, so this banner was unconditional on live data.
    serveTradeOn();
    const desk = await mountDesk({
      ...slipSource,
      pricing: () => [
        chainRow({ mark: "0.0712", markTicker: "ETH-27SEP26-4400-C", markUsd: "169.16" }),
      ],
    });
    await desk.click("+ SLIP");
    expect(desk.container.innerHTML).not.toContain("cannot be scored on the duel clock");
    await desk.unmount();
    globalThis.fetch = realFetch;
  });

  test("a ticker with no dollar mark still warns — a name alone is not enough", async () => {
    // The market maker quoted the instrument and published no spot, so the row
    // has a name and no money. Half a join is not a join.
    serveTradeOn();
    const desk = await mountDesk({
      ...slipSource,
      pricing: () => [chainRow({ mark: "0.0712", markTicker: "ETH-27SEP26-4400-C" })],
    });
    await desk.click("+ SLIP");
    expect(desk.container.innerHTML).toContain("cannot be scored on the duel clock");
    await desk.unmount();
    globalThis.fetch = realFetch;
  });

  test("removing a leg empties the slip back to its opening copy", async () => {
    serveTradeOn();
    const desk = await mountDesk(slipSource);
    await desk.click("+ SLIP");
    expect(desk.container.innerHTML).toContain("Review slip");
    await desk.click("IN SLIP");
    expect(desk.container.innerHTML).not.toContain("Review slip");
    expect(desk.container.innerHTML).toContain("resting order backs");
    await desk.unmount();
    globalThis.fetch = realFetch;
  });
});
