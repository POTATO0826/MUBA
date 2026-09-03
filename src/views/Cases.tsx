import { useState } from "react";
import { Roulette } from "../components/Roulette.tsx";
import { StarfieldButton } from "../components/StarfieldButton.tsx";
import { CASE_LIBRARY } from "../data/fixtures.ts";
import {
  LAST_SPINS,
  MISSIONS,
  PLAYER,
  SEASON,
  TIERS,
  lockedBy,
  nextTier,
} from "../data/rewards.ts";
import { UNIVERSE } from "../data/universe.ts";
import { fmtPx } from "../engine/tape.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill, sectorColor } from "../theme.ts";
import { LibraryCaseCard } from "../ui/CaseCards.tsx";

const CRYPTO = UNIVERSE.filter((u) => u.mkt === "CRYPTO");

const LABEL = `font:500 9px/1 ${MONO};letter-spacing:.14em;color:${C.dim}`;
const PANEL = `border:1px solid ${C.border};border-radius:14px;background:${C.card};overflow:hidden`;

interface CasesProps {
  onOpenCase: () => void;
  onClaimFreeBattle: (sym: string) => void;
}

export function Cases({ onOpenCase, onClaimFreeBattle }: CasesProps) {
  const [spinning, setSpinning] = useState(false);
  const [filter, setFilter] = useState("ALL");

  const tags = ["ALL", ...new Set(CASE_LIBRARY.map((c) => c.tag))];
  const shown = CASE_LIBRARY.filter((c) => filter === "ALL" || c.tag === filter);
  const unlocked = CASE_LIBRARY.filter((c) => !lockedBy(c.tier, PLAYER.tier)).length;

  return (
    <div style={sx("padding:28px;max-width:1720px;margin:0 auto;display:flex;flex-direction:column;gap:22px")}>
      <div style={sx("display:flex;align-items:center;gap:14px")}>
        <h2 style={sx(`margin:0;font:700 19px/1 ${SANS};letter-spacing:-.02em`)}>Rewards</h2>
        <span style={sx(`font:400 12px/1 ${SANS};color:${C.dim}`)}>
          Rank up, spin for free entries, unlock cases. Payoffs generated locally by
          client.utils.calculatePayout.
        </span>
        <div style={sx("flex:1")} />
        <span
          style={sx(
            `font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.accent};border:1px solid rgba(200,255,0,.3);` +
              "background:rgba(200,255,0,.08);border-radius:6px;padding:6px 9px",
          )}
        >
          {SEASON.label} · ENDS IN {SEASON.endsIn}
        </span>
      </div>

      <RankTrack />

      <div style={sx("display:grid;grid-template-columns:minmax(0,2fr) minmax(300px,1fr);gap:18px;align-items:stretch")}>
        <FreeSpin onSpin={() => setSpinning(true)} />
        <Missions />
      </div>

      <section>
        <div style={sx("display:flex;align-items:center;gap:14px;margin-bottom:14px;flex-wrap:wrap")}>
          <h3 style={sx(`margin:0;font:700 16px/1 ${SANS};letter-spacing:-.02em`)}>Case library</h3>
          <div style={sx("display:flex;gap:6px;flex-wrap:wrap")}>
            {tags.map((t) => (
              <button key={t} onClick={() => setFilter(t)} style={sx(pill(filter === t))}>
                {t}
              </button>
            ))}
          </div>
          <div style={sx("flex:1")} />
          <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>
            {unlocked} / {CASE_LIBRARY.length} unlocked · {shown.length} shown
          </span>
        </div>

        <div style={sx("display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px")}>
          {shown.map((c) => (
            <LibraryCaseCard
              key={c.name}
              c={c}
              onOpen={onOpenCase}
              lockedBy={lockedBy(c.tier, PLAYER.tier)}
            />
          ))}
        </div>
      </section>

      {spinning && (
        <Roulette
          assets={CRYPTO}
          onClose={() => setSpinning(false)}
          onClaim={(sym) => {
            setSpinning(false);
            onClaimFreeBattle(sym);
          }}
        />
      )}
    </div>
  );
}

/** Season XP bar with the tier thresholds marked along it. */
function RankTrack() {
  const top = TIERS[TIERS.length - 1]!.xp;
  const next = nextTier(PLAYER.xp);
  const pct = Math.min(100, (PLAYER.xp / top) * 100);

  return (
    <div
      style={sx(
        `${PANEL};background:linear-gradient(120deg,rgba(200,255,0,.07),${C.card} 40%,rgba(99,102,241,.06) 100%)`,
      )}
    >
      <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) auto;gap:24px;padding:18px 20px 16px;align-items:end")}>
        <div>
          <div style={sx(LABEL)}>YOUR STANDING</div>
          <div style={sx("display:flex;align-items:baseline;gap:12px;margin-top:8px")}>
            <span style={sx(`font:700 30px/1 ${MONO};letter-spacing:-.03em;color:${C.accent}`)}>
              RANK {String(PLAYER.rank).padStart(2, "0")}
            </span>
            <span style={sx(`font:700 14px/1 ${SANS}`)}>{PLAYER.tier}</span>
            <span style={sx(`font:500 11px/1 ${MONO};color:${C.dim}`)}>
              {PLAYER.xp.toLocaleString("en-US")} XP
              {next ? ` · ${(next.xp - PLAYER.xp).toLocaleString("en-US")} to ${next.name}` : " · top tier"}
            </span>
          </div>
        </div>

        <div style={sx("display:flex;gap:10px")}>
          <Stat label="WIN RATE" value={`${Math.round(PLAYER.winRate * 100)}%`} color={C.green} />
          <Stat label="STREAK" value={`${PLAYER.streak}d · ×${PLAYER.streakMult.toFixed(1)}`} color={C.amber} />
          <Stat label="CASES OPENED" value={String(PLAYER.casesOpened)} />
        </div>
      </div>

      <div style={sx("padding:0 20px 18px")}>
        <div style={sx(`position:relative;height:8px;border-radius:99px;background:${C.line};overflow:visible`)}>
          <div
            style={sx(
              `height:100%;width:${pct.toFixed(1)}%;border-radius:99px;` +
                `background:linear-gradient(90deg,${C.indigo},${C.accent});box-shadow:0 0 14px rgba(200,255,0,.35)`,
            )}
          />
          {TIERS.map((t) => {
            const x = (t.xp / top) * 100;
            const reached = PLAYER.xp >= t.xp;
            return (
              <div
                key={t.name}
                style={sx(
                  `position:absolute;top:50%;left:${x.toFixed(1)}%;width:12px;height:12px;margin:-6px 0 0 -6px;` +
                    `border-radius:99px;border:2px solid ${reached ? C.accent : C.borderMid};background:${
                      reached ? C.bg : C.line
                    }`,
                )}
              />
            );
          })}
        </div>
        <div style={sx("position:relative;height:16px;margin-top:8px")}>
          {TIERS.map((t, i) => {
            const x = (t.xp / top) * 100;
            const reached = PLAYER.xp >= t.xp;
            const anchor = i === 0 ? "left:0;transform:none" : i === TIERS.length - 1 ? "right:0;transform:none" : `left:${x.toFixed(1)}%;transform:translateX(-50%)`;
            return (
              <div
                key={t.name}
                style={sx(
                  `position:absolute;top:0;${anchor};font:500 9px/1 ${MONO};letter-spacing:.12em;white-space:nowrap;color:${
                    reached ? C.text : C.faint
                  }`,
                )}
              >
                {t.name} <span style={sx(`color:${C.faint}`)}>{t.xp.toLocaleString("en-US")}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div style={sx(`min-width:104px;padding:10px 12px;border:1px solid ${C.border};border-radius:10px;background:${C.panel}`)}>
      <div style={sx(LABEL)}>{label}</div>
      <div style={sx(`margin-top:7px;font:700 15px/1 ${MONO}${color ? `;color:${color}` : ""}`)}>{value}</div>
    </div>
  );
}

/** The roulette's front door: copy, the assets on the wheel, recent spins, the button. */
function FreeSpin({ onSpin }: { onSpin: () => void }) {
  return (
    <div
      style={sx(
        "border:1px solid rgba(200,255,0,.35);border-radius:14px;overflow:hidden;display:flex;flex-direction:column;" +
          `background:linear-gradient(160deg,rgba(200,255,0,.1),${C.card} 55%)`,
      )}
    >
      <div style={sx(`display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
        <span style={sx(`width:6px;height:6px;border-radius:99px;background:${C.accent};animation:vcPulse 1.4s ease-in-out infinite`)} />
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.accent}`)}>FREE CRYPTO BATTLES</span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>1 SPIN · DAILY · RESETS 00:00 UTC</span>
      </div>

      <div style={sx("display:grid;grid-template-columns:minmax(0,1fr) minmax(220px,.9fr);gap:18px;padding:16px;flex:1")}>
        <div style={sx("display:flex;flex-direction:column")}>
          <div style={sx(`font:700 22px/1.1 ${SANS};letter-spacing:-.02em`)}>Spin for a free 1v1</div>
          <div style={sx(`margin-top:8px;font:400 11.5px/1.55 ${SANS};color:${C.muted};text-wrap:pretty;max-width:420px`)}>
            The wheel runs the live crypto book. Whatever it lands on is drafted into your first
            slot and the house covers a 0.50 ETH pool against a random open room.
          </div>

          <div style={sx("display:flex;flex-wrap:wrap;gap:6px;margin-top:14px")}>
            {CRYPTO.map((u) => (
              <span
                key={u.sym}
                style={sx(
                  `display:inline-flex;align-items:center;gap:6px;padding:6px 8px;border-radius:6px;` +
                    `border:1px solid ${C.border};background:${C.raised};font:500 10px/1 ${MONO}`,
                )}
              >
                <span style={sx(`width:5px;height:5px;border-radius:99px;background:${sectorColor(u.sector)}`)} />
                <span style={sx("font-weight:700")}>{u.sym}</span>
                <span style={sx(`color:${C.dim}`)}>${fmtPx(u.px)}</span>
              </span>
            ))}
          </div>

          <div style={sx("flex:1")} />

          <div style={sx("display:flex;align-items:center;gap:14px;margin-top:16px")}>
            <StarfieldButton
              label="Spin the wheel"
              onClick={onSpin}
              rounded={24}
              padding="13px 22px"
              fill="#0f0f11"
              textColor={C.text}
              border={{ borderWidth: 1, borderStyle: "solid", borderColor: "rgba(200,255,0,.32)" }}
              font={{ fontFamily: SANS, fontWeight: 700, fontSize: 13, lineHeight: "1.2em" }}
              lightColor={C.accent}
              lightSize={60}
              lightThickness={2}
              lightCount={3}
              speed={62}
              glowColor={C.accent}
              glowSize={14}
              glowOpacity={80}
              pixelColor={C.accent}
              pixelSize={4}
              pixelDensity={50}
            />
            <span style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.faint}`)}>
              No wallet needed.
              <br />
              Read-only prototype.
            </span>
          </div>
        </div>

        <div style={sx(`border:1px solid ${C.border};border-radius:10px;background:${C.panel};overflow:hidden;align-self:start`)}>
          <div style={sx(`padding:9px 12px;border-bottom:1px solid ${C.line};${LABEL}`)}>LAST SPINS</div>
          {LAST_SPINS.map((s) => (
            <div key={s.who} style={sx(`display:flex;align-items:center;gap:10px;padding:9px 12px;border-bottom:1px solid ${C.line}`)}>
              <span style={sx(`width:6px;height:6px;flex:none;border-radius:99px;background:${s.win ? C.green : C.red}`)} />
              <span style={sx(`font:700 11px/1 ${SANS}`)}>{s.who}</span>
              <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>{s.sym}</span>
              <div style={sx("flex:1")} />
              <span style={sx(`font:700 10.5px/1 ${MONO};color:${s.win ? C.green : C.red}`)}>{s.result}</span>
            </div>
          ))}
          <div style={sx(`padding:10px 12px;font:400 10px/1.5 ${MONO};color:${C.faint}`)}>
            Wins pay the pool. A loss costs nothing — the entry was free.
          </div>
        </div>
      </div>
    </div>
  );
}

/** Daily missions with ASCII checkboxes. */
function Missions() {
  const done = MISSIONS.filter((m) => m.done).length;
  const earned = MISSIONS.filter((m) => m.done).reduce((a, m) => a + m.xp, 0);
  const total = MISSIONS.reduce((a, m) => a + m.xp, 0);

  return (
    <div style={sx(`${PANEL};display:flex;flex-direction:column`)}>
      <div style={sx(`display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid ${C.border}`)}>
        <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.14em;color:${C.blue}`)}>DAILY MISSIONS</span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:700 11px/1 ${MONO}`)}>{done} / {MISSIONS.length}</span>
      </div>

      <div style={sx("padding:14px 16px;display:flex;flex-direction:column;gap:8px;flex:1")}>
        {MISSIONS.map((m) => (
          <div
            key={m.id}
            style={sx(
              `display:flex;align-items:center;gap:10px;padding:10px 11px;border-radius:9px;` +
                (m.done
                  ? `border:1px solid rgba(74,222,128,.35);background:rgba(74,222,128,.06)`
                  : `border:1px dashed ${C.borderMid};background:transparent`),
            )}
          >
            <span style={sx(`font:700 12px/1 ${MONO};color:${m.done ? C.green : C.faint}`)}>
              {m.done ? "[x]" : "[ ]"}
            </span>
            <span style={sx(`font:500 12px/1 ${SANS};color:${m.done ? C.text : C.muted}`)}>{m.label}</span>
            <div style={sx("flex:1")} />
            <span style={sx(`font:700 10px/1 ${MONO};color:${m.done ? C.green : C.dim}`)}>+{m.xp} XP</span>
          </div>
        ))}
      </div>

      <div style={sx(`padding:12px 16px;border-top:1px solid ${C.line};background:${C.panel}`)}>
        <div style={sx("display:flex;justify-content:space-between")}>
          <span style={sx(LABEL)}>EARNED TODAY</span>
          <span style={sx(`font:700 11px/1 ${MONO};color:${C.accent}`)}>
            {earned} / {total} XP
          </span>
        </div>
        <div style={sx(`margin-top:8px;height:4px;border-radius:99px;background:${C.line};overflow:hidden`)}>
          <div style={sx(`height:100%;width:${((earned / total) * 100).toFixed(1)}%;background:${C.blue}`)} />
        </div>
        <div style={sx(`margin-top:8px;font:400 10px/1.5 ${MONO};color:${C.faint}`)}>
          Streak multiplier ×{PLAYER.streakMult.toFixed(1)} applies at midnight.
        </div>
      </div>
    </div>
  );
}
