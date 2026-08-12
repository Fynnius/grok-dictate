/**
 * Mocked microphone — Phase 1 walking skeleton.
 *
 * Replays canned PCM on a realistic timeline instead of opening a device, so
 * the whole pipeline runs with no microphone and no permission grant.
 * Phase 3 replaces this with the hidden capture renderer
 * (IMPLEMENTATION-PLAN.md §3.3) behind the same `AudioSourcePort`.
 *
 * It reproduces the two behaviours that matter downstream:
 *   - 100 ms / 3,200-byte chunks;
 *   - the full-utterance buffer, which is load-bearing for
 *     retry-after-failure and language replay, not an optimisation.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { AudioHandlers, AudioSourcePort } from '@contracts/ports.js';
import { CHUNK_BYTES, CHUNK_DURATION_MS, SAMPLE_RATE_HZ } from '@shared/constants.js';
import { appError } from '@shared/result.js';
import { chunkPcm, parseWav, rms } from '@shared/wav.js';

export interface MockAudioOptions {
  /** PCM16 mono @16 kHz. Defaults to a synthetic tone if no fixture is given. */
  readonly pcm?: Buffer;
  /** Wall-clock spacing between chunks. 0 replays as fast as the event loop allows. */
  readonly chunkIntervalMs?: number;
  /** Loop the source so a hold longer than the fixture keeps producing audio. */
  readonly loop?: boolean;
  /** Fail the device open, to exercise the error path. */
  readonly failWith?: 'permission' | 'device';
}

/** A 440 Hz tone — audible in a debug dump, and non-silent for RMS meters. */
function syntheticPcm(seconds = 3): Buffer {
  const samples = SAMPLE_RATE_HZ * seconds;
  const buffer = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE_HZ) * 8000),
      i * 2,
    );
  }
  return buffer;
}

/** Load a recorded fixture if present, else fall back to the tone. */
export function loadFixturePcm(path: string): Buffer {
  if (!existsSync(path)) return syntheticPcm();
  const parsed = parseWav(readFileSync(path), path);
  return parsed.ok ? parsed.value.pcm : syntheticPcm();
}

export class MockAudioSource implements AudioSourcePort {
  readonly #options: MockAudioOptions;
  readonly #pcm: Buffer;
  readonly #buffers = new Map<string, Buffer[]>();
  #timer: NodeJS.Timeout | null = null;
  #activeSession: string | null = null;

  constructor(options: MockAudioOptions = {}) {
    this.#options = options;
    this.#pcm = options.pcm ?? syntheticPcm();
  }

  start(sessionId: string, handlers: AudioHandlers): void {
    this.#stopTimer();
    this.#activeSession = sessionId;
    this.#buffers.set(sessionId, []);

    if (this.#options.failWith !== undefined) {
      const error =
        this.#options.failWith === 'permission'
          ? appError(
              'audio_permission',
              'Grok Dictate cannot use the microphone.',
              'Grant Microphone access in System Settings → Privacy & Security → Microphone, then try again.',
            )
          : appError(
              'audio_device',
              'No microphone is available.',
              'Connect or select an input device in System Settings → Sound.',
            );
      queueMicrotask(() => handlers.onError(error));
      return;
    }

    const chunks = chunkPcm(this.#pcm, CHUNK_BYTES);
    let index = 0;
    const interval = this.#options.chunkIntervalMs ?? CHUNK_DURATION_MS;

    // Report the device as open on the next tick, mirroring the real renderer:
    // capture begins slightly after `start()` returns, which is precisely why
    // the STT port buffers pre-connect PCM.
    queueMicrotask(() => handlers.onStarted(SAMPLE_RATE_HZ));

    const emit = (): void => {
      if (this.#activeSession !== sessionId) return;
      if (index >= chunks.length) {
        if (this.#options.loop === true) index = 0;
        else return;
      }
      const chunk = chunks[index++];
      if (chunk === undefined) return;
      this.#buffers.get(sessionId)?.push(chunk);
      handlers.onChunk(new Uint8Array(chunk));
      handlers.onLevel(rms(chunk));
    };

    if (interval === 0) {
      while (index < chunks.length) emit();
      return;
    }
    this.#timer = setInterval(emit, interval);
    this.#timer.unref?.();
  }

  stop(sessionId: string): void {
    if (this.#activeSession !== sessionId) return;
    this.#stopTimer();
    this.#activeSession = null;
  }

  cancel(sessionId: string): void {
    this.stop(sessionId);
    // Esc discards the audio as well as the text.
    this.#buffers.delete(sessionId);
  }

  getUtteranceBuffer(sessionId: string): Uint8Array | null {
    const parts = this.#buffers.get(sessionId);
    return parts === undefined ? null : new Uint8Array(Buffer.concat(parts));
  }

  #stopTimer(): void {
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }
}
