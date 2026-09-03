# THETHADUEL — Battles

A draft-and-duel prototype for options parlays. Two players draft tickers from a
shared board, pick a direction and target move per leg, then a compressed price
tape decides who cashed more legs.

Ported from the Claude Design source `THETHADUEL Battles.dc.html` to TypeScript +
React on Bun. No Vite, no webpack — Bun bundles `src/index.html` directly.

## Running

```bash
bun install
cp .env.example .env   # optional — add a WalletConnect project id
bun dev          # http://localhost:3000, hot reload
bun test         # 58 tests
bun run typecheck
bun run build    # → dist/
```

Without a `WALLETCONNECT_PROJECT_ID` the app runs on the mock wallet, so a fresh
clone plays with no signup. See **Connecting a wallet** below.

## Layout

```
index.ts              Bun.serve entry — serves and bundles src/index.html
src/
  index.html          the only HTML; Bun walks its tags and bundles them
  client.tsx          createRoot, injects the MarketSource
  App.tsx             shell + screen switch
  theme.ts            palette and the style builders (pill, tag, wall, …)
  types.ts            domain types
  lib/sx.ts           CSS declaration string → React.CSSProperties, cached
  state/
    battle.ts         all screen state, the actions, and the autopilot
    room.ts           useRoom() — create/join/ready, 1s polling, share-link parsing
    selectors.ts      activeUniverse / myLegs / oppLegs / arena
  engine/
    tape.ts           seeded random walk, sparkline geometry, price formatting
    chart.ts          one sparkline's view data
    payoff.ts         expiry payoff for the ETH vol box + its chart geometry
    match.ts          leg settlement, tie-break, the coach's match read
  data/
    universe.ts       the 18 draftable assets
    fixtures.ts       static content (cases, wins, rooms, slip)
    market.ts         MarketSource interface + the mock implementation
    wallet.ts         WalletSource interface, Base chain id, address formatting
    room.ts           RoomView wire shape, error codes, seat helpers
    stake.ts          USDC stakes, duel duration, the bands and the formatting
  server/
    rooms.ts          the in-memory room store; every transition a compare-and-set
  wallet/
    boundary.tsx      picks the tier at boot; the only AppKit importer
    injected.ts       EIP-6963 extension wallets — no configuration at all
    appkit.tsx        AppKit + ethers, adds the QR flow for phone wallets
    mock.ts           the placeholder wallet (no wallet installed at all)
    config.ts         network, metadata, modal theme, project-id fetch
  components/         DitherReveal, StarfieldButton, Sparkline, useTilt
  ui/                 Header, Footer, RoomsTable, CaseCards, AutoBanner
  views/              one file per screen
```

### Why style strings survive

The design computes its styles — a row's background depends on its index, a
leg's border on whether it won. `sx()` parses those declaration strings into
React style objects once and caches them, so the port reads next to the design
rather than forking from it. `src/lib/sx.ts` is the whole mechanism.

## Wiring Thetanuts in

Market data sits behind one interface, `MarketSource` in `src/data/market.ts`:

```ts
interface MarketSource {
  readonly id: string;
  underlyings(): readonly string[];
  pricing(underlying: string): readonly PricingRow[];
  orders(): readonly OrderRow[];
}
```

The app ships `mockMarketSource` (static fixtures, no network). To go live,
implement the same interface over `client.mmPricing.getPricingArray` and
`client.api.fetchOrders`, then change the one line in `src/client.tsx`:

```tsx
<App source={thetanutsMarketSource} />
```

No view changes. The footer reads `source.id`, so the provenance line updates
itself.

Two things the SDK forces (see `tnuts-test/FINDINGS.md`): the client needs an
ethers provider, so it has to run server-side — add routes to `index.ts` and
have the `MarketSource` fetch them. And `getPricingArray` is typed to `ETH | BTC`
only; every other asset returns `[]`, so `underlyings()` should stay explicit
rather than derived from the price feeds.

## Connecting a wallet

The wallet sits behind one interface, `WalletSource` in `src/data/wallet.ts` —
deliberately the same shape of seam as `MarketSource`:

```ts
interface WalletSource {
  readonly id: string;
  readonly identity: WalletIdentity;   // address, chainId, connected, wrongNetwork, …
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  openAccount(): Promise<void>;
  switchToBase(): Promise<void>;
  getSigner(): Promise<Signer | null>; // the seam for the on-chain trade
}
```

Three implementations, and `src/wallet/boundary.tsx` picks the best available at
boot:

1. **`useAppKitWallet()`** — [Reown AppKit](https://docs.walletconnect.network/app-sdk/react/installation)
   with the ethers adapter, scoped to Base. Needs `WALLETCONNECT_PROJECT_ID`.
   Browser extensions *and* phone wallets over a QR code.
2. **`useInjectedWallet()`** — browser extensions, via EIP-6963. Needs nothing.
   Real addresses, real signing; the only thing it cannot do is let a phone in.
3. **`useMockWallet()`** — the design's fixed `0x71c…4Af2`, for when no wallet is
   installed at all, and for `bun test`, where AppKit cannot initialise (it
   reaches for `window.crypto`, IndexedDB and a relay socket on init).

The ordering matters, and the first cut of this got it wrong: gating everything
behind the project id made MetaMask — the wallet that needs no setup whatsoever —
unreachable until you had registered a WalletConnect account. Tier 2 is why a
fresh clone connects a real wallet on the first click.

### Why EIP-6963 and not `window.ethereum`

With several extensions installed they fight over that one property. The symptom
is `TypeError: Cannot redefine property: ethereum` in the console, and whichever
lost the race is unreachable — so `window.ethereum` might hand you Phantom when
you wanted MetaMask. EIP-6963 has each wallet announce itself separately, so all
of them stay addressable and `src/ui/WalletPicker.tsx` lets the user choose.
Tested here against Rabby, OKX, MetaMask and Phantom side by side.

Note the SDK split, because it is easy to install the wrong half:
`@reown/walletkit` is the **Wallet SDK**, for building a wallet that dApps
connect *to*. This is a dApp, so it wants the **App SDK**, `@reown/appkit`.

### Why ethers and not wagmi

Thetanuts' own client is ethers 6 (`tnuts-test/FINDINGS.md` pins 6.17.0). Using
`@reown/appkit-adapter-ethers` keeps one web3 stack at one version instead of
carrying viem and wagmi alongside it, and makes `getSigner()` a two-line
`BrowserProvider` call against the same library the SDK already speaks.

### The project id

Optional. Without it, extension wallets work and phone wallets do not — the
project id buys the WalletConnect relay, which is what a QR code talks to.

`WALLETCONNECT_PROJECT_ID` in `.env`, from
[dashboard.walletconnect.com](https://dashboard.walletconnect.com). Add the
app's origin to the project's allowed domains or wallets refuse the session.

It reaches the browser over `/api/wallet-config` rather than through the bundle,
because Bun's HTML bundler does not inline `process.env` for `Bun.serve` routes —
only `bun build --env` does, so a compile-time read would work in `bun run build`
and silently be `undefined` under `bun dev`. The id is public either way (it
ships in every dApp bundle and is domain-restricted); serving it keeps it out of
git. Unset means the mock.

### Signing, and what is not done yet

`getSigner()` is wired and typed but nothing calls it. The intended split, given
that the Thetanuts client is provider-only and has to run server-side: the server
prices and builds the order, this signer signs and submits it from the browser.

Also open:

- **Balance.** `derived.p1Meta` shows the design's `bankroll 2.40 ETH` only while
  disconnected. With a real address it reads `base · <wallet>` instead — quoting
  a made-up balance under someone's actual address would be a fabricated number.
  A real one is a `useAppKitBalance()` call away.
- **ENS.** `p1Name` is the truncated address; Base has no L2 primary names, so
  this wants an L1 reverse lookup.
- **PvP.** The address is the player identity, which is the whole reason this
  landed before multiplayer — matchmaking and settlement now have something real
  to name players by. `useBattle(player)` takes one `PlayerIdentity`; the
  opponent is still the `kazuo.eth` fixture, and that fixture is the single thing
  the wire has to replace.

## Duel rooms and invite links

Connect a wallet, publish a lobby, get a link, send it to someone. They open it,
connect their own wallet, take the seat, both sides ready up, and the duel has
two real addresses in it.

```
POST /api/rooms            {address, prize, lobbyName}  -> {id, joinPath, seed, ...}
GET  /api/rooms/:id                                     -> RoomView
POST /api/rooms/:id/join   {address}
POST /api/rooms/:id/ready  {address}
GET  /room/:id             the share link (served by the SPA wildcard)
```

The store is a `Map` in `src/server/rooms.ts`. No database: a room lives for one
duel, and Postgres would buy durability nobody needs yet. A restart drops every
room, and rooms do not survive across processes.

### Every transition is a compare-and-set

`joinRoom` checks `guest !== null` and assigns in one synchronous step, so on a
single-threaded runtime it is a genuine CAS. Send one link to three friends and
let them all click at once: exactly one becomes the guest, the other two get a
409. The same shape against SQL is
`UPDATE rooms SET guest = ? WHERE id = ? AND guest IS NULL`, which is how the
store can move to a table without anything above it changing.

`readyBothAt` is written only while null, so whichever client reports the second
readiness fixes the start instant and a duplicate cannot drag it forward.

### Why both players see the same tape

The room carries a `seed`, fixed at creation. `studySalt` and `fightSalt` in
`src/state/selectors.ts` derive from it, so `actions.setSeed(room.seed)` on
entering the draft makes both browsers walk the same random walk. Without that
the two sides would be watching different prices and the result would mean
nothing.

### Polling, not sockets

`useRoom` re-reads the room every second while it is waiting on someone, and
stops once both sides are ready. A two-player lobby only ever waits on one event
— has my opponent shown up — and a 1s fetch against our own Bun server is less
machinery than a socket lifecycle for the same latency. The tape itself never
polls: a shared seed plus a shared start instant leaves nothing to sync.

### Two tabs on one machine

The mock wallet hands every tab the same address, and the store correctly refuses
to let a host fill their own challenger seat — so a local duel needs two
identities. `?as=0x…` overrides the mock address for one tab:

```
http://localhost:3000/?as=0xAAAA000000000000000000000000000000000001   # host
http://localhost:3000/room/<id>?as=0xBBBB000000000000000000000000000000000002   # guest
```

`?as=` also *selects* the mock tier, outranking both real ones. It has to:
on a machine with extensions installed the injected tier always wins, so without
this a local two-player test would need two real wallets in two browser profiles.

Dev affordance on the mock only. The live sources take their address from the
wallet and ignore the URL.

### What rooms do not do yet

- **No signature check.** Identity is the address in the request body, and
  nothing proves the caller controls it — anyone can POST someone else's address
  and take their seat. The fix is a nonce signed with `getSigner()` and verified
  with `verifyMessage`; `normalizeAddress` in `src/server/rooms.ts` is the one
  place it goes. Fine for two people who trust each other, not fine once a room
  holds money.
- **The draft is still local.** `derived.opponent` is the `kazuo.eth` fixture and
  the opponent's picks are simulated in `src/state/battle.ts`. The room agrees on
  who is playing and on the tape; it does not yet carry picks, bans or leg
  directions between the two browsers.
- **No stake escrow.** `prize` is a number in a room, not money anywhere.

## Stakes are USDC, and duels are measured in minutes

Two deliberate departures from the design source.

**The host sets a stake, not a pool.** The old builder asked for a prize pool and
showed half of it as the entry, so the host had to halve it in their head to know
what they were risking. Now the field is `STAKE PER PLAYER` and the pot is
derived: `poolOf(stake) === stake * 2`, shown as `WINNER TAKES`.

**The unit is USDC, not ETH.** With ETH as the unit, a move in ETH *during* the
duel changes what both players put in — a second bet nobody agreed to. USDC is
also the collateral Thetanuts quotes against on Base (`0x8335…2913` in
`tnuts-test/FINDINGS.md`). Bands and formatting live in `src/data/stake.ts`;
minimum 5 USDC, and the server clamps rather than rejecting, because a value
outside the band is a stale tab rather than something the host needs an error
about.

ETH survives only where it names the options underlying — `ETH VOL BOX`,
`ETH 4300 C`, the asset selector on Duel attack. Those are instruments, not money.

**Duration replaced tape speed.** A ×32 / ×64 / ×128 dial asked the player to
reason in multiples of an invisible unit. `DURATION (MINUTES)` is the thing they
actually care about, and `tapeStep` derives from it:

```ts
export const tapeStep = (s: BattleState): number =>
  TAPE_LEN / ((s.durationMinutes * 60_000) / TICK_MS);
```

Fractional on purpose — a one-minute duel is 500 ticks for 200 prints, so 0.4
prints each. `pos` floors the product, because a print index has to be a whole
print.

### The link is minted, not predicted

`Create arena & link` is one action: it creates the room server-side and only
then renders the invite panel. Nothing shows a link before there is a room
behind it, because such a link 404s when a friend clicks it.

Creating deliberately leaves the host on the builder rather than jumping to the
lobby — the useful next action is copying the link, not watching an empty second
seat. `Open lobby` goes there when they want it. Arriving on a `/room/<id>` link
opens the lobby directly, since for a guest that *is* the page they asked for.

## Rewards hub

The Rewards screen is a redesign, not a port — the design had a plain grid.

- **Rank track** — season XP bar with the tier thresholds (MINNOW → WHALE)
  marked along it. Fixtures in `src/data/rewards.ts`.
- **Free crypto battles** — a case-opening reel (`components/Roulette.tsx`).
  A strip of crypto tiles flies past a centre pointer, decelerates on a quintic
  ease, and stops on one; `planSpin()` decides the landing before the animation
  starts. Claiming drafts the asset into your first slot and opens a 0.50 ETH
  draft (`actions.claimFreeBattle`).
- **Daily missions** — ASCII checkboxes, XP, streak multiplier.
- **Case library** — tag filters, odds (max ÷ cost), and tier locks. Each case
  carries an image-like ASCII picture rendered by `engine/asciiImage.ts`: a
  tiny rasterizer that supersamples shaded vector shapes (top-left light,
  sphere falloff on discs) into a `" .:-=+*#%@"` luminance ramp. The pictures
  are specs in `data/ascii.ts`, so a new case is a few shapes, not hand-typed
  art.

## What the tape actually does

Every ticker's price history is a seeded random walk keyed on
`symbol + salt` — deterministic, so the same window replays across re-renders and
the study screen and the fight screen can draw *different* windows on the *same*
tickers by using different salts. `TAPE_LEN` is 200 prints; tape speed decides
how many print per 120ms tick.

A leg wins when the move from the tape's open clears its target in the chosen
direction. Ties on leg count break on conviction — the total absolute move across
the legs that landed — and, failing that, to player one.

## Notes on the port

- `battles`, `filters`, `tips` and `results` were computed in the design's logic
  layer but bound to nothing in its template. They are not carried over.
- The design's tilt handler targets `[data-wall]` and its backdrop carries a
  transform transition, but no element was ever marked — the counter-parallax
  never fired. `src/ui/CaseCards.tsx` marks it; remove the attribute for the flat
  version.
- The lobby's room table pinned a 760px minimum width on its header row but not
  its body rows, so columns drifted apart once scrolled. `RoomsTable` applies it
  to both.
- Thetanuts market data is deliberately not wired up yet — `mockMarketSource`
  still backs the pricing table. `tnuts-test/` is untouched. The wallet, by
  contrast, is live; see **Connecting a wallet**.
- The imported design source is kept in `.design/` for reference.
