import { DATA_CHAIN_ID, SIGNING_CHAIN_ID } from "./wallet.ts";

/**
 * The two Base chains as *network profiles* — rpc, explorer, USDC address —
 * for the code that needs more than a number: the operator consoles, and the
 * explorer links a receipt hangs off.
 *
 * **The numbers are not declared here.** They are re-exported from
 * `./wallet.ts`, which is where the split between the two lives and where the
 * long-form reason for it is written. Two files each declaring `84532` is the
 * shape of drift this repo has already paid for once, and a profile table is
 * not an authority on which chain may sign.
 *
 * There is deliberately no `BASE_CHAIN_ID` here or anywhere else. "Base" names
 * two chains in this codebase, so a constant called that would have to be
 * wrong about one of them; every call site says which it means or does not
 * compile. Note also that a profile in this table is not a permission —
 * `BASE_MAINNET` exists so a mainnet chain id read off a wallet can be *named*
 * in an error message, never so anything can be signed there.
 * `assertSigningChain` in `./wallet.ts` is the only thing that decides that.
 */
export const BASE_MAINNET_CHAIN_ID = DATA_CHAIN_ID as 8453;
export const BASE_SEPOLIA_CHAIN_ID = SIGNING_CHAIN_ID as 84532;

export type SupportedBaseChainId =
  | typeof BASE_MAINNET_CHAIN_ID
  | typeof BASE_SEPOLIA_CHAIN_ID;

export interface BaseNetworkProfile {
  readonly key: "base" | "base-sepolia";
  readonly chainId: SupportedBaseChainId;
  readonly name: "Base" | "Base Sepolia";
  readonly rpcUrl: string;
  readonly explorerUrl: string;
  readonly usdc: string;
  readonly testnet: boolean;
}

/** Circle-issued native USDC on Base mainnet. */
export const BASE_MAINNET: BaseNetworkProfile = Object.freeze({
  key: "base",
  chainId: BASE_MAINNET_CHAIN_ID,
  name: "Base",
  rpcUrl: "https://mainnet.base.org",
  explorerUrl: "https://basescan.org",
  usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  testnet: false,
});

/** Base Sepolia. Native test ETH has no real-world value. */
export const BASE_SEPOLIA: BaseNetworkProfile = Object.freeze({
  key: "base-sepolia",
  chainId: BASE_SEPOLIA_CHAIN_ID,
  name: "Base Sepolia",
  rpcUrl: "https://sepolia.base.org",
  explorerUrl: "https://sepolia.basescan.org",
  usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  testnet: true,
});

/**
 * Resolve the public network setting. The application is intentionally pinned
 * to Base Sepolia; explicit mainnet values fail closed.
 */
export function baseNetworkFrom(value: unknown): BaseNetworkProfile | null {
  if (value === undefined || value === null || value === "") return BASE_SEPOLIA;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const key = String(value).trim().toLowerCase();
  if (key === "") return BASE_SEPOLIA;
  if (["base", "base-mainnet", "mainnet", String(BASE_MAINNET_CHAIN_ID)].includes(key)) {
    return null;
  }
  if (["base-sepolia", "sepolia", "testnet", String(BASE_SEPOLIA_CHAIN_ID)].includes(key)) {
    return BASE_SEPOLIA;
  }
  return null;
}

export function baseNetworkByChainId(chainId: unknown): BaseNetworkProfile | null {
  if (chainId === BASE_MAINNET_CHAIN_ID) return BASE_MAINNET;
  if (chainId === BASE_SEPOLIA_CHAIN_ID) return BASE_SEPOLIA;
  return null;
}

export function baseExplorerTx(chainId: unknown, hash: string): string {
  const network = baseNetworkByChainId(chainId) ?? BASE_SEPOLIA;
  return hash ? `${network.explorerUrl}/tx/${hash}` : "";
}

export function baseExplorerAddress(chainId: unknown, address: string): string {
  const network = baseNetworkByChainId(chainId) ?? BASE_SEPOLIA;
  return address ? `${network.explorerUrl}/address/${address}` : "";
}
