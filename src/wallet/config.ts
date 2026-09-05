import { baseSepolia } from "@reown/appkit/networks";
import { C } from "../theme.ts";

/**
 * AppKit-only configuration. This module is reachable exclusively through the
 * lazy live-wallet tier; mock and injected startup code must import project.ts
 * instead so evaluating this Reown import cannot break their fallback path.
 */

/**
 * Base Sepolia, and only Base Sepolia. A one-network list turns a wrong network
 * into AppKit's own switch-network prompt before the player tries to sign.
 *
 * **Base mainnet is deliberately absent, and its absence is the feature.** The
 * owner's instruction was that nothing a user signs may spend real money; a
 * two-entry list would make mainnet one dropdown away, and AppKit would treat
 * the switch as a supported operation rather than as the refusal it has to be.
 * The options book is still read from mainnet — see `SIGNING_CHAIN_ID` and
 * `DATA_CHAIN_ID` in `src/data/wallet.ts` — but that read never touches this
 * list, because a read never touches a wallet.
 */
export const NETWORKS = [baseSepolia] as const;

/** Shown in wallet connection prompts and WalletConnect session lists. */
export const METADATA = {
  name: "THETADUEL",
  description:
    "Draft-and-duel options parlays. Prices are read from Base mainnet; " +
    "signing happens on Base Sepolia testnet only.",
  url: typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
  icons: ["https://avatars.githubusercontent.com/u/179229932"],
};

/** AppKit's modal, dressed to match the app rather than using default blue. */
export const THEME_VARIABLES = {
  "--w3m-accent": C.accent,
  "--w3m-border-radius-master": "2px",
  "--w3m-font-family": "DM Sans, system-ui, sans-serif",
} as const;
