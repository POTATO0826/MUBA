import { sx } from "../lib/sx.ts";
import { MONO, SANS } from "../theme.ts";

interface AutoBannerProps {
  label: string;
  onStop: () => void;
}

/** Floating pill shown while the autopilot drives a demo or a spectated room. */
export function AutoBanner({ label, onStop }: AutoBannerProps) {
  return (
    <div
      style={sx(
        "position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:50;display:flex;" +
          "align-items:center;gap:12px;padding:10px 12px 10px 16px;border:1px solid rgba(167,139,250,.45);" +
          "border-radius:99px;background:rgba(15,15,17,.92);backdrop-filter:blur(10px);" +
          "box-shadow:0 12px 32px rgba(0,0,0,.5)",
      )}
    >
      <span
        style={sx(
          "width:7px;height:7px;border-radius:99px;background:#a78bfa;animation:vcPulse 1.4s ease-in-out infinite",
        )}
      />
      <span
        style={sx(
          `font:700 10px/1 ${MONO};letter-spacing:.12em;color:#a78bfa;white-space:nowrap`,
        )}
      >
        {label}
      </span>
      <button
        onClick={onStop}
        style={sx(
          "height:26px;padding:0 10px;border:1px solid #3f3f46;border-radius:99px;background:transparent;" +
            `color:#fafafa;font:500 11px/1 ${SANS};cursor:pointer`,
        )}
      >
        Stop
      </button>
    </div>
  );
}
