import { describe, expect, it } from 'vitest';
import { CUE_BUDGET_MS, CUE_SPECS, cueSpec } from './cues.js';

const CUES = ['start', 'stop', 'error'] as const;

describe('CUE_SPECS', () => {
  it('keeps the two cues in the dictation path inside the §11.1.4 budget', () => {
    // "Under ~80 ms" — these fire on every single dictation, at both ends.
    expect(cueSpec('start').durationMs).toBeLessThanOrEqual(CUE_BUDGET_MS);
    expect(cueSpec('stop').durationMs).toBeLessThanOrEqual(CUE_BUDGET_MS);
  });

  it('lets the error cue run longer, since nothing waits on it', () => {
    expect(cueSpec('error').durationMs).toBeGreaterThan(cueSpec('stop').durationMs);
  });

  it('makes start rise and stop fall, so they are told apart without looking', () => {
    // Dictation is eyes-free; a start and a stop that sound alike would defeat
    // the entire point of the cue.
    expect(cueSpec('start').toHz).toBeGreaterThan(cueSpec('start').fromHz);
    expect(cueSpec('stop').toHz).toBeLessThan(cueSpec('stop').fromHz);
  });

  it('puts the error cue in a clearly lower register than stop', () => {
    // A failed insertion plays stop and then error within a second.
    expect(cueSpec('error').fromHz).toBeLessThan(cueSpec('stop').toHz);
  });

  it('stays quiet enough to sit under whatever else is playing', () => {
    for (const cue of CUES) {
      expect(cueSpec(cue).gain).toBeGreaterThan(0);
      expect(cueSpec(cue).gain).toBeLessThanOrEqual(0.25);
    }
  });

  it('has a spec for every cue in the frozen port', () => {
    for (const cue of CUES) expect(CUE_SPECS[cue]).toBeDefined();
  });

  it('uses audible frequencies only', () => {
    for (const cue of CUES) {
      for (const hz of [cueSpec(cue).fromHz, cueSpec(cue).toHz]) {
        expect(hz).toBeGreaterThan(100);
        expect(hz).toBeLessThan(8_000);
      }
    }
  });
});
