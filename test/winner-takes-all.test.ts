import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileEscrow, OPTIMIZER_RUNS, type AbiEntry } from "../contracts/build.ts";

/**
 * `WinnerTakesAll` is deliberately unguarded: `declareWinner` has no caller
 * restriction, so anyone may settle any full match. That is the requested
 * design, and these tests exist because a property that surprising has to be
 * *pinned* rather than left to be rediscovered — if someone later adds an owner
 * check, or a timeout, or a second exit path, a test should say so out loud.
 *
 * They are static: no foundry, no anvil, no local EVM in this repo. What they
 * assert is the compiled surface and the source invariants that decide where
 * the money can go.
 */
const SOURCE_PATH = join(import.meta.dir, "..", "contracts", "WinnerTakesAll.sol");
const ARTIFACT_PATH = join(import.meta.dir, "..", "contracts", "out", "WinnerTakesAll.json");

const build = await compileEscrow("WinnerTakesAll.sol", "WinnerTakesAll");
const abi: readonly AbiEntry[] = build.abi;
const source = readFileSync(SOURCE_PATH, "utf8");

/**
 * The source with every comment removed.
 *
 * The invariants below are about what the contract DOES, and this file's prose
 * necessarily discusses the very things the code must not contain — it explains
 * at length that there is no deadline and no refund. Asserting against raw
 * source would therefore fail on the documentation of the property being
 * asserted, so the checks run against code only.
 */
const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const signature = (entry: AbiEntry): string =>
  `${entry.name}(${(entry.inputs ?? []).map((input) => input.type).join(",")})`;

describe("WinnerTakesAll", () => {
  test("compiles cleanly on the pinned settings and fits well under EIP-170", () => {
    expect(build.warnings).toEqual([]);
    expect(build.solcVersion.startsWith("0.8.26+commit.")).toBe(true);
    const metadata = JSON.parse(build.metadata) as {
      settings: { optimizer: { enabled: boolean; runs: number } };
    };
    expect(metadata.settings.optimizer).toEqual({ enabled: true, runs: OPTIMIZER_RUNS });
    expect((build.deployedBytecode.length - 2) / 2).toBeLessThan(24_576);
  });

  test("the committed artifact matches a fresh compile", () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as Record<string, unknown>;
    expect(artifact).toEqual({
      abi: build.abi,
      bytecode: build.bytecode,
      deployedBytecode: build.deployedBytecode,
      metadata: build.metadata,
      solcVersion: build.solcVersion,
    });
  });

  test("exposes exactly two write functions: stake and declareWinner", () => {
    const writes = abi
      .filter(
        (entry) =>
          entry.type === "function" &&
          entry.stateMutability !== "view" &&
          entry.stateMutability !== "pure",
      )
      .map(signature)
      .sort();
    expect(writes).toEqual(["declareWinner(bytes32,address)", "stake(bytes32)"]);

    const stake = abi.find((e) => e.name === "stake");
    expect(stake?.stateMutability).toBe("payable");
    // Settling must never carry value; only the pot may move.
    expect(abi.find((e) => e.name === "declareWinner")?.stateMutability).toBe("nonpayable");
  });

  test("there is no owner, referee, admin or pause — settlement is open by design", () => {
    for (const forbidden of ["owner", "onlyOwner", "referee", "attestor", "admin", "pause"]) {
      expect(code.toLowerCase()).not.toContain(forbidden.toLowerCase() + "(");
    }
    // No caller check inside declareWinner. If one is ever added, this fails and
    // the reviewer is forced to update the contract's own warning header too.
    const body = code.slice(code.indexOf("function declareWinner"));
    expect(body).not.toContain("msg.sender ==");
  });

  test("no clock: no deadline, timeout, expiry or refund path exists", () => {
    for (const forbidden of ["block.timestamp", "TIMEOUT", "deadline", "refund", "withdraw"]) {
      expect(code).not.toContain(forbidden);
    }
  });

  test("the pot can only ever reach one of the two seated players", () => {
    expect(code).toContain('require(winner == d.a || winner == d.b, "winner is not a player")');
    expect(code).toContain('require(d.b != address(0), "match not full")');
  });

  test("state is finalised before the payout, so a reentrant winner cannot double-spend", () => {
    const body = code.slice(code.indexOf("function declareWinner"));
    const settled = body.indexOf("d.settled = true");
    const zeroed = body.indexOf("d.pool = 0");
    const transfer = body.indexOf("call{value: payout}");
    expect(settled).toBeGreaterThan(-1);
    expect(settled).toBeLessThan(transfer);
    expect(zeroed).toBeLessThan(transfer);
    expect(body).toContain('require(!d.settled, "match already settled")');
  });

  test("stray ETH is refused rather than stranded", () => {
    expect(abi.some((e) => e.type === "receive")).toBe(true);
    expect(abi.some((e) => e.type === "fallback")).toBe(true);
    expect(code).toContain('revert("use stake")');
  });

  test("the constructor pins deployment to Base Sepolia", () => {
    expect(build.constants.BASE_SEPOLIA_CHAIN_ID).toBe(84_532n);
    expect(code).toContain('require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "Base Sepolia only")');
  });

  test("settlement is auditable: the caller is recorded, since anyone may be it", () => {
    const settled = abi.find((e) => e.name === "Settled" && e.type === "event");
    expect(settled).toBeDefined();
    expect((settled?.inputs ?? []).map((i) => i.name)).toEqual([
      "matchId",
      "winner",
      "caller",
      "payout",
    ]);
  });
});
