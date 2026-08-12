/**
 * OWNER: **Phase 4**. The menu-bar item.
 *
 * Surfacing Secure Input here is not cosmetic —  and §12.2:
 * while it is active no third-party process can install a `CGEventTap`, so the
 * hotkey is dead system-wide with **no error, no log and no crash**. The icon
 * is the only thing in the product that can tell the user why nothing happens
 * when they hold `Fn`. That is why `trayIconFor` lets Secure Input outrank
 * every session state.
 *
 * Phase 4 also had to use `createTray` as its entry point into the then-frozen
 * composition root, starting `src/main/ui/` from here as a side effect. Phase 5
 * wires those explicitly, so this module is once again only the menu-bar item.
 */

import { app, Menu, nativeImage, shell, Tray, type MenuItemConstructorOptions } from 'electron';
import type { HudView, SessionState } from '@contracts/events.js';
import type { ConfigPort, HelperPermissions, TrayPort } from '@contracts/ports.js';
import type { Logger } from '@shared/logger.js';
import type { HistoryStore } from '../history/index.js';
import type { PanelName } from '../ui/panel-target.js';
import { TRAY_ICON_PNG_BASE64, trayIconDataUrl, type TrayIconName } from './icons.js';
import { warnAboutMenuBarManagers } from './menu-bar-managers.js';
import {
  buildTrayMenu,
  flattenActions,
  trayIconFor,
  trayStatusLabel,
  type TrayAction,
  type TrayMenuItem,
} from './menu.js';

/**
 * Built once and cached: `nativeImage` decoding on every state change would run
 * on the same thread that has to keep the pill responsive during a dictation.
 */
const iconCache = new Map<TrayIconName, Electron.NativeImage>();

function trayIcon(name: TrayIconName): Electron.NativeImage {
  const cached = iconCache.get(name);
  if (cached !== undefined) return cached;

  const png = TRAY_ICON_PNG_BASE64[name];
  const image = nativeImage.createFromDataURL(trayIconDataUrl(png.x1));
  // The @2x representation has to be added explicitly; `createFromDataURL`
  // produces a single 1x representation, which would look soft on a Retina
  // display.
  image.addRepresentation({ scaleFactor: 2, dataURL: trayIconDataUrl(png.x2) });
  // Template images are recoloured by macOS for the light and dark menu bar and
  // inverted while the menu is open. Without this they render as black
  // rectangles on a dark menu bar.
  image.setTemplateImage(true);

  iconCache.set(name, image);
  return image;
}

export interface TrayDeps {
  readonly logger: Logger;
  /** Reports whether the hotkey is actually alive; see `TrayModel`. */
  readonly onPermissions: (listener: (permissions: HelperPermissions) => void) => () => void;
  readonly config: ConfigPort;
  readonly history: HistoryStore;
  readonly openPanel: (panel: PanelName) => Promise<unknown>;
  /** Development-only *Preview HUD* submenu. */
  readonly previewHud: (view: HudView, delayMs: number) => void;
  readonly getSignedIn: () => boolean;
  readonly onAuthChange: (listener: () => void) => () => void;
  readonly openSignIn: () => Promise<unknown>;
}

export function createTray(deps: TrayDeps): TrayPort {
  const { config, history, logger } = deps;
  const log = logger.child('tray');

  /**
   * The *Preview HUD* submenu is a development tool and now stays one: it was
   * hardcoded on and shipping in packaged builds (overhaul §7.2). It is gated
   * rather than deleted because choosing a delayed preview and then clicking
   * into a text editor is still the cheapest way to re-run the focus test
   * (HT-1) — see the header of `src/main/hud/preview.ts`.
   */
  const includePreview = !app.isPackaged;

  let tray: Tray | null = null;
  let state: SessionState = 'idle';
  let secureInput = false;
  let historyCount = 0;
  // Optimistic until the helper says otherwise, so a healthy launch never
  // flashes a warning. `HelperClient` replays its last `permissions` report to
  // a late subscriber, so this is corrected within a second of start-up.
  let permissions: HelperPermissions = { accessibility: true, hotkeyActive: true };

  function runAction(action: TrayAction): void {
    switch (action.kind) {
      case 'set-language':
        void config.set({ ...config.get(), languageMode: action.mode });
        return;
      case 'set-audio-cues':
        void config.set({ ...config.get(), audioCues: action.enabled });
        return;
      case 'open':
        void deps.openPanel(action.panel).catch((cause: unknown) => {
          log.error('could not open a panel', { panel: action.panel, err: cause });
        });
        return;
      case 'sign-in':
        void deps.openSignIn().catch((cause: unknown) => {
          log.error('could not open the sign-in window', { err: cause });
        });
        return;
      case 'preview-hud':
        deps.previewHud(action.view, action.delayMs);
        return;
      case 'open-accessibility-settings':
        // The pane is four levels into System Settings; the URL scheme is the
        // documented way to land on it directly.
        void shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
        );
        return;
      case 'quit':
        app.quit();
        return;
    }
  }

  function toElectron(items: readonly TrayMenuItem[]): MenuItemConstructorOptions[] {
    return items.map((item) => {
      const action = item.action;
      return {
        ...(item.label === undefined ? {} : { label: item.label }),
        ...(item.type === undefined ? {} : { type: item.type }),
        ...(item.enabled === undefined ? {} : { enabled: item.enabled }),
        ...(item.checked === undefined ? {} : { checked: item.checked }),
        ...(item.submenu === undefined ? {} : { submenu: toElectron(item.submenu) }),
        ...(action === undefined
          ? {}
          : {
              click: () => {
                runAction(action);
              },
            }),
      };
    });
  }

  function render(): void {
    if (tray === null || tray.isDestroyed()) return;
    const template = buildTrayMenu({
      state,
      secureInput,
      config: config.get(),
      historyCount,
      includePreview,
      hotkeyActive: permissions.hotkeyActive,
      accessibility: permissions.accessibility,
      signedIn: deps.getSignedIn(),
    });
    tray.setImage(trayIcon(trayIconFor(state, secureInput, permissions.hotkeyActive)));
    tray.setToolTip(
      `Grok Dictate — ${trayStatusLabel(state, secureInput, permissions.hotkeyActive, permissions.accessibility)}`,
    );
    tray.setContextMenu(Menu.buildFromTemplate(toElectron(template)));

    /**
     * A label beside the icon, always.
     *
     * A menu-bar-only app has exactly one affordance, and a 16px monochrome
     * glyph among a dozen other 16px monochrome glyphs is genuinely hard to
     * pick out. Phase 4 wrote this as development-only on the theory that "in a
     * packaged build the icon stands alone as intended" — but the icon could
     * not be found at all across two phases of testing, and the word is what
     * makes it unmistakable now that it renders. The pixels are worth it.
     */
    tray.setTitle(' Dictate');
  }

  deps.onAuthChange(() => {
    render();
  });

  void app.whenReady().then(async () => {
    tray = new Tray(trayIcon('idle'));
    // A menu-bar app with no dock icon has no other way to be reached.
    tray.setIgnoreDoubleClickEvents(true);

    deps.onPermissions((next) => {
      if (
        next.accessibility === permissions.accessibility &&
        next.hotkeyActive === permissions.hotkeyActive
      ) {
        return;
      }
      permissions = next;
      log.info('helper permissions', { ...next });
      render();
    });

    historyCount = await history.count();
    history.onChange((count) => {
      historyCount = count;
      render();
    });
    config.onChange(() => {
      render();
    });

    render();
    // If the icon turns out to be invisible, the reason should already be in
    // the log — see the header of `menu-bar-managers.ts`.
    warnAboutMenuBarManagers(log);
    log.info('tray ready', {
      // Proof the clipboard is unreachable from the menu.
      actions: flattenActions(
        buildTrayMenu({
          state,
          secureInput,
          config: config.get(),
          historyCount,
          includePreview,
          hotkeyActive: permissions.hotkeyActive,
          accessibility: permissions.accessibility,
          signedIn: deps.getSignedIn(),
        }),
      ).map((a) => a.kind),
    });

    /**
     * Bounds, read late on purpose.
     *
     * `getBounds()` returns `height: 0` until macOS has laid the status item
     * out, so reading it immediately after construction reports a broken item
     * that is in fact fine — measured against a probe that built six different
     * tray variants, all of which read `height: 0` synchronously and
     * `height: 22` after a beat. Note also that `x`/`y` are not trustworthy on
     * this macOS: every variant, including a plainly visible title-only tray,
     * reported `x: 0, y: <display height>`. Height is the only field worth
     * believing here.
     */
    setTimeout(() => {
      if (tray !== null && !tray.isDestroyed()) {
        log.info('tray placed', { bounds: tray.getBounds() });
      }
    }, 500).unref?.();
  });

  app.on('before-quit', () => {
    tray?.destroy();
    tray = null;
  });

  return {
    setState(next: SessionState, nextSecureInput: boolean): void {
      if (next === state && nextSecureInput === secureInput) return;
      state = next;
      secureInput = nextSecureInput;
      log.debug('tray state', { state, secureInput });
      render();
    },
  };
}
