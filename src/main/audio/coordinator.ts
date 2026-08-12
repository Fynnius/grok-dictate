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

import type { MainToRenderer, RendererToMain } from '@contracts/events.js';
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
}

/**
 * How many finished utterances to keep addressable. One is the live session, one
 * is the session that just ended — which is the one a retry would want. Older
 * than that is memory nobody can reach.
 */
const RETAINED_UTTERANCES = 2;

export class CaptureCoordinator implements AudioSourcePort {
  readonly #transport: CaptureTransport;
  readonly #log: Logger;
  readonly #maxBufferBytes: number;
  readonly #checkPermission: () => AppError | null;

  readonly #buffers = new Map<string, Utterance>();
  #active: ActiveSession | null = null;

  constructor(options: CoordinatorOptions) {
    this.#transport = options.transport;
    this.#log = options.logger.child('audio');
    this.#maxBufferBytes = options.maxBufferBytes ?? MAX_UTTERANCE_BUFFER_BYTES;
    this.#checkPermission = options.checkPermission ?? (() => null);
  }

  /* ---------------- AudioSourcePort ---------------- */

  start(sessionId: string, handlers: AudioHandlers): void {
    // Press supersedes press (`pipeline.rs:50-63`): a rapid stop→start must
    // abort the previous capture rather than leave two sessions on the device.
    if (this.#active !== null && this.#active.sessionId !== sessionId) {
      this.#log.debug('superseding an active capture', {
        previous: this.#active.sessionId,
        next: sessionId,
      });
      this.#transport.send({ type: 'capture-stop', sessionId: this.#active.sessionId });
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

    this.#active = { sessionId, handlers, started: false };
    this.#buffers.set(sessionId, { chunks: [], bytes: 0, truncated: false });
    this.#prune();

    this.#transport.send({
      type: 'capture-start',
      sessionId,
      sampleRate: SAMPLE_RATE_HZ,
      chunkBytes: CHUNK_BYTES,
    });
  }

  /** Graceful end of turn: close the device, keep the audio. */
  stop(sessionId: string): void {
    if (this.#active?.sessionId !== sessionId) return;
    this.#active = null;
    this.#transport.send({ type: 'capture-stop', sessionId });
    const buffer = this.#buffers.get(sessionId);
    this.#log.debug('capture stopped', {
      sessionId,
      seconds: buffer === undefined ? 0 : Number((buffer.bytes / 32_000).toFixed(2)),
    });
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
    this.stop(sessionId);
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
      this.#onStarted(message.sessionId, message.actualSampleRate);
      return true;
    }
    if (message.type === 'capture-error') {
      this.#onError(message.sessionId, message.error);
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

  #onStarted(sessionId: string, actualSampleRate: number): void {
    const session = this.#forSession(sessionId);
    if (session === null) return;

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
    this.#active = null;
    this.#log.warn('capture failed', { sessionId, code: error.code });
    session.handlers.onError(error);
  }

  /** Late frames from a superseded session must never reach the new one. */
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
    if (this.#active !== null) {
      this.#transport.send({ type: 'capture-stop', sessionId: this.#active.sessionId });
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
