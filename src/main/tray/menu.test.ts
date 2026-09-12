import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '@contracts/config.js';
import { SESSION_STATES, type SessionState } from '@contracts/events.js';
import {
  buildTrayMenu,
  flattenActions,
  HISTORY_LABEL_MAX,
  truncateHistoryLabel,
  trayIconFor,
  trayStatusLabel,
  type TrayHistoryRow,
  type TrayModel,
} from './menu.js';

function row(overrides: Partial<TrayHistoryRow> = {}): TrayHistoryRow {
  return {
    id: 'a',
    text: 'hello there',
    at: '2026-09-12T00:00:00.000Z',
    ...overrides,
  };
}

function model(overrides: Partial<TrayModel> = {}): TrayModel {
  return {
    state: 'idle',
    secureInput: false,
    config: DEFAULT_CONFIG,
    recentHistory: [],
    includePreview: false,
    hotkeyActive: true,
    accessibility: true,
    signedIn: true,
    ...overrides,
  };
}

const ids = (items: readonly { id: string }[]): string[] => items.map((i) => i.id);

describe('trayIconFor', () => {
  it('shows the recording icon only while recording', () => {
    expect(trayIconFor('recording', false)).toBe('recording');
    expect(trayIconFor('idle', false)).toBe('idle');
    expect(trayIconFor('processing', false)).toBe('idle');
    expect(trayIconFor('inserting', false)).toBe('idle');
  });

  it('lets Secure Input outrank every other state', () => {
    // This is the whole reason the icon has a third state: the hotkey is dead
    // system-wide and nothing else in the app can say so.
    for (const state of SESSION_STATES) expect(trayIconFor(state, true)).toBe('blocked');
    expect(trayIconFor('blocked', false)).toBe('blocked');
  });

  it('has an icon for every session state', () => {
    for (const state of SESSION_STATES) {
      expect(['idle', 'recording', 'blocked']).toContain(trayIconFor(state, false));
    }
  });
});

describe('trayStatusLabel', () => {
  it('names Secure Input rather than saying nothing', () => {
    expect(trayStatusLabel('idle', true)).toMatch(/Secure Input/);
    expect(trayStatusLabel('blocked', false)).toMatch(/Secure Input/);
  });

  it('has a distinct label for every state', () => {
    const labels = new Set(
      (SESSION_STATES as readonly SessionState[]).map((s) => trayStatusLabel(s, false)),
    );
    expect(labels.size).toBe(SESSION_STATES.length);
  });

  it('says the same thing whether `blocked` arrives as a state or as a flag', () => {
    // The two routes into the blocked condition must not read differently: the
    // machine can be in `inserting` with `secureInput` already true
    // (state-machine.md §8), and the user should see one explanation, not two.
    expect(trayStatusLabel('idle', true)).toBe(trayStatusLabel('blocked', false));
  });
});

describe('buildTrayMenu', () => {
  it('offers history, stats, settings and quit', () => {
    const items = ids(buildTrayMenu(model()));
    expect(items).toContain('open.history');
    expect(items).toContain('open.stats');
    expect(items).toContain('open.settings');
    expect(items).toContain('quit');
    expect(items).not.toContain('open.scratchpad');
    expect(items).not.toContain('audioCues');
  });

  it('offers Sign in only when nobody is signed in', () => {
    expect(ids(buildTrayMenu(model({ signedIn: true })))).not.toContain('sign-in');
    expect(ids(buildTrayMenu(model({ signedIn: false })))).toContain('sign-in');
  });

  it('leads with the session status, disabled', () => {
    const [first] = buildTrayMenu(model({ state: 'recording' }));
    expect(first?.id).toBe('status');
    expect(first?.enabled).toBe(false);
    expect(first?.label).toBe('Listening…');
  });

  it('checks the language mode currently in force', () => {
    const menu = buildTrayMenu(model({ config: { ...DEFAULT_CONFIG, languageMode: 'de' } }));
    const language = menu.find((i) => i.id === 'language')?.submenu ?? [];
    expect(language.find((i) => i.id === 'language.de')?.checked).toBe(true);
    expect(language.find((i) => i.id === 'language.auto')?.checked).toBe(false);
    expect(
      language.every((i) => i.type === 'radio' || i.enabled === false || i.id.endsWith('sep')),
    ).toBe(true);
  });

  it('presents language as a preference, not an override (spike 3)', () => {
    // docs/phase-1-report.md §5.1: English audio sent with `language=de` came
    // back English. A menu item promising "Force German" would be a lie, so the
    // wording must not promise one.
    const language = buildTrayMenu(model()).find((i) => i.id === 'language')?.submenu ?? [];
    const labels = language.map((i) => i.label ?? '').join(' ');
    expect(labels).not.toMatch(/force/i);
    expect(labels).toMatch(/Prefer Deutsch/);
    expect(language.find((i) => i.id === 'language.note')?.enabled).toBe(false);
  });

  it('does not put audio cues on the menu', () => {
    const actions = flattenActions(buildTrayMenu(model()));
    expect(actions.map((a) => a.kind)).not.toContain('set-audio-cues');
    expect(ids(buildTrayMenu(model()))).not.toContain('audioCues');
  });

  it('opens History on a direct click, and nests copies under Recent', () => {
    const menu = buildTrayMenu(
      model({
        recentHistory: [
          row({ id: 'newest', text: 'just said this' }),
          row({ id: 'older', text: 'said that earlier' }),
        ],
      }),
    );
    const history = menu.find((i) => i.id === 'open.history');
    expect(history?.type).not.toBe('submenu');
    expect(history?.action).toEqual({ kind: 'open', panel: 'history' });
    const recent = menu.find((i) => i.id === 'history.recent');
    expect(recent?.type).toBe('submenu');
    const submenu = recent?.submenu ?? [];
    expect(submenu.map((i) => i.id)).toEqual(['history.row.newest', 'history.row.older']);
    expect(submenu[0]?.label).toBe('just said this');
    expect(submenu[0]?.action).toEqual({ kind: 'copy-history', id: 'newest' });
  });

  it('omits Recent when nothing has been dictated', () => {
    const menu = buildTrayMenu(model());
    expect(menu.find((i) => i.id === 'open.history')?.action).toEqual({
      kind: 'open',
      panel: 'history',
    });
    expect(ids(menu)).not.toContain('history.recent');
    expect(ids(menu)).not.toContain('history.empty');
  });

  it('caps Recent at five rows and truncates long labels', () => {
    const long =
      'Deployed that on the staging server and then ran the migration because the pod would otherwise restart';
    const recentHistory = Array.from({ length: 7 }, (_, i) =>
      row({ id: `r${String(i)}`, text: i === 0 ? long : `row ${String(i)}` }),
    );
    const submenu =
      buildTrayMenu(model({ recentHistory })).find((i) => i.id === 'history.recent')?.submenu ?? [];
    expect(submenu).toHaveLength(5);
    expect(submenu[0]?.label).toBe(truncateHistoryLabel(long));
    expect(submenu[0]?.label?.length).toBeLessThanOrEqual(HISTORY_LABEL_MAX);
    expect(submenu[0]?.label?.endsWith('…')).toBe(true);
  });

  it('includes the HUD preview submenu only when asked', () => {
    expect(ids(buildTrayMenu(model()))).not.toContain('preview');
    const dev = buildTrayMenu(model({ includePreview: true }));
    expect(ids(dev)).toContain('preview');
    const previews = dev.find((i) => i.id === 'preview')?.submenu ?? [];
    // Every HUD state must be previewable — that is how "all HUD states render"
    // gets confirmed by a human (IMPLEMENTATION-PLAN.md §3.4). `inserted` is
    // listed twice (`verified` true / null) even though both now draw the
    // same check, so the data path is still inspectable.
    expect(previews).toHaveLength(12);
  });

  it('delays every preview except Hide, so focus can be moved to another app first', () => {
    const previews = buildTrayMenu(model({ includePreview: true })).find(
      (i) => i.id === 'preview',
    )?.submenu;
    for (const item of previews ?? []) {
      const action = item.action;
      if (action?.kind !== 'preview-hud') throw new Error('expected a preview action');
      if (action.view.kind === 'hidden') expect(action.delayMs).toBe(0);
      else expect(action.delayMs).toBeGreaterThanOrEqual(3_000);
    }
  });

  it('the only clipboard action is copy-history, carrying an id not the text', () => {
    // A Recent-submenu click is an explicit copy. Every other tray item must
    // still leave the pasteboard alone — including Preview HUD.
    const recentHistory = [row({ id: 'keep-me', text: 'secret transcript' })];
    for (const includePreview of [false, true]) {
      for (const state of SESSION_STATES) {
        const actions = flattenActions(
          buildTrayMenu(model({ state, includePreview, recentHistory })),
        );
        expect(actions.map((a) => a.kind)).not.toContain('copy');
        const copies = actions.filter((a) => a.kind === 'copy-history');
        expect(copies).toEqual([{ kind: 'copy-history', id: 'keep-me' }]);
        for (const action of actions) {
          expect(JSON.stringify(action)).not.toMatch(/clipboard|pasteboard/i);
          if (action.kind === 'copy-history') {
            expect(JSON.stringify(action)).not.toContain('secret transcript');
          }
        }
      }
    }
  });

  it('builds for every session state without throwing, with or without Secure Input', () => {
    for (const state of SESSION_STATES) {
      for (const secureInput of [false, true]) {
        expect(() => buildTrayMenu(model({ state, secureInput }))).not.toThrow();
      }
    }
  });

  it('gives every item a unique id', () => {
    const all = buildTrayMenu(model({ includePreview: true }));
    const collect = (
      items: readonly { id: string; submenu?: readonly { id: string }[] }[],
    ): string[] => items.flatMap((i) => [i.id, ...collect(i.submenu ?? [])]);
    const found = collect(all);
    expect(new Set(found).size).toBe(found.length);
  });
});

describe('the tray tells the truth about a dead hotkey', () => {
  /**
   * The bug this closes: the menu said "Ready" while the event tap had failed
   * to install and Fn did nothing. That is the state a packaged build starts
   * in — a packaged `.app` is its own TCC identity, so Accessibility begins
   * ungranted (docs/phase-2-report.md §4, HT-1) — and the user hit it on the
   * first launch. , in the one surface built to prevent it.
   */
  it('does not say Ready when the tap is not installed', () => {
    expect(trayStatusLabel('idle', false, false, false)).toBe(
      '⚠️ Accessibility permission is needed',
    );
    expect(trayIconFor('idle', false, false)).toBe('blocked');
  });

  it('distinguishes a missing grant from a granted-but-dead tap', () => {
    // Different sentences because they need different actions: one is a trip
    // to System Settings, the other is not.
    expect(trayStatusLabel('idle', false, false, true)).toBe('⚠️ The Fn key is not being detected');
  });

  it('lets Secure Input speak when the tap is down because of it', () => {
    // Secure Input tears the tap down system-wide (§4.6), so `hotkeyActive` is
    // false at the same time — and "a password field has focus" is the useful
    // sentence, not "permission is needed".
    expect(trayStatusLabel('idle', true, false, true)).toBe('Blocked — Secure Input is active');
  });

  it('offers the door to System Settings only when the grant is what is missing', () => {
    const missing = flattenActions(buildTrayMenu(model({ accessibility: false })));
    expect(missing.map((a) => a.kind)).toContain('open-accessibility-settings');

    const fine = flattenActions(buildTrayMenu(model()));
    expect(fine.map((a) => a.kind)).not.toContain('open-accessibility-settings');
  });

  it('still writes no clipboard except copy-history, whatever the permission state', () => {
    // A new action kind is exactly how that could regress.
    for (const accessibility of [true, false]) {
      const actions = flattenActions(
        buildTrayMenu(model({ accessibility, recentHistory: [row({ id: 'x' })] })),
      );
      expect(actions.map((a) => a.kind)).not.toContain('copy');
      expect(actions.filter((a) => a.kind === 'copy-history')).toEqual([
        { kind: 'copy-history', id: 'x' },
      ]);
    }
  });
});

describe('truncateHistoryLabel', () => {
  it('collapses whitespace and ellipsises past the cap', () => {
    expect(truncateHistoryLabel('  hello   there  ')).toBe('hello there');
    expect(truncateHistoryLabel('')).toBe('…');
    const long = 'a'.repeat(HISTORY_LABEL_MAX + 8);
    const shown = truncateHistoryLabel(long);
    expect(shown.length).toBe(HISTORY_LABEL_MAX);
    expect(shown.endsWith('…')).toBe(true);
  });
});
