import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { sx, sxWith } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import { DASH, type Ticket, type TicketSource } from "../desk/ticket.ts";

/**
 * The trade ticket, as a surface — one panel, and the three ways to open it.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHAT THIS IS FOR
 * ────────────────────────────────────────────────────────────────────────────
 * A parlay card and an arena zone are both real option positions, and both are
 * drawn as tiles. The tile is small on purpose — the face is six quantities and
 * the box is a rectangle — so neither can carry what a person actually needs to
 * place the trade: the contract's own name, its expiry and the time left on it,
 * the premium **as** the max loss, the breakeven, the payoff's shape and
 * ceiling, and the four risk numbers with their windows and their provenance.
 *
 * This is where those live, and the shape is a broker's order ticket rather
 * than a help bubble: the contract first, the money second, the greeks third,
 * one clause of explanation each. `src/desk/ticket.ts` builds the content and
 * decides what may honestly be said; this file only puts it on screen.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE INTERACTION, AND WHY EACH PART
 * ────────────────────────────────────────────────────────────────────────────
 * Hover is the trigger the owner asked for, and it cannot be the only one:
 *
 *  - **Pointer.** `pointerenter` opens after {@link TICKET_DELAY_MS}, so a
 *    pointer crossing a four-column grid on its way somewhere else does not
 *    strobe eight panels. `pointerleave` closes.
 *  - **Keyboard.** `focus` opens immediately, and only on `:focus-visible` — a
 *    click already focuses the card and the pointer path has said its piece.
 *    `blur` closes. Nothing is trapped: the panel is not focusable, it is not
 *    in the tab order, and Tab moves on exactly as it would without it.
 *  - **Touch.** A pointer whose `pointerType` is not `mouse` **pins** instead of
 *    hovering, because a touch's `pointerenter` is immediately followed by its
 *    `pointerleave` and the panel would flash. A pinned panel stays until it is
 *    tapped again, Escape is pressed, or a pointer goes down outside it.
 *
 * Two placement rules, both of them the owner's:
 *
 *  - **It never covers the thing being inspected.** The panel is placed beside
 *    the trigger's own rect — right if there is room, left if there is not —
 *    and clamped into the viewport vertically. The tile stays readable while
 *    its ticket is up, which is the whole point of a ticket about it.
 *  - **It cannot flicker on the way to it.** The panel is `pointer-events:none`
 *    while hovering, so there is nothing to move *to*: crossing the gap cannot
 *    close it because the gap is not a boundary the panel participates in. Only
 *    a pinned panel takes the pointer, and a pinned panel does not close on
 *    leave.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE SECOND THING ON THIS PANEL: A FIELD NOTE
 * ────────────────────────────────────────────────────────────────────────────
 * The arena's parameters panel printed its explanatory prose inline under every
 * figure, so `SIZE` / `MAX LOSS` / `MAX PAYOUT` were three headings in six
 * paragraphs. The owner asked for the explanations to sit behind a per-figure
 * `ⓘ` instead, and the temptation was a small second tooltip — which would have
 * been this app's third hover mechanism and the only one without a settle
 * delay, a keyboard path, a touch path, an Escape or a viewport flip.
 *
 * So there is no second mechanism. A *field note* is a {@link Ticket} with no
 * rows and no footer (`fieldNote` in `src/desk/ticket.ts`), {@link FieldInfo}
 * is a `<button>` wired to the same {@link TradeTicketHost.bind}, and
 * {@link TradeTicketPanel} renders it with two `length > 0` guards and nothing
 * else new. What may go in one is a rule of the content module's, not this
 * one's: definitions only, because a disclosure behind a hover is a disclosure
 * a player may never perform.
 *
 * `prefers-reduced-motion` is honoured through `.vc-tip` in `styles.css`, which
 * animates opacity only and is switched off entirely under the query. The panel
 * carries no transform of its own for the same reason the sector tip does not:
 * its placement *is* its transform, and a keyframe touching it would fling it
 * off its anchor.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Geometry
// ─────────────────────────────────────────────────────────────────────────────

/** Wide enough for a figure and its clause on one or two lines, narrow enough
 *  to sit beside a card in a four-column grid at 1280. */
export const TICKET_W = 340;

/** Long enough that a pointer crossing a row of cards does not open eight
 *  panels on the way past. The same 120ms the sector tip settled on, shaved a
 *  little because a card is a much larger target than a chip. */
export const TICKET_DELAY_MS = 90;

/** The gap between the trigger's edge and the panel. */
const GAP = 10;

/** Below this much room to the right, the panel flips to the left. */
const FLIP_MARGIN = TICKET_W + GAP + 8;

/**
 * The tallest a ticket may be, in pixels.
 *
 * A full live ticket is thirteen rows with a clause each, which lands around
 * 830px. This is the ceiling for the window that has room; a shorter window
 * gets `vh - 16` instead and the panel scrolls. It is computed rather than left
 * to CSS because the *placement* has to know it: a panel top-aligned with a
 * card two thirds down the page and then clipped at the fold would put the
 * greeks off screen with no way to reach them.
 */
const TICKET_MAX_H = 900;

/** The panel's height budget and where its top goes, for one trigger rect. */
function placeFor(rect: { top: number }, vh: number): { top: number; maxH: number } {
  const maxH = Math.min(vh - 16, TICKET_MAX_H);
  // Prefer top-aligned with the trigger; slide up only as far as fitting the
  // budget requires, and never above the viewport.
  const top = Math.max(8, Math.min(rect.top, vh - 8 - maxH));
  return { top, maxH };
}

const PANEL = (accent: string, pinned: boolean): string =>
  `position:fixed;z-index:70;width:${TICKET_W}px;max-width:calc(100vw - 20px);` +
  `overflow:auto;` +
  `padding:12px 13px;border-radius:11px;pointer-events:${pinned ? "auto" : "none"};` +
  `background:rgba(9,9,11,.985);border:1px solid ${C.border};border-left:3px solid ${accent};` +
  `box-shadow:0 22px 54px rgba(0,0,0,.72)`;

/** Where a panel sits, in viewport coordinates. */
interface TicketAt {
  ticket: Ticket;
  left: number;
  top: number;
  /** The height budget this placement gave it. */
  maxH: number;
  /** Pinned by a tap or a click: it takes the pointer and survives a leave. */
  pinned: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Colour
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The panel's left edge, and the tag beside every figure.
 *
 * Deliberately the state vocabulary's own colours rather than a fifth palette:
 * a ticket about a listed contract is green because that is what LIVE is, and a
 * ticket about a game fixture is the resting grey SEEDED wears everywhere else
 * on this app. A reader who has learned the chips has already learned this.
 */
export const TICKET_ACCENT: Record<Ticket["state"], string> = {
  live: C.green,
  seeded: C.dim,
  "not-dealt": C.amber,
  // A field note makes no claim about a market, so it borrows no state colour.
  // Grey is the absence of the vocabulary rather than a fourth entry in it.
  note: C.muted,
};

/** What a provenance tag says and what colour it says it in. The words are
 *  short because they ride beside a number, and they are never abbreviations a
 *  reader has to expand: "venue" and "model" are the two facts. */
export const SOURCE_TAG: Record<TicketSource, { label: string; color: string }> = {
  venue: { label: "venue", color: C.green },
  model: { label: "model", color: C.blue },
  derived: { label: "derived", color: C.muted },
  game: { label: "game", color: C.amber },
};

// ─────────────────────────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────────────────────────

export function TradeTicketPanel({ at }: { at: TicketAt }) {
  const t = at.ticket;
  const accent = TICKET_ACCENT[t.state];
  return (
    <div
      data-trade-ticket={t.id}
      data-ticket-state={t.state}
      className="vc-tip"
      role="tooltip"
      id={`ticket-${t.id}`}
      style={sxWith(PANEL(accent, at.pinned), {
        left: `${at.left}px`,
        top: `${at.top}px`,
        maxHeight: `${at.maxH}px`,
      })}
    >
      <div style={sx(`font:700 12px/1.2 ${MONO};letter-spacing:.02em;color:${C.text}`)}>
        {t.title}
      </div>
      <div
        data-ticket-subtitle=""
        style={sx(`margin-top:4px;font:500 9.5px/1.3 ${MONO};letter-spacing:.06em;color:${accent}`)}
      >
        {t.subtitle}
      </div>

      {/* The claim the numbers below rest on, above the numbers. On a seeded
          ticket this is the sentence that says there is nothing to buy, and it
          is first so it cannot be read after the figures it qualifies. */}
      <div
        data-ticket-banner=""
        style={sx(
          `margin-top:8px;padding:6px 8px;border-radius:6px;` +
            `background:${accent}14;border:1px solid ${accent}3d;` +
            `font:500 10px/1.45 ${SANS};color:${C.textSoft};text-wrap:pretty`,
        )}
      >
        {t.banner}
      </div>

      {/* The rest of the same prose, when there is any. Only a field note fills
          it, and it is outside the banner's tinted block rather than inside it
          because the block is the *claim* the figures rest on — a second
          paragraph of definition is not a second claim. */}
      {(t.body ?? []).map((line) => (
        <div
          key={line.slice(0, 24)}
          data-ticket-body=""
          style={sx(
            `margin-top:8px;font:400 10.5px/1.55 ${SANS};color:${C.textSoft};text-wrap:pretty`,
          )}
        >
          {line}
        </div>
      ))}

      {t.rows.length > 0 && (
      <div style={sx("margin-top:8px;display:flex;flex-direction:column;gap:7px")}>
        {t.rows.map((row) => {
          const tag = row.source === null ? null : SOURCE_TAG[row.source];
          const absent = row.value === DASH;
          return (
            <div key={row.key} data-ticket-row={row.key} style={sx("display:grid;gap:2px")}>
              <div style={sx("display:flex;align-items:baseline;gap:6px")}>
                <span
                  style={sx(
                    `font:500 8.5px/1 ${MONO};letter-spacing:.12em;color:${C.dim};` +
                      "white-space:nowrap",
                  )}
                >
                  {row.label}
                </span>
                <div style={sx("flex:1")} />
                {tag && (
                  <span
                    data-ticket-source={row.source ?? ""}
                    style={sx(
                      `font:500 8px/1 ${MONO};letter-spacing:.1em;color:${tag.color};` +
                        `border:1px solid ${tag.color}44;border-radius:4px;padding:2px 4px`,
                    )}
                  >
                    {tag.label}
                  </span>
                )}
              </div>
              <div
                data-ticket-value={row.key}
                style={sx(
                  `font:700 12.5px/1.25 ${MONO};color:${absent ? C.faint : C.text};` +
                    "word-break:break-word",
                )}
              >
                {row.value}
              </div>
              <div style={sx(`font:400 9.5px/1.4 ${SANS};color:${C.muted};text-wrap:pretty`)}>
                {row.note}
              </div>
            </div>
          );
        })}
      </div>
      )}

      {/* Both blocks are guarded rather than left to render empty: a field note
          has neither rows nor footer, and an unguarded footer would draw its
          divider rule under nothing — a hairline that reads as content the
          panel failed to load. */}
      {t.footer.length > 0 && (
      <div
        style={sx(`margin-top:10px;padding-top:9px;border-top:1px solid ${C.line};display:grid;gap:6px`)}
      >
        {t.footer.map((line) => (
          <span
            key={line.slice(0, 24)}
            data-ticket-footer=""
            style={sx(`font:400 9.5px/1.5 ${SANS};color:${C.faint};text-wrap:pretty`)}
          >
            {line}
          </span>
        ))}
      </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The host
// ─────────────────────────────────────────────────────────────────────────────

export interface TradeTicketHost {
  /**
   * Spread onto the trigger — the card's own `<button>`, a zone chip, the box.
   *
   * Additive: it adds four handlers and one ARIA attribute and touches nothing
   * else, so a trigger keeps whatever it already did. A caller that already has
   * an `onPointerEnter` (the parlay card plays a sound on one) composes it
   * itself rather than having this file guess the order.
   */
  bind: (ticket: Ticket) => {
    onPointerEnter: (e: { currentTarget: HTMLElement; pointerType?: string }) => void;
    onPointerLeave: () => void;
    onFocus: (e: { currentTarget: HTMLElement }) => void;
    onBlur: () => void;
    "aria-describedby": string | undefined;
  };
  /**
   * Pin a ticket open from an explicit press — {@link TicketToggle}'s action,
   * and the touch path's.
   *
   * Toggles: pressing the open ticket's own control closes it, which is what
   * makes one control both the way in and the way out on a screen with no
   * hover.
   */
  pin: (ticket: Ticket, el: HTMLElement) => void;
  /** Render once, anywhere — it is `position:fixed`, so its place in the tree
   *  does not affect where it lands. `null` when nothing is open. */
  panel: ReactNode;
  /** The open ticket's id, or `null`. Exposed so a trigger can mark itself. */
  openId: string | null;
}

/**
 * One panel per screen, and the state that decides what is in it.
 *
 * A hook rather than a wrapper component because the panel has to escape every
 * `overflow` and stacking context between a card and the page — the parlay grid
 * is inside a bordered section inside a two-column grid — and the cheapest way
 * to guarantee that without a portal is one `position:fixed` element rendered
 * at the view's root. `CreateLobby` reached the same conclusion for the sector
 * tip; this is that pattern with a second trigger mode.
 */
export function useTradeTicket(): TradeTicketHost {
  const [at, setAt] = useState<TicketAt | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const close = useCallback(() => {
    clear();
    setAt((cur) => (cur && cur.pinned ? cur : null));
  }, [clear]);

  const unpin = useCallback(() => {
    clear();
    setAt(null);
  }, [clear]);

  /**
   * Read the rect now, while the trigger is under the pointer, and let only the
   * state write wait out the delay — the element may have scrolled by the time
   * the timer fires, and a panel placed against a stale rect is worse than one
   * that never opened.
   */
  const place = useCallback((ticket: Ticket, el: HTMLElement, pinned: boolean) => {
    const r = el.getBoundingClientRect();
    const vw = typeof window === "undefined" ? TICKET_W + 40 : window.innerWidth;
    const vh = typeof window === "undefined" ? 800 : window.innerHeight;
    const roomRight = vw - r.right;
    const left =
      roomRight >= FLIP_MARGIN
        ? r.right + GAP
        : Math.max(8, Math.min(r.left - TICKET_W - GAP, vw - TICKET_W - 8));
    const { top, maxH } = placeFor(r, vh);
    return { ticket, left, top, maxH, pinned };
  }, []);

  const open = useCallback(
    (ticket: Ticket, el: HTMLElement, delay: number) => {
      const next = place(ticket, el, false);
      clear();
      if (delay <= 0) {
        setAt((cur) => (cur && cur.pinned ? cur : next));
        return;
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        setAt((cur) => (cur && cur.pinned ? cur : next));
      }, delay);
    },
    [clear, place],
  );

  const pin = useCallback(
    (ticket: Ticket, el: HTMLElement) => {
      clear();
      setAt((cur) => (cur && cur.pinned && cur.ticket.id === ticket.id ? null : place(ticket, el, true)));
    },
    [clear, place],
  );

  // Escape closes a pinned panel, and a pointer going down anywhere outside it
  // does too. Neither is a focus trap: nothing is captured, nothing is
  // prevented, and the panel is not in the tab order at all.
  useEffect(() => {
    if (!at?.pinned) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") unpin();
    };
    const onDown = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest?.("[data-trade-ticket],[data-ticket-toggle]")) return;
      unpin();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onDown, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onDown, true);
    };
  }, [at?.pinned, unpin]);

  useEffect(() => () => clear(), [clear]);

  const bind = useCallback(
    (ticket: Ticket) => ({
      onPointerEnter: (e: { currentTarget: HTMLElement; pointerType?: string }) => {
        // A touch fires `pointerenter` and then `pointerleave` on release, so
        // hovering it would flash. Touch pins instead, which is also the only
        // gesture a touch screen has for "tell me more without doing the thing".
        if (e.pointerType !== undefined && e.pointerType !== "mouse") {
          pin(ticket, e.currentTarget);
          return;
        }
        open(ticket, e.currentTarget, TICKET_DELAY_MS);
      },
      onPointerLeave: close,
      onFocus: (e: { currentTarget: HTMLElement }) => {
        // Every focus, with no delay. `CreateLobby`'s sector tip gates its own
        // on `:focus-visible` so a click does not also pop a tooltip; here the
        // gate would cost more than it saves. A click on a card arrives with
        // the pointer already on it, so the hover path has the panel up
        // anyway — the guard would suppress nothing a user would notice, and
        // `:focus-visible` is unimplemented in enough environments (including
        // this repo's test DOM) that gating on it makes the keyboard path
        // silently unreachable exactly where it most needs proving.
        open(ticket, e.currentTarget, 0);
      },
      onBlur: close,
      "aria-describedby": at?.ticket.id === ticket.id ? `ticket-${ticket.id}` : undefined,
    }),
    [at?.ticket.id, close, open, pin],
  );

  return {
    bind,
    pin,
    panel: at ? <TradeTicketPanel at={at} /> : null,
    openId: at?.ticket.id ?? null,
  };
}

/**
 * The explicit affordance, for touch and for anyone who would rather press a
 * thing than hover one.
 *
 * A sibling of the trigger rather than a child, because the parlay card is a
 * `<button>` and a button inside a button is invalid HTML that browsers repair
 * by unnesting — which would move it out of the card and break the grid. The
 * caller positions it; this only knows what it says and what it toggles.
 */
export function TicketToggle({
  id,
  open,
  onToggle,
  style,
}: {
  id: string;
  open: boolean;
  onToggle: (el: HTMLElement) => void;
  style?: string;
}) {
  return (
    <button
      type="button"
      data-ticket-toggle={id}
      aria-expanded={open}
      aria-label="Trade details"
      onClick={(e) => {
        e.stopPropagation();
        onToggle(e.currentTarget);
      }}
      style={sx(
        `${style ?? ""};display:grid;place-items:center;width:17px;height:17px;padding:0;` +
          `border-radius:99px;cursor:pointer;font:700 10px/1 ${MONO};` +
          `border:1px solid ${open ? C.accent : C.borderMid};` +
          `background:${open ? C.accent : "transparent"};color:${open ? C.bg : C.dim}`,
      )}
    >
      i
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The per-figure ⓘ
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The hit target, in pixels — the whole button, ring and padding together.
 *
 * The `ⓘ` sits in a dense column of ten-pixel labels and the pull is to shrink
 * it to match. It does not shrink: a control a person is meant to find and
 * press has to be pressable with a thumb, and 26px is already at the low end of
 * what a touch screen forgives. The *ring* is small; the button is not, and the
 * difference is invisible padding.
 */
export const FIELD_INFO_HIT = 26;

/**
 * One figure's `ⓘ` — a real control, on the ticket's own interaction.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY IT IS A BUTTON AND IN THE TAB ORDER
 * ────────────────────────────────────────────────────────────────────────────
 * The parlay card's hover ticket is deliberately *not* focusable: the card
 * itself is the trigger, it is already a `<button>`, and the panel it opens is
 * a description of the thing under the cursor. This is the other case. There is
 * no surrounding control to hang the description on — `MAX LOSS` is a `<span>`
 * and a figure is a `<span>` — so if the `ⓘ` were not itself focusable the
 * explanation would be reachable by pointer alone. So it is a `<button>`, it
 * takes a tab stop, and its accessible name names its own field: forty panels
 * of "More info" is a tab order that says nothing.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THREE WAYS IN, AND WHY THERE IS NO `onClick`
 * ────────────────────────────────────────────────────────────────────────────
 * Hover, focus and tap all come from {@link TradeTicketHost.bind}, unchanged —
 * the settle delay, the instant keyboard open, the touch pin, Escape, the
 * outside-pointerdown and the viewport flip are all already correct there and
 * none of it is reimplemented.
 *
 * What is *not* wired is a click handler, and that is the one deliberate
 * difference from {@link TicketToggle}. `bind`'s pointer path already pins on a
 * non-mouse pointer, and a touch fires `pointerover` and *then* a compatibility
 * `click`: pinning on both would open the panel and close it again inside one
 * tap. `TicketToggle` can afford `onClick` because it has no `bind` on it;
 * this cannot have both, and the pointer path is the one that also serves the
 * mouse. A tap pins, a second tap unpins, Escape unpins, a press outside
 * unpins — which is the whole of what a click would have bought.
 *
 * `data-ticket-toggle` is set for exactly one reason: the outside-pointerdown
 * listener treats anything carrying it as inside, so moving from one open note
 * to the next replaces the panel instead of closing it and opening it again.
 */
export function FieldInfo({
  host,
  note,
  label,
  style,
}: {
  host: TradeTicketHost;
  /** Built by `fieldNote` in `src/desk/ticket.ts`. Its `id` is the panel's. */
  note: Ticket;
  /** The figure's heading, for the accessible name. `MAX LOSS` reads out as
   *  "What MAX LOSS means", which is the question the control answers. */
  label: string;
  style?: string;
}) {
  const open = host.openId === note.id;
  const bound = host.bind(note);
  return (
    <button
      type="button"
      data-field-info={note.id}
      data-ticket-toggle={note.id}
      aria-label={`What ${label} means`}
      aria-expanded={open}
      aria-describedby={bound["aria-describedby"]}
      onPointerEnter={bound.onPointerEnter}
      onPointerLeave={bound.onPointerLeave}
      onFocus={bound.onFocus}
      onBlur={bound.onBlur}
      style={sx(
        `${style ?? ""};display:grid;place-items:center;padding:0;` +
          `width:${FIELD_INFO_HIT}px;height:${FIELD_INFO_HIT}px;` +
          "background:transparent;border:0;cursor:pointer",
      )}
    >
      {/* The ring is a child rather than the button's own border so the target
          can be 26px while the mark stays 16px — a 26px circle beside a 10px
          label would read as a control the figure belongs to. */}
      <span
        aria-hidden="true"
        style={sx(
          `display:grid;place-items:center;width:16px;height:16px;border-radius:99px;` +
            `font:700 10px/1 ${MONO};` +
            `border:1px solid ${open ? C.accent : C.borderMid};` +
            `background:${open ? C.accent : "transparent"};color:${open ? C.bg : C.dim}`,
        )}
      >
        i
      </span>
    </button>
  );
}
