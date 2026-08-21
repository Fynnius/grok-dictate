/**
 * The orchestrator's own behaviour — the part that is *not* in the reducer.
 *
 * `machine.test.ts` proves the transitions and `round-trip.test.ts` proves the
 * whole pipeline against real child processes. Between them sits a layer with
 * rules of its own: when `audio.done` may be sent, when a turn's resources are
 * released, and how much IPC a second of recording is allowed to cost. All
 * three were defects on 2026-08-09 (BUG-2, BUG-5, BUG-7), and none of them is
 * visible from either side.
 *
 * Same style as the reducer's tests: hand-written doubles, no mocking library,
 * events in and observable calls out.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { MemoryConfig, MemoryHistory, MemoryHud, MemorySound, MemoryTray } from '@mocks/mock-ui.js';
import type { HotkeyBindings } from '@contracts/config.js';
import type {
  AudioHandlers,
  AudioSourcePort,
  FrontmostApp,
  InsertOutcome,
  NativeHelperPort,
  SttClientPort,
  SttHandlers,
  SttTurn,
  SttTurnOptions,
} from '@contracts/ports.js';
import { clearLogSinks, createLogger } from '@shared/logger.js';
import { Orchestrator } from './orchestrator.js';

/**
 * A microphone the test drives by hand. Nothing happens on its own, so the
 * exact moment the tail arrives and the exact moment the drain completes are
 * both under the test's control — which is the whole subject of BUG-2.
 */
class ScriptedAudio implements AudioSourcePort {
  handlers: AudioHandlers | null = null;
  sessionId: string | null = null;
  readonly stopped: string[] = [];
  readonly cancelled: string[] = [];

  /** `true` mimics `MockAudioSource`, which drains inside `stop()`. */
  constructor(private readonly eagerDrain = false) {}

  start(sessionId: string, handlers: AudioHandlers): void {
    this.sessionId = sessionId;
    this.handlers = handlers;
  }
  /** Deliberately does NOT drain unless asked: the test decides when the tail is in. */
  stop(sessionId: string): void {
    this.stopped.push(sessionId);
    if (this.eagerDrain) this.drain();
  }
  cancel(sessionId: string): void {
    this.cancelled.push(sessionId);
  }
  getUtteranceBuffer(): Uint8Array | null {
    return null;
  }

  /** The renderer's tail chunk, arriving after `capture-stop`. */
  chunk(pcm: Uint8Array): void {
    this.handlers?.onChunk(pcm);
  }
  drain(): void {
    this.handlers?.onDrained();
  }
}

class ScriptedTurn implements SttTurn {
  readonly sent: Uint8Array[] = [];
  finishes = 0;
  aborts = 0;

  constructor(
    readonly options: SttTurnOptions,
    readonly handlers: SttHandlers,
  ) {}

  sendPcm(pcm: Uint8Array): void {
    this.sent.push(pcm);
  }
  finish(): void {
    this.finishes++;
  }
  abort(): void {
    this.aborts++;
  }
}

class ScriptedStt implements SttClientPort {
  readonly turns: ScriptedTurn[] = [];
  startTurn(options: SttTurnOptions, handlers: SttHandlers): SttTurn {
    const turn = new ScriptedTurn(options, handlers);
    this.turns.push(turn);
    return turn;
  }
  get only(): ScriptedTurn {
    const turn = this.turns[0];
    if (turn === undefined) throw new Error('no turn was started');
    return turn;
  }
  get latest(): ScriptedTurn {
    const turn = this.turns.at(-1);
    if (turn === undefined) throw new Error('no turn was started');
    return turn;
  }
}

class StubHelper implements NativeHelperPort {
  readonly isReady = true;
  outcome: InsertOutcome = { tier: 'ax', ok: true, error: null, verified: true };
  readonly inserted: string[] = [];

  insert(text: string): Promise<InsertOutcome> {
    this.inserted.push(text);
    return Promise.resolve(this.outcome);
  }
  copy(): void {
    throw new Error('the clipboard is written only on an explicit user action');
  }
  getFrontmost(): Promise<FrontmostApp> {
    return Promise.resolve({ bundleId: 'com.apple.TextEdit', name: 'TextEdit' });
  }
  setHotkeys(_bindings: HotkeyBindings): void {
    /* nothing to bind */
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  onReady(): () => void {
    return () => undefined;
  }
  onHotkey(): () => void {
    return () => undefined;
  }
  onSecureInput(): () => void {
    return () => undefined;
  }
  onPermissions(): () => void {
    return () => undefined;
  }
  onFrontmostChanged(): () => void {
    return () => undefined;
  }
}

interface Harness {
  orchestrator: Orchestrator;
  audio: ScriptedAudio;
  stt: ScriptedStt;
  helper: StubHelper;
  hud: MemoryHud;
  history: MemoryHistory;
}

const live: Orchestrator[] = [];

afterEach(() => {
  for (const orchestrator of live.splice(0)) orchestrator.dispose();
  clearLogSinks();
});

function harness(options: { eagerDrain?: boolean } = {}): Harness {
  const audio = new ScriptedAudio(options.eagerDrain ?? false);
  const stt = new ScriptedStt();
  const helper = new StubHelper();
  const hud = new MemoryHud();
  const history = new MemoryHistory();
  const orchestrator = new Orchestrator({
    native: helper,
    audio,
    stt,
    hud,
    tray: new MemoryTray(),
    sound: new MemorySound(),
    history,
    config: new MemoryConfig(),
    logger: createLogger('orchestrator-test'),
    tickIntervalMs: 0,
  });
  live.push(orchestrator);
  return { orchestrator, audio, stt, helper, hud, history };
}

const pcm = (fill: number): Uint8Array => new Uint8Array(8).fill(fill);

/* ------------------------------------------------------------------ *
 * BUG-2 — the flushed audio tail
 * ------------------------------------------------------------------ */

describe('audio.done waits for the capture tail (2026-08-09 incident, BUG-2)', () => {
  it('does not finish the turn in the same tick as stop_capture', () => {
    const { orchestrator, audio, stt } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });

    expect(audio.stopped).toEqual([orchestrator.snapshot.ctx.sessionId]);
    // The old behaviour: `audio.done` on the wire before the renderer had
    // flushed its encoder tail, so the last ~100–300 ms of every dictation was
    // transcribed by nobody.
    expect(stt.only.finishes).toBe(0);
  });

  it('sends the tail chunk that arrives after the stop, then finishes', () => {
    const { orchestrator, audio, stt } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    audio.chunk(pcm(1));
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    audio.chunk(pcm(2)); // the flush
    audio.drain();

    expect(stt.only.sent.map((c) => c[0])).toEqual([1, 2]);
    expect(stt.only.finishes).toBe(1);
  });

  it('finishes exactly once, however many times the drain is reported', () => {
    const { orchestrator, audio, stt } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    audio.drain();
    audio.drain();

    expect(stt.only.finishes).toBe(1);
  });

  it('never finishes a turn the user cancelled, drain or no drain', () => {
    const { orchestrator, audio, stt } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'CANCEL' });
    audio.drain();

    expect(stt.only.finishes).toBe(0);
    expect(stt.only.aborts).toBe(1);
  });

  it('holds nothing back when the session was already released by an error', () => {
    // A turn that fails reports it and is let go (BUG-5). The drain that
    // arrives afterwards must find nothing to finish rather than reviving it.
    const { orchestrator, audio, stt } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const sessionId = orchestrator.snapshot.ctx.sessionId ?? '';
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    stt.only.handlers.onError({ code: 'stt_connect', message: 'gone', hint: null });
    audio.drain();

    expect(stt.only.finishes).toBe(0);
    expect(sessionId).not.toBe('');
  });

  it('finishes immediately when the port drains inside stop(), as the mock does', () => {
    // `MockAudioSource` has no renderer to wait for and calls `onDrained`
    // synchronously. The bookkeeping is registered *before* `audio.stop()` so
    // that this case is not mistaken for "still draining" and left hanging.
    const { orchestrator, stt } = harness({ eagerDrain: true });
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    expect(stt.only.finishes).toBe(1);
  });
});

/* ------------------------------------------------------------------ *
 * BUG-7 — per-frame IPC churn
 * ------------------------------------------------------------------ */

describe('the HUD is not sent a frame it is already showing (BUG-7)', () => {
  it('skips a show whose view is shallow-equal to the last one', () => {
    const { orchestrator, hud } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const shown = hud.views.length;

    // Two ticks at the same millisecond: the second produces an identical view
    // even if the reducer's coalescing window has passed.
    orchestrator.dispatch({ type: 'TICK', now: 2_000 });
    orchestrator.dispatch({ type: 'TICK', now: 2_000 });
    orchestrator.dispatch({ type: 'TICK', now: 2_000 });

    expect(hud.views.length - shown).toBeLessThanOrEqual(1);
  });

  it('still sends a frame the moment anything about it changes', () => {
    const { orchestrator, hud } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const before = hud.views.length;
    orchestrator.dispatch({ type: 'TRANSCRIPT_INTERIM', sessionId: '', text: 'hallo' });
    orchestrator.dispatch({
      type: 'TRANSCRIPT_INTERIM',
      sessionId: orchestrator.snapshot.ctx.sessionId ?? '',
      text: 'hallo du',
    });

    expect(hud.views.length).toBeGreaterThan(before);
    expect(hud.last).toMatchObject({ kind: 'recording', interim: 'hallo du' });
  });

  it('does not swallow the transition out of recording', () => {
    const { orchestrator, audio, hud } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    audio.drain();

    expect(hud.last).toMatchObject({ kind: 'processing' });
  });
});

/* ------------------------------------------------------------------ *
 * BUG-5 — the leaking turn map
 * ------------------------------------------------------------------ */

describe('a finished turn is let go (2026-08-09 incident, BUG-5)', () => {
  /**
   * `#turns` is private, and the honest observation of "is it still in there?"
   * is `dispose()`, which aborts **every turn the orchestrator is still
   * holding**. A completed turn that was released is not aborted; a leaked one
   * is. The old code's only `delete` was in `abort_stt`, which the normal
   * completion path never runs, so every successful dictation leaked an
   * `SttTurnImpl` — handlers, accumulator and keyterms — for the life of a
   * process that runs for weeks.
   */
  const completeOneDictation = (h: Harness): void => {
    h.orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const sessionId = h.orchestrator.snapshot.ctx.sessionId ?? '';
    h.orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    h.audio.drain();
    h.stt.latest.handlers.onFinal('Ein ganz normaler Satz.');
    h.stt.latest.handlers.onDone(4.2);
    h.orchestrator.dispatch({
      type: 'INSERT_RESULT',
      sessionId,
      outcome: { tier: 'ax', ok: true, error: null, verified: true },
    });
  };

  it('leaves the map empty after a successful dictation', () => {
    const h = harness();
    completeOneDictation(h);
    expect(h.orchestrator.snapshot.state).toBe('idle');
    expect(h.helper.inserted).toEqual(['Ein ganz normaler Satz.']);

    h.orchestrator.dispose();
    expect(h.stt.only.aborts).toBe(0);
  });

  it('leaves the map empty after a turn that failed', () => {
    const h = harness();
    h.orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    h.stt.only.handlers.onError({
      code: 'stt_connect',
      message: 'The connection dropped.',
      hint: 'Try again.',
    });

    h.orchestrator.dispose();
    expect(h.stt.only.aborts).toBe(0);
  });

  it('still aborts a turn that is genuinely in flight when the app quits', () => {
    // The other half of the same assertion: `dispose()` has to keep working,
    // or the test above would pass for the wrong reason.
    const h = harness();
    h.orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    h.orchestrator.dispose();
    expect(h.stt.only.aborts).toBe(1);
  });

  it('does not accumulate turns across many dictations', () => {
    const h = harness();
    for (let n = 0; n < 5; n += 1) completeOneDictation(h);
    expect(h.stt.turns).toHaveLength(5);

    h.orchestrator.dispose();
    expect(h.stt.turns.every((turn) => turn.aborts === 0)).toBe(true);
  });
});
