import { describe, expect, it } from 'vitest';
import { audioConstraints } from './constraints.js';

describe('audioConstraints', () => {
  it('asks for raw capture when microphone processing is off', () => {
    expect(audioConstraints(false)).toEqual({
      channelCount: { ideal: 1 },
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    });
  });

  it('asks for Chromium telephony DSP when microphone processing is on', () => {
    expect(audioConstraints(true)).toEqual({
      channelCount: { ideal: 1 },
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });
});
