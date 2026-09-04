import { useState } from "react";
import { MARKET_LABEL } from "../data/lobbies.ts";
import { SEASON } from "../data/rewards.ts";
import { sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill } from "../theme.ts";
import { LobbyCard } from "../ui/LobbyCards.tsx";
import type { LobbyDef, MarketFilter } from "../types.ts";

/**
 * Cards are 300px minimum and grow to share the row, so the board is four
 * across on a wide desk and reflows cleanly rather than stranding one card on
 * the last line.
 */
const GRID = "display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px";

const FILTERS: readonly { k: MarketFilter | "ALL"; label: string }[] = [
  { k: "ALL", label: "ALL" },
  { k: "STOCK", label: MARKET_LABEL.STOCK },
  { k: "CRYPTO", label: MARKET_LABEL.CRYPTO },
  { k: "MIXED", label: MARKET_LABEL.MIXED },
];

interface BattlesProps {
  lobbies: readonly LobbyDef[];
  /** Points on hand, from the ledger. */
  points: number;
  onAccept: (id: string) => void;
  onStart: (id: string) => void;
  onCreate: () => void;
}

/** The board: every open lobby as a card, yours first. */
export function Battles({ lobbies, points, onAccept, onStart, onCreate }: BattlesProps) {
  const [filter, setFilter] = useState<MarketFilter | "ALL">("ALL");
  const shown = lobbies.filter((l) => filter === "ALL" || l.market === filter);
  const open = lobbies.filter((l) => l.status === "open").length;

  return (
    <div style={sx("padding:28px;max-width:1720px;margin:0 auto;display:flex;flex-direction:column;gap:22px")}>
      <div style={sx("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Open battles</h2>
        <span style={sx(`font:400 12px/1 ${SANS};color:${C.dim}`)}>
          Take a seat on someone's lobby or publish your own. The spin picks what you both play on.
        </span>
        <div style={sx("flex:1")} />
        <span
          style={sx(
            `display:inline-flex;align-items:baseline;gap:6px;font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim};` +
              `border:1px solid ${C.border};background:${C.raised};border-radius:6px;padding:6px 9px`,
          )}
        >
          BALANCE
          <span style={sx(`font:700 12px/1 ${MONO};letter-spacing:0;color:${C.text}`)}>
            {points.toLocaleString("en-US")} PTS
          </span>
        </span>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.accent};border:1px solid rgba(200,255,0,.3);` +
              "background:rgba(200,255,0,.08);border-radius:6px;padding:6px 9px",
          )}
        >
          {SEASON.label} · ENDS IN {SEASON.endsIn}
        </span>
        <button
          onClick={() => {
            sfx("ui.click.primary");
            onCreate();
          }}
          style={sx(
            `height:36px;padding:0 16px;border:none;border-radius:8px;background:${C.accent};` +
              `color:${C.bg};font:700 12.5px/1 ${SANS};cursor:pointer`,
          )}
        >
          + Create lobby
        </button>
      </div>

      <section>
        <div style={sx("display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap")}>
          <h3 style={sx(`margin:0;font:700 16px/1 ${SANS};letter-spacing:-.02em`)}>Lobbies</h3>
          <div style={sx("display:flex;gap:6px;flex-wrap:wrap")}>
            {FILTERS.map((f) => (
              <button
                key={f.k}
                onClick={() => {
                  sfx("ui.toggle.on");
                  setFilter(f.k);
                }}
                style={sx(pill(filter === f.k))}
              >
                {f.label}
              </button>
            ))}
          </div>
          <div style={sx("flex:1")} />
          <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>
            {open} open · {shown.length} shown
          </span>
        </div>

        <div style={sx(GRID)}>
          {shown.map((l) => (
            <LobbyCard key={l.id} lobby={l} onAccept={() => onAccept(l.id)} onStart={() => onStart(l.id)} />
          ))}
        </div>
      </section>
    </div>
  );
}
