/**
 * Show a HUD state directly, after a delay. Development only, driven from the
 * tray's *Preview HUD* submenu.
 *
 * The delay is the feature. Phase 4 ran in parallel with Phase 2, so there was
 * no real `Fn` key to trigger the pill with — and clicking anything inside the
 * app is exactly what invalidates a focus test. Choosing a preview and then
 * clicking into a text editor is what made IMPLEMENTATION-PLAN.md §3.4's HT-1
 * possible at all, and it is still the cheapest way to re-run it.
 */

import type { HudView } from '@contracts/events.js';
import type { HudPort } from '@contracts/ports.js';

export interface HudPreview {
  show(view: HudView, delayMs: number): void;
  dispose(): void;
}

export function createHudPreview(hud: HudPort): HudPreview {
  let timer: NodeJS.Timeout | null = null;

  const run = (view: HudView): void => {
    timer = null;
    if (view.kind === 'hidden') hud.hide();
    else hud.show(view);
  };

  return {
    show(view: HudView, delayMs: number): void {
      if (timer !== null) clearTimeout(timer);
      if (delayMs <= 0) {
        run(view);
        return;
      }
      timer = setTimeout(() => {
        run(view);
      }, delayMs);
      timer.unref?.();
    },

    dispose(): void {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
