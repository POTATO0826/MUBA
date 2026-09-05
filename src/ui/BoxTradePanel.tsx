import { useEffect, useMemo, useRef, useState } from "react";
import {
  TARGET_FILL_USDC,
  contracts as contractText,
  createLiveFillDeps,
  runFill,
  usdText,
  type FillDeps,
  type FillOutcome,
  type FillQuote,
  type FillStep,
} from "../desk/fill.ts";
import { TARGET_RFQ_USDC, type RfqDeps } from "../desk/rfq.ts";
import { zoneEconomics, zoneQuote } from "../data/ranger.ts";
import type { CondorSpec } from "../data/condor.ts";
import type { MarketSource } from "../data/market.ts";
import type { WalletSource } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS } from "../theme.ts";
import { RfqPanel, type RfqPanelWallet } from "./RfqPanel.tsx";
import type { ListedFill } from "../views/BoxBuilder.tsx";

/** The first auction limit, shown before an unlisted box is sent for pricing. */
export const BOX_STARTING_MAX_LOSS_USD = Number(TARGET_RFQ_USDC) / 1_000_000;

interface TradeConfig {
  enabled: boolean;
  referrer: string;
}

const TRADE_OFF: TradeConfig = { enabled: false, referrer: "" };

export interface BoxTradePanelProps {
  spec: CondorSpec;
  match: ListedFill | null;
  source: MarketSource;
  wallet: WalletSource;
  /** Tests and controlled embeds can bypass the config read, never the signer. */
  enabled?: boolean;
  onBack: () => void;
  onActiveChange?: (active: boolean) => void;
  onFilled?: (outcome: Extract<FillOutcome, { status: "filled" }>) => void;
  makeFillDeps?: (wallet: WalletSource, referrer: string) => FillDeps;
  makeRfqDeps?: (wallet: RfqPanelWallet) => RfqDeps;
}

function useTradeConfig(wallet: WalletSource, override: boolean | undefined): TradeConfig {
  const [config, setConfig] = useState<TradeConfig>(TRADE_OFF);

  useEffect(() => {
    if (override !== undefined || wallet.id === "mock") return;
    let live = true;
    void (async () => {
      try {
        const response = await fetch("/api/config", { cache: "no-store" });
        const body = (await response.json()) as {
          referrer?: string;
          features?: { trade?: boolean };
        };
        if (!live) return;
        setConfig({
          enabled: body.features?.trade === true,
          referrer: typeof body.referrer === "string" ? body.referrer : "",
        });
      } catch {
        // Money-moving actions fail closed. The panel below explains how to
        // recover instead of turning a missing config route into a dead click.
      }
    })();
    return () => {
      live = false;
    };
  }, [override, wallet.id]);

  return override === undefined ? config : { ...config, enabled: override };
}

function usd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const digits = value !== 0 && Math.abs(value) < 1 ? 4 : 2;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  });
}

function expiryText(expiry: number): string {
  return new Date(expiry * 1000).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

const CARD = `border:1px solid ${C.border};border-radius:12px;background:${C.panel};overflow:hidden`;
const LABEL = `font:500 10px/1 ${MONO};letter-spacing:.12em;color:${C.dim}`;
const VALUE = `font:700 15px/1.25 ${MONO};color:${C.text}`;
const NOTE = `font:400 11px/1.55 ${SANS};color:${C.faint}`;
const ACTION =
  `min-height:40px;padding:0 16px;border:1px solid ${C.accent};border-radius:9px;` +
  `background:${C.accent};color:${C.bg};font:700 12px/1 ${SANS};cursor:pointer`;
const SECONDARY =
  `min-height:40px;padding:0 16px;border:1px solid ${C.borderMid};border-radius:9px;` +
  `background:transparent;color:${C.text};font:700 12px/1 ${SANS};cursor:pointer`;

/**
 * The single execution fork for a drawn box.
 *
 * A priced listed zone goes through the OptionBook. Every other box goes to
 * the existing sealed-bid auction, where the player sets their maximum loss
 * before a request is published. Neither route can sign without both the
 * operator flag and a real wallet.
 */
export function BoxTradePanel(props: BoxTradePanelProps) {
  const [active, setActive] = useState(false);
  const activeListener = useRef(props.onActiveChange);
  activeListener.current = props.onActiveChange;
  const premium = props.match ? zoneQuote(props.match.zone) : null;
  const nonce = props.match?.zone.order.quote?.orderNonce;
  const instant = props.match !== null && premium !== null && typeof nonce === "string" && nonce !== "";
  const config = useTradeConfig(props.wallet, props.enabled);

  useEffect(() => {
    props.onActiveChange?.(active);
  }, [active, props.onActiveChange]);
  useEffect(() => () => activeListener.current?.(false), []);

  if (!instant || !props.match || premium === null || !nonce) {
    return (
      <div style={sx("display:grid;gap:12px")}>
        <RfqPanel
          source={props.source}
          wallet={props.wallet}
          enabled={config.enabled}
          makeDeps={props.makeRfqDeps}
          box={props.spec}
          onActiveChange={setActive}
        />
        <button
          className="box-action"
          onClick={props.onBack}
          disabled={active}
          style={sx(`${SECONDARY}${active ? ";opacity:.45;cursor:not-allowed" : ""}`)}
        >
          {active ? "Cancel the request to go back" : "Back to box"}
        </button>
      </div>
    );
  }

  return (
    <InstantListedFill
      spec={props.spec}
      match={props.match}
      premium={premium}
      nonce={nonce}
      wallet={props.wallet}
      config={config}
      onBack={props.onBack}
      onFilled={props.onFilled}
      onActiveChange={setActive}
      makeFillDeps={props.makeFillDeps}
    />
  );
}

function InstantListedFill({
  spec,
  match,
  premium,
  nonce,
  wallet,
  config,
  onBack,
  onFilled,
  onActiveChange,
  makeFillDeps,
}: {
  spec: CondorSpec;
  match: ListedFill;
  premium: number;
  nonce: string;
  wallet: WalletSource;
  config: TradeConfig;
  onBack: () => void;
  onFilled?: BoxTradePanelProps["onFilled"];
  onActiveChange?: BoxTradePanelProps["onActiveChange"];
  makeFillDeps?: BoxTradePanelProps["makeFillDeps"];
}) {
  const [step, setStep] = useState<FillStep | null>(null);
  const [quote, setQuote] = useState<FillQuote | null>(null);
  const [outcome, setOutcome] = useState<FillOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const decide = useRef<((accepted: boolean) => void) | null>(null);

  useEffect(() => () => decide.current?.(false), []);
  useEffect(() => {
    onActiveChange?.(running);
  }, [onActiveChange, running]);

  const armed = config.enabled && wallet.id !== "mock";
  const perContract = useMemo(
    () => zoneEconomics(match.zone, premium, 1),
    [match.zone, premium],
  );
  const actual = useMemo(() => {
    if (!quote) return null;
    const count = Number(quote.numContracts) / 1_000_000;
    const paid = Number(quote.totalCollateral) / 1_000_000;
    return { count, ...zoneEconomics(match.zone, paid, count) };
  }, [match.zone, quote]);

  async function start() {
    if (!armed || running) return;
    setRunning(true);
    setOutcome(null);
    setQuote(null);
    setStep(null);

    const deps = makeFillDeps
      ? makeFillDeps(wallet, config.referrer)
      : createLiveFillDeps(wallet, { referrer: config.referrer || undefined });
    deps.confirm = (next) =>
      new Promise<boolean>((resolve) => {
        setQuote(next);
        decide.current = resolve;
      });

    const result = await runFill(
      {
        nonce,
        identity: `RANGER|${match.zone.underlying}|${match.zone.expiry}|${match.zone.strikes.join(",")}`,
        label: `${match.zone.underlying} RANGER ${match.zone.floor}-${match.zone.ceiling}`,
      },
      TARGET_FILL_USDC,
      deps,
      (next, info) => {
        setStep(next);
        if (info?.quote) setQuote(info.quote);
      },
    );

    decide.current = null;
    setOutcome(result);
    setRunning(false);
    if (result.status === "filled") onFilled?.(result);
  }

  function recover() {
    if (outcome?.status !== "failed") return;
    const action = outcome.error.action;
    if (action === "connect") void wallet.connect();
    else if (action === "switch") void wallet.switchToBase();
    else if (action === "retry" || action === "refresh") void start();
    else onBack();
  }

  return (
    <section style={sx(CARD)} aria-busy={running}>
      <div
        style={sx(
          `display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:14px 18px;` +
            `border-bottom:1px solid ${C.border}`,
        )}
      >
        <span style={sx(`font:700 14px/1 ${SANS}`)}>Buy this listed box</span>
        <span style={sx(`${LABEL};color:${C.accent}`)}>INSTANT · OPTIONBOOK</span>
      </div>

      <div style={sx("padding:16px 18px;display:grid;gap:14px")}>
        <div style={sx("display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:14px")}>
          <div style={sx("display:grid;gap:5px")}>
            <span style={sx(LABEL)}>POSITION</span>
            <span style={sx(VALUE)}>
              {match.zone.underlying} · ${usd(perContract.zone.floor)}–${usd(perContract.zone.ceiling)}
            </span>
            <span style={sx(NOTE)}>Listed RANGER · expires {expiryText(spec.expiry)}</span>
          </div>
          <div style={sx("display:grid;gap:5px")}>
            <span style={sx(`${LABEL};color:${C.red}`)}>MAX LOSS</span>
            <span style={sx(`${VALUE};color:${C.red}`)}>${usd(perContract.maxLoss)} per contract</span>
            <span style={sx(NOTE)}>The maker’s current ask. The exact partial-fill amount appears before approval.</span>
          </div>
          <div style={sx("display:grid;gap:5px")}>
            <span style={sx(LABEL)}>MAX PAYOUT</span>
            <span style={sx(`${VALUE};color:${C.green}`)}>${usd(perContract.maxPayout)} per contract</span>
            <span style={sx(NOTE)}>Maximum gross settlement if price lands in the band at expiry.</span>
          </div>
        </div>

        {!armed && (
          <div style={sx(`${NOTE};padding:10px 12px;border:1px solid ${C.border};border-radius:8px`)}>
            {wallet.id === "mock"
              ? "Connect a signing wallet on Base to buy. The mock wallet can play the duel but cannot spend USDC."
              : "Trading is off for this server. Set THETADUEL_TRADE=on and reload to enable the capped fill."}
          </div>
        )}

        {running && step === "confirm" && quote && actual && (
          <div aria-live="polite" style={sx(`display:grid;gap:10px;padding:12px;border:1px solid ${C.accent}66;border-radius:9px`)}>
            <span style={sx(LABEL)}>EXACT FILL PREVIEW</span>
            <span style={sx(`${VALUE};color:${C.red}`)}>MAX LOSS ${usdText(quote.totalCollateral)} USDC</span>
            <span style={sx(`${VALUE};color:${C.green}`)}>MAX PAYOUT ${usd(actual.maxPayout)} USDC</span>
            <span style={sx(NOTE)}>
              {contractText(quote.numContracts)} contracts · click the loss amount to approve exactly this fill.
            </span>
            <div style={sx("display:flex;gap:8px;flex-wrap:wrap")}>
              <button
                className="box-action"
                onClick={() => decide.current?.(true)}
                style={sx(ACTION)}
              >
                Confirm max loss · ${usdText(quote.totalCollateral)} USDC
              </button>
              <button
                className="box-action"
                onClick={() => decide.current?.(false)}
                style={sx(SECONDARY)}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {running && step !== "confirm" && (
          <div aria-live="polite" style={sx(NOTE)}>
            {step === "allowance"
              ? "Checking the exact USDC allowance…"
              : step === "fill"
                ? "Submitting the fill on Base…"
                : "Refreshing the order and preparing an exact fill…"}
          </div>
        )}

        {outcome?.status === "filled" && (
          <div aria-live="polite" style={sx(`display:grid;gap:7px;color:${C.green}`)}>
            <span style={sx(VALUE)}>Box bought</span>
            <span style={sx(NOTE)}>
              Max loss {usdText(outcome.quote.totalCollateral)} USDC · {contractText(outcome.quote.numContracts)} contracts.
            </span>
            <a
              className="box-action"
              href={outcome.explorer}
              target="_blank"
              rel="noreferrer"
              style={sx(`${NOTE};color:${C.accent};width:max-content`)}
            >
              View transaction on BaseScan
            </a>
          </div>
        )}

        {outcome?.status === "cancelled" && (
          <div aria-live="polite" style={sx(NOTE)}>Purchase cancelled. Nothing was approved or spent.</div>
        )}

        {outcome?.status === "failed" && (
          <div aria-live="assertive" style={sx(`display:grid;gap:7px;padding:12px;border:1px solid ${C.amber}66;border-radius:9px`)}>
            <span style={sx(`${LABEL};color:${C.amber}`)}>{outcome.error.code}</span>
            <span style={sx(`font:600 12px/1.4 ${SANS};color:${C.text}`)}>{outcome.error.message}</span>
            <span style={sx(NOTE)}>{outcome.error.recovery}</span>
            <button className="box-action" onClick={recover} style={sx(SECONDARY)}>
              {outcome.error.action === "connect"
                ? "Connect wallet"
                : outcome.error.action === "switch"
                  ? "Switch to Base"
                  : outcome.error.action === "retry" || outcome.error.action === "refresh"
                    ? "Try again"
                    : "Back to box"}
            </button>
          </div>
        )}

        {!running && outcome?.status !== "filled" && (
          <div style={sx("display:flex;gap:8px;flex-wrap:wrap")}>
            <button
              className="box-action"
              onClick={() => void start()}
              disabled={!armed}
              style={sx(`${ACTION}${armed ? "" : ";opacity:.45;cursor:not-allowed"}`)}
            >
              Prepare capped fill · from ${usdText(TARGET_FILL_USDC)} USDC
            </button>
            <button className="box-action" onClick={onBack} style={sx(SECONDARY)}>
              Back to box
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
