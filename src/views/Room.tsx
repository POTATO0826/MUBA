import { useEffect, useState } from "react";
import type { RoomView } from "../data/room.ts";
import { shortAddress } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import type { Room } from "../state/room.ts";
import { C, MONO, SANS, avatarStyle } from "../theme.ts";

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
      <div style={sx(avatarStyle(address ? tone : "#1a1a1d", 40))}>
        {address ? address.slice(2, 4).toUpperCase() : "··"}
      </div>
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
  onEnterDraft: () => void;
}

export function RoomLobby({ room, state, walletConnected, onEnterDraft }: RoomLobbyProps) {
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
        <div style={sx("flex:1")} />
        <span style={sx(LABEL)}>POOL</span>
        <span style={sx(`font:700 18px/1 ${MONO};color:${C.accent}`)}>
          {room.prize.toFixed(2)} ETH
        </span>
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
          {bystander && (
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

          {started && (
            <button onClick={onEnterDraft} style={sx(BTN(C.green, true))}>
              Enter draft
            </button>
          )}

          <div style={sx("flex:1")} />
          <button onClick={state.leave} style={sx(BTN(C.borderMid, false))}>
            Leave
          </button>
        </div>

        <div style={sx(`${CARD};display:flex;flex-direction:column;gap:8px`)}>
          <span style={sx(LABEL)}>SHARED TAPE</span>
          <span style={sx(`font:500 12px/1.5 ${SANS};color:${C.muted}`)}>
            Both players run seed{" "}
            <span style={sx(`font:700 12px/1 ${MONO};color:${C.accent}`)}>{room.seed}</span>, so the
            price walk is the same walk on both screens.{" "}
            {room.readyBothAt
              ? `Agreed start ${new Date(room.readyBothAt).toLocaleTimeString()}.`
              : "The start instant is fixed when the second player reports ready."}
          </span>
        </div>
      </div>
    </div>
  );
}
