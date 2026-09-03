import { DRAFT_STEPS, DRAFT_STEP_STYLE } from "../data/fixtures.ts";
import { meta } from "../data/universe.ts";
import { fmtPx } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill, sectorColor, tag } from "../theme.ts";
import type { Asset, Leg } from "../types.ts";

interface SlotRow {
  slot: string;
  label: string;
  meta: string;
  prem: string;
  /** `B` bought, `S` banned; absent on an empty slot. */
  side?: "B" | "S";
  empty?: boolean;
}

/** Fixed board: `picksMax` pick slots then two ban slots, padded with placeholders. */
function pickRows(
  syms: readonly string[],
  bans: readonly string[],
  hint: string,
  picksMax: number,
): SlotRow[] {
  const rows: SlotRow[] = [];

  for (let i = 0; i < picksMax; i++) {
    const sym = syms[i];
    if (!sym) {
      rows.push({ slot: `P${i + 1}`, label: "Empty slot", meta: hint, prem: "—", empty: true });
      continue;
    }
    const u = meta(sym);
    rows.push({
      slot: `P${i + 1}`,
      label: sym,
      meta: `${u.name} · ${u.sector}`,
      prem: `$${fmtPx(u.px)}`,
      side: "B",
    });
  }

  for (let i = 0; i < 2; i++) {
    const sym = bans[i];
    if (!sym) {
      rows.push({ slot: "X", label: "No ban", meta: "ban slot open", prem: "—", empty: true });
      continue;
    }
    rows.push({
      slot: "X",
      label: sym,
      meta: `banned · ${meta(sym).sector}`,
      prem: "out",
      side: "S",
    });
  }

  return rows;
}

interface DraftProps {
  lobbyName: string;
  prizeLabel: string;
  p1Name: string;
  p1Init: string;
  p1Meta: string;
  opponent: string;
  picks: readonly string[];
  bans: readonly string[];
  oppPicks: readonly string[];
  oppBans: readonly string[];
  oppLegs: readonly Leg[];
  universe: readonly Asset[];
  picksMax: number;
  poolFilter: string;
  auto: boolean;
  started: boolean;
  onBack: () => void;
  onStartGame: () => void;
  onPoolFilter: (f: string) => void;
  onPick: (sym: string) => void;
  onBan: (sym: string) => void;
  onConfirm: () => void;
}

export function Draft(p: DraftProps) {
  const picksComplete = p.picks.length >= 3;

  const teamA = pickRows(
    p.picks,
    p.bans,
    p.auto ? "drafting…" : "tap a ticker to pick",
    p.picksMax,
  );

  // Without the autopilot the opponent has no real board, so their bans are
  // inferred: whatever is left once your picks, your bans and their legs are out.
  const oppBansDerived = p.universe
    .map((u) => u.sym)
    .filter(
      (sym) =>
        p.oppLegs.every((l) => l.sym !== sym) &&
        !p.picks.includes(sym) &&
        !p.bans.includes(sym),
    );

  const teamB = p.auto
    ? pickRows(p.oppPicks, p.oppBans, "opponent drafting…", p.picksMax)
    : pickRows(
        p.oppLegs.map((l) => l.sym),
        oppBansDerived.slice(0, 2),
        "opponent picking",
        p.picksMax,
      );

  const sectors: string[] = [];
  for (const u of p.universe) if (!sectors.includes(u.sector)) sectors.push(u.sector);
  const poolFilters = ["ALL", ...sectors.slice(0, 5)];

  return (
    <div style={sx("padding:24px 28px;max-width:1720px;margin:0 auto;overflow-x:auto")}>
      <div style={sx("display:flex;align-items:center;gap:16px;margin-bottom:20px")}>
        <button
          onClick={p.onBack}
          style={sx(
            `height:30px;padding:0 12px;border:1px solid ${C.borderMid};border-radius:8px;` +
              `background:transparent;color:${C.muted};font:500 12px/1 ${SANS};cursor:pointer`,
          )}
        >
          ← Battles
        </button>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>
          Draft · {p.lobbyName}
        </h2>
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.accent};` +
              "border:1px solid rgba(200,255,0,.3);background:rgba(200,255,0,.08);" +
              "border-radius:6px;padding:6px 8px",
          )}
        >
          {picksComplete ? "PICKS COMPLETE" : `PICK & BAN · ${p.picks.length} OF 3`}
        </span>
        <div style={sx("flex:1")} />
        <div style={sx("display:flex;align-items:center;gap:16px")}>
          <div
            style={sx(
              "display:flex;align-items:center;gap:10px;padding:8px 12px;" +
                "border:1px solid rgba(200,255,0,.28);border-radius:9px;background:rgba(200,255,0,.06)",
            )}
          >
            <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`)}>
              PRIZE POOL
            </span>
            <span style={sx(`font:700 17px/1 ${MONO};color:${C.accent}`)}>{p.prizeLabel}</span>
            <span
              style={sx(
                `font:500 8px/1 ${MONO};letter-spacing:.1em;color:${C.accent};` +
                  "border:1px solid rgba(200,255,0,.3);border-radius:4px;padding:4px 5px",
              )}
            >
              LOCKED
            </span>
          </div>
          <button
            onClick={p.onStartGame}
            style={sx(
              `height:36px;padding:0 16px;border-radius:8px;cursor:pointer;font:700 12px/1 ${SANS};` +
                (p.started
                  ? `border:1px solid ${C.borderMid};background:${C.raised};color:${C.green}`
                  : `border:none;background:${C.violet};color:${C.bg}`),
            )}
          >
            {p.started ? "Match started" : "Start game (admin)"}
          </button>
        </div>
      </div>

      <div
        style={sx(
          `position:relative;border:1px solid ${C.border};border-radius:12px;background:${C.panel};` +
            "padding:14px 16px;margin-bottom:20px;overflow:hidden",
        )}
      >
        <div style={sx(`position:absolute;top:0;left:0;width:34%;height:2px;background:${C.accent}`)} />
        <div style={sx("display:flex;align-items:center;gap:8px")}>
          {DRAFT_STEPS.map((s, i) => (
            <div
              key={i}
              style={sx(
                "flex:1;display:flex;flex-direction:column;gap:6px;align-items:flex-start;" +
                  `padding:9px 11px;border-radius:8px;background:${DRAFT_STEP_STYLE[s.s]}`,
              )}
            >
              <span style={sx(`font:500 8px/1 ${MONO};letter-spacing:.1em;opacity:.7`)}>{s.kind}</span>
              <span style={sx(`font:700 11px/1 ${MONO}`)}>{s.label}</span>
            </div>
          ))}
        </div>
      </div>

      <div
        style={sx(
          "display:grid;grid-template-columns:minmax(240px,280px) minmax(430px,1fr) minmax(240px,280px);" +
            "gap:20px;align-items:start;min-width:980px",
        )}
      >
        <TeamPanel
          accent="rgba(99,102,241,.4)"
          gradient="linear-gradient(180deg,rgba(99,102,241,.1),#0f0f11 40%)"
          avatarBg={C.indigo}
          avatarColor="#fff"
          initial={p.p1Init}
          name={p.p1Name}
          meta={p.p1Meta}
          rows={teamA}
          board={`${p.picks.length} picks · ${p.bans.length} bans`}
        />

        <div
          style={sx(
            `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`,
          )}
        >
          <div
            style={sx(
              `display:flex;align-items:center;gap:12px;padding:14px 16px;border-bottom:1px solid ${C.border}`,
            )}
          >
            <span style={sx(`font:700 13px/1 ${SANS}`)}>Contract pool</span>
            <div style={sx("display:flex;gap:6px")}>
              {poolFilters.map((f) => (
                <button key={f} onClick={() => p.onPoolFilter(f)} style={sx(pill(p.poolFilter === f))}>
                  {f}
                </button>
              ))}
            </div>
            <div style={sx("flex:1")} />
            <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>MM QUOTES · 1.2s</span>
          </div>

          <div
            style={sx(
              "display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:16px",
            )}
          >
            {p.universe
              .filter((u) => p.poolFilter === "ALL" || u.sector === p.poolFilter)
              .map((u) => (
                <PoolCard
                  key={u.sym}
                  u={u}
                  picked={p.picks.includes(u.sym)}
                  oppPicked={p.oppPicks.includes(u.sym)}
                  banned={p.bans.includes(u.sym) || p.oppBans.includes(u.sym)}
                  onPick={() => p.onPick(u.sym)}
                  onBan={() => p.onBan(u.sym)}
                />
              ))}
          </div>

          <div
            style={sx(
              `display:flex;align-items:center;gap:12px;padding:14px 16px;` +
                `border-top:1px solid ${C.border};background:${C.card}`,
            )}
          >
            <span style={sx(`font:400 11.5px/1.5 ${SANS};color:${C.muted}`)}>
              {picksComplete
                ? "Board locked. Admin starts the match, then everyone studies the tape."
                : "Tap a ticker to pick it, BAN to take it off the board. Ban what you cannot read."}
            </span>
            <div style={sx("flex:1")} />
            <button
              onClick={p.onConfirm}
              style={sx(
                `height:36px;padding:0 16px;border:none;border-radius:8px;cursor:pointer;` +
                  `font:700 12px/1 ${SANS};white-space:nowrap;` +
                  (picksComplete
                    ? `background:${C.accent};color:${C.bg}`
                    : `background:${C.border};color:${C.dim}`),
              )}
            >
              Confirm picks → case study
            </button>
          </div>
        </div>

        <TeamPanel
          accent="rgba(248,113,113,.35)"
          gradient="linear-gradient(180deg,rgba(248,113,113,.09),#0f0f11 40%)"
          avatarBg={C.red}
          avatarColor={C.bg}
          initial="KZ"
          name={p.opponent}
          meta="bankroll 5.10 ETH"
          rows={teamB}
          board="3 picks · 2 bans"
        />
      </div>
    </div>
  );
}

function TeamPanel({
  accent,
  gradient,
  avatarBg,
  avatarColor,
  initial,
  name,
  meta: metaLine,
  rows,
  board,
}: {
  accent: string;
  gradient: string;
  avatarBg: string;
  avatarColor: string;
  initial: string;
  name: string;
  meta: string;
  rows: readonly SlotRow[];
  board: string;
}) {
  return (
    <div
      style={sx(
        `border:1px solid ${accent};border-radius:12px;background:${gradient};padding:16px`,
      )}
    >
      <div
        style={sx(
          `display:flex;align-items:center;gap:10px;padding-bottom:14px;border-bottom:1px solid ${C.border}`,
        )}
      >
        <div
          style={sx(
            `width:32px;height:32px;border-radius:9px;background:${avatarBg};display:grid;` +
              `place-items:center;font:700 13px/1 ${SANS};color:${avatarColor}`,
          )}
        >
          {initial}
        </div>
        <div>
          <div style={sx(`font:700 13px/1 ${SANS}`)}>{name}</div>
          <div style={sx(`margin-top:4px;font:400 10px/1 ${MONO};color:${C.muted}`)}>{metaLine}</div>
        </div>
      </div>

      <div style={sx("display:flex;flex-direction:column;gap:8px;margin-top:14px")}>
        {rows.map((r, i) => (
          <div
            key={`${r.slot}-${i}`}
            style={sx(
              "display:flex;align-items:center;gap:10px;padding:10px 11px;border-radius:9px;background:" +
                (r.empty ? "transparent" : C.raised) +
                `;border:1px ${r.empty ? `dashed ${C.border}` : `solid ${C.border}`}`,
            )}
          >
            <span
              style={sx(
                "width:22px;height:22px;flex:none;border-radius:6px;display:grid;place-items:center;" +
                  `font:700 9px/1 ${MONO};background:` +
                  (r.empty
                    ? `transparent;color:${C.borderMid};border:1px solid ${C.border}`
                    : r.side === "S"
                      ? `${C.red};color:${C.bg}`
                      : `${C.green};color:${C.bg}`),
              )}
            >
              {r.slot}
            </span>
            <div style={sx("min-width:0")}>
              <div style={sx(`font:700 12px/1 ${MONO}`)}>{r.label}</div>
              <div style={sx(`margin-top:5px;font:400 10px/1 ${MONO};color:${C.dim}`)}>{r.meta}</div>
            </div>
            <div style={sx("flex:1")} />
            <span style={sx(`font:500 11px/1 ${MONO};color:${C.muted}`)}>{r.prem}</span>
          </div>
        ))}
      </div>

      <div
        style={sx(
          `display:flex;justify-content:space-between;margin-top:16px;padding-top:14px;` +
            `border-top:1px solid ${C.border};font:500 11px/1 ${MONO};color:${C.dim}`,
        )}
      >
        <span>BOARD</span>
        <span style={sx(`color:${C.text}`)}>{board}</span>
      </div>
    </div>
  );
}

function PoolCard({
  u,
  picked,
  oppPicked,
  banned,
  onPick,
  onBan,
}: {
  u: Asset;
  picked: boolean;
  oppPicked: boolean;
  banned: boolean;
  onPick: () => void;
  onBan: () => void;
}) {
  // A stable pseudo "day change" derived from the reference price — the board is
  // a fixture, so this stands in for a quote feed.
  const day = (((u.px * 100) % 7) / 2 - 1.4);
  const color = sectorColor(u.sector);
  const badge = picked ? "PICKED" : oppPicked ? "TAKEN" : banned ? "BANNED" : "";

  return (
    <div
      onClick={onPick}
      style={sx(
        `position:relative;overflow:hidden;padding:14px;border-radius:11px;cursor:pointer;` +
          `background:${C.cardAlt};border:1px solid ` +
          (banned
            ? "rgba(248,113,113,.35)"
            : picked
              ? "rgba(200,255,0,.45)"
              : oppPicked
                ? "rgba(248,113,113,.4)"
                : C.border) +
          (banned ? ";opacity:.45" : ""),
      )}
    >
      <div
        style={sx(
          `position:absolute;inset:-40%;background:radial-gradient(55% 55% at 72% 20%,${color}26,transparent 70%);pointer-events:none`,
        )}
      />
      <div style={sx("position:relative")}>
        <div style={sx("display:flex;justify-content:space-between;align-items:center")}>
          <span style={sx(tag(color))}>{u.sector}</span>
          <div style={sx("display:flex;align-items:center;gap:6px")}>
            <span
              style={sx(
                `font:700 8px/1 ${MONO};letter-spacing:.1em;padding:4px 6px;border-radius:4px;` +
                  (picked
                    ? `background:${C.accent};color:${C.bg}`
                    : oppPicked
                      ? `background:#3f1d1d;color:${C.red}`
                      : banned
                        ? `background:${C.border};color:${C.dim}`
                        : "display:none"),
              )}
            >
              {badge}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                onBan();
              }}
              style={sx(
                `height:20px;padding:0 7px;border-radius:5px;cursor:pointer;font:700 8px/1 ${MONO};` +
                  "letter-spacing:.1em;border:1px solid " +
                  (banned
                    ? `rgba(248,113,113,.5);background:rgba(248,113,113,.18);color:${C.red}`
                    : `${C.borderMid};background:transparent;color:${C.dim}`),
              )}
            >
              BAN
            </button>
          </div>
        </div>

        <div style={sx(`margin-top:12px;font:700 16px/1 ${MONO};letter-spacing:-.01em`)}>
          {u.sym} · {u.name}
        </div>

        <div style={sx("display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-top:14px")}>
          <Stat label="LAST" value={fmtPx(u.px)} accent />
          <Stat label="DAY" value={`${day >= 0 ? "+" : ""}${day.toFixed(2)}%`} />
          <Stat label="σ" value={(u.vol * 100).toFixed(1)} />
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div>
      <div style={sx(`font:500 8px/1 ${MONO};letter-spacing:.1em;color:${C.faint}`)}>{label}</div>
      <div
        style={sx(`margin-top:5px;font:700 12px/1 ${MONO}${accent ? `;color:${C.accent}` : ""}`)}
      >
        {value}
      </div>
    </div>
  );
}
