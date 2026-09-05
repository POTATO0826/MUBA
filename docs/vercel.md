# Vercel deployment through GitHub

Import `POTATO0826/MUBA` in Vercel and use `main` as the production branch.
The checked-in `vercel.json` selects the Bun runtime, installs the lockfile,
builds the frontend into `dist`, and serves `/api/*` through a Vercel Function.
Frontend navigation falls back to `index.html`; JS/CSS asset paths are absolute
so opening a nested room URL directly works.

Add the entries from your local `.env.local` to the Vercel project's environment
variables before deploying. Keep that file out of GitHub. Only public settings
are returned by `/api/config`; private keys and RPC credentials stay on the
server. Changing a Vercel environment variable requires a new deployment.
Do not upload `DEPLOYER_PRIVATE_KEY`: it is only for the local contract deployer.

`WALLETCONNECT_PROJECT_ID` is optional; without it the app uses a mock wallet.
With a project ID, add the deployed origin to the Reown project's allowed
domains. An empty `ATTESTOR_PRIVATE_KEY` leaves settlement signing unavailable.

## Multiplayer limitation

Rooms, committed duel picks, and frozen news snapshots currently live in
process memory. Vercel can run requests on different instances and retire idle
instances, so this deployment does not yet provide reliable multiplayer or
durable settlement locks. A shared durable store with atomic writes is required
before relying on those features. A single catch-all function does not remove
this limitation.

Optional MP3 files under `src/assets` are gitignored. They will not be available
in a GitHub deployment unless the operator separately supplies licensed assets;
the app's existing silent/synthesized fallbacks apply.

## Verification

Run `bun run typecheck` and
`bun test test/vercel.test.ts test/chain-guard.test.ts test/market-route.test.ts test/secrets.test.ts`.
The secrets test builds and scans fresh frontend output. To verify Vercel's
emitted function, run `bunx vercel build --prod` followed by
`bun scripts/check-vercel-build.ts`. The TypeScript setting
`rewriteRelativeImportExtensions` is required because Vercel emits `.js` files
from the server's `.ts` modules. The function also explicitly includes Noble's
hash package so both conditional crypto exports are present at runtime.
After deployment,
check `/`, a nested frontend URL, `/api/config`, and `/api/market`, and confirm
that the deployment's source is the expected GitHub commit.
