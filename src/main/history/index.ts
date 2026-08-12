/**
 * OWNER: **Phase 4**.
 *
 * Flat JSON, as  prescribes — "move to SQLite only when the
 * file becomes annoying". One dictation per row: transcript, timestamp,
 * duration, detected language, frontmost app, insertion outcome.
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

import { existsSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryEntry } from '@contracts/events.js';
import type { HistoryPort } from '@contracts/ports.js';
import { INSERT_TIERS } from '@contracts/helper-protocol.js';
import type { Logger } from '@shared/logger.js';
import { writeAtomically } from '../config/index.js';

export function historyPath(userDataDir: string): string {
  return join(userDataDir, 'history.json');
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

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
 */
function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (value === null || typeof value !== 'object') return false;
  const e = value as Record<string, unknown>;
  return (
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
  const listeners = new Set<(count: number) => void>();

  let entries: HistoryEntry[] = load();

  function load(): HistoryEntry[] {
    let raw: string;
    try {
      raw = readFileSync(path, 'utf8');
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
        log.warn('could not read history; starting empty', { err: cause });
      }
      return [];
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
      return [];
    }

    if (!Array.isArray(parsed)) {
      log.warn('history file is not an array; starting empty');
      return [];
    }
    const rows = parsed.filter(isHistoryEntry);
    if (rows.length !== parsed.length) {
      log.warn('dropped malformed history rows', { dropped: parsed.length - rows.length });
    }
    return rows;
  }

  function save(): void {
    writeAtomically(path, `${JSON.stringify(entries, null, 2)}\n`, log);
    for (const listener of listeners) {
      try {
        listener(entries.length);
      } catch (cause) {
        log.error('a history listener threw', { err: cause });
      }
    }
  }

  const store: HistoryStore = {
    path,

    append(entry: HistoryEntry): Promise<void> {
      entries.push(entry);
      save();
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
