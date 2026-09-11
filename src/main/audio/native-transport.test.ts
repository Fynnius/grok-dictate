import { afterEach, describe, expect, it } from 'vitest';
import type { RendererToMain } from '@contracts/events.js';
import type { AudioHandlers } from '@contracts/ports.js';
import { CHUNK_BYTES, SAMPLE_RATE_HZ } from '@shared/constants.js';
import { createLogger } from '@shared/logger.js';
import type { AppError } from '@shared/result.js';
import { CaptureCoordinator } from './coordinator.js';
import { NativeCaptureTransport, type CaptureChild } from './native-transport.js';

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

class FakeChild implements CaptureChild {
  readonly written: string[] = [];
  readonly stdin = {
    destroyed: false,
    write: (data: string): boolean => {
      this.written.push(data);
      return true;
    },
    end: (): void => {
      this.stdin.destroyed = true;
    },
  };
  readonly #stdout = new Set<(chunk: string) => void>();
  readonly #stderr = new Set<(chunk: string) => void>();
  readonly #exit = new Set<(code: number | null, signal: NodeJS.Signals | null) => void>();
  readonly #errors = new Set<(error: Error) => void>();

  readonly stdout = {
    setEncoding: (_encoding: 'utf8'): void => undefined,
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.#stdout.add(listener);
    },
  };
  readonly stderr = {
    setEncoding: (_encoding: 'utf8'): void => undefined,
    on: (_event: 'data', listener: (chunk: string) => void): void => {
      this.#stderr.add(listener);
    },
  };

  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  on(
    event: 'exit' | 'error',
    listener:
      ((code: number | null, signal: NodeJS.Signals | null) => void) | ((error: Error) => void),
  ): void {
    if (event === 'exit') {
      this.#exit.add(listener as (code: number | null, signal: NodeJS.Signals | null) => void);
      return;
    }
    this.#errors.add(listener as (error: Error) => void);
  }

  emitFrame(frame: unknown): void {
    const line = `${JSON.stringify(frame)}\n`;
    for (const listener of this.#stdout) listener(line);
  }

  emitExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    for (const listener of this.#exit) listener(code, signal);
  }

  emitError(error: Error): void {
    for (const listener of this.#errors) listener(error);
  }

  kill(_signal?: NodeJS.Signals): boolean {
    this.emitExit(0, null);
    return true;
  }
}

const running: NativeCaptureTransport[] = [];

afterEach(async () => {
  for (const transport of running.splice(0)) await transport.stop(50);
});

function wire(spawn: () => CaptureChild): {
  transport: NativeCaptureTransport;
  coordinator: CaptureCoordinator;
} {
  const transport = new NativeCaptureTransport({
    command: '/capture',
    logger: createLogger('test'),
    spawn,
    restartBaseMs: 5,
    restartMaxMs: 10,
  });
  const coordinator = new CaptureCoordinator({
    transport,
    logger: createLogger('test'),
    drainTimeoutMs: 40,
  });
  transport.attach((message) => coordinator.handleRendererMessage(message));
  transport.start();
  running.push(transport);
  return { transport, coordinator };
}

describe('NativeCaptureTransport', () => {
  it('start delivers started and chunks to the coordinator handlers', () => {
    const child = new FakeChild();
    const { coordinator } = wire(() => child);
    const handlers = new Recorder();
    coordinator.start('s1', handlers);

    expect(child.written.join('')).toContain('"type":"start"');
    expect(child.written.join('')).toContain('"sessionId":"s1"');

    child.emitFrame({ type: 'started', sessionId: 's1', actualSampleRate: 16_000 });
    const pcm = Buffer.alloc(CHUNK_BYTES, 7);
    child.emitFrame({ type: 'chunk', sessionId: 's1', pcm: pcm.toString('base64') });
    child.emitFrame({ type: 'level', sessionId: 's1', level: 0.4 });

    expect(handlers.started).toEqual([16_000]);
    expect(handlers.chunks).toHaveLength(1);
    expect(handlers.chunks[0]?.byteLength).toBe(CHUNK_BYTES);
    expect(handlers.levels).toEqual([0.4]);
  });

  it('stop waits for drained from the process, not a local timer', () => {
    const child = new FakeChild();
    const { coordinator } = wire(() => child);
    const handlers = new Recorder();
    coordinator.start('s1', handlers);
    child.emitFrame({ type: 'started', sessionId: 's1', actualSampleRate: SAMPLE_RATE_HZ });
    coordinator.stop('s1');

    expect(child.written.at(-1)).toContain('"type":"stop"');
    expect(handlers.drained).toBe(0);

    child.emitFrame({ type: 'drained', sessionId: 's1' });
    expect(handlers.drained).toBe(1);
  });

  it('leaves the drain timeout to the coordinator when the process never acks', async () => {
    const child = new FakeChild();
    const { coordinator } = wire(() => child);
    const handlers = new Recorder();
    coordinator.start('s1', handlers);
    coordinator.stop('s1');
    expect(handlers.drained).toBe(0);
    await new Promise((r) => setTimeout(r, 60));
    expect(handlers.drained).toBe(1);
  });

  it('emits capture-error then capture-drained when the process dies mid-session', () => {
    const child = new FakeChild();
    const delivered: RendererToMain[] = [];
    const transport = new NativeCaptureTransport({
      command: '/capture',
      logger: createLogger('test'),
      spawn: () => child,
      restartBaseMs: 5,
      restartMaxMs: 10,
      maxConsecutiveRestarts: 1,
    });
    transport.attach((message) => delivered.push(message));
    transport.start();
    running.push(transport);

    transport.send({
      type: 'capture-start',
      sessionId: 's1',
      sampleRate: SAMPLE_RATE_HZ,
      chunkBytes: CHUNK_BYTES,
      micProcessing: false,
    });
    child.emitExit(1, null);

    expect(delivered.map((m) => m.type)).toEqual(['capture-error', 'capture-drained']);
    expect(delivered[0]).toMatchObject({ type: 'capture-error', sessionId: 's1' });
  });

  it('crash mid-session reaches onError and onDrained through the coordinator', () => {
    const child = new FakeChild();
    const delivered: RendererToMain[] = [];
    const { coordinator, transport } = wire(() => child);
    transport.attach((message) => {
      delivered.push(message);
      coordinator.handleRendererMessage(message);
    });
    const handlers = new Recorder();
    coordinator.start('s1', handlers);
    child.emitExit(1, null);

    expect(handlers.errors).toHaveLength(1);
    expect(handlers.errors[0]?.code).toBe('audio_device');
    expect(delivered.map((m) => m.type)).toEqual(['capture-error', 'capture-drained']);
    // capture-error clears the session, so the follow-up drained is a no-op
    // at the handler — the deliver stream is what keeps a turn from hanging
    // if the coordinator is already gone.
    expect(handlers.drained).toBe(0);
  });

  it('restarts the process for the next hold after a crash', async () => {
    const children: FakeChild[] = [];
    const { coordinator } = wire(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const first = new Recorder();
    coordinator.start('s1', first);
    expect(children).toHaveLength(1);
    children[0]?.emitExit(1, null);

    await new Promise((r) => setTimeout(r, 30));
    const second = new Recorder();
    coordinator.start('s2', second);
    expect(children.length).toBeGreaterThanOrEqual(2);
    expect(children.at(-1)?.written.join('')).toContain('"sessionId":"s2"');
  });

  it('does not restart-loop on a microphone permission error', async () => {
    const children: FakeChild[] = [];
    wire(() => {
      const child = new FakeChild();
      children.push(child);
      return child;
    });
    const child = children[0];
    expect(child).toBeDefined();
    if (child === undefined) return;
    child.emitFrame({
      type: 'error',
      sessionId: 's1',
      code: 'audio_permission',
      message: 'denied',
      hint: 'grant it',
    });
    child.emitExit(0, null);
    await new Promise((r) => setTimeout(r, 40));
    expect(children).toHaveLength(1);
  });

  it('ignores micProcessing on capture-start', () => {
    const child = new FakeChild();
    const { coordinator } = wire(() => child);
    coordinator.start('s1', new Recorder());
    const sent = child.written.join('');
    expect(sent).toContain('"type":"start"');
    expect(sent).not.toContain('micProcessing');
  });
});
