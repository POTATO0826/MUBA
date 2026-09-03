import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { mockMarketSource } from "./data/market.ts";
import { WalletBoundary } from "./wallet/boundary.tsx";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing from index.html");

createRoot(host).render(
  <StrictMode>
    <WalletBoundary>{(wallet) => <App source={mockMarketSource} wallet={wallet} />}</WalletBoundary>
  </StrictMode>,
);
