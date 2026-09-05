import { useCallback, useMemo, useState } from "react";
import {
  SIGNING_CHAIN_ID,
  DISCONNECTED,
  type WalletIdentity,
  type WalletSource,
} from "../data/wallet.ts";

/**
 * The address the design's header showed. Kept verbatim so the port's mock
 * reads `0x71c…4Af2` exactly as the source did.
 */
export const MOCK_ADDRESS = "0x71cB05fD1eA1B3d4a7C9e8F2b6D0a3C85e9d4Af2";

/**
 * `?as=0x…` overrides the mock address for this tab.
 *
 * Two tabs on one machine otherwise share the single `MOCK_ADDRESS`, and the
 * room store correctly refuses to let a host fill their own challenger seat —
 * so a duel cannot be exercised locally at all without either two real wallets
 * in two browser profiles, or this. Dev affordance on the mock only; the live
 * `WalletSource` takes its address from the wallet and ignores the URL.
 */
const AS_PARAM = /^0x[0-9a-fA-F]{40}$/;

/**
 * True when the URL is asking for the mock wallet by name.
 *
 * `?as=` only means anything to the mock, so its presence is also the signal to
 * *choose* the mock — otherwise on a machine with extensions installed the
 * injected tier always wins and a local two-player test is impossible without
 * two real wallets in two browser profiles.
 */
export function mockRequested(): boolean {
  if (typeof window === "undefined") return false;
  const raw = new URLSearchParams(window.location.search).get("as");
  return raw !== null && AS_PARAM.test(raw);
}

function mockAddress(): string {
  if (typeof window === "undefined") return MOCK_ADDRESS;
  const raw = new URLSearchParams(window.location.search).get("as");
  return raw && AS_PARAM.test(raw) ? raw : MOCK_ADDRESS;
}

function connectedIdentity(address: string): WalletIdentity {
  return {
    address,
    // The signing chain, so the mock is never the tier that reports a mainnet
    // chain id. It cannot sign at all — `getSigner` refuses below — so this
    // number decides nothing; it is here so that no screen reading
    // `identity.chainId` has to special-case the mock to print a truthful
    // network, and so a test double copied from this shape starts on the
    // chain the guards accept rather than the one they refuse.
    chainId: SIGNING_CHAIN_ID,
    walletName: "Mock wallet",
    connected: true,
    connecting: false,
    // Nothing to restore and nothing to wait for. The mock must NOT pretend to
    // persist a real session — it reports `true` immediately because it
    // genuinely knows the answer on the first render, not because it found one.
    settled: true,
    wrongNetwork: false,
  };
}

/**
 * A `WalletSource` with no network behind it: connect flips a boolean, exactly
 * the behaviour `state.wallet` had before this layer existed.
 *
 * It is the fallback, not a fixture — the app runs on it whenever the server has
 * no `WALLETCONNECT_PROJECT_ID`, which is what keeps `bun test` headless (AppKit
 * reaches for `window.crypto`, IndexedDB and a relay socket the moment it
 * initialises) and what lets someone clone the repo and play without signing up
 * for anything.
 */
export function useMockWallet(): WalletSource {
  const [connected, setConnected] = useState(false);
  /**
   * `?as=` is read once, at mount. `App` rewrites the address bar to
   * `routePath(...)` on its first navigation and the query string goes with it,
   * so a lazy read would hand back `MOCK_ADDRESS` for the rest of the session
   * and the two-tab local duel would collapse to one identity.
   */
  const [address] = useState(mockAddress);

  const connect = useCallback(async () => setConnected(true), []);
  const disconnect = useCallback(async () => setConnected(false), []);

  return useMemo(
    () => ({
      id: "mock",
      // `settled: true` on the disconnected branch too: a mock that has not been
      // connected is a *known* absence of a session, not a pending restore, and a
      // screen waiting on `settled` would otherwise never draw its connect button
      // on the no-wallet tier — which is the only tier that fresh clone has.
      identity: connected ? connectedIdentity(address) : { ...DISCONNECTED, settled: true },
      connect,
      disconnect,
      // No modal to open, so the panel's only real action stands in for it.
      openAccount: disconnect,
      // Already on the signing chain by construction, and unable to sign in any
      // case.
      switchToSigningChain: async () => {},
      // A signer would need a private key. Disconnected follows the interface
      // and returns `null`; connected refuses loudly, because handing back
      // something that looks signable and reverts on the first
      // `sendTransaction` is the worse failure.
      getSigner: async () => {
        if (!connected) return null;
        throw new Error(
          "mock wallet cannot sign — set WALLETCONNECT_PROJECT_ID to connect a real wallet",
        );
      },
    }),
    [connected, address, connect, disconnect],
  );
}
