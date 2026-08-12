/**
 * The typed handle every renderer window uses. Injected by `src/preload`.
 *
 * Phase 1 scaffolding: Phases 3 and 4 import `RendererApi` through this global
 * rather than reaching for `ipcRenderer`, which does not exist in a renderer
 * (`contextIsolation: true`).
 */

import type { RendererApi } from '@contracts/events.js';

declare global {
  interface Window {
    readonly grokDictate: RendererApi;
  }
}

export {};
