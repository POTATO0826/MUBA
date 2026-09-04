import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import type { WalletSource } from "../data/wallet.ts";
import { WalletPicker } from "../ui/WalletPicker.tsx";
import { fetchWalletConfig } from "./project.ts";
import { useInjectedWallet, useInjectedWallets } from "./injected.ts";
import { mockRequested, useMockWallet } from "./mock.ts";

/**
 * Keep AppKit out of the mock/injected wallet's startup module graph. Reown's
 * universal adapter can fail while Bun evaluates it, before this boundary has
 * a chance to select the mock. The live tier is loaded only when configured.
 */
const LiveWallet = lazy(() => import("./live.tsx"));

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

  /**
   * Read `?as=` once, at boot, and never again.
   *
   * `App` rewrites the address bar to `routePath(...)` on its first navigation,
   * which drops the query string. Re-reading `location.search` on every render
   * would therefore flip the tier from mock to injected/AppKit mid-session and
   * remount the whole app under a different identity. Latching it makes the
   * choice a boot decision, which is what it always meant.
   */
  const [asMock] = useState(() => mockRequested());

  useEffect(() => {
    let live = true;
    fetchWalletConfig().then((c) => {
      if (live) setProjectId(c.projectId);
    });
    return () => {
      live = false;
    };
  }, []);

  // `?as=0x…` asks for the mock by name, and outranks both real tiers. It is
  // how two tabs on one machine get two identities for a local duel.
  if (asMock) return <MockWallet>{children}</MockWallet>;

  if (projectId === null) return null;
  if (projectId !== "") {
    return (
      <Suspense fallback={null}>
        <LiveWallet projectId={projectId}>{children}</LiveWallet>
      </Suspense>
    );
  }
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
