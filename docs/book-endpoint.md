# Where the order book actually lives

**Status: RESOLVED. The book is up. There was never a book outage.**
Investigated 2026-09-04 ~17:50Z, Base mainnet 8453,
`@thetanuts-finance/thetanuts-client@0.3.0`.

The working theory going into this investigation was that Thetanuts had moved or
retired the Base order-book endpoint, because
`GET https://indexer.thetanuts.finance/api/v1/book` returns `{"error":"Not found"}`.

That 404 is real. It is also **irrelevant**: `fetchOrders()` never requests that
URL. The book is served from a different host entirely, that host is healthy, and
`/api/market` is serving live data again as of this writing.

The 404 got mistaken for the outage because `scripts/probe-assets.ts:209` prints
`client.indexerApiUrl` as "the endpoint" in its failure banner. That is the wrong
field. The real failure — printed one line lower in the same banner — was
`unable to get local issuer certificate`, a **local TLS-interception problem on
this machine**, not a Thetanuts one.

**There is nothing to ask the protocol team about the book being down.** One
genuinely open (non-urgent) question survives, in [§7](#7-the-one-question-still-worth-asking).

---

## 1. What `fetchOrders()` actually requests — FACT

From the bundled source, `node_modules/@thetanuts-finance/thetanuts-client/dist/index.js`:

```js
// line 2585 — fetchOrders
async fetchOrders() {
  const response = await this.request("/");
  const orders = response.data?.orders ?? response.orders ?? [];
  return orders.map((raw) => this.normalizeOdetteOrder(raw));
}

// line 2545 — request(): relative path against the axios baseURL
async request(endpoint, options) {
  const response = await this.client.http.get(endpoint, options);
  return response.data;
}

// line 16621 — the axios instance
this.http = axios.create({
  baseURL: this.apiBaseUrl,
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});
```

`apiBaseUrl` and `indexerApiUrl` are **two different fields** in the Base chain
config (`dist/index.js:169-174`):

```js
apiBaseUrl:    "https://round-snowflake-9c31.devops-118.workers.dev",
indexerApiUrl: "https://indexer.thetanuts.finance/api/v1/book",
wsBaseUrl:     "wss://ws.thetanuts.finance/v4",
pricingApiUrl: "https://pricing.thetanuts.finance",
stateApiUrl:   "https://indexer.thetanuts.finance",
```

Therefore, verbatim, the only request `fetchOrders()` makes is:

```
GET https://round-snowflake-9c31.devops-118.workers.dev/
Content-Type: application/json
(no auth, no query params, no chainId param — the worker is single-chain)
```

`getMarketData()` hits the **same** URL and reads `data.market_data` out of the
same body. One round trip serves both.

`indexerApiUrl` is used only by `indexerRequest()`, and every caller appends a
subpath:

| Method | URL |
|---|---|
| `getUserPositionsFromIndexer(a)` | `…/api/v1/book/user/{a}/positions` |
| `getUserHistoryFromIndexer(a)` | `…/api/v1/book/user/{a}/history` |
| `getStatsFromIndexer()` | `…/api/v1/book/stats` |
| `getReferrerStatsFromIndexer(a)` | `…/api/v1/book/referrer/{a}/state` |
| `triggerIndexerUpdate()` | `POST …/api/v1/book/update` |

**No SDK method ever requests the bare `/api/v1/book`.** It is a path *prefix*,
not a route. A 404 on it is expected behaviour, not a regression.

## 2. Live verification — FACT

All captured 2026-09-04, between 17:50Z and 17:54Z.

### 2a. The book host is healthy

```
$ curl -sS -i https://round-snowflake-9c31.devops-118.workers.dev/

HTTP/1.1 200 OK
Date: Fri, 04 Sep 2026 17:50:37 GMT
Content-Type: application/json
Content-Length: 325745
Cache-Control: public, max-age=0, no-store, no-cache, must-revalidate
Server: cloudflare
CF-RAY: a35ed6694870ce17-SIN

{"data":{"timestamp":"2026-09-04T17:50:03.395940+00:00","orders":[{"order":
{"ticker":"ETH-5SEP26-2400-P","maker":"0xEcda1D002FBC55F2Fd3386bB4B9B95F859f3C39E",
"orderExpiryTimestamp":1788544320,"collateral":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
"isCall":false,"priceFeed":"0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70", …
```

326 KB, 382 orders, timestamped 34 seconds before the request.

### 2b. The SDK reads it end-to-end

Constructing the real `ThetanutsClient` (chainId 8453, `https://mainnet.base.org`,
no signer) and calling the real methods:

```
apiBaseUrl    = https://round-snowflake-9c31.devops-118.workers.dev
indexerApiUrl = https://indexer.thetanuts.finance/api/v1/book
stateApiUrl   = https://indexer.thetanuts.finance

fetchOrders OK: 382 orders
sample keys: [ order, signature, availableAmount, makerAddress, rawApiData ]
  greeks:          {"delta":-0.086,"iv":0.3422,"gamma":0.0047,"theta":-4.4791,"vega":0.1543}
  availableAmount: 10000000000
getMarketData OK: ETH 2445.27  BTC 79458.53
```

Greeks present. `availableAmount` present. `rawApiData` present. This is exactly
the shape `test/fixtures/orders.json` captured at 09:31Z — same five top-level
keys, same fourteen `order` fields, same eleven `rawApiData` fields.

### 2c. The gate passes

`bun run scripts/probe-assets.ts`, live, 17:53:41Z — exit 0:

```
  source    live Base 8453, book as of 2026-09-04T17:53:41.631Z
  read      383 resting orders, 6 market prices, 8 price-feed assets

ASSET           SPOT   ORDERS   GREEKED      DEPTH USD  MM    GRADE   VERDICT
ETH           $2,444      124        85     $1,191,254  yes   DEEP    QUALIFIED
BTC          $79,400      145        94     $1,395,905  yes   DEEP    QUALIFIED
SOL          $101.15       30        26       $280,000  no    THIN    QUALIFIED
DOGE               —        0         0              —  no    —       REJECTED
XRP            $1.39       20        20       $200,000  no    THIN    QUALIFIED
BNB          $717.19       44        39       $415,000  no    THIN    QUALIFIED
PAXG               —        0         0              —  no    —       REJECTED
AVAX           $7.33       20        20       $200,000  no    THIN    QUALIFIED

QUALIFIED: ETH (DEEP), BTC (DEEP), SOL (THIN), XRP (THIN), BNB (THIN), AVAX (THIN)
```

Six qualified underlyings, all four conditions met — spot, ≥6 fillable orders,
≥4 usable deltas, ≥$50 depth.

### 2d. `/api/market` is live, not stale

```
$ curl -sS http://localhost:3000/api/market

ok: true    reason: undefined    note: undefined
at: 1788544334009  (2026-09-04T17:52:14.009Z)   age: 0.3s
top keys: [ ok, at, spot, pricing, mmPricing, orders, underlyings, optionBook, greeksSeen ]
pricing rows: { ETH: 65, BTC: 80, SOL: 17, XRP: 13, BNB: 27, AVAX: 12 }
orders: 40
```

No `note`. No `stale — refresh failed`. 214 pricing rows.

## 3. The 404 that was never the problem — FACT

```
$ curl -sS -w "\nHTTP %{http_code}\n" https://indexer.thetanuts.finance/api/v1/book
{"error":"Not found"}
HTTP 404
```

Genuine 404, genuine TLS, genuine server response. And on the **same host**, the
routes the SDK actually asks for under that prefix are all alive:

```
/api/v1/book/state             HTTP 200   (35 MB body — large, but served)
/api/v1/book/stats/protocol    HTTP 200
/api/v1/book/stats/daily       HTTP 200
/api/v1/stats/protocol         HTTP 200
/api/state                     HTTP 200
```

Body of `/api/v1/book/stats/protocol`:

```json
{"chainId":8453,"indexedBookAddresses":["0xd58b814c7ce700f251722b5555e25ae0fa8169a1",
"0x1bdff855d6811728acadc00989e79143a2bdfded"],"stats":{"7d":{"volume":
{"USDC":"28117.194814","aBasUSDC":"1.17495"},"feesUsd":"242.02", …
```

**Inference (high confidence):** the indexer routes `/api/v1/book/<something>` and
has no handler registered at the bare prefix, so it falls through to its 404. This
is ordinary router behaviour, not a moved endpoint.

## 4. What actually broke — FACT, then inference

**Fact.** The failure recorded in `docs/asset-gate.md` (run 2026-09-04T17:10Z) was:

```
BOOK UNREACHABLE — fetchOrders() failed.
  endpoint  https://indexer.thetanuts.finance/api/v1/book     ← wrong field, see below
  error     ThetanutsError: HTTP request failed
    caused by Error: unable to get local issuer certificate
```

**Fact.** `unable to get local issuer certificate` is a Node TLS chain-validation
failure. It is raised before any HTTP response exists.

**Fact.** The SDK's `mapHttpError` (`dist/index.js:483-517`) proves this from the
message alone. A response-bearing error is mapped by status:

- 404 → `NotFoundError("Resource not found: <url>")`
- any other status → `APIError("HTTP error <status>: …")`
- **no response at all** → `wrapError(error, "HTTP_ERROR", "HTTP request failed")`

The bare string `HTTP request failed` — the one in the `/api/market` stale note —
can *only* come from the last branch. **A 404 could not have produced that
message.** The error had no HTTP response: it was a transport failure.

**Fact.** The printed `endpoint` line is `client.indexerApiUrl`
(`scripts/probe-assets.ts:209`), which is not the URL `fetchOrders()` requests.
The banner attributed a transport failure to a URL that was never dialled.

**Inference (high confidence):** the whole "the book moved" theory came from that
one mislabelled line. Someone read the banner, curled the URL it named, got a real
404, and the two facts fused into a wrong conclusion.

**Inference (medium confidence):** the TLS interception was transient — a proxy or
security agent on this machine/network that was in the path at 17:10Z and is not
now. Bun + axios + the SDK all reach the host cleanly at 17:53Z with no config
change. Corollary: **it can come back.** See [§6](#6-blast-radius).

## 5. Can `/api/state` substitute for the book? — No. FACT.

Captured 2026-09-04T17:51Z, 3.2 MB:

```
lastUpdateTimestamp  1788544263  (2026-09-04T17:51:03Z — at chain head)
lastProcessedBlock   50877451
  rfqs        object{1091 keys}
  offers      object{919 keys}
  options     object{558 keys}
  userRFQs    object{78}   userOffers object{3}   userOptions object{71}
  protocolStats object{6}  referrals object{7}
  indexedFactoryAddresses  array[2]
```

Sample `options` entry:

```json
{"address":"0xAbb68c486B0E08A5c0dA10D2C5BE4941D928916d",
 "factoryAddress":"0x1adcd391cf15fb699ed29b1d394f4a64106886e5",
 "quotationId":"1","status":"pending","createdAt":1753690043,
 "createdTx":"0588cb…","createdBlock":33450348}
```

`offers` is keyed by maker address, and both live under `indexedFactoryAddresses`.

**This is RFQ / OptionFactory state, not the OptionBook.** Different product —
the README's own table says so: OptionBook data comes from `/api/v1/book/`,
RFQ data from `/api/v1/factory/`. `/api/state` is the factory side.

A `RawOrderEntry` **cannot** be derived from it. Missing, per-field:

| `RawOrderEntry` field | in `/api/state`? |
|---|---|
| `signature` (EIP-712, 65-byte) | **no** — RFQ offers are sealed-bid, encrypted |
| `order.price`, `order.strikes`, `order.expiry`, `order.nonce` | **no** |
| `availableAmount` | **no** — no resting size concept |
| `rawApiData.greeks` (delta/iv/gamma/theta/vega) | **no** |
| `rawApiData.maxCollateralUsable` (depth) | **no** |
| `makerAddress` | partially — `offers` is keyed by it |

Our gate needs orders **with greeks and depth** (conditions 3 and 4 in
`docs/asset-gate.md`). `/api/state` has neither. It is not a substitute, not even
a degraded one, and no amount of derivation gets there. **Do not build a fallback
on it.**

The MM pricing host is the only other greek-bearing source, and it grades rather
than gates — it covers ETH and BTC only.

## 6. Blast radius

Stated for the record, because it was the right call to treat this as
demo-critical while it was unexplained.

**When the book read fails, everything downstream of it fails at once:**

- `/api/market` serves the last good snapshot with `note: "stale — refresh
  failed: …"` and its original `at`, so the age chip tells the truth. This is the
  designed degradation and it worked correctly.
- `qualifiedUnderlyings` cannot gate — `scripts/probe-assets.ts` exits 1 and
  prints no table rather than an empty one, because an empty table reads as "no
  asset qualifies", which is a false claim about the market made from a true fact
  about the network.
- No card can be built from live rows.
- No fill can be previewed.

i.e. the flagship demo path is down for as long as the read is down, independent
of anything else in plan 6. **Right now it is up.** But §4's inference is that the
cause was local TLS interception, which is a property of the network the demo runs
on. **Run the probe on the demo network before the room**, and if
`unable to get local issuer certificate` appears again, it is the room's proxy,
not Thetanuts.

## 7. The one question still worth asking

The book is up, so there is no incident to report. One thing is worth a low-priority
message, because it is a real fragility and cheap to ask:

> Our Base client resolves `apiBaseUrl` to
> `https://round-snowflake-9c31.devops-118.workers.dev` (from
> `@thetanuts-finance/thetanuts-client@0.3.0`'s chain config for 8453), and
> `client.api.fetchOrders()` requests `GET /` there. It works and is serving ~380
> live orders. But that is an auto-generated `*.workers.dev` subdomain, not a
> branded host — is it a stable production URL we can rely on for a live demo, or
> is there a canonical hostname we should be pointing at instead?
>
> (Secondary, cosmetic: `GET https://indexer.thetanuts.finance/api/v1/book`
> returns `{"error":"Not found"}` while every `/api/v1/book/<sub>` route we use
> returns 200. We read that as the prefix simply having no handler — confirming
> would save the next person the same detour.)

Everything else the earlier draft would have asked is answered above and should
**not** be sent — asking whether the book endpoint moved, when it demonstrably has
not, costs credibility with the people who wrote the service.

## 8. The override, if a URL ever does change

`indexerApiUrl` **is** overridable — `ThetanutsClientConfig` declares it optional
(`dist/index.d.ts:148`) and the constructor prefers it over the chain default
(`dist/index.js:16619`):

```js
this.apiBaseUrl    = config.apiBaseUrl    ?? this.chainConfig.apiBaseUrl;
this.indexerApiUrl = config.indexerApiUrl ?? this.chainConfig.indexerApiUrl;
this.stateApiUrl   = config.stateApiUrl   ?? this.chainConfig.stateApiUrl;
```

**But `indexerApiUrl` is the wrong knob for the book.** To repoint the order
book, override `apiBaseUrl`. In `src/server/thetanuts.ts`, inside the
`new ThetanutsClient({ … })` call at line 411, add one line:

```ts
apiBaseUrl: Bun.env.THETANUTS_API_BASE_URL || undefined,
```

`undefined` falls through to the SDK's chain default, so with the env var unset
nothing changes. Set `THETANUTS_API_BASE_URL` to repoint the book without a code
change. The URL is used as an axios `baseURL` and `fetchOrders()` appends `/`, so
supply an origin with **no trailing slash**.

For completeness, the analogous knobs: `indexerApiUrl` (user positions, history,
book stats), `stateApiUrl` (RFQ/factory reads), `pricingApiUrl` (MM quotes).

## Appendix — how to re-verify in 30 seconds

```bash
# Is the book up?
curl -sS -o /dev/null -w "%{http_code} %{size_download}\n" \
  https://round-snowflake-9c31.devops-118.workers.dev/
# expect: 200 ~325000

# Does the gate pass?
bun run scripts/probe-assets.ts    # expect exit 0 and a table with ≥2 QUALIFIED

# Is our route serving live?
curl -sS http://localhost:3000/api/market | head -c 200
# expect: {"ok":true,"at":…  — and no "note" field
```

If the first succeeds and the second fails with
`unable to get local issuer certificate`, the problem is TLS interception on the
machine, not Thetanuts.
