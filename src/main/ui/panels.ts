/**
 * The Settings, History and Scratchpad windows.
 *
 * These are ordinary focusable windows — the opposite of the HUD, which must
 * never take focus. Opening one deliberately *does* change
 * the frontmost application, which is why nothing here is ever opened while a
 * dictation is in flight.
 *
 * Phase 4 wrote this as module-level state with its own `ipcMain.on` listener,
 * because `src/main/index.ts` was frozen and it had no way to be handed
 * anything (docs/phase-4-report.md §5.5). Phase 5 owns the composition root, so
 * this is now an ordinary object the root constructs and routes messages to —
 * there is exactly one `RENDERER_TO_MAIN_CHANNEL` listener in the application.
 */

import type { BrowserWindow } from 'electron';
import { join } from 'node:path';
import { MAIN_TO_RENDERER_CHANNEL } from '@contracts/events.js';
import type { MainToRenderer } from '@contracts/events.js';
import { rendererDevServerUrl } from '@shared/env.js';
import type { Logger } from '@shared/logger.js';
import { createWindow } from '../windows/window-factory.js';
import { panelTarget, panelWindowSpec, type PanelName } from './panel-target.js';

export class PanelWindows {
  readonly #open = new Map<PanelName, BrowserWindow>();
  readonly #log: Logger;

  constructor(logger: Logger) {
    this.#log = logger.child('panels');
  }

  async open(panel: PanelName): Promise<BrowserWindow> {
    const existing = this.#open.get(panel);
    if (existing !== undefined && !existing.isDestroyed()) {
      // Reopening brings the window forward rather than stacking duplicates.
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
      return existing;
    }

    const spec = panelWindowSpec(panel);
    const window = createWindow({
      width: spec.width,
      height: spec.height,
      minWidth: spec.minWidth,
      minHeight: spec.minHeight,
      title: spec.title,
      show: false,
      // A menu-bar app has no main window, so a panel that opened behind
      // everything else would look like nothing happened.
      titleBarStyle: 'hiddenInset',
    });

    this.#open.set(panel, window);
    window.on('closed', () => {
      if (this.#open.get(panel) === window) this.#open.delete(panel);
    });

    const target = panelTarget(
      panel,
      rendererDevServerUrl(),
      join(import.meta.dirname, '../renderer'),
    );
    try {
      if (target.kind === 'url') await window.loadURL(target.url);
      else await window.loadFile(target.path, { hash: target.hash });
    } catch (cause) {
      this.#log.error('could not load a panel window', { panel, err: cause });
      window.destroy();
      this.#open.delete(panel);
      throw cause instanceof Error ? cause : new Error(String(cause));
    }

    window.show();
    window.focus();
    this.#log.debug('panel opened', { panel });
    return window;
  }

  /**
   * Push a message to the panel windows.
   *
   * This is what exercises the `history-updated` and `config-updated` members
   * of `MainToRenderer`, which docs/phase-1-report.md §7.7 flagged as defined
   * but never sent — and therefore unvalidated.
   */
  broadcast(message: MainToRenderer): void {
    for (const window of this.#open.values()) {
      if (!window.isDestroyed()) window.webContents.send(MAIN_TO_RENDERER_CHANNEL, message);
    }
  }

  closeAll(): void {
    for (const window of this.#open.values()) {
      if (!window.isDestroyed()) window.destroy();
    }
    this.#open.clear();
  }

  /** Test seam. */
  get openCount(): number {
    return this.#open.size;
  }
}
