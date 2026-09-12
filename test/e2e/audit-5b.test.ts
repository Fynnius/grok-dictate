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

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));

/** `fs.globSync` is Node 22+. CI is `.nvmrc` 20. */
function globUnder(dir: string, exts: readonly string[]): string[] {
  return readdirSync(resolve(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter((name) => exts.some((ext) => name.endsWith(ext)))
    .map((name) => join(dir, name));
}

/** Every hand-written source file in the application, tests excluded. */
function sourceFiles(options: { includeTests?: boolean } = {}): string[] {
  const files = [
    ...globUnder('src', ['.ts', '.tsx']),
    ...globUnder('contracts', ['.ts']),
    ...globUnder('mocks', ['.mjs', '.ts']),
    ...globUnder('scripts', ['.ts']),
    ...globUnder('native/Sources', ['.swift']),
  ];
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

describe('§5b — the pasteboard is written deliberately and never read', () => {
  /**
   * §5b was written against a stronger rule than the one that now holds: "the
   * clipboard is written **never**, not even transiently". The paste tier
   * repealed it — see `contracts/helper-protocol.md` §5 — and replaced it with
   * a rule that is narrower and harder to keep: **written, never read.**
   *
   * What survives unchanged is the containment of the *explicit* copy, which
   * is still the only user-initiated write and still reaches the pasteboard by
   * exactly one path:
   *
   *   a click in the HUD / History, or a tray History-submenu row
   *     → `{type:'copy'}` on RENDERER_TO_MAIN_CHANNEL, or `copyPlainText`
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

  it('reaches the orchestrator from exactly one place, `copyPlainText`', () => {
    const callers = sourceFiles().filter((file) => /copyToClipboard\(/.test(code(file)));
    // The definition and the single call site.
    expect(callers.map(rel).sort()).toEqual([
      'src/main/index.ts',
      'src/main/state/orchestrator.ts',
    ]);

    const root = code(resolve(ROOT, 'src/main/index.ts'));
    const matches = root.match(/copyToClipboard\(/g) ?? [];
    expect(matches).toHaveLength(1);
    // Both sanctioned entry points — the `copy` IPC message and a tray
    // History-submenu click — share this one function.
    expect(root).toMatch(/copyPlainText = \(text\) => \{[\s\S]{0,80}?copyToClipboard\(text\)/);
    expect(root).toMatch(/case 'copy':[\s\S]{0,250}?copyPlainText\(message\.text\)/);
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
    // which is the sanctioned entry point and appears in the HUD and History.
    const senders = sourceFiles().filter((file) => /v: 1,\s*type: 'copy'/.test(code(file)));
    expect(senders.map(rel)).toEqual(['src/main/native/helper-client.ts']);
  });

  it('touches NSPasteboard in exactly two Swift files, one per sanctioned write', () => {
    // Also asserted inside the Swift package (`ClipboardDisciplineTests`), and
    // repeated here so the property is checked by `npm test` as well — a
    // machine without Xcode still runs this one.
    //
    // This used to be one file. The paste tier added the second, and the two
    // are the complete list of ways a pasteboard write can begin:
    // `SystemPasteboard` for the user's explicit *Copy*, `PasteInserter` for
    // the promised item behind an insertion. Nothing else may reach it.
    const swift = sourceFiles().filter((file) => file.endsWith('.swift'));
    expect(swift.length).toBeGreaterThan(10);
    const touching = swift.filter((file) => /NSPasteboard/.test(code(file))).map(rel);
    expect(touching).toEqual([
      'native/Sources/grok-dictate-helper/PasteInserter.swift',
      'native/Sources/grok-dictate-helper/SystemPasteboard.swift',
    ]);
  });

  it('reads the pasteboard nowhere', () => {
    //  law 1, the rule that replaced "never written". Reading is
    // the operation macOS 15.4 previewed a permission prompt for and macOS 26
    // carries; writing never prompts. Every spelling AppKit offers for getting
    // data *out* of a pasteboard is forbidden, so a "helpful" snapshot added
    // later in good faith fails here rather than in the field.
    //
    // `setString(_:forType:)` does not contain `string(forType:` and
    // `setData(_:forType:)` does not contain `data(forType:`, which is what
    // makes plain substring matching enough.
    const READS = [
      'pasteboardItems',
      'string(forType:',
      'data(forType:',
      'propertyList(forType:',
      'readObjects(',
      'canReadObject',
      'readFileContents(',
    ];
    const offenders: string[] = [];
    for (const file of sourceFiles().filter((f) => f.endsWith('.swift'))) {
      const body = code(file);
      for (const read of READS) {
        if (body.includes(read)) offenders.push(`${rel(file)} calls ${read})`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the tray menu's only clipboard action is copy-history", () => {
    // The menu is built as data precisely so this is assertable
    // (`src/main/tray/menu.test.ts` proves it over the built menu); here we
    // pin that no *new* action kind can quietly become a clipboard write.
    // `copy-history` is the sanctioned History-submenu click; the text is
    // resolved at click time, not stored on the action.
    const menu = code(resolve(ROOT, 'src/main/tray/menu.ts'));
    expect(menu).toMatch(/kind: 'copy-history'/);
    expect(menu).not.toMatch(/clipboard|pasteboard/i);
    expect(menu.replaceAll('copy-history', '')).not.toMatch(/copy/i);
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
    expect(options).not.toMatch(/token|bearer|authorization|secret|cookie/i);
  });

  it('interpolates grok.com cookies only into the Cookie header', () => {
    const client = code(resolve(ROOT, 'src/main/stt/client.ts'));
    expect(client.match(/Cookie: `\$\{cookieHeader\}`/g) ?? []).toHaveLength(1);
  });

  it('has no field on a history row that could carry a credential', () => {
    //  names the history file as one of the four sinks. The row
    // shape is the guarantee: transcript, timing, target app, outcome.
    const events = read(resolve(ROOT, 'contracts/events.ts'));
    const entry = /export interface HistoryEntry \{([\s\S]*?)\n\}/.exec(events)?.[1] ?? '';
    expect(entry.length).toBeGreaterThan(0);
    const fields = [...entry.matchAll(/^\s*readonly (\w+)\??/gm)].map((m) => m[1]);
    // `verified` and `unconfirmedTail` were added by the 2026-08-09 incident,
    // and both are booleans about what happened to the text rather than new
    // places to put one. `audioRelPath` is a userData-relative sidecar path,
    // `cancelled` / `transcribeError` mark a take that can be retried — still
    // not a place to hide a credential. The property this list defends is
    // unchanged: a history row holds a transcript, timing, the target app and
    // the outcome — and nothing with anywhere to hide a credential.
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
      'verified',
      'unconfirmedTail',
      'audioRelPath',
      'cancelled',
      'transcribeError',
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
