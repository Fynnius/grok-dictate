/**
 * Float32 audio → the PCM16 the xAI socket wants, in fixed-size chunks.
 *
 * Pure and DOM-free on purpose: this is the one piece of the capture path that
 * can be tested without a microphone, a window server or a permission grant, so
 * everything fiddly lives here rather than in `main.ts`.
 *
 * Two requirements it exists to meet (IMPLEMENTATION-PLAN.md §3.3):
 *
 *   - **PCM16 mono 16 kHz in 100 ms / 3,200-byte chunks**. The `AudioWorklet` renders in quanta of
 *     128 frames, which does not divide 1,600, so chunk assembly has to carry
 *     across callbacks.
 *
 *   - **"Verify the `AudioContext` genuinely runs at 16 kHz and isn't
 *     double-resampling (assumption 10.4); if it is, downsample explicitly."**
 *     Chromium honours `new AudioContext({sampleRate: 16000})` on every device
 *     we have tried, in which case `inputSampleRate === outputSampleRate` and
 *     the resampler is a no-op fast path. The interpolating path exists so that
 *     a device which refuses degrades to slightly-worse audio rather than to
 *     garbage: PCM16 at the wrong rate is not an error the server can detect, it
 *     is a transcript that comes back chipmunked.
 */

export interface PcmEncoderOptions {
  /** The `AudioContext`'s real sample rate, whatever it turned out to be. */
  readonly inputSampleRate: number;
  /** 16,000 — what goes on the wire. */
  readonly outputSampleRate: number;
  /** 3,200 bytes = 100 ms at 16 kHz PCM16 mono. */
  readonly chunkBytes: number;
}

export class PcmEncoder {
  readonly #ratio: number;
  readonly #chunkBytes: number;

  #pending: Uint8Array;
  #fill = 0;
  /** Input samples not yet consumed by the resampler, kept across callbacks. */
  #carry = new Float32Array(0);
  /** Fractional read position into `carry ++ nextBlock`. */
  #position = 0;

  constructor(options: PcmEncoderOptions) {
    if (options.chunkBytes % 2 !== 0) {
      throw new Error('chunkBytes must be even: PCM16 samples are two bytes');
    }
    this.#ratio = options.inputSampleRate / options.outputSampleRate;
    this.#chunkBytes = options.chunkBytes;
    this.#pending = new Uint8Array(options.chunkBytes);
  }

  /** True when the context gave us the rate we asked for (assumption 10.4). */
  get isPassthrough(): boolean {
    return this.#ratio === 1;
  }

  /** Bytes held back waiting for a full chunk. */
  get pendingBytes(): number {
    return this.#fill;
  }

  /**
   * Consume one render block. Returns every complete chunk it produced — often
   * none, sometimes two.
   */
  push(samples: Float32Array): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    if (this.#ratio === 1) {
      for (const sample of samples) this.#write(sample, chunks);
      return chunks;
    }

    const work = this.#carry.length === 0 ? samples : concat(this.#carry, samples);

    let position = this.#position;
    // `position + 1 < length` because linear interpolation needs the sample
    // after the one it is standing on.
    while (position + 1 < work.length) {
      const index = Math.floor(position);
      const fraction = position - index;
      const a = work[index] ?? 0;
      const b = work[index + 1] ?? 0;
      this.#write(a + (b - a) * fraction, chunks);
      position += this.#ratio;
    }

    const consumed = Math.min(Math.floor(position), work.length);
    this.#carry = work.slice(consumed);
    this.#position = position - consumed;
    return chunks;
  }

  /**
   * The tail of the utterance, shorter than a full chunk.
   *
   * Worth sending rather than dropping: it is up to 100 ms, and the last 100 ms
   * of a push-to-talk hold is the end of the last word.
   */
  flush(): Uint8Array | null {
    if (this.#fill === 0) return null;
    const tail = this.#pending.slice(0, this.#fill);
    this.#pending = new Uint8Array(this.#chunkBytes);
    this.#fill = 0;
    return tail;
  }

  #write(sample: number, chunks: Uint8Array[]): void {
    // Clamp then scale asymmetrically: int16 runs -32768..32767, so using
    // 32768 for the negative side and 32767 for the positive avoids wrapping a
    // full-scale +1.0 round to -32768.
    const clamped = sample < -1 ? -1 : sample > 1 ? 1 : sample;
    const value = Math.round(clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff);
    this.#pending[this.#fill++] = value & 0xff;
    this.#pending[this.#fill++] = (value >> 8) & 0xff;
    if (this.#fill === this.#chunkBytes) {
      chunks.push(this.#pending);
      // A fresh buffer per chunk, so the one handed out is exactly chunk-sized
      // and its `.buffer` can be transferred over IPC without a copy or a
      // surprise offset.
      this.#pending = new Uint8Array(this.#chunkBytes);
      this.#fill = 0;
    }
  }
}

function concat(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

/** RMS amplitude, 0..1, for the HUD level meter. */
export function rmsOf(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
