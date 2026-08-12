/**
 * Supervises the helper child process: spawn, frame, parse, restart.
 *
 * Owned by Phase 1 (IMPLEMENTATION-PLAN.md §2 — "helper-process supervisor").
 * It knows about *transport*: bytes, lines, restarts, exit codes. It knows
 * nothing about what the frames mean — that is `src/main/native/`, Phase 2.
 *
 * Restart matters more than it looks.  whole theme is that
 * this app's failures are silent: if the helper dies, the Fn key simply stops
 * working with no error anywhere. So a death is logged loudly, retried with
 * backoff, and surfaced to the app rather than absorbed.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  encodeAppFrame,
  parseHelperFrame,
  type AppToHelper,
  type HelperToApp,
} from '@contracts/helper-protocol.js';
import { Backoff } from '@shared/backoff.js';
import { childEnv } from '@shared/env.js';
import type { Logger } from '@shared/logger.js';
import { LineFramer } from './line-framing.js';

export interface HelperSpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
  /** Extra environment for the child. Merged over `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
}

export interface HelperSupervisorOptions {
  readonly spec: HelperSpawnSpec;
  readonly logger: Logger;
  readonly restartBaseMs?: number;
  readonly restartMaxMs?: number;
  /** Give up after this many consecutive failed starts. */
  readonly maxConsecutiveRestarts?: number;
  readonly random?: () => number;
}

export type HelperExitInfo = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly willRestart: boolean;
};

type FrameListener = (frame: HelperToApp) => void;
type ExitListener = (info: HelperExitInfo) => void;

export class HelperSupervisor {
  readonly #options: HelperSupervisorOptions;
  readonly #log: Logger;
  readonly #framer = new LineFramer();
  readonly #backoff: Backoff;
  readonly #frameListeners = new Set<FrameListener>();
  readonly #exitListeners = new Set<ExitListener>();

  #child: ChildProcessWithoutNullStreams | null = null;
  #restartTimer: NodeJS.Timeout | null = null;
  #stopping = false;
  #consecutiveFailures = 0;

  constructor(options: HelperSupervisorOptions) {
    this.#options = options;
    this.#log = options.logger.child('helper');
    this.#backoff = new Backoff({
      baseMs: options.restartBaseMs ?? 250,
      maxMs: options.restartMaxMs ?? 10_000,
      ...(options.random === undefined ? {} : { random: options.random }),
    });
  }

  get isRunning(): boolean {
    return this.#child !== null && this.#child.exitCode === null && !this.#child.killed;
  }

  onFrame(listener: FrameListener): () => void {
    this.#frameListeners.add(listener);
    return () => this.#frameListeners.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.#exitListeners.add(listener);
    return () => this.#exitListeners.delete(listener);
  }

  start(): void {
    if (this.isRunning || this.#stopping) return;
    this.#framer.reset();

    const { command, args, env } = this.#options.spec;
    this.#log.info('starting helper', { command, args: [...args] });

    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(command, [...args], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(env === undefined ? {} : { env: childEnv(env) }),
      });
    } catch (cause) {
      this.#log.error('failed to spawn helper', { err: cause });
      this.#scheduleRestart({ code: null, signal: null });
      return;
    }
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      for (const line of this.#framer.feed(chunk)) this.#handleLine(line);
    });

    // stderr is diagnostics, never protocol (contract §1).
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      const text = chunk.trimEnd();
      if (text.length > 0) this.#log.warn('helper stderr', { text });
    });

    let settled = false;
    /** Whichever of `error` and `exit` arrives first owns the restart. */
    const settle = (report: () => void): void => {
      if (settled) return;
      settled = true;
      this.#child = null;
      report();
    };

    /**
     * A process that could not be spawned emits `error` and **no `exit`**.
     *
     * Node's docs put it as "the 'exit' event may or may not fire after an
     * error has occurred", and for `ENOENT` it does not. Phase 1 logged here
     * and scheduled the restart only from `exit`, so a helper binary deleted or
     * made unreadable while the app was running would never be retried: one
     * ERROR line, then permanent silence with the Fn key dead — the failure
     * this supervisor exists to prevent.
     * `createNativeHelper` covers the binary being missing *at startup*; this
     * covers every other moment.
     */
    child.on('error', (error) => {
      settle(() => {
        this.#log.error('the helper process could not be started', { err: error });
        if (this.#stopping) {
          this.#emitExit({ code: null, signal: null, willRestart: false });
          return;
        }
        this.#scheduleRestart({ code: null, signal: null });
      });
    });

    child.on('exit', (code, signal) => {
      for (const line of this.#framer.flush()) this.#handleLine(line);
      settle(() => {
        if (this.#stopping) {
          this.#log.info('helper exited during shutdown', { code, signal });
          this.#emitExit({ code, signal, willRestart: false });
          return;
        }
        this.#log.error('helper exited unexpectedly — the hotkey is dead until it restarts', {
          code,
          signal,
        });
        this.#scheduleRestart({ code, signal });
      });
    });
  }

  /**
   * Queue a command. Returns false when the helper is not running, so callers
   * can fail loudly instead of losing the request silently.
   */
  send(command: AppToHelper): boolean {
    const child = this.#child;
    if (child === null || child.stdin.destroyed) {
      this.#log.warn('dropping command: helper is not running', { type: command.type });
      return false;
    }
    child.stdin.write(encodeAppFrame(command));
    return true;
  }

  /** Ask politely, then insist. */
  async stop(timeoutMs = 2000): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = null;
    }
    const child = this.#child;
    if (child === null) return;

    this.send({ v: 1, type: 'shutdown' });

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
      child.once('exit', done);
    });
  }

  #handleLine(line: string): void {
    const parsed = parseHelperFrame(line);
    if (!parsed.ok) {
      // Contract §1 rule 1: log and skip. A bad byte must not kill the app.
      this.#log.warn('discarding malformed helper frame', {
        reason: parsed.reason,
        raw: parsed.raw.slice(0, 200),
      });
      return;
    }
    // A frame proves the helper is alive and talking; reset the restart curve.
    this.#consecutiveFailures = 0;
    this.#backoff.reset();

    if (parsed.frame.type === 'log') {
      const { level, msg } = parsed.frame;
      this.#log[level](msg);
      return;
    }
    for (const listener of this.#frameListeners) listener(parsed.frame);
  }

  #scheduleRestart(exit: { code: number | null; signal: NodeJS.Signals | null }): void {
    this.#consecutiveFailures += 1;
    const max = this.#options.maxConsecutiveRestarts ?? 10;
    if (this.#consecutiveFailures > max) {
      this.#log.error('helper failed repeatedly; giving up', {
        attempts: this.#consecutiveFailures,
        hint: 'Restart Grok Dictate. If it persists, rebuild the helper with native/build.sh.',
      });
      this.#emitExit({ ...exit, willRestart: false });
      return;
    }
    const delay = this.#backoff.next();
    this.#log.warn('restarting helper', { delayMs: delay, attempt: this.#consecutiveFailures });
    this.#emitExit({ ...exit, willRestart: true });
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = null;
      this.start();
    }, delay);
    this.#restartTimer.unref?.();
  }

  #emitExit(info: HelperExitInfo): void {
    for (const listener of this.#exitListeners) listener(info);
  }
}
