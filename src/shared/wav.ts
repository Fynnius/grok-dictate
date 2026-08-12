/**
 * Minimal RIFF/WAVE reader for 16-bit PCM.
 *
 * Deliberately hand-rolled rather than pulled from npm: it is ~60 lines, it is
 * used by both the spike script and the mocked audio source, and it needs to
 * *validate* the format rather than silently accept anything. Feeding 48 kHz
 * stereo to an endpoint expecting 16 kHz mono produces a transcript that is
 * wrong in a subtle, time-wasting way, so a wrong file must be an error with a
 * usable message (§4: "Errors carry actionable text").
 */

import { appError, err, ok, type Result } from './result.js';

export interface WavAudio {
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  /** Raw little-endian PCM16 sample data, exactly as it goes on the wire. */
  readonly pcm: Buffer;
  readonly durationSec: number;
}

const RIFF = 0x46464952; // 'RIFF' little-endian
const WAVE = 0x45564157; // 'WAVE'
const FMT_ = 0x20746d66; // 'fmt '
const DATA = 0x61746164; // 'data'
const WAVE_FORMAT_PCM = 1;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export function parseWav(buffer: Buffer, label = 'WAV'): Result<WavAudio> {
  const bad = (message: string, hint: string): Result<WavAudio> =>
    err(appError('config_invalid', `${label}: ${message}`, hint));

  if (buffer.length < 44) return bad('file is too short to be a WAV', 'Re-record the file.');
  if (buffer.readUInt32LE(0) !== RIFF || buffer.readUInt32LE(8) !== WAVE) {
    return bad(
      'not a RIFF/WAVE file',
      'Convert it with: ffmpeg -i in -ac 1 -ar 16000 -sample_fmt s16 out.wav',
    );
  }

  let offset = 12;
  let format: {
    audioFormat: number;
    channels: number;
    sampleRate: number;
    bitsPerSample: number;
  } | null = null;
  let pcm: Buffer | null = null;

  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.readUInt32LE(offset);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;

    if (chunkId === FMT_ && body + 16 <= buffer.length) {
      format = {
        audioFormat: buffer.readUInt16LE(body),
        channels: buffer.readUInt16LE(body + 2),
        sampleRate: buffer.readUInt32LE(body + 4),
        bitsPerSample: buffer.readUInt16LE(body + 14),
      };
    } else if (chunkId === DATA) {
      // A truncated recording can declare more data than it holds; clamp rather
      // than reading past the end.
      pcm = buffer.subarray(body, Math.min(body + chunkSize, buffer.length));
    }
    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + chunkSize + (chunkSize % 2);
  }

  if (format === null) return bad('no `fmt ` chunk', 'The file is malformed; re-record it.');
  if (pcm === null) return bad('no `data` chunk', 'The file is malformed; re-record it.');
  if (format.audioFormat !== WAVE_FORMAT_PCM && format.audioFormat !== WAVE_FORMAT_EXTENSIBLE) {
    return bad(
      `audio format ${String(format.audioFormat)} is not PCM`,
      'Convert with: ffmpeg -i in -ac 1 -ar 16000 -sample_fmt s16 out.wav',
    );
  }
  if (format.bitsPerSample !== 16) {
    return bad(
      `${String(format.bitsPerSample)}-bit samples; 16-bit is required`,
      'Convert with: ffmpeg -i in -ac 1 -ar 16000 -sample_fmt s16 out.wav',
    );
  }

  const bytesPerFrame = (format.bitsPerSample / 8) * format.channels;
  return ok({
    sampleRate: format.sampleRate,
    channels: format.channels,
    bitsPerSample: format.bitsPerSample,
    pcm,
    durationSec: pcm.length / bytesPerFrame / format.sampleRate,
  });
}

/** Root-mean-square amplitude of PCM16 data, normalised to 0..1. */
export function rms(pcm: Buffer | Uint8Array): number {
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const samples = Math.floor(pcm.byteLength / 2);
  if (samples === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples; i++) {
    const s = view.getInt16(i * 2, true) / 32768;
    sum += s * s;
  }
  return Math.sqrt(sum / samples);
}

/**
 * Trim trailing near-silence.
 *
 * Spike 2 measures end-of-audio → `speech_final`. If the recording ends with
 * silence, the server's endpointing fires *before* we send `finalize` or
 * `audio.done` and the measurement is of the silence, not of the message. This
 * removes that confound.
 */
export function trimTrailingSilence(
  pcm: Buffer,
  sampleRate: number,
  thresholdRms = 0.005,
  windowMs = 20,
): Buffer {
  const windowSamples = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  const windowBytes = windowSamples * 2;
  let end = pcm.length;
  while (end >= windowBytes) {
    if (rms(pcm.subarray(end - windowBytes, end)) > thresholdRms) break;
    end -= windowBytes;
  }
  return pcm.subarray(0, end);
}

/** Split PCM into fixed-size chunks; the last one may be short. */
export function chunkPcm(pcm: Buffer, chunkBytes: number): Buffer[] {
  const chunks: Buffer[] = [];
  for (let i = 0; i < pcm.length; i += chunkBytes) {
    chunks.push(pcm.subarray(i, Math.min(i + chunkBytes, pcm.length)));
  }
  return chunks;
}
