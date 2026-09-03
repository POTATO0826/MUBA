import { ASK_CHIPS, SLIP_LEGS, SLIP_NOTES, SLIP_ROWS } from "../data/fixtures.ts";
import type { MarketSource } from "../data/market.ts";
import { buildPayoffChart } from "../engine/payoff.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill, tag } from "../theme.ts";

const PRICING_COLUMNS = "88px 96px 110px 100px 100px 84px 84px 1fr";

const TYPE_COLOR = { CALL: C.green, PUT: C.red, RANGER: C.violet } as const;
const STATUS_COLOR = {
  FILLED: C.green,
  PARTIAL: C.amber,
  OPEN: C.blue,
  CANCELLED: C.dim,
} as const;

interface ParlayProps {
  source: MarketSource;
  asset: string;
  onAsset: (a: string) => void;
}

export function Parlay({ source, asset, onAsset }: ParlayProps) {
  const chart = buildPayoffChart();
  const pricing = source.pricing(asset);
  const orders = source.orders();

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
              <text x={chart.spotLabelX} y="14" fill={C.muted} fontFamily={MONO} fontSize="10">
                SPOT 4,182
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
            <span style={sx(`font:500 10px/1 ${MONO};color:${C.green}`)}>
              ● client.mmPricing.getPricingArray
            </span>
          </div>

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
            <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>client.api.fetchOrders</span>
            <div style={sx("flex:1")} />
            <span
              style={sx(
                `display:flex;align-items:center;gap:7px;font:500 10px/1 ${MONO};color:${C.muted}`,
              )}
            >
              <span
                style={sx(
                  `width:6px;height:6px;border-radius:99px;background:${C.green};animation:vcPulse 2s infinite`,
                )}
              />
              STREAMING
            </span>
          </div>

          {orders.map((o, i) => (
            <div
              key={`${o.instrument}-${o.time}-${i}`}
              style={sx(
                `display:flex;align-items:center;gap:14px;padding:12px 18px;` +
                  `border-bottom:1px solid ${C.lineSoft};background:${i % 2 ? C.panelAlt : "transparent"}`,
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
          ))}
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
            <span
              style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.faint};text-align:center`)}
            >
              Read-only preview. No signer connected.
            </span>
          </div>
        </div>

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
