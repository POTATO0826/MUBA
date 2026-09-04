import { useEffect, useMemo, useRef } from "react";
import { ParlayCardFace, type FaceValues } from "../components/ParlayCardFace.tsx";
import { PlayerMark } from "../components/PlayerMark.tsx";
import { YOU_INITIALS, YOU_NAME } from "../data/leaderboard.ts";
import type { MarketSource } from "../data/market.ts";
import { modeTag, type ModeSpec } from "../data/modes.ts";
import { PLAYER } from "../data/rewards.ts";
import {
  LIVE_COLOR,
  SPOT_CHIP,
  bookDeltaNote,
  liveTag,
  seededTag,
  spotChipSx,
  spotFor,
} from "../data/spot.ts";
import { meta } from "../data/universe.ts";
import { OPTIONS_CHIP, SETTLEMENT_NOTE, type OptionBook } from "../desk/optionize.ts";
import {
  PARLAY_CARDS,
  REFERENCE_MOVE,
  cardsForTicker,
  conditionText,
  legForCard,
  slipLabel,
  slotFor,
  vanillaPayout,
  type LiveCard,
  type ParlayCard,
  type ParlayLeg,
  type ParlaySummary,
  type Stance,
  type Tier,
} from "../engine/parlay.ts";
import { rankAt } from "../engine/rank.ts";
import { fmtPx } from "../engine/tape.ts";
import { sfx, startTrack, stopTrack } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { useCardDetail } from "../state/detail.ts";
import { C, FEED_STATE, MONO, SANS, sectorColor, stateChip, tag } from "../theme.ts";
import { DetailToggle } from "../ui/DetailToggle.tsx";
import type { Player, PricingRow } from "../types.ts";

/**
 * The four tiers ride four pitches: SAFE 880 · EVEN 988 · SHARP 1174 ·
 * DEGEN 1396 Hz. `parlay.card.hover` and `parlay.card.pick` are both written
 * around 880 (map.ts), so what they take is the ratio — and DEGEN's 1396 is
 * the threshold that earns it the detuned, unstable minor third.
 */
const TIER_PITCH: Record<Tier, number> = {
  SAFE: 1,
  EVEN: 988 / 880,
  SHARP: 1174 / 880,
  DEGEN: 1396 / 880,
};

/** Tier accents. DEGEN borrows the HIGH VAR violet. */
export const TIER_COLOR: Record<Tier, string> = {
  SAFE: C.green,
  EVEN: C.accent,
  SHARP: C.amber,
  DEGEN: C.violet,
};

/**
 * The payout math the engine is handed, re-exported from where it now lives.
 *
 * It used to be declared here, because this screen was the only caller. It is
 * not any more: `src/state/match.ts` prices a match's legs off the same frozen
 * book with the same calculator, and two restatements of one arithmetic is
 * precisely the drift that left the pick screen printing one ×N and every other
 * surface printing another. So it moved to `src/engine/parlay.ts` beside the
 * functions that take it — see the docblock there for what it is, why it is not
 * the SDK's own function yet, and why every engine entry point still takes a
 * `PayoutCalculator` as an argument rather than reaching for this.
 *
 * Re-exported so callers and tests that already name it here keep working.
 */
export { vanillaPayout };

/**
 * `"58.2%"` → `0.582`; anything else → `null`.
 *
 * The `%` is required. `PricingRow.iv` is a display string in percent from every
 * producer in the tree, and a bare `"0.58"` could not be told from `"58"` — one
 * of those renders `IV 0%` beside a real strike and the other `IV 5800%`. A dash
 * is honest about not knowing; a mis-scaled number is not. Same rule, and the
 * same reasoning, as `parseIv` in `src/desk/optionize.ts`, which is module-local
 * there and so cannot be shared without exporting a decoder from a module this
 * screen no longer prices anything off.
 */
function ivOf(row: PricingRow): number | null {
  const t = String(row.iv ?? "").trim();
  if (!t.endsWith("%")) return null;
  const n = Number(t.slice(0, -1).replace(/,/g, "").replace("−", "-"));
  return Number.isFinite(n) && n > 0 ? +(n / 100).toFixed(6) : null;
}

/** `2600` → `"2,600"`, `1.45` → `"1.45"`. The label's own formatting: `fmtPx`
 *  rounds hard above 1,000 because it was written for a scrolling tape. */
function fmtStrike(v: number): string {
  if (v < 1) return v.toFixed(4);
  if (v < 1000) return v.toFixed(2);
  return Math.round(v).toLocaleString("en-US");
}

/** `"ETH 2,600 CALL · Δ0.28 · exp 12 SEP · payout at ±25%"` — the provenance
 *  line, and the stated convention printed where the number it produced is.
 *  `REFERENCE_MOVE` is a convention, not something the market said, so it is on
 *  the card as well as in the engine's docblock. */
function provenanceOf(card: LiveCard): string {
  const side = card.stance === "bull" ? "CALL" : "PUT";
  return (
    `${card.underlying} ${fmtStrike(card.strikeAt)} ${side} · Δ${card.prob.toFixed(2)} · ` +
    `exp ${card.expiry} · payout at ±${Math.round(REFERENCE_MOVE * 100)}%`
  );
}

interface ParlayPickProps {
  lobbyName: string;
  /**
   * The live book. Two strictly additive uses, and no third:
   *
   *  1. a spot annotation beside each ticker's seeded reference price;
   *  2. the book's delta beside a tier's implied probability, as advice.
   *
   * Nothing here reaches `myLegs`, `summary` or the odds. The slip is
   * built from the seed and settles on the seeded tape; if that ever stopped
   * being true, `/match/:id/parlay?seed=N` would stop replaying and the
   * determinism locks would say so.
   */
  source: MarketSource;
  /**
   * The book this match was dealt against, frozen — or `undefined`, which is
   * the default and is today's screen exactly.
   *
   * The one prop on this component that is **not** additive. Where a ticker has
   * a chain, its cards are dealt out of it by `cardsForSlice`: the strike is one
   * the venue lists, the chance is that option's own delta, the max loss is the
   * ask a buyer pays, and the multiple is the protocol's payout arithmetic over
   * that ask (`multipleAt`). Where a ticker has no chain (fourteen of eighteen
   * board names, always) the card is the seeded card it has always been, and
   * says so.
   *
   * **Its cards, and not always eight of them.** A tier crossed with a stance is
   * dealt only when a resting order backs it inside that tier's `|delta|` band;
   * where none does, the slot renders dead, in place. A card that always exists
   * is the tell that the odds are house-set (plan 6 §A4 step 6).
   *
   * The rows are read from HERE and never from `p.source`, deliberately. This
   * object is frozen at deal time and `p.myLegs` were priced off it upstream, so
   * the card and the leg cannot disagree; re-reading the polling source would
   * re-deal a player's cards under them every thirty seconds and let a slot they
   * had already picked vanish.
   *
   * Nothing here reads a market source, and this object cannot fetch: it is a
   * value `App` already read and `useMatch` already froze.
   */
  book?: OptionBook;
  /** This match's window. Its `oddsBoost` is already inside `summary.mult`;
   *  the slip only has to say where the premium came from. */
  mode: ModeSpec;
  opponent: Player;
  arena: readonly string[];
  /** Your pick per ticker so far. */
  picks: Readonly<Record<string, ParlayCard>>;
  allPicked: boolean;
  /** Whole seconds left on the pick clock; `null` on an untimed mode, and the
   *  chip, the beeps and the EVEN note all disappear with it. */
  secondsLeft: number | null;
  /** Your slip: real legs where picked, an EVEN-bullish preview where not. */
  myLegs: readonly ParlayLeg[];
  summary: ParlaySummary;
  stakePoints: number;
  prizeLabel: string;
  /**
   * Season XP now — `ledger.xp`, unmodified (`state/ledger.ts` already folds
   * `PLAYER.xp` in as the opening balance, so a caller must not add it twice).
   *
   * It sets the card face's **opening default** and nothing else: `rankAt(xp)`
   * gives the tier, `defaultDetail` gives the level, and the first press of the
   * toggle outranks both forever (§E2). It is never a gate — there is no level
   * this screen can refuse, at any XP.
   *
   * Defaults to `PLAYER.xp`, which is exactly what `useLedger` opens a season
   * at, so an un-wired caller sees the tier the ledger itself would give it
   * before the first settlement rather than an invented one.
   */
  xp?: number;
  onPick: (sym: string, cardId: string) => void;
  onLock: () => void;
}

/**
 * One block per dealt ticker, eight cards in each: four tiers, bullish and
 * bearish. Pick one per ticker; the parlay is the combination. The odds on
 * the slip are the product of the legs — every leg has to land.
 */
/** The last five seconds are the loud ones. */
const HOT = 5;

/**
 * The pick phase's bed — the hero-select music.
 *
 * Served by `index.ts` from `src/assets/` when the operator has dropped a file
 * there, and 404'd cleanly when they have not, exactly like the room's
 * `room-inspect.mp3`. The whole directory is gitignored on purpose (the audio
 * is game-ripped and licensed to someone else), so a fresh clone plays this
 * screen in silence and nothing about that is an error path — see
 * `docs/HANDOFF.md`, "Local-only artifacts".
 */
const PICK_TRACK = "/assets/parlay-pick.mp3";

/** `0:18` — a clock reads as a clock, and the monospace stops it juddering. */
const clockText = (n: number) => `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;

export function ParlayPick(p: ParlayPickProps) {
  const left = p.arena.filter((s) => !p.picks[s]).length;
  const s = p.summary;
  const counting = p.secondsLeft !== null;
  const hot = p.secondsLeft !== null && p.secondsLeft <= HOT;

  /**
   * How much of each card face is shown (§E2).
   *
   * The tier picks the opening default; the toggle in the header pins a choice
   * that outranks it in either direction from then on. Nothing below reads
   * `detail.level` to decide *whether* a player may see something — only
   * `quantitiesAt` inside `ParlayCardFace` reads it at all, and it answers with
   * an ordered list of quantities rather than a permission.
   */
  const detail = useCardDetail(rankAt(p.xp ?? PLAYER.xp).tier);

  /**
   * Live spot for the dealt tickers, `null` for most of them. Three to five
   * names on screen and a fresh `source` object on every 30s poll, so this is
   * cheap either way — it is memoised because the card grid below re-renders on
   * every pick and the answer cannot have changed.
   */
  const spots = useMemo(() => {
    const m = new Map<string, number>();
    for (const sym of p.arena) {
      const px = spotFor(sym, p.source);
      if (px !== null) m.set(sym, px);
    }
    return m;
  }, [p.arena, p.source]);
  /** No annotations, no chip — and then this screen is byte-identical to the
   *  one that shipped before live data existed. */
  const anyLive = spots.size > 0;

  /**
   * The cards the frozen book actually deals, per ticker — index-aligned to
   * `PARLAY_CARDS`, `null` where the book backs no order in that tier's band.
   *
   * This is the pick screen's whole live path, and it is one call:
   * `cardsForTicker(sym, rows, spot, vanillaPayout)` — the identity window off
   * `fullLadderSlice`, then `cardsForSlice` over it. Every number on a card
   * built here is the venue's or is derived from it by the protocol's own payout
   * arithmetic — there is no clamp, no table and no invented reference in the
   * chain any more.
   *
   * It is the **same call** `src/state/match.ts` makes on the **same frozen
   * book** to price `p.myLegs`, which is what makes the card and the leg two
   * reads of one computation rather than two computations that have to agree.
   *
   * **A ticker enters the map only when its book deals at least one card.** The
   * degenerate cases — no book, a chain with no fillable orders, a chain whose
   * every delta falls outside all four bands — all leave it out, and a ticker
   * that is out renders exactly the eight seeded cards it rendered before any of
   * this existed. That is deliberate and it is the narrower claim: eight dead
   * slots would say nothing the SEEDED chip does not already say, and would
   * delete a playable ticker from a duel that still has to settle. A dead slot
   * carries information precisely when it sits beside a live sibling — *this*
   * tier is missing and that one is not — which is the case this keeps.
   *
   * Memoised on the frozen book, so it is computed once per match rather than
   * once per pick: `p.book` is captured at deal time and does not move.
   */
  const liveCards = useMemo(() => {
    const out = new Map<string, readonly (LiveCard | null)[]>();
    if (!p.book) return out;
    for (const sym of p.arena) {
      const dealt = cardsForTicker(
        sym,
        p.book.chain[sym] ?? [],
        p.book.spot[sym] ?? 0,
        vanillaPayout,
      );
      if (dealt) out.set(sym, dealt);
    }
    return out;
  }, [p.arena, p.book]);

  /**
   * The pick music, on exactly the room's terms.
   *
   * The UNMOUNT is the general case and it covers every exit there is: the
   * clock running out, the lock button, a rematch, the back arrow, a reload.
   * The pick screen is only ever mounted by `App` for the pick phase, so
   * leaving the phase unmounts it and the cleanup fades the bed out — there is
   * no exit path that needs its own call.
   *
   * `stopTrack("room")` on the way IN is the belt to that braces. The room's
   * own cleanup already stops its bed when `App` swaps the view, and React runs
   * that cleanup before this effect; the explicit stop makes "the pick bed and
   * the room bed never sound together" a property of this file rather than a
   * property of two files and an ordering guarantee between them. Stopping a
   * track that is not playing is a no-op.
   *
   * Levels, fades and the reduced-motion opt-out are all the engine's
   * (`TRACK_GAIN` 0.22 on the ambience bus, 800ms in, 600ms out) — the same
   * numbers the room gets, because it is the same call.
   */
  useEffect(() => {
    stopTrack("room");
    startTrack("parlay", PICK_TRACK);
    return () => {
      stopTrack("parlay");
    };
  }, []);

  // One beep per distinct second of the last five. The clock re-renders far
  // more often than once a second, so the ref — not the render — is what makes
  // it fire exactly once; `countdown.final` marks the last one.
  const beeped = useRef<number | null>(null);
  useEffect(() => {
    const n = p.secondsLeft;
    if (n === null || n > HOT || n < 1) {
      if (n === null) beeped.current = null;
      return;
    }
    if (beeped.current === n) return;
    beeped.current = n;
    // `leg` is how the recipe receives the seconds remaining (map.ts).
    sfx(n === 1 ? "countdown.final" : "countdown.beep", { leg: n });
  }, [p.secondsLeft]);

  return (
    <div style={sx("padding:24px 28px;max-width:1720px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px;flex-wrap:wrap")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Build your parlay · {p.lobbyName}</h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.accent};` +
              "border:1px solid rgba(200,255,0,.3);background:rgba(200,255,0,.08);border-radius:6px;padding:6px 8px",
          )}
        >
          BLIND · OPPONENT SLIP HIDDEN
        </span>
        <span style={sx(modeTag(p.mode.key))}>
          {p.mode.label} · {p.mode.duration}
        </span>
        {/* The board legend for this surface. Only when something below is
            actually annotated. */}
        {anyLive && (
          <span data-testid="spot-chip" style={sx(spotChipSx)}>
            {SPOT_CHIP}
          </span>
        )}
        {/* The claim the market-priced cards below are making, said once at the
            top of the screen. Rendered only when there is a book — a slip with
            no market card on it must not wear a badge about market cards. */}
        {p.book && (
          <span data-testid="options-chip" style={sx(spotChipSx)}>
            {OPTIONS_CHIP}
          </span>
        )}
        {p.secondsLeft !== null && (
          <span
            data-testid="pick-clock"
            style={sx(
              `font:700 13px/1 ${MONO};letter-spacing:.08em;border-radius:6px;padding:6px 9px;` +
                (hot
                  ? `color:${C.red};border:1px solid ${C.red}66;background:${C.red}1a;` +
                    "animation:vcPulse 1.6s ease-in-out infinite"
                  : `color:${C.text};border:1px solid ${C.borderMid};background:${C.raised}`),
            )}
          >
            {clockText(p.secondsLeft)}
          </span>
        )}
        <div style={sx("flex:1")} />
        {/* On the surface, beside the cards it governs — not three menus deep.
            A player who never touches it still gets their tier's default; a
            reviewer who wants the greeks is one press away, at any rank. */}
        <DetailToggle level={detail.level} onChange={detail.setLevel} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>POOL</span>
        <span style={sx(`font:700 18px/1 ${MONO};color:${C.accent}`)}>{p.prizeLabel}</span>
      </div>

      <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) 340px;gap:20px;align-items:start")}>
        <div style={sx("display:flex;flex-direction:column;gap:16px")}>
          {p.arena.map((sym) => {
            const u = meta(sym);
            const picked = p.picks[sym] ?? null;
            const color = sectorColor(u.sector);
            const liveSpot = spots.get(sym) ?? null;
            /**
             * This ticker's eight slots off the frozen book, or `null` for a
             * ticker the book deals nothing on — which is the ordinary case and
             * is the seeded ticker, unchanged.
             */
            const dealt = liveCards.get(sym) ?? null;
            /**
             * Whether this ticker's cards are priced off the book.
             *
             * `undefined` — no book at all — is not the same as "this ticker has
             * no book". The first draws today's screen with no chips anywhere;
             * the second draws a LIVE/SEEDED chip on every ticker header, so a
             * player reading a mixed slip can see at a glance which lines the
             * market wrote and which the game did.
             *
             * Read off `dealt` and not off `hasBook`: the chip has to say what
             * the eight cards under it actually are. A chain that exists but
             * backs no fillable order deals seeded cards, and a LIVE chip over
             * them would be the chip lying about the grid it labels.
             */
            const priced = dealt !== null;
            const pickedCard = picked ? slotFor(dealt, picked.tier, picked.stance) : null;
            return (
              <section
                key={sym}
                data-leg-picker={sym}
                style={sx(`border:1px solid ${picked ? `${TIER_COLOR[picked.tier]}66` : C.border};border-radius:12px;background:${C.panel};overflow:hidden`)}
              >
                <div style={sx(`display:flex;align-items:center;gap:12px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
                  <span style={sx(`font:700 16px/1 ${MONO}`)}>{sym}</span>
                  <span style={sx(tag(color))}>{u.sector}</span>
                  {/* The state-chip vocabulary (`FEED_STATE`, `stateChip`),
                      applied to the one question this screen now has to answer
                      per ticker: did the venue write these eight cards, or did
                      the game? SEEDED is grey rather than amber on purpose —
                      a ticker with no options book is the app's ordinary
                      resting state, not a fault. */}
                  {p.book && (
                    <span
                      data-testid={`book-state-${sym}`}
                      title={FEED_STATE[priced ? "live" : "seeded"].means}
                      style={sx(stateChip(priced ? "live" : "seeded"))}
                    >
                      {FEED_STATE[priced ? "live" : "seeded"].label}
                    </span>
                  )}
                  {/* C4 site: the ticker's reference price.
                      With no live print this is the line it has always been.
                      With one, the seeded number stays exactly where it was and
                      gains the word that was always implied — the live print
                      joins it, named, in the live colour. The legs below are
                      struck off `u.px` either way. */}
                  {liveSpot === null ? (
                    <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>${fmtPx(u.px)} · base ±{u.t.toFixed(1)}%</span>
                  ) : (
                    <span data-testid={`spot-${sym}`} style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>
                      {/* `LIVE_COLOR` is the vocabulary's LIVE tint, not a
                          hand-picked green — the same constant the header chip
                          and the footer's provenance line use. */}
                      {seededTag(u.px)} · <span style={sx(`color:${LIVE_COLOR}`)}>{liveTag(liveSpot)}</span> · base ±
                      {u.t.toFixed(1)}%
                    </span>
                  )}
                  <div style={sx("flex:1")} />
                  <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.1em;color:${picked ? TIER_COLOR[picked.tier] : C.faint}`)}>
                    {/* The `×` here sits directly above a grid that may be
                        live while the ticker below it is seeded, so it is
                        `oddsOf(prob)` on both paths and nothing else — the
                        dealt card's own delta where there is one, the tier's
                        band midpoint where there is not. Printing the card's
                        `payoutMult` here is what made ETH read `×430.75` over
                        AVAX's `×6.67`. */}
                    {picked
                      ? `${picked.label} · ×${
                          pickedCard
                            ? pickedCard.odds.toFixed(2)
                            : legForCard(sym, picked).mult.toFixed(2)
                        }`
                      : "pick one"}
                  </span>
                </div>

                <div style={sx("display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px;padding:12px 16px")}>
                  {PARLAY_CARDS.map((card, i) => {
                    const leg = legForCard(sym, card);
                    const tc = TIER_COLOR[card.tier];
                    const on = picked?.id === card.id;
                    /**
                     * This card, dealt off the frozen book — or `null`.
                     *
                     * Two different `null`s, and the grid renders them
                     * differently. `dealt === null` is "this ticker is seeded",
                     * and every card below is the seeded card it has always
                     * been. `dealt[i] === null` on a ticker that IS dealt is
                     * step 6 of `cardsForSlice`: no resting order backs this
                     * tier on this side, so the card is **not dealt** and the
                     * slot renders dead, in the position it would have
                     * occupied.
                     */
                    const live = dealt ? (dealt[i] ?? null) : null;
                    if (dealt && live === null) {
                      return <DeadSlot key={card.id} sym={sym} card={card} />;
                    }
                    /**
                     * The `book Δ` second opinion — the book's own read on the
                     * line this seeded card would build, as advice.
                     *
                     * The ratio is `strike / px`, both taken off the leg the
                     * card would build, which is the leg the duel would settle.
                     * The card's own chance above it is untouched — the advisory
                     * cannot move the odds, because it never sees them.
                     *
                     * Suppressed on a dealt card. It exists to put the book's
                     * view *beside* an invented probability; where the
                     * probability already IS the book's delta, printing it twice
                     * would read as two sources agreeing when it is one source
                     * quoted once.
                     */
                    const advisory = live
                      ? null
                      : bookDeltaNote(sym, card.stance, leg.strike / leg.px, p.source);
                    return (
                      <button
                        key={card.id}
                        data-parlay={`${sym}:${card.id}`}
                        aria-pressed={on}
                        onPointerEnter={() => sfx("parlay.card.hover", { pitch: TIER_PITCH[card.tier] })}
                        onClick={() => {
                          sfx("parlay.card.pick", { pitch: TIER_PITCH[card.tier] });
                          p.onPick(sym, card.id);
                        }}
                        style={sx(
                          `text-align:left;position:relative;padding:12px;border-radius:10px;cursor:pointer;` +
                            `background:linear-gradient(160deg,${tc}${on ? "2e" : "0f"},${C.card} 60%);` +
                            `border:1px solid ${on ? tc : `${tc}3d`};` +
                            (on ? `box-shadow:0 0 0 2px ${tc}33` : ""),
                        )}
                      >
                        {/* The face, and the ONLY thing that decides what is on
                            it is `quantitiesAt(detail.level)` inside
                            `ParlayCardFace` — no branch here, and none there
                            either. §A7 rides on that: `maxLoss` is above
                            `payout` in `CARD_FACE_ORDER`, so it is above it on
                            screen at SIMPLE, STANDARD and FULL alike, in type
                            no smaller than the upside figure.

                            Every number is the same number the leg carries. On
                            a market-priced card the strike is one the venue
                            lists, the chance is that option's own delta, the
                            premium is what a buyer pays — which is exactly the
                            max loss — and the payout is that premium under the
                            protocol's own payout arithmetic. On a seeded card
                            there is no premium at all, and the face prints a
                            dash rather than inventing one: a made-up dollar
                            figure beside a real one is worse than an absence. */}
                        <ParlayCardFace
                          level={detail.level}
                          values={faceValues(card.stance, leg, live, p.book?.spot[sym] ?? 0)}
                          accent={tc}
                          lead={<span style={sx(tag(tc))}>{card.tier}</span>}
                          testKey={`${sym}:${card.id}`}
                        />
                        {live && (
                          <div
                            data-testid={`option-${sym}:${card.id}`}
                            style={sx(`margin-top:4px;font:400 9.5px/1.4 ${MONO};color:${LIVE_COLOR}`)}
                          >
                            {provenanceOf(live)}
                          </div>
                        )}
                        {advisory && (
                          <div
                            data-testid={`book-delta-${sym}:${card.id}`}
                            style={sx(`margin-top:4px;font:400 9.5px/1.4 ${MONO};color:${C.green}`)}
                          >
                            {advisory}
                          </div>
                        )}
                        {on && (
                          <div
                            style={sx(
                              `position:absolute;top:8px;right:8px;width:16px;height:16px;border-radius:99px;` +
                                `background:${tc};color:${C.bg};display:grid;place-items:center;font:700 10px/1 ${MONO}`,
                            )}
                          >
                            ✓
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <div style={sx(`padding:12px 16px;border:1px solid ${C.border};border-radius:12px;background:${C.card};font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
            One pick per ticker. Every leg must land for the parlay to pay. Against {p.opponent.name} the duel
            goes to whoever lands more legs; a tie goes to conviction. Higher tiers pay more — and hand the
            tie to the steadier slip.
            {/* The sentence a player must see before they pick, in the box they
                are already reading to learn the rules. It is not a footnote and
                it is not a tooltip: everything above it is real market data, the
                settlement below is not, and the difference is the one thing a
                demo must never leave to be inferred. */}
            {p.book && (
              <span data-testid="options-note" style={sx(`display:block;margin-top:9px;color:${C.textSoft}`)}>
                {SETTLEMENT_NOTE}
              </span>
            )}
          </div>
        </div>

        <div style={sx("display:flex;flex-direction:column;gap:16px;position:sticky;top:76px")}>
          <div style={sx(`border:1px solid ${s.loud && p.allPicked ? C.violet : C.border};border-radius:12px;background:${C.panel};overflow:hidden`)}>
            <div style={sx(`display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
              <PlayerMark name={YOU_NAME} initials={YOU_INITIALS} bg={C.indigo} size={26} />
              <span style={sx(`font:700 13px/1 ${SANS}`)}>Your slip</span>
              <div style={sx("flex:1")} />
              <span style={sx(`font:500 10px/1 ${MONO};color:${p.allPicked ? C.text : C.dim}`)}>
                {p.allPicked ? slipLabel(p.myLegs) : `${left} to pick`}
              </span>
            </div>

            <div style={sx("display:flex;flex-direction:column;gap:8px;padding:12px")}>
              {p.myLegs.map((l) => {
                const has = Boolean(p.picks[l.sym]);
                /**
                 * The multiple the slip prints for this leg is **the leg's
                 * own**, with no second opinion.
                 *
                 * This row used to re-read the dealt card and print that
                 * instead, because `src/state/match.ts` priced `l.mult` off
                 * `desk/optionize.multiplierFor` — the clamped ratio plan 6
                 * retired — and the card was the only number on screen that
                 * could be defended. That override is gone: the match now
                 * derives every leg from the card the book dealt
                 * (`legFromLiveCard`), so reading it twice could only ever hide
                 * a disagreement rather than prevent one.
                 *
                 * `l.mult` is `oddsOf(l.prob)` on **both** paths — the option's
                 * own delta on a market-priced leg, the tier's band midpoint on
                 * a seeded one. That is what makes this column addable: the
                 * three legs printed here multiply to the ODDS figure directly
                 * below them (`degeneracyScore` × the mode's boost), which was
                 * false while a live leg carried `multipleAt`. The money the
                 * dealt option pays is on the card face, in dollars.
                 */
                return (
                  <div
                    key={l.sym}
                    data-leg={l.sym}
                    style={sx(`padding:10px 11px;border-radius:9px;background:${C.raised};border:1px solid ${has ? `${TIER_COLOR[l.tier]}55` : C.border}`)}
                  >
                    <div style={sx("display:flex;align-items:center;justify-content:space-between")}>
                      <span style={sx(`font:700 12px/1 ${MONO}`)}>{l.sym}</span>
                      <span style={sx(`font:700 11px/1 ${MONO};color:${has ? TIER_COLOR[l.tier] : C.faint}`)}>
                        {has ? `${l.tier} ×${l.mult.toFixed(1)}` : "—"}
                      </span>
                    </div>
                    <div style={sx(`margin-top:7px;font:400 10px/1.4 ${MONO};color:${has ? C.textSoft : C.faint}`)}>
                      {has ? conditionText(l) : "no pick yet"}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={sx(`display:grid;grid-template-columns:1fr 1fr 1fr;border-top:1px solid ${C.border}`)}>
              <Stat label="ODDS" value={p.allPicked ? `×${s.mult.toFixed(2)}` : "—"} color={s.loud ? C.violet : C.accent} testid="combined-mult" />
              <Stat label="ALL LAND" value={p.allPicked ? `${(s.prob * 100).toFixed(s.prob < 0.1 ? 1 : 0)}%` : "—"} color={s.loud ? C.violet : C.text} testid="implied-prob" />
              <Stat label="IF IT PAYS" value={p.allPicked ? s.potentialPoints.toLocaleString("en-US") : "—"} testid="potential-points" />
            </div>

            {/* The shorter the window, the more the house pays for it. NORMAL
                is the base edition — no boost, no line. */}
            {p.mode.oddsBoost > 1 && (
              <div
                data-testid="odds-boost"
                style={sx(`display:flex;align-items:center;gap:9px;padding:10px 14px;border-top:1px solid ${C.line}`)}
              >
                <span style={sx(modeTag(p.mode.key))}>
                  {p.mode.label} +{Math.round((p.mode.oddsBoost - 1) * 100)}%
                </span>
                <span style={sx(`font:400 10px/1.4 ${MONO};color:${C.dim}`)}>window premium, already in the odds</span>
              </div>
            )}

            <div style={sx("padding:12px")}>
              <button
                onClick={() => {
                  // Eagerly, on the room's pattern: the 600ms fade is already
                  // running under the lock sound rather than starting when the
                  // duel takes the screen. The unmount cleanup is what actually
                  // guarantees it; this only decides when the fade begins.
                  stopTrack("parlay");
                  sfx("parlay.lock");
                  p.onLock();
                }}
                disabled={!p.allPicked}
                style={sx(
                  `width:100%;height:38px;border:none;border-radius:8px;font:700 12.5px/1 ${SANS};` +
                    (p.allPicked
                      ? `background:${C.accent};color:${C.bg};cursor:pointer`
                      : `background:${C.border};color:${C.dim};cursor:not-allowed`),
                )}
              >
                {p.allPicked ? "Lock parlay → duel" : `Pick ${left} more`}
              </button>
              {counting && (
                <div
                  data-testid="pick-clock-note"
                  style={sx(`margin-top:8px;text-align:center;font:400 10px/1.4 ${MONO};color:${hot ? C.red : C.dim}`)}
                >
                  unpicked legs lock at EVEN ↑
                </div>
              )}
            </div>
          </div>

          <div
            style={sx(
              "border:1px solid rgba(248,113,113,.35);border-radius:12px;overflow:hidden;" +
                "background:linear-gradient(180deg,rgba(248,113,113,.08),#0f0f11 40%)",
            )}
          >
            <div style={sx(`display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
              <PlayerMark
                name={p.opponent.name}
                initials={p.opponent.initial}
                bg={p.opponent.bg}
                size={26}
              />
              <div>
                <div style={sx(`font:700 13px/1 ${SANS}`)}>{p.opponent.name}</div>
                <div style={sx(`margin-top:4px;font:400 10px/1 ${MONO};color:${C.red}`)}>picking…</div>
              </div>
            </div>
            <div style={sx("display:flex;flex-direction:column;gap:8px;padding:12px")}>
              {p.arena.map((sym) => (
                <div key={sym} style={sx(`display:flex;align-items:center;gap:10px;padding:10px;border:1px dashed ${C.borderMid};border-radius:9px`)}>
                  <span style={sx(`font:700 12px/1 ${MONO};min-width:48px`)}>{sym}</span>
                  <span style={sx(`font:700 13px/1 ${MONO};letter-spacing:.24em;color:${C.borderMid}`)}>•••••</span>
                </div>
              ))}
              <div style={sx(`margin-top:4px;font:400 10.5px/1.5 ${MONO};color:${C.faint};text-align:center`)}>
                Revealed when both slips lock.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * One card's numbers, whichever path dealt it.
 *
 * The two paths are the same six quantities read off two sources, and this is
 * the single place the choice is made — so a face cannot show a live strike
 * beside a seeded delta. Where the book dealt the card every figure is the
 * venue's or is derived from it by the protocol's payout arithmetic; where it
 * did not, every figure is the seeded leg's and `premium` is `null`, which is
 * what makes the face print `MAX LOSS —` instead of a number nobody quoted.
 *
 * **`mult` and `winAt` are two quantities, and keeping them apart is the point.**
 *
 * `mult` is the `×`, and it means one thing on both paths: fair odds that this
 * leg lands, `oddsOf(prob)`. On a dealt card that is over the option's own
 * `|delta|` (`LiveCard.odds`); on a seeded card it is over the tier's band
 * midpoint (`tierOdds`). Nothing about either is a table, a clamp or a house
 * number, and — crucially — they are the *same construction*, so a player
 * scanning a board where ETH is live and AVAX is not is comparing like with
 * like.
 *
 * `winAt` is the money: `premium × LiveCard.payoutMult`, where `payoutMult` is
 * `multipleAt(card, spot, REFERENCE_MOVE, calculatePayout)` — the protocol's
 * payout arithmetic over the ask a buyer actually pays. `null` on a seeded
 * card, because nothing was bought.
 *
 * These were one field until the options flag was first switched on and the two
 * grids appeared together. A dealt DEGEN call is cheap and pays enormously at
 * +25%, so `payoutMult` under the `×` glyph printed `×430.75` on ETH beside
 * `×6.67` on AVAX — a sixty-five-fold difference that meant nothing, because
 * the two numbers answer different questions. Splitting the field is the fix;
 * capping the larger one would have been the same mistake in new clothes.
 *
 * `iv` is decoded off the dealt row's own percent string, so the ÷100 exactly
 * undoes the server's ×100 and recovers the greek's original value rather than
 * inventing a convention. A row without one yields `null`, and the face draws a
 * dash.
 *
 * `theta` stays `null`, and that is a data gap rather than a rendering choice:
 * `rawApiData.greeks` carries it on the wire, but nothing between there and
 * here does — the server's own `Greeks` interface declares only `delta` and
 * `iv`, and `PricingRow` has no theta field at all. Threading it is a
 * six-site change, and it is NOT the mirror of the IV work: the sampled
 * `theta: -4.4791` sits beside premia quoted in fractions of the underlying
 * (~0.05), so per-day versus per-year has to be settled against live data
 * first. Rendered verbatim it would print `θ −4.5` next to a `0.09` premium,
 * which is exactly the class of mistake the IV decode exists to prevent.
 */
function faceValues(
  stance: Stance,
  leg: ParlayLeg,
  card: LiveCard | null,
  spot: number,
): FaceValues {
  return {
    stance,
    strike: card ? card.strikeAt : leg.strike,
    spot: card ? spot : leg.px,
    prob: card ? card.prob : leg.prob,
    mult: card ? card.odds : leg.mult,
    premium: card ? card.premium : null,
    winAt: card ? card.premium * card.payoutMult : null,
    theta: null,
    iv: card ? ivOf(card.row) : null,
  };
}

/**
 * A card the book did not deal, drawn in the place it would have occupied.
 *
 * Not a button, not pressable, and not a smaller cell: the grid keeps its shape
 * so the absence is legible as an absence — *this* tier is missing on this side
 * and the one beside it is not. A card that always exists is the tell that the
 * odds are house-set (plan 6 §A4 step 6), and this is the render that stops
 * this screen making that claim.
 *
 * It says why, in the book's terms: no resting order in this tier's `|delta|`
 * band on this side, at this expiry, inside this window. That is a true
 * statement about the market at deal time and it is more informative than the
 * eight cards it replaces one of.
 */
function DeadSlot({ sym, card }: { sym: string; card: ParlayCard }) {
  const tc = TIER_COLOR[card.tier];
  return (
    <div
      data-parlay-dead={`${sym}:${card.id}`}
      aria-disabled
      style={sx(
        "text-align:left;position:relative;padding:12px;border-radius:10px;" +
          `border:1px dashed ${C.borderMid};background:${C.bg};opacity:.72`,
      )}
    >
      <span style={sx(`${tag(tc)};opacity:.5`)}>{card.tier}</span>
      <div style={sx(`margin-top:8px;font:700 11px/1.3 ${MONO};color:${C.faint}`)}>
        {card.stance === "bull" ? "BULLISH" : "BEARISH"} · NOT DEALT
      </div>
      <div style={sx(`margin-top:6px;font:400 9.5px/1.4 ${MONO};color:${C.dim}`)}>
        no resting {card.stance === "bull" ? "call" : "put"} in {card.tier}’s band
      </div>
    </div>
  );
}

function Stat({ label, value, color, testid }: { label: string; value: string; color?: string; testid: string }) {
  return (
    <div style={sx(`padding:12px 14px;border-right:1px solid ${C.line}`)}>
      <div style={sx(`font:500 8.5px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>{label}</div>
      <div data-testid={testid} style={sx(`margin-top:6px;font:700 15px/1 ${MONO}${color ? `;color:${color}` : ""}`)}>
        {value}
      </div>
    </div>
  );
}
