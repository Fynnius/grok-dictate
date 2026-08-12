/**
 * The static half of "the HUD never steals focus" (IMPLEMENTATION-PLAN.md §3.4,
 * ). It asserts the flag set that makes it true.
 *
 * The dynamic half — that the frontmost *application* is genuinely unchanged
 * after the pill shows — needs a real window server and lives in
 * `focus.e2e.test.ts`, which the user runs as HT-1.
 */

import { describe, expect, it } from 'vitest';
import { applyHudWindowFlags, HUD_WINDOW_OPTIONS, type HudFlagTarget } from './flags.js';

describe('HUD_WINDOW_OPTIONS', () => {
  it('sets every constructor flag  requires', () => {
    expect(HUD_WINDOW_OPTIONS).toMatchObject({
      focusable: false,
      frame: false,
      transparent: true,
      skipTaskbar: true,
      alwaysOnTop: true,
    });
  });

  it('cannot be moved, resized or fullscreened into taking focus', () => {
    expect(HUD_WINDOW_OPTIONS).toMatchObject({
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
    });
  });

  it('starts hidden — the pill is only ever shown by a state transition', () => {
    expect(HUD_WINDOW_OPTIONS.show).toBe(false);
  });

  it('accepts the first mouse click, so the Copy button works on a never-key window', () => {
    expect(HUD_WINDOW_OPTIONS.acceptFirstMouse).toBe(true);
  });

  it('disables background throttling, because the audio cues play in this renderer', () => {
    expect(HUD_WINDOW_OPTIONS.webPreferences?.backgroundThrottling).toBe(false);
  });

  it('never re-enables focus through a stray option', () => {
    // A regression guard with teeth: if someone adds `focusable: true` or drops
    // the key back in while restyling, this fails rather than the user
    // discovering it when text lands in the wrong app.
    expect(Object.hasOwn(HUD_WINDOW_OPTIONS, 'focusable')).toBe(true);
    expect(HUD_WINDOW_OPTIONS.focusable).not.toBe(true);
  });
});

describe('applyHudWindowFlags', () => {
  function fake(): { target: HudFlagTarget; calls: string[] } {
    const calls: string[] = [];
    const target: HudFlagTarget = {
      setAlwaysOnTop(flag, level) {
        calls.push(`alwaysOnTop:${String(flag)}:${level ?? 'default'}`);
      },
      setVisibleOnAllWorkspaces(visible, options) {
        calls.push(
          `allWorkspaces:${String(visible)}:fullScreen=${String(options?.visibleOnFullScreen)}`,
        );
      },
      setFocusable(focusable) {
        calls.push(`focusable:${String(focusable)}`);
      },
    };
    return { target, calls };
  }

  it('raises the pill to screen-saver level, which is what clears a full-screen app', () => {
    const { target, calls } = fake();
    applyHudWindowFlags(target);
    expect(calls).toContain('alwaysOnTop:true:screen-saver');
  });

  it('follows the user across Spaces and shows over full-screen apps', () => {
    const { target, calls } = fake();
    applyHudWindowFlags(target);
    expect(calls).toContain('allWorkspaces:true:fullScreen=true');
  });

  it('re-asserts focusable:false after construction', () => {
    const { target, calls } = fake();
    applyHudWindowFlags(target);
    expect(calls).toContain('focusable:false');
    expect(calls).not.toContain('focusable:true');
  });
});
