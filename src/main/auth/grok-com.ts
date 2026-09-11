/**
 * grok.com cookie session for STT 2 Fast.
 *
 * `grok-stt-2-fast` only exists on `wss://grok.com/ws/v1/stt` and authenticates
 * with grok.com cookies, not an xAI API key. The app owns an Electron persistent
 * partition (`persist:grok-com`) and the user signs in inside our window — we
 * never scrape Safari or Chrome.
 *
 * The cookie store is injectable so unit tests never load Electron.
 * **Never log cookie values.** Names only.
 */

import { app, session } from 'electron';
import type { GrokComSessionPort } from '@contracts/ports.js';
import { GROK_COM_ORIGIN, GROK_COM_PARTITION } from '@shared/constants.js';
import type { Logger } from '@shared/logger.js';

export type { GrokComSessionPort };

export interface GrokComCookieRecord {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly expirationDate?: number;
}

export interface GrokComCookieStore {
  get(url: string): Promise<readonly { readonly name: string; readonly value: string }[]>;
  write(cookies: readonly GrokComCookieRecord[]): Promise<void>;
  clear(): Promise<void>;
  onChanged(listener: () => void): () => void;
}

export { GROK_COM_ORIGIN, GROK_COM_PARTITION };

export const GROK_COM_SESSION_COOKIES = ['sso', 'sso-rw'] as const;

const SESSION_COOKIE_NAMES: ReadonlySet<string> = new Set(GROK_COM_SESSION_COOKIES);

function hasGrokComSessionCookie(
  cookies: readonly { readonly name: string; readonly value: string }[],
): boolean {
  return cookies.some((cookie) => SESSION_COOKIE_NAMES.has(cookie.name) && cookie.value.length > 0);
}

function cookieHeader(
  cookies: readonly { readonly name: string; readonly value: string }[],
): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}

function cookieNames(
  cookies: readonly { readonly name: string; readonly value: string }[],
): readonly string[] {
  return cookies.map((cookie) => cookie.name);
}

export class GrokComSession implements GrokComSessionPort {
  readonly #store: GrokComCookieStore;
  readonly #log: Logger;
  readonly #listeners = new Set<(signedIn: boolean) => void>();
  #signedIn = false;

  constructor(store: GrokComCookieStore, logger: Logger) {
    this.#store = store;
    this.#log = logger.child('grok-com');
    store.onChanged(() => {
      void this.#onStoreChanged();
    });
    void this.#onStoreChanged();
  }

  async hasSession(): Promise<boolean> {
    const cookies = await this.#store.get(GROK_COM_ORIGIN);
    return hasGrokComSessionCookie(cookies);
  }

  async getCookieHeader(): Promise<string | null> {
    const cookies = await this.#store.get(GROK_COM_ORIGIN);
    if (!hasGrokComSessionCookie(cookies)) return null;
    return cookieHeader(cookies);
  }

  async importCookies(cookies: readonly GrokComCookieRecord[]): Promise<void> {
    await this.#store.write(cookies);
    await this.#onStoreChanged();
  }

  async clearSession(): Promise<void> {
    await this.#store.clear();
    this.#emitIfChanged(false, []);
  }

  onChange(listener: (signedIn: boolean) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async #onStoreChanged(): Promise<void> {
    const cookies = await this.#store.get(GROK_COM_ORIGIN);
    this.#emitIfChanged(hasGrokComSessionCookie(cookies), cookies);
  }

  #emitIfChanged(
    signedIn: boolean,
    cookies: readonly { readonly name: string; readonly value: string }[],
  ): void {
    if (this.#signedIn === signedIn) return;
    this.#signedIn = signedIn;
    this.#log.debug(signedIn ? 'signed in' : 'signed out', { names: cookieNames(cookies) });
    for (const listener of this.#listeners) listener(signedIn);
  }
}

/**
 * Electron cookie store for `persist:grok-com`.
 *
 * `session.fromPartition` throws "Session can only be received when app is
 * ready". `GrokComSession` is constructed in `main()` before `app.whenReady()`,
 * so get/clear/onChanged must wait. Listeners are queued until then.
 */
export function electronGrokComCookieStore(
  partition: string = GROK_COM_PARTITION,
): GrokComCookieStore {
  type ElectronSession = ReturnType<typeof session.fromPartition>;
  let ses: ElectronSession | undefined;
  const listeners = new Set<() => void>();
  let attached = false;

  const whenAppReady = (): Promise<void> => (app.isReady() ? Promise.resolve() : app.whenReady());

  const resolveSession = (): ElectronSession => {
    ses ??= session.fromPartition(partition);
    return ses;
  };

  const attachCookieListener = (): void => {
    if (attached) return;
    attached = true;
    resolveSession().cookies.on('changed', () => {
      for (const listener of listeners) listener();
    });
  };

  const sessionWhenReady = async (): Promise<ElectronSession> => {
    await whenAppReady();
    attachCookieListener();
    return resolveSession();
  };

  void whenAppReady().then(() => {
    attachCookieListener();
  });

  return {
    async get(url) {
      const ready = await sessionWhenReady();
      return ready.cookies.get({ url });
    },
    async write(cookies) {
      const ready = await sessionWhenReady();
      for (const cookie of cookies) {
        const domain = (cookie.domain ?? 'grok.com').replace(/^\./, '');
        const url = `https://${domain}/`;
        await ready.cookies.set({
          url,
          name: cookie.name,
          value: cookie.value,
          ...(cookie.domain === undefined ? {} : { domain: cookie.domain }),
          path: cookie.path ?? '/',
          secure: cookie.secure ?? true,
          httpOnly: cookie.httpOnly ?? false,
          ...(cookie.expirationDate === undefined ? {} : { expirationDate: cookie.expirationDate }),
        });
      }
    },
    async clear() {
      const ready = await sessionWhenReady();
      await ready.clearStorageData();
    },
    onChanged(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
