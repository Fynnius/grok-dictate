import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileSink, logFilePath, LOG_MAX_BYTES } from './log-file.js';

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'grok-log-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const RECORD = { ts: '', level: 'info' as const, scope: 'app', msg: 'x' };

describe('fileSink', () => {
  it('creates the logs directory and appends one line per record', () => {
    const dir = join(tempDir(), 'nested', 'logs');
    const sink = fileSink(dir);
    sink('{"msg":"one"}', RECORD);
    sink('{"msg":"two"}', RECORD);
    expect(readFileSync(logFilePath(dir), 'utf8')).toBe('{"msg":"one"}\n{"msg":"two"}\n');
  });

  it('rotates one generation once the file is large', () => {
    const dir = tempDir();
    writeFileSync(logFilePath(dir), 'x'.repeat(LOG_MAX_BYTES + 1));
    const sink = fileSink(dir);
    sink('{"msg":"fresh"}', RECORD);

    expect(readFileSync(logFilePath(dir), 'utf8')).toBe('{"msg":"fresh"}\n');
    // The interesting event is usually just before the user noticed, which may
    // be before the current file started — hence keeping one generation.
    expect(existsSync(`${logFilePath(dir)}.1`)).toBe(true);
  });

  it('never throws, whatever the filesystem does', () => {
    // An unwritable logs directory is not a reason to refuse to dictate.
    const sink = fileSink('/dev/null/not-a-directory');
    expect(() => sink('{"msg":"x"}', RECORD)).not.toThrow();
  });

  it('writes exactly the line it is given, which is already redacted', () => {
    // `src/shared/logger.ts` hands sinks text that has been through
    // `serialiseRedacted`, and offers no way to see a raw record. The sink
    // must not reconstruct anything of its own.
    const dir = tempDir();
    fileSink(dir)('{"msg":"Bearer [REDACTED]"}', RECORD);
    expect(readFileSync(logFilePath(dir), 'utf8')).toBe('{"msg":"Bearer [REDACTED]"}\n');
  });
});
