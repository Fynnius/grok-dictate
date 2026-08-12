import { afterEach, describe, expect, it } from 'vitest';
import type { InvokeRequest, InvokeResponse, RendererApi } from '@contracts/events.js';
import { DEFAULT_CONFIG } from '@contracts/config.js';
import { appError } from '@shared/result.js';
import { request } from './ipc.js';

/**
 * These run in vitest's `node` environment, so `window` is installed by hand.
 * The point of the module is what happens when `invoke` misbehaves, and that is
 * exactly what a real window makes hard to arrange.
 */
function withApi(invoke: (message: InvokeRequest) => Promise<InvokeResponse>): void {
  const api: RendererApi = {
    send: () => undefined,
    on: () => () => undefined,
    invoke,
  };
  (globalThis as { window?: { grokDictate: RendererApi } }).window = { grokDictate: api };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe('request', () => {
  it('returns the reply when it is the expected member', async () => {
    withApi(() => Promise.resolve({ type: 'config', config: DEFAULT_CONFIG }));
    const outcome = await request({ type: 'get-config' }, 'config');
    expect(outcome).toEqual({ ok: true, value: { type: 'config', config: DEFAULT_CONFIG } });
  });

  it('turns a rejection into a value rather than an unhandled promise', async () => {
    // The failure this module exists for: a bare `void invoke().then()` left the
    // window on its loading state forever and logged an unhandled rejection.
    withApi(() => Promise.reject(new Error("No handler registered for 'grok-dictate:invoke'")));
    const outcome = await request({ type: 'get-config' }, 'config');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.message).toMatch(/No handler registered/);
  });

  it('surfaces an `error` reply with the main process’s own wording', async () => {
    withApi(() =>
      Promise.resolve({
        type: 'error',
        error: appError('config_invalid', 'Those settings are not valid.', null),
      }),
    );
    const outcome = await request({ type: 'set-config', config: DEFAULT_CONFIG }, 'config');
    expect(outcome).toEqual({ ok: false, message: 'Those settings are not valid.' });
  });

  it('treats a reply of the wrong type as a failure rather than ignoring it', async () => {
    withApi(() => Promise.resolve({ type: 'ok' }));
    const outcome = await request({ type: 'get-history', query: null, limit: 10 }, 'history');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.message).toMatch(/Unexpected reply: ok/);
  });

  it('copes with a non-Error rejection', async () => {
    // The rejection is deliberately not an Error: this test exists because IPC
    // can surface a rejection we did not construct, and `cause.message` would
    // then be undefined.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    withApi(() => Promise.reject('nope'));
    const outcome = await request({ type: 'get-snapshot' }, 'snapshot');
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected a failure');
    expect(outcome.message).toBe('The app did not answer.');
  });
});
