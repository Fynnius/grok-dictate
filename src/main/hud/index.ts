/**
 * OWNER: **Phase 4** (boundary clarification in docs/phase-1-report.md §6).
 *
 * Phase 4 kept the instance in a module-level singleton so `src/main/sound/`
 * could reach the HUD's renderer without the then-frozen composition root
 * passing it (docs/phase-4-report.md §5.5). Phase 5 passes it, so the singleton
 * and its `hudWindow()` accessor are gone.
 */

import type { Logger } from '@shared/logger.js';
import { HudWindow, type HudBroadcast } from './hud-window.js';

export function createHud(logger: Logger, broadcast: HudBroadcast): HudWindow {
  return new HudWindow(logger, broadcast);
}
