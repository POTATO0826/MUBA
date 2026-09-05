import { useCallback, useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import {
  Contract,
  JsonRpcProvider,
  formatEther,
  getAddress,
  isAddress,
  parseEther,
  type ContractTransactionResponse,
} from "ethers";
import { BASE_SEPOLIA } from "../data/base-network.ts";
import type { WalletSource } from "../data/wallet.ts";
import { sx } from "../lib/sx.ts";
import { C, MONO, SANS, tag } from "../theme.ts";
import {
  BASE_SEPOLIA_EXPLORER,
  BASE_SEPOLIA_DUEL_ESCROW_ADDRESS,
  DUEL_ESCROW_ABI,
  DUEL_ESCROW_FUNCTIONS,
  DUEL_STATUS,
  TEST_KEY_PREFIX,
  TEST_KEY_SCAN,
  duelIdFromInput,
  duelWriteBlocker,
  isKeyStartable,
  type DuelWrite,
} from "../utils/duelescrow.ts";

const REPORTED_ADDRESS = BASE_SEPOLIA_DUEL_ESCROW_ADDRESS;

/**
 * Where the key field starts before the chain has been asked anything. It is
 * only a placeholder: the first verified read replaces it with a key that is
 * actually usable, and this value is kept solely so that replacement knows the
 * user has not typed their own.
 */
const INITIAL_DUEL_KEY = `${TEST_KEY_PREFIX}1`;

const PAGE =
  "width:min(1180px,calc(100% - 32px));margin:0 auto;padding:48px 0 72px;display:grid;gap:24px";
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

interface ContractFacts {
  chainId: bigint;
  domainSeparator: string;
  minStake: bigint;
  timeout: bigint;
  verdictTypehash: string;
  attestor: string;
}

type CheckState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "valid"; facts: ContractFacts }
  | { kind: "invalid"; message: string; facts?: ContractFacts }
  | { kind: "error"; message: string };

interface DuelRead {
  id: string;
  a: string;
  b: string;
  invited: string;
  stake: bigint;
  fullAt: bigint;
  status: string;
  /** The raw ordinal, kept beside the label because the write gate needs it. */
  statusCode: number;
  aWithdrawn: boolean;
  bWithdrawn: boolean;
}


function messageOf(error: unknown): string {
  if (error && typeof error === "object") {
    const e = error as { shortMessage?: unknown; reason?: unknown; message?: unknown };
    for (const value of [e.shortMessage, e.reason, e.message]) {
      if (typeof value === "string" && value.trim()) return value;
    }
  }
  return "The request failed. Check the network, address, inputs, and wallet, then retry.";
}

function isMissingContractInterface(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { code?: unknown; data?: unknown; shortMessage?: unknown; message?: unknown };
  const text = `${String(e.shortMessage ?? "")} ${String(e.message ?? "")}`.toLowerCase();
  return (
    e.code === "CALL_EXCEPTION" ||
    e.data === "0x" ||
    text.includes("could not decode result data") ||
    text.includes("returned no data") ||
    text.includes("min_stake")
  );
}

function eth(amount: bigint): string {
  return `${formatEther(amount)} ETH`;
}

function short(value: string): string {
  return value.length > 28 ? `${value.slice(0, 12)}…${value.slice(-10)}` : value;
}

function Field({
  id,
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
  inputMode?: "text" | "decimal" | "numeric";
}) {
  const descriptionId = hint || error ? `${id}-description` : undefined;
  return (
    <div style={sx("display:grid;gap:7px") }>
      <label htmlFor={id} style={sx(LABEL)}>{label}</label>
      <input
        id={id}
        className="contract-control"
        type="text"
        inputMode={inputMode}
        autoComplete="off"
        spellCheck={false}
        value={value}
        placeholder={placeholder}
        aria-invalid={Boolean(error)}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.target.value)}
        style={sx(INPUT + (error ? `;border-color:${C.red}` : ""))}
      />
      {(error || hint) && (
        <span
          id={descriptionId}
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

export function ContractTest({
  wallet,
  initialAddress,
}: {
  wallet: WalletSource;
  /** Test seam. Production reads THETADUEL_ESCROW from /api/config. */
  initialAddress?: string;
}) {
  const [address, setAddress] = useState(initialAddress ?? REPORTED_ADDRESS);
  const [check, setCheck] = useState<CheckState>({ kind: "idle" });
  const [duelKey, setDuelKey] = useState(INITIAL_DUEL_KEY);
  const [stake, setStake] = useState("0.001");
  const [duel, setDuel] = useState<DuelRead | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);

  const checkContract = useCallback(async (candidate: string) => {
    const value = candidate.trim();
    if (!isAddress(value)) {
      setCheck({ kind: "invalid", message: "Enter a complete 0x contract address." });
      return;
    }
    setCheck({ kind: "loading" });
    try {
      const provider = new JsonRpcProvider(BASE_SEPOLIA.rpcUrl, BASE_SEPOLIA.chainId, {
        staticNetwork: true,
      });
      const canonical = getAddress(value);
      const code = await provider.getCode(canonical);
      if (code === "0x") {
        setCheck({ kind: "invalid", message: "No contract bytecode exists at this address on Base Sepolia." });
        return;
      }
      const contract = new Contract(canonical, DUEL_ESCROW_ABI, provider);
      const [
        chainId,
        domainSeparator,
        minStake,
        timeout,
        verdictTypehash,
        attestor,
      ] = await Promise.all([
        contract.getFunction("BASE_SEPOLIA_CHAIN_ID")(),
        contract.getFunction("DOMAIN_SEPARATOR")(),
        contract.getFunction("MIN_STAKE")(),
        contract.getFunction("TIMEOUT")(),
        contract.getFunction("VERDICT_TYPEHASH")(),
        contract.getFunction("attestor")(),
      ]);
      const facts: ContractFacts = {
        chainId: BigInt(chainId),
        domainSeparator: String(domainSeparator),
        minStake: BigInt(minStake),
        timeout: BigInt(timeout),
        verdictTypehash: String(verdictTypehash),
        attestor: getAddress(String(attestor)),
      };
      const mismatch =
        facts.chainId !== 84_532n ||
        facts.minStake !== parseEther("0.001") ||
        facts.timeout !== 21_600n;
      if (mismatch) {
        setCheck({
          kind: "invalid",
          facts,
          message: "The address responds, but its Base Sepolia or minimum-stake constants do not match this DuelEscrow build.",
        });
        return;
      }
      setAddress(canonical);
      setCheck({ kind: "valid", facts });
    } catch (error) {
      setCheck({
        kind: "error",
        message: isMissingContractInterface(error)
          ? "This address has bytecode, but it is not the current native-ETH DuelEscrow. Deploy contracts/DuelEscrow.sol on Base Sepolia and use the new deployment address; do not reuse the previous USDC escrow address."
          : `Could not verify a DuelEscrow interface at this address: ${messageOf(error)}`,
      });
    }
  }, []);

  useEffect(() => {
    if (initialAddress !== undefined) {
      void checkContract(initialAddress);
      return;
    }
    let live = true;
    void fetch("/api/config")
      .then((response) => response.json())
      .then((body: { escrow?: unknown }) => {
        if (!live) return;
        const configured = typeof body.escrow === "string" && body.escrow.trim()
          ? body.escrow.trim()
          : REPORTED_ADDRESS;
        setAddress(configured);
        void checkContract(configured);
      })
      .catch(() => {
        if (live) void checkContract(REPORTED_ADDRESS);
      });
    return () => {
      live = false;
    };
  }, [checkContract, initialAddress]);

  const facts = check.kind === "valid" ? check.facts : null;
  const derivedDuelId = useMemo(() => {
    try {
      return duelIdFromInput(duelKey);
    } catch {
      return "";
    }
  }, [duelKey]);
  const stakeValidation = useMemo(() => {
    const value = stake.trim();
    if (!value) return { amount: null, error: "Enter a stake amount." };
    try {
      const amount = parseEther(value);
      if (amount < parseEther("0.001")) {
        return { amount: null, error: "Stake must be at least 0.001 ETH." };
      }
      return { amount, error: null };
    } catch {
      return { amount: null, error: "Enter a valid ETH amount with no more than 18 decimals." };
    }
  }, [stake]);

  /**
   * The tick, and it does two jobs: it phrases `refund`'s "unlocks in about N
   * minutes", and it bounds how stale the snapshot the gate enforces can be.
   */
  const [nowSeconds, setNowSeconds] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNowSeconds(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(timer);
  }, []);

  const lookupDuel = useCallback(async (quiet = false) => {
    setLookupError(null);
    // A background refresh keeps the row on screen. Blanking it would flicker
    // the facts grid empty on every tick.
    if (!quiet) setDuel(null);
    try {
      if (!facts) throw new Error("Verify the DuelEscrow address first.");
      const duelId = duelIdFromInput(duelKey);
      const provider = new JsonRpcProvider(BASE_SEPOLIA.rpcUrl, BASE_SEPOLIA.chainId, {
        staticNetwork: true,
      });
      const contract = new Contract(address, DUEL_ESCROW_ABI, provider);
      const row = await contract.getFunction("duels")(duelId);
      const status = Number(row.status ?? row[5]);
      setDuel({
        id: duelId,
        a: String(row.a ?? row[0]),
        b: String(row.b ?? row[1]),
        invited: String(row.invited ?? row[2]),
        stake: BigInt(row.stake ?? row[3]),
        fullAt: BigInt(row.fullAt ?? row[4]),
        status: DUEL_STATUS[status] ?? `UNKNOWN (${status})`,
        statusCode: status,
        aWithdrawn: Boolean(row.aWithdrawn ?? row[6]),
        bWithdrawn: Boolean(row.bWithdrawn ?? row[7]),
      });
    } catch (error) {
      setLookupError(messageOf(error));
    }
  }, [address, duelKey, facts]);

  /**
   * Read the duel as the key is typed, rather than only when the button is
   * pressed. The write gate below is only as good as the state it reads, and a
   * gate nobody remembered to refresh is worse than none — it would disable a
   * button the chain would have accepted.
   *
   * Debounced because this fires per keystroke against a public RPC.
   */
  useEffect(() => {
    if (!facts || !derivedDuelId) return;
    const timer = setTimeout(() => void lookupDuel(), 400);
    return () => clearTimeout(timer);
  }, [facts, derivedDuelId, lookupDuel]);

  /**
   * Re-read on every tick, and this is a correctness requirement rather than a
   * nicety.
   *
   * The half of the duel this console cannot see is the COUNTERPARTY's: seat
   * two is taken by someone else's wallet, in someone else's browser, and
   * nothing tells this page about it. A snapshot taken while the duel was
   * `OPEN` therefore keeps insisting "settlement needs a full duel" long after
   * the duel filled — disabling `loseStake`, `winStake` and, after six hours,
   * the `refund` escape hatch, against a chain that would accept all three.
   *
   * A gate with no freshness bound is a gate that eventually lies. Thirty
   * seconds is the bound.
   */
  useEffect(() => {
    if (!facts || !derivedDuelId) return;
    void lookupDuel(true);
  }, [nowSeconds, facts, derivedDuelId, lookupDuel]);

  /**
   * Land on a key that can actually be used.
   *
   * A duel key names a permanent slot in contract storage, not a form value: it
   * moves NONE -> OPEN -> FULL -> SETTLED/REFUNDED and then never again. A fixed
   * default therefore works exactly once. `thetaduel-test-1` was opened and
   * cancelled long ago, so every visit since has opened this console onto a duel
   * where all five writes revert — which reads as "the page is broken" rather
   * than "that duel is over".
   *
   * So the console asks the chain instead of assuming: read the series in one
   * round trip and take the first key still startable. `isKeyStartable` accepts
   * OPEN as well as NONE so both players converge on the same key without
   * coordinating — see the note on that function.
   *
   * It runs once, and only while the field still holds the untouched default,
   * so it can never overwrite a key the user typed.
   */
  const [keyScanned, setKeyScanned] = useState(false);
  useEffect(() => {
    if (keyScanned || !facts) return;
    let live = true;
    void (async () => {
      const candidates = Array.from(
        { length: TEST_KEY_SCAN },
        (_, index) => `${TEST_KEY_PREFIX}${index + 1}`,
      );
      try {
        const provider = new JsonRpcProvider(BASE_SEPOLIA.rpcUrl, BASE_SEPOLIA.chainId, {
          staticNetwork: true,
        });
        const contract = new Contract(address, DUEL_ESCROW_ABI, provider);
        const statuses = await Promise.all(
          candidates.map(async (key) => {
            try {
              const row = await contract.getFunction("duels")(duelIdFromInput(key));
              return Number(row.status ?? row[5]);
            } catch {
              // One unreadable row must not veto the whole scan.
              return null;
            }
          }),
        );
        if (!live) return;
        const found = statuses.findIndex((status) => status !== null && isKeyStartable(status));
        if (found >= 0) {
          setDuelKey((current) => (current === INITIAL_DUEL_KEY ? candidates[found]! : current));
        }
      } catch {
        // A failed scan just leaves the default in place; the gate still explains it.
      } finally {
        if (live) setKeyScanned(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [keyScanned, facts, address]);

  const duelState = useMemo(
    () =>
      duel
        ? {
            a: duel.a,
            b: duel.b,
            stake: duel.stake,
            fullAt: duel.fullAt,
            status: duel.statusCode,
            aWithdrawn: duel.aWithdrawn,
            bWithdrawn: duel.bWithdrawn,
          }
        : null,
    [duel],
  );


  function submitCheck(event: FormEvent) {
    event.preventDefault();
    setDuel(null);
    void checkContract(address);
  }

  /**
   * A write control that knows what the duel currently is. The wallet-level
   * blocker above answers "can this page send anything at all"; this answers
   * "would the contract accept THIS call on THIS duel", which is the question
   * a spent key gets wrong.
   */

  return (
    <main style={sx(PAGE)}>
      <section style={sx("display:grid;gap:14px;max-width:800px") }>
        <a className="contract-control" href="/" style={sx(`width:max-content;font:700 12px/1 ${MONO}`)}>
          ← Home
        </a>
        <div style={sx("display:flex;align-items:center;gap:10px;flex-wrap:wrap") }>
          <span style={sx(tag(C.blue))}>BASE SEPOLIA · 84532</span>
          <span style={sx(tag(C.violet))}>INTERNAL TEST CONSOLE</span>
        </div>
        <h1 style={sx(`margin:0;font:700 clamp(30px,6vw,58px)/.98 ${SANS};letter-spacing:-.045em`)}>
          DuelEscrow function test
        </h1>
        <p style={sx(`${BODY};margin:0;max-width:68ch`)}>
          Verify the deployed bytecode, inspect every view, and exercise every write method from one page.
          Transactions stay disabled until the address identifies itself as this Base Sepolia native-ETH escrow.
        </p>
      </section>

      <section style={sx(`${PANEL};display:grid;gap:16px`)}>
        <form className="contract-address-form" onSubmit={submitCheck} style={sx("display:grid;grid-template-columns:minmax(0,1fr) auto;gap:10px;align-items:end") }>
          <Field
            id="escrow-address"
            label="DUEL ESCROW ADDRESS"
            value={address}
            onChange={(next) => {
              setAddress(next);
              setCheck({ kind: "idle" });
            }}
            placeholder="0x…"
            hint="Use the contract address produced after deploying the current DuelEscrow build on Base Sepolia."
          />
          <button
            type="submit"
            className="contract-control"
            disabled={check.kind === "loading"}
            aria-busy={check.kind === "loading"}
            style={sx(SECONDARY + (check.kind === "loading" ? DISABLED : ""))}
          >
            {check.kind === "loading" ? "Checking…" : "Check contract"}
          </button>
        </form>

        {check.kind === "idle" && <p style={sx(`${BODY};margin:0`)}>Check the address to enable contract reads.</p>}
        {check.kind === "loading" && (
          <div aria-live="polite" style={sx(`height:58px;border-radius:8px;background:${C.raised}`)} />
        )}
        {(check.kind === "invalid" || check.kind === "error") && (
          <div role="alert" style={sx(`padding:13px;border:1px solid ${C.red}55;border-radius:8px;background:${C.red}12;color:${C.red};font:600 13px/1.5 ${SANS}`)}>
            {check.message}
          </div>
        )}
        {check.kind === "valid" && (
          <div role="status" style={sx(`padding:13px;border:1px solid ${C.green}55;border-radius:8px;background:${C.green}12;color:${C.green};font:600 13px/1.5 ${SANS}`)}>
            Verified DuelEscrow interface and safety constants on Base Sepolia. Write controls are now address-safe.
          </div>
        )}
      </section>

      <section style={sx(`${PANEL};display:grid;gap:16px`)}>
        <div style={sx("display:flex;align-items:center;justify-content:space-between;gap:12px") }>
          <h2 style={sx(`margin:0;font:700 20px/1 ${SANS}`)}>Contract facts</h2>
          <button
            type="button"
            className="contract-control"
            disabled={check.kind === "loading"}
            onClick={() => void checkContract(address)}
            style={sx(SECONDARY + (check.kind === "loading" ? DISABLED : ""))}
          >
            Refresh reads
          </button>
        </div>
        {facts ? (
          <div style={sx("display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:10px") }>
            <Fact label="CHAIN ID">{facts.chainId.toString()} · BASE SEPOLIA</Fact>
            <Fact label="MIN_STAKE">{eth(facts.minStake)} · {facts.minStake.toString()} wei</Fact>
            <Fact label="TIMEOUT">{facts.timeout.toString()} sec · 6 hours</Fact>
            <Fact label="ATTESTOR">{short(facts.attestor)}</Fact>
            <Fact label="DOMAIN SEPARATOR">{short(facts.domainSeparator)}</Fact>
            <Fact label="VERDICT TYPEHASH">{short(facts.verdictTypehash)}</Fact>
          </div>
        ) : (
          <p style={sx(`${BODY};margin:0;color:${C.muted}`)}>No verified DuelEscrow reads yet.</p>
        )}
      </section>

      <section style={sx(`${PANEL};display:grid;gap:16px`)}>
        <div style={sx("display:grid;gap:5px") }>
          <span style={sx(LABEL)}>SHARED DUEL INPUT</span>
          <h2 style={sx(`margin:0;font:700 20px/1.1 ${SANS}`)}>One ID across stake, win, lose, refund and cancel</h2>
        </div>
        <Field
          id="duel-key"
          label="DUEL KEY OR BYTES32"
          value={duelKey}
          onChange={setDuelKey}
          placeholder="thetaduel-test-1"
          hint={`Derived duelId: ${derivedDuelId || "Enter a value"}`}
        />
        <button
          type="button"
          className="contract-control"
          disabled={!facts}
          onClick={() => void lookupDuel()}
          style={sx(SECONDARY + (facts ? "" : DISABLED))}
        >
          Read duels(duelId)
        </button>
        {lookupError && <div role="alert" style={sx(`${BODY};color:${C.red}`)}>{lookupError}</div>}
        {duel && (
          <div style={sx("display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px") }>
            <Fact label="STATUS">{duel.status}</Fact>
            <Fact label="STAKE">{eth(duel.stake)}</Fact>
            <Fact label="OPENER A">{short(duel.a)}</Fact>
            <Fact label="JOINER B">{short(duel.b)}</Fact>
            <Fact label="INVITED">{short(duel.invited)}</Fact>
            <Fact label="FULL AT">{duel.fullAt ? duel.fullAt.toString() : "Not filled"}</Fact>
            <Fact label="A WITHDREW">{duel.aWithdrawn ? "Yes" : "No"}</Fact>
            <Fact label="B WITHDREW">{duel.bWithdrawn ? "Yes" : "No"}</Fact>
          </div>
        )}
      </section>

    </main>
  );
}
