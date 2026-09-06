/**
 * The dwell, the fade, click-through, and the in-memory drag anchor.
 *
 * Electron is mocked rather than launched: `focus.e2e.test.ts` covers the real
 * window server, and what is asserted here is arithmetic on timers and bounds.
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
  ignoreForward: boolean;
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
    setIgnoreMouseEvents = (value: boolean, opts?: { forward?: boolean }): void => {
      fake.ignoreMouse = value;
      fake.ignoreForward = opts?.forward === true;
    };
    getBounds = (): { x: number; y: number; width: number; height: number } =>
      fake.bounds ?? { x: 0, y: 0, width: 160, height: 64 };
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
const { HUD_FADE_MS, HUD_NOTICE_WINDOW, hudBounds, hudDwellMs } = await import('./layout.js');
const { createLogger } = await import('@shared/logger.js');

/** One 60 Hz frame — the fade's step. */
const FRAME = 16;

const ERROR: HudView = { kind: 'error', message: 'No speech was detected.', hint: 'Check it.' };
const HOLD: HudView = { kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' };
const TOGGLE: HudView = { kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'toggle' };
const ERROR_DWELL = hudDwellMs(ERROR) ?? 0;
const WORK_AREA = { x: 0, y: 0, width: 1512, height: 944 };

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
    ignoreForward: false,
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

    hud.show(HOLD);
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
    await shown(HOLD);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fake.visible).toBe(true);
    expect(fake.hidden).toBe(0);
  });

  it('notifies onHidden once when the dwell hide runs', async () => {
    const hud = await shown(ERROR);
    let hidden = 0;
    hud.onHidden = () => {
      hidden += 1;
    };
    await vi.advanceTimersByTimeAsync(ERROR_DWELL + FRAME);
    expect(fake.visible).toBe(false);
    expect(hidden).toBe(1);
    hud.hide();
    expect(hidden).toBe(1);
  });
});

describe('mouse ignore', () => {
  it('forwards through empty chrome on error, and captures on hover', async () => {
    const hud = await shown(ERROR);
    expect(fake.ignoreMouse).toBe(true);
    expect(fake.ignoreForward).toBe(true);

    hud.onPointer('enter');
    expect(fake.ignoreMouse).toBe(false);

    hud.onPointer('leave');
    expect(fake.ignoreMouse).toBe(true);
    expect(fake.ignoreForward).toBe(true);
  });

  it('takes the mouse for hands-free even before hover', async () => {
    await shown(TOGGLE);
    expect(fake.ignoreMouse).toBe(false);
    expect(fake.ignoreForward).toBe(false);
  });

  it('forwards on hold — drag is hover-forward, not hudInteractive', async () => {
    await shown(HOLD);
    expect(fake.ignoreMouse).toBe(true);
    expect(fake.ignoreForward).toBe(true);
  });

  it('blocked is fully click-through, including the pills', async () => {
    await shown({ kind: 'blocked' });
    expect(fake.ignoreMouse).toBe(true);
    expect(fake.ignoreForward).toBe(false);
  });

  it('a click without a move does not pin the session position', async () => {
    const hud = await shown(HOLD);
    hud.beginDrag(400, 800);
    hud.endDrag();
    hud.show(ERROR);
    expect(fake.bounds).toEqual(hudBounds(WORK_AREA, HUD_NOTICE_WINDOW));
  });

  it('does not restore click-through on leave mid-drag', async () => {
    const hud = await shown(ERROR);
    hud.beginDrag(400, 800);
    expect(fake.ignoreMouse).toBe(false);
    hud.onPointer('leave');
    expect(fake.ignoreMouse).toBe(false);
    hud.endDrag();
    // The renderer re-sends leave after pointerup if the cursor is off the pill.
    hud.onPointer('leave');
    expect(fake.ignoreMouse).toBe(true);
    expect(fake.ignoreForward).toBe(true);
  });
});

describe('session drag anchor', () => {
  it('does not snap back to default bottom-centre after a drag', async () => {
    const hud = await shown(HOLD);
    const start = fake.bounds;
    expect(start).not.toBeNull();
    const originX = 400;
    const originY = 800;
    hud.beginDrag(originX, originY);
    hud.dragTo(originX - 120, originY - 40);
    hud.endDrag();
    const dragged = fake.bounds;
    expect(dragged).not.toBeNull();
    if (start === null || dragged === null) throw new Error('bounds missing');
    expect(dragged.x).toBe(start.x - 120);
    expect(dragged.y).toBe(start.y - 40);

    hud.show(ERROR);
    const next = fake.bounds;
    expect(next).not.toBeNull();
    if (next === null) throw new Error('bounds missing');
    expect(next.width).toBe(HUD_NOTICE_WINDOW.width);
    expect(next.height).toBe(HUD_NOTICE_WINDOW.height);
    expect(next.x + next.width / 2).toBe(dragged.x + dragged.width / 2);
    expect(next.y + next.height).toBe(dragged.y + dragged.height);

    const fallback = hudBounds(WORK_AREA, HUD_NOTICE_WINDOW);
    expect(next.x).not.toBe(fallback.x);
  });
});
