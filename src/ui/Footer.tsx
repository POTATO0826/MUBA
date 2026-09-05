import { sx } from "../lib/sx.ts";
import { C, FEED_STATE, MONO, feedState, meansOf, stateAge, stateChip } from "../theme.ts";
import type { MarketSource } from "../data/market.ts";
import { DATA_CHAIN_ID, DATA_CHAIN_NAME, SIGNING_CHAIN_ID, SIGNING_CHAIN_NAME } from "../data/wallet.ts";

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
  /**
   * Amber line. `null` when the book is fine or was never asked for.
   *
   * It is not only a failure. `LiveMarketState.error` also carries an
   * *advisory* on a perfectly live book — today, that the server had to resolve
   * the book's host around this network's DNS filter — so a green LIVE chip
   * beside an amber sentence is a legal and meaningful pairing, not a
   * contradiction. That is why this strip renders the two independently and
   * `meansOf` is told about the error rather than inferring the state from it.
   */
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
      <span>
        {DATA_CHAIN_NAME} {DATA_CHAIN_ID} · prices, read-only
      </span>
      <span>·</span>
      <span>
        {SIGNING_CHAIN_NAME} {SIGNING_CHAIN_ID} · signing
      </span>
      <div style={sx("flex:1")} />
      {/* Prose, not a chip: the reason the state is what it is. It keeps the
          plain warning amber rather than borrowing STALE's, because a
          switched-off market reports here while the chip beside it correctly
          reads SEEDED, and a colour that meant STALE would then be arguing with
          the chip. */}
      {marketError && <span style={sx(`color:${C.amber}`)}>{marketError}</span>}
      {/* The chip's `title` is the only place the claim is written out, so it
          has to be the claim that is actually true. This footer is the one
          surface holding both halves — the state AND the reason it is that
          state — so it is the one that can tell "no network was needed" from
          "the network failed and we fell back", and `meansOf` is where that
          choice is made. Before this, a book that was fetched and refused wore
          a tooltip reading "no network, nothing failed" directly beside the
          amber sentence saying what had failed. */}
      <span
        data-testid="market-state"
        title={meansOf(state, marketError !== null)}
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
