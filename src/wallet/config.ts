import { baseSepolia } from "@reown/appkit/networks";
import { C } from "../theme.ts";

/**
 * AppKit-only configuration. This module is reachable exclusively through the
 * lazy live-wallet tier; mock and injected startup code must import project.ts
 * instead so evaluating this Reown import cannot break their fallback path.
 */

/**
 * Wallet connections are testnet-only. Keeping mainnet out of this list also
 * prevents AppKit from offering it as an alternate network in the modal.
 */
export const NETWORKS = [baseSepolia] as const;

/** Shown in wallet connection prompts and WalletConnect session lists. */
export const METADATA = {
  name: "THETADUEL",
  description: "Winner-takes-all duels using Base Sepolia test ETH.",
  url: typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
  icons: ["https://avatars.githubusercontent.com/u/179229932"],
};

/** AppKit's modal, dressed to match the app rather than using default blue. */
export const THEME_VARIABLES = {
  "--w3m-accent": C.accent,
  "--w3m-border-radius-master": "2px",
  "--w3m-font-family": "DM Sans, system-ui, sans-serif",
} as const;
