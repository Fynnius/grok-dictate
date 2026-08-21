/**
 * Auth tests.
 *
 * Three things are being proven here, in order of importance:
 *
 *   1. **The token cannot escape.** Not into a log line, not into an
 *      `AppError.message`, not into a `hint`, not into a `cause`. The last test
 *      in this file runs a real 838-character JWT through every failure path
 *      and greps everything that came out.
 *   2. **The format guard holds** (assumption 10.1). Every way `auth.json` can
 *      degrade produces an actionable error rather than a crash or a silent
 *      `undefined` bearer.
 *   3. **Expiry is enforced with the 60 s margin** (IMPLEMENTATION-PLAN.md
 *      §3.3), so a token cannot die mid-utterance.
 *
 * There is deliberately no test for a refresh path, because there is no refresh
 * path — see the grep at the bottom, which asserts that in source.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_EXPIRY_MARGIN_MS } from '@shared/constants.js';
import {
  addLogSink,
  clearLogSinks,
  createLogger,
  setLogLevel,
  type LogRecord,
} from '@shared/logger.js';
import {
  DictateAuth,
  GrokAuthProvider,
  parseAuthDocument,
  type DictateAuthOptions,
} from './index.js';
import { CredentialStore, type SecretBox } from './store.js';
import type { GrokCliRenewer } from './renew.js';

/**
 * A structurally real JWT: `eyJ` header, three segments, 838 characters — the
 * length  observed. Not a live credential.
 */
const FAKE_JWT = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6ImZha2Uta2V5LTAwMSJ9.${'QWxsIG9mIHRoaXMgaXMgc3ludGhldGljIHBheWxvYWQgZm9yIHRlc3Rpbmcgb25seQ'.repeat(11)}.c2lnbmF0dXJlLXRoYXQtaXMtbm90LXJlYWwtYnV0LWlzLWxvbmc`;

const SCOPE = 'https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828';
const NOW = Date.parse('2026-08-08T20:00:00.000Z');

function authDocument(overrides: Record<string, unknown> = {}): unknown {
  return {
    [SCOPE]: {
      key: FAKE_JWT,
      refresh_token: 'V0hBVC1BLVJFRlJFU0gtVE9LRU4tVEhBVC1JUy04Ni1DSEFSUy1MT05HLUlTSA',
      expires_at: new Date(NOW + 2 * 60 * 60 * 1000).toISOString(),
      auth_mode: 'oidc',
      email: 'someone@example.com',
      coding_data_retention_opt_out: true,
      ...overrides,
    },
  };
}

let dir: string;
let path: string;
const logged: LogRecord[] = [];
const lines: string[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grok-dictate-auth-'));
  path = join(dir, 'auth.json');
  logged.length = 0;
  lines.length = 0;
  clearLogSinks();
  setLogLevel('debug');
  addLogSink((line, record) => {
    lines.push(line);
    logged.push(record);
  });
});

afterEach(() => {
  clearLogSinks();
  rmSync(dir, { recursive: true, force: true });
});

function provider(): GrokAuthProvider {
  return new GrokAuthProvider(createLogger('test'), { path, now: () => NOW });
}

function write(value: unknown): void {
  writeFileSync(path, JSON.stringify(value), 'utf8');
}

describe('parseAuthDocument — the format guard (assumption 10.1)', () => {
  it('takes `key` as the bearer and `expires_at` as the expiry', () => {
    const result = parseAuthDocument(authDocument(), path, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBe(FAKE_JWT);
    expect(result.value.expiresAt.toISOString()).toBe(new Date(NOW + 7_200_000).toISOString());
  });

  it.each([
    ['a JSON array', []],
    ['a JSON string', 'nope'],
    ['null', null],
    ['an empty object', {}],
    ['a scope whose value is not an object', { [SCOPE]: 'nope' }],
    ['a scope with no `key`', { [SCOPE]: { expires_at: '2099-01-01T00:00:00Z' } }],
    ['a scope with an empty `key`', { [SCOPE]: { key: '', expires_at: '2099-01-01T00:00:00Z' } }],
    ['a scope with no `expires_at`', { [SCOPE]: { key: FAKE_JWT } }],
    ['an unparseable `expires_at`', { [SCOPE]: { key: FAKE_JWT, expires_at: 'soon' } }],
  ])('rejects %s with an actionable auth_malformed error', (_label, document) => {
    const result = parseAuthDocument(document, path, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth_malformed');
    // §4: every error a human could act on carries a hint that says what to do.
    expect(result.error.hint).toContain('grok');
  });

  it('uses the first usable scope when the file holds several', () => {
    const result = parseAuthDocument(
      {
        'https://auth.x.ai::stale': { key: 'no-expiry' },
        [SCOPE]: { key: FAKE_JWT, expires_at: new Date(NOW + 7_200_000).toISOString() },
      },
      path,
      NOW,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBe(FAKE_JWT);
  });
});

describe('expiry (IMPLEMENTATION-PLAN.md §3.3 — a ≥60 s margin)', () => {
  it('accepts a token with more than the margin left', () => {
    const expires_at = new Date(NOW + TOKEN_EXPIRY_MARGIN_MS + 1000).toISOString();
    expect(parseAuthDocument(authDocument({ expires_at }), path, NOW).ok).toBe(true);
  });

  it('refuses a token inside the margin, so a session cannot die mid-utterance', () => {
    const expires_at = new Date(NOW + TOKEN_EXPIRY_MARGIN_MS - 1000).toISOString();
    const result = parseAuthDocument(authDocument({ expires_at }), path, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth_expired');
    expect(result.error.message).toContain('too soon');
  });

  it('reports an expired token with the wall-clock time and the fix', () => {
    const expiry = new Date(NOW - 60_000);
    const result = parseAuthDocument(authDocument({ expires_at: expiry.toISOString() }), path, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth_expired');
    // §4's worked example: "token expired at 21:58 — run `grok` to refresh".
    const hh = String(expiry.getHours()).padStart(2, '0');
    const mm = String(expiry.getMinutes()).padStart(2, '0');
    expect(result.error.message).toContain(`${hh}:${mm}`);
    expect(result.error.hint).toMatch(/grok/);
  });
});

describe('GrokAuthProvider — reading the file', () => {
  it('reads a valid file and returns the bearer', async () => {
    write(authDocument());
    const result = await provider().getBearer();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.token).toBe(FAKE_JWT);
  });

  it('says how to sign in when the file does not exist', async () => {
    const result = await provider().getBearer();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth_missing');
    expect(result.error.hint).toContain('grok');
    expect(result.error.hint).toMatch(/Sign in|API key/);
  });

  it('reports invalid JSON without quoting the file', async () => {
    writeFileSync(path, `{"${SCOPE}": {"key": "${FAKE_JWT}"`, 'utf8');
    const result = await provider().getBearer();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth_malformed');
    expect(JSON.stringify(result.error)).not.toContain(FAKE_JWT);
  });

  it('re-reads the file on every call, so `grok login` takes effect immediately', async () => {
    const auth = provider();
    const expired = await auth.getBearer();
    expect(expired.ok).toBe(false);

    write(authDocument());
    const fresh = await auth.getBearer();
    expect(fresh.ok).toBe(true);
  });

  it('warns but still works when the bearer is not JWT-shaped', async () => {
    write(authDocument({ key: 'opaque-token-value' }));
    const result = await provider().getBearer();
    expect(result.ok).toBe(true);
    const warning = logged.find((r) => r.msg.includes('not JWT-shaped'));
    expect(warning).toBeDefined();
    // Length only — never the value.
    expect(warning?.fields).toMatchObject({ length: 'opaque-token-value'.length });
  });

  it('warns when auth.json holds more than one scope', async () => {
    write({
      'https://auth.x.ai::other': { key: FAKE_JWT, expires_at: '2020-01-01T00:00:00Z' },
      ...(authDocument() as Record<string, unknown>),
    });
    await provider().getBearer();
    expect(logged.some((r) => r.msg.includes('more than one scope'))).toBe(true);
  });
});

describe('the token never escapes', () => {
  /**
   * Assertions are written so a *failure* never prints the secret: we test
   * `includes` on a boolean rather than comparing strings, and report only the
   * route that leaked.
   */
  function assertClean(where: string, haystack: string): void {
    expect(`${where}:${String(haystack.includes(FAKE_JWT))}`).toBe(`${where}:false`);
  }

  it('is absent from every log line and record produced by a successful read', async () => {
    write(authDocument());
    const result = await provider().getBearer();
    expect(result.ok).toBe(true);

    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) assertClean('log line', line);
    for (const record of logged) assertClean('log record', JSON.stringify(record));
  });

  it('is absent from every error, hint and cause on every failure path', async () => {
    const documents: unknown[] = [
      // Malformed in a way that still contains the token.
      { [SCOPE]: { key: FAKE_JWT } },
      { [SCOPE]: { key: FAKE_JWT, expires_at: 'not-a-date' } },
      // Expired, with the token present.
      authDocument({ expires_at: new Date(NOW - 1000).toISOString() }),
      // Nested somewhere unexpected.
      { [SCOPE]: { key: FAKE_JWT, expires_at: 'x', nested: { deeper: FAKE_JWT } } },
    ];

    for (const document of documents) {
      write(document);
      const result = await provider().getBearer();
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      assertClean('error', JSON.stringify(result.error));
      assertClean('message', result.error.message);
      assertClean('hint', result.error.hint ?? '');
    }

    for (const line of lines) assertClean('log line', line);
  });

  it('does not write log messages that the redaction layer mangles', () => {
    // Found in the field during Phase 3's HT-1. The message used to be "bearer
    // loaded", and `redact.ts`'s `BEARER_PATTERN` (`/\bbearer\s+\S+/gi`) rewrote
    // it to "Bearer [REDACTED]" — a log line that reads exactly like a caught
    // credential leak and sent me looking for one. The redaction was correct;
    // the message was the bug.
    return provider()
      .getBearer()
      .then(async () => {
        write(authDocument({ key: 'opaque-token-value' }));
        await provider().getBearer();
        write(authDocument());
        await provider().getBearer();

        expect(logged.length).toBeGreaterThan(0);
        for (const record of logged) {
          expect(`${record.msg} → ${String(record.msg.includes('[REDACTED]'))}`).toBe(
            `${record.msg} → false`,
          );
        }
        expect(logged.some((r) => r.msg === 'token loaded from auth.json')).toBe(true);
      });
  });
});

describe('DictateAuth', () => {
  function box(): SecretBox {
    return {
      isAvailable: () => true,
      encrypt: (plain) => Buffer.from(plain, 'utf8'),
      decrypt: (cipher) => cipher.toString('utf8'),
    };
  }

  it('prefers a stored API key over the Grok CLI file', async () => {
    write(authDocument());
    const auth = new DictateAuth(createLogger('test'), {
      store: new CredentialStore(join(dir, 'credentials.json'), box(), createLogger('test')),
      cli: { path, now: () => NOW },
    });
    const saved = await auth.setApiKey('xai-from-the-sign-in-window');
    expect(saved.ok).toBe(true);
    const bearer = await auth.getBearer();
    expect(bearer.ok).toBe(true);
    if (!bearer.ok) return;
    expect(bearer.value.token).toBe('xai-from-the-sign-in-window');
    const status = await auth.status();
    expect(status).toEqual({ state: 'signed-in', source: 'api-key', expiresAt: null });
  });

  it('falls back to the Grok CLI file when no key is stored', async () => {
    write(authDocument());
    const auth = new DictateAuth(createLogger('test'), {
      store: new CredentialStore(join(dir, 'credentials.json'), box(), createLogger('test')),
      cli: { path, now: () => NOW },
    });
    const status = await auth.status();
    expect(status.state).toBe('signed-in');
    if (status.state !== 'signed-in') return;
    expect(status.source).toBe('grok-cli');
  });

  it('reports signed-out when nothing is available', async () => {
    const auth = new DictateAuth(createLogger('test'), {
      store: new CredentialStore(join(dir, 'credentials.json'), box(), createLogger('test')),
      cli: { path: join(dir, 'missing.json'), now: () => NOW },
    });
    await expect(auth.status()).resolves.toEqual({ state: 'signed-out' });
  });

  /**
   * Renewal by delegation.
   *
   * The renewer is a stub whose `renew` rewrites `auth.json` — which is exactly
   * what the real one causes, one process removed. What is asserted here is the
   * policy around it: when we are willing to spend a second of a key press on
   * spawning something, and when we are not.
   */
  describe('automatic login renewal', () => {
    /** Stands in for `GrokCliRenewer`, recording what it was asked to do. */
    function stubRenewer(onRun: () => void): {
      renewer: GrokCliRenewer;
      calls: () => number;
      outcomes: boolean[];
    } {
      let calls = 0;
      const outcomes: boolean[] = [];
      const renewer = {
        renew: (): Promise<{ kind: 'ran'; exitCode: number | null; durationMs: number }> => {
          calls++;
          onRun();
          return Promise.resolve({ kind: 'ran' as const, exitCode: 0, durationMs: 5 });
        },
        recordOutcome: (renewed: boolean): void => {
          outcomes.push(renewed);
        },
      };
      return {
        renewer: renewer as unknown as GrokCliRenewer,
        calls: () => calls,
        outcomes,
      };
    }

    function build(options: Partial<DictateAuthOptions>): DictateAuth {
      return new DictateAuth(createLogger('test'), {
        store: new CredentialStore(join(dir, 'credentials.json'), box(), createLogger('test')),
        cli: { path, now: () => NOW },
        ...options,
      });
    }

    it('renews an expired token and returns the renewed bearer', async () => {
      write(authDocument({ expires_at: new Date(NOW - 1000).toISOString() }));
      const { renewer, calls, outcomes } = stubRenewer(() => {
        // What the CLI does: a fresh token, written in place under its own lock.
        write(authDocument({ expires_at: new Date(NOW + 3 * 60 * 60 * 1000).toISOString() }));
      });

      const bearer = await build({ renewer }).getBearer();

      expect(calls()).toBe(1);
      expect(bearer.ok).toBe(true);
      if (!bearer.ok) return;
      expect(bearer.value.expiresAt.getTime()).toBe(NOW + 3 * 60 * 60 * 1000);
      // The verdict comes from re-reading the file, never from the exit code.
      expect(outcomes).toEqual([true]);
    });

    it('reports the original error when the renewal changes nothing', async () => {
      write(authDocument({ expires_at: new Date(NOW - 1000).toISOString() }));
      const { renewer, calls, outcomes } = stubRenewer(() => undefined);

      const bearer = await build({ renewer }).getBearer();

      expect(calls()).toBe(1);
      expect(bearer.ok).toBe(false);
      if (bearer.ok) return;
      expect(bearer.error.code).toBe('auth_expired');
      expect(outcomes).toEqual([false]);
    });

    it('does not spawn anything when there is nothing to refresh from', async () => {
      // No file at all: the user never signed in, or a rejected refresh made the
      // CLI clear it. Either way `grok` cannot help, and a second of latency on
      // every key press to prove it is not a trade worth making.
      const { renewer, calls } = stubRenewer(() => undefined);
      const bearer = await build({
        cli: { path: join(dir, 'missing.json'), now: () => NOW },
        renewer,
      }).getBearer();

      expect(calls()).toBe(0);
      expect(bearer.ok).toBe(false);
      if (bearer.ok) return;
      expect(bearer.error.code).toBe('auth_missing');
    });

    it('does not spawn anything for a malformed file', async () => {
      write({ 'some-scope': { nonsense: true } });
      const { renewer, calls } = stubRenewer(() => undefined);
      const bearer = await build({ renewer }).getBearer();
      expect(calls()).toBe(0);
      expect(bearer.ok).toBe(false);
    });

    it('honours the setting being switched off', async () => {
      write(authDocument({ expires_at: new Date(NOW - 1000).toISOString() }));
      const { renewer, calls } = stubRenewer(() => undefined);
      const bearer = await build({ renewer, autoRenew: () => false }).getBearer();
      expect(calls()).toBe(0);
      expect(bearer.ok).toBe(false);
    });

    it('never spawns for an API key, which cannot expire', async () => {
      write(authDocument({ expires_at: new Date(NOW - 1000).toISOString() }));
      const { renewer, calls } = stubRenewer(() => undefined);
      const auth = build({ renewer });
      await auth.setApiKey('xai-a-perfectly-good-api-key');

      expect((await auth.getBearer()).ok).toBe(true);
      await auth.renewIfExpiringSoon();
      expect(calls()).toBe(0);
    });

    it('renews ahead of expiry, inside the window the CLI will act on', async () => {
      // Three minutes left: inside this app's four-minute margin, and inside the
      // CLI's own five-minute one, so the spawn actually accomplishes something.
      write(authDocument({ expires_at: new Date(Date.now() + 3 * 60_000).toISOString() }));
      const { renewer, calls } = stubRenewer(() => undefined);
      await build({ renewer, cli: { path } }).renewIfExpiringSoon();
      expect(calls()).toBe(1);
    });

    it('leaves a token with plenty of life alone', async () => {
      write(authDocument({ expires_at: new Date(Date.now() + 60 * 60_000).toISOString() }));
      const { renewer, calls } = stubRenewer(() => undefined);
      await build({ renewer, cli: { path } }).renewIfExpiringSoon();
      expect(calls()).toBe(0);
    });
  });
});

describe('no refresh path', () => {
  it('has no refresh path in the source', () => {
    // Phase 5 §5b audits this across the whole app; this is the local guard, so
    // a well-meaning future edit to *this* file fails a test rather than a
    // review. `grant_type=refresh_token` is the shape of the request that would
    // break the Grok CLI login.
    const source = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('grant_type');
    expect(source).not.toContain('oauth2/token');
    // `refresh_token` appears only inside comments explaining why it is unused.
    const code = source
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('*') && !l.trimStart().startsWith('//'))
      .join('\n');
    expect(code).not.toContain('refresh_token');
  });
});
