import { sx } from "../lib/sx.ts";
import { MONO } from "../theme.ts";
import type { MarketSource } from "../data/market.ts";

/**
 * Provenance strip. `source.meta` says plainly whether the numbers are live,
 * seeded, or real-but-old, and `marketError` says why when they are not live.
 *
 * The one design rule here: **no state and no timer.** An age chip that ticks
 * every second would re-render the whole app once a second forever, for a
 * number nobody reads that precisely. The age is computed during render, so it
 * refreshes whenever anything else on the page does — coarse, honest, free.
 */

/** `"12s ago"` / `"4m ago"`, or `null` when the source has no age (the mock). */
function ageLabel(fetchedAt: number, now: number): string | null {
  if (!fetchedAt) return null;
  const seconds = Math.max(0, Math.round((now - fetchedAt) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

const GREEN = "#84cc16";
const AMBER = "#f59e0b";
const DIM = "#52525b";

export function Footer({
  source,
  marketError = null,
}: {
  source: MarketSource;
  /** Amber line. `null` when the book is fine or was never asked for. */
  marketError?: string | null;
}) {
  const { source: kind, fetchedAt } = source.meta;
  const age = ageLabel(fetchedAt, Date.now());
  // Stale rows are real numbers wearing the wrong timestamp, so they get the
  // warning colour and keep their age chip — that chip is the whole disclosure.
  const colour = kind === "live" ? GREEN : kind === "stale" ? AMBER : DIM;

  return (
    <footer
      style={sx(
        "display:flex;align-items:center;gap:16px;padding:20px 28px;border-top:1px solid #1c1c20;" +
          `margin-top:20px;font:400 11px/1 ${MONO};color:${DIM};flex-wrap:wrap`,
      )}
    >
      <span>THETADUEL · prototype</span>
      <span>·</span>
      <span>@thetanuts-finance/thetanuts-client 0.3.0</span>
      <span>·</span>
      <span>Base mainnet 8453</span>
      <div style={sx("flex:1")} />
      {marketError && <span style={sx(`color:${AMBER}`)}>{marketError}</span>}
      <span style={sx(`color:${colour}`)}>
        {kind === "mock"
          ? "mock data — read only"
          : `${source.id}${age ? ` · ${age}` : ""} — read only`}
      </span>
    </footer>
  );
}
