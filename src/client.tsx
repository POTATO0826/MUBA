import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { mockMarketSource } from "./data/market.ts";

const host = document.getElementById("root");
if (!host) throw new Error("#root missing from index.html");

createRoot(host).render(
  <StrictMode>
    <App source={mockMarketSource} />
  </StrictMode>,
);
