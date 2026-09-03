import { DitherReveal } from "../components/DitherReveal.tsx";
import { FEATURED_CASES } from "../data/cases.ts";
import { CHAMP_ART, SETTLED_CASES, TOP_WINS } from "../data/fixtures.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import { LobbyCaseCard } from "../ui/CaseCards.tsx";

interface LobbyProps {
  onBrowseCases: () => void;
  onDesk: () => void;
  onOpenCase: (id: string) => void;
}

export function Lobby({ onBrowseCases, onDesk, onOpenCase }: LobbyProps) {
  return (
    <div
      style={sx(
        "display:grid;grid-template-columns:minmax(0,1fr);gap:28px;padding:28px;" +
          "max-width:1720px;margin:0 auto;align-items:start",
      )}
    >
      <div style={sx("display:flex;flex-direction:column;gap:24px;min-width:0")}>
        <Hero onBrowseCases={onBrowseCases} onDesk={onDesk} />
        <BiggestPayoffs />

        <section>
          <div style={sx("display:flex;align-items:baseline;gap:12px;margin-bottom:14px")}>
            <h2 style={sx(`margin:0;font:700 17px/1 ${SANS};letter-spacing:-.02em`)}>
              Featured cases
            </h2>
            <div style={sx("flex:1")} />
            <button
              onClick={onBrowseCases}
              style={sx(
                `height:26px;padding:0 10px;border-radius:99px;cursor:pointer;font:500 11px/1 ${MONO};` +
                  `border:1px solid ${C.border};background:transparent;color:${C.muted}`,
              )}
            >
              All cases →
            </button>
          </div>
          <div style={sx("display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:16px")}>
            {FEATURED_CASES.map((c) => (
              <LobbyCaseCard key={c.id} c={c} onOpen={() => onOpenCase(c.id)} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

function Hero({ onBrowseCases, onDesk }: { onBrowseCases: () => void; onDesk: () => void }) {
  return (
    <section
      style={sx(
        `position:relative;overflow:hidden;border:1px solid ${C.borderMid};border-radius:14px;` +
          "background:linear-gradient(115deg,#26262b 0%,#1b1b1f 55%,#212126 100%);padding:30px 32px",
      )}
    >
      <div
        style={sx(
          "position:absolute;top:0;right:0;bottom:0;width:52%;mix-blend-mode:screen;" +
            "filter:brightness(1.75) contrast(1.3);animation:vcDrift 18s ease-in-out infinite",
        )}
      >
        <DitherReveal
          ditherStyle="bayer8"
          dotSize={5}
          revealRadius={190}
          revealSoftness={40}
          wave
          waveSpeed={34}
          waveDensity={14}
          focusY={46}
        />
      </div>
      <div
        style={sx(
          "position:absolute;inset:0;background:radial-gradient(500px 240px at 88% 20%, " +
            "rgba(200,255,0,.14), transparent 65%);pointer-events:none",
        )}
      />
      <div style={sx("position:relative;display:flex;flex-wrap:wrap;align-items:flex-start;gap:32px")}>
        <div style={sx("position:relative;flex:1;min-width:300px;max-width:560px")}>
          <div
            style={sx(
              `display:inline-flex;align-items:center;gap:7px;font:500 10px/1 ${MONO};` +
                `letter-spacing:.14em;color:${C.accent};border:1px solid rgba(200,255,0,.3);` +
                "background:rgba(200,255,0,.08);border-radius:6px;padding:6px 9px",
            )}
          >
            SEASON 01 · LIVE
          </div>
          <h1 style={sx(`margin:16px 0 10px;font:700 36px/1.08 ${SANS};letter-spacing:-.03em`)}>
            Open the case. Hold the legs. Take the payoff.
          </h1>
          <p
            style={sx(
              `margin:0 0 22px;font:400 14px/1.6 ${SANS};color:${C.muted};max-width:470px;text-wrap:pretty`,
            )}
          >
            Pick a case, spin its book for your legs, tier each one, then hold the position to
            expiry. Options pricing streams live from Thetanuts on Base.
          </p>
          <div style={sx("display:flex;gap:10px")}>
            <button
              onClick={onBrowseCases}
              style={sx(
                `height:40px;padding:0 18px;border:none;border-radius:8px;background:${C.accent};` +
                  `color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer`,
              )}
            >
              Open a case
            </button>
            <button
              onClick={onDesk}
              style={sx(
                `height:40px;padding:0 18px;border:1px solid ${C.borderMid};border-radius:8px;` +
                  `background:transparent;color:${C.text};font:500 13px/1 ${SANS};cursor:pointer`,
              )}
            >
              Options desk
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function BiggestPayoffs() {
  // The strip renders the list twice so `vcStream`'s -50% translate loops seamlessly.
  const marquee = [...SETTLED_CASES, ...SETTLED_CASES];

  return (
    <div
      style={sx(
        `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`,
      )}
    >
      <div
        style={sx(
          `display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:1px solid ${C.line}`,
        )}
      >
        <span style={sx(`width:6px;height:6px;border-radius:99px;background:${C.accent}`)} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.accent}`)}>
          BIGGEST PAYOFFS 24H
        </span>
      </div>

      <div style={sx("display:grid;grid-template-columns:minmax(0,528px) minmax(0,1fr)")}>
        <div
          style={sx(
            `display:grid;grid-template-columns:repeat(3,minmax(0,1fr));border-right:1px solid ${C.line}`,
          )}
        >
          {TOP_WINS.map((w, i) => (
            <div
              key={w.rank}
              style={sx(
                "padding:16px;background:" +
                  (i === 0
                    ? "linear-gradient(180deg,rgba(200,255,0,.09),transparent 70%)"
                    : "transparent") +
                  `;border-right:${i < 2 ? `1px solid ${C.line}` : "none"}`,
              )}
            >
              <div style={sx("display:flex;align-items:center;justify-content:space-between")}>
                <span
                  style={sx(
                    `font:700 10px/1 ${MONO};letter-spacing:.1em;padding:5px 7px;border-radius:5px;background:` +
                      (i === 0
                        ? `${C.accent};color:${C.bg}`
                        : `rgba(255,255,255,.06);color:${C.muted}`),
                  )}
                >
                  {w.rank}
                </span>
                <span
                  style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}
                >
                  {w.mult}
                </span>
              </div>

              {i === 0 && (
                <div style={sx("display:flex;align-items:flex-end;gap:10px;margin-top:14px")}>
                  <pre style={sx(`margin:0;font:700 8px/1.15 ${MONO};color:${C.accent};white-space:pre`)}>
                    {CHAMP_ART}
                  </pre>
                  <div
                    style={sx(
                      `font:700 8px/1.5 ${MONO};letter-spacing:.16em;color:${C.accent};` +
                        "animation:vcPulse 2.4s ease-in-out infinite",
                    )}
                  >
                    FULL
                    <br />
                    HOUSE
                    <br />
                    EVERY
                    <br />
                    LEG
                  </div>
                </div>
              )}

              <div
                style={sx(
                  `margin-top:16px;font:700 22px/1 ${MONO};letter-spacing:-.02em;color:${C.accent}`,
                )}
              >
                {w.payout}
              </div>
              <div style={sx(`margin-top:9px;font:700 11.5px/1.2 ${SANS}`)}>{w.who}</div>
              <div style={sx(`margin-top:5px;font:400 10px/1.3 ${MONO};color:${C.dim}`)}>
                {w.structure}
              </div>
            </div>
          ))}
        </div>

        <div style={sx("position:relative;overflow:hidden")}>
          <div
            className="vc-marquee"
            style={sx("display:flex;width:max-content;animation:vcStream 46s linear infinite")}
          >
            {marquee.map((w, i) => (
              <div
                key={`${w.who}-${i}`}
                style={sx(
                  `flex:none;width:172px;padding:14px;border-right:1px solid ${C.line};background:` +
                    (w.win ? "transparent" : "rgba(248,113,113,.045)"),
                )}
              >
                <div style={sx("display:flex;align-items:center;gap:8px")}>
                  <div
                    style={sx(
                      "width:22px;height:22px;border-radius:7px;flex:none;display:grid;place-items:center;" +
                        `font:700 9px/1 ${SANS};color:${C.bg};background:${w.bg}`,
                    )}
                  >
                    {w.initial}
                  </div>
                  <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>{w.legs}</span>
                </div>
                <div
                  style={sx(
                    `margin-top:14px;font:700 15px/1 ${MONO};color:${w.win ? C.accent : C.red}`,
                  )}
                >
                  {w.payout}
                </div>
                <div
                  style={sx(
                    `margin-top:8px;font:700 11px/1.2 ${SANS};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`,
                  )}
                >
                  {w.who}
                </div>
                <div
                  style={sx(
                    `margin-top:4px;font:400 9.5px/1.3 ${MONO};color:${C.faint};white-space:nowrap`,
                  )}
                >
                  {w.structure}
                </div>
              </div>
            ))}
          </div>
          <div
            style={sx(
              `position:absolute;top:0;bottom:0;left:0;width:56px;background:linear-gradient(90deg,${C.panel},transparent);pointer-events:none`,
            )}
          />
          <div
            style={sx(
              `position:absolute;top:0;bottom:0;right:0;width:56px;background:linear-gradient(270deg,${C.panel},transparent);pointer-events:none`,
            )}
          />
        </div>
      </div>
    </div>
  );
}
