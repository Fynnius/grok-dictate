/**
 * OWNER: **Phase 3**. Reads the bearer out of the Grok CLI's own auth store.
 *
 * IMPLEMENTATION-PLAN.md §3.3: "read `~/.grok/auth.json`, take the single scope
 * key, use `key` as bearer if `expires_at` is in the future with ≥ 60 s margin.
 * **Do not refresh** in v1 (§5.6, §12.1); on expiry surface a clear 'run `grok`
 * to refresh' error. Guard the file format and fail loudly if it changes
 * (assumption 10.1). **Never log the token.**"
 *
 * ## There is no refresh path in this file, and there must never be one
 *
 *  rates this the highest-severity risk in the project: the
 * refresh grant rotates the token, and a client that refreshes without writing
 * the rotated value back to `auth.json` **under `auth.json.lock`** leaves the
 * Grok CLI holding a stale refresh token. The CLI's login then breaks — later,
 * in a different program, with no visible causal link.  (does xAI
 * rotate the refresh token on use?) is deliberately unanswered, which is
 * precisely why v1 does not go near it. Phase 5 §5b audits that no refresh path
 * exists anywhere.
 *
 * The recovery story is one sentence long and it costs nothing: run `grok`, and
 * any invocation refreshes the file as a side effect.
 *
 * ## …which is now automated, without becoming a refresh path
 *
 * "Run `grok`" is a fine recovery story and a poor user experience: the token
 * lasts hours, so a menu-bar app left running reliably meets an expired one, and
 * the answer was a dead Fn key and an error pill. `DictateAuth` therefore runs
 * that same sentence on the user's behalf — it *spawns the CLI* and re-reads the
 * file afterwards. It still never mints, rotates or writes a token; the process
 * that owns `auth.json` and its lock does all of that, exactly as before. See
 * `src/main/auth/renew.ts`, and note that §5b's source scan passes untouched.
 *
 * ## The token
 *
 * An 838-character OIDC JWT. It never enters a log line, an
 * `AppError` message, an `AppError.hint`, a history row, or a helper frame. The
 * redaction layer in `src/shared/redact.ts` is the backstop for that, not the
 * plan — nothing here hands it to anything but the `Authorization` header in
 * `src/main/stt/client.ts`.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AuthStatus } from '@contracts/events.js';
import type { AuthPort, Bearer } from '@contracts/ports.js';
import {
  API_KEY_SENTINEL_EXPIRY,
  AUTH_JSON_RELATIVE_PATH,
  TOKEN_EXPIRY_MARGIN_MS,
} from '@shared/constants.js';
import type { Logger } from '@shared/logger.js';
import { appError, err, ok, type Result } from '@shared/result.js';
import type { CredentialStore } from './store.js';
import { validateApiKey } from './validate.js';
import type { GrokCliRenewer } from './renew.js';

export function defaultAuthPath(): string {
  return join(homedir(), AUTH_JSON_RELATIVE_PATH);
}

export interface AuthProviderOptions {
  /** Overridable for tests; defaults to `~/.grok/auth.json`. */
  readonly path?: string;
  /** Injectable clock, so expiry behaviour is testable without waiting. */
  readonly now?: () => number;
}

/**
 * One scope entry from `auth.json`, reduced to the two fields this app reads.
 *
 * Everything else in the file — `refresh_token`, `email`, `principal_id`,
 * `coding_data_retention_opt_out` — is deliberately not modelled. Not parsing a
 * field is the cheapest possible guarantee that it cannot leak.
 */
interface ScopeEntry {
  readonly token: string;
  readonly expiresAt: Date;
}

/**
 * Parse the decoded contents of `auth.json`.
 *
 * Split out from the I/O so the format guard (assumption 10.1) is testable
 * against every shape the file could degrade into, and so a test can prove that
 * no error path echoes the token.
 */
export function parseAuthDocument(raw: unknown, path: string, nowMs: number): Result<Bearer> {
  const malformed = (what: string): Result<Bearer> =>
    err(
      appError(
        'auth_malformed',
        `${path} is not in the format Grok Dictate expects: ${what}.`,
        // Assumption 10.1: the file's shape was observed once, on 2026-08-08.
        // A CLI update that changes it must fail loudly and say what to do.
        'Run `grok` in a terminal to sign in again. If that does not help, the Grok CLI has changed its auth file format and Grok Dictate needs updating.',
      ),
    );

  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return malformed('the top level is not a JSON object');
  }

  // : a single top-level key, the auth *scope* string
  // (`issuer::client_id`). More than one is not something we have observed;
  // take the first usable entry and let the caller warn about the rest.
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length === 0) return malformed('it contains no auth scope entry');

  const failures: string[] = [];
  for (const [scope, value] of entries) {
    const parsed = parseScopeEntry(value);
    if (parsed === null) {
      failures.push(scope);
      continue;
    }
    const marginMs = parsed.expiresAt.getTime() - nowMs;
    if (marginMs < TOKEN_EXPIRY_MARGIN_MS) {
      return err(
        appError(
          'auth_expired',
          // §4 of the plan gives this exact standard: "token expired at 21:58 —
          // run `grok` to refresh" is correct; "STT failed" is a defect.
          marginMs <= 0
            ? `The Grok token expired at ${formatLocalTime(parsed.expiresAt)}.`
            : `The Grok token expires at ${formatLocalTime(parsed.expiresAt)}, too soon to start a dictation.`,
          'Open the Sign in window and paste an xAI API key, or run `grok` in a terminal. Grok Dictate never refreshes the Grok CLI token itself.',
        ),
      );
    }
    return ok({ token: parsed.token, expiresAt: parsed.expiresAt });
  }

  return malformed(
    failures.length === 1
      ? 'its auth scope entry has no usable `key` and `expires_at`'
      : 'none of its auth scope entries have a usable `key` and `expires_at`',
  );
}

function parseScopeEntry(value: unknown): ScopeEntry | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const token = record['key'];
  const expiresAt = record['expires_at'];
  if (typeof token !== 'string' || token.length === 0) return null;
  if (typeof expiresAt !== 'string') return null;
  const expiry = new Date(expiresAt);
  if (Number.isNaN(expiry.getTime())) return null;
  return { token, expiresAt: expiry };
}

/** Local wall-clock `HH:MM`, which is how a user thinks about "expired at". */
function formatLocalTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

/**
 * A JWT header is base64url of a JSON object, so it always begins `eyJ`
 * (see `src/shared/redact.ts`). Used only to *warn*: if xAI ever issues an
 * opaque bearer instead, refusing to dictate would be the wrong call — the
 * token may well still work, and the request will report the truth.
 */
function looksLikeJwt(token: string): boolean {
  return token.startsWith('eyJ') && token.split('.').length === 3;
}

export class GrokAuthProvider implements AuthPort {
  readonly #path: string;
  readonly #now: () => number;
  readonly #log: Logger;
  /** Warn once per process about a surprising file, not once per dictation. */
  #warnedMultipleScopes = false;
  #warnedNonJwt = false;

  constructor(logger: Logger, options: AuthProviderOptions = {}) {
    this.#path = options.path ?? defaultAuthPath();
    this.#now = options.now ?? Date.now;
    this.#log = logger.child('auth');
  }

  /**
   * Read the file fresh every time. It is a few hundred bytes,
   * and caching would mean a `grok login` in another terminal did not take
   * effect until Grok Dictate restarted.
   */
  async getBearer(): Promise<Result<Bearer>> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') {
        return err(
          appError(
            'auth_missing',
            'Grok Dictate could not find a login.',
            'Open the Sign in window and paste an xAI API key, or run `grok` in a terminal.',
            cause,
          ),
        );
      }
      return err(
        appError(
          'auth_missing',
          `Grok Dictate could not read ${this.#path}.`,
          'Check the permissions on that file, then run `grok` in a terminal to sign in again.',
          cause,
        ),
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (cause) {
      // The *contents* are never attached, only the failure. The file holds the
      // bearer and the refresh token.
      return err(
        appError(
          'auth_malformed',
          `${this.#path} is not valid JSON.`,
          'Run `grok` in a terminal to sign in again, which rewrites the file.',
          cause instanceof Error ? cause.message : String(cause),
        ),
      );
    }

    if (!this.#warnedMultipleScopes && parsed !== null && typeof parsed === 'object') {
      const count = Object.keys(parsed).length;
      if (count > 1) {
        this.#warnedMultipleScopes = true;
        //  observed exactly one. More is not an error — the first
        // usable entry is used — but it is worth knowing about.
        this.#log.warn('auth.json holds more than one scope; using the first usable entry', {
          scopeCount: count,
        });
      }
    }

    const result = parseAuthDocument(parsed, this.#path, this.#now());
    if (!result.ok) {
      // Logged with the code only. `AppError.cause` may carry a parser message,
      // and the logger redacts, but there is no reason to hand it over at all.
      this.#log.warn('no usable token in auth.json', { code: result.error.code });
      return result;
    }

    if (!this.#warnedNonJwt && !looksLikeJwt(result.value.token)) {
      this.#warnedNonJwt = true;
      // Log text deliberately avoids the word "bearer" followed by another word:
      // `redact.ts`'s `BEARER_PATTERN` is `/\bbearer\s+\S+/gi`, so a message like
      // "bearer loaded" is rewritten to "Bearer [REDACTED]" and reads, alarmingly
      // and wrongly, like a caught leak. Observed in the field during HT-1.
      this.#log.warn('the token in auth.json is not JWT-shaped; using it anyway', {
        // Length only — never the value, never a prefix.
        length: result.value.token.length,
      });
    }

    this.#log.debug('token loaded from auth.json', {
      expiresAt: result.value.expiresAt.toISOString(),
      validForSec: Math.round((result.value.expiresAt.getTime() - this.#now()) / 1000),
    });
    return result;
  }

  /**
   * The file's `expires_at`, even when the token is already unusable. Used by
   * the sign-in window so "expired" is distinct from "never signed in".
   */
  async peekExpiry(): Promise<Date | null> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        const entry = parseScopeEntry(value);
        if (entry !== null) return entry.expiresAt;
      }
    } catch {
      return null;
    }
    return null;
  }
}

export interface DictateAuthOptions {
  readonly store: CredentialStore;
  readonly cli?: AuthProviderOptions;
  /** Overridable for tests. Defaults to `XAI_API_KEY` via `envString`. */
  readonly envToken?: string | undefined;
  /**
   * Spawns the Grok CLI so it renews its own login. Absent means the feature is
   * compiled out entirely — every path below degrades to the previous
   * "run `grok` yourself" error.
   */
  readonly renewer?: GrokCliRenewer;
  /** The `autoRenewLogin` setting, read at each decision so it takes effect at once. */
  readonly autoRenew?: () => boolean;
}

/**
 * How long a dictation will wait for a renewal before giving up on it.
 *
 * The CLI takes ~1.1 s measured, so six seconds is generous. It is bounded at
 * all because `getBearer` is on the critical path of a key press: the STT
 * client's no-speech watchdog (`pipeline.rs:198` — 10 s) starts when the turn
 * does, and a renewal that outlived it would turn a slow login into "No speech
 * was detected", which is both wrong and unactionable.
 *
 * Giving up waiting does **not** stop the renewal — `GrokCliRenewer` keeps it
 * running and the next dictation gets the benefit. Nothing is killed early; see
 * rule 2 in `renew.ts`.
 */
const RENEW_WAIT_IN_DICTATION_MS = 6_000;

/** How often to check whether the token is close enough to expiry to renew. */
const RENEW_CHECK_INTERVAL_MS = 60_000;

/**
 * Renew this long before expiry.
 *
 * **Four minutes, because the CLI has its own opinion and it is five.** Its
 * `DEFAULT_EARLY_INVALIDATION_SECS` is 300: a token with more than five minutes
 * of life left is "not expired", and `grok models` will start, decide there is
 * nothing to do, and exit without contacting the IdP or writing anything. Asking
 * at ten minutes would therefore spawn a process a minute for five minutes and
 * renew nothing. Asking inside that window means the first spawn is the only
 * spawn.
 *
 * Still comfortably clear of `TOKEN_EXPIRY_MARGIN_MS` (60 s, where this app
 * starts refusing a token), so in normal running a dictation never meets an
 * expired token and the in-dictation path above stays a fallback rather than the
 * mechanism.
 */
const RENEW_MARGIN_MS = 4 * 60_000;

/**
 * The auth the app actually uses: a stored xAI API key, then `XAI_API_KEY`,
 * then the Grok CLI file. There is still no refresh path — an API key is a
 * static secret, and a CLI token is only ever read.
 */
export class DictateAuth implements AuthPort {
  readonly #store: CredentialStore;
  readonly #cli: GrokAuthProvider;
  readonly #envToken: string | undefined;
  readonly #renewer: GrokCliRenewer | undefined;
  readonly #autoRenew: () => boolean;
  readonly #log: Logger;
  readonly #listeners = new Set<(status: AuthStatus) => void>();
  #renewTimer: NodeJS.Timeout | null = null;

  constructor(logger: Logger, options: DictateAuthOptions) {
    this.#store = options.store;
    this.#cli = new GrokAuthProvider(logger, options.cli);
    this.#envToken = options.envToken;
    this.#renewer = options.renewer;
    this.#autoRenew = options.autoRenew ?? ((): boolean => true);
    this.#log = logger.child('auth');
  }

  onChange(listener: (status: AuthStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async getBearer(): Promise<Result<Bearer>> {
    const stored = await this.#store.getApiKey();
    if (stored !== null) {
      return ok({ token: stored, expiresAt: API_KEY_SENTINEL_EXPIRY });
    }
    if (this.#envToken !== undefined && this.#envToken.length > 0) {
      return ok({ token: this.#envToken, expiresAt: API_KEY_SENTINEL_EXPIRY });
    }

    const first = await this.#cli.getBearer();
    if (first.ok) return first;

    /**
     * Only `auth_expired` is worth spawning a process for, and the distinction
     * is not pedantry.
     *
     * `auth_expired` means the file is there, it parsed, and it holds a refresh
     * token the CLI can trade in — the one case where running `grok` fixes
     * something. `auth_missing` means there is nothing to refresh *from*: either
     * the user never signed in, or a previous refresh was rejected and the CLI
     * cleared the file. Spawning then is a guaranteed-useless second of latency
     * on every key press, and the honest answer is the Sign in window.
     * `auth_malformed` is left alone too: a file we cannot parse is a file we
     * should not be making decisions about.
     */
    if (first.error.code !== 'auth_expired') return first;

    const renewed = await this.#renewAndReread('a dictation started with an expired token');
    return renewed ?? first;
  }

  /**
   * Run a renewal, then find out whether it worked by re-reading `auth.json`.
   *
   * Returns the fresh bearer, or `null` if the renewal was skipped, timed out,
   * or produced nothing usable — every one of which leaves the caller's original
   * error as the honest thing to report.
   */
  async #renewAndReread(reason: string): Promise<Result<Bearer> | null> {
    const renewer = this.#renewer;
    if (renewer === undefined || !this.#autoRenew()) return null;

    const outcome = await waitAtMost(renewer.renew(reason), RENEW_WAIT_IN_DICTATION_MS);
    if (outcome === null) {
      // Still running. Leave it be — killing it is the one thing `renew.ts` is
      // careful not to do — and let the next dictation collect the result.
      this.#log.warn('the Grok CLI is taking too long; continuing without a renewed login', {
        waitedMs: RENEW_WAIT_IN_DICTATION_MS,
      });
      return null;
    }
    if (outcome.kind !== 'ran') return null;

    // The exit code is not evidence: `grok models` exits 0 while printing
    // "You are not authenticated." The file is the only source of truth.
    const after = await this.#cli.getBearer();
    renewer.recordOutcome(after.ok);
    if (!after.ok) {
      this.#log.warn('the Grok CLI ran but the login is still not usable', {
        code: after.error.code,
      });
      return null;
    }

    this.#log.info('the Grok login was renewed automatically', {
      expiresAt: after.value.expiresAt.toISOString(),
    });
    void this.refresh();
    return after;
  }

  /**
   * Keep the Grok CLI login alive for as long as the app is running.
   *
   * A check a minute, a spawn only inside `RENEW_MARGIN_MS` of expiry — so
   * roughly once per token lifetime, not once a minute. Idempotent, and a no-op
   * when the user is on an API key, which does not expire.
   */
  startAutoRenew(): void {
    if (this.#renewTimer !== null) return;
    const timer = setInterval(() => {
      void this.renewIfExpiringSoon();
    }, RENEW_CHECK_INTERVAL_MS);
    timer.unref?.();
    this.#renewTimer = timer;
  }

  stopAutoRenew(): void {
    if (this.#renewTimer === null) return;
    clearInterval(this.#renewTimer);
    this.#renewTimer = null;
  }

  /**
   * One check, awaited.
   *
   * Public because startup wants to *wait* for it: an app opened after the token
   * died should renew before it decides whether to put a sign-in window in front
   * of the user, and the periodic timer's fire-and-forget version would race
   * that decision.
   */
  async renewIfExpiringSoon(): Promise<void> {
    if (this.#renewer === undefined || !this.#autoRenew()) return;
    // An API key never expires, and the CLI login is not what we are using.
    if ((await this.#store.getApiKey()) !== null) return;
    if (this.#envToken !== undefined && this.#envToken.length > 0) return;

    const expiry = await this.#cli.peekExpiry();
    if (expiry === null) return; // Nothing to renew from — see `getBearer`.
    if (expiry.getTime() - Date.now() > RENEW_MARGIN_MS) return;

    await this.#renewAndReread('the Grok token is close to expiry');
  }

  async status(): Promise<AuthStatus> {
    const stored = await this.#store.getApiKey();
    if (stored !== null) {
      return { state: 'signed-in', source: 'api-key', expiresAt: null };
    }
    if (this.#envToken !== undefined && this.#envToken.length > 0) {
      return { state: 'signed-in', source: 'environment', expiresAt: null };
    }

    const cli = await this.#cli.getBearer();
    if (cli.ok) {
      return {
        state: 'signed-in',
        source: 'grok-cli',
        expiresAt: cli.value.expiresAt.toISOString(),
      };
    }
    if (cli.error.code === 'auth_expired') {
      const expiry = await this.#cli.peekExpiry();
      return {
        state: 'expired',
        source: 'grok-cli',
        expiresAt: expiry?.toISOString() ?? new Date(0).toISOString(),
      };
    }
    return { state: 'signed-out' };
  }

  async refresh(): Promise<AuthStatus> {
    const next = await this.status();
    this.#emit(next);
    return next;
  }

  async setApiKey(raw: string): Promise<Result<AuthStatus>> {
    const validated = validateApiKey(raw);
    if (!validated.ok) return validated;
    const written = await this.#store.setApiKey(validated.value);
    if (!written.ok) return written;
    const next = await this.status();
    this.#emit(next);
    return ok(next);
  }

  async clearApiKey(): Promise<AuthStatus> {
    await this.#store.clearApiKey();
    const next = await this.status();
    this.#emit(next);
    return next;
  }

  #emit(status: AuthStatus): void {
    for (const listener of this.#listeners) listener(status);
  }
}

/**
 * Resolve `promise` if it settles within `ms`, otherwise `null`.
 *
 * The promise is not cancelled — nothing here can cancel it, and in the one
 * place this is used that is the desired behaviour rather than a limitation.
 */
async function waitAtMost<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, expired]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export function createAuthProvider(logger: Logger, options: DictateAuthOptions): DictateAuth {
  return new DictateAuth(logger, options);
}
