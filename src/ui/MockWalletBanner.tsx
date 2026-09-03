import { sx } from "../lib/sx.ts";
import { C, MONO } from "../theme.ts";

/**
 * Shown whenever the app is running on `useMockWallet()`.
 *
 * The mock exists so a fresh clone plays without signing up for anything, but a
 * silent fallback is indistinguishable from a broken wallet integration — the
 * header shows a plausible `0x71c…4Af2` and nothing says it is fake. This says
 * it, and says what to do about it.
 */
export function MockWalletBanner() {
  return (
    <div
      style={sx(
        "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:50;display:flex;" +
          "align-items:center;gap:12px;padding:10px 16px;border:1px solid rgba(245,158,11,.45);" +
          "border-radius:99px;background:rgba(15,15,17,.94);backdrop-filter:blur(10px);" +
          "box-shadow:0 12px 32px rgba(0,0,0,.5)",
      )}
    >
      <span
        style={sx(
          `width:7px;height:7px;border-radius:99px;background:${C.amber};` +
            "animation:vcPulse 1.4s ease-in-out infinite",
        )}
      />
      <span
        style={sx(`font:700 10px/1 ${MONO};letter-spacing:.12em;color:${C.amber};white-space:nowrap`)}
      >
        MOCK WALLET · FAKE ADDRESS
      </span>
      <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.06em;color:${C.dim};white-space:nowrap`)}>
        set WALLETCONNECT_PROJECT_ID in .env to connect a real one
      </span>
    </div>
  );
}
