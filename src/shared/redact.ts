/**
 * Secret redaction.
 *
 * IMPLEMENTATION-PLAN.md §3.1.1 requires "a **mandatory** redaction layer: any
 * string matching a JWT shape or containing `Bearer` is redacted before it
 * reaches a log sink", and §4 restates it as "No secrets in logs, ever."
 *
 * The threat is concrete rather than theoretical: the app's bearer is an
 * 838-character OIDC JWT read out of `~/.grok/auth.json`, and
 * leaking it into a log file, a crash report, or the history store would hand
 * over the user's whole Grok subscription.  lists exactly those
 * four sinks.
 *
 * The design point that matters: redaction is applied *inside* the logger core
 * (see `logger.ts`), operating on the fully serialised record, so a caller
 * cannot opt out and a sink cannot receive raw data. Call-site discipline is
 * not relied upon anywhere.
 */

export const REDACTED_JWT = '[REDACTED:jwt]';
export const REDACTED_BEARER = 'Bearer [REDACTED]';
export const REDACTED_OPAQUE = '[REDACTED:opaque]';
export const REDACTED_FIELD = '[REDACTED]';

/**
 * A JSON Web Token. The first segment is base64url of a JSON object, so a real
 * JWT header always begins `eyJ` — anchoring on that keeps the pattern precise.
 * A looser "three dotted base64url runs" pattern also matches ordinary dotted
 * identifiers (`application.services.controller`), which would corrode logs.
 */
const JWT_PATTERN = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]+/g;

/** `Authorization: Bearer <anything>` in any casing, header or prose. */
const BEARER_PATTERN = /\bbearer\s+\S+/gi;

/**
 * Long opaque credentials that are not JWTs — notably the 86-character
 * `refresh_token` in `auth.json`.
 *
 * Length alone would swallow git SHAs and hex digests, so a run must also look
 * like a random token rather than an identifier: it must mix letters and
 * digits, and additionally use mixed case or base64url punctuation. A SHA-256
 * hex digest (64 lowercase hex chars) therefore survives; a base64url secret
 * does not.
 */
const OPAQUE_PATTERN = /\b[A-Za-z0-9_-]{40,}\b/g;

function looksLikeOpaqueSecret(run: string): boolean {
  const hasLetter = /[A-Za-z]/.test(run);
  const hasDigit = /[0-9]/.test(run);
  const mixedCase = /[a-z]/.test(run) && /[A-Z]/.test(run);
  const hasB64Punct = /[-_]/.test(run);
  return hasLetter && hasDigit && (mixedCase || hasB64Punct);
}

/**
 * Object keys whose *value* is redacted wholesale, whatever shape it has. This
 * catches secrets that carry no recognisable string shape at all — a token
 * split across an array, or one short enough to dodge `OPAQUE_PATTERN`.
 *
 * The names mirror the real `auth.json` fields plus the usual
 * suspects.
 */
const SENSITIVE_KEY_PATTERN =
  /^(key|token|access_?token|refresh_?token|id_?token|authorization|auth|bearer|password|passwd|secret|client_?secret|api_?key|apikey|credential|credentials|cookie|session_?token)$/i;

/** True when a field name means "this value is a secret". Exported for tests. */
export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

/**
 * Scrub secrets out of a single string. Total: never throws, always returns a
 * string. Order matters — `Bearer eyJ…` must be caught by the bearer rule
 * first so the result reads `Bearer [REDACTED]` rather than `Bearer
 * [REDACTED:jwt]`.
 */
export function redactString(input: string): string {
  return input
    .replace(BEARER_PATTERN, REDACTED_BEARER)
    .replace(JWT_PATTERN, REDACTED_JWT)
    .replace(OPAQUE_PATTERN, (run) => (looksLikeOpaqueSecret(run) ? REDACTED_OPAQUE : run));
}

const MAX_DEPTH = 12;

/**
 * Structurally redact an arbitrary value: sensitive keys lose their value
 * entirely, every string is scrubbed, and `Error`s are reduced to a plain
 * object (their `message` and `stack` are prime leak paths — an HTTP client
 * that stringifies a request into an error message will otherwise carry the
 * `Authorization` header straight into a log).
 *
 * Cycles and over-deep structures are collapsed rather than throwing, because
 * a logger that can throw is a logger that takes the app down.
 */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? redactString(value.toString()) : value;
  }
  if (depth >= MAX_DEPTH) return '[truncated]';
  if (seen.has(value)) return '[circular]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack === undefined ? {} : { stack: redactString(value.stack) }),
    };
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1, seen));
  }
  if (value instanceof Map) {
    return Object.fromEntries(
      [...value.entries()].map(([k, v]) => [
        String(k),
        isSensitiveKey(String(k)) ? REDACTED_FIELD : redactValue(v, depth + 1, seen),
      ]),
    );
  }
  if (value instanceof Set) {
    return [...value].map((item) => redactValue(item, depth + 1, seen));
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof ArrayBuffer) return `[binary ${value.byteLength}B]`;
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength}B]`;

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = isSensitiveKey(k) ? REDACTED_FIELD : redactValue(v, depth + 1, seen);
  }
  return out;
}

/**
 * Serialise a redacted value to a single line, then scrub the *serialised text*
 * a second time.
 *
 * The second pass is deliberate belt-and-braces: a custom `toJSON`, a getter,
 * or an exotic object could reintroduce a raw secret during stringification,
 * after the structural walk has already run. This function is the only thing
 * standing between the app and a leaked token, so it does not assume the walk
 * was complete.
 */
export function serialiseRedacted(value: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(redactValue(value)) ?? 'null';
  } catch {
    json = '"[unserialisable]"';
  }
  return redactString(json);
}
