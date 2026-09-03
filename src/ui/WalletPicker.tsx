import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import type { InjectedWallet } from "../wallet/injected.ts";

/**
 * Which browser wallet to connect.
 *
 * Only shown when more than one extension announced itself — with a single
 * wallet installed there is nothing to choose and `connect()` goes straight to
 * its prompt.
 */
export function WalletPicker({
  wallets,
  error,
  onChoose,
  onCancel,
}: {
  wallets: InjectedWallet[];
  error: string | null;
  onChoose: (rdns: string) => void;
  onCancel: () => void;
}) {
  return (
    <div
      onClick={onCancel}
      style={sx(
        "position:fixed;inset:0;z-index:80;display:grid;place-items:center;" +
          "background:rgba(6,6,8,.72);backdrop-filter:blur(6px)",
      )}
    >
      <div
        // The backdrop closes the picker; clicks inside it must not bubble up.
        onClick={(e) => e.stopPropagation()}
        style={sx(
          "width:360px;max-width:calc(100vw - 32px);border:1px solid #27272a;border-radius:16px;" +
            "background:linear-gradient(180deg,#101012,#0b0b0d);padding:20px;" +
            "box-shadow:0 24px 64px rgba(0,0,0,.6)",
        )}
      >
        <div style={sx("display:flex;align-items:center;gap:12px;margin-bottom:16px")}>
          <span style={sx(`font:700 14px/1 ${SANS};letter-spacing:-.01em`)}>Connect a wallet</span>
          <div style={sx("flex:1")} />
          <button
            onClick={onCancel}
            aria-label="Close"
            style={sx(
              `width:26px;height:26px;border:1px solid ${C.border};border-radius:8px;` +
                `background:transparent;color:${C.muted};font:500 13px/1 ${SANS};cursor:pointer`,
            )}
          >
            ×
          </button>
        </div>

        <div style={sx("display:flex;flex-direction:column;gap:8px")}>
          {wallets.map((w) => (
            <button
              key={w.rdns}
              onClick={() => onChoose(w.rdns)}
              style={sx(
                `display:flex;align-items:center;gap:12px;padding:10px 12px;border:1px solid ${C.border};` +
                  "border-radius:12px;background:#0a0a0c;cursor:pointer;text-align:left",
              )}
            >
              {/* Wallets announce their icon as a data: URI, so nothing loads
                  over the network here. */}
              <img
                src={w.icon}
                alt=""
                style={sx("width:26px;height:26px;border-radius:7px;flex:none")}
              />
              <span style={sx(`font:700 13px/1 ${SANS};color:${C.text};flex:1`)}>{w.name}</span>
              <span style={sx(`font:500 9px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>
                INSTALLED
              </span>
            </button>
          ))}
        </div>

        {error && (
          <p style={sx(`margin:14px 0 0;font:500 11px/1.5 ${SANS};color:${C.red}`)}>{error}</p>
        )}

        <p style={sx(`margin:16px 0 0;font:500 10px/1.5 ${MONO};color:${C.faint}`)}>
          BASE MAINNET · 8453
        </p>
      </div>
    </div>
  );
}
