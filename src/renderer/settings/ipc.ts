/**
 * OWNER: **Phase 4**. Talking to the main process without ever leaving a panel
 * blank.
 *
 * `RendererApi.invoke` rejects if the main-process handler is missing or
 * throws. Every call site used to be a bare `void api.invoke(…).then(…)`, which
 * meant a failure produced an unhandled rejection in the console and a window
 * stuck on its loading state forever — found by loading the built panels with
 * no handler registered. A blank window that explains nothing is exactly the
 * silent failure IMPLEMENTATION-PLAN.md §4 rules out.
 *
 * So every request goes through here, and failure is a value the view renders.
 */

import type { InvokeRequest, InvokeResponse } from '@contracts/events.js';

export type InvokeOutcome<T> = { ok: true; value: T } | { ok: false; message: string };

/**
 * Send a request and narrow the reply to the expected member.
 *
 * A reply of the wrong type is treated as a failure rather than ignored: the
 * main process answering `get-config` with an `error` is precisely the case a
 * settings window must show rather than swallow.
 */
export async function request<K extends InvokeResponse['type']>(
  message: InvokeRequest,
  expected: K,
): Promise<InvokeOutcome<Extract<InvokeResponse, { type: K }>>> {
  let response: InvokeResponse;
  try {
    response = await window.grokDictate.invoke(message);
  } catch (cause) {
    return {
      ok: false,
      message: cause instanceof Error ? cause.message : 'The app did not answer.',
    };
  }
  if (response.type === expected) {
    return { ok: true, value: response as Extract<InvokeResponse, { type: K }> };
  }
  if (response.type === 'error') return { ok: false, message: response.error.message };
  return { ok: false, message: `Unexpected reply: ${response.type}.` };
}
