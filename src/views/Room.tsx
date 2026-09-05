import { useEffect } from "react";
import {
  REFUND_TIMEOUT_HOURS,
  payoutOf,
  eth as ethText,
} from "../desk/escrow.ts";
import { baseExplorerAddress, baseExplorerTx } from "../data/base-network.ts";
import type { DuelStake } from "../state/stake.ts";
import { CardArt } from "../components/CardArt.tsx";
import { PlayerMark } from "../components/PlayerMark.tsx";
import { RANK_COLOR, RankBadge } from "../components/RankBadge.tsx";
import {
  LEADERBOARD,
  buildYou,
  formRun,
  pct1,
  positionOf,
  pts,
  usd,
  usdSigned,
  type LeaderPlayer,
} from "../data/leaderboard.ts";
import { MARKET_COLOR, MARKET_LABEL, bookOf } from "../data/lobbies.ts";
import { PLAYER } from "../data/rewards.ts";
import { SECTORS, bookForSectors, sectorChips, symsOfSector } from "../data/sectors.ts";
import { MODES, modeTag, type ModeSpec } from "../data/modes.ts";
import { playClip, sfx, startTrack, stopTrack } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, miniTag, tag } from "../theme.ts";
import type { LobbyDef, Player, SectorKey } from "../types.ts";
import { LadderTrend } from "../ui/LadderRow.tsx";

/** Native `title` for a sector chip — same cheap echo the lobby cards give
 *  theirs: the group's tickers, or the whole book behind a collapsed preset
 *  chip. The rich tooltip lives on /create, where there is room for it. */
function chipTitle(key: string, label: string, sectors: readonly SectorKey[]): string | undefined {
  if (key in SECTORS) return `${label} — ${symsOfSector(key as SectorKey).join(" · ")}`;
  if (key.startsWith("+")) return undefined;
  return `${label} — ${bookForSectors(sectors).join(" · ")}`;
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE SEAT DOSSIER — WHERE ITS NUMBERS COME FROM
 * ────────────────────────────────────────────────────────────────────────────
 * A seat is a `Player`: name, initial, colour. That is the whole model, and it
 * is deliberately thin — `types.ts` describes who is sitting there, not how
 * good they are. The stat line the ladder already computes for the SAME people
 * lives in `data/leaderboard.ts`, keyed by a slug id.
 *
 * The bridge is the NAME. `PERSONAS` is built from `OPPONENTS` and
 * `SETTLED_CASES` with `id = slug(name)`, so every opponent who can take a seat
 * in this room already has a row on the ladder, and `LEADERBOARD.find(byName)`
 * is a total lookup for all of them. Nothing is recomputed here: the dossier
 * prints the row, and if the ladder and this card ever disagreed it would mean
 * one of them had started deriving its own numbers.
 *
 * A name with no row renders the seat exactly as it rendered before the
 * dossier existed. That is not a defensive crouch — a custom lobby against a
 * player who is not on the roster is a legal state, and an empty middle is a
 * better answer than a card of em dashes.
 */
function rowByName(name: string): LeaderPlayer | null {
  return LEADERBOARD.find((p) => p.name === name) ?? null;
}

/**
 * Your row, when the caller has not supplied one.
 *
 * `YOU` is not a persona — there is no seeded row for you, because your record
 * is REAL: `state/rank.ts` builds it from the ledger, which is where your
 * battles and wins actually live. This room is not handed the ledger (see
 * `youRow` on the props below), so the fallback is the same construction at
 * the season's OPENING balance — `PLAYER.xp`, no matches yet — which is
 * precisely what `/ranks` shows for you before your first duel of the session.
 * Matching that beats inventing a record: the two screens agree at the start of
 * a session and the seam to keep them agreeing afterwards is one prop wide.
 *
 * Module-level because it is a pure constant; `buildYou` reads no clock and no
 * DOM.
 */
const YOU_BASELINE: LeaderPlayer = buildYou({ xp: PLAYER.xp, battles: 0, wins: 0 });

interface RoomProps {
  lobby: LobbyDef;
  you: Player;
  opponent: Player;
  /**
   * Your live ladder row, if the caller has one. `App` holds it as
   * `useRankProgress(ledger).you` — the very object `/ranks` sorts into the
   * table — and passing it here makes your seat dossier track the ledger
   * match by match instead of resting on `YOU_BASELINE`. Optional so this view
   * stays mountable from a test or a story with two `Player`s and nothing
   * else.
   */
  youRow?: LeaderPlayer;
  ready: { me: boolean; opp: boolean };
  entryLabel: string;
  prizeLabel: string;
  /**
   * The optional USDC side bet.
   *
   * Optional in the strongest sense: absent — a test, a story, a build with
   * `THETADUEL_STAKE` unset, a server with no escrow deployed, or the mock
   * wallet — this view renders **exactly** the DOM it rendered before staking
   * existed, which `test/stake.test.ts` asserts by string-comparing
   * `container.innerHTML`. `SideBet` below returns `null` for every one of those
   * cases, and a `null` child contributes no markup.
   *
   * It is also *only* a side bet: nothing on this screen converts between PTS
   * and USDC, no exchange rate is shown, and the entry figure above stays the
   * PTS pool's own ETH-denominated fiction, untouched.
   */
  stake?: DuelStake;
  onReady: () => void;
  onBegin: () => void;
  onLeave: () => void;
}

/**
 * The four beats of a match. Only DUEL depends on the mode: it is the line
 * that names the compression both players just agreed to — a Blitz duel is
 * fifteen minutes of tape played in a couple of seconds.
 */
const stepsFor = (mode: ModeSpec): readonly (readonly [string, string])[] => [
  ["SPIN", "the reel deals the tickers"],
  ["STUDY", "same charts, same wire"],
  ["PARLAY", "pick a card, blind"],
  ["DUEL", `${mode.duration} of tape in ${mode.wallSeconds}s`],
];

/**
 * Served by `index.ts` when the operator has dropped a file at
 * `src/assets/room-inspect.mp3`, and 404'd cleanly when they have not. The
 * engine treats both answers as normal, so the room is silent rather than
 * broken on a checkout without the asset.
 */
const ROOM_TRACK = "/assets/room-inspect.mp3";

/**
 * The lobby room. Both seats are taken; nothing happens until both players
 * have readied up. Readying is the moment your entry leaves the balance —
 * before that you can still walk out and the seat reopens.
 */
export function Room(p: RoomProps) {
  const color = MARKET_COLOR[p.lobby.market];
  const mode = MODES[p.lobby.mode];
  const steps = stepsFor(mode);
  const both = p.ready.me && p.ready.opp;

  /**
   * The waiting music. Leaving, navigating and the spin all unmount this view,
   * so the cleanup is the general case; the ready press stops it eagerly on
   * top of that, so the fade is already running while the seat locks rather
   * than starting when the reel takes the screen.
   */
  useEffect(() => {
    startTrack("room", ROOM_TRACK);
    return () => {
      stopTrack("room");
    };
  }, []);

  return (
    <div style={sx("padding:24px 28px;max-width:1100px;margin:0 auto")}>
      <div
        style={sx(
          `position:relative;overflow:hidden;border:1px solid ${color}59;border-radius:14px;background:${C.card};padding:24px 26px;min-height:150px`,
        )}
      >
        <CardArt id={p.lobby.id} color={color} />
        <div style={sx("position:relative;display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap")}>
          <div style={sx("flex:1;min-width:260px")}>
            <div style={sx("display:flex;align-items:center;gap:8px")}>
              <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${color}`)}>LOBBY</span>
              <span style={sx(tag(color))}>{MARKET_LABEL[p.lobby.market]}</span>
              {sectorChips(p.lobby.sectors).map((chip) => (
                <span
                  key={chip.key}
                  title={chipTitle(chip.key, chip.label, p.lobby.sectors)}
                  style={sx(`${miniTag(chip.color)};flex:none;white-space:nowrap`)}
                >
                  {chip.label}
                </span>
              ))}
              <span style={sx(modeTag(p.lobby.mode))}>
                {mode.label} · {mode.duration}
              </span>
              <span style={sx(tag(C.muted))}>{p.lobby.legs} LEGS</span>
              <span style={sx(tag(C.muted))}>1V1</span>
            </div>
            <h2 style={sx(`margin:12px 0 0;font:700 30px/1.05 ${SANS};letter-spacing:-.03em;text-shadow:0 2px 14px rgba(0,0,0,.7)`)}>
              {p.lobby.name}
            </h2>
            <div style={sx(`margin-top:10px;font:400 12px/1.5 ${SANS};color:${C.textSoft};max-width:520px;text-wrap:pretty`)}>
              The book is {bookOf(p.lobby).length} names. The spin deals {p.lobby.legs} of them and both slips run
              on exactly those — neither of you picks a ticker.
            </div>
          </div>
          <div style={sx("display:flex;gap:10px;flex:none")}>
            <Figure label="PRIZE POOL" value={p.prizeLabel} color={C.accent} />
            <Figure label="YOUR ENTRY" value={p.entryLabel} />
          </div>
        </div>
      </div>

      <div style={sx("display:grid;grid-template-columns:1fr auto 1fr;gap:18px;align-items:stretch;margin-top:18px")}>
        <Seat
          player={p.you}
          row={p.youRow ?? YOU_BASELINE}
          role={p.lobby.mine ? "host" : "challenger"}
          ready={p.ready.me}
          accent={C.indigo}
          action={
            p.ready.me ? null : (
              <button
                onClick={() => {
                  // The recorded clip REPLACES `room.ready.me` — the two
                  // together are one doubled transient. The opponent's ready
                  // and the both-ready chime stay synth: they are not this
                  // button.
                  playClip("exo-4", "/assets/exo-kill-4.mp3");
                  stopTrack("room");
                  p.onReady();
                }}
                style={sx(
                  `height:40px;width:100%;border:none;border-radius:8px;background:${C.accent};color:${C.bg};` +
                    `font:700 13px/1 ${SANS};cursor:pointer`,
                )}
              >
                Ready up · {p.entryLabel} entry
              </button>
            )
          }
          note={p.ready.me ? "Entry locked. Waiting on the other seat." : "Readying locks your entry into the pool."}
          stakePanel={<SideBet stake={p.stake} ready={p.ready.me} />}
        />

        <div style={sx("display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;min-width:64px")}>
          <span style={sx(`font:700 22px/1 ${MONO};letter-spacing:-.02em;color:${C.dim}`)}>VS</span>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${both ? C.green : C.faint}`)}>
            {both ? "2/2 READY" : `${Number(p.ready.me) + Number(p.ready.opp)}/2 READY`}
          </span>
        </div>

        <Seat
          player={p.opponent}
          row={rowByName(p.opponent.name)}
          role={p.lobby.mine ? "challenger" : "host"}
          ready={p.ready.opp}
          accent={C.red}
          action={null}
          note={p.ready.opp ? "Ready." : "Reading the lobby…"}
        />
      </div>

      <div style={sx(`display:flex;align-items:center;gap:10px;margin-top:18px;padding:14px 18px;border:1px solid ${C.border};border-radius:12px;background:${C.card};flex-wrap:wrap`)}>
        {steps.map(([k, v], i) => (
          <div key={k} style={sx("display:flex;align-items:center;gap:10px")}>
            <div>
              <div style={sx(`font:700 10px/1 ${MONO};letter-spacing:.12em;color:${i === 0 ? color : C.muted}`)}>{k}</div>
              <div style={sx(`margin-top:5px;font:400 10.5px/1 ${MONO};color:${C.faint}`)}>{v}</div>
            </div>
            {i < steps.length - 1 && <span style={sx(`margin:0 6px;color:${C.borderMid}`)}>→</span>}
          </div>
        ))}
        <div style={sx("flex:1")} />
        <button
          onClick={p.onLeave}
          style={sx(
            `height:36px;padding:0 14px;border:1px solid ${C.borderMid};border-radius:8px;background:transparent;` +
              `color:${C.muted};font:500 12px/1 ${SANS};cursor:pointer`,
          )}
        >
          Leave lobby
        </button>
        <button
          onClick={() => {
            playClip("exo-3", "/assets/exo-kill-3.mp3");
            p.onBegin();
          }}
          disabled={!both}
          style={sx(
            `height:36px;padding:0 16px;border:none;border-radius:8px;font:700 12.5px/1 ${SANS};white-space:nowrap;` +
              (both
                ? `background:${C.accent};color:${C.bg};cursor:pointer;animation:vcPulse 1.6s ease-in-out infinite`
                : `background:${C.border};color:${C.dim};cursor:not-allowed`),
          )}
        >
          {both ? "Both ready → lucky spin" : "Waiting for both players"}
        </button>
      </div>
    </div>
  );
}

/** One label/value line in the dossier grid. The label is dim and spaced, the
 *  value tabular — the same reading `Ranking.tsx`'s row drawer gives a figure,
 *  so a number means the same thing on both screens. */
function Line({
  label,
  value,
  sub,
  tone = C.text,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: string;
}) {
  return (
    <div style={sx("display:flex;flex-direction:column;gap:6px;min-width:0")}>
      <span style={sx(`font:500 8.5px/1 ${MONO};letter-spacing:.14em;color:${C.faint}`)}>{label}</span>
      <span
        style={sx(
          `font:700 13px/1 ${MONO};font-variant-numeric:tabular-nums;color:${tone};` +
            "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
        )}
      >
        {value}
      </span>
      {sub !== undefined && (
        <span
          style={sx(
            `font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim};` +
              "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
          )}
        >
          {sub}
        </span>
      )}
    </div>
  );
}

/**
 * The seat dossier: who you are about to play, in the ladder's own vocabulary.
 *
 * The room used to be a header row, a gap, and a status line — and the gap was
 * the largest thing on the screen at the moment a player most wants to know
 * something. This fills it with the five readings `/ranks` already computes for
 * this person, and computes none of them itself.
 *
 * The layout is two bands. The TOP band is identity-at-a-glance: the full
 * `RankBadge` (this is one of the few places with room for the sigil — see the
 * note in `LadderRow.tsx` about why the ladder itself renders a word instead),
 * the tier label, the season position, and the same `LadderTrend` line the
 * ladder draws, so a player's form reads identically in both places. The
 * BOTTOM band is the four figures, on a two-column grid that survives the seat
 * card being half a narrow screen.
 *
 * `FORM` is the one reading that is not a raw field: `formRun` counts the
 * trailing rising or falling windows of the trend line, and it is labelled as
 * form rather than as a win streak for the reason spelled out where it is
 * defined — the personas have career totals, not ordered results, so a "streak"
 * would be a number the app has never simulated.
 */
function Dossier({ row }: { row: LeaderPlayer }) {
  const tint = RANK_COLOR[row.rank.tier.name];
  const sector = SECTORS[row.sector];
  const mode = MODES[row.mode];
  const run = formRun(row.trend);
  const e = row.econ;

  // A fresh season has no record to report. "0 – 0 · 0.0%" is a true statement
  // that reads as a broken one, so an unplayed card says so in words.
  const played = row.battles > 0;
  const runTone = run.dir === "up" ? C.green : run.dir === "down" ? C.red : C.faint;
  const runText =
    run.length === 0
      ? "LEVEL"
      : `${run.dir === "up" ? "↑" : "↓"} ${run.length} WINDOW${run.length === 1 ? "" : "S"}`;

  return (
    <div
      data-seat-dossier={row.name}
      style={sx(
        `display:flex;flex-direction:column;gap:13px;padding:13px 14px;border:1px solid ${C.line};` +
          "border-radius:10px;background:rgba(9,9,11,.5)",
      )}
    >
      <div style={sx("display:flex;align-items:center;gap:12px;min-width:0")}>
        <RankBadge point={row.rank} size={46} />
        <div style={sx("min-width:0;flex:1")}>
          <div
            style={sx(
              `font:700 11px/1 ${MONO};letter-spacing:.12em;color:${tint};` +
                "white-space:nowrap;overflow:hidden;text-overflow:ellipsis",
            )}
          >
            {row.rank.label}
          </div>
          <div style={sx(`margin-top:7px;font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.faint}`)}>
            #{positionOf(row.xp)} SEASON · {pts(row.xp)} XP
          </div>
        </div>
        <div style={sx("display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex:none")}>
          <LadderTrend points={row.trend} color={tint} />
          <span style={sx(`font:500 8.5px/1 ${MONO};letter-spacing:.12em;color:${runTone}`)}>
            FORM {runText}
          </span>
        </div>
      </div>

      <div
        style={sx(
          "display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px 14px;" +
            `padding-top:12px;border-top:1px solid ${C.line}`,
        )}
      >
        {/* CAREER and COPIERS are the copy desk's dollars — the same fields
            `/ranks` prints, in the same units, through the same formatters.
            The desk's dollars are not the PTS ledger and there is no rate
            between them (see the currency note in `data/leaderboard.ts`); the
            unlock line below stays in XP for exactly that reason. */}
        <Line
          label="CAREER P/L"
          value={usdSigned(row.earnings)}
          sub={`${pts(row.battles)} BATTLES`}
          tone={row.earnings < 0 ? C.red : C.green}
        />
        <Line
          label="RECORD"
          value={played ? `${pts(row.wins)} – ${pts(row.battles - row.wins)}` : "NO DUELS YET"}
          sub={played ? `${pct1(row.winRate)} WIN RATE` : "SEASON OPENS HERE"}
        />
        <Line
          label={e.unlocked ? "COPIERS" : "COPY-TRADE"}
          value={e.unlocked ? pts(e.copiers) : "LOCKED"}
          sub={
            e.unlocked
              ? `≈ ${usd(e.daily)} / DAY`
              : `${pts(e.nextUnlock?.xpAway ?? 0)} XP TO ${e.nextUnlock?.tier.name ?? "SHARK"}`
          }
          tone={e.unlocked ? C.accent : C.dim}
        />
        <div style={sx("display:flex;flex-direction:column;gap:6px;min-width:0")}>
          <span style={sx(`font:500 8.5px/1 ${MONO};letter-spacing:.14em;color:${C.faint}`)}>
            SPECIALTY
          </span>
          <span style={sx(`${miniTag(sector.color)};align-self:flex-start;white-space:nowrap`)}>
            {sector.label}
          </span>
          <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>
            {mode.label}
          </span>
        </div>
      </div>
    </div>
  );
}

function Seat(p: {
  player: Player;
  /** The ladder row behind this seat, or `null` for a player off the roster —
   *  in which case the card is exactly the card it was before the dossier. */
  row: LeaderPlayer | null;
  role: string;
  ready: boolean;
  accent: string;
  action: React.ReactNode;
  note: string;
  /** The side bet, directly under the ready button it is driven by. `null`
   *  whenever staking is not live, which is the default build. */
  stakePanel?: React.ReactNode;
}) {
  return (
    <div
      data-seat={p.player.name}
      style={sx(
        `border:1px solid ${p.ready ? "rgba(74,222,128,.45)" : `${p.accent}55`};border-radius:12px;padding:18px;` +
          `background:linear-gradient(180deg,${p.accent}14,${C.card} 45%);display:flex;flex-direction:column;gap:14px`,
      )}
    >
      <div style={sx("display:flex;align-items:center;gap:12px")}>
        <PlayerMark name={p.player.name} initials={p.player.initial} bg={p.player.bg} size={44} />
        <div style={sx("min-width:0")}>
          <div style={sx(`font:700 16px/1 ${SANS}`)}>{p.player.name}</div>
          <div style={sx(`margin-top:5px;font:400 10px/1 ${MONO};color:${C.dim}`)}>{p.role}</div>
        </div>
        <div style={sx("flex:1")} />
        <span
          style={sx(
            `display:inline-flex;align-items:center;gap:6px;font:700 9px/1 ${MONO};letter-spacing:.12em;padding:6px 8px;border-radius:6px;` +
              (p.ready
                ? `border:1px solid rgba(74,222,128,.45);background:rgba(74,222,128,.12);color:${C.green}`
                : `border:1px solid ${C.borderMid};background:transparent;color:${C.dim}`),
          )}
        >
          <span style={sx(`width:6px;height:6px;border-radius:99px;background:${p.ready ? C.green : C.amber}` + (p.ready ? "" : ";animation:vcPulse 1.2s ease-in-out infinite"))} />
          {p.ready ? "READY" : "NOT READY"}
        </span>
      </div>
      {p.row && <Dossier row={p.row} />}
      {/* Still here, and still doing its job: the dossier fills the middle, but
          the ready button and the status line stay welded to the foot of the
          card so the two seats' controls line up whatever each dossier's
          height turns out to be. */}
      <div style={sx("flex:1")} />
      {p.action}
      {p.stakePanel}
      <div style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.faint}`)}>{p.note}</div>
    </div>
  );
}

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE SIDE BET — SIX STATES, AND THE SIXTH IS "PLAY ANYWAY"
 * ────────────────────────────────────────────────────────────────────────────
 *
 * The ready press does two things and they are deliberately not the same thing.
 * It locks the PTS entry — instantly, synchronously, exactly as it always has —
 * and it *starts* this. The points game never waits on a chain and never learns
 * whether one answered.
 *
 * So the machine reads:
 *
 *   idle ─► approving ─► staking ─► confirming ─► staked
 *              └────────────┴────────────┴──────────► failed
 *
 * and `failed` is not an error state. It is the game as it has always been:
 * every one of the escrow module's fourteen codes lands here, the duel goes
 * ahead, and the copy says so in the same sentence as the failure. A side bet
 * that could stop a match would not be a side bet.
 *
 * Two rules the copy obeys without exception:
 *
 *  - **Its own unit.** Every figure here is `$`, USDC. The PRIZE POOL and YOUR
 *    ENTRY figures above are the PTS game's ETH-denominated pool. No rate
 *    between them is shown, computed or implied, because there is not one.
 *  - **The six-hour line, on the winning side.** Adversarial review finding 4-1:
 *    `settle` has no timeout of its own and is closed by the first `refund`, so
 *    a loser who pulls their stake after the timeout forces a draw and the
 *    winner loses their profit. Nobody's principal is at risk either way — but
 *    the winner has to know to claim promptly, and this is where they are first
 *    told.
 */
function SideBet({ stake, ready }: { stake: DuelStake | undefined; ready: boolean }) {
  // Every "not live" case in one place: no stake layer, the flag off, no escrow
  // deployed, the mock wallet. `null` is what makes the flag-off DOM identical.
  //
  // The refusal copy is gated on the ready press, not on mount, and that is a
  // deliberate ordering rather than a hedge. **Byte-for-byte identity of the
  // un-staked room is the pinned property** — a build with the flag off, a build
  // with the flag on and no escrow deployed, and a build on the mock wallet must
  // all render exactly the room that existed before this file was touched, and
  // `test/stake.test.ts` compares `container.innerHTML` to prove it. An honest
  // refusal belongs at the point of action, which is the moment the player
  // readies up and *would* have staked; decorating an untouched screen with a
  // notice about a feature that is not on is the other kind of dishonesty.
  if (!stake) return null;
  if (!stake.available) {
    if (!stake.unavailable || !ready) return null;
    return (
      <div data-side-bet="unavailable" style={sx(PANEL(C.borderMid))}>
        <div style={sx(HEAD(C.dim))}>SIDE BET · UNAVAILABLE</div>
        <div style={sx(BODY)}>{stake.unavailable}</div>
      </div>
    );
  }

  const each = ethText(stake.amount);
  const takes = ethText(payoutOf(stake.amount));
  const tone =
    stake.phase === "failed"
      ? C.amber
      : stake.phase === "staked"
        ? C.green
        : stake.phase === "idle"
          ? C.dim
          : C.blue;

  return (
    <div data-side-bet={stake.phase} style={sx(PANEL(tone))}>
      <div style={sx("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
        <span style={sx(HEAD(tone))}>STAKE · BASE SEPOLIA</span>
        <span style={sx(`font:700 9px/1 ${MONO};letter-spacing:.14em;color:${tone}`)}>
          {PHASE_LABEL[stake.phase]}
        </span>
      </div>

      {/* The plan's sentence, verbatim. It is the only place the two currencies
          appear near each other, and it is there to say they are separate. */}
      <div style={sx(`margin-top:8px;font:700 12px/1.4 ${MONO};color:${C.text}`)}>
        Stake: {each} each in native test ETH. Winner takes the complete pool.
      </div>

      <div style={sx(BODY)}>{lineFor(stake, ready, takes)}</div>

      {stake.phase === "failed" && stake.error && (
        <div data-side-bet-error={stake.error.code} style={sx(`${BODY};color:${C.amber}`)}>
          {stake.error.message} {stake.error.recovery}
        </div>
      )}

      {/* The referee refused to pin the slip. The stake is still in the escrow
          and still comes back on the timeout — but no verdict will ever be
          signed for this duel, and saying so here is better than a CLAIM button
          that fails an entire match later. */}
      {stake.lockError && (
        <div data-side-bet-lock={stake.lockError.code} style={sx(`${BODY};color:${C.amber}`)}>
          {stake.lockError.message} {stake.lockError.recovery}
        </div>
      )}

      <div style={sx("display:flex;align-items:center;gap:10px;margin-top:9px;flex-wrap:wrap")}>
        <a
          href={baseExplorerAddress(stake.chainId, stake.escrow)}
          target="_blank"
          rel="noreferrer noopener"
          style={sx(`font:500 9.5px/1 ${MONO};letter-spacing:.08em;color:${C.dim}`)}
        >
          ESCROW {stake.escrow.slice(0, 6)}…{stake.escrow.slice(-4)} ↗
        </a>
        {stake.hash && (
          <a
            href={baseExplorerTx(stake.chainId, stake.hash)}
            target="_blank"
            rel="noreferrer noopener"
            style={sx(`font:500 9.5px/1 ${MONO};letter-spacing:.08em;color:${C.blue}`)}
          >
            1 TX ↗
          </a>
        )}
      </div>
    </div>
  );
}

const PHASE_LABEL: Record<DuelStake["phase"], string> = {
  idle: "NOT PLACED",
  approving: "PREPARING",
  staking: "STAKING",
  confirming: "WAITING FOR SEAT",
  staked: "STAKED",
  failed: "PTS-ONLY",
};

/** One line per phase. The two that mention six hours are the two where the
 *  player's money is actually sitting in the contract. */
function lineFor(stake: DuelStake, ready: boolean, takes: string): string {
  switch (stake.phase) {
    case "idle":
      return ready
        ? "No side bet on this duel."
        : "Ready up to place it. Declining costs nothing — the duel plays either way.";
    case "approving":
      return "Preparing the native test ETH stake.";
    case "staking":
      return "Sending the stake to the escrow on Base Sepolia.";
    case "confirming":
      return (
        "Your stake is held. Waiting for the other seat to fill on chain — the duel itself " +
        "does not wait."
      );
    case "staked":
      return (
        `Both stakes held. Winner takes the full ${takes}; the loser receives nothing. Claim within ` +
        `${REFUND_TIMEOUT_HOURS} hours: after that either player can pull their stake back, which voids the bet.`
      );
    case "failed":
      return "";
  }
}

const PANEL = (tone: string): string =>
  `margin-top:2px;padding:11px 12px;border:1px solid ${tone}4d;border-radius:10px;` +
  `background:rgba(9,9,11,.55)`;

const HEAD = (tone: string): string =>
  `font:700 9px/1 ${MONO};letter-spacing:.14em;color:${tone}`;

const BODY = `margin-top:7px;font:400 10.5px/1.55 ${MONO};color:${C.faint};text-wrap:pretty`;

function Figure({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={sx(`min-width:110px;padding:10px 12px;border:1px solid ${C.border};border-radius:10px;background:rgba(9,9,11,.6)`)}>
      <div style={sx(`font:500 8.5px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>{label}</div>
      <div style={sx(`margin-top:6px;font:700 16px/1 ${MONO}${color ? `;color:${color}` : ""}`)}>{value}</div>
    </div>
  );
}
