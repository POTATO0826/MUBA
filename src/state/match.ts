import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { briefsFor } from "../data/briefs.ts";
import {
  LOBBIES,
  YOU,
  bookOf,
  canPlay,
  opponentOf,
  randomOpponent,
  stakePointsFor,
} from "../data/lobbies.ts";
import { PRESETS, SECTOR_ORDER, bookForSectors, marketOf } from "../data/sectors.ts";
import { settle } from "../engine/match.ts";
import {
  PARLAY_CARDS,
  buildLeg,
  cardById,
  legForCard,
  summarize,
  type ParlayCard,
  type ParlayLeg,
} from "../engine/parlay.ts";
import { newSeed, seededRandom, spinCase } from "../engine/spin.ts";
import { TAPE_LEN } from "../engine/tape.ts";
import type { Route } from "../lib/route.ts";
import type { LobbyDef, MarketFilter, SectorKey, Tab } from "../types.ts";

/**
 * One match: which lobby, which seed, who is ready, which parlay card, and
 * how far the tape has played. Plus the board of lobbies, since the ones you
 * publish live here.
 *
 * The tickers are not state. They fall out of `spinCase(book, legs, seed)`,
 * which is deterministic — so a `/match/:id/parlay?seed=N` link rebuilt from
 * nothing shows the same slip the person who sent it saw. The opponent's picks
 * are drawn from the same seed, so they replay too.
 */
export interface LobbyForm {
  name: string;
  /** The groups the published lobby's spin will deal from. `market` is
   *  `marketOf(sectors)` — the two are kept in step by every action that
   *  touches either. */
  sectors: readonly SectorKey[];
  market: MarketFilter;
  legs: number;
  /** Prize pool in ETH. */
  prize: number;
  /** Raw text in the prize field — kept apart from `prize` so a half-typed
   *  "1." survives until blur. */
  prizeText: string;
}

export interface MatchState {
  tab: Tab;
  lobbies: readonly LobbyDef[];
  lobbyId: string | null;
  seed: number;
  /** Who has readied up in the room. The spin waits on both. */
  ready: { me: boolean; opp: boolean };
  /** Your pick per ticker: card id by symbol. The lock waits for every ticker. */
  myPicks: Readonly<Record<string, string>>;
  /** Advances every 120ms while the tape is running. */
  tick: number;
  /** Underlying selected on the options desk. */
  asset: string;
  form: LobbyForm;
}

/** Prints per tick on the tape: the whole tape plays in about eight seconds. */
export const TAPE_STEP = 3;
/** How long a lobby you publish waits before someone takes the seat. */
export const MATCHMAKING_MS = 1600;
/** How long the other player takes to ready up once you are in the room. */
export const OPP_READY_MS = 1100;

const INITIAL_FORM: LobbyForm = {
  name: "Room #4471",
  sectors: PRESETS.MIXED,
  market: "MIXED",
  legs: 3,
  prize: 5,
  prizeText: "5.00",
};

const NOT_READY = { me: false, opp: false } as const;

export function initialState(route: Route): MatchState {
  const lobby = LOBBIES.find((l) => l.id === route.lobbyId) ?? null;
  const inMatch = route.tab !== "lobby" && route.tab !== "battles" && route.tab !== "create" && route.tab !== "desk";
  return {
    // A match address with no lobby behind it lands on the board.
    tab: inMatch && !lobby ? "battles" : route.tab,
    lobbies: LOBBIES,
    lobbyId: lobby ? lobby.id : null,
    seed: route.seed ?? newSeed(),
    ready: NOT_READY,
    myPicks: {},
    tick: 0,
    asset: "ETH",
    form: INITIAL_FORM,
  };
}

type Patch = Partial<MatchState> | ((s: MatchState) => Partial<MatchState>);

const clampPrize = (v: number) => Math.max(0.1, Math.min(999, +v.toFixed(2)));

/** Ceiling on legs for a selection: four, or the book if it is shorter. A
 *  selection can be empty — Publish is what refuses it, not this. */
const legsMax = (sectors: readonly SectorKey[]) => Math.min(4, bookForSectors(sectors).length);

/** Two is always the floor, even when the book cannot fill it: the form stays
 *  legal-looking and the gated Publish explains why it will not go. */
const clampLegs = (n: number, max: number) => Math.max(2, Math.min(max, n));

export function useMatch(route: Route) {
  const [state, setState] = useState<MatchState>(() => initialState(route));

  // The clock runs outside React's render, so it reads the tab through a ref.
  const stateRef = useRef(state);
  stateRef.current = state;

  const patch = useCallback((p: Patch) => {
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
  }, []);

  useEffect(() => {
    const id = setInterval(() => {
      if (stateRef.current.tab === "duel") setState((s) => ({ ...s, tick: s.tick + 1 }));
    }, 120);
    return () => clearInterval(id);
  }, []);

  // Matchmaking: a lobby you published gets its second seat filled after a
  // moment. One timer per open lobby of yours; cancelled if it disappears.
  const pendingId = state.lobbies.find((l) => l.mine && l.status === "open")?.id ?? null;
  useEffect(() => {
    if (!pendingId) return;
    const t = setTimeout(() => {
      patch((s) => ({
        lobbies: s.lobbies.map((l) =>
          l.id === pendingId ? { ...l, status: "matched", opponent: randomOpponent() } : l,
        ),
      }));
    }, MATCHMAKING_MS);
    return () => clearTimeout(t);
  }, [pendingId, patch]);

  // The other player readies up a beat after you enter the room. The spin
  // still waits for you.
  const inRoom = state.tab === "room" && state.lobbyId !== null;
  useEffect(() => {
    if (!inRoom || state.ready.opp) return;
    const t = setTimeout(() => patch((s) => ({ ready: { ...s.ready, opp: true } })), OPP_READY_MS);
    return () => clearTimeout(t);
  }, [inRoom, state.ready.opp, state.lobbyId, patch]);

  const actions = useMemo(() => {
    /** Both seats are taken: into the room, where both players ready up. */
    const enterRoom = (lobbyId: string) =>
      patch({
        tab: "room",
        lobbyId,
        seed: newSeed(),
        ready: NOT_READY,
        myPicks: {},
        tick: 0,
      });

    return {
      go: (tab: Tab) => () => patch({ tab }),
      setAsset: (asset: string) => patch({ asset }),

      // ---------- lobbies ----------

      /** Take the open seat on someone else's lobby, then into the room. */
      accept: (lobbyId: string) => {
        patch((s) => ({
          lobbies: s.lobbies.map((l) =>
            l.id === lobbyId && !l.mine ? { ...l, status: "matched", opponent: YOU } : l,
          ),
        }));
        enterRoom(lobbyId);
      },
      /** Your lobby filled: into the room. */
      start: enterRoom,

      setFormName: (name: string) => patch((s) => ({ form: { ...s.form, name } })),
      /** The BOOK presets. Selects that market's groups, so `sectors` and
       *  the derived `market` never drift apart. */
      setFormMarket: (market: MarketFilter) =>
        patch((s) => ({ form: { ...s.form, sectors: PRESETS[market], market } })),
      /** Add or drop one group. `market` is recomputed from what is left, so
       *  the header tag never drifts from the selection.
       *
       *  `legs` is deliberately left alone: dropping to a book too short for
       *  the legs already set is the state the gated Publish exists to
       *  explain, and silently rewriting the number would hide it. The legs
       *  stepper re-clamps on its next press. An empty selection is allowed
       *  here too — again, Publish is the gate. */
      toggleFormSector: (k: SectorKey) =>
        patch((s) => {
          const had = s.form.sectors.includes(k);
          // Rebuilt in canonical order so the stored selection never depends
          // on the order the chips were pressed in.
          const sectors = SECTOR_ORDER.filter((x) =>
            x === k ? !had : s.form.sectors.includes(x),
          );
          return { form: { ...s.form, sectors, market: marketOf(sectors) } };
        }),
      formLegsUp: () =>
        patch((s) => ({ form: { ...s.form, legs: clampLegs(s.form.legs + 1, legsMax(s.form.sectors)) } })),
      formLegsDown: () =>
        patch((s) => ({ form: { ...s.form, legs: clampLegs(s.form.legs - 1, legsMax(s.form.sectors)) } })),
      onPrizeInput: (raw: string) => {
        const cleaned = raw.replace(/[^0-9.]/g, "");
        const f = parseFloat(cleaned);
        patch((s) => ({
          form: Number.isFinite(f)
            ? { ...s.form, prizeText: cleaned, prize: clampPrize(f) }
            : { ...s.form, prizeText: cleaned },
        }));
      },
      onPrizeBlur: () => patch((s) => ({ form: { ...s.form, prizeText: s.form.prize.toFixed(2) } })),
      prizeUp: () =>
        patch((s) => {
          const v = clampPrize(s.form.prize + 0.5);
          return { form: { ...s.form, prize: v, prizeText: v.toFixed(2) } };
        }),
      prizeDown: () =>
        patch((s) => {
          const v = clampPrize(s.form.prize - 0.5);
          return { form: { ...s.form, prize: v, prizeText: v.toFixed(2) } };
        }),
      /** Put the lobby on the board, at the top, and wait for a seat to fill. */
      publishLobby: () =>
        patch((s) => {
          const mine: LobbyDef = {
            id: `mine-${s.lobbies.filter((l) => l.mine).length + 1}`,
            name: s.form.name.trim() || "Untitled lobby",
            host: YOU,
            sectors: s.form.sectors,
            // Presentation only, and always derived — never the form's own field.
            market: marketOf(s.form.sectors),
            legs: s.form.legs,
            prize: s.form.prize,
            status: "open",
            mine: true,
            opponent: null,
            createdAgo: "now",
          };
          return { tab: "battles", lobbies: [mine, ...s.lobbies] };
        }),

      // ---------- the room ----------

      readyUp: () => patch((s) => ({ ready: { ...s.ready, me: true } })),
      /** Both ready: the spin decides what you play on. A no-op until then. */
      beginSpin: () =>
        patch((s) => (s.ready.me && s.ready.opp ? { tab: "spin" } : {})),
      /** Walk out. Someone else's lobby goes back on the board open. */
      leaveRoom: () =>
        patch((s) => ({
          tab: "battles",
          lobbyId: null,
          ready: NOT_READY,
          lobbies: s.lobbies.map((l) =>
            l.id === s.lobbyId && !l.mine ? { ...l, status: "open", opponent: null } : l,
          ),
        })),

      // ---------- the match ----------

      /** Abandon the spin. */
      closeSpin: () => patch({ tab: "battles", lobbyId: null, ready: NOT_READY }),
      claim: () => patch({ tab: "study" }),
      doneStudy: () => patch({ tab: "parlay" }),
      pick: (sym: string, cardId: string) =>
        patch((s) => ({ myPicks: { ...s.myPicks, [sym]: cardId } })),
      lockParlay: () => patch({ tab: "duel", tick: 0 }),
      settle: () => patch({ tab: "result" }),
      backToBattles: () => patch({ tab: "battles", lobbyId: null, ready: NOT_READY, tick: 0 }),
    };
  }, [patch]);

  const derived = useMemo(() => {
    const lobby = state.lobbies.find((l) => l.id === state.lobbyId) ?? null;
    const opponent = lobby ? opponentOf(lobby) : null;
    // The book comes from the lobby's sectors, and `canPlay` is what keeps
    // `spinCase` from throwing mid-render on a book too small for the legs.
    const spin = lobby && canPlay(lobby) ? spinCase(bookOf(lobby), lobby.legs, state.seed) : null;
    const arena = spin ? spin.syms : [];

    // The opponent's pick per ticker is drawn from the same seed, so it
    // replays with the link and stays hidden until both slips lock.
    const oppRandom = seededRandom(state.seed ^ 0x5bd1e995);
    const oppPicks: Record<string, ParlayCard> = {};
    for (const sym of arena) oppPicks[sym] = PARLAY_CARDS[Math.floor(oppRandom() * PARLAY_CARDS.length)]!;

    const myPicks: Record<string, ParlayCard> = {};
    for (const sym of arena) {
      const c = cardById(state.myPicks[sym]);
      if (c) myPicks[sym] = c;
    }
    const allPicked = arena.length > 0 && arena.every((sym) => sym in myPicks);

    // A ticker without a pick shows at EVEN, bullish — a preview, not a position.
    const myLegs: readonly ParlayLeg[] = arena.map((sym) =>
      myPicks[sym] ? legForCard(sym, myPicks[sym]!) : buildLeg(sym, "over", "EVEN"),
    );
    const oppLegs: readonly ParlayLeg[] = arena.map((sym) => legForCard(sym, oppPicks[sym]!));

    const stakePoints = lobby ? stakePointsFor(lobby) : 0;
    const studySalt = 1 + state.seed * 3;
    const fightSalt = 2 + state.seed * 3;
    const pos = Math.min(TAPE_LEN, Math.max(2, state.tick * TAPE_STEP));

    const verdict =
      lobby && opponent
        ? settle(myLegs, oppLegs, arena, fightSalt, TAPE_LEN, YOU.name, opponent.name)
        : null;
    const mySummary = summarize(myLegs, stakePoints);
    const oppSummary = summarize(oppLegs, stakePoints);

    return {
      lobby,
      opponent,
      bothReady: state.ready.me && state.ready.opp,
      spin,
      arena,
      myPicks,
      oppPicks,
      allPicked,
      myLegs,
      oppLegs,
      stakePoints,
      mySummary,
      oppSummary,
      /** What the winner banks in points: the stake at their own parlay's odds. */
      pointsIfWon: mySummary.potentialPoints,
      briefs: briefsFor(arena, studySalt),
      /** Identity of this match for anything cached per (lobby, seed) — the news wire. Null-safe: `lobby` can be null mid-render. */
      matchKey: `${state.lobbyId ?? "none"}:${state.seed}`,
      studySalt,
      fightSalt,
      /** Print index the tape has played up to. */
      pos,
      raceDone: pos >= TAPE_LEN,
      verdict,
      prizeLabel: lobby ? `${lobby.prize.toFixed(2)} ETH` : "—",
      entryLabel: lobby ? `${(lobby.prize / 2).toFixed(2)} ETH` : "—",
      formPrizeLabel: `${state.form.prize.toFixed(2)} ETH`,
      formEntryLabel: `${(state.form.prize / 2).toFixed(2)} ETH`,
    };
  }, [state.lobbies, state.lobbyId, state.seed, state.ready, state.myPicks, state.tick, state.form.prize]);

  return { state, derived, actions };
}

export type Match = ReturnType<typeof useMatch>;
