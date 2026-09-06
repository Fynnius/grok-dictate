/**
 * OWNER: **Phase 4**. What the three cues sound like.
 *
 * Dictation is eyes-free; these tones are how the user knows the microphone
 * opened — and, on a failure, that it did not. Under ~80 ms for the two that
 * sit in the dictation path (§11.1.4).
 *
 * Struck-glass two-note earcons, not oscillator sweeps. A linear sine ramp is
 * the cheap tell; a short inharmonic tick with a rising (start) or falling
 * (stop) fifth is what reads as a designed product sound. Synthesised in the
 * HUD renderer rather than sampled: nothing to go missing from a packaged
 * build, and the mute-after-start delay keys off `durationMs`.
 *
 * Pure data, so the durations are testable against the §11.1.4 budget.
 */

import type { AudioCue } from '@contracts/ports.js';

export interface CueNote {
  /** Fundamental of this tap, in hertz. */
  readonly hz: number;
  /** Offset from the start of the cue. */
  readonly atMs: number;
  /**
   * 0..1. Scales the inharmonic partials and the strike noise. Brighter =
   * more glass sparkle; darker = more wood.
   */
  readonly brightness: number;
}

export interface CueSpec {
  readonly durationMs: number;
  /** Peak master gain, 0..1. Deliberately quiet: this plays over whatever else is on. */
  readonly gain: number;
  /** Glass = crystal tap; muted = duller, slightly drooping (error). */
  readonly material: 'glass' | 'muted';
  readonly notes: readonly CueNote[];
}

/** The §11.1.4 budget for the cues that sit in the dictation path. */
export const CUE_BUDGET_MS = 80;

/**
 * Same perfect fifth (660 / 990 Hz) as the original pair, so start and stop
 * still invert each other. The interval is two discrete taps, not a glissando.
 */
export const CUE_SPECS: Record<AudioCue, CueSpec> = {
  /** Rising fifth: "we are listening". */
  start: {
    material: 'glass',
    durationMs: 70,
    gain: 0.12,
    notes: [
      { hz: 660, atMs: 0, brightness: 0.72 },
      { hz: 990, atMs: 24, brightness: 1 },
    ],
  },
  /** The same interval, falling and a little darker. */
  stop: {
    material: 'glass',
    durationMs: 64,
    gain: 0.1,
    notes: [
      { hz: 990, atMs: 0, brightness: 0.55 },
      { hz: 660, atMs: 22, brightness: 0.4 },
    ],
  },
  /**
   * Lower, duller, a little longer. A failed insertion plays `stop` then
   * `error` within a second; they have to be unmistakeable. Outside the
   * §11.1.4 budget on purpose: nothing is waiting on it.
   */
  error: {
    material: 'muted',
    durationMs: 140,
    gain: 0.15,
    notes: [
      { hz: 311, atMs: 0, brightness: 0.32 },
      { hz: 233, atMs: 52, brightness: 0.2 },
    ],
  },
};

export function cueSpec(cue: AudioCue): CueSpec {
  return CUE_SPECS[cue];
}
