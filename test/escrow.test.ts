import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TypedDataEncoder, id, keccak256, toUtf8Bytes } from "ethers";
import {
  ARTIFACT_PATH,
  OPTIMIZER_RUNS,
  SOURCE_PATH,
  compileEscrow,
  type AbiEntry,
} from "../contracts/build.ts";

const build = await compileEscrow();
const abi: readonly AbiEntry[] = build.abi;
const source = readFileSync(SOURCE_PATH, "utf8");

const signature = (entry: AbiEntry): string =>
  `${entry.name}(${(entry.inputs ?? []).map((input) => input.type).join(",")})`;

describe("Base Sepolia DuelEscrow", () => {
  test("compiles cleanly with the pinned production settings", () => {
    expect(build.warnings).toEqual([]);
    expect(build.solcVersion.startsWith("0.8.26+commit.")).toBe(true);
    const metadata = JSON.parse(build.metadata) as {
      settings: { optimizer: { enabled: boolean; runs: number }; evmVersion: string };
    };
    expect(metadata.settings.optimizer).toEqual({ enabled: true, runs: OPTIMIZER_RUNS });
    expect(metadata.settings.evmVersion).toBe("cancun");
    expect((build.deployedBytecode.length - 2) / 2).toBeLessThan(24_576);
  });

  test("the committed deployment artifact matches a fresh compile", () => {
    const artifact = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as {
      abi: readonly AbiEntry[];
      bytecode: string;
      deployedBytecode: string;
      metadata: string;
      solcVersion: string;
    };
    expect(artifact).toEqual({
      abi: build.abi,
      bytecode: build.bytecode,
      deployedBytecode: build.deployedBytecode,
      metadata: build.metadata,
      solcVersion: build.solcVersion,
    });
  });

  test("has the requested stake and winner-takes-all write surface", () => {
    const writes = abi
      .filter((entry) => entry.type === "function" && entry.stateMutability !== "view" && entry.stateMutability !== "pure")
      .map(signature)
      .sort();
    expect(writes).toEqual([
      "cancel(bytes32)",
      "loseStake(bytes32)",
      "refund(bytes32)",
      "stake(bytes32)",
      "winStake(bytes32,address,uint64,bytes)",
    ]);
    expect(abi.find((entry) => entry.type === "function" && entry.name === "stake")?.stateMutability)
      .toBe("payable");
    for (const forbidden of ["approve", "claimRake", "owner", "treasury", "usdc", "withdraw"])
      expect(abi.some((entry) => entry.type === "function" && entry.name === forbidden)).toBe(false);
  });

  test("constructor and constants make mainnet deployment impossible", () => {
    const constructor = abi.find((entry) => entry.type === "constructor");
    expect((constructor?.inputs ?? []).map((input) => `${input.type} ${input.name}`)).toEqual([
      "address attestor_",
    ]);
    expect(build.constants["BASE_SEPOLIA_CHAIN_ID"]).toBe(84_532n);
    expect(build.constants["MIN_STAKE"]).toBe(1_000_000_000_000_000n);
    expect(build.constants["TIMEOUT"]).toBe(21_600n);
    expect(source).toContain('require(block.chainid == BASE_SEPOLIA_CHAIN_ID, "Base Sepolia only")');
  });

  test("anyone may stake, but cannot fill both seats or change the stake", () => {
    expect(source).toContain("function stake(bytes32 duelId) external payable");
    expect(source).not.toMatch(/onlyOwner|whitelist|allowlist/);
    expect(source).toContain('require(msg.sender != d.a, "cannot join own duel")');
    expect(source).toContain('require(msg.value == d.stake, "stake must match")');
  });

  test("the winner receives the entire two-player pool and the loser has no claim", () => {
    expect(source).toContain("uint256 payout = uint256(d.stake) * 2;");
    expect(source).toContain("d.status = Status.SETTLED;");
    expect(source).toContain("_send(winner, payout);");
    expect(source).not.toMatch(/rake|fee|treasury/i);
    expect(source).toContain("Once `winStake` settles a duel, the loser has no claim.");
  });

  test("loseStake is a seated player's voluntary full forfeit", () => {
    expect(source).toContain("function loseStake(bytes32 duelId) external nonReentrant");
    expect(source).toContain("if (msg.sender == d.a)");
    expect(source).toContain("else if (msg.sender == d.b)");
    expect(source).toContain('revert("not a player")');
    expect(source).toContain("emit DuelForfeited(duelId, msg.sender, winner, payout)");
  });

  test("the permissionless win relay is authorized by a Sepolia-bound verdict", () => {
    const types = {
      Verdict: [
        { name: "duelId", type: "bytes32" },
        { name: "winner", type: "address" },
        { name: "deadline", type: "uint64" },
      ],
    };
    const value = {
      duelId: id("duel-1"),
      winner: "0x2222222222222222222222222222222222222222",
      deadline: 2_000_000_000n,
    };
    const base = {
      name: "THETADUEL",
      version: "1",
      chainId: 84_532n,
      verifyingContract: "0x1111111111111111111111111111111111111111",
    };
    const digest = TypedDataEncoder.hash(base, types, value);
    expect(TypedDataEncoder.hash({ ...base, chainId: 8_453n }, types, value)).not.toBe(digest);
    expect(build.deployedBytecode.toLowerCase()).toContain(
      keccak256(toUtf8Bytes("Verdict(bytes32 duelId,address winner,uint64 deadline)"))
        .slice(2)
        .toLowerCase(),
    );
  });

  test("timeout recovery remains available only before settlement", () => {
    expect(source).toContain(
      'require(status == Status.FULL || status == Status.REFUNDED, "not refundable")',
    );
    expect(source).toContain(
      'require(block.timestamp > uint256(d.fullAt) + TIMEOUT, "not expired")',
    );
    expect(source).toContain('require(d.status == Status.FULL, "duel not full")');
  });
});
