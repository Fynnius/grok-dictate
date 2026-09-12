/**
 * Interactive Grok CLI sign-in by opening Terminal.app.
 *
 * `grok login` is a TUI. Embedding it in Electron, or spawning it as a child
 * and killing it, would race the same locked write that `renew.ts` is careful
 * not to interrupt. Terminal.app runs the command; this module only launches
 * that window and watches `auth.json` until a usable token appears. It never
 * writes the file, and it never sends SIGTERM at `grok`.
 */

import { spawn } from 'node:child_process';
import type { CliAuthStatus } from '@contracts/events.js';
import { childEnv, envString } from '@shared/env.js';
import type { Logger } from '@shared/logger.js';
import { appError, err, ok, type Result } from '@shared/result.js';
import { resolveGrokBinary, type GrokBinaryLookup } from './renew.js';

/** How often to re-read the CLI file while Terminal is doing the login. */
const DEFAULT_POLL_MS = 1_000;

/**
 * Give up waiting (not the login itself). The OAuth flow in the browser can
 * take a while; past this the Settings row stops spinning and the user can
 * click Sign in again. Terminal is left alone.
 */
const DEFAULT_TIMEOUT_MS = 15 * 60_000;

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function appleScriptForGrokLogin(grokPath: string): string {
  const command = `${shellQuote(grokPath)} login`;
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`;
}

export type LaunchTerminal = (script: string) => Promise<void>;

export interface GrokCliLoginOptions {
  readonly logger: Logger;
  readonly status: () => Promise<CliAuthStatus>;
  /** Fired once a usable token is in the file, before `start` resolves. */
  readonly onSignedIn?: () => void;
  readonly override?: string | undefined;
  readonly home?: string;
  readonly exists?: (path: string) => boolean;
  readonly launch?: LaunchTerminal;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}

export class GrokCliLogin {
  readonly #log: Logger;
  readonly #status: () => Promise<CliAuthStatus>;
  readonly #onSignedIn: (() => void) | undefined;
  readonly #launch: LaunchTerminal;
  readonly #lookup: GrokBinaryLookup;
  readonly #pollMs: number;
  readonly #timeoutMs: number;

  #inFlight: Promise<Result<CliAuthStatus>> | null = null;
  #cancelled = false;
  #timer: NodeJS.Timeout | null = null;
  #wakeSleep: (() => void) | null = null;

  constructor(options: GrokCliLoginOptions) {
    this.#log = options.logger.child('auth.login');
    this.#status = options.status;
    this.#onSignedIn = options.onSignedIn;
    this.#launch = options.launch ?? runOsascript;
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#lookup = resolveGrokBinary({
      override: options.override ?? envString('GROK_DICTATE_GROK_BIN'),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.exists === undefined ? {} : { exists: options.exists }),
    });
  }

  get available(): boolean {
    return this.#lookup.found;
  }

  /**
   * Open Terminal with `grok login` and wait until the file is usable, the
   * user cancels, or the wait times out. Concurrent callers share the wait.
   */
  start(): Promise<Result<CliAuthStatus>> {
    const existing = this.#inFlight;
    if (existing !== null) return existing;

    this.#cancelled = false;
    const attempt = this.#run();
    this.#inFlight = attempt;
    void attempt.finally(() => {
      if (this.#inFlight === attempt) this.#inFlight = null;
    });
    return attempt;
  }

  /** Stop waiting. Does not close Terminal or kill `grok`. */
  cancel(): void {
    this.#cancelled = true;
    this.#wake();
  }

  async #run(): Promise<Result<CliAuthStatus>> {
    if (!this.#lookup.found) {
      this.#log.warn('cannot start grok login: the grok CLI was not found', {
        lookedFor: this.#lookup.path,
        hint: 'Install the Grok CLI, or set GROK_DICTATE_GROK_BIN to its full path.',
      });
      return err(
        appError(
          'auth_missing',
          'Grok Dictate could not find the Grok CLI.',
          'Install the Grok CLI, or set GROK_DICTATE_GROK_BIN to its full path.',
        ),
      );
    }

    const current = await this.#status();
    if (current.state === 'signed-in') return ok(current);

    try {
      await this.#launch(appleScriptForGrokLogin(this.#lookup.path));
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#log.warn('could not open Terminal for grok login', { err: message });
      return err(
        appError(
          'internal',
          'Grok Dictate could not open Terminal to run `grok login`.',
          'Open Terminal yourself and run `grok login`.',
          cause,
        ),
      );
    }

    this.#log.info('opened Terminal for grok login', { command: `${this.#lookup.path} login` });

    const deadline = Date.now() + this.#timeoutMs;
    while (!this.#cancelled && Date.now() < deadline) {
      const status = await this.#status();
      if (status.state === 'signed-in') {
        this.#onSignedIn?.();
        return ok(status);
      }
      await this.#sleep(this.#pollMs);
    }

    if (this.#cancelled) {
      this.#log.info('stopped waiting for grok login');
    } else {
      this.#log.warn('timed out waiting for grok login; leaving Terminal alone');
    }
    return ok(await this.#status());
  }

  #sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      this.#wakeSleep = resolve;
      this.#timer = setTimeout(() => {
        this.#wakeSleep = null;
        this.#timer = null;
        resolve();
      }, ms);
      this.#timer.unref?.();
    });
  }

  #wake(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    const wake = this.#wakeSleep;
    this.#wakeSleep = null;
    wake?.();
  }
}

function runOsascript(script: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('osascript', ['-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({}),
    });
    child.stdout.resume();
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 1_000) stderr += chunk;
    });
    child.on('error', (cause: Error) => {
      reject(cause);
    });
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `osascript exited ${String(code)}`));
    });
  });
}
