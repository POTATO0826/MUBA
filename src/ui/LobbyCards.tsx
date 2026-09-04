import { CardArt } from "../components/CardArt.tsx";
import { PlayerMark } from "../components/PlayerMark.tsx";
import { MARKET_COLOR, MARKET_LABEL, MARKET_WALL } from "../data/lobbies.ts";
import { MODES, type ModeSpec } from "../data/modes.ts";
import { SECTORS, SECTOR_ORDER, bookForSectors, sectorChips, symsOfSector } from "../data/sectors.ts";
import { playClip, useSoundHover } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, wall } from "../theme.ts";
import { ChromeTag } from "./ChromeTag.tsx";
import type { LobbyDef, SectorKey } from "../types.ts";

/** Native `title` for a sector chip: the card face is too dense for the rich
 *  tooltip /create gives these chips, but the tickers still have to be one
 *  hover away. A collapsed preset chip ("ALL CRYPTO") names the whole book;
 *  a `+N` overflow chip names nothing, since it stands for no one group. */
function chipTitle(key: string, label: string, sectors: readonly SectorKey[]): string | undefined {
  if (key in SECTORS) return `${label} — ${symsOfSector(key as SectorKey).join(" · ")}`;
  if (key.startsWith("+")) return undefined;
  return `${label} — ${bookForSectors(sectors).join(" · ")}`;
}

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
/**
 * `"15 MIN"` → `"15M"`, `"24 HOURS"` → `"24H"`. The mode chip stacks above the
 * legs badge in a 264px-wide card, so the badge column stays one token deep.
 */
const shortDuration = (m: ModeSpec): string =>
  m.minutes < 60 ? `${m.minutes}M` : `${m.minutes / 60}H`;

export function LobbyCard({
  lobby,
  onAccept,
  onStart,
}: {
  lobby: LobbyDef;
  onAccept: () => void;
  onStart: () => void;
}) {
  // Straight onto the existing card div: the board is a grid of these and a
  // sweep across it must not add a wrapper (the tests reach for the card's own
  // button and count `[data-lobby]` nodes). The hover budget thins the sweep.
  const hover = useSoundHover("card.hover");

  const color = MARKET_COLOR[lobby.market];
  const [a, b, deg] = MARKET_WALL[lobby.market];
  const waiting = lobby.mine && lobby.status === "open";
  const ready = lobby.mine && lobby.status === "matched";

  const status = waiting
    ? { text: "YOURS · WAITING FOR P2", color: C.amber, pulse: true }
    : ready
      ? { text: `MATCHED · VS ${lobby.opponent?.name.toUpperCase() ?? "?"}`, color: C.green, pulse: false }
      : { text: "OPEN · WAITING FOR P2", color: C.green, pulse: true };

  // Resting state shows at most two sector chips; the hover pane shows the
  // book in full, so a collapsed `ALL STOCKS` chip is never the whole story.
  const chips = sectorChips(lobby.sectors, 2);
  const mode = MODES[lobby.mode];
  const picked = new Set(lobby.sectors);
  const sectorLine = SECTOR_ORDER.filter((k) => picked.has(k))
    .map((k) => SECTORS[k].label)
    .join(" + ");

  /** Three lines on hover. Enough to know what you are sitting down to. */
  const details = [
    `${lobby.host.name} · ${MARKET_LABEL[lobby.market]} · ${lobby.legs} legs · ${sectorLine}`,
    `${lobby.prize.toFixed(2)} Ξ pool · ${(lobby.prize / 2).toFixed(2)} Ξ each`,
    `${mode.label} · ${mode.duration} window · spin deals the tickers · most legs wins`,
  ];

  return (
    <div
      className="vc-lobby"
      data-lobby={lobby.id}
      onPointerEnter={hover.onPointerEnter}
      style={sx(
        `position:relative;height:300px;border:1px solid ${lobby.mine ? "rgba(99,102,241,.45)" : C.border};` +
          `border-radius:16px;overflow:hidden;background:${C.card}`,
      )}
    >
      {/* The wall, then the card's own generative picture — `CardArt`, back
          where it was. One wave of this board wore a chrome candlestick
          ornament here instead; seeing it at a wide viewport the owner asked
          for the background to go back and for the chrome to move onto the
          LABELS, which is what `ChromeTag` below now is. Nothing was
          resurrected to do it: `Room.tsx` never stopped drawing these
          patterns, so only the call site came back. */}
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
              <PlayerMark
                name={lobby.host.name}
                initials={lobby.host.initial}
                bg={lobby.host.bg}
                size={30}
              />
              <div style={sx("min-width:0")}>
                <div style={sx(`font:700 12.5px/1 ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>
                  {lobby.host.name}
                </div>
                <div style={sx(`margin-top:4px;font:400 9.5px/1 ${MONO};color:${C.dim}`)}>
                  host · {lobby.createdAgo} ago
                </div>
              </div>
            </div>
            {/* The badge column: what window you are playing, then how many
                legs. BLITZ keeps its pulse — that is a `styles.css` keyframe on
                the chip itself, and it rides through `extra` because
                `ChromeTag` has no business knowing the mode vocabulary. */}
            <div style={sx("display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none")}>
              <ChromeTag
                uid={`${lobby.id}-mode`}
                color={mode.color}
                size="mini"
                extra={lobby.mode === "BLITZ" ? ";animation:vcPulse 1.6s ease-in-out infinite" : ""}
              >
                {mode.label} · {shortDuration(mode)}
              </ChromeTag>
              <ChromeTag uid={`${lobby.id}-legs`} color={C.muted} size="mini">
                {lobby.legs} LEGS
              </ChromeTag>
            </div>
          </div>

          <div className="vc-lobby-fade">
            <div
              style={sx(
                "display:flex;align-items:center;gap:6px;margin-top:16px;flex-wrap:nowrap;overflow:hidden",
              )}
            >
              <ChromeTag uid={`${lobby.id}-mkt`} color={color}>
                {MARKET_LABEL[lobby.market]}
              </ChromeTag>
              {chips.map((chip) => (
                <ChromeTag
                  key={chip.key}
                  uid={`${lobby.id}-${chip.key}`}
                  color={chip.color}
                  size="mini"
                  title={chipTitle(chip.key, chip.label, lobby.sectors)}
                >
                  {chip.label}
                </ChromeTag>
              ))}
            </div>
            {/* A SECOND `vc-lobby-fade`, nested inside the first, and the fix
                for a real legibility bug: the stylesheet fades this block to
                0.18 on hover, but the three detail lines land exactly on the
                title's line, so a ghost of "Majors only" was printing through
                "mira.base · CRYPTO · 2 legs · MAJORS" and neither read. The
                chips can survive at 0.18 — they sit above the details and read
                as texture. The title cannot: it is the same size and weight as
                nothing else on the card and it is directly underneath. Nesting
                the class multiplies the two transitions, 0.18 x 0.18 ≈ 0.03,
                which is gone rather than faint — and it does it with the rule
                the stylesheet already ships, so no new CSS, no `:hover` that
                inline styles cannot express, and no pointer state in React
                re-rendering six cards on every mouse move. */}
            <div
              className="vc-lobby-fade"
              style={sx(`margin-top:10px;font:700 21px/1.1 ${SANS};letter-spacing:-.02em;text-shadow:0 2px 12px rgba(0,0,0,.6)`)}
            >
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
                onClick={() => {
                  // The recorded clip REPLACES `card.start` / `card.accept`:
                  // both at once is one doubled transient, which reads as a
                  // bug rather than as emphasis.
                  playClip("exo-2", "/assets/exo-kill-2.mp3");
                  (ready ? onStart : onAccept)();
                }}
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
