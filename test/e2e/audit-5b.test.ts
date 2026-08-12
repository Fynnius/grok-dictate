/**
 * IMPLEMENTATION-PLAN.md §5b — the adversarial audit, as executable assertions.
 *
 * §5b lists eleven checks and says why they need a phase of their own: "each is
 * **silent** and none will surface in ordinary testing". This file holds the
 * ones that are only meaningful **across** the whole application — the two
 * containment properties (the clipboard, the token) and the absence of a
 * refresh path — because those are exactly the properties a single phase could
 * honour inside its own boundary while the product as a whole broke them.
 *
 * The per-behaviour checks stay where they are and are listed in
 * `docs/phase-5-review.md` with their homes; duplicating them here would give
 * two places to update and one to forget.
 *
 * Several assertions below are **source scans**. That is deliberate. A
 * behavioural test proves that the paths it drives do not write the clipboard;
 * a source scan proves that no path exists to drive. For a hard product
 * requirement — , "the clipboard is written **never**, not even
 * transiently" — the second is the one that survives a future edit by someone
 * who has not read .
 */

import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { globSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** Every hand-written source file in the application, tests excluded. */
function sourceFiles(options: { includeTests?: boolean } = {}): string[] {
  const patterns = [
    'src/**/*.ts',
    'src/**/*.tsx',
    'contracts/**/*.ts',
    'mocks/**/*.mjs',
    'mocks/**/*.ts',
    'scripts/**/*.ts',
    'native/Sources/**/*.swift',
  ];
  const files = patterns.flatMap((pattern) => globSync(pattern, { cwd: ROOT }));
  return files
    .filter((file) => options.includeTests === true || !/\.test\.tsx?$/.test(file))
    .map((file) => resolve(ROOT, file))
    .sort();
}

function read(file: string): string {
  return readFileSync(file, 'utf8');
}

/**
 * Strip comments before scanning.
 *
 * Every one of these properties is discussed at length in prose *in the files
 * that implement it*, so a scan that counted comments would match everywhere
 * and prove nothing. Crude but adequate: this only has to survive our own
 * commenting style, and a false negative shows up as a scan that finds no
 * occurrences at all, which the tests below also assert against.
 */
function code(file: string): string {
  return read(file)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/^\s*\/\/\/.*$/gm, ' ');
}

const rel = (file: string): string => relative(ROOT, file);

/* ------------------------------------------------------------------ *
 * §5b — "Clipboard is never written except on explicit user action —
 *        audit every path"
 * ------------------------------------------------------------------ */

describe('§5b — the clipboard is written only on an explicit user action', () => {
  /**
   * The chain, and the whole of it:
   *
   *   a click in the HUD / History / Scratchpad
   *     → `{type:'copy'}` on RENDERER_TO_MAIN_CHANNEL
   *     → `orchestrator.copyToClipboard`
   *     → `NativeHelperPort.copy`
   *     → `{"type":"copy"}` to the helper
   *     → `NSPasteboard`, in `native/Sources/grok-dictate-helper/SystemPasteboard.swift`
   *
   * Each assertion below pins one link. Break any of them and this fails.
   */

  it('has exactly one implementation of NativeHelperPort.copy', () => {
    const implementations = sourceFiles().filter((file) =>
      /^\s*copy\(text: string\): void \{/m.test(code(file)),
    );
    expect(implementations.map(rel)).toEqual(['src/main/native/helper-client.ts']);
  });

  it('reaches that implementation from exactly one place in the main process', () => {
    const callers = sourceFiles().filter((file) => /\bnative\.copy\(/.test(code(file)));
    expect(callers.map(rel)).toEqual(['src/main/state/orchestrator.ts']);
  });

  it('reaches the orchestrator from exactly one place, the `copy` IPC message', () => {
    const callers = sourceFiles().filter((file) => /copyToClipboard\(/.test(code(file)));
    // The definition and the single call site.
    expect(callers.map(rel).sort()).toEqual([
      'src/main/index.ts',
      'src/main/state/orchestrator.ts',
    ]);

    const root = code(resolve(ROOT, 'src/main/index.ts'));
    const matches = root.match(/copyToClipboard\(/g) ?? [];
    expect(matches).toHaveLength(1);
    // …and it sits under `case 'copy':`, not under any other message.
    expect(root).toMatch(/case 'copy':[\s\S]{0,200}?copyToClipboard\(message\.text\)/);
  });

  it('emits no clipboard effect from the state machine at all', () => {
    // The reducer enumerates every action the app can take on the outside
    // world (`Effect`).  is therefore structural rather than
    // behavioural: there is no effect a transition *could* emit that writes
    // the pasteboard, so no sequence of events can produce one.
    const machine = code(resolve(ROOT, 'src/main/state/machine.ts'));
    expect(machine).not.toMatch(/'copy'/);
    expect(machine).not.toMatch(/clipboard/i);
  });

  it('sends the `copy` helper command from exactly one place', () => {
    // The *helper command* — `{v:1,type:'copy'}` on the wire — as opposed to
    // the `{type:'copy'}` IPC message the renderers send when the user clicks,
    // which is the sanctioned entry point and appears in three views.
    const senders = sourceFiles().filter((file) => /v: 1,\s*type: 'copy'/.test(code(file)));
    expect(senders.map(rel)).toEqual(['src/main/native/helper-client.ts']);
  });

  it('touches NSPasteboard in exactly one Swift file, wired to the `copy` command', () => {
    // Also asserted inside the Swift package (`ClipboardContainmentTests`),
    // and repeated here so the property is checked by `npm test` as well —
    // a machine without Xcode still runs this one.
    const swift = sourceFiles().filter((file) => file.endsWith('.swift'));
    expect(swift.length).toBeGreaterThan(10);
    const touching = swift.filter((file) => /NSPasteboard/.test(code(file))).map(rel);
    expect(touching).toEqual(['native/Sources/grok-dictate-helper/SystemPasteboard.swift']);
  });

  it('offers no clipboard action anywhere in the tray menu', () => {
    // The menu is built as data precisely so this is assertable
    // (`src/main/tray/menu.test.ts` proves it over the built menu); here we
    // pin that no *new* action kind can quietly become a clipboard write.
    const menu = code(resolve(ROOT, 'src/main/tray/menu.ts'));
    expect(menu).not.toMatch(/copy/i);
  });
});

/* ------------------------------------------------------------------ *
 * §5b — "No token refresh path exists anywhere"
 * ------------------------------------------------------------------ */

describe('§5b — no token refresh path exists anywhere', () => {
  /**
   * , the highest-severity risk in the document: refreshing
   * without writing the rotated token back under `auth.json.lock` can silently
   * invalidate the user's Grok CLI login — and the failure surfaces later, in a
   * different program, so the causal link is easy to miss. §5.6 avoids it by
   * never refreshing at all.
   *
   * `src/main/auth/auth.test.ts` asserts this for the auth module. It is
   * asserted app-wide here because the risk is not "the auth module grows a
   * refresh"; it is "somebody adds one somewhere else because auth did not
   * have it".
   */
  const FORBIDDEN = [
    /grant_type/,
    /refresh_token/,
    /oauth2\/token/,
    /\brefreshToken\b/,
    /\brefreshBearer\b/,
  ];

  /**
   * Three files name these strings in order to *forbid* or *redact* them, and
   * are the reason the property holds rather than a violation of it. Anything
   * else matching is a real finding.
   */
  const ALLOWED = [
    'test/e2e/audit-5b.test.ts',
    // A source-level tripwire inside the auth module itself.
    'src/main/auth/auth.test.ts',
    // The redaction layer exists to recognise `refresh_token` as a secret key
    //.
    'src/shared/redact.test.ts',
  ];

  it('mentions no OAuth refresh grant in any source file', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles({ includeTests: true })) {
      if (ALLOWED.includes(rel(file))) continue;
      const body = code(file);
      for (const pattern of FORBIDDEN) {
        if (pattern.test(body)) offenders.push(`${rel(file)} matches ${String(pattern)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('has the scan pointed at real files rather than quietly matching nothing', () => {
    // A source scan that finds no files is a scan that always passes.
    const files = sourceFiles({ includeTests: true });
    expect(files.length).toBeGreaterThan(60);
    expect(files.some((f) => rel(f) === 'src/main/auth/index.ts')).toBe(true);
  });

  it('never writes to the credential store', () => {
    const offenders = sourceFiles()
      .filter((file) => /writeFile|writeFileSync|renameSync/.test(code(file)))
      .filter((file) => /auth\.json/.test(code(file)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

/* ------------------------------------------------------------------ *
 * §5b — "Token never reaches a log, a crash report, the history file,
 *        or an error message"
 * ------------------------------------------------------------------ */

describe('§5b — the bearer token cannot leave the auth module except as a header', () => {
  /**
   * `src/shared/redact.test.ts` proves the redactor holds against the user's
   * *real* 838-character token, including through `toJSON`. That is the
   * backstop. This is the upstream half: the token should not be handed to
   * anything that could log it in the first place.
   */

  it('reads `bearer.token` in exactly one place in the app, the Authorization header', () => {
    const readers = sourceFiles()
      .filter((file) => /\bbearer\.token\b/.test(code(file)))
      .map(rel);
    // `scripts/probe-stt.ts` is the Phase 1 spike tool, not part of the app; it
    // reads the same credential and is checked below rather than exempted.
    expect(readers).toEqual(['scripts/probe-stt.ts', 'src/main/stt/client.ts']);

    const client = code(resolve(ROOT, 'src/main/stt/client.ts'));
    expect(client.match(/bearer\.token/g) ?? []).toHaveLength(1);
    expect(client).toMatch(/Authorization: `Bearer \$\{bearer\.token\}`/);
  });

  it('keeps the spike script to a header too', () => {
    const probe = code(resolve(ROOT, 'scripts/probe-stt.ts'));
    expect(probe.match(/bearer\.token/g) ?? []).toHaveLength(1);
    expect(probe).toMatch(/Authorization: `Bearer \$\{bearer\.token\}`/);
  });

  it('builds the connect URL from data that cannot contain a credential', () => {
    // `client.ts` logs the URL at info, so this is the difference between a
    // clean log line and the whole subscription in a text file. The guarantee
    // is structural: the URL builder is handed `SttTurnOptions`, which has no
    // credential field, and never sees a `Bearer`.
    const url = code(resolve(ROOT, 'src/main/stt/url.ts'));
    expect(url).not.toMatch(/\bBearer\b|bearer\.|AuthPort|getBearer/);

    const ports = read(resolve(ROOT, 'contracts/ports.ts'));
    const options = /export interface SttTurnOptions \{([\s\S]*?)\n\}/.exec(ports)?.[1] ?? '';
    expect(options.length).toBeGreaterThan(0);
    expect(options).not.toMatch(/token|bearer|authorization|secret/i);
  });

  it('has no field on a history row that could carry a credential', () => {
    //  names the history file as one of the four sinks. The row
    // shape is the guarantee: transcript, timing, target app, outcome.
    const events = read(resolve(ROOT, 'contracts/events.ts'));
    const entry = /export interface HistoryEntry \{([\s\S]*?)\n\}/.exec(events)?.[1] ?? '';
    expect(entry.length).toBeGreaterThan(0);
    const fields = [...entry.matchAll(/^\s*readonly (\w+)/gm)].map((m) => m[1]);
    expect(fields).toEqual([
      'id',
      'at',
      'text',
      'durationSec',
      'language',
      'frontmostBundleId',
      'frontmostName',
      'tier',
      'inserted',
    ]);
  });

  it('never sends the token to the helper process', () => {
    // The helper is a separate process with its own stdout, which the
    // supervisor logs verbatim at warn. Nothing in the app→helper union has
    // anywhere to put a credential.
    const protocol = read(resolve(ROOT, 'contracts/helper-protocol.ts'));
    const appToHelper = /App → Helper([\s\S]*?)Framing/.exec(protocol)?.[1] ?? '';
    expect(appToHelper.length).toBeGreaterThan(0);
    expect(appToHelper).not.toMatch(/token|bearer|authorization|secret|credential/i);
  });
});
