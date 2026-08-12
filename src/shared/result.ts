/**
 * A tiny Result type.
 *
 * Used where a failure is an expected outcome that carries user-facing text —
 * a missing `auth.json`, a rejected insertion, a malformed helper frame — as
 * opposed to a programmer error, which still throws.
 *
 * IMPLEMENTATION-PLAN.md §4: "Errors carry actionable text. 'STT failed' is a
 * defect; 'token expired at 21:58 — run `grok` to refresh' is correct." The
 * `AppError` shape below enforces that by making `hint` a first-class field
 * rather than something a caller may forget to write.
 */

export type Result<T, E = AppError> = { ok: true; value: T } | { ok: false; error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/**
 * Machine-readable failure classes. The set is deliberately small and
 * cross-cutting; each phase maps its own failures onto one of these so the HUD
 * and history can render them uniformly.
 */
export const ERROR_CODES = [
  'auth_missing', // ~/.grok/auth.json absent or unreadable
  'auth_expired', // token past expires_at
  'auth_malformed', // file present but not the expected shape (assumption 10.1)
  'audio_permission', // microphone denied
  'audio_device', // no device / device vanished
  'stt_connect', // handshake failed
  'stt_protocol', // server sent something unusable
  'stt_rate_limited', // HTTP 429
  'stt_no_speech', // 10s watchdog (pipeline.rs:198 NO_SPEECH_TIMEOUT)
  'insert_failed', // both AX and Unicode tiers declined
  'insert_blocked', // Secure Input active
  'helper_unavailable', // Swift helper not running / died
  'helper_protocol', // malformed JSON-lines frame
  'config_invalid',
  'internal',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface AppError {
  readonly code: ErrorCode;
  /** What happened, in plain language. Shown to the user. */
  readonly message: string;
  /**
   * What the user should do about it. Required for every error that a human
   * could act on; `null` only where genuinely nothing can be done.
   */
  readonly hint: string | null;
  /** Original cause, for logs. Never rendered to the user. */
  readonly cause?: unknown;
}

export function appError(
  code: ErrorCode,
  message: string,
  hint: string | null,
  cause?: unknown,
): AppError {
  return { code, message, hint, ...(cause === undefined ? {} : { cause }) };
}

/** Render an error the way the HUD and logs should show it. */
export function formatError(error: AppError): string {
  return error.hint === null ? error.message : `${error.message} — ${error.hint}`;
}

export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** Narrow an unknown thrown value into something loggable. */
export function toAppError(cause: unknown, code: ErrorCode = 'internal'): AppError {
  const message = cause instanceof Error ? cause.message : String(cause);
  return appError(code, message, null, cause);
}
