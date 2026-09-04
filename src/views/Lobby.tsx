import { useRef } from "react";
import { CursorField } from "../components/CursorField.tsx";
import { DitherReveal } from "../components/DitherReveal.tsx";
import { PlayerMark } from "../components/PlayerMark.tsx";
import { CHAMP_ART, SETTLED_CASES, TOP_WINS } from "../data/fixtures.ts";
import type { Grade } from "../data/qualify.ts";
import { sfx } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, FEED_STATE, MONO, SANS } from "../theme.ts";
import { LobbyCard } from "../ui/LobbyCards.tsx";
import type { LobbyDef } from "../types.ts";

interface LobbyProps {
  lobbies: readonly LobbyDef[];
  onFindMatch: () => void;
  onCreate: () => void;
  onAccept: (id: string) => void;
  onStart: (id: string) => void;
  /** Today's measured grades, whole — `gradeIndex(source)`. Threaded straight
   *  to the card, which takes its own names out of it; absent means no book was
   *  read, which the card renders as no chip rather than as THIN. */
  grades?: Readonly<Record<string, Grade>>;
}

/** Home: the hero, the biggest payoffs, and a taste of the board. */
export function Lobby({ lobbies, onFindMatch, onCreate, onAccept, onStart, grades }: LobbyProps) {
  const featured = lobbies.slice(0, 4);

  return (
    <div style={sx("display:flex;flex-direction:column;gap:24px;padding:28px;max-width:1720px;margin:0 auto;min-width:0")}>
      <Hero onFindMatch={onFindMatch} onCreate={onCreate} />
      <BiggestPayoffs />

      <section>
        <div style={sx("display:flex;align-items:center;gap:12px;margin-bottom:14px")}>
          <h2 style={sx(`margin:0;font:700 17px/1 ${SANS};letter-spacing:-.02em`)}>Open lobbies</h2>
          <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>{lobbies.filter((l) => l.status === "open").length} waiting for a second seat</span>
          <div style={sx("flex:1")} />
          <button
            onClick={() => {
              sfx("ui.click");
              onFindMatch();
            }}
            style={sx(
              `height:28px;padding:0 12px;border-radius:99px;cursor:pointer;font:500 11px/1 ${MONO};` +
                `border:1px solid ${C.border};background:transparent;color:${C.muted}`,
            )}
          >
            All lobbies →
          </button>
        </div>
        <div style={sx("display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:16px")}>
          {featured.map((l) => (
            <LobbyCard
              key={l.id}
              lobby={l}
              onAccept={() => onAccept(l.id)}
              onStart={() => onStart(l.id)}
              grades={grades}
            />
          ))}
        </div>
      </section>
    </div>
  );
}

function Hero({ onFindMatch, onCreate }: { onFindMatch: () => void; onCreate: () => void }) {
  // The cursor trail reads this to keep its glyphs off the hand art.
  const handRef = useRef<HTMLDivElement>(null);

  return (
    <section
      style={sx(
        `position:relative;overflow:hidden;border:1px solid ${C.borderMid};border-radius:14px;` +
          "background:linear-gradient(115deg,#26262b 0%,#1b1b1f 55%,#212126 100%);padding:30px 32px",
      )}
    >
      <div
        ref={handRef}
        data-hero-art=""
        style={sx(
          "position:absolute;top:0;right:0;bottom:0;width:52%;mix-blend-mode:screen;" +
            "filter:brightness(1.75) contrast(1.3);animation:vcDrift 18s ease-in-out infinite",
        )}
      >
        <DitherReveal ditherStyle="bayer8" dotSize={5} revealRadius={190} revealSoftness={40} wave waveSpeed={34} waveDensity={14} focusY={46} />
      </div>
      <div style={sx("position:absolute;inset:0;background:radial-gradient(500px 240px at 88% 20%, rgba(200,255,0,.14), transparent 65%);pointer-events:none")} />
      {/* Above the backdrop, below the copy — see the z-index on the row that follows. */}
      <CursorField excludeRef={handRef} />
      <div style={sx("position:relative;z-index:1;display:flex;flex-wrap:wrap;align-items:flex-start;gap:32px")}>
        <div style={sx("position:relative;flex:1;min-width:300px;max-width:560px")}>
          <div
            style={sx(
              `display:inline-flex;align-items:center;gap:7px;font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.accent};` +
                "border:1px solid rgba(200,255,0,.3);background:rgba(200,255,0,.08);border-radius:6px;padding:6px 9px",
            )}
          >
            {/* A season is a real thing that is really running — this says the
                season is open, not that a venue is streaming. It deliberately
                does NOT use `stateChip`: the four feed states describe where
                DATA came from, and borrowing LIVE for anything else is how
                `/ranks` came to wear a pulsing live dot over a seeded ladder
                (fixed alongside this). Season, not feed. */}
            SEASON 01 · OPEN
          </div>
          <h1 style={sx(`margin:16px 0 10px;font:700 36px/1.08 ${SANS};letter-spacing:-.03em`)}>
            Battle the book, not the market.
          </h1>
          <p style={sx(`margin:0 0 22px;font:400 14px/1.6 ${SANS};color:${C.muted};max-width:470px;text-wrap:pretty`)}>
            Take a seat, let the spin deal the tickers, read the case, pick a parlay and duel it
            out on the tape. Options pricing streams live from Thetanuts on Base.
          </p>
          <div style={sx("display:flex;gap:10px")}>
            <button
              onClick={() => {
                sfx("ui.click.primary");
                onFindMatch();
              }}
              style={sx(`height:40px;padding:0 18px;border:none;border-radius:8px;background:${C.accent};color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`)}
            >
              Find a match
            </button>
            <button
              onClick={() => {
                sfx("ui.click.primary");
                onCreate();
              }}
              style={sx(`height:40px;padding:0 18px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;color:${C.text};font:500 13px/1 ${SANS};cursor:pointer`)}
            >
              Create lobby
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * The podium and the marquee stack rather than share a row: side by side the
 * three podium cells squeezed into whatever the marquee left them, and the
 * champion art wrapped under the rank badge on anything narrower than a wide
 * desk. Stacked, the podium is three equal cells at full width and the tape
 * scrolls beneath it at its own pace.
 */
function BiggestPayoffs() {
  // The strip renders the list twice so `vcStream`'s -50% translate loops seamlessly.
  const marquee = [...SETTLED_CASES, ...SETTLED_CASES];

  return (
    <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`)}>
      <div style={sx(`display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid ${C.line}`)}>
        <span style={sx(`width:6px;height:6px;border-radius:99px;background:${C.accent}`)} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.accent}`)}>BIGGEST PAYOFFS 24H</span>
        <div style={sx("flex:1")} />
        {/* `SETTLED_CASES` is a checked-in fixture list, so this reads SEEDED
            like every other fixture in the app. It said `MOCK` — the word the
            implementation uses (`mockMarketSource`, `wallet.id === "mock"`) and
            the fourth different name one app had for one idea. Same claim, same
            resting grey, the vocabulary's word. */}
        <span
          title={FEED_STATE.seeded.means}
          style={sx(
            `font:500 9px/1 ${MONO};letter-spacing:.1em;color:${FEED_STATE.seeded.color}`,
          )}
        >
          SETTLED ON BASE · {FEED_STATE.seeded.label}
        </span>
      </div>

      <div style={sx(`display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-bottom:1px solid ${C.line}`)}>
        {TOP_WINS.map((w, i) => (
          <div
            key={w.rank}
            style={sx(
              "display:flex;flex-direction:column;padding:16px 18px;min-width:0;background:" +
                (i === 0 ? "linear-gradient(180deg,rgba(200,255,0,.09),transparent 70%)" : "transparent") +
                `;border-right:${i < 2 ? `1px solid ${C.line}` : "none"}`,
            )}
          >
            <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:8px")}>
              <span
                style={sx(
                  `font:700 10px/1 ${MONO};letter-spacing:.1em;padding:5px 7px;border-radius:5px;background:` +
                    (i === 0 ? `${C.accent};color:${C.bg}` : `rgba(255,255,255,.06);color:${C.muted}`),
                )}
              >
                {w.rank}
              </span>
              <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>{w.mult}</span>
            </div>

            <div style={sx("display:flex;align-items:flex-end;gap:14px;margin-top:14px;min-height:78px")}>
              <div style={sx("min-width:0")}>
                <div style={sx(`font:700 24px/1 ${MONO};letter-spacing:-.02em;color:${C.accent}`)}>{w.payout}</div>
                <div style={sx(`margin-top:9px;font:700 11.5px/1.2 ${SANS}`)}>{w.who}</div>
                <div style={sx(`margin-top:5px;font:400 10px/1.3 ${MONO};color:${C.dim};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>
                  {w.structure}
                </div>
              </div>
              {i === 0 && (
                <div style={sx("display:flex;align-items:flex-end;gap:10px;margin-left:auto;flex:none")}>
                  <pre style={sx(`margin:0;font:700 8px/1.15 ${MONO};color:${C.accent};white-space:pre`)}>{CHAMP_ART}</pre>
                  <div style={sx(`font:700 8px/1.5 ${MONO};letter-spacing:.16em;color:${C.accent};animation:vcPulse 2.4s ease-in-out infinite`)}>
                    WINNER
                    <br />
                    WINNER
                    <br />
                    CHICKEN
                    <br />
                    DINNER
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={sx("position:relative;overflow:hidden")}>
        <div className="vc-marquee" style={sx("display:flex;width:max-content;animation:vcStream 46s linear infinite")}>
          {marquee.map((w, i) => (
            <div
              key={`${w.who}-${i}`}
              style={sx(`flex:none;width:172px;padding:14px;border-right:1px solid ${C.line};background:` + (w.win ? "transparent" : "rgba(248,113,113,.045)"))}
            >
              <div style={sx("display:flex;align-items:center;gap:8px")}>
                {/* The last hand-rolled initials chip in the app. It predates
                    `PlayerMark` and was the one avatar `avatarStyle` never
                    owned, which is exactly how it survived — so it goes the
                    same way as the rest: the settled-cases faces are the same
                    people the ladder ranks, and they wear the same mark here. */}
                <PlayerMark name={w.who} initials={w.initial} bg={w.bg} size={26} />
                <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>{w.legs}</span>
              </div>
              <div style={sx(`margin-top:14px;font:700 15px/1 ${MONO};color:${w.win ? C.accent : C.red}`)}>{w.payout}</div>
              <div style={sx(`margin-top:8px;font:700 11px/1.2 ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`)}>{w.who}</div>
              <div style={sx(`margin-top:4px;font:400 9.5px/1.3 ${MONO};color:${C.faint};white-space:nowrap`)}>{w.structure}</div>
            </div>
          ))}
        </div>
        <div style={sx(`position:absolute;top:0;bottom:0;left:0;width:56px;background:linear-gradient(90deg,${C.panel},transparent);pointer-events:none`)} />
        <div style={sx(`position:absolute;top:0;bottom:0;right:0;width:56px;background:linear-gradient(270deg,${C.panel},transparent);pointer-events:none`)} />
      </div>
    </div>
  );
}
