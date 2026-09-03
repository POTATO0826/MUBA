import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { LiveMarket } from "./data/thetanuts.tsx";
import { WalletBoundary } from "./wallet/boundary.tsx";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing from index.html");

/**
 * Two boundaries and the app.
 *
 * `WalletBoundary` picks a wallet tier; `LiveMarket` fetches the Thetanuts book
 * and falls back to the mock if it cannot. Neither is visible to any view — the
 * app just receives a `WalletSource` and a `MarketSource`.
 */
createRoot(host).render(
  <StrictMode>
    <WalletBoundary>
      {(wallet) => (
        <LiveMarket>
          {(market) => <App source={market.source} wallet={wallet} marketError={market.error} />}
        </LiveMarket>
      )}
    </WalletBoundary>
  </StrictMode>,
);
