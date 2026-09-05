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
import { MODES, MODE_SALT } from "../data/modes.ts";
import { PRESETS, SECTOR_ORDER, bookForSectors, marketOf } from "../data/sectors.ts";
import { settle } from "../engine/match.ts";
import {
  PARLAY_CARDS,
  buildLeg,
  cardById,
  cardsForTicker,
  legForCard,
  legFromLiveCard,
  slotFor,
  summarize,
  vanillaPayout,
  type LiveCard,
  type ParlayCard,
  type ParlayLeg,
} from "../engine/parlay.ts";
import type { OptionBook } from "../desk/optionize.ts";
import { newSeed, seededRandom, spinCase } from "../engine/spin.ts";
import { sfx } from "../lib/sound/index.ts";
import type { Route } from "../lib/route.ts";
import { useMatchSound } from "./matchSound.ts";
import type { LobbyDef, MarketFilter, Mode, SectorKey, Tab } from "../types.ts";

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
  /** The window the published lobby's duel runs on. `MODES[mode]` carries the
   *  settle print, the target scale, the odds boost and the pick clock. */
  mode: Mode;
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
  /** Advances every 120ms while the tape is running, and while a timed parlay
   *  is counting down — that is what makes `derived.secondsLeft` move. */
  tick: number;
  /** Wall-clock ms the parlay slip locks itself at, or `null` when the mode is
   *  untimed (`NORMAL`) or there is no parlay on screen. Set on entry to the
   *  parlay and cleared on every way out of a match, so a second duel can
   *  never inherit the first one's clock. */
  deadline: number | null;
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
  mode: "NORMAL",
  legs: 3,
  prize: 5,
  prizeText: "5.00",
};

const NOT_READY = { me: false, opp: false } as const;

/** The screens that stand outside a match: they carry no lobby and no seed,
 *  so a cold `/ranks` (or `/desk`) must never be mistaken for a match address
 *  with a missing lobby and bounced to the board. */
const OUTSIDE_MATCH: ReadonlySet<Tab> = new Set<Tab>([
  "lobby",
  "battles",
  "create",
  "desk",
  "ranks",
  "arena",
]);

/**
 * When a parlay entered right now would lock itself. `null` for an untimed
 * mode or a missing lobby — the clock is a mode property, not a match one.
 *
 * Wall clock only: it decides WHEN the slip locks, never WHAT it locks. The
 * legs an expired slip carries are the same deterministic `buildLeg(sym,
 * "over", "EVEN", targetScale)` preview `derived` already renders for an
 * unpicked ticker, so nothing here reaches for an RNG.
 */
function deadlineFor(lobby: LobbyDef | null): number | null {
  const secs = lobby ? MODES[lobby.mode].pickSeconds : null;
  return secs === null ? null : Date.now() + secs * 1000;
}

/** The one patch that ends the pick phase — pressed or expired, byte for byte
 *  the same transition. Auto-lock must never drift from the button. */
const LOCK_PATCH = { tab: "duel", tick: 0, deadline: null } as const satisfies Partial<MatchState>;

export function initialState(route: Route): MatchState {
  const lobby = LOBBIES.find((l) => l.id === route.lobbyId) ?? null;
  const inMatch = !OUTSIDE_MATCH.has(route.tab);
  return {
    // A match address with no lobby behind it lands on the board.
    tab: inMatch && !lobby ? "battles" : route.tab,
    lobbies: LOBBIES,
    lobbyId: lobby ? lobby.id : null,
    seed: route.seed ?? newSeed(),
    ready: NOT_READY,
    myPicks: {},
    tick: 0,
    // A `/match/:id/parlay?seed=N` link opened cold starts its own clock.
    deadline: route.tab === "parlay" && lobby ? deadlineFor(lobby) : null,
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

/**
 * What `useMatch` is allowed to be told about the world outside the sim.
 *
 * Exactly one field, and it only ever *removes* behaviour: with a real USDC
 * stake held in the escrow, the second seat is a real address that has really
 * paid, so faking its ready would be a lie the chain could contradict. Default
 * `false`, so PTS-only play — which is every existing caller and every existing
 * test — keeps the 1100 ms `OPP_READY_MS` timer exactly.
 *
 * Note what this deliberately is NOT: a way for the chain to influence the
 * match. Nothing here reaches settlement; `(lobby, seed, picks)` is still the
 * whole input, and `test/determinism.test.ts`'s source scan still forbids this
 * file from naming the referee routes, the market layer or the SDK — which is
 * also why the staking machine itself lives in `src/state/stake.ts` and this
 * seam is one boolean wide.
 */
export interface MatchOptions {
  /** An on-chain seat is held for this duel, so the opponent's ready must come
   *  from `DuelJoined` (via `actions.oppReady`) rather than from a timer. */
  liveSeats?: boolean;
  /**
   * The option book this match's cards are priced off, or `undefined` — and
   * `undefined` is the default, which is every existing caller and every
   * existing test.
   *
   * **Plain data, and that is the whole seam.** This file may not reach for a
   * market source, a route or an SDK — the source scan in
   * `test/determinism.test.ts` forbids naming any of them, and rightly: a match
   * that could *fetch* would be a match whose legs depend on what a remote host
   * felt like saying at render time. What arrives here instead is a value
   * somebody else already read, handed in from `App` exactly the way
   * `liveSeats` is, and frozen below the moment a match is dealt.
   *
   * With it absent, the book deals no cards, `priced` returns every leg by
   * identity and this file behaves — line for line, byte for byte — as it did
   * before options existed.
   */
  book?: OptionBook;
}

export function useMatch(route: Route, options: MatchOptions = {}) {
  const [state, setState] = useState<MatchState>(() => initialState(route));
  const liveSeats = options.liveSeats === true;

  /**
   * The book, frozen at deal time.
   *
   * A quote is a moment. The cards on the pick screen state a strike, a
   * probability and a payout, and those three numbers must not move under a
   * player between reading a card and pressing it — so the match takes one
   * snapshot and keeps it, rather than re-reading a book that refreshes every
   * thirty seconds.
   *
   * "Deal time" is the first render of a `(lobby, seed)` pair that actually has
   * a book to take, which is the second clause below: a link opened cold mounts
   * before the market read resolves, and freezing the `undefined` it saw on
   * frame one would hand every such match a seeded slip for no reason. After
   * that first capture the book is never replaced — only a new deal replaces it.
   */
  const [book, setBook] = useState<OptionBook | null>(null);
  const bookKey = useRef<string>("");
  const offered = options.book;
  useEffect(() => {
    const key = `${state.lobbyId ?? "none"}:${state.seed}`;
    if (bookKey.current !== key) {
      bookKey.current = key;
      setBook(offered ?? null);
    } else if (book === null && offered) {
      setBook(offered);
    }
  }, [state.lobbyId, state.seed, offered, book]);

  // The clock runs outside React's render, so it reads the tab through a ref.
  const stateRef = useRef(state);
  stateRef.current = state;

  const patch = useCallback((p: Patch) => {
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
  }, []);

  // One clock for the whole match. The tape uses it to advance, and a timed
  // parlay uses it twice over: every tick re-runs `derived` so `secondsLeft`
  // counts down, and the tick that finds the deadline behind us locks the slip
  // with the button's own patch. An untimed parlay (NORMAL) is not ticked at
  // all, so nothing about that path — renders included — changes.
  useEffect(() => {
    const id = setInterval(() => {
      const cur = stateRef.current;
      if (cur.tab === "duel") {
        setState((s) => ({ ...s, tick: s.tick + 1 }));
        return;
      }
      if (cur.tab !== "parlay" || cur.deadline === null) return;
      if (Date.now() >= cur.deadline) {
        sfx("countdown.expire");
        setState((s) => (s.tab === "parlay" ? { ...s, ...LOCK_PATCH } : s));
      } else {
        setState((s) => ({ ...s, tick: s.tick + 1 }));
      }
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
  //
  // `liveSeats` is the one thing that can switch this off, and it switches off
  // only from the moment a stake is actually held on chain: until then — which
  // is all of PTS-only play, and the whole of every existing test — the 1100 ms
  // timer runs exactly as it always has.
  const inRoom = state.tab === "room" && state.lobbyId !== null;
  useEffect(() => {
    if (!inRoom || state.ready.opp || liveSeats) return;
    const t = setTimeout(() => patch((s) => ({ ready: { ...s.ready, opp: true } })), OPP_READY_MS);
    return () => clearTimeout(t);
  }, [inRoom, state.ready.opp, state.lobbyId, patch, liveSeats]);

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
        deadline: null,
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
      /** The window the published duel runs on. Nothing else recomputes: the
       *  mode is orthogonal to the book — it picks the settle print, the target
       *  scale, the payout boost and the pick clock, none of which touch which
       *  tickers get dealt or how many legs the book can fill. */
      setFormMode: (mode: Mode) => patch((s) => ({ form: { ...s.form, mode } })),
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
            mode: s.form.mode,
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
      /**
       * The other seat filled — for real.
       *
       * The same patch the `OPP_READY_MS` timer applies, reachable by a caller
       * that watched the escrow's `DuelJoined` instead of a clock. It exists so
       * that `liveSeats` can suppress the timer without leaving the room with no
       * way to ever start; it carries no data into settlement, and it is
       * idempotent, so a poller may call it on every tick.
       */
      oppReady: () => patch((s) => ({ ready: { ...s.ready, opp: true } })),
      /** Both ready: the spin decides what you play on. A no-op until then. */
      beginSpin: () =>
        patch((s) => (s.ready.me && s.ready.opp ? { tab: "spin" } : {})),
      /** Walk out. Someone else's lobby goes back on the board open. */
      leaveRoom: () =>
        patch((s) => ({
          tab: "battles",
          lobbyId: null,
          ready: NOT_READY,
          deadline: null,
          lobbies: s.lobbies.map((l) =>
            l.id === s.lobbyId && !l.mine ? { ...l, status: "open", opponent: null } : l,
          ),
        })),

      // ---------- the match ----------

      /** Abandon the spin. */
      closeSpin: () => patch({ tab: "battles", lobbyId: null, ready: NOT_READY, deadline: null }),
      claim: () => patch({ tab: "study" }),
      /** Into the pick phase, and the pick clock starts here. Study itself is
       *  untimed — the mode's `pickSeconds` bounds the slip, not the reading. */
      doneStudy: () =>
        patch((s) => ({
          tab: "parlay",
          deadline: deadlineFor(s.lobbies.find((l) => l.id === s.lobbyId) ?? null),
        })),
      pick: (sym: string, cardId: string) =>
        patch((s) => ({ myPicks: { ...s.myPicks, [sym]: cardId } })),
      lockParlay: () => patch(LOCK_PATCH),
      settle: () => patch({ tab: "result" }),
      backToBattles: () =>
        patch({ tab: "battles", lobbyId: null, ready: NOT_READY, tick: 0, deadline: null }),
    };
  }, [patch]);

  const derived = useMemo(() => {
    const lobby = state.lobbies.find((l) => l.id === state.lobbyId) ?? null;
    const opponent = lobby ? opponentOf(lobby) : null;
    // The mode spec drives four things at once: the salts, the settle print,
    // every leg's target and the payout. With no lobby on screen there is no
    // duel to shape, and NORMAL is the identity of all four — full tape,
    // salt 0, ×1 targets, ×1 odds — so the no-lobby path stays inert.
    const spec = lobby ? MODES[lobby.mode] : MODES.NORMAL;
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

    /**
     * The cards this match's frozen book deals, per ticker — the same
     * `cardsForTicker` call the pick screen's grid is drawn from, on the same
     * frozen object.
     *
     * **This is where the legs are priced, and it is why.** The slip, the
     * result screen, the tape and the escrow all read a leg; the pick screen
     * reads a card. Pricing the leg anywhere but off the card it came from left
     * exactly one surface right and every other surface printing the retired
     * clamped ratio (`desk/optionize.multiplierFor`) for the same bet. So the
     * card is dealt once, here, and the leg is derived from it — plan 6 §9 item
     * 2 ("every rendered multiplier traces to a live ask or to
     * `calculatePayout`") holds at the source rather than per screen.
     *
     * A ticker enters the map only when its book deals at least one card. No
     * book, no chain, no fillable order, or a chain whose every delta falls
     * outside all four bands all leave it out — and a ticker that is out keeps
     * the seeded leg it has always had.
     *
     * Nothing here can fetch: `book` is a plain value `App` already read and
     * this hook already froze, and `vanillaPayout` is local arithmetic. The
     * determinism scan is untouched.
     */
    const dealt = new Map<string, readonly (LiveCard | null)[]>();
    if (book) {
      for (const sym of arena) {
        const cards = cardsForTicker(
          sym,
          book.chain[sym] ?? [],
          book.spot[sym] ?? 0,
          vanillaPayout,
        );
        if (cards) dealt.set(sym, cards);
      }
    }

    /**
     * A dealt leg, re-denominated in the option that stands for it — or handed
     * straight back when the book deals no card for that tier on that side,
     * which is the default and is fourteen of the eighteen board names even when
     * there is a book.
     *
     * `legFromLiveCard` swaps five numbers on the leg (`t`, `mult`, `prob`,
     * `px`, `strike`) and touches nothing else: the ticker, the direction and
     * the tier are still whatever the seed and the pick decided. So the leg that
     * reaches `settle`, `summarize` and the tape is the same *shape* either way,
     * and both paths run the same `legState`.
     *
     * The mode's `targetScale` is deliberately not applied on the market path.
     * It shrinks a *seeded* target so a shorter window has a reachable line; a
     * listed strike is not ours to shrink, and scaling one would put a number on
     * the card that no venue quotes. The window premium still rides on the odds
     * (`spec.oddsBoost`, inside `summarize`) exactly as before.
     */
    const priced = (leg: ParlayLeg): ParlayLeg => {
      const card = slotFor(dealt.get(leg.sym), leg.tier, leg.dir === "over" ? "bull" : "bear");
      return card ? legFromLiveCard(leg, card, book?.spot[leg.sym] ?? 0) : leg;
    };

    // A ticker without a pick shows at EVEN, bullish — a preview, not a position.
    const myLegs: readonly ParlayLeg[] = arena.map((sym) =>
      priced(
        myPicks[sym]
          ? legForCard(sym, myPicks[sym]!, spec.targetScale)
          : buildLeg(sym, "over", "EVEN", spec.targetScale),
      ),
    );
    const oppLegs: readonly ParlayLeg[] = arena.map((sym) =>
      priced(legForCard(sym, oppPicks[sym]!, spec.targetScale)),
    );

    const stakePoints = lobby ? stakePointsFor(lobby) : 0;
    // `MODE_SALT` moves the whole window rather than shortening the same one,
    // so the same seed in a different mode is a genuinely different draw and
    // not a prefix of the NORMAL tape. `MODE_SALT.NORMAL === 0` keeps today's
    // series byte-identical.
    const studySalt = 1 + state.seed * 3 + MODE_SALT[spec.key];
    const fightSalt = 2 + state.seed * 3 + MODE_SALT[spec.key];
    const pos = Math.min(spec.settleAt, Math.max(2, state.tick * TAPE_STEP));
    // Whole seconds still on the pick clock. Recomputed here rather than kept
    // in state so it can never disagree with `deadline`; the 120ms interval
    // bumps `tick`, which re-runs this memo, which is what makes it count.
    const secondsLeft =
      state.deadline === null ? null : Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));

    const verdict =
      lobby && opponent
        ? settle(myLegs, oppLegs, arena, fightSalt, spec.settleAt, YOU.name, opponent.name)
        : null;
    const mySummary = summarize(myLegs, stakePoints, spec.oddsBoost);
    const oppSummary = summarize(oppLegs, stakePoints, spec.oddsBoost);

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
      briefs: briefsFor(arena, studySalt, spec.settleAt),
      /** Identity of this match for anything cached per (lobby, seed) — the news wire. Null-safe: `lobby` can be null mid-render. */
      matchKey: `${state.lobbyId ?? "none"}:${state.seed}`,
      /**
       * The book this match was dealt against, frozen — `null` on every seeded
       * path, which is the default.
       *
       * Handed to the pick screen so a card can show *where* its numbers came
       * from. It is the same object `myLegs` were priced off, deliberately: two
       * reads of one snapshot cannot disagree, and a card claiming a strike the
       * leg does not hold would be the worst bug this feature could have.
       */
      optionBook: book,
      studySalt,
      fightSalt,
      /** This match's mode spec — the window, the targets, the odds, the clock. */
      mode: spec,
      /** The print the duel settles on: the whole tape on NORMAL, less on the
       *  shorter modes. Every view that used to reach for `TAPE_LEN` reads this. */
      settleAt: spec.settleAt,
      /** Print index the tape has played up to. */
      pos,
      /** Whole seconds left to pick, or `null` when the mode is untimed. */
      secondsLeft,
      raceDone: pos >= spec.settleAt,
      verdict,
      /**
       * The notional pool, and the entry that is half of it.
       *
       * ## Why the glyph changed
       *
       * These read `"4.80 ETH"` until the honesty pass. Nothing on this path is
       * staked, nothing is paid, and the only quantity that ever moves is
       * points (`stakePointsFor` in `src/data/lobbies.ts` — the seeded
       * `prize: 4.8` is 2,400 PTS an entry and nothing else). The unit word was
       * the whole of the claim: a player reading "4.80 ETH" on the room and the
       * result screen is reading ether, which is not a thing this app has, has
       * held, or has ever transferred.
       *
       * `Ξ` is what `src/ui/LobbyCards.tsx` already prints for **this exact
       * number** — `lobby.prize` renders as `4.80 Ξ pool` on the board card a
       * player clicks to get here — so the choice is not between two units but
       * between one number rendered two ways on two screens. A board that says
       * `Ξ` and a room that says `ETH` is a conversion nobody performed, which
       * is the shape of six of the seven money bugs in `docs/reality-check.md`.
       * The arena's real, USDC-denominated pool goes through `usdc(...)` in
       * `src/state/battle.ts` and is deliberately *not* this.
       *
       * The glyph is a mark on a notional figure, not a promise, and what says
       * so is `NOTIONAL_POOL_LINE` — "notional · nothing is held · settles in
       * PTS" — which is rendered beside every one of these on every surface
       * that prints them (`LobbyCards`, `CreateLobby`, `Room`, `Result`). This
       * change is belt-and-braces to that: the disclosure is what carries the
       * truth, and the unit should not be quietly arguing with it.
       *
       * Not converted to `PTS` here, though that is the unit that actually
       * moves: `prize` is 4.8 and the pool in points is 4,800, so printing
       * `"4.80 PTS"` would be a fresh thousand-fold error, and printing
       * `"4,800 PTS"` would put a second scale of the same pool on screen
       * beside `stakePoints`. One number, one scale, one disclosure.
       */
      prizeLabel: lobby ? `${lobby.prize.toFixed(2)} Ξ` : "—",
      entryLabel: lobby ? `${(lobby.prize / 2).toFixed(2)} Ξ` : "—",
      formPrizeLabel: `${state.form.prize.toFixed(2)} Ξ`,
      formEntryLabel: `${(state.form.prize / 2).toFixed(2)} Ξ`,
    };
  }, [
    state.lobbies,
    state.lobbyId,
    state.seed,
    state.ready,
    state.myPicks,
    state.tick,
    state.deadline,
    state.form.prize,
    // Frozen at deal time, so this changes at most once per match — and never
    // at all on the seeded path, where it is `null` for the life of the app.
    book,
  ]);

  // Everything the match plays because state MOVED — the beds, the ready
  // edges, the leg hits, the riser into the settle. Read-only and inert when
  // there is no audio context (every test), so it adds no timer and no render.
  useMatchSound(state, derived);

  return { state, derived, actions };
}

export type Match = ReturnType<typeof useMatch>;
