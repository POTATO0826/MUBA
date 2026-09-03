import { MARKET_COLOR, MARKET_LABEL, bookFor } from "../data/lobbies.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill, tag } from "../theme.ts";
import type { LobbyForm } from "../state/match.ts";
import type { MarketFilter } from "../types.ts";

const STEP_BTN =
  `width:34px;height:34px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
  `color:${C.text};font:700 15px/1 ${MONO};cursor:pointer`;

const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;
const NOTE = `margin-top:8px;font:400 10.5px/1.4 ${MONO};color:${C.faint}`;
const CARD = `border:1px solid ${C.border};border-radius:12px;background:${C.panel};padding:18px`;

const MARKETS: readonly MarketFilter[] = ["STOCK", "CRYPTO", "MIXED"];

interface CreateLobbyProps {
  form: LobbyForm;
  entryLabel: string;
  prizeLabel: string;
  onName: (v: string) => void;
  onMarket: (m: MarketFilter) => void;
  onLegsUp: () => void;
  onLegsDown: () => void;
  onPrizeInput: (raw: string) => void;
  onPrizeBlur: () => void;
  onPrizeUp: () => void;
  onPrizeDown: () => void;
  onPublish: () => void;
  onBack: () => void;
}

/** Four fields, then a card on the board: name, book, legs, prize. */
export function CreateLobby(p: CreateLobbyProps) {
  const color = MARKET_COLOR[p.form.market];

  return (
    <div style={sx("padding:24px 28px;max-width:940px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px")}>
        <button
          onClick={p.onBack}
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
              <button key={m} onClick={() => p.onMarket(m)} style={sx(pill(p.form.market === m))}>
                {MARKET_LABEL[m]}
                <span style={sx(`margin-left:6px;color:${C.faint}`)}>{bookFor(m).length}</span>
              </button>
            ))}
          </div>
          <div style={sx(NOTE)}>
            The spin deals both players' legs from this book. Neither of you picks a ticker.
          </div>

          <div style={sx(`${LABEL};margin-top:20px`)}>LEGS</div>
          <div style={sx("display:flex;align-items:center;gap:10px;margin-top:10px")}>
            <button onClick={p.onLegsDown} style={sx(STEP_BTN)}>−</button>
            <span style={sx(`min-width:40px;text-align:center;font:700 20px/1 ${MONO}`)}>{p.form.legs}</span>
            <button onClick={p.onLegsUp} style={sx(STEP_BTN)}>+</button>
            <span style={sx(`font:400 10.5px/1 ${MONO};color:${C.faint}`)}>2 to 4 · both slips run on the same {p.form.legs}</span>
          </div>
        </div>

        <div style={sx(CARD)}>
          <div style={sx(LABEL)}>PRIZE POOL (ETH)</div>
          <div style={sx("display:flex;align-items:center;gap:10px;margin-top:10px")}>
            <button onClick={p.onPrizeDown} style={sx(STEP_BTN)}>−</button>
            <input
              value={p.form.prizeText}
              inputMode="decimal"
              onChange={(e) => p.onPrizeInput(e.target.value)}
              onBlur={p.onPrizeBlur}
              style={sx(
                `flex:1;height:38px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;text-align:center;` +
                  `background:${C.raised};color:${C.accent};font:700 18px/1 ${MONO};outline:none`,
              )}
            />
            <button onClick={p.onPrizeUp} style={sx(STEP_BTN)}>+</button>
          </div>
          <div style={sx(NOTE)}>
            Adjustable until the lobby is published. Once public the prize is locked for whoever
            takes the seat.
          </div>

          <div style={sx(`${LABEL};margin-top:20px`)}>ENTRY PER PLAYER</div>
          <div style={sx(`margin-top:10px;font:700 24px/1 ${MONO}`)}>{p.entryLabel}</div>
          <div style={sx(NOTE)}>Half the pool each. Winner takes the full pool.</div>

          <div style={sx(`${LABEL};margin-top:20px`)}>MODE</div>
          <div style={sx(`margin-top:10px;font:700 14px/1 ${SANS}`)}>1v1</div>
          <div style={sx(NOTE)}>Spin → case study → parlay → duel. Winner on legs, conviction breaks ties.</div>

          <button
            onClick={p.onPublish}
            style={sx(
              `width:100%;height:40px;margin-top:22px;border:none;border-radius:8px;` +
                `background:${C.accent};color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`,
            )}
          >
            Publish lobby · {p.prizeLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
