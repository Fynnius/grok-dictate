import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __setLogClock,
  addLogSink,
  clearLogSinks,
  consoleSink,
  createLogger,
  setLogLevel,
  type LogRecord,
} from './logger.js';

const FAKE_JWT = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${'aB3dEf9hIjKlMn0pQrStUvWxYz12'.repeat(20)}.sIgNaTuRe1234567890`;

function captureSink(): { lines: string[]; records: LogRecord[] } {
  const lines: string[] = [];
  const records: LogRecord[] = [];
  addLogSink((line, record) => {
    lines.push(line);
    records.push(record);
  });
  return { lines, records };
}

beforeEach(() => {
  clearLogSinks();
  setLogLevel('debug');
  __setLogClock(() => new Date('2026-08-08T20:00:00.000Z'));
});

afterEach(() => {
  clearLogSinks();
  __setLogClock(() => new Date());
});

describe('logger', () => {
  it('emits a structured line with scope, level and timestamp', () => {
    const { records } = captureSink();
    createLogger('stt').info('connected', { endpointing: 400 });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      ts: '2026-08-08T20:00:00.000Z',
      level: 'info',
      scope: 'stt',
      msg: 'connected',
      fields: { endpointing: 400 },
    });
  });

  it('nests child scopes', () => {
    const { records } = captureSink();
    createLogger('stt').child('socket').warn('reconnecting');
    expect(records[0]?.scope).toBe('stt.socket');
  });

  it('respects the minimum level', () => {
    const { lines } = captureSink();
    setLogLevel('warn');
    const log = createLogger('x');
    log.debug('nope');
    log.info('nope');
    log.warn('yes');
    log.error('yes');
    expect(lines).toHaveLength(2);
  });

  it('keeps running when a sink throws', () => {
    addLogSink(() => {
      throw new Error('sink exploded');
    });
    const { lines } = captureSink();
    expect(() => createLogger('x').info('still fine')).not.toThrow();
    expect(lines).toHaveLength(1);
  });
});

describe('a token cannot reach a sink', () => {
  // IMPLEMENTATION-PLAN.md §3.1.1: "Add a unit test that asserts a token cannot
  // be logged." Each case is a route a careless caller might actually take.
  it('via the message', () => {
    const { lines, records } = captureSink();
    createLogger('auth').info(`using bearer ${FAKE_JWT}`);
    expect(lines[0]).not.toContain(FAKE_JWT);
    expect(records[0]?.msg).not.toContain(FAKE_JWT);
  });

  it('via a structured field', () => {
    const { lines, records } = captureSink();
    createLogger('auth').info('loaded auth.json', {
      key: FAKE_JWT,
      expires_at: '2026-08-08T21:58:59Z',
    });
    expect(lines[0]).not.toContain(FAKE_JWT);
    expect(JSON.stringify(records[0])).not.toContain(FAKE_JWT);
    // The non-secret field survives — redaction must not blind the logs.
    expect(lines[0]).toContain('2026-08-08T21:58:59Z');
  });

  it('via a deeply nested field', () => {
    const { lines } = captureSink();
    createLogger('stt').error('handshake failed', {
      request: { url: 'wss://api.x.ai/v1/stt', headers: { authorization: `Bearer ${FAKE_JWT}` } },
    });
    expect(lines[0]).not.toContain(FAKE_JWT);
    expect(lines[0]).toContain('wss://api.x.ai/v1/stt');
  });

  it('via an Error thrown by an HTTP client', () => {
    const { lines } = captureSink();
    createLogger('stt').error('connect failed', {
      err: new Error(`401 for GET /v1/stt with Authorization: Bearer ${FAKE_JWT}`),
    });
    expect(lines[0]).not.toContain(FAKE_JWT);
  });

  it('via the console sink, which formats independently of the JSON line', () => {
    const written: string[] = [];
    addLogSink(consoleSink((s) => written.push(s)));
    createLogger('auth').info(`bearer ${FAKE_JWT}`, { key: FAKE_JWT });
    expect(written).toHaveLength(1);
    expect(written[0]).not.toContain(FAKE_JWT);
  });

  it('via a field object whose toJSON leaks it', () => {
    const { lines } = captureSink();
    createLogger('auth').info('token holder', {
      holder: {
        toJSON: () => ({ raw: FAKE_JWT }),
      },
    });
    expect(lines[0]).not.toContain(FAKE_JWT);
  });
});

describe('log volume safety', () => {
  it('does not dump PCM buffers into the log', () => {
    const { lines } = captureSink();
    createLogger('audio').debug('chunk', { pcm: new Uint8Array(3200) });
    expect(lines[0]).toContain('[binary 3200B]');
    expect(lines[0]!.length).toBeLessThan(300);
  });

  it('does no work when there are no sinks', () => {
    const toJSON = vi.fn();
    createLogger('x').info('nothing listening', { probe: { toJSON } });
    expect(toJSON).not.toHaveBeenCalled();
  });
});
