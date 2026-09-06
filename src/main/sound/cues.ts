/**
 * OWNER: **Phase 4**. What the three cues sound like.
 *
 * Dictation is eyes-free; these tones are how the user knows the microphone
 * opened — and, on a failure, that it did not. Under ~80 ms for the two that
 * sit in the dictation path (§11.1.4).
 *
 * One rounded sine each, no strike noise, no stacked taps. A fifth-wide
 * glissando and an inharmonic glass hit both read as cheap; a small scoop
 * (a couple of semitones) with a long attack is enough to tell start from
 * stop without looking, and stays out of the way of speech. Synthesised in
 * the HUD renderer rather than sampled: nothing to go missing from a packaged
 * build, and the mute-after-start delay keys off `durationMs`.
 *
 * Pure data, so the durations are testable against the §11.1.4 budget.
 */

import type { AudioCue } from '@contracts/ports.js';

export interface CueSpec {
  readonly durationMs: number;
  /** Peak master gain, 0..1. Deliberately quiet: this plays over whatever else is on. */
  readonly gain: number;
  readonly fromHz: number;
  readonly toHz: number;
  /**
   * Linear fade-in. Below ~12 ms a sine reads as a click, which is the
   * "hard" the glass taps had.
   */
  readonly attackMs: number;
  /** Mix of a 2nd harmonic, 0..1. A little body, not a saw. */
  readonly harmonic: number;
}

/** The §11.1.4 budget for the cues that sit in the dictation path. */
export const CUE_BUDGET_MS = 80;

export const CUE_SPECS: Record<AudioCue, CueSpec> = {
  /** A small rise: "we are listening". */
  start: {
    fromHz: 587,
    toHz: 698,
    durationMs: 72,
    attackMs: 18,
    gain: 0.07,
    harmonic: 0.1,
  },
  /** A small fall, same register: "we stopped". */
  stop: {
    fromHz: 698,
    toHz: 523,
    durationMs: 72,
    attackMs: 18,
    gain: 0.06,
    harmonic: 0.08,
  },
  /**
   * One low, longer tone. A failed insertion — or a dead microphone — must
   * not also play `stop`. The player ducks whatever is ringing; the
   * orchestrator cancels a stop that is still waiting on unmute.
   */
  error: {
    fromHz: 220,
    toHz: 196,
    durationMs: 160,
    attackMs: 28,
    gain: 0.08,
    harmonic: 0.05,
  },
};

export function cueSpec(cue: AudioCue): CueSpec {
  return CUE_SPECS[cue];
}
