import { useCallback, useEffect } from "react";
import { MatchSpin } from "./components/MatchSpin.tsx";
import { scoreOf } from "./engine/match.ts";
import { slipLabel } from "./engine/parlay.ts";
import { MARKET_COLOR, MARKET_LABEL, YOU, bookOf, stakePointsFor } from "./data/lobbies.ts";
import type { WalletSource } from "./data/wallet.ts";
import type { MarketSource } from "./data/market.ts";
import { mockNewsSource, type NewsSource } from "./data/news.ts";
import { meta } from "./data/universe.ts";
import { parseRoute, routePath, type Route } from "./lib/route.ts";
import { useSoundUnlock } from "./lib/sound/index.ts";
import { sx } from "./lib/sx.ts";
import { useLedger } from "./state/ledger.ts";
import { useMatch } from "./state/match.ts";
import { useOptionBook } from "./state/options.ts";
import { useDuelStake } from "./state/stake.ts";
import { useRankProgress } from "./state/rank.ts";
import { useWire } from "./state/wire.ts";
import { Footer } from "./ui/Footer.tsx";
import { Header } from "./ui/Header.tsx";
import { MockWalletBanner } from "./ui/MockWalletBanner.tsx";
import { Battles } from "./views/Battles.tsx";
import { CreateLobby } from "./views/CreateLobby.tsx";
import { Live } from "./views/Live.tsx";
import { Lobby } from "./views/Lobby.tsx";
import { Parlay } from "./views/Parlay.tsx";
import { ParlayPick } from "./views/ParlayPick.tsx";
import { Ranking } from "./views/Ranking.tsx";
import { Result } from "./views/Result.tsx";
import { Room } from "./views/Room.tsx";
import { Study } from "./views/Study.tsx";
import { useMockWallet } from "./wallet/mock.ts";

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
 * tape, settle. `lobby` (home), `create`, `desk` and `ranks` sit beside it.
 */
export function App({ source, newsSource = mockNewsSource, route, wallet, marketError }: {
  source: MarketSource;
  /** The study wire's feed. Defaults to the seeded one, so tests and the
   *  offline build touch no network; `client.tsx` injects the live source. */
  newsSource?: NewsSource;
  route?: Route;
  /**
   * Whichever wallet `WalletBoundary` picked. Optional on purpose: AppKit
   * cannot initialise under happy-dom, so the tests mount `App` bare and the
   * mock below stands in. `client.tsx` always passes one.
   */
  wallet?: WalletSource;
  /**
   * Why the live book is degraded, threaded straight to the footer and read by
   * nothing else. Optional so the tests keep mounting `App` with a mock source
   * and no market layer at all.
   */
  marketError?: string | null;
}) {
  // First hook in the tree: the audio context is built inside the very first
  // gesture, capture-phase, so the click that starts the session is audible.
  useSoundUnlock();

  // The headless fallback. A hook, so it must run unconditionally even when a
  // real source was injected — cheap, and it keeps the rules of hooks honest.
  // It is read here, above the match, because the side bet needs a wallet id and
  // the match needs to know whether a real seat is held.
  const fallback = useMockWallet();
  const active = wallet ?? fallback;

  /**
   * The optional USDC side bet, and the reason it is the FIRST stateful hook in
   * this component.
   *
   * `useMatch` needs `stake.live` — an on-chain seat means the opponent's ready
   * must come from `DuelJoined` rather than from `OPP_READY_MS` — and `begin`
   * therefore takes the match key as an argument rather than the hook taking it
   * as a parameter, because the key is derived state that does not exist yet.
   *
   * With no flag, no escrow, or the mock wallet this settles at `available:
   * false`, opens no socket, constructs no contract and renders no DOM anywhere
   * downstream. That is the whole rollback story: flags off is today's app.
   */
  const stake = useDuelStake(active);

  /**
   * The live option book, behind `THETADUEL_OPTIONS=on`.
   *
   * Read here rather than inside the match because `src/state/match.ts` may not
   * touch a market source — the determinism scan forbids it, and a match that
   * could read a book at render time would be a match whose legs depend on the
   * wall clock. What crosses is the plain frozen value, threaded in beside
   * `liveSeats`; `useMatch` takes one snapshot of it when a match is dealt and
   * holds that for the life of the match.
   *
   * `undefined` with the flag off, on a seeded source, or when neither ETH nor
   * BTC has both a spot and a chain — and `undefined` deals exactly the legs the
   * app has always dealt.
   */
  const optionBook = useOptionBook(source);

  const { state, derived, actions } = useMatch(route ?? currentRoute(), {
    liveSeats: stake.live,
    book: optionBook,
  });
  const ledger = useLedger();
  // The rank moment's whole input. Derived from the ledger, so by the time
  // `Result` mounts (App settles on duel → result) `history[0]` is the match
  // that just finished and `rank.gain` is exactly what it paid.
  const rank = useRankProgress(ledger);

  // The news terminal's feed. Seeded synchronously off the match's own salt, so
  // the wire is populated on the first paint; the live source swaps under it if
  // one is injected and answers. Presentation only — never read by settlement.
  const { wire, status: wireStatus } = useWire({
    source: newsSource,
    matchKey: derived.matchKey,
    arena: derived.arena,
    salt: derived.studySalt,
    deskLines: derived.briefs,
  });

  // The chain says the other seat filled. The same patch the fake timer would
  // have applied — which is exactly why the timer is suppressed while a stake is
  // live: two sources for one fact is one source too many.
  useEffect(() => {
    if (stake.joined) actions.oppReady();
  }, [stake.joined, actions]);

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

  /**
   * Readying up is when the entry leaves the balance. Before that, the seat can
   * still be given back.
   *
   * The two lines are in this order and are deliberately not awaited on each
   * other: **the PTS entry is locked synchronously, exactly as it always has
   * been**, and only then does the optional side bet start. `stake.begin` is a
   * no-op unless the flag is on, an escrow is deployed and the wallet can sign;
   * when it does run it never throws and every failure inside it lands the room
   * in PTS-only. Nothing about the points game can be delayed, blocked or
   * changed by a chain.
   */
  const readyUp = useCallback(() => {
    if (state.lobbyId) ledger.enter(stakeOf(state.lobbyId));
    actions.readyUp();
    stake.begin(derived.matchKey);
  }, [actions, derived.matchKey, ledger, stake, stakeOf, state.lobbyId]);

  /** The slip locks: commit it to the referee, signed, so a verdict can be
   *  derived later. A no-op with no stake in play. */
  const lockParlay = useCallback(() => {
    stake.commit(derived.matchKey, state.myPicks);
    actions.lockParlay();
  }, [actions, derived.matchKey, stake, state.myPicks]);

  /** Walking out of a room abandons the side bet's local state too. The escrow
   *  is unaffected — an unjoined duel is still cancellable and a full one still
   *  refunds after the timeout — but this browser stops tracking it. */
  const leaveRoom = useCallback(() => {
    stake.reset();
    actions.leaveRoom();
  }, [actions, stake]);

  const backToBattles = useCallback(() => {
    stake.reset();
    actions.backToBattles();
  }, [actions, stake]);

  /**
   * The duel settled: the winner banks the stake at their parlay's odds.
   *
   * `ledger.settle` fires FIRST and unconditionally — before any chain call
   * exists in this function, and there still is none. The points, the XP, the
   * streak and the rank are all banked from the seeded verdict alone. The USDC
   * claim is offered on the result screen afterwards, by `Result`'s own panel,
   * and it can fail all day without any of the above noticing.
   */
  const settle = useCallback(() => {
    const v = derived.verdict;
    if (derived.lobby && v) {
      ledger.settle({
        lobbyId: derived.lobby.id,
        seed: state.seed,
        stake: derived.stakePoints,
        points: v.meWins ? derived.pointsIfWon : 0,
        won: v.meWins,
        mode: derived.lobby.mode,
        // A sweep is a win with every leg cashed — the ledger doubles its XP.
        sweep: v.meWins && v.myScore === derived.myLegs.length,
        // The tickers the spin DEALT, by raw sector: how this player plays.
        sectors: derived.arena.map((s) => meta(s).sector),
      });
    }
    actions.settle();
  }, [
    actions,
    derived.lobby,
    derived.verdict,
    derived.stakePoints,
    derived.pointsIfWon,
    derived.myLegs,
    derived.arena,
    ledger,
    state.seed,
  ]);

  const lobby = derived.lobby;
  const opp = derived.opponent;

  return (
    <div style={sx(PAGE)}>
      <Header
        tab={state.tab}
        wallet={active.identity}
        onNavigate={(t) => actions.go(t)()}
        onConnect={() => void active.connect()}
        onManage={() => void active.openAccount()}
        onSwitchNetwork={() => void active.switchToBase()}
      />

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
          onToggleSector={actions.toggleFormSector}
          onMode={actions.setFormMode}
          onLegsUp={actions.formLegsUp}
          onLegsDown={actions.formLegsDown}
          onPrizeInput={actions.onPrizeInput}
          onPrizeBlur={actions.onPrizeBlur}
          onPrizeUp={actions.prizeUp}
          onPrizeDown={actions.prizeDown}
          onPublish={actions.publishLobby}
          onBack={actions.go("battles")}
          stake={stake}
        />
      )}

      {state.tab === "room" && lobby && opp && (
        <Room
          lobby={lobby}
          you={YOU}
          youRow={rank.you}
          opponent={opp}
          ready={state.ready}
          entryLabel={derived.entryLabel}
          prizeLabel={derived.prizeLabel}
          stake={stake}
          onReady={readyUp}
          onBegin={actions.beginSpin}
          onLeave={leaveRoom}
        />
      )}

      {state.tab === "spin" && lobby && opp && derived.spin && (
        <MatchSpin
          key={state.seed}
          lobbyName={lobby.name}
          // Display only, and only ever additive: the reel annotates the four
          // board names Thetanuts actually prices and is silent about the other
          // fourteen. What the reel *deals* comes from `spinCase` and the seed,
          // which never see this.
          source={source}
          marketLabel={MARKET_LABEL[lobby.market]}
          mode={derived.mode}
          color={MARKET_COLOR[lobby.market]}
          opponent={opp}
          assets={bookOf(lobby).map(meta)}
          result={derived.spin}
          onDone={actions.claim}
          onClose={actions.closeSpin}
        />
      )}

      {state.tab === "study" && lobby && opp && (
        <Study
          arena={derived.arena}
          wire={wire}
          wireStatus={wireStatus}
          salt={derived.studySalt}
          settleAt={derived.settleAt}
          mode={derived.mode}
          opponent={opp}
          prizeLabel={derived.prizeLabel}
          onDone={actions.doneStudy}
        />
      )}

      {state.tab === "parlay" && lobby && opp && (
        <ParlayPick
          lobbyName={lobby.name}
          // Same contract as the reel's: spot annotates the ticker headers and
          // the book's delta sits beside a tier as advice. Neither reaches
          // `derived.myLegs`, `summary` or anything that pays out.
          source={source}
          // The frozen book, and the one prop on this screen that is not merely
          // additive: where a ticker has a chain, its cards state the venue's
          // strike, delta and premium-derived payout instead of the tier table's.
          // It is the SAME object `derived.myLegs` were priced off, so a card
          // and the leg behind it cannot disagree.
          book={derived.optionBook ?? undefined}
          mode={derived.mode}
          opponent={opp}
          arena={derived.arena}
          picks={derived.myPicks}
          allPicked={derived.allPicked}
          secondsLeft={derived.secondsLeft}
          myLegs={derived.myLegs}
          summary={derived.mySummary}
          stakePoints={derived.stakePoints}
          prizeLabel={derived.prizeLabel}
          onPick={actions.pick}
          onLock={lockParlay}
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
          settleAt={derived.settleAt}
          mode={derived.mode}
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
          settleAt={derived.settleAt}
          mode={derived.mode}
          sectors={lobby.sectors}
          prizeLabel={derived.prizeLabel}
          xpGain={rank.gain}
          xpBefore={rank.xpBefore}
          xpAfter={rank.xpAfter}
          streak={rank.streak}
          posBefore={rank.posBefore}
          posAfter={rank.posAfter}
          stake={stake}
          matchKey={derived.matchKey}
          onBackToBattles={backToBattles}
          onRematch={actions.go("create")}
          onOpenLadder={actions.go("ranks")}
        />
      )}

      {/* `wallet` is what lets /desk sign a real fill behind `THETADUEL_TRADE=on`
          — the first screen in the app that needs a signer rather than an
          address. It is optional on `Parlay`, and with the flag off (or on the
          mock tier, which must never approve or fill) the desk renders exactly
          the DOM it rendered before the fill flow existed. */}
      {state.tab === "desk" && (
        <Parlay source={source} asset={state.asset} onAsset={actions.setAsset} wallet={active} />
      )}

      {/* The ladder. `rank.you` is the same `LeaderPlayer` the rank moment
          reasons about, so the row that climbs on the Result screen is
          literally the row this page sorts into the table. `streak` rides
          along from the same hook because it is the one movement reading the
          ledger actually samples — the hero chip's `↑ W3 STREAK`. */}
      {state.tab === "ranks" && <Ranking you={rank.you} streak={rank.streak} />}

      {/* The address in the header is a plausible-looking fake whenever the
          mock tier won. Say so, rather than letting it pass for a wallet. */}
      {active.id === "mock" && <MockWalletBanner />}

      <Footer source={source} marketError={marketError ?? null} />
    </div>
  );
}
