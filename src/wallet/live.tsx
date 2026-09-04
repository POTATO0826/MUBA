import { EthersAdapter } from "@reown/appkit-adapter-ethers";
import { AppKitProvider } from "@reown/appkit/react";
import { useMemo, type ReactNode } from "react";
import type { WalletSource } from "../data/wallet.ts";
import { useAppKitWallet } from "./appkit.tsx";
import { METADATA, NETWORKS, THEME_VARIABLES } from "./config.ts";

/**
 * The complete AppKit tier lives in this lazy module. Do not import it from the
 * mock/injected startup path: some Bun/Reown combinations cannot evaluate the
 * universal adapter in that path even though AppKit will never be rendered.
 */
export default function LiveWallet({
  projectId,
  children,
}: {
  projectId: string;
  children: (wallet: WalletSource) => ReactNode;
}) {
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

function ConnectedWallet({ children }: { children: (wallet: WalletSource) => ReactNode }) {
  const wallet = useAppKitWallet();
  return <>{children(wallet)}</>;
}
