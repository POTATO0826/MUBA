export interface WalletConfig {
  /** Empty means AppKit is not configured, so the boundary uses a fallback. */
  projectId: string;
}

/**
 * Read the public WalletConnect project id from our own Bun server. Keeping
 * this Reown-free is important: the mock tier imports this module at startup.
 */
export async function fetchWalletConfig(): Promise<WalletConfig> {
  try {
    const res = await fetch("/api/wallet-config");
    if (!res.ok) return { projectId: "" };
    const body = (await res.json()) as Partial<WalletConfig>;
    return { projectId: typeof body.projectId === "string" ? body.projectId : "" };
  } catch {
    return { projectId: "" };
  }
}
