import { describe, expect, it } from 'vitest';
import type { CliAuthStatus } from '@contracts/events.js';
import { createLogger } from '@shared/logger.js';
import { appleScriptForGrokLogin, GrokCliLogin, shellQuote } from './login.js';

const logger = (): ReturnType<typeof createLogger> => createLogger('test');

const SIGNED_IN: CliAuthStatus = {
  state: 'signed-in',
  expiresAt: '2026-08-08T22:00:00.000Z',
};

const SIGNED_OUT: CliAuthStatus = { state: 'signed-out' };

describe('appleScriptForGrokLogin', () => {
  it('asks Terminal to run grok login, quoted for the shell', () => {
    const script = appleScriptForGrokLogin('/Users/someone/.grok/bin/grok');
    expect(script).toContain('tell application "Terminal"');
    expect(script).toContain('activate');
    expect(script).toContain(`do script "${shellQuote('/Users/someone/.grok/bin/grok')} login"`);
  });

  it('keeps spaces in the path inside single quotes', () => {
    const script = appleScriptForGrokLogin('/tmp/My Grok/grok');
    expect(script).toContain("'/tmp/My Grok/grok' login");
  });

  it('escapes a double quote so AppleScript stays valid', () => {
    const script = appleScriptForGrokLogin('/tmp/foo"bar/grok');
    expect(script).toContain('\\"');
    expect(script).toContain('login');
  });
});

describe('GrokCliLogin', () => {
  it('refuses to start when the CLI is not installed, and does not open Terminal', async () => {
    let launched = 0;
    const login = new GrokCliLogin({
      logger: logger(),
      status: () => Promise.resolve(SIGNED_OUT),
      home: '/Users/someone',
      exists: () => false,
      launch: () => {
        launched += 1;
        return Promise.resolve();
      },
    });

    expect(login.available).toBe(false);
    const result = await login.start();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('auth_missing');
    expect(result.error.hint).toMatch(/GROK_DICTATE_GROK_BIN/);
    expect(launched).toBe(0);
  });

  it('does not open Terminal when the CLI file is already usable', async () => {
    let launched = 0;
    const login = new GrokCliLogin({
      logger: logger(),
      status: () => Promise.resolve(SIGNED_IN),
      override: '/bin/grok',
      exists: () => true,
      launch: () => {
        launched += 1;
        return Promise.resolve();
      },
    });

    const result = await login.start();
    expect(result).toEqual({ ok: true, value: SIGNED_IN });
    expect(launched).toBe(0);
  });

  it('opens Terminal and resolves once the file becomes usable', async () => {
    const launched: string[] = [];
    let calls = 0;
    let signedIn = 0;
    const login = new GrokCliLogin({
      logger: logger(),
      status: () => {
        calls += 1;
        return Promise.resolve(calls >= 3 ? SIGNED_IN : SIGNED_OUT);
      },
      onSignedIn: () => {
        signedIn += 1;
      },
      override: '/bin/grok',
      exists: () => true,
      pollMs: 5,
      launch: (script) => {
        launched.push(script);
        return Promise.resolve();
      },
    });

    const result = await login.start();
    expect(result).toEqual({ ok: true, value: SIGNED_IN });
    expect(launched).toHaveLength(1);
    expect(launched[0]).toContain('login');
    expect(launched[0]).toContain("'/bin/grok'");
    expect(signedIn).toBe(1);
  });

  it('shares one wait between concurrent callers', async () => {
    let launches = 0;
    let calls = 0;
    const login = new GrokCliLogin({
      logger: logger(),
      status: () => {
        calls += 1;
        return Promise.resolve(calls >= 3 ? SIGNED_IN : SIGNED_OUT);
      },
      override: '/bin/grok',
      exists: () => true,
      pollMs: 5,
      launch: () => {
        launches += 1;
        return Promise.resolve();
      },
    });

    const [first, second] = await Promise.all([login.start(), login.start()]);
    expect(launches).toBe(1);
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true, value: SIGNED_IN });
  });

  it('cancel stops waiting without claiming a login, and does not throw', async () => {
    const login = new GrokCliLogin({
      logger: logger(),
      status: () => Promise.resolve(SIGNED_OUT),
      override: '/bin/grok',
      exists: () => true,
      pollMs: 20,
      timeoutMs: 5_000,
      launch: () => Promise.resolve(),
    });

    const pending = login.start();
    login.cancel();
    const result = await pending;
    expect(result).toEqual({ ok: true, value: SIGNED_OUT });
  });

  it('reports a launch failure instead of throwing at the caller', async () => {
    const login = new GrokCliLogin({
      logger: logger(),
      status: () => Promise.resolve(SIGNED_OUT),
      override: '/bin/grok',
      exists: () => true,
      launch: () => Promise.reject(new Error('osascript failed')),
    });

    const result = await login.start();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toMatch(/Terminal/);
    expect(result.error.hint).toMatch(/grok login/);
  });
});
