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

/**
 * What the SDK builds from a given number of strikes.
 *
 * `RFQBuilderParams.strikes` accepts 1 to 4 values on ONE underlying. A parlay
 * across two assets is not one RFQ — `underlying` takes a single value — so the
 * builder here stays on one asset and the structure comes from the strike count.
 */
const STRUCTURE = ["—", "vanilla", "spread", "butterfly", "condor"] as const;

interface ParlayRfqProps {
  source: MarketSource;
  room: RoomView | null;
  seat: "host" | "guest" | null;
  busy: boolean;
  onLock: (pick: string) => void;
  onBack: () => void;
}

/**
 * Mode 1 — parlay as an RFQ.
 *
 * Pick up to 4 strikes on one asset. The strike count decides the structure the
 * SDK would build: `buildRFQRequest` for one, `buildSpreadRFQ` for two,
 * `buildButterflyRFQ` for three, `buildCondorRFQ` for four.
 *
 * The duel scores on edge captured — the summed distance of each chosen leg
 * from its own expiry's median volatility. That is a real number from live
 * orders. It is NOT settlement profit, which cannot exist until expiry.
 */
export function ParlayRfq({ source, room, seat, busy, onLock, onBack }: ParlayRfqProps) {
  const underlyings = source.underlyings();
  // Opens on the asset with a real two-sided book. AVAX sorts first and quotes
  // one side only, so the old default showed "ask —" on every leg.
  const [asset, setAsset] = useState(() => defaultAsset(source));
  const [legs, setLegs] = useState<string[]>([]);

  const rows = useMemo(() => playableRows(source, asset), [source, asset]);
  // Scored across every asset, so an opponent on another asset still counts.
  const index = useMemo(() => edgeIndex(source), [source]);

  const chosen = useMemo(
    () =>
      legs
        .map((id) => rows.find((r) => pickId(asset, r) === id))
        .filter((r): r is PricingRow => !!r),
    [legs, rows, asset],
  );

  const reveal = room?.revealed ?? false;
  const myPick = seat === "host" ? room?.picks[0] : seat === "guest" ? room?.picks[1] : null;
  const oppPick = seat === "host" ? room?.picks[1] : seat === "guest" ? room?.picks[0] : null;
  const locked = Boolean(myPick) || busy;

  const myEdge = myPick
    ? scorePick(index, myPick)
    : chosen.reduce((s, r) => s + Math.abs(r.edge ?? 0), 0);
  const oppEdge = scorePick(index, oppPick);
  const oppAsset = assetOfPick(oppPick);
  const verdict =
    !reveal || !room ? null : myEdge > oppEdge ? "YOU WIN" : myEdge < oppEdge ? "YOU LOSE" : "DRAW";

  // Cost of the structure at the offered asks, when every leg quotes one.
  const debit = chosen.reduce((sum, r) => sum + (r.ask === "—" ? 0 : Number(r.ask)), 0);
  const quotedAll = chosen.length > 0 && chosen.every((r) => r.ask !== "—");

  const toggle = (id: string) => {
    if (locked) return;
    setLegs((current) =>
      current.includes(id)
        ? current.filter((x) => x !== id)
        : current.length >= 4
          ? current
          : [...current, id],
    );
  };

  return (
    <div style={sx("padding:22px 28px;max-width:1180px;margin:0 auto;display:grid;gap:14px")}>
      <div style={sx("display:flex;align-items:center;gap:14px;flex-wrap:wrap")}>
        <button onClick={onBack} style={sx(BTN(C.borderMid, false))}>
          ← Arena
        </button>
        <h2 style={sx(`margin:0;font:700 18px/1 ${SANS};letter-spacing:-.02em`)}>Parlay · RFQ</h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;padding:6px 8px;border-radius:6px;` +
              `color:${C.accent};border:1px solid rgba(200,255,0,.35);background:rgba(200,255,0,.1)`,
          )}
        >
          {STRUCTURE[chosen.length] ?? "—"} · {chosen.length}/4 LEGS
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
              // Legs name contracts on one asset. A switch invalidates them.
              setLegs([]);
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

      <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) 300px;gap:14px")}>
        <div style={sx(`${CARD};padding:14px;max-height:440px;overflow:auto`)}>
          {rows.length === 0 ? (
            <span style={sx(`font:400 12px/1.5 ${SANS};color:${C.faint}`)}>
              No quotes with greeks on {asset} right now.
            </span>
          ) : (
            <div
              style={sx(
                "display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px",
              )}
            >
              {rows.map((r) => {
                const id = pickId(asset, r);
                const on = legs.includes(id);
                return (
                  <button
                    key={id}
                    onClick={() => toggle(id)}
                    style={sx(
                      `${CARD};padding:9px 10px;border-radius:9px;cursor:pointer;text-align:left;` +
                        `display:flex;flex-direction:column;gap:4px;` +
                        (on ? `border-color:${C.accent};box-shadow:0 0 0 1px ${C.accent}` : ""),
                    )}
                  >
                    <span style={sx(`font:700 11px/1 ${MONO};color:${C.text}`)}>
                      {r.type} {r.strike}
                    </span>
                    <span style={sx(`font:400 9.5px/1 ${MONO};color:${C.dim}`)}>
                      {r.expiry} · ask {r.ask} · IV {r.iv}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div style={sx(`${CARD};padding:16px;display:flex;flex-direction:column;gap:12px`)}>
          <span style={sx(LABEL)}>YOUR SLIP</span>
          {chosen.length === 0 ? (
            <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.faint}`)}>
              Pick 1 to 4 strikes on {asset}.
            </span>
          ) : (
            chosen.map((r) => (
              <div
                key={pickId(asset, r)}
                style={sx("display:flex;align-items:center;gap:8px;justify-content:space-between")}
              >
                <span style={sx(`font:700 11px/1 ${MONO};color:${C.text}`)}>
                  {r.type} {r.strike}
                </span>
                <span style={sx(`font:400 10.5px/1 ${MONO};color:${C.dim}`)}>{r.expiry}</span>
              </div>
            ))
          )}

          <div style={sx(`height:1px;background:${C.border}`)} />

          <div style={sx("display:flex;justify-content:space-between")}>
            <span style={sx(LABEL)}>STRUCTURE</span>
            <span style={sx(`font:700 11px/1 ${MONO};color:${C.accent}`)}>
              {STRUCTURE[chosen.length] ?? "—"}
            </span>
          </div>
          <div style={sx("display:flex;justify-content:space-between")}>
            <span style={sx(LABEL)}>DEBIT AT ASK</span>
            <span style={sx(`font:700 11px/1 ${MONO};color:${quotedAll ? C.text : C.faint}`)}>
              {quotedAll ? debit.toFixed(4) : "—"}
            </span>
          </div>
          <div style={sx("display:flex;justify-content:space-between")}>
            <span style={sx(LABEL)}>EDGE CAPTURED</span>
            <span style={sx(`font:700 11px/1 ${MONO};color:${C.accent}`)}>
              {(myEdge * 100).toFixed(1)}%
            </span>
          </div>
          {reveal && (
            <div style={sx("display:flex;justify-content:space-between")}>
              <span style={sx(LABEL)}>OPPONENT{oppAsset ? ` · ${oppAsset}` : ""}</span>
              <span style={sx(`font:700 11px/1 ${MONO};color:${C.muted}`)}>
                {(oppEdge * 100).toFixed(1)}%
              </span>
            </div>
          )}
          {verdict && (
            <span
              style={sx(
                `font:700 13px/1 ${MONO};letter-spacing:.12em;text-align:center;` +
                  `color:${verdict === "YOU WIN" ? C.green : verdict === "YOU LOSE" ? C.red : C.amber}`,
              )}
            >
              {verdict}
            </span>
          )}

          {!room ? (
            <span style={sx(`font:400 11px/1.5 ${SANS};color:${C.muted}`)}>
              Open a duel from the arena to play this against someone.
            </span>
          ) : myPick ? (
            <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim};text-align:center`)}>
              {reveal ? "Both slips revealed" : "Locked — waiting for opponent"}
            </span>
          ) : (
            <button
              onClick={() => legs.length > 0 && onLock(legs.join(","))}
              disabled={legs.length === 0 || locked}
              style={sx(BTN(C.accent, true, legs.length === 0 || locked))}
            >
              {busy ? "Locking…" : "Lock parlay"}
            </button>
          )}
        </div>
      </div>

      <span style={sx(`font:400 11px/1.5 ${SANS};color:${C.faint}`)}>
        One RFQ carries one underlying. A cross-asset parlay needs two RFQs. Edge captured is the
        summed volatility gap of your legs — it is not settlement profit, which only exists at
        expiry.
      </span>
    </div>
  );
}
