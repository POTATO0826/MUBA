/**
 * The synth primitives. Every sound in the app is built from these five —
 * there are no audio assets, so there is nothing to license, nothing to load
 * and nothing to keep in sync with the code that plays it.
 *
 * Each takes `(ctx, dest, when, params)`: the graph to build into, the node to
 * hang off, and the exact context-clock moment to start. Nothing here reads a
 * global, decides whether it may be heard, or keeps state beyond one shared
 * noise buffer per context — that is `budget.ts` and `engine.ts`.
 *
 * One hard rule throughout: an exponential ramp cannot target 0 (it throws)
 * and a step to 0 clicks, so every envelope lands on `SILENT` instead.
 */

/** The floor every envelope ramps to — audibly zero, legally non-zero. */
export const SILENT = 0.0001;

/** A sustained voice (a bed, the riser) the engine stops by hand. */
export interface SoundHandle {
  stop(when: number, fadeSec: number): void;
}

const NOISE = new WeakMap<BaseAudioContext, AudioBuffer>();

/** One 2s white-noise buffer per context, shared by every burst and swell. */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const hit = NOISE.get(ctx);
  if (hit) return hit;
  const buf = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * 2)), ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  NOISE.set(ctx, buf);
  return buf;
}

/** attack → decay envelope, exponential both ways, ending at `SILENT`. */
function envelope(
  ctx: BaseAudioContext,
  dest: AudioNode,
  when: number,
  attack: number,
  dur: number,
  peak: number,
): GainNode {
  const g = ctx.createGain();
  const top = Math.max(SILENT * 2, peak);
  const a = Math.max(0.0005, Math.min(attack, dur * 0.9));
  g.gain.setValueAtTime(SILENT, when);
  g.gain.exponentialRampToValueAtTime(top, when + a);
  g.gain.exponentialRampToValueAtTime(SILENT, when + dur);
  g.connect(dest);
  return g;
}

/** Release a sustained gain without a click, whatever it was doing. */
function fadeOut(param: AudioParam, when: number, fadeSec: number): void {
  const hold = param as AudioParam & { cancelAndHoldAtTime?: (t: number) => AudioParam };
  if (typeof hold.cancelAndHoldAtTime === "function") hold.cancelAndHoldAtTime(when);
  else param.cancelScheduledValues(when);
  param.setTargetAtTime(SILENT, when, Math.max(0.01, fadeSec) / 3);
}

export interface BlipParams {
  freq: number;
  dur: number;
  wave?: OscillatorType;
  /** Exponential glide to this frequency across `dur`. */
  freqTo?: number;
  attack?: number;
  peak?: number;
  /** Cents of detune — a few random cents keeps repeats from phasing. */
  detune?: number;
  lp?: number;
  /** Filter cutoff at the end of `dur`, if the cutoff should sweep. */
  lpTo?: number;
  hp?: number;
  q?: number;
}

/** osc → [filter] → envelope. The workhorse: clicks, blips, bells, pads. */
export function blip(ctx: BaseAudioContext, dest: AudioNode, when: number, p: BlipParams): void {
  const dur = Math.max(0.006, p.dur);
  const g = envelope(ctx, dest, when, p.attack ?? 0.002, dur, p.peak ?? 0.9);
  let head: AudioNode = g;

  if (p.hp !== undefined) {
    const f = ctx.createBiquadFilter();
    f.type = "highpass";
    f.frequency.setValueAtTime(p.hp, when);
    f.connect(head);
    head = f;
  }
  if (p.lp !== undefined) {
    const f = ctx.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(p.lp, when);
    if (p.lpTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(40, p.lpTo), when + dur);
    if (p.q !== undefined) f.Q.setValueAtTime(p.q, when);
    f.connect(head);
    head = f;
  }

  const osc = ctx.createOscillator();
  osc.type = p.wave ?? "sine";
  osc.frequency.setValueAtTime(Math.max(20, p.freq), when);
  if (p.freqTo !== undefined) osc.frequency.exponentialRampToValueAtTime(Math.max(20, p.freqTo), when + dur);
  if (p.detune !== undefined) osc.detune.setValueAtTime(p.detune, when);
  osc.connect(head);
  osc.start(when);
  osc.stop(when + dur + 0.03);
}

export interface NoiseParams {
  dur: number;
  /** Defaults to a bandpass — the metal-pin ring of the reel tick. */
  type?: BiquadFilterType;
  freq?: number;
  /** Filter cutoff at the end of `dur`, for swells and whooshes. */
  freqTo?: number;
  q?: number;
  peak?: number;
  attack?: number;
  hp?: number;
}

/** A slice of the shared noise buffer, filtered and enveloped. */
export function noiseBurst(ctx: BaseAudioContext, dest: AudioNode, when: number, p: NoiseParams): void {
  const dur = Math.max(0.006, p.dur);
  const g = envelope(ctx, dest, when, p.attack ?? 0.001, dur, p.peak ?? 0.5);
  let head: AudioNode = g;

  if (p.hp !== undefined) {
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(p.hp, when);
    hp.connect(head);
    head = hp;
  }
  if (p.freq !== undefined) {
    const f = ctx.createBiquadFilter();
    f.type = p.type ?? "bandpass";
    f.frequency.setValueAtTime(Math.max(40, p.freq), when);
    if (p.freqTo !== undefined) f.frequency.exponentialRampToValueAtTime(Math.max(40, p.freqTo), when + dur);
    if (p.q !== undefined) f.Q.setValueAtTime(p.q, when);
    f.connect(head);
    head = f;
  }

  const src = ctx.createBufferSource();
  const buf = noiseBuffer(ctx);
  src.buffer = buf;
  src.connect(head);
  const room = Math.max(0, buf.duration - dur - 0.05);
  src.start(when, Math.random() * room, dur + 0.02);
}

export interface SweepParams {
  f0: number;
  f1: number;
  dur: number;
  wave?: OscillatorType;
  lp0?: number;
  lp1?: number;
  q?: number;
  peak?: number;
  attack?: number;
}

/** A pitch glide with an optional filter opening behind it. */
export function sweep(ctx: BaseAudioContext, dest: AudioNode, when: number, p: SweepParams): void {
  blip(ctx, dest, when, {
    freq: p.f0,
    freqTo: p.f1,
    dur: p.dur,
    wave: p.wave ?? "sawtooth",
    peak: p.peak ?? 0.7,
    attack: p.attack ?? 0.01,
    ...(p.lp0 !== undefined ? { lp: p.lp0, lpTo: p.lp1 ?? p.lp0, q: p.q } : {}),
  });
}

export interface ThunkParams {
  f0: number;
  f1: number;
  dur: number;
  bodyPeak?: number;
  clickPeak?: number;
}

/** Body plus transient: the sound of something heavy arriving in a slot. */
export function thunk(ctx: BaseAudioContext, dest: AudioNode, when: number, p: ThunkParams): void {
  sweep(ctx, dest, when, {
    f0: p.f0,
    f1: p.f1,
    dur: p.dur,
    wave: "sine",
    peak: p.bodyPeak ?? 0.9,
    attack: 0.004,
  });
  noiseBurst(ctx, dest, when, {
    dur: Math.min(0.05, p.dur * 0.4),
    type: "lowpass",
    freq: 900,
    peak: p.clickPeak ?? 0.5,
  });
}

export interface ChordParams {
  freqs: readonly number[];
  dur: number;
  wave?: OscillatorType;
  peak?: number;
  attack?: number;
  lp?: number;
  lpTo?: number;
  q?: number;
  detune?: number;
  /** Onset spacing. 0 is a chord; anything else arpeggiates. */
  spreadMs?: number;
  /** Each successive note relative to the first — arps taper. */
  falloff?: number;
}

/** N blips at one onset, or walked apart into an arpeggio. */
export function chord(ctx: BaseAudioContext, dest: AudioNode, when: number, p: ChordParams): void {
  const spread = (p.spreadMs ?? 0) / 1000;
  const falloff = p.falloff ?? 1;
  p.freqs.forEach((f, i) => {
    blip(ctx, dest, when + i * spread, {
      freq: f,
      dur: p.dur,
      wave: p.wave ?? "triangle",
      peak: (p.peak ?? 0.7) * Math.pow(falloff, i),
      attack: p.attack ?? 0.004,
      ...(p.detune !== undefined ? { detune: p.detune } : {}),
      ...(p.lp !== undefined ? { lp: p.lp, lpTo: p.lpTo ?? p.lp, q: p.q } : {}),
    });
  });
}

export interface BedParams {
  /** Cutoff of the noise layer — the whole bed's colour. */
  cutoff?: number;
  /** Sub-bass fundamental under the noise. */
  sub?: number;
  peak?: number;
  attack?: number;
  /** Cutoff wander, in Hz, at 0.08Hz. */
  drift?: number;
}

/**
 * A sustained room tone: filtered noise plus a sub, breathing on a slow LFO.
 * Sustained voices are singletons the engine holds and releases, so this one
 * hands back a handle instead of scheduling its own end.
 */
export function bed(ctx: BaseAudioContext, dest: AudioNode, when: number, p: BedParams): SoundHandle {
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, when);
  g.gain.exponentialRampToValueAtTime(Math.max(SILENT * 2, p.peak ?? 0.5), when + (p.attack ?? 0.6));
  g.connect(dest);

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(p.cutoff ?? 500, when);
  lp.Q.setValueAtTime(0.5, when);
  lp.connect(g);

  const src = ctx.createBufferSource();
  src.buffer = noiseBuffer(ctx);
  src.loop = true;
  src.connect(lp);
  src.start(when);

  const lfo = ctx.createOscillator();
  lfo.type = "sine";
  lfo.frequency.setValueAtTime(0.08, when);
  const depth = ctx.createGain();
  depth.gain.setValueAtTime(p.drift ?? 120, when);
  lfo.connect(depth);
  depth.connect(lp.frequency);
  lfo.start(when);

  const sub = ctx.createOscillator();
  sub.type = "sine";
  sub.frequency.setValueAtTime(p.sub ?? 55, when);
  const subGain = ctx.createGain();
  subGain.gain.setValueAtTime(0.15, when);
  sub.connect(subGain);
  subGain.connect(g);
  sub.start(when);

  return {
    stop(at, fadeSec) {
      fadeOut(g.gain, at, fadeSec);
      const end = at + fadeSec + 0.1;
      src.stop(end);
      lfo.stop(end);
      sub.stop(end);
    },
  };
}

export interface RiserParams {
  f0?: number;
  f1?: number;
  /** Wall-clock length of the climb, in seconds. */
  dur: number;
  peak?: number;
  lp0?: number;
  lp1?: number;
}

/** The tension climb under the last stretch of tape. Singleton, stoppable. */
export function riser(ctx: BaseAudioContext, dest: AudioNode, when: number, p: RiserParams): SoundHandle {
  const dur = Math.max(0.1, p.dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(SILENT, when);
  g.gain.exponentialRampToValueAtTime(Math.max(SILENT * 2, p.peak ?? 0.5), when + dur);
  g.connect(dest);

  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(p.lp0 ?? 300, when);
  lp.frequency.exponentialRampToValueAtTime(p.lp1 ?? 3500, when + dur);
  lp.Q.setValueAtTime(8, when);
  lp.connect(g);

  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  osc.frequency.setValueAtTime(p.f0 ?? 110, when);
  osc.frequency.exponentialRampToValueAtTime(p.f1 ?? 440, when + dur);
  osc.connect(lp);
  osc.start(when);

  const swell = ctx.createBufferSource();
  swell.buffer = noiseBuffer(ctx);
  swell.loop = true;
  const swellGain = ctx.createGain();
  swellGain.gain.setValueAtTime(SILENT, when);
  swellGain.gain.exponentialRampToValueAtTime(0.25, when + dur);
  swell.connect(swellGain);
  swellGain.connect(lp);
  swell.start(when);

  return {
    stop(at, fadeSec) {
      fadeOut(g.gain, at, fadeSec);
      const end = at + fadeSec + 0.1;
      osc.stop(end);
      swell.stop(end);
    },
  };
}
