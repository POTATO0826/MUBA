import { caseArt } from "../data/ascii.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, tag, wall } from "../theme.ts";
import type { CaseDef } from "../types.ts";

/**
 * `data-wall` opts the backdrop into the counter-parallax in `useTilt`. The
 * design authored both halves — the handler queries `[data-wall]` and the
 * backdrop carries a transform transition — but never marked the element, so
 * the effect lay dormant. Removing this attribute restores the flat version.
 */

/** Fallback when a case has no picture: a plain distribution strip. */
const NO_ART = String.raw`
   .   .   .   .   .   .
  _|___|___|___|___|___|_`.slice(1);

/** "0.41 Ξ" → 0.41. Cost and max are display strings in the fixtures. */
const eth = (s: string): number => parseFloat(s);

/** Compact card on the lobby: cost and max payout, no picture. */
export function LobbyCaseCard({ c }: { c: CaseDef }) {
  return (
    <div
      data-tilt
      style={sx(
        `position:relative;height:246px;border:1px solid ${C.border};border-radius:14px;` +
          `overflow:hidden;background:${C.card};cursor:pointer;transform-style:preserve-3d;perspective:900px`,
      )}
    >
      <div data-wall style={sx(wall(c.w[0], c.w[1], c.w[2]))} />
      <div
        data-tilt-layer
        style={sx(
          "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;" +
            "padding:16px;transform:translateZ(40px)",
        )}
      >
        <div style={sx("display:flex;justify-content:space-between;align-items:flex-start")}>
          <div style={sx(tag(c.tc))}>{c.tag}</div>
          <div style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>{c.legs}</div>
        </div>
        <div>
          <div style={sx(`font:700 19px/1.1 ${SANS};letter-spacing:-.02em`)}>{c.name}</div>
          <div style={sx(`margin-top:6px;font:400 11px/1.45 ${SANS};color:${C.muted}`)}>{c.blurb}</div>
          <div
            style={sx(
              "display:flex;align-items:flex-end;justify-content:space-between;margin-top:14px",
            )}
          >
            <div>
              <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>
                OPEN COST
              </div>
              <div style={sx(`margin-top:5px;font:700 17px/1 ${MONO};color:${C.accent}`)}>
                {c.cost}
              </div>
            </div>
            <div style={sx("text-align:right")}>
              <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>
                MAX PAYOUT
              </div>
              <div style={sx(`margin-top:5px;font:700 17px/1 ${MONO}`)}>{c.max}</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

interface LibraryCaseCardProps {
  c: CaseDef;
  onOpen: () => void;
  /** Tier name when the case is gated above the player; null when openable. */
  lockedBy?: string | null;
}

/** Full card in the rewards library: ASCII picture, odds, tier lock, actions. */
export function LibraryCaseCard({ c, onOpen, lockedBy = null }: LibraryCaseCardProps) {
  const odds = eth(c.max) / eth(c.cost);
  const locked = lockedBy !== null;

  return (
    <div
      data-tilt
      style={sx(
        `position:relative;height:372px;border:1px solid ${locked ? C.border : C.border};border-radius:16px;` +
          `overflow:hidden;background:${C.card};cursor:pointer;perspective:900px`,
      )}
    >
      <div data-wall style={sx(wall(c.w[0], c.w[1], c.w[2]) + (locked ? ";opacity:.45" : ""))} />

      <div
        data-tilt-layer
        style={sx(
          "position:absolute;inset:0;display:flex;flex-direction:column;justify-content:space-between;" +
            "padding:18px;transform:translateZ(46px)",
        )}
      >
        <div style={sx("display:flex;justify-content:space-between;align-items:flex-start;gap:8px")}>
          <div style={sx(tag(c.tc))}>{c.tag}</div>
          <div style={sx("display:flex;align-items:center;gap:8px")}>
            {locked && (
              <span
                style={sx(
                  `font:700 8px/1 ${MONO};letter-spacing:.12em;padding:5px 7px;border-radius:5px;` +
                    `border:1px solid ${C.borderMid};background:${C.raised};color:${C.muted}`,
                )}
              >
                LOCKED · {lockedBy}
              </span>
            )}
            <div style={sx(`font:500 10px/1 ${MONO};color:${C.muted}`)}>{c.legs}</div>
          </div>
        </div>

        <div>
          <div
            style={sx(
              `margin:0 0 14px;padding:8px 10px;border-radius:10px;background:rgba(0,0,0,.32);` +
                `border:1px solid rgba(255,255,255,.05);overflow:hidden`,
            )}
          >
            <pre
              aria-hidden
              style={sx(
                `margin:0;font:500 8px/1.05 ${MONO};letter-spacing:0;color:${locked ? C.dim : c.tc};` +
                  `white-space:pre;text-shadow:0 0 10px currentColor;opacity:${locked ? ".55" : "1"}`,
              )}
            >
              {caseArt(c.name) ?? NO_ART}
            </pre>
          </div>

          <div style={sx(`font:700 21px/1.1 ${SANS};letter-spacing:-.02em`)}>{c.name}</div>
          <div style={sx(`margin-top:7px;font:400 11.5px/1.5 ${SANS};color:${C.muted};text-wrap:pretty`)}>
            {c.blurb}
          </div>

          <div
            style={sx(
              `display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:14px;padding-top:12px;` +
                `border-top:1px solid ${C.line}`,
            )}
          >
            <Figure label="OPEN COST" value={c.cost} color={C.accent} />
            <Figure label="MAX PAYOUT" value={c.max} />
            <Figure label="ODDS" value={`${odds.toFixed(1)}×`} color={c.tc} />
          </div>

          <div style={sx("display:flex;align-items:center;gap:10px;margin-top:14px")}>
            <button
              onClick={locked ? undefined : onOpen}
              disabled={locked}
              style={sx(
                `height:36px;flex:1;border:none;border-radius:8px;font:700 12px/1 ${SANS};` +
                  (locked
                    ? `background:${C.border};color:${C.dim};cursor:not-allowed`
                    : `background:${C.accent};color:${C.bg};cursor:pointer`),
              )}
            >
              {locked ? `Reach ${lockedBy} to open` : `Open · ${c.cost}`}
            </button>
            <button
              style={sx(
                `height:36px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;` +
                  `background:transparent;color:${C.text};font:500 12px/1 ${SANS};cursor:pointer`,
              )}
            >
              Odds
            </button>
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
