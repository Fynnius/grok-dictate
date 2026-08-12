/**
 * The HUD pill window. OWNER: **Phase 4**.
 *
 * **The flags below are the correctness of this window, not its styling.** If
 * the pill takes focus, the frontmost app changes and insertion targets the
 * wrong process — , and the reason IMPLEMENTATION-PLAN.md §3.4
 * calls the focus test "the single most important visual test in the project".
 * Restyle the contents freely; changing `HUD_WINDOW_OPTIONS` or
 * `applyHudWindowFlags` means re-running that test.
 *
 * Phase 1 established the flag set and proved it launches. Phase 4 adds
 * per-state sizing, dwell (the state machine emits no `hidden` after a terminal
 * insert), click-through for status-only states, and `acceptFirstMouse` so the
 * *Copy* button works on the first click of a window that can never be key.
 */

import { screen, type BrowserWindow } from 'electron';
import type { HudView } from '@contracts/events.js';
import { MAIN_TO_RENDERER_CHANNEL } from '@contracts/events.js';
import type { HudPort } from '@contracts/ports.js';
import type { Logger } from '@shared/logger.js';
import { createWindow, loadWindow } from '../windows/window-factory.js';
import { applyHudWindowFlags, HUD_WINDOW_OPTIONS } from './flags.js';
import {
  HUD_CAPSULE_WINDOW,
  HUD_FADE_MS,
  hudBounds,
  hudDwellMs,
  hudInteractive,
  hudSize,
  type HudSize,
} from './layout.js';

/**
 * Where a `hud` view goes besides the pill itself. The Scratchpad tracks the
 * latest transcript, so it needs the same stream. Injected rather than imported
 * so the HUD does not depend on the panel windows.
 */
export type HudBroadcast = (message: { type: 'hud'; view: HudView }) => void;

/** Steps in the fade — 16 ms apart is one frame at 60 Hz. */
const FADE_STEP_MS = 16;

export class HudWindow implements HudPort {
  #window: BrowserWindow | null = null;
  #pending: HudView | null = null;
  #dwell: NodeJS.Timeout | null = null;
  #fade: NodeJS.Timeout | null = null;
  readonly #log: Logger;
  readonly #broadcast: HudBroadcast;

  constructor(logger: Logger, broadcast: HudBroadcast) {
    this.#log = logger.child('hud');
    this.#broadcast = broadcast;
  }

  /** For `src/main/sound/`, which plays its cues in this renderer. */
  get window(): BrowserWindow | null {
    return this.#window !== null && !this.#window.isDestroyed() ? this.#window : null;
  }

  async create(): Promise<BrowserWindow> {
    const window = createWindow(HUD_WINDOW_OPTIONS);
    applyHudWindowFlags(window);

    this.#window = window;
    await loadWindow(window, 'hud');
    this.#position(window, HUD_CAPSULE_WINDOW);
    this.#log.info('hud window created', {
      focusable: window.isFocusable(),
      alwaysOnTop: window.isAlwaysOnTop(),
    });
    if (this.#pending !== null) {
      const pending = this.#pending;
      this.#pending = null;
      this.show(pending);
    }
    return window;
  }

  show(view: HudView): void {
    // The Scratchpad tracks the latest transcript, so it needs the view stream
    // too.
    this.#broadcast({ type: 'hud', view });

    const window = this.window;
    if (window === null) {
      this.#pending = view;
      return;
    }
    this.#clearDwell();
    // A state arriving mid-fade takes the window back to full strength: the
    // pill that is going out is never the one the user should be reading.
    this.#cancelFade();
    window.setOpacity(1);

    window.webContents.send(MAIN_TO_RENDERER_CHANNEL, { type: 'hud', view });

    // Status-only states are click-through, so a click meant for the app
    // underneath is never eaten by a window floating over it (layout.ts).
    window.setIgnoreMouseEvents(!hudInteractive(view));

    this.#position(window, hudSize(view));
    if (!window.isVisible()) {
      // `showInactive`, never `show`: `show()` can make the window key on some
      // paths, which is precisely what must never happen.
      window.showInactive();
    }

    const dwell = hudDwellMs(view);
    if (dwell !== null) {
      // The fade is inside the dwell, not after it: a state that says it lives
      // for 5 s should be gone at 5 s.
      this.#dwell = setTimeout(
        () => {
          this.#dwell = null;
          this.#fadeOut();
        },
        Math.max(0, dwell - HUD_FADE_MS),
      );
      this.#dwell.unref?.();
    }
  }

  hide(): void {
    this.#clearDwell();
    this.#cancelFade();
    const window = this.window;
    if (window === null) {
      this.#pending = null;
      return;
    }
    if (window.isVisible()) window.hide();
    // Always restored, even when it was already hidden: the next `showInactive`
    // must never reveal a window left part-way through a fade.
    window.setOpacity(1);
  }

  destroy(): void {
    this.#clearDwell();
    this.#cancelFade();
    this.#window?.destroy();
    this.#window = null;
  }

  /**
   * Dim the window to nothing, then hide it (§19.3).
   *
   * `setOpacity` on the window rather than a CSS transition in the renderer:
   * the dwell that decides *when* to go lives here, in `layout.ts`, and sending
   * a "start fading now" message would put the same duration in two processes
   * that could then disagree. It also fades both pills and their shadows as one
   * object, which is what they are.
   */
  #fadeOut(): void {
    const window = this.window;
    if (window === null || !window.isVisible()) {
      this.hide();
      return;
    }

    const started = Date.now();
    this.#fade = setInterval(() => {
      const target = this.window;
      if (target === null) {
        this.#cancelFade();
        return;
      }
      const progress = (Date.now() - started) / HUD_FADE_MS;
      if (progress >= 1) {
        this.hide(); // resets the opacity and clears this timer
        return;
      }
      // Linear in opacity is the right curve for something leaving: it holds
      // long enough to be seen going, without an ease-out's slow tail.
      target.setOpacity(1 - progress);
    }, FADE_STEP_MS);
    this.#fade.unref?.();
  }

  #clearDwell(): void {
    if (this.#dwell !== null) {
      clearTimeout(this.#dwell);
      this.#dwell = null;
    }
  }

  #cancelFade(): void {
    if (this.#fade !== null) {
      clearInterval(this.#fade);
      this.#fade = null;
    }
  }

  /** Bottom-centre of whichever display holds the cursor (multi-display, §5b). */
  #position(window: BrowserWindow, size: HudSize): void {
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    window.setBounds(hudBounds(display.workArea, size));
  }
}
