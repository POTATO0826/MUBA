import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_OFFER_WINDOW_MIN,
  MAX_RFQ_USDC,
  RFQ_PHASE_COPY,
  RFQ_PHASE_OF,
  RFQ_POLL_MS,
  TARGET_RFQ_USDC,
  UNANSWERED_COPY,
  acceptOffer,
  awaitOffers,
  cancelRequest,
  createKeyring,
  createLiveRfqDeps,
  elapsedText,
  openRequest,
  type RfqDeps,
  type RfqError,
  type RfqInput,
  type RfqKeyring,
  type RfqOffer,
  type RfqOpen,
  type RfqPhase,
  type RfqStep,
  type RfqWallet,
} from "../desk/rfq.ts";
import { usdText } from "../desk/fill.ts";
import type { MarketSource } from "../data/market.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, pill, tag } from "../theme.ts";

/**
 * The patient RFQ panel — a desk tool you leave open, not a button you press.
 *
 * ## Why every piece of copy on this panel is defensive about time
 *
 * A fill is a transaction. An RFQ is a *request*, sent to counterparties who owe
 * us nothing, with no SLA and no guarantee that anybody ever answers. The plan
 * scoped it out of the duel loop for exactly that reason
 * (`docs/plans/plan5-thetanuts.md` line 27); what is left is this — a panel a
 * trader opens, sets going, and comes back to.
 *
 * Three rules follow, and they are the whole visual design:
 *
 * 1. **No spinner.** A spinner is a promise that something is about to happen.
 *    Nothing is about to happen. What this panel shows instead is an elapsed
 *    clock and a poll count — the only two claims that are actually true while
 *    waiting on a market maker.
 * 2. **"Nobody answered" is not an error.** It renders in the ordinary dim
 *    register with `UNANSWERED_COPY`, next to a cancel button, and never in the
 *    amber error box. A sealed-bid auction that drew no bids worked correctly.
 * 3. **The four phases are named on screen, up front.** Before anything is
 *    pressed, the panel says what each phase costs and who controls it, because
 *    the single most misleading thing this UI could do is look like the fill
 *    panel next to it.
 *
 * ## Inert by default, and gated twice
 *
 * This component is **not imported anywhere yet** — it is wired into `/desk` in
 * one line once the view files are free. It takes everything it needs as props
 * with defaults, so it renders — read-only, no network, no wallet — from
 * `<RfqPanel />` with no arguments at all. That is the state `test/rfq.test.ts`
 * asserts.
 *
 * Live behaviour needs **both**: `/api/config` reporting `features.trade`
 * (`THETADUEL_TRADE=on` exactly) **and** a wallet that is not the mock. The mock
 * wallet is refused inside `src/desk/rfq.ts` above `getSigner`, and this panel
 * additionally never asks the config for it — there is nothing a flag could
 * enable for a wallet that cannot sign.
 *
 * ## The ECDH key lives in this component's ref and nowhere else
 *
 * `createKeyring` holds the private key in a closure; the ref holds the keyring.
 * Nothing writes it to `localStorage`, `sessionStorage`, IndexedDB, a cookie, or
 * a log line. Unmounting this component ends readability of any bid sealed to
 * it, which is why the copy says so before the request is opened rather than
 * after it is lost.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Props
// ─────────────────────────────────────────────────────────────────────────────

/** The wallet, as this panel needs it — the signer seam plus two recovery verbs. */
export interface RfqPanelWallet extends RfqWallet {
  connect?(): Promise<void>;
  switchToBase?(): Promise<void>;
}

export interface RfqPanelProps {
  /**
   * The market, only ever read for a sensible default strike and the tradable
   * underlyings. Absent is fine: the panel falls back to ETH and an empty strike,
   * which is exactly what it shows in a static build.
   */
  source?: MarketSource;
  /** Absent — a static build, a test, an unwired caller — means read-only. */
  wallet?: RfqPanelWallet;
  /**
   * Override the `/api/config` read. `undefined` asks the server; `false` keeps
   * the panel inert without a network call at all, which is what the render test
   * uses.
   */
  enabled?: boolean;
  /** Injectable so a test can drive the whole panel without a chain. */
  makeDeps?: (wallet: RfqPanelWallet) => RfqDeps;
  /** Injectable clock, for the elapsed readout. */
  now?: () => number;
  /** Poll cadence override, so a test does not wait 15 real seconds. */
  pollMs?: number;
  /** Patience override, same reason. */
  patienceMs?: number;
}

/** Thetanuts publishes an options market for these two and no others (FINDINGS §3). */
const TRADABLE = ["ETH", "BTC"] as const;
type Tradable = (typeof TRADABLE)[number];

/** The reserve ladder, matching the fill panel's rungs and its code cap. */
const RESERVE_LADDER: readonly bigint[] = [10_000n, 100_000n, 1_000_000n];

/** Reference strikes, used only when there is no live spot to round off. */
const FALLBACK_STRIKE: Record<Tradable, number> = { ETH: 2400, BTC: 62000 };

/** One week out, to the nearest UTC 08:00 — the venue's expiry convention. */
function defaultExpiry(now: number): number {
  const d = new Date(now + 7 * 86_400_000);
  d.setUTCHours(8, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function expiryText(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const months = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The trade flag
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ask the server whether real trading is switched on.
 *
 * Deliberately the same shape as `useTradeConfig` in `src/views/Parlay.tsx` —
 * read at mount, `no-store`, fail closed on anything that went wrong, and never
 * asked at all for the mock wallet or for no wallet. Duplicated rather than
 * imported because that hook is private to a view another agent owns; the
 * discipline is what matters and it is identical.
 */
function useTradeFlag(wallet: RfqPanelWallet | undefined, override: boolean | undefined): boolean {
  const [on, setOn] = useState(false);
  const id = wallet?.id;

  useEffect(() => {
    if (override !== undefined) return;
    if (!id || id === "mock") return;
    let live = true;
    void (async () => {
      try {
        const res = await fetch("/api/config");
        const body = (await res.json()) as { features?: { trade?: boolean } };
        if (live) setOn(body.features?.trade === true);
      } catch {
        // Fail closed, silently. A static build has no server to ask and is not
        // misconfigured.
      }
    })();
    return () => {
      live = false;
    };
  }, [id, override]);

  return override ?? on;
}

// ─────────────────────────────────────────────────────────────────────────────
// The panel
// ─────────────────────────────────────────────────────────────────────────────

type PanelState =
  | { kind: "idle" }
  | { kind: "opening" }
  | { kind: "waiting"; open: RfqOpen }
  | { kind: "offers"; open: RfqOpen; offers: RfqOffer[] }
  | { kind: "unanswered"; open: RfqOpen; elapsedMs: number; polls: number }
  | { kind: "settling"; open: RfqOpen; offer: RfqOffer }
  | { kind: "settled"; open: RfqOpen; offer: RfqOffer; hash: string; explorer: string }
  | { kind: "closed"; open: RfqOpen; note: string }
  | { kind: "failed"; error: RfqError };

export function RfqPanel({
  source,
  wallet,
  enabled,
  makeDeps,
  now = () => Date.now(),
  pollMs = RFQ_POLL_MS,
  patienceMs,
}: RfqPanelProps = {}) {
  const flag = useTradeFlag(wallet, enabled);
  /** Both halves required: an operator's flag AND a wallet that can actually sign. */
  const armed = flag && wallet !== undefined && wallet.id !== "mock";

  const [underlying, setUnderlying] = useState<Tradable>("ETH");
  const [optionType, setOptionType] = useState<"CALL" | "PUT">("CALL");
  const [reserve, setReserve] = useState<bigint>(TARGET_RFQ_USDC);
  const [windowMin, setWindowMin] = useState(DEFAULT_OFFER_WINDOW_MIN);
  const [state, setState] = useState<PanelState>({ kind: "idle" });
  const [step, setStep] = useState<RfqStep | null>(null);
  const [polls, setPolls] = useState(0);

  /**
   * The ECDH keyring, in a ref, for the life of this mount.
   *
   * A ref rather than state because it must never take part in a render — the
   * private key should not be reachable from a React devtools inspection of this
   * component's props or state, and it is never a dependency of anything.
   */
  const keyring = useRef<RfqKeyring | null>(null);
  /** The deps for the run in progress. Rebuilt per request. */
  const deps = useRef<RfqDeps | null>(null);
  /** Set while a phase-2 wait is in flight, so unmount can end it. */
  const alive = useRef(true);

  // The elapsed clock. One second, and only while there is something to time —
  // this is the panel's entire substitute for a progress indicator.
  const [tick, setTick] = useState(0);
  const waitingSince =
    state.kind === "waiting" || state.kind === "offers" || state.kind === "settling"
      ? state.open.openedAt
      : null;
  useEffect(() => {
    if (waitingSince === null) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [waitingSince]);

  useEffect(
    () => () => {
      alive.current = false;
      // The key dies with the mount, explicitly rather than by garbage
      // collection, so the moment of loss is a line of code someone can find.
      keyring.current?.forget();
    },
    [],
  );

  const spot = source?.spot(underlying) ?? null;
  const strike = useMemo(() => {
    if (spot === null) return FALLBACK_STRIKE[underlying];
    // Round to a plausible listed strike rather than inventing decimals.
    const grain = underlying === "BTC" ? 1000 : 50;
    return Math.round(spot / grain) * grain;
  }, [spot, underlying]);
  const expiry = useMemo(() => defaultExpiry(now()), [now]);

  const input: RfqInput = {
    requester: "",
    underlying,
    optionType,
    strike,
    expiry,
    isLong: true,
    // One contract, on-chain units against 6dp USDC collateral. The reserve is
    // what bounds the money; the size is deliberately the smallest honest one.
    numContracts: 1_000000n,
    reserveUsdc: reserve,
    offerWindowMin: windowMin,
  };

  /** Phase 2, kicked off once the request is on chain. */
  const waitFor = useCallback(
    async (opened: RfqOpen, d: RfqDeps, ring: RfqKeyring) => {
      const result = await awaitOffers(
        opened.quotationId,
        ring,
        d,
        { pollMs, ...(patienceMs === undefined ? {} : { patienceMs }) },
        (s, info) => {
          if (!alive.current) return;
          setStep(s);
          if (info?.polls !== undefined) setPolls(info.polls);
        },
      );
      if (!alive.current) return;
      if (result.status === "offers") setState({ kind: "offers", open: opened, offers: result.offers });
      else if (result.status === "unanswered")
        setState({
          kind: "unanswered",
          open: opened,
          elapsedMs: result.elapsedMs,
          polls: result.polls,
        });
      else if (result.status === "closed")
        setState({ kind: "closed", open: opened, note: `quotation ${result.state.status}` });
      else setState({ kind: "failed", error: result.error });
    },
    [pollMs, patienceMs],
  );

  async function start() {
    if (!armed || !wallet) return;
    setState({ kind: "opening" });
    setStep(null);
    setPolls(0);

    const d = makeDeps ? makeDeps(wallet) : createLiveRfqDeps(wallet);
    deps.current = d;

    let ring: RfqKeyring;
    try {
      ring = createKeyring(d.generateKeyPair());
    } catch {
      // `generateKeyPair` needs a client, which needs a signer. Ask for the
      // signer first and try once more — a first press should not fail on
      // ordering the user cannot see.
      try {
        await d.getSigner();
        ring = createKeyring(d.generateKeyPair());
      } catch (error) {
        setState({
          kind: "failed",
          error: {
            code: "SIGNER_REQUIRED",
            message: "No wallet can sign this request.",
            recovery: "Connect a wallet on Base, then open the request again.",
            action: "connect",
            step: "key",
            detail: error instanceof Error ? error.message : String(error),
          },
        });
        return;
      }
    }
    keyring.current?.forget();
    keyring.current = ring;

    const opened = await openRequest({ ...input, requester: "" }, ring, d, (s, info) => {
      if (!alive.current) return;
      setStep(s);
      void info;
    });
    if (!alive.current) return;
    if (opened.status === "failed") {
      setState({ kind: "failed", error: opened.error });
      return;
    }
    setState({ kind: "waiting", open: opened });
    void waitFor(opened, d, ring);
  }

  /**
   * Accept a bid.
   *
   * **The button the user pressed was the premium itself**, so the click and the
   * consent are the same event and `confirm` resolves immediately. That is the
   * same rule the fill panel holds — the thing you press is the amount you spend
   * — expressed for a flow where the amount is already known when the button is
   * drawn, rather than discovered by a preview mid-sequence.
   */
  async function accept(open: RfqOpen, offer: RfqOffer) {
    const d = deps.current;
    if (!d) return;
    setState({ kind: "settling", open, offer });
    const result = await acceptOffer(offer, reserve, { ...d, confirm: async () => true }, (s) => {
      if (alive.current) setStep(s);
    });
    if (!alive.current) return;
    if (result.status === "settled")
      setState({ kind: "settled", open, offer, hash: result.hash, explorer: result.explorer });
    else if (result.status === "failed") setState({ kind: "failed", error: result.error });
    else setState({ kind: "offers", open, offers: [offer] });
  }

  async function cancel(open: RfqOpen) {
    const d = deps.current;
    if (!d) return;
    const result = await cancelRequest(open.quotationId, d);
    if (!alive.current) return;
    if (result.status === "failed") setState({ kind: "failed", error: result.error });
    else setState({ kind: "closed", open, note: "request cancelled" });
  }

  const phase: RfqPhase = step ? RFQ_PHASE_OF[step] : "request";
  const elapsed = waitingSince === null ? 0 : now() - waitingSince;
  void tick; // the interval's only job is to force this recompute.

  return (
    <section
      data-testid="rfq-panel"
      style={sx(
        `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`,
      )}
    >
      <div
        style={sx(
          `display:flex;align-items:center;gap:12px;padding:14px 18px;border-bottom:1px solid ${C.border};flex-wrap:wrap`,
        )}
      >
        <span style={sx(`font:700 14px/1 ${SANS}`)}>Request for quote</span>
        <span style={sx(tag(C.violet))}>PATIENT</span>
        <div style={sx("flex:1")} />
        <span style={sx(`font:500 10px/1 ${MONO};color:${C.dim}`)}>
          client.optionFactory.requestForQuotation()
        </span>
      </div>

      {/* The honesty header. It is above the form on purpose: the expectation has
          to be set before anything is pressed, not explained afterwards. */}
      <div
        style={sx(
          `padding:12px 18px;border-bottom:1px solid ${C.lineSoft};font:400 11px/1.6 ${MONO};color:${C.muted}`,
        )}
      >
        Four phases, two of your transactions, and a wait with no deadline on it. Market makers are
        not obliged to answer and often will not. This is a desk tool to leave open — it is
        deliberately outside the duel.
      </div>

      {/* The four phases, named up front. */}
      <div style={sx("display:flex;flex-direction:column")}>
        {(Object.keys(RFQ_PHASE_COPY) as RfqPhase[]).map((p) => {
          const here = armed && state.kind !== "idle" && phase === p;
          return (
            <div
              key={p}
              style={sx(
                `display:flex;gap:12px;align-items:baseline;padding:9px 18px;` +
                  `border-bottom:1px solid ${C.lineSoft};` +
                  (here ? `background:${C.raised}` : ""),
              )}
            >
              <span
                style={sx(
                  `min-width:88px;font:700 9px/1 ${MONO};letter-spacing:.1em;` +
                    `color:${here ? C.accent : C.faint}`,
                )}
              >
                {RFQ_PHASE_COPY[p].label}
              </span>
              <span style={sx(`font:400 10.5px/1.5 ${MONO};color:${C.dim}`)}>
                {RFQ_PHASE_COPY[p].means}
              </span>
            </div>
          );
        })}
      </div>

      {/* The form. Rendered always — an inert desk still shows what it would ask
          for — but every control is disabled without the flag and a wallet. */}
      <div style={sx("padding:14px 18px;display:flex;flex-direction:column;gap:12px")}>
        <div style={sx("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
          <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>BOOK</span>
          {TRADABLE.map((u) => (
            <button
              key={u}
              disabled={!armed}
              onClick={() => setUnderlying(u)}
              style={sx(pill(underlying === u))}
            >
              {u}
            </button>
          ))}
          {(["CALL", "PUT"] as const).map((t) => (
            <button
              key={t}
              disabled={!armed}
              onClick={() => setOptionType(t)}
              style={sx(pill(optionType === t))}
            >
              {t}
            </button>
          ))}
          <span style={sx(`font:400 10.5px/1.4 ${MONO};color:${C.faint}`)}>
            {underlying}-{expiryText(expiry)}-{strike}-{optionType === "CALL" ? "C" : "P"}
            {spot === null ? " · strike from reference" : " · strike off live spot"}
          </span>
        </div>

        <div style={sx("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
          <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>
            RESERVE
          </span>
          {RESERVE_LADDER.filter((r) => r <= MAX_RFQ_USDC).map((r) => (
            <button
              key={String(r)}
              disabled={!armed}
              onClick={() => setReserve(r)}
              style={sx(pill(reserve === r))}
            >
              ${usdText(r)}
            </button>
          ))}
          <span style={sx(`font:400 10px/1.4 ${MONO};color:${C.faint}`)}>
            most premium you will pay · cap ${usdText(MAX_RFQ_USDC)}, enforced in code
          </span>
        </div>

        <div style={sx("display:flex;align-items:center;gap:8px;flex-wrap:wrap")}>
          <span style={sx(`font:500 10px/1 ${MONO};letter-spacing:.1em;color:${C.dim}`)}>WINDOW</span>
          {[5, 10, 30].map((m) => (
            <button
              key={m}
              disabled={!armed}
              onClick={() => setWindowMin(m)}
              style={sx(pill(windowMin === m))}
            >
              {m}m
            </button>
          ))}
          <span style={sx(`font:400 10px/1.4 ${MONO};color:${C.faint}`)}>
            how long bids are accepted. Not a promise that any arrive.
          </span>
        </div>

        {/* The key disclosure, before the request rather than after it is lost. */}
        <div style={sx(`font:400 10px/1.5 ${MONO};color:${C.faint}`)}>
          Bids are sealed to an ECDH key generated in this tab and never written to storage —
          reloading this page makes any bid already sealed to it permanently unreadable. That is the
          trade: a lost key costs one request, a stored key costs every sealed bid.
        </div>

        {!armed && (
          <div style={sx(`font:400 11px/1.5 ${MONO};color:${C.dim}`)}>
            {wallet === undefined
              ? "Read-only preview. No signer connected."
              : wallet.id === "mock"
                ? "Mock wallet — it cannot sign and must not. Nothing here is armed."
                : "THETADUEL_TRADE is off. Nothing here is armed."}
          </div>
        )}

        {armed && state.kind === "idle" && (
          <button
            onClick={() => void start()}
            style={sx(
              `height:36px;border:none;border-radius:8px;background:${C.accent};color:${C.bg};` +
                `font:700 12px/1 ${SANS};cursor:pointer`,
            )}
          >
            Open request · reserve ${usdText(reserve)} USDC
          </button>
        )}

        {state.kind === "opening" && (
          <div style={sx(`font:400 11px/1.5 ${MONO};color:${C.dim}`)}>
            publishing the request{step ? ` · ${step}` : ""}…
          </div>
        )}

        {/* Phase 2. No spinner: an elapsed clock and a poll count, which are the
            only two true statements available while waiting. */}
        {state.kind === "waiting" && (
          <div style={sx(`font:400 11px/1.6 ${MONO};color:${C.muted}`)}>
            <div>
              <span style={sx(`color:${C.violet};font-weight:700`)}>
                waiting {elapsedText(elapsed)}
              </span>{" "}
              · {polls} {polls === 1 ? "poll" : "polls"} · no bids yet
            </div>
            <div style={sx(`margin-top:5px;color:${C.faint}`)}>
              request #{state.open.quotationId} is open. You can close this and come back — nothing
              is locked, and nothing about this is imminent.
            </div>
            <button
              onClick={() => void cancel(state.open)}
              style={sx(
                `margin-top:8px;height:28px;padding:0 10px;border:1px solid ${C.borderMid};` +
                  `border-radius:7px;background:transparent;color:${C.muted};` +
                  `font:500 11px/1 ${SANS};cursor:pointer`,
              )}
            >
              Cancel request
            </button>
          </div>
        )}

        {/* Phase 3 + 4. Each bid's own premium is the button. */}
        {state.kind === "offers" && (
          <div style={sx(`font:400 11px/1.6 ${MONO};color:${C.muted}`)}>
            <div style={sx(`color:${C.green}`)}>
              {state.offers.length} {state.offers.length === 1 ? "bid" : "bids"} after{" "}
              {elapsedText(elapsed)}
            </div>
            {state.offers.map((o) => (
              <div
                key={`${o.offeror}-${o.createdAt}`}
                style={sx(
                  `margin-top:9px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;` +
                    `padding-top:9px;border-top:1px solid ${C.lineSoft}`,
                )}
              >
                <span style={sx(`color:${C.faint}`)}>
                  {o.offeror.slice(0, 8)}…{o.offeror.slice(-4)}
                </span>
                {o.unreadable || o.offerAmount === null ? (
                  <span style={sx(`color:${C.amber}`)}>
                    sealed to a key this tab cannot open — the bid exists, it just cannot be read
                  </span>
                ) : (
                  <>
                    <button
                      onClick={() => void accept(state.open, o)}
                      style={sx(
                        `border:1px solid ${C.accent};border-radius:7px;background:rgba(200,255,0,.12);` +
                          `color:${C.accent};font:700 13px/1 ${MONO};padding:7px 10px;cursor:pointer`,
                      )}
                    >
                      ${usdText(o.offerAmount)}
                    </button>
                    <span style={sx(`color:${C.faint}`)}>
                      click the premium to approve exactly that and settle
                    </span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {state.kind === "settling" && (
          <div style={sx(`font:400 11px/1.5 ${MONO};color:${C.dim}`)}>
            {step === "approve" ? "approving the exact premium…" : "revealing and settling…"}
          </div>
        )}

        {state.kind === "settled" && (
          <div style={sx(`font:400 11px/1.6 ${MONO};color:${C.green}`)}>
            SETTLED · premium ${state.offer.offerAmount === null ? "—" : usdText(state.offer.offerAmount)}{" "}
            · request #{state.open.quotationId}
            <div style={sx("margin-top:6px")}>
              <a
                href={state.explorer}
                target="_blank"
                rel="noreferrer"
                style={sx(`color:${C.accent}`)}
              >
                {state.hash.slice(0, 12)}… on BaseScan
              </a>
            </div>
          </div>
        )}

        {/* The normal ending. Dim, not amber; a sentence, not an error box. */}
        {state.kind === "unanswered" && (
          <div style={sx(`font:400 11px/1.6 ${MONO};color:${C.dim}`)}>
            <div style={sx(`color:${C.muted}`)}>
              No bids after {elapsedText(state.elapsedMs)} · {state.polls} polls
            </div>
            <div style={sx("margin-top:6px")}>{UNANSWERED_COPY}</div>
            <button
              onClick={() => void cancel(state.open)}
              style={sx(
                `margin-top:8px;height:28px;padding:0 10px;border:1px solid ${C.borderMid};` +
                  `border-radius:7px;background:transparent;color:${C.muted};` +
                  `font:500 11px/1 ${SANS};cursor:pointer`,
              )}
            >
              Cancel request
            </button>
          </div>
        )}

        {state.kind === "closed" && (
          <div style={sx(`font:400 11px/1.5 ${MONO};color:${C.dim}`)}>
            {state.note} · request #{state.open.quotationId}
          </div>
        )}

        {state.kind === "failed" && (
          <div
            style={sx(
              `border:1px solid ${C.amber}55;background:${C.amber}12;border-radius:8px;padding:10px;` +
                `font:400 11px/1.6 ${MONO};color:${C.amber}`,
            )}
          >
            <div style={sx(`font:700 10px/1 ${MONO};letter-spacing:.1em`)}>
              {state.error.code} · at {state.error.step.toUpperCase()}
            </div>
            <div style={sx(`margin-top:7px;color:${C.textSoft}`)}>{state.error.message}</div>
            <div style={sx(`margin-top:5px;color:${C.muted}`)}>{state.error.recovery}</div>
            {state.error.detail && (
              <div style={sx(`margin-top:5px;color:${C.faint}`)}>{state.error.detail}</div>
            )}
            <button
              onClick={() => {
                const action = state.error.action;
                if (action === "connect") void wallet?.connect?.();
                else if (action === "switch") void wallet?.switchToBase?.();
                else if (action === "retry") void start();
                else setState({ kind: "idle" });
              }}
              style={sx(
                `margin-top:9px;height:28px;padding:0 10px;border:1px solid ${C.borderMid};` +
                  `border-radius:7px;background:transparent;color:${C.muted};` +
                  `font:500 11px/1 ${SANS};cursor:pointer`,
              )}
            >
              {state.error.action === "connect"
                ? "Connect wallet"
                : state.error.action === "switch"
                  ? "Switch to Base"
                  : state.error.action === "retry"
                    ? "Try again"
                    : "Dismiss"}
            </button>
          </div>
        )}
      </div>

      {/* What only a live market maker can confirm. On the panel, not in a
          changelog, because a demo audience is exactly who needs to know it. */}
      <div
        style={sx(
          `padding:11px 18px;border-top:1px solid ${C.border};font:400 10px/1.6 ${MONO};color:${C.faint}`,
        )}
      >
        Never exercised against a live market maker. The sequence, the invariants and the error map
        are covered offline in test/rfq.test.ts; whether anyone bids, how long they take, and the
        in-flight shape of a sealed offer are not knowable from here.
      </div>
    </section>
  );
}
