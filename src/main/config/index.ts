/**
 * OWNER: **Phase 4**.
 *
 * The user's settings, on disk. The *schema* lives in the frozen
 * `contracts/config.ts`; this module owns persistence, change notification and
 * the guarantee that a corrupt file never stops the app dictating.
 *
 * Deliberately free of Electron: `createConfigStore` is constructed by the
 * composition root before `app.whenReady()`, and keeping it Electron-free is
 * also what lets the whole store be unit-tested against a real temp directory.
 * The one setting that needs Electron — `launchAtLogin` — is applied by
 * `src/main/ui/launch-at-login.ts`, which subscribes to `onChange`.
 */

import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from '@contracts/config.js';
import { DEFAULT_CONFIG, parseConfig } from '@contracts/config.js';
import type { ConfigPort } from '@contracts/ports.js';
import type { Logger } from '@shared/logger.js';

export function configPath(userDataDir: string): string {
  return join(userDataDir, 'config.json');
}

export interface ConfigStore extends ConfigPort {
  readonly path: string;
  /** Fields that were rejected at load and fell back to their default. */
  readonly loadIssues: readonly string[];
}

export function createConfigStore(userDataDir: string, logger: Logger): ConfigStore {
  const log = logger.child('config');
  const path = configPath(userDataDir);
  const listeners = new Set<(config: AppConfig) => void>();

  let current: AppConfig = DEFAULT_CONFIG;
  let loadIssues: readonly string[] = [];

  try {
    const parsed = parseConfig(JSON.parse(readFileSync(path, 'utf8')));
    current = parsed.config;
    loadIssues = parsed.issues;
    // Never silently change a user's settings: say which fields were rejected.
    if (parsed.issues.length > 0)
      log.warn('config fields fell back to defaults', { issues: parsed.issues });
  } catch (cause) {
    const missing = (cause as NodeJS.ErrnoException | null)?.code === 'ENOENT';
    if (!missing) log.warn('could not read config; using defaults', { err: cause });
  }

  const store: ConfigStore = {
    path,
    get loadIssues() {
      return loadIssues;
    },
    get: () => current,

    set(config: AppConfig): Promise<void> {
      current = config;
      writeAtomically(path, `${JSON.stringify(config, null, 2)}\n`, log);
      // Listeners run after the write, so anything that reacts to a setting
      // (launch-at-login, the retention sweep) can never observe a value that
      // would be lost on a crash.
      for (const listener of listeners) {
        try {
          listener(config);
        } catch (cause) {
          log.error('a config listener threw', { err: cause });
        }
      }
      return Promise.resolve();
    },

    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return store;
}

/**
 * Write via a temp file and `rename`, which is atomic within a filesystem.
 *
 * A settings file is a few hundred bytes, so this is synchronous on purpose:
 * the alternative is an interleaving hazard between two rapid saves for no
 * measurable gain. What it buys is that a crash mid-write leaves the previous
 * settings intact rather than a truncated file the next launch has to salvage.
 *
 * **Returns whether the file was actually replaced.** It still never throws —
 * a failed save is logged and life goes on, which is right for settings. The
 * history store needs the answer, though: it folds a journal of appended rows
 * back into `history.json` and may only delete that journal once the rewrite it
 * replaces has landed. Callers that have nothing to undo can ignore it.
 */
export function writeAtomically(path: string, contents: string, log: Logger): boolean {
  const temp = `${path}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temp, contents, 'utf8');
    renameSync(temp, path);
    return true;
  } catch (cause) {
    log.error('could not save', { path, err: cause });
    try {
      unlinkSync(temp);
    } catch {
      // The temp file may never have been created; nothing to clean up.
    }
    return false;
  }
}
