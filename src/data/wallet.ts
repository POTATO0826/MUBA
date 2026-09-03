import type { Signer } from "ethers";

/**
 * Base mainnet. Thetanuts is deployed here and nowhere else — see
 * `tnuts-test/FINDINGS.md`, which pins chain 8453 and `https://mainnet.base.org`.
 * A wallet parked on any other chain cannot sign anything this app submits, so
 * the chain check is part of the identity rather than an afterthought.
 */
export const BASE_CHAIN_ID = 8453;

/** A read-only snapshot of who the connected wallet says you are. */
export interface WalletIdentity {
  /** Checksummed address, or `null` when nothing is connected. */
  address: string | null;
  /** Chain the wallet currently has selected. `null` when disconnected. */
  chainId: number | null;
  /** Name of the wallet app, e.g. `"MetaMask"`. `null` when unknown. */
  walletName: string | null;
  connected: boolean;
  /** A connect or an automatic reconnect is in flight. */
  connecting: boolean;
  /** Connected, but not on Base — nothing can be signed against Thetanuts. */
  wrongNetwork: boolean;
}

/**
 * Everything the UI needs from a wallet, behind one interface — deliberately the
 * same shape of seam as `MarketSource` in `./market.ts`.
 *
 * Two implementations ship:
 *
 * - `useMockWallet()` (`src/wallet/mock.ts`) — the design's placeholder. One
 *   fixed address, no network, no project id. Keeps the app runnable and the
 *   headless tests honest.
 * - `useAppKitWallet()` (`src/wallet/appkit.tsx`) — real WalletConnect over
 *   Reown AppKit with the ethers adapter, scoped to Base.
 *
 * `src/wallet/boundary.tsx` picks between them at boot and hands the winner to
 * `<App wallet={…} />`, so no view imports AppKit.
 *
 * The address is the player identity. That is the whole point of doing this
 * before PvP: matchmaking, room links and settlement all key on
 * `identity.address`, so the multiplayer layer has something real to name
 * players by instead of the `"You"` / `"kazuo.eth"` fixtures.
 */
export interface WalletSource {
  readonly id: string;
  readonly identity: WalletIdentity;
  /**
   * Open the wallet chooser. Resolves when the modal closes — which is *not*
   * the same as having connected; watch `identity.connected` for that.
   */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** The connected-wallet panel: balance, copy address, disconnect. */
  openAccount(): Promise<void>;
  /** Ask the wallet to move to Base. Rejects if the wallet refuses. */
  switchToBase(): Promise<void>;
  /**
   * An ethers signer for writes — the seam the real on-chain options trade
   * hangs off.
   *
   * Thetanuts' own client is provider-only and has to run server-side
   * (`tnuts-test/FINDINGS.md`), so the split is: the server prices and builds
   * the order, this signer signs and submits it from the browser. ethers 6 is
   * shared with the SDK on purpose — one web3 stack, one version.
   *
   * Returns `null` when no wallet is connected. Throws when a wallet is
   * connected but sitting on the wrong chain, because silently returning
   * `null` there would look identical to "not connected" at the call site.
   */
  getSigner(): Promise<Signer | null>;
}

export const DISCONNECTED: WalletIdentity = {
  address: null,
  chainId: null,
  walletName: null,
  connected: false,
  connecting: false,
  wrongNetwork: false,
};

/**
 * `0x71cB05fD1eA1B3d4a7C9e8F2b6D0a3C85e9d4Af2` → `0x71c…4Af2`.
 *
 * Three in, four out — the design's truncation, not the more common six-in
 * form, so the header reads exactly as the source mock did.
 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-4)}`;
}

/** Two initials for the player avatar: the first two hex digits, upper-cased. */
export function addressInitials(address: string): string {
  return address.slice(2, 4).toUpperCase();
}
