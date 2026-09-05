import {
  useAppKit,
  useAppKitAccount,
  useAppKitNetwork,
  useAppKitProvider,
  useDisconnect,
  useWalletInfo,
} from "@reown/appkit/react";
import { baseSepolia } from "@reown/appkit/networks";
import { BrowserProvider, type Eip1193Provider } from "ethers";
import { useMemo } from "react";
import {
  SIGNING_CHAIN_ID,
  SIGNING_CHAIN_NAME,
  type WalletIdentity,
  type WalletSource,
} from "../data/wallet.ts";

/**
 * The real `WalletSource`: AppKit's stores read through hooks, flattened into
 * the one interface the app knows about.
 *
 * Must be rendered inside `<AppKitProvider>` — `src/wallet/boundary.tsx` is the
 * only place that does that, and it is also the only place that decides between
 * this and the mock.
 */
export function useAppKitWallet(): WalletSource {
  const { address, isConnected, status } = useAppKitAccount();
  const { chainId, switchNetwork } = useAppKitNetwork();
  const { walletInfo } = useWalletInfo();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  // AppKit is multi-chain; we only ever ask for the EVM namespace.
  const { walletProvider } = useAppKitProvider<Eip1193Provider>("eip155");

  // `chainId` is `number | string | undefined` — WalletConnect carries CAIP ids
  // as strings, so normalise before comparing to the signing chain.
  const numericChainId = useMemo(() => {
    if (chainId === undefined) return null;
    const n = typeof chainId === "number" ? chainId : Number.parseInt(chainId, 10);
    return Number.isNaN(n) ? null : n;
  }, [chainId]);

  const identity = useMemo<WalletIdentity>(
    () => ({
      address: address ?? null,
      chainId: numericChainId,
      walletName: walletInfo?.name ?? null,
      connected: isConnected && Boolean(address),
      // `status` covers the reconnect-on-reload window, which `isConnected`
      // reports as false — without it the header flashes "Connect wallet" at
      // someone who is already connected.
      connecting: status === "connecting" || status === "reconnecting",
      // AppKit persists the session itself (WalletConnect keeps it in
      // localStorage, and an injected connector re-authorises silently), so
      // "stay connected across a reload" is already true at this layer. What was
      // NOT true is that the UI waited for it: `status` is `undefined` on the
      // very first render and `"reconnecting"` for the round trip after, and a
      // screen that decided what to draw in either window offered to connect a
      // wallet that was already coming back. `settled` is that window, named, so
      // no surface has to infer it from a status string it should not know about.
      settled: status !== undefined && status !== "connecting" && status !== "reconnecting",
      wrongNetwork: isConnected && numericChainId !== null && numericChainId !== SIGNING_CHAIN_ID,
    }),
    [address, numericChainId, walletInfo?.name, isConnected, status],
  );

  return useMemo(
    () => ({
      id: "walletconnect",
      identity,
      connect: () => open({ view: "Connect" }).then(() => undefined),
      disconnect: () => disconnect(),
      openAccount: () => open({ view: "Account" }).then(() => undefined),
      switchToSigningChain: async () => {
        await switchNetwork(baseSepolia);
      },
      getSigner: async () => {
        if (!walletProvider || !identity.address) return null;
        // A RESTORED session gets no pass here. "Stay connected" means we do
        // not re-ask for a connection; it has never meant skipping the chain
        // check, and a silently-restored mainnet session that could sign would
        // be strictly worse than prompting every time.
        if (identity.wrongNetwork) {
          throw new Error(
            `WRONG_CHAIN: wallet is on chain ${identity.chainId}, but THETADUEL signs only on ` +
              `${SIGNING_CHAIN_NAME} (${SIGNING_CHAIN_ID}) — switch network first`,
          );
        }
        // Pinning the network skips a round-trip to `eth_chainId` on every call
        // and is safe because the wrong-network case is already out.
        const provider = new BrowserProvider(walletProvider, SIGNING_CHAIN_ID);
        return provider.getSigner(identity.address);
      },
    }),
    [identity, open, disconnect, switchNetwork, walletProvider],
  );
}
