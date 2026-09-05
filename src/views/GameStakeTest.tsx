import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Contract,
  JsonRpcProvider,
  formatEther,
  getAddress,
  parseEther,
  type ContractTransactionResponse,
} from "ethers";
import { BASE_SEPOLIA } from "../data/base-network.ts";
import type { WalletSource } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, tag } from "../theme.ts";
import {
  BASE_SEPOLIA_EXPLORER,
  GAME_STAKE_ABI,
  GAME_STAKE_ADDRESS,
  ZERO_ADDRESS,
  gameStakeBlocker,
  matchIdFromInput,
  seatsTaken,
  type MatchState,
} from "../utils/gamestake.ts";

/**
 * The GameStake console: two functions, one pot, nothing else on the page.
 *
 * Deliberately not a second copy of the DuelEscrow console. That contract has
 * thirteen functions and a signature to paste; this one has `stake` and
 * `winnerTakesAll`, so the page is two cards and a live read of the match.
 */

const PAGE =
  "width:min(940px,calc(100% - 32px));margin:0 auto;padding:48px 0 72px;display:grid;gap:22px";
const PANEL = `background:${C.panel};border:1px solid ${C.border};border-radius:12px;padding:20px`;
const LABEL = `font:700 10px/1 ${MONO};letter-spacing:.12em;color:${C.muted}`;
const BODY = `font:500 13px/1.55 ${SANS};color:${C.textSoft}`;
const VALUE = `font:600 12px/1.5 ${MONO};color:${C.text};word-break:break-all`;
const INPUT =
  `width:100%;height:42px;border:1px solid ${C.borderMid};border-radius:8px;` +
  `background:${C.raised};color:${C.text};padding:0 12px;font:500 12px/1 ${MONO}`;
const BUTTON =
  `min-height:42px;border:1px solid ${C.accent}55;border-radius:8px;padding:0 14px;` +
  `background:${C.accent};color:${C.bg};font:700 12px/1 ${SANS};cursor:pointer`;
const SECONDARY =
  `min-height:42px;border:1px solid ${C.borderMid};border-radius:8px;padding:0 14px;` +
  `background:${C.raised};color:${C.text};font:700 12px/1 ${SANS};cursor:pointer`;
const DISABLED = ";opacity:.45;cursor:not-allowed";

type ActionState =
  | { kind: "idle" }
  | { kind: "pending"; label: string; hash?: string }
  | { kind: "success"; label: string; hash: string }
  | { kind: "error"; message: string };

function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { shortMessage?: unknown; reason?: unknown; message?: unknown };
    for (const value of [e.shortMessage, e.reason, e.message]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return "The request failed. Check the network, inputs and wallet, then retry.";
}

function short(value: string): string {
  return value.length > 26 ? `${value.slice(0, 10)}…${value.slice(-8)}` : value;
}

function Field({
  id: fieldId,
  label,
  value,
  onChange,
  hint,
  error,
  placeholder,
  inputMode,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  error?: string | null;
  placeholder?: string;
  inputMode?: "text" | "decimal";
}) {
  const describedBy = hint || error ? `${fieldId}-description` : undefined;
  return (
    <div style={sx("display:grid;gap:7px")}>
      <label htmlFor={fieldId} style={sx(LABEL)}>{label}</label>
      <input
        id={fieldId}
        className="contract-control"
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        onChange={(event) => onChange(event.target.value)}
        style={sx(INPUT + (error ? `;border-color:${C.red}` : ""))}
      />
      {(error || hint) && (
        <span
          id={describedBy}
          role={error ? "alert" : undefined}
          style={sx(`font:600 11px/1.45 ${SANS};color:${error ? C.red : C.muted}`)}
        >
          {error ?? hint}
        </span>
      )}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={sx(`min-width:0;display:grid;gap:8px;padding:12px;background:${C.card};border-radius:8px`)}>
      <span style={sx(LABEL)}>{label}</span>
      <span style={sx(VALUE)}>{children}</span>
    </div>
  );
}

export function GameStakeTest({
  wallet,
  initialAddress,
}: {
  wallet: WalletSource;
  /** Test seam. Production reads THETADUEL_GAMESTAKE from /api/config. */
  initialAddress?: string;
}) {
  const [address, setAddress] = useState(initialAddress ?? GAME_STAKE_ADDRESS);
  const [matchKey, setMatchKey] = useState("game-1");
  const [amount, setAmount] = useState("0.001");
  const [winner, setWinner] = useState("");
  const [state, setState] = useState<MatchState | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [action, setAction] = useState<ActionState>({ kind: "idle" });

  /** The address comes from the server, so the page never pins a stale one. */
  useEffect(() => {
    if (initialAddress !== undefined) return;
    let live = true;
    void fetch("/api/config")
      .then((response) => response.json())
      .then((body: { gameStake?: unknown }) => {
        if (!live) return;
        if (typeof body.gameStake === "string" && body.gameStake.trim()) {
          setAddress(body.gameStake.trim());
        }
      })
      .catch(() => {
        /* keep the compiled-in default */
      });
    return () => {
      live = false;
    };
  }, [initialAddress]);

  const matchId = useMemo(() => {
    try {
      return matchIdFromInput(matchKey);
    } catch {
      return "";
    }
  }, [matchKey]);

  const readMatch = useCallback(async () => {
    setReadError(null);
    if (!matchId || !address) return;
    try {
      const provider = new JsonRpcProvider(BASE_SEPOLIA.rpcUrl, BASE_SEPOLIA.chainId, {
        staticNetwork: true,
      });
      const contract = new Contract(address, GAME_STAKE_ABI, provider);
      const row = await contract.getFunction("matches")(matchId);
      setState({
        player1: String(row.player1 ?? row[0]),
        player2: String(row.player2 ?? row[1]),
        pool: BigInt(row.pool ?? row[2]),
        paid: Boolean(row.paid ?? row[3]),
      });
    } catch (error) {
      setState(null);
      setReadError(messageOf(error));
    }
  }, [address, matchId]);

  // Read as the key is typed, and again on a slow tick so the counterparty's
  // stake shows up without a manual refresh.
  useEffect(() => {
    const timer = setTimeout(() => void readMatch(), 400);
    return () => clearTimeout(timer);
  }, [readMatch]);
  useEffect(() => {
    const timer = setInterval(() => void readMatch(), 15_000);
    return () => clearInterval(timer);
  }, [readMatch]);

  const busy = action.kind === "pending";
  const connected = wallet.id !== "mock" && wallet.identity.connected;
  const rightChain = wallet.identity.chainId === BASE_SEPOLIA.chainId;
  const walletBlocker = !connected
    ? wallet.id === "mock"
      ? "Connect MetaMask or another injected wallet — the mock wallet cannot sign."
      : "Connect your wallet from the header."
    : !rightChain
      ? `Switch to Base Sepolia (84532). Current chain: ${wallet.identity.chainId ?? "unknown"}.`
      : null;
  const canWrite = !walletBlocker && !busy;

  const amountValidation = useMemo(() => {
    const value = amount.trim();
    if (!value) return { wei: null, error: "Enter an amount." };
    try {
      const wei = parseEther(value);
      // The contract's only rule: `require(msg.value > 0)`. No minimum.
      if (wei <= 0n) return { wei: null, error: "Stake must be more than zero." };
      return { wei, error: null };
    } catch {
      return { wei: null, error: "Enter a valid ETH amount." };
    }
  }, [amount]);

  async function transact(label: string, method: string, args: unknown[], overrides?: unknown) {
    if (!canWrite) {
      setAction({ kind: "error", message: walletBlocker ?? "A transaction is already running." });
      return;
    }
    setAction({ kind: "pending", label });
    try {
      const signer = await wallet.getSigner();
      if (!signer) throw new Error("Connect a real wallet first.");
      const contract = new Contract(address, GAME_STAKE_ABI, signer);
      const call = overrides === undefined ? args : [...args, overrides];
      const tx = (await contract.getFunction(method)(...call)) as ContractTransactionResponse;
      setAction({ kind: "pending", label, hash: tx.hash });
      await tx.wait();
      setAction({ kind: "success", label, hash: tx.hash });
      await readMatch();
    } catch (error) {
      setAction({ kind: "error", message: messageOf(error) });
    }
  }

  const stakeGate = gameStakeBlocker("stake", state, wallet.identity.address);
  const winGate = gameStakeBlocker("winnerTakesAll", state, wallet.identity.address, winner);
  const seats = seatsTaken(state);

  const button = (label: string, onClick: () => void, enabled: boolean) => (
    <button
      type="button"
      className="contract-control"
      disabled={!enabled}
      aria-busy={busy}
      onClick={onClick}
      style={sx(BUTTON + (enabled ? "" : DISABLED))}
    >
      {busy ? "Transaction in progress…" : label}
    </button>
  );

  const gateNote = (reason: string | null) =>
    reason && (
      <p role="status" style={sx(`${BODY};margin:0;color:${C.amber}`)}>
        {reason}
      </p>
    );

  return (
    <main style={sx(PAGE)}>
      <section style={sx("display:grid;gap:12px")}>
        <a className="contract-control" href="/" style={sx(`width:max-content;font:700 12px/1 ${MONO}`)}>
          ← Home
        </a>
        <div style={sx("display:flex;align-items:center;gap:10px;flex-wrap:wrap")}>
          <span style={sx(tag(C.blue))}>BASE SEPOLIA · 84532</span>
          <span style={sx(tag(C.green))}>GAMESTAKE</span>
        </div>
        <h1 style={sx(`margin:0;font:700 clamp(28px,5vw,48px)/1 ${SANS};letter-spacing:-.04em`)}>
          Stake &amp; winner takes all
        </h1>
        <p style={sx(`${BODY};margin:0;max-width:66ch`)}>
          Two wallets stake any amount into the same match key. Either one can then be paid the
          whole pot. No minimum, no timeout, no signature.
        </p>
        <span style={sx(`${VALUE};color:${C.muted}`)}>
          <a
            href={`${BASE_SEPOLIA_EXPLORER}/address/${address}`}
            target="_blank"
            rel="noreferrer noopener"
            style={sx(`color:${C.muted}`)}
          >
            {address} ↗
          </a>
        </span>
      </section>

      <section style={sx(`${PANEL};display:grid;gap:16px`)}>
        <Field
          id="match-key"
          label="MATCH KEY"
          value={matchKey}
          onChange={setMatchKey}
          placeholder="game-1"
          hint={matchId ? `matchId ${matchId}` : "Enter a key or a 0x… bytes32"}
        />
        {readError && <div role="alert" style={sx(`${BODY};color:${C.red}`)}>{readError}</div>}
        {state && (
          <div style={sx("display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px")}>
            <Fact label="POOL">{formatEther(state.pool)} ETH</Fact>
            <Fact label="SEATS">{seats} of 2</Fact>
            <Fact label="PLAYER 1">
              {state.player1 === ZERO_ADDRESS ? "empty" : short(state.player1)}
            </Fact>
            <Fact label="PLAYER 2">
              {state.player2 === ZERO_ADDRESS ? "empty" : short(state.player2)}
            </Fact>
            <Fact label="PAID OUT">{state.paid ? "Yes" : "No"}</Fact>
          </div>
        )}
      </section>

      {walletBlocker && (
        <div
          role="status"
          style={sx(`padding:13px;border:1px solid ${C.amber}55;border-radius:8px;background:${C.amber}12;color:${C.amber};font:600 13px/1.5 ${SANS}`)}
        >
          {walletBlocker}
        </div>
      )}

      <section style={sx("display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:14px")}>
        <div style={sx(`${PANEL};display:grid;align-content:start;gap:14px`)}>
          <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:12px")}>
            <h2 style={sx(`margin:0;font:700 16px/1.2 ${SANS}`)}>Stake</h2>
            <span style={sx(tag(C.violet))}>stake</span>
          </div>
          <Field
            id="amount"
            label="AMOUNT · TESTNET ETH"
            value={amount}
            onChange={setAmount}
            inputMode="decimal"
            error={amountValidation.error}
            hint="Any amount above zero. The two stakes do not have to match."
          />
          {gateNote(stakeGate)}
          {button(
            "Stake into this match",
            () =>
              void transact("Stake", "stake", [matchId], { value: amountValidation.wei ?? 0n }),
            canWrite && !amountValidation.error && !stakeGate && Boolean(matchId),
          )}
        </div>

        <div style={sx(`${PANEL};display:grid;align-content:start;gap:14px`)}>
          <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:12px")}>
            <h2 style={sx(`margin:0;font:700 16px/1.2 ${SANS}`)}>Winner takes all</h2>
            <span style={sx(tag(C.violet))}>winnerTakesAll</span>
          </div>
          <Field
            id="winner"
            label="WINNER ADDRESS"
            value={winner}
            onChange={setWinner}
            placeholder="0x…"
            hint="Must be one of the two wallets that staked."
          />
          {state && seats === 2 && (
            <div style={sx("display:flex;gap:8px;flex-wrap:wrap")}>
              <button
                type="button"
                className="contract-control"
                onClick={() => setWinner(state.player1)}
                style={sx(SECONDARY)}
              >
                Use player 1
              </button>
              <button
                type="button"
                className="contract-control"
                onClick={() => setWinner(state.player2)}
                style={sx(SECONDARY)}
              >
                Use player 2
              </button>
            </div>
          )}
          {gateNote(winGate)}
          {button(
            "Pay the whole pot",
            () => {
              try {
                void transact("Winner takes all", "winnerTakesAll", [
                  matchId,
                  getAddress(winner.trim()),
                ]);
              } catch (error) {
                setAction({ kind: "error", message: messageOf(error) });
              }
            },
            canWrite && !winGate && Boolean(matchId) && Boolean(winner.trim()),
          )}
        </div>
      </section>

      <section aria-live="polite" style={sx(`${PANEL};display:grid;gap:10px`)}>
        <span style={sx(LABEL)}>WALLET + TRANSACTION</span>
        <p style={sx(`${BODY};margin:0`)}>
          {connected && rightChain ? `Ready: ${wallet.identity.address}` : (walletBlocker ?? "")}
        </p>
        {action.kind === "idle" && <span style={sx(`${BODY};color:${C.muted}`)}>No transaction submitted.</span>}
        {action.kind === "pending" && (
          <span style={sx(`${BODY};color:${C.amber}`)}>
            {action.label} pending.{action.hash ? ` ${action.hash}` : " Confirm it in your wallet."}
          </span>
        )}
        {action.kind === "success" && (
          <a
            href={`${BASE_SEPOLIA_EXPLORER}/tx/${action.hash}`}
            target="_blank"
            rel="noreferrer noopener"
            style={sx(`${BODY};color:${C.green}`)}
          >
            {action.label} confirmed · View transaction ↗
          </a>
        )}
        {action.kind === "error" && <div role="alert" style={sx(`${BODY};color:${C.red}`)}>{action.message}</div>}
      </section>
    </main>
  );
}
