/**
 * Short-tap silence gate.
 *
 * At end of turn, an utterance that is both *short* and *measurably silent*
 * is dropped without waiting on the server. A brushed hotkey otherwise opens
 * a socket, ships room tone, and shows a failure.
 *
 * **Duration is a precondition, not the gate.** "Yes", "no", "OK", "ship it"
 * are legitimate dictations and are short by definition. Amplitude is what
 * decides. Bias hard toward transcribing: a wasted API call costs a fraction
 * of a cent, a swallowed sentence costs the user's trust.
 *
 * **If any partial with text already arrived, never gate.** The server heard
 * speech; that outranks an amplitude heuristic.
 *
 * Distinct from `NO_SPEECH_TIMEOUT_MS` in `src/main/stt/client.ts`. That
 * watchdog ends a *long* recording that produced no transcript (muted mic,
 * denied permission, ten seconds of nothing). This gate is about a short
 * accidental tap. Merging them would either eat real one-word dictations or
 * wait ten seconds on a brushed key.
 *
 * Idea from FluidVoice's end-of-utterance silence check; reimplemented as a
 * pure function against this codebase's PCM16 buffers. No source copied.
 */

import { BYTES_PER_SAMPLE, CHUNK_BYTES, SAMPLE_RATE_HZ } from './constants.js';

/**
 * How short an utterance has to be before we even look at amplitude.
 *
 * **Chosen, not measured on this laptop's microphone.** A brushed Fn is
 * typically 100–400 ms of room tone; a spoken "yes" is typically 200–500 ms
 * of speech. 900 ms is long enough that a real one-word dictation is
 * assessed on amplitude (and kept), and short enough that a held-too-long
 * accidental tap still qualifies for the look. A value below ~400 ms would
 * skip the look on "yes" only because it was short, which is the failure
 * this function exists to avoid.
 */
export const SILENCE_GATE_MAX_DURATION_MS = 900;

/**
 * Peak (normalized 0..1) above which the buffer contains something that
 * could be speech.
 *
 * **Chosen, not measured.** `SILENT_PEAK` in `machine.ts` is 0.002 RMS and
 * separates digital silence from room tone for the no-speech copy. This
 * number has to sit *above* room tone and *below* a close-mic "yes".
 * Digital silence is 0. A quiet room on a laptop mic with Chromium's noise
 * suppression is typically well under 0.01 peak. Speech is not. 0.03
 * (−30 dBFS) is conservative: we would rather transcribe room tone than
 * eat "OK".
 */
export const SILENCE_GATE_PEAK = 0.03;

/**
 * RMS (normalized 0..1) above which the buffer contains something that
 * could be speech. Same bias as the peak, for utterances whose energy is
 * spread rather than peaked.
 *
 * **Chosen, not measured.** 0.008 (−42 dBFS) is above the 0.002 floor the
 * machine already uses for "the microphone sent no sound" and below any
 * real close-mic syllable we have a reason to expect.
 */
export const SILENCE_GATE_RMS = 0.008;

export interface SilenceGateInput {
  /** PCM16 little-endian mono @ 16 kHz. */
  readonly pcm: Uint8Array | null;
  /** Wall duration of the hold, milliseconds. */
  readonly durationMs: number;
  /** True when any interim or committed transcript already has text. */
  readonly hasTranscriptText: boolean;
  /** The setting. Off means never drop. */
  readonly enabled: boolean;
}

export type SilenceGateReason =
  'disabled' | 'too_long' | 'has_transcript' | 'no_audio' | 'speech' | 'silent';

export interface SilenceGateDecision {
  readonly gated: boolean;
  readonly reason: SilenceGateReason;
  readonly durationMs: number;
  readonly peak: number;
  readonly rms: number;
}

/**
 * Decide whether this utterance should be dropped at release.
 *
 * Pure. The fixtures in `silence-gate.test.ts` are real PCM16 buffers —
 * zeros, low-amplitude noise, a short tone burst — not a mock of this
 * function.
 */
export function assessSilenceGate(input: SilenceGateInput): SilenceGateDecision {
  const durationMs = Math.max(0, input.durationMs);
  const { peak, rms } = input.pcm === null ? { peak: 0, rms: 0 } : pcmPeakRms(input.pcm);

  if (!input.enabled) {
    return { gated: false, reason: 'disabled', durationMs, peak, rms };
  }
  if (input.hasTranscriptText) {
    return { gated: false, reason: 'has_transcript', durationMs, peak, rms };
  }
  if (durationMs > SILENCE_GATE_MAX_DURATION_MS) {
    return { gated: false, reason: 'too_long', durationMs, peak, rms };
  }
  if (input.pcm === null || input.pcm.byteLength < CHUNK_BYTES) {
    // Cannot measure. A hold shorter than one capture chunk (100 ms) has
    // not produced a full buffer yet — that is "too soon", not "silent".
    // Bias to transcribe.
    return { gated: false, reason: 'no_audio', durationMs, peak, rms };
  }
  if (peak >= SILENCE_GATE_PEAK || rms >= SILENCE_GATE_RMS) {
    return { gated: false, reason: 'speech', durationMs, peak, rms };
  }
  return { gated: true, reason: 'silent', durationMs, peak, rms };
}

/** Duration of a PCM16 mono 16 kHz buffer, in milliseconds. */
export function pcmDurationMs(pcm: Uint8Array): number {
  const samples = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  return (samples / SAMPLE_RATE_HZ) * 1000;
}

export function pcmPeakRms(pcm: Uint8Array): { peak: number; rms: number } {
  const samples = Math.floor(pcm.byteLength / BYTES_PER_SAMPLE);
  if (samples === 0) return { peak: 0, rms: 0 };
  const view = new DataView(pcm.buffer, pcm.byteOffset, samples * BYTES_PER_SAMPLE);
  let peak = 0;
  let sumSq = 0;
  for (let i = 0; i < samples; i++) {
    const raw = view.getInt16(i * 2, true);
    const normalized = raw < 0 ? raw / 0x8000 : raw / 0x7fff;
    const abs = normalized < 0 ? -normalized : normalized;
    if (abs > peak) peak = abs;
    sumSq += normalized * normalized;
  }
  return { peak, rms: Math.sqrt(sumSq / samples) };
}
