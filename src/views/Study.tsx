import { useMemo, useState } from "react";
import { NewsWire } from "../components/NewsWire.tsx";
import { Sparkline } from "../components/Sparkline.tsx";
import { modeTag, type ModeSpec } from "../data/modes.ts";
import type { WireItem } from "../data/news.ts";
import { meta } from "../data/universe.ts";
import { buildChartCard } from "../engine/chart.ts";
import { TAPE_LEN, fmtPx, series } from "../engine/tape.ts";
import { playClip, sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { Player } from "../types.ts";

interface StudyProps {
  /** Symbols to chart: the legs the spin dealt. */
  arena: readonly string[];
  /** The terminal's feed: filed stories per ticker with the desk exchange
   *  folded in on top. Seeded off the same salt as the charts, or live. */
  wire: readonly WireItem[];
  /** Where that feed came from — the terminal draws it as its header chip. */
  wireStatus: "mock" | "live" | "partial";
  salt: number;
  /** The print the duel will settle on. The study charts are drawn to exactly
   *  that window, so what you read is the length you play. */
  settleAt: number;
  mode: ModeSpec;
  opponent: Player;
  prizeLabel: string;
  onDone: () => void;
}

/**
 * The case card, resting and filtering.
 *
 * The lit branch is `rowStyle`'s selected read in card form — the accent, the
 * same 8% wash — but drawn as a border rather than an inset bar, because a card
 * has four sides where a wire row has one. Both branches carry a 1px border and
 * the same padding, so the grid is laid out identically either way: pressing a
 * card must not shuffle the charts beside it by a pixel.
 */
const caseCardStyle = (on: boolean): string =>
  `border-radius:12px;padding:14px;cursor:pointer;` +
  (on
    ? `border:1px solid ${C.accent}99;background:rgba(200,255,0,.06);box-shadow:inset 0 0 0 1px rgba(200,255,0,.18)`
    : `border:1px solid ${C.border};background:${C.panel}`);

/**
 * The zoom levels, as divisors of the duel's own window.
 *
 * Powers of two rather than named durations, and that is a truth constraint
 * rather than a style one. A mode's window is a whole number of *prints*
 * (BLITZ 56, QUICK 110, NORMAL 200) and its declared duration is 15 minutes, an
 * hour, a day. Quartering an hour gives fifteen minutes; quartering fifteen
 * minutes gives three minutes forty-five seconds. Chips that printed `3M45S`
 * would be quoting a precision the simulation does not have any claim to, and
 * chips that rounded it to `4M` would be quoting a number that is simply wrong.
 * A zoom factor is exact for every mode, needs no formatter, and says plainly
 * what it is: a camera setting.
 *
 * The prints each level actually draws are printed beside the chips and on
 * every card, so nothing is hidden behind the factor.
 */
const ZOOMS: readonly number[] = [1, 2, 4, 8];

/**
 * Below this many prints in a card, the line has fewer points than the card has
 * pixels and the terminal says so.
 *
 * The chart never interpolates — `geom` slices the tape and joins the prints it
 * finds — but a fourteen-point line stretched across five hundred pixels *looks*
 * like a smooth continuous series, and a reader is entitled to know it is
 * fourteen measurements rather than five hundred. Roughly a quarter of the
 * card's rendered width in CSS pixels; the exact number does not matter, being
 * told does.
 */
const COARSE_BELOW = 60;

const zoomChip = (on: boolean): string =>
  `height:24px;min-width:34px;padding:0 8px;border-radius:6px;cursor:pointer;` +
  `font:700 10px/1 ${MONO};letter-spacing:.06em;` +
  (on
    ? `border:1px solid ${C.accent}66;background:${C.accent}1f;color:${C.accent}`
    : `border:1px solid ${C.border};background:transparent;color:${C.dim}`);

/** Both players read the same charts and the same wire before picking a parlay. */
export function Study({ arena, wire, wireStatus, salt, settleAt, mode, opponent, prizeLabel, onDone }: StudyProps) {
  const cols = Math.min(3, Math.max(2, arena.length));

  /**
   * Which ticker the terminal is reading, or `null` for the whole board.
   *
   * One piece of state with two handles on it: the case card above and the sym
   * chip on a wire row below. Both call `toggleSym`, both read `filterSym`, and
   * neither owns it — which is the only arrangement where pressing SOL on a
   * card and pressing SOL on a row cannot disagree about what the wire is
   * showing. It lives here rather than in `NewsWire` because the cards are
   * here; the wire is handed the value and a way to flip it.
   *
   * Nothing downstream of this reaches settlement. The filter is a view over an
   * already-built feed — `data/wire.ts` is never re-run, never re-ordered, and
   * never even told a filter exists.
   */
  const [filterSym, setFilterSym] = useState<string | null>(null);

  /**
   * The camera on the charts, and nothing but the camera.
   *
   * The owner's note was *"its so confusing and useless where it shows such a
   * long period, let ppl choose the period or zoom in and out or smtg."* Half
   * of that confusion was a lie in the label — the cards claimed a hashed
   * `OCT 2013 · JAN 2014` over a generated walk, which `engine/tape.ts` no
   * longer prints. This is the other half: the reader can now look at the last
   * half, quarter or eighth of the window instead of only the whole thing.
   *
   * ## Why this is safe, and why it is structurally safe rather than carefully
   * safe
   *
   * `zoom` is a number in this component and it reaches exactly one function:
   * `buildChartCard`, which slices an already-generated tape. It is not a
   * parameter of `series`, so it cannot change a single print; it is not a
   * parameter of `onDone`, so it cannot travel to the parlay; and the seed, the
   * salt and `settleAt` are all props arriving from above, so it cannot reach
   * what was dealt or what will settle. Two seats at two zoom levels are
   * reading one board — the same argument `src/views/BoxBuilder.tsx` makes for
   * keeping its ladder viewport out of `encodeBoxPick`, and the same reason
   * neither of them needed a test to prove it: there is no wire from here to
   * there to cut.
   *
   * Reset is unnecessary: `arena`, `salt` and `settleAt` all change together
   * when the match does, and a zoom factor is meaningful against any window.
   */
  const [zoom, setZoom] = useState(1);

  /**
   * The slice every card draws: the last `settleAt / zoom` prints of the duel's
   * window.
   *
   * Anchored on the *end* of the window rather than the start, because the end
   * is the interesting edge — it is where the tape stops and where the reader's
   * eye already is. Two prints is the floor; a one-print chart is a dot.
   */
  const view = useMemo(() => {
    const count = Math.max(2, Math.round(settleAt / zoom));
    return { count, from: Math.max(0, settleAt - count) };
  }, [settleAt, zoom]);

  const coarse = view.count < COARSE_BELOW;

  /** Press the active ticker again and the wire comes back whole. Written as a
   *  read-then-set rather than a functional update on purpose: the sound is a
   *  side effect, and a state updater is not allowed to have one. */
  const toggleSym = (sym: string) => {
    const next = filterSym === sym ? null : sym;
    // Narrowing latches, clearing releases — the two-blip toggle the rest of
    // the app already uses for exactly this gesture.
    sfx(next ? "ui.toggle.on" : "ui.toggle.off");
    setFilterSym(next);
  };

  const setZoomTo = (z: number) => {
    if (z === zoom) return;
    sfx(z > zoom ? "ui.toggle.on" : "ui.toggle.off");
    setZoom(z);
  };

  return (
    /**
     * One column, and that is the change.
     *
     * ## What was here, and why it is gone
     *
     * A 320px right rail carrying a panel headed "Coach reads the tape" behind
     * an `AI` avatar, holding three notes — READ 01 / READ 02 / READ 03. There
     * was no coach and there was no AI. The three notes were a literal array of
     * three template strings with two numbers interpolated, identical on every
     * session of every match, and they occupied about a third of the viewport.
     * The owner called the screen "ai slop … especially the thing on the right,
     * its hard coded and useless", and separately from the UX that framing is a
     * straight honesty problem under `docs/reality-check.md` and the standing
     * *"i dont want to demo fake stuff"* rule: an AI persona is a claim about
     * where advice came from, and the claim was false.
     *
     * One of the three notes carried something a player genuinely needs to know
     * — that the duel runs on a *fresh* window, so the thing to read off these
     * charts is behaviour and not levels. It survives, once, as a quiet line on
     * the board bar below, stated as a fact about the screen rather than as
     * advice from a persona. The other two said "match the tier to the
     * behaviour" and "your opponent sees the same board", which are a truism
     * and a restatement of the header chip that is already on screen.
     *
     * ## What the space became
     *
     * Nothing was invented to fill it — the instruction was explicit that
     * replacing static prose with different static prose fails. The rail's
     * width went to the two things on this page that were cramped and are the
     * player's actual job here, which is deciding which parlay to pick:
     *
     *  - **the dealt charts**, which gain about a third of their width each, so
     *    two hundred prints have room to be legible instead of a thumbnail;
     *  - **the wire**, which was a nine-row scroll box with the open story
     *    hidden below the fold and is now a full-width terminal: fourteen rows
     *    of feed beside the story they open, both visible at once.
     *
     * The exit — "Done studying → pick a parlay" — moved to the header, top
     * right. It used to sit at the bottom of the rail; in a single column that
     * would have put it below the wire, and the one control that leaves the
     * screen should not require scrolling past the screen to reach.
     */
    <div style={sx("padding:24px 28px;max-width:1720px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:14px;margin-bottom:16px;flex-wrap:wrap")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Case study</h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.blue};` +
              "border:1px solid rgba(56,189,248,.35);background:rgba(56,189,248,.12);" +
              "border-radius:6px;padding:6px 8px",
          )}
        >
          STUDY PHASE · BOTH PLAYERS READING
        </span>
        <span style={sx(modeTag(mode.key))}>
          {mode.label} · {mode.duration}
        </span>
        {/* Who is on the other side. This is the third coach note's only real
            content — "same charts, same wire, same book" — reduced to the fact
            it was dressed up as advice: a name, in the header, where the rest of
            the match's identity already lives. The header chip beside it
            ("BOTH PLAYERS READING") was always the sentence's other half. */}
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>
          VS <span style={sx(`color:${C.muted};font-weight:700`)}>{opponent.name}</span>
        </span>
        <div style={sx("flex:1")} />
        <span style={sx(`flex:none;font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>POOL</span>
        {/* `flex:none` on both: the pool is the one number in this header that
            must never be shrunk to fit, and the exit button beside it is happy
            to take the width instead. */}
        <span style={sx(`flex:none;font:700 18px/1 ${MONO};color:${C.accent};margin-right:6px;white-space:nowrap`)}>
          {prizeLabel}
        </span>
        <button
          onClick={() => {
            playClip("exo-1", "/assets/exo-kill-1.mp3");
            onDone();
          }}
          style={sx(
            `height:38px;padding:0 18px;border:none;border-radius:8px;` +
              `background:${C.accent};color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer;white-space:nowrap`,
          )}
        >
          Done studying → pick a parlay
        </button>
      </div>

      {/* THE BOARD BAR — what the charts are, and the camera on them. */}
      <div
        style={sx(
          "display:flex;align-items:flex-end;gap:20px;flex-wrap:wrap;margin-bottom:10px;" +
            `padding:11px 14px;border:1px solid ${C.border};border-radius:10px;background:${C.card}`,
        )}
      >
        <div style={sx("flex:1;min-width:320px")}>
          <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.14em;color:${C.faint}`)}>THE DEALT BOARD</div>
          {/* READ 02, relocated and demoted — the one sentence out of the coach
              panel that told a player something they could not read off the
              screen. Stated as a fact about the tape, unsigned. */}
          <div style={sx(`margin-top:7px;font:400 11.5px/1.55 ${SANS};color:${C.muted};text-wrap:pretty`)}>
            These are the tickers the spin dealt, on this match's generated study tape. The duel draws a
            fresh window on the same tickers, so read behaviour — not levels. Press a ticker to narrow
            the wire to it.
          </div>
        </div>

        <div style={sx("display:flex;flex-direction:column;align-items:flex-end;gap:7px")}>
          <div style={sx("display:flex;align-items:center;gap:6px")}>
            <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.14em;color:${C.faint};margin-right:4px`)}>ZOOM</span>
            {ZOOMS.map((z) => (
              <button
                key={z}
                data-zoom={z}
                aria-pressed={z === zoom}
                title={
                  z === 1
                    ? `The whole ${settleAt}-print window`
                    : `The last ${Math.max(2, Math.round(settleAt / z))} prints of the ${settleAt}-print window`
                }
                onClick={() => setZoomTo(z)}
                style={sx(zoomChip(z === zoom))}
              >
                {z}×
              </button>
            ))}
          </div>
          {/* The readout. Everything in it is either counted off the tape or is
              a declared rule of the mode — there is no date here and there is
              nothing derived from a hash. */}
          <div
            data-testid="zoom-readout"
            style={sx(`font:400 10px/1.5 ${MONO};letter-spacing:.04em;color:${C.dim};text-align:right`)}
          >
            {view.count} OF {settleAt} PRINTS · WINDOW {settleAt}/{TAPE_LEN} ≙ {mode.duration} SIMULATED
            {coarse ? (
              <span style={sx(`display:block;color:${C.faint}`)}>
                FEWER PRINTS THAN PIXELS — THE LINE JOINS REAL PRINTS, IT ADDS NONE
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div style={sx(`display:grid;grid-template-columns:repeat(${cols},minmax(0,1fr));gap:12px;margin-bottom:16px`)}>
        {arena.map((sym) => {
          const card = buildChartCard(sym, salt, view.count, 132, view.from);
          const u = meta(sym);
          // The range is the range of what is DRAWN. It used to be the whole
          // 200-print tape's high and low while the chart above it drew the
          // mode's shorter window, so on any mode but NORMAL the two disagreed
          // before a zoom control existed to make it worse.
          const slice = series(sym, salt).slice(view.from, view.from + view.count);
          const hi = Math.max(...slice);
          const lo = Math.min(...slice);

          const on = filterSym === sym;

          return (
            // A case card is a switch as well as a chart: it narrows the
            // terminal below to this name's stories. `role="button"` rather
            // than a real `<button>` because the card's layout is the grid's
            // — a button element brings its own box, and the charts would
            // move the first time anyone pressed one.
            <div
              key={sym}
              data-case={sym}
              role="button"
              tabIndex={0}
              aria-pressed={on}
              title={on ? `The wire is showing ${sym} only — click to clear` : `Filter the wire to ${sym}`}
              onClick={() => toggleSym(sym)}
              onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault(); // Space scrolls the study page otherwise.
                toggleSym(sym);
              }}
              style={sx(caseCardStyle(on))}
            >
              <div style={sx("display:flex;align-items:flex-start;justify-content:space-between")}>
                <div>
                  <div style={sx(`font:700 15px/1 ${MONO}`)}>{card.sym}</div>
                  <div style={sx(`margin-top:6px;font:400 9.5px/1 ${MONO};color:${C.faint}`)}>{card.window}</div>
                </div>
                <div style={sx("text-align:right")}>
                  <div style={sx(`font:700 14px/1 ${MONO};color:${card.stroke}`)}>{card.pct}</div>
                  <div style={sx(`margin-top:6px;font:400 10px/1 ${MONO};color:${C.dim}`)}>{card.px}</div>
                </div>
              </div>

              <Sparkline card={card} height={132} />

              <div
                style={sx(
                  "display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:12px;" +
                    `padding-top:12px;border-top:1px solid ${C.line}`,
                )}
              >
                {[
                  { label: "RANGE DRAWN", value: `${fmtPx(lo)}–${fmtPx(hi)}` },
                  { label: "σ DAILY", value: `${(u.vol * 100).toFixed(1)}%` },
                  { label: "SECTOR", value: u.sector },
                ].map((s) => (
                  <div key={s.label}>
                    <div style={sx(`font:500 8px/1 ${MONO};letter-spacing:.1em;color:${C.faint}`)}>{s.label}</div>
                    <div style={sx(`margin-top:5px;font:700 11.5px/1 ${MONO}`)}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {/* The terminal: filed stories beside the open one, desk chatter pinned on
          top. Presentation only — settlement never reads a headline. The filter
          travels down as a value and comes back as a call: the sym tokens on the
          rows are the same switch the cards are. */}
      <NewsWire items={wire} status={wireStatus} filterSym={filterSym} onSymToggle={toggleSym} />
    </div>
  );
}
