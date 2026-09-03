import { sx } from "../lib/sx.ts";
import { MONO } from "../theme.ts";
import type { MarketSource } from "../data/market.ts";

/** Provenance strip. `source.id` says plainly whether the numbers are live. */
export function Footer({ source }: { source: MarketSource }) {
  return (
    <footer
      style={sx(
        "display:flex;align-items:center;gap:16px;padding:20px 28px;border-top:1px solid #1c1c20;" +
          `margin-top:20px;font:400 11px/1 ${MONO};color:#52525b`,
      )}
    >
      <span>THETADUEL · prototype</span>
      <span>·</span>
      <span>@thetanuts-finance/thetanuts-client 0.2.5</span>
      <span>·</span>
      <span>Base mainnet 8453</span>
      <div style={sx("flex:1")} />
      <span>{source.id === "mock" ? "mock data — read only" : `${source.id} — read only`}</span>
    </footer>
  );
}
