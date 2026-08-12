/**
 * Window creation helpers shared by every window in the app.
 *
 * This module only supplies the plumbing that is identical for all of them —
 * where the renderer entry lives in dev versus a packaged build, and the
 * security defaults. The windows themselves live with their owners.
 */

import { join } from 'node:path';
import { BrowserWindow, type BrowserWindowConstructorOptions } from 'electron';
import { rendererDevServerUrl } from '@shared/env.js';

/** The renderer entry points declared in `electron.vite.config.ts`. */
export type WindowName = 'hud' | 'settings' | 'capture' | 'signin';

export const SECURE_WEB_PREFERENCES = {
  // No Node in any renderer, and no direct `ipcRenderer`: the preload script is
  // the entire surface (see src/preload/index.ts).
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false, // required for an ESM preload under `"type": "module"`
} as const;

export function preloadPath(): string {
  return join(import.meta.dirname, '../preload/index.mjs');
}

/** Load a window's HTML, from the dev server in development or from disk. */
export async function loadWindow(window: BrowserWindow, name: WindowName): Promise<void> {
  const devServer = rendererDevServerUrl();
  if (devServer !== undefined) {
    await window.loadURL(`${devServer}/${name}/index.html`);
    return;
  }
  await window.loadFile(join(import.meta.dirname, `../renderer/${name}/index.html`));
}

export function createWindow(options: BrowserWindowConstructorOptions): BrowserWindow {
  return new BrowserWindow({
    show: false,
    ...options,
    webPreferences: {
      ...SECURE_WEB_PREFERENCES,
      preload: preloadPath(),
      ...options.webPreferences,
    },
  });
}
