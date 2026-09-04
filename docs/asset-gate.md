# The asset gate — committed probe output

Which Thetanuts underlyings can THETADUEL actually deal today? The honest answer
is a **measurement**, not a list. This file is the committed output of

```
bun run scripts/probe-assets.ts
```

taken on the date stamped in each block below. The gate itself is
`src/data/qualify.ts` — pure, fixture-driven, and unit-tested in
`test/qualify.test.ts`. The script is I/O and a table; every verdict it prints
was decided there.

**Re-run it before the demo, and re-run it *in* the demo.** A committed table is
evidence of a method, not a claim about tomorrow's book — that is the whole
reason the gate is a probe and not a hardcoded set (plan6 §7.1).

## ⚠ READ THIS BEFORE CONCLUDING THE BOOK IS DOWN

`https://indexer.thetanuts.finance/api/v1/book` returns 404 **by design** and always has.
`fetchOrders()` never requests it — it issues a relative `get("/")` against `apiBaseUrl`,
a Cloudflare Worker origin. `indexerApiUrl` is a path *prefix* other callers append to.
**Three separate agents have now curled that URL, seen the expected 404, and concluded the
venue moved its book. It never did.** Teardown: `docs/book-endpoint.md`.

## Live run

```
THETADUEL — asset gate probe
  chain     Base 8453 via https://mainnet.base.org
  run       2026-09-04T20:00:56.214Z
  gate      ≥6 fillable orders, ≥4 with a usable delta, ≥$50 depth, spot readable

  source    live Base 8453, book as of 2026-09-04T20:00:56.214Z
  read      362 resting orders, 6 market prices, 8 price-feed assets

ASSET           SPOT   ORDERS   GREEKED      DEPTH USD  MM    GRADE   VERDICT
----------------------------------------------------------------------------------------
ETH           $2,455      124        81     $1,191,241  yes   DEEP    QUALIFIED
BTC          $79,731      141        94     $1,355,890  yes   DEEP    QUALIFIED
SOL          $101.73       27        25       $260,000  no    THIN    QUALIFIED
DOGE               —        0         0              —  no    —       REJECTED — no market price; not enough resting orders; no usable deltas; not enough depth
XRP            $1.40       14        14       $140,000  no    THIN    QUALIFIED
BNB          $719.99       40        35       $375,000  no    THIN    QUALIFIED
PAXG               —        0         0              —  no    —       REJECTED — no market price; not enough resting orders; no usable deltas; not enough depth
AVAX           $7.39       16        16       $160,000  no    THIN    QUALIFIED

QUALIFIED: ETH (DEEP), BTC (DEEP), SOL (THIN), XRP (THIN), BNB (THIN), AVAX (THIN)
MM pricing grades, it never gates — the resting order book is a separate source and covers more assets.
```

## The four conditions

All four are necessary. An asset that fails any one of them cannot produce cards
the player can actually buy.

| # | Condition | Threshold | Why |
|---|---|---|---|
| 1 | Spot is readable | `getMarketData().prices` has it | Excludes PAXG — it has a Chainlink feed and no market price |
| 2 | Fillable resting orders | `MIN_ORDERS = 6` | Enough for ≥1 card in ≥3 delta buckets; a two-order book is a round with no choice in it |
| 3 | Usable deltas | `MIN_GREEKED = 4` | A row with no delta cannot be bucketed into a tier, and `rawApiData.greeks` is undocumented and genuinely absent on live orders |
| 4 | Real depth | `MIN_DEPTH_USDC = 50` | 25 × `MAX_FILL_USDC`. **The one that is cheap to skip and expensive to skip:** a card backed by $3 of depth previews fine and fills partially or not at all |

Aliases collapse **by feed address, not by key** — `ETH/USD` and `ETH` hold the
identical address (FINDINGS §5.6), and deduplicating by key would put ETH on the
reel twice and make it twice as likely to be dealt.

**MM pricing grades; it never gates.** `getPricingArray` covers ETH and BTC and
returns `[]` for the other six (FINDINGS §5.5), but the resting order book is a
*separate* source covering more assets. Gating on MM pricing would amputate the
protocol's own breadth. It sets `DEEP` (has MM pricing) vs `THIN` (orders and
greeks, no MM pricing) instead — a difficulty label on the lobby card, not a
locked door.

---

## Live run — 2026-09-04T17:10Z

The Odette book could not be read from this machine, so **there is no live
table**. That is the correct behaviour: an empty table would read as "no asset
qualifies", which is a false claim about the market made out of a true fact about
the network. The script says which endpoint it asked and what came back, and
exits non-zero.

```
THETADUEL — asset gate probe
  chain     Base 8453 via https://mainnet.base.org
  run       2026-09-04T17:10:08.764Z
  gate      ≥6 fillable orders, ≥4 with a usable delta, ≥$50 depth, spot readable

BOOK UNREACHABLE — fetchOrders() failed. No table: this is a network
result, not a market result, and an empty table would say the wrong thing.
  endpoint  https://indexer.thetanuts.finance/api/v1/book
  error     ThetanutsError: HTTP request failed
    caused by Error: unable to get local issuer certificate

Re-run with --fixture to show the same gate over the frozen capture.
```

exit code `1`.

### What was actually wrong, and what to check before the room

Two separate things, and only one of them is ours:

1. **TLS interception on this machine.** `unable to get local issuer certificate`
   is the SDK's Node HTTP agent refusing a certificate chain it does not trust —
   a proxy sitting in front of this network, not a Thetanuts outage. Bun's own
   `fetch` (different CA store) reaches the same host fine. **Run the probe from
   an un-intercepted network before the demo.**
2. ~~**The SDK's configured book route answers 404.**~~ **RETRACTED — this was
   wrong, and the way it was wrong is worth keeping on the record.**

   `fetchOrders()` does **not** request `indexerApiUrl`. It issues a relative
   `get("/")` against the axios instance built on `apiBaseUrl`, which for Base
   8453 is a Cloudflare Worker origin — verified serving 200 with ~382 orders
   carrying greeks and `availableAmount`. `indexerApiUrl` is a path *prefix*
   that every other SDK caller appends a subpath to (`/user/{a}/positions`,
   `/stats`, …), so requesting it bare 404s by design and always did.

   What actually happened: item 1's transport failure printed an endpoint
   nobody calls (the probe named the wrong field — since fixed), someone
   curled it, got the expected 404, and two unrelated facts fused into "the
   venue moved its book". It never moved. Do not ask the protocol team about
   this; the full teardown, with verbatim requests, is in
   `docs/book-endpoint.md`.

Neither changes a line of the gate. `probeAssets` never saw a socket.

---

## Frozen-capture run — `--fixture`

The identical gate, the identical formatter, over `test/fixtures/orders.json` —
one genuine Base mainnet `fetchOrders()` + `getMarketData()` response captured
2026-09-04T09:31Z, trimmed to 30 of 426 orders. It exists so the room's wifi is
not part of the argument, and it is banner-marked so a frozen table can never be
mistaken for a live one.

```
THETADUEL — asset gate probe
  chain     Base 8453 via https://mainnet.base.org
  run       2026-09-04T17:11:27.387Z
  gate      ≥6 fillable orders, ≥4 with a usable delta, ≥$50 depth, spot readable

  !!  SOURCE: FROZEN FIXTURE — NOT THE LIVE BOOK  !!
  test/fixtures/orders.json, 30 of 426 orders, hand-trimmed.
  It carries no mmPricing, so MM and GRADE below are unanswered, not 'no'.

  source    test/fixtures/orders.json, book as of 2026-09-04T09:31:00.000Z
  read      30 resting orders, 6 market prices, 8 price-feed assets

ASSET           SPOT   ORDERS   GREEKED      DEPTH USD  MM    GRADE   VERDICT
----------------------------------------------------------------------------------------
ETH           $2,522       16        16       $159,970  ?     ?       QUALIFIED
BTC          $81,004       14         9       $140,000  ?     ?       QUALIFIED
SOL          $104.09        0         0              —  ?     —       REJECTED — not enough resting orders; no usable deltas; not enough depth
DOGE               —        0         0              —  ?     —       REJECTED — no market price; not enough resting orders; no usable deltas; not enough depth
XRP            $1.45        0         0              —  ?     —       REJECTED — not enough resting orders; no usable deltas; not enough depth
BNB          $718.18        0         0              —  ?     —       REJECTED — not enough resting orders; no usable deltas; not enough depth
PAXG               —        0         0              —  ?     —       REJECTED — no market price; not enough resting orders; no usable deltas; not enough depth
AVAX           $7.50        0         0              —  ?     —       REJECTED — not enough resting orders; no usable deltas; not enough depth

QUALIFIED: ETH, BTC
MM pricing grades, it never gates — the resting order book is a separate source and covers more assets.
```

exit code `0`.

### Reading that table out loud

- **ETH and BTC qualify.** 16 and 14 fillable orders, $159,970 and $140,000 of
  depth. Note the depth figures are *valued*, not counted: three of the ETH
  orders are collateralised in aBasWETH at 18 decimals, and summing the integers
  would have made 3.96 ETH look like four quintillion dollars and qualified a
  dead asset.
- **BTC is greeked 9 of 14.** Five live BTC orders carry `delta: null`. That is
  why condition 3 counts rows rather than assuming them, and BTC clears
  `MIN_GREEKED` with room rather than by luck.
- **SOL, XRP, BNB and AVAX are priced and empty** *in this trimmed capture* —
  they fail conditions 2, 3 and 4 and not condition 1. AVAX in particular is on
  the live board bid-only; it is the asset whose presence on a hardcoded list,
  and absence from any real book check, made it the broken default. The row says
  `not enough resting orders`, which is the sentence the lobby greys the sector
  with.
- **DOGE and PAXG fail condition 1** — no market price. PAXG is the standing
  example: a Chainlink feed exists, spot does not, and eight feeds is therefore
  not seven prices. Three asset sets, three sizes.
- **MM and GRADE read `?`, not `no`.** The capture carries no `mmPricing`,
  because nobody asked the pricing host. "No MM pricing" would be a claim about a
  market maker; `?` is a claim about our own run.

The rejects are the interesting half. A sector greys **with a reason**, and the
reason is a measurement anyone in the room can re-run.

---

## Running it yourself

```
bun run scripts/probe-assets.ts            # live Base book, read-only, no signer
bun run scripts/probe-assets.ts --fixture  # the frozen capture, no network
bun run scripts/probe-assets.ts --help
RPC_URL=… bun run scripts/probe-assets.ts  # override the Base RPC
```

Exit `0` when the book was read, `1` when a source was unreachable — a failed
probe must look failed, not empty.

@see `plan6-real-parlay.md` §7, `tnuts-test/FINDINGS.md` §3, §5.5, §5.6
