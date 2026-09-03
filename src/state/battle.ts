import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AutoMode, Direction, MarketFilter, Tab } from "../types.ts";
import { TAPE_LEN } from "../engine/tape.ts";
import { activeUniverse, arena, fightSalt, myLegs, oppLegs, studySalt, tapeStep } from "./selectors.ts";

export interface BattleState {
  tab: Tab;
  /** Sector filter on the contract pool. `"ALL"` or a sector name. */
  pool: string;
  /** Underlying selected on the MM pricing table. */
  asset: string;
  /** Prize pool in ETH. */
  prize: number;
  /** Raw text in the prize field — kept apart from `prize` so a half-typed
   *  "1." survives until blur. */
  prizeText: string;
  lobbyName: string;
  published: boolean;
  started: boolean;

  picks: string[];
  bans: string[];
  oppPicks: string[];
  oppBans: string[];
  legDir: Record<string, Direction>;
  oppDir: Record<string, Direction>;

  /** Advances every 120ms while a countdown or tape is running. */
  tick: number;
  market: MarketFilter;
  /** Symbols the admin dropped from the board. */
  excluded: string[];
  picksMax: number;
  chartCount: number;
  tapeSpeed: 32 | 64 | 128;

  auto: AutoMode | null;
  /** Reseeds every tape when the autopilot restarts. */
  seed: number;
}

export const INITIAL_STATE: BattleState = {
  tab: "lobby",
  pool: "ALL",
  asset: "ETH",
  prize: 5.0,
  prizeText: "5.00",
  lobbyName: "Room #4471",
  published: false,
  started: false,
  picks: [],
  bans: [],
  oppPicks: [],
  oppBans: [],
  legDir: {},
  oppDir: {},
  tick: 0,
  market: "MIXED",
  excluded: [],
  picksMax: 3,
  chartCount: 5,
  tapeSpeed: 64,
  auto: null,
  seed: 0,
};

type Patch = Partial<BattleState> | ((s: BattleState) => Partial<BattleState>);

const OPPONENT = "kazuo.eth";

/**
 * How the local player is labelled on the board.
 *
 * Passed in rather than derived because the source of truth is the connected
 * wallet, which lives outside this store (`src/data/wallet.ts`). Omitting it
 * gives the design's `"You"` placeholder, which is what the headless tests and
 * the mock wallet run on.
 *
 * This is the hook PvP lands on: today one identity comes in and the opponent
 * is the `OPPONENT` fixture; multiplayer replaces that fixture with a second
 * real identity off the wire and nothing else in this file has to move.
 */
export interface PlayerIdentity {
  /** Display name — a short address, or an ENS name once resolved. */
  name: string;
  /** Two characters for the avatar. */
  init: string;
  /** The line under the name. */
  meta: string;
}

const ANON: PlayerIdentity = {
  name: "You",
  init: "YO",
  meta: "bankroll 2.40 ETH",
};

export function useBattle(player: PlayerIdentity = ANON) {
  const [state, setState] = useState<BattleState>(INITIAL_STATE);

  // Timers and the autopilot script run outside React's render, so they read
  // state through a ref rather than through a stale closure.
  const stateRef = useRef(state);
  stateRef.current = state;

  const queue = useRef<ReturnType<typeof setTimeout>[]>([]);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  const patch = useCallback((p: Patch) => {
    setState((s) => ({ ...s, ...(typeof p === "function" ? p(s) : p) }));
  }, []);

  const stopAuto = useCallback(() => {
    queue.current.forEach(clearTimeout);
    queue.current = [];
    if (poll.current) clearInterval(poll.current);
    poll.current = null;
    setState((s) => (s.auto ? { ...s, auto: null } : s));
  }, []);

  // ---------- autopilot: it drafts, studies, picks and fights on its own ----------

  const botPick = useCallback((side: "me" | "opp") => {
    setState((s) => {
      const taken = [...s.picks, ...s.oppPicks, ...s.bans, ...s.oppBans];
      const avail = activeUniverse(s)
        .map((u) => u.sym)
        .filter((sym) => !taken.includes(sym));
      if (!avail.length) return s;
      const sym = avail[Math.floor(Math.random() * avail.length)]!;
      if (side === "me") {
        return s.picks.length < s.picksMax ? { ...s, picks: [...s.picks, sym] } : s;
      }
      return s.oppPicks.length < s.picksMax ? { ...s, oppPicks: [...s.oppPicks, sym] } : s;
    });
  }, []);

  const botBan = useCallback((side: "me" | "opp") => {
    setState((s) => {
      const taken = [...s.picks, ...s.oppPicks, ...s.bans, ...s.oppBans];
      const avail = activeUniverse(s)
        .map((u) => u.sym)
        .filter((sym) => !taken.includes(sym));
      if (!avail.length) return s;
      const sym = avail[Math.floor(Math.random() * avail.length)]!;
      return side === "me"
        ? { ...s, bans: [...s.bans, sym] }
        : { ...s, oppBans: [...s.oppBans, sym] };
    });
  }, []);

  const runAuto = useCallback(
    (mode: AutoMode) => {
      stopAuto();

      let cursor = 500;
      const q: ReturnType<typeof setTimeout>[] = [];
      /** Schedule `fn` at the current cursor, then advance the cursor by `gap`. */
      const at = (fn: () => void, gap: number) => {
        q.push(setTimeout(fn, cursor));
        cursor += gap;
      };

      const n = stateRef.current.picksMax;

      patch((s) => ({
        auto: mode,
        seed: Math.floor(Math.random() * 100000),
        published: true,
        started: false,
        picks: [],
        bans: [],
        oppPicks: [],
        oppBans: [],
        legDir: {},
        oppDir: {},
        tick: 0,
        tab: "draft",
        lobbyName:
          mode === "spectate"
            ? `Room #${4000 + Math.floor(Math.random() * 900)}`
            : s.lobbyName,
      }));

      for (let i = 0; i < n; i++) {
        at(() => botPick("me"), 620);
        at(() => botPick("opp"), 620);
      }
      at(() => botBan("me"), 560);
      at(() => botBan("opp"), 560);
      at(() => botBan("me"), 560);
      at(() => botBan("opp"), 800);
      at(() => patch({ started: true }), 900);
      at(() => patch({ tab: "study" }), 3400);
      at(() => patch({ tab: "pick", tick: 0 }), 600);

      for (let i = 0; i < n; i++) {
        at(() => {
          setState((s) => {
            const leg = myLegs(s)[i];
            if (!leg) return s;
            const dir: Direction = Math.random() < 0.5 ? "over" : "under";
            return { ...s, legDir: { ...s.legDir, [leg.sym]: dir } };
          });
        }, 520);
      }

      at(() => {
        setState((s) => {
          const dirs: Record<string, Direction> = {};
          for (const sym of s.oppPicks) dirs[sym] = Math.random() < 0.5 ? "over" : "under";
          return { ...s, oppDir: dirs };
        });
      }, 700);

      at(() => patch({ tab: "live", tick: 0 }), 200);
      at(() => {
        poll.current = setInterval(() => {
          const s = stateRef.current;
          if (s.tab === "live" && s.tick * tapeStep(s) >= TAPE_LEN) {
            if (poll.current) clearInterval(poll.current);
            poll.current = null;
            queue.current.push(
              setTimeout(() => patch({ tab: "result", auto: null }), 1400),
            );
          }
        }, 200);
      }, 0);

      queue.current = q;
    },
    [botBan, botPick, patch, stopAuto],
  );

  // ---------- clock ----------

  useEffect(() => {
    const id = setInterval(() => {
      const t = stateRef.current.tab;
      if (t === "pick" || t === "live") setState((s) => ({ ...s, tick: s.tick + 1 }));
    }, 120);
    return () => {
      clearInterval(id);
      queue.current.forEach(clearTimeout);
      queue.current = [];
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
    };
  }, []);

  // ---------- actions ----------

  const actions = useMemo(
    () => ({
      /** Navigate, cancelling any autopilot run — a manual click always wins. */
      go: (tab: Tab) => () => {
        stopAuto();
        patch({ tab });
      },
      goStudy: () => patch({ tab: "study" }),
      goPick: () => patch({ tab: "pick", tick: 0 }),
      startFight: () => patch({ tab: "live", tick: 0 }),
      goResult: () => patch({ tab: "result" }),
      startGame: () => patch({ started: true }),

      setPool: (pool: string) => patch({ pool }),
      setAsset: (asset: string) => patch({ asset }),
      setTapeSpeed: (tapeSpeed: 32 | 64 | 128) => patch({ tapeSpeed }),

      setMarket: (market: MarketFilter) =>
        patch({ market, picks: [], bans: [], legDir: {} }),

      toggleExcluded: (sym: string) =>
        patch((s) => {
          const on = !s.excluded.includes(sym);
          return {
            excluded: on ? [...s.excluded, sym] : s.excluded.filter((x) => x !== sym),
            picks: on ? s.picks.filter((x) => x !== sym) : s.picks,
          };
        }),

      onPrizeInput: (raw: string) => {
        const cleaned = raw.replace(/[^0-9.]/g, "");
        const f = parseFloat(cleaned);
        patch(
          Number.isFinite(f)
            ? { prizeText: cleaned, prize: Math.max(0.1, Math.min(999, f)) }
            : { prizeText: cleaned },
        );
      },
      onPrizeBlur: () => patch((s) => ({ prizeText: s.prize.toFixed(2) })),
      prizeUp: () =>
        patch((s) => {
          const v = Math.min(999, +(s.prize + 0.5).toFixed(2));
          return { prize: v, prizeText: v.toFixed(2) };
        }),
      prizeDown: () =>
        patch((s) => {
          const v = Math.max(0.1, +(s.prize - 0.5).toFixed(2));
          return { prize: v, prizeText: v.toFixed(2) };
        }),
      setLobbyName: (lobbyName: string) => patch({ lobbyName }),
      publishLobby: () => patch({ published: true, tab: "draft" }),

      /**
       * Adopt a duel room's tape seed.
       *
       * `studySalt`/`fightSalt` derive from `seed`, so setting it from the room
       * is what makes two browsers draw the same random walk.
       */
      setSeed: (seed: number) => patch({ seed }),

      picksUp: () => patch((s) => ({ picksMax: Math.min(4, s.picksMax + 1) })),
      picksDown: () =>
        patch((s) => {
          const next = Math.max(2, s.picksMax - 1);
          return { picksMax: next, picks: s.picks.slice(0, next) };
        }),
      chartsUp: () => patch((s) => ({ chartCount: Math.min(6, s.chartCount + 1) })),
      chartsDown: () => patch((s) => ({ chartCount: Math.max(3, s.chartCount - 1) })),

      /** Draft a ticker, or un-draft it. No-op while the autopilot is driving. */
      pick: (sym: string) =>
        patch((s) => {
          if (s.auto) return {};
          if (s.bans.includes(sym) || s.oppBans.includes(sym) || s.oppPicks.includes(sym)) return {};
          if (s.picks.includes(sym)) return { picks: s.picks.filter((x) => x !== sym) };
          return s.picks.length >= s.picksMax ? {} : { picks: [...s.picks, sym] };
        }),

      /** Banning also releases the ticker if you had drafted it. */
      ban: (sym: string) =>
        patch((s) => ({
          bans: s.bans.includes(sym) ? s.bans.filter((x) => x !== sym) : [...s.bans, sym],
          picks: s.picks.filter((x) => x !== sym),
        })),

      setLegDir: (sym: string, dir: Direction) =>
        patch((s) => ({ legDir: { ...s.legDir, [sym]: dir } })),

      /** Join an open room: fresh board, straight to the draft. */
      joinRoom: () => {
        stopAuto();
        patch({
          tab: "draft",
          picks: [],
          bans: [],
          oppPicks: [],
          oppBans: [],
          started: false,
          published: true,
        });
      },
      /** Cash a roulette win: a crypto-only draft with the landed asset already
       *  in your first slot and the house covering a 0.50 ETH pool. */
      claimFreeBattle: (sym: string) => {
        stopAuto();
        patch({
          tab: "draft",
          market: "CRYPTO",
          excluded: [],
          picks: [sym],
          bans: [],
          oppPicks: [],
          oppBans: [],
          legDir: {},
          oppDir: {},
          started: false,
          published: true,
          prize: 0.5,
          prizeText: "0.50",
          lobbyName: `Free spin · ${sym}`,
        });
      },
      runDemo: () => runAuto("demo"),
      runSpectate: () => runAuto("spectate"),
      stopAuto,
    }),
    [patch, runAuto, stopAuto],
  );

  // ---------- derived ----------

  const derived = useMemo(() => {
    const spectating = state.auto === "spectate";
    const my = myLegs(state);
    const opp = oppLegs(state);
    const step = tapeStep(state);
    const pos = Math.min(TAPE_LEN, Math.max(2, state.tick * step));

    return {
      universe: activeUniverse(state),
      myLegs: my,
      oppLegs: opp,
      arena: arena(state),
      studySalt: studySalt(state),
      fightSalt: fightSalt(state),
      /** Print index the fight tape has played up to. */
      pos,
      raceDone: pos >= TAPE_LEN,
      spectating,
      p1Name: spectating ? "mira.base" : player.name,
      p1Init: spectating ? "MI" : player.init,
      p1Meta: spectating ? "bankroll 6.80 ETH · spectating" : player.meta,
      opponent: OPPONENT,
      prizeLabel: `${state.prize.toFixed(2)} ETH`,
      entryLabel: `${(state.prize / 2).toFixed(2)} ETH`,
    };
  }, [state, player]);

  return { state, derived, actions };
}

export type Battle = ReturnType<typeof useBattle>;
