/**
 * Detect a running menu-bar manager, and say so.
 *
 * ## Why this is here
 *
 * The tray icon is the **only** affordance a menu-bar app has, and it is the
 * only surface that can tell the user Secure Input is active — one of the two
 * silent failures  says "will make a working app look broken".
 * So when the icon itself is invisible, the product has no way to explain
 * anything at all.
 *
 * That is not hypothetical. Phase 4's HT-6 failed exactly this way: the item
 * could not be found on the test machine, three attempts, which blocked three
 * further tests. Every reproducible check said it should render — the image
 * decoded, the menu built, `getBounds()` reported a laid-out 22-point height —
 * and Phase 4 recorded "a menu-bar manager hiding new items" as the best
 * remaining explanation, untested. Phase 5 found `Hidden Bar.app` running on
 * the machine with `isAutoHide = 1` and `areSeparatorsHidden = 1`: it hides
 * newly added status items automatically, and hides its own separators too, so
 * there is not even a chevron to click.
 *
 * A log line would have turned three attempts and a round trip into one look at
 * the terminal. That is the whole justification for this file.
 *
 * ## Why `lsappinfo`
 *
 * Electron exposes no list of running applications, and the alternatives are
 * worse: `NSWorkspace.runningApplications` would mean routing a question
 * through the Swift helper for a diagnostic, and reading each manager's
 * preference domain would report apps that are installed but not running —
 * which is the wrong question. `lsappinfo` is already used by
 * `src/main/hud/focus.e2e.test.ts` for the same reason, and it needs no TCC
 * grant, unlike asking System Events through `osascript`.
 */

import { execFile } from 'node:child_process';
import type { Logger } from '@shared/logger.js';

export interface MenuBarManager {
  readonly bundleId: string;
  readonly name: string;
  /** What the user has to do to see a newly added status item. */
  readonly remedy: string;
}

/**
 * The managers that hide status items. All of them default to hiding items
 * they have not seen before, which is precisely the case that matters here.
 */
export const KNOWN_MENU_BAR_MANAGERS: readonly MenuBarManager[] = [
  {
    bundleId: 'com.dwarvesv.minimalbar',
    name: 'Hidden Bar',
    remedy:
      'quit Hidden Bar, or ⌘-drag the Grok Dictate icon to the right of its separator so it stays visible',
  },
  {
    bundleId: 'com.surteesstudios.Bartender',
    name: 'Bartender',
    remedy: 'open Bartender Settings → Menu Bar Items and set Grok Dictate to "Show in Menu Bar"',
  },
  {
    bundleId: 'com.jordanbaird.Ice',
    name: 'Ice',
    remedy: 'open Ice Settings → Menu Bar Layout and drag Grok Dictate into the visible section',
  },
  {
    bundleId: 'com.mortenjust.Dozer',
    name: 'Dozer',
    remedy: 'quit Dozer, or ⌘-drag the Grok Dictate icon to the right of its dot',
  },
  {
    bundleId: 'com.matthewpalmer.Vanilla',
    name: 'Vanilla',
    remedy: 'quit Vanilla, or ⌘-drag the Grok Dictate icon to the right of its arrow',
  },
];

/**
 * Parse `lsappinfo list` output for the managers above.
 *
 * Pure, so the parsing is a unit test rather than something that only runs on a
 * machine that happens to have one of these installed. `lsappinfo` prints a
 * paragraph per application; a bundle identifier appears as
 * `bundleID="com.example.thing"`, which is specific enough to match on directly
 * — the surrounding format has changed between macOS releases, that field has
 * not.
 */
export function detectMenuBarManagers(lsappinfoOutput: string): readonly MenuBarManager[] {
  return KNOWN_MENU_BAR_MANAGERS.filter((manager) =>
    lsappinfoOutput.includes(`bundleID="${manager.bundleId}"`),
  );
}

/**
 * Log a warning naming any manager that is running.
 *
 * Deliberately not an error and deliberately not a dialog: having one installed
 * is a legitimate choice, and most of the time the icon will be reachable
 * behind it. This exists so that when the icon *cannot* be found, the reason is
 * already in the log rather than something to go hunting for.
 */
export function warnAboutMenuBarManagers(logger: Logger): void {
  execFile('/usr/bin/lsappinfo', ['list'], { timeout: 3_000 }, (error, stdout) => {
    if (error !== null) {
      logger.debug('could not list running applications', { err: error });
      return;
    }
    for (const manager of detectMenuBarManagers(stdout)) {
      logger.warn(
        `${manager.name} is running — it hides newly added menu-bar items by default, ` +
          'which is the usual reason the Grok Dictate icon cannot be found',
        { remedy: manager.remedy },
      );
    }
  });
}
