/**
 * The decoded-audio cache: the one place a url becomes an `AudioBuffer`.
 *
 * It exists as its own module because of an import direction. `engine.ts`
 * imports `map.ts` — it needs `SFX_MAP` to dispatch a name to a recipe — so
 * `map.ts` may never import `engine.ts` back. But recipes are now the thing
 * that wants a sample: `spin.tick` and `spin.land` play a slice of a real
 * case-open recording and fall back to their synth when it is not there yet.
 * Putting the cache in a leaf both files can import is what keeps that from
 * becoming a cycle:
 *
 *              samples.ts        (imports nothing of ours)
 *              ↑         ↑
 *          engine.ts →  map.ts
 *
 * The alternative — an accessor exported from `engine.ts` — is the cycle, and
 * the other alternative — a second cache living in `map.ts` — would fetch and
 * decode the same file twice, once for the preloader and once for the recipe.
 * One cache, two callers, no edge back.
 *
 * The rule for every asset behind it is the same one the music and the button
 * clips already follow: **optional**. A missing file, a refused decode, or a
 * context that was never unlocked all end in `null`, never a throw and never a
 * rejected promise. The caller's job is to have something to do with `null` —
 * for a track that is silence, for a recipe it is the synth.
 */

/**
 * In flight or finished, per url, for the life of the tab. A failed load
 * caches its `null` too: the promise IS the one-attempt guarantee, so a
 * missing file costs one 404 and never a retry storm.
 */
const decoding = new Map<string, Promise<AudioBuffer | null>>();

/**
 * The resolved half of `decoding`, readable without awaiting. A recipe runs
 * inside `sfx()` on the click that caused it and cannot await anything — by
 * the time a promise settled the moment it was voicing would be gone — so the
 * synchronous read is the whole reason this second map exists.
 */
const decoded = new Map<string, AudioBuffer>();

/**
 * Fetch and decode `url` once. Subsequent calls get the same promise, settled
 * or not. Never rejects.
 */
export function loadBuffer(ctx: BaseAudioContext, url: string): Promise<AudioBuffer | null> {
  const hit = decoding.get(url);
  if (hit) return hit;
  const pending = (async (): Promise<AudioBuffer | null> => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null; // 404 is a legitimate answer: the asset is optional
      const bytes = await res.arrayBuffer();
      const buf = (await ctx.decodeAudioData(bytes)) ?? null;
      if (buf) decoded.set(url, buf);
      return buf;
    } catch {
      return null; // offline, aborted, or bytes that are not audio
    }
  })();
  decoding.set(url, pending);
  return pending;
}

/**
 * The decoded buffer for `url` if it is already in hand, `null` otherwise —
 * and on a miss, the load is started in the background so a later play finds
 * it. Synchronous by design: see `decoded` above.
 *
 * `null` is a normal answer, not an error. It is what the first milliseconds
 * of a session return (the graph is built inside the unlock gesture, and the
 * fetch it kicks off has not landed yet), what an offline tab returns, and
 * what a repo without the operator's mp3s returns forever. Every caller needs
 * a real second path, not a guard that gives up.
 */
export function getSample(ctx: BaseAudioContext, url: string): AudioBuffer | null {
  const hit = decoded.get(url);
  if (hit) return hit;
  void loadBuffer(ctx, url); // idempotent — `decoding` is the one-fetch guarantee
  return null;
}
