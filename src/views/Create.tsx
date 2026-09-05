import { useEffect, useState } from "react";
import {
  MAX_DURATION_MINUTES,
  MAX_STAKE_USDC,
  MIN_DURATION_MINUTES,
  MIN_STAKE_USDC,
} from "../data/stake.ts";
import { sx } from "../lib/sx.ts";
import type { BattleState } from "../state/battle.ts";
import { NOTIONAL_STAKE_COPY, stakeBasisLine, type DuelCustody } from "./BoxBuilder.tsx";
import { C, MONO, SANS } from "../theme.ts";
import type { GameMode } from "../types.ts";

const CARD =
  "border:1px solid #27272a;border-radius:14px;background:linear-gradient(180deg,#101012,#0c0c0e)";
const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;
const NOTE = `margin-top:8px;font:400 10.5px/1.4 ${MONO};color:${C.faint}`;
const STEP_BTN =
  `width:34px;height:34px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
  `color:${C.text};font:700 16px/1 ${MONO};cursor:pointer`;

/**
 * The mode's name on the setup screen, keyed by `GameMode`.
 *
 * `"PARLAY · RFQ"` used to live here, and it is the second half of plan 7 §7's
 * caught sentence: the screen is not an RFQ, RFQ is one of the two paths a
 * drawn box takes to execution. Kept as a map rather than inlined because it is
 * keyed by the mode a room was created in, and that is a value, not a constant.
 */
const MODE_TITLE: Record<GameMode, string> = { box: "DRAW A BOX" };

/**
 * The invite link, shown only after the arena exists.
 *
 * Deliberately not rendered before the button is pressed: a link that exists
 * before there is a room behind it is a link that 404s when a friend clicks it.
 */
function Invite({ url, onOpenLobby }: { url: string; onOpenLobby: () => void }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div
      style={sx(
        `${CARD};border-color:rgba(200,255,0,.3);background:rgba(200,255,0,.05);` +
          "padding:18px 20px;display:flex;flex-direction:column;gap:12px",
      )}
    >
      <span style={sx(LABEL)}>INVITE LINK · ONE OPPONENT</span>
      <div style={sx("display:flex;gap:10px;align-items:center;flex-wrap:wrap")}>
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          style={sx(
            `flex:1;min-width:240px;height:36px;padding:0 12px;border:1px solid ${C.border};` +
              `border-radius:8px;background:#0a0a0c;color:${C.textSoft};font:500 11.5px/1 ${MONO}`,
          )}
        />
        <button
          onClick={() => {
            navigator.clipboard.writeText(url).then(
              () => {
                setCopied(true);
                setCopyFailed(false);
              },
              // Clipboard access can be refused on an insecure origin or by
              // permission. The input stays selectable, so say so.
              () => setCopyFailed(true),
            );
          }}
          style={sx(
            `height:36px;padding:0 15px;border-radius:8px;cursor:pointer;font:700 11px/1 ${SANS};` +
              `border:1px solid ${copied ? C.green : C.accent};` +
              `background:${copied ? C.green : C.accent};color:${C.bg}`,
          )}
        >
          {copied ? "Copied" : "Copy"}
        </button>
        <button
          onClick={onOpenLobby}
          style={sx(
            `height:36px;padding:0 15px;border-radius:8px;cursor:pointer;font:700 11px/1 ${SANS};` +
              `border:1px solid ${C.borderMid};background:transparent;color:${C.text}`,
          )}
        >
          Open lobby
        </button>
      </div>
      <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
        {copyFailed
          ? "Clipboard was refused — click the link to select it, then copy by hand."
          : "Whoever opens this connects their own wallet and takes the challenger seat."}
      </span>
    </div>
  );
}

interface CreateProps {
  state: BattleState;
  entryLabel: string;
  /**
   * Both stakes, gross — `usdc(potOf(stake))`. The figure under **TWICE THE
   * STAKE**, and the one the custody subtitle names as what goes in.
   */
  potLabel: string;
  /**
   * The pot less the escrow's 4% rake — `usdc(winnerTakesUsdc(stake))`. The
   * figure under **WINNER TAKES**, and nowhere else.
   *
   * Two props rather than one `prizeLabel`, because this panel prints one
   * number under two labels that make two different claims. See
   * `state/battle.ts`'s `derived` for the money bug that split them.
   */
  payoutLabel: string;
  /** The invite link, once the arena exists. `null` before that. */
  inviteUrl: string | null;
  creating: boolean;
  createError: string | null;
  walletConnected: boolean;
  /**
   * What would actually hold the two stakes this screen is setting — `null`,
   * the default, when nothing would.
   *
   * The same seam `BoxBuilder` carries, for the same reason and with the same
   * default: see {@link DuelCustody}.
   */
  custody?: DuelCustody | null;
  onBack: () => void;
  onStakeInput: (raw: string) => void;
  onStakeBlur: () => void;
  onStakeUp: () => void;
  onStakeDown: () => void;
  onLobbyName: (name: string) => void;
  onDuration: (minutes: number) => void;
  onCreateArena: () => void;
  onOpenLobby: () => void;
}

/** Arena setup: stake, duration, name. Four fields, then a link. */
export function Create(p: CreateProps) {
  const { state } = p;
  const custody = p.custody ?? null;

  return (
    <div style={sx("padding:26px 28px;max-width:760px;margin:0 auto;display:grid;gap:14px")}>
      <div style={sx("display:flex;align-items:center;gap:14px")}>
        <button
          onClick={p.onBack}
          style={sx(
            `height:32px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;` +
              `background:transparent;color:${C.text};font:700 11px/1 ${SANS};cursor:pointer`,
          )}
        >
          ← Arena
        </button>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Create duel</h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;padding:6px 8px;border-radius:6px;` +
              `color:${C.accent};border:1px solid rgba(200,255,0,.35);background:rgba(200,255,0,.1)`,
          )}
        >
          {MODE_TITLE[state.mode]}
        </span>
      </div>

      <div style={sx(`${CARD};display:grid;grid-template-columns:1fr 1fr`)}>
        <div style={sx(`padding:20px;border-right:1px solid ${C.border}`)}>
          <div style={sx(LABEL)}>STAKE PER PLAYER (USDC)</div>
          <div style={sx("display:flex;align-items:center;gap:10px;margin-top:14px")}>
            <button onClick={p.onStakeDown} style={sx(STEP_BTN)}>
              −
            </button>
            <div
              style={sx(
                `display:flex;align-items:baseline;gap:8px;padding:6px 10px;` +
                  `border:1px solid ${C.border};border-radius:9px;background:#0a0a0c`,
              )}
            >
              <input
                type="text"
                inputMode="decimal"
                value={state.stakeText}
                onChange={(e) => p.onStakeInput(e.target.value)}
                onBlur={p.onStakeBlur}
                style={sx(
                  `width:104px;border:none;outline:none;background:transparent;color:${C.accent};` +
                    `font:700 28px/1.1 ${MONO};letter-spacing:-.02em;padding:0`,
                )}
              />
              <span style={sx(`font:700 15px/1 ${MONO};color:${C.dim}`)}>USDC</span>
            </div>
            <button onClick={p.onStakeUp} style={sx(STEP_BTN)}>
              +
            </button>
          </div>
          <div style={sx(`margin-top:12px;font:400 11.5px/1.55 ${SANS};color:${C.muted}`)}>
            {MIN_STAKE_USDC.toFixed(2)} to {MAX_STAKE_USDC.toLocaleString()} USDC. The stake locks
            when the arena exists.
          </div>
        </div>

        {/* The figure is real arithmetic — twice the number in the field beside
            it — and it stays. What went is the claim about what happens to it.

            This panel used to be headed WINNER TAKES and footed "Both stakes —
            $10.00 from each player. Settled in USDC." Nothing settles: the
            arena is not routed through `useDuelStake`, and `DuelEscrow` is
            written and reviewed but not deployed. TWICE THE STAKE is the same
            number with only the arithmetic asserted.

            **Two labels, two figures.** The number was the same under both for
            one more commit than it should have been. `TWICE THE STAKE` is a
            claim about multiplication and `potLabel` is that multiplication;
            `WINNER TAKES` is a claim about a transfer, and the transfer
            `DuelEscrow.settle` makes is the pot less its 4% rake — 1.92× the
            stake, which is `payoutLabel`. Printing the pot under WINNER TAKES
            overstated the payout by 4%; printing the payout under TWICE THE
            STAKE would understate the arithmetic by the same 4%. Neither figure
            is wrong, and neither is right under the other's label. */}
        <div style={sx("padding:20px")}>
          <div style={sx(LABEL)}>{custody ? "WINNER TAKES" : "TWICE THE STAKE"}</div>
          <div style={sx(`margin-top:14px;font:700 30px/1 ${MONO};letter-spacing:-.02em`)}>
            {custody ? p.payoutLabel : p.potLabel}
          </div>
          {/* "Both stakes" is a sentence about the **pot**, so the pot is the
              figure it names — and once the headline above is the payout, the
              gap between the two is on screen and has to be accounted for in
              the same breath rather than left as an unexplained 80 cents. The
              rake is named here and only here on this screen; `Room.tsx` says
              it the same way over the on-chain side bet. */}
          <div style={sx(`margin-top:12px;font:400 11.5px/1.55 ${SANS};color:${C.muted}`)}>
            {custody
              ? `Both stakes — ${p.entryLabel} from each player, ${p.potLabel} in the pot. ` +
                `The winner takes that less the escrow's 4% rake. Settled in USDC.`
              : stakeBasisLine(state.stakeUsdc, null)}
          </div>
          {custody === null && (
            <div
              data-role="notional-stake"
              style={sx(
                `margin-top:10px;font:400 10.5px/1.5 ${SANS};color:${C.amber};text-wrap:pretty`,
              )}
            >
              {NOTIONAL_STAKE_COPY}
            </div>
          )}
        </div>
      </div>

      <div style={sx(`${CARD};display:grid;grid-template-columns:1fr 1fr`)}>
        <div style={sx(`padding:18px 20px;border-right:1px solid ${C.border}`)}>
          <div style={sx(LABEL)}>DUEL NAME</div>
          <input
            type="text"
            value={state.lobbyName}
            onChange={(e) => p.onLobbyName(e.target.value)}
            placeholder="Room #4471"
            style={sx(
              `width:100%;height:38px;margin-top:12px;padding:0 12px;border:1px solid ${C.border};` +
                `border-radius:9px;background:#0a0a0c;color:${C.text};font:700 14px/1 ${SANS};outline:none`,
            )}
          />
        </div>
        <div style={sx("padding:18px 20px")}>
          <div style={sx(LABEL)}>DURATION (MINUTES)</div>
          <div style={sx("display:flex;gap:8px;margin-top:12px;align-items:center")}>
            <input
              type="number"
              min={MIN_DURATION_MINUTES}
              max={MAX_DURATION_MINUTES}
              step={1}
              value={state.durationMinutes}
              onChange={(e) => p.onDuration(Number.parseInt(e.target.value, 10))}
              style={sx(
                `width:96px;height:38px;padding:0 10px;border:1px solid ${C.border};` +
                  `border-radius:9px;background:#0a0a0c;color:${C.accent};` +
                  `font:700 18px/1 ${MONO};outline:none`,
              )}
            />
            <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>MIN</span>
          </div>
          <div style={sx(NOTE)}>
            {state.durationMinutes === 1 ? "1 minute duel" : `${state.durationMinutes} minute duel`}
          </div>
        </div>
      </div>

      {p.createError && (
        <div
          style={sx(
            `${CARD};border-color:rgba(248,113,113,.4);padding:14px 18px;` +
              `font:500 12px/1.4 ${SANS};color:${C.red}`,
          )}
        >
          {p.createError}
        </div>
      )}

      <div style={sx("display:flex;align-items:center;gap:14px")}>
        <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted};flex:1`)}>
          {p.walletConnected
            ? "Creating the arena mints one invite link for one opponent."
            : "Connect a wallet — your address is your seat at the table."}
        </span>
        <button
          onClick={p.onCreateArena}
          disabled={p.creating || !p.walletConnected}
          style={sx(
            `height:42px;padding:0 20px;border:none;border-radius:9px;background:${C.accent};` +
              `color:${C.bg};font:700 13px/1 ${SANS};cursor:pointer;white-space:nowrap` +
              (p.creating || !p.walletConnected ? ";opacity:.45;cursor:not-allowed" : ""),
          )}
        >
          {/* The amount used to ride on this label — "Create arena & link ·
              $10.00" — which is how a price on a button reads: press it and you
              are charged. Pressing it writes a row in the room store and mints
              an invite link. Nothing is charged, so nothing is priced here. */}
          {p.creating
            ? "Creating…"
            : custody
              ? `Create arena & link · ${p.entryLabel}`
              : "Create arena & link"}
        </button>
      </div>

      {p.inviteUrl && <Invite url={p.inviteUrl} onOpenLobby={p.onOpenLobby} />}
    </div>
  );
}
