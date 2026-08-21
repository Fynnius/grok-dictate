/**
 * OWNER: **Phase 4**. The menu-bar menu, as data.
 *
 * The template is pure data — every item carries a `TrayAction` value rather
 * than a closure — so the whole menu is unit-testable without Electron, and so
 * a test can assert the property that matters most here: **no tray item writes
 * the clipboard**. A menu built
 * from closures would make that assertion impossible.
 *
 * `src/main/tray/index.ts` maps the actions onto handlers and hands the result
 * to `Menu.buildFromTemplate`.
 */

import type { AppConfig, LanguageMode } from '@contracts/config.js';
import type { HudView, SessionState } from '@contracts/events.js';
import type { TrayIconName } from './icons.js';

export type PanelName = 'settings' | 'history' | 'scratchpad';

export type TrayAction =
  | { kind: 'set-language'; mode: LanguageMode }
  /** Open System Settings at the pane that fixes a missing grant. */
  | { kind: 'open-accessibility-settings' }
  | { kind: 'set-audio-cues'; enabled: boolean }
  | { kind: 'open'; panel: PanelName }
  | { kind: 'sign-in' }
  | { kind: 'preview-hud'; view: HudView; delayMs: number }
  | { kind: 'quit' };

export interface TrayMenuItem {
  readonly id: string;
  readonly label?: string;
  readonly type?: 'normal' | 'separator' | 'radio' | 'checkbox' | 'submenu';
  readonly enabled?: boolean;
  readonly checked?: boolean;
  readonly action?: TrayAction;
  readonly submenu?: readonly TrayMenuItem[];
}

export interface TrayModel {
  readonly state: SessionState;
  readonly secureInput: boolean;
  readonly config: AppConfig;
  readonly historyCount: number;
  /**
   * The HUD-preview submenu. It exists because Phase 4 runs in parallel with
   * Phase 2, so there is no real `Fn` key yet — and clicking a button in the
   * app's own debug window is exactly the thing that invalidates a focus test
   * (docs/phase-1-report.md §4, HT-2's caveat). A *delayed* preview is what
   * lets the user put focus in a text editor first.
   */
  readonly includePreview: boolean;
  /**
   * Whether the event tap is installed and enabled *right now*.
   *
   * Until Phase 5 the menu said "Ready" whenever the session state was `idle`,
   * which is true of an app whose hotkey is dead — and that is the state a
   * packaged build starts in, since a packaged `.app` is its own TCC identity
   * and Accessibility begins ungranted (docs/phase-2-report.md §4, HT-1). The
   * user hit exactly that: a menu bar reading "Ready" and an Fn key that did
   * nothing.  in the one surface built to prevent it.
   */
  readonly hotkeyActive: boolean;
  /** `false` means the grant is missing, as opposed to Secure Input holding
   *  the tap down — different sentences, different remedies. */
  readonly accessibility: boolean;
  /** When false, the menu leads with Sign in. */
  readonly signedIn: boolean;
}

/**
 * Anything that stops the hotkey outranks the session state, because it is the
 * reason nothing is responding.
 *
 * A dead tap ranks above Secure Input: Secure Input is transient and clears
 * itself when the password field loses focus, while a missing grant needs the
 * user to go and do something.
 */
export function trayIconFor(
  state: SessionState,
  secureInput: boolean,
  hotkeyActive = true,
): TrayIconName {
  if (!hotkeyActive || secureInput || state === 'blocked') return 'blocked';
  return state === 'recording' ? 'recording' : 'idle';
}

export function trayStatusLabel(
  state: SessionState,
  secureInput: boolean,
  hotkeyActive = true,
  accessibility = true,
): string {
  if (!hotkeyActive && !secureInput) {
    // The warning sign is the visual weight the overhaul's §11.1.12 asks for:
    // a native menu item cannot be styled, and "Ready" versus a dead hotkey is
    // the difference between a working app and a broken one — it must not
    // render as the same grey row.
    return accessibility
      ? '⚠️ The Fn key is not being detected'
      : '⚠️ Accessibility permission is needed';
  }
  if (secureInput || state === 'blocked') return 'Blocked — Secure Input is active';
  switch (state) {
    case 'idle':
      return 'Ready';
    case 'recording':
      return 'Listening…';
    case 'processing':
      return 'Transcribing…';
    case 'inserting':
      return 'Inserting…';
  }
}

const PREVIEW_DELAY_MS = 5_000;

const PREVIEW_VIEWS: readonly { id: string; label: string; view: HudView }[] = [
  {
    id: 'preview.recording',
    label: 'Recording',
    view: {
      kind: 'recording',
      elapsedMs: 7_000,
      level: 0.42,
      interim: 'hello there',
      mode: 'hold',
    },
  },
  {
    id: 'preview.processing',
    label: 'Transcribing',
    view: { kind: 'processing', interim: 'hello there, this is a test' },
  },
  {
    id: 'preview.inserted',
    label: 'Inserted',
    view: {
      kind: 'inserted',
      text: 'Deployed that on the staging server and then ran the migration.',
      tier: 'ax',
      verified: true,
    },
  },
  {
    // Two entries for one `HudView` kind, because `verified` selects between
    // two entirely different surfaces — a wordless check and a transcript pill
    // with four buttons (2026-08-09 incident). Previewing only the happy one
    // is how the silent-drop rendering would go unlooked-at again.
    id: 'preview.inserted_unconfirmed',
    label: 'Inserted (unconfirmed)',
    view: {
      kind: 'inserted',
      text: 'Deployed that on the staging server and then ran the migration.',
      tier: 'unicode',
      verified: null,
    },
  },
  {
    id: 'preview.not_inserted',
    label: 'Not inserted',
    view: {
      kind: 'not_inserted',
      text: 'Deployed that on the staging server and then ran the migration.',
      reason: 'insert_failed',
      detail: 'kAXErrorAttributeUnsupported',
    },
  },
  { id: 'preview.blocked', label: 'Blocked', view: { kind: 'blocked' } },
  {
    id: 'preview.error',
    label: 'Error',
    view: {
      kind: 'error',
      message: 'Your Grok token expired at 21:58.',
      hint: 'Run `grok` in a terminal to sign in again.',
    },
  },
  { id: 'preview.hidden', label: 'Hide', view: { kind: 'hidden' } },
];

export function buildTrayMenu(model: TrayModel): readonly TrayMenuItem[] {
  const { config } = model;

  const items: TrayMenuItem[] = [
    {
      id: 'status',
      label: trayStatusLabel(
        model.state,
        model.secureInput,
        model.hotkeyActive,
        model.accessibility,
      ),
      enabled: false,
    },
  ];

  // IMPLEMENTATION-PLAN.md §4, "errors carry actionable text": saying the
  // permission is missing is worth little without the door to fix it, which is
  // buried four levels into System Settings.
  if (!model.signedIn) {
    items.push({
      id: 'sign-in',
      label: 'Sign in…',
      action: { kind: 'sign-in' },
    });
  }

  if (!model.accessibility) {
    items.push({
      id: 'open-accessibility',
      label: 'Open Accessibility settings…',
      action: { kind: 'open-accessibility-settings' },
    });
  }

  items.push(
    { id: 'sep.status', type: 'separator' },
    {
      id: 'language',
      label: 'Language',
      type: 'submenu',
      submenu: [
        /**
         * Presented as a *preference*, not an override, on the evidence of
         * spike 3 (docs/spike-results.md; docs/phase-1-report.md §5.1):
         * English audio sent with `language=de` came back `"language":"en"`
         * with a correctly formatted English transcript. The parameter did not
         * steer recognition in any test that could be constructed, so a menu
         * item promising "force German" would be a lie.
         */
        {
          id: 'language.note',
          label: 'The server detects the language it hears.',
          enabled: false,
        },
        { id: 'language.sep', type: 'separator' },
        languageItem('auto', 'Automatic', config.languageMode),
        languageItem('de', 'Prefer Deutsch', config.languageMode),
        languageItem('en', 'Prefer English', config.languageMode),
      ],
    },
    {
      id: 'audioCues',
      label: 'Audio cues',
      type: 'checkbox',
      checked: config.audioCues,
      action: { kind: 'set-audio-cues', enabled: !config.audioCues },
    },
    { id: 'sep.settings', type: 'separator' },
    {
      id: 'open.history',
      label: model.historyCount === 0 ? 'History' : `History (${String(model.historyCount)})`,
      action: { kind: 'open', panel: 'history' },
    },
    {
      id: 'open.scratchpad',
      label: 'Scratchpad',
      action: { kind: 'open', panel: 'scratchpad' },
    },
    {
      id: 'open.settings',
      label: 'Settings…',
      action: { kind: 'open', panel: 'settings' },
    },
  );

  if (model.includePreview) {
    items.push(
      { id: 'sep.preview', type: 'separator' },
      {
        id: 'preview',
        label: `Preview HUD (after ${String(PREVIEW_DELAY_MS / 1000)}s)`,
        type: 'submenu',
        submenu: PREVIEW_VIEWS.map((preview) => ({
          id: preview.id,
          label: preview.label,
          action: {
            kind: 'preview-hud' as const,
            view: preview.view,
            // The delay is the point: it gives the user time to click into
            // another application before the pill appears, which is the only
            // way to test that showing it does not steal focus.
            delayMs: preview.view.kind === 'hidden' ? 0 : PREVIEW_DELAY_MS,
          },
        })),
      },
    );
  }

  items.push(
    { id: 'sep.quit', type: 'separator' },
    { id: 'quit', label: 'Quit Grok Dictate', action: { kind: 'quit' } },
  );

  return items;
}

function languageItem(mode: LanguageMode, label: string, current: LanguageMode): TrayMenuItem {
  return {
    id: `language.${mode}`,
    label,
    type: 'radio',
    checked: current === mode,
    action: { kind: 'set-language', mode },
  };
}

/** Every action reachable from the menu, flattened — used by the tests. */
export function flattenActions(items: readonly TrayMenuItem[]): TrayAction[] {
  const out: TrayAction[] = [];
  for (const item of items) {
    if (item.action !== undefined) out.push(item.action);
    if (item.submenu !== undefined) out.push(...flattenActions(item.submenu));
  }
  return out;
}
