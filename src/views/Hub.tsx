import { PlayerMark } from "../components/PlayerMark.tsx";
import type { RoomView } from "../data/room.ts";
import { poolOf, usdc } from "../data/stake.ts";
import { addressInitials, shortAddress, type WalletIdentity } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { GameMode } from "../types.ts";

const CARD =
  "border:1px solid #27272a;border-radius:14px;background:linear-gradient(180deg,#101012,#0c0c0e)";
const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;
const BTN =
  `height:32px;padding:0 14px;border-radius:8px;cursor:pointer;font:700 11px/1 ${SANS};` +
  `border:1px solid ${C.borderMid};background:transparent;color:${C.text}`;

/**
 * The mode, as the hub presents it.
 *
 * One entry. It was two — `PARLAY` ("Build a multi-leg RFQ on one asset") and
 * `FIND A DIFFERENCE` — and plan 7 §8 step 6 retires both: the box arena is
 * what they were reaching for, and §7 is explicit that the blurb above is the
 * sentence that gets you caught. A screen is not an RFQ. RFQ is one of the two
 * ways a drawn box gets executed, and the other one — a zone already resting on
 * the OptionBook — sends no quote request at all.
 *
 * Still an array of one rather than a single object, because the shape is what
 * the grid below and `ModeCard` read, and a second mode should cost a row here
 * and nothing else.
 */
const MODES: readonly {
  key: GameMode;
  title: string;
  kicker: string;
  blurb: string;
  tone: string;
}[] = [
  {
    key: "box",
    title: "DRAW A BOX",
    kicker: "ENTER ARENA",
    blurb:
      "Draw a price band and an expiry on the chart — the box is the option · set stake · invite your opponent",
    tone: C.accent,
  },
];

function ModeCard({
  mode,
  onEnter,
  disabled,
}: {
  mode: (typeof MODES)[number];
  onEnter: () => void;
  disabled: boolean;
}) {
  return (
    <button
      onClick={onEnter}
      disabled={disabled}
      style={sx(
        `${CARD};border-color:${mode.tone}55;padding:26px 20px;text-align:center;cursor:pointer;` +
          `display:flex;flex-direction:column;gap:8px;align-items:center;width:100%;` +
          `box-shadow:0 0 28px ${mode.tone}14` +
          (disabled ? ";opacity:.45;cursor:not-allowed" : ""),
      )}
    >
      <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.28em;color:${mode.tone}`)}>
        {mode.kicker}
      </span>
      <span
        style={sx(
          `font:700 30px/1.05 ${SANS};letter-spacing:.02em;color:${mode.tone};text-shadow:0 0 22px ${mode.tone}55`,
        )}
      >
        {mode.title}
      </span>
      <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted};max-width:38ch`)}>
        {mode.blurb}
      </span>
    </button>
  );
}

function DuelRow({
  room,
  address,
  onOpen,
}: {
  room: RoomView;
  address: string | null;
  onOpen: (id: string) => void;
}) {
  const me = address?.toLowerCase() ?? "";
  const other = room.host === me ? room.guest : room.host;
  const state = !room.guest
    ? "Waiting for opponent"
    : room.ready[0] && room.ready[1]
      ? "Both ready"
      : "Lobby";

  return (
    <div
      style={sx(
        `${CARD};padding:14px 16px;display:flex;align-items:center;gap:12px;border-radius:10px`,
      )}
    >
      <div style={sx("display:flex;flex-direction:column;gap:5px;min-width:0")}>
        <span style={sx(`font:700 12px/1 ${MONO};color:${C.text}`)}>
          {shortAddress(room.host)} vs {other ? shortAddress(other) : "—"}
        </span>
        <span style={sx(`font:400 10.5px/1 ${MONO};color:${C.dim}`)}>
          {usdc(poolOf(room.stakeUsdc))} pot · {room.durationMinutes} min · {state}
        </span>
      </div>
      <div style={sx("flex:1")} />
      <button onClick={() => onOpen(room.id)} style={sx(BTN)}>
        Open duel
      </button>
    </div>
  );
}

interface HubProps {
  identity: WalletIdentity;
  rooms: readonly RoomView[];
  onEnterMode: (mode: GameMode) => void;
  onOpenRoom: (id: string) => void;
  onConnect: () => void;
  onDisconnect: () => void;
  onRefresh: () => void;
}

/**
 * The screen a player lands on after connect.
 *
 * Identity, then the mode, then the duels already in flight. No draft, no tape,
 * no case library — a player should reach a game in one click.
 */
export function Hub({
  identity,
  rooms,
  onEnterMode,
  onOpenRoom,
  onConnect,
  onDisconnect,
  onRefresh,
}: HubProps) {
  const connected = Boolean(identity.address);

  return (
    <div style={sx("padding:26px 28px;max-width:940px;margin:0 auto;display:grid;gap:16px")}>
      <div style={sx(`${CARD};padding:16px 18px;display:flex;align-items:center;gap:14px`)}>
        {identity.address ? (
          <PlayerMark
            name={identity.address}
            initials={addressInitials(identity.address)}
            bg={C.accent}
            size={40}
          />
        ) : (
          <span
            aria-label="Wallet disconnected"
            style={sx(
              `display:grid;place-items:center;flex:none;width:40px;height:40px;border-radius:4px;` +
                `border:1px solid ${C.border};background:${C.panelAlt};color:${C.faint};font:700 12px/1 ${MONO}`,
            )}
          >
            ··
          </span>
        )}
        <div style={sx("display:flex;flex-direction:column;gap:5px;min-width:0")}>
          <span style={sx(`font:700 14px/1 ${SANS};letter-spacing:.02em`)}>
            {identity.address ? shortAddress(identity.address) : "NOT CONNECTED"}
          </span>
          <span style={sx(`font:400 10.5px/1 ${MONO};color:${C.dim}`)}>
            {identity.wrongNetwork
              ? "wrong network · switch to Base"
              : connected
                ? `base 8453 · ${identity.walletName ?? "wallet"}`
                : "connect a wallet to play"}
          </span>
        </div>
        <div style={sx("flex:1")} />
        <button onClick={connected ? onDisconnect : onConnect} style={sx(BTN)}>
          {connected ? "Log out" : "Connect"}
        </button>
      </div>

      {/* One column per mode, centred. With a single entry a `1fr 1fr` grid
          left a half-width card against an empty half, which reads as a mode
          that failed to load rather than as the only one there is. */}
      <div
        style={sx(
          `display:grid;grid-template-columns:repeat(${MODES.length},minmax(0,1fr));gap:16px;` +
            `width:100%;max-width:${MODES.length === 1 ? "520px" : "none"};margin:0 auto`,
        )}
      >
        {MODES.map((m) => (
          <ModeCard
            key={m.key}
            mode={m}
            disabled={!connected}
            onEnter={() => onEnterMode(m.key)}
          />
        ))}
      </div>

      {!connected && (
        <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted};text-align:center`)}>
          The arena stakes real USDC on Base. Connect a wallet to enter.
        </span>
      )}

      <div style={sx(`${CARD};padding:18px 20px;display:flex;flex-direction:column;gap:12px`)}>
        <div style={sx("display:flex;align-items:center;gap:12px")}>
          <span style={sx(LABEL)}>ACTIVE DUELS</span>
          <div style={sx("flex:1")} />
          <button onClick={onRefresh} style={sx(BTN)}>
            Refresh
          </button>
        </div>
        {rooms.length === 0 ? (
          <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.faint}`)}>
            No duels yet. Enter a mode to open one.
          </span>
        ) : (
          <div style={sx("display:grid;gap:8px")}>
            {rooms.map((r) => (
              <DuelRow key={r.id} room={r} address={identity.address} onOpen={onOpenRoom} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
