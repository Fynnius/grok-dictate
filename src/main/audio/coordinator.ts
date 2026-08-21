/**
 * The main-process half of audio capture: session bookkeeping and the
 * full-utterance buffer.
 *
 * Electron-free on purpose. The capture renderer needs a window, a permission
 * grant and a microphone; the rules about *which* audio belongs to *which*
 * session, what happens when a press supersedes a press, and how much PCM may
 * be held do not — so they live here, where they are unit tests.
 *
 * ## The full-utterance buffer is load-bearing
 *
 * : "Needed three times over: retry-after-failed-insertion,
 * Layer-2 language replay, and retry-after-network-failure. … **This is a
 * load-bearing design decision, not an optimisation** — build it in from the
 * start." One of those three uses died with spike 1 (there is no Layer 2), but
 * the other two are live.
 *
 * At 16 kHz PCM16 mono the cost is 32 KB/s. `MAX_UTTERANCE_BUFFER_BYTES` bounds
 * it at the recording cap — 6 minutes, ~11.5 MB — and the orchestrator's own cap
 * timer fires at exactly that point, so the ceiling here is a backstop rather
 * than something reached in normal use.
 */

import type { CaptureTrackSettings, MainToRenderer, RendererToMain } from '@contracts/events.js';
import type { AudioHandlers, AudioSourcePort } from '@contracts/ports.js';
import { CHUNK_BYTES, MAX_UTTERANCE_BUFFER_BYTES, SAMPLE_RATE_HZ } from '@shared/constants.js';
import type { Logger } from '@shared/logger.js';
import type { AppError } from '@shared/result.js';

export interface CaptureTransport {
  /** Deliver a message to the capture renderer. */
  send(message: MainToRenderer): void;
}

export interface CoordinatorOptions {
  readonly transport: CaptureTransport;
  readonly logger: Logger;
  readonly maxBufferBytes?: number;
  /** Test seam for `DRAIN_TIMEOUT_MS`; production always uses the constant. */
  readonly drainTimeoutMs?: number;
  /**
   * Pre-flight microphone check, before the renderer is asked to do anything.
   * Returns an actionable error when the device may not be opened, `null` to go
   * ahead. Injected because it is `systemPreferences.getMediaAccessStatus`,
   * which needs Electron.
   */
  readonly checkPermission?: () => AppError | null;
}

interface Utterance {
  readonly chunks: Uint8Array[];
  bytes: number;
  truncated: boolean;
}

interface ActiveSession {
  readonly sessionId: string;
  readonly handlers: AudioHandlers;
  started: boolean;
  /**
   * `stop()` has been sent and we are waiting for the renderer's tail chunk.
   * The session is still addressable — that is the entire point.
   */
  draining: boolean;
  drainTimer: NodeJS.Timeout | null;
}

/**
 * How many finished utterances to keep addressable. One is the live session, one
 * is the session that just ended — which is the one a retry would want. Older
 * than that is memory nobody can reach.
 */
const RETAINED_UTTERANCES = 2;

/**
 * How long to wait for the renderer's `capture-drained` before ending the turn
 * anyway.
 *
 * **Chosen, not measured.** What has to fit inside it is one IPC round trip and
 * one `encoder.flush()` — microseconds of work in a window that has just been
 * told to stop, so the interesting figure is not the happy path but the ceiling
 * on a busy or wedged renderer. 250 ms is the largest delay that stays under
 * the ~300 ms end-of-audio → `speech_final` latency the spikes measured, so in
 * the worst case the drain hides inside a wait the user was already having; and
 * it is short enough that a renderer which has died outright costs a pause
 * rather than a hang.
 *
 * The timer exists because a dead renderer must not be able to hang a turn. The
 * dictation is held open until the drain completes, so this is the only thing
 * standing between a wedged capture window and a session parked in `processing`
 * for ever. It fires, it logs, and the turn goes on with whatever arrived.
 */
export const DRAIN_TIMEOUT_MS = 250;

export class CaptureCoordinator implements AudioSourcePort {
  readonly #transport: CaptureTransport;
  readonly #log: Logger;
  readonly #maxBufferBytes: number;
  readonly #checkPermission: () => AppError | null;
  readonly #drainTimeoutMs: number;

  readonly #buffers = new Map<string, Utterance>();
  #active: ActiveSession | null = null;

  constructor(options: CoordinatorOptions) {
    this.#transport = options.transport;
    this.#log = options.logger.child('audio');
    this.#maxBufferBytes = options.maxBufferBytes ?? MAX_UTTERANCE_BUFFER_BYTES;
    this.#checkPermission = options.checkPermission ?? (() => null);
    this.#drainTimeoutMs = options.drainTimeoutMs ?? DRAIN_TIMEOUT_MS;
  }

  /* ---------------- AudioSourcePort ---------------- */

  start(sessionId: string, handlers: AudioHandlers): void {
    // Press supersedes press (`pipeline.rs:50-63`): a rapid stop→start must
    // abort the previous capture rather than leave two sessions on the device.
    if (this.#active !== null && this.#active.sessionId !== sessionId) {
      const previous = this.#active;
      this.#log.debug('superseding an active capture', {
        previous: previous.sessionId,
        next: sessionId,
      });
      // A session already draining has had its `capture-stop`; sending a second
      // would be noise. Either way its drain ends here — there is no longer
      // anywhere for a late chunk of it to go, and the waiter must be released
      // rather than left for the timer.
      if (previous.draining) this.#endDrain(previous, 'superseded');
      else this.#transport.send({ type: 'capture-stop', sessionId: previous.sessionId });
    }

    const denied = this.#checkPermission();
    if (denied !== null) {
      // Never even ask the renderer: opening the device would light the orange
      // indicator on a session that cannot work.
      this.#active = null;
      this.#log.warn('capture refused before opening the device', { code: denied.code });
      queueMicrotask(() => {
        handlers.onError(denied);
      });
      return;
    }

    this.#active = { sessionId, handlers, started: false, draining: false, drainTimer: null };
    this.#buffers.set(sessionId, { chunks: [], bytes: 0, truncated: false });
    this.#prune();

    this.#transport.send({
      type: 'capture-start',
      sessionId,
      sampleRate: SAMPLE_RATE_HZ,
      chunkBytes: CHUNK_BYTES,
    });
  }

  /**
   * Graceful end of turn: close the device, keep the audio — **in two phases**.
   *
   * Phase one is this method: tell the renderer to stop, and mark the session
   * `draining`. Phase two is `capture-drained` (or the timeout), which releases
   * the session and calls `onDrained`.
   *
   * Until the 2026-08-09 incident this method set `#active = null` on the spot.
   * The renderer flushes its encoder tail as a final `capture-chunk` *after*
   * `capture-stop` reaches it — its own comment says "the last 100 ms of a hold
   * is the end of the last word" — so that chunk arrived to a `#forSession`
   * that returned null and was dropped, on every dictation, while the
   * orchestrator had already sent `audio.done` regardless. The renderer's
   * tail-flush was dead code and the last ~100–300 ms of every utterance never
   * reached the server: clipped or wrong final words, and a full-utterance
   * buffer that was missing the same tail.
   */
  stop(sessionId: string): void {
    const session = this.#active;
    if (session === null || session.sessionId !== sessionId) return;
    if (session.draining) return; // already asked; the tail is in flight

    session.draining = true;
    this.#transport.send({ type: 'capture-stop', sessionId });

    const timer = setTimeout(() => {
      // The renderer never answered. Proceed rather than hold the turn open —
      // and say so, because a renderer that stops acknowledging is a real
      // failure even though the dictation survives it.
      this.#log.warn('the capture renderer did not acknowledge the tail; ending the turn anyway', {
        sessionId,
        timeoutMs: this.#drainTimeoutMs,
      });
      this.#endDrain(session, 'timeout');
    }, this.#drainTimeoutMs);
    timer.unref?.();
    session.drainTimer = timer;
  }

  /**
   * Release a draining session and let the turn end.
   *
   * `draining` is the latch as well as the flag, so an ack that races the
   * timeout — or a duplicate ack, or a supersede on top of either — produces
   * exactly **one** `onDrained`. That is what the port promises its caller, and
   * the caller ends the turn from it.
   */
  #endDrain(session: ActiveSession, reason: 'ack' | 'timeout' | 'superseded' | 'cancelled'): void {
    if (!session.draining) return;
    session.draining = false;
    if (session.drainTimer !== null) {
      clearTimeout(session.drainTimer);
      session.drainTimer = null;
    }
    if (this.#active === session) this.#active = null;

    const buffer = this.#buffers.get(session.sessionId);
    this.#log.debug('capture stopped', {
      sessionId: session.sessionId,
      reason,
      seconds: buffer === undefined ? 0 : Number((buffer.bytes / 32_000).toFixed(2)),
    });
    session.handlers.onDrained();
  }

  /**
   * Discard the session and free its audio, per the port contract.
   *
   * Phase 3 moved the bytes to a single-slot archive instead of freeing them,
   * on the grounds that  lists "retry-after-network-failure"
   * as one of the three reasons the buffer exists, and that the state machine
   * reaches this method by two routes that are indistinguishable from here:
   * `CANCEL` (Esc — the user meant it) and `SESSION_ERROR` (the network
   * dropped — the user did not). It then recorded that nothing consumed the
   * archive and asked Phase 5 to wire it up or delete it rather than leave it
   * as decoration (docs/phase-3-report.md §5.3).
   *
   * **Deleted.** Re-submitting the PCM needs a second turn whose transcript has
   * to be reconciled with the text the first turn already committed, and that
   * design does not exist. Meanwhile the machine now keeps the *text* through a
   * mid-utterance failure (`contracts/state-machine.md` §10), which covers the
   * realistic recovery — the user gets what was heard and re-dictates the rest.
   * Against a hypothetical feature, an Esc-cancelled utterance sitting in RAM
   * until the next cancel overwrites it is a real cost:  point
   * about this product accumulating everything the user says applies to memory
   * as much as to the history file.
   */
  cancel(sessionId: string): void {
    const session = this.#active;
    if (session !== null && session.sessionId === sessionId) {
      if (!session.draining) {
        session.draining = true;
        this.#transport.send({ type: 'capture-stop', sessionId });
      }
      // Closed at once rather than drained. Esc throws the audio away, so there
      // is nothing for a tail chunk to be kept for, and holding the session
      // open would delay teardown by the drain timeout for no gain.
      this.#endDrain(session, 'cancelled');
    }

    const buffer = this.#buffers.get(sessionId);
    this.#buffers.delete(sessionId);
    if (buffer === undefined || buffer.bytes === 0) return;
    this.#log.info('utterance discarded', {
      sessionId,
      seconds: Number((buffer.bytes / 32_000).toFixed(2)),
    });
  }

  getUtteranceBuffer(sessionId: string): Uint8Array | null {
    const buffer = this.#buffers.get(sessionId);
    if (buffer === undefined) return null;
    return concat(buffer.chunks, buffer.bytes);
  }

  /* ---------------- renderer → main ---------------- */

  /**
   * Returns true when the message belonged to capture and was consumed.
   *
   * An `if` chain rather than a `switch`: this handler deliberately covers only
   * four of `RendererToMain`'s members, and an exhaustive switch would have to
   * name every message Phase 4 owns just to ignore it.
   */
  handleRendererMessage(message: RendererToMain): boolean {
    if (message.type === 'capture-chunk') {
      this.#onChunk(message.sessionId, new Uint8Array(message.pcm));
      return true;
    }
    if (message.type === 'capture-level') {
      this.#forSession(message.sessionId)?.handlers.onLevel(message.level);
      return true;
    }
    if (message.type === 'capture-started') {
      this.#onStarted(message.sessionId, message.actualSampleRate, message.trackSettings);
      return true;
    }
    if (message.type === 'capture-error') {
      this.#onError(message.sessionId, message.error);
      return true;
    }
    if (message.type === 'capture-drained') {
      const session = this.#forSession(message.sessionId);
      if (session !== null) this.#endDrain(session, 'ack');
      return true;
    }
    return false;
  }

  #onChunk(sessionId: string, pcm: Uint8Array): void {
    const session = this.#forSession(sessionId);
    if (session === null) return;

    const buffer = this.#buffers.get(sessionId);
    if (buffer !== undefined) {
      if (buffer.bytes + pcm.byteLength <= this.#maxBufferBytes) {
        buffer.chunks.push(pcm);
        buffer.bytes += pcm.byteLength;
      } else if (!buffer.truncated) {
        // Keep the beginning: the recording cap ends the turn at this point
        // anyway, and the start of the utterance is the part worth having.
        buffer.truncated = true;
        this.#log.warn('utterance buffer full; stopped retaining audio', {
          sessionId,
          maxBytes: this.#maxBufferBytes,
        });
      }
    }

    session.handlers.onChunk(pcm);
  }

  #onStarted(
    sessionId: string,
    actualSampleRate: number,
    trackSettings?: CaptureTrackSettings,
  ): void {
    const session = this.#forSession(sessionId);
    if (session === null) return;

    // What Chromium's audio processing actually applied, as opposed to what the
    // renderer asked for. It is tuned for telephony rather than for a
    // recogniser, and whether it helps accuracy here has never been measured —
    // which is impossible without these values sitting in the log beside the
    // transcript they produced. See `AUDIO_CONSTRAINTS` in the capture renderer.
    if (trackSettings !== undefined) {
      this.#log.info('microphone processing as applied by the device', {
        sessionId,
        ...trackSettings,
      });
    }

    if (actualSampleRate !== SAMPLE_RATE_HZ) {
      // Assumption 10.4 was "Electron `getUserMedia` + AudioWorklet at 16 kHz
      // yields PCM the API accepts". If this fires, the AudioContext refused the
      // requested rate and `PcmEncoder` is resampling explicitly — which works,
      // but is worth knowing rather than discovering through a bad transcript.
      this.#log.warn('the AudioContext did not run at 16 kHz; resampling explicitly', {
        actualSampleRate,
        expected: SAMPLE_RATE_HZ,
      });
    }
    if (session.started) {
      // A mid-hold device change re-announces the device.
      this.#log.info('capture device restarted mid-session', { sessionId, actualSampleRate });
      return;
    }
    session.started = true;
    session.handlers.onStarted(actualSampleRate);
  }

  #onError(sessionId: string, error: AppError): void {
    const session = this.#forSession(sessionId);
    if (session === null) return;
    // A device that failed mid-drain has no tail to deliver, and the pending
    // timer would otherwise fire `onDrained` on a session the machine has
    // already torn down.
    if (session.drainTimer !== null) {
      clearTimeout(session.drainTimer);
      session.drainTimer = null;
    }
    session.draining = false;
    this.#active = null;
    this.#log.warn('capture failed', { sessionId, code: error.code });
    session.handlers.onError(error);
  }

  /**
   * Late frames from a superseded session must never reach the new one.
   *
   * A *draining* session is deliberately still addressable: the whole point of
   * the two-phase stop is that its tail chunk still counts (BUG-2).
   */
  #forSession(sessionId: string): ActiveSession | null {
    const active = this.#active;
    if (active === null || active.sessionId !== sessionId) return null;
    return active;
  }

  #prune(): void {
    while (this.#buffers.size > RETAINED_UTTERANCES) {
      const oldest = this.#buffers.keys().next();
      if (oldest.done === true) return;
      this.#buffers.delete(oldest.value);
    }
  }

  /** Close the device and forget everything. Called on quit. */
  dispose(): void {
    const session = this.#active;
    if (session !== null) {
      if (session.drainTimer !== null) clearTimeout(session.drainTimer);
      // No `onDrained` here: the application is quitting, and calling back into
      // a machine that is being torn down is how a shutdown grows a race.
      if (!session.draining) {
        this.#transport.send({ type: 'capture-stop', sessionId: session.sessionId });
      }
      this.#active = null;
    }
    this.#buffers.clear();
  }
}

function concat(chunks: readonly Uint8Array[], bytes: number): Uint8Array {
  const out = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
