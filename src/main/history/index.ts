/**
 * OWNER: **Phase 4**.
 *
 * Flat JSON, as  prescribes — "move to SQLite only when the
 * file becomes annoying". One dictation per row: transcript, timestamp,
 * duration, detected language, frontmost app, insertion outcome.
 *
 * ## Two files, one store
 *
 * `history.json` is the array — always valid JSON at rest, always replaced
 * atomically. `history.pending.jsonl` is a journal of rows appended since it
 * was last written, one JSON object per line. `load` reads both and the journal
 * is folded back in at startup and whenever it grows past `JOURNAL_MAX_ROWS`.
 *
 * That split exists because a dictation must not pay to rewrite every dictation
 * before it, and because the alternative — appending into the array itself —
 * trades away the property this file cares about most. See `JOURNAL_MAX_ROWS`.
 *
 * It is not only a log. It is the **recovery surface**: when insertion fails
 * the transcript still lands here, searchable,
 * so nothing the user said is ever lost to a failed injection.
 *
 * : this file is a partial keylogger — everything ever dictated,
 * in one searchable local store. Retention plus an explicit `purge()` is the
 * conscious mitigation, and both are required rather than optional.
 *
 * Electron-free on purpose, so the whole store is unit-testable against a real
 * temp directory.
 */

import { appendFileSync, existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from '@contracts/events.js';
import type { HistoryPort } from '@contracts/ports.js';
import { INSERT_TIERS } from '@contracts/helper-protocol.js';
import type { Logger } from '@shared/logger.js';
import { writeAtomically } from '../config/index.js';

export function historyPath(userDataDir: string): string {
  return join(userDataDir, 'history.json');
}

/**
 * The append journal that sits beside `history.json`. See `compact`.
 *
 * Exported for the tests; nothing in the application needs to know it exists.
 */
export function historyJournalPath(userDataDir: string): string {
  return join(userDataDir, 'history.pending.jsonl');
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * How many appended rows may sit in the journal before it is folded back into
 * `history.json`.
 *
 * **Why a journal at all** (2026-08-09 incident, BUG-7): `append` used to
 * re-serialise and rewrite the *entire* history on every dictation, and that
 * cost grows with retention — at ninety days of heavy use it is a couple of
 * megabytes of `JSON.stringify` and file I/O, synchronously, at the moment the
 * insert result comes back.
 *
 * **Why not a plain append-only file**: `history.json` is the recovery surface,
 * and a corrupted one is a far worse bug than a slow one. Appending into the
 * array itself — seeking past the trailing `]` and rewriting it — gives up
 * atomicity: a crash mid-write leaves a file that is not JSON, which `load`
 * quarantines, and the user loses everything. So the array file keeps its
 * `writeAtomically` rewrite and stays valid JSON at rest, and the *new rows*
 * accumulate in a sidecar that only ever grows by one line.
 *
 * What a crash can cost is then bounded to the single line being written when
 * the power went out, which `loadJournal` drops as unreadable. Nothing older is
 * ever at risk.
 *
 * 200 is chosen, not measured: it makes the amortised cost of an append a
 * two-hundredth of a rewrite while keeping the journal small enough that
 * replaying it at launch is imperceptible, and it is a day or two of heavy
 * dictation — so in practice the fold happens while the app is starting rather
 * than while the user is waiting for text.
 */
const JOURNAL_MAX_ROWS = 200;

export interface HistoryStore extends HistoryPort {
  readonly path: string;
  /**
   * Drop entries older than `retentionDays`. `0` means keep forever
   * (`contracts/config.ts`). Returns how many rows were removed so the caller
   * can log a number rather than a promise.
   */
  sweep(retentionDays: number, now?: number): Promise<number>;
  /** Fired after any mutation, with the new row count. Drives `history-updated`. */
  onChange(listener: (count: number) => void): () => void;
}

/**
 * Total by construction: anything that is not a well-formed row is dropped
 * rather than trusted. The previous implementation cast the parsed array
 * straight to `HistoryEntry[]`, which would let a hand-edited file put
 * `undefined` into the search path.
 *
 * **Every field added after v0.1.0 must be optional here, and old rows must
 * still load.** This function is a filter, not a validator: a row it rejects is
 * dropped silently, so requiring a field the user's existing file cannot have
 * would delete their entire dictation history on the first launch after an
 * update — the exact opposite of what the recovery surface is for. `verified`
 * and `unconfirmedTail` (2026-08-09 incident) are therefore accepted as absent,
 * and `history.test` pins that.
 */
function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean';
}

function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
    isOptionalBoolean(e['verified']) &&
    isOptionalBoolean(e['unconfirmedTail']) &&
    typeof e['id'] === 'string' &&
    typeof e['at'] === 'string' &&
    typeof e['text'] === 'string' &&
    (typeof e['durationSec'] === 'number' || e['durationSec'] === null) &&
    typeof e['language'] === 'string' &&
    (typeof e['frontmostBundleId'] === 'string' || e['frontmostBundleId'] === null) &&
    (typeof e['frontmostName'] === 'string' || e['frontmostName'] === null) &&
    (INSERT_TIERS as readonly string[]).includes(e['tier'] as string) &&
    typeof e['inserted'] === 'boolean'
  );
}

export function createHistoryStore(userDataDir: string, logger: Logger): HistoryStore {
  const log = logger.child('history');
  const path = historyPath(userDataDir);
  const journal = historyJournalPath(userDataDir);
  const listeners = new Set<(count: number) => void>();

  let entries: HistoryEntry[] = load();
  /**
   * Whether `history.json` exists on disk, so the first append creates it
   * rather than leaving the array file missing while rows pile up in the
   * journal. Read *after* `load`, which may have quarantined it.
   */
  let baseWritten = existsSync(path);
  let journalRows = 0;
  // Fold the journal in at startup, so the array file is complete for anything
  // that reads it directly and so a session never begins with a backlog.
  if (existsSync(journal)) compact();

  function load(): HistoryEntry[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        log.warn('could not read history; starting empty', { err: cause });
      }
      return withJournal([]);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (cause) {
      // Do NOT start empty and then overwrite: that destroys the user's whole
      // dictation history on one bad byte. Move it aside so it is recoverable.
      const quarantine = quarantinePath(path);
      try {
        renameSync(path, quarantine);
        log.error('history file is not valid JSON; moved aside', { err: cause, to: quarantine });
      } catch (renameCause) {
        log.error('history file is not valid JSON and could not be moved aside', {
          err: renameCause,
        });
      }
      // The journal is a separate file and a separate failure: rows appended
      // since the last compaction are still readable, so they survive the
      // quarantine of the array beside them.
      return withJournal([]);
    }

    if (!Array.isArray(parsed)) {
      log.warn('history file is not an array; starting empty');
      return withJournal([]);
    }
    const rows = parsed.filter(isHistoryEntry);
    if (rows.length !== parsed.length) {
      log.warn('dropped malformed history rows', { dropped: parsed.length - rows.length });
    }
    return withJournal(rows);
  }

  /**
   * The array file plus whatever was appended since it was last written.
   *
   * De-duplicated by `id`, which is the belt to the journal's braces: if a
   * compaction lands and then the journal fails to delete, the same rows are in
   * both files and would otherwise appear twice for ever.
   */
  function withJournal(base: readonly HistoryEntry[]): HistoryEntry[] {
    const pending = loadJournal();
    if (pending.length === 0) return [...base];
    const seen = new Set(base.map((row) => row.id));
    const merged = [...base];
    for (const row of pending) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
    return merged;
  }

  /**
   * Read the append journal, line by line and forgivingly.
   *
   * A process killed mid-append leaves a torn final line. Dropping it costs the
   * one dictation that was being written; every line before it is complete, and
   * `history.json` itself was never open. That bound is the whole reason the
   * journal is a separate file (see `JOURNAL_MAX_ROWS`).
   */
  function loadJournal(): HistoryEntry[] {
    let raw: string;
    try {
      raw = readFileSync(journal, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        log.warn('could not read the history journal', { err: cause });
      }
      return [];
    }

    const rows: HistoryEntry[] = [];
    let dropped = 0;
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        dropped += 1;
        continue;
      }
      if (isHistoryEntry(parsed)) rows.push(parsed);
      else dropped += 1;
    }
    if (dropped > 0) {
      log.warn('dropped unreadable rows from the history journal', { dropped, kept: rows.length });
    }
    return rows;
  }

  /**
   * Fold everything into `history.json` and drop the journal.
   *
   * The journal is only removed once the rewrite has actually landed — this is
   * what `writeAtomically`'s return value is for. A compaction that failed
   * leaves both files exactly as they were, and the rows are still in the
   * journal for the next attempt.
   */
  function compact(): void {
    const written = writeAtomically(path, `${JSON.stringify(entries, null, 2)}\n`, log);
    if (!written) return;
    baseWritten = true;
    journalRows = 0;
    try {
      rmSync(journal, { force: true });
    } catch (cause) {
      // Harmless: the rows are already in the array file and `withJournal`
      // de-duplicates by id, so a journal that outlives its compaction is
      // ignored rather than doubled.
      log.warn('could not remove the history journal', { err: cause });
    }
  }

  /**
   * One line onto the journal — the whole point of the exercise.
   *
   * A failure here falls back to rewriting the array file, because losing a
   * dictation to a sidecar that could not be opened would be a worse bug than
   * the slow write this replaced.
   */
  function appendToJournal(entry: HistoryEntry): void {
    try {
      appendFileSync(journal, `${JSON.stringify(entry)}\n`, 'utf8');
      journalRows += 1;
    } catch (cause) {
      log.warn('could not append to the history journal; rewriting the whole file', { err: cause });
      compact();
    }
  }

  function notify(): void {
    for (const listener of listeners) {
      try {
        listener(entries.length);
      } catch (cause) {
        log.error('a history listener threw', { err: cause });
      }
    }
  }

  /** Rewrite the whole file. For the mutations that are not appends. */
  function save(): void {
    compact();
    notify();
  }

  const store: HistoryStore = {
    path,

    /**
     * One row, one line. The array file is only rewritten when the journal has
     * grown past `JOURNAL_MAX_ROWS` — or when there is no array file yet, so
     * that `history.json` exists from the first dictation onwards for anything
     * that reads it directly.
     */
    append(entry: HistoryEntry): Promise<void> {
      entries.push(entry);
      if (!baseWritten || journalRows >= JOURNAL_MAX_ROWS) compact();
      else appendToJournal(entry);
      notify();
      return Promise.resolve();
    },

    /**
     * Newest first. The query matches the transcript and the app the dictation
     * was aimed at — "what did I say in Slack?" is the question this surface
     * actually gets asked.
     */
    list(query: string | null, limit: number): Promise<readonly HistoryEntry[]> {
      const needle = query === null ? null : query.trim().toLowerCase();
      const matched =
        needle === null || needle.length === 0
          ? entries
          : entries.filter(
              (e) =>
                e.text.toLowerCase().includes(needle) ||
                (e.frontmostName?.toLowerCase().includes(needle) ?? false),
            );
      return Promise.resolve([...matched].reverse().slice(0, Math.max(0, limit)));
    },

    purge(): Promise<void> {
      const removed = entries.length;
      entries = [];
      save();
      log.info('history purged', { removed });
      return Promise.resolve();
    },

    count(): Promise<number> {
      return Promise.resolve(entries.length);
    },

    sweep(retentionDays: number, now = Date.now()): Promise<number> {
      if (retentionDays <= 0) return Promise.resolve(0); // 0 = keep forever
      const cutoff = now - retentionDays * MS_PER_DAY;
      const kept = entries.filter((e) => {
        const at = Date.parse(e.at);
        // An unparseable timestamp is kept: losing a row to a formatting bug is
        // worse than keeping one row too long.
        return Number.isNaN(at) || at >= cutoff;
      });
      const removed = entries.length - kept.length;
      if (removed === 0) return Promise.resolve(0);
      entries = kept;
      save();
      log.info('history retention sweep', { removed, retentionDays });
      return Promise.resolve(removed);
    },

    onChange(listener: (count: number) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return store;
}

/**
 * Never overwrite an earlier quarantine: two corruptions in a row would
 * otherwise destroy the first file, which is the one most likely to still hold
 * the user's transcripts.
 */
function quarantinePath(path: string): string {
  const stem = path.replace(/\.json$/, '');
  for (let n = 0; n < 100; n += 1) {
    const candidate = n === 0 ? `${stem}.corrupt.json` : `${stem}.corrupt.${String(n)}.json`;
    if (!existsSync(candidate)) return candidate;
  }
  return `${stem}.corrupt.json`;
}
