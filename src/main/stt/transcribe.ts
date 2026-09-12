/**
 * One-shot transcription of already-captured PCM — History Retry.
 *
 * Reuses `startTurn` and ships the wav as ordinary chunks. Does not insert;
 * the caller writes the text back onto the history row.
 */

import { randomUUID } from 'node:crypto';
import type { SttModel } from '@contracts/config.js';
import type { SttClientPort } from '@contracts/ports.js';
import { CHUNK_BYTES } from '@shared/constants.js';
import { err, ok, type Result } from '@shared/result.js';
import { stitchSegments } from '@shared/stitch.js';
import { chunkPcm } from '@shared/wav.js';

export interface TranscribePcmOptions {
  readonly language: string | null;
  readonly endpointingMs: number;
  readonly keyterms: readonly string[];
  readonly useFinalize: boolean;
  readonly model?: SttModel;
  readonly repairSeams: boolean;
}

export interface TranscribePcmResult {
  readonly text: string;
  readonly durationSec: number | null;
  readonly language: string | null;
}

export function transcribePcm(
  stt: SttClientPort,
  pcm: Uint8Array,
  options: TranscribePcmOptions,
): Promise<Result<TranscribePcmResult>> {
  return new Promise((resolve) => {
    const finals: string[] = [];
    let lastInterim = '';
    let detected: string | null = null;
    const turn = stt.startTurn(
      {
        sessionId: `retry-${randomUUID()}`,
        language: options.language,
        endpointingMs: options.endpointingMs,
        keyterms: options.keyterms,
        useFinalize: options.useFinalize,
        ...(options.model === undefined ? {} : { model: options.model }),
      },
      {
        onReady: () => undefined,
        onInterim: (text) => {
          lastInterim = text;
        },
        onFinal: (text) => {
          finals.push(text);
          lastInterim = '';
        },
        onLanguageDetected: (code) => {
          detected = code;
        },
        onDone: (durationSec) => {
          const text =
            finals.length > 0 ? stitchSegments(finals, options.repairSeams) : lastInterim.trim();
          resolve(ok({ text, durationSec, language: detected }));
        },
        onError: (error) => {
          resolve(err(error));
        },
      },
    );
    const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    for (const chunk of chunkPcm(bytes, CHUNK_BYTES)) {
      turn.sendPcm(chunk);
    }
    turn.finish();
  });
}
