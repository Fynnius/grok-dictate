/**
 * Tests for the CLI-delegated login renewal.
 *
 * The child process itself is a seam (`RunGrok`), so everything below is about
 * *policy*: when we are willing to spawn, how often, and what we conclude from
 * the result. The one thing deliberately not asserted here is the token — this
 * module never sees one.
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { clearLogSinks, createLogger, setLogLevel, type LogRecord } from '@shared/logger.js';
import { addLogSink } from '@shared/logger.js';
import { GrokCliRenewer, resolveGrokBinary, type RunResult } from './renew.js';

const logged: LogRecord[] = [];

beforeEach(() => {
  logged.length = 0;
  clearLogSinks();
  setLogLevel('debug');
  addLogSink((_line, record) => {
    logged.push(record);
  });
});

const logger = (): ReturnType<typeof createLogger> => createLogger('test');

const ok = (): Promise<RunResult> =>
  Promise.resolve({ code: 0, signal: null, stderr: '' } satisfies RunResult);

describe('resolveGrokBinary', () => {
  it('prefers an explicit override, even when it does not exist', () => {
    // A user who set the variable wants to know it is wrong, not to have a
    // different binary quietly used instead.
    const lookup = resolveGrokBinary({ override: '/custom/grok', exists: () => false });
    expect(lookup).toEqual({ path: '/custom/grok', found: false, source: 'override' });
  });

  it('finds the CLI where its own installer puts it', () => {
    const lookup = resolveGrokBinary({
      home: '/Users/someone',
      exists: (path) => path === '/Users/someone/.grok/bin/grok',
    });
    expect(lookup).toEqual({
      path: '/Users/someone/.grok/bin/grok',
      found: true,
      source: 'home',
    });
  });

  it('falls back to the usual install prefixes', () => {
    const lookup = resolveGrokBinary({
      home: '/Users/someone',
      exists: (path) => path === '/opt/homebrew/bin/grok',
    });
    expect(lookup).toEqual({ path: '/opt/homebrew/bin/grok', found: true, source: 'search-path' });
  });

  it('reports not-found rather than throwing, naming where it looked', () => {
    const lookup = resolveGrokBinary({ home: '/Users/someone', exists: () => false });
    expect(lookup.found).toBe(false);
    expect(lookup.path).toBe('/Users/someone/.grok/bin/grok');
  });
});

describe('GrokCliRenewer', () => {
  it('runs the CLI and reports that it ran', async () => {
    const calls: { command: string; args: readonly string[] }[] = [];
    const renewer = new GrokCliRenewer({
      logger: logger(),
      override: '/bin/grok',
      exists: () => true,
      run: (command, args) => {
        calls.push({ command, args });
        return ok();
      },
    });

    const outcome = await renewer.renew('a test');
    expect(outcome.kind).toBe('ran');
    // `models`, not a bare TUI launch that then has to be killed.
    expect(calls).toEqual([{ command: '/bin/grok', args: ['models'] }]);
  });

  it('does not treat exit 0 as proof of anything', async () => {
    // `grok models` exits 0 while printing "You are not authenticated.", so the
    // outcome deliberately carries the code rather than a verdict.
    const renewer = new GrokCliRenewer({
      logger: logger(),
      override: '/bin/grok',
      exists: () => true,
      run: ok,
    });
    const outcome = await renewer.renew('a test');
    expect(outcome.kind).toBe('ran');
    if (outcome.kind !== 'ran') return;
    expect(outcome.exitCode).toBe(0);
    expect(typeof outcome.durationMs).toBe('number');
  });

  it('shares one process between concurrent callers', async () => {
    // The expiry timer and a key press can land in the same second. Two `grok`
    // processes contending for auth.json.lock is not a race worth having.
    let started = 0;
    let release: (value: RunResult) => void = () => undefined;
    const renewer = new GrokCliRenewer({
      logger: logger(),
      override: '/bin/grok',
      exists: () => true,
      run: () => {
        started++;
        return new Promise<RunResult>((resolve) => {
          release = resolve;
        });
      },
    });

    const first = renewer.renew('timer');
    const second = renewer.renew('key press');
    release({ code: 0, signal: null, stderr: '' });
    await Promise.all([first, second]);

    expect(started).toBe(1);
  });

  it('skips when the CLI is not installed, and says so once', async () => {
    const renewer = new GrokCliRenewer({
      logger: logger(),
      override: undefined,
      home: '/Users/someone',
      exists: () => false,
      run: () => {
        throw new Error('must not spawn');
      },
    });

    expect(await renewer.renew('one')).toEqual({ kind: 'skipped', reason: 'binary_missing' });
    expect(await renewer.renew('two')).toEqual({ kind: 'skipped', reason: 'binary_missing' });
    const warnings = logged.filter((r) => r.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.msg).toContain('grok CLI was not found');
  });

  it('reports a spawn failure instead of throwing at the caller', async () => {
    const renewer = new GrokCliRenewer({
      logger: logger(),
      override: '/bin/grok',
      exists: () => true,
      run: () => Promise.reject(new Error('ENOENT')),
    });
    expect(await renewer.renew('a test')).toEqual({ kind: 'failed', reason: 'ENOENT' });
  });

  it('treats a killed child as a failure, never as a completed run', async () => {
    const renewer = new GrokCliRenewer({
      logger: logger(),
      override: '/bin/grok',
      exists: () => true,
      run: () => Promise.resolve({ code: null, signal: 'SIGTERM', stderr: '' }),
    });
    expect(await renewer.renew('a test')).toEqual({ kind: 'failed', reason: 'killed by SIGTERM' });
  });
});

describe('GrokCliRenewer cooldown', () => {
  /** A renewer whose clock the test drives. */
  function fixture(): {
    renewer: GrokCliRenewer;
    runs: () => number;
    advance: (ms: number) => void;
  } {
    let clock = 1_000_000;
    let runs = 0;
    const renewer = new GrokCliRenewer({
      logger: logger(),
      override: '/bin/grok',
      exists: () => true,
      now: () => clock,
      run: () => {
        runs++;
        return ok();
      },
    });
    return {
      renewer,
      runs: () => runs,
      advance: (ms) => {
        clock += ms;
      },
    };
  }

  it('lets a second attempt straight through while nothing has failed', async () => {
    const { renewer, runs, advance } = fixture();
    await renewer.renew('one');
    renewer.recordOutcome(true);
    advance(1_000);
    await renewer.renew('two');
    expect(runs()).toBe(2);
  });

  it('holds off after a failure, then allows a retry once the gap has passed', async () => {
    // Being offline must not turn into a spawn a minute for the whole evening.
    const { renewer, runs, advance } = fixture();
    await renewer.renew('one');
    renewer.recordOutcome(false);

    advance(10_000);
    expect(await renewer.renew('too soon')).toEqual({ kind: 'skipped', reason: 'cooling_down' });
    expect(runs()).toBe(1);

    advance(25_000); // 35 s total, past the 30 s first cooldown
    expect((await renewer.renew('now fine')).kind).toBe('ran');
    expect(runs()).toBe(2);
  });

  it('doubles the gap for each consecutive failure', async () => {
    const { renewer, runs, advance } = fixture();
    await renewer.renew('one');
    renewer.recordOutcome(false);
    advance(31_000);
    await renewer.renew('two');
    renewer.recordOutcome(false);

    // Second failure: the gap is now 60 s, so 31 s is no longer enough.
    advance(31_000);
    expect(await renewer.renew('three')).toEqual({ kind: 'skipped', reason: 'cooling_down' });
    advance(30_000);
    expect((await renewer.renew('four')).kind).toBe('ran');
    expect(runs()).toBe(3);
  });

  it('forgets the whole history the moment a renewal works', async () => {
    const { renewer, runs, advance } = fixture();
    for (let i = 0; i < 4; i++) {
      advance(600_000);
      await renewer.renew(`attempt ${String(i)}`);
      renewer.recordOutcome(false);
    }
    advance(600_000);
    await renewer.renew('the one that works');
    renewer.recordOutcome(true);

    advance(100);
    expect((await renewer.renew('immediately after')).kind).toBe('ran');
    expect(runs()).toBe(6);
  });
});

/**
 * The one test that uses no seam at all.
 *
 * Everything above stubs `RunGrok`, which means none of it would notice the two
 * ways this feature actually breaks in the field: the binary is not where we
 * looked, or `spawn` is handed something it cannot execute. Both are invisible
 * until a user's token expires, which is the worst possible moment to find out.
 *
 * Skipped rather than failed when the CLI is absent — a machine without it is a
 * legitimate configuration, and CI is one.
 *
 * Safe to run against a real installation: with a valid token `grok models`
 * prints the model list and returns without touching `auth.json` (it treats
 * anything over five minutes from expiry as fine), so this neither rotates a
 * token nor writes to the user's file.
 */
describe('against the real Grok CLI', () => {
  const installed = resolveGrokBinary().found;

  it.skipIf(!installed)(
    'finds the binary and runs it to completion',
    async () => {
      const renewer = new GrokCliRenewer({ logger: logger() });
      expect(renewer.available).toBe(true);

      const outcome = await renewer.renew('an end-to-end test');

      // `ran` and nothing more: the exit code is not evidence of a renewal, and
      // whether one was needed depends on a real clock and a real token.
      expect(outcome.kind).toBe('ran');
      if (outcome.kind !== 'ran') return;
      expect(outcome.exitCode).toBe(0);
    },
    130_000,
  );
});
