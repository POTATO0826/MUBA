import { useEffect, useRef, useState } from "react";
import { ASK_CHIPS, SLIP_LEGS, SLIP_NOTES, SLIP_ROWS } from "../data/fixtures.ts";
import type { MarketSource } from "../data/market.ts";
import { REFRESH_MS } from "../data/thetanuts.tsx";
import {
  ALCHEMY_HINT,
  FILL_LADDER,
  MAX_FILL_USDC,
  TARGET_FILL_USDC,
  claimReferrerFees,
  contracts as contractText,
  createLiveFillDeps,
  readReferrerSplit,
  refFor,
  runFill,
  splitLabel,
  usdText,
  type FillOutcome,
  type FillQuote,
  type FillStep,
  type FillWallet,
} from "../desk/fill.ts";
import { buildPayoffChart, ETH_VOL_BOX } from "../desk/payoff.ts";
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
import type { OrderRow } from "../types.ts";

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
  switchToBase?(): Promise<void>;
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
              <line
                x1={chart.spotX}
                x2={chart.spotX}
                y1="18"
                y2="252"
                stroke={C.dim}
                strokeWidth="1.5"
                strokeDasharray="3 3"
              />
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
                <div key={s.label}>
                  <div
                    style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}
                  >
                    {s.label}
                  </div>
                  <div
                    style={sx(
                      `margin-top:8px;font:700 18px/1 ${MONO};letter-spacing:-.02em;color:${s.color}`,
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
                key={`${r.type}-${r.strike}`}
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
  switch: "Switch to Base",
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
    else if (action === "switch") void wallet.switchToBase?.();
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
            {/* Click the amount, not a button beside it. This exact figure is
                what `ensureAllowance` approves — never MaxUint256 — and what
                `fillOrder` then spends. */}
            <button
              onClick={() => decide.current?.(true)}
              style={sx(
                `border:1px solid ${C.accent};border-radius:7px;background:rgba(200,255,0,.12);` +
                  `color:${C.accent};font:700 13px/1 ${MONO};padding:7px 10px;cursor:pointer`,
              )}
            >
              ${usdText(quote.totalCollateral)}
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
          {usdText(outcome.quote.totalCollateral)} ·{" "}
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
