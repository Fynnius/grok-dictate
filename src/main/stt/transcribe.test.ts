import { describe, expect, it } from 'vitest';
import { DEFAULT_SCRIPT, MockSttClient } from '@mocks/mock-stt.js';
import { CHUNK_BYTES } from '@shared/constants.js';
import { transcribePcm } from './transcribe.js';

describe('transcribePcm', () => {
  it('ships the wav as chunks and returns the speech_final text', async () => {
    const stt = new MockSttClient({
      ...DEFAULT_SCRIPT,
      connectMs: 5,
      finalAfterFinishMs: 5,
      partials: [],
    });
    const pcm = new Uint8Array(CHUNK_BYTES * 2).fill(1);
    const result = await transcribePcm(stt, pcm, {
      language: 'de',
      endpointingMs: 400,
      keyterms: ['kubectl'],
      useFinalize: false,
      repairSeams: true,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.text).toBe(DEFAULT_SCRIPT.finalText);
    expect(result.value.durationSec).toBe(DEFAULT_SCRIPT.durationSec);
    expect(result.value.language).toBe(DEFAULT_SCRIPT.detectedLanguage);
    expect(stt.turns[0]?.options).toMatchObject({ language: 'de', keyterms: ['kubectl'] });
  });
});
