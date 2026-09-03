import index from "./src/index.html";
import { ROOM_ERROR_STATUS, type RoomResult } from "./src/data/room.ts";
import {
  createRoom,
  joinRoom,
  listRoomsFor,
  pickRoom,
  readRoom,
  readyRoom,
} from "./src/server/rooms.ts";
import { marketSnapshot } from "./src/server/thetanuts.ts";

const NO_STORE = { "cache-control": "no-store" };

/** A `RoomResult` as JSON, with the status its error code maps to. */
function roomResponse(result: RoomResult): Response {
  if (result.ok) return Response.json(result.room, { headers: NO_STORE });
  return Response.json(
    { error: result.error, code: result.code },
    { status: ROOM_ERROR_STATUS[result.code], headers: NO_STORE },
  );
}

/** Bodies come off the wire untrusted; the store validates every field. */
async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Bun serves the app directly from `index.html`: it walks the tags, bundles
 * `client.tsx` and `styles.css`, and hot-reloads them in development. No Vite,
 * no build step.
 */
const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 3000),
  development: Bun.env.NODE_ENV !== "production",
  routes: {
    /**
     * The WalletConnect project id, read at boot by `src/wallet/config.ts`.
     *
     * It goes over the wire rather than into the bundle because Bun's HTML
     * bundler does not inline `process.env` for `Bun.serve` routes — a
     * build-time read would work under `bun run build` and silently be
     * `undefined` under `bun dev`. The id is public either way (it ships in
     * every dApp bundle and is domain-restricted in the dashboard); serving it
     * just keeps it out of git.
     *
     * Unset means the app falls back to the mock wallet.
     */
    "/api/wallet-config": () =>
      Response.json(
        { projectId: Bun.env.WALLETCONNECT_PROJECT_ID ?? "" },
        { headers: { "cache-control": "no-store" } },
      ),

    /**
     * Duel rooms. Identity is the caller's wallet address, sent in the body.
     *
     * Note what this does *not* do: verify that the caller controls that
     * address. Anyone can POST someone else's address and take their seat. The
     * fix is a signature — a nonce the client signs with `getSigner()`, checked
     * here with `verifyMessage` — and `normalizeAddress` in
     * `src/server/rooms.ts` is the one place it goes. Fine for a local duel
     * between two people who trust each other; not fine once a room holds money.
     */
    "/api/rooms": {
      POST: async (req) => {
        const b = await body(req);
        return roomResponse(
          createRoom({
            address: b.address,
            stakeUsdc: b.stakeUsdc,
            durationMinutes: b.durationMinutes,
            lobbyName: b.lobbyName,
            mode: b.mode,
          }),
        );
      },
    },
    /** Rooms this address sits in. Drives the hub's active-duels list. */
    "/api/rooms/mine": (req) =>
      Response.json(
        { rooms: listRoomsFor(new URL(req.url).searchParams.get("address")) },
        { headers: NO_STORE },
      ),

    "/api/rooms/:id": (req) => roomResponse(readRoom(req.params.id)),
    "/api/rooms/:id/join": {
      POST: async (req) => roomResponse(joinRoom(req.params.id, (await body(req)).address)),
    },
    "/api/rooms/:id/pick": {
      POST: async (req) => {
        const b = await body(req);
        return roomResponse(pickRoom(req.params.id, b.address, b.pick));
      },
    },
    "/api/rooms/:id/ready": {
      POST: async (req) => roomResponse(readyRoom(req.params.id, (await body(req)).address)),
    },

    /**
     * Live Thetanuts market data.
     *
     * Server-side because `pricing.thetanuts.finance` sends no CORS headers, so
     * the browser cannot read it directly. A failure returns HTTP 200 with
     * `{ok:false}` so the client can fall back to the mock and say so, rather
     * than the pricing table rendering an exception.
     */
    "/api/market": async () => {
      try {
        const snap = await marketSnapshot();
        return Response.json(
          {
            ok: true,
            at: snap.at,
            underlyings: snap.underlyings,
            spot: snap.spot,
            pricing: Object.fromEntries(snap.pricing),
            orders: snap.orders,
          },
          { headers: NO_STORE },
        );
      } catch (error) {
        console.error("[market]", error);
        return Response.json(
          { ok: false, error: error instanceof Error ? error.message : String(error) },
          { headers: NO_STORE },
        );
      }
    },

    // `/room/<id>` is a share link, not a server route — the SPA reads the id
    // off the path. The wildcard hands it the same bundle as `/`.
    "/*": index,
  },
});

console.log(`THETHADUEL running at ${server.url}`);
if (!Bun.env.WALLETCONNECT_PROJECT_ID) {
  console.log(
    "no WALLETCONNECT_PROJECT_ID — running on the mock wallet.\n" +
      "  get an id at https://dashboard.walletconnect.com and put it in .env",
  );
}
