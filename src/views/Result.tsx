import { useCallback, useState } from "react";
import {
  BASESCAN_TX,
  REFUND_TIMEOUT_HOURS,
  payoutOf,
  usd as usdcText,
} from "../desk/escrow.ts";
import type { DuelStake } from "../state/stake.ts";
import { PlayerMark } from "../components/PlayerMark.tsx";
import { ExitRow, RankUpSequence } from "../components/RankUpSequence.tsx";
import { CHAMP_ART } from "../data/fixtures.ts";
import { modeTag, type ModeSpec } from "../data/modes.ts";
import { SEASON } from "../data/rewards.ts";
import { sectorChips } from "../data/sectors.ts";
import { legState, type MatchVerdict } from "../engine/match.ts";
import { conditionText, type ParlayLeg } from "../engine/parlay.ts";
import { sfx, useCountUp } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, miniTag, tag } from "../theme.ts";
import { NOTIONAL_POOL_LINE } from "../ui/LobbyCards.tsx";
import type { Player, SectorKey } from "../types.ts";
import { TIER_COLOR } from "./ParlayPick.tsx";

interface ResultProps {
  verdict: MatchVerdict;
  you: Player;
  opponent: Player;
  myLegs: readonly ParlayLeg[];
  oppLegs: readonly ParlayLeg[];
  myMult: number;
  oppMult: number;
  /** What you banked in points: the stake at your parlay's odds, or nothing. */
  pointsWon: number;
  salt: number;
  /** The print the duel settled on — the mode's window. Every leg on this
   *  screen is read at it, so a Blitz result never shows a full-tape move. */
  settleAt: number;
  mode: ModeSpec;
  sectors: readonly SectorKey[];
  prizeLabel: string;
  /** ── The rank moment (BUILD-ORDER §C-6). Every one of these is rendered
   *  ONLY inside `RankUpSequence`, behind the gate: plan 1's separate Result
   *  XP chip is absorbed by this sequence and must never be built. ── */
  xpGain: number;
  xpBefore: number;
  xpAfter: number;
  streak: number;
  posBefore: number;
  posAfter: number;
  /**
   * The optional USDC side bet, and the match key the referee knows it by.
   *
   * Both optional together: absent — no flag, no escrow, the mock wallet, a
   * test — this screen renders exactly the DOM it rendered before staking
   * existed. `SideBetClaim` returns `null` for every one of those cases.
   *
   * The ordering this screen depends on lives in `App.settle`, not here:
   * `ledger.settle` fires FIRST and unconditionally, so the PTS result, the XP
   * and the rank move whether or not a chain is reachable. The panel below is
   * strictly downstream of a game that has already finished.
   */
  stake?: DuelStake;
  matchKey?: string;
  onBackToBattles: () => void;
  onRematch: () => void;
  /** `View the full ladder →`. Live: `App` points it at `go("ranks")`, so the
   *  rank moment's call to action lands on the page that page-ranks the same
   *  `LeaderPlayer` this screen just counted out — the loop, closed. */
  onOpenLadder: () => void;
}

/**
 * The screen runs in three phases.
 *
 *   debrief  the three existing blocks, live, plus the `Next → your rank` bar
 *   rank     the same blocks, DIMMED but still mounted, with the sequence below
 *   done     everything lit again, exits revealed
 *
 * The debrief blocks are never unmounted — dimming is a style, so every
 * assertion about the winner banner, the coach grid or the banked figure holds
 * at every phase. Only the exits are gated, which is the one thing the gate is
 * for: the XP moment gets to happen before the player can leave.
 */
type Phase = "debrief" | "rank" | "done";

/** Who took the pool, and a read of each player's slip. */
export function Result(p: ResultProps) {
  const v = p.verdict;
  const nLegs = p.myLegs.length;
  // The banked figure climbs on arrival. Silent builds (and reduced motion)
  // get the final number on the first render — see `useCountUp`.
  const banked = useCountUp(p.pointsWon, { steps: 24 });

  const [phase, setPhase] = useState<Phase>("debrief");
  const onSequenceDone = useCallback(() => setPhase("done"), []);

  const sides = [
    { who: p.you, legs: p.myLegs, mult: p.myMult, score: v.myScore, win: v.meWins, read: v.myRead },
    { who: p.opponent, legs: p.oppLegs, mult: p.oppMult, score: v.oppScore, win: !v.meWins, read: v.oppRead },
  ];

  return (
    <div style={sx("padding:28px;max-width:1100px;margin:0 auto")}>
      {/* The debrief. Dimmed while the rank moment plays, never unmounted —
          the winner banner, the coach grid, the scoreboards and the count-up
          points row all stay exactly where they were and keep reading. */}
      <div
        data-debrief=""
        style={sx(
          "transition:opacity .4s ease,filter .4s ease;" +
            (phase === "rank" ? "opacity:.34;filter:saturate(.6);pointer-events:none" : "opacity:1"),
        )}
      >
        <div
          style={sx(
            "position:relative;overflow:hidden;border:1px solid rgba(200,255,0,.35);border-radius:14px;" +
              "background:linear-gradient(150deg,rgba(200,255,0,.12),#0f0f11 55%);padding:28px 30px",
          )}
        >
          <div style={sx("display:flex;align-items:flex-start;gap:24px")}>
            <pre style={sx(`margin:0;font:700 10px/1.15 ${MONO};color:${C.accent};white-space:pre`)}>{CHAMP_ART}</pre>
            <div>
              <div style={sx(`font:700 10px/1 ${MONO};letter-spacing:.18em;color:${C.accent};animation:vcPulse 2.4s ease-in-out infinite`)}>
                WINNER WINNER CHICKEN DINNER
              </div>
              <h2 style={sx(`margin:14px 0 0;font:700 34px/1.05 ${SANS};letter-spacing:-.03em`)}>
                {v.winner} {v.winnerVerb} the pool
              </h2>
              <div style={sx("margin-top:12px;display:flex;align-items:baseline;gap:16px;flex-wrap:wrap")}>
                <span style={sx(`font:700 30px/1 ${MONO};color:${C.accent}`)}>{p.prizeLabel}</span>
                <span style={sx(`font:500 12px/1 ${MONO};color:${C.muted}`)}>{v.scoreLine}</span>
              </div>
              {/* The largest number on this screen, and the one nobody is paid.
                  `prizeLabel` is `state/match.ts`'s `"4.80 Ξ"` off a seeded
                  `LobbyDef.prize`; what actually moved is the PTS figure two
                  rows down, which is counted out and banked. A visitor with no
                  wallet and every flag off reached here reading that someone
                  "takes the pool — 4.80 ETH" — the unit was spelled out as a
                  word then, and is now the same `Ξ` the board card prints for
                  the same number — so the clause the box arena says
                  about its own stake is said here too, next to the figure it is
                  about. `NOTIONAL_POOL_LINE` is the board card's and the room's
                  line: one statement about the pool, from the lobby list to the
                  scoreboard. */}
              <div
                data-notional-pool=""
                style={sx(`margin-top:8px;font:500 8.5px/1 ${MONO};letter-spacing:.04em;color:${C.faint}`)}
              >
                {NOTIONAL_POOL_LINE}
              </div>
              <div style={sx("margin-top:12px;display:flex;align-items:center;gap:6px;flex-wrap:wrap")}>
                <span style={sx(modeTag(p.mode.key))}>
                  {p.mode.label} · {p.mode.duration}
                </span>
                {sectorChips(p.sectors).map((c) => (
                  <span key={c.key} style={sx(miniTag(c.color))}>
                    {c.label}
                  </span>
                ))}
              </div>
              <div data-testid="points-won" style={sx(`margin-top:10px;font:500 11px/1 ${MONO};color:${v.meWins ? C.green : C.dim}`)}>
                {v.meWins
                  ? `+${banked.toLocaleString("en-US")} PTS banked at ×${p.myMult.toFixed(2)} — your parlay's odds`
                  : `0 PTS · ${p.opponent.name} banks the odds this time`}
              </div>
            </div>
          </div>
        </div>

        {/* Each player's choices and what the tape made of them. */}
        <div style={sx(`border:1px solid ${C.border};border-radius:12px;background:${C.card};overflow:hidden;margin-top:18px`)}>
          <div style={sx(`display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid ${C.border}`)}>
            <div
              style={sx(
                `width:28px;height:28px;border-radius:8px;background:linear-gradient(135deg,${C.indigo},${C.accent});` +
                  `display:grid;place-items:center;font:700 12px/1 ${MONO};color:${C.bg}`,
              )}
            >
              AI
            </div>
            <span style={sx(`font:700 13px/1 ${SANS}`)}>Coach · match summary</span>
            <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>WHAT EACH PLAYER CHOSE · WHAT THE TAPE DID</span>
          </div>

          <div style={sx(`display:grid;grid-template-columns:1fr 1fr;gap:0;border-bottom:1px solid ${C.line}`)}>
            {sides.map((s, i) => (
              <div key={s.who.name} data-summary={s.who.name} style={sx(`padding:16px;${i === 0 ? `border-right:1px solid ${C.line}` : ""}`)}>
                <div style={sx("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
                  <PlayerMark name={s.who.name} initials={s.who.initial} bg={s.who.bg} size={24} />
                  <span style={sx(`font:700 12.5px/1 ${SANS}`)}>{s.who.name}</span>
                  <span
                    style={sx(
                      `font:700 8px/1 ${MONO};letter-spacing:.1em;padding:4px 6px;border-radius:4px;background:` +
                        (s.win ? `${C.accent};color:${C.bg}` : `${C.border};color:${C.muted}`),
                    )}
                  >
                    {s.win ? "WINNER" : "RUNNER-UP"}
                  </span>
                </div>
                <div style={sx("display:flex;align-items:center;gap:6px;margin-top:10px;flex-wrap:wrap")}>
                  {s.legs.map((l) => (
                    <span key={l.sym} style={sx(tag(TIER_COLOR[l.tier]))}>
                      {l.sym} {l.tier}
                      {l.dir === "over" ? "↑" : "↓"}
                    </span>
                  ))}
                  <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>×{s.mult.toFixed(2)} · {s.read.style}</span>
                </div>
                <div style={sx(`margin-top:10px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>{s.read.read}</div>
              </div>
            ))}
          </div>

          <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:0")}>
            <div style={sx(`padding:16px;border-right:1px solid ${C.line}`)}>
              <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.accent}`)}>WHAT DECIDED IT</div>
              <div style={sx(`margin-top:8px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>{v.decider}</div>
            </div>
            <div style={sx("padding:16px")}>
              <div style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.blue}`)}>LESSON FOR NEXT DUEL</div>
              <div style={sx(`margin-top:8px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>{v.lesson}</div>
            </div>
          </div>
        </div>

        <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:18px")}>
          {sides.map((s) => (
            <div
              key={s.who.name}
              style={sx(`border-radius:12px;padding:16px;background:${C.card};border:1px solid ` + (s.win ? "rgba(200,255,0,.4)" : C.border))}
            >
              <div style={sx(`display:flex;align-items:center;justify-content:space-between;padding-bottom:12px;border-bottom:1px solid ${C.border}`)}>
                <span style={sx(`font:700 13px/1 ${SANS}`)}>{s.who.name}</span>
                <span style={sx(`font:700 18px/1 ${MONO};color:${s.win ? C.accent : C.dim}`)}>
                  {s.score} / {nLegs}
                </span>
              </div>
              <div style={sx("display:flex;flex-direction:column;gap:0;margin-top:6px")}>
                {s.legs.map((l) => {
                  const st = legState(l, p.salt, p.settleAt);
                  return (
                    <div
                      key={l.sym}
                      style={sx(`display:grid;grid-template-columns:16px 56px minmax(0,1fr) 72px;align-items:center;gap:10px;padding:11px 0;border-bottom:1px solid ${C.line}`)}
                    >
                      <span style={sx(`width:7px;height:7px;border-radius:99px;background:${st.won ? C.green : C.red}`)} />
                      <span style={sx(`font:700 12px/1 ${MONO}`)}>{l.sym}</span>
                      <span style={sx(`font:400 10px/1.3 ${MONO};color:${C.dim}`)}>{conditionText(l)}</span>
                      <span style={sx(`text-align:right;font:700 12px/1 ${MONO};color:${st.won ? C.green : C.red}`)}>
                        {st.pct >= 0 ? "+" : ""}
                        {st.pct.toFixed(2)}%
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Outside the debrief block on purpose: `phase === "rank"` sets
          `pointer-events:none` on everything above, and a CLAIM button that
          stops responding the moment someone presses "Next" would be a button
          holding real money hostage to an animation. */}
      <SideBetClaim stake={p.stake} matchKey={p.matchKey} meWins={v.meWins} />

      {/* The gate. One press, and the XP moment owns the screen. */}
      {phase === "debrief" && (
        <div style={sx("margin-top:18px")}>
          <button
            onClick={() => {
              sfx("ui.click.primary");
              setPhase("rank");
            }}
            style={sx(
              `position:relative;overflow:hidden;display:block;width:100%;height:56px;border:none;border-radius:12px;` +
                `background:linear-gradient(100deg,${C.accent},#a8e000);color:${C.bg};` +
                `font:700 15px/1 ${SANS};letter-spacing:-.01em;cursor:pointer`,
            )}
          >
            {/* Empty by design: an accent sweep across the bar must not put a
                character into the button's textContent — the test helper
                matches labels on the trimmed text, exactly. */}
            <span
              aria-hidden="true"
              style={sx(
                "position:absolute;top:0;bottom:0;left:0;width:38%;pointer-events:none;" +
                  "background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);" +
                  "animation:vcSweep 2.2s ease-in-out infinite",
              )}
            />
            Next → your rank
          </button>
          <div
            data-next-sub=""
            style={sx(
              `margin-top:8px;text-align:center;font:700 9px/1 ${MONO};letter-spacing:.18em;color:${C.dim}`,
            )}
          >
            {SEASON.label} · +{p.xpGain} XP PENDING
          </div>
        </div>
      )}

      {phase !== "debrief" && (
        <div
          data-rank-overlay=""
          role="dialog"
          aria-modal="true"
          aria-label="Rank progress"
          style={sx(
            "position:fixed;inset:0;z-index:200;display:grid;place-items:center;padding:24px;" +
              "background:rgba(9,9,11,.78);backdrop-filter:blur(5px)",
          )}
        >
          {/* Keep the rank moment's existing UI intact; this shell only moves
              it from the bottom of the result into a compact post-result
              screen. The internal scroller keeps every stage reachable on a
              short viewport without scrolling the debrief behind it. */}
          <div
            style={sx(
              "width:min(760px,100%);max-height:calc(100vh - 48px);overflow-y:auto;" +
                "padding:0 2px 18px;overscroll-behavior:contain",
            )}
          >
            <RankUpSequence
              xpGain={p.xpGain}
              xpBefore={p.xpBefore}
              xpAfter={p.xpAfter}
              streak={p.streak}
              posBefore={p.posBefore}
              posAfter={p.posAfter}
              onDone={onSequenceDone}
              onOpenLadder={p.onOpenLadder}
            />

            {phase === "done" && (
              <ExitRow
                onBackToBattles={p.onBackToBattles}
                onRematch={p.onRematch}
                onOpenLadder={p.onOpenLadder}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE CLAIM — AND THE SIX-HOUR CLOCK NOBODY ELSE WILL MENTION
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The order of operations on this screen is fixed and is the whole point:
 *
 *   1. `ledger.settle` — already happened, in `App.settle`, unconditionally.
 *      The points, the XP and the rank are banked before anything below runs
 *      and regardless of whether it runs at all.
 *   2. `POST /api/attest` — the referee re-derives the winner from the picks it
 *      committed and signs an EIP-712 verdict. It is handed a match key and
 *      nothing else; a `winner` in the body would be ignored.
 *   3. `escrow.settle(verdict)` — relayed from this browser, because `settle` is
 *      permissionless and the winner should never wait on the server to pay gas.
 *   4. A BaseScan link, because a payout nobody can open is not evidence.
 *
 * **Why the copy insists on six hours** (adversarial review finding 4-1,
 * executed): `settle` has no timeout of its own — it is closed by the first
 * `refund`. So after `TIMEOUT` a *losing* player who refunds first moves the
 * duel to REFUNDED, and the winner's still-in-date verdict then reverts
 * `not full`. Both sides end flat. No principal is at risk and no third party
 * gains, but the winner loses the 0.92 × stake they earned, and the only defence
 * is to relay promptly. That is a UI responsibility and this is the UI.
 *
 * **Why the server-down copy says refund** rather than retry: the escrow's
 * timeout needs no server, no signature and no cooperation from the other
 * player. It is the one guarantee that survives this app disappearing entirely.
 */
function SideBetClaim({
  stake,
  matchKey,
  meWins,
}: {
  stake: DuelStake | undefined;
  matchKey: string | undefined;
  meWins: boolean;
}) {
  // Nothing was staked — no flag, no escrow, the mock wallet, a failed stake
  // that already fell back to PTS-only, or a duel nobody backed. In every one of
  // those the screen is exactly the screen it was before staking existed.
  if (!stake || !matchKey || stake.phase !== "staked") return null;

  const takes = usdcText(payoutOf(stake.amount));
  const each = usdcText(stake.amount);
  const done = stake.claimPhase === "claimed";
  const busy = stake.claimPhase === "signing" || stake.claimPhase === "relaying";
  const tone = done ? C.green : meWins ? C.accent : C.dim;

  return (
    <div
      data-side-bet-claim={stake.claimPhase}
      style={sx(
        `margin-top:18px;padding:16px 18px;border:1px solid ${tone}4d;border-radius:12px;` +
          `background:${C.card}`,
      )}
    >
      <div style={sx("display:flex;align-items:center;gap:10px;flex-wrap:wrap")}>
        <span style={sx(`font:700 9px/1 ${MONO};letter-spacing:.16em;color:${tone}`)}>
          SIDE BET · ON-CHAIN
        </span>
        <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>
          SEPARATE FROM THE PTS POOL
        </span>
      </div>

      {/* No slip was pinned, so no verdict can be derived: the referee refused
          the lock, or the room never reached one. The escrow still holds both
          stakes and still returns them on the timeout, and there is nothing to
          claim — a CLAIM button here would be a promise this app cannot keep.
          Only the OPENER can know this: the seat binding makes `a` the seat that
          locks, so a joiner has no local evidence either way and is shown the
          ordinary claim copy. */}
      {stake.seat === "a" && !stake.locked ? (
        <div
          data-claim-unlocked={stake.lockError?.code ?? "none"}
          style={sx(`margin-top:11px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}
        >
          {stake.lockError
            ? `${stake.lockError.message} ${stake.lockError.recovery}`
            : `This duel's slip was never committed to the referee, so no verdict can be signed
               for it. Both stakes refund automatically after ${REFUND_TIMEOUT_HOURS} hours — the escrow's
               timeout needs no server and no cooperation from anyone.`}
        </div>
      ) : meWins ? (
        <>
          <div style={sx(`margin-top:11px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>
            You won the duel, so the escrow owes you {takes} — the {each} you each staked, less the
            4% rake. Relaying the verdict is permissionless, so this browser sends it; the server
            only signs it.
          </div>
          {!done && (
            <button
              data-claim
              disabled={busy}
              onClick={() => {
                sfx("ui.click.primary");
                stake.claim(matchKey);
              }}
              style={sx(
                `margin-top:13px;height:44px;padding:0 20px;border:none;border-radius:10px;` +
                  `font:700 13.5px/1 ${SANS};` +
                  (busy
                    ? `background:${C.border};color:${C.dim};cursor:progress`
                    : `background:${C.accent};color:${C.bg};cursor:pointer`),
              )}
            >
              {stake.claimPhase === "signing"
                ? "Asking the referee…"
                : stake.claimPhase === "relaying"
                  ? "Relaying the verdict…"
                  : `CLAIM ${takes}`}
            </button>
          )}
          <div style={sx(`margin-top:10px;font:500 10.5px/1.55 ${MONO};color:${C.amber}`)}>
            Claim within {REFUND_TIMEOUT_HOURS} hours. After that either player can pull their own
            stake back, and a refund closes settlement for good — you would get your {each} back and
            nothing more.
          </div>
        </>
      ) : (
        <div style={sx(`margin-top:11px;font:400 12px/1.6 ${SANS};color:${C.textSoft};text-wrap:pretty`)}>
          The duel went the other way, so your {each} side bet is the winner's to claim. If nobody
          relays a verdict, the stake refunds automatically after {REFUND_TIMEOUT_HOURS} hours —
          the escrow's timeout needs no server and no cooperation from anyone.
        </div>
      )}

      {done && stake.claimHash && (
        <div style={sx("margin-top:12px")}>
          <a
            data-claim-tx
            href={`${BASESCAN_TX}${stake.claimHash}`}
            target="_blank"
            rel="noreferrer noopener"
            style={sx(`font:700 11px/1 ${MONO};letter-spacing:.1em;color:${C.green}`)}
          >
            PAID · VIEW ON BASESCAN ↗
          </a>
        </div>
      )}

      {stake.claimPhase === "failed" && stake.claimError && (
        <div
          data-claim-error={stake.claimError.code}
          style={sx(`margin-top:12px;font:400 10.5px/1.6 ${MONO};color:${C.amber};text-wrap:pretty`)}
        >
          {stake.claimError.message}{" "}
          {stake.claimError.code === "ATTESTOR_DOWN"
            ? `The referee is unreachable — stake refunds automatically after ${REFUND_TIMEOUT_HOURS} hours.`
            : stake.claimError.recovery}
        </div>
      )}

      {stake.refundable && (
        <button
          data-refund
          onClick={() => {
            sfx("ui.click.primary");
            stake.refund();
          }}
          style={sx(
            `margin-top:12px;height:36px;padding:0 14px;border:1px solid ${C.borderMid};` +
              `border-radius:8px;background:transparent;color:${C.muted};font:500 12px/1 ${SANS};cursor:pointer`,
          )}
        >
          Refund my {each}
        </button>
      )}
    </div>
  );
}
