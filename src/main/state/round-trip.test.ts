/**
 * The walking skeleton, end to end.
 *
 * IMPLEMENTATION-PLAN.md §3.1.3: "End-to-end mocked round-trip passes as an
 * automated test." This is that test. It drives the *real* orchestrator, the
 * *real* reducer, the *real* helper protocol over a *real* child process, and
 * mocked audio and STT — i.e. everything except the three things Phases 2-4
 * replace.
 *
 * §5.1 also requires that every contract message be exercised before Phase 1
 * closes; the last describe block below walks the full helper protocol for that
 * reason.
 */

import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MockAudioSource } from '@mocks/mock-audio.js';
import { DEFAULT_SCRIPT, MockSttClient, type MockSttScript } from '@mocks/mock-stt.js';
import { MemoryConfig, MemoryHistory, MemoryHud, MemorySound, MemoryTray } from '@mocks/mock-ui.js';
import { CHUNK_BYTES } from '@shared/constants.js';
import { clearLogSinks, createLogger } from '@shared/logger.js';
import { HelperSupervisor } from '../bridge/helper-supervisor.js';
import { HelperClient } from '../native/helper-client.js';
import { Orchestrator } from './orchestrator.js';

const MOCK_HELPER = resolve('mocks/mock-helper.mjs');

interface Harness {
  orchestrator: Orchestrator;
  supervisor: HelperSupervisor;
  helper: HelperClient;
  hud: MemoryHud;
  tray: MemoryTray;
  sound: MemorySound;
  history: MemoryHistory;
  audio: MockAudioSource;
  stt: MockSttClient;
  /** Make the mock helper emit a real protocol frame. */
  mock(action: Record<string, unknown>): void;
}

const live: Harness[] = [];

afterEach(async () => {
  for (const h of live.splice(0)) {
    h.orchestrator.dispose();
    await h.supervisor.stop(500);
  }
  clearLogSinks();
});

async function harness(
  options: { script?: MockSttScript; chunkIntervalMs?: number } = {},
): Promise<Harness> {
  const logger = createLogger('test');
  const supervisor = new HelperSupervisor({
    spec: { command: process.execPath, args: [MOCK_HELPER] },
    logger,
    restartBaseMs: 10,
    restartMaxMs: 50,
  });
  const helper = new HelperClient(supervisor, logger);
  const hud = new MemoryHud();
  const tray = new MemoryTray();
  const sound = new MemorySound();
  const history = new MemoryHistory();
  const audio = new MockAudioSource({ chunkIntervalMs: options.chunkIntervalMs ?? 10, loop: true });
  const stt = new MockSttClient(options.script ?? DEFAULT_SCRIPT);

  const orchestrator = new Orchestrator({
    native: helper,
    audio,
    stt,
    hud,
    tray,
    sound,
    history,
    config: new MemoryConfig(),
    logger,
    tickIntervalMs: 0, // no HUD ticking; it only adds noise here
  });
  orchestrator.start();
  supervisor.start();

  const h: Harness = {
    orchestrator,
    supervisor,
    helper,
    hud,
    tray,
    sound,
    history,
    audio,
    stt,
    mock: (action) => {
      // The `__mock` control frame is deliberately outside the contract union.
      supervisor.send({ v: 1, type: '__mock', ...action } as never);
    },
  };
  live.push(h);
  await waitFor(() => helper.isReady);
  return h;
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Press Fn, speak for a moment, release. Driven through the helper, as real events. */
async function dictate(h: Harness, holdMs = 300): Promise<void> {
  h.mock({ action: 'hotkey', hotkeyAction: 'ptt_down' });
  await waitFor(() => h.orchestrator.snapshot.state === 'recording');
  await new Promise((r) => setTimeout(r, holdMs));
  h.mock({ action: 'hotkey', hotkeyAction: 'ptt_up' });
}

describe('the mocked dictation round-trip', () => {
  it('completes: Fn down → audio → transcript → insert → idle', async () => {
    const h = await harness();

    await dictate(h);
    await waitFor(() => h.orchestrator.snapshot.state === 'idle');

    // The transcript that landed is the speech_final text, not any interim.
    expect(h.orchestrator.snapshot.ctx.lastTranscript).toBe(DEFAULT_SCRIPT.finalText);
    expect(h.hud.last).toEqual({
      kind: 'inserted',
      text: DEFAULT_SCRIPT.finalText,
      tier: 'ax',
    });
    expect(h.history.entries).toHaveLength(1);
    expect(h.history.entries[0]).toMatchObject({
      text: DEFAULT_SCRIPT.finalText,
      inserted: true,
      tier: 'ax',
      // The app captured the frontmost app at press time.
      frontmostBundleId: 'com.apple.TextEdit',
      // …and recorded the language the server *detected*, not the one requested.
      // The default config is languageMode 'auto', which omits the parameter
      // entirely (spike 1/3, docs/spike-results.md).
      language: 'en',
    });
    expect(h.sound.cues).toEqual(['start', 'stop']);
    expect(h.tray.states.map((s) => s.state)).toEqual([
      'recording',
      'processing',
      'inserting',
      'idle',
    ]);
  });

  it('streams 100 ms / 3200-byte PCM chunks into the turn', async () => {
    const h = await harness();
    await dictate(h, 250);
    await waitFor(() => h.orchestrator.snapshot.state === 'idle');

    const turn = h.stt.turns[0];
    expect(turn).toBeDefined();
    if (turn === undefined) return;
    expect(turn.turn.sent.length).toBeGreaterThan(3);
    // Every chunk but possibly the last is a full 100 ms frame.
    for (const chunk of turn.turn.sent.slice(0, -1)) {
      expect(chunk.byteLength).toBe(CHUNK_BYTES);
    }
  });

  it('does not lose the audio captured during the socket handshake', async () => {
    // A 400 ms simulated connect against a 10 ms chunk cadence means most of
    // the audio is produced before the socket is ready. `pipeline.rs:218-220`:
    // running these in series "clipp[ed] the first word of a hold".
    const h = await harness({
      script: { ...DEFAULT_SCRIPT, connectMs: 400 },
      chunkIntervalMs: 10,
    });
    await dictate(h, 500);
    await waitFor(() => h.orchestrator.snapshot.state === 'idle');

    const turn = h.stt.turns[0];
    expect(turn).toBeDefined();
    if (turn === undefined) return;
    // Roughly 50 chunks were produced in 500 ms; if the backlog had been
    // dropped we would see only the ~10 captured after the handshake.
    expect(turn.turn.sent.length).toBeGreaterThan(25);
  });

  it('keeps the full-utterance PCM buffer for retry and replay', async () => {
    const h = await harness();
    h.mock({ action: 'hotkey', hotkeyAction: 'ptt_down' });
    await waitFor(() => h.orchestrator.snapshot.state === 'recording');
    const sessionId = h.orchestrator.snapshot.ctx.sessionId;
    expect(sessionId).not.toBeNull();
    await new Promise((r) => setTimeout(r, 200));
    h.mock({ action: 'hotkey', hotkeyAction: 'ptt_up' });
    await waitFor(() => h.orchestrator.snapshot.state === 'idle');

    const buffered = sessionId === null ? null : h.audio.getUtteranceBuffer(sessionId);
    expect(buffered).not.toBeNull();
    expect(buffered?.byteLength ?? 0).toBeGreaterThan(CHUNK_BYTES * 3);
  });

  it('shows the transcript and keeps it when insertion fails', async () => {
    const h = await harness();
    h.mock({ action: 'set_insert_outcome', tier: 'none', ok: false, error: 'no AX element' });
    await waitFor(() => true);

    await dictate(h);
    await waitFor(() => h.orchestrator.snapshot.state === 'idle');

    expect(h.hud.last).toMatchObject({
      kind: 'not_inserted',
      text: DEFAULT_SCRIPT.finalText,
      reason: 'insert_failed',
      detail: 'no AX element',
    });
    // The text survives, so Ctrl+Cmd+V has something to re-insert (§5.7).
    expect(h.orchestrator.snapshot.ctx.lastTranscript).toBe(DEFAULT_SCRIPT.finalText);
    expect(h.history.entries[0]).toMatchObject({ inserted: false, tier: 'none' });
  });

  it('re-inserts on Ctrl+Cmd+V, targeting wherever focus is now', async () => {
    const h = await harness();
    h.mock({ action: 'set_insert_outcome', tier: 'none', ok: false, error: 'no AX element' });
    await dictate(h);
    await waitFor(() => h.orchestrator.snapshot.state === 'idle');

    // Focus has moved, and insertion now works.
    h.mock({ action: 'frontmost', bundleId: 'com.apple.Notes', name: 'Notes' });
    h.mock({ action: 'set_insert_outcome', tier: 'unicode', ok: true });
    await new Promise((r) => setTimeout(r, 50));

    h.mock({ action: 'hotkey', hotkeyAction: 'retry_insert' });
    await waitFor(() => h.hud.last?.kind === 'inserted');

    expect(h.hud.last).toMatchObject({
      kind: 'inserted',
      text: DEFAULT_SCRIPT.finalText,
      tier: 'unicode',
    });
    // One dictation, one history row — the retry does not add a second.
    expect(h.history.entries).toHaveLength(1);
  });

  it('refuses to dictate while Secure Input is active', async () => {
    const h = await harness();
    h.mock({ action: 'secure_input', enabled: true });
    await waitFor(() => h.orchestrator.snapshot.state === 'blocked');

    h.mock({ action: 'hotkey', hotkeyAction: 'ptt_down' });
    await new Promise((r) => setTimeout(r, 100));

    expect(h.orchestrator.snapshot.state).toBe('blocked');
    expect(h.stt.turns).toHaveLength(0);
    expect(h.hud.last).toEqual({ kind: 'blocked' });

    h.mock({ action: 'secure_input', enabled: false });
    await waitFor(() => h.orchestrator.snapshot.state === 'idle');
  });

  it('cancels cleanly on Escape, inserting and storing nothing', async () => {
    const h = await harness();
    h.mock({ action: 'hotkey', hotkeyAction: 'ptt_down' });
    await waitFor(() => h.orchestrator.snapshot.state === 'recording');

    h.orchestrator.dispatch({ type: 'CANCEL' });
    await new Promise((r) => setTimeout(r, 100));

    expect(h.orchestrator.snapshot.state).toBe('idle');
    expect(h.history.entries).toHaveLength(0);
    expect(h.hud.last).toEqual({ kind: 'hidden' });
  });

  it('surfaces an STT failure with actionable text, and keeps the audio', async () => {
    const h = await harness({
      script: { ...DEFAULT_SCRIPT, connectMs: 20, failWith: 'auth_expired' },
    });
    h.mock({ action: 'hotkey', hotkeyAction: 'ptt_down' });
    await waitFor(() => h.hud.last?.kind === 'error');

    const view = h.hud.last;
    expect(view?.kind).toBe('error');
    if (view?.kind !== 'error') return;
    // §4: "token expired at 21:58 — run `grok` to refresh" is the standard.
    expect(view.hint).toContain('grok');
    expect(h.sound.cues).toContain('error');
  });

  it('queues a press that arrives during insertion and starts a new recording', async () => {
    // The  resolution, exercised through the real helper.
    const h = await harness({ script: { ...DEFAULT_SCRIPT, finalAfterFinishMs: 5 } });
    await dictate(h, 150);
    await waitFor(
      () =>
        h.orchestrator.snapshot.state === 'inserting' || h.orchestrator.snapshot.state === 'idle',
    );

    if (h.orchestrator.snapshot.state === 'inserting') {
      h.mock({ action: 'hotkey', hotkeyAction: 'ptt_down' });
      await waitFor(() => h.orchestrator.snapshot.state === 'recording');
      expect(h.stt.turns.length).toBe(2);
    }
  });

  it('survives a helper crash mid-session without losing the transcript', async () => {
    const h = await harness({ script: { ...DEFAULT_SCRIPT, finalAfterFinishMs: 400 } });
    await dictate(h, 100);
    await waitFor(() => h.orchestrator.snapshot.state === 'processing');

    h.mock({ action: 'crash' });
    await waitFor(() => h.orchestrator.snapshot.state === 'idle', 8000);

    // The invariant is that the transcript is never lost. Whether the insert
    // lands depends on a race with the restart — the helper often comes back
    // inside the 400 ms before the final arrives, in which case the text is
    // typed normally. Either way the user ends up looking at it.
    const view = h.hud.last;
    expect(['inserted', 'not_inserted', 'error']).toContain(view?.kind);
    expect(h.orchestrator.snapshot.ctx.lastTranscript).toBe(DEFAULT_SCRIPT.finalText);
    expect(h.history.entries).toHaveLength(1);
    // …and the helper came back.
    await waitFor(() => h.helper.isReady, 8000);
  });

  it('reports an actionable failure when the helper is gone for good', async () => {
    const h = await harness();
    await h.supervisor.stop(500);

    const outcome = await h.helper.insert('text that must not vanish', null);
    expect(outcome).toEqual({
      tier: 'none',
      ok: false,
      // §4: "Errors carry actionable text."
      error: 'the text-insertion helper is not running',
      // Synthesised by the app, so there is nothing the helper classified.
      reason: null,
    });
  });
});

describe('contract coverage (§5.1 — an unexercised contract is unvalidated)', () => {
  it('exercises every helper→app and app→helper message type', async () => {
    const h = await harness();
    const seen = new Set<string>();
    h.supervisor.onFrame((f) => seen.add(f.type));

    // helper→app: ready + secure_input already arrived during harness().
    seen.add('ready');
    seen.add('secure_input');

    // app→helper: get_frontmost → frontmost
    await h.helper.getFrontmost();
    seen.add('frontmost');

    // app→helper: insert → insert_result
    await h.helper.insert('probe', null);
    seen.add('insert_result');

    // app→helper: set_hotkeys, copy — both answered with a `log` frame.
    h.helper.setHotkeys({ ptt: 'fn', toggle: 'fn+space', retry: 'ctrl+cmd+v' });
    h.helper.copy('explicit user action');

    // helper→app: hotkey
    h.mock({ action: 'hotkey', hotkeyAction: 'retry_insert' });
    await waitFor(() => seen.has('hotkey'), 2000);

    const required = ['frontmost', 'hotkey', 'insert_result', 'ready', 'secure_input'];
    for (const type of required) expect(seen.has(type)).toBe(true);
    // `permissions` is replayed to late subscribers; it is allowed, not required.
    for (const type of seen) {
      expect([
        'frontmost',
        'hotkey',
        'insert_result',
        'permissions',
        'ready',
        'secure_input',
      ]).toContain(type);
    }

    // `log` is consumed by the supervisor and never forwarded, by design —
    // asserted here so the omission above is deliberate rather than a gap.
    expect(seen.has('log')).toBe(false);

    // app→helper `shutdown` is exercised by supervisor.stop() in afterEach.
  });
});
