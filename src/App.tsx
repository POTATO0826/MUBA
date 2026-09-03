import { useCallback, useEffect, useState } from "react";
import { MatchSpin } from "./components/MatchSpin.tsx";
import { scoreOf } from "./engine/match.ts";
import { slipLabel } from "./engine/parlay.ts";
import { MARKET_COLOR, MARKET_LABEL, YOU, bookFor, stakePointsFor } from "./data/lobbies.ts";
import type { MarketSource } from "./data/market.ts";
import { meta } from "./data/universe.ts";
import { parseRoute, routePath, type Route } from "./lib/route.ts";
import { sx } from "./lib/sx.ts";
import { useLedger } from "./state/ledger.ts";
import { useMatch } from "./state/match.ts";
import { Footer } from "./ui/Footer.tsx";
import { Header } from "./ui/Header.tsx";
import { Battles } from "./views/Battles.tsx";
import { CreateLobby } from "./views/CreateLobby.tsx";
import { Live } from "./views/Live.tsx";
import { Lobby } from "./views/Lobby.tsx";
import { Parlay } from "./views/Parlay.tsx";
import { ParlayPick } from "./views/ParlayPick.tsx";
import { Result } from "./views/Result.tsx";
import { Room } from "./views/Room.tsx";
import { Study } from "./views/Study.tsx";

const PAGE =
  "min-height:100vh;background:radial-gradient(1200px 600px at 78% -10%, rgba(200,255,0,.07), transparent 60%)," +
  "radial-gradient(900px 500px at 8% 0%, rgba(99,102,241,.08), transparent 55%),#09090b";

const MATCH_STAGES = new Set(["room", "spin", "study", "parlay", "duel", "result"]);

function currentRoute(): Route {
  if (typeof window === "undefined") return { tab: "lobby", lobbyId: null, seed: null };
  return parseRoute(window.location.pathname, window.location.search);
}

/**
 * One match, end to end:
 *
 *   battles → room → spin → study → parlay → duel → result
 *
 * Take a seat, both players ready up in the room, the spin deals the tickers
 * both of you play on, read the case, pick a parlay card, hold through the
 * tape, settle. `lobby` (home), `create` and `desk` sit beside it.
 */
export function App({ source, route }: { source: MarketSource; route?: Route }) {
  const { state, derived, actions } = useMatch(route ?? currentRoute());
  const ledger = useLedger();
  const [wallet, setWallet] = useState(false);

  // The address follows the match, so a spin can be shared with its seed in it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const seed = MATCH_STAGES.has(state.tab) ? state.seed : null;
    const path = routePath(state.tab, state.lobbyId, seed);
    if (window.location.pathname + window.location.search !== path) {
      window.history.replaceState(null, "", path);
    }
  }, [state.tab, state.lobbyId, state.seed]);

  const stakeOf = useCallback(
    (id: string) => {
      const l = state.lobbies.find((x) => x.id === id);
      return l ? stakePointsFor(l) : 0;
    },
    [state.lobbies],
  );

  /** Take the second seat on someone's lobby: into the room. */
  const accept = useCallback((id: string) => actions.accept(id), [actions]);
  /** Your lobby filled: into the room. */
  const start = useCallback((id: string) => actions.start(id), [actions]);

  /** Readying up is when the entry leaves the balance. Before that, the seat can still be given back. */
  const readyUp = useCallback(() => {
    if (state.lobbyId) ledger.enter(stakeOf(state.lobbyId));
    actions.readyUp();
  }, [actions, ledger, stakeOf, state.lobbyId]);

  /** The duel settled: the winner banks the stake at their parlay's odds. */
  const settle = useCallback(() => {
    const v = derived.verdict;
    if (derived.lobby && v) {
      ledger.settle({
        lobbyId: derived.lobby.id,
        seed: state.seed,
        stake: derived.stakePoints,
        points: v.meWins ? derived.pointsIfWon : 0,
        won: v.meWins,
      });
    }
    actions.settle();
  }, [actions, derived.lobby, derived.verdict, derived.stakePoints, derived.pointsIfWon, ledger, state.seed]);

  const lobby = derived.lobby;
  const opp = derived.opponent;

  return (
    <div style={sx(PAGE)}>
      <Header tab={state.tab} wallet={wallet} onNavigate={(t) => actions.go(t)()} onToggleWallet={() => setWallet((w) => !w)} />

      {state.tab === "lobby" && (
        <Lobby
          lobbies={state.lobbies}
          onFindMatch={actions.go("battles")}
          onCreate={actions.go("create")}
          onAccept={accept}
          onStart={start}
        />
      )}

      {/* The spin is a dialog over the board, so closing it lands back on the grid. */}
      {(state.tab === "battles" || state.tab === "spin") && (
        <Battles
          lobbies={state.lobbies}
          points={ledger.points}
          onAccept={accept}
          onStart={start}
          onCreate={actions.go("create")}
        />
      )}

      {state.tab === "create" && (
        <CreateLobby
          form={state.form}
          entryLabel={derived.formEntryLabel}
          prizeLabel={derived.formPrizeLabel}
          onName={actions.setFormName}
          onMarket={actions.setFormMarket}
          onLegsUp={actions.formLegsUp}
          onLegsDown={actions.formLegsDown}
          onPrizeInput={actions.onPrizeInput}
          onPrizeBlur={actions.onPrizeBlur}
          onPrizeUp={actions.prizeUp}
          onPrizeDown={actions.prizeDown}
          onPublish={actions.publishLobby}
          onBack={actions.go("battles")}
        />
      )}

      {state.tab === "room" && lobby && opp && (
        <Room
          lobby={lobby}
          you={YOU}
          opponent={opp}
          ready={state.ready}
          entryLabel={derived.entryLabel}
          prizeLabel={derived.prizeLabel}
          onReady={readyUp}
          onBegin={actions.beginSpin}
          onLeave={actions.leaveRoom}
        />
      )}

      {state.tab === "spin" && lobby && opp && derived.spin && (
        <MatchSpin
          key={state.seed}
          lobbyName={lobby.name}
          marketLabel={MARKET_LABEL[lobby.market]}
          color={MARKET_COLOR[lobby.market]}
          opponent={opp}
          assets={bookFor(lobby.market).map(meta)}
          result={derived.spin}
          onDone={actions.claim}
          onClose={actions.closeSpin}
        />
      )}

      {state.tab === "study" && lobby && opp && (
        <Study
          arena={derived.arena}
          briefs={derived.briefs}
          salt={derived.studySalt}
          opponent={opp}
          prizeLabel={derived.prizeLabel}
          onDone={actions.doneStudy}
        />
      )}

      {state.tab === "parlay" && lobby && opp && (
        <ParlayPick
          lobbyName={lobby.name}
          opponent={opp}
          arena={derived.arena}
          picks={derived.myPicks}
          allPicked={derived.allPicked}
          myLegs={derived.myLegs}
          summary={derived.mySummary}
          stakePoints={derived.stakePoints}
          prizeLabel={derived.prizeLabel}
          onPick={actions.pick}
          onLock={actions.lockParlay}
        />
      )}

      {state.tab === "duel" && lobby && opp && derived.verdict && (
        <Live
          lobbyName={lobby.name}
          prizeLabel={derived.prizeLabel}
          arena={derived.arena}
          myLegs={derived.myLegs}
          oppLegs={derived.oppLegs}
          myCardLabel={slipLabel(derived.myLegs)}
          oppCardLabel="HIDDEN UNTIL SETTLED"
          salt={derived.fightSalt}
          pos={derived.pos}
          raceDone={derived.raceDone}
          you={YOU}
          opponent={opp}
          myScore={scoreOf(derived.myLegs, derived.fightSalt, derived.pos)}
          oppScore={scoreOf(derived.oppLegs, derived.fightSalt, derived.pos)}
          onSettle={settle}
        />
      )}

      {state.tab === "result" && lobby && opp && derived.verdict && (
        <Result
          verdict={derived.verdict}
          you={YOU}
          opponent={opp}
          myLegs={derived.myLegs}
          oppLegs={derived.oppLegs}
          myMult={derived.mySummary.mult}
          oppMult={derived.oppSummary.mult}
          pointsWon={derived.pointsIfWon}
          salt={derived.fightSalt}
          prizeLabel={derived.prizeLabel}
          onBackToBattles={actions.backToBattles}
          onRematch={actions.go("create")}
        />
      )}

      {state.tab === "desk" && <Parlay source={source} asset={state.asset} onAsset={actions.setAsset} />}

      <Footer source={source} />
    </div>
  );
}
