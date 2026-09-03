import { useCallback, useEffect, useState } from "react";
import { CaseSpin } from "./components/CaseSpin.tsx";
import { useTilt } from "./components/useTilt.ts";
import { caseById, stakePointsFor } from "./data/cases.ts";
import type { MarketSource } from "./data/market.ts";
import { PLAYER, lockedBy } from "./data/rewards.ts";
import { meta } from "./data/universe.ts";
import { parseRoute, routePath, type Route } from "./lib/route.ts";
import { sx } from "./lib/sx.ts";
import { useCaseRun } from "./state/caseRun.ts";
import { useLedger } from "./state/ledger.ts";
import { Footer } from "./ui/Footer.tsx";
import { Header } from "./ui/Header.tsx";
import { Cases } from "./views/Cases.tsx";
import { Lobby } from "./views/Lobby.tsx";
import { Parlay } from "./views/Parlay.tsx";
import { ParlayBuilder } from "./views/ParlayBuilder.tsx";
import { Settled } from "./views/Settled.tsx";
import { Study } from "./views/Study.tsx";
import { Tape } from "./views/Tape.tsx";

const PAGE =
  "min-height:100vh;background:radial-gradient(1200px 600px at 78% -10%, rgba(200,255,0,.07), transparent 60%)," +
  "radial-gradient(900px 500px at 8% 0%, rgba(99,102,241,.08), transparent 55%),#09090b";

const CASE_FLOW = new Set(["spin", "parlay-build", "study", "tape", "settled"]);

function currentRoute(): Route {
  if (typeof window === "undefined") return { tab: "cases", caseId: null, seed: null };
  return parseRoute(window.location.pathname, window.location.search);
}

/**
 * One case run, end to end:
 *
 *   cases → spin → parlay-build → study → tape → settled
 *
 * Open a case, the reel deals its legs, tier each leg, study the charts, hold
 * the position through the tape, settle. `lobby` and `desk` sit beside it.
 */
export function App({ source, route }: { source: MarketSource; route?: Route }) {
  const { state, derived, actions } = useCaseRun(route ?? currentRoute());
  const ledger = useLedger();
  const [wallet, setWallet] = useState(false);
  useTilt();

  // The address follows the run, so a spin can be shared with its seed in it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const seed = CASE_FLOW.has(state.tab) ? state.seed : null;
    const path = routePath(state.tab, state.caseId, seed);
    if (window.location.pathname + window.location.search !== path) {
      window.history.replaceState(null, "", path);
    }
  }, [state.tab, state.caseId, state.seed]);

  /** Buy the position, then spin. A locked case is not openable from anywhere. */
  const openCase = useCallback(
    (id: string) => {
      const c = caseById(id);
      if (!c || lockedBy(c.tier, PLAYER.tier)) return;
      ledger.open(stakePointsFor(c));
      actions.openCase(id);
    },
    [actions, ledger],
  );

  /** The position settles: whatever it paid comes back to the balance. */
  const settle = useCallback(() => {
    const v = derived.verdict;
    if (derived.caseDef && v) {
      ledger.settle({
        caseId: derived.caseDef.id,
        seed: state.seed,
        stake: derived.stakePoints,
        points: v.points,
        allHit: v.allHit,
      });
    }
    actions.settle();
  }, [actions, derived.caseDef, derived.verdict, derived.stakePoints, ledger, state.seed]);

  const c = derived.caseDef;
  const potentialLabel = derived.summary
    ? `${derived.summary.potentialPoints.toLocaleString("en-US")} PTS`
    : "—";

  return (
    <div style={sx(PAGE)}>
      <Header
        tab={state.tab}
        wallet={wallet}
        onNavigate={(t) => actions.go(t)()}
        onToggleWallet={() => setWallet((w) => !w)}
      />

      {state.tab === "lobby" && (
        <Lobby onBrowseCases={actions.go("cases")} onDesk={actions.go("desk")} onOpenCase={openCase} />
      )}

      {/* The spin is a dialog over the library, so closing it lands back on the grid. */}
      {(state.tab === "cases" || state.tab === "spin") && (
        <Cases points={ledger.points} onOpenCase={openCase} />
      )}

      {state.tab === "spin" && c && derived.spin && (
        <CaseSpin
          key={state.seed}
          c={c}
          assets={c.eligibleAssets.map(meta)}
          result={derived.spin}
          respinsLeft={state.respinsLeft}
          onRespin={actions.respin}
          onClaim={actions.claim}
          onClose={actions.closeSpin}
        />
      )}

      {state.tab === "parlay-build" && c && derived.summary && (
        <ParlayBuilder
          c={c}
          legs={derived.legs}
          summary={derived.summary}
          stakePoints={derived.stakePoints}
          onTier={actions.setTier}
          onDir={actions.setDir}
          onLock={actions.lockParlay}
          onBack={actions.backToCases}
        />
      )}

      {state.tab === "study" && c && (
        <Study
          arena={derived.arena}
          myLegs={derived.legs}
          salt={derived.studySalt}
          potentialLabel={potentialLabel}
          onDone={actions.runTape}
        />
      )}

      {state.tab === "tape" && c && (
        <Tape
          caseName={c.name}
          potentialLabel={potentialLabel}
          arena={derived.arena}
          legs={derived.legs}
          salt={derived.fightSalt}
          pos={derived.pos}
          raceDone={derived.raceDone}
          onSettle={settle}
        />
      )}

      {state.tab === "settled" && c && derived.verdict && derived.summary && (
        <Settled
          c={c}
          verdict={derived.verdict}
          summary={derived.summary}
          legs={derived.legs}
          stakePoints={derived.stakePoints}
          onBackToCases={actions.backToCases}
          onOpenAgain={() => openCase(c.id)}
        />
      )}

      {state.tab === "desk" && (
        <Parlay source={source} asset={state.asset} onAsset={actions.setAsset} />
      )}

      <Footer source={source} />
    </div>
  );
}
