/**
 * The hidden window that owns the microphone.
 *
 * Everything Electron-specific about capture is here, so `coordinator.ts` stays
 * testable. Three properties of this window are not cosmetic:
 *
 *   - **`backgroundThrottling: false`.** The window is never shown, and Chromium
 *     throttles timers and message delivery in windows it believes are hidden.
 *     Audio rendering happens on the audio thread and would survive, but the
 *     `port.onmessage` hop that carries every chunk to the main process does
 *     not. Throttled, dictation would arrive in bursts or not at all.
 *
 *   - **Its own session partition.** The permission handlers below allow exactly
 *     one permission, `media`, and only for this window. On the default session
 *     they would apply to the HUD and settings windows too, which belong to
 *     Phase 4 — a partition keeps the decision inside this phase's boundary.
 *
 *   - **`show: false` and never shown.** A visible window would be another way
 *     to steal focus, which is the failure  is about.
 */

import { session, type BrowserWindow, type WebContents } from 'electron';
import { MAIN_TO_RENDERER_CHANNEL, type MainToRenderer } from '@contracts/events.js';
import type { Logger } from '@shared/logger.js';
import { createWindow, loadWindow } from '../windows/window-factory.js';
import type { CaptureTransport } from './coordinator.js';

/** Not `persist:` — capture stores nothing, so the session dies with the app. */
export const CAPTURE_PARTITION = 'grok-dictate-capture';

/**
 * Messages held while the window loads. Bounded because a window that never
 * loads must not accumulate an unbounded queue; in practice the window is
 * created at startup and this holds at most one `capture-start`/`capture-stop`
 * pair, from a dictation begun in the first second of the app's life.
 */
const MAX_PENDING = 16;

export class CaptureWindow implements CaptureTransport {
  readonly #log: Logger;
  #window: BrowserWindow | null = null;
  #loaded = false;
  #pending: MainToRenderer[] = [];

  constructor(logger: Logger) {
    this.#log = logger.child('audio.window');
  }

  /** Call once, after `app.whenReady()`. */
  async create(): Promise<void> {
    if (this.#window !== null) return;

    const partition = session.fromPartition(CAPTURE_PARTITION);
    partition.setPermissionRequestHandler((_contents, permission, callback) => {
      const allowed = permission === 'media';
      if (!allowed)
        this.#log.warn('denied a permission request from the capture window', { permission });
      callback(allowed);
    });
    partition.setPermissionCheckHandler((_contents, permission) => permission === 'media');

    const window = createWindow({
      width: 240,
      height: 120,
      show: false,
      skipTaskbar: true,
      webPreferences: {
        partition: CAPTURE_PARTITION,
        backgroundThrottling: false,
      },
    });
    this.#window = window;

    window.on('closed', () => {
      this.#window = null;
      this.#loaded = false;
    });

    await loadWindow(window, 'capture');
    this.#loaded = true;
    this.#log.info('capture window ready', {
      backgroundThrottling: window.webContents.getBackgroundThrottling(),
    });

    const queued = this.#pending.splice(0);
    for (const message of queued) this.#post(message);
  }

  send(message: MainToRenderer): void {
    if (this.#loaded) {
      this.#post(message);
      return;
    }
    if (this.#pending.length >= MAX_PENDING) this.#pending.shift();
    this.#pending.push(message);
    this.#log.debug('queued a capture message until the window loads', { type: message.type });
  }

  /** True when `contents` is this window — nothing else may drive capture. */
  owns(contents: WebContents): boolean {
    const window = this.#window;
    return window !== null && !window.isDestroyed() && window.webContents.id === contents.id;
  }

  destroy(): void {
    this.#pending = [];
    this.#loaded = false;
    const window = this.#window;
    this.#window = null;
    if (window !== null && !window.isDestroyed()) window.destroy();
  }

  #post(message: MainToRenderer): void {
    const window = this.#window;
    if (window === null || window.isDestroyed()) {
      this.#log.warn('capture window is gone; dropping a message', { type: message.type });
      return;
    }
    window.webContents.send(MAIN_TO_RENDERER_CHANNEL, message);
  }
}
