import { useCallback, useRef } from "react";
import { MARKET_COLOR, MARKET_LABEL, bookFor } from "../data/lobbies.ts";
import { MODES, MODE_ORDER, modeTag } from "../data/modes.ts";
import { SECTORS, SECTOR_ORDER, bookForSectors, symsOfSector } from "../data/sectors.ts";
import { sfx, useSoundHover } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, miniTag, pill, tag } from "../theme.ts";
import type { LobbyForm } from "../state/match.ts";
import type { MarketFilter, Mode, SectorKey } from "../types.ts";

const STEP_BTN =
  `width:34px;height:34px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
  `color:${C.text};font:700 15px/1 ${MONO};cursor:pointer`;

const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;
const NOTE = `margin-top:8px;font:400 10.5px/1.4 ${MONO};color:${C.faint}`;
const CARD = `border:1px solid ${C.border};border-radius:12px;background:${C.panel};padding:18px`;

/** The live book strip: one line, ellipsised — a long book must not reflow the card. */
const BOOK_LINE =
  `margin-top:10px;font:400 10.5px/1.5 ${MONO};color:${C.dim};` +
  `white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;

const MARKETS: readonly MarketFilter[] = ["STOCK", "CRYPTO", "MIXED"];

/** One mode button. The selected one is lit in its own colour — the same
 *  border/tint idiom the sector pills use, one step brighter because the mode
 *  is the only choice on this card that changes the payout. */
const MODE_BTN = (color: string, on: boolean): string =>
  `display:flex;flex-direction:column;align-items:flex-start;gap:7px;min-width:0;` +
  `padding:10px 8px;border-radius:10px;text-align:left;cursor:pointer;` +
  (on
    ? `border:1px solid ${color}80;background:${color}14;box-shadow:0 0 0 1px ${color}26,0 8px 20px -12px ${color}`
    : `border:1px solid ${C.border};background:transparent`);

/** `BLITZ · 15 MIN` on one line inside a ~112px column: the mode tag with its
 *  letter-spacing eased off, so `NORMAL · 24 HOURS` still fits unwrapped. */
const MODE_HEAD = (m: Mode, on: boolean): string =>
  (on ? modeTag(m) : miniTag(C.faint)) + ";letter-spacing:.06em;white-space:nowrap";

const MODE_NUM = (on: boolean): string =>
  `font:500 9.5px/1 ${MONO};color:${on ? C.textSoft : C.dim}`;

/** Legs run 2–4, so the stepper's pitch walks that span. */
const legsPitch = (legs: number) => 1 + ((Math.max(2, Math.min(4, legs)) - 2) / 2) * 0.35;
/** The prize has no useful ceiling, so the walk saturates at a sane pool. */
const prizePitch = (prize: number) => 1 + Math.min(1, Math.max(0, (prize - 0.1) / 19.9)) * 0.35;

/** How long the prize field waits before it will click again while typing. */
const TYPE_SFX_MS = 250;

interface CreateLobbyProps {
  form: LobbyForm;
  entryLabel: string;
  prizeLabel: string;
  onName: (v: string) => void;
  onMarket: (m: MarketFilter) => void;
  onToggleSector: (k: SectorKey) => void;
  onMode: (m: Mode) => void;
  onLegsUp: () => void;
  onLegsDown: () => void;
  onPrizeInput: (raw: string) => void;
  onPrizeBlur: () => void;
  onPrizeUp: () => void;
  onPrizeDown: () => void;
  onPublish: () => void;
  onBack: () => void;
}

/** Four fields, then a card on the board: name, book, legs, prize.
 *
 *  The book is chosen twice over: three presets that select whole markets, and
 *  six sector chips underneath that compose any subset. Both write the same
 *  `sectors` field — the presets are just the common combinations — and the
 *  header tag reflects the market the selection derives to. */
export function CreateLobby(p: CreateLobbyProps) {
  const color = MARKET_COLOR[p.form.market];
  const mode = MODES[p.form.mode];
  const hover = useSoundHover();

  // The book the spin would deal from, recomputed each render — it is a
  // filter over the universe, not state.
  const book = bookForSectors(p.form.sectors);
  const tooSmall = p.form.sectors.length === 0 || book.length < p.form.legs;

  // Keystrokes get one click per quarter second at most: a held key must not
  // machine-gun the mixer, and R11 forbids per-character sounds outright.
  const lastTypeSfx = useRef(0);
  const onPrizeInput = useCallback(
    (raw: string) => {
      const now = Date.now();
      if (now - lastTypeSfx.current > TYPE_SFX_MS) {
        lastTypeSfx.current = now;
        sfx("ui.step");
      }
      p.onPrizeInput(raw);
    },
    [p.onPrizeInput],
  );

  return (
    <div style={sx("padding:24px 28px;max-width:940px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px")}>
        <button
          onClick={() => {
            sfx("ui.back");
            p.onBack();
          }}
          {...hover}
          style={sx(
            `height:32px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;` +
              `background:transparent;color:${C.muted};font:500 12px/1 ${SANS};cursor:pointer`,
          )}
        >
          ← Battles
        </button>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Create lobby</h2>
        <span style={sx(tag(color))}>{MARKET_LABEL[p.form.market]}</span>
        <div style={sx("flex:1")} />
        <span style={sx(LABEL)}>PRIZE POOL</span>
        <span style={sx(`font:700 18px/1 ${MONO};color:${C.accent}`)}>{p.prizeLabel}</span>
      </div>

      <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:18px;align-items:start")}>
        <div style={sx(CARD)}>
          <div style={sx(LABEL)}>LOBBY NAME</div>
          <input
            value={p.form.name}
            onChange={(e) => p.onName(e.target.value)}
            style={sx(
              `width:100%;margin-top:10px;height:38px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;` +
                `background:${C.raised};color:${C.text};font:600 13px/1 ${SANS};outline:none`,
            )}
          />

          <div style={sx(`${LABEL};margin-top:20px`)}>BOOK</div>
          <div style={sx("display:flex;gap:6px;margin-top:10px;flex-wrap:wrap")}>
            {MARKETS.map((m) => (
              <button
                key={m}
                onClick={() => {
                  sfx("ui.toggle.on");
                  p.onMarket(m);
                }}
                {...hover}
                style={sx(pill(p.form.market === m))}
              >
                {MARKET_LABEL[m]}
                <span style={sx(`margin-left:6px;color:${C.faint}`)}>{bookFor(m).length}</span>
              </button>
            ))}
          </div>
          <div style={sx(NOTE)}>
            The spin deals both players' legs from this book. Neither of you picks a ticker.
          </div>

          <div style={sx(`${LABEL};margin-top:20px`)}>SECTORS</div>
          <div style={sx("display:flex;gap:6px;margin-top:10px;flex-wrap:wrap")}>
            {SECTOR_ORDER.map((k) => (
              <button
                key={k}
                data-sector={k}
                aria-pressed={p.form.sectors.includes(k)}
                onClick={() => {
                  sfx("ui.toggle.on");
                  p.onToggleSector(k);
                }}
                {...hover}
                style={sx(pill(p.form.sectors.includes(k)))}
              >
                {SECTORS[k].label}
                <span style={sx(`margin-left:6px;color:${C.faint}`)}>{symsOfSector(k).length}</span>
              </button>
            ))}
          </div>
          <div data-book style={sx(BOOK_LINE)} title={book.join(" · ")}>
            book: {book.length} names{book.length > 0 ? ` — ${book.join(" · ")}` : ""}
          </div>

          <div style={sx(`${LABEL};margin-top:20px`)}>LEGS</div>
          <div style={sx("display:flex;align-items:center;gap:10px;margin-top:10px")}>
            <button
              onClick={() => {
                sfx("ui.step", { pitch: legsPitch(p.form.legs - 1) });
                p.onLegsDown();
              }}
              style={sx(STEP_BTN)}
            >
              −
            </button>
            <span style={sx(`min-width:40px;text-align:center;font:700 20px/1 ${MONO}`)}>{p.form.legs}</span>
            <button
              onClick={() => {
                sfx("ui.step", { pitch: legsPitch(p.form.legs + 1) });
                p.onLegsUp();
              }}
              style={sx(STEP_BTN)}
            >
              +
            </button>
            <span style={sx(`font:400 10.5px/1 ${MONO};color:${C.faint}`)}>2 to 4 · both slips run on the same {p.form.legs}</span>
          </div>
        </div>

        <div style={sx(CARD)}>
          <div style={sx(LABEL)}>PRIZE POOL (ETH)</div>
          <div style={sx("display:flex;align-items:center;gap:10px;margin-top:10px")}>
            <button
              onClick={() => {
                sfx("ui.step", { pitch: prizePitch(p.form.prize - 0.5) });
                p.onPrizeDown();
              }}
              style={sx(STEP_BTN)}
            >
              −
            </button>
            <input
              value={p.form.prizeText}
              inputMode="decimal"
              onChange={(e) => onPrizeInput(e.target.value)}
              onBlur={p.onPrizeBlur}
              style={sx(
                `flex:1;height:38px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;text-align:center;` +
                  `background:${C.raised};color:${C.accent};font:700 18px/1 ${MONO};outline:none`,
              )}
            />
            <button
              onClick={() => {
                sfx("ui.step", { pitch: prizePitch(p.form.prize + 0.5) });
                p.onPrizeUp();
              }}
              style={sx(STEP_BTN)}
            >
              +
            </button>
          </div>
          <div style={sx(NOTE)}>
            Adjustable until the lobby is published. Once public the prize is locked for whoever
            takes the seat.
          </div>

          <div style={sx(`${LABEL};margin-top:20px`)}>ENTRY PER PLAYER</div>
          <div style={sx(`margin-top:10px;font:700 24px/1 ${MONO}`)}>{p.entryLabel}</div>
          <div style={sx(NOTE)}>Half the pool each. Winner takes the full pool.</div>
          {mode.oddsBoost > 1 && (
            <div data-boost style={sx(`margin-top:6px;font:500 10.5px/1.4 ${MONO};color:${mode.color}`)}>
              winner takes {p.prizeLabel} · payout boost ×{mode.oddsBoost.toFixed(2)}
            </div>
          )}

          <div style={sx(`${LABEL};margin-top:20px`)}>MODE</div>
          <div style={sx("display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;margin-top:10px")}>
            {MODE_ORDER.map((m) => {
              const s = MODES[m];
              const on = p.form.mode === m;
              return (
                <button
                  key={m}
                  data-mode={m}
                  aria-pressed={on}
                  onClick={() => {
                    sfx("ui.toggle.on");
                    p.onMode(m);
                  }}
                  {...hover}
                  style={sx(MODE_BTN(s.color, on))}
                >
                  <span style={sx(MODE_HEAD(m, on))}>
                    {s.label} · {s.duration}
                  </span>
                  <span style={sx(MODE_NUM(on))}>targets ×{s.targetScale.toFixed(2)}</span>
                  <span style={sx(MODE_NUM(on))}>payout ×{s.oddsBoost.toFixed(2)}</span>
                </button>
              );
            })}
          </div>
          <div style={sx(NOTE)}>{mode.blurb}</div>

          <button
            onClick={() => {
              sfx("lobby.publish");
              p.onPublish();
            }}
            disabled={tooSmall}
            style={sx(
              `width:100%;height:40px;margin-top:22px;border:none;border-radius:8px;` +
                `font:700 13px/1 ${SANS};` +
                (tooSmall
                  ? `background:${C.line};color:${C.faint};cursor:not-allowed`
                  : `background:${C.accent};color:${C.bg};cursor:pointer`),
            )}
          >
            Publish lobby · {p.prizeLabel}
          </button>
          {tooSmall && (
            <div data-gate style={sx(`${NOTE};color:${C.red}`)}>
              book too small for {p.form.legs} legs — add a sector
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
