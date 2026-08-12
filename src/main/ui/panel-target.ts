/**
 * OWNER: **Phase 4**. Where a panel window's HTML comes from.
 *
 * ## Why three windows share one renderer entry
 *
 * Settings, History and Scratchpad are three windows, but they load **one**
 * Vite entry (`src/renderer/settings/`) and select a view from the URL hash.
 * The reason is boundary, not taste: the entry list lives in
 * `electron.vite.config.ts`, which Phase 1 owns and froze
 * (IMPLEMENTATION-PLAN.md §2), so Phase 4 cannot add `history` and
 * `scratchpad` entries of its own. Recorded as a cross-boundary request in
 * docs/phase-4-report.md — Phase 5 can split them with no change to the
 * renderer code, since each view is already a separate component.
 *
 * `window-factory.ts`'s `loadWindow()` is not used here for the same reason: it
 * is a Phase 1 file and takes no hash. The dev-vs-packaged branch below is the
 * same one it makes.
 *
 * Pure and Electron-free so both branches are unit-tested; `panels.ts` applies
 * the result.
 */

export type PanelName = 'settings' | 'history' | 'scratchpad';

export const PANEL_NAMES: readonly PanelName[] = ['settings', 'history', 'scratchpad'];

/** The single renderer entry all three panels share. */
export const PANEL_ENTRY = 'settings';

export type PanelTarget =
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'file'; readonly path: string; readonly hash: string };

/**
 * `devServerUrl` is `ELECTRON_RENDERER_URL`, which electron-vite injects in
 * development and omits in a packaged build.
 */
export function panelTarget(
  panel: PanelName,
  devServerUrl: string | undefined,
  rendererDir: string,
): PanelTarget {
  if (devServerUrl !== undefined) {
    return { kind: 'url', url: `${devServerUrl}/${PANEL_ENTRY}/index.html#/${panel}` };
  }
  return {
    kind: 'file',
    path: `${rendererDir}/${PANEL_ENTRY}/index.html`,
    // Electron's `loadFile` takes the hash separately and adds the `#` itself.
    hash: `/${panel}`,
  };
}

/** Read back the panel a renderer was loaded for. `location.hash` in the window. */
export function panelFromHash(hash: string): PanelName {
  const name = hash.replace(/^#\/?/, '');
  return (PANEL_NAMES as readonly string[]).includes(name)
    ? (name as PanelName)
    : // An unknown or absent hash is not an error worth a blank window: Settings
      // is the entry a user reaches for by default.
      'settings';
}

export interface PanelWindowSpec {
  readonly width: number;
  readonly height: number;
  readonly minWidth: number;
  readonly minHeight: number;
  readonly title: string;
}

export function panelWindowSpec(panel: PanelName): PanelWindowSpec {
  switch (panel) {
    case 'settings':
      return {
        width: 560,
        height: 680,
        minWidth: 460,
        minHeight: 420,
        title: 'Grok Dictate — Settings',
      };
    case 'history':
      return {
        width: 760,
        height: 620,
        minWidth: 520,
        minHeight: 360,
        title: 'Grok Dictate — History',
      };
    case 'scratchpad':
      // : a *real focusable window* holding the last
      // transcript, so the text can be selected and edited rather than only
      // looked at. That is the whole difference from the HUD pill.
      return {
        width: 560,
        height: 380,
        minWidth: 360,
        minHeight: 220,
        title: 'Grok Dictate — Scratchpad',
      };
  }
}
