/**
 * A rotating log file, for the packaged app.
 *
 * ## Why
 *
 * In development the app writes to the terminal that started it, and every
 * diagnosis in this project so far has come from a user pasting that output.
 * A packaged menu-bar app has no terminal: it is launched from Finder, its
 * stdout goes nowhere, and it has no window that could show a log either. So
 * the moment the app is packaged — which is the moment the tray icon finally
 * works, `docs/phase-5-review.md` — it also becomes undiagnosable.
 *
 * That is the same shape as the failures  is about. Both silent
 * failures it names (Secure Input, the event-tap timeout) produce "no error, no
 * log, no crash"; shipping a build where *nothing* produces a log would make
 * every failure look like that one.
 *
 * ## What it does not do
 *
 * It writes the same already-redacted line the console sink receives.
 * `LogSink` is handed text that has been through `serialiseRedacted`, and there
 * is deliberately no API by which a sink can see a raw record
 * (`src/shared/logger.ts`), so a file sink cannot leak a token even by mistake
 * —  names a log file as one of the four sinks that must never
 * hold the bearer, and this is the one that persists.
 *
 * Rotation is one generation at a fixed size. A dictation session logs a few
 * lines per turn at info, and considerably more at debug; without a bound the
 * file would grow for as long as the app is installed. One previous generation
 * is kept because the interesting thing usually happened just before the user
 * noticed, which may be before the current file started.
 */

import { appendFileSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { LogSink } from '@shared/logger.js';

/** Small enough to open in an editor, large enough to hold a day of dictation. */
export const LOG_MAX_BYTES = 2 * 1024 * 1024;

export function logFilePath(logsDir: string): string {
  return join(logsDir, 'main.log');
}

/**
 * `logsDir` is `app.getPath('logs')`, which on macOS is
 * `~/Library/Logs/<productName>` — where a macOS user, and Console.app, already
 * look.
 */
export function fileSink(logsDir: string): LogSink {
  const path = logFilePath(logsDir);
  const previous = `${path}.1`;
  let broken = false;

  try {
    mkdirSync(logsDir, { recursive: true });
  } catch {
    // An unwritable logs directory is not a reason to refuse to dictate. The
    // sink below will no-op on the first failed write.
    broken = true;
  }

  return (line) => {
    if (broken) return;
    try {
      rotateIfLarge(path, previous);
      appendFileSync(path, `${line}\n`, 'utf8');
    } catch {
      // Stop trying rather than failing on every line for the rest of the
      // session. `emit()` already swallows sink exceptions, but a full disk
      // would otherwise mean a syscall per log line for ever.
      broken = true;
    }
  };
}

function rotateIfLarge(path: string, previous: string): void {
  let size: number;
  try {
    size = statSync(path).size;
  } catch {
    return; // No file yet: nothing to rotate.
  }
  if (size < LOG_MAX_BYTES) return;
  try {
    unlinkSync(previous);
  } catch {
    // No previous generation; `rename` below creates it.
  }
  renameSync(path, previous);
}
