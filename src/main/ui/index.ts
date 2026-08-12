/**
 * The main-process services behind everything the user sees: Escape-to-cancel,
 * launch-at-login reconciliation, the history retention sweep, and the fan-out
 * of `config-updated` / `history-updated` to the panel windows.
 *
 * Phase 4 had to start all of this from `createTray`, because `createTray` was
 * the one Phase 4 factory the then-frozen composition root called, and it had
 * to reach config, history and the HUD through module-level accessors
 * (docs/phase-4-report.md §5.5). Phase 5 owns the composition root, so these
 * are ordinary constructor arguments and the tray is once again just a
 * `TrayPort`.
 *
 * One behavioural consequence of that move is worth stating: session state now
 * arrives from the orchestrator's `onChange`, which fires on **every**
 * transition, rather than from `TrayPort.setState`, which only fires when the
 * machine emits a `tray` effect. Escape is therefore armed and disarmed
 * correctly even for transitions that carry no tray effect.
 */

import type { App, GlobalShortcut } from 'electron';
import type { SessionState } from '@contracts/events.js';
import type { ConfigPort } from '@contracts/ports.js';
import type { Logger } from '@shared/logger.js';
import type { HistoryStore } from '../history/index.js';
import { EscapeCancel } from './escape.js';
import { syncLaunchAtLogin } from './launch-at-login.js';
import type { PanelWindows } from './panels.js';

/** Re-sweep occasionally so a machine left running for days still expires rows. */
const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UiServiceDeps {
  readonly app: App;
  readonly globalShortcut: GlobalShortcut;
  readonly config: ConfigPort;
  readonly history: HistoryStore;
  readonly panels: PanelWindows;
  readonly logger: Logger;
  /** Feeds `CANCEL` into the state machine when Escape is pressed. */
  readonly onCancel: () => void;
}

export interface UiServices {
  /** Drive from every session transition. */
  setSessionState(state: SessionState): void;
  /** Deferred work that needs `app.whenReady()`. */
  ready(): void;
  dispose(): void;
}

export function createUiServices(deps: UiServiceDeps): UiServices {
  const log = deps.logger.child('ui');
  const escape = new EscapeCancel(deps.globalShortcut, deps.onCancel, log);
  const unsubscribes: (() => void)[] = [];
  let sweepTimer: NodeJS.Timeout | null = null;
  let disposed = false;

  return {
    setSessionState(state: SessionState): void {
      escape.setState(state);
    },

    ready(): void {
      const { app, config, history, panels } = deps;

      syncLaunchAtLogin(app, config.get(), log);
      void history.sweep(config.get().historyRetentionDays);

      unsubscribes.push(
        config.onChange((next) => {
          syncLaunchAtLogin(app, next, log);
          void history.sweep(next.historyRetentionDays);
          panels.broadcast({ type: 'config-updated', config: next });
        }),
        history.onChange((count) => {
          panels.broadcast({ type: 'history-updated', count });
        }),
      );

      sweepTimer = setInterval(() => {
        void history.sweep(config.get().historyRetentionDays);
      }, SWEEP_INTERVAL_MS);
      sweepTimer.unref?.();
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      escape.dispose();
      for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
      if (sweepTimer !== null) {
        clearInterval(sweepTimer);
        sweepTimer = null;
      }
      deps.panels.closeAll();
    },
  };
}
