/**
 * First-run sign-in window.
 *
 * Opens automatically when the app starts with no usable credential, and
 * again from the tray or Settings. Closing it is allowed — the user can grant
 * permissions first — but every later dictation will fail loudly until they
 * paste a key or sign in to the Grok CLI.
 */

import type { BrowserWindow } from 'electron';
import { MAIN_TO_RENDERER_CHANNEL, type MainToRenderer } from '@contracts/events.js';
import type { Logger } from '@shared/logger.js';
import { createWindow, loadWindow } from '../windows/window-factory.js';

const WIDTH = 440;
const HEIGHT = 540;

export class SignInWindow {
  #window: BrowserWindow | null = null;
  readonly #log: Logger;

  constructor(logger: Logger) {
    this.#log = logger.child('signin');
  }

  async open(): Promise<BrowserWindow> {
    const existing = this.#window;
    if (existing !== null && !existing.isDestroyed()) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }

    const window = createWindow({
      width: WIDTH,
      height: HEIGHT,
      minWidth: WIDTH,
      minHeight: 480,
      resizable: false,
      fullscreenable: false,
      title: 'Sign in — Grok Dictate',
      show: false,
      titleBarStyle: 'hiddenInset',
    });

    this.#window = window;
    window.on('closed', () => {
      if (this.#window === window) this.#window = null;
    });

    try {
      await loadWindow(window, 'signin');
    } catch (cause) {
      this.#log.error('could not load the sign-in window', { err: cause });
      window.destroy();
      this.#window = null;
      throw cause instanceof Error ? cause : new Error(String(cause));
    }

    window.show();
    window.focus();
    this.#log.info('sign-in window opened');
    return window;
  }

  close(): void {
    if (this.#window === null || this.#window.isDestroyed()) return;
    this.#window.close();
  }

  send(message: MainToRenderer): void {
    if (this.#window === null || this.#window.isDestroyed()) return;
    this.#window.webContents.send(MAIN_TO_RENDERER_CHANNEL, message);
  }
}
