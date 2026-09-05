import { Contract, JsonRpcProvider, getAddress } from "ethers";
import { DUEL_ESCROW_ABI } from "../src/utils/duelescrow.ts";

// Read-only diagnostic: never loads a private key or sends a transaction.
const address = getAddress(Bun.argv[2] ?? "");
const provider = new JsonRpcProvider("https://sepolia.base.org");
try {
  const network = await provider.getNetwork();
  if (network.chainId !== 84532n) throw new Error("RPC is not Base Sepolia");
  const code = await provider.getCode(address);
  console.log(`Address: ${address}\nChain: ${network.chainId}\nRuntime bytes: ${(code.length - 2) / 2}`);
  if (code === "0x") throw new Error("No deployed contract at this address on Base Sepolia");
  const contract = new Contract(address, DUEL_ESCROW_ABI, provider);
  for (const name of ["MIN_STAKE", "BASE_SEPOLIA_CHAIN_ID", "attestor", "TIMEOUT", "DOMAIN_SEPARATOR"]) {
    console.log(`${name}: ${await contract.getFunction(name)()}`);
  }
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  provider.destroy();
}
