import { ROOMS } from "../data/fixtures.ts";
import { meta } from "../data/universe.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, avatarStyle, chipStyle, sectorColor } from "../theme.ts";

const COLUMNS =
  "80px minmax(248px,1.4fr) minmax(0,1fr) minmax(120px,.9fr) minmax(0,1.1fr) 104px";

interface RoomsTableProps {
  /** Drives the pot/entry on the room the admin is configuring. */
  prize: number;
  onJoin: () => void;
  onSpectate: () => void;
  /** Lobby renders this inside a horizontal scroller and pins a minimum width. */
  scroll?: boolean;
}

export function RoomsTable({ prize, onJoin, onSpectate, scroll = false }: RoomsTableProps) {
  const minWidth = scroll ? "min-width:760px;" : "";

  return (
    <div
      style={sx(
        `border:1px solid ${C.border};border-radius:12px;background:${C.panel};` +
          (scroll ? "overflow-x:auto" : "overflow:hidden"),
      )}
    >
      <div
        style={sx(
          `display:grid;grid-template-columns:${COLUMNS};gap:12px;padding:11px 16px;${minWidth}` +
            `background:${C.raised};border-bottom:1px solid ${C.border};font:500 10px/1 ${MONO};` +
            `letter-spacing:.12em;color:${C.dim}`,
        )}
      >
        <div>MODE</div>
        <div>STOCK ROTATION</div>
        <div>PHASE</div>
        <div>PRIZE POOL</div>
        <div>PLAYERS</div>
        <div />
      </div>

      {ROOMS.map((room, i) => {
        const pot = room.pot ?? prize.toFixed(2);
        const entry = room.entry ?? (prize / 2).toFixed(2);
        const isJoin = room.cta === "Join";

        return (
          <div
            key={`${room.status}-${i}`}
            style={sx(
              `display:grid;grid-template-columns:${COLUMNS};gap:12px;align-items:center;` +
                `padding:15px 16px;${minWidth}border-bottom:1px solid ${C.lineSoft};background:` +
                (room.hot ? "rgba(200,255,0,.035)" : i % 2 ? C.panelAlt : "transparent"),
            )}
          >
            <div style={sx("display:flex;flex-direction:column;gap:5px")}>
              <span style={sx(`font:700 13px/1 ${MONO};color:${C.text}`)}>{room.mode}</span>
              <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.11em;color:${room.sc}`)}>
                {room.status}
              </span>
            </div>

            <div
              style={sx(
                "display:flex;align-items:center;gap:8px;min-width:0;overflow:hidden;flex-wrap:wrap;max-height:26px",
              )}
            >
              {room.syms.map((sym) => (
                <div key={sym} style={sx(chipStyle(sectorColor(meta(sym).sector)))}>
                  {sym}
                </div>
              ))}
            </div>

            <div style={sx(`font:500 12px/1.5 ${MONO};color:${C.muted}`)}>{room.phase}</div>

            <div style={sx("display:flex;flex-direction:column;gap:4px")}>
              <span style={sx(`font:700 15px/1 ${MONO};color:${C.accent}`)}>{pot} ETH</span>
              <span style={sx(`font:400 10px/1 ${MONO};color:${C.dim}`)}>{entry} entry · locked</span>
            </div>

            <div style={sx("display:flex;align-items:center;gap:7px;min-width:0;overflow:hidden")}>
              {room.players.map(([initial, bg]) => (
                <div key={initial} style={sx(avatarStyle(bg))}>
                  {initial}
                </div>
              ))}
              <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>{room.slots}</span>
            </div>

            <button
              onClick={isJoin ? onJoin : onSpectate}
              style={sx(
                `height:32px;border-radius:8px;cursor:pointer;font:700 12px/1 ${SANS};` +
                  (isJoin
                    ? `border:none;background:${C.accent};color:${C.bg}`
                    : `border:1px solid ${C.borderMid};background:transparent;color:${C.text}`),
              )}
            >
              {room.cta}
            </button>
          </div>
        );
      })}
    </div>
  );
}
