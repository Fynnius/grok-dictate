import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { HelperToApp } from '@contracts/helper-protocol.js';
import { clearLogSinks, createLogger } from '@shared/logger.js';
import { HelperSupervisor, type HelperExitInfo } from './helper-supervisor.js';

/**
 * These tests drive the REAL mock helper as a real child process. That is the
 * point: spawning, stdio framing, JSON parsing, correlation and restart are
 * exactly the paths the Swift helper will use in Phase 2, so testing them
 * against a stub object would prove nothing about the parts that actually break.
 */
const MOCK_HELPER = resolve('mocks/mock-helper.mjs');

function makeSupervisor(
  overrides: Partial<{ restartBaseMs: number; command: string; args: string[] }> = {},
): {
  supervisor: HelperSupervisor;
  frames: HelperToApp[];
  exits: HelperExitInfo[];
} {
  const frames: HelperToApp[] = [];
  const exits: HelperExitInfo[] = [];
  const supervisor = new HelperSupervisor({
    spec: {
      command: overrides.command ?? process.execPath,
      args: overrides.args ?? [MOCK_HELPER],
    },
    logger: createLogger('test'),
    restartBaseMs: overrides.restartBaseMs ?? 10,
    restartMaxMs: 50,
    random: () => 1,
  });
  supervisor.onFrame((f) => frames.push(f));
  supervisor.onExit((e) => exits.push(e));
  return { supervisor, frames, exits };
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const running: HelperSupervisor[] = [];

afterEach(async () => {
  for (const s of running.splice(0)) await s.stop(500);
  clearLogSinks();
});

describe('HelperSupervisor against the real mock helper process', () => {
  it('receives the ready frame and the initial secure-input value', async () => {
    const { supervisor, frames } = makeSupervisor();
    running.push(supervisor);
    supervisor.start();
    await waitFor(() => frames.length >= 2);

    expect(frames[0]).toEqual({
      v: 1,
      type: 'ready',
      version: '0.1.0-mock',
      caps: ['ax', 'unicode'],
    });
    expect(frames[1]).toEqual({ v: 1, type: 'secure_input', enabled: false });
  });

  it('round-trips an insert and correlates the result by id', async () => {
    const { supervisor, frames } = makeSupervisor();
    running.push(supervisor);
    supervisor.start();
    await waitFor(() => frames.length >= 2);

    supervisor.send({
      v: 1,
      type: 'insert',
      id: 'req-1',
      text: 'Grüße aus München — 😀',
      targetBundleId: null,
    });
    await waitFor(() => frames.some((f) => f.type === 'insert_result'));

    const result = frames.find((f) => f.type === 'insert_result');
    expect(result).toEqual({
      v: 1,
      type: 'insert_result',
      id: 'req-1',
      tier: 'ax',
      ok: true,
      error: null,
      reason: null,
      // The mock declares the `ax` tier, the one that genuinely reports
      // success, so it confirms. `verified` is what separates that from a
      // Unicode post that may have gone nowhere (2026-08-09 incident).
      verified: true,
      frontmostBundleId: 'com.apple.TextEdit',
      frontmostName: 'TextEdit',
    });
  });

  it('declines an insert when the frontmost app has changed', async () => {
    const { supervisor, frames } = makeSupervisor();
    running.push(supervisor);
    supervisor.start();
    await waitFor(() => frames.length >= 2);

    supervisor.send({
      v: 1,
      type: 'insert',
      id: 'req-2',
      text: 'text',
      targetBundleId: 'com.microsoft.VSCode', // mock is frontmost=com.apple.TextEdit
    });
    await waitFor(() => frames.some((f) => f.type === 'insert_result'));

    const result = frames.find((f) => f.type === 'insert_result');
    expect(result).toMatchObject({ tier: 'none', ok: false });
  });

  it('answers get_frontmost with the matching id', async () => {
    const { supervisor, frames } = makeSupervisor();
    running.push(supervisor);
    supervisor.start();
    await waitFor(() => frames.length >= 2);

    supervisor.send({ v: 1, type: 'get_frontmost', id: 'q-1' });
    await waitFor(() => frames.some((f) => f.type === 'frontmost'));

    expect(frames.find((f) => f.type === 'frontmost')).toEqual({
      v: 1,
      type: 'frontmost',
      bundleId: 'com.apple.TextEdit',
      name: 'TextEdit',
      id: 'q-1',
    });
  });

  it('survives malformed, wrong-version and unknown frames (contract §1 rules 1-3)', async () => {
    const { supervisor, frames } = makeSupervisor();
    running.push(supervisor);
    supervisor.start();
    await waitFor(() => frames.length >= 2);
    const before = frames.length;

    supervisor.send({ v: 1, type: 'get_frontmost', id: 'ignored' });
    // The mock-only `__mock` control frame is deliberately outside the
    // contract union; see mocks/mock-helper.mjs.
    supervisor.send({ v: 1, type: '__mock', action: 'garbage' } as never);
    supervisor.send({ v: 1, type: 'get_frontmost', id: 'after-garbage' });

    // The frame *after* the garbage still arrives — the stream resynchronised
    // and nothing crashed.
    await waitFor(() => frames.some((f) => f.type === 'frontmost' && f.id === 'after-garbage'));

    // The wrong-version and unknown-type frames were dropped, not forwarded.
    const forwarded = frames.slice(before);
    expect(forwarded.some((f) => f.type === 'ready')).toBe(false);
    expect(forwarded.map((f) => f.type)).not.toContain('from_the_future');
    // …but the valid frame carrying an unknown *field* was accepted.
    expect(forwarded.some((f) => f.type === 'secure_input')).toBe(true);
  });

  it('restarts a helper that dies, and reports the death', async () => {
    const { supervisor, frames, exits } = makeSupervisor();
    running.push(supervisor);
    supervisor.start();
    await waitFor(() => frames.length >= 2);

    supervisor.send({ v: 1, type: '__mock', action: 'crash' } as never);

    await waitFor(() => exits.length >= 1);
    expect(exits[0]).toMatchObject({ code: 7, willRestart: true });

    // A fresh `ready` proves the restart actually happened.
    await waitFor(() => frames.filter((f) => f.type === 'ready').length >= 2);
    expect(supervisor.isRunning).toBe(true);
  });

  it('refuses to send when the helper is not running, rather than losing the command', async () => {
    const { supervisor } = makeSupervisor();
    expect(supervisor.send({ v: 1, type: 'get_frontmost', id: 'x' })).toBe(false);
    await Promise.resolve();
  });

  it('stops cleanly without a restart', async () => {
    const { supervisor, frames, exits } = makeSupervisor();
    supervisor.start();
    await waitFor(() => frames.length >= 2);

    await supervisor.stop(1000);
    expect(supervisor.isRunning).toBe(false);
    expect(exits.every((e) => !e.willRestart)).toBe(true);
  });
});

describe('a helper that cannot be started at all', () => {
  it('is retried, not left for dead', async () => {
    // A process that fails to spawn emits `error` and **no `exit`** — Node's
    // docs say "the 'exit' event may or may not fire after an error", and for
    // ENOENT it does not. Phase 1 scheduled restarts from `exit` alone, so a
    // helper binary deleted or made unreadable while the app was running was
    // never retried: one ERROR line and then permanent silence with the Fn key
    // dead. That is  shape precisely.
    const { supervisor, exits } = makeSupervisor({
      command: resolve('mocks/there-is-no-such-binary'),
      args: [],
      restartBaseMs: 10,
    });
    supervisor.start();

    await waitFor(() => exits.length >= 2, 4000);
    expect(exits.every((e) => e.willRestart)).toBe(true);
    await supervisor.stop(200);
  });

  it('gives up after the configured number of consecutive failures', async () => {
    const supervisor = new HelperSupervisor({
      spec: { command: resolve('mocks/there-is-no-such-binary'), args: [] },
      logger: createLogger('test'),
      restartBaseMs: 1,
      restartMaxMs: 5,
      maxConsecutiveRestarts: 2,
      random: () => 1,
    });
    const exits: HelperExitInfo[] = [];
    supervisor.onExit((e) => exits.push(e));
    supervisor.start();

    // Two restarts, then one final exit saying it will not try again — rather
    // than spinning on a binary that is never coming back.
    await waitFor(() => exits.some((e) => !e.willRestart), 4000);
    expect(exits.filter((e) => e.willRestart)).toHaveLength(2);
    await supervisor.stop(200);
  });
});
