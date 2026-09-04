import { useMemo, useState } from "react";
import { assetOfPick, defaultAsset, edgeIndex, pickId, playableRows, scorePick } from "../data/board.ts";
import type { MarketSource } from "../data/market.ts";
import type { RoomView } from "../data/room.ts";
import { shortAddress } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { PricingRow } from "../types.ts";

const CARD =
  "border:1px solid #27272a;border-radius:14px;background:linear-gradient(180deg,#101012,#0c0c0e)";
const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;

const BTN = (tone: string, filled: boolean, off = false): string =>
  `height:38px;padding:0 18px;border-radius:10px;cursor:pointer;font:700 12px/1 ${SANS};` +
  (filled
    ? `background:${tone};color:${C.bg};border:1px solid ${tone}`
    : `background:transparent;color:${C.text};border:1px solid ${C.borderMid}`) +
  (off ? ";opacity:.45;cursor:not-allowed" : "");

function Cell({
  row,
  picked,
  reveal,
  onPick,
}: {
  row: PricingRow;
  picked: boolean;
  reveal: boolean;
  onPick: () => void;
}) {
  const edge = row.edge ?? 0;
  const hot = Math.min(1, Math.abs(edge) / 0.2);
  // Before the reveal the grid must give nothing away — every cell looks the
  // same. Colour by edge only after both players lock.
  const tone = !reveal ? C.borderMid : edge > 0 ? C.green : C.red;
  const border = picked ? C.accent : reveal ? tone : "#27272a";

  return (
    <button
      onClick={onPick}
      style={sx(
        `${CARD};padding:10px 11px;text-align:left;cursor:pointer;display:flex;` +
          `flex-direction:column;gap:5px;border-radius:10px;border-color:${border};` +
          (picked ? `box-shadow:0 0 0 1px ${C.accent},0 0 18px ${C.accent}33;` : "") +
          (reveal ? `background:linear-gradient(180deg,${tone}${hot > 0.5 ? "22" : "11"},#0c0c0e)` : ""),
      )}
    >
      <div style={sx("display:flex;align-items:center;gap:6px")}>
        <span
          style={sx(
            `font:700 8px/1 ${MONO};letter-spacing:.1em;padding:3px 5px;border-radius:4px;` +
              `color:${row.type === "PUT" ? C.red : C.green};` +
              `border:1px solid ${row.type === "PUT" ? "rgba(248,113,113,.3)" : "rgba(74,222,128,.3)"}`,
          )}
        >
          {row.type}
        </span>
        <span style={sx(`font:700 12px/1 ${MONO};color:${C.text}`)}>{row.strike}</span>
      </div>
      <span style={sx(`font:400 9.5px/1 ${MONO};color:${C.dim}`)}>
        {row.expiry} · IV {row.iv}
      </span>
      <span
        style={sx(
          `font:700 11px/1 ${MONO};color:${reveal ? tone : C.faint}`,
        )}
      >
        {reveal ? `${edge >= 0 ? "+" : ""}${(edge * 100).toFixed(1)}%` : "· · ·"}
      </span>
    </button>
  );
}

interface SpotDiffProps {
  source: MarketSource;
  room: RoomView | null;
  seat: "host" | "guest" | null;
  address: string | null;
  busy: boolean;
  onLock: (pick: string) => void;
  onBack: () => void;
}

/**
 * Mode 2 — find a difference.
 *
 * The grid is the live Thetanuts order book. Every cell hides its `edge`: how
 * far that strike's implied volatility sits from the median of its own expiry
 * and type. A big edge is a real outlier on the smile.
 *
 * Both players pick one cell blind. The picks unlock together, and the larger
 * absolute edge wins. Nothing here is simulated — the numbers come from resting
 * orders on Base.
 */
export function SpotDiff({
  source,
  room,
  seat,
  address,
  busy,
  onLock,
  onBack,
}: SpotDiffProps) {
  const underlyings = source.underlyings();
  // Opens on the asset with a real two-sided book, not on whatever sorts first.
  const [asset, setAsset] = useState(() => defaultAsset(source));
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(() => playableRows(source, asset), [source, asset]);
  // Scored across every asset, so an opponent on another asset still counts.
  const index = useMemo(() => edgeIndex(source), [source]);

  const reveal = room?.revealed ?? false;
  const myPick = seat === "host" ? room?.picks[0] : seat === "guest" ? room?.picks[1] : null;
  const oppPick = seat === "host" ? room?.picks[1] : seat === "guest" ? room?.picks[0] : null;
  const locked = Boolean(myPick) || busy;

  const myEdge = scorePick(index, myPick ?? selected);
  const oppEdge = scorePick(index, oppPick);
  const oppAsset = assetOfPick(oppPick);
  const verdict =
    !reveal || !room ? null : myEdge > oppEdge ? "YOU WIN" : myEdge < oppEdge ? "YOU LOSE" : "DRAW";

  return (
    <div style={sx("padding:22px 28px;max-width:1180px;margin:0 auto;display:grid;gap:14px")}>
      <div style={sx("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
        <button onClick={onBack} style={sx(BTN(C.borderMid, false))}>
          ← Arena
        </button>
        <h2 style={sx(`margin:0;font:700 18px/1 ${SANS};letter-spacing:-.02em`)}>
          Find a difference
        </h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;padding:6px 8px;border-radius:6px;` +
              `color:${C.blue};border:1px solid rgba(56,189,248,.35);background:rgba(56,189,248,.12)`,
          )}
        >
          {rows.length} LIVE QUOTES
        </span>
        <div style={sx("flex:1")} />
        {room && (
          <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>
            {room.lobbyName} · {shortAddress(room.host)} vs{" "}
            {room.guest ? shortAddress(room.guest) : "—"}
          </span>
        )}
      </div>

      <div style={sx("display:flex;gap:6px;flex-wrap:wrap")}>
        {underlyings.map((u) => (
          <button
            key={u}
            onClick={() => {
              setAsset(u);
              setSelected(null);
            }}
            style={sx(
              `height:30px;padding:0 12px;border-radius:8px;cursor:pointer;font:700 11px/1 ${MONO};` +
                (u === asset
                  ? `background:${C.accent};color:${C.bg};border:1px solid ${C.accent}`
                  : `background:transparent;color:${C.muted};border:1px solid ${C.border}`),
            )}
          >
            {u}
          </button>
        ))}
      </div>

      <div style={sx(`${CARD};padding:16px`)}>
        {rows.length === 0 ? (
          <span style={sx(`font:400 12px/1.5 ${SANS};color:${C.faint}`)}>
            No quotes with greeks on {asset} right now. Try another asset.
          </span>
        ) : (
          <div
            style={sx(
              "display:grid;grid-template-columns:repeat(auto-fill,minmax(128px,1fr));gap:8px",
            )}
          >
            {rows.map((r) => {
              const id = pickId(asset, r);
              return (
                <Cell
                  key={id}
                  row={r}
                  picked={id === (myPick ?? selected)}
                  reveal={reveal}
                  onPick={() => !locked && setSelected(id)}
                />
              );
            })}
          </div>
        )}
      </div>

      <div style={sx(`${CARD};padding:16px 18px;display:flex;align-items:center;gap:14px`)}>
        <div style={sx("display:flex;flex-direction:column;gap:6px")}>
          <span style={sx(LABEL)}>YOUR EDGE</span>
          <span style={sx(`font:700 20px/1 ${MONO};color:${C.accent}`)}>
            {selected || myPick ? `${(myEdge * 100).toFixed(1)}%` : "—"}
          </span>
        </div>
        {reveal && (
          <div style={sx("display:flex;flex-direction:column;gap:6px;margin-left:18px")}>
            <span style={sx(LABEL)}>OPPONENT{oppAsset ? ` · ${oppAsset}` : ""}</span>
            <span style={sx(`font:700 20px/1 ${MONO};color:${C.muted}`)}>
              {(oppEdge * 100).toFixed(1)}%
            </span>
          </div>
        )}
        {verdict && (
          <span
            style={sx(
              `margin-left:18px;font:700 13px/1 ${MONO};letter-spacing:.12em;` +
                `color:${verdict === "YOU WIN" ? C.green : verdict === "YOU LOSE" ? C.red : C.amber}`,
            )}
          >
            {verdict}
          </span>
        )}
        <div style={sx("flex:1")} />
        {!room ? (
          <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
            Open a duel from the arena to play this against someone.
          </span>
        ) : myPick ? (
          <span style={sx(`font:500 11.5px/1 ${MONO};color:${C.dim}`)}>
            {reveal ? "Both picks revealed" : "Locked — waiting for opponent"}
          </span>
        ) : (
          <button
            onClick={() => selected && onLock(selected)}
            disabled={!selected || locked}
            style={sx(BTN(C.accent, true, !selected || locked))}
          >
            {busy ? "Locking…" : "Lock pick"}
          </button>
        )}
      </div>

      <span style={sx(`font:400 11px/1.5 ${SANS};color:${C.faint}`)}>
        Edge is the gap between a strike's implied volatility and the median of its own expiry and
        type, from live resting orders on Base. Both picks stay hidden until both players lock.
      </span>
    </div>
  );
}
