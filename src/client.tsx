import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { liveNewsSource } from "./data/news.ts";
import { LiveMarket } from "./data/thetanuts.tsx";
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
      {(wallet) => (
        // Inside the wallet boundary, not outside: the wallet decides whether
        // the page renders at all, the book only decides what the numbers say.
        // A market read that never answers must not hold up the connect button.
        <LiveMarket>
          {(market) => (
            <App
              source={market.source}
              newsSource={liveNewsSource}
              wallet={wallet}
              marketError={market.error}
            />
          )}
        </LiveMarket>
      )}
    </WalletBoundary>
  </StrictMode>,
);
