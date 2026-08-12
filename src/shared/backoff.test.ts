import { describe, expect, it } from 'vitest';
import { Backoff, backoffDelayMs } from './backoff.js';

describe('backoffDelayMs', () => {
  const opts = { baseMs: 100, maxMs: 5000, random: () => 1 };

  it('grows exponentially from the base', () => {
    expect([0, 1, 2, 3].map((n) => backoffDelayMs(n, opts))).toEqual([100, 200, 400, 800]);
  });

  it('is capped', () => {
    expect(backoffDelayMs(20, opts)).toBe(5000);
  });

  it('applies full jitter, so a retry can fire early', () => {
    expect(backoffDelayMs(3, { ...opts, random: () => 0 })).toBe(0);
    expect(backoffDelayMs(3, { ...opts, random: () => 0.5 })).toBe(400);
  });

  it('never exceeds the cap for any random draw', () => {
    for (let attempt = 0; attempt < 40; attempt++) {
      for (const r of [0, 0.25, 0.5, 0.99, 1]) {
        const delay = backoffDelayMs(attempt, { ...opts, random: () => r });
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(5000);
      }
    }
  });
});

describe('Backoff', () => {
  it('advances and resets', () => {
    const b = new Backoff({ baseMs: 10, maxMs: 1000, random: () => 1 });
    expect([b.next(), b.next(), b.next()]).toEqual([10, 20, 40]);
    b.reset();
    expect(b.next()).toBe(10);
    expect(b.attempts).toBe(1);
  });
});
