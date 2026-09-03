import { CardArt } from "../components/CardArt.tsx";
import { MARKET_COLOR, MARKET_LABEL, MARKET_WALL } from "../data/lobbies.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, avatarStyle, tag, wall } from "../theme.ts";
import type { LobbyDef } from "../types.ts";

/**
 * A lobby as a card. The backdrop is the market gradient with a generative,
 * animated pattern over it — the card's own picture. No tilt: the picture
 * moves, the card does not.
 *
 * Three states, told by the footer:
 *
 *   someone else's, open   → "Accept match" — you are the second seat
 *   yours, open            → "Waiting for opponent…" — nothing to do yet
 *   yours, matched         → "Start match · vs …" — both seats are taken
 */
export function LobbyCard({
  lobby,
  onAccept,
  onStart,
}: {
  lobby: LobbyDef;
  onAccept: () => void;
  onStart: () => void;
}) {
  const color = MARKET_COLOR[lobby.market];
  const [a, b, deg] = MARKET_WALL[lobby.market];
  const waiting = lobby.mine && lobby.status === "open";
  const ready = lobby.mine && lobby.status === "matched";

  const status = waiting
    ? { text: "YOURS · WAITING FOR P2", color: C.amber, pulse: true }
    : ready
      ? { text: `MATCHED · VS ${lobby.opponent?.name.toUpperCase() ?? "?"}`, color: C.green, pulse: false }
      : { text: "OPEN · WAITING FOR P2", color: C.green, pulse: true };

  /** Three lines on hover. Enough to know what you are sitting down to. */
  const details = [
    `${lobby.host.name} · ${MARKET_LABEL[lobby.market]} · ${lobby.legs} legs`,
    `${lobby.prize.toFixed(2)} Ξ pool · ${(lobby.prize / 2).toFixed(2)} Ξ each`,
    "Spin deals the tickers · most legs wins",
  ];

  return (
    <div
      className="vc-lobby"
      data-lobby={lobby.id}
      style={sx(
        `position:relative;height:300px;border:1px solid ${lobby.mine ? "rgba(99,102,241,.45)" : C.border};` +
          `border-radius:16px;overflow:hidden;background:${C.card}`,
      )}
    >
      <div style={sx(wall(a, b, deg))} />
      <CardArt id={lobby.id} color={color} />

      {/* Hover: three lines over the name. */}
      <div
        className="vc-lobby-details"
        data-details={lobby.id}
        style={sx("left:18px;right:18px;top:60px;bottom:126px;display:flex;flex-direction:column;justify-content:flex-end;gap:7px")}
      >
        {details.map((line) => (
          <div key={line} style={sx(`font:500 11px/1.35 ${MONO};color:${C.textSoft};text-shadow:0 1px 8px rgba(0,0,0,.7)`)}>
            {line}
          </div>
        ))}
      </div>

      <div
        className="vc-lobby-body"
        style={sx(
          "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;padding:18px",
        )}
      >
        <div>
          <div style={sx("display:flex;justify-content:space-between;align-items:flex-start;gap:8px")}>
            <div style={sx("display:flex;align-items:center;gap:9px;min-width:0")}>
              <div style={sx(avatarStyle(lobby.host.bg, 30))}>{lobby.host.initial}</div>
              <div style={sx("min-width:0")}>
                <div style={sx(`font:700 12.5px/1 ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>
                  {lobby.host.name}
                </div>
                <div style={sx(`margin-top:4px;font:400 9.5px/1 ${MONO};color:${C.dim}`)}>
                  host · {lobby.createdAgo} ago
                </div>
              </div>
            </div>
            <div
              style={sx(
                `font:700 9px/1 ${MONO};letter-spacing:.1em;padding:5px 7px;border-radius:5px;flex:none;` +
                  `border:1px solid ${C.border};background:rgba(0,0,0,.28);color:${C.muted}`,
              )}
            >
              {lobby.legs} LEGS
            </div>
          </div>

          <div className="vc-lobby-fade">
            <div style={sx("display:flex;align-items:center;gap:8px;margin-top:16px")}>
              <span style={sx(tag(color))}>{MARKET_LABEL[lobby.market]}</span>
              <span style={sx(tag(C.muted))}>1V1</span>
            </div>
            <div style={sx(`margin-top:10px;font:700 21px/1.1 ${SANS};letter-spacing:-.02em;text-shadow:0 2px 12px rgba(0,0,0,.6)`)}>
              {lobby.name}
            </div>
          </div>
        </div>

        <div>
          <div
            style={sx(
              `display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding-top:12px;border-top:1px solid ${C.line}`,
            )}
          >
            <Figure label="PRIZE POOL" value={`${lobby.prize.toFixed(2)} Ξ`} color={C.accent} />
            <Figure label="ENTRY" value={`${(lobby.prize / 2).toFixed(2)} Ξ`} />
            <Figure label="SEATS" value={lobby.status === "matched" ? "2/2" : "1/2"} color={status.color} />
          </div>

          <div style={sx("display:flex;align-items:center;gap:7px;margin-top:12px")}>
            <span
              style={sx(
                `width:6px;height:6px;border-radius:99px;background:${status.color};flex:none` +
                  (status.pulse ? ";animation:vcPulse 1.4s ease-in-out infinite" : ""),
              )}
            />
            <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${status.color}`)}>{status.text}</span>
          </div>

          <div style={sx("margin-top:10px")}>
            {waiting ? (
              <div
                style={sx(
                  `height:36px;display:flex;align-items:center;justify-content:center;border-radius:8px;` +
                    `border:1px dashed ${C.borderMid};background:rgba(9,9,11,.4);font:500 11px/1 ${MONO};letter-spacing:.06em;color:${C.dim}`,
                )}
              >
                Waiting for opponent…
              </div>
            ) : (
              <button
                onClick={ready ? onStart : onAccept}
                style={sx(
                  `height:36px;width:100%;border:none;border-radius:8px;font:700 12px/1 ${SANS};cursor:pointer;` +
                    `background:${C.accent};color:${C.bg}`,
                )}
              >
                {ready ? `Start match · vs ${lobby.opponent?.name}` : `Accept match · ${(lobby.prize / 2).toFixed(2)} Ξ`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <div style={sx(`font:500 8.5px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>{label}</div>
      <div style={sx(`margin-top:5px;font:700 14px/1 ${MONO}${color ? `;color:${color}` : ""}`)}>
        {value}
      </div>
    </div>
  );
}
