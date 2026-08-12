/**
 * The bars, as maths. The complaint these tests encode is "I speak normally and
 * they don't move properly" (§19.1) — so what is asserted is not a pixel
 * value but *movement*: that ordinary speech uses most of the travel, that the
 * row does not move as one, and that silence is still flat.
 */

import { describe, expect, it } from 'vitest';
import {
  BAR_COUNT,
  BAR_MAX,
  BAR_MIN,
  barScale,
  DELAY_MS,
  ENVELOPE,
  follow,
  LevelHistory,
  loudness,
  STEP_MS,
} from './waveform.js';

/** Typical RMS values, as `rmsOf` reports them from a laptop microphone. */
const SILENCE = 0;
const ROOM_TONE = 0.001;
const QUIET_SPEECH = 0.02;
const NORMAL_SPEECH = 0.05;
const LOUD_SPEECH = 0.15;

describe('loudness', () => {
  it('puts normal speech in the top half of the travel', () => {
    // The bug being fixed: the old mapping was `min(1, rms × 3)`, which put
    // this exact value at 0.15 — the bars never left the floor.
    expect(loudness(NORMAL_SPEECH)).toBeGreaterThan(0.6);
    expect(loudness(NORMAL_SPEECH)).toBeLessThan(0.9);
  });

  it('still separates quiet speech, loud speech and silence', () => {
    expect(loudness(SILENCE)).toBe(0);
    expect(loudness(ROOM_TONE)).toBeLessThan(0.15);
    expect(loudness(QUIET_SPEECH)).toBeGreaterThan(loudness(ROOM_TONE) + 0.25);
    expect(loudness(LOUD_SPEECH)).toBeGreaterThan(loudness(NORMAL_SPEECH) + 0.1);
    expect(loudness(LOUD_SPEECH)).toBeLessThanOrEqual(1);
  });

  it('is monotonic and clamped, whatever the device reports', () => {
    expect(loudness(-1)).toBe(0);
    expect(loudness(Number.NaN)).toBe(0);
    expect(loudness(4)).toBe(1);
    let previous = -1;
    for (let rms = 0; rms <= 1; rms += 0.01) {
      const value = loudness(rms);
      expect(value).toBeGreaterThanOrEqual(previous);
      previous = value;
    }
  });
});

describe('follow', () => {
  it('rises faster than it falls — the asymmetry is the point', () => {
    const up = follow(0, 1, 50);
    const down = 1 - follow(1, 0, 50);
    expect(up).toBeGreaterThan(down);
  });

  it('reaches most of a jump within one 100 ms level packet', () => {
    // If it did not, the bars would still be climbing when the next packet
    // arrives, which is exactly what "stiff" looks like.
    expect(follow(0, 1, 100)).toBeGreaterThan(0.85);
  });

  it('carries a level across the gaps inside a word', () => {
    // 100 ms of silence between two syllables must not collapse the row.
    expect(follow(1, 0, 100)).toBeGreaterThan(0.5);
  });

  it('does not depend on the frame rate', () => {
    // One 32 ms frame and two 16 ms frames must land in the same place, or the
    // bars would move differently on a busy machine.
    const one = follow(0, 1, 32);
    const two = follow(follow(0, 1, 16), 1, 16);
    expect(one).toBeCloseTo(two, 6);
  });
});

describe('LevelHistory', () => {
  const settle = (history: LevelHistory, target: number, ms: number): void => {
    for (let t = 0; t < ms; t += 16) history.advance(16, target);
  };

  it('delays the outer bars behind the centre, so a syllable ripples outward', () => {
    const history = new LevelHistory();
    settle(history, 0, 400); // start from silence
    settle(history, 1, 40); // …then a sudden syllable

    const centre = history.at(DELAY_MS[Math.floor(BAR_COUNT / 2)] ?? 0);
    const edge = history.at(DELAY_MS[0] ?? 0);
    expect(centre).toBeGreaterThan(edge);
  });

  it('lets the whole row catch up once the level holds', () => {
    const history = new LevelHistory();
    settle(history, 1, 600);
    for (const delay of DELAY_MS) expect(history.at(delay)).toBeGreaterThan(0.9);
  });

  it('returns to the floor after speech stops', () => {
    const history = new LevelHistory();
    settle(history, 1, 300);
    settle(history, 0, 1_500);
    for (const delay of DELAY_MS) expect(history.at(delay)).toBeLessThan(0.01);
  });

  it('survives a stalled frame without racing ahead', () => {
    // A window that was occluded can hand back a multi-second `dt`; the clamp
    // stops that from being replayed as hundreds of steps.
    const history = new LevelHistory();
    expect(() => {
      history.advance(30_000, 1);
    }).not.toThrow();
    expect(history.at(0)).toBeLessThanOrEqual(1);
  });

  it('advances by whole steps only, so the ripple keeps its wall-clock speed', () => {
    const history = new LevelHistory();
    history.advance(STEP_MS / 2, 1);
    expect(history.at(0)).toBe(0); // half a step is not yet a step
    history.advance(STEP_MS / 2, 1);
    expect(history.at(0)).toBeGreaterThan(0);
  });
});

describe('barScale', () => {
  it('draws every bar as a dash at silence, and holds them still', () => {
    for (let i = 0; i < BAR_COUNT; i++) {
      const floor = BAR_MIN / BAR_MAX;
      expect(barScale(i, 0, 0)).toBeCloseTo(floor, 6);
      // The shimmer is scaled by the level, so a silent row cannot wobble —
      // the pill must not draw the eye while the user is working elsewhere.
      expect(barScale(i, 0, 3.7)).toBeCloseTo(floor, 6);
    }
  });

  it('keeps the reference bell: the centre pair tall, the ends dashes', () => {
    const heights = ENVELOPE.map((_, i) => barScale(i, 1, 0));
    const centre = heights[BAR_COUNT / 2] ?? 0;
    expect(centre).toBeGreaterThan(heights[0] ?? 0);
    expect(heights[0] ?? 0).toBeLessThan(0.5);
    // Not 1.0: at full level the shimmer is still working, and it can be at
    // the bottom of its swing on the frame this samples.
    expect(centre).toBeGreaterThan(0.85);
  });

  it('never exceeds the bar it is scaling', () => {
    for (let i = 0; i < BAR_COUNT; i++) {
      for (let t = 0; t < 2; t += 0.05) expect(barScale(i, 1, t)).toBeLessThanOrEqual(1);
    }
  });

  it('does not move all ten bars in lockstep on a held vowel', () => {
    // The old renderer multiplied one number by a fixed envelope, so the row
    // could only ever pulse as a single shape. Two bars, one moment apart,
    // must differ.
    const spread = (t: number): number => {
      const values = ENVELOPE.map((_, i) => barScale(i, 0.8, t) / (ENVELOPE[i] ?? 1));
      return Math.max(...values) - Math.min(...values);
    };
    expect(spread(1.0)).toBeGreaterThan(0.01);
  });
});
