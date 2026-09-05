/**
 * The escrow gate: everything about `contracts/DuelEscrow.sol` that can be
 * checked without spending money.
 *
 * There is no EVM in this suite — no anvil, no foundry, no forked node. What it
 * *can* do is far more valuable for a one-shot mainnet deployment of an
 * un-upgradeable contract: it pins the compiler-visible surface. The three
 * things that quietly burn real USDC if they drift are
 *
 *   1. the ABI growing a function nobody reviewed (an admin, a sweep, a
 *      `receive`) or a settle signature changing shape under the client;
 *   2. the money constants moving — a rake that is not 4%, a minimum that is
 *      not $0.10;
 *   3. the EIP-712 typehash string disagreeing between the contract and the
 *      server that signs verdicts, which produces a signature the contract
 *      rejects *after* both stakes are locked, leaving the six-hour timeout as
 *      the only way out of every duel.
 *
 * Each assertion below is made against what the compiler actually produced —
 * the AST, the ABI, the deployed bytecode — never against the source text as a
 * string, except where the thing being pinned genuinely IS a documented string.
 */

import { describe, expect, test } from "bun:test";
import { MIN_STAKE_USDC } from "../src/desk/escrow.ts";
import { readFileSync } from "node:fs";
import {
  AbiCoder,
  TypedDataEncoder,
  concat,
  id,
  keccak256,
  toUtf8Bytes,
} from "ethers";
import {
  ARTIFACT_PATH,
  OPTIMIZER_RUNS,
  SOURCE_PATH,
  compileEscrow,
  type AbiEntry,
} from "../contracts/build.ts";

/**
 * One compile for the whole suite (~2s). Top-level await runs at module load,
 * so no individual test pays the cost and none needs a raised timeout.
 * `compileEscrow` throws on any solc error, so simply getting here is the
 * "compiles clean" assertion; the test below re-states it for the report.
 */
const build = await compileEscrow();

const abi: readonly AbiEntry[] = build.abi;
const source = readFileSync(SOURCE_PATH, "utf8");

const names = (type: string): string[] =>
  abi.filter((e) => e.type === type).map((e) => e.name ?? "").sort();

/** `open(bytes32,uint128,address)` — the canonical selector signature. */
const signature = (e: AbiEntry): string =>
  `${e.name}(${(e.inputs ?? []).map((i) => i.type).join(",")})`;

const MUTATING = new Set(["nonpayable", "payable"]);

// ---------------------------------------------------------------------------

describe("DuelEscrow compiles", () => {
  test("solc reports zero errors and zero warnings", () => {
    // compileEscrow() throws on errors, so reaching this line is half the
    // assertion. Warnings are the other half: a clean contract has none, and a
    // new one (shadowed name, unreachable code, unused parameter) is a signal
    // worth failing on in a contract that holds money.
    expect(build.warnings).toEqual([]);
    expect(build.bytecode.startsWith("0x")).toBe(true);
    expect(build.bytecode.length).toBeGreaterThan(2);
  });

  test("the pinned compiler and settings are the ones we verify against", () => {
    // BaseScan verification reproduces the build from exactly these. If any of
    // them changes, the runbook in contracts/README.md is wrong.
    expect(build.solcVersion.startsWith("0.8.26+commit.")).toBe(true);
    expect(build.solcLongVersion).toBe("v0.8.26+commit.8a97fa7a");

    const metadata = JSON.parse(build.metadata) as {
      compiler: { version: string };
      settings: { optimizer: { enabled: boolean; runs: number }; evmVersion: string };
    };
    expect(metadata.compiler.version).toBe("0.8.26+commit.8a97fa7a");
    expect(metadata.settings.optimizer).toEqual({ enabled: true, runs: OPTIMIZER_RUNS });
    // 0.8.26's default target. Base supports Cancun; a newer solc would default
    // to something Base may not accept, which is why solc is pinned exactly.
    expect(metadata.settings.evmVersion).toBe("cancun");
  });

  test("the runtime fits well inside the EIP-170 limit", () => {
    const bytes = (build.deployedBytecode.length - 2) / 2;
    expect(bytes).toBeGreaterThan(1000);
    expect(bytes).toBeLessThan(24576);
  });

  test("the committed artifact matches a fresh compile", () => {
    // contracts/out/DuelEscrow.json is committed and is what deploy.ts checks
    // before broadcasting. A stale one means the source under review is not the
    // source that gets deployed or verified. Fix: `bun contracts/build.ts`.
    const committed = JSON.parse(readFileSync(ARTIFACT_PATH, "utf8")) as {
      abi: readonly AbiEntry[];
      bytecode: string;
      deployedBytecode: string;
      metadata: string;
      solcVersion: string;
    };
    expect(Object.keys(committed).sort()).toEqual([
      "abi",
      "bytecode",
      "deployedBytecode",
      "metadata",
      "solcVersion",
    ]);
    expect(committed.solcVersion).toBe(build.solcVersion);
    expect(committed.bytecode).toBe(build.bytecode);
    expect(committed.deployedBytecode).toBe(build.deployedBytecode);
    expect(committed.metadata).toBe(build.metadata);
    expect(committed.abi).toEqual(build.abi as AbiEntry[]);
  });
});

describe("the ABI is exactly the reviewed surface", () => {
  test("the six state-changing functions and nothing else", () => {
    const mutating = abi
      .filter((e) => e.type === "function" && MUTATING.has(e.stateMutability ?? ""))
      .map(signature)
      .sort();

    // Every one of these moves USDC. Adding a seventh — an owner withdraw, a
    // pause, a token sweep, a rescue — is exactly the change this test exists
    // to make impossible to land quietly.
    expect(mutating).toEqual([
      "cancel(bytes32)",
      "claimRake()",
      "join(bytes32)",
      "open(bytes32,uint128,address)",
      "refund(bytes32)",
      "settle(bytes32,address,uint64,bytes)",
    ]);
  });

  test("nothing is payable, and there is no receive or fallback", () => {
    // The contract has no business holding ETH: there would be no way to get it
    // back out.
    expect(abi.filter((e) => e.stateMutability === "payable")).toEqual([]);
    expect(abi.filter((e) => e.type === "receive" || e.type === "fallback")).toEqual([]);
  });

  test("the views are the immutables, the constants and the duel map", () => {
    const views = abi
      .filter((e) => e.type === "function" && !MUTATING.has(e.stateMutability ?? ""))
      .map(signature)
      .sort();

    expect(views).toEqual([
      "BPS()",
      "DOMAIN_SEPARATOR()",
      "MIN_STAKE()",
      "RAKE_BPS()",
      "TIMEOUT()",
      "VERDICT_TYPEHASH()",
      "attestor()",
      "duels(bytes32)",
      "rakeAccrued()",
      "treasury()",
      "usdc()",
    ]);
  });

  test("the constructor takes (usdc, attestor, treasury) and nothing else", () => {
    const ctor = abi.find((e) => e.type === "constructor");
    expect(ctor).toBeDefined();
    expect((ctor?.inputs ?? []).map((i) => `${i.type} ${i.name}`)).toEqual([
      "address usdc_",
      "address attestor_",
      "address treasury_",
    ]);
    // Immutable-by-construction: no setter exists for any of them.
    for (const name of ["setAttestor", "setTreasury", "setUsdc", "transferOwnership", "owner"]) {
      expect(names("function")).not.toContain(name);
    }
  });

  test("every lifecycle transition emits an event", () => {
    expect(names("event")).toEqual([
      "DuelCancelled",
      "DuelJoined",
      "DuelOpened",
      "DuelRefunded",
      "DuelSettled",
      "RakeClaimed",
    ]);
    // The plan's P6 staking UI polls for DuelJoined and renders from
    // DuelSettled; both carry the duelId as topic 1 so a client can filter.
    const joined = abi.find((e) => e.type === "event" && e.name === "DuelJoined");
    expect((joined?.inputs ?? []).map((i) => i.type)).toEqual(["bytes32", "address", "uint64"]);
    const settled = abi.find((e) => e.type === "event" && e.name === "DuelSettled");
    expect((settled?.inputs ?? []).map((i) => i.type)).toEqual([
      "bytes32",
      "address",
      "uint256",
      "uint256",
    ]);
  });

  test("the duels view exposes the per-player refund flags", () => {
    // The bookkeeping that stops one player refusing to claim from stranding
    // the other has to be readable off-chain, or the UI cannot tell a fully
    // refunded duel from a half-refunded one.
    const duels = abi.find((e) => e.type === "function" && e.name === "duels");
    expect((duels?.outputs ?? []).map((o) => `${o.type} ${o.name}`)).toEqual([
      "address a",
      "address b",
      "address invited",
      "uint128 stake",
      "uint64 fullAt",
      "uint8 status",
      "bool aWithdrawn",
      "bool bWithdrawn",
    ]);
  });
});

describe("the money constants are what the owner decided", () => {
  test("RAKE_BPS is 400 and BPS is 10000 — a 4% rake", () => {
    // Read out of the compiler's AST: the value solc parsed, not source text.
    expect(build.constants["RAKE_BPS"]).toBe(400n);
    expect(build.constants["BPS"]).toBe(10_000n);
    expect(Number(build.constants["RAKE_BPS"]) / Number(build.constants["BPS"])).toBeCloseTo(0.04, 12);
  });

  test("MIN_STAKE is 1000 base units = $0.001 of 6-decimal USDC", () => {
    // It was 100_000 ($0.10). The floor is anti-grief and that argument was
    // written for a mainnet deployment; this contract now deploys to Base
    // Sepolia, where the stake token is a free test token and the griefing the
    // floor prevented costs nothing to suffer. See the natspec on MIN_STAKE for
    // why this is the last moment the value could change — it is a `constant`
    // with no setter, so it is immutable from the deploy transaction onward.
    expect(build.constants["MIN_STAKE"]).toBe(1_000n);
    expect(Number(build.constants["MIN_STAKE"]) / 1e6).toBeCloseTo(0.001, 12);
    // And it is a mirror of the client's copy, which refuses below it so a
    // player does not spend gas being refused on chain. If these disagree, one
    // of the two is lying about what the escrow will take.
    expect(build.constants["MIN_STAKE"]).toBe(MIN_STAKE_USDC);
  });

  test("TIMEOUT is six hours", () => {
    expect(build.constants["TIMEOUT"]).toBe(21_600n);
  });

  test("the constants are literally compiled into the runtime, not just declared", () => {
    // Belt and braces on the AST read: the getters push these exact values.
    // 400 -> PUSH2 0x0190, 10000 -> PUSH2 0x2710, 1000 -> PUSH2 0x03e8,
    // 21600 -> PUSH2 0x5460.
    //
    // MIN_STAKE's push narrowed from PUSH3 0x0186a0 to PUSH2 0x03e8 when the
    // floor dropped to 1_000 — the opcode is part of what is being pinned, so
    // it changes with the value rather than beside it.
    const runtime = build.deployedBytecode.toLowerCase();
    expect(runtime).toContain("610190");
    expect(runtime).toContain("612710");
    expect(runtime).toContain("6103e8");
    expect(runtime).toContain("615460");
    // And the old floor is gone from the runtime, not merely unreferenced.
    expect(runtime).not.toContain("620186a0");
  });

  test("there is no maximum stake — the owner's explicit, documented decision", () => {
    // Not an oversight. If a MAX_STAKE ever appears, the README's risk
    // statement and the natspec both become wrong and must be rewritten.
    expect(build.constants["MAX_STAKE"]).toBeUndefined();
    expect(source).not.toContain("MAX_STAKE");
    expect(source).toContain("UNCAPPED STAKE");
  });

  test("the rake math is exact at the minimum stake and loses no dust", () => {
    // pot - rake + rake == pot for every stake: rake rounds down, the winner's
    // payout takes the remainder. Checked here over the shape the contract uses
    // so a reviewer can see there is no third bucket.
    for (const stake of [100_000n, 1_000_000n, 2_500_001n, 999_999_999n, 1n << 100n]) {
      const pot = stake * 2n;
      const rake = (pot * build.constants["RAKE_BPS"]!) / build.constants["BPS"]!;
      expect(rake + (pot - rake)).toBe(pot);
    }
    expect((200_000n * 400n) / 10_000n).toBe(8_000n); // $0.20 pot -> $0.008 rake
  });
});

describe("EIP-712: the verdict the server signs is the verdict the contract checks", () => {
  const VERDICT_TYPE = "Verdict(bytes32 duelId,address winner,uint64 deadline)";
  const DOMAIN_TYPE =
    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

  const escrow = "0x1111111111111111111111111111111111111111";
  const winner = "0x2222222222222222222222222222222222222222";
  const duelId = id("thetaduel:room-7:seed-4182");
  const deadline = 1_756_000_000n;
  const chainId = 8453n;

  test("the typehash strings are the ones compiled into the contract", () => {
    // solc constant-folds `keccak256("<literal>")`, so the hash of the correct
    // string is a PUSH32 in the deployed code. If someone edits a space, a
    // field order or a type into the contract's typehash, this fails — and it
    // fails HERE rather than on mainnet with both stakes already locked.
    expect(build.deployedBytecode.toLowerCase()).toContain(
      keccak256(toUtf8Bytes(VERDICT_TYPE)).slice(2).toLowerCase(),
    );
    // The domain pieces are folded into the constructor, hence creation code.
    const creation = build.bytecode.toLowerCase();
    expect(creation).toContain(keccak256(toUtf8Bytes(DOMAIN_TYPE)).slice(2).toLowerCase());
    expect(creation).toContain(keccak256(toUtf8Bytes("THETADUEL")).slice(2).toLowerCase());
    expect(creation).toContain(keccak256(toUtf8Bytes("1")).slice(2).toLowerCase());
  });

  test("a hand-built digest equals ethers' TypedDataEncoder", () => {
    // The hand-built side is a transcription of the Solidity, line for line.
    // The ethers side is what src/server/attest.ts will call. They must agree,
    // and neither one is allowed to be the definition of the other.
    const domainSeparator = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "bytes32", "uint256", "address"],
        [
          keccak256(toUtf8Bytes(DOMAIN_TYPE)),
          keccak256(toUtf8Bytes("THETADUEL")),
          keccak256(toUtf8Bytes("1")),
          chainId,
          escrow,
        ],
      ),
    );
    const structHash = keccak256(
      AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "bytes32", "address", "uint64"],
        [keccak256(toUtf8Bytes(VERDICT_TYPE)), duelId, winner, deadline],
      ),
    );
    const handBuilt = keccak256(concat(["0x1901", domainSeparator, structHash]));

    const viaEthers = TypedDataEncoder.hash(
      { name: "THETADUEL", version: "1", chainId, verifyingContract: escrow },
      { Verdict: [
        { name: "duelId", type: "bytes32" },
        { name: "winner", type: "address" },
        { name: "deadline", type: "uint64" },
      ] },
      { duelId, winner, deadline },
    );

    expect(viaEthers).toBe(handBuilt);

    // And the encoder derives the same typehash from the field list, which is
    // what actually guards the string above against a silent rename.
    expect(TypedDataEncoder.hashDomain({
      name: "THETADUEL",
      version: "1",
      chainId,
      verifyingContract: escrow,
    })).toBe(domainSeparator);
  });

  test("the digest is bound to the chain, the deployment and the duel", () => {
    const types = { Verdict: [
      { name: "duelId", type: "bytes32" },
      { name: "winner", type: "address" },
      { name: "deadline", type: "uint64" },
    ] };
    const base = { name: "THETADUEL", version: "1", chainId, verifyingContract: escrow };
    const value = { duelId, winner, deadline };
    const digest = TypedDataEncoder.hash(base, types, value);

    // Replay across chains, across deployments, across duels, across winners
    // and across expiries all produce a different digest — the contract's
    // status check handles replay onto the SAME duel.
    expect(TypedDataEncoder.hash({ ...base, chainId: 1n }, types, value)).not.toBe(digest);
    expect(TypedDataEncoder.hash(
      { ...base, verifyingContract: "0x3333333333333333333333333333333333333333" },
      types,
      value,
    )).not.toBe(digest);
    expect(TypedDataEncoder.hash(base, types, { ...value, duelId: id("other") })).not.toBe(digest);
    expect(TypedDataEncoder.hash(base, types, {
      ...value,
      winner: "0x4444444444444444444444444444444444444444",
    })).not.toBe(digest);
    expect(TypedDataEncoder.hash(base, types, { ...value, deadline: deadline + 1n })).not.toBe(digest);
  });
});

describe("duel ids", () => {
  test("the documented client rule is keccak256(utf8Bytes(matchKey))", () => {
    // The contract treats duelId as opaque; the CLIENT rule is what has to be
    // stable, because the server signs against whatever the client opened with.
    // `ethers.id(x)` is that rule, and this pins the two spellings together so
    // a hand-rolled server-side derivation cannot drift.
    for (const matchKey of ["room-7", "thetaduel:room-7:seed-4182", "unicode ✦ ok", ""]) {
      expect(id(matchKey)).toBe(keccak256(toUtf8Bytes(matchKey)));
    }
    expect(id("thetaduel:room-7:seed-4182")).toMatch(/^0x[0-9a-f]{64}$/);
    // Distinct keys give distinct ids, so two rooms can never share an escrow
    // slot (and `open` rejects a reused id outright).
    expect(id("room-7")).not.toBe(id("room-8"));
  });

  test("the derivation rule is documented in the contract itself", () => {
    expect(source).toContain("keccak256(utf8Bytes(matchKey))");
  });
});

describe("the trust model is stated where it has to be read", () => {
  test("the natspec names the attestor, the relay and the treasury separation", () => {
    expect(source).toContain("TRUST MODEL");
    expect(source).toContain("PERMISSIONLESS RELAY");
    expect(source).toContain("BALANCE INVARIANT");
  });

  test("no delegatecall, no selfdestruct, no assembly beyond signature recovery", () => {
    expect(source).not.toContain("delegatecall");
    expect(source).not.toContain("selfdestruct");
    // Exactly one assembly block, and it is the one in _recover.
    expect(source.match(/assembly/g)?.length).toBe(1);
  });
});
