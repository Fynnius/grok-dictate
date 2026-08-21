/**
 * The real xAI streaming STT client.
 *
 * Replaces `mocks/mock-stt.ts` behind the frozen `SttClientPort`. Everything
 * here that looks like a design decision is either ported from the Grok Rust
 * source (cited by file and line) or settled by a Phase 1 spike (cited to
 * docs/spike-results.md); nothing is invented.
 *
 * ## The five behaviours that matter
 *
 * 1. **`startTurn` is synchronous and PCM is accepted before the socket is up.**
 *    `forward_pcm` (`pipeline.rs:147-192`) buffers into a bounded queue and
 *    flushes in order once the session is live. `pipeline.rs:218-220` records
 *    that running mic-open and connect in series "clipp[ed] the first word of a
 *    hold" — and the spikes measured the handshake at **518-591 ms**, so this is
 *    over half a second of speech, every single dictation.
 *
 * 2. **Only `speech_final` produces `onFinal`.** `pipeline.rs:273-279`. Deltas
 *    drive the preview; the committed text is the server's clean one-pass
 *    re-transcription. See `frames.ts`.
 *
 * 3. **A close is benign once the turn has ended.** `streaming.rs:206-213`
 *    filters `ConnectionClosed` / `ResetWithoutClosingHandshake`; the spikes
 *    confirmed this endpoint closes with **code 1006, no closing handshake,
 *    after every turn**. Without the filter every dictation ends in a spurious
 *    error. A close *before* the turn ends is a different thing entirely — a
 *    dropped network — and is reported.
 *
 * 4. **`audio.done`, not `finalize`.** Spike 2 measured 318-344 ms either way,
 *    and `finalize` produces no `transcript.done` (so no `duration` telemetry)
 *    and never closes the socket. `useFinalize` defaults to false in the frozen
 *    config; the flag is still honoured here, with a guard timer, because it is
 *    the right primitive if the app ever holds one socket across utterances.
 *
 * 5. **429 is retried with exponential backoff and full jitter, and every
 *    rate-limit response is logged with its headers.**  is the
 *    highest-stakes open question in the project and calls this "a v1
 *    requirement, not polish". No 429 was seen across 12 spike sessions, which
 *    says nothing about daily use — these logs are how §9.1 gets answered.
 */

import type { ClientRequest, IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { WebSocket, type RawData } from 'ws';
import type {
  AuthPort,
  Bearer,
  SttClientPort,
  SttHandlers,
  SttTurn,
  SttTurnOptions,
} from '@contracts/ports.js';
import {
  BACKLOG_MAX_CHUNKS,
  BYTES_PER_SECOND,
  NO_SPEECH_TIMEOUT_MS,
  STT_API_BASE,
  STT_CONNECT_TIMEOUT_MS,
  STT_READY_TIMEOUT_MS,
} from '@shared/constants.js';
import { backoffDelayMs } from '@shared/backoff.js';
import type { Logger } from '@shared/logger.js';
import { appError, type AppError } from '@shared/result.js';
import { TranscriptAccumulator, parseServerFrame } from './frames.js';
import { buildSttUrl, checkTransportSecurity, selectKeyterms, sttUrlOptions } from './url.js';

/* ------------------------------------------------------------------ *
 * Tuning
 * ------------------------------------------------------------------ */

/**
 * 429 backoff. : the subscription's limits are unpublished, so a
 * retry storm is a real way to make the product unusable. Full jitter comes from
 * `src/shared/backoff.ts`, which exists for exactly these two callers.
 *
 * Three retries inside ~10 s is bounded by what a human will wait with a key
 * held down; past that, an error that says how long to wait beats a hang.
 */
const RATE_LIMIT_BASE_MS = 500;
const RATE_LIMIT_MAX_MS = 8_000;
const RATE_LIMIT_MAX_RETRIES = 3;

/**
 * How long to wait after ending the turn before giving up on `transcript.done`.
 *
 * Two cases need it. `finalize` never produces a terminal frame at all (spike
 * 2), and a stalled server would otherwise leave the state machine parked in
 * `processing` forever, with the user's transcript on screen and no way out.
 * Measured end-of-audio → `transcript.done` was 332-344 ms; 8 s is a ceiling,
 * not a target.
 */
const FINISH_TIMEOUT_MS = 8_000;

/**
 * Liveness. **Added after Phase 3's human test HT-5 failed**, and the reason it
 * failed is worth stating: switching Wi-Fi off mid-utterance produces no socket
 * error and no close event at all. Writes keep succeeding into the kernel send
 * buffer, `ws` sees nothing, and the client sat happily for the full eight
 * seconds of the finish timeout before ending the turn with the one three-
 * character fragment that had arrived before the link died — presented to the
 * user as a successful dictation. A silent failure of exactly the kind
 *  is about.
 *
 * A black-holed TCP connection can only be detected by asking it something. A
 * probe against the live endpoint (2026-08-09) confirmed the server answers
 * every WebSocket ping with a pong in 107-241 ms, and additionally emits an
 * empty `transcript.partial` roughly every 500 ms even during pure silence — so
 * *any* inbound frame is a liveness signal and the timeouts below are generous
 * by two orders of magnitude.
 *
 * The window tightens at end of turn: that is the moment the answer matters,
 * and a pong is served by the WebSocket layer regardless of how busy
 * transcription is, so a short deadline cannot false-positive on a slow final.
 */
const LIVENESS_CHECK_INTERVAL_MS = 500;
const LIVENESS_TIMEOUT_MS = 6_000;
const FINISH_LIVENESS_TIMEOUT_MS = 3_000;

/**
 * How late a liveness firing has to be before it is read as **the process not
 * running** rather than as the link being silent.
 *
 * The 2026-08-09 incident, BUG-6: `idle` is `now - lastInboundAt` measured
 * inside a `setInterval`, which quietly assumes the interval actually ran. If
 * the Mac sleeps mid-dictation, or the main process's event loop stalls past
 * the timeout under heavy GC or system pressure, the callback runs before the
 * queued WebSocket `message` events are processed. `idle` then measures **our
 * own absence**, looks enormous, and the turn is killed with "the connection
 * stopped responding" — error cue, no insert, and combined with BUG-3 the
 * interim text lost with it — on a link that is perfectly fine.
 *
 * The gap between two firings is the thing that separates the two cases: a
 * silent server still lets the interval run on time, and a sleeping laptop does
 * not. Both bounds are **chosen, not measured**. 2 s absolute is two orders of
 * magnitude above ordinary timer jitter (single-digit milliseconds) and far
 * below any sleep or stall worth calling one; the ×4 factor keeps the rule
 * proportionate if the period is ever shortened. The absolute floor is what
 * stops a short test timeout from turning normal scheduling noise into a
 * suppressed failure.
 */
const LIVENESS_STALL_MS = 2_000;
const LIVENESS_STALL_FACTOR = 4;

type TimerName = 'ready' | 'noSpeech' | 'finish' | 'retry';

/* ------------------------------------------------------------------ *
 * Client
 * ------------------------------------------------------------------ */

/**
 * Every timeout in the client, in one place.
 *
 * Overridable purely as a test seam: waiting out a real 10 s no-speech watchdog
 * in a unit test is the kind of thing that turns a suite into something nobody
 * runs. Production always uses the constants, which carry their own citations.
 */
export interface SttTimeouts {
  /** `pipeline.rs:198` — 10 s, disarmed by the first transcript. */
  readonly noSpeechMs: number;
  /** `streaming.rs:154` — 10 s waiting for `transcript.created`. */
  readonly readyMs: number;
  /** `streaming.rs:63-68` — 15 s on the WebSocket connect. */
  readonly connectMs: number;
  /** Backstop for a server that never sends a terminal frame (spike 2). */
  readonly finishMs: number;
  /** No inbound frame or pong for this long, mid-turn, means the link is gone. */
  readonly livenessMs: number;
  /** The same, tightened once the turn has ended. */
  readonly finishLivenessMs: number;
}

export const DEFAULT_TIMEOUTS: SttTimeouts = {
  noSpeechMs: NO_SPEECH_TIMEOUT_MS,
  readyMs: STT_READY_TIMEOUT_MS,
  connectMs: STT_CONNECT_TIMEOUT_MS,
  finishMs: FINISH_TIMEOUT_MS,
  livenessMs: LIVENESS_TIMEOUT_MS,
  finishLivenessMs: FINISH_LIVENESS_TIMEOUT_MS,
};

export interface SttClientOptions {
  readonly auth: AuthPort;
  readonly logger: Logger;
  /** `https://api.x.ai` in production; a loopback server under test. */
  readonly apiBase?: string;
  readonly now?: () => number;
  /** Injectable for deterministic backoff assertions. */
  readonly random?: () => number;
  readonly timeouts?: Partial<SttTimeouts>;
}

export class XaiSttClient implements SttClientPort {
  readonly #options: TurnDeps;

  constructor(options: SttClientOptions) {
    this.#options = {
      ...options,
      apiBase: options.apiBase ?? STT_API_BASE,
      now: options.now ?? Date.now,
      random: options.random ?? Math.random,
      timeouts: { ...DEFAULT_TIMEOUTS, ...options.timeouts },
    };
  }

  /** Synchronous by contract — see the note at the top of `contracts/ports.ts`. */
  startTurn(options: SttTurnOptions, handlers: SttHandlers): SttTurn {
    return new SttTurnImpl(options, handlers, this.#options);
  }
}

/* ------------------------------------------------------------------ *
 * A single turn
 * ------------------------------------------------------------------ */

interface TurnDeps {
  readonly auth: AuthPort;
  readonly logger: Logger;
  readonly apiBase: string;
  readonly now: () => number;
  readonly random: () => number;
  readonly timeouts: SttTimeouts;
}

class SttTurnImpl implements SttTurn {
  readonly #options: SttTurnOptions;
  readonly #handlers: SttHandlers;
  readonly #deps: TurnDeps;
  readonly #log: Logger;
  readonly #accumulator = new TranscriptAccumulator();
  readonly #timers = new Map<TimerName, NodeJS.Timeout>();
  readonly #startedAt: number;

  #socket: WebSocket | null = null;
  /** PCM captured before `transcript.created`. */
  #backlog: Uint8Array[] = [];
  #backlogDropped = 0;
  #ready = false;
  #finishRequested = false;
  /** No further handler calls once set. Set by success, failure and abort alike. */
  #terminal = false;
  #doneEmitted = false;
  #detectedLanguage: string | null = null;
  #attempt = 0;
  #bytesSent = 0;
  #finalCount = 0;
  #openedAt: number | null = null;
  /** Any inbound frame — message or pong. The liveness clock. */
  #lastInboundAt = 0;
  #livenessTimer: NodeJS.Timeout | null = null;
  #livenessTimeoutMs: number;

  constructor(options: SttTurnOptions, handlers: SttHandlers, deps: TurnDeps) {
    this.#options = options;
    this.#handlers = handlers;
    this.#deps = deps;
    this.#log = deps.logger.child('stt');
    this.#startedAt = deps.now();
    this.#livenessTimeoutMs = deps.timeouts.livenessMs;

    // `pipeline.rs:198-209` — 10 s, disarmed by the first transcript. It exists
    // because "macOS may return silence instead of an error" when microphone
    // permission is denied, which is otherwise indistinguishable from a user
    // who simply has not started talking.
    this.#arm('noSpeech', deps.timeouts.noSpeechMs, () => {
      this.#fail(
        appError(
          'stt_no_speech',
          `No speech reached the xAI speech service in ${String(Math.round(deps.timeouts.noSpeechMs / 1000))} seconds.`,
          'Check that the right input device is selected and not muted, and that Grok Dictate has Microphone access in System Settings → Privacy & Security → Microphone.',
        ),
      );
    });

    void this.#begin();
  }

  /* ---------------- SttTurn ---------------- */

  sendPcm(pcm: Uint8Array): void {
    if (this.#terminal) return;

    if (!this.#ready) {
      // Bounded exactly as `pipeline.rs:145` bounds it (`BACKLOG_MAX_CHUNKS`):
      // drop the oldest rather than growing without limit. In practice the
      // connect timeout fires long before 1024 chunks (~102 s) accumulate, so
      // this only guards a pathological hang.
      if (this.#backlog.length >= BACKLOG_MAX_CHUNKS) {
        this.#backlog.shift();
        this.#backlogDropped++;
      }
      this.#backlog.push(pcm);
      return;
    }

    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    socket.send(pcm);
    this.#bytesSent += pcm.byteLength;
  }

  finish(): void {
    if (this.#terminal || this.#finishRequested) return;
    this.#finishRequested = true;
    this.#clear('noSpeech');

    // Guard against a server that never produces a terminal frame — which is
    // exactly what `finalize` does (spike 2).
    this.#arm('finish', this.#deps.timeouts.finishMs, () => {
      this.#log.warn('no transcript.done within the finish timeout; ending the turn anyway', {
        timeoutMs: this.#deps.timeouts.finishMs,
        useFinalize: this.#options.useFinalize,
      });
      this.#emitDone(null);
    });

    // End of turn is the moment "is this connection still there?" matters, so
    // ask straight away and shorten the deadline. HT-5: without this the client
    // waits out the whole finish timeout on a link that died minutes ago.
    this.#livenessTimeoutMs = this.#deps.timeouts.finishLivenessMs;
    this.#pingNow();
    if (this.#livenessTimer !== null) this.#startLiveness();

    if (this.#ready) this.#sendEndOfTurn();
    // Otherwise `#onCreated` sends it as soon as the session exists, after the
    // backlog has been flushed — order matters, or the server ends the turn
    // before it has the audio.
  }

  abort(): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#clearAll();
    this.#backlog = [];
    this.#log.debug('turn aborted', { sessionId: this.#options.sessionId });
    this.#closeSocket();
  }

  /* ---------------- connect ---------------- */

  async #begin(): Promise<void> {
    const bearer = await this.#deps.auth.getBearer();
    if (this.#terminal) return;
    if (!bearer.ok) {
      this.#fail(bearer.error);
      return;
    }
    this.#connect(bearer.value);
  }

  #connect(bearer: Bearer): void {
    if (this.#terminal) return;

    const url = buildSttUrl(sttUrlOptions(this.#deps.apiBase, this.#options));

    // `config.rs:100-119`: "Refusing to send the bearer token over a plaintext
    // connection." Ported, with a loopback exemption for the test harness.
    const secure = checkTransportSecurity(url);
    if (!secure.ok) {
      this.#fail(
        appError(
          'stt_connect',
          `Grok Dictate ${secure.reason}.`,
          'This is a bug in Grok Dictate — the speech endpoint must be wss://.',
        ),
      );
      return;
    }

    const dropped = selectKeyterms(this.#options.keyterms).dropped;
    if (dropped.length > 0) {
      this.#log.warn('some keyterms were not sent', { dropped });
    }
    if (this.#options.useFinalize) {
      // Spike 2 measured no benefit and two costs. Say so, loudly, once a turn.
      this.#log.warn(
        'useFinalize is on: no transcript.done and no server close (docs/spike-results.md §2)',
      );
    }

    this.#log.info('connecting', {
      sessionId: this.#options.sessionId,
      // No token: the bearer travels in a header, and the URL carries only
      // tuning parameters and keyterms.
      url,
      attempt: this.#attempt,
    });

    const socket = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${bearer.token}`,
        // Attribution only; the connection is fully authorised without these
        // (`streaming.rs:49-55`).
        'x-grok-client-identifier': 'grok-dictate',
        'User-Agent': 'grok-dictate/0.1',
      },
      handshakeTimeout: this.#deps.timeouts.connectMs, // `streaming.rs:63-68` — 15 s
    });
    this.#socket = socket;

    const isCurrent = (): boolean => this.#socket === socket && !this.#terminal;

    socket.on('unexpected-response', (request: ClientRequest, response: IncomingMessage) => {
      if (!isCurrent()) return;
      this.#onUnexpectedResponse(bearer, request, response);
    });

    socket.on('open', () => {
      if (!isCurrent()) return;
      this.#openedAt = this.#deps.now();
      this.#log.debug('socket open', { handshakeMs: this.#openedAt - this.#startedAt });
      // `streaming.rs:154` — 10 s waiting for `transcript.created`.
      this.#arm('ready', this.#deps.timeouts.readyMs, () => {
        this.#fail(
          appError(
            'stt_protocol',
            'The xAI speech service accepted the connection but never started a transcript.',
            'Try again. If it keeps happening, the streaming API may have changed.',
          ),
        );
      });
    });

    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!isCurrent()) return;
      this.#lastInboundAt = this.#deps.now();
      this.#onMessage(data, isBinary);
    });

    socket.on('pong', () => {
      if (!isCurrent()) return;
      this.#lastInboundAt = this.#deps.now();
    });

    socket.on('error', (error: Error) => {
      if (!isCurrent()) return;
      this.#onSocketError(error);
    });

    socket.on('close', (code: number, reason: Buffer) => {
      if (this.#socket !== socket) return;
      this.#onClose(code, reason.toString('utf8'));
    });
  }

  /**
   * A non-101 handshake response. `ws` only skips its own abort when a listener
   * is present, which is the whole reason to have one: it is the only place the
   * status code and the rate-limit headers are visible.
   */
  #onUnexpectedResponse(bearer: Bearer, request: ClientRequest, response: IncomingMessage): void {
    const status = response.statusCode ?? 0;
    const headers = response.headers;

    // We own the cleanup now that `ws` has deferred to us.
    response.resume();
    request.destroy();
    this.#socket = null;

    if (status === 429) {
      // §9.1: "log every rate-limit response with its headers". This is the only
      // instrumentation that can ever answer what the subscription's limits are.
      this.#log.warn('rate limited by the xAI speech service (HTTP 429)', {
        attempt: this.#attempt,
        headers: { ...headers },
      });
      this.#retryAfterRateLimit(bearer, headers);
      return;
    }

    if (status === 401 || status === 403) {
      this.#log.warn('the xAI speech service rejected the token', { status });
      this.#fail(
        appError(
          'auth_expired',
          `The xAI speech service rejected the login (HTTP ${String(status)}).`,
          'Open the Sign in window and paste a fresh xAI API key, or run `grok` in a terminal.',
        ),
      );
      return;
    }

    this.#log.warn('unexpected handshake response', { status, headers: { ...headers } });
    this.#fail(
      appError(
        'stt_connect',
        `The xAI speech service refused the connection (HTTP ${String(status)}).`,
        'Try again in a moment. The audio just recorded is still in memory.',
      ),
    );
  }

  #retryAfterRateLimit(bearer: Bearer, headers: IncomingHttpHeaders): void {
    const retryAfter = parseRetryAfterMs(headers['retry-after'], this.#deps.now());

    if (this.#attempt >= RATE_LIMIT_MAX_RETRIES) {
      this.#fail(
        appError(
          'stt_rate_limited',
          'The xAI speech service is rate limiting this account.',
          retryAfter === null
            ? 'Wait a few seconds and try again.'
            : `Wait about ${String(Math.ceil(retryAfter / 1000))} seconds and try again.`,
        ),
      );
      return;
    }

    // Full jitter (`src/shared/backoff.ts`), floored by any `Retry-After` the
    // server gave us — ignoring an explicit instruction is how a client earns a
    // longer ban.
    const backoff = backoffDelayMs(this.#attempt, {
      baseMs: RATE_LIMIT_BASE_MS,
      maxMs: RATE_LIMIT_MAX_MS,
      random: this.#deps.random,
    });
    const delay = Math.max(backoff, retryAfter ?? 0);

    if (delay > RATE_LIMIT_MAX_MS) {
      // Telling the user how long to wait beats holding a dead session open.
      this.#fail(
        appError(
          'stt_rate_limited',
          'The xAI speech service is rate limiting this account.',
          `It asked us to wait ${String(Math.ceil(delay / 1000))} seconds. Try again after that.`,
        ),
      );
      return;
    }

    this.#attempt++;
    this.#log.info('retrying after rate limit', { attempt: this.#attempt, delayMs: delay });
    this.#arm('retry', delay, () => {
      this.#connect(bearer);
    });
  }

  /* ---------------- frames ---------------- */

  #onMessage(data: RawData, isBinary: boolean): void {
    if (isBinary) {
      this.#log.debug('ignoring a binary frame from the server');
      return;
    }

    const frame = parseServerFrame(rawToString(data));
    switch (frame.kind) {
      case 'created':
        this.#onCreated();
        return;

      case 'partial': {
        if (frame.language !== null && frame.language !== this.#detectedLanguage) {
          // Spike 1: real acoustic detection, reported on every partial and on
          // the `speech_final` frame. This is the entirety of the app's language
          // detection —  do not exist.
          this.#detectedLanguage = frame.language;
          this.#handlers.onLanguageDetected(frame.language);
        }

        const update = this.#accumulator.accept(frame);
        if (update.kind === 'none') return;
        // The first real text disarms the watchdog. Empty partials arrive first
        // (docs/spike-results.md) and deliberately do not count.
        this.#clear('noSpeech');
        if (update.kind === 'interim') {
          this.#handlers.onInterim(update.text);
          return;
        }
        this.#finalCount++;
        this.#handlers.onFinal(update.text);
        return;
      }

      case 'done':
        this.#emitDone(frame.durationSec);
        return;

      case 'error':
        this.#fail(
          appError(
            'stt_protocol',
            `The xAI speech service reported an error: ${frame.message}`,
            'Try again. The audio just recorded is still in memory.',
          ),
        );
        return;

      case 'unknown':
        // `stt/types.rs` has an `Unknown` catch-all for the same reason: a new
        // frame type must not break dictation. Logged so it is not invisible —
        // spike 1 exists because the CLI's silence about unknown *fields* hid
        // the language field for the entire life of the crate.
        this.#log.debug('unmodelled server frame', { type: frame.type });
        return;

      case 'unparseable':
        this.#log.warn('unparseable server frame', { reason: frame.reason });
        return;
    }
  }

  #onCreated(): void {
    if (this.#ready) return;
    this.#clear('ready');
    this.#ready = true;

    const socket = this.#socket;
    const backlog = this.#backlog;
    this.#backlog = [];
    if (socket !== null && socket.readyState === WebSocket.OPEN) {
      for (const chunk of backlog) {
        socket.send(chunk);
        this.#bytesSent += chunk.byteLength;
      }
    }

    this.#log.debug('session created; backlog flushed', {
      chunks: backlog.length,
      bufferedMs: Math.round(
        (backlog.reduce((n, c) => n + c.byteLength, 0) / BYTES_PER_SECOND) * 1000,
      ),
      dropped: this.#backlogDropped,
      readyMs: this.#deps.now() - this.#startedAt,
    });
    if (this.#backlogDropped > 0) {
      this.#log.warn('dropped pre-connect audio chunks', { dropped: this.#backlogDropped });
    }

    this.#startLiveness();
    this.#handlers.onReady();
    // A hold short enough to end during the handshake: send the end-of-turn now
    // that the audio is on its way.
    if (this.#finishRequested) this.#sendEndOfTurn();
  }

  /* ---------------- liveness ---------------- */

  /**
   * Watch for the connection disappearing without saying so.
   *
   * Armed only once the session exists: before that the handshake timeout and
   * the ready timeout cover the same ground, and pinging a socket that has not
   * finished negotiating is meaningless.
   */
  #startLiveness(): void {
    this.#lastInboundAt = this.#deps.now();
    if (this.#livenessTimer !== null) clearInterval(this.#livenessTimer);

    // Everything derives from the current timeout so that shortening it at end
    // of turn — or in a test — stays self-consistent: probe at a third of the
    // budget, and sample often enough that the deadline is not overshot.
    const timeout = this.#livenessTimeoutMs;
    const period = Math.max(20, Math.min(LIVENESS_CHECK_INTERVAL_MS, Math.floor(timeout / 4)));
    const pingAfter = Math.floor(timeout / 3);
    const stallThreshold = Math.max(LIVENESS_STALL_MS, period * LIVENESS_STALL_FACTOR);
    let lastTickAt = this.#deps.now();

    const timer = setInterval(() => {
      if (this.#terminal) return;
      const now = this.#deps.now();
      const sinceTick = now - lastTickAt;
      lastTickAt = now;

      // The process was not running (BUG-6). Everything the socket delivered
      // during the gap is still sitting in the event queue behind us, so `idle`
      // measures our absence rather than the link's silence. Re-arm and ask the
      // connection directly: the turn can only die after a full timeout of
      // silence *from here*, during which at least one explicit ping goes
      // unanswered, so a genuinely dead link is still caught one window later.
      if (sinceTick >= stallThreshold) {
        this.#log.warn('the liveness check fired late; re-arming rather than blaming the link', {
          sinceTickMs: sinceTick,
          periodMs: period,
          finished: this.#finishRequested,
        });
        this.#lastInboundAt = now;
        this.#pingNow();
        return;
      }

      const idle = now - this.#lastInboundAt;
      if (idle >= this.#livenessTimeoutMs) {
        this.#log.warn('no response from the xAI speech service; treating the link as dead', {
          idleMs: idle,
          timeoutMs: this.#livenessTimeoutMs,
          finished: this.#finishRequested,
        });
        this.#fail(
          appError(
            'stt_connect',
            'The connection to the xAI speech service stopped responding.',
            'Check your network connection and try again — nothing was typed.',
          ),
        );
        return;
      }
      if (idle >= pingAfter) this.#pingNow();
    }, period);
    // `unref()` does nothing in the Electron main process, which stays alive on
    // its own — but it is not decoration either: this client also runs under
    // Vitest and in `scripts/probe-stt.ts`, both short-lived Node processes
    // where a live interval on a leaked turn would keep the process from
    // exiting. Kept for those, harmless in the app. Same for `#arm` below.
    timer.unref?.();
    this.#livenessTimer = timer;
  }

  #pingNow(): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    try {
      socket.ping();
    } catch {
      // A socket torn down between the check and the call; the liveness timer
      // will conclude the same thing a moment later.
    }
  }

  #sendEndOfTurn(): void {
    const socket = this.#socket;
    if (socket === null || socket.readyState !== WebSocket.OPEN) return;
    // Spike 2 chose `audio.done`: same latency, and it is the only one that
    // yields `transcript.done` and lets the server close.
    const message = this.#options.useFinalize ? '{"type":"finalize"}' : '{"type":"audio.done"}';
    socket.send(message);
    this.#log.debug('end of turn sent', {
      message,
      audioSec: Number((this.#bytesSent / BYTES_PER_SECOND).toFixed(2)),
    });
  }

  /* ---------------- termination ---------------- */

  #emitDone(durationSec: number | null): void {
    if (this.#doneEmitted || this.#terminal) return;
    this.#doneEmitted = true;
    this.#terminal = true;
    this.#clearAll();

    // : `transcript.done.duration` is free telemetry the
    // Grok CLI parses and discards. It is audio-seconds for the whole session
    // (spike 4), which is the honest number to compare against billing, and the
    // only instrumentation that can answer §9.1's cost question.
    this.#log.info('turn complete', {
      sessionId: this.#options.sessionId,
      durationSec,
      finals: this.#finalCount,
      sentSec: Number((this.#bytesSent / BYTES_PER_SECOND).toFixed(2)),
      language: this.#detectedLanguage,
      wallMs: this.#deps.now() - this.#startedAt,
    });

    this.#handlers.onDone(durationSec);
    this.#closeSocket();
  }

  #onClose(code: number, reason: string): void {
    if (this.#terminal) return;

    // `streaming.rs:206-213` treats `ConnectionClosed` and
    // `ResetWithoutClosingHandshake` as a normal end of turn. Spike 2 confirmed
    // this endpoint always closes 1006 — an abrupt reset with no handshake —
    // after `transcript.done`. Without this branch, *every* dictation would end
    // in an error toast.
    if (this.#finishRequested) {
      this.#log.debug('socket closed after end of turn (benign)', { code, reason });
      // If `transcript.done` never arrived, the turn still has to end or the
      // state machine parks in `processing` with the transcript on screen.
      this.#emitDone(null);
      return;
    }

    // Closing *before* the user let go is a different event: the network went
    // away mid-utterance. That is the one the user needs to be told about.
    this.#fail(
      appError(
        'stt_connect',
        'The connection to the xAI speech service dropped mid-sentence.',
        'Check your network connection and try again — nothing was typed.',
        { code, reason },
      ),
    );
  }

  #onSocketError(error: Error): void {
    const message = error.message;
    if (/handshake has timed out/i.test(message)) {
      this.#fail(
        appError(
          'stt_connect',
          `Connecting to the xAI speech service timed out after ${String(Math.round(this.#deps.timeouts.connectMs / 1000))} seconds.`,
          'Check your network connection and try again.',
          error,
        ),
      );
      return;
    }
    if (/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH|ECONNRESET|EHOSTUNREACH/i.test(message)) {
      this.#fail(
        appError(
          'stt_connect',
          'Grok Dictate could not reach the xAI speech service.',
          'Check your network connection and try again — nothing was typed.',
          error,
        ),
      );
      return;
    }
    this.#fail(
      appError(
        'stt_connect',
        'The connection to the xAI speech service failed.',
        'Try again. If it keeps happening, check your network connection.',
        error,
      ),
    );
  }

  #fail(error: AppError): void {
    if (this.#terminal) return;
    this.#terminal = true;
    this.#clearAll();
    this.#backlog = [];
    this.#log.warn('turn failed', {
      sessionId: this.#options.sessionId,
      code: error.code,
      sentSec: Number((this.#bytesSent / BYTES_PER_SECOND).toFixed(2)),
    });
    this.#closeSocket();
    this.#handlers.onError(error);
  }

  #closeSocket(): void {
    const socket = this.#socket;
    this.#socket = null;
    if (socket === null) return;
    try {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000);
        // A server that ignores the close handshake would otherwise keep the
        // handle alive; the spikes show this one resets without one anyway.
        setTimeout(() => {
          socket.terminate();
        }, 1000).unref();
      }
    } catch {
      socket.terminate();
    }
  }

  /* ---------------- timers ---------------- */

  #arm(name: TimerName, ms: number, fn: () => void): void {
    this.#clear(name);
    const timer = setTimeout(() => {
      this.#timers.delete(name);
      fn();
    }, ms);
    timer.unref?.();
    this.#timers.set(name, timer);
  }

  #clear(name: TimerName): void {
    const timer = this.#timers.get(name);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#timers.delete(name);
    }
  }

  #clearAll(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
    if (this.#livenessTimer !== null) {
      clearInterval(this.#livenessTimer);
      this.#livenessTimer = null;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function rawToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** `Retry-After` is either delta-seconds or an HTTP-date (RFC 9110 §10.2.3). */
export function parseRetryAfterMs(
  value: string | string[] | undefined,
  nowMs: number,
): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === undefined || raw.trim().length === 0) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}
