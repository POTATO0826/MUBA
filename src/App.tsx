import { useCallback, useEffect, useState } from "react";
import { MatchSpin } from "./components/MatchSpin.tsx";
import { scoreOf } from "./engine/match.ts";
import { slipLabel } from "./engine/parlay.ts";
import { MARKET_COLOR, MARKET_LABEL, YOU, bookOf, stakePointsFor } from "./data/lobbies.ts";
import type { RoomView } from "./data/room.ts";
import type { WalletSource } from "./data/wallet.ts";
import { qualifiedAssetsOf, type MarketSource } from "./data/market.ts";
import { mockNewsSource, type NewsSource } from "./data/news.ts";
import { meta } from "./data/universe.ts";
import { parseRoute, routePath, type Route } from "./lib/route.ts";
import { useSoundUnlock } from "./lib/sound/index.ts";
import { sx } from "./lib/sx.ts";
import { useLedger } from "./state/ledger.ts";
import { useBattle } from "./state/battle.ts";
import { useMatch } from "./state/match.ts";
import { useOptionBook } from "./state/options.ts";
import { useDuelStake } from "./state/stake.ts";
import { useRankProgress } from "./state/rank.ts";
import { useRoom } from "./state/room.ts";
import { useWire } from "./state/wire.ts";
import { Footer } from "./ui/Footer.tsx";
import { Header } from "./ui/Header.tsx";
import { MockWalletBanner } from "./ui/MockWalletBanner.tsx";
import { Battles } from "./views/Battles.tsx";
import { Create } from "./views/Create.tsx";
import { CreateLobby } from "./views/CreateLobby.tsx";
import { Hub } from "./views/Hub.tsx";
import { Live } from "./views/Live.tsx";
import { Lobby } from "./views/Lobby.tsx";
import { Parlay } from "./views/Parlay.tsx";
import { ParlayRfq } from "./views/ParlayRfq.tsx";
import { ParlayPick } from "./views/ParlayPick.tsx";
import { Ranking } from "./views/Ranking.tsx";
import { Result } from "./views/Result.tsx";
import { Room } from "./views/Room.tsx";
import { RoomLobby } from "./views/RoomLobby.tsx";
import { SpotDiff } from "./views/SpotDiff.tsx";
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

  /**
   * Today's qualified assets — the asset gate, measured, threaded to the screens
   * that offer a market.
   *
   * Read straight off the source rather than through a hook, and deliberately
   * not memoised: `qualifiedAssetsOf` is one property read plus a `??`, and both
   * shipped sources hand back an array whose identity is stable for the life of
   * the source (`NO_QUALIFIED` for the mock, the wire array for the live one).
   * A `useMemo` here would cost more than it saved and would add a dependency
   * on a value that already changes exactly when the book does.
   *
   * `[]` offline, `[]` while the indexer 404s, and `[]` on the seeded source —
   * all of which are the honest answer, and all of which grey the live sector
   * groups *with a reason* rather than hiding them or inventing a grade.
   *
   * **Not passed anywhere near the match.** `useMatch` above has already been
   * given its inputs; the gate informs what a lobby *offers*, never what a seed
   * *deals*. `src/state/match.ts` may not import `data/qualify` at all
   * (`test/determinism.test.ts`, `ASSET_GATE_RE`), and the reel takes the list
   * as the second argument of `spinSlice(book, qualified, seed)` — injected,
   * never imported.
   */
  const liveAssets = qualifiedAssetsOf(source);

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

  // `active` is already resolved above the match, because the side bet needs a
  // wallet id before the match state exists. The arena only needs the identity
  // off it.
  const { identity } = active;

  // The invite-room PvP flow lives beside the original seeded match flow.
  // Its internal tabs are deliberately separate because both flows have a
  // create screen and a parlay screen with different state contracts.
  const { state: arena, derived: arenaDerived, actions: arenaActions } = useBattle();
  const roomState = useRoom(identity.address ?? null);
  const [roomLobbyOpen, setRoomLobbyOpen] = useState(false);
  const [arenaEntered, setArenaEntered] = useState(false);
  const showArenaRoom =
    state.tab === "arena" &&
    roomState.room !== null &&
    (roomLobbyOpen || roomState.arrivedFromLink) &&
    !arenaEntered;

  const [myRooms, setMyRooms] = useState<readonly RoomView[]>([]);
  const refreshRooms = useCallback(() => {
    if (state.tab !== "arena" || !identity.address) {
      setMyRooms([]);
      return;
    }
    fetch(`/api/rooms/mine?address=${encodeURIComponent(identity.address)}`)
      .then((response) => response.json())
      .then((data: { rooms?: RoomView[] }) => setMyRooms(data.rooms ?? []))
      .catch(() => {
        // The arena remains usable even when its history list cannot refresh.
      });
  }, [identity.address, state.tab]);

  const arenaRoomId = roomState.room?.id ?? null;
  useEffect(refreshRooms, [refreshRooms, arenaRoomId]);
  // The chain says the other seat filled. The same patch the fake timer would
  // have applied — which is exactly why the timer is suppressed while a stake is
  // live: two sources for one fact is one source too many.
  useEffect(() => {
    if (stake.joined) actions.oppReady();
  }, [stake.joined, actions]);

  // The address follows the match, so a spin can be shared with its seed in it.
  useEffect(() => {
    if (typeof window === "undefined") return;
    // Shared room URLs are owned by `useRoom`; rewriting one to `/arena`
    // would destroy the invite before a challenger can join. An ordinary
    // arena navigation still needs its own URL, including the mock `?as=`
    // identity override used to exercise two seats on one machine.
    if (state.tab === "arena") {
      if (!/^\/room\/[0-9a-fA-F-]{36}\/?$/.test(window.location.pathname)) {
        const arenaPath = `/arena${window.location.search}`;
        if (window.location.pathname + window.location.search !== arenaPath) {
          window.history.replaceState(null, "", arenaPath);
        }
      }
      return;
    }
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

  const createArena = useCallback(() => {
    if (!identity.address) return;
    setArenaEntered(false);
    setRoomLobbyOpen(false);
    void roomState.create(
      arena.stakeUsdc,
      arena.durationMinutes,
      arena.lobbyName,
      arena.mode,
    );
  }, [arena.durationMinutes, arena.lobbyName, arena.mode, arena.stakeUsdc, identity.address, roomState]);

  const enterArenaDuel = useCallback(() => {
    setArenaEntered(true);
    arenaActions.go(roomState.room?.mode ?? arena.mode)();
  }, [arena.mode, arenaActions, roomState.room]);

  const backToArenaHub = useCallback(() => {
    setArenaEntered(false);
    setRoomLobbyOpen(false);
    roomState.leave();
    arenaActions.go("hub")();
    actions.go("arena")();
  }, [actions, arenaActions, roomState]);

  const lockArenaPick = useCallback(
    (pick: string) => void roomState.pick(pick),
    [roomState],
  );

  return (
    <div style={sx(PAGE)}>
      <Header
        tab={state.tab}
        wallet={identity}
        onNavigate={(tab) => {
          if (tab === "arena") {
            setArenaEntered(false);
            setRoomLobbyOpen(false);
            if (roomState.room) roomState.leave();
            arenaActions.go("hub")();
          }
          actions.go(tab)();
        }}
        onConnect={() => void active.connect()}
        onManage={() => void active.openAccount()}
        onSwitchNetwork={() => void active.switchToBase()}
      />

      {showArenaRoom && roomState.room && (
        <RoomLobby
          room={roomState.room}
          state={roomState}
          walletConnected={identity.connected}
          onEnterDuel={enterArenaDuel}
        />
      )}

      {state.tab === "arena" && !showArenaRoom && arena.tab === "hub" && (
        <Hub
          identity={identity}
          rooms={myRooms}
          onEnterMode={arenaActions.enterMode}
          onOpenRoom={(id) => {
            setArenaEntered(false);
            setRoomLobbyOpen(true);
            void roomState.open(id);
          }}
          onConnect={() => void active.connect()}
          onDisconnect={() => void active.disconnect()}
          onRefresh={refreshRooms}
        />
      )}

      {state.tab === "arena" && !showArenaRoom && arena.tab === "create" && (
        <Create
          state={arena}
          entryLabel={arenaDerived.entryLabel}
          prizeLabel={arenaDerived.prizeLabel}
          inviteUrl={roomState.inviteUrl}
          creating={roomState.busy}
          createError={roomState.error}
          walletConnected={identity.connected}
          onBack={backToArenaHub}
          onStakeInput={arenaActions.onStakeInput}
          onStakeBlur={arenaActions.onStakeBlur}
          onStakeUp={arenaActions.stakeUp}
          onStakeDown={arenaActions.stakeDown}
          onLobbyName={arenaActions.setLobbyName}
          onDuration={arenaActions.setDuration}
          onCreateArena={createArena}
          onOpenLobby={() => setRoomLobbyOpen(true)}
        />
      )}

      {state.tab === "arena" && !showArenaRoom && arena.tab === "parlay" && (
        <ParlayRfq
          source={source}
          room={roomState.room}
          seat={roomState.seat}
          busy={roomState.busy}
          onLock={lockArenaPick}
          onBack={backToArenaHub}
        />
      )}

      {state.tab === "arena" && !showArenaRoom && arena.tab === "spotdiff" && (
        <SpotDiff
          source={source}
          room={roomState.room}
          seat={roomState.seat}
          address={identity.address}
          busy={roomState.busy}
          onLock={lockArenaPick}
          onBack={backToArenaHub}
        />
      )}

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
          // The asset gate reaches a screen. `CreateLobby` has declared this
          // prop since plan 6 landed and nothing has ever passed it, which is
          // why every live sector group has been greying with a reason that was
          // true by accident — `docs/plan6-audit.md` items 15, 18 and 19.
          live={liveAssets}
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
