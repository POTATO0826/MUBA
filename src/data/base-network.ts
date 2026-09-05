/** Chain constants retained for decoding historical data; the live app only permits Sepolia. */
export const BASE_MAINNET_CHAIN_ID = 8453 as const;
export const BASE_SEPOLIA_CHAIN_ID = 84532 as const;

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
