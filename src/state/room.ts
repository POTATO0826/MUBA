import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { seatOf, bothReady, type RoomSeat, type RoomView } from "../data/room.ts";
import type { GameMode } from "../types.ts";

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
  /**
   * The absolute link to hand to an opponent, or `null` with no room. Built
   * from the browser's own origin plus the server's `joinPath`, so it is right
   * on localhost, a LAN IP and a deploy without the server knowing any of them.
   */
  inviteUrl: string | null;
  /** True when the room came off a `/room/<id>` URL rather than from `create`. */
  arrivedFromLink: boolean;
  /** Which side of the table you are on, or `null` if you are a bystander. */
  seat: RoomSeat | null;
  /** True once both sides are ready — the duel can start. */
  started: boolean;
  error: string | null;
  busy: boolean;
  create(
    stakeUsdc: number,
    durationMinutes: number,
    lobbyName: string,
    mode: GameMode,
  ): Promise<void>;
  /** Load a room by id, for the hub's active-duel list. */
  open(id: string): Promise<void>;
  /** Lock this seat's pick. Write-once; the server refuses a second. */
  pick(pick: string): Promise<void>;
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
  const [arrivedFromLink, setArrivedFromLink] = useState(
    () => roomIdFromPath(window.location.pathname) !== null,
  );

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

  /**
   * Both seats have reported ready. This releases the lobby into the mode board.
   *
   * Kept separate from `pollDone` on purpose. They were one flag once, and
   * folding the pick reveal into it deadlocked the duel: the lobby waited for
   * picks, and the picks needed the board the lobby was holding shut.
   */
  const started = room !== null && bothReady(room);

  /** Nothing left to wait on — an opponent, a readiness, or the other pick. */
  const pollDone = started && (room?.revealed ?? false);

  const roomId = room?.id ?? null;
  useEffect(() => {
    if (!roomId || pollDone) return;
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
    // Keyed on the id, not the room object. Each poll returns a fresh object,
    // so an object dependency would tear down and rebuild the interval every
    // single tick.
  }, [roomId, pollDone]);

  const create = useCallback(
    async (stakeUsdc: number, durationMinutes: number, lobbyName: string, mode: GameMode) => {
      if (!address) {
        setError("Connect a wallet first.");
        return;
      }
      setBusy(true);
      const result = await post("/api/rooms", {
        address,
        stakeUsdc,
        durationMinutes,
        lobbyName,
        mode,
      });
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

  const open = useCallback(
    async (id: string) => {
      setBusy(true);
      try {
        const res = await fetch(`/api/rooms/${id}`);
        const data = (await res.json()) as RoomView & Wire;
        if (res.ok) {
          setRoom(data);
          setError(null);
          window.history.pushState(null, "", `/room/${id}${window.location.search}`);
        } else {
          setError(data.error ?? "Could not open that duel.");
        }
      } catch {
        setError("Could not reach the server.");
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const pick = useCallback(
    async (choice: string) => {
      const id = idRef.current;
      if (!id || !address) return;
      setBusy(true);
      apply(await post(`/api/rooms/${id}/pick`, { address, pick: choice }));
      setBusy(false);
    },
    [address, apply],
  );

  const leave = useCallback(() => {
    window.history.pushState(null, "", `/${window.location.search}`);
    setRoom(null);
    setError(null);
    setArrivedFromLink(false);
  }, []);

  const seat = useMemo(() => (room ? seatOf(room, address) : null), [room, address]);

  const inviteUrl = useMemo(
    () => (room ? `${window.location.origin}${room.joinPath}` : null),
    [room],
  );

  return {
    room,
    inviteUrl,
    arrivedFromLink,
    open,
    pick,
    seat,
    started,
    error,
    busy,
    create,
    join,
    ready,
    leave,
    dismissError: useCallback(() => setError(null), []),
  };
}
