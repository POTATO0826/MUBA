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
  type WalletIdentity,
  type WalletSource,
} from "../data/wallet.ts";
import { BASE_SEPOLIA_CHAIN_ID } from "../data/base-network.ts";

/**
 * The real `WalletSource`: AppKit's stores read through hooks, flattened into
 * the one interface the app knows about.
 *
 * Must be rendered inside `<AppKitProvider>` — `src/wallet/boundary.tsx` is the
 * only place that does that, and it is also the only place that decides between
 * this and the mock.
 */
export function useAppKitWallet(_requestedChainId: number = BASE_SEPOLIA_CHAIN_ID): WalletSource {
  const targetChainId = BASE_SEPOLIA_CHAIN_ID;
  const { address, isConnected, status } = useAppKitAccount();
  const { chainId, switchNetwork } = useAppKitNetwork();
  const { walletInfo } = useWalletInfo();
  const { open } = useAppKit();
  const { disconnect } = useDisconnect();
  // AppKit is multi-chain; we only ever ask for the EVM namespace.
  const { walletProvider } = useAppKitProvider<Eip1193Provider>("eip155");
  const targetNetwork = baseSepolia;
  const targetName = "Base Sepolia";

  // `chainId` is `number | string | undefined` — WalletConnect carries CAIP ids
  // as strings, so normalise before comparing to the configured Base chain.
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
      wrongNetwork: isConnected && numericChainId !== null && numericChainId !== targetChainId,
      targetNetworkName: targetName,
    }),
    [address, numericChainId, walletInfo?.name, isConnected, status, targetChainId, targetName],
  );

  return useMemo(
    () => ({
      id: "walletconnect",
      identity,
      connect: () => open({ view: "Connect" }).then(() => undefined),
      disconnect: () => disconnect(),
      openAccount: () => open({ view: "Account" }).then(() => undefined),
      switchToBase: async () => {
        await switchNetwork(targetNetwork);
      },
      getSigner: async () => {
        if (!walletProvider || !identity.address) return null;
        if (identity.wrongNetwork) {
          throw new Error(
            `wallet is on chain ${identity.chainId}, but this server targets ${targetName} (${targetChainId}) — switch network first`,
          );
        }
        // Pinning the network skips a round-trip to `eth_chainId` on every call
        // and is safe because the wrong-network case is already out.
        const provider = new BrowserProvider(walletProvider, targetChainId);
        return provider.getSigner(identity.address);
      },
    }),
    [identity, open, disconnect, switchNetwork, walletProvider, targetNetwork, targetChainId, targetName],
  );
}
