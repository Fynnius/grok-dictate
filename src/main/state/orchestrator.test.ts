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

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryConfig, MemoryHistory, MemoryHud, MemorySound, MemoryTray } from '@mocks/mock-ui.js';
import type { AppConfig, HotkeyBindings } from '@contracts/config.js';
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
import { CHUNK_BYTES } from '@shared/constants.js';
import { addLogSink, clearLogSinks, createLogger } from '@shared/logger.js';
import type { MachineEnv } from './machine.js';
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
  constructor(
    private readonly eagerDrain = false,
    readonly announceStart = true,
  ) {}

  start(sessionId: string, handlers: AudioHandlers): void {
    this.sessionId = sessionId;
    this.handlers = handlers;
    // Mirrors a capture adapter that opens synchronously (tests that do not
    // care about device-open latency). Pass `announceStart: false` to drive
    // `onStarted` by hand.
    if (this.announceStart) handlers.onStarted(16_000);
  }
  /** Deliberately does NOT drain unless asked: the test decides when the tail is in. */
  stop(sessionId: string): void {
    this.stopped.push(sessionId);
    if (this.eagerDrain) this.drain();
  }
  cancel(sessionId: string): void {
    this.cancelled.push(sessionId);
  }
  /** Test seam for the silence gate. `null` / sub-chunk is `no_audio` and now gates. */
  buffer: Uint8Array | null = null;
  getUtteranceBuffer(): Uint8Array | null {
    return this.buffer;
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

  readonly mutes: string[] = [];
  insert(text: string): Promise<InsertOutcome> {
    this.inserted.push(text);
    return Promise.resolve(this.outcome);
  }
  copy(): void {
    throw new Error('the clipboard is written only on an explicit user action');
  }
  muteOutput(): void {
    this.mutes.push('mute');
  }
  unmuteOutput(): void {
    this.mutes.push('unmute');
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
  hotkeyListener:
    ((action: 'ptt_down' | 'ptt_up' | 'toggle' | 'retry_insert', ts: number) => void) | null = null;

  onHotkey(
    listener: (action: 'ptt_down' | 'ptt_up' | 'toggle' | 'retry_insert', ts: number) => void,
  ): () => void {
    this.hotkeyListener = listener;
    return () => {
      this.hotkeyListener = null;
    };
  }

  fireHotkey(action: 'ptt_down' | 'ptt_up' | 'toggle' | 'retry_insert', ts = 1): void {
    this.hotkeyListener?.(action, ts);
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

class ArchivingHistory extends MemoryHistory {
  readonly files = new Map<string, Uint8Array>();
  archiveAudio(id: string, pcm: Uint8Array): string | null {
    if (pcm.byteLength === 0) return null;
    const rel = `recordings/${id}.wav`;
    this.files.set(rel, pcm);
    return rel;
  }
}

interface Harness {
  orchestrator: Orchestrator;
  audio: ScriptedAudio;
  stt: ScriptedStt;
  helper: StubHelper;
  hud: MemoryHud;
  history: MemoryHistory;
  sound: MemorySound;
}

const live: Orchestrator[] = [];

afterEach(() => {
  for (const orchestrator of live.splice(0)) orchestrator.dispose();
  clearLogSinks();
});

function harness(
  options: {
    eagerDrain?: boolean;
    announceStart?: boolean;
    config?: Partial<AppConfig>;
    unmuteBeforeCueMs?: number;
    env?: MachineEnv;
    history?: MemoryHistory;
  } = {},
): Harness {
  const audio = new ScriptedAudio(options.eagerDrain ?? false, options.announceStart ?? true);
  const stt = new ScriptedStt();
  const helper = new StubHelper();
  const hud = new MemoryHud();
  const history = options.history ?? new MemoryHistory();
  const sound = new MemorySound();
  const config = new MemoryConfig(options.config);
  const orchestrator = new Orchestrator({
    native: helper,
    audio,
    stt,
    hud,
    tray: new MemoryTray(),
    sound,
    history,
    config,
    logger: createLogger('orchestrator-test'),
    tickIntervalMs: 0,
    muteAfterCueMs: 0,
    unmuteBeforeCueMs: options.unmuteBeforeCueMs ?? 0,
    env: options.env ?? {
      newSessionId: () => randomUUID(),
      now: () => Date.now(),
      minPttHoldMs: () => 0,
      repairSeams: () => config.get().repairSeams,
      liveHudText: () => config.get().liveHudText,
      silenceGate: () => config.get().silenceGate,
      muteWhileRecording: () => config.get().muteWhileRecording,
      insertMethod: () => config.get().insertMethod,
    },
  });
  live.push(orchestrator);
  return { orchestrator, audio, stt, helper, hud, history, sound };
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
    const { orchestrator, audio, stt } = harness({ config: { silenceGate: false } });
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    audio.chunk(pcm(1));
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    audio.chunk(pcm(2)); // the flush
    audio.drain();

    expect(stt.only.sent.map((c) => c[0])).toEqual([1, 2]);
    expect(stt.only.finishes).toBe(1);
  });

  it('finishes exactly once, however many times the drain is reported', () => {
    const { orchestrator, audio, stt } = harness({ config: { silenceGate: false } });
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
    const { orchestrator, stt } = harness({ eagerDrain: true, config: { silenceGate: false } });
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

  it('does not send a HUD frame for an interim the pill will not draw', () => {
    const { orchestrator, hud } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const before = hud.views.length;
    const sessionId = orchestrator.snapshot.ctx.sessionId ?? '';
    orchestrator.dispatch({ type: 'TRANSCRIPT_INTERIM', sessionId, text: 'hallo' });
    orchestrator.dispatch({ type: 'TRANSCRIPT_INTERIM', sessionId, text: 'hallo du' });

    expect(hud.views.length).toBe(before);
    expect(hud.last).toMatchObject({ kind: 'recording', interim: '' });
    expect(orchestrator.snapshot.ctx.interim).toBe('hallo du');
  });

  it('does not swallow the transition out of recording', () => {
    const { orchestrator, audio, hud } = harness({ config: { silenceGate: false } });
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
    const h = harness({ config: { silenceGate: false } });
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
    const h = harness({ config: { silenceGate: false } });
    for (let n = 0; n < 5; n += 1) completeOneDictation(h);
    expect(h.stt.turns).toHaveLength(5);

    h.orchestrator.dispose();
    expect(h.stt.turns.every((turn) => turn.aborts === 0)).toBe(true);
  });
});

describe('mute around recording (2026-08-22)', () => {
  it('mutes after capture start and unmutes on every exit', () => {
    const { orchestrator, helper } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    expect(helper.mutes).toEqual(['mute']);
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    expect(helper.mutes).toEqual(['mute', 'unmute']);
  });

  it('unmutes on cancel even if mute never ran', () => {
    const { orchestrator, helper } = harness();
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'CANCEL' });
    expect(helper.mutes.at(-1)).toBe('unmute');
  });

  it('does not let a delayed stop land on top of an error', () => {
    // A dead microphone: PTT_UP schedules `stop` 25 ms after unmute, then
    // TURN_ENDED with no words fires `error`. Playing both is the chord.
    vi.useFakeTimers();
    const { orchestrator, sound } = harness({ unmuteBeforeCueMs: 30 });
    try {
      orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
      const sessionId = orchestrator.snapshot.ctx.sessionId ?? '';
      orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
      expect(sound.cues).toEqual(['start']);

      orchestrator.dispatch({ type: 'TURN_ENDED', sessionId, durationSec: 0 });
      expect(sound.cues).toEqual(['start']);

      vi.advanceTimersByTime(30);
      expect(sound.cues).toEqual(['start', 'error']);

      vi.advanceTimersByTime(30);
      expect(sound.cues).toEqual(['start', 'error']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('still plays stop after unmute when the turn did not fail', () => {
    vi.useFakeTimers();
    const { orchestrator, sound } = harness({ unmuteBeforeCueMs: 30 });
    try {
      orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
      orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
      expect(sound.cues).toEqual(['start']);
      vi.advanceTimersByTime(30);
      expect(sound.cues).toEqual(['start', 'stop']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('plays the start cue when the device opens, not when capture is requested', () => {
    const { orchestrator, audio, sound, helper } = harness({ announceStart: false });
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    expect(sound.cues).toEqual([]);
    expect(helper.mutes).toEqual([]);
    audio.handlers?.onStarted(16_000);
    expect(sound.cues).toEqual(['start']);
    expect(helper.mutes).toEqual(['mute']);
  });

  it('does not play a late start cue after cancel', () => {
    const { orchestrator, audio, sound } = harness({ announceStart: false });
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'CANCEL' });
    audio.handlers?.onStarted(16_000);
    expect(sound.cues).toEqual([]);
  });
});

describe('silence gate at drain (2026-08-22)', () => {
  it('cancels a sub-threshold FN tap before processing', () => {
    let now = 1_000_000;
    const { orchestrator, stt, hud } = harness({
      env: {
        newSessionId: () => randomUUID(),
        now: () => now,
        minPttHoldMs: () => 200,
        repairSeams: () => true,
        liveHudText: () => false,
        silenceGate: () => true,
        muteWhileRecording: () => true,
        insertMethod: () => 'auto',
      },
    });
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    now += 100;
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    expect(orchestrator.snapshot.state).toBe('idle');
    expect(hud.last).toEqual({ kind: 'hidden' });
    expect(hud.views.some((v) => v.kind === 'processing')).toBe(false);
    expect(hud.views.some((v) => v.kind === 'error')).toBe(false);
    expect(stt.only.aborts).toBeGreaterThanOrEqual(1);
    expect(stt.only.finishes).toBe(0);
  });

  it('skips STT finish on a short silent utterance and hides the HUD without an error', () => {
    const { orchestrator, audio, stt, hud } = harness();
    audio.buffer = new Uint8Array(CHUNK_BYTES);
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    audio.drain();
    expect(stt.only.finishes).toBe(0);
    expect(stt.only.aborts).toBe(1);
    expect(orchestrator.snapshot.state).toBe('idle');
    expect(hud.last).toEqual({ kind: 'hidden' });
  });

  it('does not gate once any partial with text has arrived', () => {
    const { orchestrator, audio, stt } = harness();
    audio.buffer = new Uint8Array(0);
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const sessionId = orchestrator.snapshot.ctx.sessionId ?? '';
    orchestrator.dispatch({ type: 'TRANSCRIPT_INTERIM', sessionId, text: 'yes' });
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    audio.drain();
    expect(stt.only.finishes).toBe(1);
    expect(stt.only.aborts).toBe(0);
  });
});

describe('W0 timing channel', () => {
  it('emits key=value lines for a synthetic session without transcript text', () => {
    const lines: string[] = [];
    addLogSink((_line, record) => {
      if (record.msg.startsWith('timing ')) lines.push(record.msg);
    });
    const { orchestrator, audio } = harness();
    audio.buffer = new Uint8Array(64).fill(1);
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const sessionId = orchestrator.snapshot.ctx.sessionId ?? '';
    audio.handlers?.onStarted(16_000);
    audio.chunk(new Uint8Array(64).fill(1));
    orchestrator.dispatch({
      type: 'TRANSCRIPT_INTERIM',
      sessionId,
      text: 'secret words that must not leak',
    });
    orchestrator.dispatch({ type: 'PTT_UP', ts: 2 });
    audio.drain();

    const joined = lines.join('\n');
    expect(joined).toContain('event=hotkey_down');
    expect(joined).toContain('event=capture_requested');
    expect(joined).toContain('event=device_open');
    expect(joined).toContain('event=first_pcm_main');
    expect(joined).toContain('event=hotkey_up');
    expect(joined).not.toContain('secret words');
    expect(joined).not.toContain('must not leak');
  });
});

describe('STT model from config', () => {
  it('passes sttModel into startTurn', () => {
    const { orchestrator, stt } = harness({ config: { sttModel: 'grok-stt-2-fast' } });
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    expect(stt.only.options.model).toBe('grok-stt-2-fast');
  });
});

describe('error HUD dismiss (click / FN)', () => {
  it('dismissHud hides and lets the same error show again', () => {
    const { orchestrator, hud } = harness();
    orchestrator.reportError('auth_missing', 'Not signed in.', 'Open Settings.');
    expect(hud.last).toMatchObject({ kind: 'error', message: 'Not signed in.' });
    const shown = hud.views.filter((view) => view.kind === 'error').length;
    orchestrator.dismissHud();
    expect(hud.last).toEqual({ kind: 'hidden' });
    orchestrator.reportError('auth_missing', 'Not signed in.', 'Open Settings.');
    expect(hud.last).toMatchObject({ kind: 'error', message: 'Not signed in.' });
    expect(hud.views.filter((view) => view.kind === 'error').length).toBe(shown + 1);
  });

  it('dismissHud is idempotent', () => {
    const { orchestrator, hud } = harness();
    orchestrator.reportError('auth_missing', 'Not signed in.', null);
    orchestrator.dismissHud();
    const n = hud.views.length;
    orchestrator.dismissHud();
    expect(hud.views.length).toBe(n);
  });

  it('FN while the error is up starts a recording', () => {
    const { orchestrator, helper, hud, audio } = harness();
    orchestrator.start();
    orchestrator.reportError('auth_missing', 'Not signed in.', null);
    helper.fireHotkey('ptt_down', 10);
    expect(orchestrator.snapshot.state).toBe('recording');
    expect(audio.sessionId).not.toBeNull();
    expect(hud.last).toMatchObject({ kind: 'recording' });
  });

  it('toggle FN while the error is up starts hands-free', () => {
    const { orchestrator, helper, audio } = harness();
    orchestrator.start();
    orchestrator.reportError('auth_missing', 'Not signed in.', null);
    helper.fireHotkey('toggle', 10);
    expect(orchestrator.snapshot.state).toBe('recording');
    expect(orchestrator.snapshot.ctx.mode).toBe('toggle');
    expect(audio.sessionId).not.toBeNull();
  });

  it('clicking the pill still dismisses without starting', () => {
    const { orchestrator, hud, audio } = harness();
    orchestrator.start();
    orchestrator.reportError('auth_missing', 'Not signed in.', null);
    orchestrator.dismissHud();
    expect(hud.last).toEqual({ kind: 'hidden' });
    expect(orchestrator.snapshot.state).toBe('idle');
    expect(audio.sessionId).toBeNull();
  });
});

describe('live interim stays off the HUD', () => {
  it('keeps the recording capsule wordless even if a leftover config asks for preview', () => {
    const { orchestrator, hud } = harness({ config: { liveHudText: true } });
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const sessionId = orchestrator.snapshot.ctx.sessionId ?? '';
    orchestrator.dispatch({ type: 'TRANSCRIPT_INTERIM', sessionId, text: 'hello there' });
    expect(hud.last).toMatchObject({ kind: 'recording', interim: '' });
    expect(orchestrator.snapshot.ctx.interim).toBe('hello there');
  });
});

describe('Esc archives audio then stores a cancelled history row', () => {
  it('writes a sidecar and a cancelled row when PCM exists', () => {
    const history = new ArchivingHistory();
    const { orchestrator, audio } = harness({ history });
    audio.buffer = new Uint8Array(CHUNK_BYTES).fill(7);
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'CANCEL' });

    expect(orchestrator.snapshot.state).toBe('idle');
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      cancelled: true,
      inserted: false,
      text: '',
    });
    expect(history.entries[0]?.audioRelPath).toMatch(/^recordings\/.+\.wav$/);
    expect(history.files.get(history.entries[0]?.audioRelPath ?? '')?.byteLength).toBe(CHUNK_BYTES);
    expect(audio.cancelled).toHaveLength(1);
  });

  it('stores nothing when there was no PCM', () => {
    const history = new ArchivingHistory();
    const { orchestrator } = harness({ history });
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    orchestrator.dispatch({ type: 'CANCEL' });
    expect(history.entries).toHaveLength(0);
  });

  it('archives PCM on a session error even with no text yet', () => {
    const history = new ArchivingHistory();
    const { orchestrator, audio } = harness({ history });
    audio.buffer = new Uint8Array(CHUNK_BYTES).fill(3);
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: 1 });
    const sessionId = orchestrator.snapshot.ctx.sessionId ?? '';
    orchestrator.dispatch({
      type: 'SESSION_ERROR',
      sessionId,
      error: { code: 'stt_connect', message: 'the socket died', hint: null },
    });
    expect(history.entries).toHaveLength(1);
    expect(history.entries[0]).toMatchObject({
      text: '',
      transcribeError: 'the socket died',
      inserted: false,
    });
    expect(history.entries[0]?.audioRelPath).toMatch(/^recordings\/.+\.wav$/);
  });
});
