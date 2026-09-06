import { describe, expect, it } from 'vitest';
import { CUE_BUDGET_MS, CUE_SPECS, cueSpec } from './cues.js';

const CUES = ['start', 'stop', 'error'] as const;

function firstHz(cue: (typeof CUES)[number]): number {
  return cueSpec(cue).notes[0]!.hz;
}

function lastHz(cue: (typeof CUES)[number]): number {
  const notes = cueSpec(cue).notes;
  return notes[notes.length - 1]!.hz;
}

function allHz(cue: (typeof CUES)[number]): number[] {
  return cueSpec(cue).notes.map((note) => note.hz);
}

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
    expect(lastHz('start')).toBeGreaterThan(firstHz('start'));
    expect(lastHz('stop')).toBeLessThan(firstHz('stop'));
  });

  it('pairs start and stop on the same fifth, inverted', () => {
    expect([...allHz('start')].sort()).toEqual([...allHz('stop')].sort());
  });

  it('puts the error cue in a clearly lower register than stop', () => {
    // A failed insertion plays stop and then error within a second.
    const stopFloor = Math.min(...allHz('stop'));
    for (const hz of allHz('error')) expect(hz).toBeLessThan(stopFloor);
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

  it('uses audible frequencies only, and keeps every tap inside the cue', () => {
    for (const cue of CUES) {
      const spec = cueSpec(cue);
      expect(spec.notes.length).toBeGreaterThanOrEqual(2);
      for (const note of spec.notes) {
        expect(note.hz).toBeGreaterThan(100);
        expect(note.hz).toBeLessThan(8_000);
        expect(note.atMs).toBeGreaterThanOrEqual(0);
        expect(note.atMs).toBeLessThan(spec.durationMs);
        expect(note.brightness).toBeGreaterThan(0);
        expect(note.brightness).toBeLessThanOrEqual(1);
      }
    }
  });

  it('uses glass for the dictation path and a duller material for error', () => {
    expect(cueSpec('start').material).toBe('glass');
    expect(cueSpec('stop').material).toBe('glass');
    expect(cueSpec('error').material).toBe('muted');
  });
});
