/**
 * OWNER: **Phase 4**. The §12.3 flag set, and nothing else.
 *
 * Separated from `hud-window.ts` so it can be asserted by a unit test with no
 * window server: the only `electron` import here is a **type**, which the
 * compiler erases. `hud-window.ts` is then the thin part that actually touches
 * Electron.
 *
 * **These flags are the correctness of the HUD, not its styling.** If the pill
 * takes focus, the frontmost app changes and insertion targets the wrong
 * process — which is why IMPLEMENTATION-PLAN.md §3.4 calls
 * the focus test "the single most important visual test in the project".
 * Changing anything in this file means re-running it (`focus.e2e.test.ts`).
 */

import type { BrowserWindowConstructorOptions } from 'electron';
import { HUD_CAPSULE_WINDOW } from './layout.js';

export const HUD_WINDOW_OPTIONS: BrowserWindowConstructorOptions = {
  width: HUD_CAPSULE_WINDOW.width,
  height: HUD_CAPSULE_WINDOW.height,
  show: false,

  /* ---- : the pill must never take focus ---- */
  focusable: false, // the one that matters most
  frame: false,
  transparent: true,
  hasShadow: false,
  resizable: false,
  movable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  skipTaskbar: true,
  alwaysOnTop: true, // raised to 'screen-saver' level by applyHudWindowFlags

  /**
   * A window that can never become key would otherwise swallow the first click
   * on its own buttons, so the *Copy* button in the `not_inserted` state would
   * need two clicks. `acceptFirstMouse` delivers that first click to the
   * content; it does not make the window key, and `focusable: false` means it
   * cannot become key regardless.
   */
  acceptFirstMouse: true,

  webPreferences: {
    /**
     * The pill spends most of its life hidden, and `src/main/sound/` plays the
     * start/stop cues from this renderer.
     * Chromium throttles timers and de-prioritises hidden windows, which is
     * exactly the wrong thing for a latency-critical cue.
     */
    backgroundThrottling: false,
  },
};

/** The subset of `BrowserWindow` the flag application needs — so it can be faked. */
export interface HudFlagTarget {
  setAlwaysOnTop(flag: boolean, level?: 'screen-saver'): void;
  setVisibleOnAllWorkspaces(visible: boolean, options?: { visibleOnFullScreen?: boolean }): void;
  setFocusable(focusable: boolean): void;
}

/**
 * The imperative half of §12.3, which cannot be expressed as constructor
 * options.
 *
 * `'screen-saver'` is the level that clears a full-screen app;
 * `visibleOnFullScreen` is what makes the pill follow the user onto that Space;
 * the final `setFocusable(false)` is belt and braces against anything that
 * later calls `focus()`.
 */
export function applyHudWindowFlags(window: HudFlagTarget): void {
  window.setAlwaysOnTop(true, 'screen-saver');
  window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  window.setFocusable(false);
}
