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

/**
 * Height of the terminal's body — the headline list and the filed story, which
 * now sit side by side and are therefore the same height by construction.
 *
 * It went from 288 to this when the fake coach panel came off the study screen
 * and the wire stopped being a short scroll box wedged under three charts. The
 * feed is the page's live half; giving it fourteen rows instead of nine is most
 * of what "reclaim the space" meant.
 */
const BODY_H = 420;

/** How wide the filed story is. Fixed rather than fluid so the body's measure
 *  stays inside a comfortable 60–75 characters at every window width — a story
 *  column that grew with the viewport would hit 120 characters on a wide screen
 *  and stop being readable prose. */
const STORY_W = 460;

/** How many freshly-arrived news rows get a tick, and the gap between them. */
const TICK_ROWS = 6;
const TICK_GAP_MS = 90;

/** How tall a day band is, near enough. Rows carry it as `scroll-margin-top` so
 *  ↑/↓ cannot walk the selected row underneath the sticky band above it. */
const BAND_H = 25;

/**
 * A wire row: a mono stamp, a sym token, the headline, the source.
 *
 * ## Why the headline is not monospace any more
 *
 * The owner's read on this terminal was "yes it might be working but ui wise ai
 * slop", and the row rhythm was the largest part of why. Every column was
 * `MONO` at one size, so a *stamp* (data — fixed width matters, columns must
 * line up) and a *headline* (prose — written by a person, read as a sentence)
 * were rendered as the same kind of object, and forty of them stacked read as
 * machine output rather than as a feed.
 *
 * The split here is the whole fix and it is a rule, not a preference:
 * **provenance is monospace and dim; content is proportional and bright.** The
 * stamp, the ticker and the publisher are provenance; the headline is content.
 * Nothing was removed to get there — the publisher was *added*, because a wire
 * that does not name its source on the row is the one thing a real terminal
 * never does, and this feed's sources are real and worth naming.
 */
const rowStyle = (selected: boolean, desk: boolean): string =>
  `display:grid;grid-template-columns:62px 42px minmax(0,1fr) auto;gap:10px;align-items:center;` +
  `padding:7px 14px;cursor:pointer;text-align:left;width:100%;border:none;scroll-margin-top:${BAND_H}px;` +
  `border-bottom:1px solid ${C.lineSoft};` +
  (selected
    ? `background:rgba(200,255,0,.08);box-shadow:inset 2px 0 0 ${C.accent}`
    : `background:${desk ? C.panelAlt : "transparent"}`);

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

/**
 * The sym token, at rest and as the live filter.
 *
 * At rest it is the sector's colour on the terminal's own ground — a *word*,
 * not a sticker. It used to be a filled pill on every single row, and forty
 * filled pills down one edge is the thing that made this list read as
 * decoration rather than as a feed. The pill did not carry information the
 * colour and the letters were not already carrying.
 *
 * Pressed, it fills. That is the one state where a background is doing work:
 * it says *this ticker is the filter that is currently on*, which is a fact
 * about the terminal rather than a fact about the row.
 */
const symToken = (color: string, pressed: boolean): string =>
  (pressed
    ? `${tag(color)};padding:4px 3px;`
    : `display:inline-flex;align-items:center;justify-content:center;padding:4px 3px;color:${color};`) +
  `justify-content:center;font:700 8.5px/1 ${MONO};letter-spacing:.06em;${CLIP}`;

/** Same chrome for both header toggles, so "narrowed to SOL" and "price talk
 *  only" read as one row of switches rather than two unrelated widgets. */
const headerChip = (on: boolean, color: string): string =>
  `font:700 9px/1 ${MONO};letter-spacing:.12em;padding:5px 7px;border-radius:5px;cursor:pointer;` +
  (on
    ? `border:1px solid ${color}55;background:${color}1f;color:${color}`
    : `border:1px solid ${C.border};background:transparent;color:${C.dim}`);

/** The app's standing reduced-motion read, same shape as `Ranking`/`ChromeTag`.
 *  Read once at mount: a viewer who changes the OS setting mid-study is not a
 *  case worth a listener, and the pulse is one dot. */
const stillness = (): boolean =>
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;

/**
 * The study terminal's news wire: a scrolling headline list beside a filed-story
 * detail pane, dressed as a Dow Jones terminal.
 *
 * ## The list and the story sit side by side
 *
 * They used to stack — a 288px scroll box with the open story underneath it —
 * and stacked is what made the relationship between the two invisible: pressing
 * a headline changed something below the fold, and the feed itself never got
 * tall enough to read as a feed. Side by side, the selected row and the story it
 * opened are visible at the same time, which is how every terminal and every
 * mail client has laid this out for forty years, and the list gets the height
 * the removed coach panel was using.
 *
 * ## Order
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
 * ## Both narrowings are DISPLAY ONLY
 *
 * `filterSym` narrows the same feed to one ticker; `priced` narrows it to the
 * rows whose own words quote a move, a level or a market event. Neither ever
 * reaches `data/wire.ts` or `/api/news`, so the feed's order, its ids and its
 * bytes are the same whether a filter is on or off, and clearing one restores
 * the terminal node for node. It is also why the tick effect below is keyed on
 * `items` and not on `rows` — narrowing the view is not the wire receiving, and
 * must not sound like it.
 */
export function NewsWire({ items, status, filterSym = null, onSymToggle }: NewsWireProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [selId, setSelId] = useState<string | null>(null);
  const [still] = useState(stillness);

  /**
   * "Show me the rows that talk about price."
   *
   * Off by default, and that is a correctness decision rather than a taste one.
   * `priceSignal` (`data/wire.ts`) measures whether an item's *text* quotes a
   * move, a level or a market event; it cannot measure whether a story moved a
   * price, because nothing in this app can. A quiet, genuinely market-moving
   * story written without a number comes back unmarked. Hiding real news by
   * default on a marker that imprecise would be a fabrication wearing a
   * filter's clothes — so the sharpening is the player's to ask for, the count
   * it hides is stated out loud, and one click puts every row back.
   *
   * The ranking that *does* run by default is upstream and is a budget rule
   * rather than a visibility rule: `merge()` in `server/news.ts` spends the
   * wire's limited row budget on price-talking copy first, so the stadium-logo
   * story only reaches the terminal when its ticker had nothing better to send.
   */
  const [priced, setPriced] = useState(true);

  /**
   * Desk chatter pins above the filed stories: the desk's read is the reason
   * the player is on this screen, and it should not scroll away under a live
   * feed. Both partitions keep their source order, so the news half stays
   * strictly ts-descending.
   */
  const symRows = useMemo(
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

  /** How many of the rows on screen carry a price marker. Counted over the
   *  sym-narrowed set, so the number the header states is the number the reader
   *  would actually gain or lose by pressing the switch. */
  const marked = useMemo(() => symRows.filter((i) => (i.signal?.length ?? 0) > 0).length, [symRows]);

  const rows = useMemo(
    () => (priced ? symRows.filter((i) => (i.signal?.length ?? 0) > 0) : symRows),
    [symRows, priced],
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
   * Grouped over `rows` rather than `items`, so a narrowed wire bands only the
   * days that survived the narrowing and cannot leave an empty session heading
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

  const togglePriced = () => {
    // Same two-blip toggle the sym filter uses — narrowing latches, clearing
    // releases. Two switches on one terminal should not sound different.
    sfx(priced ? "ui.toggle.off" : "ui.toggle.on");
    setPriced(!priced);
  };

  const chip = STATUS[status];

  return (
    <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden`)}>
      {/* The bar Study has always carried, plus the source chip on the right. */}
      <div style={sx(`display:flex;align-items:center;gap:8px;padding:11px 14px;border-bottom:1px solid ${C.border}`)}>
        <span
          style={sx(
            `width:6px;height:6px;border-radius:99px;background:${C.amber}` +
              // The one animated thing on this panel, and it says "receiving".
              // Stilled rather than merely slowed under `prefers-reduced-motion`:
              // the dot's colour already carries the state, so nothing is lost.
              (still ? "" : ";animation:vcPulse 1.4s ease-in-out infinite"),
          )}
        />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.amber}`)}>NEWS WIRE · DESK CHATTER</span>
        <div style={sx("flex:1")} />

        {/* Price talk. See the `priced` state for why this is opt-in and why the
            marker it reads is evidence rather than a score. */}
        <button
          data-testid="wire-priced"
          aria-pressed={priced}
          title={
            priced
              ? "Showing only rows that quote a move, a level or a market event — click to show every row"
              : "Show only rows that quote a move, a level or a market event in their own words"
          }
          onClick={togglePriced}
          style={sx(headerChip(priced, C.blue))}
        >
          PRICE TALK{priced ? " ×" : ""}
        </button>

        {/* The wire says out loud that it is narrowed, and the way out of the
            filter is the same chip that reports it — one click, no hunting
            back up to the card that set it. */}
        {filterSym ? (
          <button
            data-testid="wire-filter"
            data-wire-filter={filterSym}
            title={`The wire is showing ${filterSym} only — clear the filter`}
            onClick={() => onSymToggle?.(filterSym)}
            style={sx(headerChip(true, C.accent))}
          >
            {filterSym} ×
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

      {/* The census strip. Always drawn, so pressing PRICE TALK cannot shift the
          list under the reader's cursor, and always stating a count rather than
          a claim: the terminal reports what it is hiding at the moment it hides
          it. */}
      <div
        data-testid="wire-census"
        style={sx(
          `display:flex;align-items:center;gap:10px;padding:6px 14px;border-bottom:1px solid ${C.lineSoft};` +
            `background:${C.panelAlt};font:500 9px/1.4 ${MONO};letter-spacing:.1em;color:${C.faint}`,
        )}
      >
        <span>
          {rows.length} OF {symRows.length} ROWS
        </span>
        <span style={sx(`color:${C.line}`)}>·</span>
        <span style={sx(`color:${priced ? C.blue : C.faint}`)}>
          {priced
            ? `${marked} QUOTE A MOVE, A LEVEL OR AN EVENT · ${symRows.length - marked} HIDDEN`
            : `${marked} QUOTE A MOVE, A LEVEL OR AN EVENT`}
        </span>
        <div style={sx("flex:1")} />
        <span>SAME WIRE ON BOTH SCREENS</span>
      </div>

      <div style={sx(`display:grid;grid-template-columns:minmax(0,1fr) ${STORY_W}px`)}>
        {/* LEFT — the feed. */}
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
          style={sx(`height:${BODY_H}px;overflow-y:auto;background:${C.panel};outline:none`)}
        >
          {/* A ticker the feed has filed nothing on yet — a live source that came
              back thin, most often. The terminal says so in its own voice rather
              than drawing an empty box, and the story pane beside it draws its
              own quiet line, so neither pane can throw on a missing story. */}
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
                  data-wire-signal={(item.signal?.length ?? 0) > 0 ? "1" : "0"}
                  onClick={() => open(item)}
                  style={sx(rowStyle(on, desk))}
                >
                  <span style={sx(`font:400 10.5px/1.45 ${MONO};color:${on ? C.textSoft : C.faint};${CLIP}`)}>
                    {item.time}
                  </span>
                  {desk ? (
                    <span
                      style={sx(
                        `font:700 8.5px/1 ${MONO};letter-spacing:.08em;text-align:center;` +
                          // Study's own mapping, kept verbatim: the coach speaks in
                          // accent, the desk in blue.
                          `color:${item.who === "COACH" ? C.accent : C.blue};${CLIP}`,
                      )}
                    >
                      {item.who ?? "DESK"}
                    </span>
                  ) : sym ? (
                    // The token is the wire's own handle on the filter. It sits
                    // inside a row that is itself a click target, so the toggle
                    // stops the event dead: pressing SOL narrows the feed, it does
                    // not also file SOL's story into the pane beside it. Handed no
                    // `onSymToggle`, it renders as the inert label it always was.
                    <span
                      style={sx(
                        symToken(sectorColor(meta(sym).sector), sym === filterSym) +
                          (onSymToggle ? ";cursor:pointer" : ""),
                      )}
                      {...(onSymToggle
                        ? {
                            "data-wire-chip": sym,
                            role: "button",
                            // Off the tab order on purpose: the row already answers
                            // ↑/↓, and forty chips ahead of the story pane would
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
                  {/* Content, in the proportional face — see `rowStyle`. */}
                  <span
                    style={sx(
                      `font:${desk ? "400" : "500"} 12.5px/1.4 ${SANS};` +
                        `color:${on ? C.text : desk ? C.muted : C.textSoft};` +
                        (desk ? "font-style:italic;" : "") +
                        CLIP,
                    )}
                  >
                    {desk ? `“${item.headline}”` : item.headline}
                  </span>
                  {/* The source, on the row, where a wire puts it. */}
                  <span
                    style={sx(
                      `font:400 9px/1 ${MONO};letter-spacing:.06em;color:${C.faint};` +
                        `max-width:130px;text-align:right;${CLIP}`,
                    )}
                  >
                    {item.publisher}
                  </span>
                </div>
              </Fragment>
            );
          })}
        </div>

        {/* RIGHT — the filed story behind the selected line.
            Left-aligned, top to bottom. It used to be centred — the dateline
            centred and bold, the body centred under it, the sign-off centred
            under that — and centred running text is the single strongest visual
            tell of a decorative fake newspaper. A wire is a column of copy: a
            source strip, its own dateline, the body, the sign-off. Nothing was
            dropped to get there; the same four facts are in the same order. */}
        <div
          data-testid="wire-detail"
          style={sx(
            `height:${BODY_H}px;overflow-y:auto;padding:16px 20px 18px;background:${C.panelAlt};` +
              `border-left:1px solid ${C.border}`,
          )}
        >
          {selected ? (
            <>
              <div
                style={sx(
                  `display:flex;align-items:center;gap:8px;padding-bottom:9px;border-bottom:1px solid ${C.line};` +
                    `font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`,
                )}
              >
                <span style={sx(`color:${selected.sym ? sectorColor(meta(selected.sym).sector) : C.dim};font-weight:700`)}>
                  {selected.sym ?? selected.who ?? "MKT"}
                </span>
                <span style={sx(`color:${C.muted};${CLIP}`)}>{selected.publisher}</span>
                <div style={sx("flex:1")} />
                <span style={sx("white-space:nowrap")}>
                  {selected.day ? `${selected.day} · ` : ""}
                  {selected.time} ET
                </span>
              </div>

              {/* The wire's own dateline string, as the wire wrote it. This is
                  the headline line on a real terminal — date, subject, headline
                  in one — so it is drawn as the story's opening line rather than
                  as a centred banner over it. */}
              <div
                data-testid="wire-dateline"
                style={sx(
                  `margin-top:13px;font:700 12px/1.55 ${MONO};color:${C.text};text-wrap:pretty`,
                )}
              >
                {selected.dateline}
              </div>

              <div
                style={sx(`margin-top:11px;font:400 12.5px/1.72 ${SANS};color:${C.muted};text-wrap:pretty`)}
              >
                {selected.body}
              </div>

              {/* Why this row survives PRICE TALK, in the words that matched.
                  Drawn only when there is evidence to show, and phrased as
                  evidence: the terminal never asserts that a story moved a
                  price, because it cannot know that. */}
              {selected.signal && selected.signal.length > 0 ? (
                <div
                  data-testid="wire-signal"
                  style={sx(
                    `margin-top:12px;font:400 10px/1.6 ${MONO};color:${C.blue};text-wrap:pretty;opacity:.85`,
                  )}
                >
                  PRICE TALK · {selected.signal.join(" · ")}
                </div>
              ) : null}

              <div
                style={sx(
                  `margin-top:14px;padding-top:11px;border-top:1px solid ${C.line};` +
                    "display:flex;flex-direction:column;gap:8px",
                )}
              >
                {/* Live items carry a source link; seeded ones never do. It sits
                    in the sign-off block because that is what it is: the last
                    piece of provenance, next to the copyright it belongs to. */}
                {selected.link ? (
                  <a
                    href={selected.link}
                    target="_blank"
                    rel="noreferrer"
                    style={sx(
                      `font:500 10px/1.5 ${MONO};letter-spacing:.06em;color:${C.blue};` +
                        "text-decoration:none;word-break:break-all",
                    )}
                  >
                    READ ON {selected.publisher} ↗
                  </a>
                ) : null}
                <div
                  data-testid="wire-signature"
                  // Kept in full, deliberately. It reads as filler and it is not:
                  // "(END)" is the wire's terminator, and the publisher, the ET
                  // stamp and the copyright holder are this row's provenance —
                  // the difference between a headline this app fetched and a
                  // headline it made up. What changed is that it now looks like
                  // a sign-off instead of like a paragraph: smaller, dimmer,
                  // left-aligned, under the rule rather than floating.
                  style={sx(`font:400 9.5px/1.6 ${MONO};color:${C.faint};text-wrap:pretty`)}
                >
                  {selected.signature}
                </div>
              </div>
            </>
          ) : (
            // Reachable two ways: a filter that emptied the wire, and a source
            // that handed the terminal nothing.
            <div style={sx(`font:400 12px/1.7 ${SANS};color:${C.faint}`)}>
              The wire is quiet. No stories have filed on this board.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
