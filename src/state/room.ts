import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { seatOf, bothReady, type RoomSeat, type RoomView } from "../data/room.ts";

/** How often the lobby re-reads the room while it is waiting on someone. */
const POLL_MS = 1000;

/** `/room/<uuid>` → `<uuid>`. Anything else → `null`. */
export function roomIdFromPath(pathname: string): string | null {
  const m = /^\/room\/([0-9a-fA-F-]{36})\/?$/.exec(pathname);
  return m ? m[1]! : null;
}

interface Wire {
  error?: string;
  code?: string;
}

async function post(url: string, payload: unknown): Promise<RoomView | string> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as RoomView & Wire;
  return res.ok ? data : (data.error ?? "Request failed.");
}

export interface Room {
  room: RoomView | null;
  /** Which side of the table you are on, or `null` if you are a bystander. */
  seat: RoomSeat | null;
  /** True once both sides are ready — the duel can start. */
  started: boolean;
  error: string | null;
  busy: boolean;
  create(prize: number, lobbyName: string): Promise<void>;
  join(): Promise<void>;
  ready(): Promise<void>;
  /** Drop the room and return the URL to the app root. */
  leave(): void;
  dismissError(): void;
}

/**
 * The duel room, client side.
 *
 * Polls rather than sockets: a two-player lobby only ever waits on one event
 * ("has my opponent shown up"), and a 1s fetch against our own Bun server is
 * less machinery than a socket lifecycle for the same latency. The live tape
 * does not poll — once both sides are ready they have a shared seed and a
 * shared start instant, so each client runs the same walk locally with nothing
 * left to sync.
 *
 * `address` is the connected wallet. Passing `null` (no wallet) still lets
 * someone open a link and *look* at the room; joining needs an address.
 */
export function useRoom(address: string | null): Room {
  const [room, setRoom] = useState<RoomView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The poller reads the current id without re-subscribing every tick.
  const idRef = useRef<string | null>(null);
  idRef.current = room?.id ?? null;

  const apply = useCallback((result: RoomView | string) => {
    if (typeof result === "string") {
      setError(result);
      return;
    }
    setRoom(result);
    setError(null);
  }, []);

  // Someone opened a share link: pick the id off the path and read the room.
  useEffect(() => {
    const id = roomIdFromPath(window.location.pathname);
    if (!id) return;
    let live = true;
    fetch(`/api/rooms/${id}`)
      .then((r) => r.json())
      .then((data: RoomView & Wire) => {
        if (!live) return;
        if (data.error) setError(data.error);
        else setRoom(data);
      })
      .catch(() => live && setError("Could not reach the server."));
    return () => {
      live = false;
    };
  }, []);

  // Poll while the room is still waiting on something. Once both sides are
  // ready nothing else changes server-side, so the timer stops.
  const settled = room !== null && bothReady(room);
  useEffect(() => {
    if (!room || settled) return;
    const timer = setInterval(() => {
      const id = idRef.current;
      if (!id) return;
      fetch(`/api/rooms/${id}`)
        .then((r) => r.json())
        .then((data: RoomView & Wire) => {
          if (!data.error) setRoom(data);
        })
        .catch(() => {
          /* a dropped poll is not worth surfacing; the next tick retries */
        });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [room, settled]);

  const create = useCallback(
    async (prize: number, lobbyName: string) => {
      if (!address) {
        setError("Connect a wallet first.");
        return;
      }
      setBusy(true);
      const result = await post("/api/rooms", { address, prize, lobbyName });
      if (typeof result !== "string") {
        // Make the URL the shareable thing, so a refresh keeps the room. The
        // query survives the rewrite: the mock wallet's `?as=` override lives
        // there, and dropping it would flip the host to a different address
        // mid-room.
        window.history.pushState(null, "", `${result.joinPath}${window.location.search}`);
      }
      apply(result);
      setBusy(false);
    },
    [address, apply],
  );

  const join = useCallback(async () => {
    const id = idRef.current;
    if (!id) return;
    if (!address) {
      setError("Connect a wallet first.");
      return;
    }
    setBusy(true);
    apply(await post(`/api/rooms/${id}/join`, { address }));
    setBusy(false);
  }, [address, apply]);

  const ready = useCallback(async () => {
    const id = idRef.current;
    if (!id || !address) return;
    setBusy(true);
    apply(await post(`/api/rooms/${id}/ready`, { address }));
    setBusy(false);
  }, [address, apply]);

  const leave = useCallback(() => {
    window.history.pushState(null, "", `/${window.location.search}`);
    setRoom(null);
    setError(null);
  }, []);

  const seat = useMemo(() => (room ? seatOf(room, address) : null), [room, address]);

  return {
    room,
    seat,
    started: settled,
    error,
    busy,
    create,
    join,
    ready,
    leave,
    dismissError: useCallback(() => setError(null), []),
  };
}
