# Thetanuts SDK — exploration findings

SDK `@thetanuts-finance/thetanuts-client` pinned at exactly `0.2.5` (no caret).
ethers 6.17.0. Chain: Base mainnet 8453. RPC: `https://mainnet.base.org`.
Read-only client (provider only, no signer). All 6 steps ran successfully.
Data captured 2026-09-03 ~08:00 UTC (block 50790061).

Run one step at a time: `npx tsx test.ts <1-6>` (or by name, e.g. `npx tsx test.ts ethPricing`).
No arg prints the step menu.

---

## 1. Field shape of one mmPricing object

From `client.mmPricing.getPricingArray('ETH')` → `MMVanillaPricing`. 15 top-level fields.

| field | type | example |
|---|---|---|
| `ticker` | string | `'ETH-3SEP26-2100-C'` |
| `rawBidPrice` | number | `0.115` |
| `rawAskPrice` | number | `0.119` |
| `feeAdjustedBid` | number | `0.11460000000000001` |
| `feeAdjustedAsk` | number | `0.11939999999999999` |
| `markPrice` | number | `0.116552` |
| `underlyingPrice` | number | `2375.76` |
| `strike` | number | `2100` |
| `expiry` | number | `1788422400` (unix seconds) |
| `isCall` | boolean | `true` |
| `underlying` | string | `'ETH'` |
| `passesToleranceCheck` | boolean | `false` |
| `timeToExpiryYears` | number | `0.0016778919330289192` |
| `feeMultiplier` | number | `1.03` |
| `byCollateral` | object | `{ ETH, USD }` |

All prices are `number` (JS float), not bigint. Prices are quoted **in units of the
underlying**, not USD — an ETH call at `0.1155` mark is 0.1155 ETH.

`byCollateral` is keyed by collateral asset. Keys observed: `ETH` + `USD` for ETH options,
`BTC` + `USD` for BTC options. Each value has 11 fields:

| field | type | example (byCollateral.ETH) |
|---|---|---|
| `collateralAsset` | string | `'ETH'` |
| `collateralAmount` | number | `1` |
| `collateralCostPerUnit` | number | `0.00006711567732115677` |
| `mmBidPrice` | number | `0.11453288432267886` |
| `mmAskPrice` | number | `0.11946711567732114` |
| `mmWlBidPrice` | number | `0.11608488432267886` |
| `mmWlAskPrice` | number | `0.11701911567732115` |
| `mmBidPriceBuffered` | number | `0.11119697507056199` |
| `mmAskPriceBuffered` | number | `0.12305112914764078` |
| `mmWlBidPriceBuffered` | number | `0.11270377118706684` |
| `mmWlAskPriceBuffered` | number | `0.12052968914764078` |

`Wl` = whitelisted. `Buffered` applies `feeMultiplier` (1.03).
For `collateralAsset: 'USD'`, `collateralAmount` equals the strike (2100), not 1.

Counts at capture time: ETH **782** rows, BTC **925** rows. Neither was empty.

---

## 2. Field shape of one order object

From `client.api.fetchOrders()` → `OrderWithSignature`. **426** live orders at capture.
5 top-level fields, with the EIP-712 payload nested under `order`.

| field | type |
|---|---|
| `order` | object (14 fields, below) |
| `signature` | string (0x, 65-byte) |
| `availableAmount` | **bigint** |
| `makerAddress` | string |
| `rawApiData` | object (11 fields, below) |

`order` (the signed struct):

| field | type | example |
|---|---|---|
| `maker` | string | `0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E` |
| `taker` | string | `0x0000...0000` (open order) |
| `option` | string | `''` — **empty string**, not an address |
| `isBuyer` | boolean | `true` |
| `numContracts` | bigint | `0n` |
| `price` | bigint | `144246644n` |
| `expiry` | bigint | `1788422400n` |
| `nonce` | bigint | `25365122831975758400662931726290595927861030329151298978392616734748722343309n` |
| `optionType` | number | `1` |
| `strikes` | bigint[] | `[230000000000n]` (8dp → $2300) |
| `strikePrice` | bigint | `230000000000n` |
| `collateralToken` | string | `0x8335...2913` (USDC) |
| `underlyingToken` | string | `0x4200...0006` (WETH) |
| `deadline` | bigint | `1788422400n` |

`rawApiData` (indexer passthrough):

| field | type |
|---|---|
| `collateral` | string |
| `priceFeed` | string |
| `implementation` | string |
| `strikes` | string[] (decimal strings, not bigint) |
| `isCall` | boolean |
| `isLong` | boolean |
| `orderExpiryTimestamp` | number |
| `extraOptionData` | string (`'0x'`) |
| `maxCollateralUsable` | string |
| `optionBookAddress` | string |
| `greeks` | object: `{ delta, iv, gamma, theta, vega }` — all number |

Observed on the sampled order: `order.numContracts` is `0n` and `order.option` is `''`.
`availableAmount` was `10000000000n` = 10,000 USDC at 6dp, matching
`rawApiData.maxCollateralUsable`. `strikes` is duplicated in three places with two
different encodings (`order.strikes` bigint[], `order.strikePrice` bigint,
`rawApiData.strikes` string[]).

---

## 3. Price feeds vs MM options pricing

`client.chainConfig.priceFeeds` — **10 keys**, 8 distinct assets:

`ETH`, `BTC`, `SOL`, `DOGE`, `XRP`, `BNB`, `PAXG`, `AVAX`, plus two aliases
`ETH/USD` and `BTC/USD` whose addresses are identical to `ETH` and `BTC`.

`client.chainConfig.implementations` — **22 keys**. 15 have real addresses:
`PUT`, `INVERSE_CALL`, `LINEAR_CALL`, `CALL_SPREAD`, `PUT_SPREAD`, `INVERSE_CALL_SPREAD`,
`CALL_FLY`, `PUT_FLY`, `CALL_CONDOR`, `PUT_CONDOR`, `IRON_CONDOR`, `RANGER`, `CALL_LOAN`,
`PHYSICAL_CALL`, `PHYSICAL_PUT`.

7 are the zero address: `PHYSICAL_CALL_SPREAD`, `PHYSICAL_PUT_SPREAD`, `PHYSICAL_CALL_FLY`,
`PHYSICAL_PUT_FLY`, `PHYSICAL_CALL_CONDOR`, `PHYSICAL_PUT_CONDOR`, `PHYSICAL_IRON_CONDOR`.

**MM options pricing exists for ETH and BTC only.** `getPricingArray` is typed
`(underlying: 'ETH' | 'BTC')`. Probed against all 8 price-feed assets — none of the other
six throw, they all return `[]`:

| underlying | outcome | rows |
|---|---|---|
| ETH | returned array | 781 |
| BTC | returned array | 923 |
| SOL | returned array | 0 |
| DOGE | returned array | 0 |
| XRP | returned array | 0 |
| BNB | returned array | 0 |
| PAXG | returned array | 0 |
| AVAX | returned array | 0 |

`getMarketData().prices` returned **7** assets: ETH, BTC, SOL, XRP, BNB, AVAX, DOGE.
PAXG has a price feed but no entry in market prices.

So, three different asset sets: 8 price feeds / 7 market prices / 2 with MM pricing.

---

## 4. calculatePayout and RANGER

**`client.utils.calculatePayout` does NOT support RANGER.** Probed at runtime, both casings:

```
REJECTED  type:'RANGER'  code=INVALID_PARAMS  message="Unknown option type: RANGER"
REJECTED  type:'ranger'  code=INVALID_PARAMS  message="Unknown option type: ranger"
```

The shipped type is `PayoutType = 'call' | 'put' | 'call_spread' | 'put_spread'`.
The implementation is a 4-case switch with `default: throw INVALID_PARAMS`.
No butterfly, condor, or iron-condor support either, despite those implementations
being deployed on chain.

Args it wants (`PayoutParams`):

| arg | required | type |
|---|---|---|
| `type` | yes | `'call' \| 'put' \| 'call_spread' \| 'put_spread'` |
| `strikes` | yes | `bigint[]` — exactly 1 for call/put, exactly 2 for spreads (throws otherwise) |
| `settlementPrice` | yes | `bigint`, 8dp |
| `numContracts` | yes | `bigint`, 18dp |
| `priceDecimals` | no | number, default 8 |
| `sizeDecimals` | no | number, default 18 |
| `collateralDecimals` | no | number, default 6 (USDC) |

Returns `bigint` in collateral decimals. Pure local, no RPC (step ran in 2ms).

Sweep, strike 3000, 1 contract (`10n**18n`), payout in USDC:

| settlement | call | put | call_spread [2800,3200] | put_spread [2800,3200] |
|---|---|---|---|---|
| 2000 | 0 | 1000 | 0 | 400 |
| 2400 | 0 | 600 | 0 | 400 |
| 2800 | 0 | 200 | 0 | 400 |
| 3000 | 0 | 0 | 200 | 200 |
| 3200 | 200 | 0 | 400 | 0 |
| 3600 | 600 | 0 | 400 | 0 |
| 4000 | 1000 | 0 | 400 | 0 |

For spreads, `strikes[0]` is the lower strike and `strikes[1]` the upper.

RangerOption payoff is not reachable locally. The only ranger payout paths are
`client.ranger.calculatePayout(addr, price)` and
`client.ranger.simulatePayout(addr, price, strikes, numContracts)` — both take a
deployed ranger contract address and both are async/on-chain.

---

## 5. Where the responses contradict the docs

1. **Fee adjustment cap is 0.0004, not 0.0003.** `llms-full.txt` states
   `feeAdjustment = min(0.0003, rawPrice × 0.125)`. The shipped code uses `Math.min(4e-4, …)`.
   Live data agrees with the code: ETH raw bid 0.115 → feeAdjustedBid 0.1146 (delta 0.0004);
   BTC raw bid 0.1025 → 0.1021 (delta 0.0004).

2. **`applyFeeAdjustment` signature is different.** Docs say `applyFeeAdjustment(price, side)`.
   Actual: `applyFeeAdjustment(bid, ask, markPrice = 0, isWhitelisted = false)` returning the
   tuple `[adjustedBid, adjustedAsk]`.

3. **`COLLATERAL_APR` is keyed `BTC`/`ETH`/`USD`, not `cbBTC`/`WETH`/`USD`.** Docs describe the
   rates as "cbBTC: 1%, WETH: 4%, USD: 7%". The actual object is `{BTC: 0.01, ETH: 0.04, USD: 0.07}`.
   Lookup is `COLLATERAL_APR[asset] ?? DEFAULT_CARRY_RATE` where `DEFAULT_CARRY_RATE = 0.05`,
   so passing `'WETH'` or `'cbBTC'` silently yields 5% instead of 4%/1%.

4. **`calculatePayout` type strings are lowercase and snake_case.** The implementation registry
   and docs use `PUT`, `CALL_SPREAD`, etc.; `client.utils.calculatePayout` accepts only
   `'call'`, `'put'`, `'call_spread'`, `'put_spread'`. The two namespaces do not share strings.

5. **`getPricingArray` with an unsupported underlying returns `[]` rather than throwing.**
   The docs' error table implies `INVALID_PARAMS` for bad input. All six non-ETH/BTC feed
   assets returned an empty array instead — indistinguishable from "no live options right now".
   An empty result therefore has two possible causes and the SDK does not let you tell them apart.

6. **`priceFeeds` has 10 keys, not the 8 assets listed.** `ETH/USD` and `BTC/USD` are duplicate
   aliases of `ETH` and `BTC` at the same addresses.

7. **`greeks` is undocumented.** `rawApiData.greeks` (`delta`, `iv`, `gamma`, `theta`, `vega`)
   is present on live orders but appears nowhere in `llms-full.txt`.

8. **PAXG has a price feed but no market price.** `getMarketData().prices` omits it while
   `chainConfig.priceFeeds.PAXG` is populated.

Not contradicted / confirmed as documented: `availableAmount` is a collateral budget in
collateral decimals (10000000000n = 10,000 USDC), not a contract count; the 7 physical
multi-leg implementations are zero addresses; `RANGER` is deployed at
`0x9980ec85bc6fE07340adb36c76FA093bb6D4FcBc`.

## Browser UI

`npx tsx server.ts` → http://localhost:8787. The SDK stays in Node (it needs the ethers
provider); `ui.html` is plain HTML/JS with no build step and no CDN, fetching JSON from
the local server. Same read-only client, no signer.

A published/hosted static page cannot do this job: outbound fetch/XHR is blocked in the
Artifact sandbox, so live indexer and RPC data is unreachable from there.

Endpoints: `/api/health`, `/api/orders`, `/api/pricing?underlying=`, `/api/config`,
`/api/payout?type=&strikes=&contracts=&from=&to=&steps=`, `/api/probe-underlyings`.
Reads are cached 15s to avoid bursting the public RPC. Errors return HTTP 200 with
`{ok:false, code, message, throttled}` so the page renders the typed SDK error itself.

## Notes on running

RPC throttling was not hit in this session — all network steps returned first try
(getMarketData 659ms, fetchOrders 181ms, ETH pricing 288ms). The script detects the
`CALL_EXCEPTION`/no-revert-data shape and prints an instruction to set `RPC_URL` to an
Alchemy key rather than retrying.

Steps 5 and 6 make no network calls at all — `chainConfig` is bundled static config and
`utils.calculatePayout` is local math. Both completed in 2ms.
