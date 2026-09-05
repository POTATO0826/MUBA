import { BASE_SEPOLIA_CHAIN_ID } from "../data/base-network.ts";

export interface WalletConfig {
  /** Empty means AppKit is not configured, so the boundary uses a fallback. */
  projectId: string;
  /** Wallet switching is pinned to Base Sepolia. */
  chainId: number;
}

const FALLBACK: WalletConfig = { projectId: "", chainId: BASE_SEPOLIA_CHAIN_ID };

/**
 * Read the public WalletConnect project id from our own Bun server. Keeping
 * this Reown-free is important: the mock tier imports this module at startup.
 */
export async function fetchWalletConfig(): Promise<WalletConfig> {
  try {
    const res = await fetch("/api/wallet-config");
    if (!res.ok) return FALLBACK;
    const body = (await res.json()) as Partial<WalletConfig>;
    return {
      projectId: typeof body.projectId === "string" ? body.projectId : "",
      // Do not let deployment configuration widen wallet access to mainnet.
      chainId: BASE_SEPOLIA_CHAIN_ID,
    };
  } catch {
    return FALLBACK;
  }
}
