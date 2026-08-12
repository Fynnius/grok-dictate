/**
 * Protocol conformance, against the **real Swift binary**.
 *
 * Phase 1 proved the app's side of the wire against `mocks/mock-helper.mjs`.
 * This proves the other side: the actual process the app will spawn, speaking
 * the actual protocol, parsed by the actual frozen contract parser. Contract
 * §1's robustness rules are only worth anything if the helper obeys them, and
 * the only way to know is to send it garbage and watch.
 *
 * The suite skips itself when `native/build/grok-dictate-helper` is absent, so
 * a fresh clone with no Xcode still runs `npm test` green. Build it with
 * `./native/build.sh`.
 *
 * Two environment variables keep this safe to run unattended:
 *   - `GROK_DICTATE_HELPER_DRY_RUN` — nothing is ever typed into whatever
 *     window happens to be open while the suite runs.
 *   - `GROK_DICTATE_HELPER_NO_TAP` — no event tap is attempted, so macOS
 *     cannot raise a TCC prompt and block the run on a modal dialog.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { parseHelperFrame, type HelperToApp } from '@contracts/helper-protocol.js';
import { LineFramer } from '../bridge/line-framing.js';
import { resolveHelperBinary } from './index.js';

const lookup = resolveHelperBinary({ override: process.env['GROK_DICTATE_HELPER'] });
const FRAME_TIMEOUT_MS = 5_000;

class HelperUnderTest {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #framer = new LineFramer();
  readonly frames: HelperToApp[] = [];
  /** Every line stdout produced, frame or not — contract §1 rule 4. */
  readonly rawLines: string[] = [];
  readonly stderr: string[] = [];
  readonly parseFailures: string[] = [];
  #exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;

  constructor(extraEnv: Record<string, string> = {}) {
    this.#child = spawn(lookup.path, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        GROK_DICTATE_HELPER_DRY_RUN: '1',
        GROK_DICTATE_HELPER_NO_TAP: '1',
        ...extraEnv,
      },
    });
    this.#child.stdout.setEncoding('utf8');
    this.#child.stdout.on('data', (chunk: string) => {
      for (const line of this.#framer.feed(chunk)) {
        this.rawLines.push(line);
        const parsed = parseHelperFrame(line);
        if (parsed.ok) this.frames.push(parsed.frame);
        else this.parseFailures.push(`${parsed.reason}: ${parsed.raw}`);
      }
    });
    this.#child.stderr.setEncoding('utf8');
    this.#child.stderr.on('data', (chunk: string) => this.stderr.push(chunk));
    this.#child.on('exit', (code, signal) => {
      this.#exit = { code, signal };
    });
  }

  /** Raw, so a test can send things the contract's encoder could not produce. */
  sendRaw(line: string): void {
    this.#child.stdin.write(`${line}\n`);
  }

  async waitForFrame<T extends HelperToApp>(
    predicate: (frame: HelperToApp) => frame is T,
    label: string,
  ): Promise<T>;
  async waitForFrame(
    predicate: (frame: HelperToApp) => boolean,
    label: string,
  ): Promise<HelperToApp>;
  async waitForFrame(
    predicate: (frame: HelperToApp) => boolean,
    label: string,
  ): Promise<HelperToApp> {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    for (;;) {
      const found = this.frames.find(predicate);
      if (found !== undefined) return found;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for ${label}. Frames so far:\n${this.rawLines.join('\n')}`,
        );
      }
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    const deadline = Date.now() + FRAME_TIMEOUT_MS;
    while (this.#exit === null) {
      if (Date.now() > deadline) throw new Error('the helper did not exit');
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

describe.skipIf(!lookup.found)('the built helper binary', () => {
  let helper: HelperUnderTest | null = null;

  const start = (extraEnv?: Record<string, string>): HelperUnderTest => {
    helper = new HelperUnderTest(extraEnv);
    return helper;
  };

  afterEach(() => {
    helper?.kill();
    helper = null;
  });

  it('announces itself with ready before anything else', async () => {
    const h = start();
    const ready = await h.waitForFrame((f) => f.type === 'ready', 'ready');
    expect(ready).toMatchObject({ v: 1, type: 'ready' });
    if (ready.type !== 'ready') throw new Error('unreachable');
    expect(ready.caps).toEqual(['ax', 'unicode']);
    expect(ready.version).toMatch(/^\d+\.\d+\.\d+$/);
    // Contract §2: the first frame after start-up.
    expect(h.frames[0]?.type).toBe('ready');
  });

  it('establishes the initial Secure Input value shortly after ready', async () => {
    const h = start();
    const frame = await h.waitForFrame((f) => f.type === 'secure_input', 'secure_input');
    expect(frame).toMatchObject({ v: 1, type: 'secure_input' });
  });

  it('answers get_frontmost with the same id', async () => {
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    h.sendRaw(JSON.stringify({ v: 1, type: 'get_frontmost', id: 'correlate-me' }));
    const reply = await h.waitForFrame(
      (f) => f.type === 'frontmost' && f.id === 'correlate-me',
      'the frontmost reply',
    );
    expect(reply).toMatchObject({ type: 'frontmost', id: 'correlate-me' });
  });

  it('declines an insert whose target app is no longer in front', async () => {
    //  Deterministic without any permission: the frontmost
    // app during a test run is certainly not this bundle id.
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    h.sendRaw(
      JSON.stringify({
        v: 1,
        type: 'insert',
        id: 'insert-1',
        text: 'hallo',
        targetBundleId: 'com.example.definitely-not-frontmost',
      }),
    );
    const result = await h.waitForFrame(
      (f) => f.type === 'insert_result' && f.id === 'insert-1',
      'the insert_result',
    );
    if (result.type !== 'insert_result') throw new Error('unreachable');
    expect(result.tier).toBe('none');
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('answers every insert exactly once, in order', async () => {
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    for (const id of ['a', 'b', 'c']) {
      h.sendRaw(JSON.stringify({ v: 1, type: 'insert', id, text: 'x', targetBundleId: null }));
    }
    await h.waitForFrame((f) => f.type === 'insert_result' && f.id === 'c', 'the third result');
    const ids = h.frames.filter((f) => f.type === 'insert_result').map((f) => f.id);
    expect(ids).toEqual(['a', 'b', 'c']);
  });

  it('round-trips a transcript containing newlines, quotes and emoji', async () => {
    // The property all the framing rests on (contract §1). If the helper's
    // encoder let a raw newline through, the reply would arrive as two
    // unparseable lines instead of one frame.
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    const nasty = 'erste Zeile\nzweite "Zeile"\\ 👨‍👩‍👧‍👦 „Grüße"\ttabuliert';
    h.sendRaw(
      JSON.stringify({ v: 1, type: 'insert', id: nasty, text: nasty, targetBundleId: null }),
    );
    const result = await h.waitForFrame(
      (f) => f.type === 'insert_result' && f.id === nasty,
      'the echoed id',
    );
    expect(result).toMatchObject({ type: 'insert_result', id: nasty });
    expect(h.parseFailures).toEqual([]);
  });

  it('survives malformed, unknown and wrong-version lines and keeps serving', async () => {
    // Contract §1 rules 1-3. IMPLEMENTATION-PLAN.md §3.2: "Malformed input must
    // never crash the helper."
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');

    h.sendRaw('this is not json');
    h.sendRaw('[1,2,3]');
    h.sendRaw('null');
    h.sendRaw('{');
    h.sendRaw(JSON.stringify({ v: 99, type: 'shutdown' }));
    h.sendRaw(JSON.stringify({ v: 1, type: 'from_the_future', payload: { deep: [1, 2] } }));
    h.sendRaw(JSON.stringify({ v: 1, type: 'insert' }));
    h.sendRaw(JSON.stringify({ v: 1, type: 'copy', text: 'x', unknownField: 'ignore me' }));
    h.sendRaw(' ');

    // Still alive and still correlating.
    h.sendRaw(JSON.stringify({ v: 1, type: 'get_frontmost', id: 'after-the-garbage' }));
    await h.waitForFrame(
      (f) => f.type === 'frontmost' && f.id === 'after-the-garbage',
      'a reply after the garbage',
    );
  });

  it('never writes a non-frame to stdout', async () => {
    // Contract §1 rule 4: "no banners, no progress output". Anything else on
    // stdout desynchronises the app's parser.
    const h = start();
    await h.waitForFrame((f) => f.type === 'secure_input', 'secure_input');
    h.sendRaw(JSON.stringify({ v: 1, type: 'get_frontmost', id: 'x' }));
    await h.waitForFrame((f) => f.type === 'frontmost' && f.id === 'x', 'a reply');
    expect(h.parseFailures).toEqual([]);
    expect(h.rawLines.length).toBe(h.frames.length);
  });

  it('warns about an unrecognised hotkey and keeps the previous binding', async () => {
    // Contract §3: "an unrecognised binding must be reported via `log` at
    // `warn` and the previous binding kept, never silently ignored." The `log`
    // frame is consumed by the supervisor in production, so this test reads it
    // off the wire directly.
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    h.sendRaw(
      JSON.stringify({
        v: 1,
        type: 'set_hotkeys',
        ptt: 'f13',
        toggle: 'fn+space',
        retry: 'ctrl+cmd+v',
      }),
    );
    const warning = await h.waitForFrame(
      (f) => f.type === 'log' && f.level === 'warn' && f.msg.includes('f13'),
      'the hotkey warning',
    );
    if (warning.type !== 'log') throw new Error('unreachable');
    expect(warning.msg).toContain('fn');
  });

  it('accepts the canonical hotkey bindings without complaint', async () => {
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    const before = h.frames.length;
    h.sendRaw(
      JSON.stringify({
        v: 1,
        type: 'set_hotkeys',
        ptt: 'fn',
        toggle: 'fn+space',
        retry: 'ctrl+cmd+v',
      }),
    );
    h.sendRaw(JSON.stringify({ v: 1, type: 'get_frontmost', id: 'settled' }));
    await h.waitForFrame((f) => f.type === 'frontmost' && f.id === 'settled', 'a reply');
    // Scoped to hotkey warnings: start-up also warns about the dry run and the
    // skipped tap, which are this test's own doing.
    const warnings = h.frames
      .slice(before)
      .filter((f) => f.type === 'log' && f.level === 'warn')
      .map((f) => (f.type === 'log' ? f.msg : ''))
      .filter((message) => message.startsWith('ignoring'));
    expect(warnings).toEqual([]);
  });

  it('exits 0 on shutdown', async () => {
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    h.sendRaw(JSON.stringify({ v: 1, type: 'shutdown' }));
    expect(await h.waitForExit()).toEqual({ code: 0, signal: null });
  });

  it('answers an insert that is still running when shutdown arrives', async () => {
    // Contract §4: "Requests are never silently dropped." Insertion runs off
    // the main thread, so exiting the instant `shutdown` is parsed would lose
    // the reply — and the app would show "not inserted" for text that went in.
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    h.sendRaw(
      JSON.stringify({ v: 1, type: 'insert', id: 'racing', text: 'hallo', targetBundleId: null }),
    );
    h.sendRaw(JSON.stringify({ v: 1, type: 'shutdown' }));
    await h.waitForFrame((f) => f.type === 'insert_result' && f.id === 'racing', 'the result');
    expect(await h.waitForExit()).toEqual({ code: 0, signal: null });
  });

  it('exits when the app closes its stdin', async () => {
    const h = start();
    await h.waitForFrame((f) => f.type === 'ready', 'ready');
    h.closeStdin();
    expect(await h.waitForExit()).toEqual({ code: 0, signal: null });
  });

  it('reports the dry run rather than pretending to insert', async () => {
    // If this ever stops holding, every test above could be typing into the
    // developer's screen.
    const h = start();
    await h.waitForFrame(
      (f) => f.type === 'log' && f.level === 'warn' && f.msg.includes('DRY RUN'),
      'the dry-run warning',
    );
    h.sendRaw(
      JSON.stringify({ v: 1, type: 'insert', id: 'dry', text: 'hallo', targetBundleId: null }),
    );
    const result = await h.waitForFrame(
      (f) => f.type === 'insert_result' && f.id === 'dry',
      'the result',
    );
    if (result.type !== 'insert_result') throw new Error('unreachable');
    expect(result.tier).toBe('none');
    expect(result.ok).toBe(false);
  });
});
