import { PlayerMark } from "../components/PlayerMark.tsx";
import { useEffect, useState } from "react";
import type { RoomView } from "../data/room.ts";
import { poolOf, usdc } from "../data/stake.ts";
import { shortAddress } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import type { Room } from "../state/room.ts";
import { STAKES_OFF_COPY, stakeBasisLine, type DuelCustody } from "./BoxBuilder.tsx";
import { C, MONO, SANS } from "../theme.ts";

const CARD =
  "border:1px solid #27272a;border-radius:14px;background:linear-gradient(180deg,#101012,#0c0c0e);padding:20px";

const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;

const BTN = (tone: string, filled: boolean): string =>
  `height:38px;padding:0 18px;border-radius:10px;cursor:pointer;font:700 12px/1 ${SANS};` +
  (filled
    ? `background:${tone};color:${C.bg};border:1px solid ${tone}`
    : `background:transparent;color:${C.text};border:1px solid ${C.borderMid}`);

const OFF = ";opacity:.45;cursor:not-allowed";

/** One side of the table. Empty until the seat is claimed. */
function Seat({
  address,
  label,
  ready,
  you,
}: {
  address: string | null;
  label: string;
  ready: boolean;
  you: boolean;
}) {
  const tone = ready ? C.green : address ? C.accent : C.faint;
  return (
    <div
      style={sx(
        `${CARD};display:flex;align-items:center;gap:14px;` +
          `border-color:${ready ? "rgba(74,222,128,.35)" : "#27272a"}`,
      )}
    >
      {address ? (
        <PlayerMark
          name={address}
          initials={address.slice(2, 4).toUpperCase()}
          bg={tone}
          size={40}
        />
      ) : (
        <span
          aria-label={`${label} seat empty`}
          style={sx(
            `display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:4px;` +
              `border:1px solid ${C.border};background:${C.panelAlt};color:${C.faint};font:700 12px/1 ${MONO}`,
          )}
        >
          ··
        </span>
      )}
      <div style={sx("display:flex;flex-direction:column;gap:6px;min-width:0")}>
        <span style={sx(LABEL)}>
          {label}
          {you ? " · YOU" : ""}
        </span>
        <span style={sx(`font:700 15px/1 ${MONO};color:${address ? C.text : C.faint}`)}>
          {address ? shortAddress(address) : "waiting…"}
        </span>
      </div>
      <div style={sx("flex:1")} />
      {address && (
        <span
          style={sx(
            `font:700 9px/1 ${MONO};letter-spacing:.12em;padding:6px 9px;border-radius:6px;` +
              (ready
                ? `color:${C.green};border:1px solid rgba(74,222,128,.35);background:rgba(74,222,128,.12)`
                : `color:${C.dim};border:1px solid ${C.border}`),
          )}
        >
          {ready ? "READY" : "NOT READY"}
        </span>
      )}
    </div>
  );
}

/** The share link, with a copy button that reports back. */
function InviteLink({ room }: { room: RoomView }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // The server returns a path, not a URL — the origin is whatever the browser
  // reached us on, so this works on localhost, a LAN IP and a deploy alike.
  const url = `${window.location.origin}${room.joinPath}`;

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <div style={sx(`${CARD};display:flex;flex-direction:column;gap:12px`)}>
      <span style={sx(LABEL)}>INVITE LINK · SEND THIS TO YOUR OPPONENT</span>
      <div style={sx("display:flex;gap:10px;align-items:center")}>
        <input
          readOnly
          value={url}
          onFocus={(e) => e.currentTarget.select()}
          style={sx(
            `flex:1;min-width:0;height:38px;padding:0 12px;border:1px solid ${C.border};` +
              `border-radius:10px;background:#0a0a0c;color:${C.textSoft};font:500 12px/1 ${MONO}`,
          )}
        />
        <button
          onClick={() => {
            navigator.clipboard.writeText(url).then(
              () => {
                setCopied(true);
                setCopyFailed(false);
              },
              // Clipboard access can be refused — insecure origin, or the user
              // denied the permission. The input stays selectable, so say that
              // rather than looking like nothing happened.
              () => setCopyFailed(true),
            );
          }}
          style={sx(BTN(copied ? C.green : C.accent, true))}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {copyFailed && (
        <span style={sx(`font:500 11px/1.4 ${SANS};color:${C.amber}`)}>
          Clipboard was refused. Click the link to select it, then copy by hand.
        </span>
      )}
    </div>
  );
}

interface RoomLobbyProps {
  room: RoomView;
  state: Room;
  walletConnected: boolean;
  onEnterDuel: () => void;
  /**
   * What is actually holding this room's two stakes — `null`, the default, when
   * nothing is.
   *
   * The same seam `BoxBuilder` carries, for the same reason and with the same
   * default: see {@link DuelCustody}.
   */
  custody?: DuelCustody | null;
}

export function RoomLobby({
  room,
  state,
  walletConnected,
  onEnterDuel,
  custody = null,
}: RoomLobbyProps) {
  const { seat, started, error, busy } = state;
  const iAmReady = seat === "host" ? room.ready[0] : seat === "guest" ? room.ready[1] : false;
  const bystander = seat === null;
  const full = room.guest !== null;

  const joinBlocked = busy || !walletConnected || full;
  const readyBlocked = busy || iAmReady || !full;

  return (
    <div style={sx("padding:24px 28px;max-width:900px;margin:0 auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>
          {room.lobbyName}
        </h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;padding:6px 8px;border-radius:6px;` +
              (started
                ? `color:${C.green};border:1px solid rgba(74,222,128,.35);background:rgba(74,222,128,.12)`
                : `color:${C.blue};border:1px solid rgba(56,189,248,.35);background:rgba(56,189,248,.12)`),
          )}
        >
          {started ? "BOTH READY" : full ? "LOBBY · PICK READY" : "WAITING FOR OPPONENT"}
        </span>
        {/* The same line the duel strip prints, from the same helper, so the
            lobby and the board a player walks into cannot disagree about who
            holds the money. */}
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>
          {stakeBasisLine(room.stakeUsdc, custody).toUpperCase()} · {room.durationMinutes} MIN
        </span>
        <div style={sx("flex:1")} />
        {/* WINNER TAKES $20.00 stood here unconditionally. It is a claim about
            custody — a pot, held, paid to whoever wins — and it is now gated on
            the thing that would do the holding. */}
        {custody !== null && (
          <>
            <span style={sx(LABEL)}>WINNER TAKES</span>
            <span style={sx(`font:700 18px/1 ${MONO};color:${C.accent}`)}>
              {usdc(poolOf(room.stakeUsdc))}
            </span>
          </>
        )}
      </div>

      <div style={sx("display:grid;gap:14px")}>
        <div style={sx("display:grid;grid-template-columns:1fr 1fr;gap:14px")}>
          <Seat address={room.host} label="HOST" ready={room.ready[0]} you={seat === "host"} />
          <Seat
            address={room.guest}
            label="CHALLENGER"
            ready={room.ready[1]}
            you={seat === "guest"}
          />
        </div>

        {seat === "host" && !full && <InviteLink room={room} />}

        {error && (
          <div
            style={sx(
              `${CARD};border-color:rgba(248,113,113,.4);display:flex;align-items:center;gap:12px`,
            )}
          >
            <span style={sx(`font:500 12px/1.4 ${SANS};color:${C.red};flex:1`)}>{error}</span>
            <button onClick={state.dismissError} style={sx(BTN(C.red, false))}>
              Dismiss
            </button>
          </div>
        )}

        <div style={sx("display:flex;gap:10px;align-items:center")}>
          {bystander && !full && (
            <button
              onClick={() => void state.join()}
              disabled={joinBlocked}
              style={sx(BTN(C.accent, true) + (joinBlocked ? OFF : ""))}
            >
              {!walletConnected
                ? "Connect a wallet to join"
                : full
                  ? "Duel is full"
                  : busy
                    ? "Joining…"
                    : "Accept duel"}
            </button>
          )}

          {!bystander && !started && (
            <button
              onClick={() => void state.ready()}
              disabled={readyBlocked}
              style={sx(BTN(C.accent, !iAmReady) + (readyBlocked ? OFF : ""))}
            >
              {!full ? "Waiting for an opponent" : iAmReady ? "Ready — waiting" : "Ready up"}
            </button>
          )}

          {/* Only a seated player enters. A bystander who opens the link must
              not reach the board, and must not be offered a lock they cannot
              submit — the server would refuse it with NOT_A_PLAYER. */}
          {started && !bystander && (
            <button onClick={onEnterDuel} style={sx(BTN(C.green, true))}>
              Enter duel
            </button>
          )}

          {started && bystander && (
            <span style={sx(`font:500 11.5px/1.4 ${SANS};color:${C.muted}`)}>
              This duel is full. You are watching, not playing.
            </span>
          )}

          <div style={sx("flex:1")} />
          <button onClick={state.leave} style={sx(BTN(C.borderMid, false))}>
            Leave
          </button>
        </div>

        {/* Headed HOW THIS SETTLES, over a paragraph that describes how the duel
            *runs* — one book, blind picks, a simultaneous reveal. Nothing in it
            was ever about settlement, and nothing in this build settles, so the
            heading was the only untrue word in the panel. */}
        <div style={sx(`${CARD};display:flex;flex-direction:column;gap:8px`)}>
          <span style={sx(LABEL)}>HOW THIS DUEL RUNS</span>
          <span style={sx(`font:500 12px/1.5 ${SANS};color:${C.muted}`)}>
            Both players read the same live Thetanuts book on Base. Picks stay hidden until both
            sides lock, then reveal together.{" "}
            {room.readyBothAt
              ? `Agreed start ${new Date(room.readyBothAt).toLocaleTimeString()}.`
              : "The start instant is fixed when the second player reports ready."}
          </span>
          {custody === null && (
            <span
              data-role="notional-stake"
              style={sx(`font:400 11px/1.5 ${SANS};color:${C.amber};text-wrap:pretty`)}
            >
              {STAKES_OFF_COPY}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
