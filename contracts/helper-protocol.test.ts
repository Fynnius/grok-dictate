import { describe, expect, it } from 'vitest';
import {
  encodeAppFrame,
  parseAppFrame,
  parseHelperFrame,
  HELPER_CAPABILITIES,
  INSERT_TIERS,
  type InsertCommand,
  type MuteOutputCommand,
  type UnmuteOutputCommand,
} from './helper-protocol.js';

describe('mute_output / unmute_output (2026-08-22)', () => {
  it('round-trips mute_output', () => {
    const command: MuteOutputCommand = { v: 1, type: 'mute_output' };
    const parsed = parseAppFrame(encodeAppFrame(command));
    expect(parsed).toEqual({ ok: true, frame: command });
  });

  it('round-trips unmute_output', () => {
    const command: UnmuteOutputCommand = { v: 1, type: 'unmute_output' };
    const parsed = parseAppFrame(encodeAppFrame(command));
    expect(parsed).toEqual({ ok: true, frame: command });
  });

  it('ignores unknown fields on mute commands (contract §1 rule 3)', () => {
    expect(parseAppFrame('{"v":1,"type":"mute_output","fromTheFuture":true}')).toEqual({
      ok: true,
      frame: { v: 1, type: 'mute_output' },
    });
    expect(parseAppFrame('{"v":1,"type":"unmute_output","extra":1}')).toEqual({
      ok: true,
      frame: { v: 1, type: 'unmute_output' },
    });
  });
});

describe('the paste tier (2026-09-06)', () => {
  const insert = (extra: Record<string, unknown> = {}): string =>
    JSON.stringify({
      v: 1,
      type: 'insert',
      id: 'x',
      text: 'hallo',
      targetBundleId: null,
      ...extra,
    });

  it('round-trips an insert carrying a route', () => {
    const command: InsertCommand = {
      v: 1,
      type: 'insert',
      id: 'x',
      text: 'hallo',
      targetBundleId: null,
      route: 'paste',
    };
    expect(parseAppFrame(encodeAppFrame(command))).toEqual({ ok: true, frame: command });
  });

  it('reads an insert from an older app as `auto`', () => {
    // The whole reason `route` is defaulted rather than required. An app that
    // predates the setting sends no route at all, and must get the behaviour a
    // user who has not touched the setting gets — not a parse failure, which
    // would drop the frame and lose a transcript.
    const parsed = parseAppFrame(insert());
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.frame.type === 'insert' && parsed.frame.route).toBe('auto');
  });

  it('rejects a route it does not know rather than guessing one', () => {
    // The opposite trade from `insertMethod` on disk, and deliberately so: a
    // config file is the user's and is salvaged field by field, but a frame
    // from a *newer app* naming a route this helper cannot perform must not be
    // silently downgraded to `auto` — that would paste when the user asked not
    // to. Rejecting surfaces the version mismatch as a log line.
    expect(parseAppFrame(insert({ route: 'telepathy' })).ok).toBe(false);
  });

  it('carries `paste` as both a tier and a capability', () => {
    expect(INSERT_TIERS).toContain('paste');
    expect(HELPER_CAPABILITIES).toContain('paste');
  });

  it('parses a paste result, and a ready frame from a helper that cannot paste', () => {
    const result = parseHelperFrame(
      '{"v":1,"type":"insert_result","id":"x","tier":"paste","ok":true,' +
        '"verified":true,"error":null,"reason":null}',
    );
    expect(result.ok).toBe(true);

    // An older helper binary. `caps` without `paste` is how the app tells "this
    // build cannot" apart from "the helper chose not to".
    const ready = parseHelperFrame(
      '{"v":1,"type":"ready","version":"0.1.0","caps":["ax","unicode"]}',
    );
    expect(ready.ok).toBe(true);
  });
});
