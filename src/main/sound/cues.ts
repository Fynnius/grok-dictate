/**
 * OWNER: **Phase 4**. What the three cues sound like.
 *
 * : "Short audio cues on start/stop. Under ~80 ms. Dictation
 * is eyes-free; this is the entire feedback channel." The user is looking at
 * the app they are dictating into, not at the pill, so these tones are how they
 * know the microphone actually opened — and, on a failure, that it did not.
 *
 * Synthesised rather than sampled. That is a boundary decision as much as a
 * taste one: shipping audio files would need an asset pipeline in
 * `electron.vite.config.ts`, which Phase 1 owns and froze. Two oscillator ramps
 * cost nothing and cannot go missing from a packaged build.
 *
 * Pure data, so the durations are testable against the §11.1.4 budget.
 */

import type { AudioCue } from '@contracts/ports.js';

export interface CueSpec {
  /** Start of the pitch sweep, in hertz. */
  readonly fromHz: number;
  /** End of the sweep. Rising = "open", falling = "closed". */
  readonly toHz: number;
  readonly durationMs: number;
  /** Peak gain, 0..1. Deliberately quiet: this plays over whatever else is on. */
  readonly gain: number;
  readonly wave: 'sine' | 'triangle';
}

/** The §11.1.4 budget for the cues that sit in the dictation path. */
export const CUE_BUDGET_MS = 80;

export const CUE_SPECS: Record<AudioCue, CueSpec> = {
  /** Rising, so "we are listening" is unmistakable without looking. */
  start: { fromHz: 660, toHz: 990, durationMs: 55, gain: 0.16, wave: 'sine' },
  /** The same interval, falling. */
  stop: { fromHz: 990, toHz: 660, durationMs: 55, gain: 0.14, wave: 'sine' },
  /**
   * Low and a little longer, because it has to be distinguishable from `stop`
   * when the two arrive within a second of each other — a failed insertion
   * plays `stop` and then `error`. It is outside the §11.1.4 budget on purpose:
   * nothing is waiting on it.
   */
  error: { fromHz: 320, toHz: 180, durationMs: 130, gain: 0.2, wave: 'triangle' },
};

export function cueSpec(cue: AudioCue): CueSpec {
  return CUE_SPECS[cue];
}
