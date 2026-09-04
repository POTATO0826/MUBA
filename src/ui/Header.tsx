import { StarfieldButton } from "../components/StarfieldButton.tsx";
import { sfx, useSoundHover } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, tabBtn } from "../theme.ts";
import type { Tab } from "../types.ts";
import { SoundToggle } from "./SoundToggle.tsx";

/** Screens that belong to a match. Any of them lights the "Battles" tab. */
const MATCH_FLOW: readonly Tab[] = ["battles", "create", "room", "spin", "study", "parlay", "duel", "result"];

/**
 * Each tab clicks at its own pitch, so walking the nav row walks up a scale:
 * 523 / 587 / 659 Hz against `nav.click`'s 660Hz base.
 */
const NAV: readonly { key: Tab; label: string; pitch: number }[] = [
  { key: "lobby", label: "Home", pitch: 523 / 660 },
  { key: "battles", label: "Battles", pitch: 587 / 660 },
  { key: "desk", label: "Options desk", pitch: 659 / 660 },
];

interface HeaderProps {
  tab: Tab;
  wallet: boolean;
  onNavigate: (tab: Tab) => void;
  onToggleWallet: () => void;
}

export function Header({ tab, wallet, onNavigate, onToggleWallet }: HeaderProps) {
  // One stable handler shared by every nav button — the row re-renders on each
  // tab change and a fresh listener per render would churn the DOM.
  const hover = useSoundHover();

  return (
    <header
      style={sx(
        "position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:24px;padding:0 28px;" +
          "height:60px;background:rgba(9,9,11,.86);backdrop-filter:blur(12px);border-bottom:1px solid #27272a",
      )}
    >
      <div
        onClick={() => {
          sfx("nav.click");
          onNavigate("lobby");
        }}
        style={sx("display:flex;align-items:center;gap:10px;cursor:pointer")}
      >
        <div
          style={sx(
            `width:26px;height:26px;border-radius:7px;background:${C.accent};display:grid;` +
              `place-items:center;color:${C.bg};font:700 15px/1 ${SANS}`,
          )}
        >
          θ
        </div>
        <span style={sx(`font:700 16px/1 ${SANS};letter-spacing:-.02em`)}>THETADUEL</span>
      </div>

      <nav style={sx("display:flex;gap:2px;margin-left:8px")}>
        {NAV.map((n) => (
          <button
            key={n.key}
            onClick={() => {
              sfx("nav.click", { pitch: n.pitch });
              onNavigate(n.key);
            }}
            {...hover}
            style={sx(tabBtn(n.key === "battles" ? MATCH_FLOW.includes(tab) : tab === n.key))}
          >
            {n.label}
          </button>
        ))}
      </nav>

      <div style={sx("flex:1")} />

      <div style={sx("display:flex;align-items:center;gap:14px")}>
        <SoundToggle />
        <StarfieldButton
          label={wallet ? "0x71c…4Af2" : "Connect wallet"}
          onClick={onToggleWallet}
          rounded={47}
          padding="9px 15px"
          fill="#0f0f11"
          textColor={C.text}
          border={{ borderWidth: 1, borderStyle: "solid", borderColor: "rgba(200,255,0,.22)" }}
          font={{ fontFamily: wallet ? MONO : SANS, fontWeight: 700, fontSize: 12, lineHeight: "1.35em", letterSpacing: "0.01em" }}
          lightColor={C.accent}
          lightSize={46}
          lightThickness={2}
          lightCount={2}
          speed={58}
          movement="continuous"
          direction="ccw"
          glowColor={C.accent}
          glowSize={12}
          glowOpacity={70}
          pixelColor={C.accent}
          pixelSize={4}
          pixelDensity={46}
          pixelBrightness={100}
        />
      </div>
    </header>
  );
}
