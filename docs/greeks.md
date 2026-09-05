# The greeks — what they are, how we compute them, and what we refuse to

**Module** `src/data/greeks.ts` · **Wiring** `src/server/thetanuts.ts`, `src/desk/optionize.ts`
**Tests** `test/greeks.test.ts` · **Validated against** `test/fixtures/orders.json`

This is the explainer for the option maths the app now does. Plain language first,
formulas second, and every convention stated out loud — because the two worst bugs this
repo has had were both a number whose *units* only existed in somebody's head.

---

## 0. What changed

Before this, THETADUEL computed no option maths at all. It *read* two numbers off the
venue — a delta and an implied volatility — out of an undocumented `rawApiData.greeks`
field, and dropped the other three on the floor. And **103 of the 341 live rows** (every
spread, every butterfly, every ranger) carry no greeks from the venue whatsoever, so they
had no risk numbers at all.

Now there is a real pricing engine:

- **Black–Scholes–Merton**, closed form, with analytic delta, gamma, theta, vega and rho.
- A **normal CDF** accurate to 3.4e-16 absolute over the whole real line.
- An **implied-volatility solver** — Newton–Raphson, bisection fallback, hard caps, and
  guards that return `null` rather than a confident wrong answer.
- **Multi-leg composition**, so a spread, a fly, a condor and a ranger get greeks derived
  from their legs.
- A **provenance flag on every set**, so a number we computed can never be mistaken for a
  number the venue published.

---

## 1. The four numbers, in this game's terms

An option is a bet with a shape. The greeks are the four ways that shape can move under
you. Here is each one in the language of a duel.

### Delta — "how much of the move do I get?"

**Delta is the fraction of the underlying's move that lands in your position.** A 0.30-delta
ETH call gains about $0.30 for every $1.00 ETH gains.

It is also, to a very good first approximation, **the market's probability that the option
finishes in the money**. That second reading is the hinge the whole parlay screen turns on:
when a card says `above 2,650 · ~25%`, the 25% is a real listed option's delta, not a payout
table. `src/desk/optionize.ts` explains that design at length.

Two warnings that matter more than the definition:

1. **The probability reading only works for a plain vanilla.** A spread's delta is the *net*
   of two vanilla deltas and a condor's is the net of four. A 0.10 condor delta means "moves
   ten cents on the dollar", **not** "10% chance". An earlier agent read `PricingRow.type`
   (which says `CALL` even on a call spread), mistook 22 spreads for in-the-money vanillas,
   and nearly shipped a card promising an "88% chance" on a 10-delta instrument. The engine
   is built so that mistake is now unspellable — see §5.
2. **The venue only lists out-of-the-money wings.** Maximum |delta| across the whole capture
   is 0.50. The engine can price a 0.95-delta call perfectly well; that does not mean one is
   listed, and nothing here may be used to claim one is.

### Gamma — "how fast does that fraction change?"

**Gamma is how much delta itself moves per dollar of underlying.** A high-gamma option is one
whose exposure swings quickly — it turns from "barely participating" to "fully participating"
over a small move.

In duel terms: gamma is *why a near-the-money short-dated option feels alive*. A far wing has
almost no gamma, so nothing you watch on the tape changes what it is. A strike sitting right
on spot with a day to run has a lot, and it is the reason the same 8-second tape produces a
completely different experience on two different strikes.

Gamma is per one unit of the underlying, so it looks tiny on BTC (~1e-4) and less tiny on ETH
(~1e-3). Small is not zero.

### Theta — "what does waiting cost?"

**Theta is what the position loses to the passage of time**, with everything else held still.
A long option is a wasting asset: every hour that passes with no move is an hour of premium
gone.

**This is where the two clocks bite, and it is the single most dangerous number on the
screen.** THETADUEL runs two clocks that differ by four orders of magnitude:

| clock | length | what it is |
| --- | --- | --- |
| **duel clock** | 8 s (the seeded tape) — or 30–60 s for an RFQ window | what a player watches |
| **expiry clock** | 1–21 days | what the contract is actually written on |

Every theta anyone publishes is quoted against the **expiry** clock. A BTC put in the frozen
capture publishes `theta: −165.13`. That is **−$165.13 per calendar day**. Over an
eight-second duel, the same instantaneous rate is **−$0.0153**.

Both numbers are true. Printing the first one as "what this costs you during the duel"
overstates it by **10,800×**.

So the engine has **no field called `theta`**. It has `thetaPerDay` (what the venue
publishes, and the only theta safe to print without naming a window) and `thetaPerYear` (the
textbook derivative). Anything else goes through `decayOver(greeks, windowSeconds)` or
`duelDecay(quote, DUEL_WINDOW.tape)`, which *make you name the window*.

Theta's sign is worth one more note: for a **long vanilla** it is always negative. For a
**zone sitting on its flat top** it is *positive* — time passing is your friend when you are
already where you want to be. That sign flip is asserted in `test/greeks.test.ts` and it is
the strongest evidence that the composition maths is real rather than a sum of magnitudes.

### Vega — "what does the market's fear cost?"

**Vega is what the position gains when implied volatility rises by one point** (say IV 60% →
61%). Every long option is long vega: more expected movement is more chance of finishing
somewhere good.

In duel terms, vega is the part of the price that has nothing to do with direction. Two calls
at the same strike can be quoted very differently because the book disagrees about how much
the thing is going to move — and vega is how much of the premium that disagreement is worth.

Same naming discipline: **no field called `vega`**. There is `vegaPerPoint` (per 1% of IV —
what the venue publishes and what a human means) and `vegaPerUnitVol` (per 1.00 of IV — the
textbook derivative, 100× larger, and the one Newton's method needs).

### Rho — "what does the interest rate cost?"

**Rho is the sensitivity to the risk-free rate.** It is computed and carried for
completeness. Since this engine uses `r = 0` (§2), rho has no effect on any number the app
shows. It is present so that its irrelevance is visible rather than assumed.

---

## 2. The conventions, and why each one

This section is the contract. Every number in or out of the engine obeys it.

### The instruments: European, cash-settled

Verified from the shipped SDK (`@thetanuts-finance/thetanuts-client` 0.3.0), offline,
without touching the venue:

| claim | evidence |
| --- | --- |
| **Cash-settled** | `PositionSettlement` (`index.d.ts:1231`) carries `settlementPrice`, `payoutBuyer`, `collateralReturnedSeller` — money, not coins. Its `deliveryAmount` fields belong to the separately-named `PHYSICAL_*` implementations (`index.d.ts:214-233`), a different set of contracts. |
| **European** | `ChainConfig.twapConsumer` is *"HistoricalPriceConsumerV3_TWAP … used at settlement"*. The entire payout library takes **one** `settlementPrice` and knows nothing about a path. `plan7-measurements.md` §2.3 puts it in the game's words: *price does not have to stay in the band, it has to land there.* There is no early-exercise path anywhere in the SDK. |
| **The venue's own model is Black–Scholes** | `VaultModule.bsBaseDelta(vaultMathAddress, spot, strike, ivBps, tteSeconds)` (`index.d.ts:8901`) — *"Compute the Black-Scholes base delta using VaultMath"*. |

European + cash-settled + a single terminal price ⇒ **closed-form Black–Scholes–Merton is the
right model**, and every greek is an exact analytic derivative, not a finite difference and
not a tree.

### Year fraction: **ACT/365, calendar days**

`SECONDS_PER_YEAR = 365 × 86400`.

252 trading days is the *equity* convention, and it exists because an equity does not move at
3 a.m. on a Sunday. **This underlying does.** Base produces blocks continuously, Chainlink
prints continuously, and the venue lists expiries on calendar days at 08:00 UTC including
weekends. Using 252 would inflate every `T` by 365/252 = 1.448.

It is also what the venue does: its own `bsBaseDelta` takes `tteSeconds` — wall-clock
seconds. And it is what the data says: ACT/365 reproduces the venue's published deltas to a
mean absolute error of 0.0010, and `test/greeks.test.ts` asserts that a 252-day basis misses
by more than three times the model's whole error budget.

### Risk-free rate: **`r = 0`**, by default and overridable

Three reasons, in order of weight:

1. **The venue's own on-chain delta function takes no rate parameter at all.** That is the
   strongest possible evidence about what the venue believes, because it is the arithmetic it
   settles vaults with.
2. These are cash-settled USD-strike options on an asset with **no carry and no dividend**.
   With `r = q = 0` the forward equals the spot, which is the regime the payout code assumes.
3. `r = 0` already reproduces the published deltas to inside the published field's own
   precision (§6).

**An honest caveat.** A two-parameter fit over the frozen capture prefers `r ≈ 2.5%`
(RMSE 0.00054, against 0.00146 at `r = 0`). We do **not** adopt it. The capture's timestamp is
recorded only to the minute, and `r` trades off directly against that uncertainty — a rate
fitted on 25 rows against a clock known to ±30 s is fitting the clock. The rate is exposed as
an argument (`VanillaSpec.rate`) and defaulted to zero, so the day someone measures it, the
call site changes and the engine does not.

### Volatility: always a **fraction**

`0.6879`, never `68.79`, never `"68.79%"`. `PricingRow.iv` is a **display string in percent**
because `/desk` prints it verbatim; `parseIv` in `src/desk/optionize.ts` is the one boundary
that converts, and it **requires** the `%` — a bare `"0.58"` and a bare `"58"` are
indistinguishable, and guessing wrong prints `IV 0%` or `IV 5800%` next to a real strike.

### Theta: **`thetaPerDay`** and **`thetaPerYear`**, never `theta`

`thetaPerDay = thetaPerYear / 365`. The venue's published `theta` is per **calendar day** —
measured, not assumed. Its first order publishes `theta: -7.0104` against a premium of
`3.97`; as an annual rate that would be absurd, and it is exactly
`−S·φ(d₁)·σ/(2√T)/365`.

### Vega: **`vegaPerPoint`** and **`vegaPerUnitVol`**, never `vega`

`vegaPerPoint = vegaPerUnitVol / 100`. The venue's published `vega` is per **one volatility
point** — also measured.

### Premium: **per one unit of the underlying**

Matching the venue's `order.price` at 8dp: an ETH call quoted `3.9678` costs $3.97 for one
ETH-worth of exposure. Every price in and out of the engine is on that scale, so a greek is
"dollars per unit move" and needs no contract multiplier.

*(Note the row's own pre-existing asymmetry while you are here: `bid`, `ask` and `mid` come
off the signed order book and are already USDC per contract; `mark` comes off the market maker
and is in units of the underlying. `markUsd` is the converted one. They are not
interchangeable. See `PricingRow.markUsd` in `src/types.ts`.)*

---

## 3. The formulas, as implemented

With `S` spot, `K` strike, `σ` implied vol (fraction), `T` years (ACT/365), `r` rate
(default 0), `N` the standard normal CDF and `φ` its density:

```
d₁ = [ ln(S/K) + (r + σ²/2)·T ] / (σ√T)
d₂ = d₁ − σ√T

C  = S·N(d₁) − K·e^(−rT)·N(d₂)
P  = K·e^(−rT)·N(−d₂) − S·N(−d₁)

Δ_call = N(d₁)                       Δ_put = N(d₁) − 1
Γ      = φ(d₁) / (S·σ·√T)                                   [same both ways]
ν      = S·φ(d₁)·√T                                         [same both ways]
Θ_call = −S·φ(d₁)·σ/(2√T) − r·K·e^(−rT)·N(d₂)
Θ_put  = −S·φ(d₁)·σ/(2√T) + r·K·e^(−rT)·N(−d₂)
ρ_call = +K·T·e^(−rT)·N(d₂)          ρ_put = −K·T·e^(−rT)·N(−d₂)

vegaPerPoint  = ν / 100
thetaPerDay   = Θ / 365
rhoPerPoint   = ρ / 100
```

At `r = 0` the carry terms vanish and `Θ_call = Θ_put`, which is why the venue's published
thetas are reproduced by the first term alone.

**Gamma and vega are identical for a call and a put at the same strike.** That is not a
coincidence — it is put–call parity differentiated. Parity's difference `S − K·e^(−rT)` is
linear in `S` and free of `σ`, so it vanishes under `∂²/∂S²` and under `∂/∂σ`.
`test/greeks.test.ts` asserts it as an invariant rather than trusting two code paths to agree.

### The normal CDF

**Hart's 1968 algorithm** (in the double-precision form Graeme West published in Wilmott,
2005): a ratio of degree-7/8 polynomials for |x| < 7.07, a five-level continued fraction
above that, both evaluated on |x| and reflected.

Measured against two independent high-precision references — an erf Taylor series for
|x| ≤ 2 and a 1200-level tail continued fraction for 2 ≤ |x| ≤ 37, sampled every 0.002:

| quantity | value |
| --- | --- |
| **max absolute error, whole real line** | **3.4e-16** (≈1.5 ulp of 1.0) |
| relative error, \|x\| ≤ 2 | ≤ 1.2e-14 |
| relative error, \|x\| = 5 | ≈ 5e-11 |
| relative error, worst case (\|x\| ≈ 7.8) | 8.9e-9 — where N(x) itself is ~1e-14 |
| beyond \|x\| = 37 | exactly 0 or 1 (the density underflows a double) |

**Why not Abramowitz & Stegun 7.1.26**, the five-term polynomial most textbooks print? Its
maximum absolute error is **7.5e-8**. Since delta *is* `N(d₁)`, that is an error of 7.5e-8 in
delta directly — four orders of magnitude worse than the agreement we actually reach with the
venue, and it would put a floor under the validation in §6 that hid whatever real
disagreement was underneath. It also degrades badly in the far tail, which is exactly where a
deep-OTM crypto wing lives, and the wings are most of this book.

---

## 4. The implied-volatility solver

`impliedVol({spot, strike, years, right, price, rate?})` → `number | null`.

**Newton–Raphson** on `f(σ) = BS(σ) − price`, whose derivative is vega and therefore comes
free with the price. `f` is strictly increasing in σ and vega is strictly positive, so there
is exactly one root and no local minimum to fall into; from the Brenner–Subrahmanyam seed
`σ ≈ (price/S)·√(2π/T)` it converges in 3–5 steps.

**Bisection** takes over the moment Newton misbehaves — a step outside `[0.0001, 10]`, a vega
below 1e-12 (a very deep wing where the price is flat in σ to machine precision), or 32
iterations burned. Bisection restarts from the *full* bracket rather than from Newton's last
iterate: Newton failed, so nothing it touched is evidence about where the root is. It is
capped at 128 halvings, which is far more than double precision can use.

### It converges on σ, not on the premium

This one is a fix, not a preference, and it was caught by a round-trip test. An absolute
*price* tolerance is a trap on this book: a far wing quotes `0.0012` against a spot of
`2,522`, so "within 1e-8 of the target price" is satisfied by every volatility from 1% to
40%, and the solver returns whatever it was seeded with. The first draft of the module had
exactly that bug and returned `0.0001` for a true `2.00`. A vol tolerance (`1e-10`) has no
scale dependence.

### The guards — each one returns `null`

1. **Non-finite or non-positive inputs.** A zero spot prices everything at zero; a zero
   `years` has no volatility at all (any σ gives the same intrinsic value, so the implied vol
   is the whole real line).
2. **No-arbitrage bounds.** A European call must satisfy `max(S − K·e^(−rT), 0) ≤ C ≤ S`; a
   put, `max(K·e^(−rT) − S, 0) ≤ P ≤ K·e^(−rT)`. A quote outside those has no implied
   volatility — not a very large one, **none**, because no σ produces it. **This is the guard
   that matters most.** A stale stub ask on a far wing is an ordinary reading of this book,
   and bisection on such a price would converge happily to whichever end of the bracket it
   started near and hand back a confident, meaningless number.
3. **A price exactly at a bound** → `null`, not the edge of the bracket. Equality is the
   degenerate case, not a solution.
4. **Non-convergence** → `null`. Neither loop returns its last iterate as if it were an
   answer.

### Measured

Round-tripped over a 15,780-case grid (spot 50 → 2,600; moneyness 0.5 → 2.0; 1 day → 3 years;
σ 5% → 500%; both rights) restricted to quotes with a recoverable time value — premium above
intrinsic by more than `1e-8 × spot`:

> **worst absolute error in σ: 7.1e-10** — i.e. the tolerance.

Outside that restriction the honest answer is "there is nothing to recover". A call so deep
in the money that its premium equals `S − K` to the last bit of a double has lost its
optionality to floating point, not to arithmetic, and no solver can return σ from it. Those
fall out as `null` (below the no-arbitrage floor) or as a σ that reprices the premium exactly
while differing from the one that generated it — which is what *"the price does not determine
the vol here"* looks like. The venue lists only OTM wings, so none of them is a row this app
will see.

---

## 5. Multi-leg structures

**103 of 341 live rows** are `SPREAD`, `FLY` or `RANGER`, and the venue publishes **no greeks
for any of them**. `src/data/ranger.ts` records the measurement: 0 of 38 listed zones carried
greeks over 32 reads of the live book.

Their greeks *are* derivable, exactly. Every greek is a partial derivative of price;
differentiation is linear; a portfolio's price is the signed sum of its legs' prices;
therefore **a portfolio's greeks are the signed sum of its legs' greeks**, with no
approximation anywhere. A spread's delta is a *derived* number, not an *estimated* one.

### The decompositions — read off the venue's own settlement code

Not from memory and not from a textbook. Every row below was read out of
`ThetanutsUtils.calculatePayout` in the shipped SDK (`dist/index.js:10840`) — the same
function the venue settles with — and then checked against it price by price across the whole
price line in `test/greeks.test.ts`.

| `payout` | the venue's terminal value | replicated as |
| --- | --- | --- |
| `call` | `max(S−K,0)` | `+C(K)` |
| `put` | `max(K−S,0)` | `+P(K)` |
| `call_spread` | `min(S,K₂) − K₁` above `K₁` | `+C(K₁) −C(K₂)` |
| `put_spread` | `K₂ − max(S,K₁)` below `K₂` | `+P(K₂) −P(K₁)` |
| `call_fly` | `max(S−K₁,0) −2max(S−K₂,0) +max(S−K₃,0)` | `+C(K₁) −2C(K₂) +C(K₃)` |
| `put_fly` | `max(K₃−S,0) −2max(K₂−S,0) +max(K₁−S,0)` | `+P(K₁) −2P(K₂) +P(K₃)` |
| `call_condor` | `max(S−K₁,0) −max(S−K₂,0) −max(S−K₃,0) +max(S−K₄,0)` | `+C(K₁) −C(K₂) −C(K₃) +C(K₄)` |
| `put_condor` | `max(K₄−S,0) −max(K₃−S,0) −max(K₂−S,0) +max(K₁−S,0)` | `+P(K₁) −P(K₂) −P(K₃) +P(K₄)` |
| `iron_condor` | put spread `K₁/K₂` + call spread `K₃/K₄` | `+P(K₂) −P(K₁) +C(K₃) −C(K₄)` |
| `ranger` | piecewise: `0`, `S−cL`, `cU−cL`, `pU−S`, `0` | `+C(cL) −C(cU) −C(pL) +C(pU)` |

**The ranger line is a derivation, not a transcription** — the SDK writes it as a five-branch
piecewise function and never as a portfolio. It is exact, and it is exact *because* of the
ranger's own zone invariant `cU − cL = pU − pL`: substitute that into the call-condor sum and
the third branch collapses to `cU − cL` and the fourth to `pU − S`, which is the SDK's
function line for line. **A ranger is a call condor at its four strikes**, and the test
re-derives that across the whole price line rather than taking this paragraph's word for it.

One caution belongs next to it. `calculateCollateralRequired` returns `2 × (cU − cL)` for a
`RANGER` — **twice** the maximum payout the decomposition implies. That is the *seller's*
posted collateral, not the buyer's payoff. Reading one as the other is the mistake
`src/data/condor.ts` documents at length; the payoff function is authoritative and the
collateral function is not evidence against it.

### Filter on `payout`, never on `type`

`PricingRow.type` has three members because `/desk` colours by it, so **a call spread's `type`
is `CALL`** while its `structure` is `SPREAD` and its `payout` is `call_spread`. The engine
takes a *payout name*, never a side, so reading the wrong field is not something a caller can
express. And `payout` is resolved from the **implementation address**, never from counting
strikes — a four-strike row whose contract we cannot resolve is `UNKNOWN`, gets no payout
name, and therefore gets no greeks. That is the correct answer to "condor or ranger?" when
nothing authoritative said.

### Where the volatility comes from — and what it costs

Each leg needs a σ, and the venue publishes IVs per **listed vanilla strike**, never per
structure. So the engine does not decide; it takes a `volFor(strike, right)` callback and
returns `null` if *any* leg has no vol. A condor priced off three real IVs and one invented
one is not three-quarters honest.

`src/server/thetanuts.ts` supplies that callback from the **published smile** of the same
(underlying, option expiry), taking the **nearest listed strike**:

- **Calls and puts share one smile**, deliberately. Under put–call parity a call and a put at
  the same strike and expiry have the same implied vol — parity is a model-free identity
  between their *prices*, so any σ that reprices one reprices the other. One curve instead of
  two loses nothing and roughly doubles the coverage, which matters when a four-strike ranger
  needs a vol at four strikes.
- **Nearest, not interpolated.** Interpolating is a strictly larger claim — it asserts the
  smile is smooth and locally linear between two points that can be $1,000 apart on BTC. The
  nearest neighbour asserts only *"this is the closest thing the venue actually said"*, which
  is the weakest claim that still produces a number. It is also stable: a new listing between
  two old ones cannot swing a neighbour's greek the way a refitted curve would.

Borrowing is an approximation, so it is flagged: `RowGreeks.volSource` is `"own"` when the
venue published an IV for that exact strike and `"smile"` when it was borrowed.

### The sign flip that proves it is real

A long **vanilla** always has positive gamma, positive vega and negative theta. A long
**zone sitting on its flat top** has **negative gamma, negative vega and positive theta** —
more movement is bad, more fear is bad, and time passing is your friend when you are already
where you want to be. `test/greeks.test.ts` asserts both, and it is the strongest evidence
that the composition is maths rather than a sum of magnitudes.

---

## 6. Validation against the venue

Measured on `test/fixtures/orders.json` — the frozen 2026-09-04T09:31Z capture — over the
**25** single-strike orders that publish both a delta and an IV. `test/greeks.test.ts`
recomputes these on every run, so this table is a gate, not a note.

| greek | mean abs err | p95 | max | venue publishes to |
| --- | --- | --- | --- | --- |
| **delta** | **0.00104** | 0.00264 | 0.00329 | 4 dp |
| gamma | 2.1e-5 | 4.3e-5 | 4.6e-5 | 4 dp |
| theta / day | 0.109 | 0.391 | 0.642 | 4 dp, values −1.3 … −165 |
| vega / point | 0.039 | 0.138 | 0.452 | 4 dp, values 0.15 … 37.5 |

Per-row relative error is under **1%** on delta for every contract inside two weeks, and under
2% on the longest-dated pair. The residual is dominated by two things that cannot be removed
offline: the capture's timestamp is recorded to the **minute** (so `T` is uncertain by ±30 s)
and the spot used is the `getMarketData().prices` mark rather than whatever the pricing engine
held at the instant it computed the greek. Neither is a disagreement with the model.

### On the earlier 0.0030 figure — reproduced, and explained

A previous scratch run reported meanAbs **0.0030** (p95 0.0046). That is **consistent with
this measurement, and it was measuring the display format rather than the model.** That run
compared against `PricingRow.delta`, which is `toFixed(2)`. Rounding a delta to two decimals
injects a uniform ±0.005 error whose mean absolute value is 0.0025 all by itself — which is
most of 0.0030. Against the raw four-decimal `rawApiData.greeks.delta`, the same model scores
**0.0010**.

So: not refuted, and not a disagreement with the venue. The model agrees with the venue's own
arithmetic to inside the precision the venue prints.

### The conventions are not free parameters

The test suite asserts that breaking either one breaks the agreement by orders of magnitude,
which is the positive evidence that the ones chosen are the venue's:

- a 252-day year misses delta by **more than 3× the whole error budget**;
- reading `theta` as per-year misses by **>100×**;
- reading `vega` as per-1.00 misses by **>50×**.

### What still needs the live book

**The 113-row comparison the brief asked for cannot be done from this machine.** 113 rows
carrying both a published delta and an IV is a property of a full `/api/market` read; the
checked-in fixture is 30 hand-picked orders and cannot carry a distribution. The venue is
unreachable here — local DNS resolves `round-snowflake-9c31.devops-118.workers.dev` to an
OpenDNS block page, and any 43-byte `market.json` in a scratchpad is that failure payload, not
a book. **This is a local DNS condition, not a Thetanuts outage**; the correction for the
session that misdiagnosed it is pinned in `docs/asset-gate.md` and `docs/plan6-audit.md`.

Everything in §§1–5 needs no network: published reference values for `N(x)`, put–call parity,
the analytic identities between a call's greeks and a put's, and the SDK's own payout code
transcribed and diffed. Those are ground truth. Only the *size* of the §6 sample waits on the
book.

Two other things would be worth measuring against a live read:

1. **The implied rate.** With 113 rows and a timestamp better than minute resolution, the
   `r ≈ 2.5%` fit could be separated from the clock. Today it cannot.
2. **Composed greeks against a market maker's own.** The MM chain (`mmPricing`) quotes some of
   the same instruments; if it ever publishes greeks for a structure, that is the one
   independent check on the composition that the payoff identity does not already give.

---

## 7. Provenance — the rule, and how it is enforced

The repo's hard rule (`docs/reality-check.md`; the owner's standing instruction *"i dont want
to demo fake stuff"*) is that a number the venue published and a number we derived are never
interchangeable and never presented as each other. Both are honest. Conflating them is not.

Every greek set therefore carries a `source`, and it is not optional:

| tag | meaning |
| --- | --- |
| `venue` | verbatim from `rawApiData.greeks`. **Nothing in the engine ever produces one** — the tag exists so a mixed set can be described with one union. |
| `model` | computed by us, from a published IV **on this exact strike**. One venue input, one model. |
| `model-composed` | summed from the legs of a multi-leg structure, each leg priced off an IV published for a *different* strike. Two approximations deep, and it says so. |

How it is enforced in practice:

- `PricingRow.greeks` is a **separate object**, not five more sibling fields, precisely so a
  reader cannot pick one up by accident. `bid`, `ask`, `iv` and `delta` on the row are still
  the venue's own strings, untouched.
- `test/greeks.test.ts` asserts that **no computed set is ever labelled `venue`**, and that
  the venue's strings are byte-for-byte unchanged by the addition.
- `OptionQuote.delta` and `OptionQuote.impliedProb` on a parlay card remain the **venue's**
  published delta. `OptionQuote.greeks` is the parallel model reading, and a card may show its
  gamma, theta and vega — none of which the venue publishes for anything a player sees — but
  must **not** substitute `greeks.delta` where `impliedProb` belongs. *The odds on a card are
  the market's number, not ours.*
- A card gets greeks **only** for a vanilla priced off its own published IV. A composed set
  and a borrowed-vol set are both refused at that boundary (`vanillaGreeks` in
  `src/desk/optionize.ts`) — a second lock on the same door that `candidate`'s
  `structure`-based filter already closes, because the failure it guards against is the one
  that nearly shipped.

---

## 8. What the engine refuses to do

`null`, every time, rather than a number it cannot stand behind:

- no published IV anywhere on the row's smile;
- no premium, or a premium outside the no-arbitrage box;
- a non-positive time to expiry — **including exactly at expiry**, where the "right" answer is
  a step-function delta and an unbounded gamma. Both would be defensible in a textbook and
  indefensible on a card;
- a non-positive or non-finite spot, strike or vol;
- a structure whose strikes violate the venue's own invariants (unequal condor wings, a
  non-equidistant fly, a ranger with no zone gap);
- a product no authoritative table names — `UNKNOWN`, `CALL_LOAN`, a deployment newer than
  our installed SDK;
- a multi-leg structure with even one leg whose vol cannot be sourced.

And it **never manufactures an instrument.** The venue lists only OTM vanillas, max |delta|
0.50. The engine can price a 0.95-delta call; that does not put one on the book, and no caller
may use it to claim otherwise.

**A wrong greek is worse than a missing one.** An IV is the input to every other greek, so a
wrong IV is worse still.

---

## 9. Where to look

| you want | file |
| --- | --- |
| the maths, pure, numbers-in-numbers-out | `src/data/greeks.ts` |
| the venue's five published numbers, shape-checked | `venueGreeksOf` in `src/server/thetanuts.ts` |
| the smile, and one level's computed set | `smileIndex` / `nearestIv` / `levelGreeks`, same file |
| what lands on a row | `PricingRow.greeks` / `RowGreeks` in `src/types.ts` |
| what lands on a parlay card, and the duel clock | `OptionQuote.greeks` / `duelDecay` / `DUEL_WINDOW` in `src/desk/optionize.ts` |
| everything asserted | `test/greeks.test.ts` |

The engine is **pure** — no clock, no network, no import of anything under `src/server/`. That
is what lets it be imported from anywhere, including `src/engine/**`, without tripping the
source scan in `test/determinism.test.ts`. Keep it that way.
