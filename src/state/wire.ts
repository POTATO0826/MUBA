import { useEffect, useRef, useState } from "react";
import type { Brief } from "../data/briefs.ts";
import { mockNewsSource, type NewsSource, type WireItem, type WireResult } from "../data/news.ts";
import { mockWire } from "../data/wire.ts";

/**
 * The study terminal's feed, seeded first and live second.
 *
 * The rule this hook exists to enforce: **the wire is never empty and never
 * blocks**. The seeded feed is built synchronously, in the state initialiser,
 * so the very first paint already carries a full terminal — no spinner, no
 * empty pane, and no `await` in a test that only wants to read headlines. The
 * live source is then given its chance in an effect; if it answers with
 * something usable the feed swaps under the component, and if it does not
 * (offline, rate-limited, `THETADUEL_NEWS=off`, a throw) the seeded wire simply
 * stays up and the header chip keeps reading SEEDED.
 *
 * Nothing here can influence a duel. The items are handed to `NewsWire` and to
 * nowhere else; settlement reads `fightSalt` and `legState`, which this hook
 * cannot see.
 */

/** Which feed is on screen — the header chip's whole input. */
export type WireStatus = WireResult["source"];

export interface UseWireArgs {
  /** Injected at the root. Tests get `mockNewsSource` and touch no network. */
  source: NewsSource;
  /** `"${lobbyId}:${seed}"` — the identity of the match being studied. */
  matchKey: string;
  /** The dealt tickers. */
  arena: readonly string[];
  /** The study salt: what the seeded wire is drawn from. */
  salt: number;
  /** `briefsFor()` whole — `mockWire` keeps the desk half and pins it on top. */
  deskLines: readonly Brief[];
}

interface Feed {
  /** The match this feed belongs to. A feed never outlives its `matchKey`. */
  key: string;
  items: readonly WireItem[];
  status: WireStatus;
}

const seededFeed = (
  matchKey: string,
  arena: readonly string[],
  salt: number,
  deskLines: readonly Brief[],
): Feed => ({ key: matchKey, items: mockWire(arena, salt, deskLines), status: "mock" });

export function useWire({ source, matchKey, arena, salt, deskLines }: UseWireArgs): {
  wire: readonly WireItem[];
  status: WireStatus;
} {
  // Synchronous: the terminal is populated on the first render, before any
  // effect has run. This is what makes the wire testable without `await`.
  const [feed, setFeed] = useState<Feed>(() => seededFeed(matchKey, arena, salt, deskLines));

  // The hook is called once at the root and therefore outlives any one match.
  // When the (lobby, seed) pair changes, the previous match's feed — live rows
  // included — must not paint over the new one. Re-seeding during render (the
  // documented "adjust state when a prop changes" path) keeps that swap inside
  // the same commit, so no frame shows the wrong match's headlines. `arena`,
  // `salt` and `deskLines` are all functions of `matchKey`, so it is the only
  // key needed.
  let current = feed;
  if (feed.key !== matchKey) {
    current = seededFeed(matchKey, arena, salt, deskLines);
    setFeed(current);
  }

  // The request is keyed on `source.id` + `matchKey`, so a caller that rebuilds
  // its source object every render cannot spin the effect. The live value is
  // read through a ref rather than a dependency for the same reason.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const argsRef = useRef({ arena, salt });
  argsRef.current = { arena, salt };

  useEffect(() => {
    const src = sourceRef.current;
    // The seeded source would hand back exactly what is already on screen —
    // same pure function, same arguments — so the round trip is skipped.
    if (src.id === mockNewsSource.id) return;

    // Only the newest request may write: a match switched mid-flight, or a
    // StrictMode double-mount, must not resurrect a stale payload.
    let ignore = false;
    src
      .wire({ matchKey, tickers: argsRef.current.arena, salt: argsRef.current.salt })
      .then((res) => {
        // Anything unusable leaves the seeded wire exactly where it is.
        if (ignore || !res.ok || res.items.length === 0) return;
        setFeed({ key: matchKey, items: res.items, status: res.source });
      })
      // A source is contracted never to reject; if one does, that is a bug in
      // the source and not a reason to blank the terminal.
      .catch(() => {});
    return () => {
      ignore = true;
    };
  }, [source.id, matchKey]);

  return { wire: current.items, status: current.status };
}
