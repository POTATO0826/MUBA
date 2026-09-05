import { afterEach, describe, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { boxToCondor } from "../src/data/condor.ts";
import { zoneToRanger, type ListedZone } from "../src/data/ranger.ts";
import type { MarketSource } from "../src/data/market.ts";
import type { WalletSource } from "../src/data/wallet.ts";
import type { FillDeps, RawFillOrder } from "../src/desk/fill.ts";
import { BoxTradePanel } from "../src/ui/BoxTradePanel.tsx";

const EXPIRY = 1_900_000_000;
const USDC = "0x0000000000000000000000000000000000000a01";
const BOOK = "0x0000000000000000000000000000000000000b01";
const HASH = "0xabc123def456abc123def456abc123def456abc123def456abc123def456abcd";
const BOX = {
  underlying: "ETH" as const,
  floor: "245000000000",
  ceiling: "250000000000",
  wing: "5000000000",
  expiry: EXPIRY,
};
const SPEC = boxToCondor(BOX);

const source: MarketSource = {
  id: "test",
  meta: { ok: true, source: "live", fetchedAt: 0 },
  underlyings: () => ["ETH"],
  pricing: () => [],
  mmPricing: () => [],
  orders: () => [],
  spot: () => 2475,
};

const wallet: WalletSource = {
  id: "wallet",
  identity: {
    address: "0x0000000000000000000000000000000000000001",
    chainId: 8453,
    walletName: "Test",
    connected: true,
    connecting: false,
    wrongNetwork: false,
  },
  async connect() {},
  async disconnect() {},
  async openAccount() {},
  async switchToBase() {},
  async getSigner() { return {} as never; },
};

const zone = (quote = true): ListedZone => ({
  underlying: "ETH",
  expiry: EXPIRY,
  strikes: ["240000000000", "245000000000", "250000000000", "255000000000"],
  floor: "245000000000",
  ceiling: "250000000000",
  wing: "5000000000",
  availableAmount: "1000000",
  index: 0,
  order: {
    order: { expiry: String(EXPIRY) },
    availableAmount: "1000000",
    rawApiData: {
      priceFeed: "0xfeed",
      strikes: ["240000000000", "245000000000", "250000000000", "255000000000"],
      implementation: "0xranger",
      isLong: false,
    },
    ...(quote
      ? { quote: { premium: "20.00", fillable: true, orderNonce: "7" } }
      : {}),
  },
});

let container: HTMLDivElement;
let root: Root;

async function mount(ui: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(ui));
}

afterEach(async () => {
  if (!root) return;
  await act(async () => root.unmount());
  container.remove();
  root = undefined as unknown as Root;
});

const button = (label: RegExp) =>
  [...container.querySelectorAll("button")].find((node) => label.test(node.textContent ?? "")) as
    | HTMLButtonElement
    | undefined;

describe("BoxTradePanel", () => {
  test("an unlisted box opens pricing with both risk numbers and a recovery state", async () => {
    await mount(
      <BoxTradePanel spec={SPEC} match={null} source={source} wallet={{ ...wallet, id: "mock" }} enabled={false} onBack={() => {}} />,
    );

    const text = container.textContent ?? "";
    expect(text).toContain("Max loss $0.01");
    expect(text).toContain("Max payout $50.00");
    expect(text).toContain("Mock wallet");
    expect(text.indexOf("Max loss")).toBeLessThan(text.indexOf("Max payout"));
  });

  test("a quoted listed zone previews the exact loss before any fill", async () => {
    const listed = zone();
    const fullOrder: RawFillOrder = {
      order: { price: 2_000_000_000n, isBuyer: true, nonce: 7n, expiry: BigInt(EXPIRY) },
      availableAmount: 1_000_000n,
      signature: "0xsigned",
      rawApiData: {
        orderExpiryTimestamp: EXPIRY - 60,
        strikes: [...listed.strikes],
        optionBookAddress: BOOK,
        collateral: USDC,
      },
    };
    let fills = 0;
    const activity: boolean[] = [];
    const makeFillDeps = (): FillDeps => ({
      walletId: "wallet",
      usdc: USDC,
      optionBook: BOOK,
      now: () => 1_800_000_000_000,
      async getSigner() { return {}; },
      async refetchOrder(ref) {
        expect(ref.nonce).toBe("7");
        return fullOrder;
      },
      previewFillOrder: () => ({
        numContracts: 20_000n,
        totalCollateral: 10_000n,
        collateralToken: USDC,
        pricePerContract: 2_000_000_000n,
      }),
      async ensureAllowance() { return null; },
      async fillOrder() {
        fills += 1;
        return { hash: HASH };
      },
      async confirm() { return false; },
    });

    await mount(
      <BoxTradePanel
        spec={SPEC}
        match={{ zone: listed, spec: zoneToRanger(listed) }}
        source={source}
        wallet={wallet}
        enabled
        makeFillDeps={makeFillDeps}
        onBack={() => {}}
        onActiveChange={(value) => activity.push(value)}
      />,
    );

    expect(container.textContent).toContain("MAX LOSS$20.00 per contract");
    expect(container.textContent).toContain("MAX PAYOUT$50.00 per contract");

    await act(async () => button(/Prepare capped fill/)?.click());
    expect(container.textContent).toContain("MAX LOSS $0.01 USDC");
    expect(container.textContent).toContain("MAX PAYOUT $1.00 USDC");
    expect(fills).toBe(0);
    expect(activity.at(-1)).toBe(true);

    await act(async () => button(/Confirm max loss/)?.click());
    await act(async () => {});
    expect(fills).toBe(1);
    expect(activity.at(-1)).toBe(false);
    expect(container.textContent).toContain("Box bought");
    expect(container.querySelector('a[href^="https://basescan.org/tx/"]')).not.toBeNull();
  });
});
