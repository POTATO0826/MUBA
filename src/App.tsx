import { useCallback, useMemo, useState } from "react";
import { useTilt } from "./components/useTilt.ts";
import type { MarketSource } from "./data/market.ts";
import { addressInitials, shortAddress, type WalletSource } from "./data/wallet.ts";
import { scoreOf, settle } from "./engine/match.ts";
import { TAPE_LEN } from "./engine/tape.ts";
import { sx } from "./lib/sx.ts";
import { useRoom } from "./state/room.ts";
import { useBattle, type PlayerIdentity } from "./state/battle.ts";
import { useMockWallet } from "./wallet/mock.ts";
import { AutoBanner } from "./ui/AutoBanner.tsx";
import { Footer } from "./ui/Footer.tsx";
import { Header } from "./ui/Header.tsx";
import { MockWalletBanner } from "./ui/MockWalletBanner.tsx";
import { Battles } from "./views/Battles.tsx";
import { Cases } from "./views/Cases.tsx";
import { Create } from "./views/Create.tsx";
import { Draft } from "./views/Draft.tsx";
import { Live } from "./views/Live.tsx";
import { Lobby } from "./views/Lobby.tsx";
import { Parlay } from "./views/Parlay.tsx";
import { ParlayLock } from "./views/ParlayLock.tsx";
import { Result } from "./views/Result.tsx";
import { RoomLobby } from "./views/Room.tsx";
import { Study } from "./views/Study.tsx";

const PAGE =
  "min-height:100vh;background:radial-gradient(1200px 600px at 78% -10%, rgba(200,255,0,.07), transparent 60%)," +
  "radial-gradient(900px 500px at 8% 0%, rgba(99,102,241,.08), transparent 55%),#09090b";

export function App({
  source,
  wallet,
}: {
  source: MarketSource;
  /**
   * Omit to run on the mock wallet. `src/client.tsx` always supplies one via
   * `WalletBoundary`; the default is what keeps `<App source={…} />` mountable
   * on its own in the headless tests, where AppKit cannot initialise.
   */
  wallet?: WalletSource;
}) {
  const fallback = useMockWallet();
  const active = wallet ?? fallback;
  const { identity } = active;

  /**
   * The connected wallet, rendered as a player.
   *
   * `meta` drops the design's placeholder bankroll once a real address is in
   * play — quoting a made-up 2.40 ETH under someone's actual address would be
   * a fabricated balance, so the line says what is actually known instead. A
   * real balance is a `useAppKitBalance()` call away when the stakes are wired.
   */
  const player = useMemo<PlayerIdentity | undefined>(
    () =>
      identity.address
        ? {
            name: shortAddress(identity.address),
            init: addressInitials(identity.address),
            meta: identity.wrongNetwork
              ? "wrong network · switch to Base"
              : `base · ${identity.walletName ?? "connected"}`,
          }
        : undefined,
    [identity.address, identity.walletName, identity.wrongNetwork],
  );

  const { state, derived, actions } = useBattle(player);
  useTilt();

  const roomState = useRoom(identity.address ?? null);

  /**
   * The room lobby pre-empts every screen while a room is open and the draft has
   * not been entered — including on a cold load of a `/room/<id>` share link,
   * where `useRoom` picks the id off the path before anything else renders.
   *
   * Kept as local state rather than another `Tab` so the match flow underneath
   * is untouched: leaving a room drops straight back to whatever tab was live.
   */
  const [draftEntered, setDraftEntered] = useState(false);
  const showRoom = roomState.room !== null && !draftEntered;

  const enterDraft = useCallback(() => {
    if (roomState.room) actions.setSeed(roomState.room.seed);
    setDraftEntered(true);
    actions.go("draft")();
  }, [roomState.room, actions]);

  /**
   * Publish the lobby.
   *
   * With a wallet connected this opens a real room and yields a share link. With
   * no wallet it falls through to the original local behaviour and drops straight
   * into the draft — solo and demo play predate rooms and should not start
   * requiring a server and an address to reach the board.
   */
  const publishRoom = useCallback(() => {
    if (!identity.address) {
      actions.publishLobby();
      return;
    }
    setDraftEntered(false);
    void roomState.create(state.prize, state.lobbyName);
  }, [identity.address, actions, roomState, state.prize, state.lobbyName]);

  // Settling reads the whole tape, not the played-to position, so the verdict is
  // stable however early the fight is abandoned.
  const verdict = useMemo(
    () =>
      settle(
        derived.myLegs,
        derived.oppLegs,
        derived.arena,
        derived.fightSalt,
        TAPE_LEN,
        derived.p1Name,
        derived.opponent,
      ),
    [derived],
  );

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

      {showRoom && roomState.room && (
        <RoomLobby
          room={roomState.room}
          state={roomState}
          walletConnected={identity.connected}
          onEnterDraft={enterDraft}
        />
      )}

      {!showRoom && state.tab === "lobby" && (
        <Lobby
          prize={state.prize}
          onCreateBattle={actions.go("draft")}
          onBrowseRewards={actions.go("cases")}
          onJoinRoom={actions.joinRoom}
          onSpectate={actions.runSpectate}
        />
      )}

      {!showRoom && state.tab === "battles" && (
        <Battles
          prize={state.prize}
          onJoinRoom={actions.joinRoom}
          onSpectate={actions.runSpectate}
          onRunDemo={actions.runDemo}
          onCreate={actions.go("create")}
        />
      )}

      {!showRoom && state.tab === "create" && (
        <Create
          state={state}
          activeCount={derived.universe.length}
          entryLabel={derived.entryLabel}
          prizeLabel={derived.prizeLabel}
          onBack={actions.go("battles")}
          onPrizeInput={actions.onPrizeInput}
          onPrizeBlur={actions.onPrizeBlur}
          onPrizeUp={actions.prizeUp}
          onPrizeDown={actions.prizeDown}
          onLobbyName={actions.setLobbyName}
          onMarket={actions.setMarket}
          onPicksUp={actions.picksUp}
          onPicksDown={actions.picksDown}
          onChartsUp={actions.chartsUp}
          onChartsDown={actions.chartsDown}
          onTapeSpeed={actions.setTapeSpeed}
          onToggleAsset={actions.toggleExcluded}
          onPublish={publishRoom}
        />
      )}

      {!showRoom && state.tab === "draft" && (
        <Draft
          lobbyName={state.lobbyName}
          prizeLabel={derived.prizeLabel}
          p1Name={derived.p1Name}
          p1Init={derived.p1Init}
          p1Meta={derived.p1Meta}
          opponent={derived.opponent}
          picks={state.picks}
          bans={state.bans}
          oppPicks={state.oppPicks}
          oppBans={state.oppBans}
          oppLegs={derived.oppLegs}
          universe={derived.universe}
          picksMax={state.picksMax}
          poolFilter={state.pool}
          auto={state.auto !== null}
          started={state.started}
          onBack={actions.go("battles")}
          onStartGame={actions.startGame}
          onPoolFilter={actions.setPool}
          onPick={actions.pick}
          onBan={actions.ban}
          onConfirm={actions.goStudy}
        />
      )}

      {!showRoom && state.tab === "study" && (
        <Study
          arena={derived.arena}
          myLegs={derived.myLegs}
          salt={derived.studySalt}
          prizeLabel={derived.prizeLabel}
          onDone={actions.goPick}
        />
      )}

      {!showRoom && state.tab === "pick" && (
        <ParlayLock
          myLegs={derived.myLegs}
          tick={state.tick}
          opponent={derived.opponent}
          onSetDir={actions.setLegDir}
          onLock={actions.startFight}
        />
      )}

      {!showRoom && state.tab === "live" && (
        <Live
          lobbyName={state.lobbyName}
          prizeLabel={derived.prizeLabel}
          tapeSpeed={state.tapeSpeed}
          arena={derived.arena}
          myLegs={derived.myLegs}
          oppLegs={derived.oppLegs}
          salt={derived.fightSalt}
          pos={derived.pos}
          raceDone={derived.raceDone}
          p1Name={derived.p1Name}
          p1Init={derived.p1Init}
          opponent={derived.opponent}
          myScore={scoreOf(derived.myLegs, derived.fightSalt, derived.pos)}
          oppScore={scoreOf(derived.oppLegs, derived.fightSalt, derived.pos)}
          onSettle={actions.goResult}
        />
      )}

      {!showRoom && state.tab === "result" && (
        <Result
          verdict={verdict}
          myLegs={derived.myLegs}
          oppLegs={derived.oppLegs}
          salt={derived.fightSalt}
          prizeLabel={derived.prizeLabel}
          p1Name={derived.p1Name}
          opponent={derived.opponent}
          onBackToBattles={actions.go("battles")}
          onRematch={actions.go("create")}
        />
      )}

      {!showRoom && state.tab === "parlay" && (
        <Parlay source={source} asset={state.asset} onAsset={actions.setAsset} />
      )}

      {!showRoom && state.tab === "cases" && (
        <Cases onOpenCase={actions.go("draft")} onClaimFreeBattle={actions.claimFreeBattle} />
      )}

      {state.auto && (
        <AutoBanner
          label={
            derived.spectating
              ? "SPECTATING · mira.base vs kazuo.eth"
              : "RANDOM DEMO · autopilot"
          }
          onStop={actions.stopAuto}
        />
      )}

      {active.id === "mock" && !state.auto && <MockWalletBanner />}

      <Footer source={source} />
    </div>
  );
}
