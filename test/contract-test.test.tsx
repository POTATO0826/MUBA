import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { WalletSource } from "../src/data/wallet.ts";
import { parseRoute, routePath } from "../src/lib/route.ts";
import {
  BASE_SEPOLIA_DUEL_ESCROW_ADDRESS,
  DUEL_ESCROW_FUNCTIONS,
  DUEL_TIMEOUT_SECONDS,
  STATUS_FULL,
  STATUS_NONE,
  STATUS_OPEN,
  STATUS_REFUNDED,
  STATUS_SETTLED,
  duelIdFromInput,
  isKeyStartable,
  duelWriteBlocker,
  validContractAddress,
  type DuelState,
} from "../src/utils/duelescrow.ts";
import { ContractTest } from "../src/views/ContractTest.tsx";

const wallet: WalletSource = {
  id: "mock",
  identity: {
    address: null,
    chainId: null,
    walletName: null,
    connected: false,
    connecting: false,
    // `settled` is required on `WalletIdentity`: the restore has finished and
    // there provably is no session. A fixture that omitted it would be the
    // "still restoring" state, which no surface may draw a connect button in.
    settled: true,
    wrongNetwork: false,
  },
  async connect() {},
  async disconnect() {},
  async openAccount() {},
  async switchToSigningChain() {},
  async getSigner() { return null; },
};

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
});

describe("DuelEscrow /test console", () => {
  test("is read-only: the console renders no write buttons at all", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ContractTest wallet={wallet} initialAddress="" />);
    });

    expect(container.textContent).toContain("BASE SEPOLIA · 84532");
    // The address form and its check button are the only controls left.
    expect(container.textContent).toContain("DUEL ESCROW ADDRESS");

    // Every transaction control is gone, along with the coverage grid and the
    // transaction panel that only existed to report on them.
    for (const removed of [
      "Stake testnet ETH",
      "Pay winner",
      "Forfeit entire stake",
      "Refund my stake",
      "Cancel open duel",
      "FUNCTION COVERAGE",
      "functions linked",
      "8 reads · 5 writes",
      "Transaction buttons are unavailable",
      "WALLET + TRANSACTION STATE",
    ]) {
      expect(container.textContent).not.toContain(removed);
    }

    const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((label) => label.includes("Check contract"))).toBe(true);
    expect(buttons.some((label) => label.includes("Refresh reads"))).toBe(true);
    // Nothing on the page can send a transaction any more.
    expect(buttons.some((label) => /stake|winner|forfeit|refund|cancel/i.test(label))).toBe(false);
  });

  test("the test route and address helpers are deterministic", () => {
    expect(parseRoute("/test", "")).toEqual({ tab: "test", lobbyId: null, seed: null });
    expect(routePath("test", null, null)).toBe("/test");
    // /testing is the GameStake console and must not collide with /test.
    expect(parseRoute("/testing", "")).toEqual({ tab: "testing", lobbyId: null, seed: null });
    expect(routePath("testing", null, null)).toBe("/testing");
    expect(duelIdFromInput("thetaduel-test-1")).toMatch(/^0x[0-9a-f]{64}$/);
    expect(duelIdFromInput("thetaduel-test-1")).toBe(duelIdFromInput("thetaduel-test-1"));
    expect(validContractAddress("0x1111111111111111111111111111111111111111")).toBe(true);
    expect(validContractAddress("")).toBe(false);
    expect(BASE_SEPOLIA_DUEL_ESCROW_ADDRESS).toBe("0xc683A484FC42eD99c48ad8E19F841388536deB3E");
  });
});

const A = "0xd69c6657D1997b4C27D6bF70e8f15F0f55Ef12bE";
const B = "0x23577Abf42FF22F45210c005267Ceb06A867b44d";
const OUTSIDER = "0x1111111111111111111111111111111111111111";
const ZERO = "0x0000000000000000000000000000000000000000";
const NOW = 1_800_000_000;

function duel(over: Partial<DuelState>): DuelState {
  return {
    a: A,
    b: ZERO,
    stake: 1_000_000_000_000_000n,
    fullAt: 0n,
    status: STATUS_OPEN,
    aWithdrawn: false,
    bWithdrawn: false,
    ...over,
  };
}

describe("duelWriteBlocker mirrors the DuelEscrow requires", () => {
  test("an unread duel gates nothing — the contract stays the authority", () => {
    for (const m of ["stake", "winStake", "loseStake", "refund", "cancel"] as const) {
      expect(duelWriteBlocker(m, null, A, NOW)).toBeNull();
    }
  });

  test("a fresh key accepts a stake and nothing else", () => {
    const fresh = duel({ status: STATUS_NONE, a: ZERO, stake: 0n });
    expect(duelWriteBlocker("stake", fresh, A, NOW)).toBeNull();
    expect(duelWriteBlocker("cancel", fresh, A, NOW)).toContain("open duel");
    expect(duelWriteBlocker("winStake", fresh, A, NOW)).toContain("full duel");
    expect(duelWriteBlocker("loseStake", fresh, A, NOW)).toContain("full duel");
    expect(duelWriteBlocker("refund", fresh, A, NOW)).toContain("filled");
  });

  test("an open duel: the opener cancels, a different wallet takes seat two", () => {
    const open = duel({ status: STATUS_OPEN });
    expect(duelWriteBlocker("stake", open, A, NOW)).toContain("different wallet");
    expect(duelWriteBlocker("stake", open, B, NOW)).toBeNull();
    expect(duelWriteBlocker("cancel", open, A, NOW)).toBeNull();
    expect(duelWriteBlocker("cancel", open, B, NOW)).toContain("Only the wallet that opened");
    expect(duelWriteBlocker("winStake", open, A, NOW)).toContain("full duel");
  });

  test("a full duel settles, refuses more stake, and refunds only after the timeout", () => {
    const filledAt = BigInt(NOW - 60);
    const full = duel({ status: STATUS_FULL, b: B, fullAt: filledAt });
    expect(duelWriteBlocker("stake", full, OUTSIDER, NOW)).toContain("Both seats are taken");
    expect(duelWriteBlocker("cancel", full, A, NOW)).toContain("open duel");
    expect(duelWriteBlocker("winStake", full, A, NOW)).toBeNull();
    expect(duelWriteBlocker("loseStake", full, A, NOW)).toBeNull();
    expect(duelWriteBlocker("loseStake", full, B, NOW)).toBeNull();
    expect(duelWriteBlocker("loseStake", full, OUTSIDER, NOW)).toContain("seated player");

    expect(duelWriteBlocker("refund", full, A, NOW)).toContain("six-hour timeout");
    // The contract's comparison is strict: `block.timestamp > fullAt + TIMEOUT`.
    // Exactly at the boundary it still reverts, so the gate must still block.
    const boundary = Number(filledAt) + DUEL_TIMEOUT_SECONDS;
    expect(duelWriteBlocker("refund", full, A, boundary)).toContain("six-hour timeout");
    expect(duelWriteBlocker("refund", full, A, boundary + 1)).toBeNull();
    const expired = NOW + DUEL_TIMEOUT_SECONDS + 1;
    expect(duelWriteBlocker("refund", full, A, expired)).toBeNull();
    expect(duelWriteBlocker("refund", full, OUTSIDER, expired)).toContain("seated player");
    expect(
      duelWriteBlocker("refund", { ...full, aWithdrawn: true }, A, expired),
    ).toContain("already withdrawn");
    expect(duelWriteBlocker("refund", { ...full, aWithdrawn: true }, B, expired)).toBeNull();
  });

  test("the exact on-chain state of the burned thetaduel-test-1 key blocks every write", () => {
    // Read live from 0xc683A484…deB3E: opened by A, then cancelled.
    const spent = duel({ status: STATUS_REFUNDED, fullAt: 0n, aWithdrawn: true, bWithdrawn: true });
    for (const m of ["stake", "winStake", "loseStake", "cancel"] as const) {
      expect(duelWriteBlocker(m, spent, A, NOW)).toBeTruthy();
    }
    expect(duelWriteBlocker("stake", spent, A, NOW)).toContain("spent");
    // `refund` reverts "never filled" on chain, and says so here.
    expect(duelWriteBlocker("refund", spent, A, NOW)).toContain("never filled");
  });

  test("a settled duel is terminal for every method, and says so accurately", () => {
    const settled = duel({ status: STATUS_SETTLED, b: B, fullAt: BigInt(NOW - 99_999) });
    for (const m of ["stake", "winStake", "loseStake", "cancel"] as const) {
      expect(duelWriteBlocker(m, settled, A, NOW)).toContain("spent");
    }
    // A settled duel DID fill, so "needs a duel that filled" would be a lie.
    expect(duelWriteBlocker("refund", settled, A, NOW)).toContain("already settled");
  });

  test("a partly-refunded duel still lets the other player claim", () => {
    // status REFUNDED with fullAt set is the half-withdrawn state, not a cancel.
    const half = duel({
      status: STATUS_REFUNDED,
      b: B,
      fullAt: BigInt(NOW - DUEL_TIMEOUT_SECONDS - 10),
      aWithdrawn: true,
    });
    expect(duelWriteBlocker("refund", half, A, NOW)).toContain("already withdrawn");
    expect(duelWriteBlocker("refund", half, B, NOW)).toBeNull();
  });

  test("address comparison is case-insensitive, so a lowercase wallet is still seat A", () => {
    const open = duel({ status: STATUS_OPEN });
    expect(duelWriteBlocker("cancel", open, A.toLowerCase(), NOW)).toBeNull();
    expect(duelWriteBlocker("cancel", open, A.toUpperCase().replace("0X", "0x"), NOW)).toBeNull();
  });

  test("a disconnected wallet is never mistaken for a seat", () => {
    const open = duel({ status: STATUS_OPEN, a: ZERO });
    expect(duelWriteBlocker("cancel", open, null, NOW)).toContain("Only the wallet that opened");
  });
});

describe("stake amount matching and key reuse", () => {
  test("seat two must match the opener's stake exactly, and is told the number", () => {
    const open = duel({ status: STATUS_OPEN, stake: 5_000_000_000_000_000n });
    // Unknown amount gates nothing — the check is advisory, like the rest.
    expect(duelWriteBlocker("stake", open, B, NOW)).toBeNull();
    expect(duelWriteBlocker("stake", open, B, NOW, null)).toBeNull();
    // Matching passes; anything else names the required figure.
    expect(duelWriteBlocker("stake", open, B, NOW, 5_000_000_000_000_000n)).toBeNull();
    const wrong = duelWriteBlocker("stake", open, B, NOW, 1_000_000_000_000_000n);
    expect(wrong).toContain("0.005");
    expect(wrong).toContain("0.001");
  });

  test("the amount never gates a duel that has no opener yet", () => {
    const fresh = duel({ status: STATUS_NONE, a: ZERO, stake: 0n });
    expect(duelWriteBlocker("stake", fresh, B, NOW, 1_000_000_000_000_000n)).toBeNull();
    expect(duelWriteBlocker("stake", fresh, B, NOW, 999_000_000_000_000_000n)).toBeNull();
  });

  test("a key is startable while it can still be opened or joined, and never after", () => {
    expect(isKeyStartable(STATUS_NONE)).toBe(true);
    // OPEN must qualify, or the two players would never converge on one key.
    expect(isKeyStartable(STATUS_OPEN)).toBe(true);
    expect(isKeyStartable(STATUS_FULL)).toBe(false);
    expect(isKeyStartable(STATUS_SETTLED)).toBe(false);
    expect(isKeyStartable(STATUS_REFUNDED)).toBe(false);
  });
});
