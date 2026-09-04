import { CardArt } from "../components/CardArt.tsx";
import { MARKET_COLOR, MARKET_LABEL, bookOf } from "../data/lobbies.ts";
import { sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, avatarStyle, tag } from "../theme.ts";
import type { LobbyDef, Player } from "../types.ts";

interface RoomProps {
  lobby: LobbyDef;
  you: Player;
  opponent: Player;
  ready: { me: boolean; opp: boolean };
  entryLabel: string;
  prizeLabel: string;
  onReady: () => void;
  onBegin: () => void;
  onLeave: () => void;
}

const STEPS = [
  ["SPIN", "the reel deals the tickers"],
  ["STUDY", "same charts, same wire"],
  ["PARLAY", "pick a card, blind"],
  ["DUEL", "both slips on the tape"],
] as const;

/**
 * The lobby room. Both seats are taken; nothing happens until both players
 * have readied up. Readying is the moment your entry leaves the balance —
 * before that you can still walk out and the seat reopens.
 */
export function Room(p: RoomProps) {
  const color = MARKET_COLOR[p.lobby.market];
  const both = p.ready.me && p.ready.opp;

  return (
    <div style={sx("padding:24px 28px;max-width:1100px;margin:0 auto")}>
      <div
        style={sx(
          `position:relative;overflow:hidden;border:1px solid ${color}59;border-radius:14px;background:${C.card};padding:24px 26px;min-height:150px`,
        )}
      >
        <CardArt id={p.lobby.id} color={color} />
        <div style={sx("position:relative;display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap")}>
          <div style={sx("flex:1;min-width:260px")}>
            <div style={sx("display:flex;align-items:center;gap:8px")}>
              <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${color}`)}>LOBBY</span>
              <span style={sx(tag(color))}>{MARKET_LABEL[p.lobby.market]}</span>
              <span style={sx(tag(C.muted))}>{p.lobby.legs} LEGS</span>
              <span style={sx(tag(C.muted))}>1V1</span>
            </div>
            <h2 style={sx(`margin:12px 0 0;font:700 30px/1.05 ${SANS};letter-spacing:-.03em;text-shadow:0 2px 14px rgba(0,0,0,.7)`)}>
              {p.lobby.name}
            </h2>
            <div style={sx(`margin-top:10px;font:400 12px/1.5 ${SANS};color:${C.textSoft};max-width:520px;text-wrap:pretty`)}>
              The book is {bookOf(p.lobby).length} names. The spin deals {p.lobby.legs} of them and both slips run
              on exactly those — neither of you picks a ticker.
            </div>
          </div>
          <div style={sx("display:flex;gap:10px;flex:none")}>
            <Figure label="PRIZE POOL" value={p.prizeLabel} color={C.accent} />
            <Figure label="YOUR ENTRY" value={p.entryLabel} />
          </div>
        </div>
      </div>

      <div style={sx("display:grid;grid-template-columns:1fr auto 1fr;gap:18px;align-items:stretch;margin-top:18px")}>
        <Seat
          player={p.you}
          role={p.lobby.mine ? "host" : "challenger"}
          ready={p.ready.me}
          accent={C.indigo}
          action={
            p.ready.me ? null : (
              <button
                onClick={p.onReady}
                style={sx(
                  `height:40px;width:100%;border:none;border-radius:8px;background:${C.accent};color:${C.bg};` +
                    `font:700 13px/1 ${SANS};cursor:pointer`,
                )}
              >
                Ready up · {p.entryLabel} entry
              </button>
            )
          }
          note={p.ready.me ? "Entry locked. Waiting on the other seat." : "Readying locks your entry into the pool."}
        />

        <div style={sx("display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-width:64px")}>
          <span style={sx(`font:700 22px/1 ${MONO};letter-spacing:-.02em;color:${C.dim}`)}>VS</span>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${both ? C.green : C.faint}`)}>
            {both ? "2/2 READY" : `${Number(p.ready.me) + Number(p.ready.opp)}/2 READY`}
          </span>
        </div>

        <Seat
          player={p.opponent}
          role={p.lobby.mine ? "challenger" : "host"}
          ready={p.ready.opp}
          accent={C.red}
          action={null}
          note={p.ready.opp ? "Ready." : "Reading the lobby…"}
        />
      </div>

      <div style={sx(`display:flex;align-items:center;gap:10px;margin-top:18px;padding:14px 18px;border:1px solid ${C.border};border-radius:12px;background:${C.card};flex-wrap:wrap`)}>
        {STEPS.map(([k, v], i) => (
          <div key={k} style={sx("display:flex;align-items:center;gap:10px")}>
            <div>
              <div style={sx(`font:700 10px/1 ${MONO};letter-spacing:.12em;color:${i === 0 ? color : C.muted}`)}>{k}</div>
              <div style={sx(`margin-top:5px;font:400 10.5px/1 ${MONO};color:${C.faint}`)}>{v}</div>
            </div>
            {i < STEPS.length - 1 && <span style={sx(`margin:0 6px;color:${C.borderMid}`)}>→</span>}
          </div>
        ))}
        <div style={sx("flex:1")} />
        <button
          onClick={p.onLeave}
          style={sx(
            `height:36px;padding:0 14px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
              `color:${C.muted};font:500 12px/1 ${SANS};cursor:pointer`,
          )}
        >
          Leave lobby
        </button>
        <button
          onClick={() => {
            sfx("spin.open");
            p.onBegin();
          }}
          disabled={!both}
          style={sx(
            `height:36px;padding:0 16px;border:none;border-radius:8px;font:700 12.5px/1 ${SANS};white-space:nowrap;` +
              (both
                ? `background:${C.accent};color:${C.bg};cursor:pointer;animation:vcPulse 1.6s ease-in-out infinite`
                : `background:${C.border};color:${C.dim};cursor:not-allowed`),
          )}
        >
          {both ? "Both ready → lucky spin" : "Waiting for both players"}
        </button>
      </div>
    </div>
  );
}

function Seat(p: {
  player: Player;
  role: string;
  ready: boolean;
  accent: string;
  action: React.ReactNode;
  note: string;
}) {
  return (
    <div
      data-seat={p.player.name}
      style={sx(
        `border:1px solid ${p.ready ? "rgba(74,222,128,.45)" : `${p.accent}55`};border-radius:12px;padding:18px;` +
          `background:linear-gradient(180deg,${p.accent}14,${C.card} 45%);display:flex;flex-direction:column;gap:14px`,
      )}
    >
      <div style={sx("display:flex;align-items:center;gap:12px")}>
        <div style={sx(avatarStyle(p.player.bg, 44))}>{p.player.initial}</div>
        <div style={sx("min-width:0")}>
          <div style={sx(`font:700 16px/1 ${SANS}`)}>{p.player.name}</div>
          <div style={sx(`margin-top:5px;font:400 10px/1 ${MONO};color:${C.dim}`)}>{p.role}</div>
        </div>
        <div style={sx("flex:1")} />
        <span
          style={sx(
            `display:inline-flex;align-items:center;gap:6px;font:700 9px/1 ${MONO};letter-spacing:.12em;padding:6px 8px;border-radius:6px;` +
              (p.ready
                ? `border:1px solid rgba(74,222,128,.45);background:rgba(74,222,128,.12);color:${C.green}`
                : `border:1px solid ${C.borderMid};background:transparent;color:${C.dim}`),
          )}
        >
          <span style={sx(`width:6px;height:6px;border-radius:99px;background:${p.ready ? C.green : C.amber}` + (p.ready ? "" : ";animation:vcPulse 1.2s ease-in-out infinite"))} />
          {p.ready ? "READY" : "NOT READY"}
        </span>
      </div>
      <div style={sx("flex:1")} />
      {p.action}
      <div style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.faint}`)}>{p.note}</div>
    </div>
  );
}

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={sx(`min-width:110px;padding:10px 12px;border:1px solid ${C.border};border-radius:10px;background:rgba(9,9,11,.6)`)}>
      <div style={sx(`font:500 8.5px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>{label}</div>
      <div style={sx(`margin-top:6px;font:700 16px/1 ${MONO}${color ? `;color:${color}` : ""}`)}>{value}</div>
    </div>
  );
}
