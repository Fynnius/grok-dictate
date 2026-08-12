import { describe, expect, it } from 'vitest';
import { CHUNK_BYTES, SAMPLE_RATE_HZ } from './constants.js';
import { chunkPcm, parseWav, rms, trimTrailingSilence } from './wav.js';

/** Build a WAV in memory so the tests do not depend on a recording existing. */
function makeWav(options: {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  audioFormat?: number;
  samples: number[];
}): Buffer {
  const sampleRate = options.sampleRate ?? SAMPLE_RATE_HZ;
  const channels = options.channels ?? 1;
  const bits = options.bitsPerSample ?? 16;
  const data = Buffer.alloc(options.samples.length * 2);
  options.samples.forEach((s, i) => data.writeInt16LE(s, i * 2));

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(options.audioFormat ?? 1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

describe('parseWav', () => {
  it('reads a 16 kHz mono PCM16 file', () => {
    const wav = makeWav({ samples: new Array<number>(16_000).fill(1000) });
    const result = parseWav(wav);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.sampleRate).toBe(16_000);
    expect(result.value.channels).toBe(1);
    expect(result.value.pcm.length).toBe(32_000);
    expect(result.value.durationSec).toBeCloseTo(1, 5);
  });

  it('rejects a non-WAV file with an actionable hint', () => {
    const result = parseWav(Buffer.alloc(100));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.hint).toContain('ffmpeg');
  });

  it('rejects non-16-bit audio rather than producing garbage', () => {
    const wav = makeWav({ samples: [1, 2, 3], bitsPerSample: 24 });
    const result = parseWav(wav);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('24-bit');
  });

  it('rejects compressed audio', () => {
    const wav = makeWav({ samples: [1, 2, 3], audioFormat: 3 });
    expect(parseWav(wav).ok).toBe(false);
  });

  it('clamps a data chunk that claims more bytes than the file holds', () => {
    const wav = makeWav({ samples: [1, 2, 3] });
    wav.writeUInt32LE(999_999, 40);
    const result = parseWav(wav);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.pcm.length).toBe(6);
  });
});

describe('rms', () => {
  it('is zero for silence and near one for a full-scale square wave', () => {
    expect(rms(Buffer.alloc(1000))).toBe(0);
    const loud = Buffer.alloc(1000);
    for (let i = 0; i < 500; i++) loud.writeInt16LE(i % 2 === 0 ? 32767 : -32767, i * 2);
    expect(rms(loud)).toBeCloseTo(1, 2);
  });
});

describe('trimTrailingSilence', () => {
  it('removes trailing silence but keeps the speech', () => {
    const speech = Buffer.alloc(16_000 * 2); // 1 s
    for (let i = 0; i < 16_000; i++) speech.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
    const withSilence = Buffer.concat([speech, Buffer.alloc(16_000 * 2)]);
    const trimmed = trimTrailingSilence(withSilence, SAMPLE_RATE_HZ);
    expect(trimmed.length).toBeGreaterThan(speech.length * 0.95);
    expect(trimmed.length).toBeLessThanOrEqual(speech.length + 640);
  });

  it('leaves audio that ends in speech alone', () => {
    const speech = Buffer.alloc(4000);
    for (let i = 0; i < 2000; i++) speech.writeInt16LE(i % 2 === 0 ? 8000 : -8000, i * 2);
    expect(trimTrailingSilence(speech, SAMPLE_RATE_HZ).length).toBe(speech.length);
  });
});

describe('chunkPcm', () => {
  it('splits into 3200-byte (100 ms) chunks with a short tail', () => {
    const chunks = chunkPcm(Buffer.alloc(CHUNK_BYTES * 2 + 100), CHUNK_BYTES);
    expect(chunks.map((c) => c.length)).toEqual([CHUNK_BYTES, CHUNK_BYTES, 100]);
  });
});
