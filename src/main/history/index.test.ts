import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HistoryEntry } from '@contracts/events.js';
import { addLogSink, clearLogSinks, createLogger, type LogRecord } from '@shared/logger.js';
import { parseWav } from '@shared/wav.js';
import {
  AUDIO_RETENTION_MS,
  createHistoryStore,
  historyJournalPath,
  historyPath,
  recordingsDir,
} from './index.js';

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

  describe('fields added after the first release', () => {
    /**
     * `isHistoryEntry` is a filter, not a validator: a row it rejects is
     * dropped without asking. A field added as *required* would therefore
     * delete every row the user had ever written on the first launch after the
     * update — the exact opposite of what the recovery surface is for.
     */
    it('loads rows written before `verified` and `unconfirmedTail` existed', async () => {
      const old = {
        id: 'pre-incident',
        at: new Date('2026-08-01T09:00:00.000Z').toISOString(),
        text: 'written by v0.1.0, with no verification field anywhere',
        durationSec: 3.5,
        language: 'en',
        frontmostBundleId: 'com.apple.Notes',
        frontmostName: 'Notes',
        tier: 'unicode',
        inserted: true,
      };
      writeFileSync(historyPath(dir), JSON.stringify([old]), 'utf8');

      const store = createHistoryStore(dir, log);
      expect(await store.count()).toBe(1);
      const [row] = await store.list(null, 1);
      expect(row?.id).toBe('pre-incident');
      expect(row?.verified).toBeUndefined();
      // …and nothing was reported as malformed, which is what would have
      // preceded the rows being thrown away.
      expect(records.some((r) => r.msg.includes('malformed'))).toBe(false);
    });

    it('round-trips the new fields and still rejects a wrong type', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'a', verified: null }));
      await store.append(entry({ id: 'b', verified: false, unconfirmedTail: true }));
      const reloaded = await createHistoryStore(dir, log).list(null, 10);
      expect(reloaded.map((e) => [e.id, e.verified, e.unconfirmedTail])).toEqual([
        ['b', false, true],
        ['a', null, undefined],
      ]);

      writeFileSync(
        historyPath(dir),
        JSON.stringify([entry({ id: 'good' }), { ...entry({ id: 'bad' }), verified: 'yes' }]),
        'utf8',
      );
      expect((await createHistoryStore(dir, log).list(null, 10)).map((e) => e.id)).toEqual([
        'good',
      ]);
    });

    it('loads rows written before audioRelPath, cancelled and transcribeError existed', async () => {
      const old = {
        id: 'pre-audio',
        at: new Date('2026-08-01T09:00:00.000Z').toISOString(),
        text: 'no sidecar fields',
        durationSec: 1,
        language: 'en',
        frontmostBundleId: null,
        frontmostName: null,
        tier: 'ax',
        inserted: true,
      };
      writeFileSync(historyPath(dir), JSON.stringify([old]), 'utf8');
      const store = createHistoryStore(dir, log);
      expect(await store.count()).toBe(1);
      const [row] = await store.list(null, 1);
      expect(row?.audioRelPath).toBeUndefined();
      expect(row?.cancelled).toBeUndefined();
      expect(row?.transcribeError).toBeUndefined();
      expect(records.some((r) => r.msg.includes('malformed'))).toBe(false);
    });

    it('keeps a row whose optional sidecar fields were written as null', async () => {
      writeFileSync(
        historyPath(dir),
        JSON.stringify([
          {
            id: 'null-sidecars',
            at: new Date('2026-08-01T09:00:00.000Z').toISOString(),
            text: 'still a transcript',
            durationSec: 1,
            language: 'en',
            frontmostBundleId: null,
            frontmostName: null,
            tier: 'ax',
            inserted: true,
            audioRelPath: null,
            cancelled: null,
            transcribeError: null,
          },
        ]),
        'utf8',
      );
      const store = createHistoryStore(dir, log);
      expect(await store.count()).toBe(1);
      expect((await store.list(null, 1))[0]?.text).toBe('still a transcript');
    });

    it('round-trips audioRelPath, cancelled and transcribeError, and drops a wrong type', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(
        entry({
          id: 'c',
          cancelled: true,
          audioRelPath: 'recordings/c.wav',
          transcribeError: 'the socket died',
        }),
      );
      const [row] = await createHistoryStore(dir, log).list(null, 1);
      expect(row).toMatchObject({
        id: 'c',
        cancelled: true,
        audioRelPath: 'recordings/c.wav',
        transcribeError: 'the socket died',
      });

      writeFileSync(
        historyPath(dir),
        JSON.stringify([entry({ id: 'good' }), { ...entry({ id: 'bad' }), audioRelPath: 1 }]),
        'utf8',
      );
      expect((await createHistoryStore(dir, log).list(null, 10)).map((e) => e.id)).toEqual([
        'good',
      ]);
    });
  });

  describe('audio sidecars', () => {
    const pcm = new Uint8Array(3200).fill(7);

    it('writes a 16 kHz wav and reads it back', () => {
      const store = createHistoryStore(dir, log);
      const rel = store.archiveAudio('take-1', pcm);
      expect(rel).toBe('recordings/take-1.wav');
      const bytes = store.readAudio(rel ?? '');
      expect(bytes).not.toBeNull();
      const parsed = parseWav(bytes ?? Buffer.alloc(0));
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;
      expect(parsed.value.pcm.length).toBe(3200);
    });

    it('refuses an empty buffer and an unsafe id', () => {
      const store = createHistoryStore(dir, log);
      expect(store.archiveAudio('take-1', new Uint8Array(0))).toBeNull();
      expect(store.archiveAudio('../escape', pcm)).toBeNull();
      expect(store.readAudio('/tmp/nope.wav')).toBeNull();
    });

    it('deletes files older than one day and clears audioRelPath, keeping the row', async () => {
      const now = Date.parse('2026-09-12T12:00:00.000Z');
      const store = createHistoryStore(dir, log);
      const rel = store.archiveAudio('old', pcm);
      expect(rel).toBe('recordings/old.wav');
      await store.append(
        entry({
          id: 'old',
          at: new Date(now - AUDIO_RETENTION_MS - 1000).toISOString(),
          audioRelPath: 'recordings/old.wav',
        }),
      );
      expect(store.archiveAudio('fresh', pcm)).toBe('recordings/fresh.wav');
      await store.append(
        entry({
          id: 'fresh',
          at: new Date(now).toISOString(),
          audioRelPath: 'recordings/fresh.wav',
        }),
      );

      expect(await store.sweepAudio(now)).toBe(1);
      const rows = await store.list(null, 10);
      expect(rows.find((r) => r.id === 'old')?.audioRelPath).toBeUndefined();
      expect(rows.find((r) => r.id === 'old')?.text).toBeTruthy();
      expect(rows.find((r) => r.id === 'fresh')?.audioRelPath).toBe('recordings/fresh.wav');
      expect(existsSync(join(recordingsDir(dir), 'old.wav'))).toBe(false);
      expect(existsSync(join(recordingsDir(dir), 'fresh.wav'))).toBe(true);
    });

    it('clears audioRelPath when the file is already gone', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'ghost', audioRelPath: 'recordings/ghost.wav' }));
      expect(await store.sweepAudio()).toBe(0);
      expect((await store.get('ghost'))?.audioRelPath).toBeUndefined();
    });

    it('deletes expired orphan wavs that no row points at', async () => {
      const store = createHistoryStore(dir, log);
      const rel = store.archiveAudio('orphan', pcm);
      expect(rel).not.toBeNull();
      const abs = join(recordingsDir(dir), 'orphan.wav');
      const old = new Date(Date.now() - AUDIO_RETENTION_MS - 1000);
      utimesSync(abs, old, old);
      expect(await store.sweepAudio()).toBe(1);
      expect(existsSync(abs)).toBe(false);
    });

    it('removes recordings on purge', async () => {
      const store = createHistoryStore(dir, log);
      store.archiveAudio('x', pcm);
      await store.append(entry({ id: 'x', audioRelPath: 'recordings/x.wav' }));
      await store.purge();
      expect(existsSync(recordingsDir(dir))).toBe(false);
    });

    it('updates a row and can clear optional fields', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(
        entry({
          id: 'u',
          cancelled: true,
          transcribeError: 'nope',
          audioRelPath: 'recordings/u.wav',
        }),
      );
      const next = await store.update('u', {
        text: 'hello',
        cancelled: null,
        transcribeError: null,
        audioRelPath: null,
      });
      expect(next).toMatchObject({ id: 'u', text: 'hello' });
      expect(next?.cancelled).toBeUndefined();
      expect(next?.transcribeError).toBeUndefined();
      expect(next?.audioRelPath).toBeUndefined();
    });
  });

  it('writes atomically, leaving no temp file behind', async () => {
    const store = createHistoryStore(dir, log);
    await store.append(entry());
    expect(readdirSync(dir)).toEqual(['history.json']);
  });

  /* ---------------------------------------------------------------- *
   * BUG-7 — appending without rewriting the whole file
   * ---------------------------------------------------------------- */

  describe('the append journal', () => {
    const journal = (): string => historyJournalPath(dir);
    const array = (): unknown => JSON.parse(readFileSync(historyPath(dir), 'utf8'));

    it('does not rewrite the array file for every append', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'a' })); // creates history.json
      const afterFirst = readFileSync(store.path, 'utf8');

      await store.append(entry({ id: 'b' }));
      await store.append(entry({ id: 'c' }));

      // The expensive file is untouched…
      expect(readFileSync(store.path, 'utf8')).toBe(afterFirst);
      // …and the new rows are one line each in the journal.
      expect(readFileSync(journal(), 'utf8').trim().split('\n')).toHaveLength(2);
    });

    it('keeps the array file valid JSON at rest throughout', async () => {
      const store = createHistoryStore(dir, log);
      for (let n = 0; n < 12; n += 1) {
        await store.append(entry({ id: `e${String(n)}` }));
        expect(() => array()).not.toThrow();
        expect(Array.isArray(array())).toBe(true);
      }
    });

    it('gives readers the journal rows as well as the array', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'a', text: 'first' }));
      await store.append(entry({ id: 'b', text: 'second' }));

      expect(await store.count()).toBe(2);
      // …including a store built fresh from the two files, which is what the
      // next launch does.
      const reopened = createHistoryStore(dir, log);
      expect((await reopened.list(null, 10)).map((e) => e.text)).toEqual(['second', 'first']);
    });

    it('folds the journal back into the array file at startup', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'a' }));
      await store.append(entry({ id: 'b' }));
      expect(existsSync(journal())).toBe(true);

      createHistoryStore(dir, log);
      expect(existsSync(journal())).toBe(false);
      expect(array()).toHaveLength(2);
    });

    it('drops a torn final line and keeps every complete row before it', async () => {
      // What a power cut costs: the one dictation that was being written.
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'a' }));
      await store.append(entry({ id: 'b', text: 'complete' }));
      appendFileSync(journal(), '{"id":"c","at":"2026-08-08T12:00', 'utf8');

      const reopened = createHistoryStore(dir, log);
      expect((await reopened.list(null, 10)).map((e) => e.id)).toEqual(['b', 'a']);
      expect(records.some((r) => r.msg.includes('unreadable rows from the history journal'))).toBe(
        true,
      );
    });

    it('does not double a row when a journal outlives its compaction', async () => {
      // A crash between the atomic rewrite and the journal being removed. The
      // rows are in both files; `id` is what stops them appearing twice.
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'a' }));
      await store.append(entry({ id: 'b' }));
      const stale = readFileSync(journal(), 'utf8');

      createHistoryStore(dir, log); // compacts and removes the journal
      writeFileSync(journal(), stale, 'utf8'); // …but it came back

      const reopened = createHistoryStore(dir, log);
      expect((await reopened.list(null, 10)).map((e) => e.id)).toEqual(['b', 'a']);
    });

    it('rewrites the array file on purge and on a sweep, and clears the journal', async () => {
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'a' }));
      await store.append(entry({ id: 'b' }));
      await store.purge();

      expect(array()).toEqual([]);
      expect(existsSync(journal())).toBe(false);
      expect(await createHistoryStore(dir, log).count()).toBe(0);
    });

    it('survives a journal that is not there when it is expected to be', async () => {
      // Somebody deleted it, or a sync tool did. The array file is the truth
      // for everything older, so only the un-compacted rows are at risk.
      const store = createHistoryStore(dir, log);
      await store.append(entry({ id: 'a' }));
      await store.append(entry({ id: 'b' }));
      rmSync(journal());

      const reopened = createHistoryStore(dir, log);
      expect((await reopened.list(null, 10)).map((e) => e.id)).toEqual(['a']);
    });
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
