import { sx } from "../lib/sx.ts";
import { CARD_DETAILS, type CardDetail } from "../state/detail.ts";
import { C, MONO, pill } from "../theme.ts";

/**
 * The card detail control — plan 6 §E2.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * WHY THIS IS ON THE SURFACE AND NOT IN A SETTINGS MENU
 * ────────────────────────────────────────────────────────────────────────────
 * A visible three-way toggle, deliberately, and the plan says why in one line:
 * most players never touch it, so the rank defaults still walk them up the
 * ramp — but a Thetanuts reviewer can reach FULL in **one tap** instead of
 * grinding XP, and in a pitch that matters more than the ramp does. A checkbox
 * three menus deep would keep the ramp and lose the reviewer, which is the
 * worse trade of the two.
 *
 * It is a segmented control and not a stepper, because §E2's rule is that the
 * move is available **in either direction** at any time: three targets, always
 * all three, one press to any of them. Nothing is ever disabled and nothing is
 * ever marked locked — there is no `disabled` prop on this component and no
 * caller may add one.
 *
 * Three real `<button>`s in a `role="group"`, so it is tab-reachable and
 * space/enter-operable with no key handling of our own, and each carries
 * `aria-pressed` so a screen reader announces which of the three is in force.
 * `pill()` from `theme.ts` is the app's existing chip idiom — `Battles`,
 * `CreateLobby`, `Parlay` and `RfqPanel` all draw filters this way, so the
 * control reads as furniture the player has already used rather than as a new
 * kind of switch.
 */

const ROW = "display:inline-flex;align-items:center;gap:6px";

const LABEL =
  `font:700 8.5px/1 ${MONO};letter-spacing:.12em;color:${C.faint};` + "margin-right:2px;flex:none";

const GROUP = "display:inline-flex;align-items:center;gap:4px";

/** What each level puts on a card, in the words the tooltip may use. Kept
 *  short: the contract itself lives in `state/detail.ts`. */
const MEANS: Record<CardDetail, string> = {
  SIMPLE: "Direction, payout, max loss.",
  STANDARD: "Adds strike, the odds, and ITM/OTM.",
  FULL: "Adds the payoff curve, breakeven, and the greeks.",
};

export interface DetailToggleProps {
  /** The level in force — `useCardDetail(tier).level`. */
  level: CardDetail;
  /** Pin a new one. Called for a press on a level that is already in force
   *  too; the store treats that as the player confirming their choice. */
  onChange: (next: CardDetail) => void;
  /** Show the `DETAIL` caption. Off for tight headers. */
  label?: boolean;
}

export function DetailToggle({ level, onChange, label = true }: DetailToggleProps) {
  return (
    <div style={sx(ROW)}>
      {label ? <span style={sx(LABEL)}>DETAIL</span> : null}
      <div role="group" aria-label="Card detail" style={sx(GROUP)}>
        {CARD_DETAILS.map((d) => {
          const on = d === level;
          return (
            <button
              key={d}
              type="button"
              onClick={() => onChange(d)}
              aria-pressed={on}
              title={MEANS[d]}
              data-testid={`detail-${d}`}
              style={sx(pill(on))}
            >
              {d}
            </button>
          );
        })}
      </div>
    </div>
  );
}
