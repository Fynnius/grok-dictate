/**
 * Map a non-101 STT handshake to an AppError.
 *
 * Measured 2026-09-11 against `wss://api.x.ai/v1/stt?model=grok-stt-2-fast`:
 * HTTP 404, body
 * `{"error":"The model 'grok-stt-2-fast' does not exist or your team does not have access to it"}`.
 * grok.com composer dictate uses that model on `wss://grok.com/ws/v1/stt` with
 * cookies; the public API does not offer it. A CLI OAuth bearer against
 * grok.com's socket is 401.
 */

import { appError, type AppError } from '@shared/result.js';

const UNKNOWN_MODEL =
  /does not exist or your team does not have access/i;

export function handshakeErrorText(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed !== null && typeof parsed === 'object' && 'error' in parsed) {
      const value = (parsed as { error: unknown }).error;
      return typeof value === 'string' && value.length > 0 ? value : null;
    }
  } catch {
    /* not JSON */
  }
  return null;
}

export function errorFromSttHandshake(status: number, body: string): AppError {
  const text = handshakeErrorText(body);
  const haystack = text ?? body;

  if (status === 404 && UNKNOWN_MODEL.test(haystack)) {
    const model = /model '([^']+)'/i.exec(haystack)?.[1];
    return appError(
      'stt_connect',
      model === undefined
        ? 'That speech model is not available on the xAI API.'
        : `The speech model '${model}' is not available on the xAI API.`,
      'STT 2 Fast is what grok.com uses internally. Switch Speech model back to Standard — the public API does not offer it yet.',
    );
  }

  return appError(
    'stt_connect',
    `The xAI speech service refused the connection (HTTP ${String(status)}).`,
    'Try again in a moment. The audio just recorded is still in memory.',
  );
}
