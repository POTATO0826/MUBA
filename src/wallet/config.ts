import { base } from "@reown/appkit/networks";
import { C } from "../theme.ts";

/**
 * AppKit-only configuration. This module is reachable exclusively through the
 * lazy live-wallet tier; mock and injected startup code must import project.ts
 * instead so evaluating this Reown import cannot break their fallback path.
 */

/**
 * Base mainnet, and only Base. A one-network list turns a wrong network into
 * AppKit's own switch-network prompt before the player tries to sign.
 */
export const NETWORKS = [base] as const;

/** Shown in wallet connection prompts and WalletConnect session lists. */
export const METADATA = {
  name: "THETADUEL",
  description: "Draft-and-duel options parlays, settled on Base.",
  url: typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
  icons: ["https://avatars.githubusercontent.com/u/179229932"],
};

/** AppKit's modal, dressed to match the app rather than using default blue. */
export const THEME_VARIABLES = {
  "--w3m-accent": C.accent,
  "--w3m-border-radius-master": "2px",
  "--w3m-font-family": "DM Sans, system-ui, sans-serif",
} as const;
