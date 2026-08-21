/**
 * Renewing the Grok CLI login by asking the Grok CLI to do it.
 *
 * ## Why this is not the refresh path §5.6 forbids
 *
 * `contracts/ports.ts` and `src/main/auth/index.ts` are emphatic that this app
 * must never refresh an OIDC token itself, and they are right: the grant
 * rotates the refresh token, and a client that refreshes without writing the
 * rotated value back under `auth.json.lock` leaves the Grok CLI holding a stale
 * one. Its login then breaks later, in a different program, with no visible
 * causal link. `test/e2e/audit-5b.test.ts` scans the whole source tree for
 * `grant_type`, `refresh_token` and friends to keep it that way.
 *
 * Nothing here goes near any of that. This module spawns `grok`, which owns the
 * file, owns the lock and owns the rotation, and then re-reads `auth.json` like
 * any other reader. The audit passes unchanged, and that is the point: asking
 * the owner to do the work is categorically different from doing it yourself.
 *
 * ## Why `grok models` and not `grok`
 *
 * The obvious version — launch the interactive TUI and kill it — is the one
 * thing not to do. It allocates a terminal, writes session state and starts a
 * leader process, and killing it is a race against whatever it is midway
 * through. `grok models` is a first-class non-interactive subcommand that
 * authenticates, prints, and exits on its own.
 *
 * Measured on 2026-08-21 against `grok 1.0.5`:
 *
 * | Starting state                    | Result                                    |
 * | --------------------------------- | ----------------------------------------- |
 * | valid token                       | exits in ~1.1 s, `auth.json` **untouched** |
 * | expired token, refresh accepted   | token renewed in place                    |
 * | expired token, server says no     | `auth.json` **deleted** — see below       |
 * | expired token, network unreachable| `auth.json` **survives**                  |
 *
 * "Untouched" in row one is not laziness on the CLI's part but a documented
 * threshold: `DEFAULT_EARLY_INVALIDATION_SECS = 300`, so it treats a token with
 * over five minutes left as fine and returns without an IdP call. Calling this
 * outside that window achieves nothing, which is what `RENEW_MARGIN_MS` in
 * `./index.ts` is sized against.
 *
 * ## The deletion, and why it is safe to live with
 *
 * A refresh the server *rejects* makes the CLI clear the credential file. That
 * sounds alarming and is actually the careful behaviour: it only happens when
 * xAI has authoritatively refused the refresh token, at which point the login is
 * genuinely gone and an interactive sign-in is the only way back. Verified by
 * pointing the issuer at a closed port: a transport failure leaves the file
 * intact, so being offline can never cost the user their login.
 *
 * ## Two rules that matter more than they look
 *
 * 1. **The exit code is not the answer.** `grok models` exits 0 while printing
 *    "You are not authenticated." Success is decided by re-reading `auth.json`
 *    and finding a usable token — never by `code === 0`.
 * 2. **Do not kill it early.** The timeout here is deliberately many times the
 *    measured runtime, because a SIGTERM landing between the token response and
 *    the locked write is the one way this module could do the damage it exists
 *    to avoid.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { childEnv, envString } from '@shared/env.js';
import type { Logger } from '@shared/logger.js';

/**
 * How long to let the CLI run before killing it as a leak backstop.
 *
 * **Two minutes, and the size is load-bearing.** The obvious value is a few
 * seconds — it finishes in ~1.1 s — and it would be a bug. Reading the CLI's own
 * refresh path (`xai-grok-shell/src/auth/`):
 *
 *   - `REFRESH_LOCK_TIMEOUT` is **45 s**: it will wait that long for
 *     `auth.json.lock` if another `grok` is mid-refresh.
 *   - the token exchange has a 15 s timeout and is retried up to three times
 *     with jittered backoff.
 *
 * So a legitimate, healthy refresh can take the better part of a minute, and
 * killing it partway through is the specific way this module could cause the
 * damage it exists to prevent: the IdP burns the old refresh token when it
 * answers, and if the process dies before the locked write lands, the rotated
 * token is gone while the spent one is still on disk. The next launch presents
 * the spent token, gets `invalid_grant`, and the user is signed out for real.
 * The CLI guards that window against suspend; it has no handler for SIGTERM.
 *
 * Killing early also risks leaving an `auth.json.<pid>.<seq>.tmp` behind — the
 * CLI's atomic-rename staging file, mode 0600 but holding both tokens in plain
 * text, and nothing ever cleans those up.
 *
 * Nobody waits this long: a dictation gives up watching after six seconds
 * (`RENEW_WAIT_IN_DICTATION_MS`) and lets it finish in the background. This
 * number only decides when a genuinely hung process gets reaped.
 */
const RENEW_TIMEOUT_MS = 120_000;

/** Grace between SIGTERM and SIGKILL for a child that ignores the first. */
const KILL_GRACE_MS = 5_000;

/**
 * Shortest gap between two attempts, and how it grows.
 *
 * A failed renewal usually means "offline" or "the login is really gone",
 * neither of which a prompt retry fixes — and the scheduler asks once a minute,
 * so without a gate an evening offline would be hundreds of spawns. The cooldown
 * doubles per consecutive failure and resets the moment one succeeds.
 *
 * `@shared/backoff.ts` is deliberately not reused: it returns a *full-jitter
 * delay to wait before retrying*, and a jittered value in `[0, cap]` makes a
 * poor gate — it would sometimes permit an immediate second spawn.
 */
const COOLDOWN_BASE_MS = 30_000;
const COOLDOWN_MAX_MS = 10 * 60_000;

/** Where the official installer puts the CLI, relative to `$HOME`. */
export const GROK_BIN_RELATIVE_PATH = join('.grok', 'bin', 'grok');

export type RenewOutcome =
  /** The CLI ran to completion. Whether it *helped* is for the caller to check. */
  | { readonly kind: 'ran'; readonly exitCode: number | null; readonly durationMs: number }
  | { readonly kind: 'skipped'; readonly reason: 'cooling_down' | 'binary_missing' }
  | { readonly kind: 'failed'; readonly reason: string };

export interface GrokBinaryLookup {
  readonly path: string;
  readonly found: boolean;
  readonly source: 'override' | 'home' | 'search-path';
}

/**
 * Find the `grok` executable.
 *
 * `PATH` is not consulted, and that is the whole reason this function exists: a
 * GUI app launched from Finder or a LaunchAgent inherits a minimal
 * `/usr/bin:/bin:/usr/sbin:/sbin`, not the user's shell `PATH`, so the CLI that
 * is obviously present in a terminal is invisible here. The install location is
 * checked directly instead.
 */
export function resolveGrokBinary(
  options: {
    readonly override?: string | undefined;
    readonly home?: string;
    readonly exists?: (path: string) => boolean;
  } = {},
): GrokBinaryLookup {
  const exists = options.exists ?? existsSync;
  const home = options.home ?? homedir();

  const override = options.override?.trim();
  if (override !== undefined && override.length > 0) {
    return { path: override, found: exists(override), source: 'override' };
  }

  const installed = join(home, GROK_BIN_RELATIVE_PATH);
  if (exists(installed)) return { path: installed, found: true, source: 'home' };

  for (const candidate of ['/opt/homebrew/bin/grok', '/usr/local/bin/grok', '/usr/bin/grok']) {
    if (exists(candidate)) return { path: candidate, found: true, source: 'search-path' };
  }

  return { path: installed, found: false, source: 'home' };
}

export interface RunResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
}

/** The one impure step, isolated so the policy above is testable without a CLI. */
export type RunGrok = (command: string, args: readonly string[]) => Promise<RunResult>;

export interface GrokCliRenewerOptions {
  readonly logger: Logger;
  readonly override?: string | undefined;
  readonly now?: () => number;
  readonly run?: RunGrok;
  readonly exists?: (path: string) => boolean;
  readonly home?: string;
}

export class GrokCliRenewer {
  readonly #log: Logger;
  readonly #now: () => number;
  readonly #run: RunGrok;
  readonly #lookup: GrokBinaryLookup;

  /** Shared by every caller that asks while one is already running. */
  #inFlight: Promise<RenewOutcome> | null = null;
  #lastAttemptAt = 0;
  #consecutiveFailures = 0;
  #warnedMissing = false;

  constructor(options: GrokCliRenewerOptions) {
    this.#log = options.logger.child('auth.renew');
    this.#now = options.now ?? Date.now;
    this.#run = options.run ?? spawnGrok;
    this.#lookup = resolveGrokBinary({
      override: options.override ?? envString('GROK_DICTATE_GROK_BIN'),
      ...(options.home === undefined ? {} : { home: options.home }),
      ...(options.exists === undefined ? {} : { exists: options.exists }),
    });
  }

  get binaryPath(): string {
    return this.#lookup.path;
  }

  get available(): boolean {
    return this.#lookup.found;
  }

  /**
   * Ask the CLI to renew the login, at most one at a time.
   *
   * Concurrent callers — the expiry scheduler and a dictation starting in the
   * same second — get the *same* promise rather than a second process. Two
   * `grok` processes contending for `auth.json.lock` is not a race this app
   * needs to have an opinion about.
   */
  renew(reason: string): Promise<RenewOutcome> {
    const existing = this.#inFlight;
    if (existing !== null) return existing;

    if (!this.#lookup.found) {
      if (!this.#warnedMissing) {
        this.#warnedMissing = true;
        this.#log.warn('cannot renew the Grok login: the grok CLI was not found', {
          lookedFor: this.#lookup.path,
          hint: 'Install the Grok CLI, or set GROK_DICTATE_GROK_BIN to its full path.',
        });
      }
      return Promise.resolve({ kind: 'skipped', reason: 'binary_missing' });
    }

    const waitedMs = this.#now() - this.#lastAttemptAt;
    const cooldown = this.#cooldownMs();
    if (this.#lastAttemptAt !== 0 && waitedMs < cooldown) {
      this.#log.debug('renewal skipped: still cooling down after a failure', {
        waitedMs,
        cooldownMs: cooldown,
        consecutiveFailures: this.#consecutiveFailures,
      });
      return Promise.resolve({ kind: 'skipped', reason: 'cooling_down' });
    }

    const attempt = this.#attempt(reason);
    this.#inFlight = attempt;
    return attempt;
  }

  async #attempt(reason: string): Promise<RenewOutcome> {
    const startedAt = this.#now();
    this.#lastAttemptAt = startedAt;
    this.#log.info('asking the Grok CLI to renew the login', {
      reason,
      command: `${this.#lookup.path} models`,
    });

    try {
      const result = await this.#run(this.#lookup.path, ['models']);
      const durationMs = this.#now() - startedAt;

      if (result.signal !== null) {
        this.#consecutiveFailures++;
        this.#log.warn('the Grok CLI was killed before it finished', {
          signal: result.signal,
          durationMs,
        });
        return { kind: 'failed', reason: `killed by ${result.signal}` };
      }

      // Deliberately not treated as success or failure. `grok models` exits 0
      // while printing "You are not authenticated." — only `auth.json` knows.
      this.#log.info('the Grok CLI finished', { exitCode: result.code, durationMs });
      if (result.code !== 0 && result.stderr.length > 0) {
        this.#log.warn('the Grok CLI reported an error', { stderr: truncate(result.stderr) });
      }
      return { kind: 'ran', exitCode: result.code, durationMs };
    } catch (cause) {
      this.#consecutiveFailures++;
      const message = cause instanceof Error ? cause.message : String(cause);
      this.#log.warn('could not run the Grok CLI', { err: message });
      return { kind: 'failed', reason: message };
    } finally {
      this.#inFlight = null;
    }
  }

  /**
   * Called by the auth layer once it has re-read `auth.json` and knows whether
   * the renewal actually produced a usable token. The cooldown is driven from
   * here rather than from the exit code, for the reason in rule 1.
   */
  recordOutcome(renewed: boolean): void {
    if (renewed) {
      this.#consecutiveFailures = 0;
      this.#lastAttemptAt = 0;
      return;
    }
    this.#consecutiveFailures++;
  }

  #cooldownMs(): number {
    if (this.#consecutiveFailures === 0) return 0;
    const exponent = Math.min(this.#consecutiveFailures - 1, 10);
    return Math.min(COOLDOWN_MAX_MS, COOLDOWN_BASE_MS * 2 ** exponent);
  }
}

/* ------------------------------------------------------------------ *
 * The child process
 * ------------------------------------------------------------------ */

function spawnGrok(command: string, args: readonly string[]): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    const child = spawn(command, [...args], {
      // stdin is `/dev/null`, not a pipe: a subcommand that decided to ask a
      // question would otherwise wait for an answer that is never coming, and
      // this runs with no user in front of it.
      stdio: ['ignore', 'pipe', 'pipe'],
      env: childEnv({
        // Nothing renders this output; escape codes would only make the log
        // harder to read if a failure ever needs quoting into it.
        NO_COLOR: '1',
      }),
    });

    let stderr = '';
    let settled = false;
    let killTimer: NodeJS.Timeout | null = null;

    // stdout is drained and dropped. It names the signed-in account, and there
    // is no reason for that to be anywhere near a log file.
    child.stdout.resume();
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderr.length < 4_000) stderr += chunk;
    });

    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref?.();
    }, RENEW_TIMEOUT_MS);
    timeout.unref?.();

    const finish = (): void => {
      clearTimeout(timeout);
      if (killTimer !== null) clearTimeout(killTimer);
    };

    child.on('error', (cause: Error) => {
      if (settled) return;
      settled = true;
      finish();
      reject(cause);
    });

    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      finish();
      resolve({ code, signal, stderr: stderr.trim() });
    });
  });
}

function truncate(text: string): string {
  const firstLine = text.split('\n')[0] ?? '';
  return firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
}
