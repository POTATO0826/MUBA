import type { MarketSource } from "../data/market.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO } from "../theme.ts";

/** Provenance strip. `source.id` says plainly whether the numbers are live. */
export function Footer({
  source,
  marketError = null,
}: {
  source: MarketSource;
  marketError?: string | null;
}) {
  const live = source.id !== "mock";
  return (
    <footer
      style={sx(
        "display:flex;align-items:center;gap:16px;padding:20px 28px;border-top:1px solid #1c1c20;" +
          `margin-top:20px;font:400 11px/1 ${MONO};color:#52525b`,
      )}
    >
      <span>THETHADUEL · prototype</span>
      <span>·</span>
      <span>@thetanuts-finance/thetanuts-client 0.3.0</span>
      <span>·</span>
      <span>Base mainnet 8453</span>
      <div style={sx("flex:1")} />
      {marketError && (
        <span style={sx(`color:${C.amber}`)} title={marketError}>
          live book unavailable — showing fixtures
        </span>
      )}
      <span style={sx(live ? `color:${C.green}` : "")}>
        {live ? `${source.id} — live, read only` : "mock data — read only"}
      </span>
    </footer>
  );
}
