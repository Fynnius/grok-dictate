/**
 * The one and only bridge between main and every renderer window.
 *
 * OWNERSHIP: `src/preload/` is not listed in IMPLEMENTATION-PLAN.md §2's
 * ownership table. Phase 1 claims it, because it is shared infrastructure
 * derived directly from the frozen `contracts/events.ts` and every later phase
 * consumes it — see docs/phase-1-report.md, "Boundary clarifications".
 *
 * `contextIsolation` is on and `nodeIntegration` is off, so no renderer ever
 * touches `ipcRenderer` directly. The exposed surface is exactly `RendererApi`
 * from the contract and nothing else — which also means a renderer has no way
 * to read a file, spawn a process, or reach the bearer token.
 */

import { contextBridge, ipcRenderer } from 'electron';
import {
  INVOKE_CHANNEL,
  MAIN_TO_RENDERER_CHANNEL,
  RENDERER_TO_MAIN_CHANNEL,
  type InvokeRequest,
  type InvokeResponse,
  type MainToRenderer,
  type RendererApi,
  type RendererToMain,
} from '@contracts/events.js';

const api: RendererApi = {
  send(message: RendererToMain): void {
    ipcRenderer.send(RENDERER_TO_MAIN_CHANNEL, message);
  },

  on(listener: (message: MainToRenderer) => void): () => void {
    const handler = (_event: Electron.IpcRendererEvent, message: MainToRenderer): void => {
      listener(message);
    };
    ipcRenderer.on(MAIN_TO_RENDERER_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(MAIN_TO_RENDERER_CHANNEL, handler);
    };
  },

  async invoke(request: InvokeRequest): Promise<InvokeResponse> {
    return (await ipcRenderer.invoke(INVOKE_CHANNEL, request)) as InvokeResponse;
  },
};

contextBridge.exposeInMainWorld('grokDictate', api);
