/**
 * OWNER: **Design overhaul, session 3** (§19.1). The maths behind the ten bars,
 * kept out of `main.tsx` so it can be unit-tested without a window.
 *
 * ## Why this file exists at all
 *
 * Session 1 drove the bars straight from the level the capture renderer sends:
 * `height[i] = min + envelope[i] × (rms × 3)`, with a 90 ms CSS transition.
 * Two things made that read as dead — the user's report was "I speak normally
 * and they don't move properly":
 *
 *  1. **The scale was wrong.** RMS is a *linear* amplitude, and normal speech
 *     through a laptop microphone with AGC sits around 0.02–0.08 — times three
 *     that is 0.06–0.24, so the tallest bar spent the whole dictation between
 *     18 % and 35 % of its travel. The bars were not stiff so much as barely
 *     leaving the floor. Loudness is logarithmic, so the mapping is now dB
 *     (§19.1): −58 dBFS is the floor, −14 dBFS is full height, and ordinary
 *     speech lands in the top half of the range where it belongs.
 *  2. **All ten bars were one number.** A single scalar times a fixed envelope
 *     means every bar rises and falls in perfect lockstep — a bell that
 *     breathes, not a waveform. The level also only arrives **ten times a
 *     second** (one `capture-level` per 1,600-frame worklet post), so between
 *     samples nothing moved at all.
 *
 * The fix keeps the transport at 10 Hz — raising it would put 40+ state-machine
 * transitions a second through the main process for a decoration — and spends
 * the renderer's own frames instead: a 60 Hz loop with an asymmetric envelope
 * follower (fast attack, slow release, like every real meter) and a per-bar
 * delay that lets each level sample travel outward from the centre pair. One
 * syllable becomes a ripple across the row rather than a simultaneous twitch.
 *
 * Everything here is pure and frame-rate independent (`dt` in, no clocks), so
 * `waveform.test.ts` can step it deterministically.
 */

/** Ten bars, as measured from the reference pill (overhaul §15.1). */
export const BAR_COUNT = 10;

/**
 * The reference waveform is a symmetric bell: outermost bars are dashes, the
 * centre pair tall (overhaul §4.2). `sin^1.5` reproduces the screenshots
 * (§11.1.3); the exponent is what tames the outer bars into dashes.
 */
export const ENVELOPE: readonly number[] = Array.from(
  { length: BAR_COUNT },
  (_, i) => Math.sin((Math.PI * (i + 0.5)) / BAR_COUNT) ** 1.5,
);

/** Bar geometry, in CSS px = pt (§15.1): 2 wide, 16 tall at full level. */
export const BAR_MIN = 2;
export const BAR_MAX = 16;

/**
 * The dB window the bars span. Below `FLOOR_DB` is silence (flat dashes);
 * `CEIL_DB` is a bar at full height.
 *
 * −58 dBFS is under the room tone a mic with Chromium's noise suppression
 * reports between words, so a pause still drops the bars to dashes. −14 dBFS is
 * about where a laptop microphone with AGC peaks on someone speaking up, so
 * "loud" is reachable without shouting. Speech at a normal distance (≈ −30 dB)
 * lands at roughly two thirds — visibly alive, with headroom left.
 */
const FLOOR_DB = -58;
const CEIL_DB = -14;

/** Linear RMS (0..1, as `rmsOf` reports it) → 0..1 of the bars' travel. */
export function loudness(rms: number): number {
  if (!(rms > 0)) return 0; // also catches NaN
  const db = 20 * Math.log10(rms);
  return clamp01((db - FLOOR_DB) / (CEIL_DB - FLOOR_DB));
}

/**
 * Attack and release, in milliseconds, as time constants.
 *
 * Asymmetry is the whole trick: a meter that rises as slowly as it falls feels
 * laggy, and one that falls as fast as it rises flickers. 45 ms up is faster
 * than the 100 ms level packets arrive, so the bars jump on the first sample of
 * a syllable; 190 ms down carries them across the gaps *inside* a word instead
 * of collapsing between every consonant.
 */
const ATTACK_MS = 45;
const RELEASE_MS = 190;

/** One follower step. Exponential, so the result does not depend on the frame rate. */
export function follow(current: number, target: number, dtMs: number): number {
  const tau = target > current ? ATTACK_MS : RELEASE_MS;
  // 1 − e^(−dt/τ) is the fraction of the remaining distance covered in dt.
  return current + (target - current) * (1 - Math.exp(-Math.max(0, dtMs) / tau));
}

/**
 * How far behind the live level each bar runs, in milliseconds, measured from
 * the centre outward.
 *
 * This is what turns one number into a waveform. The centre pair shows the
 * level now; each bar further out shows it slightly later, so a syllable
 * spreads outward as a visible ripple. 22 ms per step puts the outermost bars
 * ~99 ms behind — one level packet — which is exactly enough for a single
 * sample to be crossing the row when the next one lands.
 */
const DELAY_PER_BAR_MS = 22;

export const DELAY_MS: readonly number[] = ENVELOPE.map(
  (_, i) => Math.abs(i - (BAR_COUNT - 1) / 2) * DELAY_PER_BAR_MS,
);

/**
 * A per-bar shimmer, so a sustained vowel is not ten bars frozen at one height.
 *
 * Scaled by the level, so silence is dead flat — the dashes must stay still, or
 * the pill draws the eye while the user is looking at the app they dictate
 * into (§11.1.13 is the same instinct). Frequencies are mutually irrational
 * enough that the row never falls into a visible pattern.
 */
const SHIMMER = 0.13;
const SHIMMER_HZ: readonly number[] = ENVELOPE.map((_, i) => 2.7 + i * 0.41);

/**
 * The height of bar `i`, as a `scaleY` factor against the 16 pt bar in the CSS.
 *
 * `delayed` is the follower's value from `DELAY_MS[i]` ago; `tSec` is any
 * monotonic clock, and only the shimmer uses it.
 */
export function barScale(i: number, delayed: number, tSec: number): number {
  const shimmer = 1 + SHIMMER * delayed * Math.sin(2 * Math.PI * (SHIMMER_HZ[i] ?? 3) * tSec + i);
  const height = BAR_MIN + clamp01((ENVELOPE[i] ?? 1) * delayed * shimmer) * (BAR_MAX - BAR_MIN);
  return height / BAR_MAX;
}

/**
 * A fixed-step history of the follower, so each bar can read the level as it
 * was `DELAY_MS[i]` ago.
 *
 * Fixed-step rather than timestamped: at a 8 ms step the ring is 15 slots for
 * the ~99 ms of delay the outermost bars need, and a lookup is one subtraction.
 * A dropped frame simply advances the ring further, which is what should happen
 * — the ripple keeps its wall-clock speed.
 */
export const STEP_MS = 8;

export class LevelHistory {
  readonly #slots: Float32Array;
  #head = 0;
  /** Time not yet consumed by a whole step. */
  #carry = 0;
  #value = 0;

  constructor() {
    const longest = Math.max(...DELAY_MS);
    this.#slots = new Float32Array(Math.ceil(longest / STEP_MS) + 2);
  }

  /** Advance by `dtMs` of real time, chasing `target` (0..1). */
  advance(dtMs: number, target: number): void {
    this.#carry += Math.min(Math.max(0, dtMs), 250); // a backgrounded tab, ignored
    while (this.#carry >= STEP_MS) {
      this.#carry -= STEP_MS;
      this.#value = follow(this.#value, target, STEP_MS);
      this.#head = (this.#head + 1) % this.#slots.length;
      this.#slots[this.#head] = this.#value;
    }
  }

  /** The follower's value `delayMs` ago, rounded to the nearest step. */
  at(delayMs: number): number {
    const back = Math.min(Math.round(delayMs / STEP_MS), this.#slots.length - 1);
    const index = (this.#head - back + this.#slots.length) % this.#slots.length;
    return this.#slots[index] ?? 0;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
