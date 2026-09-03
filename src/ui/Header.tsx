import { StarfieldButton } from "../components/StarfieldButton.tsx";
import { shortAddress, type WalletIdentity } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, tabBtn } from "../theme.ts";
import type { Tab } from "../types.ts";

/** Screens that belong to a match. Any of them lights the "Battles" tab. */
const MATCH_FLOW: readonly Tab[] = ["battles", "create", "draft", "study", "pick", "live", "result"];

const NAV: readonly { key: Tab; label: string }[] = [
  { key: "lobby", label: "Home" },
  { key: "battles", label: "Battles" },
  { key: "parlay", label: "Duel attack" },
  { key: "cases", label: "Rewards" },
];

interface HeaderProps {
  tab: Tab;
  wallet: WalletIdentity;
  onNavigate: (tab: Tab) => void;
  onConnect: () => void;
  onManage: () => void;
  onSwitchNetwork: () => void;
}

/**
 * The four states the one button carries, in the order they're checked.
 *
 * Wrong-network outranks the address on purpose: someone connected on Ethereum
 * can draft a whole duel and only discover at signing that Thetanuts isn't
 * there, so the header says so first and the accent goes amber to match.
 */
function walletButton(wallet: WalletIdentity) {
  if (wallet.connecting) return { label: "Connecting…", mono: false, tone: C.accent };
  if (wallet.wrongNetwork) return { label: "Switch to Base", mono: false, tone: C.amber };
  if (wallet.address) return { label: shortAddress(wallet.address), mono: true, tone: C.accent };
  return { label: "Connect wallet", mono: false, tone: C.accent };
}

export function Header({
  tab,
  wallet,
  onNavigate,
  onConnect,
  onManage,
  onSwitchNetwork,
}: HeaderProps) {
  const btn = walletButton(wallet);
  const onWalletClick = wallet.wrongNetwork
    ? onSwitchNetwork
    : wallet.address
      ? onManage
      : onConnect;

  return (
    <header
      style={sx(
        "position:sticky;top:0;z-index:40;display:flex;align-items:center;gap:24px;padding:0 28px;" +
          "height:60px;background:rgba(9,9,11,.86);backdrop-filter:blur(12px);border-bottom:1px solid #27272a",
      )}
    >
      <div style={sx("display:flex;align-items:center;gap:10px")}>
        <div
          style={sx(
            `width:26px;height:26px;border-radius:7px;background:${C.accent};display:grid;` +
              `place-items:center;color:${C.bg};font:700 15px/1 ${SANS}`,
          )}
        >
          T
        </div>
        <span style={sx(`font:700 16px/1 ${SANS};letter-spacing:-.02em`)}>THETHADUEL</span>
      </div>

      <nav style={sx("display:flex;gap:2px;margin-left:8px")}>
        {NAV.map((n) => (
          <button
            key={n.key}
            onClick={() => onNavigate(n.key)}
            style={sx(tabBtn(n.key === "battles" ? MATCH_FLOW.includes(tab) : tab === n.key))}
          >
            {n.label}
          </button>
        ))}
      </nav>

      <div style={sx("flex:1")} />

      <div style={sx("display:flex;align-items:center;gap:14px")}>
        <StarfieldButton
          label={btn.label}
          onClick={onWalletClick}
          rounded={47}
          padding="9px 15px"
          fill="#0f0f11"
          textColor={C.text}
          border={{
            borderWidth: 1,
            borderStyle: "solid",
            borderColor: wallet.wrongNetwork ? "rgba(245,158,11,.38)" : "rgba(200,255,0,.22)",
          }}
          font={{
            fontFamily: btn.mono ? MONO : SANS,
            fontWeight: 700,
            fontSize: 12,
            lineHeight: "1.35em",
            letterSpacing: "0.01em",
          }}
          lightColor={btn.tone}
          lightSize={46}
          lightThickness={2}
          lightCount={2}
          speed={58}
          movement="continuous"
          direction="ccw"
          glowColor={btn.tone}
          glowSize={12}
          glowOpacity={70}
          pixelColor={btn.tone}
          pixelSize={4}
          pixelDensity={46}
          pixelBrightness={100}
        />
      </div>
    </header>
  );
}
