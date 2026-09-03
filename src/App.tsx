import { useMemo } from "react";
import { useTilt } from "./components/useTilt.ts";
import type { MarketSource } from "./data/market.ts";
import { scoreOf, settle } from "./engine/match.ts";
import { TAPE_LEN } from "./engine/tape.ts";
import { sx } from "./lib/sx.ts";
import { useBattle } from "./state/battle.ts";
import { AutoBanner } from "./ui/AutoBanner.tsx";
import { Footer } from "./ui/Footer.tsx";
import { Header } from "./ui/Header.tsx";
import { Battles } from "./views/Battles.tsx";
import { Cases } from "./views/Cases.tsx";
import { Create } from "./views/Create.tsx";
import { Draft } from "./views/Draft.tsx";
import { Live } from "./views/Live.tsx";
import { Lobby } from "./views/Lobby.tsx";
import { Parlay } from "./views/Parlay.tsx";
import { ParlayLock } from "./views/ParlayLock.tsx";
import { Result } from "./views/Result.tsx";
import { Study } from "./views/Study.tsx";

const PAGE =
  "min-height:100vh;background:radial-gradient(1200px 600px at 78% -10%, rgba(200,255,0,.07), transparent 60%)," +
  "radial-gradient(900px 500px at 8% 0%, rgba(99,102,241,.08), transparent 55%),#09090b";

export function App({ source }: { source: MarketSource }) {
  const { state, derived, actions } = useBattle();
  useTilt();

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
        wallet={state.wallet}
        onNavigate={(t) => actions.go(t)()}
        onToggleWallet={actions.toggleWallet}
      />

      {state.tab === "lobby" && (
        <Lobby
          prize={state.prize}
          onCreateBattle={actions.go("draft")}
          onBrowseRewards={actions.go("cases")}
          onJoinRoom={actions.joinRoom}
          onSpectate={actions.runSpectate}
        />
      )}

      {state.tab === "battles" && (
        <Battles
          prize={state.prize}
          onJoinRoom={actions.joinRoom}
          onSpectate={actions.runSpectate}
          onRunDemo={actions.runDemo}
          onCreate={actions.go("create")}
        />
      )}

      {state.tab === "create" && (
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
          onPublish={actions.publishLobby}
        />
      )}

      {state.tab === "draft" && (
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

      {state.tab === "study" && (
        <Study
          arena={derived.arena}
          myLegs={derived.myLegs}
          salt={derived.studySalt}
          prizeLabel={derived.prizeLabel}
          onDone={actions.goPick}
        />
      )}

      {state.tab === "pick" && (
        <ParlayLock
          myLegs={derived.myLegs}
          tick={state.tick}
          opponent={derived.opponent}
          onSetDir={actions.setLegDir}
          onLock={actions.startFight}
        />
      )}

      {state.tab === "live" && (
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

      {state.tab === "result" && (
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

      {state.tab === "parlay" && (
        <Parlay source={source} asset={state.asset} onAsset={actions.setAsset} />
      )}

      {state.tab === "cases" && (
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

      <Footer source={source} />
    </div>
  );
}
