import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@contracts/config.js';
import type { AppConfig } from '@contracts/config.js';
import { addLogSink, clearLogSinks, createLogger, type LogRecord } from '@shared/logger.js';
import { configPath, createConfigStore } from './index.js';

const log = createLogger('test');

let dir: string;
let records: LogRecord[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grok-dictate-config-'));
  records = [];
  clearLogSinks();
  addLogSink((_line, record) => records.push(record));
});

afterEach(() => {
  clearLogSinks();
  rmSync(dir, { recursive: true, force: true });
});

describe('createConfigStore', () => {
  it('starts from the defaults when no file exists, and does not warn', () => {
    const store = createConfigStore(dir, log);
    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(store.loadIssues).toEqual([]);
    expect(records.filter((r) => r.level === 'warn')).toHaveLength(0);
  });

  it('round-trips through disk', async () => {
    const first = createConfigStore(dir, log);
    const next: AppConfig = { ...DEFAULT_CONFIG, languageMode: 'de', endpointingMs: 250 };
    await first.set(next);
    const second = createConfigStore(dir, log);
    expect(second.get()).toEqual(next);
  });

  it('salvages the valid fields of a partially invalid file and names the rejects', () => {
    writeFileSync(
      configPath(dir),
      JSON.stringify({ languageMode: 'de', endpointingMs: 'soon', keyterms: ['kubectl'] }),
      'utf8',
    );
    const store = createConfigStore(dir, log);

    expect(store.get().languageMode).toBe('de');
    expect(store.get().keyterms).toEqual(['kubectl']);
    // The bad field falls back rather than taking the whole file down with it.
    expect(store.get().endpointingMs).toBe(DEFAULT_CONFIG.endpointingMs);
    expect(store.loadIssues.join(' ')).toContain('endpointingMs');
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('falls back to defaults when the file is not JSON at all', () => {
    writeFileSync(configPath(dir), 'not json {{{', 'utf8');
    const store = createConfigStore(dir, log);
    // Dictation must still work when the config is corrupt.
    expect(store.get()).toEqual(DEFAULT_CONFIG);
    expect(records.some((r) => r.level === 'warn')).toBe(true);
  });

  it('notifies listeners after the write, and stops when unsubscribed', async () => {
    const store = createConfigStore(dir, log);
    const seen: AppConfig[] = [];
    const unsubscribe = store.onChange((c) => {
      // The file is already on disk by the time a listener runs, so a listener
      // can never act on a value a crash would lose.
      seen.push(JSON.parse(readFileSync(store.path, 'utf8')) as AppConfig);
      expect(c.languageMode).toBe(seen.at(-1)?.languageMode);
    });

    await store.set({ ...DEFAULT_CONFIG, languageMode: 'en' });
    unsubscribe();
    await store.set({ ...DEFAULT_CONFIG, languageMode: 'de' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.languageMode).toBe('en');
  });

  it('survives a listener that throws', async () => {
    const store = createConfigStore(dir, log);
    store.onChange(() => {
      throw new Error('listener exploded');
    });
    const after: AppConfig[] = [];
    store.onChange((c) => after.push(c));

    await expect(store.set({ ...DEFAULT_CONFIG, audioCues: false })).resolves.toBeUndefined();
    expect(after).toHaveLength(1);
    expect(records.some((r) => r.level === 'error')).toBe(true);
  });

  it('writes atomically and leaves no temp file behind', async () => {
    const store = createConfigStore(dir, log);
    await store.set({ ...DEFAULT_CONFIG, launchAtLogin: true });
    expect(readdirSync(dir)).toEqual(['config.json']);
  });
});
