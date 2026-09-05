import type { Signer } from "ethers";

/**
 * ─── The two chains, and why they are two ────────────────────────────────────
 *
 * THETADUEL now reads from one chain and signs on another, and collapsing the
 * two into a single `chainId` would be exactly the class of bug
 * `docs/reality-check.md` is a list of: a number that means something other
 * than what its name claims. So there are two names, they are both exported,
 * and nothing in the app may print one while meaning the other.
 *
 * **{@link SIGNING_CHAIN_ID} — Base Sepolia, 84532. The only chain this app
 * will ever sign, approve or send on.** The owner's instruction was that
 * nothing a user signs should be able to spend real money, and this constant is
 * the whole of that promise. A wallet on any other chain — Base mainnet
 * included, especially Base mainnet — is refused by {@link assertSigningChain}
 * before a signer is handed to anything.
 *
 * **{@link DATA_CHAIN_ID} — Base mainnet, 8453. Read only, forever.** The
 * Thetanuts protocol is deployed here and on Ethereum mainnet and nowhere else:
 * the shipped SDK's `SupportedChainId` is the literal union `8453 | 1`
 * (`node_modules/@thetanuts-finance/thetanuts-client/dist/index.d.ts:112`), and
 * its runtime `CHAIN_CONFIGS_BY_ID` (`dist/index.js:13`) has exactly those two
 * keys. There is no Thetanuts testnet — no resting orders, no RANGER zones, no
 * strikes, no smile. So the strikes, premiums and vol surface the app displays
 * are a **mainnet read**, and the alternative to reading mainnet is not reading
 * a testnet, it is having no options data at all.
 *
 * Reading signs nothing and spends nothing, which is what makes the split safe.
 * The consequence, stated plainly because the screens must state it too: a
 * testnet wallet **cannot fill a mainnet OptionBook order**. Real fills are
 * impossible by construction under this design. That is the point, not a
 * regression — see `src/desk/fill.ts`.
 *
 * There was a single `BASE_CHAIN_ID = 8453` here until this split. It was
 * deliberately removed rather than aliased: every call site now has to say
 * which of the two it means, and `bunx tsc --noEmit` is what asks the question.
 */
export const SIGNING_CHAIN_ID = 84532;

/** The signing chain's name, as every piece of copy must spell it. */
export const SIGNING_CHAIN_NAME = "Base Sepolia";

/** Base Sepolia's explorer. Receipts get a link, because a hash nobody can open
 *  is not evidence. */
export const SIGNING_EXPLORER_TX = "https://sepolia.basescan.org/tx/";

/** Base Sepolia's public RPC — the fallback when a signer carries no provider. */
export const SIGNING_RPC = "https://sepolia.base.org";

/**
 * Base mainnet, 8453. **Read-only.** The Thetanuts book lives here; no wallet
 * this app connects may operate here. Passed to `ThetanutsClient` for reads,
 * never reached by a signing path — {@link assertSigningChain} runs first.
 */
export const DATA_CHAIN_ID = 8453;

/** The data chain's name, for provenance labels. */
export const DATA_CHAIN_NAME = "Base mainnet";

/**
 * The one sentence every surface uses to describe the split. Kept here so the
 * desk, the arena and the wallet picker cannot drift into three versions of it.
 */
export const CHAIN_SPLIT_NOTE =
  `Prices and strikes are read from ${DATA_CHAIN_NAME} (${DATA_CHAIN_ID}). ` +
  `Anything you sign happens on ${SIGNING_CHAIN_NAME} (${SIGNING_CHAIN_ID}), ` +
  "so nothing here can spend real money.";

/**
 * Refuse any chain that is not the signing chain. Throws; never returns false.
 *
 * The shape is `assertZeroCollateral` / `assertLongOnly` in `src/desk/rfq.ts`,
 * for their reason: a type lock ends at the first `any`, the first hand-built
 * dep object and the first test double that decides to be helpful, so the
 * runtime half has to exist too. It is called on the **connected wallet's own
 * reported chain**, at the last moment before a signer is handed over, in every
 * one of the four sequences that can reach one — `runFill`, `runSlip`,
 * `openDuel`/`settleDuel`/`refundDuel`/`cancelDuel`, and `openRequest`/
 * `acceptOffer` — plus the referee's `signMessage` in `src/state/stake.ts`.
 *
 * A refusal that cannot be skipped, rather than a warning that can be ignored:
 * there is no flag, no override and no `force` argument, because the failure
 * this stands in front of is an irreversible mainnet transaction spending the
 * user's own money.
 *
 * The thrown message begins `WRONG_CHAIN:` so the desk's `classify*Error` maps
 * can recognise it without matching on prose.
 */
export function assertSigningChain(chainId: number | null | undefined, what: string): number {
  // `null` is "no wallet connected" and `undefined` is "a dep object forgot to
  // thread the field through". Neither is the signing chain, and neither may be
  // read as one — a missing value passing a chain check is the exact coercion
  // trap `assertZeroCollateral` refuses on `collateralAmount`.
  if (typeof chainId !== "number" || !Number.isFinite(chainId)) {
    throw new Error(
      `WRONG_CHAIN: ${what} cannot proceed — the wallet reported no chain (${String(chainId)}). ` +
        `This build signs only on ${SIGNING_CHAIN_NAME} (${SIGNING_CHAIN_ID}).`,
    );
  }
  if (chainId !== SIGNING_CHAIN_ID) {
    throw new Error(
      `WRONG_CHAIN: ${what} refused — the wallet is on chain ${chainId}, and this build signs ` +
        `only on ${SIGNING_CHAIN_NAME} (${SIGNING_CHAIN_ID}). ` +
        (chainId === DATA_CHAIN_ID
          ? `${DATA_CHAIN_NAME} is where the options book is READ from; it is never signed on, ` +
            "because a signature there would spend real money."
          : "Switch the wallet's network and try again."),
    );
  }
  return chainId;
}

/**
 * True when `error` is {@link assertSigningChain}'s refusal. The desk modules
 * use this to keep "connected but on the wrong chain" distinguishable from
 * "not connected", which are different sentences and different buttons.
 */
export function isWrongChainError(error: unknown): boolean {
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String((error as { message: unknown }).message)
      : String(error);
  return message.startsWith("WRONG_CHAIN:");
}


/** A read-only snapshot of who the connected wallet says you are. */
export interface WalletIdentity {
  /** Checksummed address, or `null` when nothing is connected. */
  address: string | null;
  /** Chain the wallet currently has selected. `null` when disconnected. */
  chainId: number | null;
  /** Name of the wallet app, e.g. `"MetaMask"`. `null` when unknown. */
  walletName: string | null;
  connected: boolean;
  /**
   * A connect or an automatic reconnect is in flight.
   *
   * **This is also the "session is being restored" flag, and reading it as
   * merely "the modal is open" is a real bug.** A wallet that connected on a
   * previous visit reconnects silently on load, and that restore is not
   * instantaneous — it is at minimum a round trip to the extension or the relay.
   * A screen that decides what to draw the moment it first renders will see
   * `connected: false` during the restore and offer to connect a wallet that is
   * already connecting. From the user's side that is indistinguishable from the
   * session having been lost, which is the complaint this flag now answers.
   *
   * So: {@link WalletIdentity.settled} is what a screen gates a connect
   * affordance on, never `connected` alone.
   */
  connecting: boolean;
  /**
   * The restore has finished, one way or the other — there either is a session
   * or there provably is not.
   *
   * `false` on the very first paint of a reload and for as long as the
   * underlying SDK is still reattaching. While it is `false`, **no surface may
   * render a connect button**: the honest thing to draw is nothing, or a quiet
   * placeholder, because the app does not yet know the answer. `useMockWallet`
   * reports `true` immediately — it has nothing to restore and must not pretend
   * it does.
   */
  settled: boolean;
  /**
   * Connected, but not on {@link SIGNING_CHAIN_NAME} — nothing this app submits
   * can be signed.
   *
   * **A restored session does not get a pass here.** "Stay connected" is about
   * not re-asking for a *connection*; it is not permission to skip the *chain*
   * check, and a silently-restored mainnet session that could sign would be
   * strictly worse than asking every time. `getSigner` throws for this identity
   * whether the session is one second old or restored from last week.
   */
  wrongNetwork: boolean;
}

/**
 * Everything the UI needs from a wallet, behind one interface — deliberately the
 * same shape of seam as `MarketSource` in `./market.ts`.
 *
 * Two implementations ship:
 *
 * - `useMockWallet()` (`src/wallet/mock.ts`) — the design's placeholder. One
 *   fixed address, no network, no project id. Keeps the app runnable and the
 *   headless tests honest.
 * - `useAppKitWallet()` (`src/wallet/appkit.tsx`) — real WalletConnect over
 *   Reown AppKit with the ethers adapter, scoped to {@link SIGNING_CHAIN_NAME}.
 *
 * `src/wallet/boundary.tsx` picks between them at boot and hands the winner to
 * `<App wallet={…} />`, so no view imports AppKit.
 *
 * The address is the player identity. That is the whole point of doing this
 * before PvP: matchmaking, room links and settlement all key on
 * `identity.address`, so the multiplayer layer has something real to name
 * players by instead of the `"You"` / `"kazuo.eth"` fixtures.
 */
export interface WalletSource {
  readonly id: string;
  readonly identity: WalletIdentity;
  /**
   * Open the wallet chooser. Resolves when the modal closes — which is *not*
   * the same as having connected; watch `identity.connected` for that.
   *
   * **Call this only when `identity.settled && !identity.connected`.** Every
   * other case is either a session still being restored or a wallet that is
   * already connected, and prompting in either is the "it keeps asking me to
   * connect" defect. `src/App.tsx` had two independent `connect()` call sites
   * on two surfaces before this was written down.
   */
  connect(): Promise<void>;
  /**
   * Drop the session, deliberately and explicitly.
   *
   * The counterweight to silent reconnection: "never ask again" must not become
   * "cannot get out". This clears whatever the underlying SDK persisted, so the
   * next load starts genuinely disconnected rather than restoring the session
   * the user just ended.
   */
  disconnect(): Promise<void>;
  /** The connected-wallet panel: balance, copy address, disconnect. */
  openAccount(): Promise<void>;
  /**
   * Ask the wallet to move to {@link SIGNING_CHAIN_NAME}, adding the network
   * first if the wallet has never seen it. Rejects if the wallet refuses.
   *
   * Named for the chain it targets rather than `switchToBase`, because "Base"
   * is now ambiguous in this codebase and an ambiguous name on a network switch
   * is how a user ends up on mainnet believing they are on a testnet.
   */
  switchToSigningChain(): Promise<void>;
  /**
   * An ethers signer for writes — the seam the real on-chain options trade
   * hangs off.
   *
   * The intended split is: the server prices and builds the order, this
   * signer signs and submits it from the browser. ethers 6 is the one web3
   * stack in the app, at one version.
   *
   * Returns `null` when no wallet is connected. Throws when a wallet is
   * connected but sitting on the wrong chain, because silently returning
   * `null` there would look identical to "not connected" at the call site.
   *
   * "The wrong chain" now means **anything but {@link SIGNING_CHAIN_ID}**, and
   * that emphatically includes {@link DATA_CHAIN_ID}. This is the first of two
   * layers: this one refuses to produce a signer at all, and the desk adapters
   * call {@link assertSigningChain} on `identity.chainId` again immediately
   * before they hand a signer to anything that can spend
   * (`src/desk/fill.ts`, `src/desk/escrow.ts`, `src/desk/rfq.ts`). Two layers
   * because this interface has three implementations and a test double is one
   * `getSigner: async () => ({})` away from being a fourth.
   */
  getSigner(): Promise<Signer | null>;
}

export const DISCONNECTED: WalletIdentity = {
  address: null,
  chainId: null,
  walletName: null,
  connected: false,
  connecting: false,
  // `false`, not `true`: this constant is what an implementation reports before
  // it has looked for a stored session, so the honest answer to "has the
  // restore finished?" is no. An implementation with nothing to restore
  // (`src/wallet/mock.ts`) overrides it to `true` rather than inheriting it.
  settled: false,
  wrongNetwork: false,
};

/**
 * `0x71cB05fD1eA1B3d4a7C9e8F2b6D0a3C85e9d4Af2` → `0x71c…4Af2`.
 *
 * Three in, four out — the design's truncation, not the more common six-in
 * form, so the header reads exactly as the source mock did.
 */
export function shortAddress(address: string): string {
  return `${address.slice(0, 5)}…${address.slice(-4)}`;
}

/** Two initials for the player avatar: the first two hex digits, upper-cased. */
export function addressInitials(address: string): string {
  return address.slice(2, 4).toUpperCase();
}
