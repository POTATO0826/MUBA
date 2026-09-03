import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill } from "../theme.ts";
import { RoomsTable } from "../ui/RoomsTable.tsx";

interface BattlesProps {
  prize: number;
  onJoinRoom: () => void;
  onSpectate: () => void;
  onRunDemo: () => void;
  onCreate: () => void;
}

export function Battles({ prize, onJoinRoom, onSpectate, onRunDemo, onCreate }: BattlesProps) {
  return (
    <div style={sx("padding:28px;max-width:1720px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:14px;margin-bottom:18px")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Open battles</h2>
        <div style={sx("display:flex;gap:6px")}>
          <button style={sx(pill(true))}>1v1</button>
        </div>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>6 rooms</span>
        <button
          onClick={onRunDemo}
          style={sx(
            "height:36px;padding:0 14px;border:1px solid rgba(167,139,250,.45);border-radius:8px;" +
              `background:rgba(167,139,250,.12);color:${C.violet};font:700 12.5px/1 ${SANS};cursor:pointer`,
          )}
        >
          ▶ Random demo
        </button>
        <button
          onClick={onCreate}
          style={sx(
            `height:36px;padding:0 16px;border:none;border-radius:8px;background:${C.accent};` +
              `color:${C.bg};font:700 12.5px/1 ${SANS};cursor:pointer`,
          )}
        >
          Create battle
        </button>
      </div>

      <RoomsTable prize={prize} onJoin={onJoinRoom} onSpectate={onSpectate} />
    </div>
  );
}
