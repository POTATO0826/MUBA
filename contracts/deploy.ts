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
 *   - the token MUST be native USDC on Base and the chain MUST be Base mainnet
 *     — both are hard refusals with no override, see below;
 *   - the committed artifact is recompiled and compared byte-for-byte, so a
 *     stale `contracts/out/DuelEscrow.json` can never be what gets deployed
 *     (and can never be what the operator then pastes into BaseScan);
 *   - the default run broadcasts NOTHING. Deploying takes `--broadcast`.
 *
 * Two of those used to be warnings and are now refusals — finding 5-1 of
 * `docs/reviews/escrow-adversarial-review.md`, executed against the real
 * bytecode:
 *
 *   - **A non-canonical token is unrecoverable.** The constructor takes any
 *     non-zero address, and there is no owner, no sweep and no rotation. With a
 *     1 % fee-on-transfer token the reviewer watched the escrow book a
 *     `2 × stake` pot, receive less than that, pay a settle out of the
 *     shortfall and then strand `claimRake` forever — with several duels live,
 *     the gap comes out of other players' stakes. One wrong constructor
 *     argument is permanent.
 *   - **A non-Base chain silently invalidates every verdict.**
 *     `src/server/attest.ts` hard-codes `chainId = 8453` in its EIP-712 domain,
 *     so a deployment anywhere else produces signatures that recover to a
 *     stranger — discovered only after both stakes are locked, with the
 *     six-hour timeout as the only way out.
 *
 * Neither has an override flag, deliberately. If a future deployment genuinely
 * needs a different token or chain, that is a code change and a review, not a
 * flag someone can reach for at 3am on deploy night.
 *
 * Env:
 *   RPC_URL               required, secret. Base mainnet JSON-RPC.
 *   DEPLOYER_PRIVATE_KEY  required, secret. Needs ~$0.50 of Base ETH.
 *   ATTESTOR_ADDRESS      required. The referee key's ADDRESS (never its key).
 *   TREASURY_ADDRESS      required. Sole rake recipient, immutable forever.
 *   USDC                  optional. Defaults to native USDC on Base, and is
 *                         REFUSED if set to anything else.
 */

import { AbiCoder, ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress } from "ethers";
import { ARTIFACT_PATH, CONTRACT_NAME, OPTIMIZER_RUNS, SOURCE_NAME, compileEscrow } from "./build.ts";

/**
 * Native (Circle-issued) USDC on Base mainnet, 6 decimals — FiatTokenV2_2,
 * which returns `true`, reverts on failure and takes no transfer fee. The
 * escrow's whole accounting rests on those three properties (`DuelEscrow.sol`
 * :6). The only token this script will deploy against; see 5-1 above.
 */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** Base mainnet. A mismatch is a HARD REFUSAL — see 5-1 above and `main`. */
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

  // The token is checked here, before a single RPC call or compile, because it
  // is the one constructor argument whose wrongness is silent: a fee-on-transfer
  // or otherwise non-canonical token deploys cleanly, settles cleanly, and only
  // fails once `claimRake` reaches for rake the escrow never received — by
  // which time there is no owner, no sweep and no rotation to fix it. Both
  // sides are checksummed by `address()` above, so this is a value comparison.
  if (usdc !== USDC_BASE) {
    console.error("REFUSING TO RUN — USDC is not native USDC on Base.");
    console.error(`  got       ${usdc}`);
    console.error(`  expected  ${USDC_BASE}`);
    console.error("");
    console.error("  The escrow assumes a token that returns true, reverts on failure and");
    console.error("  charges no transfer fee. It has no owner, no sweep and no rotation, so a");
    console.error("  wrong token address is unrecoverable — every stake behind it included.");
    console.error("  Unset USDC to take the default. There is deliberately no override flag.");
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

  // Refused before the deployer is even loaded. `src/server/attest.ts` binds
  // its EIP-712 domain to chainId 8453 as a constant, so an escrow deployed on
  // any other chain is an escrow no verdict this repo can sign will ever
  // settle — and the failure surfaces with both stakes already locked.
  if (network.chainId !== BASE_CHAIN_ID) {
    console.error(`REFUSING TO RUN — RPC_URL is not Base mainnet.`);
    console.error(`  got       chainId ${network.chainId} (${network.name})`);
    console.error(`  expected  chainId ${BASE_CHAIN_ID} (base)`);
    console.error("");
    console.error("  The attestor signs verdicts for chainId 8453 and nothing else, so an");
    console.error("  escrow anywhere else can never be settled by this server. Point RPC_URL");
    console.error("  at Base mainnet. There is deliberately no override flag.");
    process.exit(1);
  }

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
  // `usdc` and the chain are already proven above; these two are not, and no
  // check can prove them. Read them back against your notes and against
  // BaseScan before broadcasting — a typo here is a redeploy at best.
  console.log(`  usdc          ${usdc}  (Base native USDC, verified)`);
  console.log(`  attestor      ${attestor}  <-- CONFIRM ON BASESCAN`);
  console.log(`  treasury      ${treasury}  <-- CONFIRM ON BASESCAN`);
  console.log("");

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
