import { meta } from "../data/universe.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { Direction, Leg } from "../types.ts";

const ON = `height:28px;flex:1;border-radius:7px;cursor:pointer;font:700 10px/1 ${MONO};letter-spacing:.1em;border:none;`;
const OFF =
  `height:28px;flex:1;border-radius:7px;cursor:pointer;font:700 10px/1 ${MONO};letter-spacing:.1em;` +
  `border:1px solid ${C.borderMid};background:transparent;color:${C.dim}`;

interface ParlayLockProps {
  myLegs: readonly Leg[];
  /** Drives the lock countdown; one second per 8 ticks. */
  tick: number;
  opponent: string;
  onSetDir: (sym: string, dir: Direction) => void;
  onLock: () => void;
}

export function ParlayLock({ myLegs, tick, opponent, onSetDir, onLock }: ParlayLockProps) {
  const secs = Math.max(0, 60 - Math.floor(tick / 8));
  const countdown = `0:${secs < 10 ? "0" : ""}${secs}`;

  return (
    <div style={sx("padding:24px 28px;max-width:1440px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Parlay selection</h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.accent};` +
              "border:1px solid rgba(200,255,0,.3);background:rgba(200,255,0,.08);" +
              "border-radius:6px;padding:6px 8px",
          )}
        >
          BLIND · OPPONENT SLIP HIDDEN
        </span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>LOCK IN</span>
        <span
          style={sx(
            `font:700 22px/1 ${MONO};color:${secs <= 10 ? C.red : C.text}` +
              (secs <= 10 ? ";animation:vcPulse 1.2s ease-in-out infinite" : ""),
          )}
        >
          {countdown}
        </span>
      </div>

      <div
        style={sx("display:grid;grid-template-columns:minmax(0,1fr) 320px;gap:20px;align-items:start")}
      >
        <div
          style={sx(
            `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`,
          )}
        >
          <div
            style={sx(
              `display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid ${C.border}`,
            )}
          >
            <span style={sx(`font:700 14px/1 ${SANS}`)}>Your legs</span>
            <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>
              PICK A DIRECTION PER DRAFTED TICKER
            </span>
          </div>

          <div
            style={sx("display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;padding:16px")}
          >
            {myLegs.map((l) => (
              <div
                key={l.sym}
                style={sx(
                  `border:1px solid ${C.border};border-radius:11px;background:${C.cardAlt};padding:14px`,
                )}
              >
                <div style={sx("display:flex;align-items:center;justify-content:space-between")}>
                  <span style={sx(`font:700 15px/1 ${MONO}`)}>{l.sym}</span>
                  <span style={sx(`font:400 10px/1 ${MONO};color:${C.dim}`)}>
                    {l.sector ?? meta(l.sym).sector}
                  </span>
                </div>

                <div style={sx("margin-top:12px;display:flex;gap:6px")}>
                  <button
                    onClick={() => onSetDir(l.sym, "over")}
                    style={sx(l.dir === "over" ? `${ON}background:${C.green};color:${C.bg}` : OFF)}
                  >
                    OVER
                  </button>
                  <button
                    onClick={() => onSetDir(l.sym, "under")}
                    style={sx(l.dir === "under" ? `${ON}background:${C.red};color:${C.bg}` : OFF)}
                  >
                    UNDER
                  </button>
                </div>

                <div
                  style={sx(
                    `margin-top:12px;font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.faint}`,
                  )}
                >
                  TARGET MOVE
                </div>
                <div style={sx(`margin-top:7px;font:700 18px/1 ${MONO};color:${C.accent}`)}>
                  {l.dir === "over" ? "+" : "−"}
                  {l.t.toFixed(1)}%
                </div>
                <div style={sx(`margin-top:10px;font:400 10.5px/1.4 ${MONO};color:${C.faint}`)}>
                  {l.dir === "over"
                    ? "wins if it closes above target"
                    : "wins if it closes below target"}
                </div>
              </div>
            ))}
          </div>

          <div
            style={sx(
              `display:flex;align-items:center;gap:12px;padding:14px 18px;` +
                `border-top:1px solid ${C.border};background:${C.card}`,
            )}
          >
            <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
              Coach: three legs on one timeline is one bet. Split directions to survive a flat tape.
            </span>
            <div style={sx("flex:1")} />
            <button
              onClick={onLock}
              style={sx(
                `height:36px;padding:0 16px;border:none;border-radius:8px;background:${C.accent};` +
                  `color:${C.bg};font:700 12px/1 ${SANS};cursor:pointer;white-space:nowrap`,
              )}
            >
              Lock parlay → fight
            </button>
          </div>
        </div>

        <div
          style={sx(
            "border:1px solid rgba(248,113,113,.35);border-radius:12px;" +
              "background:linear-gradient(180deg,rgba(248,113,113,.08),#0f0f11 40%);overflow:hidden",
          )}
        >
          <div
            style={sx(
              `display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ${C.border}`,
            )}
          >
            <div
              style={sx(
                `width:30px;height:30px;border-radius:9px;background:${C.red};display:grid;` +
                  `place-items:center;font:700 12px/1 ${SANS};color:${C.bg}`,
              )}
            >
              KZ
            </div>
            <div>
              <div style={sx(`font:700 13px/1 ${SANS}`)}>{opponent}</div>
              <div style={sx(`margin-top:4px;font:400 10px/1 ${MONO};color:${C.red}`)}>selecting…</div>
            </div>
          </div>

          <div style={sx("display:flex;flex-direction:column;gap:8px;padding:16px")}>
            {myLegs.map((_, i) => (
              <div
                key={i}
                style={sx(
                  `display:flex;align-items:center;gap:10px;padding:12px;border:1px dashed ${C.borderMid};border-radius:9px`,
                )}
              >
                <span
                  style={sx(
                    `width:22px;height:22px;flex:none;border-radius:6px;background:${C.border};` +
                      `display:grid;place-items:center;font:700 10px/1 ${MONO};color:${C.faint}`,
                  )}
                >
                  ?
                </span>
                <span
                  style={sx(`font:700 13px/1 ${MONO};letter-spacing:.24em;color:${C.borderMid}`)}
                >
                  •••••
                </span>
              </div>
            ))}
            <div
              style={sx(
                `margin-top:6px;font:400 11px/1.5 ${MONO};color:${C.faint};text-align:center`,
              )}
            >
              Revealed when both slips lock.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
