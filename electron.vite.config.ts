import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

const alias = {
  '@contracts': resolve('contracts'),
  '@shared': resolve('src/shared'),
  '@mocks': resolve('mocks'),
};

/**
 * One HTML entry per renderer bundle.
 *
 * - hud      — the pill; must never take focus (§12.3)
 * - settings — Settings, History and Scratchpad, selected by URL hash
 * - capture  — hidden renderer running getUserMedia + AudioWorklet
 * - signin   — first-run / missing-credential window
 *
 * Phase 1's `debug` entry (the walking-skeleton control surface) was removed in
 * Phase 5 along with the window.
 *
 * Settings, History and Scratchpad deliberately still share one entry. Phase 4
 * asked for a split (docs/phase-4-report.md §5.3), but only because the frozen
 * config was the reason they were combined in the first place; with the freeze
 * lifted the reason to split them is gone too. Three entries would mean three
 * more HTML files and three more React bundles to load the same three
 * components, and the hash routing is already covered by `panel-target.test.ts`.
 */
const rendererEntries = {
  hud: resolve('src/renderer/hud/index.html'),
  settings: resolve('src/renderer/settings/index.html'),
  capture: resolve('src/renderer/capture/index.html'),
  signin: resolve('src/renderer/signin/index.html'),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/main/index.ts') },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: { alias },
    plugins: [react()],
    build: {
      rollupOptions: { input: rendererEntries },
    },
  },
});
