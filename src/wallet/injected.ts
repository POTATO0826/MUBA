import { BrowserProvider, type Eip1193Provider } from "ethers";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  DISCONNECTED,
  type WalletIdentity,
  type WalletSource,
} from "../data/wallet.ts";
import { BASE_SEPOLIA, BASE_SEPOLIA_CHAIN_ID } from "../data/base-network.ts";

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

export function useInjectedWallet(_requestedChainId: number = BASE_SEPOLIA_CHAIN_ID): InjectedWalletSource {
  const { wallets: available } = useInjectedWallets();
  const targetNetwork = BASE_SEPOLIA;
  const targetHex = `0x${targetNetwork.chainId.toString(16)}`;
  const targetChainParams = useMemo(
    () => ({
      chainId: targetHex,
      chainName: targetNetwork.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: [targetNetwork.rpcUrl],
      blockExplorerUrls: [targetNetwork.explorerUrl],
    }),
    [targetHex, targetNetwork.name, targetNetwork.rpcUrl, targetNetwork.explorerUrl],
  );

  const [active, setActive] = useState<InjectedWallet | null>(null);
  const [address, setAddress] = useState<string | null>(null);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    } catch (e) {
      // Cancelling a wallet prompt is a decision, not a fault.
      setError(errorCode(e) === USER_REJECTED ? null : message(e));
    } finally {
      setConnecting(false);
    }
  }, []);

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
            wrongNetwork: chainId !== null && chainId !== targetNetwork.chainId,
            targetNetworkName: targetNetwork.name,
          }
        : { ...DISCONNECTED, connecting },
    [address, chainId, active?.name, connecting, targetNetwork.chainId, targetNetwork.name],
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

  const switchToBase = useCallback(async () => {
    if (!active) return;
    setError(null);
    try {
      await active.provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: targetHex }],
      });
    } catch (e) {
      if (errorCode(e) === CHAIN_NOT_ADDED) {
        try {
          await active.provider.request({
            method: "wallet_addEthereumChain",
            params: [targetChainParams],
          });
        } catch (addError) {
          if (errorCode(addError) !== USER_REJECTED) setError(message(addError));
        }
        return;
      }
      if (errorCode(e) !== USER_REJECTED) setError(message(e));
    }
  }, [active, targetHex, targetChainParams]);

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
        setActive(null);
        setAddress(null);
        setChainId(null);
        setError(null);
      },
      switchToBase,
      getSigner: async () => {
        if (!active || !address) return null;
        if (identity.wrongNetwork) {
          throw new Error(
            `wallet is on chain ${chainId}, but this server targets ${targetNetwork.name} (${targetNetwork.chainId}) — switch network first`,
          );
        }
        const provider = new BrowserProvider(active.provider, targetNetwork.chainId);
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
      switchToBase,
      active,
      address,
      chainId,
      targetNetwork,
    ],
  );
}
