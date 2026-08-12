/**
 * OWNER: **Phase 4**. The one setting that has to reach the operating system.
 *
 * `contracts/config.ts` carries `launchAtLogin`; macOS keeps the truth in
 * LaunchServices, and the two can disagree — the user can remove the app from
 * System Settings › General › Login Items without the app ever knowing. So the
 * app's setting is treated as the intent and pushed to the OS whenever the two
 * differ, rather than written once and assumed.
 *
 * The Electron dependency is behind `LoginItemTarget` so the reconciliation is
 * unit-testable; `src/main/ui/index.ts` passes the real `app`.
 */

import type { AppConfig } from '@contracts/config.js';
import type { Logger } from '@shared/logger.js';

export interface LoginItemTarget {
  getLoginItemSettings(): { openAtLogin: boolean };
  setLoginItemSettings(settings: { openAtLogin: boolean }): void;
}

/**
 * Returns whether anything was changed, so the caller can log a state change
 * rather than a heartbeat.
 */
export function syncLaunchAtLogin(
  target: LoginItemTarget,
  config: AppConfig,
  logger: Logger,
): boolean {
  const log = logger.child('login-item');
  let current: boolean;
  try {
    current = target.getLoginItemSettings().openAtLogin;
  } catch (cause) {
    log.warn('could not read the login-item setting', { err: cause });
    return false;
  }

  if (current === config.launchAtLogin) return false;

  try {
    target.setLoginItemSettings({ openAtLogin: config.launchAtLogin });
    log.info('login item updated', { openAtLogin: config.launchAtLogin });
    return true;
  } catch (cause) {
    // Failing to register at login must never stop the app from starting.
    log.error('could not update the login-item setting', { err: cause });
    return false;
  }
}
