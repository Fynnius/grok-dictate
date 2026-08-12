import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@contracts/events.js';
import { addLogSink, clearLogSinks, createLogger, type LogRecord } from '@shared/logger.js';
import { createHistoryStore, historyPath } from './index.js';

const log = createLogger('test');

let dir: string;
let records: LogRecord[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grok-dictate-history-'));
  records = [];
  clearLogSinks();
  addLogSink((_line, record) => records.push(record));
});

afterEach(() => {
  clearLogSinks();
  rmSync(dir, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

function entry(overrides: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: `id-${String(Math.random()).slice(2)}`,
    at: new Date('2026-08-08T12:00:00.000Z').toISOString(),
    text: 'Deployed that on the staging server',
    durationSec: 4.2,
    language: 'de',
    frontmostBundleId: 'com.microsoft.VSCode',
    frontmostName: 'Code',
    tier: 'ax',
    inserted: true,
    ...overrides,
  };
}

describe('createHistoryStore', () => {
  it('appends and survives a restart', async () => {
    const first = createHistoryStore(dir, log);
    await first.append(entry({ id: 'a', text: 'first' }));
    await first.append(entry({ id: 'b', text: 'second' }));
    const second = createHistoryStore(dir, log);
    expect(await second.count()).toBe(2);
    // Newest first.
    expect((await second.list(null, 10)).map((e) => e.text)).toEqual(['second', 'first']);
  });

  it('searches the transcript and the target app, case-insensitively', async () => {
    const store = createHistoryStore(dir, log);
    await store.append(entry({ id: 'a', text: 'deploy the pod', frontmostName: 'Slack' }));
    await store.append(entry({ id: 'b', text: 'hello there', frontmostName: 'Code' }));

    expect((await store.list('POD', 10)).map((e) => e.id)).toEqual(['a']);
    expect((await store.list('slack', 10)).map((e) => e.id)).toEqual(['a']);
    expect(await store.list('  ', 10)).toHaveLength(2); // blank query = everything
    expect(await store.list('nothing here', 10)).toHaveLength(0);
  });

  it('honours the limit and never returns a negative slice', async () => {
    const store = createHistoryStore(dir, log);
    for (let n = 0; n < 5; n += 1) await store.append(entry({ id: `e${String(n)}` }));
    expect(await store.list(null, 2)).toHaveLength(2);
    expect(await store.list(null, -1)).toHaveLength(0);
  });

  it('records a failed insertion, which is what makes history the recovery surface', async () => {
    const store = createHistoryStore(dir, log);
    await store.append(entry({ tier: 'none', inserted: false, text: 'never landed' }));
    const [row] = await store.list(null, 1);
    expect(row?.inserted).toBe(false);
    expect(row?.tier).toBe('none');
    expect(row?.text).toBe('never landed');
  });

  it('purges everything', async () => {
    const store = createHistoryStore(dir, log);
    await store.append(entry());
    await store.purge();
    expect(await store.count()).toBe(0);
    expect(await createHistoryStore(dir, log).count()).toBe(0);
  });

  describe('retention sweep', () => {
    const now = Date.parse('2026-08-08T12:00:00.000Z');

    it('drops rows older than the retention window', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'old', at: new Date(now - 100 * DAY).toISOString() }));
      await store.append(entry({ id: 'fresh', at: new Date(now - 2 * DAY).toISOString() }));

      expect(await store.sweep(90, now)).toBe(1);
      expect((await store.list(null, 10)).map((e) => e.id)).toEqual(['fresh']);
    });

    it('keeps everything when retention is 0', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ at: new Date(now - 5000 * DAY).toISOString() }));
      expect(await store.sweep(0, now)).toBe(0);
      expect(await store.count()).toBe(1);
    });

    it('keeps a row whose timestamp cannot be parsed', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'weird', at: 'not a date' }));
      expect(await store.sweep(1, now)).toBe(0);
      expect(await store.count()).toBe(1);
    });

    it('does not rewrite the file when nothing expires', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ at: new Date(now).toISOString() }));
      const before = readFileSync(store.path, 'utf8');
      expect(await store.sweep(90, now)).toBe(0);
      expect(readFileSync(store.path, 'utf8')).toBe(before);
    });
  });

  describe('damaged files', () => {
    it('quarantines an unparseable file instead of overwriting it', async () => {
      writeFileSync(historyPath(dir), '[{"id":"a", trunc', 'utf8');
      const store = createHistoryStore(dir, log);

      expect(await store.count()).toBe(0);
      expect(existsSync(join(dir, 'history.corrupt.json'))).toBe(true);
      // The original bytes are still there to be recovered by hand.
      expect(readFileSync(join(dir, 'history.corrupt.json'), 'utf8')).toContain('trunc');
      expect(records.some((r) => r.level === 'error')).toBe(true);

      await store.append(entry());
      expect(existsSync(join(dir, 'history.corrupt.json'))).toBe(true);
    });

    it('does not clobber an earlier quarantine', () => {
      writeFileSync(join(dir, 'history.corrupt.json'), 'first casualty', 'utf8');
      writeFileSync(historyPath(dir), 'broken again {', 'utf8');
      createHistoryStore(dir, log);

      expect(readFileSync(join(dir, 'history.corrupt.json'), 'utf8')).toBe('first casualty');
      expect(readFileSync(join(dir, 'history.corrupt.1.json'), 'utf8')).toBe('broken again {');
    });

    it('drops malformed rows but keeps the well-formed ones', async () => {
      writeFileSync(
        historyPath(dir),
        JSON.stringify([entry({ id: 'good' }), { id: 'bad' }, null, 'nope']),
        'utf8',
      );
      const store = createHistoryStore(dir, log);
      expect((await store.list(null, 10)).map((e) => e.id)).toEqual(['good']);
      expect(records.some((r) => r.level === 'warn')).toBe(true);
    });

    it('starts empty when the file holds something that is not an array', async () => {
      writeFileSync(historyPath(dir), '{"not":"an array"}', 'utf8');
      expect(await createHistoryStore(dir, log).count()).toBe(0);
    });
  });

  it('writes atomically, leaving no temp file behind', async () => {
    const store = createHistoryStore(dir, log);
    await store.append(entry());
    expect(readdirSync(dir)).toEqual(['history.json']);
  });

  it('notifies listeners with the new count on every mutation', async () => {
    const store = createHistoryStore(dir, log);
    const counts: number[] = [];
    const unsubscribe = store.onChange((n) => counts.push(n));

    await store.append(entry());
    await store.append(entry());
    await store.purge();
    unsubscribe();
    await store.append(entry());

    expect(counts).toEqual([1, 2, 0]);
  });
});
