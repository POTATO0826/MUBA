/**
 * Compile `contracts/DuelEscrow.sol` with a pinned solc and write the committed
 * artifact to `contracts/out/DuelEscrow.json`.
 *
 *     bun contracts/build.ts
 *
 * There is no foundry and no hardhat here on purpose: one contract, no imports,
 * no libraries. `solc` is pinned to an exact version in package.json (0.8.26,
 * matching the contract's fixed pragma) because the compiler version and its
 * settings are part of what an operator has to reproduce byte-for-byte to
 * verify the source on BaseScan. Anything that floats here turns verification
 * into a guessing game.
 *
 * Settings that are load-bearing for verification:
 *   - optimizer enabled, 200 runs
 *   - evmVersion: NOT set, i.e. the compiler default, which for 0.8.26 is
 *     `cancun` — supported by Base. (Do not "helpfully" upgrade solc: releases
 *     from 0.8.30 on default to newer EVM targets whose opcodes Base may not
 *     accept. If the version is ever bumped, pin `evmVersion` explicitly.)
 *   - the exact source bytes of DuelEscrow.sol, single file, no remappings
 *
 * The module also exports {@link compileEscrow} so `test/escrow.test.ts` can run
 * the very same compile in-process and assert on its output rather than on a
 * checked-in file that could drift from the source.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import solc from "solc";

/** File name as it appears inside the standard-JSON input (and in metadata). */
export const SOURCE_NAME = "DuelEscrow.sol";

/** The single contract this project deploys. */
export const CONTRACT_NAME = "DuelEscrow";

/** Optimizer runs. Part of the BaseScan verification input. */
export const OPTIMIZER_RUNS = 200;

const HERE = import.meta.dir;

/** Absolute path of the Solidity source. */
export const SOURCE_PATH = join(HERE, SOURCE_NAME);

/** Absolute path of the committed build artifact. */
export const ARTIFACT_PATH = join(HERE, "out", `${CONTRACT_NAME}.json`);

// -- solc standard JSON, typed just enough to stay honest ------------------

/** One entry of a Solidity ABI. Loose on purpose — we only read `type`/`name`. */
export interface AbiEntry {
  readonly type: string;
  readonly name?: string;
  readonly stateMutability?: string;
  readonly inputs?: readonly { readonly name: string; readonly type: string }[];
  readonly outputs?: readonly { readonly name: string; readonly type: string }[];
}

interface SolcError {
  readonly severity?: string;
  readonly formattedMessage?: string;
  readonly message?: string;
}

interface SolcOutput {
  readonly errors?: readonly SolcError[];
  readonly contracts?: Record<string, Record<string, {
    readonly abi?: readonly AbiEntry[];
    readonly metadata?: string;
    readonly evm?: {
      readonly bytecode?: { readonly object?: string };
      readonly deployedBytecode?: { readonly object?: string };
    };
  }> | undefined>;
  readonly sources?: Record<string, { readonly ast?: AstNode } | undefined>;
}

/** A solc AST node. Only the fields the constant walk needs are named. */
export interface AstNode {
  readonly nodeType?: string;
  readonly name?: string;
  readonly constant?: boolean;
  readonly value?: AstNode | string;
  readonly nodes?: readonly AstNode[];
  readonly [key: string]: unknown;
}

/** What {@link compileEscrow} hands back. */
export interface CompileResult {
  /** The contract ABI. */
  readonly abi: readonly AbiEntry[];
  /** Creation bytecode, `0x`-prefixed. */
  readonly bytecode: string;
  /** Runtime bytecode, `0x`-prefixed. */
  readonly deployedBytecode: string;
  /** solc metadata JSON string (contains settings + source hash). */
  readonly metadata: string;
  /** Full solc version string, e.g. `0.8.26+commit.8a97fa7a.Emscripten.clang`. */
  readonly solcVersion: string;
  /** `v0.8.26+commit.8a97fa7a` — the form BaseScan's compiler dropdown uses. */
  readonly solcLongVersion: string;
  /**
   * Numeric value of every `constant` declaration whose initialiser is a plain
   * number literal (`RAKE_BPS` -> `400n`, `TIMEOUT` -> `21600n`). Read from the
   * AST — i.e. from what the compiler actually parsed — rather than from source
   * text or from bytecode, with `_` separators stripped and time/ether
   * subdenominations applied. Constants initialised by an expression (e.g.
   * `VERDICT_TYPEHASH = keccak256(...)`) are not literals and do not appear.
   */
  readonly constants: Readonly<Record<string, bigint>>;
  /** Non-fatal diagnostics; empty on a clean build. */
  readonly warnings: readonly string[];
}

/** The exact standard-JSON input, so build and test cannot disagree. */
function standardInput(source: string, sourceName: string = SOURCE_NAME): string {
  return JSON.stringify({
    language: "Solidity",
    sources: { [sourceName]: { content: source } },
    settings: {
      // evmVersion deliberately omitted — see the header.
      optimizer: { enabled: true, runs: OPTIMIZER_RUNS },
      outputSelection: {
        "*": {
          "*": ["abi", "metadata", "evm.bytecode.object", "evm.deployedBytecode.object"],
          "": ["ast"],
        },
      },
    },
  });
}

/**
 * Solidity literal subdenominations and their multipliers. `6 hours` parses as
 * the literal `6` carrying `subdenomination: "hours"`, so the AST value alone
 * would read as 6 rather than 21600.
 */
const SUBDENOMINATION: Readonly<Record<string, bigint>> = {
  seconds: 1n,
  minutes: 60n,
  hours: 3600n,
  days: 86_400n,
  weeks: 604_800n,
  wei: 1n,
  gwei: 1_000_000_000n,
  ether: 1_000_000_000_000_000_000n,
};

/** Collect `name -> value` for every `constant` number literal in the AST. */
function constantLiterals(ast: AstNode | undefined): Record<string, bigint> {
  const out: Record<string, bigint> = {};
  const walk = (node: AstNode | undefined): void => {
    if (!node) return;
    if (node.nodeType === "VariableDeclaration" && node.constant === true && typeof node.name === "string") {
      const value = node.value;
      if (value && typeof value !== "string" && value["kind"] === "number" && typeof value["value"] === "string") {
        // `100_000` and `0x7FFF…` both go through BigInt; `_` is not legal there.
        const raw = value["value"].replaceAll("_", "");
        const sub = typeof value["subdenomination"] === "string" ? value["subdenomination"] : undefined;
        try {
          out[node.name] = BigInt(raw) * (sub ? (SUBDENOMINATION[sub] ?? 1n) : 1n);
        } catch {
          // Not a plain integer literal (scientific notation, a rational) —
          // leave it out rather than record a wrong number.
        }
      }
    }
    for (const child of node.nodes ?? []) walk(child);
  };
  walk(ast);
  return out;
}

const hex = (object: string): string => (object.startsWith("0x") ? object : `0x${object}`);

/**
 * Compile the escrow. Throws with the full solc diagnostics on any error.
 *
 * Pure with respect to the filesystem: it reads the source and returns; nothing
 * is written. {@link writeArtifact} does the writing.
 */
export async function compileEscrow(
  sourceName: string = SOURCE_NAME,
  contractName: string = CONTRACT_NAME,
): Promise<CompileResult> {
  // Normalise to LF before compiling, and it is load-bearing rather than
  // tidiness. `core.autocrlf=true` with no `.gitattributes` checks these
  // sources out as CRLF on Windows while the committed artifact was compiled
  // from LF, and solc hashes the exact source bytes into `metadata` — so the
  // same commit produced different bytecode on Windows and Linux, and
  // `test/escrow.test.ts`'s artifact check failed on a clean Windows clone.
  // Compiling a canonical form makes the artifact reproducible on any host,
  // which is the whole point of pinning the compiler and its settings.
  const source = (await Bun.file(join(HERE, sourceName)).text()).replace(/\r\n/g, "\n");

  const output = JSON.parse(solc.compile(standardInput(source, sourceName))) as SolcOutput;

  const all = output.errors ?? [];
  const fatal = all.filter((e) => e.severity === "error");
  if (fatal.length > 0) {
    const detail = fatal.map((e) => e.formattedMessage ?? e.message ?? "(no message)").join("\n");
    throw new Error(`solc reported ${fatal.length} error(s) compiling ${sourceName}:\n${detail}`);
  }
  const warnings = all
    .filter((e) => e.severity !== "error")
    .map((e) => e.formattedMessage ?? e.message ?? "(no message)");

  const compiled = output.contracts?.[sourceName]?.[contractName];
  if (!compiled) throw new Error(`solc produced no output for ${sourceName}:${contractName}`);

  const { abi, metadata, evm } = compiled;
  const creation = evm?.bytecode?.object;
  const runtime = evm?.deployedBytecode?.object;
  if (!abi || !metadata || !creation || !runtime) {
    throw new Error(`solc output for ${contractName} is missing abi/metadata/bytecode`);
  }
  if (creation.length === 0) throw new Error(`${contractName} compiled to empty creation bytecode`);

  const solcVersion = solc.version();
  return {
    abi,
    bytecode: hex(creation),
    deployedBytecode: hex(runtime),
    metadata,
    solcVersion,
    // `0.8.26+commit.8a97fa7a.Emscripten.clang` -> `v0.8.26+commit.8a97fa7a`
    solcLongVersion: `v${solcVersion.split(".Emscripten")[0] ?? solcVersion}`,
    constants: constantLiterals(output.sources?.[sourceName]?.ast),
    warnings,
  };
}

/** Write the five committed artifact fields to {@link ARTIFACT_PATH}. */
export function writeArtifact(result: CompileResult): void {
  const { abi, bytecode, deployedBytecode, metadata, solcVersion } = result;
  // `recursive: true` is supposed to make this a no-op on an existing
  // directory; Bun on Windows still throws EEXIST, so check first.
  const dir = dirname(ARTIFACT_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(
    ARTIFACT_PATH,
    `${JSON.stringify({ abi, bytecode, deployedBytecode, metadata, solcVersion }, null, 2)}\n`,
    "utf8",
  );
}

if (import.meta.main) {
  const result = await compileEscrow();
  for (const warning of result.warnings) console.warn(warning);
  writeArtifact(result);

  const externals = result.abi.filter((e) => e.type === "function").length;
  const events = result.abi.filter((e) => e.type === "event").length;
  const runtimeBytes = (result.deployedBytecode.length - 2) / 2;

  console.log(`solc            ${result.solcVersion}`);
  console.log(`optimizer       enabled, ${OPTIMIZER_RUNS} runs`);
  console.log(`warnings        ${result.warnings.length}`);
  console.log(`abi             ${externals} function(s), ${events} event(s)`);
  console.log(`runtime size    ${runtimeBytes} bytes (EIP-170 limit 24576)`);
  const constants = Object.entries(result.constants).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`constants       ${constants}`);
  console.log(`artifact        ${ARTIFACT_PATH}`);
}
