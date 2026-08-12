/**
 * The `wss://api.x.ai/v1/stt` query contract.
 *
 * Pure, so every decision the spikes settled is a unit test rather than a thing
 * you have to run a socket to check.
 *
 * Parameters, and where each comes from:
 *
 * | Parameter          | Value          | Source                                    |
 * | ------------------ | -------------- | ----------------------------------------- |
 * | `sample_rate`      | 16000          | `config.rs:36-48`,          |
 * | `encoding`         | `pcm`          | `config.rs:36-48`                         |
 * | `interim_results`  | `true`         | `config.rs:36-48` (xAI's default is false)|
 * | `endpointing`      | config, 400 ms | `config.rs:36-48`; spike 2                |
 * | `language`         | omitted for `auto` | spike 1 + 3, docs/spike-results.md    |
 * | `keyterm`          | repeated       | spike 5                                   |
 *
 * Two of those are the direct output of the Phase 1 spikes and would otherwise
 * be guesses:
 *
 *   - **`language` is omitted on `auto`.** The server performs real acoustic
 *     detection and reports it back on every `transcript.partial`; English audio
 *     sent with `language=de` came back `"language":"en"` with English
 *     formatting. Sending a code the server ignores is inert at best, and
 *      shows a wrong code fails silently (`xx99` was accepted).
 *     `resolveWireLanguage` in the frozen config contract already returns `null`
 *     for `auto`; this module just honours the `null`.
 *
 *   - **`keyterm` is repeated, not comma-separated.** Spike 5 proved both forms
 *     work identically, and repetition is chosen because a term containing a
 *     comma is unrepresentable in the CSV form.
 */

import type { SttTurnOptions } from '@contracts/ports.js';
import {
  KEYTERM_MAX_COUNT,
  KEYTERM_MAX_LENGTH,
  SAMPLE_RATE_HZ,
  STT_WS_PATH,
} from '@shared/constants.js';

export interface KeytermSelection {
  readonly accepted: readonly string[];
  /** Terms the server would reject or that carry no information, with a reason. */
  readonly dropped: readonly { term: string; reason: string }[];
}

/**
 * Normalise the configured keyterms into what actually goes on the wire.
 *
 * `contracts/config.ts` already caps the array at 100 × 50, but
 * the config file is user-editable and `parseConfig` salvages field-by-field, so
 * an over-long list must degrade to a warning rather than a rejected handshake.
 */
export function selectKeyterms(keyterms: readonly string[]): KeytermSelection {
  const accepted: string[] = [];
  const dropped: { term: string; reason: string }[] = [];
  const seen = new Set<string>();

  for (const raw of keyterms) {
    const term = raw.trim();
    if (term.length === 0) continue;
    if (term.length > KEYTERM_MAX_LENGTH) {
      dropped.push({ term, reason: `longer than ${String(KEYTERM_MAX_LENGTH)} characters` });
      continue;
    }
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (accepted.length === KEYTERM_MAX_COUNT) {
      dropped.push({ term, reason: `over the ${String(KEYTERM_MAX_COUNT)}-term limit` });
      continue;
    }
    accepted.push(term);
  }

  return { accepted, dropped };
}

export interface SttUrlOptions {
  /** `https://api.x.ai` in production; a `http://127.0.0.1:PORT` server in tests. */
  readonly apiBase: string;
  readonly language: string | null;
  readonly endpointingMs: number;
  readonly keyterms: readonly string[];
  /** `config.rs:36-48` sets this true; xAI's documented default is false. */
  readonly interimResults?: boolean;
}

export function sttUrlOptions(apiBase: string, options: SttTurnOptions): SttUrlOptions {
  return {
    apiBase,
    language: options.language,
    endpointingMs: options.endpointingMs,
    keyterms: options.keyterms,
  };
}

export function buildSttUrl(options: SttUrlOptions): string {
  const url = new URL(STT_WS_PATH, options.apiBase);
  // `http(s)` → `ws(s)`; the caller supplies an https base because that is what
  // `config.rs` stores, and the plaintext guard below keys off the same value.
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';

  url.searchParams.set('sample_rate', String(SAMPLE_RATE_HZ));
  url.searchParams.set('encoding', 'pcm');
  url.searchParams.set('interim_results', String(options.interimResults ?? true));
  url.searchParams.set('endpointing', String(options.endpointingMs));
  // `null` means "omit" — never the literal string `auto`, and never a
  // guessed code (spike 3: the parameter did not steer anything we could test).
  if (options.language !== null) url.searchParams.set('language', options.language);

  for (const term of selectKeyterms(options.keyterms).accepted) {
    url.searchParams.append('keyterm', term);
  }

  return url.toString();
}

/**
 * `config.rs:100-119` refuses a plaintext base outright: *"Refusing to send the
 * bearer token over a plaintext connection."* That guard is ported, with one
 * documented exemption — a loopback host, which is how the test suite runs a
 * real `ws` server without a certificate. The bearer never leaves the machine in
 * that case, and the tests use a synthetic token regardless.
 */
export function isLoopbackHost(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname === '[::1]'
  );
}

export function checkTransportSecurity(url: string): { ok: true } | { ok: false; reason: string } {
  const parsed = new URL(url);
  if (parsed.protocol === 'wss:') return { ok: true };
  if (isLoopbackHost(parsed.hostname)) return { ok: true };
  return {
    ok: false,
    reason: `refusing to send the Grok token over a plaintext connection to ${parsed.host}`,
  };
}
