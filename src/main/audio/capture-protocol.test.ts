import { describe, expect, it } from 'vitest';
import {
  captureFrameToRenderer,
  encodeCaptureCommand,
  parseCaptureFrame,
} from './capture-protocol.js';

describe('capture protocol', () => {
  it('encodes a start command as one JSON line', () => {
    expect(
      encodeCaptureCommand({
        type: 'start',
        sessionId: 's1',
        sampleRate: 16_000,
        chunkBytes: 3200,
      }),
    ).toBe('{"type":"start","sessionId":"s1","sampleRate":16000,"chunkBytes":3200}\n');
  });

  it('parses started, level, drained and error', () => {
    const started = parseCaptureFrame(
      '{"type":"started","sessionId":"s1","actualSampleRate":16000}',
    );
    expect(started).toEqual({
      ok: true,
      value: { type: 'started', sessionId: 's1', actualSampleRate: 16_000 },
    });

    const drained = parseCaptureFrame('{"type":"drained","sessionId":"s1"}');
    expect(drained).toEqual({ ok: true, value: { type: 'drained', sessionId: 's1' } });

    const error = parseCaptureFrame(
      '{"type":"error","sessionId":"s1","code":"audio_permission","message":"no","hint":"grant it"}',
    );
    expect(error.ok).toBe(true);
    if (!error.ok) return;
    expect(error.value).toMatchObject({ type: 'error', code: 'audio_permission' });
  });

  it('treats malformed and unknown lines as failures, not throws', () => {
    expect(parseCaptureFrame('this is not json').ok).toBe(false);
    expect(parseCaptureFrame('[1,2,3]').ok).toBe(false);
    expect(parseCaptureFrame('{"type":"from_the_future"}').ok).toBe(false);
    expect(parseCaptureFrame('').ok).toBe(false);
  });

  it('decodes a chunk into an ArrayBuffer the coordinator already understands', () => {
    const pcm = Buffer.from([0, 128, 255, 127]);
    const frame = parseCaptureFrame(
      JSON.stringify({ type: 'chunk', sessionId: 's1', pcm: pcm.toString('base64') }),
    );
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    const message = captureFrameToRenderer(frame.value);
    expect(message?.type).toBe('capture-chunk');
    if (message?.type !== 'capture-chunk') return;
    expect(Buffer.from(message.pcm)).toEqual(pcm);
  });

  it('maps an error frame onto capture-error', () => {
    const frame = parseCaptureFrame(
      '{"type":"error","sessionId":"s1","code":"audio_device","message":"gone","hint":"plug it in"}',
    );
    expect(frame.ok).toBe(true);
    if (!frame.ok) return;
    expect(captureFrameToRenderer(frame.value)).toEqual({
      type: 'capture-error',
      sessionId: 's1',
      error: { code: 'audio_device', message: 'gone', hint: 'plug it in' },
    });
  });
});
