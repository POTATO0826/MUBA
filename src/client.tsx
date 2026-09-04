import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { mockMarketSource } from "./data/market.ts";
import { liveNewsSource } from "./data/news.ts";
import { WalletBoundary } from "./wallet/boundary.tsx";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing from index.html");

createRoot(host).render(
  <StrictMode>
    {/* The boundary picks a wallet tier — AppKit, injected, or the mock — and
        hands the winner down. It renders nothing for the frame its config
        fetch takes; `styles.css` paints `body` `#09090b`, so that frame is the
        page background rather than a white flash. */}
    <WalletBoundary>
      {(wallet) => <App source={mockMarketSource} newsSource={liveNewsSource} wallet={wallet} />}
    </WalletBoundary>
  </StrictMode>,
);
