import { describe, expect, it } from 'vitest';
import { TranscriptAccumulator, parseServerFrame, type ServerFrame } from './frames.js';

function partial(fields: Partial<Extract<ServerFrame, { kind: 'partial' }>>) {
  return {
    kind: 'partial' as const,
    text: '',
    isFinal: false,
    speechFinal: false,
    language: null,
    durationSec: null,
    ...fields,
  };
}

describe('parseServerFrame', () => {
  it('reads the `language` field the Grok CLI throws away (spike 1)', () => {
    // Verbatim shape from docs/spike-raw/01-de-lang-de.jsonl.
    const frame = parseServerFrame(
      JSON.stringify({
        type: 'transcript.partial',
        text: 'Hello there, this is a test. Please confirm the details.',
        words: [{ text: 'Ich', start: 0.0, end: 1.25 }],
        is_final: false,
        speech_final: false,
        start: 0.0,
        duration: 5.5,
        language: 'de',
      }),
    );
    expect(frame).toEqual(
      partial({
        text: 'Hello there, this is a test. Please confirm the details.',
        durationSec: 5.5,
        language: 'de',
      }),
    );
  });

  it('reads transcript.done as a duration receipt, not a transcript', () => {
    expect(
      parseServerFrame('{"type":"transcript.done","text":"","words":[],"duration":12.865}'),
    ).toEqual({ kind: 'done', durationSec: 12.865 });
  });

  it('reads transcript.created', () => {
    expect(parseServerFrame('{"type":"transcript.created","id":"abc"}')).toEqual({
      kind: 'created',
      id: 'abc',
    });
  });

  it('reads an error frame, and supplies text when the server gives none', () => {
    expect(parseServerFrame('{"type":"error","message":"boom"}')).toEqual({
      kind: 'error',
      message: 'boom',
    });
    const empty = parseServerFrame('{"type":"error"}');
    expect(empty.kind).toBe('error');
    if (empty.kind !== 'error') return;
    expect(empty.message.length).toBeGreaterThan(0);
  });

  it('survives anything: unknown types, junk, and missing fields', () => {
    // `stt/types.rs` has an `Unknown` catch-all for exactly this reason — and
    // spike 1 exists because its silence about unknown *fields* hid the
    // `language` field for the whole life of the crate. Unknown must be visible,
    // never fatal.
    expect(parseServerFrame('{"type":"speech.started"}')).toEqual({
      kind: 'unknown',
      type: 'speech.started',
    });
    expect(parseServerFrame('not json at all').kind).toBe('unparseable');
    expect(parseServerFrame('{"no":"type"}').kind).toBe('unparseable');
    expect(parseServerFrame('{"type":"transcript.partial"}')).toEqual(partial({}));
    expect(parseServerFrame('{"type":"transcript.partial","text":123}').kind).toBe('unparseable');
  });
});

describe('TranscriptAccumulator — pipeline.rs:310-330', () => {
  it('emits speech_final text as a final, never as preview', () => {
    const acc = new TranscriptAccumulator();
    expect(acc.accept(partial({ text: 'Hallo Welt', speechFinal: true, isFinal: true }))).toEqual({
      kind: 'final',
      text: 'Hallo Welt',
    });
  });

  it('locks is_final deltas into the preview and never commits them', () => {
    const acc = new TranscriptAccumulator();
    expect(acc.accept(partial({ text: 'erster Teil', isFinal: true }))).toEqual({
      kind: 'interim',
      text: 'erster Teil',
    });
    expect(acc.accept(partial({ text: 'zweiter Teil', isFinal: true }))).toEqual({
      kind: 'interim',
      text: 'erster Teil zweiter Teil',
    });
    // A plain partial is shown after the locked prefix, not instead of it: a
    // long pauseless utterance keeps accumulating on screen rather than
    // resetting to the latest ~3 s chunk (pipeline.rs:273-279).
    expect(acc.accept(partial({ text: 'gerade gesprochen' }))).toEqual({
      kind: 'interim',
      text: 'erster Teil zweiter Teil gerade gesprochen',
    });
  });

  it('clears the locked prefix on speech_final, so the re-transcription wins', () => {
    const acc = new TranscriptAccumulator();
    acc.accept(partial({ text: 'ungefähr 20 Minuten', isFinal: true }));
    // The spike saw exactly this: the interim reads "20 Minuten", the
    // speech_final re-transcription reads "zwanzig Minuten", with punctuation.
    expect(acc.accept(partial({ text: 'Ungefähr zwanzig Minuten.', speechFinal: true }))).toEqual({
      kind: 'final',
      text: 'Ungefähr zwanzig Minuten.',
    });
    expect(acc.preview).toBe('');
    expect(acc.accept(partial({ text: 'danach' }))).toEqual({ kind: 'interim', text: 'danach' });
  });

  it('skips the empty partials that arrive first', () => {
    // docs/spike-results.md: the first one or two partials carry `"text":""`
    // with `is_final` sometimes true. A naive "first partial means speech
    // started" check misfires; `pipeline.rs:303-306` trims and skips.
    const acc = new TranscriptAccumulator();
    expect(acc.accept(partial({ text: '', isFinal: true }))).toEqual({ kind: 'none' });
    expect(acc.accept(partial({ text: '   ' }))).toEqual({ kind: 'none' });
    expect(acc.preview).toBe('');
  });

  it('does not leak a previous turn into the next', () => {
    const acc = new TranscriptAccumulator();
    acc.accept(partial({ text: 'alt', isFinal: true }));
    acc.reset();
    expect(acc.accept(partial({ text: 'neu' }))).toEqual({ kind: 'interim', text: 'neu' });
  });
});
