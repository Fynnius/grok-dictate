import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MainToRenderer, RendererToMain } from '@contracts/events.js';
import type { AudioHandlers } from '@contracts/ports.js';
import { CHUNK_BYTES, SAMPLE_RATE_HZ } from '@shared/constants.js';
import {
  addLogSink,
  clearLogSinks,
  createLogger,
  setLogLevel,
  type LogRecord,
} from '@shared/logger.js';
import { appError, type AppError } from '@shared/result.js';
import { CaptureCoordinator } from './coordinator.js';

class Recorder implements AudioHandlers {
  readonly chunks: Uint8Array[] = [];
  readonly levels: number[] = [];
  readonly errors: AppError[] = [];
  readonly started: number[] = [];
  drained = 0;

  onDrained(): void {
    this.drained++;
  }
  onChunk(pcm: Uint8Array): void {
    this.chunks.push(pcm);
  }
  onLevel(level: number): void {
    this.levels.push(level);
  }
  onError(error: AppError): void {
    this.errors.push(error);
  }
  onStarted(actualSampleRate: number): void {
    this.started.push(actualSampleRate);
  }
}

const sent: MainToRenderer[] = [];
const records: LogRecord[] = [];

function coordinator(
  options: {
    checkPermission?: () => AppError | null;
    maxBufferBytes?: number;
    drainTimeoutMs?: number;
  } = {},
) {
  return new CaptureCoordinator({
    transport: {
      send: (message) => {
        sent.push(message);
      },
    },
    logger: createLogger('test'),
    ...options,
  });
}

const chunk = (fill: number, bytes = CHUNK_BYTES): RendererToMain => ({
  type: 'capture-chunk',
  sessionId: 's1',
  pcm: new Uint8Array(bytes).fill(fill).buffer,
});

beforeEach(() => {
  sent.length = 0;
  records.length = 0;
  clearLogSinks();
  setLogLevel('debug');
  addLogSink((_line, record) => {
    records.push(record);
  });
});

afterEach(() => {
  clearLogSinks();
});

describe('starting and stopping', () => {
  it('asks the renderer for 16 kHz / 3200-byte chunks', () => {
    coordinator().start('s1', new Recorder());
    expect(sent).toEqual([
      {
        type: 'capture-start',
        sessionId: 's1',
        sampleRate: SAMPLE_RATE_HZ,
        chunkBytes: CHUNK_BYTES,
      },
    ]);
  });

  it('stops the previous capture when a press supersedes a press', () => {
    const audio = coordinator();
    audio.start('s1', new Recorder());
    sent.length = 0;
    audio.start('s2', new Recorder());
    expect(sent).toEqual([
      { type: 'capture-stop', sessionId: 's1' },
      {
        type: 'capture-start',
        sessionId: 's2',
        sampleRate: SAMPLE_RATE_HZ,
        chunkBytes: CHUNK_BYTES,
      },
    ]);
  });

  it('never opens the device when the microphone is already denied', async () => {
    const denied = appError('audio_permission', 'not allowed', 'grant it in System Settings');
    const handlers = new Recorder();
    coordinator({ checkPermission: () => denied }).start('s1', handlers);

    // The renderer is not even asked: opening a device that cannot work would
    // light the orange indicator for nothing.
    expect(sent).toHaveLength(0);
    await Promise.resolve();
    expect(handlers.errors).toEqual([denied]);
  });

  it('closes the device on stop and on cancel', () => {
    const audio = coordinator();
    audio.start('s1', new Recorder());
    audio.stop('s1');
    expect(sent.at(-1)).toEqual({ type: 'capture-stop', sessionId: 's1' });

    sent.length = 0;
    audio.start('s2', new Recorder());
    audio.cancel('s2');
    expect(sent.at(-1)).toEqual({ type: 'capture-stop', sessionId: 's2' });
  });

  it('ignores stop for a session that is not the live one', () => {
    const audio = coordinator();
    audio.start('s1', new Recorder());
    sent.length = 0;
    audio.stop('an-older-session');
    expect(sent).toHaveLength(0);
  });
});

describe('draining the tail after stop (2026-08-09 incident, BUG-2)', () => {
  /**
   * The renderer flushes its encoder tail as a final `capture-chunk` *after* it
   * is told to stop — "the last 100 ms of a hold is the end of the last word".
   * `stop()` used to drop the session on the spot, so that chunk was discarded
   * on every dictation and the last ~100–300 ms of every utterance never
   * reached the server or the full-utterance buffer.
   */
  const drained = (sessionId = 's1'): RendererToMain => ({ type: 'capture-drained', sessionId });

  it('still accepts the tail chunk that arrives after capture-stop', () => {
    const audio = coordinator();
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.handleRendererMessage(chunk(1));

    audio.stop('s1');
    // The renderer's flush lands here, one IPC hop after `capture-stop`.
    audio.handleRendererMessage(chunk(2));
    audio.handleRendererMessage(drained());

    expect(handlers.chunks).toHaveLength(2);
    expect(audio.getUtteranceBuffer('s1')?.byteLength).toBe(CHUNK_BYTES * 2);
    // …and the tail is the *end* of the buffer, in order.
    expect(audio.getUtteranceBuffer('s1')?.[CHUNK_BYTES]).toBe(2);
  });

  it('reports the drain exactly once, and only after the ack', () => {
    const audio = coordinator();
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.stop('s1');
    expect(handlers.drained).toBe(0);

    audio.handleRendererMessage(drained());
    expect(handlers.drained).toBe(1);
    // A duplicate ack, or one racing the timeout, must not fire it twice: the
    // turn is ended from this callback.
    audio.handleRendererMessage(drained());
    expect(handlers.drained).toBe(1);
  });

  it('closes the session once drained, so a later chunk cannot reopen it', () => {
    const audio = coordinator();
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.stop('s1');
    audio.handleRendererMessage(drained());
    audio.handleRendererMessage(chunk(3));

    expect(handlers.chunks).toHaveLength(0);
  });

  it('gives up on a renderer that never acknowledges, and says so', async () => {
    // A dead or wedged capture window must not be able to hang a turn: the
    // dictation is held open until the drain completes, so this timer is the
    // only thing between it and a session parked in `processing` for ever.
    const audio = coordinator({ drainTimeoutMs: 20 });
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.stop('s1');

    await new Promise((r) => setTimeout(r, 60));
    expect(handlers.drained).toBe(1);
    expect(records.some((r) => r.msg.includes('did not acknowledge the tail'))).toBe(true);

    // …and the late ack that finally turns up changes nothing.
    audio.handleRendererMessage(drained());
    expect(handlers.drained).toBe(1);
  });

  it('does not wait for a drain on cancel — the audio is being thrown away', () => {
    const audio = coordinator({ drainTimeoutMs: 10_000 });
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.cancel('s1');

    expect(handlers.drained).toBe(1);
    expect(sent.at(-1)).toEqual({ type: 'capture-stop', sessionId: 's1' });
  });

  it('releases a draining session when a new press supersedes it', () => {
    // Otherwise the old session's waiter sits until the timeout while the new
    // recording is already running.
    const audio = coordinator({ drainTimeoutMs: 10_000 });
    const first = new Recorder();
    audio.start('s1', first);
    audio.stop('s1');
    audio.start('s2', new Recorder());

    expect(first.drained).toBe(1);
    // The second `capture-stop` is not sent: the renderer already had one.
    expect(sent.filter((m) => m.type === 'capture-stop')).toHaveLength(1);
  });

  it('does not drain twice when stop is called twice', () => {
    const audio = coordinator({ drainTimeoutMs: 10_000 });
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.stop('s1');
    audio.stop('s1');
    audio.handleRendererMessage(drained());

    expect(handlers.drained).toBe(1);
    expect(sent.filter((m) => m.type === 'capture-stop')).toHaveLength(1);
  });
});

describe('the full-utterance buffer', () => {
  it('accumulates every chunk and survives stop', () => {
    const audio = coordinator();
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.handleRendererMessage(chunk(1));
    audio.handleRendererMessage(chunk(2));
    audio.stop('s1');

    const buffer = audio.getUtteranceBuffer('s1');
    expect(buffer?.byteLength).toBe(CHUNK_BYTES * 2);
    expect(buffer?.[0]).toBe(1);
    expect(buffer?.[CHUNK_BYTES]).toBe(2);
    // …and the chunks reached the STT client as they arrived.
    expect(handlers.chunks).toHaveLength(2);
  });

  it('returns null for a session it never saw', () => {
    expect(coordinator().getUtteranceBuffer('nope')).toBeNull();
  });

  it('frees the audio on cancel rather than archiving it', () => {
    // Phase 3 kept the bytes in a single-slot archive for a
    // retry-after-network-failure that was never built; Phase 5 deleted it
    // (docs/phase-3-report.md §5.3). An Esc-cancelled utterance must not sit in
    // RAM waiting for a feature —  applies to memory too.
    const audio = coordinator();
    audio.start('s1', new Recorder());
    audio.handleRendererMessage(chunk(9));
    audio.cancel('s1');

    expect(audio.getUtteranceBuffer('s1')).toBeNull();
    expect('retainedUtterance' in audio).toBe(false);
  });

  it('stops growing at the cap and says so once', () => {
    const audio = coordinator({ maxBufferBytes: CHUNK_BYTES });
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.handleRendererMessage(chunk(1));
    audio.handleRendererMessage(chunk(2));
    audio.handleRendererMessage(chunk(3));

    // The beginning is kept: the recording cap ends the turn here anyway.
    expect(audio.getUtteranceBuffer('s1')?.byteLength).toBe(CHUNK_BYTES);
    // The STT client still receives everything — only retention is bounded.
    expect(handlers.chunks).toHaveLength(3);
    expect(records.filter((r) => r.msg.includes('buffer full'))).toHaveLength(1);
  });

  it('holds 90 seconds of continuous speech without dropping or truncating', () => {
    // Partial cover for human test HT-4, which the user declined to run on the
    // grounds that Phase 1's spike 4 already streamed 15 minutes. That spike
    // streamed a *file* through `scripts/probe-stt.ts`; it says nothing about
    // this buffer. What is verified here is the memory side — 90 s stays well
    // inside `MAX_UTTERANCE_BUFFER_BYTES` and every chunk is retained in order.
    // What remains unverified is sustained live capture from a real device; see
    // docs/phase-3-report.md.
    const audio = coordinator();
    const handlers = new Recorder();
    audio.start('s1', handlers);
    for (let i = 0; i < 900; i++) {
      audio.handleRendererMessage(chunk(i % 251));
    }
    audio.stop('s1');

    const buffer = audio.getUtteranceBuffer('s1');
    expect(buffer?.byteLength).toBe(CHUNK_BYTES * 900); // 90 s at 32 KB/s ≈ 2.9 MB
    expect(handlers.chunks).toHaveLength(900);
    expect(records.some((r) => r.msg.includes('buffer full'))).toBe(false);
    // In order: the 500th chunk carries its own marker byte.
    expect(buffer?.[CHUNK_BYTES * 500]).toBe(500 % 251);
  });

  it('holds at most two utterances, so a long session does not leak', () => {
    const audio = coordinator();
    for (const id of ['s1', 's2', 's3']) {
      audio.start(id, new Recorder());
      audio.handleRendererMessage({ ...chunk(1), sessionId: id } as RendererToMain);
      audio.stop(id);
    }
    expect(audio.getUtteranceBuffer('s1')).toBeNull();
    expect(audio.getUtteranceBuffer('s2')).not.toBeNull();
    expect(audio.getUtteranceBuffer('s3')).not.toBeNull();
  });
});

describe('messages from the renderer', () => {
  it('routes level, started and error to the live session', () => {
    const audio = coordinator();
    const handlers = new Recorder();
    audio.start('s1', handlers);

    audio.handleRendererMessage({
      type: 'capture-started',
      sessionId: 's1',
      actualSampleRate: 16_000,
    });
    audio.handleRendererMessage({ type: 'capture-level', sessionId: 's1', level: 0.42 });
    expect(handlers.started).toEqual([16_000]);
    expect(handlers.levels).toEqual([0.42]);

    const error = appError('audio_device', 'gone', 'plug it back in');
    audio.handleRendererMessage({ type: 'capture-error', sessionId: 's1', error });
    expect(handlers.errors).toEqual([error]);
  });

  it('drops everything from a superseded session', () => {
    // `pipeline.rs:50-63` — a superseded session's trailing frames must never
    // land on the new one.
    const audio = coordinator();
    const first = new Recorder();
    const second = new Recorder();
    audio.start('s1', first);
    audio.start('s2', second);

    audio.handleRendererMessage(chunk(1)); // sessionId 's1'
    audio.handleRendererMessage({ type: 'capture-level', sessionId: 's1', level: 1 });
    expect(first.chunks).toHaveLength(0);
    expect(second.chunks).toHaveLength(0);
    expect(second.levels).toHaveLength(0);
  });

  it('warns when the AudioContext refused 16 kHz (assumption 10.4)', () => {
    const audio = coordinator();
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.handleRendererMessage({
      type: 'capture-started',
      sessionId: 's1',
      actualSampleRate: 48_000,
    });

    expect(handlers.started).toEqual([48_000]);
    expect(records.some((r) => r.msg.includes('did not run at 16 kHz'))).toBe(true);
  });

  it('treats a second capture-started as a mid-hold device change, not a new start', () => {
    // : AirPods connecting mid-utterance. The renderer
    // re-announces the device; the session must not restart.
    const audio = coordinator();
    const handlers = new Recorder();
    audio.start('s1', handlers);
    audio.handleRendererMessage({
      type: 'capture-started',
      sessionId: 's1',
      actualSampleRate: 16_000,
    });
    audio.handleRendererMessage({
      type: 'capture-started',
      sessionId: 's1',
      actualSampleRate: 16_000,
    });

    expect(handlers.started).toHaveLength(1);
    expect(records.some((r) => r.msg.includes('device restarted mid-session'))).toBe(true);
  });

  it('leaves non-capture messages alone', () => {
    const audio = coordinator();
    expect(audio.handleRendererMessage({ type: 'cancel' })).toBe(false);
    expect(audio.handleRendererMessage({ type: 'copy', text: 'x' })).toBe(false);
    expect(audio.handleRendererMessage(chunk(1))).toBe(true);
  });
});
