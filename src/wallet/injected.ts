import { BrowserProvider, type Eip1193Provider } from "ethers";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DISCONNECTED,
  SIGNING_CHAIN_ID,
  SIGNING_CHAIN_NAME,
  SIGNING_RPC,
  type WalletIdentity,
  type WalletSource,
} from "../data/wallet.ts";

/**
 * Browser-extension wallets, with no configuration at all.
 *
 * MetaMask, Rabby, OKX and friends are injected into the page — connecting to
 * one is `eth_requestAccounts` on an EIP-1193 provider. No relay, no project
 * id, no account anywhere. That makes this the path that works on a fresh
 * clone, and AppKit (`./appkit.tsx`) the upgrade that additionally lets phone
 * wallets in over a QR code.
 *
 * Discovery is EIP-6963 rather than `window.ethereum`, because with several
 * extensions installed they fight over that property — the observable symptom
 * is `TypeError: Cannot redefine property: ethereum` in the console, and
 * whichever lost the race is unreachable. EIP-6963 has each wallet announce
 * itself separately, so all of them stay addressable and the user picks.
 */

/** https://eips.ethereum.org/EIPS/eip-6963 */
export interface InjectedWallet {
  uuid: string;
  name: string;
  /** data: URI, per the spec. */
  icon: string;
  /** Reverse-DNS id, e.g. `io.metamask`. Stable across versions. */
  rdns: string;
  provider: Eip1193Provider;
}

interface AnnounceEvent extends CustomEvent {
  detail: {
    info: { uuid: string; name: string; icon: string; rdns: string };
    provider: Eip1193Provider;
  };
}

const SIGNING_HEX = `0x${SIGNING_CHAIN_ID.toString(16)}`;

/**
 * What `wallet_addEthereumChain` needs if the wallet has never seen Base
 * Sepolia — which, unlike Base mainnet, is the common case: plenty of wallets
 * ship mainnet preloaded and no testnets at all. So the add path here is the
 * expected path rather than the exceptional one, and `switchToSigningChain`
 * retries the switch after adding for exactly that reason.
 */
const SIGNING_CHAIN_PARAMS = {
  chainId: SIGNING_HEX,
  chainName: "Base Sepolia",
  nativeCurrency: { name: "Sepolia Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: [SIGNING_RPC],
  blockExplorerUrls: ["https://sepolia.basescan.org"],
};

/**
 * Which wallet the user last chose, so a reload does not ask again.
 *
 * **The `rdns` and nothing else.** It is a public reverse-DNS identifier like
 * `io.metamask` — it grants no authority, unlocks nothing, and is worthless to
 * anyone who reads it out of localStorage. The authority stays exactly where it
 * already was: in the extension's own record that this origin is permitted,
 * which is what makes the silent `eth_accounts` restore below work at all. No
 * key, no signature and no address is written here — the address is re-read
 * from the wallet on every restore rather than trusted from storage, because a
 * stored address that the wallet no longer holds is a fabricated identity.
 */
const LAST_WALLET_KEY = "thetaduel.wallet.rdns";

/** localStorage throws in a sandboxed iframe and in some privacy modes, and a
 *  wallet that cannot remember a preference must still be able to connect. */
function rememberWallet(rdns: string | null): void {
  try {
    if (rdns === null) window.localStorage.removeItem(LAST_WALLET_KEY);
    else window.localStorage.setItem(LAST_WALLET_KEY, rdns);
  } catch {
    /* a preference, never load-bearing */
  }
}

function rememberedWallet(): string | null {
  try {
    return window.localStorage.getItem(LAST_WALLET_KEY);
  } catch {
    return null;
  }
}

/** The user closed the wallet prompt. Not an error worth shouting about. */
const USER_REJECTED = 4001;
/** The wallet does not know this chain yet — add it, then retry the switch. */
const CHAIN_NOT_ADDED = 4902;

function errorCode(e: unknown): number | null {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code: unknown }).code;
    if (typeof c === "number") return c;
  }
  return null;
}

function message(e: unknown): string {
  if (typeof e === "object" && e !== null && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  return String(e);
}

/**
 * Every injected wallet in the page.
 *
 * The announce/request handshake is the wrong way round from most events: we
 * listen first, then ask, because wallets answer synchronously and an already
 * loaded extension would otherwise have announced before we subscribed.
 */
export function useInjectedWallets(): { wallets: InjectedWallet[]; settled: boolean } {
  const [wallets, setWallets] = useState<InjectedWallet[]>([]);
  /**
   * Announcements arrive synchronously when we dispatch the request, but React
   * has already rendered once by then. Without this flag the boundary would see
   * an empty list on the first paint and pick the mock tier before any wallet
   * had a chance to speak.
   */
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    const onAnnounce = (event: Event) => {
      const { info, provider } = (event as AnnounceEvent).detail;
      setWallets((current) =>
        // Extensions re-announce on request; keyed by rdns so a second ask does
        // not duplicate the list.
        current.some((w) => w.rdns === info.rdns)
          ? current
          : [...current, { ...info, provider }],
      );
    };

    window.addEventListener("eip6963:announceProvider", onAnnounce);
    window.dispatchEvent(new Event("eip6963:requestProvider"));

    // One macrotask is enough for every already-loaded extension to answer.
    const done = setTimeout(() => setSettled(true), 0);

    return () => {
      clearTimeout(done);
      window.removeEventListener("eip6963:announceProvider", onAnnounce);
    };
  }, []);

  return { wallets, settled };
}

export interface InjectedWalletSource extends WalletSource {
  /** Everything discovered in the page, for the chooser. */
  readonly available: InjectedWallet[];
  /** True while the user is being asked which wallet to use. */
  readonly choosing: boolean;
  /** Connect to one specific wallet, by `rdns`. */
  chooseWallet(rdns: string): Promise<void>;
  cancelChoice(): void;
  /** Last failure worth showing, or `null`. */
  readonly error: string | null;
}

export function useInjectedWallet(): InjectedWalletSource {
  const { wallets: available, settled: discovered } = useInjectedWallets();

  const [active, setActive] = useState<InjectedWallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Has the silent restore below finished, one way or the other?
   *
   * Starts `false` and is set exactly once. Until it flips, no surface may
   * offer to connect — see `WalletIdentity.settled`. `discovered` is the
   * separate question of whether EIP-6963 has finished announcing, and the
   * restore cannot even begin before it has.
   */
  const [settled, setSettled] = useState(false);

  const connectTo = useCallback(async (wallet: InjectedWallet) => {
    setConnecting(true);
    setError(null);
    try {
      const accounts = (await wallet.provider.request({
        method: "eth_requestAccounts",
      })) as string[];
      if (!accounts?.length) {
        setError(`${wallet.name} returned no accounts.`);
        return;
      }
      const hex = (await wallet.provider.request({ method: "eth_chainId" })) as string;
      setActive(wallet);
      setAddress(accounts[0]!);
      setChainId(Number.parseInt(hex, 16));
      setChoosing(false);
      rememberWallet(wallet.rdns);
    } catch (e) {
      // Cancelling a wallet prompt is a decision, not a fault.
      setError(errorCode(e) === USER_REJECTED ? null : message(e));
    } finally {
      setConnecting(false);
    }
  }, []);

  /**
   * Reconnect silently to the wallet used last time. Runs once, after discovery.
   *
   * **`eth_accounts`, never `eth_requestAccounts`.** They differ in exactly the
   * way that matters here: `eth_requestAccounts` opens the wallet's approval
   * prompt, `eth_accounts` returns the accounts this origin is *already*
   * permitted to see and returns an empty array otherwise. So this restores a
   * session the user previously granted and is silent when they did not — which
   * is the whole of "after connecting once, do not ask again". Calling the
   * requesting form here is the bug this comment exists to prevent: it would
   * turn every page load into a wallet popup, which is worse than the defect it
   * was meant to fix.
   *
   * Nothing is trusted from storage but the `rdns`. The address and the chain
   * are read back from the wallet itself, so a permission revoked in the
   * extension since the last visit restores nothing at all.
   */
  useEffect(() => {
    if (settled) return;
    // The wallet list is still filling; announcing is synchronous but lands
    // after React's first render (`useInjectedWallets`). Deciding now would
    // read "no wallets" and settle on a false negative.
    if (!discovered) return;

    const rdns = rememberedWallet();
    const wallet = rdns ? available.find((w) => w.rdns === rdns) : undefined;
    if (!wallet) {
      // Either nothing was remembered, or the extension it names is gone. Both
      // are honest answers of "no session", and both settle.
      setSettled(true);
      return;
    }

    let live = true;
    void (async () => {
      try {
        const accounts = (await wallet.provider.request({
          method: "eth_accounts",
        })) as string[];
        if (!live) return;
        if (accounts?.length) {
          const hex = (await wallet.provider.request({ method: "eth_chainId" })) as string;
          if (!live) return;
          setActive(wallet);
          setAddress(accounts[0]!);
          setChainId(Number.parseInt(hex, 16));
        } else {
          // Permission was revoked in the wallet. Drop the pointer so the next
          // load does not try again, and stay disconnected.
          rememberWallet(null);
        }
      } catch {
        // A wallet that will not answer `eth_accounts` is not a session. No
        // error is surfaced: the user did not ask for this, so it must fail
        // invisibly and leave them exactly where a first-time visitor is.
      } finally {
        if (live) setSettled(true);
      }
    })();

    return () => {
      live = false;
    };
  }, [discovered, available, settled]);

  /** Track account and chain changes the user makes inside the wallet itself. */
  useEffect(() => {
    if (!active) return;
    const provider = active.provider as Eip1193Provider & {
      on?: (event: string, handler: (...args: never[]) => void) => void;
      removeListener?: (event: string, handler: (...args: never[]) => void) => void;
    };
    if (!provider.on) return;

    const onAccounts = (...args: never[]) => {
      const accounts = args[0] as unknown as string[];
      // An empty array means disconnected from the wallet's side — a
      // permission revoked in the extension, not a page action.
      if (!accounts?.length) {
        rememberWallet(null);
        setActive(null);
        setAddress(null);
        setChainId(null);
        return;
      }
      setAddress(accounts[0]!);
    };

    const onChain = (...args: never[]) => {
      const hex = args[0] as unknown as string;
      setChainId(Number.parseInt(hex, 16));
    };

    provider.on("accountsChanged", onAccounts);
    provider.on("chainChanged", onChain);
    return () => {
      provider.removeListener?.("accountsChanged", onAccounts);
      provider.removeListener?.("chainChanged", onChain);
    };
  }, [active]);

  const identity = useMemo<WalletIdentity>(
    () =>
      address
        ? {
            address,
            chainId,
            walletName: active?.name ?? null,
            connected: true,
            connecting,
            settled,
            wrongNetwork: chainId !== null && chainId !== SIGNING_CHAIN_ID,
          }
        : { ...DISCONNECTED, connecting, settled },
    [address, chainId, active?.name, connecting, settled],
  );

  const connect = useCallback(async () => {
    if (!available.length) {
      setError("No browser wallet found. Install MetaMask or Rabby, then reload.");
      return;
    }
    // One wallet is unambiguous — skip the chooser and go straight to its prompt.
    if (available.length === 1) {
      await connectTo(available[0]!);
      return;
    }
    setChoosing(true);
  }, [available, connectTo]);

  const chooseWallet = useCallback(
    async (rdns: string) => {
      const wallet = available.find((w) => w.rdns === rdns);
      if (wallet) await connectTo(wallet);
    },
    [available, connectTo],
  );

  const switchToSigningChain = useCallback(async () => {
    if (!active) return;
    setError(null);
    try {
      await active.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: SIGNING_HEX }],
      });
    } catch (e) {
      if (errorCode(e) === CHAIN_NOT_ADDED) {
        try {
          await active.provider.request({
            method: "wallet_addEthereumChain",
            params: [SIGNING_CHAIN_PARAMS],
          });
          // Retry the switch. When this targeted Base mainnet the add path
          // returned here, because a wallet that had just added mainnet was
          // generally already on it. A wallet that has just added a *testnet*
          // frequently is not, and stopping here left the user on mainnet
          // looking at a button that appeared to have done nothing. Adding a
          // chain is not switching to it.
          await active.provider.request({
            method: "wallet_switchEthereumChain",
            params: [{ chainId: SIGNING_HEX }],
          });
        } catch (addError) {
          if (errorCode(addError) !== USER_REJECTED) setError(message(addError));
        }
        return;
      }
      if (errorCode(e) !== USER_REJECTED) setError(message(e));
    }
  }, [active]);

  return useMemo(
    () => ({
      id: "injected",
      identity,
      available,
      choosing,
      error,
      connect,
      chooseWallet,
      cancelChoice: () => setChoosing(false),
      /**
       * An extension cannot be told to forget the page — `wallet_revokePermissions`
       * is not universally supported — so this drops the connection locally.
       * The wallet may re-authorise silently on the next connect, which is the
       * behaviour users expect from "disconnect" on a dApp.
       */
      disconnect: async () => {
        // Forget the wallet too, or the silent restore would reconnect on the
        // next load and "disconnect" would mean "disconnect until you blink".
        // This is the deliberate way out that silent reconnection must keep.
        rememberWallet(null);
        setActive(null);
        setAddress(null);
        setChainId(null);
        setError(null);
      },
      /**
       * No account modal of our own, so the header's address button disconnects.
       * Trivially reversible — the next click reconnects, and most wallets
       * re-authorise without a second prompt.
       */
      openAccount: async () => {
        rememberWallet(null);
        setActive(null);
        setAddress(null);
        setChainId(null);
        setError(null);
      },
      switchToSigningChain,
      getSigner: async () => {
        if (!active || !address) return null;
        // A RESTORED session gets no pass here. Staying connected is about not
        // re-asking for a connection; it never licensed skipping the chain
        // check, and a silently-restored mainnet session that could sign would
        // be strictly worse than asking every time.
        if (identity.wrongNetwork) {
          throw new Error(
            `WRONG_CHAIN: wallet is on chain ${chainId}, but THETADUEL signs only on ` +
              `${SIGNING_CHAIN_NAME} (${SIGNING_CHAIN_ID}) — switch network first`,
          );
        }
        const provider = new BrowserProvider(active.provider, SIGNING_CHAIN_ID);
        return provider.getSigner(address);
      },
    }),
    [
      identity,
      available,
      choosing,
      error,
      connect,
      chooseWallet,
      switchToSigningChain,
      active,
      address,
      chainId,
    ],
  );
}
