import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addLogSink, clearLogSinks, createLogger, setLogLevel } from '@shared/logger.js';
import { GrokComSession, GROK_COM_SESSION_COOKIES, type GrokComCookieStore } from './grok-com.js';

vi.mock('electron', () => ({
  app: {
    isReady: (): boolean => false,
    whenReady: (): Promise<void> => Promise.resolve(),
  },
  session: {
    fromPartition: (): never => {
      throw new Error('unit tests must not touch Electron session');
    },
  },
}));

class MemoryCookieStore implements GrokComCookieStore {
  #cookies: { name: string; value: string }[] = [];
  readonly #listeners = new Set<() => void>();

  get(_url: string): Promise<readonly { readonly name: string; readonly value: string }[]> {
    return Promise.resolve(this.#cookies);
  }

  write(
    cookies: readonly { readonly name: string; readonly value: string }[],
  ): Promise<void> {
    const next = [...this.#cookies];
    for (const cookie of cookies) {
      const index = next.findIndex((existing) => existing.name === cookie.name);
      if (index >= 0) next[index] = { name: cookie.name, value: cookie.value };
      else next.push({ name: cookie.name, value: cookie.value });
    }
    this.#cookies = next;
    this.#emit();
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.#cookies = [];
    this.#emit();
    return Promise.resolve();
  }

  onChanged(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(cookies: { name: string; value: string }[]): void {
    this.#cookies = cookies;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}

async function flush(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

describe('GROK_COM_SESSION_COOKIES', () => {
  it('is sso and sso-rw', () => {
    expect(GROK_COM_SESSION_COOKIES).toEqual(['sso', 'sso-rw']);
  });
});

describe('GrokComSession', () => {
  let store: MemoryCookieStore;
  let session: GrokComSession;

  beforeEach(() => {
    store = new MemoryCookieStore();
    session = new GrokComSession(store, createLogger('test'));
  });

  afterEach(() => {
    clearLogSinks();
  });

  it('has no session and no cookie header when the store is empty', async () => {
    await expect(session.hasSession()).resolves.toBe(false);
    await expect(session.getCookieHeader()).resolves.toBeNull();
  });

  it('ignores grok_device_id alone', async () => {
    store.set([{ name: 'grok_device_id', value: 'device-abc' }]);
    await expect(session.hasSession()).resolves.toBe(false);
    await expect(session.getCookieHeader()).resolves.toBeNull();
  });

  it('treats a non-empty sso-rw cookie as signed in and returns every cookie in the header', async () => {
    store.set([
      { name: 'grok_device_id', value: 'device-abc' },
      { name: 'sso-rw', value: 'fake' },
    ]);
    await expect(session.hasSession()).resolves.toBe(true);
    const header = await session.getCookieHeader();
    expect(header).toContain('sso-rw=fake');
    expect(header).toContain('grok_device_id=device-abc');
  });

  it('treats a non-empty sso cookie as signed in', async () => {
    store.set([{ name: 'sso', value: 'fake-sso' }]);
    await expect(session.hasSession()).resolves.toBe(true);
    await expect(session.getCookieHeader()).resolves.toBe('sso=fake-sso');
  });

  it('does not treat an empty sso value as a session', async () => {
    store.set([{ name: 'sso', value: '' }]);
    await expect(session.hasSession()).resolves.toBe(false);
    await expect(session.getCookieHeader()).resolves.toBeNull();
  });

  it('clears the session, signs out, and emits onChange(false)', async () => {
    store.set([{ name: 'sso-rw', value: 'fake' }]);
    await flush();
    const events: boolean[] = [];
    session.onChange((signedIn) => events.push(signedIn));

    await session.clearSession();

    await expect(session.hasSession()).resolves.toBe(false);
    await expect(session.getCookieHeader()).resolves.toBeNull();
    expect(events).toEqual([false]);
  });

  it('fires onChange only when signed-in flips', async () => {
    const events: boolean[] = [];
    session.onChange((signedIn) => events.push(signedIn));

    store.set([{ name: 'grok_device_id', value: 'device-abc' }]);
    await flush();
    expect(events).toEqual([]);

    store.set([
      { name: 'grok_device_id', value: 'device-abc' },
      { name: 'sso-rw', value: 'fake' },
    ]);
    await flush();
    expect(events).toEqual([true]);

    store.set([
      { name: 'grok_device_id', value: 'device-abc' },
      { name: 'sso-rw', value: 'fake' },
      { name: 'sso', value: 'also-fake' },
    ]);
    await flush();
    expect(events).toEqual([true]);

    store.set([{ name: 'grok_device_id', value: 'device-abc' }]);
    await flush();
    expect(events).toEqual([true, false]);

    store.set([]);
    await flush();
    expect(events).toEqual([true, false]);
  });

  it('imports cookies through the store and then reports signed in', async () => {
    await session.importCookies([
      { name: 'grok_device_id', value: 'device-abc' },
      { name: 'sso-rw', value: 'fake' },
    ]);
    await expect(session.hasSession()).resolves.toBe(true);
    await expect(session.getCookieHeader()).resolves.toContain('sso-rw=fake');
  });

  it('never logs cookie values', async () => {
    const lines: string[] = [];
    setLogLevel('debug');
    addLogSink((line) => lines.push(line));

    store.set([{ name: 'sso-rw', value: 'super-secret-cookie-value' }]);
    await flush();
    await session.getCookieHeader();
    await session.clearSession();
    await flush();

    const joined = lines.join('\n');
    expect(joined).not.toContain('super-secret-cookie-value');
    expect(joined).toContain('sso-rw');
  });
});
