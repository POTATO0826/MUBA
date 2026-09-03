import { useCallback, useEffect, useState } from "react";
import type { MarketSource } from "./data/market.ts";
import type { RoomView } from "./data/room.ts";
import type { WalletSource } from "./data/wallet.ts";
import { sx } from "./lib/sx.ts";
import { useBattle } from "./state/battle.ts";
import { useRoom } from "./state/room.ts";
import { Footer } from "./ui/Footer.tsx";
import { Header } from "./ui/Header.tsx";
import { MockWalletBanner } from "./ui/MockWalletBanner.tsx";
import { Create } from "./views/Create.tsx";
import { Hub } from "./views/Hub.tsx";
import { ParlayRfq } from "./views/ParlayRfq.tsx";
import { RoomLobby } from "./views/Room.tsx";
import { SpotDiff } from "./views/SpotDiff.tsx";
import { useMockWallet } from "./wallet/mock.ts";

const PAGE =
  "min-height:100vh;background:radial-gradient(1200px 600px at 78% -10%, rgba(200,255,0,.07), transparent 60%)," +
  "radial-gradient(900px 500px at 8% 0%, rgba(99,102,241,.08), transparent 55%),#09090b";

/**
 * The whole flow.
 *
 *   hub -> create -> room lobby -> parlay | spotdiff
 *
 * A player connects, picks one of two modes, sets a stake, and sends a link.
 * The opponent opens the link, connects, and takes the seat. Both lock a pick,
 * and the picks reveal together.
 */
export function App({
  source,
  wallet,
  marketError = null,
}: {
  source: MarketSource;
  /**
   * Omit to run on the mock wallet. `src/client.tsx` always supplies one via
   * `WalletBoundary`; the default keeps the app mountable on its own in the
   * headless tests, where AppKit cannot initialise.
   */
  wallet?: WalletSource;
  /** Set when the live Thetanuts book could not be read and `source` is the
   *  mock. Surfaced so the screen never passes fixtures off as live data. */
  marketError?: string | null;
}) {
  const fallback = useMockWallet();
  const active = wallet ?? fallback;
  const { identity } = active;

  const { state, derived, actions } = useBattle();
  const roomState = useRoom(identity.address ?? null);

  /**
   * Whether the room lobby covers the tab underneath.
   *
   * Creation deliberately does not set this. The host stays on the builder and
   * gets the invite link inline, because the useful next action is to copy the
   * link. Arrival on a `/room/<id>` link does set it, because for a guest the
   * lobby is the page they asked for.
   */
  const [lobbyOpen, setLobbyOpen] = useState(false);
  const [entered, setEntered] = useState(false);
  const showRoom = roomState.room !== null && (lobbyOpen || roomState.arrivedFromLink) && !entered;

  /** Duels this address already sits in. The hub lists them. */
  const [myRooms, setMyRooms] = useState<readonly RoomView[]>([]);
  const refreshRooms = useCallback(() => {
    if (!identity.address) {
      setMyRooms([]);
      return;
    }
    fetch(`/api/rooms/mine?address=${identity.address}`)
      .then((r) => r.json())
      .then((d: { rooms?: RoomView[] }) => setMyRooms(d.rooms ?? []))
      .catch(() => {
        /* the hub still renders without the list */
      });
  }, [identity.address]);

  // Keyed on the room id, not the room object: the lobby poll hands back a new
  // object every second, and an object dependency would fire a fresh
  // `/api/rooms/mine` request on every one of them.
  const roomId = roomState.room?.id ?? null;
  useEffect(refreshRooms, [refreshRooms, roomId]);

  const createArena = useCallback(() => {
    if (!identity.address) return;
    setEntered(false);
    setLobbyOpen(false);
    void roomState.create(state.stakeUsdc, state.durationMinutes, state.lobbyName, state.mode);
  }, [
    identity.address,
    roomState,
    state.stakeUsdc,
    state.durationMinutes,
    state.lobbyName,
    state.mode,
  ]);

  /**
   * Leave the lobby for the mode board. The room's own mode outranks the
   * builder's, so a guest lands in the game the host chose.
   */
  const enterDuel = useCallback(() => {
    setEntered(true);
    actions.go(roomState.room?.mode ?? state.mode)();
  }, [actions, roomState.room, state.mode]);

  const backToHub = useCallback(() => {
    setEntered(false);
    setLobbyOpen(false);
    roomState.leave();
    actions.go("hub")();
  }, [actions, roomState]);

  const lockPick = useCallback((pick: string) => void roomState.pick(pick), [roomState]);

  const board = roomState.room;
  const seat = roomState.seat;

  return (
    <div style={sx(PAGE)}>
      <Header
        tab={state.tab}
        wallet={identity}
        onNavigate={(t) => actions.go(t)()}
        onConnect={() => void active.connect()}
        onManage={() => void active.openAccount()}
        onSwitchNetwork={() => void active.switchToBase()}
      />

      {showRoom && board && (
        <RoomLobby
          room={board}
          state={roomState}
          walletConnected={identity.connected}
          onEnterDuel={enterDuel}
        />
      )}

      {!showRoom && state.tab === "hub" && (
        <Hub
          identity={identity}
          rooms={myRooms}
          onEnterMode={actions.enterMode}
          onOpenRoom={(id) => {
            setEntered(false);
            setLobbyOpen(true);
            void roomState.open(id);
          }}
          onConnect={() => void active.connect()}
          onDisconnect={() => void active.disconnect()}
          onRefresh={refreshRooms}
        />
      )}

      {!showRoom && state.tab === "create" && (
        <Create
          state={state}
          entryLabel={derived.entryLabel}
          prizeLabel={derived.prizeLabel}
          inviteUrl={roomState.inviteUrl}
          creating={roomState.busy}
          createError={roomState.error}
          walletConnected={identity.connected}
          onBack={backToHub}
          onStakeInput={actions.onStakeInput}
          onStakeBlur={actions.onStakeBlur}
          onStakeUp={actions.stakeUp}
          onStakeDown={actions.stakeDown}
          onLobbyName={actions.setLobbyName}
          onDuration={actions.setDuration}
          onCreateArena={createArena}
          onOpenLobby={() => setLobbyOpen(true)}
        />
      )}

      {!showRoom && state.tab === "parlay" && (
        <ParlayRfq
          source={source}
          room={board}
          seat={seat}
          busy={roomState.busy}
          onLock={lockPick}
          onBack={backToHub}
        />
      )}

      {!showRoom && state.tab === "spotdiff" && (
        <SpotDiff
          source={source}
          room={board}
          seat={seat}
          address={identity.address}
          busy={roomState.busy}
          onLock={lockPick}
          onBack={backToHub}
        />
      )}

      {active.id === "mock" && <MockWalletBanner />}

      <Footer source={source} marketError={marketError} />
    </div>
  );
}
