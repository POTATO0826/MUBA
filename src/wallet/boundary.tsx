import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { AppKitProvider } from "@reown/appkit/react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { WalletSource } from "../data/wallet.ts";
import { WalletPicker } from "../ui/WalletPicker.tsx";
import { useAppKitWallet } from "./appkit.tsx";
import { METADATA, NETWORKS, THEME_VARIABLES, fetchWalletConfig } from "./config.ts";
import { useInjectedWallet, useInjectedWallets } from "./injected.ts";
import { useMockWallet } from "./mock.ts";

/**
 * Decides which wallet the app runs on, and is the only module that knows
 * AppKit exists.
 *
 * Three tiers, best available first:
 *
 * 1. **AppKit** — needs `WALLETCONNECT_PROJECT_ID`. Browser extensions *and*
 *    phone wallets over a QR code.
 * 2. **Injected** — needs nothing. Any extension in the page, via EIP-6963.
 *    This is a real wallet signing real transactions; the only thing it cannot
 *    do is let a phone connect.
 * 3. **Mock** — a fixed fake address, for when no wallet is installed at all,
 *    and for the headless tests where AppKit cannot initialise.
 *
 * The ordering matters and was originally wrong: gating everything behind the
 * project id meant MetaMask — the wallet that needs no setup whatsoever — was
 * unreachable until you had registered for a WalletConnect account. Tier 2
 * exists so a fresh clone connects a real wallet immediately.
 *
 * Boot order:
 *
 *   fetch /api/wallet-config → pick a tier → source → children
 *
 * The gate renders nothing for the one frame the same-origin fetch takes.
 * `styles.css` paints `body` `#09090b`, so that frame is the page background
 * rather than white.
 */
export function WalletBoundary({
  children,
}: {
  children: (wallet: WalletSource) => ReactNode;
}) {
  const [projectId, setProjectId] = useState<string | null>(null);
  const { wallets: injected, settled: injectedSettled } = useInjectedWallets();

  useEffect(() => {
    let live = true;
    fetchWalletConfig().then((c) => {
      if (live) setProjectId(c.projectId);
    });
    return () => {
      live = false;
    };
  }, []);

  if (projectId === null) return null;
  if (projectId !== "") return <LiveWallet projectId={projectId}>{children}</LiveWallet>;
  // Waiting on discovery avoids a flash of the mock tier — and a pointless
  // remount — while the extensions announce themselves.
  if (!injectedSettled) return null;
  if (injected.length > 0) return <InjectedWallet>{children}</InjectedWallet>;
  return <MockWallet>{children}</MockWallet>;
}

/** Tier 2: extensions only, zero configuration. */
function InjectedWallet({ children }: { children: (w: WalletSource) => ReactNode }) {
  const wallet = useInjectedWallet();
  return (
    <>
      {children(wallet)}
      {wallet.choosing && (
        <WalletPicker
          wallets={wallet.available}
          error={wallet.error}
          onChoose={(rdns) => void wallet.chooseWallet(rdns)}
          onCancel={wallet.cancelChoice}
        />
      )}
    </>
  );
}

/** Tier 3: no wallet installed anywhere. */
function MockWallet({ children }: { children: (w: WalletSource) => ReactNode }) {
  const wallet = useMockWallet();
  return <>{children(wallet)}</>;
}

/** Tier 1: AppKit, which brings its own modal and the QR flow. */
function LiveWallet({
  projectId,
  children,
}: {
  projectId: string;
  children: (w: WalletSource) => ReactNode;
}) {
  // `AppKitProvider` memoises the client on first render, so the adapter is
  // built once whatever React does with this subtree.
  const adapters = useMemo(() => [new EthersAdapter()], []);

  return (
    <AppKitProvider
      adapters={adapters}
      networks={[...NETWORKS]}
      projectId={projectId}
      metadata={METADATA}
      themeMode="dark"
      themeVariables={THEME_VARIABLES}
      features={{
        analytics: false,
        // Email and social logins mint their own embedded wallets. A duel
        // settles between two addresses the players control, so the only
        // connector that makes sense here is a real wallet.
        email: false,
        socials: false,
        swaps: false,
        onramp: false,
      }}
    >
      <ConnectedWallet>{children}</ConnectedWallet>
    </AppKitProvider>
  );
}

/** Sits inside the provider, which is the only place the AppKit hooks work. */
function ConnectedWallet({ children }: { children: (w: WalletSource) => ReactNode }) {
  const wallet = useAppKitWallet();
  return <>{children(wallet)}</>;
}
