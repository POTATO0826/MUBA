import { useCallback, useEffect, useRef, useState } from "react";
import {
  LARGE_STAKE_USDC,
  MIN_STAKE_USDC,
  parseStakeUsdc,
  usd as usdcText,
} from "../desk/escrow.ts";
import type { DuelStake } from "../state/stake.ts";
import { MARKET_COLOR, MARKET_LABEL } from "../data/lobbies.ts";
import { MODES, MODE_ORDER, modeTag } from "../data/modes.ts";
import type { Grade, QualifiedAsset } from "../data/qualify.ts";
import {
  GRADE_BLURB,
  GRADE_COLOR,
  SECTORS,
  bookForSectors,
  liveSectorStatus,
  symsOfSector,
} from "../data/sectors.ts";
import { sfx, useSoundHover } from "../lib/sound/index.ts";
import { sx, sxWith } from "../lib/sx.ts";
import { C, FEED_STATE, MONO, SANS, miniTag, pill, stateChip, tag } from "../theme.ts";
import { NOTIONAL_POOL_LINE } from "../ui/LobbyCards.tsx";
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

// ── The book ────────────────────────────────────────────────────────────────
//
// ONE row of chips, and it is the live Base board.
//
// This screen used to carry two: six chips over `data/universe.ts`'s eighteen
// invented rows (SEMIS, BIG TECH, OLD WORLD — NVDA, TSLA, XOM, PEPE), and a
// second, read-only row underneath showing what Thetanuts actually quotes. A
// host could publish a lobby from the first row and it could never be filled.
// Plan 6 §B3 retired that board; the second row is now the only row, and it is
// selectable, so the thing you choose from is the thing that trades.
//
// A group with nothing qualified is GREYED WITH THE REASON, never hidden. A
// host who picks MEME and gets an empty lobby learns nothing; a host who sees
// MEME greyed, reading "no live book today", has just been told the shape of
// the market they were about to trade in — and that is the claim the whole
// integration rests on, made in the one place a host is deciding anything.
//
// Greyed does NOT mean disabled. With no book at all — offline, or `/api/market`
// down — every group greys, and a builder that refused every chip in that state
// would delete the offline game rather than describe the market. The chip says
// what is true and the publish gate below still holds the line.

const LIVE_ROW = "display:flex;gap:6px;margin-top:10px;flex-wrap:wrap";

/**
 * What an asset with no measurement behind it says, in the three places the
 * chip says anything: the visible token, the tooltip, and the data attribute a
 * test reads.
 *
 * It is deliberately NOT a third grade. `Grade` has two members and both are
 * verdicts about depth; this is the absence of a verdict, so it is written in
 * `C.faint` rather than in a grade colour and it carries no blurb about spreads
 * or cards, because nobody looked.
 */
const UNGRADED_LABEL = "NOT GRADED";
const UNGRADED_ATTR = "none";
const UNGRADED_BLURB =
  "not graded — this asset is not in today's measured set, so nothing is known about its depth";

/**
 * Four states on two axes, because they are two different facts and a chip that
 * conflated them would lie in one direction or the other:
 *
 *   IN THE LOBBY?  is this group part of the book I am about to publish
 *   OPEN?          does it have a live book today
 *
 * Selection is the fill and the ring. The book is the BORDER: solid when the
 * group is quoted, dashed and dimmed when it is not — so a group that is both
 * chosen and unquoted still reads "not today" rather than being repainted as
 * healthy by the fact that someone selected it.
 */
const LIVE_CHIP = (color: string, open: boolean, on: boolean): string =>
  `display:flex;align-items:center;gap:8px;min-width:0;padding:8px 11px;border-radius:9px;` +
  `text-align:left;cursor:pointer;` +
  (open
    ? on
      ? `border:1px solid ${color}8c;background:${color}1c;box-shadow:0 0 0 1px ${color}26`
      : `border:1px solid ${color}59;background:transparent`
    : on
      ? // Greyed, not gone, and still visibly in the lobby.
        `border:1px dashed ${color}66;background:${color}0d;opacity:.72`
      : `border:1px dashed ${C.border};background:transparent;opacity:.62`);

/** One group, with today's book against it — and the control that puts it in
 *  the lobby. Both the chip and the status are the same element on purpose:
 *  there is no second place where a book could be described differently from
 *  the one being chosen. */
function LiveSector({
  status,
  grades,
  on,
  onToggle,
  onOpenTip,
  onCloseTip,
  hover,
}: {
  status: ReturnType<typeof liveSectorStatus>[number];
  grades: Readonly<Record<string, Grade>>;
  on: boolean;
  onToggle: () => void;
  onOpenTip: (el: HTMLElement) => void;
  onCloseTip: () => void;
  hover: { onPointerEnter: () => void };
}) {
  return (
    <button
      data-sector={status.key}
      data-live-sector={status.key}
      data-live-open={status.open}
      aria-pressed={on}
      title={status.blurb}
      onClick={() => {
        sfx("ui.toggle.on");
        onToggle();
      }}
      onPointerEnter={(e) => {
        hover.onPointerEnter();
        onOpenTip(e.currentTarget);
      }}
      onPointerLeave={onCloseTip}
      onFocus={(e) => {
        // Keyboard only — a click already focuses the chip, and the pointer
        // path has said its piece.
        if (focusVisible(e.currentTarget)) onOpenTip(e.currentTarget);
      }}
      onBlur={onCloseTip}
      style={sx(LIVE_CHIP(status.color, status.open, on))}
    >
      <span
        style={sx(
          `font:700 9.5px/1 ${MONO};letter-spacing:.12em;color:${
            on || status.open ? status.color : C.dim
          }`,
        )}
      >
        {status.label}
      </span>
      {status.open ? (
        <span style={sx(`display:flex;align-items:center;gap:6px;min-width:0`)}>
          {status.playable.map((sym) => {
            /**
             * The grade, or the absence of one — and they are two different
             * facts.
             *
             * `grades` holds ONLY assets the gate measured and qualified. A miss
             * is therefore "not graded", never "graded THIN": THIN is a real
             * verdict meaning *resting orders and greeks, no market-maker feed*,
             * and printing it for an asset nobody measured would be a
             * measurement nobody made — the exact class of claim this screen
             * exists to delete.
             *
             * In practice the lookup hits, because `status.playable` is filtered
             * from the same qualified list `grades` is built from. The `null`
             * branch is what keeps that a **consequence** rather than an
             * assumption: a caller that ever passes a `grades` map from one
             * snapshot and a `playable` list from another gets an honest blank
             * instead of a fabricated amber THIN.
             *
             * `MatchSpin` makes the same choice at the slice reveal for the same
             * reason (`gradeIndex(...)[underlying] ?? null`), and `LobbyCard`
             * sidesteps it by rendering only the entries a grades map actually
             * has.
             */
            const grade = grades[sym] ?? null;
            return (
              <span
                key={sym}
                data-live-asset={sym}
                data-grade={grade ?? UNGRADED_ATTR}
                title={`${sym} — ${grade ? GRADE_BLURB[grade] : UNGRADED_BLURB}`}
                style={sx(`font:500 10px/1 ${MONO};color:${C.textSoft};white-space:nowrap`)}
              >
                {sym}{" "}
                <span style={sx(`color:${grade ? GRADE_COLOR[grade] : C.faint}`)}>
                  {grade ?? UNGRADED_LABEL}
                </span>
              </span>
            );
          })}
        </span>
      ) : (
        <span
          data-live-reason
          style={sx(`display:flex;align-items:center;gap:6px;font:400 10px/1 ${MONO};color:${C.faint}`)}
        >
          <span style={sx("white-space:nowrap")}>{status.members.join(" · ")}</span>
          <span style={sx("white-space:nowrap")}>— {status.reason}</span>
        </span>
      )}
    </button>
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
  /**
   * Today's qualified assets, from `qualifiedAssets()` against the live book.
   *
   * Optional and defaulting to none, which is the honest render offline and
   * whenever `/api/market` is down: every live group greys with its reason and
   * the seeded board — which needs no book and is what the six chips above
   * deal from — still publishes a lobby. An empty list is a statement about
   * the market, not a broken screen.
   */
  live?: readonly QualifiedAsset[];
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

  // The groups, measured against today's book. Recomputed each render for the
  // same reason the book above is: it is a filter over an injected list, not
  // state, and the list changes every time the snapshot refreshes.
  const qualified = p.live ?? [];
  /** Did today's book measure anything at all? `[]` is the answer both offline
   *  and with `/api/market` down, and it is the state the BOOK heading and the
   *  greyed groups below have to agree about. */
  const measured = qualified.length > 0;
  const liveStatus = liveSectorStatus(qualified.map((a) => a.underlying));
  const grades: Record<string, Grade> = Object.fromEntries(
    qualified.map((a) => [a.underlying, a.grade]),
  );

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

          {/* The heading claimed `BOOK · LIVE ON BASE` unconditionally, which
              made it the loudest thing on the card that could be false: with the
              venue unreachable every group below greys out *with its reason*
              while the header above them still said LIVE. The measurement is
              `p.live` — `qualifiedAssets()` against today's book — so an empty
              list is the app saying it read nothing, and the heading now says
              the same thing the rows under it are already saying. */}
          <div
            data-book-head={measured ? "live" : "seeded"}
            style={sx(`${LABEL};margin-top:20px;display:flex;align-items:center;gap:8px;flex-wrap:wrap`)}
          >
            <span>BOOK · {measured ? "LIVE ON BASE" : "NO LIVE READ ON BASE"}</span>
            {!measured && (
              <span
                title={FEED_STATE.seeded.means}
                style={sx(`${stateChip("seeded")};font-size:8px;letter-spacing:.12em`)}
              >
                {FEED_STATE.seeded.label}
              </span>
            )}
          </div>
          <div data-live-book style={sx(LIVE_ROW)}>
            {liveStatus.map((s) => (
              <LiveSector
                key={s.key}
                status={s}
                grades={grades}
                on={p.form.sectors.includes(s.key)}
                onToggle={() => p.onToggleSector(s.key)}
                onOpenTip={(el) => openTip(s.key, el)}
                onCloseTip={closeTip}
                hover={hover}
              />
            ))}
          </div>
          <div data-book style={sx(BOOK_LINE)} title={book.join(" · ")}>
            book: {book.length} names{book.length > 0 ? ` — ${book.join(" · ")}` : ""}
          </div>
          <div style={sx(NOTE)}>
            The spin deals both players' legs from this book. Neither of you picks a ticker, and
            every name on it is one Thetanuts has a price feed for on Base. Measured against the
            resting order book right now — spot, order count, greeks and depth. A group with no
            book is greyed rather than hidden, because which sectors are trading today is part of
            what you are choosing. <span style={sx(`color:${GRADE_COLOR.DEEP}`)}>DEEP</span> means
            market makers quote both sides; <span style={sx(`color:${GRADE_COLOR.THIN}`)}>THIN</span>{" "}
            means resting orders only — a harder round, not a broken one.
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
          <div style={sx(NOTE)}>Half the pool each. Winner banks the full pool, in points.</div>
          {/* Said where the host is choosing the number, in the shape the box
              arena's create screen already says it: the amount above, then the
              clause about what it is. `StakeField` below is the USDC side bet
              and is a different currency with no rate to this one — it carries
              its own copy. */}
          <div
            data-notional-pool=""
            style={sx(`margin-top:10px;font:500 8.5px/1.5 ${MONO};letter-spacing:.04em;color:${C.faint}`)}
          >
            {NOTIONAL_POOL_LINE}
          </div>
          <div style={sx(NOTE)}>
            The pool is a number this lobby carries, not money anyone took — no ETH is approved,
            transferred or escrowed on this path, and the duel settles in points. The Ξ figure
            scales the points at stake and nothing else.
          </div>

          <StakeField stake={p.stake} />
          {mode.oddsBoost > 1 && (
            <div data-boost style={sx(`margin-top:6px;font:500 10.5px/1.4 ${MONO};color:${mode.color}`)}>
              winner banks {p.prizeLabel} in points · payout boost ×{mode.oddsBoost.toFixed(2)}
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
