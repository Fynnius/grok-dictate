import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TIMING_EVENTS, TimingSession, formatTimingLine, timingEnabled } from './timing.js';

const ORIGINAL = process.env.GROK_DICTATE_TIMING;

beforeEach(() => {
  delete process.env.GROK_DICTATE_TIMING;
});

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GROK_DICTATE_TIMING;
  else process.env.GROK_DICTATE_TIMING = ORIGINAL;
});

describe('formatTimingLine', () => {
  it('emits a stable key=value grammar in documented order', () => {
    const line = formatTimingLine('s1', 'hotkey_down', 0);
    expect(line).toBe('session=s1 event=hotkey_down elapsed_ms=0');
  });

  it('covers every named lifecycle event', () => {
    for (const event of TIMING_EVENTS) {
      const line = formatTimingLine('abc', event, 12);
      expect(line).toContain(`event=${event}`);
      expect(line).toContain('elapsed_ms=12');
      expect(line).toContain('session=abc');
    }
  });

  it('keeps elapsed_ms monotonic from session start when fed a synthetic session', () => {
    const session = new TimingSession('s1', 1_000);
    const events = [
      'hotkey_down',
      'capture_requested',
      'device_open',
      'first_pcm_main',
      'socket_open',
      'first_partial',
      'hotkey_up',
      'audio_done',
      'final_transcript',
      'insert_begin',
      'insert_end',
      'idle',
    ] as const;
    let t = 1_000;
    const elapsed: number[] = [];
    for (const event of events) {
      t += 10;
      const marked = session.mark(event, t);
      expect(marked.first).toBe(true);
      elapsed.push(marked.elapsedMs);
      const line = formatTimingLine(session.sessionId, event, marked.elapsedMs);
      expect(line).toContain(`event=${event}`);
    }
    for (let i = 1; i < elapsed.length; i++) {
      expect(elapsed[i]!).toBeGreaterThanOrEqual(elapsed[i - 1]!);
    }
    session.textLen = 42;
    session.pcmChunks = 21;
    const summary = formatTimingLine(
      session.sessionId,
      'summary',
      session.elapsed(t),
      session.summaryFields(t),
    );
    expect(summary).toContain('event=summary');
    expect(summary).toContain('hotkey_down=10');
    expect(summary).toContain('idle=120');
    expect(summary).toContain('text_len=42');
    expect(summary).toContain('pcm_chunks=21');
  });

  it('drops a transcript-shaped string rather than putting it on the line', () => {
    const leaked = 'Deployed that on the staging server and then ran the migration';
    const line = formatTimingLine('s1', 'first_partial', 800, {
      text: leaked,
      transcript: leaked,
      interim: leaked,
      text_len: leaked.length,
    });
    expect(line).not.toContain(leaked);
    expect(line).not.toContain('Deployed');
    expect(line).toContain('text_len=62');
    expect(line).not.toContain('text=');
    expect(line).not.toContain('transcript=');
  });

  it('does not repeat a first-only mark', () => {
    const session = new TimingSession('s1', 0);
    expect(session.mark('first_pcm_main', 40).first).toBe(true);
    expect(session.mark('first_pcm_main', 80).first).toBe(false);
    expect(session.marks).toHaveLength(1);
    expect(session.marks[0]?.elapsedMs).toBe(40);
  });
});

describe('timingEnabled', () => {
  it('is on by default', () => {
    expect(timingEnabled()).toBe(true);
  });

  it('turns off only when explicitly set to 0 or false', () => {
    process.env.GROK_DICTATE_TIMING = '0';
    expect(timingEnabled()).toBe(false);
    process.env.GROK_DICTATE_TIMING = 'false';
    expect(timingEnabled()).toBe(false);
    process.env.GROK_DICTATE_TIMING = '1';
    expect(timingEnabled()).toBe(true);
  });
});
