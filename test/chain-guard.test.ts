import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CHAIN_SPLIT_NOTE,
  DATA_CHAIN_ID,
  DATA_CHAIN_NAME,
  DISCONNECTED,
  SIGNING_CHAIN_ID,
  SIGNING_CHAIN_NAME,
  assertSigningChain,
  isWrongChainError,
} from "../src/data/wallet.ts";
import {
  MAX_FILL_USDC,
  runFill,
  runParlayFill,
  type FillDeps,
  type ParlayFillLeg,
} from "../src/desk/fill.ts";
import {
  cancelDuel,
  openDuel,
  refundDuel,
  settleDuel,
  type EscrowDeps,
} from "../src/desk/escrow.ts";
import { createKeyring, openRequest, type RfqDeps } from "../src/desk/rfq.ts";

/**
 * THE CHAIN GUARD.
 *
 * The owner's instruction was one sentence — *"connecting wallet should only be
 * on testnet not mainnet, and work on testnet only"* — and its intent is
 * unambiguous: **nothing the user signs may be able to spend real money.**
 *
 * That instruction turns into two facts that must never be confused, and this
 * file exists because confusing them would be free and catastrophic:
 *
 *  - **Signing happens on Base Sepolia (84532) and nowhere else.** Wallet
 *    connection, `DuelEscrow`, staking, settlement, attestation.
 *  - **The options book stays a Base mainnet (8453) READ.** Thetanuts has no
 *    testnet at all — the shipped SDK's `SupportedChainId` is the literal union
 *    `8453 | 1` (`dist/index.d.ts:112`) and its runtime `CHAIN_CONFIGS_BY_ID`
 *    (`dist/index.js:13`) has exactly those two keys — so the choice was never
 *    "mainnet data or testnet data", it was "mainnet data or no strikes, no
 *    premiums and no vol smile at all". Reading signs nothing and spends
 *    nothing, which is what makes the asymmetry safe rather than a compromise.
 *
 * `docs/reality-check.md` is eight findings long and every one of them is a
 * number or a label that meant something other than what it claimed. A chain id
 * is exactly that kind of label, and it now appears twice with two meanings. So
 * the tests below are deliberately about *distinctness* as much as about
 * refusal: it is not enough that the guard refuses mainnet, the two numbers must
 * also stay separately named everywhere they surface.
 *
 * What this file does NOT do is assert that a fill succeeds. It cannot, and that
 * is the design working — see "what became impossible" at the bottom.
 */

const HOST = "0x71cB05fD1eA1B3d4a7C9e8F2b6D0a3C85e9d4Af2";
const DUEL_ID = `0x${"ab".repeat(32)}`;
const SIGNER = { address: HOST };

/** Every chain the guard must refuse, and why each one is in the list. */
const REFUSED: readonly [string, number | null | undefined][] = [
  // The headline case. Base mainnet is where the money is, where the book is,
  // and — until this change — where the app signed.
  ["Base mainnet", DATA_CHAIN_ID],
  // Ethereum mainnet: the SDK's other supported chain, so the one a reader of
  // `SupportedChainId` might assume is fine.
  ["Ethereum mainnet", 1],
  // A chain nobody meant to be on.
  ["Optimism", 10],
  // Ethereum Sepolia. A *testnet*, and still refused: "testnet" is not the
  // property being checked, "the chain the escrow is deployed to" is. A verdict
  // signed for the wrong domain recovers to a stranger whether or not the money
  // was play money.
  ["Ethereum Sepolia", 11155111],
  // Disconnected, and a dep object that forgot the field. Neither is the
  // signing chain and neither may be coerced into passing — this is the
  // `assertZeroCollateral` coercion trap, applied to a chain id.
  ["no wallet connected", null],
  ["a dep that omitted the field", undefined],
];

// ─────────────────────────────────────────────────────────────────────────────
// The guard itself
// ─────────────────────────────────────────────────────────────────────────────

describe("assertSigningChain is the one refusal, and it cannot be skipped", () => {
  test("the signing chain passes, and it is Base Sepolia", () => {
    expect(SIGNING_CHAIN_ID).toBe(84532);
    expect(SIGNING_CHAIN_NAME).toBe("Base Sepolia");
    expect(assertSigningChain(SIGNING_CHAIN_ID, "a test")).toBe(SIGNING_CHAIN_ID);
  });

  test("the data chain is Base mainnet, and it is NOT the signing chain", () => {
    expect(DATA_CHAIN_ID).toBe(8453);
    expect(DATA_CHAIN_NAME).toBe("Base mainnet");
    // The single most important assertion in this file. If these two ever
    // collapse to one number, every other test here still passes and the app
    // signs on mainnet again.
    expect(DATA_CHAIN_ID).not.toBe(SIGNING_CHAIN_ID);
  });

  for (const [label, chainId] of REFUSED) {
    test(`${label} is refused`, () => {
      expect(() => assertSigningChain(chainId, "a test")).toThrow(/^WRONG_CHAIN:/);
    });
  }

  test("the refusal names the required chain, so the copy cannot be vague", () => {
    try {
      assertSigningChain(DATA_CHAIN_ID, "a fill");
      throw new Error("unreachable — the guard did not refuse");
    } catch (error) {
      const message = String((error as Error).message);
      expect(message).toContain("a fill");
      expect(message).toContain(String(SIGNING_CHAIN_ID));
      expect(message).toContain(SIGNING_CHAIN_NAME);
      // And it says why mainnet in particular is refused, rather than treating
      // it as just another wrong chain.
      expect(message).toContain("READ");
    }
  });

  test("isWrongChainError recognises the guard and nothing else", () => {
    try {
      assertSigningChain(1, "a test");
    } catch (error) {
      expect(isWrongChainError(error)).toBe(true);
    }
    expect(isWrongChainError(new Error("RATE_LIMIT: too many requests"))).toBe(false);
    expect(isWrongChainError(null)).toBe(false);
  });

  test("there is no override — the guard takes no flag that could lift it", () => {
    // A second argument that could disable the check would be the whole point
    // undone. `assertSigningChain` takes a chain and a label, and the label is
    // only ever interpolated into the message.
    expect(assertSigningChain.length).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Every signing path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A dep object that records whether anything was reached past the guard.
 *
 * The assertion that matters in this section is not merely "it failed" — it is
 * **"and it touched nothing"**. A guard that refuses after calling `getSigner`
 * has already opened a wallet prompt; a guard that refuses after `approve` has
 * already spent gas. So every dep here throws if it is called at all, and the
 * absence of that throw is the proof.
 */
function tripwire<T extends object>(over: T): T & { touched: string[] } {
  const touched: string[] = [];
  const trap = (name: string) =>
    (async () => {
      touched.push(name);
      throw new Error(`REACHED ${name} — the guard let this through`);
    }) as never;
  return {
    getSigner: trap("getSigner"),
    address: trap("address"),
    approve: trap("approve"),
    ...over,
    touched,
  } as T & { touched: string[] };
}

describe("every path that can reach a signer refuses a mainnet chain", () => {
  test("runFill", async () => {
    const deps = tripwire<Partial<FillDeps>>({
      walletId: "injected",
      chainId: DATA_CHAIN_ID,
    }) as unknown as FillDeps & { touched: string[] };

    const out = await runFill({ orderId: "1" } as never, 1_000000n, deps);

    expect(out.status).toBe("failed");
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.code).toBe("SIGNER_REQUIRED");
    // "switch", not "connect": the wallet IS connected, it is just in the wrong
    // place, and telling someone to connect a wallet they already connected is
    // the bug this distinction has always existed to prevent.
    expect(out.error.action).toBe("switch");
    expect(out.error.recovery).toContain(SIGNING_CHAIN_NAME);
    expect(deps.touched).toEqual([]);
  });

  test("runParlayFill (the multi-leg slip)", async () => {
    const deps = tripwire<Partial<FillDeps>>({
      walletId: "injected",
      chainId: DATA_CHAIN_ID,
      optionBook: HOST,
    }) as unknown as FillDeps & { touched: string[] };

    const legs: ParlayFillLeg[] = [
      {
        id: "leg-1",
        label: "ETH-27SEP-4400-C",
        ref: { orderId: "1" } as never,
        usdcAmount: 1_000000n,
      } as unknown as ParlayFillLeg,
    ];
    const out = await runParlayFill(legs, deps);

    // "refused", not "failed": the slip's own vocabulary for a run that never
    // started. Either way nothing was signed.
    expect(out.status).toBe("refused");
    // `error` is optional on the slip result — a refusal that carried none
    // would be a slip that stopped for no stated reason, which is its own bug.
    if (!out.error) throw new Error("the slip refused without saying why");
    expect(out.error.action).toBe("switch");
    expect(deps.touched).toEqual([]);
  });

  test("openDuel", async () => {
    const deps = tripwire<Partial<EscrowDeps>>({
      walletId: "injected",
      chainId: DATA_CHAIN_ID,
      escrow: HOST,
    }) as unknown as EscrowDeps & { touched: string[] };

    const out = await openDuel(DUEL_ID, 1_000000n, deps);

    expect(out.status).toBe("failed");
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.action).toBe("switch");
    // The staking rule: every failure degrades to PTS-only, and the copy says
    // the duel is unaffected. A chain refusal is not exempt from it.
    expect(out.error.recovery).toContain("PTS");
    expect(deps.touched).toEqual([]);
  });

  test("settleDuel", async () => {
    const deps = tripwire<Partial<EscrowDeps>>({
      walletId: "injected",
      chainId: DATA_CHAIN_ID,
      escrow: HOST,
      now: () => 0,
    }) as unknown as EscrowDeps & { touched: string[] };

    const out = await settleDuel(
      {
        duelId: DUEL_ID,
        winner: HOST,
        deadline: Math.floor(Date.now() / 1000) + 3600,
        signature: `0x${"cd".repeat(65)}`,
      },
      deps,
    );

    expect(out.status).toBe("failed");
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.action).toBe("switch");
    expect(deps.touched).toEqual([]);
  });

  test("refundDuel and cancelDuel", async () => {
    for (const run of [refundDuel, cancelDuel]) {
      const deps = tripwire<Partial<EscrowDeps>>({
        walletId: "injected",
        chainId: DATA_CHAIN_ID,
        escrow: HOST,
      }) as unknown as EscrowDeps & { touched: string[] };

      const out = await run(DUEL_ID, deps);

      expect(out.status).toBe("failed");
      if (out.status !== "failed") throw new Error("unreachable");
      expect(out.error.action).toBe("switch");
      expect(deps.touched).toEqual([]);
    }
  });

  test("openRequest", async () => {
    const deps = tripwire<Partial<RfqDeps>>({
      walletId: "injected",
      chainId: DATA_CHAIN_ID,
      generateKeyPair: (() => {
        throw new Error("REACHED generateKeyPair — the guard let this through");
      }) as never,
    }) as unknown as RfqDeps & { touched: string[] };

    // A live keyring, because `openRequest` checks for a lost key BEFORE the
    // signer step — a forgotten keyring would short-circuit above the guard and
    // this test would pass without exercising it.
    const keyring = createKeyring({
      privateKey: `0x${"11".repeat(32)}`,
      compressedPublicKey: `0x${"02".repeat(33)}`,
      publicKey: `0x${"04".repeat(65)}`,
    });

    const out = await openRequest(
      // A fully valid request: the cap stage runs ABOVE the signer step and
      // would otherwise refuse this for `SHORT_REFUSED` or `SIZE`, and the test
      // would pass without ever reaching the chain guard.
      {
        requester: HOST,
        underlying: "ETH",
        optionType: "CALL",
        isLong: true,
        reserveUsdc: 1_000000n,
      } as never,
      keyring,
      deps,
    );

    expect(out.status).toBe("failed");
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.action).toBe("switch");
    expect(deps.touched).toEqual([]);
  });

  test("the mock wallet is still refused, and the chain guard did not replace it", async () => {
    // Two independent controls, and adding one must not have removed the other.
    // On the correct chain, the mock is still turned away before `getSigner`.
    const deps = tripwire<Partial<FillDeps>>({
      walletId: "mock",
      chainId: SIGNING_CHAIN_ID,
    }) as unknown as FillDeps & { touched: string[] };

    const out = await runFill({ orderId: "1" } as never, 1_000000n, deps);

    expect(out.status).toBe("failed");
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.action).toBe("connect");
    expect(deps.touched).toEqual([]);
  });

  test("the size cap still runs BEFORE the chain guard", async () => {
    // `runFill`'s cap is documented as touching no dep at all, and the
    // "cap-before-network" property is pinned elsewhere. Inserting a guard
    // above the signer must not have pushed the cap below it — an over-cap
    // fill on the wrong chain should still report SIZE, because the amount is
    // wrong regardless of where it would have been sent.
    const deps = tripwire<Partial<FillDeps>>({
      walletId: "injected",
      chainId: DATA_CHAIN_ID,
    }) as unknown as FillDeps & { touched: string[] };

    const out = await runFill(
      { orderId: "1" } as never,
      MAX_FILL_USDC + 1n,
      deps,
    );

    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.code).toBe("SIZE");
    expect(deps.touched).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The wallet tier
// ─────────────────────────────────────────────────────────────────────────────

const ROOT = join(import.meta.dir, "..");
const read = (p: string) => Bun.file(join(ROOT, p)).text();

describe("the wallet refuses to operate off the signing chain", () => {
  test("no wallet implementation may hand back a signer on the wrong chain", async () => {
    // Source-level, because these are React hooks over an injected provider and
    // an AppKit store — neither is constructible in a headless test process.
    // The property is structural anyway: `getSigner` must consult
    // `wrongNetwork` and throw, before it builds a `BrowserProvider`.
    for (const path of ["src/wallet/injected.ts", "src/wallet/appkit.tsx"]) {
      const src = await read(path);
      const from = src.indexOf("getSigner:");
      expect(from).toBeGreaterThan(-1);
      const body = src.slice(from, from + 1200);

      expect(body).toContain("identity.wrongNetwork");
      expect(body).toContain("WRONG_CHAIN:");
      // The refusal comes before the provider is built, or it is not a refusal.
      expect(body.indexOf("wrongNetwork")).toBeLessThan(body.indexOf("BrowserProvider"));
      // And the provider is pinned to the SIGNING chain, never the data chain.
      expect(body).toContain("SIGNING_CHAIN_ID");
      expect(body).not.toContain("DATA_CHAIN_ID");
    }
  });

  test("`wrongNetwork` is computed against the signing chain in every tier", async () => {
    for (const path of ["src/wallet/injected.ts", "src/wallet/appkit.tsx"]) {
      const src = await read(path);
      expect(src).toMatch(/wrongNetwork:[^\n]*SIGNING_CHAIN_ID/);
      expect(src).not.toMatch(/wrongNetwork:[^\n]*8453/);
    }
  });

  test("AppKit is offered exactly one network, and it is the testnet", async () => {
    const src = await read("src/wallet/config.ts");
    expect(src).toContain("NETWORKS = [baseSepolia] as const");
    // Not merely "sepolia is present" — mainnet must be ABSENT, or it is one
    // dropdown away and AppKit treats the switch as supported.
    expect(src).not.toMatch(/\bbase\b(?!Sepolia)/);
  });

  test("the mock never reports a mainnet chain and still cannot sign", async () => {
    const src = await read("src/wallet/mock.ts");
    expect(src).toContain("chainId: SIGNING_CHAIN_ID");
    expect(src).toContain("mock wallet cannot sign");
    expect(src).not.toContain("8453");
  });

  test("nothing under src/ still calls the old switchToBase", async () => {
    // The rename is load-bearing: "Base" is ambiguous in this codebase now, and
    // an ambiguous name on a network switch is how someone ends up on mainnet
    // believing they are on a testnet.
    for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(ROOT, "src") })) {
      const src = await read(join("src", f));
      // The identifier, not the word: `src/data/wallet.ts` names the old
      // spelling in the doc comment that explains why it was renamed, and a
      // test that forbade the explanation would be forbidding the reason.
      expect(src).not.toMatch(/switchToBase\s*[(:,]/);
      expect(src).not.toMatch(/\.switchToBase/);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The config surface
// ─────────────────────────────────────────────────────────────────────────────

const INDEX_SRC = await read("index.ts");

/** The `/api/config` response literal, as source text. `index.ts` imports
 *  `src/index.html`, which only Bun's HTML bundler resolves, so the handler
 *  cannot be imported into a test process — `test/market-route.test.ts` reads
 *  the same block the same way and for the same reason. */
const CONFIG_BODY = (() => {
  const from = INDEX_SRC.indexOf('"/api/config"');
  return from < 0 ? "" : INDEX_SRC.slice(from, INDEX_SRC.indexOf("cache-control", from));
})();

describe("/api/config reports both chains, distinctly", () => {
  test("the block read is the one the handler serves", () => {
    expect(CONFIG_BODY).toContain('"/api/config"');
    expect(CONFIG_BODY).toContain("features:");
  });

  test("it emits a signing chain and a data chain under separate names", () => {
    expect(CONFIG_BODY).toContain("signingChainId: SIGNING_CHAIN_ID");
    expect(CONFIG_BODY).toContain("dataChainId: DATA_CHAIN_ID");
  });

  test("the ambiguous `chainId` key is GONE, not merely joined", () => {
    // The whole finding. One field cannot carry two chains without lying about
    // one of them, and a `chainId` left beside the two honest keys would be a
    // third answer for clients to pick from — which is how the eight bugs in
    // `docs/reality-check.md` happened.
    expect(CONFIG_BODY).not.toMatch(/^\s*chainId\s*:/m);
  });

  test("no client reads the old key, and staking reads the signing one", async () => {
    for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(ROOT, "src") })) {
      const src = await read(join("src", f));
      // `body.chainId` off a config response is the exact mistake this rename
      // exists to make impossible.
      expect(src).not.toMatch(/body\.chainId/);
    }
    const stake = await read("src/state/stake.ts");
    expect(stake).toContain("body.signingChainId");
    // And it must NOT fall back to a legacy `chainId`: a server that predates
    // the split would otherwise arm staking against the chain we refuse.
    expect(stake).not.toContain("body.chainId");
  });

  test("staking's default config is the signing chain, so it fails closed", async () => {
    const { STAKE_OFF } = await import("../src/desk/escrow.ts");
    expect(STAKE_OFF.chainId).toBe(SIGNING_CHAIN_ID);
    expect(STAKE_OFF.enabled).toBe(false);
  });

  test("stake and trade are still OPT-IN — the guard did not license loosening them", () => {
    // Two locks. Adding the chain guard must not have removed the flag, or the
    // second one holding is the reason the first came off.
    expect(CONFIG_BODY).toContain('Bun.env.THETADUEL_STAKE === "on"');
    expect(CONFIG_BODY).toContain('Bun.env.THETADUEL_TRADE === "on"');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// One connection, kept
// ─────────────────────────────────────────────────────────────────────────────

describe("connecting once is enough, and staying connected does not weaken the guard", () => {
  test("`settled` starts false, so no screen may decide before the restore answers", () => {
    expect(DISCONNECTED.settled).toBe(false);
    expect(DISCONNECTED.connected).toBe(false);
    expect(DISCONNECTED.chainId).toBe(null);
  });

  test("App has exactly one connect call site, and it is guarded", async () => {
    const app = await read("src/App.tsx");
    // There were two — the header's and the arena hub's — and two call sites
    // meant no single place to say when connecting is the wrong thing to do.
    expect([...app.matchAll(/void active\.connect\(\)/g)]).toHaveLength(1);
    expect(app).toContain("const connectOnce");
    // Both conditions, in the one place.
    expect(app).toMatch(/if \(identity\.connected \|\| !identity\.settled\) return;/);
    // And every surface goes through it.
    expect([...app.matchAll(/onConnect=\{connectOnce\}/g)].length).toBeGreaterThanOrEqual(2);
  });

  test("no surface offers to connect while the restore is in flight", async () => {
    const header = await read("src/ui/Header.tsx");
    // The button label and the click handler both have to know: a disabled-
    // looking button that still fires is the same popup.
    expect(header).toContain("if (!wallet.settled) return");
    expect(header).toMatch(/!wallet\.settled.*Restoring/s);

    const hub = await read("src/views/Hub.tsx");
    expect(hub).toContain("disabled={!identity.settled}");
    expect(hub).toContain("!identity.settled ? \"Restoring…\"");
  });

  test("the restore is silent — eth_accounts, never eth_requestAccounts", async () => {
    const src = await read("src/wallet/injected.ts");
    // They differ in exactly the way that matters: the requesting form opens
    // the wallet's approval prompt. Using it in the restore would turn every
    // page load into a popup — worse than the defect it was meant to fix.
    const restore = src.slice(src.indexOf("Reconnect silently"), src.indexOf("Track account"));
    expect(restore).toContain('method: "eth_accounts"');
    // The call, not the word: the comment above it names the method precisely
    // so a future reader knows which one is forbidden and why.
    expect(restore).not.toContain('method: "eth_requestAccounts"');
  });

  test("only a non-authoritative pointer is persisted — never a key or an address", async () => {
    const src = await read("src/wallet/injected.ts");
    expect(src).toContain('LAST_WALLET_KEY = "thetaduel.wallet.rdns"');
    // The only thing written is the rdns. An address, a signature or a key in
    // browser storage would be authority at rest, which this must never be.
    const writes = [...src.matchAll(/setItem\(([^)]*)\)/g)].map((m) => m[1]!);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toBe("LAST_WALLET_KEY, rdns");
    expect(src).not.toMatch(/setItem\([^)]*(address|privateKey|signature)/i);
  });

  test("disconnect is still reachable, and it forgets the stored wallet", async () => {
    const src = await read("src/wallet/injected.ts");
    const dis = src.slice(src.indexOf("disconnect: async"), src.indexOf("openAccount:"));
    // "Never ask again" must not become "cannot get out". A disconnect that
    // left the pointer would be undone by the next reload.
    expect(dis).toContain("rememberWallet(null)");
  });

  test("A RESTORED SESSION ON MAINNET STILL CANNOT SIGN", async () => {
    // The single most important test in this section. "Stay connected" is about
    // not re-asking for a *connection*; it was never permission to skip the
    // *chain* check, and a silently-restored mainnet session that could sign
    // would be strictly worse than the behaviour it replaced.
    //
    // The restore reads the chain back from the wallet rather than from
    // storage, so a session restored while the wallet sits on mainnet produces
    // `chainId: 8453` — and every signing path refuses it, exactly as a
    // freshly-connected mainnet wallet is refused.
    const deps = tripwire<Partial<FillDeps>>({
      walletId: "injected",
      chainId: DATA_CHAIN_ID,
    }) as unknown as FillDeps & { touched: string[] };

    const out = await runFill({ orderId: "1" } as never, 1_000000n, deps);
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.action).toBe("switch");
    expect(deps.touched).toEqual([]);

    // And the wallet tier does not special-case a restored session either: the
    // chain check in `getSigner` is unconditional, with no "restored" branch.
    const src = await read("src/wallet/injected.ts");
    const getSigner = src.slice(src.indexOf("getSigner: async"));
    expect(getSigner).toContain("identity.wrongNetwork");
    // No BRANCH on a restored or settled state — the comment may (and does)
    // discuss one, but there must be no `if` that could let one through.
    expect(getSigner).not.toMatch(/if \([^)]*(restored|settled)/);
    // And the chain check stands between the entry and the provider — an
    // unconditional gate on the way to a signer, not a branch beside one.
    const thrown = getSigner.slice(0, getSigner.indexOf("BrowserProvider"));
    expect(thrown).toContain("if (identity.wrongNetwork)");
    expect(thrown).toContain("throw new Error(");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// What became impossible, and where the screens say so
// ─────────────────────────────────────────────────────────────────────────────

describe("the screens say a fill cannot complete, rather than implying it can", () => {
  test("there is one sentence for the split, and it names both chains", () => {
    expect(CHAIN_SPLIT_NOTE).toContain(DATA_CHAIN_NAME);
    expect(CHAIN_SPLIT_NOTE).toContain(String(DATA_CHAIN_ID));
    expect(CHAIN_SPLIT_NOTE).toContain(SIGNING_CHAIN_NAME);
    expect(CHAIN_SPLIT_NOTE).toContain(String(SIGNING_CHAIN_ID));
    // And it says what the reader actually wants to know.
    expect(CHAIN_SPLIT_NOTE).toContain("real money");
  });

  test("the desk's fill button carries it, next to the button", async () => {
    // Not "the button was removed" — removing it would hide that the pricing
    // path above is real and working. Leaving it silent would be a button that
    // can only ever fail, which is the species of quiet untruth
    // `docs/reality-check.md` catalogues. So: left in place, and labelled.
    const src = await read("src/views/Parlay.tsx");
    expect(src).toContain('data-role="chain-split"');
    expect(src).toContain("CHAIN_SPLIT_NOTE");
    expect(src).toContain("stop at the chain guard rather than transact");
  });

  test("the wallet picker names both chains rather than one", async () => {
    const src = await read("src/ui/WalletPicker.tsx");
    // It printed `BASE MAINNET · 8453` alone — now the chain we specifically
    // refuse to sign on.
    expect(src).not.toContain("BASE MAINNET · 8453");
    expect(src).toContain("SIGNS ON");
    expect(src).toContain("READ ONLY");
  });

  test("no screen claims a testnet options market exists", async () => {
    // The line the app must never cross. There is no Thetanuts testnet: no
    // resting orders, no RANGER zones, no strikes, no smile. Any copy pairing
    // the testnet with the book would be inventing a venue.
    const claims = [
      /testnet (book|orders|strikes|market|premiums)/i,
      /(book|orders|strikes|market|premiums) on (base )?sepolia/i,
      /sepolia (book|order book|options market)/i,
    ];
    for (const f of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: join(ROOT, "src") })) {
      const src = await read(join("src", f));
      for (const claim of claims) expect(src).not.toMatch(claim);
    }
  });

  test("the SDK really has no testnet — this is checked, not assumed", async () => {
    // The constraint the whole design rests on, re-verified against the shipped
    // package rather than taken on trust from a plan document. If Thetanuts
    // ever ships a testnet deployment, this test fails and the split above
    // should be revisited — that is the point of asserting it here.
    const dts = await Bun.file(
      join(ROOT, "node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts"),
    ).text();
    expect(dts).toContain("type SupportedChainId = 8453 | 1;");

    const js = await Bun.file(
      join(ROOT, "node_modules/@thetanuts-finance/thetanuts-client/dist/index.js"),
    ).text();
    // The runtime table, not just the type: a type is erased, a config is not.
    const ids = new Set([...js.matchAll(/chainId: (\d+)/g)].map((m) => m[1]!));
    expect([...ids].sort()).toEqual(["1", "8453"]);
    expect(js).not.toMatch(/84532|11155111/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The limits, relaxed on the testnet and kept on mainnet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The owner asked for no minimum and no maximum on anything wallet-related, and
 * specifically for **0.001 of a testnet token to work in every function**.
 *
 * Both limits existed for the same reason and only one of them was ours:
 *
 *  - `MAX_FILL_USDC` ($2) is a code cap in `fill.ts`, checked above any
 *    approval, and it existed because a fill spent real money on mainnet.
 *  - `MIN_STAKE` ($0.10) was enforced **on chain** by
 *    `require(stake >= MIN_STAKE)` — not a form rule, and unreachable by any
 *    client change. It could only move because `DuelEscrow` has never been
 *    deployed, and it can never move again once it is.
 *
 * Neither is relaxed globally. The cap is tied to the chain, so a future
 * mainnet deploy does not silently inherit an uncapped fill path — a deleted
 * constant would have been a trap for whoever re-enables mainnet, which is the
 * same species of quiet inheritance the chain split exists to prevent.
 */
describe("0.001 works, and relaxing a limit did not relax the wrong thing", () => {
  test("the fill cap is lifted on the signing chain and kept on mainnet", async () => {
    const { MAX_FILL_USDC: CAP, maxFillFor } = await import("../src/desk/fill.ts");
    expect(maxFillFor(SIGNING_CHAIN_ID)).toBe(null);
    // Unchanged where it still means something.
    expect(CAP).toBe(2_000000n);
    expect(maxFillFor(DATA_CHAIN_ID)).toBe(CAP);
    expect(maxFillFor(1)).toBe(CAP);
    // And it fails CLOSED on an unknown chain: a cap that relaxed when it could
    // not tell where it was would relax exactly when it is needed most.
    expect(maxFillFor(null)).toBe(CAP);
    expect(maxFillFor(undefined)).toBe(CAP);
  });

  test("a fill far above the old cap is allowed on the signing chain", async () => {
    const deps = tripwire<Partial<FillDeps>>({
      walletId: "injected",
      chainId: SIGNING_CHAIN_ID,
    }) as unknown as FillDeps & { touched: string[] };

    // A thousand times the mainnet cap. It must NOT be refused for SIZE — it
    // stops at `getSigner` instead, which is the next step and proves the cap
    // let it through.
    const out = await runFill({ orderId: "1" } as never, MAX_FILL_USDC * 1000n, deps);
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.code).not.toBe("SIZE");
    expect(deps.touched).toEqual(["getSigner"]);
  });

  test("zero and negative are still refused — that is correctness, not size", async () => {
    for (const amount of [0n, -1n]) {
      const deps = tripwire<Partial<FillDeps>>({
        walletId: "injected",
        chainId: SIGNING_CHAIN_ID,
      }) as unknown as FillDeps & { touched: string[] };

      const out = await runFill({ orderId: "1" } as never, amount, deps);
      if (out.status !== "failed") throw new Error("unreachable");
      // A fill of nothing is not a small fill, it is a malformed one, and the
      // instruction to remove limits was about size.
      expect(out.error.code).toBe("SIZE");
      expect(deps.touched).toEqual([]);
    }
  });

  test("the stake floor is 0.001, in the client and in the contract, identically", async () => {
    const { MIN_STAKE_USDC } = await import("../src/desk/escrow.ts");
    expect(MIN_STAKE_USDC).toBe(1_000n);

    // The client constant is a MIRROR of an on-chain `require`. If the two ever
    // disagree the panel either refuses stakes the escrow would take, or spends
    // gas to be refused — so the contract is read, not assumed.
    const sol = await read("contracts/DuelEscrow.sol");
    const declared = sol.match(/uint128 public constant MIN_STAKE = ([0-9_]+);/);
    expect(declared).not.toBe(null);
    expect(BigInt(declared![1]!.replace(/_/g, ""))).toBe(MIN_STAKE_USDC);
    // And the floor is still enforced on chain, not merely in the UI.
    expect(sol).toContain('require(stake >= MIN_STAKE, "stake too small")');
  });

  test("0.001 round-trips through parse and display without becoming zero", async () => {
    const { parseStakeUsdc, usd } = await import("../src/desk/escrow.ts");
    const { usdText } = await import("../src/desk/fill.ts");

    // 6dp: 0.001 USDC is 1,000 base units, a hundredth of the old floor.
    expect(parseStakeUsdc("0.001")).toBe(1_000n);
    expect(parseStakeUsdc(".001")).toBe(1_000n);
    expect(parseStakeUsdc("$0.001")).toBe(1_000n);

    // The display is where a sub-cent amount usually dies. `usdText` pads to two
    // decimals but does not TRUNCATE to two, so 1,000 units must not print as
    // `$0.00` — a screen showing zero for a real stake is exactly the class of
    // bug `docs/reality-check.md` collects.
    expect(usdText(1_000n)).toBe("0.001");
    expect(usd(1_000n)).toBe("$0.001");
    expect(usd(1_000n)).not.toBe("$0.00");

    // The smallest representable unit still survives the round trip.
    expect(parseStakeUsdc("0.000001")).toBe(1n);
    expect(usdText(1n)).toBe("0.000001");

    // And the old shapes still parse, unchanged.
    expect(parseStakeUsdc("0.10")).toBe(100_000n);
    expect(parseStakeUsdc("1")).toBe(1_000000n);
    expect(usdText(1_000000n)).toBe("1.00");
  });

  test("a 0.001 stake settles and pays the rake exactly", async () => {
    const { payoutOf, RAKE_BPS, BPS } = await import("../src/desk/escrow.ts");

    const stake = 1_000n;
    const pot = stake * 2n;
    // 0.001 x 2 x 0.96 = 0.00192, representable at 6dp with no dust.
    expect(payoutOf(stake)).toBe(1_920n);

    // The contract's invariant, at the new floor: payout + rake == 2 x stake
    // EXACTLY. Integer division floors, so this is the assertion that says the
    // new floor did not eat a base unit at an amount nobody had tried before.
    const rake = (pot * RAKE_BPS) / BPS;
    expect(payoutOf(stake) + rake).toBe(pot);
    expect(rake).toBe(80n);

    // One base unit — the true minimum the arithmetic can express. The rake
    // floors to zero and the winner takes the whole pot; nothing is lost, which
    // is the property that matters. The floor always favours the winner.
    expect(payoutOf(1n) + (2n * RAKE_BPS) / BPS).toBe(2n);
  });

  test("a stake below the floor is still refused before any approval", async () => {
    const { MIN_STAKE_USDC } = await import("../src/desk/escrow.ts");
    const deps = tripwire<Partial<EscrowDeps>>({
      walletId: "injected",
      chainId: SIGNING_CHAIN_ID,
      escrow: HOST,
    }) as unknown as EscrowDeps & { touched: string[] };

    const out = await openDuel(DUEL_ID, MIN_STAKE_USDC - 1n, deps);
    if (out.status !== "failed") throw new Error("unreachable");
    expect(out.error.code).toBe("STAKE_TOO_SMALL");
    // The floor is on chain; refusing here only saves the gas of being refused
    // there, so it must happen before anything is touched.
    expect(deps.touched).toEqual([]);
  });

  test("0.001 itself is accepted — it reaches the signer rather than the floor", async () => {
    const deps = tripwire<Partial<EscrowDeps>>({
      walletId: "injected",
      chainId: SIGNING_CHAIN_ID,
      escrow: HOST,
    }) as unknown as EscrowDeps & { touched: string[] };

    const out = await openDuel(DUEL_ID, 1_000n, deps);
    if (out.status !== "failed") throw new Error("unreachable");
    // Not STAKE_TOO_SMALL. It got past the guard step and stopped at the signer,
    // which is the tripwire firing — the proof that 0.001 is a legal stake.
    expect(out.error.code).not.toBe("STAKE_TOO_SMALL");
    expect(deps.touched).toEqual(["getSigner"]);
  });

  test("there is still no MAXIMUM stake, only a warning", async () => {
    const { LARGE_STAKE_USDC } = await import("../src/desk/escrow.ts");
    // The owner's documented decision, and lowering a floor must not have
    // introduced a ceiling. A warning that a number is large is not a cap and
    // must never behave like one.
    expect(LARGE_STAKE_USDC).toBe(20_000000n);
    const sol = await read("contracts/DuelEscrow.sol");
    expect(sol).not.toMatch(/require\(stake <=/);
  });

  test("nothing implies the relaxed limits would be safe on mainnet", async () => {
    const sol = await read("contracts/DuelEscrow.sol");
    // The contract is unaudited and uncapped, and a worthless denomination is a
    // fact about the token rather than about the bytecode. The risk note must
    // say so rather than reading as retired.
    expect(sol).toContain("unaudited");
    expect(sol).toContain("DENOMINATION and not about this");
    expect(sol).toContain("argued again from scratch");
  });
});
