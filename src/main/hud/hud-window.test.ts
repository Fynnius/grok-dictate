/**
 * The dwell and the fade — the pill's exit, which since §19.3 is the *only* way
 * an `error` leaves the screen. It has no Dismiss button any more, so a broken
 * timer here would mean a red capsule sitting over the user's work until the
 * next dictation replaces it.
 *
 * Electron is mocked rather than launched: `focus.e2e.test.ts` covers the real
 * window server, and what is asserted here is arithmetic on timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HudView } from '@contracts/events.js';

/** Every call the class makes on a `BrowserWindow`, recorded. */
interface FakeWindow {
  opacity: number[];
  visible: boolean;
  hidden: number;
  destroyed: boolean;
  bounds: { x: number; y: number; width: number; height: number } | null;
  ignoreMouse: boolean | null;
  sent: unknown[];
}

let fake: FakeWindow;

vi.mock('electron', () => {
  class BrowserWindow {
    isDestroyed = (): boolean => fake.destroyed;
    isVisible = (): boolean => fake.visible;
    isFocusable = (): boolean => false;
    isAlwaysOnTop = (): boolean => true;
    setOpacity = (value: number): void => void fake.opacity.push(value);
    setIgnoreMouseEvents = (value: boolean): void => void (fake.ignoreMouse = value);
    setBounds = (bounds: FakeWindow['bounds']): void => void (fake.bounds = bounds);
    showInactive = (): void => void (fake.visible = true);
    hide = (): void => {
      fake.visible = false;
      fake.hidden++;
    };
    destroy = (): void => void (fake.destroyed = true);
    setAlwaysOnTop = (): void => undefined;
    setVisibleOnAllWorkspaces = (): void => undefined;
    setFocusable = (): void => undefined;
    loadFile = (): Promise<void> => Promise.resolve();
    loadURL = (): Promise<void> => Promise.resolve();
    webContents = {
      send: (_channel: string, message: unknown): void => void fake.sent.push(message),
    };
  }
  return {
    BrowserWindow,
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1512, height: 944 } }),
    },
  };
});

const { HudWindow } = await import('./hud-window.js');
const { HUD_FADE_MS, hudDwellMs } = await import('./layout.js');
const { createLogger } = await import('@shared/logger.js');

/** One 60 Hz frame — the fade's step. */
const FRAME = 16;

const ERROR: HudView = { kind: 'error', message: 'No speech was detected.', hint: 'Check it.' };
const ERROR_DWELL = hudDwellMs(ERROR) ?? 0;

async function shown(view: HudView): Promise<InstanceType<typeof HudWindow>> {
  const hud = new HudWindow(createLogger('test'), () => undefined);
  await hud.create();
  hud.show(view);
  return hud;
}

beforeEach(() => {
  vi.useFakeTimers();
  fake = {
    opacity: [],
    visible: false,
    hidden: 0,
    destroyed: false,
    bounds: null,
    ignoreMouse: null,
    sent: [],
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe('dwell and fade', () => {
  it('holds the pill fully opaque for the dwell it was given', async () => {
    await shown(ERROR);
    await vi.advanceTimersByTimeAsync(ERROR_DWELL - HUD_FADE_MS - 20);
    expect(fake.visible).toBe(true);
    expect(fake.opacity.every((value) => value === 1)).toBe(true);
  });

  it('fades out and is gone by the end of the dwell, not after it', async () => {
    await shown(ERROR);
    await vi.advanceTimersByTimeAsync(ERROR_DWELL - HUD_FADE_MS + FRAME);
    // Mid-fade: dimmed, still on screen.
    const dimmed = fake.opacity.filter((value) => value > 0 && value < 1);
    expect(dimmed.length).toBeGreaterThan(0);
    expect(fake.visible).toBe(true);

    await vi.advanceTimersByTimeAsync(HUD_FADE_MS);
    expect(fake.visible).toBe(false);
    expect(fake.hidden).toBe(1);
  });

  it('fades monotonically — the pill never brightens on its way out', async () => {
    await shown(ERROR);
    await vi.advanceTimersByTimeAsync(ERROR_DWELL - HUD_FADE_MS);
    const start = fake.opacity.length;
    await vi.advanceTimersByTimeAsync(HUD_FADE_MS - FRAME);
    const ramp = fake.opacity.slice(start).filter((value) => value < 1);
    expect(ramp.length).toBeGreaterThan(2);
    for (let i = 1; i < ramp.length; i++) expect(ramp[i]).toBeLessThanOrEqual(ramp[i - 1] ?? 1);
  });

  it('restores full opacity when the next state arrives mid-fade', async () => {
    // The failure this guards: a dictation started while an error was fading
    // would show its capsule at whatever opacity the fade had reached.
    const hud = await shown(ERROR);
    await vi.advanceTimersByTimeAsync(ERROR_DWELL - HUD_FADE_MS + FRAME * 4);
    expect(fake.opacity.some((value) => value < 1)).toBe(true);

    hud.show({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' });
    expect(fake.opacity.at(-1)).toBe(1);
    expect(fake.visible).toBe(true);

    // …and the interrupted fade must not still be running underneath it.
    await vi.advanceTimersByTimeAsync(HUD_FADE_MS * 4);
    expect(fake.opacity.at(-1)).toBe(1);
    expect(fake.visible).toBe(true);
  });

  it('hides instantly when something else hides it, without a fade', async () => {
    const hud = await shown(ERROR);
    hud.hide();
    expect(fake.visible).toBe(false);
    // The outgoing pill must not linger under the one replacing it.
    expect(fake.opacity.filter((value) => value < 1)).toEqual([]);
    expect(fake.opacity.at(-1)).toBe(1);
  });

  it('leaves nothing running after destroy', async () => {
    const hud = await shown(ERROR);
    await vi.advanceTimersByTimeAsync(ERROR_DWELL - HUD_FADE_MS + FRAME);
    hud.destroy();
    const after = fake.opacity.length;
    await vi.advanceTimersByTimeAsync(ERROR_DWELL * 2);
    expect(fake.opacity.length).toBe(after);
  });

  it('never sets a dwell for a state that ends when the session does', async () => {
    await shown({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.visible).toBe(true);
    expect(fake.hidden).toBe(0);
  });
});
