import { useCallback, useEffect, useRef, useState } from "react";
import {
  LARGE_STAKE_USDC,
  MIN_STAKE_USDC,
  parseStakeUsdc,
  usd as usdcText,
} from "../desk/escrow.ts";
import type { DuelStake } from "../state/stake.ts";
import { MARKET_COLOR, MARKET_LABEL, bookFor } from "../data/lobbies.ts";
import { MODES, MODE_ORDER, modeTag } from "../data/modes.ts";
import { SECTORS, SECTOR_ORDER, bookForSectors, symsOfSector } from "../data/sectors.ts";
import { sfx, useSoundHover } from "../lib/sound/index.ts";
import { sx, sxWith } from "../lib/sx.ts";
import { C, MONO, SANS, miniTag, pill, tag } from "../theme.ts";
import type { LobbyForm } from "../state/match.ts";
import type { MarketFilter, Mode, SectorKey } from "../types.ts";

const STEP_BTN =
  `width:34px;height:34px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
  `color:${C.text};font:700 15px/1 ${MONO};cursor:pointer`;

const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;
const NOTE = `margin-top:8px;font:400 10.5px/1.4 ${MONO};color:${C.faint}`;
/** A column card. `min-width:0` is load-bearing: without it a grid child floors
 *  at its content width and the row overflows the viewport instead of shrinking
 *  (and the book line's ellipsis never engages). */
const CARD =
  `border:1px solid ${C.border};border-radius:12px;background:${C.panel};padding:18px;min-width:0`;

/** Two columns while both fit, one column below that — `auto-fit` folds the
 *  empty track away and `min(100%,…)` keeps the floor under the viewport, so
 *  the page never scrolls sideways. */
const COLUMNS =
  "display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,400px),1fr));gap:18px;align-items:start";

/** The live book strip: one line, ellipsised — a long book must not reflow the card. */
const BOOK_LINE =
  `margin-top:10px;font:400 10.5px/1.5 ${MONO};color:${C.dim};` +
  `min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis`;

const MARKETS: readonly MarketFilter[] = ["STOCK", "CRYPTO", "MIXED"];

/** One mode button. The selected one is lit in its own colour — the same
 *  border/tint idiom the sector pills use, one step brighter because the mode
 *  is the only choice on this card that changes the payout. */
const MODE_BTN = (color: string, on: boolean): string =>
  `display:flex;flex-direction:column;align-items:flex-start;gap:7px;min-width:0;overflow:hidden;` +
  `padding:10px 8px;border-radius:10px;text-align:left;cursor:pointer;` +
  (on
    ? `border:1px solid ${color}80;background:${color}14;box-shadow:0 0 0 1px ${color}26,0 8px 20px -12px ${color}`
    : `border:1px solid ${C.border};background:transparent`);

/** `BLITZ · 15 MIN` on one line inside a ~112px column: the mode tag with its
 *  letter-spacing eased off, so `NORMAL · 24 HOURS` still fits unwrapped. */
const MODE_HEAD = (m: Mode, on: boolean): string =>
  (on ? modeTag(m) : miniTag(C.faint)) +
  ";letter-spacing:.06em;white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis";

const MODE_NUM = (on: boolean): string =>
  `font:500 9.5px/1 ${MONO};color:${on ? C.textSoft : C.dim}`;

/** Legs run 2–4, so the stepper's pitch walks that span. */
const legsPitch = (legs: number) => 1 + ((Math.max(2, Math.min(4, legs)) - 2) / 2) * 0.35;
/** The prize has no useful ceiling, so the walk saturates at a sane pool. */
const prizePitch = (prize: number) => 1 + Math.min(1, Math.max(0, (prize - 0.1) / 19.9)) * 0.35;

/** How long the prize field waits before it will click again while typing. */
const TYPE_SFX_MS = 250;

// ── The sector tooltip ──────────────────────────────────────────────────────
// SECTORS is a hand-drawn taxonomy — OLD WORLD and MAJORS are our words, not
// the tape's — so every chip has to be able to say what it gathers. The panel
// is `position:fixed` and measured off the chip's own rect: it costs the chips
// no layout, it cannot be clipped by the card, and it flips under a chip that
// sits too near the top edge to hang a panel above.

const TIP_W = 264;
/** Long enough that a pointer crossing the row does not strobe six panels. */
const TIP_DELAY_MS = 120;
/** Below this much room overhead, the panel flips under the chip. */
const TIP_FLIP_PX = 170;

const TIP_PANEL = (color: string): string =>
  `position:fixed;z-index:60;width:${TIP_W}px;max-width:calc(100vw - 20px);` +
  `padding:10px 12px;border-radius:10px;pointer-events:none;` +
  `background:rgba(11,11,13,.97);border:1px solid ${C.border};border-left:3px solid ${color};` +
  `box-shadow:0 18px 44px rgba(0,0,0,.6)`;

/** `:focus-visible` is unimplemented in some test DOMs, where `matches` throws
 *  on the selector rather than returning false. */
function focusVisible(el: HTMLElement): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return false;
  }
}

interface TipAt {
  key: SectorKey;
  /** Viewport coords of the chip's top/bottom centre. */
  x: number;
  y: number;
  below: boolean;
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE SIDE BET'S AMOUNT — A WARNING, NOT A CAP
 * ────────────────────────────────────────────────────────────────────────────
 *
 * `contracts/DuelEscrow.sol` has a `MIN_STAKE` of $0.10 and, by the owner's
 * explicit and documented decision, **no maximum**. The contract's own natspec
 * states the risk that comes with that (uncapped plus unaudited means a bug
 * risks whatever players choose to stake) and names the compensating controls.
 *
 * This field honours both halves. The floor is enforced, because it is a
 * constant in the contract and a transaction under it simply reverts
 * `stake too small`. The ceiling is **not** enforced, because the owner said
 * there is not one — above $20 the field says so, loudly, and still lets the
 * number through. A warning that quietly behaved like a cap would be a cap
 * someone had to discover.
 *
 * The text is local state so a half-typed `0.` survives until it parses, the
 * same shape the prize field uses for the same reason. Nothing is rounded: a
 * seventh decimal is refused rather than truncated, because USDC has six and
 * silently dropping a digit changes what someone typed.
 */
function StakeField({ stake }: { stake: DuelStake | undefined }) {
  const [text, setText] = useState(() =>
    stake ? usdcText(stake.amount).replace("$", "") : "1.00",
  );

  if (!stake?.available) return null;

  const parsed = parseStakeUsdc(text);
  const tooSmall = parsed !== null && parsed < MIN_STAKE_USDC;
  const large = parsed !== null && parsed > LARGE_STAKE_USDC;

  return (
    <div data-stake-field="">
      <div style={sx(`${LABEL};margin-top:20px`)}>SIDE BET PER PLAYER (USDC)</div>
      <div style={sx("display:flex;align-items:center;gap:10px;margin-top:10px")}>
        <span style={sx(`font:700 18px/1 ${MONO};color:${C.dim}`)}>$</span>
        <input
          data-stake-input=""
          value={text}
          inputMode="decimal"
          onChange={(e) => {
            const raw = e.target.value;
            setText(raw);
            const next = parseStakeUsdc(raw);
            // Only a legal stake is committed. An illegal one leaves the last
            // legal amount in place, so the room can never be handed a number
            // the escrow would refuse.
            if (next !== null && next >= MIN_STAKE_USDC) stake.setAmount(next);
          }}
          style={sx(
            `flex:1;min-width:0;height:38px;padding:0 12px;border:1px solid ${
              tooSmall ? C.red : C.borderMid
            };border-radius:8px;text-align:center;` +
              `background:${C.raised};color:${C.text};font:700 18px/1 ${MONO};outline:none`,
          )}
        />
      </div>
      <div style={sx(NOTE)}>
        On-chain, in USDC, and entirely separate from the PTS pool above. Both players stake the
        same amount; the winner takes the pot less the escrow's 4% rake.
      </div>
      {tooSmall && (
        <div data-stake-gate style={sx(`${NOTE};color:${C.red}`)}>
          the escrow's MIN_STAKE is {usdcText(MIN_STAKE_USDC)} — anything less reverts on chain
        </div>
      )}
      {large && (
        <div data-stake-warning style={sx(`${NOTE};color:${C.amber}`)}>
          large stake — above {usdcText(LARGE_STAKE_USDC)}. There is no cap by the owner's
          decision, and this contract is unaudited: a bug would risk the whole amount, and there
          is no admin who could rescue it. Stake accordingly.
        </div>
      )}
    </div>
  );
}

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
  /**
   * The optional USDC side bet, for its amount only.
   *
   * The stake is **not** a `LobbyForm` field. It is deliberately kept out of
   * `src/state/match.ts` and out of `LobbyDef`: the form and the lobby are the
   * PTS game's own model, they are pinned by `test/determinism.test.ts` and
   * `test/app.test.tsx`, and threading a dollar amount through them would put a
   * second currency inside the structure that decides what a duel deals and
   * pays. The side bet is a session-level setting held by `useDuelStake`, read
   * here and read again in the room, and the two are the same object.
   *
   * Absent — every default build, every test — this card renders exactly the
   * DOM it rendered before staking existed.
   */
  stake?: DuelStake;
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
  // Which chip is explaining itself, and where its panel lands. Null until a
  // pointer has rested on a chip for TIP_DELAY_MS.
  const [tip, setTip] = useState<TipAt | null>(null);
  const tipTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeTip = useCallback(() => {
    if (tipTimer.current !== null) {
      clearTimeout(tipTimer.current);
      tipTimer.current = null;
    }
    setTip(null);
  }, []);

  // The rect is read now, while the chip is under the pointer; only the state
  // write waits out the delay.
  const openTip = useCallback((k: SectorKey, el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    const half = TIP_W / 2;
    const right = Math.max(half + 10, window.innerWidth - half - 10);
    const x = Math.min(Math.max(r.left + r.width / 2, half + 10), right);
    const below = r.top < TIP_FLIP_PX;
    const y = below ? r.bottom + 8 : r.top - 8;
    if (tipTimer.current !== null) clearTimeout(tipTimer.current);
    tipTimer.current = setTimeout(() => {
      tipTimer.current = null;
      setTip({ key: k, x, y, below });
    }, TIP_DELAY_MS);
  }, []);

  useEffect(
    () => () => {
      if (tipTimer.current !== null) clearTimeout(tipTimer.current);
    },
    [],
  );

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
      <div style={sx("display:flex;align-items:center;gap:10px 16px;margin-bottom:20px;flex-wrap:wrap")}>
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

      <div style={sx(COLUMNS)}>
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
                onPointerEnter={(e) => {
                  hover.onPointerEnter();
                  openTip(k, e.currentTarget);
                }}
                onPointerLeave={closeTip}
                onFocus={(e) => {
                  // Keyboard only — a click already focuses the chip, and the
                  // pointer path has said its piece.
                  if (focusVisible(e.currentTarget)) openTip(k, e.currentTarget);
                }}
                onBlur={closeTip}
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
          <div style={sx("display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap")}>
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
            <span style={sx(`min-width:0;font:400 10.5px/1.4 ${MONO};color:${C.faint}`)}>
              2 to 4 · both slips run on the same {p.form.legs}
            </span>
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
                `flex:1;min-width:0;height:38px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;text-align:center;` +
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

          <StakeField stake={p.stake} />
          {mode.oddsBoost > 1 && (
            <div data-boost style={sx(`margin-top:6px;font:500 10.5px/1.4 ${MONO};color:${mode.color}`)}>
              winner takes {p.prizeLabel} · payout boost ×{mode.oddsBoost.toFixed(2)}
            </div>
          )}

          {/* The side bet's amount sits here, under the PTS entry it is NOT a
              conversion of — two figures, two units, no rate between them and
              none shown. */}
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

      {tip && (
        <div
          data-sector-tip={tip.key}
          className="vc-tip"
          role="tooltip"
          style={sxWith(TIP_PANEL(SECTORS[tip.key].color), {
            left: `${tip.x}px`,
            top: `${tip.y}px`,
            transform: tip.below ? "translate(-50%,0)" : "translate(-50%,-100%)",
          })}
        >
          <div style={sx(`font:700 9.5px/1 ${MONO};letter-spacing:.14em;color:${SECTORS[tip.key].color}`)}>
            {SECTORS[tip.key].label}
          </div>
          <div style={sx(`margin-top:7px;font:400 11.5px/1.45 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>
            {SECTORS[tip.key].blurb}
          </div>
          <div style={sx(`margin-top:8px;font:500 10px/1.6 ${MONO};color:${C.dim};word-break:break-word`)}>
            {symsOfSector(tip.key).join(" · ")}
          </div>
        </div>
      )}
    </div>
  );
}
