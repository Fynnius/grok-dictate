import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  REDACTED_BEARER,
  REDACTED_FIELD,
  REDACTED_JWT,
  REDACTED_OPAQUE,
  isSensitiveKey,
  redactString,
  redactValue,
  serialiseRedacted,
} from './redact.js';

/**
 * A synthetic token with the same shape as the real one: three base64url
 * segments, header starting `eyJ`, ~838 characters total.
 * Deliberately synthetic — no real credential is ever committed.
 */
const FAKE_JWT = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${'aB3dEf9hIjKlMn0pQrStUvWxYz12'.repeat(
  20,
)}.${'Zy9xWv8tSrQpOnMlKjIhGfEdCbA7'.repeat(8)}`;

/** Same shape as the 86-character opaque `refresh_token`. */
const FAKE_REFRESH =
  'r8Kq2Vb7Nz4Xm1Pc6Ld9Tj3Hs5Yw0Ge-Uf2Ai8Bo4Rn6Qk1Zv7Xd3Mp9Ct5Ly0Ws6Er2Tu8Yi4Oa1Pj7Hk3';

describe('redactString', () => {
  it('redacts a JWT anywhere in a string', () => {
    const out = redactString(`connecting with token ${FAKE_JWT} to api.x.ai`);
    expect(out).toContain(REDACTED_JWT);
    expect(out).not.toContain(FAKE_JWT);
    expect(out).toContain('connecting with token');
  });

  it('redacts a Bearer header including the token after it', () => {
    const out = redactString(`Authorization: Bearer ${FAKE_JWT}`);
    expect(out).toBe(`Authorization: ${REDACTED_BEARER}`);
  });

  it('redacts "Bearer" case-insensitively, as it appears in header dumps', () => {
    expect(redactString('authorization: bearer abc123')).toContain(REDACTED_BEARER);
    expect(redactString('BEARER abc123')).toContain('[REDACTED]');
  });

  it('redacts a long opaque credential such as the refresh token', () => {
    const out = redactString(`refresh=${FAKE_REFRESH}`);
    expect(out).toBe(`refresh=${REDACTED_OPAQUE}`);
  });

  it('leaves ordinary log prose alone', () => {
    const prose = 'stt: speech_final after 412ms, duration=3.8s, endpointing=400';
    expect(redactString(prose)).toBe(prose);
  });

  it('leaves dotted identifiers alone (they are not JWTs)', () => {
    const text = 'com.microsoft.VSCode frontmost; application.services.controller ready';
    expect(redactString(text)).toBe(text);
  });

  it('leaves hex digests alone — length alone must not trigger redaction', () => {
    const sha1 = '3e620a76a5f374ce644dc7c87f7e990c68348218'; // the real SOURCE_REV, 40 chars
    expect(redactString(`SOURCE_REV ${sha1}`)).toBe(`SOURCE_REV ${sha1}`);
  });

  it('leaves UUIDs alone (hyphens split them below the length threshold)', () => {
    const id = 'f078bb34-98f0-4104-b521-205955787fa6';
    expect(redactString(id)).toBe(id);
  });
});

describe('isSensitiveKey', () => {
  it('matches the real auth.json secret fields', () => {
    expect(isSensitiveKey('key')).toBe(true);
    expect(isSensitiveKey('refresh_token')).toBe(true);
    expect(isSensitiveKey('Authorization')).toBe(true);
  });

  it('does not match the harmless auth.json fields', () => {
    for (const k of ['expires_at', 'auth_mode', 'oidc_issuer', 'user_id', 'email']) {
      expect(isSensitiveKey(k)).toBe(false);
    }
  });
});

describe('redactValue', () => {
  it('redacts sensitive keys whatever the value shape', () => {
    const out = redactValue({
      key: FAKE_JWT,
      refresh_token: FAKE_REFRESH,
      expires_at: '2026-08-08',
    });
    expect(out).toEqual({
      key: REDACTED_FIELD,
      refresh_token: REDACTED_FIELD,
      expires_at: '2026-08-08',
    });
  });

  it('redacts secrets nested in arrays and objects', () => {
    const out = serialiseRedacted({
      headers: [{ name: 'authorization', value: `Bearer ${FAKE_JWT}` }],
    });
    expect(out).not.toContain(FAKE_JWT);
  });

  it('redacts Error messages and stacks', () => {
    const err = new Error(`request failed: Authorization: Bearer ${FAKE_JWT}`);
    const out = serialiseRedacted({ err });
    expect(out).not.toContain(FAKE_JWT);
    expect(out).toContain('request failed');
  });

  it('survives circular structures instead of throwing', () => {
    const a: Record<string, unknown> = { name: 'a' };
    a['self'] = a;
    expect(() => serialiseRedacted(a)).not.toThrow();
    expect(serialiseRedacted(a)).toContain('[circular]');
  });

  it('summarises binary payloads rather than dumping PCM into the log', () => {
    expect(redactValue(new Uint8Array(3200))).toBe('[binary 3200B]');
  });

  it('never throws on unserialisable input', () => {
    const bad = {
      toJSON() {
        throw new Error('nope');
      },
    };
    expect(() => serialiseRedacted(bad)).not.toThrow();
  });

  it('catches a secret reintroduced by a custom toJSON, after the structural walk', () => {
    // The structural walk cannot see through `toJSON`; the second pass over the
    // serialised text is what stops this leak. This test is the reason that
    // second pass exists.
    const sneaky = {
      toJSON() {
        return { note: `Bearer ${FAKE_JWT}` };
      },
    };
    expect(serialiseRedacted({ sneaky })).not.toContain(FAKE_JWT);
  });
});

describe('the real credential on this machine', () => {
  // Proves the redaction rules cover the *actual* token shape rather than only
  // the synthetic one. Skipped when the user is not logged in. Assertions are
  // written so that a failure never prints the secret.
  const authPath = join(homedir(), '.grok', 'auth.json');
  let realSecrets: string[] = [];
  try {
    const parsed: unknown = JSON.parse(readFileSync(authPath, 'utf8'));
    if (parsed !== null && typeof parsed === 'object') {
      for (const scope of Object.values(parsed as Record<string, unknown>)) {
        if (scope !== null && typeof scope === 'object') {
          const rec = scope as Record<string, unknown>;
          for (const field of ['key', 'refresh_token']) {
            const v = rec[field];
            if (typeof v === 'string' && v.length > 0) realSecrets.push(v);
          }
        }
      }
    }
  } catch {
    realSecrets = [];
  }

  it.skipIf(realSecrets.length === 0)('cannot be logged by any route', () => {
    for (const secret of realSecrets) {
      const routes = [
        secret,
        `Authorization: Bearer ${secret}`,
        JSON.stringify({ nested: { deeper: [secret] } }),
      ];
      for (const route of routes) {
        expect(redactString(route).includes(secret), 'secret survived redactString').toBe(false);
        expect(
          serialiseRedacted({ msg: route, err: new Error(route) }).includes(secret),
          'secret survived serialiseRedacted',
        ).toBe(false);
      }
      expect(
        serialiseRedacted({ key: secret, refresh_token: secret }).includes(secret),
        'secret survived key-based redaction',
      ).toBe(false);
    }
  });
});
