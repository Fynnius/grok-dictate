import { describe, expect, it } from 'vitest';
import { BYTES_PER_SAMPLE, SAMPLE_RATE_HZ } from './constants.js';
import {
  SILENCE_GATE_MAX_DURATION_MS,
  SILENCE_GATE_PEAK,
  assessSilenceGate,
  pcmDurationMs,
  pcmPeakRms,
} from './silence-gate.js';

function pcm16(samples: Float32Array): Uint8Array {
  const out = new Uint8Array(samples.length * BYTES_PER_SAMPLE);
  const view = new DataView(out.buffer);
  for (let i = 0; i < samples.length; i++) {
    const clamped = samples[i]! < -1 ? -1 : samples[i]! > 1 ? 1 : samples[i]!;
    const value = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    view.setInt16(i * 2, value, true);
  }
  return out;
}

function silence(ms: number): Uint8Array {
  return pcm16(new Float32Array(Math.round((SAMPLE_RATE_HZ * ms) / 1000)));
}

function noise(ms: number, amplitude: number): Uint8Array {
  const samples = new Float32Array(Math.round((SAMPLE_RATE_HZ * ms) / 1000));
  for (let i = 0; i < samples.length; i++) {
    samples[i] = (((i * 17) % 10) / 10) * amplitude - amplitude / 2;
  }
  return pcm16(samples);
}

function tone(ms: number, hz: number, amplitude: number): Uint8Array {
  const n = Math.round((SAMPLE_RATE_HZ * ms) / 1000);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    samples[i] = Math.sin((2 * Math.PI * hz * i) / SAMPLE_RATE_HZ) * amplitude;
  }
  return pcm16(samples);
}

describe('assessSilenceGate', () => {
  it('drops digital silence that is short', () => {
    const pcm = silence(300);
    const decision = assessSilenceGate({
      pcm,
      durationMs: pcmDurationMs(pcm),
      hasTranscriptText: false,
      enabled: true,
    });
    expect(decision.gated).toBe(true);
    expect(decision.reason).toBe('silent');
    expect(decision.peak).toBe(0);
    expect(decision.rms).toBe(0);
  });

  it('drops room-tone-like low amplitude that is short', () => {
    const pcm = noise(250, 0.004);
    const { peak, rms } = pcmPeakRms(pcm);
    expect(peak).toBeLessThan(SILENCE_GATE_PEAK);
    const decision = assessSilenceGate({
      pcm,
      durationMs: 250,
      hasTranscriptText: false,
      enabled: true,
    });
    expect(decision.gated).toBe(true);
    expect(decision.reason).toBe('silent');
    expect(decision.rms).toBeCloseTo(rms, 5);
  });

  it('does not drop a short speech-like tone burst ("yes")', () => {
    // A close-mic syllable: 300 ms of 200 Hz at 0.2 amplitude. "Yes"/"no"/"OK"
    // live here; duration alone would eat them, which is why duration is only
    // a precondition.
    const pcm = tone(300, 200, 0.2);
    const decision = assessSilenceGate({
      pcm,
      durationMs: 300,
      hasTranscriptText: false,
      enabled: true,
    });
    expect(decision.gated).toBe(false);
    expect(decision.reason).toBe('speech');
    expect(decision.peak).toBeGreaterThan(SILENCE_GATE_PEAK);
  });

  it('never gates when any partial with text already arrived', () => {
    const decision = assessSilenceGate({
      pcm: silence(200),
      durationMs: 200,
      hasTranscriptText: true,
      enabled: true,
    });
    expect(decision.gated).toBe(false);
    expect(decision.reason).toBe('has_transcript');
  });

  it('does not gate when the setting is off', () => {
    const decision = assessSilenceGate({
      pcm: silence(200),
      durationMs: 200,
      hasTranscriptText: false,
      enabled: false,
    });
    expect(decision.gated).toBe(false);
    expect(decision.reason).toBe('disabled');
  });

  it('does not treat duration alone as a gate — a long silent hold is not dropped here', () => {
    // That is the no-speech watchdog's job, on a different timescale.
    const decision = assessSilenceGate({
      pcm: silence(SILENCE_GATE_MAX_DURATION_MS + 50),
      durationMs: SILENCE_GATE_MAX_DURATION_MS + 50,
      hasTranscriptText: false,
      enabled: true,
    });
    expect(decision.gated).toBe(false);
    expect(decision.reason).toBe('too_long');
  });

  it('does not gate when there is no buffer to measure — bias to transcribe', () => {
    expect(
      assessSilenceGate({
        pcm: null,
        durationMs: 80,
        hasTranscriptText: false,
        enabled: true,
      }),
    ).toMatchObject({ gated: false, reason: 'no_audio' });
  });

  it('does not gate a hold shorter than one capture chunk — too soon to measure', () => {
    expect(
      assessSilenceGate({
        pcm: new Uint8Array(0),
        durationMs: 80,
        hasTranscriptText: false,
        enabled: true,
      }),
    ).toMatchObject({ gated: false, reason: 'no_audio' });
  });
});
