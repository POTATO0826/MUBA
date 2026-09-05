import { useEffect, useRef, useState } from "react";
import { CHAIN_SPLIT_NOTE, SIGNING_CHAIN_NAME } from "../data/wallet.ts";
import { ASK_CHIPS, SLIP_LEGS, SLIP_NOTES, SLIP_ROWS } from "../data/fixtures.ts";
import type { MarketSource } from "../data/market.ts";
import { REFRESH_MS } from "../data/thetanuts.tsx";
import {
  ALCHEMY_HINT,
  DROP_COPY,
  FILL_LADDER,
  MAX_FILL_USDC,
  PARTIAL_FILL_POLICY,
  TARGET_FILL_USDC,
  claimReferrerFees,
  contracts as contractText,
  createLiveFillDeps,
  readReferrerSplit,
  refFor,
  runFill,
  runParlayFill,
  splitLabel,
  usdText,
  type FillOutcome,
  type FillQuote,
  type FillStep,
  type FillWallet,
  type ParlayFillLeg,
  type ParlayFillResult,
  type ParlayLegState,
  type ParlaySlipQuote,
} from "../desk/fill.ts";
import { buildPayoffChart, ETH_VOL_BOX } from "../desk/payoff.ts";
import { degeneracyScore } from "../engine/parlay.ts";
import { sx } from "../lib/sx.ts";
import {
  C,
  FEED_STATE,
  MONO,
  SANS,
  feedState,
  pill,
  stateAge,
  stateDot,
  tag,
} from "../theme.ts";
import type { OrderRow, PricingRow } from "../types.ts";

const PRICING_COLUMNS = "88px 96px 110px 100px 100px 84px 84px 1fr";
/** The MM chain: ticker, type, strike, expiry, and the four prices. */
const MM_COLUMNS = "168px 72px 96px 92px 92px 92px 92px 1fr";

const TYPE_COLOR = { CALL: C.green, PUT: C.red, RANGER: C.violet } as const;
const STATUS_COLOR = {
  FILLED: C.green,
  PARTIAL: C.amber,
  OPEN: C.blue,
  CANCELLED: C.dim,
} as const;

/**
 * The wallet, as the desk needs it: a signer seam plus the two recovery verbs
 * the typed error map points at.
 *
 * `WalletSource` (`src/data/wallet.ts`) satisfies this structurally, so `App`
 * hands its own wallet straight through and this view never imports AppKit,
 * ethers, or the wallet tiers.
 */
export interface DeskWallet extends FillWallet {
  connect?(): Promise<void>;
  switchToSigningChain?(): Promise<void>;
}

/** What `/api/config` says about trading. Both fields default to "off"/"none",
 *  and a config that never answers leaves them there — money-moving features
 *  are opt-IN, so an unreachable server must fail closed. */
interface TradeConfig {
  enabled: boolean;
  referrer: string;
}

const TRADE_OFF: TradeConfig = { enabled: false, referrer: "" };

/**
 * Ask the server whether real fills are switched on.
 *
 * Read at mount rather than baked in: `THETADUEL_TRADE=on` is a per-process
 * decision an operator makes, `/api/config` is `no-store`, and the whole
 * rollback story is "flags off → today's app". Anything that failed — no
 * server, a 500, a body that is not JSON, or a wallet that could never sign
 * anyway — leaves this at `TRADE_OFF`, which renders exactly the DOM this
 * screen rendered before the fill flow existed.
 */
function useTradeConfig(wallet: DeskWallet | undefined): TradeConfig {
  const [config, setConfig] = useState<TradeConfig>(TRADE_OFF);

  // `wallet.id` rather than `wallet`: the wallet object is rebuilt on every
  // render of the tier hook, and depending on the object would re-fetch the
  // config on every keystroke anywhere in the app.
  const id = wallet?.id;

  useEffect(() => {
    // The mock wallet is inert by design — it cannot sign and must never
    // approve or fill (`src/wallet/mock.ts`, and P6 holds the same line for
    // staking). There is therefore nothing for the flag to enable, and skipping
    // the fetch here is what keeps the default build, and every headless test,
    // free of a network call it would only ignore the answer to.
    if (!id || id === "mock") return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        const body = (await res.json()) as {
          referrer?: string;
          features?: { trade?: boolean };
        };
        if (!live) return;
        setConfig({
          enabled: body.features?.trade === true,
          referrer: typeof body.referrer === "string" ? body.referrer : "",
        });
      } catch {
        // Fail closed. Silence, not a console warning: an app served as static
        // files has no server to ask and is not misconfigured.
      }
    })();
    return () => {
      live = false;
    };
  }, [id]);

  return config;
}

/**
 * One chain level's identity on this screen.
 *
 * ## The merge this replaces
 *
 * This used to be `` `${row.type}-${row.strike}-${row.expiry}` ``, and every
 * one of those three fields is coarser than it looks:
 *
 *  - `type` is the three-member colour bucket. A CALL_SPREAD and a CALL_FLY are
 *    both `CALL`; `structure` is the truthful field and it was not in the key.
 *  - `strike` prints only the **first** strike for anything under four of them
 *    (`src/server/thetanuts.ts`), so an 85,000/86,000 spread and an
 *    85,000/86,000/87,000 fly both print `85,000`.
 *  - `expiry` is `"5 SEP"` — **no year**. Two Septembers key the same.
 *
 * The repo's own frozen capture carries the collision: BTC, `5 SEP`, both rows
 * fillable, both keying to `CALL-85,000-5 SEP` (`test/fixtures/orders.json`
 * through the real `buildSnapshot`; pinned in `test/fill.test.ts`). What that
 * cost, with `THETADUEL_TRADE=on` and a real wallet: pressing `+ SLIP` on the
 * fly lit both rows `IN SLIP`, `slipRows` resolved the key with `.find` and
 * returned the **first** match — the spread — and `runParlayFill` approved USDC
 * and filled a contract the player never picked, at a different premium and a
 * different payoff shape. `probOf` is keyed the same way, so the re-score
 * divided one row's delta into the other's fill. React saw two children with
 * one `key` and was free to swap them under the 30s book refresh.
 *
 * `cardsForSlice` in `src/engine/parlay.ts` has always guarded this on the
 * card-dealing path — its step 1 refuses any row whose `structure` is not the
 * plain vanilla, and its docblock says why. The desk's chain-table slip is the
 * same hazard on the other path and never got the guard.
 *
 * ## What names one contract now
 *
 * The **server's own `Level` key**, rebuilt from what the row carries:
 * call/put, the structure, **every** strike, the **option** expiry in unix
 * seconds — never the printed label, so a year cannot go missing — and the
 * implementation address, lowercased, because a RANGER and a CALL_CONDOR are
 * different products at identical strikes and only the address separates them.
 * The underlying is the one part of that key left out, and it is the one part
 * that cannot vary here: this screen renders `source.pricing(asset)`, one
 * asset at a time.
 *
 * The exact half comes off `row.order` — the resting ask the level would fill
 * against — so a row that can be **bought** is keyed by what a fill would
 * actually sign. A row with no `order` is display-only: it cannot enter the
 * slip at all (`slipRows` drops it, and the `+ SLIP` toggle is not rendered for
 * it), and it keys on the printed half alone, which is already strictly finer
 * than the old key. That last gap — a year for a display-only row — is now
 * closed by `PricingRow.expirySec` (`src/types.ts`), set by `buildSnapshot` for
 * every row, `order` or no `order`: display-only rows get a year in the key
 * the same way fillable ones do, just off the row instead of off an order.
 *
 * ## Why the printed half is kept as well
 *
 * Both halves, joined, never one or the other. They are two readings of one
 * level and on live data they cannot disagree — the server derives the printed
 * strike and expiry *from* the very order it attaches. Keeping both means a
 * key can only merge two rows when **everything** about them agrees, printed
 * and exact; drop either half and a divergence the builder is not supposed to
 * produce becomes a silent merge again, which is the whole class of failure
 * this function is now the wrong place for.
 */
export function rowKey(row: PricingRow): string {
  const api = row.order?.rawApiData;
  // `order.expiry` is the OPTION's expiry in unix seconds — the settlement
  // date, and the year with it. `rawApiData.orderExpiryTimestamp` is the
  // signature deadline and is deliberately not here: two orders on one contract
  // with different deadlines are one instrument, which is the correction
  // `Level` records.
  const expiry = row.order?.order.expiry;
  return [
    // What the player reads off the row.
    row.type,
    row.structure ?? "",
    row.strike,
    row.expiry,
    row.expirySec === undefined ? "" : String(row.expirySec),
    // What a fill would sign against: every strike, the settlement date in
    // seconds, and the product's own contract.
    api?.strikes?.join("/") ?? "",
    expiry === undefined ? "" : String(expiry),
    String(api?.implementation ?? "").toLowerCase(),
  ].join("|");
}

/**
 * What a slip leg is called on the ladder, the confirm screen and the receipt.
 *
 * `${underlying}-${expiry}-${strike}-${C|P}` for a plain vanilla — the string
 * this screen has always printed — with the structure appended for anything
 * that is not one. `PricingRow.type` is the three-member colour bucket, so a
 * CALL_SPREAD and a CALL_FLY both answer `CALL` and both print only their first
 * strike; a player confirming `BTC-5 SEP-85,000-C` while buying a fly is the
 * same merge {@link rowKey} exists to stop, one layer up in the copy.
 *
 * The label is display only — `ParlayFillLeg.instrument` is what the duel clock
 * keys on, and it is copied off `markTicker` or absent, never composed here.
 */
function legLabel(underlying: string, row: PricingRow): string {
  const base = `${underlying}-${row.expiry}-${row.strike}-${row.type === "CALL" ? "C" : "P"}`;
  return row.structure === undefined || row.structure === row.type
    ? base
    : `${base} ${row.structure}`;
}

/** `−0.34` / `0.34` → `0.34`, and `—` → `null`. Both minus signs, because the
 *  server writes U+2212 and a put's delta is negative. */
function absDelta(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const n = Math.abs(Number(String(raw).replace("−", "-")));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * `markUsd` as a number, or `undefined` — **US dollars per contract**.
 *
 * `markUsd`, not `mark`. The venue quotes a mark in units of the underlying
 * (`tnuts-test/FINDINGS.md` §1), the premium a fill pays is USDC, and the duel
 * score divides one by the other — so the row's dollar figure, derived on the
 * server against the spot that same quote was made against, is the only one of
 * the two that may be sent. See `src/engine/score.ts` §Units.
 *
 * Most live rows carry neither: market-maker pricing covers two underlyings,
 * and that is a fact about the feed, never a reason to substitute a mid we
 * computed or a spot from another call.
 */
function markUsdOf(row: PricingRow): number | undefined {
  if (row.markUsd === undefined) return undefined;
  const n = Number(String(row.markUsd).replace("−", "-"));
  return Number.isFinite(n) ? n : undefined;
}

interface ParlayProps {
  source: MarketSource;
  asset: string;
  onAsset: (a: string) => void;
  /**
   * Optional on purpose. Absent — a static build, a test, any caller that has
   * not wired the wallet layer — means the desk is read-only and renders
   * byte-identically to the pre-P3 screen.
   */
  wallet?: DeskWallet;
}

export function Parlay({ source, asset, onAsset, wallet }: ParlayProps) {
  const trade = useTradeConfig(wallet);
  /** Real fills are live on this screen. Both halves required: an operator's
   *  flag AND a wallet that can actually sign. */
  const canFill = trade.enabled && wallet !== undefined;
  // The structure is written on ETH, so ETH's live print is the one that
  // anchors it. `null` — every asset Thetanuts does not publish, and the mock
  // for all of them — draws exactly the chart this screen always drew, labelled
  // `· REFERENCE` instead of pretending.
  const chart = buildPayoffChart(ETH_VOL_BOX, source.spot("ETH"));
  const pricing = source.pricing(asset);
  const mm = source.mmPricing(asset);
  const orders = source.orders();

  /**
   * The RANGER disposition, read off the rows rather than off a flag.
   *
   * `structure` is set only by the live builder, so the seeded RANGER rows in
   * the mock never reach this line — the copy below is a statement about what
   * the SDK can price, and applying it to a fixture would be a claim about
   * nothing. SDK 0.3.0 ships real ranger payout math, so `payout` is populated
   * and the unsupported branch stays unrendered; it is kept because the branch
   * is a property of the installed SDK, not of this file.
   */
  const rangers = pricing.filter((r) => r.structure === "RANGER");
  const unpriceable = rangers.filter((r) => !r.payout);

  /** Whether any shipped row was previewed at all. The mock has none, and a
   *  blotter of un-clickable rows must not advertise a quote it cannot give. */
  const previewable = orders.some((o) => o.preview);
  const [selected, setSelected] = useState<string | null>(null);

  /**
   * The parlay slip: which chain rows the player has stacked, by key.
   *
   * Kept as keys rather than rows so a book refresh re-resolves each pick
   * against the *current* snapshot — a slip holding a 30-second-old copy of a
   * row would quote one price and preview another.
   *
   * Only rows that carry `order` can be picked at all. That is the same rule
   * `cardsForSlice` applies when it deals a card: a level built from bids or
   * from MM pricing alone has nothing to buy, so it is display-only. The mock
   * sets `order` on nothing, which is what keeps the seeded book unfillable by
   * construction here as well as on the blotter.
   */
  const [slipKeys, setSlipKeys] = useState<readonly string[]>([]);
  const slipRows = slipKeys
    .map((key) => pricing.find((r) => rowKey(r) === key))
    .filter((r): r is PricingRow => r !== undefined && r.order !== undefined);
  function toggleSlip(key: string) {
    setSlipKeys((keys) => (keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key]));
  }

  /**
   * The blotter's provenance pill.
   *
   * No socket is open. The blotter is a 30s poll over a 15s server cache, and
   * the pill says so — `client.ws.subscribeOrders` is P2's optional garnish and
   * was not taken, so a `STREAMING` label here would be the same kind of
   * decoration this phase exists to remove.
   *
   * Two claims this pill used to make that the data did not support, both fixed
   * here:
   *
   *  - it read `POLL 30s` for *any* non-mock source, including a `stale` one.
   *    A stale book is precisely the book that is **not** being polled
   *    successfully; the cadence was advertised loudest exactly when it had
   *    stopped working. STALE now takes the cadence's place and brings the age
   *    of the read that is actually on screen, which is the disclosure.
   *  - the dot beside it was green and pulsing unconditionally, so a screen of
   *    checked-in fixtures wore the universal "data is arriving" animation
   *    while the label next to it honestly said SEEDED. `stateDot` pulses for
   *    `live` and nothing else.
   */
  const feed = feedState(source.meta.source);
  const feedAge = stateAge(source.meta.fetchedAt, Date.now());
  const feedLabel =
    feed === "live"
      ? `LIVE · POLL ${Math.round(REFRESH_MS / 1000)}s`
      : feed === "stale"
        ? `STALE${feedAge ? ` · ${feedAge}` : ""}`
        : FEED_STATE[feed].label;

  return (
    <div
      style={sx(
        "display:grid;grid-template-columns:minmax(0,1fr) 360px;gap:24px;padding:24px 28px;" +
          "max-width:1720px;margin:0 auto;align-items:start",
      )}
    >
      <div style={sx("display:flex;flex-direction:column;gap:20px;min-width:0")}>
        <section
          style={sx(
            `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`,
          )}
        >
          <div
            style={sx(
              `display:flex;align-items:center;gap:14px;padding:14px 18px;border-bottom:1px solid ${C.border}`,
            )}
          >
            <span style={sx(`font:700 14px/1 ${SANS}`)}>Combined payoff at expiry</span>
            <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>4 LEGS · ETH · 27 SEP</span>
            <div style={sx("flex:1")} />
            <div style={sx(`display:flex;gap:14px;font:500 10px/1 ${MONO};color:${C.muted}`)}>
              <span style={sx("display:flex;align-items:center;gap:6px")}>
                <span style={sx(`width:14px;height:2px;background:${C.accent};display:block`)} />
                PARLAY
              </span>
              <span style={sx("display:flex;align-items:center;gap:6px")}>
                <span style={sx(`width:14px;height:2px;background:${C.faint};display:block`)} />
                SPOT
              </span>
            </div>
          </div>

          <div style={sx("padding:18px")}>
            <svg viewBox="0 0 900 300" style={{ width: "100%", height: 300, display: "block", overflow: "visible" }}>
              {chart.gridY.map((g) => (
                <g key={g.label}>
                  <line x1="52" x2="880" y1={g.y} y2={g.y} stroke="#1f1f23" strokeWidth="1" />
                  <text
                    x="44"
                    y={g.ty}
                    textAnchor="end"
                    fill={C.faint}
                    fontFamily={MONO}
                    fontSize="10"
                  >
                    {g.label}
                  </text>
                </g>
              ))}
              {chart.gridX.map((g) => (
                <g key={g.label}>
                  <line y1="18" y2="252" x1={g.x} x2={g.x} stroke="#161619" strokeWidth="1" />
                  <text
                    y="272"
                    x={g.x}
                    textAnchor="middle"
                    fill={C.faint}
                    fontFamily={MONO}
                    fontSize="10"
                  >
                    {g.label}
                  </text>
                </g>
              ))}
              <line
                x1="52"
                x2="880"
                y1={chart.zeroY}
                y2={chart.zeroY}
                stroke={C.borderMid}
                strokeWidth="1"
                strokeDasharray="4 4"
              />
              <path d={chart.fill} fill="rgba(200,255,0,.1)" />
              <path
                d={chart.path}
                fill="none"
                stroke={C.accent}
                strokeWidth="2.5"
                strokeLinejoin="round"
              />
              {/* The spot line, drawn only where there is a spot to draw.
                  `spotX` is clamped into the window, so with live ETH at 2,453
                  against a 3,200 floor this line used to sit exactly on the
                  3.2k gridline — a dashed marker parked on a price the asset is
                  not at, contradicting the honest label beside it. Off scale we
                  draw the frame edge and an arrow out of it instead: the reader
                  learns the direction and that the number is outside, which is
                  the true state of affairs. Nothing rescales; the fixture's
                  window is fixed. */}
              {chart.spotOnScale ? (
                <line
                  data-spot-line=""
                  x1={chart.spotX}
                  x2={chart.spotX}
                  y1="18"
                  y2="252"
                  stroke={C.dim}
                  strokeWidth="1.5"
                  strokeDasharray="3 3"
                />
              ) : (
                <g data-spot-offscale={Number(chart.spotX) < 100 ? "low" : "high"}>
                  <line
                    x1={chart.spotX}
                    x2={chart.spotX}
                    y1="18"
                    y2="252"
                    stroke={C.line}
                    strokeWidth="1"
                  />
                  <text
                    x={Number(chart.spotX) < 100 ? Number(chart.spotX) + 6 : Number(chart.spotX) - 6}
                    y="252"
                    textAnchor={Number(chart.spotX) < 100 ? "start" : "end"}
                    fill={C.faint}
                    fontFamily={MONO}
                    fontSize="10"
                  >
                    {Number(chart.spotX) < 100 ? "◀ SPOT OFF SCALE" : "SPOT OFF SCALE ▶"}
                  </text>
                </g>
              )}
              {/* The number itself comes from `buildPayoffChart`, which knows
                  whether it is a live print or the reference the structure was
                  written around. This view carries no spot literal of its own —
                  it was the fifth of the five hardcoded-spot sites, and the one
                  that would have kept saying 4,182 with a live book on screen. */}
              <text x={chart.spotLabelX} y="14" fill={C.muted} fontFamily={MONO} fontSize="10">
                {chart.spotLabel}
              </text>
              {chart.strikeMarks.map((s) => (
                <g key={s.label}>
                  <circle cx={s.x} cy={s.y} r="3.5" fill={C.bg} stroke={C.accent} strokeWidth="2" />
                  <text
                    x={s.x}
                    y={s.ty}
                    textAnchor="middle"
                    fill={C.accent}
                    fontFamily={MONO}
                    fontSize="9"
                  >
                    {s.label}
                  </text>
                </g>
              ))}
            </svg>

            <div
              style={sx(
                "display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-top:16px;" +
                  `padding-top:16px;border-top:1px solid ${C.line}`,
              )}
            >
              {chart.stats.map((s) => (
                <div key={s.label} style={sx("min-width:0")}>
                  <div
                    style={sx(
                      `font:500 9px/1.4 ${MONO};letter-spacing:.12em;color:${C.dim};` +
                        "overflow-wrap:anywhere",
                    )}
                  >
                    {s.label}
                  </div>
                  <div
                    style={sx(
                      `margin-top:8px;font:700 18px/1.15 ${MONO};letter-spacing:-.02em;color:${s.color};` +
                        // `3,723 / 4,389` is the widest value this strip has
                        // ever carried. It wraps rather than pushing the grid
                        // track past its column and taking the page's
                        // no-horizontal-scroll guarantee with it.
                        "overflow-wrap:anywhere",
                    )}
                  >
                    {s.value}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section
          style={sx(
            `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`,
          )}
        >
          <div
            style={sx(
              `display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid ${C.border}`,
            )}
          >
            <span style={sx(`font:700 14px/1 ${SANS}`)}>MM pricing</span>
            <div style={sx("display:flex;gap:6px")}>
              {source.underlyings().map((a) => (
                <button key={a} onClick={() => onAsset(a)} style={sx(pill(asset === a))}>
                  {a}
                </button>
              ))}
            </div>
            <div style={sx("flex:1")} />
            {/* The exact call whose output is on screen, not a decoration. With
                no MM chain the panel is showing the order book instead, and it
                says the call that produced that.

                The filled branch used to be a flat green — the LIVE colour —
                even when the snapshot underneath it was stale. It now carries
                the feed's own colour, so an aged MM chain reads amber like
                everything else aged on the page. (The mock never reaches this
                branch: it ships no MM quotes at all.) */}
            <span
              style={sx(
                `font:500 10px/1 ${MONO};color:${mm.length > 0 ? FEED_STATE[feed].color : C.dim}`,
              )}
            >
              {mm.length > 0
                ? `● client.mmPricing.getPricingArray('${asset}')`
                : "○ client.api.fetchOrders()"}
            </span>
          </div>

          {mm.length > 0 && (
            <div style={sx("overflow-x:auto")}>
              <div
                style={sx(
                  `display:grid;grid-template-columns:${MM_COLUMNS};gap:10px;padding:10px 18px;` +
                    `background:${C.raised};border-bottom:1px solid ${C.border};font:500 10px/1 ${MONO};` +
                    `letter-spacing:.1em;color:${C.dim}`,
                )}
              >
                <div>TICKER</div>
                <div>TYPE</div>
                <div>STRIKE</div>
                <div>EXPIRY</div>
                <div>BID</div>
                <div>ASK</div>
                <div>MARK</div>
                <div>SPREAD</div>
              </div>

              {mm.map((q, i) => (
                <div
                  key={q.ticker}
                  style={sx(
                    `display:grid;grid-template-columns:${MM_COLUMNS};gap:10px;align-items:center;` +
                      `padding:12px 18px;border-bottom:1px solid ${C.lineSoft};background:${
                        i % 2 ? C.panelAlt : "transparent"
                      }`,
                  )}
                >
                  <div style={sx(`font:400 11px/1 ${MONO};color:${C.faint}`)}>{q.ticker}</div>
                  <div>
                    <span style={sx(tag(TYPE_COLOR[q.type]))}>{q.type}</span>
                  </div>
                  <div style={sx(`font:700 12px/1 ${MONO}`)}>{q.strike}</div>
                  <div style={sx(`font:400 12px/1 ${MONO};color:${C.muted}`)}>{q.expiry}</div>
                  {/* `feeAdjustedBid`/`feeAdjustedAsk`, verbatim from the venue.
                      The fee cap is 4e-4 in the shipped code and 3e-4 in the
                      docs (FINDINGS §5.1); nothing here recomputes either. */}
                  <div style={sx(`font:500 12px/1 ${MONO};color:${C.green}`)}>{q.bid}</div>
                  <div style={sx(`font:500 12px/1 ${MONO};color:${C.red}`)}>{q.ask}</div>
                  <div style={sx(`font:400 12px/1 ${MONO};color:${C.muted}`)}>{q.mark}</div>
                  <div style={sx(`font:400 12px/1 ${MONO};color:${C.dim}`)}>{q.spread}</div>
                </div>
              ))}
            </div>
          )}

          <div style={sx("overflow-x:auto")}>
            <div
              style={sx(
                `display:grid;grid-template-columns:${PRICING_COLUMNS};gap:10px;padding:10px 18px;` +
                  `background:${C.raised};border-bottom:1px solid ${C.border};font:500 10px/1 ${MONO};` +
                  `letter-spacing:.1em;color:${C.dim}`,
              )}
            >
              <div>TYPE</div>
              <div>STRIKE</div>
              <div>EXPIRY</div>
              <div>BID</div>
              <div>ASK</div>
              <div>IV</div>
              <div>Δ</div>
              <div>SIZE</div>
            </div>

            {pricing.map((r, i) => (
              <div
                key={rowKey(r)}
                style={sx(
                  `display:grid;grid-template-columns:${PRICING_COLUMNS};gap:10px;align-items:center;` +
                    `padding:12px 18px;border-bottom:1px solid ${C.lineSoft};background:${
                      i % 2 ? C.panelAlt : "transparent"
                    }`,
                )}
              >
                <div>
                  <span style={sx(tag(TYPE_COLOR[r.type]))}>{r.type}</span>
                </div>
                <div style={sx(`font:700 12px/1 ${MONO}`)}>{r.strike}</div>
                <div style={sx(`font:400 12px/1 ${MONO};color:${C.muted}`)}>{r.expiry}</div>
                <div style={sx(`font:500 12px/1 ${MONO};color:${C.green}`)}>{r.bid}</div>
                <div style={sx(`font:500 12px/1 ${MONO};color:${C.red}`)}>{r.ask}</div>
                <div style={sx(`font:400 12px/1 ${MONO};color:${C.muted}`)}>{r.iv}</div>
                <div style={sx(`font:400 12px/1 ${MONO};color:${C.muted}`)}>{r.delta}</div>
                <div style={sx("display:flex;align-items:center;gap:8px")}>
                  <div
                    style={sx(
                      "flex:1;height:4px;border-radius:99px;background:#1f1f23;overflow:hidden;max-width:110px",
                    )}
                  >
                    <div
                      style={sx(
                        `height:100%;width:${r.depth}%;background:${TYPE_COLOR[r.type]};opacity:.75`,
                      )}
                    />
                  </div>
                  <span style={sx(`font:400 10px/1 ${MONO};color:${C.dim}`)}>{r.size}</span>
                  {/* The slip toggle. Rendered only with `THETADUEL_TRADE=on`,
                      a wallet, AND a resting order behind the level — a level
                      with no `order` is a quote you cannot buy, and offering it
                      as a leg would be the one failure `PricingRow.order`
                      exists to delete. With any of the three missing this cell
                      is exactly what it was. */}
                  {canFill && r.order && (
                    <button
                      onClick={() => toggleSlip(rowKey(r))}
                      style={sx(
                        `height:22px;padding:0 8px;border-radius:6px;cursor:pointer;` +
                          `font:700 9px/1 ${MONO};letter-spacing:.1em;` +
                          (slipKeys.includes(rowKey(r))
                            ? `border:1px solid ${C.accent};background:rgba(200,255,0,.14);color:${C.accent}`
                            : `border:1px solid ${C.borderMid};background:transparent;color:${C.muted}`),
                      )}
                    >
                      {slipKeys.includes(rowKey(r)) ? "IN SLIP" : "+ SLIP"}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>

          {rangers.length > 0 && (
            <div
              style={sx(
                `padding:12px 18px;border-top:1px solid ${C.border};font:400 10.5px/1.5 ${MONO};` +
                  `color:${unpriceable.length > 0 ? C.amber : C.dim}`,
              )}
            >
              {unpriceable.length > 0
                ? // Unreachable on SDK 0.3.0, and kept for the day it is not:
                  // 0.2.5's `calculatePayout` threw `Unknown option type: RANGER`
                  // on both casings, so a row could be quoted and unpriceable at
                  // the same time. The rows still show their two-sided market —
                  // only the payoff is withheld.
                  "PAYOFF UNAVAILABLE — ranger math is on-chain only"
                : // `payout` is the flag that stops these pricing as condors:
                  // the SDK derives a payout type from the order shape and
                  // four-strike orders default to `call_condor` unless the
                  // caller says otherwise (FINDINGS, "the 4-strike discriminator
                  // trap"). The server decided it once, with `validateRanger`
                  // in scope.
                  `${rangers.length} RANGER · payout '${rangers[0]!.payout}' — priced off-chain, isRanger set`}
            </div>
          )}
        </section>

        <section
          style={sx(
            `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`,
          )}
        >
          <div
            style={sx(
              `display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid ${C.border}`,
            )}
          >
            <span style={sx(`font:700 14px/1 ${SANS}`)}>Live orders</span>
            <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>
              client.api.fetchOrders()
            </span>
            <div style={sx("flex:1")} />
            {previewable && (
              <span style={sx(`font:500 10px/1 ${MONO};color:${C.faint}`)}>
                select a row · previewFillOrder($1.00)
              </span>
            )}
            <span
              data-testid="desk-feed"
              title={FEED_STATE[feed].means}
              style={sx(
                `display:flex;align-items:center;gap:7px;font:500 10px/1 ${MONO};color:${FEED_STATE[feed].color}`,
              )}
            >
              <span style={sx(stateDot(feed))} />
              {feedLabel}
            </span>
          </div>

          {orders.map((o, i) => {
            const key = `${o.instrument}-${o.time}-${i}`;
            const preview = o.preview;
            // Grey is a statement about the book, not about the row: the
            // maker's remaining collateral will not absorb even a dollar.
            const thin = preview !== undefined && !preview.fillable;
            const open = selected === key;
            return (
              <div key={key}>
                <div
                  onClick={previewable ? () => setSelected(open ? null : key) : undefined}
                  style={sx(
                    `display:flex;align-items:center;gap:14px;padding:12px 18px;` +
                      `border-bottom:1px solid ${C.lineSoft};background:${
                        open ? C.raised : i % 2 ? C.panelAlt : "transparent"
                      }` +
                      (previewable ? ";cursor:pointer" : "") +
                      (thin ? ";opacity:.5" : ""),
                  )}
                >
                  <span
                    style={sx(
                      `min-width:44px;font:700 10px/1 ${MONO};letter-spacing:.1em;padding:6px 7px;` +
                        "border-radius:5px;text-align:center;background:" +
                        (o.side === "BUY"
                          ? `rgba(74,222,128,.14);color:${C.green}`
                          : `rgba(248,113,113,.14);color:${C.red}`),
                    )}
                  >
                    {o.side}
                  </span>
                  <span style={sx(`font:700 12px/1 ${MONO};min-width:150px`)}>{o.instrument}</span>
                  <span style={sx(`font:400 11px/1 ${MONO};color:${C.muted};min-width:80px`)}>
                    {o.size}
                  </span>
                  <span style={sx(`font:500 12px/1 ${MONO};min-width:90px`)}>{o.px}</span>
                  <span
                    style={sx(
                      `font:500 10px/1 ${MONO};letter-spacing:.1em;color:${STATUS_COLOR[o.status]}`,
                    )}
                  >
                    {o.status}
                  </span>
                  <div style={sx("flex:1")} />
                  <span style={sx(`font:400 10px/1 ${MONO};color:${C.faint}`)}>{o.time}</span>
                </div>

                {open && (
                  <div
                    style={sx(
                      `padding:12px 18px 14px;border-bottom:1px solid ${C.lineSoft};` +
                        `background:${C.raised};font:400 11px/1.5 ${MONO}`,
                    )}
                  >
                    {/* Computed on the server, at snapshot time, by the
                        synchronous `previewFillOrder` — the SDK never enters
                        this bundle. It is a quote against a book that is up to
                        15 seconds old, not a promise of a fill; P3 re-previews
                        against a freshly fetched order before it signs. */}
                    <div style={sx(`color:${C.faint}`)}>
                      client.optionBook.previewFillOrder(order, 1_000000n, referrer)
                    </div>
                    <div style={sx("margin-top:8px")}>
                      {preview === undefined ? (
                        <span style={sx(`color:${C.dim}`)}>no preview for this row</span>
                      ) : preview.fillable ? (
                        <span style={sx(`color:${C.muted}`)}>
                          $1.00 buys{" "}
                          <span style={sx(`color:${C.accent};font-weight:700`)}>
                            {preview.contracts}
                          </span>{" "}
                          contracts · collateral{" "}
                          <span style={sx(`color:${C.accent};font-weight:700`)}>
                            ${preview.collateral}
                          </span>
                        </span>
                      ) : (
                        <span style={sx(`color:${C.amber}`)}>no fill available</span>
                      )}
                    </div>
                    {/* The flagship. Rendered only with `THETADUEL_TRADE=on`
                        AND a wallet — so with either missing this whole subtree
                        is absent and the quote line above is the last thing on
                        the row, exactly as it was. */}
                    {canFill && wallet && (
                      <FillFlow row={o} wallet={wallet} referrer={trade.referrer} />
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </section>
      </div>

      <aside style={sx("display:flex;flex-direction:column;gap:16px;position:sticky;top:88px")}>
        <div
          style={sx(
            `border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden`,
          )}
        >
          <div
            style={sx(
              `padding:14px 16px;border-bottom:1px solid ${C.border};display:flex;align-items:center;gap:10px`,
            )}
          >
            <span style={sx(`font:700 14px/1 ${SANS}`)}>Options desk</span>
            <span
              style={sx(
                `font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.bg};background:${C.accent};` +
                  "border-radius:5px;padding:5px 6px",
              )}
            >
              4 LEGS
            </span>
          </div>

          <div style={sx("display:flex;flex-direction:column")}>
            {SLIP_LEGS.map((l) => (
              <div
                key={l.label}
                style={sx(
                  `display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${C.line}`,
                )}
              >
                <span
                  style={sx(
                    "width:22px;height:22px;flex:none;border-radius:6px;display:grid;place-items:center;" +
                      `font:700 9px/1 ${MONO};background:${l.side === "B" ? C.green : C.red};color:${C.bg}`,
                  )}
                >
                  {l.side}
                </span>
                <div style={sx("min-width:0;flex:1")}>
                  <div style={sx(`font:700 12px/1 ${MONO}`)}>{l.label}</div>
                  <div style={sx(`margin-top:5px;font:400 10px/1 ${MONO};color:${C.dim}`)}>
                    {l.meta}
                  </div>
                </div>
                <span style={sx(`font:500 12px/1 ${MONO};color:${C.muted}`)}>{l.prem}</span>
              </div>
            ))}
          </div>

          <div style={sx("padding:16px;display:flex;flex-direction:column;gap:10px")}>
            {SLIP_ROWS.map((r) => (
              <div
                key={r.label}
                style={sx(
                  `display:flex;justify-content:space-between;font:500 11.5px/1 ${MONO};color:${C.dim}`,
                )}
              >
                <span>{r.label}</span>
                <span style={sx(`color:${r.c}`)}>{r.value}</span>
              </div>
            ))}
            <button
              style={sx(
                `height:42px;margin-top:6px;border:none;border-radius:8px;background:${C.accent};` +
                  `color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`,
              )}
            >
              Launch attack · 0.412 ETH
            </button>
            {/* The one line on this panel that would become a lie the moment
                trading is on: the slip beside it is the seeded four-leg
                structure, and the thing that actually signs is a row of the
                real book below. Say which. */}
            <span
              style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.faint};text-align:center`)}
            >
              {canFill
                ? "Seeded slip. Real fills are on the live book rows below."
                : "Read-only preview. No signer connected."}
            </span>
          </div>
        </div>

        {canFill && wallet && (
          <ParlaySlip
            rows={slipRows}
            underlying={asset}
            wallet={wallet}
            referrer={trade.referrer}
            onRemove={toggleSlip}
          />
        )}

        {canFill && wallet && <ReferrerStrip wallet={wallet} referrer={trade.referrer} />}

        <div
          style={sx(
            `border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden`,
          )}
        >
          <div
            style={sx(
              `display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ${C.border}`,
            )}
          >
            <div
              style={sx(
                `width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,${C.indigo},${C.accent});` +
                  `display:grid;place-items:center;font:700 12px/1 ${MONO};color:${C.bg}`,
              )}
            >
              AI
            </div>
            <span style={sx(`font:700 13px/1 ${SANS}`)}>Coach reads your slip</span>
          </div>

          <div style={sx("display:flex;flex-direction:column;gap:12px;padding:16px")}>
            {SLIP_NOTES.map((n) => (
              <div
                key={n.tag}
                style={sx(
                  `border:1px solid ${C.border};border-radius:9px;background:${C.raised};padding:12px`,
                )}
              >
                <div style={sx("display:flex;align-items:center;gap:8px")}>
                  <span style={sx(tag(n.tc))}>{n.tag}</span>
                  <span style={sx(`font:700 11.5px/1 ${SANS}`)}>{n.title}</span>
                </div>
                <div
                  style={sx(
                    `margin-top:8px;font:400 11.5px/1.55 ${SANS};color:${C.muted};text-wrap:pretty`,
                  )}
                >
                  {n.body}
                </div>
              </div>
            ))}

            <div style={sx("display:flex;gap:8px;flex-wrap:wrap")}>
              {ASK_CHIPS.map((label) => (
                <button
                  key={label}
                  style={sx(
                    `height:28px;padding:0 10px;border:1px solid ${C.borderMid};border-radius:99px;` +
                      `background:transparent;color:${C.muted};font:500 11px/1 ${SANS};cursor:pointer`,
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The fill flow — the flagship, behind THETADUEL_TRADE=on
// ─────────────────────────────────────────────────────────────────────────────

/** The nine steps, in the order `runFill` walks them. Rendered as a stepper so
 *  a fill that stalls says *where* it stalled — one of nine named steps is a
 *  diagnosis on a stage, and "loading…" is not. */
const STEP_ORDER: readonly FillStep[] = [
  "cap",
  "signer",
  "refetch",
  "expiry",
  "preview",
  "confirm",
  "allowance",
  "fill",
  "done",
];

const STEP_LABEL: Record<FillStep, string> = {
  cap: "CAP",
  signer: "SIGNER",
  refetch: "REFETCH",
  expiry: "EXPIRY",
  preview: "PREVIEW",
  confirm: "CONFIRM",
  allowance: "APPROVE",
  fill: "FILL",
  done: "DONE",
};

/** What the recovery button says for each typed action. `refresh` and `fund`
 *  are things this app cannot do on the user's behalf, so they dismiss and the
 *  copy above them says what the user does instead. */
const ACTION_LABEL = {
  connect: "Connect wallet",
  switch: `Switch to ${SIGNING_CHAIN_NAME}`,
  retry: "Try again",
  refresh: "Dismiss",
  fund: "Dismiss",
  none: "Dismiss",
} as const;

/**
 * "Launch attack", for real, on one row of the live Base book.
 *
 * The state here is deliberately thin — the sequence lives in
 * `src/desk/fill.ts`, where it is testable without a chain. This component owns
 * three things and nothing else: which rung of the ladder is selected, which
 * step is current, and the promise that the confirm click resolves.
 *
 * **The confirm gate is the point.** `runFill` awaits `deps.confirm(quote)`, and
 * the only thing that resolves it `true` is a click on the collateral figure
 * itself — the number you press is the number that leaves the wallet. A button
 * labelled "Confirm" beside a number is a weaker promise about a different
 * thing.
 */
function FillFlow({
  row,
  wallet,
  referrer,
}: {
  row: OrderRow;
  wallet: DeskWallet;
  referrer: string;
}) {
  /**
   * The row's identity on the book, or `null` for a row that is not a live book
   * row at all — the mock's `ETH-27SEP-RANGER` parses to nothing, so **the
   * seeded book is unfillable by construction** rather than by a flag someone
   * has to remember to set. See `rowIdentity` in `src/desk/fill.ts`.
   */
  const ref = refFor(row);

  const [amount, setAmount] = useState<bigint>(TARGET_FILL_USDC);
  const [step, setStep] = useState<FillStep | null>(null);
  const [quote, setQuote] = useState<FillQuote | null>(null);
  const [outcome, setOutcome] = useState<FillOutcome | null>(null);
  const [running, setRunning] = useState(false);
  /** Resolves the confirm promise `runFill` is sitting on. */
  const decide = useRef<((ok: boolean) => void) | null>(null);

  // An unmount mid-flow — the row collapses, the 30s poll swaps the blotter —
  // must not leave `runFill` awaiting a click that can never arrive. Resolving
  // `false` ends it as `cancelled`, which is the truth: nobody confirmed.
  useEffect(() => () => decide.current?.(false), []);

  async function start() {
    if (!ref || running) return;
    setRunning(true);
    setOutcome(null);
    setStep(null);
    setQuote(null);

    const deps = createLiveFillDeps(wallet, { referrer: referrer || undefined });
    // The live adapter's own `confirm` refuses by default — a deps object that
    // could confirm itself would be a fill with no human in it. The panel is
    // what supplies consent, and only a click on the number does.
    deps.confirm = (q) =>
      new Promise<boolean>((resolve) => {
        setQuote(q);
        decide.current = resolve;
      });

    const result = await runFill(ref, amount, deps, (s, info) => {
      setStep(s);
      if (info?.quote) setQuote(info.quote);
    });
    decide.current = null;
    setOutcome(result);
    setRunning(false);
  }

  function recover(action: keyof typeof ACTION_LABEL) {
    if (action === "connect") void wallet.connect?.();
    else if (action === "switch") void wallet.switchToSigningChain?.();
    else if (action === "retry") void start();
    else setOutcome(null);
  }

  const awaiting = running && step === "confirm" && quote !== null;

  if (!ref) {
    return (
      <div style={sx(`margin-top:10px;font:400 10.5px/1.5 ${MONO};color:${C.dim}`)}>
        not a live book row — nothing to fill
      </div>
    );
  }

  return (
    <div
      style={sx(
        `margin-top:12px;padding-top:12px;border-top:1px solid ${C.line};` +
          "display:flex;flex-direction:column;gap:10px",
      )}
    >
      {/* The size selector IS the UI clamp the plan asks for beside the code
          cap: every rung is filtered against MAX_FILL_USDC, so no press can
          offer an amount `runFill` would refuse. The code cap stands anyway —
          a clamp in a view is a suggestion to whoever calls the function. */}
      <div style={sx("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>SIZE</span>
        {FILL_LADDER.filter((rung) => rung <= MAX_FILL_USDC).map((rung) => (
          <button
            key={String(rung)}
            disabled={running}
            onClick={() => setAmount(rung)}
            style={sx(pill(amount === rung))}
          >
            ${usdText(rung)}
          </button>
        ))}
        <span style={sx(`font:400 10px/1.4 ${MONO};color:${C.faint}`)}>
          cap ${usdText(MAX_FILL_USDC)} — enforced in code, not only here
        </span>
      </div>

      {/* THE HONEST LINE ABOUT THIS BUTTON.

          The strike, the premium and the greeks above are read from the live
          Thetanuts book on Base mainnet. The wallet signs on Base Sepolia, and
          `assertSigningChain` refuses anything else. Those two facts together
          mean this button cannot complete a fill — there is no Thetanuts
          deployment on any testnet to fill against, and the mainnet OptionBook
          will not take a testnet signature.

          The button is left in place, and it is left honest. Removing it would
          hide that the pricing path above is real and working; leaving it
          unlabelled would be a button that can only ever fail, which is the
          exact species of quiet untruth `docs/reality-check.md` catalogues.
          So it says what will happen before it is pressed. */}
      <p
        data-role="chain-split"
        style={sx(`margin:0;font:400 10px/1.5 ${MONO};color:${C.amber}`)}
      >
        {CHAIN_SPLIT_NOTE} A fill would have to be signed against the mainnet
        book, so it will stop at the chain guard rather than transact.
      </p>

      {!running && !outcome && (
        <button
          onClick={() => void start()}
          style={sx(
            `height:36px;border:none;border-radius:8px;background:${C.accent};color:${C.bg};` +
              `font:700 12px/1 ${SANS};cursor:pointer`,
          )}
        >
          Launch attack · ${usdText(amount)} USDC · {row.instrument}
        </button>
      )}

      {(running || outcome) && (
        <div style={sx("display:flex;gap:6px;flex-wrap:wrap")}>
          {STEP_ORDER.map((s, index) => {
            const at = step === null ? -1 : STEP_ORDER.indexOf(step);
            const done = at > index || outcome?.status === "filled";
            const here = at === index && running;
            return (
              <span
                key={s}
                style={sx(
                  `font:500 9px/1 ${MONO};letter-spacing:.1em;padding:5px 6px;border-radius:5px;` +
                    (here
                      ? `background:rgba(200,255,0,.14);color:${C.accent}`
                      : done
                        ? `background:rgba(74,222,128,.12);color:${C.green}`
                        : `background:${C.raised};color:${C.faint}`),
                )}
              >
                {STEP_LABEL[s]}
              </span>
            );
          })}
        </div>
      )}

      {awaiting && quote && (
        <div style={sx(`font:400 11px/1.6 ${MONO};color:${C.muted}`)}>
          <div>
            {contractText(quote.numContracts)} contracts for{" "}
            {/* Click the amount, not a button beside it. `premium`, not
                `totalCollateral`: the SDK caps the contract count at the
                maker's remaining collateral and does NOT cap the collateral
                figure, which comes back as the amount we asked for. This is the
                number the chain will actually pull, computed from the count it
                will actually use — see `premiumOf` in `src/desk/fill.ts`. The
                approval is still `totalCollateral`, because an allowance must
                cover what is pulled. */}
            <button
              onClick={() => decide.current?.(true)}
              style={sx(
                `border:1px solid ${C.accent};border-radius:7px;background:rgba(200,255,0,.12);` +
                  `color:${C.accent};font:700 13px/1 ${MONO};padding:7px 10px;cursor:pointer`,
              )}
            >
              ${usdText(quote.premium)}
            </button>
          </div>
          <div style={sx(`margin-top:6px;color:${C.faint}`)}>
            click the amount to approve exactly that and fill · collateral{" "}
            {quote.collateralToken.slice(0, 10)}…
          </div>
          <button
            onClick={() => decide.current?.(false)}
            style={sx(
              `margin-top:8px;height:28px;padding:0 10px;border:1px solid ${C.borderMid};` +
                `border-radius:7px;background:transparent;color:${C.muted};` +
                `font:500 11px/1 ${SANS};cursor:pointer`,
            )}
          >
            Cancel
          </button>
        </div>
      )}

      {running && !awaiting && (
        <div style={sx(`font:400 11px/1.5 ${MONO};color:${C.dim}`)}>
          {step === "fill" ? "signing and submitting…" : "working…"}
        </div>
      )}

      {outcome?.status === "filled" && (
        <div style={sx(`font:400 11px/1.6 ${MONO};color:${C.green}`)}>
          FILLED · {contractText(outcome.quote.numContracts)} contracts · $
          {usdText(outcome.quote.premium)} ·{" "}
          {outcome.approvalSkipped ? "1 tx (allowance already sufficient)" : "2 tx"}
          <div style={sx("margin-top:6px")}>
            <a
              href={outcome.explorer}
              target="_blank"
              rel="noreferrer"
              style={sx(`color:${C.accent}`)}
            >
              {outcome.hash.slice(0, 12)}… on BaseScan
            </a>
          </div>
          {outcome.nonce && (
            <div style={sx(`margin-top:4px;color:${C.faint}`)}>order nonce {outcome.nonce}</div>
          )}
        </div>
      )}

      {outcome?.status === "cancelled" && (
        <div style={sx(`font:400 11px/1.5 ${MONO};color:${C.dim}`)}>
          cancelled — nothing was approved and nothing was spent
        </div>
      )}

      {outcome?.status === "failed" && (
        <div
          style={sx(
            `border:1px solid ${C.amber}55;background:${C.amber}12;border-radius:8px;padding:10px;` +
              `font:400 11px/1.6 ${MONO};color:${C.amber}`,
          )}
        >
          <div style={sx(`font:700 10px/1 ${MONO};letter-spacing:.1em`)}>
            {outcome.error.code} · at {STEP_LABEL[outcome.error.step]}
          </div>
          <div style={sx(`margin-top:7px;color:${C.textSoft}`)}>{outcome.error.message}</div>
          <div style={sx(`margin-top:5px;color:${C.muted}`)}>{outcome.error.recovery}</div>
          {outcome.error.throttled && (
            <div style={sx(`margin-top:5px;color:${C.faint}`)}>{ALCHEMY_HINT}</div>
          )}
          {outcome.error.detail && (
            <div style={sx(`margin-top:5px;color:${C.faint}`)}>{outcome.error.detail}</div>
          )}
          <button
            onClick={() => recover(outcome.error.action)}
            style={sx(
              `margin-top:9px;height:28px;padding:0 10px;border:1px solid ${C.borderMid};` +
                `border-radius:7px;background:transparent;color:${C.muted};` +
                `font:500 11px/1 ${SANS};cursor:pointer`,
            )}
          >
            {ACTION_LABEL[outcome.error.action]}
          </button>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The parlay slip — N legs, one confirmation, N transactions
// ─────────────────────────────────────────────────────────────────────────────

/** The §D3 ladder, as chips. `dropped` and `failed` are their own terminals
 *  because "nothing was spent" and "gas was spent and it reverted" are not the
 *  same news. */
const LEG_STATUS_LABEL: Record<ParlayLegState["status"], string> = {
  pending: "PENDING",
  previewed: "PREVIEWED",
  dropped: "DROPPED",
  approved: "APPROVED",
  filled: "FILLED ✓",
  failed: "FAILED",
};

const LEG_STATUS_COLOR: Record<ParlayLegState["status"], string> = {
  pending: C.faint,
  previewed: C.blue,
  dropped: C.dim,
  approved: C.accent,
  filled: C.green,
  failed: C.amber,
};

/**
 * One rung of the §D3 ladder, drawn.
 *
 * Exported so `test/fill.test.ts` can assert every terminal renders what it
 * promises without a chain: a BaseScan link on `filled`, the mapped error code
 * on `failed`, and the reason on `dropped`. A ladder is the strongest "this is
 * real" artifact a demo has, and a hash nobody can open is not evidence.
 */
export function ParlayLegChip({ leg }: { leg: ParlayLegState }) {
  const color = LEG_STATUS_COLOR[leg.status];
  return (
    <div
      style={sx(
        `display:flex;flex-direction:column;gap:4px;padding:8px 10px;border-radius:8px;` +
          `border:1px solid ${C.line};background:${C.raised}`,
      )}
    >
      <div style={sx("display:flex;align-items:center;gap:8px")}>
        <span style={sx(`font:700 10.5px/1 ${MONO};flex:1;min-width:0`)}>{leg.label}</span>
        <span style={sx(`font:700 9px/1 ${MONO};letter-spacing:.1em;color:${color}`)}>
          {LEG_STATUS_LABEL[leg.status]}
        </span>
      </div>
      {leg.quote && (
        <div style={sx(`font:400 10px/1.4 ${MONO};color:${C.muted}`)}>
          {contractText(leg.quote.numContracts)} contracts · ${usdText(leg.quote.premium)}
          {leg.status === "filled" &&
            (leg.approvalSkipped ? " · 1 tx (allowance sufficient)" : " · 2 tx")}
        </div>
      )}
      {/* A hash nobody can open is not evidence. This link is the strongest
          "this is real" artifact the demo has, so it is on the leg rather than
          on a summary line the eye slides past. */}
      {leg.status === "filled" && leg.explorer && (
        <a
          href={leg.explorer}
          target="_blank"
          rel="noreferrer"
          style={sx(`font:400 10px/1.4 ${MONO};color:${C.accent}`)}
        >
          {leg.hash?.slice(0, 12)}… on BaseScan
        </a>
      )}
      {leg.status === "dropped" && leg.dropped && (
        <div style={sx(`font:400 10px/1.4 ${MONO};color:${C.dim}`)}>
          {leg.dropped} — {DROP_COPY[leg.dropped]}
        </div>
      )}
      {leg.status === "failed" && leg.error && (
        <div style={sx(`font:400 10px/1.4 ${MONO};color:${C.amber}`)}>
          {leg.error.code} at {STEP_LABEL[leg.error.step]} — {leg.error.message}
        </div>
      )}
    </div>
  );
}

/**
 * The slip, and the one confirmation that buys it.
 *
 * **A parlay is N independent fills, one transaction each** — the seven
 * physical multi-leg implementations on Base are the zero address
 * (`tnuts-test/FINDINGS.md` §3), so there is no atomic basket to buy and this
 * screen does not pretend there is one. Everything visible here follows from
 * that: the per-leg ladder, the partial-fill sentence above the button, and the
 * fact that the result can read "2 of 3 landed" without anything having gone
 * wrong with the app.
 *
 * The sequence lives in `src/desk/fill.ts`, where `test/fill.test.ts` drives
 * every branch with no chain in reach. This component owns four things: which
 * rung is selected, the ladder as it arrives, the slip quote that is awaiting a
 * confirmation, and the promise that clicking the total resolves.
 */
function ParlaySlip({
  rows,
  underlying,
  wallet,
  referrer,
  onRemove,
}: {
  rows: readonly PricingRow[];
  underlying: string;
  wallet: DeskWallet;
  referrer: string;
  onRemove: (key: string) => void;
}) {
  const [amount, setAmount] = useState<bigint>(TARGET_FILL_USDC);
  const [ladder, setLadder] = useState<readonly ParlayLegState[] | null>(null);
  const [step, setStep] = useState<FillStep | null>(null);
  const [slip, setSlip] = useState<ParlaySlipQuote | null>(null);
  const [result, setResult] = useState<ParlayFillResult | null>(null);
  const [running, setRunning] = useState(false);
  /** Resolves the one confirmation `runParlayFill` is sitting on. */
  const decide = useRef<((ok: boolean) => void) | null>(null);

  // An unmount mid-slip must not leave the sequence awaiting a click that can
  // never arrive. `false` ends it as `cancelled`, which is the truth.
  useEffect(() => () => decide.current?.(false), []);

  /**
   * The legs, and the two fields the duel clock cannot do without.
   *
   * `instrument` is the key a filled leg is marked by, and it must be the
   * **venue's own** name, verbatim (`src/engine/score.ts`): the order book's
   * `ETH-3SEP-4400-C` is a different namespace from the market maker's
   * `ETH-3SEP26-2100-C`, and only the second one keys into a marks map. It is
   * therefore **copied** off `row.markTicker` — the ticker of the MM quote that
   * joined this row's mark — and left `undefined` when no quote joined. Never
   * composed from a strike and an expiry: a near-miss key is the one failure
   * that pays the wrong player quietly, and the honest outcome is `unmarkable`
   * → no verdict → both stakes refunded.
   *
   * `entryMarkUsd` is the same story in the other dimension: dollars, because
   * the premium is dollars, and absent when the quote published no spot to
   * convert with. Both are copied, neither is computed here, and the line below
   * says on screen how many legs are missing either.
   */
  const legs: ParlayFillLeg[] = rows.map((row) => ({
    id: rowKey(row),
    // The structure rides on the label for the same reason it now rides on
    // `rowKey`: `type` is the colour bucket, and a fly labelled `BTC-5 SEP-
    // 85,000-C` reads on the ladder and on the confirm screen as a plain call
    // at one strike. It is appended rather than substituted so a vanilla's
    // label is byte-identical to the one this screen always printed.
    label: legLabel(underlying, row),
    instrument: row.markTicker,
    entryMarkUsd: markUsdOf(row),
    order: row.order!,
    usdcAmount: amount,
  }));
  /** Legs the duel clock could not score even if they all landed. */
  const unscoreable = legs.filter((l) => !l.instrument || l.entryMarkUsd === undefined);
  /** What the slip asks for. Shown beside the cap so the staircase is visible
   *  before it is refused — but the refusal itself is in code, above the
   *  network, which is the half that is a bound. */
  const requested = legs.reduce((acc, l) => acc + l.usdcAmount, 0n);
  const overCap = requested > MAX_FILL_USDC;

  /** `|delta|` per leg id — the "chance to land", for the re-score. */
  const probOf = new Map<string, number>();
  for (const row of rows) {
    const d = absDelta(row.delta);
    if (d !== null) probOf.set(rowKey(row), d);
  }

  /**
   * The slip's degeneracy score over the legs that actually landed.
   *
   * `degeneracyScore` (`src/engine/parlay.ts`) is the product of `1 / prob`. It
   * is a GAME number and it is rendered without a currency symbol, because a
   * basket of options pays the **sum** of its legs and never the product — see
   * `basketPayoff`. This is what "your slip re-scores" means, computed: a
   * three-leg slip that lands two legs is a shorter shot than the one the
   * player pressed, and the score says so instead of quietly keeping the old
   * one.
   */
  function scoreOf(states: readonly ParlayLegState[]): number | null {
    const probs = states.map((s) => probOf.get(s.id)).filter((p): p is number => p !== undefined);
    return probs.length === states.length && probs.length > 0
      ? degeneracyScore(probs.map((prob) => ({ prob })))
      : null;
  }

  const pressedScore = scoreOf(legs.map((l) => ({ id: l.id, label: l.label, status: "pending" })));

  async function start() {
    if (running || legs.length === 0) return;
    setRunning(true);
    setResult(null);
    setLadder(null);
    setSlip(null);
    setStep(null);

    const deps = createLiveFillDeps(wallet, { referrer: referrer || undefined });
    // One confirmation, for the whole slip, and only a click on the total
    // resolves it. The live adapter's own `confirm` refuses by default; a deps
    // object that could confirm itself would be a fill with no human in it.
    deps.confirmSlip = (quote) =>
      new Promise<boolean>((resolve) => {
        setSlip(quote);
        decide.current = resolve;
      });

    const outcome = await runParlayFill(legs, deps, (states, s) => {
      setLadder(states);
      setStep(s);
    });
    decide.current = null;
    setSlip(null);
    setResult(outcome);
    setRunning(false);
  }

  const awaiting = running && slip !== null;
  const landedScore = result ? scoreOf(result.filled) : null;

  return (
    <div
      style={sx(
        `border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden`,
      )}
    >
      <div
        style={sx(
          `display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ${C.border}`,
        )}
      >
        <span style={sx(`font:700 13px/1 ${SANS}`)}>Parlay slip</span>
        <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>
          {legs.length} LEG{legs.length === 1 ? "" : "S"} · {legs.length} TX
        </span>
      </div>

      <div style={sx("padding:14px 16px;display:flex;flex-direction:column;gap:10px")}>
        {legs.length === 0 && (
          <div style={sx(`font:400 10.5px/1.6 ${MONO};color:${C.dim}`)}>
            Empty. Press <span style={sx(`color:${C.muted}`)}>+ SLIP</span> on a chain row that a
            resting order backs — a level quoted by market makers alone has nothing to buy.
          </div>
        )}

        {/* The pre-flight list: what the player picked, and what each leg's
            premium is. Max loss is the premium, at every rank and every detail
            level, and it is above the size selector rather than behind it. */}
        {!running &&
          !result &&
          rows.map((row) => (
            <div
              key={rowKey(row)}
              style={sx(
                `display:flex;align-items:center;gap:8px;font:400 10.5px/1.4 ${MONO};color:${C.muted}`,
              )}
            >
              <span style={sx(tag(TYPE_COLOR[row.type]))}>{row.type}</span>
              <span style={sx(`font-weight:700;color:${C.text}`)}>{row.strike}</span>
              <span style={sx(`color:${C.dim}`)}>{row.expiry}</span>
              <div style={sx("flex:1")} />
              <span style={sx(`color:${C.red}`)}>{row.ask}</span>
              <button
                onClick={() => onRemove(rowKey(row))}
                style={sx(
                  `height:20px;width:20px;border:1px solid ${C.borderMid};border-radius:6px;` +
                    `background:transparent;color:${C.dim};font:700 10px/1 ${MONO};cursor:pointer`,
                )}
              >
                ×
              </button>
            </div>
          ))}

        {/* Size, per leg. Every rung is filtered against MAX_FILL_USDC — but
            the rung is per LEG, and the cap is on the SLIP, which is exactly
            the staircase §D1 names. The line below states the sum against the
            bound so the player can see it before pressing; the refusal itself
            lives in `runParlayFill`, above the network. */}
        {!running && !result && legs.length > 0 && (
          <>
            <div style={sx("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
              <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>
                PER LEG
              </span>
              {FILL_LADDER.filter((rung) => rung <= MAX_FILL_USDC).map((rung) => (
                <button
                  key={String(rung)}
                  onClick={() => setAmount(rung)}
                  style={sx(pill(amount === rung))}
                >
                  ${usdText(rung)}
                </button>
              ))}
            </div>
            <div
              style={sx(
                `font:400 10px/1.5 ${MONO};color:${overCap ? C.amber : C.faint}`,
              )}
            >
              slip total ${usdText(requested)} · cap ${usdText(MAX_FILL_USDC)}
              {overCap
                ? " — refused in code, on the SUM. A cap the sum can step over is a cap with a staircase next to it."
                : " — the cap is checked on the sum as well as on each leg"}
            </div>
            {pressedScore !== null && (
              <div style={sx(`font:400 10px/1.5 ${MONO};color:${C.dim}`)}>
                degeneracy ×{pressedScore.toFixed(2)} — a game score, not a payout. A basket pays
                the sum of its legs.
              </div>
            )}
            {/* The two clocks are independent, and one of them cannot read
                these legs. Said before the press, not after the refund: the
                option still settles at expiry on chain either way, but the
                four-minute duel needs a mark and a name to read it by, and the
                book publishes a market-maker ticker for ETH and BTC only. */}
            {unscoreable.length > 0 && (
              <div style={sx(`font:400 10px/1.55 ${MONO};color:${C.amber}`)}>
                {unscoreable.length} of {legs.length} leg
                {legs.length === 1 ? "" : "s"} cannot be scored on the duel clock — no
                market-maker mark and ticker for {unscoreable.length === 1 ? "it" : "them"}. The
                position is real and settles at expiry regardless; the duel itself would refund
                both stakes.
              </div>
            )}
            <button
              onClick={() => void start()}
              style={sx(
                `height:36px;border:none;border-radius:8px;background:${C.accent};color:${C.bg};` +
                  `font:700 12px/1 ${SANS};cursor:pointer`,
              )}
            >
              Review slip · {legs.length} leg{legs.length === 1 ? "" : "s"}
            </button>
          </>
        )}

        {/* ── The confirm screen. One confirmation, for the whole slip. ──── */}
        {awaiting && slip && (
          <div style={sx("display:flex;flex-direction:column;gap:9px")}>
            <div style={sx(`font:700 10px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>
              CONFIRM THE SLIP
            </div>
            {slip.legs.map((leg) => (
              <div
                key={leg.id}
                style={sx(
                  `display:flex;gap:8px;font:400 10.5px/1.4 ${MONO};color:${C.muted}`,
                )}
              >
                <span style={sx(`flex:1;min-width:0;color:${C.text}`)}>{leg.label}</span>
                <span>{contractText(leg.quote!.numContracts)}</span>
                <span style={sx(`color:${C.accent}`)}>${usdText(leg.quote!.premium)}</span>
              </div>
            ))}
            {/* Legs the book removed between the press and this screen, named
                rather than silently dropped — a slip that quietly shrinks is a
                slip the player did not build. */}
            {slip.dropped.map((leg) => (
              <div key={leg.id} style={sx(`font:400 10px/1.4 ${MONO};color:${C.dim}`)}>
                {leg.label} — dropped, {leg.dropped ? DROP_COPY[leg.dropped] : "not fillable"}
              </div>
            ))}
            <div
              style={sx(
                `display:flex;justify-content:space-between;font:500 11px/1 ${MONO};color:${C.muted}`,
              )}
            >
              <span>total debit</span>
              <span style={sx(`color:${C.text}`)}>${usdText(slip.totalDebit)}</span>
            </div>
            {/* Max loss, above the button, unconditionally. It is the same
                number as the debit — every leg is a long option, so the premium
                paid is the whole of the downside — and saying so is the single
                most valuable habit this product can build. */}
            <div
              style={sx(
                `display:flex;justify-content:space-between;font:700 11px/1 ${MONO};color:${C.amber}`,
              )}
            >
              <span>total max loss</span>
              <span>${usdText(slip.maxLoss)}</span>
            </div>
            {/* §D2 — the policy, on screen, BEFORE the first signature. */}
            <div
              style={sx(
                `border:1px solid ${C.borderMid};border-radius:8px;padding:9px;` +
                  `font:400 10.5px/1.55 ${SANS};color:${C.textSoft};text-wrap:pretty`,
              )}
            >
              {slip.policy}
            </div>
            <button
              onClick={() => decide.current?.(true)}
              style={sx(
                `border:1px solid ${C.accent};border-radius:8px;background:rgba(200,255,0,.12);` +
                  `color:${C.accent};font:700 14px/1 ${MONO};padding:10px;cursor:pointer`,
              )}
            >
              ${usdText(slip.totalDebit)}
            </button>
            <div style={sx(`font:400 10px/1.5 ${MONO};color:${C.faint};text-align:center`)}>
              click the amount — each leg approves exactly its own collateral, never MaxUint256
            </div>
            <button
              onClick={() => decide.current?.(false)}
              style={sx(
                `height:28px;border:1px solid ${C.borderMid};border-radius:7px;background:transparent;` +
                  `color:${C.muted};font:500 11px/1 ${SANS};cursor:pointer`,
              )}
            >
              Cancel
            </button>
          </div>
        )}

        {/* ── The §D3 ladder ─────────────────────────────────────────────── */}
        {(ladder || result) && !awaiting && (
          <div style={sx("display:flex;flex-direction:column;gap:7px")}>
            {(result?.legs ?? ladder ?? []).map((leg) => (
              <ParlayLegChip key={leg.id} leg={leg} />
            ))}
          </div>
        )}

        {running && !awaiting && (
          <div style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.dim}`)}>
            {step === "fill" ? "signing and submitting…" : `working… (${step ?? "cap"})`}
          </div>
        )}

        {result && result.status !== "refused" && (
          <div
            style={sx(
              `font:400 10.5px/1.6 ${MONO};color:${
                result.status === "filled"
                  ? C.green
                  : result.status === "partial"
                    ? C.amber
                    : C.dim
              }`,
            )}
          >
            {result.status === "cancelled"
              ? "cancelled — nothing was approved and nothing was spent"
              : `${result.filled.length} of ${result.legs.length} legs landed · spent $${usdText(result.spent)}`}
            {/* The re-score, which is the second half of the policy the player
                read before signing. It is a game number and carries no `$`. */}
            {result.filled.length > 0 && landedScore !== null && (
              <div style={sx(`margin-top:5px;color:${C.dim}`)}>
                slip re-scored — degeneracy ×{landedScore.toFixed(2)} on what landed
              </div>
            )}
            {result.status === "partial" && (
              <div style={sx(`margin-top:5px;color:${C.faint}`)}>
                Nothing was unwound. Selling the landed legs back into a thin book would turn a
                failed leg into a realised loss; you keep the options you paid for.
              </div>
            )}
            {/* On the receipt too, because this is where a player looks when
                the duel later refunds instead of paying. */}
            {result.unmarkable.length > 0 && (
              <div style={sx(`margin-top:5px;color:${C.amber}`)}>
                {result.unmarkable.length} landed leg
                {result.unmarkable.length === 1 ? "" : "s"} carry no market-maker mark, so the duel
                clock cannot score {result.unmarkable.length === 1 ? "it" : "them"} — the duel
                refunds. The options are yours and settle at expiry on chain.
              </div>
            )}
          </div>
        )}

        {result?.status === "refused" && result.error && (
          <div
            style={sx(
              `border:1px solid ${C.amber}55;background:${C.amber}12;border-radius:8px;padding:10px;` +
                `font:400 10.5px/1.6 ${MONO};color:${C.amber}`,
            )}
          >
            <div style={sx(`font:700 10px/1 ${MONO};letter-spacing:.1em`)}>
              {result.error.code} · at {STEP_LABEL[result.error.step]}
            </div>
            <div style={sx(`margin-top:7px;color:${C.textSoft}`)}>{result.error.message}</div>
            <div style={sx(`margin-top:5px;color:${C.muted}`)}>{result.error.recovery}</div>
          </div>
        )}

        {result && (
          <button
            onClick={() => {
              setResult(null);
              setLadder(null);
              setStep(null);
            }}
            style={sx(
              `height:28px;border:1px solid ${C.borderMid};border-radius:7px;background:transparent;` +
                `color:${C.muted};font:500 11px/1 ${SANS};cursor:pointer`,
            )}
          >
            {ACTION_LABEL[result.error?.action ?? "none"]}
          </button>
        )}

        {/* The policy is on the confirm screen because that is where §D2 puts
            it — but it is also here, before the player has pressed anything, so
            nobody meets it for the first time with a wallet prompt open. */}
        {!running && !result && legs.length > 0 && (
          <div style={sx(`font:400 10px/1.55 ${SANS};color:${C.faint};text-wrap:pretty`)}>
            {PARTIAL_FILL_POLICY}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The desk's referrer strip.
 *
 * Every fill this app makes carries `THETADUEL_REFERRER`, which is how a trade
 * is provably attributed to THETADUEL on-chain. It is **attribution, never
 * revenue**: an un-whitelisted referrer's split is `0n` basis points, and the
 * copy says exactly that rather than implying a revenue share that does not
 * exist yet (the owner's action item is to ask Thetanuts to whitelist the
 * address).
 *
 * `claimAllFees` is wired because the plan asks for the round trip to be real,
 * not because there is anything to claim at 0 bps — at which point it claims
 * nothing and says so, which is the honest demo.
 */
function ReferrerStrip({ wallet, referrer }: { wallet: DeskWallet; referrer: string }) {
  const [bps, setBps] = useState<bigint | null>(null);
  const [claim, setClaim] = useState<string | null>(null);
  const [claiming, setClaiming] = useState(false);

  useEffect(() => {
    let live = true;
    void readReferrerSplit(referrer).then((value) => {
      if (live) setBps(value);
    });
    return () => {
      live = false;
    };
  }, [referrer]);

  async function claimFees() {
    setClaiming(true);
    const result = await claimReferrerFees(wallet, referrer);
    setClaim(
      result.ok
        ? result.claimed === 0
          ? "nothing to claim — the split is 0 bps"
          : `claimed ${result.claimed} token${result.claimed === 1 ? "" : "s"}`
        : `${result.error.code} — ${result.error.message}`,
    );
    setClaiming(false);
  }

  return (
    <div
      style={sx(
        `border:1px solid ${C.border};border-radius:12px;background:${C.card};padding:14px 16px;` +
          "display:flex;flex-direction:column;gap:8px",
      )}
    >
      <div style={sx(`font:700 12px/1 ${SANS}`)}>Referrer attribution</div>
      <div style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.muted}`)}>
        {referrer ? `${referrer.slice(0, 10)}…${referrer.slice(-4)}` : "THETADUEL_REFERRER unset"}
      </div>
      <div
        style={sx(
          `font:500 10px/1.4 ${MONO};letter-spacing:.08em;color:${
            bps !== null && bps > 0n ? C.green : C.dim
          }`,
        )}
      >
        {splitLabel(bps)}
      </div>
      <div style={sx(`font:400 10px/1.5 ${MONO};color:${C.faint}`)}>
        client.optionBook.getReferrerFeeSplit(referrer) — attribution, not revenue
      </div>
      <button
        disabled={claiming || !referrer}
        onClick={() => void claimFees()}
        style={sx(
          `height:30px;border:1px solid ${C.borderMid};border-radius:7px;background:transparent;` +
            `color:${C.muted};font:500 11px/1 ${SANS};cursor:pointer`,
        )}
      >
        {claiming ? "claiming…" : "claimAllFees(referrer)"}
      </button>
      {claim && <div style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.dim}`)}>{claim}</div>}
    </div>
  );
}
