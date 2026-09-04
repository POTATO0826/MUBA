/**
 * Deploy DuelEscrow to Base mainnet and print everything BaseScan needs to
 * verify the source.
 *
 *     bun contracts/deploy.ts              # PREFLIGHT — broadcasts nothing
 *     bun contracts/deploy.ts --broadcast  # actually spends gas
 *
 * This script is the ONLY place `DEPLOYER_PRIVATE_KEY` is ever read. Nothing
 * under `src/` may import it, and `test/secrets.test.ts` fails the build if that
 * name ever reaches a client bundle.
 *
 * It is deliberately paranoid, because it is a one-shot irreversible action on
 * mainnet with an unaudited, un-upgradeable, un-ownable contract:
 *
 *   - every required env var must be present, or it refuses to do anything;
 *   - every address is checksum-validated before a transaction is built;
 *   - the committed artifact is recompiled and compared byte-for-byte, so a
 *     stale `contracts/out/DuelEscrow.json` can never be what gets deployed
 *     (and can never be what the operator then pastes into BaseScan);
 *   - the default run broadcasts NOTHING. Deploying takes `--broadcast`.
 *
 * Env:
 *   RPC_URL               required, secret. Base mainnet JSON-RPC.
 *   DEPLOYER_PRIVATE_KEY  required, secret. Needs ~$0.50 of Base ETH.
 *   ATTESTOR_ADDRESS      required. The referee key's ADDRESS (never its key).
 *   TREASURY_ADDRESS      required. Sole rake recipient, immutable forever.
 *   USDC                  optional. Defaults to native USDC on Base.
 */

import { AbiCoder, ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress } from "ethers";
import { ARTIFACT_PATH, CONTRACT_NAME, OPTIMIZER_RUNS, SOURCE_NAME, compileEscrow } from "./build.ts";

/** Native (Circle-issued) USDC on Base mainnet, 6 decimals. */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Base mainnet. A mismatch is a warning, not a hard stop — see `main`. */
const BASE_CHAIN_ID = 8453n;

/** Read a required env var or collect the reason it is missing. */
function required(name: string, missing: string[]): string {
  const value = Bun.env[name]?.trim();
  if (!value) {
    missing.push(name);
    return "";
  }
  return value;
}

/** Checksum an address or record why it is unusable. */
function address(name: string, raw: string, bad: string[]): string {
  if (!raw) return "";
  try {
    return getAddress(raw);
  } catch {
    bad.push(`${name} is not a valid address: ${raw}`);
    return "";
  }
}

async function main(): Promise<void> {
  const broadcast = Bun.argv.includes("--broadcast");

  // -- 1. environment ------------------------------------------------------
  const missing: string[] = [];
  const rpcUrl = required("RPC_URL", missing);
  const deployerKey = required("DEPLOYER_PRIVATE_KEY", missing);
  const attestorRaw = required("ATTESTOR_ADDRESS", missing);
  const treasuryRaw = required("TREASURY_ADDRESS", missing);
  const usdcRaw = Bun.env["USDC"]?.trim() || USDC_BASE;

  if (missing.length > 0) {
    console.error(`REFUSING TO RUN — missing required env var(s): ${missing.join(", ")}`);
    console.error("");
    console.error("  RPC_URL               Base mainnet JSON-RPC (secret)");
    console.error("  DEPLOYER_PRIVATE_KEY  funded deploy key (secret, this script only)");
    console.error("  ATTESTOR_ADDRESS      the referee key's address");
    console.error("  TREASURY_ADDRESS      sole rake recipient, immutable after deploy");
    console.error("  USDC                  optional, defaults to Base native USDC");
    process.exit(1);
  }

  const bad: string[] = [];
  const usdc = address("USDC", usdcRaw, bad);
  const attestor = address("ATTESTOR_ADDRESS", attestorRaw, bad);
  const treasury = address("TREASURY_ADDRESS", treasuryRaw, bad);
  if (bad.length > 0) {
    console.error(`REFUSING TO RUN — ${bad.join("; ")}`);
    process.exit(1);
  }

  // -- 2. artifact integrity ----------------------------------------------
  // Recompile and compare: the bytes that go on chain must be the bytes that
  // are committed, or BaseScan verification will fail after the money is spent.
  const fresh = await compileEscrow();
  for (const warning of fresh.warnings) console.warn(warning);

  const artifactFile = Bun.file(ARTIFACT_PATH);
  if (!(await artifactFile.exists())) {
    console.error(`REFUSING TO RUN — no artifact at ${ARTIFACT_PATH}. Run: bun contracts/build.ts`);
    process.exit(1);
  }
  const committed = (await artifactFile.json()) as { bytecode?: string; solcVersion?: string };
  if (committed.bytecode !== fresh.bytecode || committed.solcVersion !== fresh.solcVersion) {
    console.error("REFUSING TO RUN — contracts/out/DuelEscrow.json is stale.");
    console.error("  The committed artifact does not match a fresh compile of DuelEscrow.sol.");
    console.error("  Run `bun contracts/build.ts`, review the diff, commit it, then retry.");
    process.exit(1);
  }

  // -- 3. network + signer -------------------------------------------------
  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  const wallet = new Wallet(deployerKey, provider);
  const balance = await provider.getBalance(wallet.address);

  const encodedArgs = AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [usdc, attestor, treasury],
  );

  console.log("");
  console.log(`contract        ${CONTRACT_NAME}  (${SOURCE_NAME})`);
  console.log(`chain           ${network.name} (chainId ${network.chainId})`);
  console.log(`deployer        ${wallet.address}`);
  console.log(`balance         ${formatEther(balance)} ETH`);
  console.log("");
  console.log("constructor arguments (IMMUTABLE FOREVER — check every one):");
  console.log(`  usdc          ${usdc}${usdc === USDC_BASE ? "  (Base native USDC)" : "  <-- NOT the default!"}`);
  console.log(`  attestor      ${attestor}`);
  console.log(`  treasury      ${treasury}`);
  console.log("");

  if (network.chainId !== BASE_CHAIN_ID) {
    console.warn(`WARNING: chainId ${network.chainId} is not Base mainnet (${BASE_CHAIN_ID}).`);
  }
  if (balance === 0n) {
    console.warn("WARNING: deployer balance is 0 — the deployment will fail.");
  }

  // -- 4. verification inputs (printed either way) -------------------------
  const metadata = JSON.parse(fresh.metadata) as { settings?: { evmVersion?: string } };
  console.log("BaseScan verification inputs (Verify & Publish -> Solidity, Single file):");
  console.log(`  Compiler Type       Solidity (Single file)`);
  console.log(`  Compiler Version    ${fresh.solcLongVersion}`);
  console.log(`  Open Source License MIT`);
  console.log(`  Optimization        Yes`);
  console.log(`  Runs                ${OPTIMIZER_RUNS}`);
  console.log(`  EVM Version         ${metadata.settings?.evmVersion ?? "(compiler default)"}`);
  console.log(`  Source file         contracts/${SOURCE_NAME} (paste verbatim, no imports to flatten)`);
  console.log(`  Constructor args    ${encodedArgs.slice(2)}`);
  console.log("    (BaseScan wants the ABI-encoded args WITHOUT the leading 0x — that is the line above.)");
  console.log("");

  if (!broadcast) {
    console.log("PREFLIGHT ONLY — nothing was broadcast. Re-run with --broadcast to deploy.");
    return;
  }

  // -- 5. deploy -----------------------------------------------------------
  const factory = new ContractFactory(fresh.abi, fresh.bytecode, wallet);
  const contract = await factory.deploy(usdc, attestor, treasury);
  const tx = contract.deploymentTransaction();
  console.log(`broadcast       ${tx?.hash ?? "(unknown)"}`);
  console.log("waiting for confirmation...");
  await contract.waitForDeployment();
  const deployed = await contract.getAddress();

  console.log("");
  console.log(`DEPLOYED        ${deployed}`);
  console.log(`tx              ${tx?.hash ?? "(unknown)"}`);
  console.log(`explorer        https://basescan.org/address/${deployed}#code`);
  console.log("");
  console.log(`Set THETADUEL_ESCROW=${deployed} in .env, then verify the source on BaseScan`);
  console.log("using the inputs printed above. Source verification is a release gate.");
}

if (import.meta.main) {
  await main();
}
