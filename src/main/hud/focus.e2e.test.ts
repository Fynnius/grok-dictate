/**
 * "The HUD never steals focus", tested against a real window server.
 *
 * IMPLEMENTATION-PLAN.md §3.4: "Write an automated test that asserts the
 * frontmost application is unchanged after the HUD shows."  is
 * the why — if the pill takes focus, the frontmost app changes and the
 * transcript is typed into the wrong process.
 *
 * `flags.test.ts` asserts the flag set. This asserts the *behaviour*, which
 * needs a real Electron process, a real window server and a logged-in GUI
 * session — so it is **opt-in**:
 *
 *     GROK_HUD_FOCUS_TEST=1 npx vitest run src/main/hud/focus.e2e.test.ts
 *
 * It is skipped in a plain `npm test` run, because a headless or SSH session
 * would fail it for reasons that have nothing to do with the HUD.
 *
 * The probe is written to a temp directory at run time rather than kept as a
 * file in the repo: it has to be plain JavaScript executed by the Electron
 * binary, and a stray `.mjs` under `src/main/` would sit outside every tsconfig
 * and break `npm run lint`.
 *
 * It is handed **both** halves of the real configuration — `HUD_WINDOW_OPTIONS`
 * as JSON, and the calls `applyHudWindowFlags` actually makes, recorded against
 * a stand-in and replayed on the real window. The first version of this test
 * hardcoded those three calls, and a mutation run proved the point: flipping
 * `focusable` to `true` in `flags.ts` still passed, because the probe was
 * applying its own copy of `setFocusable(false)` rather than the shipping one.
 * Recording and replaying closes that hole — delete a flag from `flags.ts` and
 * the probe stops making the call.
 *
 * ## What the mutation run actually showed — read this before trusting one line
 *
 * With `focusable: true` **and** `setFocusable(false)` deleted from
 * `flags.ts`, the frontmost-application assertions still passed; only
 * `isFocusable` failed. `showInactive()` does not activate an application even
 * when its window is focusable, and in a dock-hidden (`LSUIElement`) process a
 * subsequent `window.focus()` did not activate it either.
 *
 * So the assertions are not interchangeable, and the frontmost check alone is
 * not the strong one:
 *
 *   - `isFocusable` / `getFocusedWindow()` are what catch a lost flag.
 *   - the frontmost check is what proves the end-user-visible property, and it
 *     is the one that would catch a future change to `show()` instead of
 *     `showInactive()`, or a lost `app.dock.hide()`.
 *
 * All of them are kept for that reason. Recorded in docs/phase-4-report.md so
 * Phase 5's §5b audit does not over-read a green line here.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { applyHudWindowFlags, HUD_WINDOW_OPTIONS, type HudFlagTarget } from './flags.js';

/** Every call `applyHudWindowFlags` makes, as replayable data. */
type FlagCall = [method: string, args: unknown[]];

function recordFlagCalls(): FlagCall[] {
  const calls: FlagCall[] = [];
  const recorder: HudFlagTarget = {
    setAlwaysOnTop(flag, level) {
      calls.push(['setAlwaysOnTop', level === undefined ? [flag] : [flag, level]]);
    },
    setVisibleOnAllWorkspaces(visible, options) {
      calls.push([
        'setVisibleOnAllWorkspaces',
        options === undefined ? [visible] : [visible, options],
      ]);
    },
    setFocusable(focusable) {
      calls.push(['setFocusable', [focusable]]);
    },
  };
  applyHudWindowFlags(recorder);
  return calls;
}

const ENABLED = process.env['GROK_HUD_FOCUS_TEST'] === '1';

/**
 * Who macOS thinks is frontmost. The **ASN** is the identity that matters: it
 * is unique per running instance, so it distinguishes the probe from another
 * Electron app that happens to be frontmost — which a name-based check cannot,
 * since both would read "Electron".
 */
interface Frontmost {
  asn: string;
  name: string;
  pid: number;
}

interface ProbeResult {
  /** Frontmost application before the pill was shown. */
  before: Frontmost;
  /** …and after `showInactive()`. These must be the same app. */
  afterShow: Frontmost;
  /** …and after a deliberate, errant `window.focus()`. */
  afterFocusCall: Frontmost;
  isFocusable: boolean;
  isAlwaysOnTop: boolean;
  isVisible: boolean;
  /** `BrowserWindow.getFocusedWindow()` — must stay null throughout. */
  focusedWindowAfterShow: string | null;
  focusedWindowAfterFocusCall: string | null;
  /** The probe's own pid, so the test can tell whether *it* was frontmost. */
  selfPid: number;
}

const PROBE = String.raw`
const { app, BrowserWindow } = require('electron');
const { execFileSync } = require('node:child_process');

const { options, flagCalls } = JSON.parse(process.argv[2]);

/**
 * Ask LaunchServices which application is frontmost.
 *
 * lsappinfo rather than osascript: reading this through System Events needs an
 * Automation (TCC) grant for whichever terminal runs the test, so it can prompt
 * or silently fail on a machine that has not granted it. lsappinfo needs
 * nothing, and its ASN identifies the exact running instance.
 */
function frontmost() {
  try {
    const asn = execFileSync('lsappinfo', ['front']).toString().trim();
    const info = execFileSync('lsappinfo', ['info', '-only', 'name,pid', asn]).toString();
    const name = /"LSDisplayName"="([^"]*)"/.exec(info);
    const pid = /"pid"=(\d+)/.exec(info);
    return {
      asn,
      name: name === null ? '(unknown)' : name[1],
      pid: pid === null ? -1 : Number(pid[1]),
    };
  } catch (cause) {
    return { asn: 'lsappinfo-failed', name: String(cause && cause.message), pid: -1 };
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.whenReady().then(async () => {
  // Menu-bar app: no dock icon, so launching must not activate us.
  if (app.dock) app.dock.hide();
  await sleep(900);

  const before = frontmost();

  const window = new BrowserWindow(options);
  // Replay exactly what applyHudWindowFlags does — not a copy of it.
  for (const [method, args] of flagCalls) window[method](...args);
  await window.loadURL(
    'data:text/html,<body style="margin:0;background:rgba(28,28,30,.9)"><p style="color:#fff;font:13px system-ui;padding:16px">Grok Dictate focus probe</p></body>',
  );

  window.showInactive();
  await sleep(900);
  const afterShow = frontmost();
  const focusedAfterShow = BrowserWindow.getFocusedWindow();

  // Belt and braces: even an errant focus() must not make it key, because
  // setFocusable(false) is what stands between a restyle and a silent bug.
  window.focus();
  await sleep(900);
  const afterFocusCall = frontmost();
  const focusedAfterFocusCall = BrowserWindow.getFocusedWindow();

  const result = {
    before,
    afterShow,
    afterFocusCall,
    isFocusable: window.isFocusable(),
    isAlwaysOnTop: window.isAlwaysOnTop(),
    isVisible: window.isVisible(),
    focusedWindowAfterShow: focusedAfterShow === null ? null : String(focusedAfterShow.id),
    focusedWindowAfterFocusCall:
      focusedAfterFocusCall === null ? null : String(focusedAfterFocusCall.id),
    selfPid: process.pid,
  };

  process.stdout.write('__PROBE__' + JSON.stringify(result) + '__PROBE__');
  window.destroy();
  app.exit(0);
});
`;

function runProbe(): ProbeResult {
  const require = createRequire(import.meta.url);
  const electronBinary = require('electron') as unknown;
  if (typeof electronBinary !== 'string') {
    throw new Error('the electron package did not resolve to a binary path');
  }

  const dir = mkdtempSync(join(tmpdir(), 'grok-dictate-focus-'));
  try {
    const script = join(dir, 'probe.cjs');
    writeFileSync(script, PROBE, 'utf8');
    const payload = JSON.stringify({
      options: HUD_WINDOW_OPTIONS,
      flagCalls: recordFlagCalls(),
    });
    const stdout = execFileSync(electronBinary, [script, payload], {
      encoding: 'utf8',
      timeout: 60_000,
      env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0' },
    });
    const match = /__PROBE__(.*)__PROBE__/s.exec(stdout);
    if (match?.[1] === undefined) {
      throw new Error(`the probe produced no result. stdout was:\n${stdout}`);
    }
    return JSON.parse(match[1]) as ProbeResult;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe.skipIf(!ENABLED)('the HUD window, against a real window server', () => {
  it('does not change the frontmost application when it appears', () => {
    const result = runProbe();

    // If the probe process were already frontmost, `before === afterShow`
    // would hold for entirely the wrong reason. Check that first, so a
    // meaningless pass is impossible.
    expect(result.before.pid).not.toBe(result.selfPid);
    expect(result.before.asn).not.toBe('lsappinfo-failed');

    // The single most important assertion in the project
    // (IMPLEMENTATION-PLAN.md §3.4): showing the pill left the frontmost
    // application exactly where it was.
    expect(result.afterShow.asn).toBe(result.before.asn);

    // …and it survives something calling focus() on it, which is the failure
    // a restyle could reintroduce.
    expect(result.afterFocusCall.asn).toBe(result.before.asn);

    // The pill must never be the key window, at any point.
    expect(result.focusedWindowAfterShow).toBeNull();
    expect(result.focusedWindowAfterFocusCall).toBeNull();

    // The flags survived construction rather than being silently dropped.
    expect(result.isFocusable).toBe(false);
    expect(result.isAlwaysOnTop).toBe(true);
    expect(result.isVisible).toBe(true);
  }, 120_000);
});
