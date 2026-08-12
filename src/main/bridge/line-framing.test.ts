import { describe, expect, it } from 'vitest';
import { LineFramer, MAX_LINE_BYTES } from './line-framing.js';

describe('LineFramer', () => {
  it('splits complete lines', () => {
    const framer = new LineFramer();
    expect(framer.feed('a\nb\n')).toEqual(['a', 'b']);
  });

  it('holds a partial line until its newline arrives', () => {
    const framer = new LineFramer();
    expect(framer.feed('{"v":1,')).toEqual([]);
    expect(framer.feed('"type":"ready"}')).toEqual([]);
    expect(framer.feed('\n')).toEqual(['{"v":1,"type":"ready"}']);
  });

  it('returns several frames delivered in one chunk', () => {
    const framer = new LineFramer();
    expect(framer.feed('one\ntwo\nthree\n')).toEqual(['one', 'two', 'three']);
  });

  it('reassembles a frame split mid-multibyte-safe boundary across chunks', () => {
    const framer = new LineFramer();
    framer.feed('{"text":"Grüße aus ');
    expect(framer.feed('München"}\n')).toEqual(['{"text":"Grüße aus München"}']);
  });

  it('tolerates CRLF', () => {
    const framer = new LineFramer();
    expect(framer.feed('a\r\nb\r\n')).toEqual(['a', 'b']);
  });

  it('skips blank lines rather than emitting empty frames', () => {
    const framer = new LineFramer();
    expect(framer.feed('a\n\n\nb\n')).toEqual(['a', 'b']);
  });

  it('flushes a trailing partial line when the stream ends', () => {
    const framer = new LineFramer();
    framer.feed('no trailing newline');
    expect(framer.flush()).toEqual(['no trailing newline']);
    expect(framer.flush()).toEqual([]);
  });

  it('drops a runaway line and resynchronises at the next newline', () => {
    const framer = new LineFramer();
    expect(framer.feed('x'.repeat(MAX_LINE_BYTES + 1))).toEqual([]);
    // The tail of the dropped line must not be parsed as a frame.
    expect(framer.feed('garbage-tail\n{"v":1}\n')).toEqual(['{"v":1}']);
  });

  it('keeps escaped newlines inside JSON strings intact', () => {
    // The whole framing scheme rests on JSON.stringify escaping newlines, so a
    // transcript containing them stays on one line (helper-protocol.md §1).
    const frame = JSON.stringify({ v: 1, type: 'insert', text: 'line one\nline two' });
    const framer = new LineFramer();
    const lines = framer.feed(`${frame}\n`);
    expect(lines).toHaveLength(1);
    const parsed: unknown = JSON.parse(lines[0] ?? '');
    expect((parsed as { text: string }).text).toBe('line one\nline two');
  });
});
