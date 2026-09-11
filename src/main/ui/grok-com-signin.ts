/**
 * In-app grok.com sign-in window.
 *
 * STT 2 Fast authenticates with grok.com cookies in `persist:grok-com`. The user
 * logs in here; we never scrape another browser.
 *
 * **Do not attach the app preload.** grok.com JS must not see `window.grokDictate`.
 * This constructs `BrowserWindow` itself and does not use `createWindow()`.
 */

import { app, BrowserWindow } from 'electron';
import type { GrokComSessionPort } from '@contracts/ports.js';
import { GROK_COM_ORIGIN, GROK_COM_PARTITION } from '@shared/constants.js';
import type { Logger } from '@shared/logger.js';

const WIDTH = 960;
const HEIGHT = 720;
const CLOSE_DELAY_MS = 400;
const SIGN_IN_URL = `${GROK_COM_ORIGIN}/`;
const AUTH_HOSTNAMES = new Set(['accounts.x.ai', 'auth.x.ai']);

export class GrokComSignInWindow {
  readonly #session: GrokComSessionPort;
  readonly #log: Logger;
  #window: BrowserWindow | null = null;
  #closeTimer: NodeJS.Timeout | null = null;
  #unsubSession: (() => void) | null = null;

  constructor(session: GrokComSessionPort, logger: Logger) {
    this.#session = session;
    this.#log = logger.child('grok-com-signin');
  }

  async open(): Promise<void> {
    const existing = this.#window;
    if (existing !== null && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return;
    }

    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      title: 'Sign in to grok.com — Grok Dictate',
      show: false,
      titleBarStyle: 'hiddenInset',
      webPreferences: {
        partition: GROK_COM_PARTITION,
        nodeIntegration: false,
        contextIsolation: true,
        // no preload — grok.com must not receive window.grokDictate
      },
    });

    this.#window = window;
    window.on('closed', () => {
      this.#teardown(window);
    });
    window.webContents.setWindowOpenHandler(({ url }) => {
      const hostname = hostnameOf(url);
      if (hostname === null || !isAuthHost(hostname)) {
        return { action: 'deny' };
      }
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          webPreferences: {
            partition: GROK_COM_PARTITION,
            nodeIntegration: false,
            contextIsolation: true,
          },
        },
      };
    });

    this.#unsubSession = this.#session.onChange(() => {
      void this.#considerClose();
    });
    window.webContents.on('did-navigate', (_event, url) => {
      void this.#considerClose(url);
    });
    window.webContents.on('did-navigate-in-page', (_event, url) => {
      void this.#considerClose(url);
    });

    try {
      await window.loadURL(SIGN_IN_URL);
    } catch (cause) {
      this.#log.error('could not load grok.com', { err: cause });
      window.destroy();
      throw cause instanceof Error ? cause : new Error(String(cause));
    }

    if (window.isDestroyed()) return;
    // LSUIElement menu-bar apps often never receive the system passkey sheet.
    app.dock?.show();
    app.focus({ steal: true });
    window.show();
    window.focus();
    this.#log.info('opened');
    void this.#considerClose();
  }

  close(): void {
    if (this.#window === null || this.#window.isDestroyed()) return;
    this.#window.close();
  }

  #teardown(window: BrowserWindow): void {
    this.#cancelCloseTimer();
    this.#unsubSession?.();
    this.#unsubSession = null;
    if (this.#window === window) this.#window = null;
    app.dock?.hide();
  }

  async #considerClose(url?: string): Promise<void> {
    const window = this.#window;
    if (window === null || window.isDestroyed()) return;

    const signedIn = await this.#session.hasSession();
    const href = url ?? window.webContents.getURL();
    const hostname = hostnameOf(href);

    // Stay open on the IdP even if some cookies already exist; close only once
    // we have sso/sso-rw and the page is grok.com itself.
    if (!signedIn || hostname === null || AUTH_HOSTNAMES.has(hostname) || hostname !== 'grok.com') {
      this.#cancelCloseTimer();
      return;
    }

    if (this.#closeTimer !== null) return;
    this.#log.info('signed in, closing', { hostname });
    this.#closeTimer = setTimeout(() => {
      this.#closeTimer = null;
      this.close();
    }, CLOSE_DELAY_MS);
  }

  #cancelCloseTimer(): void {
    if (this.#closeTimer === null) return;
    clearTimeout(this.#closeTimer);
    this.#closeTimer = null;
  }
}

function hostnameOf(url: string): string | null {
  if (url.length === 0) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function isAuthHost(hostname: string): boolean {
  return (
    hostname === 'grok.com' ||
    hostname.endsWith('.grok.com') ||
    hostname === 'x.ai' ||
    hostname.endsWith('.x.ai')
  );
}
