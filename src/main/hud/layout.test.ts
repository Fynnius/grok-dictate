import { describe, expect, it } from 'vitest';
import type { HudView } from '@contracts/events.js';
import {
  HUD_BOTTOM_MARGIN,
  HUD_CAPSULE_WINDOW,
  HUD_FADE_MS,
  HUD_MESSAGE_WINDOW,
  HUD_NOTICE_WINDOW,
  hudBounds,
  hudDwellMs,
  hudInteractive,
  hudSize,
} from './layout.js';

const VIEWS: Record<HudView['kind'], HudView> = {
  hidden: { kind: 'hidden' },
  recording: { kind: 'recording', elapsedMs: 3_000, level: 0.3, interim: 'hallo', mode: 'hold' },
  processing: { kind: 'processing', interim: 'hallo' },
  inserted: { kind: 'inserted', text: 'hallo', tier: 'ax' },
  not_inserted: { kind: 'not_inserted', text: 'hallo', reason: 'insert_failed', detail: null },
  blocked: { kind: 'blocked' },
  error: { kind: 'error', message: 'boom', hint: null },
};

const ALL = Object.values(VIEWS);

describe('hudSize', () => {
  it('grows only for the states that carry the message pill (overhaul §16.3)', () => {
    expect(hudSize(VIEWS.not_inserted)).toEqual(HUD_MESSAGE_WINDOW);
    expect(hudSize(VIEWS.recording)).toEqual(HUD_CAPSULE_WINDOW);
    expect(hudSize(VIEWS.processing)).toEqual(HUD_CAPSULE_WINDOW);
    // `inserted` is the green check in the capsule now — the transcript no
    // longer shows, a trade the user chose (overhaul §16.4).
    expect(hudSize(VIEWS.inserted)).toEqual(HUD_CAPSULE_WINDOW);
  });

  it('gives a sentence less room than a transcript (§19.3)', () => {
    // `error` and `blocked` say one thing and leave; only `not_inserted` puts
    // the words themselves on screen. The window is transparent, so a size it
    // does not need is a rectangle floating over the user's document for no
    // reason.
    expect(hudSize(VIEWS.error)).toEqual(HUD_NOTICE_WINDOW);
    expect(hudSize(VIEWS.blocked)).toEqual(HUD_NOTICE_WINDOW);
    expect(HUD_NOTICE_WINDOW.height).toBeLessThan(HUD_MESSAGE_WINDOW.height);
  });

  it('always returns a usable size', () => {
    for (const view of ALL) {
      const size = hudSize(view);
      expect(size.width).toBeGreaterThan(0);
      expect(size.height).toBeGreaterThan(0);
    }
  });
});

describe('hudInteractive', () => {
  it('takes the mouse only where there is a button to press', () => {
    expect(hudInteractive(VIEWS.not_inserted)).toBe(true);
    // Hands-free has the ✕/✓ buttons (§16.5c).
    expect(
      hudInteractive({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'toggle' }),
    ).toBe(true);
  });

  it('is click-through while dictating hold, so a click reaches the app underneath', () => {
    expect(hudInteractive(VIEWS.recording)).toBe(false);
    expect(hudInteractive(VIEWS.processing)).toBe(false);
    expect(hudInteractive(VIEWS.inserted)).toBe(false);
    expect(hudInteractive(VIEWS.blocked)).toBe(false);
    expect(hudInteractive(VIEWS.hidden)).toBe(false);
    // `error` joined them in §19.3 when its Dismiss button went: the only click
    // it could take now is one the user aimed at the app underneath.
    expect(hudInteractive(VIEWS.error)).toBe(false);
  });
});

describe('hudDwellMs', () => {
  it('leaves the live states up until the session replaces them', () => {
    expect(hudDwellMs(VIEWS.recording)).toBeNull();
    expect(hudDwellMs(VIEWS.processing)).toBeNull();
  });

  it('keeps `blocked` up until Secure Input actually clears (§12.2)', () => {
    // Hiding it on a timer would re-hide the one signal that explains why the
    // hotkey has stopped responding.
    expect(hudDwellMs(VIEWS.blocked)).toBeNull();
  });

  it('gives the recovery state far longer than the success state', () => {
    const notInserted = hudDwellMs(VIEWS.not_inserted);
    const inserted = hudDwellMs(VIEWS.inserted);
    expect(inserted).not.toBeNull();
    expect(notInserted).not.toBeNull();
    expect(notInserted ?? 0).toBeGreaterThan((inserted ?? 0) * 4);
  });

  it('always ends a terminal state, because the machine emits no `hidden` after one', () => {
    // `finishInsert` in src/main/state/machine.ts pushes `inserted` /
    // `not_inserted` and stops; without a dwell the pill would stay forever.
    expect(hudDwellMs(VIEWS.inserted)).not.toBeNull();
    expect(hudDwellMs(VIEWS.not_inserted)).not.toBeNull();
    expect(hudDwellMs(VIEWS.error)).not.toBeNull();
  });

  it('handles every HudView kind', () => {
    for (const view of ALL) expect(() => hudDwellMs(view)).not.toThrow();
  });

  it('leaves room for the fade inside every dwell it sets (§19.3)', () => {
    // `hud-window.ts` starts the fade at `dwell - HUD_FADE_MS`; a dwell shorter
    // than the fade would mean the pill began leaving before it had arrived.
    for (const view of ALL) {
      const dwell = hudDwellMs(view);
      if (dwell !== null) expect(dwell).toBeGreaterThan(HUD_FADE_MS * 2);
    }
  });
});

describe('hudBounds — multi-display (IMPLEMENTATION-PLAN.md §5b)', () => {
  const PRIMARY = { x: 0, y: 0, width: 1512, height: 944 };

  it('centres the pill horizontally and sits it above the bottom margin', () => {
    expect(hudBounds(PRIMARY, HUD_CAPSULE_WINDOW)).toEqual({
      x: Math.round((1512 - HUD_CAPSULE_WINDOW.width) / 2),
      y: 944 - HUD_CAPSULE_WINDOW.height - HUD_BOTTOM_MARGIN,
      width: HUD_CAPSULE_WINDOW.width,
      height: HUD_CAPSULE_WINDOW.height,
    });
  });

  it('honours a display to the left, whose work area has a negative origin', () => {
    // The bug this guards is arithmetic that assumes an origin of (0, 0): on a
    // secondary display it puts the pill on the wrong screen, or off every
    // screen — silent, and invisible on the single-display machine this was
    // developed on.
    const left = { x: -1920, y: -120, width: 1920, height: 1080 };
    const bounds = hudBounds(left, HUD_MESSAGE_WINDOW);
    expect(bounds.x).toBe(-1920 + Math.round((1920 - HUD_MESSAGE_WINDOW.width) / 2));
    expect(bounds.y).toBe(-120 + 1080 - HUD_MESSAGE_WINDOW.height - HUD_BOTTOM_MARGIN);
  });

  it('keeps the pill inside the work area on a small display', () => {
    const small = { x: 0, y: 25, width: 1280, height: 775 };
    for (const size of [HUD_CAPSULE_WINDOW, HUD_MESSAGE_WINDOW]) {
      const bounds = hudBounds(small, size);
      expect(bounds.x).toBeGreaterThanOrEqual(small.x);
      expect(bounds.y).toBeGreaterThanOrEqual(small.y);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(small.x + small.width);
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(small.y + small.height);
    }
  });
});
