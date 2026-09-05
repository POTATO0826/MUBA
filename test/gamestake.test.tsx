import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Interface, id } from "ethers";
import type { WalletSource } from "../src/data/wallet.ts";
import {
  GAME_STAKE_ABI,
  GAME_STAKE_ADDRESS,
  ZERO_ADDRESS,
  gameStakeBlocker,
  matchIdFromInput,
  seatsTaken,
  type MatchState,
} from "../src/utils/gamestake.ts";
import { GameStakeTest } from "../src/views/GameStakeTest.tsx";

const wallet: WalletSource = {
  id: "mock",
  identity: {
    address: null,
    chainId: null,
    walletName: null,
    connected: false,
    connecting: false,
    // Required on `WalletIdentity`: the restore finished and there is no
    // session, as opposed to a restore still in flight.
    settled: true,
    wrongNetwork: false,
  },
  async connect() {},
  async disconnect() {},
  async openAccount() {},
  async switchToSigningChain() {},
  async getSigner() {
    return null;
  },
};

// Real EIP-55 checksums. A hand-typed mixed-case address fails ethers'
// isAddress(), which is exactly what the blocker is meant to catch.
const P1 = "0xd69C6657d1997B4c27d6Bf70E8F15F0f55ef12Be";
const P2 = "0x23577Abf42FF22F45210c005267Ceb06A867b44d";
const OUTSIDER = "0x1111111111111111111111111111111111111111";

function match(over: Partial<MatchState> = {}): MatchState {
  return { player1: P1, player2: P2, pool: 2_000_000_000_000_000n, paid: false, ...over };
}

let container: HTMLDivElement;
let root: Root;

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
  root = undefined as unknown as Root;
});

describe("GameStake ABI", () => {
  test("matches the three selectors actually deployed at the address", () => {
    // Read from the live dispatcher at 0xcd3dAC24…3eAC on Base Sepolia.
    const iface = new Interface([...GAME_STAKE_ABI]);
    expect(iface.getFunction("stake")?.selector).toBe("0xc0d64a87");
    expect(iface.getFunction("winnerTakesAll")?.selector).toBe("0x5f086696");
    expect(iface.getFunction("matches")?.selector).toBe("0x9fe9ada3");
  });

  test("carries no DuelEscrow surface — these are different contracts", () => {
    const iface = new Interface([...GAME_STAKE_ABI]);
    for (const absent of ["winStake", "attestor", "MIN_STAKE", "TIMEOUT", "refund", "cancel"]) {
      expect(iface.getFunction(absent)).toBeNull();
    }
  });

  test("the deployed address is checksummed", () => {
    expect(GAME_STAKE_ADDRESS).toBe("0xcd3dAC24e99E1Cb710B8243468e6D118215f3eAC");
  });

  test("a match key hashes the same way the console does", () => {
    expect(matchIdFromInput("game-1")).toBe(id("game-1"));
    const raw = `0x${"ab".repeat(32)}`;
    expect(matchIdFromInput(raw)).toBe(raw);
    expect(() => matchIdFromInput("  ")).toThrow();
  });
});

describe("gameStakeBlocker mirrors the contract's requires", () => {
  test("an unread match gates nothing", () => {
    expect(gameStakeBlocker("stake", null, P1)).toBeNull();
    expect(gameStakeBlocker("winnerTakesAll", null, P1, P2)).toBeNull();
  });

  test("seat counting", () => {
    expect(seatsTaken(null)).toBe(0);
    expect(seatsTaken(match({ player1: ZERO_ADDRESS, player2: ZERO_ADDRESS }))).toBe(0);
    expect(seatsTaken(match({ player2: ZERO_ADDRESS }))).toBe(1);
    expect(seatsTaken(match())).toBe(2);
  });

  test("anyone may stake until both seats are taken, then only the two players", () => {
    const empty = match({ player1: ZERO_ADDRESS, player2: ZERO_ADDRESS, pool: 0n });
    expect(gameStakeBlocker("stake", empty, OUTSIDER)).toBeNull();

    const one = match({ player2: ZERO_ADDRESS });
    expect(gameStakeBlocker("stake", one, OUTSIDER)).toBeNull();

    const full = match();
    expect(gameStakeBlocker("stake", full, P1)).toBeNull();
    expect(gameStakeBlocker("stake", full, P2)).toBeNull();
    expect(gameStakeBlocker("stake", full, OUTSIDER)).toContain("Both seats are taken");
  });

  test("a paid match is finished for both functions", () => {
    const paid = match({ paid: true });
    expect(gameStakeBlocker("stake", paid, P1)).toContain("already paid");
    expect(gameStakeBlocker("winnerTakesAll", paid, P1, P2)).toContain("already paid");
  });

  test("payout needs two players and a winner who is one of them", () => {
    const one = match({ player2: ZERO_ADDRESS });
    expect(gameStakeBlocker("winnerTakesAll", one, P1, P1)).toContain("Both players must stake");

    const full = match();
    expect(gameStakeBlocker("winnerTakesAll", full, OUTSIDER, P1)).toBeNull();
    expect(gameStakeBlocker("winnerTakesAll", full, P1, P2)).toBeNull();
    expect(gameStakeBlocker("winnerTakesAll", full, P1, OUTSIDER)).toContain("must be one of the two");
    expect(gameStakeBlocker("winnerTakesAll", full, P1, "not-an-address")).toContain("valid winner");
    // An empty field is not yet an error — the button is simply not ready.
    expect(gameStakeBlocker("winnerTakesAll", full, P1, "")).toBeNull();
  });

  test("addresses compare case-insensitively", () => {
    const full = match();
    expect(gameStakeBlocker("stake", full, P1.toLowerCase())).toBeNull();
    expect(gameStakeBlocker("winnerTakesAll", full, P1, P2.toLowerCase())).toBeNull();
  });
});

describe("the /testing console", () => {
  test("renders both functions and blocks writes on the mock wallet", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<GameStakeTest wallet={wallet} initialAddress={GAME_STAKE_ADDRESS} />);
    });

    expect(container.textContent).toContain("Stake & winner takes all");
    expect(container.textContent).toContain("stake");
    expect(container.textContent).toContain("winnerTakesAll");
    expect(container.textContent).toContain("Connect MetaMask");

    for (const label of ["Stake into this match", "Pay the whole pot"]) {
      const button = [...container.querySelectorAll("button")].find((node) =>
        (node.textContent ?? "").includes(label),
      );
      expect(button).toBeDefined();
      expect(button?.disabled).toBe(true);
    }
  });
});
