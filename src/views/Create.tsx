import { UNIVERSE } from "../data/universe.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill } from "../theme.ts";
import type { BattleState } from "../state/battle.ts";
import type { MarketFilter } from "../types.ts";

const STEP_BTN =
  `width:30px;height:30px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
  `color:${C.text};font:700 15px/1 ${MONO};cursor:pointer`;

const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;
const NOTE = `margin-top:8px;font:400 10.5px/1.4 ${MONO};color:${C.faint}`;

const MARKET_TABS: readonly { k: MarketFilter; label: string; note: string }[] = [
  { k: "STOCK", label: "Stocks", note: "9 tickers" },
  { k: "CRYPTO", label: "Web3 crypto", note: "9 assets" },
  { k: "MIXED", label: "Mixed", note: "both books" },
];

const SPEEDS = [32, 64, 128] as const;

interface CreateProps {
  state: BattleState;
  activeCount: number;
  entryLabel: string;
  prizeLabel: string;
  onBack: () => void;
  onPrizeInput: (raw: string) => void;
  onPrizeBlur: () => void;
  onPrizeUp: () => void;
  onPrizeDown: () => void;
  onLobbyName: (name: string) => void;
  onMarket: (m: MarketFilter) => void;
  onPicksUp: () => void;
  onPicksDown: () => void;
  onChartsUp: () => void;
  onChartsDown: () => void;
  onTapeSpeed: (v: 32 | 64 | 128) => void;
  onToggleAsset: (sym: string) => void;
  onPublish: () => void;
}

export function Create(p: CreateProps) {
  const { state } = p;

  const universeLabel =
    (state.market === "CRYPTO"
      ? "CRYPTO UNIVERSE"
      : state.market === "STOCK"
        ? "STOCK UNIVERSE"
        : "MIXED UNIVERSE") + ` · ${p.activeCount} ACTIVE`;

  const speedNote =
    state.tapeSpeed === 32
      ? "tape plays in ~12s"
      : state.tapeSpeed === 128
        ? "tape plays in ~5s"
        : "tape plays in ~8s";

  const marketAssets = UNIVERSE.filter((u) => state.market === "MIXED" || u.mkt === state.market);

  return (
    <div style={sx("padding:28px;max-width:940px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:12px;margin-bottom:18px")}>
        <button
          onClick={p.onBack}
          style={sx(
            `height:30px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;` +
              `background:transparent;color:${C.muted};font:500 12px/1 ${SANS};cursor:pointer`,
          )}
        >
          ← Battles
        </button>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Create battle</h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.violet};` +
              "border:1px solid rgba(167,139,250,.35);background:rgba(167,139,250,.12);" +
              "border-radius:6px;padding:6px 8px",
          )}
        >
          ADMIN
        </span>
      </div>

      <div
        style={sx(
          `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`,
        )}
      >
        <div
          style={sx(
            `display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid ${C.line}`,
          )}
        >
          <div style={sx(`padding:20px;border-right:1px solid ${C.line}`)}>
            <div style={sx(LABEL)}>PRIZE POOL</div>
            <div style={sx("display:flex;align-items:center;gap:12px;margin-top:14px")}>
              <button
                onClick={p.onPrizeDown}
                style={sx(
                  `width:34px;height:34px;border:1px solid ${C.borderMid};border-radius:8px;` +
                    `background:transparent;color:${C.text};font:700 16px/1 ${MONO};cursor:pointer`,
                )}
              >
                −
              </button>
              <div
                style={sx(
                  `display:flex;align-items:baseline;gap:8px;padding:6px 10px;` +
                    `border:1px solid ${C.border};border-radius:9px;background:${C.raised}`,
                )}
              >
                <input
                  type="text"
                  inputMode="decimal"
                  value={state.prizeText}
                  onChange={(e) => p.onPrizeInput(e.target.value)}
                  onBlur={p.onPrizeBlur}
                  style={sx(
                    `width:112px;border:none;outline:none;background:transparent;color:${C.accent};` +
                      `font:700 30px/1.1 ${MONO};letter-spacing:-.02em;padding:0`,
                  )}
                />
                <span style={sx(`font:700 16px/1 ${MONO};color:${C.dim}`)}>ETH</span>
              </div>
              <button
                onClick={p.onPrizeUp}
                style={sx(
                  `width:34px;height:34px;border:1px solid ${C.borderMid};border-radius:8px;` +
                    `background:transparent;color:${C.text};font:700 16px/1 ${MONO};cursor:pointer`,
                )}
              >
                +
              </button>
            </div>
            <div
              style={sx(
                `margin-top:12px;font:400 11.5px/1.55 ${SANS};color:${C.muted};text-wrap:pretty`,
              )}
            >
              Adjustable until the lobby is published. Once public the prize is locked for every
              player who joins.
            </div>
          </div>

          <div style={sx("padding:20px")}>
            <div style={sx(LABEL)}>ENTRY PER PLAYER</div>
            <div style={sx(`margin-top:14px;font:700 32px/1 ${MONO};letter-spacing:-.02em`)}>
              {p.entryLabel}
            </div>
            <div style={sx(`margin-top:12px;font:400 11.5px/1.55 ${SANS};color:${C.muted}`)}>
              Half the pool each in 1v1. Winner takes the full pool.
            </div>
          </div>
        </div>

        <div style={sx(`padding:18px 20px;border-bottom:1px solid ${C.line}`)}>
          <div style={sx(LABEL)}>LOBBY NAME</div>
          <input
            type="text"
            value={state.lobbyName}
            onChange={(e) => p.onLobbyName(e.target.value)}
            placeholder="Room #4471"
            style={sx(
              `width:100%;max-width:420px;height:38px;margin-top:12px;padding:0 12px;` +
                `border:1px solid ${C.border};border-radius:9px;background:${C.raised};` +
                `color:${C.text};font:700 14px/1 ${SANS};outline:none`,
            )}
          />
        </div>

        <div style={sx(`padding:18px 20px;border-bottom:1px solid ${C.line}`)}>
          <div style={sx(LABEL)}>MARKET</div>
          <div style={sx("display:flex;gap:8px;margin-top:12px")}>
            {MARKET_TABS.map((m) => (
              <button
                key={m.k}
                onClick={() => p.onMarket(m.k)}
                style={sx(
                  "display:flex;flex-direction:column;gap:6px;align-items:flex-start;padding:11px 14px;" +
                    "border-radius:9px;cursor:pointer;" +
                    (state.market === m.k
                      ? `border:1px solid rgba(200,255,0,.45);background:rgba(200,255,0,.1);color:${C.accent}`
                      : `border:1px solid ${C.border};background:${C.raised};color:${C.muted}`),
                )}
              >
                <span style={sx(`font:700 12px/1 ${SANS}`)}>{m.label}</span>
                <span style={sx(`font:400 10px/1 ${MONO};opacity:.7`)}>{m.note}</span>
              </button>
            ))}
          </div>
        </div>

        <div
          style={sx(
            `display:grid;grid-template-columns:repeat(4,1fr);gap:0;border-bottom:1px solid ${C.line}`,
          )}
        >
          <div style={sx(`padding:18px 20px;border-right:1px solid ${C.line}`)}>
            <div style={sx(LABEL)}>MODE</div>
            <div style={sx(`margin-top:12px;font:700 15px/1 ${MONO}`)}>1v1</div>
            <div style={sx(`margin-top:6px;font:400 10.5px/1.4 ${MONO};color:${C.faint}`)}>
              2 players · winner takes all
            </div>
          </div>

          <Stepper
            label="PICKS EACH"
            value={state.picksMax}
            note={`2 bans each · ${state.picksMax * 2 + 4} draft turns`}
            onUp={p.onPicksUp}
            onDown={p.onPicksDown}
            divider
          />
          <Stepper
            label="CHARTS IN ARENA"
            value={state.chartCount}
            note="random window per asset"
            onUp={p.onChartsUp}
            onDown={p.onChartsDown}
            divider
          />

          <div style={sx("padding:18px 20px")}>
            <div style={sx(LABEL)}>TAPE SPEED</div>
            <div style={sx("display:flex;gap:6px;margin-top:12px")}>
              {SPEEDS.map((v) => (
                <button
                  key={v}
                  onClick={() => p.onTapeSpeed(v)}
                  style={sx(pill(state.tapeSpeed === v))}
                >
                  ×{v}
                </button>
              ))}
            </div>
            <div style={sx(NOTE)}>{speedNote}</div>
          </div>
        </div>

        <div style={sx("padding:20px")}>
          <div style={sx("display:flex;align-items:baseline;gap:10px")}>
            <div style={sx(LABEL)}>{universeLabel}</div>
            <span style={sx(`font:400 10.5px/1 ${SANS};color:${C.faint}`)}>
              tap to include or drop an asset
            </span>
          </div>
          <div style={sx("display:flex;flex-wrap:wrap;gap:8px;margin-top:12px")}>
            {marketAssets.map((u) => {
              const on = !state.excluded.includes(u.sym);
              return (
                <button
                  key={u.sym}
                  onClick={() => p.onToggleAsset(u.sym)}
                  style={sx(
                    "display:flex;align-items:center;gap:8px;padding:8px 11px;border-radius:8px;cursor:pointer;" +
                      (on
                        ? `border:1px solid rgba(200,255,0,.35);background:rgba(200,255,0,.07);color:${C.text}`
                        : `border:1px dashed ${C.borderMid};background:transparent;color:${C.faint}`),
                  )}
                >
                  <span style={sx(`font:700 12px/1 ${MONO}`)}>{u.sym}</span>
                  <span style={sx(`font:400 10px/1 ${MONO};opacity:.62`)}>{u.sector}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div
          style={sx(
            `display:flex;align-items:center;gap:14px;padding:16px 20px;` +
              `border-top:1px solid ${C.border};background:${C.card}`,
          )}
        >
          <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
            Publishing opens the room to one opponent and freezes the prize.
          </span>
          <div style={sx("flex:1")} />
          <button
            onClick={p.onPublish}
            style={sx(
              `height:40px;padding:0 18px;border:none;border-radius:8px;background:${C.accent};` +
                `color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer;white-space:nowrap`,
            )}
          >
            Publish lobby · {p.prizeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function Stepper({
  label,
  value,
  note,
  onUp,
  onDown,
  divider,
}: {
  label: string;
  value: number;
  note: string;
  onUp: () => void;
  onDown: () => void;
  divider?: boolean;
}) {
  return (
    <div style={sx(`padding:18px 20px;${divider ? `border-right:1px solid ${C.line}` : ""}`)}>
      <div style={sx(LABEL)}>{label}</div>
      <div style={sx("display:flex;align-items:center;gap:10px;margin-top:10px")}>
        <button onClick={onDown} style={sx(STEP_BTN)}>
          −
        </button>
        <span style={sx(`font:700 17px/1 ${MONO};min-width:18px;text-align:center`)}>{value}</span>
        <button onClick={onUp} style={sx(STEP_BTN)}>
          +
        </button>
      </div>
      <div style={sx(NOTE)}>{note}</div>
    </div>
  );
}
