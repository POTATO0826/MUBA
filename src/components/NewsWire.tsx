import { Fragment, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import type { WireItem } from "../data/wire.ts";
import { meta } from "../data/universe.ts";
import { sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, FEED_STATE, MONO, SANS, sectorColor, tag, type FeedStateSpec } from "../theme.ts";

interface NewsWireProps {
  /**
   * The feed, newest first. Desk rows are pinned to the top on render.
   *
   * "Newest first" is the *producer's* job and it is done at the source —
   * `merge()` in `server/news.ts` for the live feed, one descending stamp walk
   * in `data/wire.ts` for the seeded one. Nothing here re-sorts, and nothing
   * here may: the live envelope is frozen per match so both players read the
   * same order, and a client-side re-sort after the freeze would be exactly the
   * bug that guarantee exists to prevent.
   */
  items: readonly WireItem[];
  /** Where the feed came from — drawn as the header chip. */
  status: "mock" | "live" | "partial";
  /**
   * The one ticker the wire is narrowed to, or `null` for the whole feed.
   *
   * The state lives in `Study`, not here, because the case cards above the
   * terminal are the other handle on it — a card and a sym chip are two ways
   * of pressing the same switch, so neither may own it. Left off entirely,
   * this component draws exactly the DOM it drew before the filter existed.
   */
  filterSym?: string | null;
  /**
   * Toggle that switch from inside the wire: a row's sym chip, and the header's
   * clear chip. Omitted means the wire is not a control surface — the chips
   * render as the inert labels they always were, attribute for attribute.
   */
  onSymToggle?: (sym: string) => void;
}

/**
 * Header chip copy and colour per source — now read straight off the app's one
 * provenance vocabulary (`FEED_STATE`, `src/theme.ts`) rather than re-stated
 * here.
 *
 * The labels are unchanged; this wire is where `SEEDED`/`LIVE`/`PARTIAL` were
 * coined and the vocabulary took its words from it. What changed is the fixture
 * colour: `SEEDED` was amber, and amber simultaneously meant STALE in the
 * footer — the same colour claiming "this is a fixture" on one panel and "these
 * numbers are real but out of date" on another. Amber is now STALE alone, and a
 * fixture reads in the resting grey, which is what a fixture is.
 */
const STATUS: Record<NewsWireProps["status"], FeedStateSpec> = {
  mock: FEED_STATE.seeded,
  live: FEED_STATE.live,
  partial: FEED_STATE.partial,
};

/** Scroll height of the headline list — about nine rows, so the feed reads as
 *  a feed (there is always more below the fold) without eating the charts. */
const LIST_H = 288;

/** How many freshly-arrived news rows get a tick, and the gap between them. */
const TICK_ROWS = 6;
const TICK_GAP_MS = 90;

/** How tall a day band is, near enough. Rows carry it as `scroll-margin-top` so
 *  ↑/↓ cannot walk the selected row underneath the sticky band above it. */
const BAND_H = 25;

const rowStyle = (selected: boolean, desk: boolean): string =>
  `display:grid;grid-template-columns:76px 46px minmax(0,1fr);gap:10px;align-items:center;` +
  `padding:6px 14px;cursor:pointer;text-align:left;width:100%;border:none;scroll-margin-top:${BAND_H}px;` +
  `border-bottom:1px solid ${C.lineSoft};font:400 11.5px/1.45 ${MONO};` +
  (selected
    ? `background:rgba(200,255,0,.08);box-shadow:inset 2px 0 0 ${C.accent};color:${C.text}`
    : `background:${desk ? C.panelAlt : "transparent"};color:${C.textSoft}`);

/**
 * The day band: a dated rule that opens each session's run of rows.
 *
 * Sticky rather than merely inserted, and that is the whole point. A band
 * scrolled past the top of the list would leave the rows under it wearing bare
 * `hh:mm:ss` again — exactly the ambiguity this exists to remove — so it pins
 * to the top edge of the scroller and whatever the reader is looking at is
 * always sitting under a visible date. Opaque background for the same reason: a
 * translucent one would smear the rows travelling beneath it.
 */
const bandStyle =
  `position:sticky;top:0;z-index:1;display:grid;grid-template-columns:auto minmax(0,1fr);` +
  `gap:12px;align-items:center;padding:7px 14px;background:${C.panelAlt};` +
  `border-top:1px solid ${C.border};border-bottom:1px solid ${C.border};` +
  `font:700 8.5px/1 ${MONO};letter-spacing:.16em;color:${C.dim}`;

/** One line, clipped rather than wrapped — a wire never reflows. */
const CLIP = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0";

/** `tag()` at terminal scale: the sym column is 46px, so the chip is tighter
 *  and centred. The overrides trail the shorthand so they win. */
const symChip = (color: string): string =>
  `${tag(color)};justify-content:center;padding:5px 4px;font-size:8px;letter-spacing:.06em;${CLIP}`;

/**
 * The study terminal's news wire: a scrolling headline list over a filed-story
 * detail pane, dressed as a Dow Jones terminal.
 *
 * Rows descend by time and a live feed carries up to a week of them, so the
 * list is grouped under sticky day bands. That is a *display* fix for a display
 * problem: the feed's order was never wrong, but `hh:mm:ss` with no date cannot
 * say "yesterday", so `04:08:51` sitting above `21:23:32` read as a sort bug to
 * anyone looking at it. The band names the session; the order it bands is taken
 * exactly as given.
 *
 * The wire is flavour and nothing else — settlement never reads it — so this
 * component is handed a finished `WireItem[]` and owns only presentation and
 * the two wire sound seams. The feed swaps under it when the live source
 * resolves; selection is therefore held as an *id*, not an index, and re-found
 * on every render. The fallback to the first row means the detail pane cannot
 * be empty, which is why nothing here has an "unselected" branch to draw.
 *
 * `filterSym` narrows the same feed to one ticker. It is DISPLAY ONLY, like
 * everything else on this screen: the filter never reaches `data/wire.ts`, so
 * the feed's order, its ids and its bytes are the same whether a filter is on
 * or off, and clearing one restores the terminal node for node. It is also why
 * the tick effect below is keyed on `items` and not on `rows` — narrowing the
 * view is not the wire receiving, and must not sound like it.
 */
export function NewsWire({ items, status, filterSym = null, onSymToggle }: NewsWireProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selId, setSelId] = useState<string | null>(null);

  /**
   * Desk chatter pins above the filed stories: the coach's read is the reason
   * the player is on this screen, and it should not scroll away under a live
   * feed. Both partitions keep their source order, so the news half stays
   * strictly ts-descending.
   */
  const rows = useMemo(
    () =>
      filterSym
        ? // A filter is a single-asset read of the wire: only that name's filed
          // stories survive it. Desk chatter and market-wide rows are not that
          // asset, so they go with everything else — a filtered wire shows the
          // asset, full stop, and the pin-to-top rule has nothing left to pin.
          items.filter((i) => i.kind === "news" && i.sym === filterSym)
        : [...items.filter((i) => i.kind === "desk"), ...items.filter((i) => i.kind === "news")],
    [items, filterSym],
  );

  /**
   * Which rows open a new session — row id → the band to draw above it.
   *
   * The wire is newest-first and a live feed spans up to a week of it, so a
   * bare `hh:mm:ss` column reads as scrambled the moment the list crosses
   * midnight: `04:08:51` above `21:23:32` is a *correct* descent that looks
   * like a broken one. The band is the disambiguation, and it is drawn off the
   * `day` the feed was built with — formatted once, in ET, by whoever built the
   * feed — never from `ts` and the viewer's own clock, which would put two
   * players in two zones on two different day boundaries.
   *
   * Grouped over `rows` rather than `items`, so a filtered wire bands only the
   * days that survived the filter and cannot leave an empty session heading
   * behind. A feed whose rows carry no `day` (an older `/api/news` envelope,
   * say) yields an empty map and the terminal draws exactly what it drew before
   * bands existed.
   */
  const bands = useMemo(() => {
    const out = new Map<string, string>();
    let open: string | undefined;
    for (const it of rows) {
      if (!it.day || it.day === open) continue;
      open = it.day;
      out.set(it.id, it.day);
    }
    return out;
  }, [rows]);

  /** Selection survives a mock → live swap: the id is looked up again, and a
   *  miss falls through to the top row rather than blanking the pane. A filter
   *  is just another way for the id to go missing, so switching tickers files
   *  the new top story on its own — no special case, and no blank pane. */
  const selected = rows.find((i) => i.id === selId) ?? rows[0];

  /**
   * The wire ticking in. Fires on mount and on every feed swap, staggered over
   * the first few news rows so the terminal sounds like it is receiving rather
   * than like one click. Keyed on the head id + length (not array identity) so
   * an unrelated re-render with an equal feed stays silent. In tests
   * `audioAvailable` is false, so this costs zero timers.
   */
  useEffect(() => {
    items
      .filter((i) => i.kind === "news")
      .slice(0, TICK_ROWS)
      .forEach((_, i) => sfx("wire.tick", { delayMs: i * TICK_GAP_MS }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items[0]?.id, items.length]);

  const open = (item: WireItem) => {
    sfx("wire.select");
    setSelId(item.id);
  };

  /** ↑/↓ walks the list. Keeps the moved-to row in view when the pane can
   *  scroll; `scrollIntoView` is optional-called because happy-dom has none. */
  const step = (delta: number) => {
    if (rows.length === 0) return;
    const at = rows.findIndex((i) => i.id === selected?.id);
    const next = rows[Math.min(rows.length - 1, Math.max(0, (at < 0 ? 0 : at) + delta))];
    if (!next || next.id === selected?.id) return;
    open(next);
    const el = listRef.current?.querySelector(`[data-wire-id="${next.id}"]`);
    (el as HTMLElement | null)?.scrollIntoView?.({ block: "nearest" });
  };

  const chip = STATUS[status];

  return (
    <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden`)}>
      {/* The bar Study has always carried, plus the source chip on the right. */}
      <div style={sx(`display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
        <span style={sx(`width:6px;height:6px;border-radius:99px;background:${C.amber};animation:vcPulse 1.4s ease-in-out infinite`)} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.amber}`)}>NEWS WIRE · DESK CHATTER</span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>SAME WIRE ON BOTH SCREENS</span>
        {/* The wire says out loud that it is narrowed, and the way out of the
            filter is the same chip that reports it — one click, no hunting
            back up to the card that set it. */}
        {filterSym ? (
          <button
            data-testid="wire-filter"
            data-wire-filter={filterSym}
            title={`The wire is showing ${filterSym} only — clear the filter`}
            onClick={() => onSymToggle?.(filterSym)}
            style={sx(
              `font:700 9px/1 ${MONO};letter-spacing:.12em;padding:5px 7px;border-radius:5px;cursor:pointer;` +
                `border:1px solid ${C.accent}55;background:${C.accent}1f;color:${C.accent}`,
            )}
          >
            FILTER · {filterSym} ×
          </button>
        ) : null}
        <span
          data-testid="wire-status"
          // The vocabulary's own sentence, so the chip explains itself on
          // hover instead of restating its own label back at the reader.
          title={chip.means}
          style={sx(
            `font:700 9px/1 ${MONO};letter-spacing:.12em;padding:5px 7px;border-radius:5px;` +
              `border:1px solid ${chip.color}55;background:${chip.color}1f;color:${chip.color}`,
          )}
        >
          {chip.label}
        </span>
      </div>

      {/* TOP PANE — the feed. */}
      <div
        ref={listRef}
        role="listbox"
        aria-label="News wire headlines"
        aria-activedescendant={selected ? `wire-row-${selected.id}` : undefined}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
          e.preventDefault();
          step(e.key === "ArrowDown" ? 1 : -1);
        }}
        style={sx(`height:${LIST_H}px;overflow-y:auto;background:${C.panel};outline:none`)}
      >
        {/* A ticker the feed has filed nothing on yet — a live source that came
            back thin, most often. The terminal says so in its own voice rather
            than drawing an empty box, and the detail pane below draws its own
            quiet line, so neither pane can throw on a missing story. */}
        {rows.length === 0 ? (
          <div
            data-testid="wire-empty"
            style={sx(
              `padding:22px 16px;text-align:center;font:500 10px/1.6 ${MONO};letter-spacing:.14em;color:${C.faint}`,
            )}
          >
            NO {filterSym ?? "MKT"} STORIES ON THE WIRE
          </div>
        ) : null}
        {rows.map((item) => {
          const desk = item.kind === "desk";
          const on = item.id === selected?.id;
          // Hoisted out of the JSX so the narrowing survives into the chip's
          // own click handler — `item.sym` is a property, and a closure would
          // widen it straight back to `string | null`.
          const sym = item.sym;
          const band = bands.get(item.id);
          return (
            <Fragment key={item.id}>
              {band ? (
                // `presentation` keeps the listbox's children valid — a band is
                // not an option and must not be walked by ↑/↓ or counted by the
                // `[data-wire]` selectors the suite reads rows off. The date is
                // not lost to a screen reader: every row below carries it in its
                // own `title`, which is also what a mouse gets on hover.
                <div role="presentation" data-wire-day={band} style={sx(bandStyle)}>
                  <span>{band}</span>
                  <span style={sx(`height:1px;background:${C.line}`)} />
                </div>
              ) : null}
              <div
                id={`wire-row-${item.id}`}
                role="option"
                aria-selected={on}
                // The full stamp, day included, on every row — the band answers
                // "which session am I in" for a run of rows, this answers it for
                // one row without the reader having to scroll up to find out.
                title={item.day ? `${item.day} · ${item.time} ET` : `${item.time} ET`}
                data-wire={item.kind}
                // Desk rows answer to the old selector as well: one standing
                // assertion counts `[data-brief="desk"]` on this screen.
                {...(desk ? { "data-brief": "desk" } : {})}
                data-wire-id={item.id}
                data-wire-sym={item.sym ?? "MKT"}
                onClick={() => open(item)}
                style={sx(rowStyle(on, desk))}
              >
                <span style={sx(`color:${on ? C.textSoft : C.faint};${CLIP}`)}>{item.time}</span>
                {desk ? (
                  <span
                    style={sx(
                      `font:700 9px/1 ${MONO};letter-spacing:.1em;text-align:center;` +
                        // Study's own mapping, kept verbatim: the coach speaks in
                        // accent, the desk in blue.
                        `color:${item.who === "COACH" ? C.accent : C.blue};${CLIP}`,
                    )}
                  >
                    {item.who ?? "DESK"}
                  </span>
                ) : sym ? (
                  // The chip is the wire's own handle on the filter. It sits
                  // inside a row that is itself a click target, so the toggle
                  // stops the event dead: pressing SOL narrows the feed, it does
                  // not also file SOL's story into the pane underneath. Handed no
                  // `onSymToggle`, it renders as the inert label it always was.
                  <span
                    style={sx(symChip(sectorColor(meta(sym).sector)) + (onSymToggle ? ";cursor:pointer" : ""))}
                    {...(onSymToggle
                      ? {
                          "data-wire-chip": sym,
                          role: "button",
                          // Off the tab order on purpose: the row already answers
                          // ↑/↓, and forty chips ahead of the detail pane would
                          // make the terminal unkeyboardable.
                          tabIndex: -1,
                          "aria-pressed": sym === filterSym,
                          title:
                            sym === filterSym
                              ? `Showing ${sym} only — click to clear the filter`
                              : `Filter the wire to ${sym}`,
                          onClick: (e: MouseEvent<HTMLSpanElement>) => {
                            e.stopPropagation();
                            onSymToggle(sym);
                          },
                        }
                      : {})}
                  >
                    {sym}
                  </span>
                ) : (
                  <span style={sx(`font:500 8px/1 ${MONO};letter-spacing:.06em;text-align:center;color:${C.dim};${CLIP}`)}>
                    MKT
                  </span>
                )}
                <span style={sx(CLIP)}>{desk ? `“${item.headline}”` : item.headline}</span>
              </div>
            </Fragment>
          );
        })}
      </div>

      {/* BOTTOM PANE — the filed story behind the selected line. */}
      <div
        data-testid="wire-detail"
        style={sx(`min-height:196px;padding:16px 20px;background:${C.panelAlt};border-top:1px solid ${C.border}`)}
      >
        {selected ? (
          <>
            <div
              data-testid="wire-dateline"
              style={sx(
                `font:700 12px/1.5 ${MONO};color:${C.textSoft};text-align:center;` +
                  `padding-bottom:10px;border-bottom:1px solid ${C.line};text-wrap:pretty`,
              )}
            >
              {selected.dateline}
            </div>

            <div
              style={sx(
                `max-width:74ch;margin:14px auto 0;font:400 12.5px/1.7 ${SANS};color:${C.muted};text-wrap:pretty`,
              )}
            >
              {selected.body}
            </div>

            {/* Live items carry a source link; seeded ones never do. */}
            {selected.link ? (
              <div style={sx("max-width:74ch;margin:12px auto 0")}>
                <a
                  href={selected.link}
                  target="_blank"
                  rel="noreferrer"
                  style={sx(`font:400 10px/1.5 ${MONO};color:${C.blue};text-decoration:none;word-break:break-all`)}
                >
                  READ ON {selected.publisher} ↗
                </a>
              </div>
            ) : null}

            <div
              data-testid="wire-signature"
              style={sx(
                `max-width:74ch;margin:14px auto 0;padding-top:12px;border-top:1px solid ${C.line};` +
                  `font:400 10.5px/1.6 ${MONO};color:${C.faint};text-wrap:pretty`,
              )}
            >
              {selected.signature}
            </div>
          </>
        ) : (
          // Unreachable with any real source — the seeded wire is never empty —
          // but the pane still has to draw something if one hands it nothing.
          <div style={sx(`font:400 12px/1.7 ${SANS};color:${C.faint};text-align:center`)}>
            The wire is quiet. No stories have filed on this board.
          </div>
        )}
      </div>
    </div>
  );
}
