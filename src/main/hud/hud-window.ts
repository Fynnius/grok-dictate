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
 *
 * Mouse policy: hands-free recording captures the mouse unconditionally so
 * ✕/✓ work before hover. Every other visible state uses
 * `setIgnoreMouseEvents(true, { forward: true })` so empty chrome is
 * click-through and the renderer still gets enter/leave on the pills. Drag
 * is manual (the window is `movable: false`) and the session anchor is the
 * capsule's bottom-centre, not the window top-left.
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
  boundsFromAnchor,
  hudBounds,
  hudDwellMs,
  hudSize,
  type HudAnchor,
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

interface DragSession {
  readonly startCursor: { x: number; y: number };
  readonly startBounds: { x: number; y: number; width: number; height: number };
}

/** Hands-free ✕/✓ must work even before the cursor has entered the pill. */
function hudCapturesMouse(view: HudView): boolean {
  return view.kind === 'recording' && view.mode === 'toggle';
}

function bottomCenter(bounds: { x: number; y: number; width: number; height: number }): HudAnchor {
  return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height };
}

export class HudWindow implements HudPort {
  #window: BrowserWindow | null = null;
  #pending: HudView | null = null;
  #dwell: NodeJS.Timeout | null = null;
  #fade: NodeJS.Timeout | null = null;
  #view: HudView = { kind: 'hidden' };
  /** Capsule bottom-centre in screen coords. `null` until the user drags. */
  #anchor: HudAnchor | null = null;
  #drag: DragSession | null = null;
  #pointerInside = false;
  #notifiedHidden = true;
  /**
   * Fired from `hide()`, including dwell/fade. Wired to `orchestrator.dismissHud`
   * so `#hudView` cannot stay `error` after the pill is already gone.
   * `dismissHud` → `hide` → this → `dismissHud` is idempotent.
   */
  onHidden: (() => void) | null = null;
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

    this.#view = view;
    this.#notifiedHidden = false;
    window.webContents.send(MAIN_TO_RENDERER_CHANNEL, { type: 'hud', view });
    this.#syncIgnoreMouse();

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
    this.#view = { kind: 'hidden' };
    this.#pointerInside = false;
    this.#drag = null;
    const window = this.window;
    if (window === null) {
      this.#pending = null;
    } else {
      if (window.isVisible()) window.hide();
      // Always restored, even when it was already hidden: the next `showInactive`
      // must never reveal a window left part-way through a fade.
      window.setOpacity(1);
    }
    if (!this.#notifiedHidden) {
      this.#notifiedHidden = true;
      this.onHidden?.();
    }
  }

  destroy(): void {
    this.#clearDwell();
    this.#cancelFade();
    this.#window?.destroy();
    this.#window = null;
  }

  onPointer(phase: 'enter' | 'leave'): void {
    if (phase === 'enter') {
      this.#pointerInside = true;
      this.#syncIgnoreMouse();
      return;
    }
    if (this.#drag !== null) return;
    this.#pointerInside = false;
    this.#syncIgnoreMouse();
  }

  beginDrag(screenX: number, screenY: number): void {
    const window = this.window;
    if (window === null) return;
    this.#drag = { startCursor: { x: screenX, y: screenY }, startBounds: window.getBounds() };
    this.#pointerInside = true;
    this.#syncIgnoreMouse();
  }

  dragTo(screenX: number, screenY: number): void {
    const window = this.window;
    const drag = this.#drag;
    if (window === null || drag === null) return;
    const size = { width: drag.startBounds.width, height: drag.startBounds.height };
    const proposed: HudAnchor = {
      x: drag.startBounds.x + size.width / 2 + (screenX - drag.startCursor.x),
      y: drag.startBounds.y + size.height + (screenY - drag.startCursor.y),
    };
    const display = screen.getDisplayNearestPoint({ x: proposed.x, y: proposed.y });
    window.setBounds(boundsFromAnchor(proposed, size, display.workArea));
  }

  endDrag(): void {
    const window = this.window;
    const drag = this.#drag;
    // A click is not a drag. Pinning the session on pointer-up without a
    // move would stick the pill to this display after dismiss.
    if (window !== null && drag !== null) {
      const bounds = window.getBounds();
      if (bounds.x !== drag.startBounds.x || bounds.y !== drag.startBounds.y) {
        this.#anchor = bottomCenter(bounds);
      }
    }
    this.#drag = null;
    this.#syncIgnoreMouse();
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

  /**
   * Hands-free: take the mouse now. Error / recording / processing: forward
   * events through empty chrome until a pill reports enter. Hidden and
   * `blocked` ignore entirely — a blocked click has to reach the password
   * field, not our overlay.
   */
  #syncIgnoreMouse(): void {
    const window = this.window;
    if (window === null) return;
    if (this.#view.kind === 'hidden' || this.#view.kind === 'blocked') {
      window.setIgnoreMouseEvents(true);
      return;
    }
    if (hudCapturesMouse(this.#view) || this.#pointerInside || this.#drag !== null) {
      window.setIgnoreMouseEvents(false);
      return;
    }
    window.setIgnoreMouseEvents(true, { forward: true });
  }

  /**
   * Default: bottom-centre of whichever display holds the cursor. After a
   * drag, the session anchor — which dies with the process, never config.json.
   */
  #position(window: BrowserWindow, size: HudSize): void {
    if (this.#drag !== null) return;
    if (this.#anchor === null) {
      const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      window.setBounds(hudBounds(display.workArea, size));
      return;
    }
    const display = screen.getDisplayNearestPoint(this.#anchor);
    window.setBounds(boundsFromAnchor(this.#anchor, size, display.workArea));
  }
}
