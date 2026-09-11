/**
 * CaptureTransport that talks to `grok-dictate-capture` over stdin/stdout.
 *
 * Session bookkeeping, the utterance buffer and the drain timer stay in
 * `CaptureCoordinator`. This class only: spawn the process, frame lines,
 * translate `capture-start`/`capture-stop` into the capture protocol, and
 * synthesise renderer-shaped messages the coordinator already handles.
 *
 * The process may be running while idle — spawning is not opening the
 * microphone. The binary prepares the capture graph at launch and opens
 * the device only when it receives `start`.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { MainToRenderer, RendererToMain } from '@contracts/events.js';
import { Backoff } from '@shared/backoff.js';
import type { Logger } from '@shared/logger.js';
import { appError } from '@shared/result.js';
import { LineFramer } from '../bridge/line-framing.js';
import {
  captureFrameToRenderer,
  encodeCaptureCommand,
  parseCaptureFrame,
  type AppToCapture,
} from './capture-protocol.js';
import type { CaptureTransport } from './coordinator.js';

const MAX_PENDING = 16;

export interface CaptureChild {
  stdin: { write(data: string): boolean; destroyed: boolean; end(): void };
  stdout: {
    setEncoding(encoding: 'utf8'): void;
    on(event: 'data', listener: (chunk: string) => void): void;
  };
  stderr: {
    setEncoding(encoding: 'utf8'): void;
    on(event: 'data', listener: (chunk: string) => void): void;
  };
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export type CaptureSpawn = (command: string) => CaptureChild;

export interface NativeCaptureTransportOptions {
  readonly command: string;
  readonly logger: Logger;
  readonly spawn?: CaptureSpawn;
  readonly restartBaseMs?: number;
  readonly restartMaxMs?: number;
  readonly maxConsecutiveRestarts?: number;
}

function defaultSpawn(command: string): CaptureChild {
  return spawn(command, [], { stdio: ['pipe', 'pipe', 'pipe'] }) as ChildProcessWithoutNullStreams;
}

export class NativeCaptureTransport implements CaptureTransport {
  readonly #command: string;
  readonly #log: Logger;
  readonly #spawn: CaptureSpawn;
  readonly #framer = new LineFramer();
  readonly #backoff: Backoff;
  readonly #maxConsecutiveRestarts: number;

  #child: CaptureChild | null = null;
  #deliver: ((message: RendererToMain) => void) | null = null;
  #pending: AppToCapture[] = [];
  #sessionId: string | null = null;
  #draining = false;
  #stopping = false;
  #restartTimer: NodeJS.Timeout | null = null;
  #consecutiveFailures = 0;
  #permissionDenied = false;

  constructor(options: NativeCaptureTransportOptions) {
    this.#command = options.command;
    this.#log = options.logger.child('audio.native');
    this.#spawn = options.spawn ?? defaultSpawn;
    this.#backoff = new Backoff({
      baseMs: options.restartBaseMs ?? 250,
      maxMs: options.restartMaxMs ?? 10_000,
    });
    this.#maxConsecutiveRestarts = options.maxConsecutiveRestarts ?? 10;
  }

  attach(deliver: (message: RendererToMain) => void): void {
    this.#deliver = deliver;
  }

  /** Spawn the process without opening the microphone. */
  start(): void {
    this.#stopping = false;
    this.#ensureChild();
  }

  send(message: MainToRenderer): void {
    if (message.type === 'capture-start') {
      this.#sessionId = message.sessionId;
      this.#draining = false;
      this.#permissionDenied = false;
      this.#write({
        type: 'start',
        sessionId: message.sessionId,
        sampleRate: message.sampleRate,
        chunkBytes: message.chunkBytes,
      });
      return;
    }
    if (message.type === 'capture-stop') {
      this.#draining = true;
      this.#write({ type: 'stop', sessionId: message.sessionId });
    }
  }

  async stop(timeoutMs = 2000): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (child === null) return;

    child.stdin.end();

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(termTimer);
        resolve();
      };
      const termTimer = setTimeout(() => child.kill('SIGTERM'), timeoutMs / 2);
      const hardTimer = setTimeout(() => {
        child.kill('SIGKILL');
        done();
      }, timeoutMs);
      child.on('exit', done);
    });
    this.#child = null;
  }

  #write(command: AppToCapture): void {
    this.#ensureChild();
    const child = this.#child;
    if (child === null || child.stdin.destroyed) {
      if (this.#pending.length >= MAX_PENDING) this.#pending.shift();
      this.#pending.push(command);
      this.#log.debug('queued a capture command until the process starts', { type: command.type });
      return;
    }
    child.stdin.write(encodeCaptureCommand(command));
  }

  #ensureChild(): void {
    if (this.#stopping) return;
    if (this.#child !== null) return;
    this.#framer.reset();

    this.#log.info('starting capture process', { command: this.#command });
    let child: CaptureChild;
    try {
      child = this.#spawn(this.#command);
    } catch (cause) {
      this.#log.error('failed to spawn capture process', { err: cause });
      this.#onChildGone();
      this.#scheduleRestart();
      return;
    }
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of this.#framer.feed(chunk)) this.#handleLine(line);
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trimEnd();
      if (text.length === 0) return;
      // `engine start N ms (warm|cold)` is a successful diagnostic, not a fault.
      if (/engine start \d+ ms/.test(text)) this.#log.info('capture', { text });
      else this.#log.warn('capture stderr', { text });
    });

    let settled = false;
    const settle = (report: () => void): void => {
      if (settled) return;
      settled = true;
      this.#child = null;
      report();
    };

    child.on('error', (error) => {
      settle(() => {
        this.#log.error('the capture process could not be started', { err: error });
        this.#onChildGone();
        if (!this.#stopping) this.#scheduleRestart();
      });
    });

    child.on('exit', (code, signal) => {
      for (const line of this.#framer.flush()) this.#handleLine(line);
      settle(() => {
        if (this.#stopping) {
          this.#log.info('capture process exited during shutdown', { code, signal });
          return;
        }
        this.#log.error('capture process exited unexpectedly', { code, signal });
        this.#onChildGone();
        this.#scheduleRestart();
      });
    });

    const queued = this.#pending.splice(0);
    for (const command of queued) child.stdin.write(encodeCaptureCommand(command));
  }

  #handleLine(line: string): void {
    const parsed = parseCaptureFrame(line);
    if (!parsed.ok) {
      this.#log.warn('discarding malformed capture frame', {
        reason: parsed.error.message,
        raw: line.slice(0, 200),
      });
      return;
    }

    this.#consecutiveFailures = 0;
    this.#backoff.reset();

    if (parsed.value.type === 'error' && parsed.value.code === 'audio_permission') {
      // Stay up and wait for the next hold. Restarting cannot grant TCC.
      this.#permissionDenied = true;
    }
    if (parsed.value.type === 'drained' && parsed.value.sessionId === this.#sessionId) {
      this.#sessionId = null;
      this.#draining = false;
    }

    const message = captureFrameToRenderer(parsed.value);
    if (message === null) {
      this.#log.warn('discarding a capture chunk that was not valid base64');
      return;
    }
    this.#deliver?.(message);
  }

  /**
   * The process died under a live session. Emit error then drained so the turn
   * cannot hang — the coordinator's drain timer is the other backstop, but a
   * crash mid-hold has no tail to wait for.
   */
  #onChildGone(): void {
    const sessionId = this.#sessionId;
    if (sessionId === null) return;
    this.#sessionId = null;
    const draining = this.#draining;
    this.#draining = false;

    if (!draining) {
      this.#deliver?.({
        type: 'capture-error',
        sessionId,
        error: appError(
          'audio_device',
          'The microphone capture process stopped unexpectedly.',
          'Try dictating again. If it keeps happening, rebuild the capture binary with `./native/build.sh`.',
        ),
      });
    }
    this.#deliver?.({ type: 'capture-drained', sessionId });
  }

  #scheduleRestart(): void {
    if (this.#stopping) return;
    if (this.#permissionDenied) {
      this.#log.warn('not restarting the capture process after a microphone permission error');
      return;
    }
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures > this.#maxConsecutiveRestarts) {
      this.#log.error('capture process failed repeatedly; giving up', {
        attempts: this.#consecutiveFailures,
        hint: 'Rebuild the capture binary with `./native/build.sh`, then restart Grok Dictate.',
      });
      return;
    }
    const delay = this.#backoff.next();
    this.#log.warn('restarting capture process', {
      delayMs: delay,
      attempt: this.#consecutiveFailures,
    });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.#ensureChild();
    }, delay);
    this.#restartTimer.unref?.();
  }
}
