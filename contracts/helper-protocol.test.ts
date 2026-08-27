import { describe, expect, it } from 'vitest';
import {
  encodeAppFrame,
  parseAppFrame,
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
