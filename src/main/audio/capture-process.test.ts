/**
 * Protocol conformance against the **real** `grok-dictate-capture` binary.
 *
 * Skips itself when `native/build/grok-dictate-capture` is absent, so a fresh
 * clone with no Xcode still runs `npm test` green. Build it with
 * `./native/build.sh`.
 *
 * `GROK_DICTATE_CAPTURE_DRY_RUN` keeps this from opening a microphone.
 */

import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { LineFramer } from '../bridge/line-framing.js';
import { parseCaptureFrame } from './capture-protocol.js';
import { resolveCaptureBinary } from './capture-binary.js';

const lookup = resolveCaptureBinary({ override: process.env['GROK_DICTATE_CAPTURE'] });
const FRAME_TIMEOUT_MS = 5_000;

class CaptureUnderTest {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #framer = new LineFramer();
  readonly rawLines: string[] = [];
  readonly stderr: string[] = [];
  #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor() {
    this.#child = spawn(lookup.path, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GROK_DICTATE_CAPTURE_DRY_RUN: '1',
      },
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      for (const line of this.#framer.feed(chunk)) this.rawLines.push(line);
    });
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.#child.on('exit', (code, signal) => {
      this.#exit = { code, signal };
    });
  }

  sendRaw(line: string): void {
    this.#child.stdin.write(`${line}\n`);
  }

  async waitForLine(predicate: (line: string) => boolean, label: string): Promise<string> {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    for (;;) {
      const found = this.rawLines.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}. Lines so far:\n${this.rawLines.join('\n')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (this.#exit === null) {
      if (Date.now() > deadline) throw new Error('the capture process did not exit');
      await new Promise((r) => setTimeout(r, 10));
    }
    return this.#exit;
  }

  closeStdin(): void {
    this.#child.stdin.end();
  }

  kill(): void {
    if (this.#exit === null) this.#child.kill('SIGKILL');
  }
}

describe.skipIf(!lookup.found)('the built capture binary', () => {
  let proc: CaptureUnderTest | null = null;

  afterEach(() => {
    proc?.kill();
    proc = null;
  });

  it('prints a version on --version', () => {
    const out = execFileSync(lookup.path, ['--version'], { encoding: 'utf8' }).trim();
    expect(out).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints help on --help', () => {
    const out = execFileSync(lookup.path, ['--help'], { encoding: 'utf8' });
    expect(out).toContain('grok-dictate-capture');
    expect(out).toContain('--version');
  });

  it('survives a malformed line and keeps serving', async () => {
    proc = new CaptureUnderTest();
    proc.sendRaw('this is not json');
    proc.sendRaw('[1,2,3]');
    proc.sendRaw('{"type":"from_the_future"}');
    proc.sendRaw(
      JSON.stringify({
        type: 'start',
        sessionId: 'after-garbage',
        sampleRate: 16_000,
        chunkBytes: 3200,
      }),
    );
    const line = await proc.waitForLine(
      (l) => l.includes('after-garbage'),
      'started after garbage',
    );
    const parsed = parseCaptureFrame(line);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value).toMatchObject({ type: 'started', sessionId: 'after-garbage' });
  });

  it('answers start then stop with drained in dry run', async () => {
    proc = new CaptureUnderTest();
    proc.sendRaw(
      JSON.stringify({ type: 'start', sessionId: 's1', sampleRate: 16_000, chunkBytes: 3200 }),
    );
    await proc.waitForLine((l) => l.includes('"started"'), 'started');
    proc.sendRaw(JSON.stringify({ type: 'stop', sessionId: 's1' }));
    const drained = await proc.waitForLine((l) => l.includes('"drained"'), 'drained');
    expect(parseCaptureFrame(drained)).toEqual({
      ok: true,
      value: { type: 'drained', sessionId: 's1' },
    });
  });

  it('answers a second start after stop (the graph-reuse path)', async () => {
    proc = new CaptureUnderTest();
    proc.sendRaw(
      JSON.stringify({ type: 'start', sessionId: 's1', sampleRate: 16_000, chunkBytes: 3200 }),
    );
    await proc.waitForLine(
      (l) => l.includes('"sessionId":"s1"') && l.includes('"started"'),
      's1 started',
    );
    proc.sendRaw(JSON.stringify({ type: 'stop', sessionId: 's1' }));
    await proc.waitForLine(
      (l) => l.includes('"sessionId":"s1"') && l.includes('"drained"'),
      's1 drained',
    );
    proc.sendRaw(
      JSON.stringify({ type: 'start', sessionId: 's2', sampleRate: 16_000, chunkBytes: 3200 }),
    );
    const started = await proc.waitForLine(
      (l) => l.includes('"sessionId":"s2"') && l.includes('"started"'),
      's2 started',
    );
    expect(parseCaptureFrame(started)).toEqual({
      ok: true,
      value: { type: 'started', sessionId: 's2', actualSampleRate: 16_000 },
    });
  });

  it('exits 0 when the app closes stdin', async () => {
    proc = new CaptureUnderTest();
    proc.sendRaw(
      JSON.stringify({ type: 'start', sessionId: 's1', sampleRate: 16_000, chunkBytes: 3200 }),
    );
    await proc.waitForLine((l) => l.includes('"started"'), 'started');
    proc.closeStdin();
    expect(await proc.waitForExit()).toEqual({ code: 0, signal: null });
  });

  it('never writes a non-frame to stdout in protocol mode', async () => {
    proc = new CaptureUnderTest();
    proc.sendRaw(
      JSON.stringify({ type: 'start', sessionId: 's1', sampleRate: 16_000, chunkBytes: 3200 }),
    );
    await proc.waitForLine((l) => l.includes('"started"'), 'started');
    for (const line of proc.rawLines) {
      expect(parseCaptureFrame(line).ok).toBe(true);
    }
  });
});
