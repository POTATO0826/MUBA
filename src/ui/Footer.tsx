import { sx } from "../lib/sx.ts";
import { C, FEED_STATE, MONO, feedState, stateAge, stateChip } from "../theme.ts";
import type { MarketSource } from "../data/market.ts";

/**
 * Provenance strip. `source.meta` says plainly whether the numbers are live,
 * seeded, or real-but-old, and `marketError` says why when they are not live.
 *
 * The one design rule here: **no state and no timer.** An age chip that ticks
 * every second would re-render the whole app once a second forever, for a
 * number nobody reads that precisely. The age is computed during render, so it
 * refreshes whenever anything else on the page does — coarse, honest, free.
 *
 * The word and the colour come from `FEED_STATE` (`src/theme.ts`). This strip
 * used to hold three colour literals of its own and to phrase the fixture case
 * as lowercase "mock data" while the news wire two panels up called the same
 * condition `SEEDED` — and its amber meant STALE while the wire's amber meant
 * SEEDED. One vocabulary, so a reader who learns a chip here can read it
 * anywhere.
 */

const DIM = C.faint;

export function Footer({
  source,
  marketError = null,
}: {
  source: MarketSource;
  /** Amber line. `null` when the book is fine or was never asked for. */
  marketError?: string | null;
}) {
  const { source: kind, fetchedAt } = source.meta;
  const age = stateAge(fetchedAt, Date.now());
  // Stale rows are real numbers wearing the wrong timestamp, so they get the
  // warning colour and keep their age chip — that chip is the whole disclosure.
  const state = feedState(kind);
  const spec = FEED_STATE[state];

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
      <span>Base Sepolia testnet 84532</span>
      <div style={sx("flex:1")} />
      {/* Prose, not a chip: the reason the state is what it is. It keeps the
          plain warning amber rather than borrowing STALE's, because a
          switched-off market reports here while the chip beside it correctly
          reads SEEDED, and a colour that meant STALE would then be arguing with
          the chip. */}
      {marketError && <span style={sx(`color:${C.amber}`)}>{marketError}</span>}
      <span
        data-testid="market-state"
        title={spec.means}
        style={sx(stateChip(state))}
      >
        {spec.label}
      </span>
      <span style={sx(`color:${spec.color}`)}>
        {/* Same claim as before the vocabulary landed, in the vocabulary's
            word: a fixture is SEEDED, and "seeded fixtures" is what the chip
            beside it now says out loud. */}
        {state === "seeded"
          ? "seeded fixtures — read only"
          : `${source.id}${age ? ` · ${age}` : ""} — read only`}
      </span>
    </footer>
  );
}
