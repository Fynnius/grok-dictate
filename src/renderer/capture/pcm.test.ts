import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, SAMPLE_RATE_HZ } from '@shared/constants.js';
import { PcmEncoder, rmsOf } from './pcm.js';

function encoder(inputSampleRate = SAMPLE_RATE_HZ): PcmEncoder {
  return new PcmEncoder({
    inputSampleRate,
    outputSampleRate: SAMPLE_RATE_HZ,
    chunkBytes: CHUNK_BYTES,
  });
}

/** Read a chunk back as signed 16-bit little-endian samples. */
function samplesOf(chunk: Uint8Array): number[] {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  return Array.from({ length: chunk.byteLength / 2 }, (_, i) => view.getInt16(i * 2, true));
}

/** One second of a sine wave, as the worklet would deliver it. */
function tone(hz: number, seconds: number, sampleRate: number): Float32Array {
  const out = new Float32Array(Math.round(sampleRate * seconds));
  for (let i = 0; i < out.length; i++) out[i] = Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

describe('chunking', () => {
  it('emits exactly-sized chunks and holds the remainder back', () => {
    const enc = encoder();
    // 1,600 samples is one chunk; the worklet posts 128-frame quanta, which do
    // not divide 1,600, so the carry across callbacks is the thing being tested.
    const chunks = enc.push(new Float32Array(1_500));
    expect(chunks).toHaveLength(0);
    expect(enc.pendingBytes).toBe(3_000);

    const more = enc.push(new Float32Array(1_800));
    expect(more).toHaveLength(2);
    expect(more.every((c) => c.byteLength === CHUNK_BYTES)).toBe(true);
    expect(enc.pendingBytes).toBe((1_500 + 1_800 - 3_200) * 2);
  });

  it('produces chunks whose ArrayBuffer is exactly the chunk (IPC transfers it)', () => {
    const chunk = encoder().push(new Float32Array(1_600))[0];
    expect(chunk).toBeDefined();
    if (chunk === undefined) return;
    expect(chunk.byteOffset).toBe(0);
    expect(chunk.buffer.byteLength).toBe(CHUNK_BYTES);
  });

  it('flushes the tail, because the last 100 ms is the end of the last word', () => {
    const enc = encoder();
    enc.push(new Float32Array(10));
    const tail = enc.flush();
    expect(tail?.byteLength).toBe(20);
    expect(enc.flush()).toBeNull();
  });

  it('does not carry pending bytes into a new encoder (warm-graph session isolation)', () => {
    // Reusing one encoder across dictations would leak the previous turn's
    // unflushed tail into the next session's first chunk. The capture
    // renderer constructs a fresh PcmEncoder per session because of this.
    const first = encoder();
    first.push(new Float32Array(100).fill(1));
    expect(first.pendingBytes).toBeGreaterThan(0);
    const second = encoder();
    const chunk = second.push(new Float32Array(1_600).fill(-1))[0];
    expect(chunk).toBeDefined();
    expect(samplesOf(chunk ?? new Uint8Array()).every((s) => s === -32_768)).toBe(true);
  });

  it('does not reuse a buffer between chunks', () => {
    const enc = encoder();
    const first = enc.push(new Float32Array(1_600).fill(1))[0];
    const second = enc.push(new Float32Array(1_600).fill(-1))[0];
    expect(samplesOf(first ?? new Uint8Array()).at(0)).toBe(32_767);
    expect(samplesOf(second ?? new Uint8Array()).at(0)).toBe(-32_768);
  });
});

describe('float → PCM16', () => {
  it('maps the full scale without wrapping', () => {
    const enc = encoder();
    enc.push(new Float32Array([0, 1, -1, 0.5, -0.5]));
    const tail = enc.flush();
    expect(tail).not.toBeNull();
    expect(samplesOf(tail ?? new Uint8Array())).toEqual([0, 32_767, -32_768, 16_384, -16_384]);
  });

  it('clamps rather than wrapping when a sample exceeds ±1', () => {
    // Auto gain control can overshoot; a wrap turns a loud syllable into a
    // click, which is exactly the kind of damage a transcript hides.
    const enc = encoder();
    enc.push(new Float32Array([2, -2, Number.POSITIVE_INFINITY]));
    expect(samplesOf(enc.flush() ?? new Uint8Array())).toEqual([32_767, -32_768, 32_767]);
  });

  it('writes little-endian, which is what the API expects', () => {
    const enc = encoder();
    enc.push(new Float32Array([0.5]));
    const tail = enc.flush() ?? new Uint8Array();
    expect([tail[0], tail[1]]).toEqual([0x00, 0x40]); // 16384 = 0x4000 LE
  });
});

describe('resampling (assumption 10.4)', () => {
  it('is a pass-through when the context really runs at 16 kHz', () => {
    const enc = encoder(SAMPLE_RATE_HZ);
    expect(enc.isPassthrough).toBe(true);
    const input = tone(440, 0.1, SAMPLE_RATE_HZ);
    const chunks = enc.push(input);
    expect(chunks).toHaveLength(1);
    // Pass-through means the samples are the input, not an approximation.
    // Negatives scale by 0x8000 and positives by 0x7fff — see `PcmEncoder`.
    const sample = input[100] ?? 0;
    const expected = Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff);
    expect(samplesOf(chunks[0] ?? new Uint8Array())[100]).toBe(expected);
  });

  it('downsamples 48 kHz to 16 kHz at the right rate', () => {
    // If Chromium ever refuses the requested rate, PCM16 at the wrong rate is
    // not an error the server can detect — it is a chipmunked transcript.
    const enc = encoder(48_000);
    expect(enc.isPassthrough).toBe(false);
    const chunks = enc.push(tone(440, 1, 48_000));
    const bytes = chunks.reduce((n, c) => n + c.byteLength, 0) + enc.pendingBytes;
    // One second in, one second out: 16,000 samples = 32,000 bytes, ±1 sample
    // of interpolation slack.
    expect(Math.abs(bytes - 32_000)).toBeLessThanOrEqual(4);
  });

  it('keeps the sample rate stable across many small blocks', () => {
    // The real thing arrives 128 frames at a time; a resampler that resets its
    // phase every callback drifts, and drift is inaudible until the transcript
    // comes back wrong.
    const enc = encoder(44_100);
    const source = tone(440, 2, 44_100);
    let bytes = 0;
    for (let i = 0; i < source.length; i += 128) {
      for (const chunk of enc.push(source.subarray(i, Math.min(i + 128, source.length)))) {
        bytes += chunk.byteLength;
      }
    }
    bytes += enc.pendingBytes;
    expect(Math.abs(bytes - 2 * 32_000)).toBeLessThanOrEqual(64);
  });

  it('upsamples too, rather than producing silence', () => {
    const enc = encoder(8_000);
    const chunks = enc.push(tone(300, 1, 8_000));
    const bytes = chunks.reduce((n, c) => n + c.byteLength, 0) + enc.pendingBytes;
    expect(Math.abs(bytes - 32_000)).toBeLessThanOrEqual(4);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('preserves the waveform well enough to be recognisable after downsampling', () => {
    // A crude but meaningful check: a 400 Hz tone downsampled from 48 kHz should
    // still cross zero about 800 times a second.
    const enc = encoder(48_000);
    const chunks = enc.push(tone(400, 1, 48_000));
    const all = chunks.flatMap((c) => samplesOf(c));
    let crossings = 0;
    for (let i = 1; i < all.length; i++) {
      const previous = all[i - 1] ?? 0;
      const current = all[i] ?? 0;
      if (previous < 0 !== current < 0) crossings++;
    }
    expect(crossings).toBeGreaterThan(700);
    expect(crossings).toBeLessThan(900);
  });

  it('rejects an odd chunk size rather than emitting misaligned samples', () => {
    expect(
      () =>
        new PcmEncoder({ inputSampleRate: 16_000, outputSampleRate: 16_000, chunkBytes: 3_201 }),
    ).toThrow(/two bytes/);
  });
});

describe('rmsOf', () => {
  it('is 0 for silence and ~0.707 for a full-scale sine', () => {
    expect(rmsOf(new Float32Array(100))).toBe(0);
    expect(rmsOf(new Float32Array(0))).toBe(0);
    expect(rmsOf(tone(440, 0.1, SAMPLE_RATE_HZ))).toBeCloseTo(Math.SQRT1_2, 2);
  });
});
