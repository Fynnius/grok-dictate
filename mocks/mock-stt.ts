/**
 * Mocked xAI streaming STT — Phase 1 walking skeleton.
 *
 * Replays a canned transcript on a realistic timeline: `transcript.created`
 * after a simulated handshake, `transcript.partial` roughly every 500 ms, then
 * a `speech_final` a short time after the turn ends, then `transcript.done`.
 * Phase 3 replaces it with the real WebSocket client behind the same
 * `SttClientPort`.
 *
 * Two real behaviours are reproduced because the rest of the app depends on
 * them:
 *
 *   1. **PCM is accepted before the socket is ready** and flushed in order once
 *      it is — `forward_pcm` in `pipeline.rs:147-192`. `pipeline.rs:218-220`
 *      records that not doing this "clipp[ed] the first word of a hold".
 *
 *   2. **Only `speech_final` produces `onFinal`.** Chunk-final deltas
 *      (`is_final && !speech_final`) drive the preview only — `pipeline.rs:273-279`,
 *       The mock emits both kinds so that a regression which
 *      commits delta text is caught by a test rather than in production.
 */

import type { SttClientPort, SttHandlers, SttTurn, SttTurnOptions } from '@contracts/ports.js';
import { BACKLOG_MAX_CHUNKS } from '@shared/constants.js';
import { appError } from '@shared/result.js';

export interface MockSttPartial {
  /** Milliseconds after the turn starts. */
  readonly atMs: number;
  readonly text: string;
  /** `is_final && !speech_final` — a locked chunk delta. Preview only. */
  readonly isFinal?: boolean;
}

export interface MockSttScript {
  /** Simulated TLS + WebSocket + `transcript.created` round trip. */
  readonly connectMs: number;
  readonly partials: readonly MockSttPartial[];
  /** The `speech_final` text — the only thing that may be inserted. */
  readonly finalText: string;
  /** End-of-audio → `speech_final`. Spike 2 measures the real figure. */
  readonly finalAfterFinishMs: number;
  /** `transcript.done.duration`. */
  readonly durationSec: number;
  /** The `language` field the server puts on every partial (spike 1). */
  readonly detectedLanguage: string;
  /** Fail instead of transcribing, to exercise the error path. */
  readonly failWith?: 'connect' | 'rate_limited' | 'auth_expired';
}

/** Canned transcript so the mock exercises the same path as a real turn. */
export const DEFAULT_SCRIPT: MockSttScript = {
  connectMs: 180,
  partials: [
    { atMs: 500, text: 'hello' },
    { atMs: 1000, text: 'hello there' },
    { atMs: 1500, text: 'Hello there, this is a test.', isFinal: true },
    { atMs: 2000, text: 'please confirm' },
    { atMs: 2500, text: 'please confirm the details' },
  ],
  finalText: 'Hello there, this is a test. Please confirm the details.',
  finalAfterFinishMs: 220,
  durationSec: 12.9,
  detectedLanguage: 'en',
};

interface Scheduled {
  timer: NodeJS.Timeout;
}

class MockSttTurnImpl implements SttTurn {
  readonly #handlers: SttHandlers;
  readonly #script: MockSttScript;
  readonly #timers: Scheduled[] = [];
  /** PCM held until the simulated socket is ready. */
  #backlog: Uint8Array[] = [];
  #ready = false;
  #finished = false;
  #aborted = false;
  /** Everything that actually reached the "socket", in order. */
  readonly sent: Uint8Array[] = [];

  constructor(script: MockSttScript, handlers: SttHandlers) {
    this.#script = script;
    this.#handlers = handlers;
    this.#schedule(script.connectMs, () => this.#open());
  }

  sendPcm(pcm: Uint8Array): void {
    if (this.#aborted) return;
    if (!this.#ready) {
      // Bounded, exactly as `pipeline.rs:145` bounds it: a pathological hang
      // drops the oldest chunks rather than growing without limit.
      if (this.#backlog.length === BACKLOG_MAX_CHUNKS) this.#backlog.shift();
      this.#backlog.push(pcm);
      return;
    }
    this.sent.push(pcm);
  }

  finish(): void {
    if (this.#aborted || this.#finished) return;
    this.#finished = true;
    this.#schedule(this.#script.finalAfterFinishMs, () => {
      if (this.#aborted) return;
      // The observed `speech_final` frame carries the `language` field too, not
      // just the interim partials — see docs/spike-raw/02a-done-ep400.jsonl. A
      // short hold can end before any partial arrives, so this is the only
      // detection the app gets in that case.
      this.#handlers.onLanguageDetected(this.#script.detectedLanguage);
      this.#handlers.onFinal(this.#script.finalText);
      this.#handlers.onDone(this.#script.durationSec);
    });
  }

  abort(): void {
    this.#aborted = true;
    for (const { timer } of this.#timers.splice(0)) clearTimeout(timer);
    this.#backlog = [];
  }

  #open(): void {
    if (this.#aborted) return;

    const failure = this.#script.failWith;
    if (failure !== undefined) {
      this.#handlers.onError(mockFailure(failure));
      return;
    }

    this.#ready = true;
    // Flush in order, ahead of anything captured live.
    this.sent.push(...this.#backlog);
    this.#backlog = [];
    this.#handlers.onReady();

    for (const partial of this.#script.partials) {
      const delay = Math.max(0, partial.atMs - this.#script.connectMs);
      this.#schedule(delay, () => {
        if (this.#aborted || this.#finished) return;
        // Both kinds arrive as `onInterim`: a chunk-final delta is still
        // preview text. Only `finish()` produces `onFinal`.
        this.#handlers.onInterim(partial.text);
        // Every real partial carries a detected `language` field (spike 1).
        this.#handlers.onLanguageDetected(this.#script.detectedLanguage);
      });
    }
  }

  #schedule(delayMs: number, fn: () => void): void {
    const timer = setTimeout(fn, delayMs);
    timer.unref?.();
    this.#timers.push({ timer });
  }
}

function mockFailure(kind: NonNullable<MockSttScript['failWith']>): ReturnType<typeof appError> {
  switch (kind) {
    case 'connect':
      return appError(
        'stt_connect',
        'Could not reach the xAI speech service.',
        'Check your network connection and try again — the audio has been kept.',
      );
    case 'rate_limited':
      return appError(
        'stt_rate_limited',
        'The xAI speech service is rate limiting this account.',
        'Wait a few seconds and try again.',
      );
    case 'auth_expired':
      // §4: "token expired at 21:58 — run `grok` to refresh" is the standard.
      return appError(
        'auth_expired',
        'The Grok token has expired.',
        'Run `grok` in a terminal to refresh it, then try again.',
      );
  }
}

export class MockSttClient implements SttClientPort {
  #script: MockSttScript;
  /** Every turn started, for assertions. */
  readonly turns: { options: SttTurnOptions; turn: MockSttTurnImpl }[] = [];

  constructor(script: MockSttScript = DEFAULT_SCRIPT) {
    this.#script = script;
  }

  setScript(script: MockSttScript): void {
    this.#script = script;
  }

  startTurn(options: SttTurnOptions, handlers: SttHandlers): SttTurn {
    // Synchronous by contract: the caller may push PCM immediately (ports.ts).
    const turn = new MockSttTurnImpl(this.#script, handlers);
    this.turns.push({ options, turn });
    return turn;
  }
}
