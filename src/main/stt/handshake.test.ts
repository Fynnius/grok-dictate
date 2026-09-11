import { describe, expect, it } from 'vitest';
import { errorFromSttHandshake, handshakeErrorText } from './handshake.js';

describe('handshakeErrorText', () => {
  it('reads the `error` string xAI puts on a refused upgrade', () => {
    expect(
      handshakeErrorText(
        '{"error":"The model \'grok-stt-2-fast\' does not exist or your team does not have access to it"}',
      ),
    ).toBe("The model 'grok-stt-2-fast' does not exist or your team does not have access to it");
  });

  it('returns null for empty, non-JSON, or a non-string error field', () => {
    expect(handshakeErrorText('')).toBeNull();
    expect(handshakeErrorText('not json')).toBeNull();
    expect(handshakeErrorText('{"error":{"code":"nope"}}')).toBeNull();
  });
});

describe('errorFromSttHandshake', () => {
  it('names the missing model on the measured 404', () => {
    const error = errorFromSttHandshake(
      404,
      '{"error":"The model \'grok-stt-2-fast\' does not exist or your team does not have access to it"}',
    );
    expect(error.code).toBe('stt_connect');
    expect(error.message).toBe("The speech model 'grok-stt-2-fast' is not available on the xAI API.");
    expect(error.hint).toContain('Standard');
  });

  it('keeps the generic refusal for a 500 with no body', () => {
    const error = errorFromSttHandshake(500, '');
    expect(error.message).toContain('HTTP 500');
    expect(error.hint).toContain('Try again');
  });
});
