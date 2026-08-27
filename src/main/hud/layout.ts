/**
 * OWNER: **Phase 4**; resized by the design overhaul, session 1. How big the
 * HUD window is, how long a state lingers, and whether it takes the mouse.
 *
 * Split out of `hud-window.ts` so the rules are unit-testable without Electron.
 *
 * The facts that used to be stated twice here and in the renderer — which
 * states show words, which take the mouse — now live once, in
 * `src/shared/hud-view.ts`, which both tsconfig projects include. This file
 * only maps them onto window geometry, which is main-process knowledge.
 */

import type { HudView } from '@contracts/events.js';
import { hudLayer } from '@shared/hud-view.js';

export interface HudSize {
  readonly width: number;
  readonly height: number;
}

/**
 * Window sizes for the two-pill design (overhaul §16.3, §16.6). The window is
 * larger than the pixels it shows: the visible capsule is 71–100 × 30 pt and
 * resizes *inside* the window with CSS (§11.1.2 — animating the window between
 * three near-identical widths would read as jitter), so `setBounds` runs once
 * per state, not once per width.
 */

/** Capsule only: waveform / spinner / check, plus shadow clearance. */
export const HUD_CAPSULE_WINDOW: HudSize = { width: 160, height: 64 };
/** Size a transcript overlay would need. No insert state uses this window now;
 *  kept so `hudBounds` tests still cover a large overlay on a secondary display. */
export const HUD_MESSAGE_WINDOW: HudSize = { width: 400, height: 260 };
/**
 * Capsule plus a two-or-three-line notice (`error`, `blocked`) — a title and a
 * line of advice, nothing more (§19.3). Sized to that rather than to the
 * transcript pill so the transparent window is not a 400 × 260 rectangle
 * floating over the user's document for states that need a fifth of it.
 */
export const HUD_NOTICE_WINDOW: HudSize = { width: 400, height: 152 };

/**
 * Distance from the bottom of the work area to the window's bottom edge.
 *
 * **Closes overhaul §9.4** (96 pt here vs the reference's 12.5 pt): the user's
 * report was "this whole bar goes more to the bottom, it's too far inside the
 * screen", so the reference wins. This is measured from the *work area*, which
 * already excludes a visible Dock, so a small margin is safe on every Dock
 * setting — that is the argument §9.4 left open, and it is why the number can
 * be this low without the pill ever landing behind the Dock.
 *
 * The pill the user sees sits 14 pt higher again: `hud.css` reserves that much
 * inside the window as shadow clearance. 4 + 14 = 18 pt of visible gap.
 */
export const HUD_BOTTOM_MARGIN = 4;

/** A display's work area, as `Electron.Display.workArea` reports it. */
export interface WorkArea {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where the pill goes: bottom-centre of the work area it is given.
 *
 * Pure, and separate from `hud-window.ts`, because IMPLEMENTATION-PLAN.md §5b
 * asks for the focus guarantee to hold "including on multi-display". A second
 * display's `workArea` has a **non-zero origin** — a monitor to the left of the
 * primary reports a negative `x`, one above it a negative `y` — so arithmetic
 * that assumed an origin of `(0, 0)` would put the pill on the wrong screen or
 * off the edge of every screen. That is not a focus failure, but it is the same
 * bug class: silent, and invisible on the single-display machine everything was
 * developed on.
 */
export function hudBounds(
  workArea: WorkArea,
  size: HudSize,
): { x: number; y: number; width: number; height: number } {
  return {
    x: Math.round(workArea.x + (workArea.width - size.width) / 2),
    y: Math.round(workArea.y + workArea.height - size.height - HUD_BOTTOM_MARGIN),
    width: size.width,
    height: size.height,
  };
}

/**
 * Window size per state, derived from the shared surface switch so the main
 * process and the renderer can no longer disagree about which states carry
 * the message pill.
 *
 * The one distinction this file adds on top of `hudLayer` is *how much* the
 * pill has to say: `error` and `blocked` carry a sentence; insert outcomes
 * are a wordless capsule. `HUD_MESSAGE_WINDOW` stays as the size a transcript
 * pill would need, used by tests of `hudBounds` on a large overlay.
 */
export function hudSize(view: HudView): HudSize {
  if (hudLayer(view) !== 'capsule-message') return HUD_CAPSULE_WINDOW;
  return HUD_NOTICE_WINDOW;
}

/**
 * Whether the window should accept the mouse at all now lives in
 * `src/shared/hud-view.ts`, where the renderer reads the same switch —
 * re-exported here so `hud-window.ts` keeps one import site for its rules.
 */
export { hudInteractive } from '@shared/hud-view.js';

/**
 * How long a state stays on screen before the HUD hides itself, or `null` for
 * "until the session replaces it".
 *
 * The state machine emits no `hidden` view after a terminal insert — see
 * `finishInsert` in `src/main/state/machine.ts`, which pushes `inserted` /
 * `not_inserted` and stops. Dwell therefore lives here, in the window, which is
 * also the only place that knows the pill is a transient overlay rather than a
 * piece of app chrome.
 */
export function hudDwellMs(view: HudView): number | null {
  switch (view.kind) {
    case 'hidden':
      return null;
    case 'recording':
    case 'processing':
      return null; // ends when the session does
    case 'blocked':
      // Cleared by `SECURE_INPUT(false)`, which emits `hud(hidden)`. Hiding it
      // on a timer would re-hide the one signal that explains why the hotkey
      // is dead.
      return null;
    case 'inserted':
    case 'not_inserted':
      // Wordless: a green check or a red flash, then gone. Recovery is
      // History and ⌃⌘V, not a paragraph over the document.
      return 2_000;
    case 'error':
      // Shortened from 8 s (§19.3). The pill no longer carries a Dismiss
      // button, so this timer is the only way it leaves — and the user asked
      // for it to "blend out earlier" instead of being clicked away. Five
      // seconds is a comfortable read of a title plus one line of advice; the
      // last 260 ms of it are the fade in `hud-window.ts`.
      return 5_000;
  }
}

/**
 * How long the window spends fading out when a dwell expires.
 *
 * A pill that vanishes between two frames reads as a glitch — the eye catches
 * the disappearance and not the thing that disappeared. A short fade is what
 * makes an auto-dismissing notice feel dismissed rather than lost, and it is
 * the reason the Dismiss button could go (§19.3). Only dwell expiry fades; a
 * `hide()` caused by the next state must be instant, or the outgoing pill
 * would still be on screen underneath the incoming one.
 */
export const HUD_FADE_MS = 260;
