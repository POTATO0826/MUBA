/**
 * Base Sepolia-only deployment for DuelEscrow.
 *
 *   bun contracts/deploy.ts              # preflight; broadcasts nothing
 *   bun contracts/deploy.ts --broadcast  # deploy with test ETH
 *
 * Required environment:
 *   ESCROW_RPC_URL        Base Sepolia RPC (chain id 84532)
 *   DEPLOYER_PRIVATE_KEY  funded with Base Sepolia test ETH
 *   ATTESTOR_ADDRESS      address of the verdict signer
 */

import { AbiCoder, ContractFactory, JsonRpcProvider, Wallet, formatEther, getAddress } from "ethers";
import { ARTIFACT_PATH, CONTRACT_NAME, OPTIMIZER_RUNS, SOURCE_NAME, compileEscrow } from "./build.ts";

const BASE_SEPOLIA_CHAIN_ID = 84_532n;

function required(name: string, missing: string[]): string {
  const value = Bun.env[name]?.trim();
  if (!value) missing.push(name);
  return value ?? "";
}

async function main(): Promise<void> {
  const broadcast = Bun.argv.includes("--broadcast");
  const missing: string[] = [];
  const rpcUrl = required("ESCROW_RPC_URL", missing);
  const deployerKey = required("DEPLOYER_PRIVATE_KEY", missing);
  const attestorRaw = required("ATTESTOR_ADDRESS", missing);

  if (missing.length > 0) {
    throw new Error(`missing required environment: ${missing.join(", ")}`);
  }

  let attestor: string;
  try {
    attestor = getAddress(attestorRaw);
  } catch {
    throw new Error("ATTESTOR_ADDRESS is not a valid address");
  }

  const fresh = await compileEscrow();
  for (const warning of fresh.warnings) console.warn(warning);
  const artifactFile = Bun.file(ARTIFACT_PATH);
  if (!(await artifactFile.exists())) {
    throw new Error(`missing ${ARTIFACT_PATH}; run bun contracts/build.ts`);
  }
  const committed = (await artifactFile.json()) as { bytecode?: string; solcVersion?: string };
  if (committed.bytecode !== fresh.bytecode || committed.solcVersion !== fresh.solcVersion) {
    throw new Error("compiled artifact is stale; run bun contracts/build.ts and review it");
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const network = await provider.getNetwork();
  if (network.chainId !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(
      `refusing chain ${network.chainId}; ESCROW_RPC_URL must be Base Sepolia (${BASE_SEPOLIA_CHAIN_ID})`,
    );
  }

  const wallet = new Wallet(deployerKey, provider);
  const balance = await provider.getBalance(wallet.address);
  const encodedArgs = AbiCoder.defaultAbiCoder().encode(["address"], [attestor]);
  const metadata = JSON.parse(fresh.metadata) as { settings?: { evmVersion?: string } };

  console.log(`contract       ${CONTRACT_NAME} (${SOURCE_NAME})`);
  console.log(`network        Base Sepolia (${network.chainId})`);
  console.log(`deployer       ${wallet.address}`);
  console.log(`balance        ${formatEther(balance)} test ETH`);
  console.log(`attestor       ${attestor}`);
  console.log(`compiler       ${fresh.solcLongVersion}`);
  console.log(`optimizer      enabled, ${OPTIMIZER_RUNS} runs`);
  console.log(`EVM version    ${metadata.settings?.evmVersion ?? "compiler default"}`);
  console.log(`constructor    ${encodedArgs.slice(2)}`);

  if (!broadcast) {
    console.log("PREFLIGHT ONLY — nothing was broadcast.");
    return;
  }
  if (balance === 0n) throw new Error("deployer has no Base Sepolia test ETH");

  const factory = new ContractFactory(fresh.abi, fresh.bytecode, wallet);
  const contract = await factory.deploy(attestor);
  const tx = contract.deploymentTransaction();
  console.log(`broadcast      ${tx?.hash ?? "unknown"}`);
  await contract.waitForDeployment();
  const deployed = await contract.getAddress();
  const deployedCode = await provider.getCode(deployed);
  if (deployedCode === "0x") {
    throw new Error("deployment transaction confirmed but no contract bytecode was found");
  }

  // Verify the exact interface the app probes before printing an address for
  // THETADUEL_ESCROW. This catches a stale artifact or an unexpected RPC result
  // at deployment time instead of surfacing an opaque `MIN_STAKE: undefined`
  // error later in the browser.
  const [deployedChainId, deployedMinStake] = await Promise.all([
    contract.getFunction("BASE_SEPOLIA_CHAIN_ID")(),
    contract.getFunction("MIN_STAKE")(),
  ]);
  if (BigInt(deployedChainId) !== BASE_SEPOLIA_CHAIN_ID) {
    throw new Error(`deployed contract reported unexpected chain id ${deployedChainId}`);
  }
  if (BigInt(deployedMinStake) !== 1_000_000_000_000_000n) {
    throw new Error(`deployed contract reported unexpected MIN_STAKE ${deployedMinStake}`);
  }

  console.log(`deployed       ${deployed}`);
  console.log("verified       MIN_STAKE=1000000000000000 wei");
  console.log(`explorer       https://sepolia.basescan.org/address/${deployed}#code`);
  console.log(`set THETADUEL_ESCROW=${deployed}`);
}

if (import.meta.main) await main();
