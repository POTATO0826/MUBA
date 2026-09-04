import { base } from "@reown/appkit/networks";
import { C } from "../theme.ts";

/**
 * Base mainnet, and only Base. Offering a network the options book is not
 * deployed on would let someone connect, draft a duel and then fail at signing;
 * a one-network list turns that into AppKit's own "switch network" prompt.
 */
export const NETWORKS = [base] as const;

/** Shown in the wallet's connection prompt and in WalletConnect session lists. */
export const METADATA = {
  name: "THETADUEL",
  description: "Draft-and-duel options parlays, settled on Base.",
  // Filled in from the live origin — a mismatch here is the most common cause
  // of a wallet refusing a session, and hardcoding localhost breaks in deploy.
  url: typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
  icons: ["https://avatars.githubusercontent.com/u/179229932"],
};

/** AppKit's modal, dressed to match the app rather than shipping default blue. */
export const THEME_VARIABLES = {
  "--w3m-accent": C.accent,
  "--w3m-border-radius-master": "2px",
  "--w3m-font-family": "DM Sans, system-ui, sans-serif",
} as const;

export interface WalletConfig {
  /**
   * WalletConnect project id. Public by design — it ships in every dApp bundle
   * and is domain-restricted in the dashboard, not secret — but it still comes
   * from the server rather than being committed, so each clone uses its own.
   *
   * Empty string means unset, which the boundary reads as "run on the mock".
   */
  projectId: string;
}

/**
 * Ask our own Bun server for the project id.
 *
 * Why a fetch and not a build-time constant: Bun's HTML bundler does not inline
 * `process.env` for `Bun.serve` routes (only `bun build --env` does), so a
 * compile-time read works in `bun run build` and silently yields `undefined`
 * under `bun dev`. One runtime mechanism that behaves the same in both beats two
 * that diverge. The request is same-origin and the server already has to exist
 * for the news feed.
 */
export async function fetchWalletConfig(): Promise<WalletConfig> {
  try {
    const res = await fetch("/api/wallet-config");
    if (!res.ok) return { projectId: "" };
    const body = (await res.json()) as Partial<WalletConfig>;
    return { projectId: typeof body.projectId === "string" ? body.projectId : "" };
  } catch {
    // Offline, or the app is being served as static files with no Bun behind
    // it. Either way the mock is the correct fallback, not a crash.
    return { projectId: "" };
  }
}
