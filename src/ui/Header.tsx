import { StarfieldButton } from "../components/StarfieldButton.tsx";
import { SIGNING_CHAIN_NAME } from "../data/wallet.ts";
import { shortAddress, type WalletIdentity } from "../data/wallet.ts";
import { sfx, useSoundHover } from "../lib/sound/index.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, tabBtn } from "../theme.ts";
import type { Tab } from "../types.ts";
import { SoundToggle } from "./SoundToggle.tsx";

/** Screens that belong to a match. Any of them lights the "Battles" tab. */
const MATCH_FLOW: readonly Tab[] = ["battles", "create", "room", "spin", "study", "parlay", "duel", "result"];

/**
 * Each tab clicks at its own pitch, so walking the nav row walks up a scale:
 * 523 / 587 / 659 / 698 Hz against `nav.click`'s 660Hz base. The ladder took
 * the fourth step rather than squeezing a semitone in beside the desk.
 */
const NAV: readonly { key: Tab; label: string; pitch: number }[] = [
  { key: "lobby", label: "Home", pitch: 523 / 660 },
  { key: "battles", label: "Battles", pitch: 587 / 660 },
  { key: "arena", label: "Live arena", pitch: 622 / 660 },
  { key: "ranks", label: "Ranking", pitch: 659 / 660 },
  { key: "desk", label: "Options desk", pitch: 698 / 660 },
  // The GameStake console. It was reachable at `/testing` and had a `Tab`
  // entry from the moment `6f7102a` merged it, but nothing in this row pointed
  // at it — a screen you can only reach by typing the URL is, to everyone who
  // does not already know it is there, a screen that did not ship. The fifth
  // step continues the ladder rather than squeezing a semitone in.
  { key: "testing", label: "Testing", pitch: 784 / 660 },
];

interface HeaderProps {
  tab: Tab;
  /** Whoever the wallet layer says you are. `DISCONNECTED` until you connect. */
  wallet: WalletIdentity;
  onNavigate: (tab: Tab) => void;
  onConnect: () => void;
  /** The connected-wallet panel — on the mock and on injected, a disconnect. */
  onManage: () => void;
  onSwitchNetwork: () => void;
}

/**
 * The four states the one button carries, in the order they're checked.
 *
 * Wrong-network outranks the address on purpose: someone connected on the wrong
 * chain can draft a whole duel and only discover at signing that Base Sepolia
 * isn't where they are, so the header says so first and the accent goes amber
 * to match.
 *
 * **`settled` outranks everything**, and it is the fix for "it keeps asking me
 * to connect". A wallet that connected on a previous visit comes back silently,
 * but not instantly; until the restore resolves, `connected` is `false` and
 * `address` is `null`, and a header that trusted those would offer to connect a
 * wallet already on its way back — every reload, to someone who never
 * disconnected. So the unsettled state gets its own label and, crucially, its
 * own *click behaviour*: `onWalletClick` does nothing while it holds, because a
 * connect fired mid-restore is the wallet popup this whole change exists to
 * stop.
 */
function walletButton(wallet: WalletIdentity) {
  if (wallet.connecting) return { label: "Connecting…", mono: false, tone: C.accent };
  if (!wallet.settled) return { label: "Restoring…", mono: false, tone: C.dim };
  if (wallet.wrongNetwork)
    return { label: `Switch to ${SIGNING_CHAIN_NAME}`, mono: false, tone: C.amber };
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
  // One stable handler shared by every nav button — the row re-renders on each
  // tab change and a fresh listener per render would churn the DOM.
  const hover = useSoundHover();

  const btn = walletButton(wallet);

  /**
   * One button, three destinations — and only the connect leg is a connect, so
   * only it gets `wallet.connect`. `StarfieldButton` used to fire that sound on
   * every click of itself, which meant "Switch to Base" and the account panel
   * both played a connect chime.
   */
  const onWalletClick = () => {
    // Nothing at all until the restore has answered. See `walletButton`.
    if (!wallet.settled) return;
    if (wallet.wrongNetwork) return onSwitchNetwork();
    if (wallet.address) return onManage();
    sfx("wallet.connect");
    onConnect();
  };

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
          label={btn.label}
          onClick={onWalletClick}
          rounded={47}
          padding="9px 15px"
          fill="#0f0f11"
          textColor={C.text}
          border={{
            borderWidth: 1,
            borderStyle: "solid",
            // Amber rim while the wallet is on the wrong chain, so the button
            // reads as a warning before the label is.
            borderColor: wallet.wrongNetwork ? "rgba(245,158,11,.38)" : "rgba(200,255,0,.22)",
          }}
          font={{ fontFamily: btn.mono ? MONO : SANS, fontWeight: 700, fontSize: 12, lineHeight: "1.35em", letterSpacing: "0.01em" }}
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
