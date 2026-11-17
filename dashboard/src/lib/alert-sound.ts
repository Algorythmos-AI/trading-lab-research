// The board's alert tones, with no React and no DOM in it: the audio context is made by a function passed in, so the
// rules below can be tested with a fake one.
//
//  * A browser runs audio only after a click or a key on the page. The context is made on the first such gesture
//    (`unlock`), or on a ring; a ring on a context that is not running yet plays nothing and says "needs-tap": it
//    never schedules tones that a later click would play late, and never claims a sound it did not make.
//  * Two tones: an entry (two rising notes) and an exit (three falling notes, louder). Each note has a short attack
//    and decay, so it does not click.
//  * Advisory and read only: a sound, nothing else.

export type AlertTone = "entry" | "exit";
export type AlertVolume = "quiet" | "normal" | "loud";
export const VOLUMES: readonly AlertVolume[] = ["quiet", "normal", "loud"];

/** Peak gain per volume step. */
export const GAIN: Record<AlertVolume, number> = { quiet: 0.06, normal: 0.14, loud: 0.3 };
/** The exit tone is this much louder than an entry, never above 0.5. */
export const EXIT_BOOST = 1.4;

/** One note: its pitch (Hz), when it starts after the ring (s) and how long it lasts (s). */
export interface Note {
  f: number;
  at: number;
  dur: number;
}
export const TONES: Record<AlertTone, readonly Note[]> = {
  entry: [
    { f: 660, at: 0, dur: 0.16 },
    { f: 990, at: 0.18, dur: 0.24 },
  ],
  exit: [
    { f: 1047, at: 0, dur: 0.14 },
    { f: 784, at: 0.17, dur: 0.14 },
    { f: 523, at: 0.34, dur: 0.3 },
  ],
};

export type SoundState = "ready" | "needs-tap" | "unsupported";
export type PlayResult = "played" | "needs-tap" | "unsupported";

/** What the engine uses of an AudioContext: enough to fake in a test. */
export interface AudioParamLike {
  setValueAtTime(v: number, t: number): unknown;
  linearRampToValueAtTime(v: number, t: number): unknown;
  exponentialRampToValueAtTime(v: number, t: number): unknown;
}
export interface AudioNodeLike {
  connect(n: unknown): unknown;
}
export interface AudioContextLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): AudioNodeLike & { type: string; frequency: AudioParamLike; start(t?: number): void; stop(t?: number): void };
  createGain(): AudioNodeLike & { gain: AudioParamLike };
  addEventListener?(type: "statechange", fn: () => void): void;
}

export interface SoundEngine {
  /** On a click or key on the page: make the context if need be and ask it to run; settles once it has answered. */
  unlock(): Promise<void>;
  /** Play a tone now, if the context runs; otherwise nothing, and say why. */
  play(tone: AlertTone, volume: AlertVolume): PlayResult;
  state(): SoundState;
  subscribe(fn: () => void): () => void;
}

/** `make` returns a new context, or null where the browser has none (it may throw: that counts as none). */
export function soundEngine(make: () => AudioContextLike | null): SoundEngine {
  let ctx: AudioContextLike | null = null;
  let unsupported = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((f) => f());

  const ensure = (): AudioContextLike | null => {
    // A context the browser has closed never runs again: make a new one.
    if (ctx && ctx.state === "closed") ctx = null;
    if (ctx || unsupported) return ctx;
    try {
      ctx = make();
    } catch {
      ctx = null;
    }
    if (!ctx) {
      unsupported = true;
      emit();
      return null;
    }
    ctx.addEventListener?.("statechange", emit);
    return ctx;
  };
  const wake = (c: AudioContextLike): Promise<void> => {
    if (c.state === "running") return Promise.resolve();
    // A refused resume leaves the state as it is: the switch keeps saying "tap".
    return c.resume().then(emit, emit);
  };

  const state = (): SoundState => {
    if (unsupported) return "unsupported";
    return ctx?.state === "running" ? "ready" : "needs-tap";
  };

  return {
    unlock() {
      const c = ensure();
      return c ? wake(c) : Promise.resolve();
    },
    play(tone, volume) {
      const c = ensure();
      if (!c) return "unsupported";
      if (c.state !== "running") {
        void wake(c); // works without a click where the page has had one before (a tab shown again)
        return "needs-tap";
      }
      const peak = Math.min(0.5, GAIN[volume] * (tone === "exit" ? EXIT_BOOST : 1));
      try {
        const t0 = c.currentTime + 0.01;
        for (const n of TONES[tone]) {
          const osc = c.createOscillator();
          const gain = c.createGain();
          osc.type = "sine";
          osc.frequency.setValueAtTime(n.f, t0 + n.at);
          gain.gain.setValueAtTime(0.0001, t0 + n.at);
          gain.gain.linearRampToValueAtTime(peak, t0 + n.at + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, t0 + n.at + n.dur);
          osc.connect(gain);
          gain.connect(c.destination);
          osc.start(t0 + n.at);
          osc.stop(t0 + n.at + n.dur + 0.02);
        }
      } catch {
        return "unsupported";
      }
      return "played";
    },
    state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
  };
}
