/**
 * The patient RFQ path, exercised without a chain — and without a market maker.
 *
 * `src/desk/rfq.ts` is in a stranger position than `src/desk/fill.ts`. The fill
 * path at least has a manual mainnet checklist behind it; **no RFQ has ever been
 * sent from this repo**, so every claim the module makes is a claim these tests
 * have to carry on their own. Which is exactly why every seam is injected: the
 * ordering, the invariants, the error map and — the part that is unique to this
 * protocol — the *patience* behaviour are all provable offline over a spy.
 *
 * What these tests pin:
 *
 *  - the sequence touches the world in one fixed order across all four phases;
 *  - **`collateralAmount === 0n` at creation**, checked on the built request, so
 *    a builder that ever returns a non-zero value cannot reach a transaction;
 *  - the **mock wallet is refused before any dep is touched** — it never signs,
 *    never approves, never settles;
 *  - the **ECDH private key is never serialised**: an injected storage stub
 *    records everything written and none of it contains the key;
 *  - the request object is **frozen**, because `requesterPublicKey` inside it is
 *    the seal every bid is encrypted to;
 *  - **"no market maker responded" is a normal outcome** with a status of its
 *    own, not an error code and not a thrown promise;
 *  - one case per error code, with the full union asserted covered;
 *  - the panel renders **inert** with no wallet, and asks the network nothing.
 */

import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  MAX_RFQ_USDC,
  POLL_FAILURE_LIMIT,
  RFQ_COPY,
  RFQ_STORAGE_PREFIX,
  UNANSWERED_COPY,
  acceptOffer,
  assertZeroCollateral,
  awaitOffers,
  cancelRequest,
  classifyRfqError,
  createKeyring,
  elapsedText,
  openRequest,
  rememberRequest,
  runRfq,
  type RawRfqState,
  type RfqCode,
  type RfqDeps,
  type RfqInput,
  type RfqKeyPair,
  type RfqOffer,
  type RfqRequest,
  type RfqStorage,
} from "../src/desk/rfq.ts";
import { RfqPanel, type RfqPanelProps } from "../src/ui/RfqPanel.tsx";

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FACTORY = "0x000000000000000000000000000000000000FAC7";
const MAKER = "0x00000000000000000000000000000000000000Mm".replace("Mm", "aa");
const HASH = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abcd";
const CANCEL_HASH = "0xdead00def456abc123def456abc123def456abc123def456abc123def456beef";
const SIGNER = { address: "0xsigner" };

/** 4 Sep 2026, UTC — the same instant every other suite in this repo uses. */
const NOW = Date.UTC(2026, 8, 4);

/**
 * The ECDH keypair.
 *
 * `PRIVATE` is deliberately a distinctive, greppable string: several assertions
 * below scan everything the module wrote and look for exactly these bytes.
 */
const PRIVATE = `0x${"ab".repeat(32)}`;
const KEYPAIR: RfqKeyPair = {
  privateKey: PRIVATE,
  compressedPublicKey: `0x02${"cd".repeat(32)}`,
  publicKey: `0x04${"ef".repeat(64)}`,
};

const INPUT: RfqInput = {
  requester: "0x000000000000000000000000000000000000dEaD",
  underlying: "ETH",
  optionType: "CALL",
  strike: 2400,
  expiry: Math.floor(Date.UTC(2026, 8, 11, 8) / 1000),
  isLong: true,
  numContracts: 1_000000n,
  reserveUsdc: 10_000n,
  offerWindowMin: 10,
};

/** A well-formed request: `collateralAmount` is `0n`, as the factory demands. */
function makeRequest(over: Partial<RfqRequest["params"]> = {}): RfqRequest {
  return {
    params: {
      requester: INPUT.requester,
      existingOptionAddress: "0x0000000000000000000000000000000000000000",
      collateral: USDC,
      collateralPriceFeed: "0x0000000000000000000000000000000000000FEE",
      implementation: "0x0000000000000000000000000000000000000CA1",
      strikes: [240000000000n],
      numContracts: 1_000000n,
      requesterDeposit: 0n,
      collateralAmount: 0n,
      expiryTimestamp: BigInt(INPUT.expiry),
      offerEndTimestamp: BigInt(INPUT.expiry - 86_400),
      isRequestingLongPosition: true,
      convertToLimitOrder: false,
      extraOptionData: "0x",
      ...over,
    },
    tracking: { referralId: 0n, eventCode: 0n },
    reservePrice: 10_000n,
    requesterPublicKey: KEYPAIR.compressedPublicKey,
  };
}

/** The indexer's view: active, with one sealed bid. */
function stateWithOffer(over: Partial<RawRfqState> = {}): RawRfqState {
  return {
    id: "42",
    status: "active",
    requesterPublicKey: KEYPAIR.compressedPublicKey,
    offers: {
      "0": {
        offeror: MAKER,
        signingKey: `0x03${"11".repeat(32)}`,
        signedOfferForRequester: "0xdeadbeefcafe",
        status: "pending",
        createdAt: Math.floor(NOW / 1000),
      },
    },
    ...over,
  };
}

/** Active, and nobody has bid. The state that produces `unanswered`. */
const EMPTY_STATE: RawRfqState = { id: "42", status: "active", offers: {} };

/** A storage stub that records every write, so the tests can search it. */
function storageStub(): RfqStorage & { writes: [string, string][]; removed: string[] } {
  const writes: [string, string][] = [];
  const removed: string[] = [];
  const map = new Map<string, string>();
  return {
    writes,
    removed,
    set(key, value) {
      writes.push([key, value]);
      map.set(key, value);
    },
    get(key) {
      return map.get(key) ?? null;
    },
    remove(key) {
      removed.push(key);
      map.delete(key);
    },
  };
}

interface Spy {
  deps: RfqDeps;
  /** Every seam call, in order. This array *is* the sequence assertion. */
  calls: string[];
  allowanceArgs: [string, string, bigint][];
  settleArgs: [string, bigint, bigint, string][];
  requestArgs: Readonly<RfqRequest>[];
  decryptArgs: [string, string, RfqKeyPair][];
  confirmArgs: RfqOffer[];
  storage: ReturnType<typeof storageStub>;
  /** The virtual clock. `sleep` advances it, so patience is instant. */
  clockMs(): number;
}

/**
 * An `RfqDeps` that records everything and defaults to a happy four-phase run.
 *
 * The clock is virtual: `sleep` advances it rather than waiting, which is what
 * makes a protocol with an eleven-minute patience window testable in
 * microseconds without weakening what is being tested — `awaitOffers` reads the
 * same `now()` it would in a browser.
 */
function spy(over: Partial<RfqDeps> = {}): Spy {
  const calls: string[] = [];
  const allowanceArgs: Spy["allowanceArgs"] = [];
  const settleArgs: Spy["settleArgs"] = [];
  const requestArgs: Spy["requestArgs"] = [];
  const decryptArgs: Spy["decryptArgs"] = [];
  const confirmArgs: RfqOffer[] = [];
  const storage = storageStub();
  let clock = NOW;

  const base: RfqDeps = {
    walletId: "injected",
    storage,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    getSigner: async () => SIGNER,
    generateKeyPair: () => KEYPAIR,
    buildRequest: () => makeRequest(),
    requestForQuotation: async () => ({ quotationId: 42n, hash: HASH }),
    readRfq: async () => stateWithOffer(),
    decryptOffer: async () => ({ offerAmount: 5_000n, nonce: 7n }),
    factoryAddress: async () => FACTORY,
    collateralToken: async () => USDC,
    ensureAllowance: async () => null,
    settleQuotationEarly: async () => ({ hash: HASH }),
    cancelQuotation: async () => ({ hash: CANCEL_HASH }),
    confirm: async () => true,
  };
  const merged = { ...base, ...over };

  const deps: RfqDeps = {
    ...merged,
    getSigner: async () => {
      calls.push("getSigner");
      return merged.getSigner();
    },
    generateKeyPair: () => {
      calls.push("generateKeyPair");
      return merged.generateKeyPair();
    },
    buildRequest: (input, key) => {
      calls.push("buildRequest");
      return merged.buildRequest(input, key);
    },
    requestForQuotation: async (request) => {
      calls.push("requestForQuotation");
      requestArgs.push(request);
      return merged.requestForQuotation(request);
    },
    readRfq: async (id) => {
      calls.push("readRfq");
      return merged.readRfq(id);
    },
    decryptOffer: async (cipher, pub, keyPair) => {
      calls.push("decryptOffer");
      decryptArgs.push([cipher, pub, keyPair]);
      return merged.decryptOffer(cipher, pub, keyPair);
    },
    factoryAddress: async () => {
      calls.push("factoryAddress");
      return merged.factoryAddress();
    },
    collateralToken: async () => {
      calls.push("collateralToken");
      return merged.collateralToken();
    },
    ensureAllowance: async (token, spender, amount) => {
      calls.push("ensureAllowance");
      allowanceArgs.push([token, spender, amount]);
      return merged.ensureAllowance(token, spender, amount);
    },
    settleQuotationEarly: async (id, amount, nonce, offeror) => {
      calls.push("settleQuotationEarly");
      settleArgs.push([id, amount, nonce, offeror]);
      return merged.settleQuotationEarly(id, amount, nonce, offeror);
    },
    cancelQuotation: async (id) => {
      calls.push("cancelQuotation");
      return merged.cancelQuotation(id);
    },
    confirm: async (offer) => {
      calls.push("confirm");
      confirmArgs.push(offer);
      return merged.confirm(offer);
    },
    storage: {
      set: (k, v) => {
        calls.push("storage.set");
        (merged.storage ?? storage).set(k, v);
      },
      get: (k) => (merged.storage ?? storage).get(k),
      remove: (k) => {
        calls.push("storage.remove");
        (merged.storage ?? storage).remove(k);
      },
    },
  };

  return {
    deps,
    calls,
    allowanceArgs,
    settleArgs,
    requestArgs,
    decryptArgs,
    confirmArgs,
    storage,
    clockMs: () => clock,
  };
}

/** Fast options — a 1-minute window over 15s polls, so `unanswered` is 4 polls. */
const FAST = { patienceMs: 60_000, pollMs: 15_000 };

// ─────────────────────────────────────────────────────────────────────────────
// The sequence
// ─────────────────────────────────────────────────────────────────────────────

describe("call ordering across the four phases", () => {
  test("request → offer → reveal → settle, in exactly that order", async () => {
    const s = spy();
    const outcome = await runRfq(INPUT, s.deps, FAST);

    expect(outcome.status).toBe("settled");
    expect(s.calls).toEqual([
      // Phase 1 — REQUEST. The key is generated before the signer is asked for,
      // because the public key is an input to the request and costs nothing.
      "generateKeyPair",
      "getSigner",
      "buildRequest",
      "requestForQuotation",
      "storage.set",
      // Phase 2 — OFFER. A poll, not a subscription.
      "readRfq",
      // Phase 3 — REVEAL. Local, with the keypair passed explicitly.
      "decryptOffer",
      // Phase 4 — SETTLE. Confirm before approval, approval before settlement,
      // and both addresses read from the chain config rather than an API.
      "confirm",
      "factoryAddress",
      "collateralToken",
      "ensureAllowance",
      "settleQuotationEarly",
    ]);
  });

  test("the settle carries the amount and nonce from inside the seal, verbatim", async () => {
    const s = spy();
    await runRfq(INPUT, s.deps, FAST);
    expect(s.settleArgs).toEqual([["42", 5_000n, 7n, MAKER]]);
  });

  test("the approval is exactly the premium, never MaxUint256", async () => {
    const s = spy();
    await runRfq(INPUT, s.deps, FAST);
    expect(s.allowanceArgs).toEqual([[USDC, FACTORY, 5_000n]]);
    for (const [, , amount] of s.allowanceArgs) {
      expect(amount).toBe(5_000n);
      expect(amount).not.toBe((1n << 256n) - 1n);
    }
  });

  test("declining the confirm cancels — nothing is approved and nothing is settled", async () => {
    const s = spy({ confirm: async () => false });
    const outcome = await runRfq(INPUT, s.deps, FAST);
    expect(outcome.status).toBe("cancelled");
    expect(s.calls).not.toContain("ensureAllowance");
    expect(s.calls).not.toContain("settleQuotationEarly");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The invariant
// ─────────────────────────────────────────────────────────────────────────────

describe("collateralAmount must be 0 at creation", () => {
  test("a zero request passes and comes back frozen", () => {
    const request = assertZeroCollateral(makeRequest());
    expect(BigInt(request.params.collateralAmount)).toBe(0n);
    expect(Object.isFrozen(request)).toBe(true);
  });

  test("a non-zero collateralAmount is refused, and never reaches the network", async () => {
    const s = spy({ buildRequest: () => makeRequest({ collateralAmount: 1n }) });
    const outcome = await runRfq(INPUT, s.deps, FAST);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe("COLLATERAL_NOT_ZERO");
    // The whole point: the transaction was never sent.
    expect(s.calls).not.toContain("requestForQuotation");
    expect(s.calls).toEqual(["generateKeyPair", "getSigner", "buildRequest"]);
  });

  test("a missing or unparseable collateralAmount is refused too", () => {
    expect(() =>
      assertZeroCollateral(makeRequest({ collateralAmount: undefined as unknown as bigint })),
    ).toThrow(/COLLATERAL_NOT_ZERO/);
    expect(() => assertZeroCollateral(makeRequest({ collateralAmount: "" }))).toThrow(
      /COLLATERAL_NOT_ZERO/,
    );
  });

  test("string zero is still zero — the SDK's builder is free to hand back either", () => {
    expect(() => assertZeroCollateral(makeRequest({ collateralAmount: "0" }))).not.toThrow();
  });

  test("every phase-1 run asserts on the BUILT request, not on our input", async () => {
    // A builder that quietly rewrites the tuple is the case the guard exists
    // for: nothing about `INPUT` is wrong here, only what came back.
    const s = spy({ buildRequest: () => makeRequest({ collateralAmount: 250_000n }) });
    const ring = createKeyring(KEYPAIR);
    const outcome = await openRequest(INPUT, ring, s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe("COLLATERAL_NOT_ZERO");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The frozen request
// ─────────────────────────────────────────────────────────────────────────────

describe("the request is frozen before it is sent", () => {
  test("params, strikes and tracking are all frozen on the object that goes out", async () => {
    const s = spy();
    const ring = createKeyring(KEYPAIR);
    const outcome = await openRequest(INPUT, ring, s.deps);
    expect(outcome.status).toBe("open");

    const sent = s.requestArgs[0]!;
    expect(Object.isFrozen(sent)).toBe(true);
    expect(Object.isFrozen(sent.params)).toBe(true);
    expect(Object.isFrozen(sent.params.strikes)).toBe(true);
    expect(Object.isFrozen(sent.tracking)).toBe(true);
  });

  test("mutating the seal throws instead of silently making every bid unreadable", () => {
    const request = assertZeroCollateral(makeRequest());
    // `requesterPublicKey` is the key market makers encrypt to. A rewrite here
    // would produce bids sealed to something this tab cannot open, with nothing
    // in the stack pointing at the mutation.
    expect(() => {
      (request as { requesterPublicKey: string }).requesterPublicKey = "0xdead";
    }).toThrow(TypeError);
    expect(() => {
      (request.params as { collateralAmount: bigint }).collateralAmount = 99n;
    }).toThrow(TypeError);
  });

  test("a request built with a public key we do not hold is refused before submission", async () => {
    const s = spy({
      buildRequest: () => ({ ...makeRequest(), requesterPublicKey: `0x02${"99".repeat(32)}` }),
    });
    const ring = createKeyring(KEYPAIR);
    const outcome = await openRequest(INPUT, ring, s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe("KEY_LOST");
    expect(s.calls).not.toContain("requestForQuotation");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The mock wallet
// ─────────────────────────────────────────────────────────────────────────────

describe("the mock wallet never signs, approves or settles", () => {
  test("refused before any dep is touched", async () => {
    const s = spy({ walletId: "mock" });
    const ring = createKeyring(KEYPAIR);
    const outcome = await openRequest(INPUT, ring, s.deps);

    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe("SIGNER_REQUIRED");
      expect(outcome.error.message).toMatch(/mock wallet cannot sign/i);
    }
    // Not even `getSigner`. The refusal is above the seam, not inside it.
    expect(s.calls).toEqual([]);
  });

  test("refused at the settle phase too, before the approval", async () => {
    const s = spy({ walletId: "mock" });
    const offer: RfqOffer = {
      quotationId: "42",
      offeror: MAKER,
      signingKey: "0x03",
      offerAmount: 5_000n,
      nonce: 7n,
      createdAt: 0,
      status: "pending",
    };
    const outcome = await acceptOffer(offer, 10_000n, s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe("SIGNER_REQUIRED");
    expect(s.calls).toEqual([]);
  });

  test("refused at cancel", async () => {
    const s = spy({ walletId: "mock" });
    const outcome = await cancelRequest("42", s.deps);
    expect(outcome.status).toBe("failed");
    expect(s.calls).toEqual([]);
  });

  test("the whole run over a mock wallet touches nothing", async () => {
    const s = spy({ walletId: "mock" });
    const outcome = await runRfq(INPUT, s.deps, FAST);
    expect(outcome.status).toBe("failed");
    // `generateKeyPair` is ours and harmless; nothing that reaches a chain runs.
    expect(s.calls).toEqual(["generateKeyPair"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The key
// ─────────────────────────────────────────────────────────────────────────────

describe("the ECDH private key is never serialised", () => {
  test("a full run writes breadcrumbs and none of them contain the key", async () => {
    const s = spy();
    await runRfq(INPUT, s.deps, FAST);

    expect(s.storage.writes.length).toBe(1);
    for (const [key, value] of s.storage.writes) {
      expect(key.startsWith(RFQ_STORAGE_PREFIX)).toBe(true);
      expect(value).not.toContain(PRIVATE);
      expect(value).not.toContain("privateKey");
      // Not just "the literal is absent": nothing 32-bytes-of-hex-shaped that
      // is not the public key may appear at all.
      const hexRuns = value.match(/0x[0-9a-fA-F]{64,}/g) ?? [];
      for (const run of hexRuns) {
        expect([KEYPAIR.compressedPublicKey, KEYPAIR.publicKey]).toContain(run);
      }
    }
    // The breadcrumb is still worth something: it carries the public key, which
    // is on chain anyway, so a reload can say what it lost.
    expect(s.storage.writes[0]![1]).toContain(KEYPAIR.compressedPublicKey);
  });

  test("browser storage is untouched by a full run", async () => {
    const before = {
      local: globalThis.localStorage?.length ?? 0,
      session: globalThis.sessionStorage?.length ?? 0,
    };
    const s = spy();
    await runRfq(INPUT, s.deps, FAST);
    expect(globalThis.localStorage?.length ?? 0).toBe(before.local);
    expect(globalThis.sessionStorage?.length ?? 0).toBe(before.session);
  });

  test("rememberRequest refuses to write a payload containing the key", () => {
    const store = storageStub();
    expect(() =>
      // Contrived: the allowlist would have to grow a bad field for this to
      // happen for real. The check is the second line of defence and this is
      // what proves it is armed.
      rememberRequest(
        store,
        {
          quotationId: "42",
          publicKey: PRIVATE,
          createdAt: NOW,
          underlying: "ETH",
          strike: 2400,
          expiry: INPUT.expiry,
          readable: false,
        },
        PRIVATE,
      ),
    ).toThrow(/refused to persist/i);
    expect(store.writes).toEqual([]);
  });

  test("no storage at all is a supported configuration", async () => {
    const s = spy({ storage: undefined });
    const deps: RfqDeps = { ...s.deps, storage: undefined };
    const outcome = await runRfq(INPUT, deps, FAST);
    expect(outcome.status).toBe("settled");
  });

  test("the keyring hands the keypair to decryptOffer and to nothing else", async () => {
    const s = spy();
    await runRfq(INPUT, s.deps, FAST);
    expect(s.decryptArgs.length).toBe(1);
    // Explicit, so the SDK never falls back to reading its storage provider.
    expect(s.decryptArgs[0]![2]).toBe(KEYPAIR);
  });

  test("a forgotten keyring makes offers unreadable, not leaked", async () => {
    const ring = createKeyring(KEYPAIR);
    expect(ring.lost).toBe(false);
    expect(ring.publicKey).toBe(KEYPAIR.compressedPublicKey);
    ring.forget();
    expect(ring.lost).toBe(true);
    expect(() => ring.take((k) => k.privateKey)).toThrow(/KEY_LOST/);

    const s = spy();
    const result = await awaitOffers("42", ring, s.deps, FAST);
    expect(result.status).toBe("offers");
    if (result.status === "offers") {
      expect(result.offers[0]!.offerAmount).toBeNull();
      expect(result.offers[0]!.unreadable).toMatch(/KEY_LOST/);
    }
  });

  test("a lost key stops the request from being opened at all", async () => {
    const ring = createKeyring(KEYPAIR);
    ring.forget();
    const s = spy();
    const outcome = await openRequest(INPUT, ring, s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe("KEY_LOST");
    expect(s.calls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Patience — the outcome that is not an error
// ─────────────────────────────────────────────────────────────────────────────

describe("nobody responding is a normal outcome", () => {
  test("an empty book of bids ends as `unanswered`, with elapsed time attached", async () => {
    const s = spy({ readRfq: async () => EMPTY_STATE });
    const outcome = await runRfq(INPUT, s.deps, FAST);

    expect(outcome.status).toBe("unanswered");
    if (outcome.status === "unanswered") {
      expect(outcome.quotationId).toBe("42");
      expect(outcome.polls).toBe(4); // 60s of patience over 15s polls.
      expect(outcome.elapsedMs).toBe(60_000);
    }
    // Nothing was approved and nothing was settled.
    expect(s.calls).not.toContain("ensureAllowance");
    expect(s.calls).not.toContain("settleQuotationEarly");
  });

  test("`unanswered` is not in the error union at all", () => {
    // A compile-time claim, asserted at runtime so it cannot rot: no code in the
    // map is named for this outcome, and the copy for it lives elsewhere.
    expect(Object.keys(RFQ_COPY)).not.toContain("UNANSWERED");
    expect(Object.keys(RFQ_COPY)).not.toContain("NO_RESPONSE");
    expect(Object.keys(RFQ_COPY)).not.toContain("TIMEOUT");
    // And its copy does not call it a failure.
    expect(UNANSWERED_COPY).toMatch(/ordinary outcome/i);
    expect(UNANSWERED_COPY).not.toMatch(/error|failed|failure/i);
  });

  test("a transient read failure does not end the wait", async () => {
    let n = 0;
    const s = spy({
      readRfq: async () => {
        n += 1;
        if (n <= 2) throw new Error("fetch failed");
        return stateWithOffer();
      },
    });
    const outcome = await runRfq(INPUT, s.deps, FAST);
    expect(outcome.status).toBe("settled");
  });

  test("an unbroken run of read failures does give up, as a NETWORK error", async () => {
    const s = spy({
      readRfq: async () => {
        throw new Error("fetch failed");
      },
    });
    const ring = createKeyring(KEYPAIR);
    const result = await awaitOffers("42", ring, s.deps, { patienceMs: 600_000, pollMs: 1_000 });
    expect(result.status).toBe("failed");
    if (result.status === "failed") expect(result.error.code).toBe("NETWORK");
    expect(s.calls.filter((c) => c === "readRfq").length).toBe(POLL_FAILURE_LIMIT);
  });

  test("an RFQ that leaves `active` under us is reported as closed, not as waiting", async () => {
    const s = spy({ readRfq: async () => ({ id: "42", status: "cancelled", offers: {} }) });
    const ring = createKeyring(KEYPAIR);
    const result = await awaitOffers("42", ring, s.deps, FAST);
    expect(result.status).toBe("closed");
  });

  test("cancelling an unanswered request removes its breadcrumb", async () => {
    const s = spy();
    const outcome = await cancelRequest("42", s.deps);
    expect(outcome.status).toBe("cancelled");
    if (outcome.status === "cancelled") expect(outcome.hash).toBe(CANCEL_HASH);
    expect(s.storage.removed).toEqual([`${RFQ_STORAGE_PREFIX}42`]);
  });

  test("the elapsed readout is a clock, not a percentage", () => {
    expect(elapsedText(0)).toBe("0s");
    expect(elapsedText(38_000)).toBe("38s");
    expect(elapsedText(252_000)).toBe("4m 12s");
    expect(elapsedText(3_780_000)).toBe("1h 03m");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The error map — one case per code
// ─────────────────────────────────────────────────────────────────────────────

describe("the error map: one case per code, and every code covered", () => {
  /** Collected across the whole block, then asserted exhaustive at the end. */
  const seen = new Set<RfqCode>();
  const note = (code: RfqCode) => {
    seen.add(code);
    return code;
  };

  test("SIGNER_REQUIRED — no wallet at all", async () => {
    const s = spy({ getSigner: async () => null });
    const outcome = await openRequest(INPUT, createKeyring(KEYPAIR), s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("SIGNER_REQUIRED"));
  });

  test("SIGNER_REQUIRED — a throw from getSigner is the wrong chain, and says switch", async () => {
    const s = spy({
      getSigner: async () => {
        throw new Error("chain 1 is not 8453");
      },
    });
    const outcome = await openRequest(INPUT, createKeyring(KEYPAIR), s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe("SIGNER_REQUIRED");
      expect(outcome.error.action).toBe("switch");
    }
  });

  test("COLLATERAL_NOT_ZERO", async () => {
    const s = spy({ buildRequest: () => makeRequest({ collateralAmount: 5n }) });
    const outcome = await openRequest(INPUT, createKeyring(KEYPAIR), s.deps);
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("COLLATERAL_NOT_ZERO"));
  });

  test("SIZE — the cap runs before any dep is touched", async () => {
    const s = spy();
    const outcome = await openRequest(
      { ...INPUT, reserveUsdc: MAX_RFQ_USDC + 1n },
      createKeyring(KEYPAIR),
      s.deps,
    );
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("SIZE"));
    expect(s.calls).toEqual([]);
  });

  test("SIZE — a bid above the cap is refused even though our reserve allowed it", async () => {
    const s = spy();
    const offer: RfqOffer = {
      quotationId: "42",
      offeror: MAKER,
      signingKey: "0x03",
      offerAmount: MAX_RFQ_USDC + 1n,
      nonce: 7n,
      createdAt: 0,
      status: "pending",
    };
    // A counterparty's number has never been through our cap. This is the point.
    const outcome = await acceptOffer(offer, MAX_RFQ_USDC + 10n, s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe("SIZE");
    expect(s.calls).not.toContain("ensureAllowance");
  });

  test("KEY_LOST", async () => {
    const ring = createKeyring(KEYPAIR);
    ring.forget();
    const outcome = await openRequest(INPUT, ring, spy().deps);
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("KEY_LOST"));
  });

  test("OFFER_UNREADABLE — a bid we cannot open is refused, and the others are not", async () => {
    const s = spy({
      decryptOffer: async () => {
        throw new Error("DecryptionError: unable to authenticate data");
      },
    });
    const ring = createKeyring(KEYPAIR);
    const waited = await awaitOffers("42", ring, s.deps, FAST);
    expect(waited.status).toBe("offers");
    if (waited.status !== "offers") return;

    const outcome = await acceptOffer(waited.offers[0]!, 10_000n, s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("OFFER_UNREADABLE"));
    expect(s.calls).not.toContain("ensureAllowance");
  });

  test("WINDOW_CLOSED", async () => {
    const s = spy({
      settleQuotationEarly: async () => {
        throw new Error("offer period has ended");
      },
    });
    const offer: RfqOffer = {
      quotationId: "42",
      offeror: MAKER,
      signingKey: "0x03",
      offerAmount: 5_000n,
      nonce: 7n,
      createdAt: 0,
      status: "pending",
    };
    const outcome = await acceptOffer(offer, 10_000n, s.deps);
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("WINDOW_CLOSED"));
  });

  test("RESERVE_EXCEEDED — refused before the human is even asked", async () => {
    const s = spy({ decryptOffer: async () => ({ offerAmount: 900_000n, nonce: 7n }) });
    const outcome = await runRfq(INPUT, s.deps, FAST);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("RESERVE_EXCEEDED"));
    expect(s.calls).not.toContain("confirm");
  });

  test("INSUFFICIENT_BALANCE", async () => {
    const s = spy({
      settleQuotationEarly: async () => {
        throw new Error("transfer amount exceeds balance");
      },
    });
    const outcome = await runRfq(INPUT, s.deps, FAST);
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("INSUFFICIENT_BALANCE"));
  });

  test("INSUFFICIENT_ALLOWANCE", async () => {
    const s = spy({
      ensureAllowance: async () => {
        throw new Error("ERC20: insufficient allowance");
      },
    });
    const outcome = await runRfq(INPUT, s.deps, FAST);
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("INSUFFICIENT_ALLOWANCE"));
  });

  test("CONTRACT_REVERT — including a settle that returns no hash", async () => {
    const s = spy({ settleQuotationEarly: async () => ({}) });
    const outcome = await runRfq(INPUT, s.deps, FAST);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe(note("CONTRACT_REVERT"));
      // The copy must not claim nothing happened — it may well have landed.
      expect(outcome.error.recovery).toMatch(/may have landed/i);
    }
  });

  test("CONTRACT_REVERT — a request with no quotation id is unpollable and says so", async () => {
    const s = spy({ requestForQuotation: async () => ({ hash: HASH }) });
    const outcome = await openRequest(INPUT, createKeyring(KEYPAIR), s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") expect(outcome.error.code).toBe("CONTRACT_REVERT");
  });

  test("NETWORK", async () => {
    const s = spy({
      requestForQuotation: async () => {
        throw new Error("fetch failed");
      },
    });
    const outcome = await openRequest(INPUT, createKeyring(KEYPAIR), s.deps);
    if (outcome.status === "failed") expect(outcome.error.code).toBe(note("NETWORK"));
  });

  test("RATE_LIMIT — a throttle is not a revert, and gets the Alchemy hint", async () => {
    const throttle = Object.assign(new Error("missing revert data"), { code: "CALL_EXCEPTION" });
    const s = spy({
      requestForQuotation: async () => {
        throw throttle;
      },
    });
    const outcome = await openRequest(INPUT, createKeyring(KEYPAIR), s.deps);
    expect(outcome.status).toBe("failed");
    if (outcome.status === "failed") {
      expect(outcome.error.code).toBe(note("RATE_LIMIT"));
      expect(outcome.error.throttled).toBe(true);
      expect(outcome.error.recovery).toMatch(/RPC_URL/);
    }
  });

  test("every code in the union was reached by a real sequence", () => {
    const all = Object.keys(RFQ_COPY) as RfqCode[];
    expect(all.length).toBe(12);
    // A code with no test is a panel state nobody has ever seen. There is no
    // tenth-code escape hatch here for the same reason `fill.ts` has none: a
    // code the UI has no copy for is a spinner that never resolves.
    for (const code of all) expect([...seen]).toContain(code);
    for (const code of all) {
      expect(RFQ_COPY[code].message.length).toBeGreaterThan(0);
      expect(RFQ_COPY[code].recovery.length).toBeGreaterThan(0);
    }
  });
});

describe("classifyRfqError's ordering traps", () => {
  test("a key error is never read as a generic revert — its recovery is not 'retry'", () => {
    const e = classifyRfqError(
      Object.assign(new Error("no key"), { name: "KeyNotFoundError", code: "KEY_NOT_FOUND" }),
      "decrypt",
    );
    expect(e.code).toBe("KEY_LOST");
    expect(e.action).toBe("none");
  });

  test("a decryption failure is its own code, distinct from a lost key", () => {
    expect(classifyRfqError(new Error("DecryptionError"), "decrypt").code).toBe("OFFER_UNREADABLE");
  });

  test("a throttle beats the network bucket; a real revert beats the throttle", () => {
    const throttled = Object.assign(new Error("could not coalesce error"), {
      code: "SERVER_ERROR",
    });
    expect(classifyRfqError(throttled, "poll").code).toBe("RATE_LIMIT");

    const reverted = Object.assign(new Error("execution reverted: bad"), { code: "CALL_EXCEPTION" });
    expect(classifyRfqError(reverted, "settle").code).toBe("CONTRACT_REVERT");
  });

  test("every classification carries the step it died on", () => {
    expect(classifyRfqError(new Error("x"), "approve").step).toBe("approve");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────────────────────────

/** Mount `RfqPanel` and return its HTML, with all effects settled. */
async function panelHtml(props: RfqPanelProps = {}): Promise<string> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    // The explicit type argument is load-bearing: every prop on this panel is
    // optional, which makes `RfqPanelProps` a "weak type" — TypeScript refuses
    // to infer it from `{}` because an empty object has no property in common
    // with it. Naming it is also the assertion: `<RfqPanel />` with no props at
    // all is a legal, inert render.
    root.render(createElement<RfqPanelProps>(RfqPanel, props));
  });
  await act(async () => {});
  const html = container.innerHTML;
  await act(async () => root.unmount());
  container.remove();
  return html;
}

describe("the panel is inert without a wallet", () => {
  const realFetch = globalThis.fetch;

  test("no props at all: it renders, explains itself, and arms nothing", async () => {
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response("{}");
    }) as unknown as typeof globalThis.fetch;

    const html = await panelHtml();
    globalThis.fetch = realFetch;

    // It renders at all, self-contained, with no source and no wallet.
    expect(html).toContain("Request for quote");
    // And it says what it is.
    expect(html).toContain("Read-only preview. No signer connected.");
    expect(html).not.toContain("Open request");
    // The four phases are named before anything is pressed.
    expect(html).toContain("1 · REQUEST");
    expect(html).toContain("4 · SETTLE");
    // No wallet means nothing to ask the server about.
    expect(fetched).toBe(0);
  });

  test("the copy sets the expectation honestly — no spinner language, no imminence", async () => {
    const html = await panelHtml();
    expect(html).toMatch(/no deadline/i);
    expect(html).toMatch(/not obliged to answer/i);
    expect(html).toMatch(/outside the duel/i);
    // The key disclosure comes before the request, not after it is lost.
    expect(html).toMatch(/never written to storage/i);
    // Nothing on an unarmed panel claims work is in progress.
    // (`\b` on purpose: the key disclosure says "reloading this page", which is
    // the opposite of a progress claim.)
    expect(html).not.toMatch(/\bloading\b|please wait|processing/i);
  });

  test("a mock wallet is named as inert, and still asks the server nothing", async () => {
    let fetched = 0;
    globalThis.fetch = (async () => {
      fetched += 1;
      return new Response(JSON.stringify({ features: { trade: true } }));
    }) as unknown as typeof globalThis.fetch;

    const html = await panelHtml({ wallet: { id: "mock", getSigner: async () => null } });
    globalThis.fetch = realFetch;

    expect(html).toMatch(/Mock wallet/);
    expect(html).not.toContain("Open request");
    expect(fetched).toBe(0);
  });

  test("a real wallet with the flag off is inert too", async () => {
    const html = await panelHtml({
      enabled: false,
      wallet: { id: "injected", getSigner: async () => SIGNER },
    });
    expect(html).toMatch(/THETADUEL_TRADE is off/);
    expect(html).not.toContain("Open request");
  });

  test("flag on plus a real wallet arms it — and only then", async () => {
    const html = await panelHtml({
      enabled: true,
      wallet: { id: "injected", getSigner: async () => SIGNER },
    });
    expect(html).toContain("Open request");
    expect(html).not.toContain("Read-only preview");
  });

  test("mounting the panel writes nothing to browser storage", async () => {
    const before = globalThis.localStorage?.length ?? 0;
    await panelHtml({ enabled: true, wallet: { id: "injected", getSigner: async () => SIGNER } });
    expect(globalThis.localStorage?.length ?? 0).toBe(before);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The underlying is the protocol's eight, not our two
// ─────────────────────────────────────────────────────────────────────────────

/**
 * plan6 §9: *"No hardcoded `"ETH" | "BTC"` union survives anywhere in the tree."*
 *
 * `RfqInput.underlying` was one of the two live sites when plan 6's Definition of
 * Done was audited. It read `"ETH" | "BTC"`, justified as "nothing else has a
 * Thetanuts options market" — which is false, and is exactly the conflation §7
 * was written to kill: MM *streaming* pricing is two assets, the price feeds are
 * eight, and the resting book sits in between. The SDK's own `RFQUnderlying` is
 * the eight, so our narrower type was us deciding what the venue sells.
 *
 * These tests are the tripwire on the widening — the union must stay equal to the
 * SDK's, and no code path in `rfq.ts` may start branching on which of the eight
 * it was handed.
 */
describe("RfqUnderlying — the SDK's eight, threaded verbatim", () => {
  const EIGHT = ["ETH", "BTC", "SOL", "DOGE", "XRP", "BNB", "PAXG", "AVAX"] as const;

  test("the union mirrors the SDK's own RFQUnderlying, member for member", async () => {
    // Read the declaration rather than trusting a memory of it: an SDK bump that
    // adds or drops an asset must fail HERE, in a test that names the file, and
    // not silently in a request the makers cannot price.
    const dts = await Bun.file(
      new URL(
        "../node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts",
        import.meta.url,
      ),
    ).text();
    const decl = dts.match(/type RFQUnderlying = ([^;]+);/);
    expect(decl).not.toBeNull();
    const sdk = [...decl![1]!.matchAll(/'([A-Z]+)'/g)].map((m) => m[1]!);
    expect(sdk).toEqual([...EIGHT]);
  });

  test("every one of the eight is assignable, and reaches the SDK builder unchanged", async () => {
    for (const underlying of EIGHT) {
      const seen: string[] = [];
      // `satisfies RfqInput` is the compile-time half of the assertion: this
      // block does not typecheck if the union ever narrows back to two.
      const input = { ...INPUT, underlying } satisfies RfqInput;
      const s = spy({
        buildRequest: (given: RfqInput) => {
          seen.push(given.underlying);
          return makeRequest();
        },
      });
      const outcome = await runRfq(input, s.deps, FAST);
      expect({ underlying, status: outcome.status }).toEqual({ underlying, status: "settled" });
      // Threaded, not translated, not defaulted, not refused.
      expect(seen).toEqual([underlying]);
    }
  });

  test("a non-ETH/BTC request is not special-cased anywhere in the flow", async () => {
    // AVAX is the asset the old union excluded and the live board already
    // carries (bid-only). Same call sequence, same statuses, same breadcrumb
    // shape as ETH — if any branch ever grows an ETH/BTC test, this diverges.
    const eth = spy();
    await runRfq(INPUT, eth.deps, FAST);
    const avax = spy();
    await runRfq({ ...INPUT, underlying: "AVAX" }, avax.deps, FAST);

    expect(avax.calls).toEqual(eth.calls);
    expect(avax.storage.writes.length).toBe(eth.storage.writes.length);
    const crumb = JSON.parse(avax.storage.writes[0]![1]!) as { underlying: string };
    expect(crumb.underlying).toBe("AVAX");
  });

  test("widening the type did not widen the panel — TRADABLE stays a subset", async () => {
    // The panel offers two because that is where a bid is likeliest, which is a
    // PRODUCT decision and not a claim about the venue. It must stay inside the
    // union, so a chip can never build a request the type would refuse.
    const panel = await Bun.file(
      new URL("../src/ui/RfqPanel.tsx", import.meta.url),
    ).text();
    const decl = panel.match(/const TRADABLE = \[([^\]]+)\]/);
    expect(decl).not.toBeNull();
    const offered = [...decl![1]!.matchAll(/"([A-Z]+)"/g)].map((m) => m[1]!);
    expect(offered.length).toBeGreaterThan(0);
    for (const sym of offered) expect(EIGHT).toContain(sym as (typeof EIGHT)[number]);
  });
});
