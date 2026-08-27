import { describe, expect, it } from 'vitest';
import {
  STATS_TYPING_WPM,
  aggregateStats,
  countWords,
  statsContainsTranscript,
  windowLabel,
  type StatsSourceRow,
} from './stats.js';

function entry(
  overrides: Partial<StatsSourceRow> & Pick<StatsSourceRow, 'at' | 'text'>,
): StatsSourceRow {
  return {
    durationSec: 2,
    language: 'en',
    frontmostBundleId: 'com.apple.Notes',
    frontmostName: 'Notes',
    inserted: true,
    ...overrides,
  };
}

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

describe('windowLabel', () => {
  it('names the configured window, never "lifetime"', () => {
    expect(windowLabel(90)).toBe('Last 90 days');
    expect(windowLabel(7)).toBe('Last 7 days');
    expect(windowLabel(0)).toBe('All history on disk');
    expect(windowLabel(90)).not.toMatch(/lifetime/i);
  });
});

describe('aggregateStats', () => {
  it('is empty for empty history — a first-class case, not a missing branch', () => {
    const stats = aggregateStats([], NOW, 90);
    expect(stats.empty).toBe(true);
    expect(stats.dictationCount).toBe(0);
    expect(stats.wordCount).toBe(0);
    expect(stats.durationSec).toBe(0);
    expect(stats.insertionRate).toBeNull();
    expect(stats.topApps).toEqual([]);
    expect(stats.languages).toEqual([]);
    expect(stats.windowLabel).toBe('Last 90 days');
  });

  it('counts words, time, dictations, apps, languages and insertion rate from the fixture', () => {
    const rows: StatsSourceRow[] = [
      entry({
        at: '2026-08-20T10:00:00.000Z',
        text: 'one two three',
        durationSec: 3,
        frontmostName: 'Notes',
        language: 'en',
        inserted: true,
      }),
      entry({
        at: '2026-08-21T10:00:00.000Z',
        text: 'vier fünf',
        durationSec: 2,
        frontmostName: 'Notes',
        language: 'de',
        inserted: true,
      }),
      entry({
        at: '2026-08-21T11:00:00.000Z',
        text: 'six',
        durationSec: 1,
        frontmostName: 'Code',
        frontmostBundleId: 'com.microsoft.VSCode',
        language: 'en',
        inserted: false,
      }),
    ];
    const stats = aggregateStats(rows, NOW, 90);
    expect(stats.empty).toBe(false);
    expect(stats.dictationCount).toBe(3);
    expect(stats.wordCount).toBe(3 + 2 + 1);
    expect(stats.durationSec).toBe(6);
    expect(stats.insertedCount).toBe(2);
    expect(stats.insertionRate).toBeCloseTo(2 / 3);
    expect(stats.topApps).toEqual([
      { name: 'Notes', count: 2 },
      { name: 'Code', count: 1 },
    ]);
    expect(stats.languages).toEqual([
      { code: 'en', count: 2 },
      { code: 'de', count: 1 },
    ]);
    expect(stats.timeSavedMinutes).toBe(Math.round((6 / STATS_TYPING_WPM) * 10) / 10);
    expect(stats.typingWpmAssumption).toBe(STATS_TYPING_WPM);
  });

  it('uses the configured window as the denominator, not all history', () => {
    const rows = [
      entry({ at: '2026-01-01T00:00:00.000Z', text: 'ancient words here' }),
      entry({ at: '2026-08-20T00:00:00.000Z', text: 'recent' }),
    ];
    const stats = aggregateStats(rows, NOW, 90);
    expect(stats.dictationCount).toBe(1);
    expect(stats.wordCount).toBe(1);
    expect(statsContainsTranscript(stats, 'ancient words here')).toBe(false);
  });

  it('zeros after a purge (empty input)', () => {
    const before = aggregateStats(
      [entry({ at: '2026-08-20T00:00:00.000Z', text: 'hello world' })],
      NOW,
      90,
    );
    expect(before.wordCount).toBe(2);
    const after = aggregateStats([], NOW, 90);
    expect(after).toMatchObject({
      dictationCount: 0,
      wordCount: 0,
      durationSec: 0,
      empty: true,
    });
  });

  it('never puts transcript text in the view-model', () => {
    const secret = 'Deployed that on the staging server with a unique nonce xyzzy-42';
    const stats = aggregateStats(
      [entry({ at: '2026-08-20T00:00:00.000Z', text: secret, frontmostName: 'Notes' })],
      NOW,
      90,
    );
    expect(statsContainsTranscript(stats, secret)).toBe(false);
    expect(JSON.stringify(stats)).not.toContain('xyzzy-42');
    expect(JSON.stringify(stats)).not.toContain('Deployed');
  });

  it('walks a large fixture in linear time without leaking text', () => {
    const rows: StatsSourceRow[] = [];
    for (let i = 0; i < 5_000; i++) {
      rows.push(
        entry({
          at: new Date(NOW - i * 60_000).toISOString(),
          text: `unique-transcript-row-${String(i)} extra words`,
          durationSec: 1,
        }),
      );
    }
    const started = Date.now();
    const stats = aggregateStats(rows, NOW, 90);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(stats.dictationCount).toBe(5_000);
    expect(stats.wordCount).toBe(5_000 * 3);
    expect(statsContainsTranscript(stats, 'unique-transcript-row-42')).toBe(false);
  });
});

describe('countWords', () => {
  it('splits on whitespace and ignores empty', () => {
    expect(countWords('')).toBe(0);
    expect(countWords('  ')).toBe(0);
    expect(countWords('one two  three')).toBe(3);
  });
});
