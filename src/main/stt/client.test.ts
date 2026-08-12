/**
 * The STT client, against a real WebSocket server on loopback.
 *
 * Every test here maps to a line in IMPLEMENTATION-PLAN.md §3.3 or to a spike
 * result. The ones that matter most, because each is a silent failure in
 * production:
 *
 *   - connect-time buffering — the handshake measured 518-591 ms, so without it
 *     the first half-second of every hold is lost (`pipeline.rs:218-220`);
 *   - `speech_final` alone drives committed text (`pipeline.rs:273-279`);
 *   - a close after the turn is benign — this endpoint always resets with 1006,
 *     so getting it wrong means an error toast on *every* dictation;
 *   - 429 backoff with jitter, and rate-limit responses logged;
 *   - the token never reaches a log.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AuthPort, SttHandlers, SttTurn, SttTurnOptions } from '@contracts/ports.js';
import { CHUNK_BYTES } from '@shared/constants.js';
import {
  addLogSink,
  clearLogSinks,
  createLogger,
  setLogLevel,
  type LogRecord,
} from '@shared/logger.js';
import { appError, err, ok, type AppError, type Result } from '@shared/result.js';
import type { Bearer } from '@contracts/ports.js';
import { XaiSttClient } from './client.js';
import { FakeSttServer, waitFor } from './fake-server.js';

/** Structurally a JWT, so the redaction layer treats it like the real bearer. */
const FAKE_JWT = `eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.${'c3ludGhldGljLXBheWxvYWQtZm9yLXRlc3Rpbmc'.repeat(4)}.bm90LWEtcmVhbC1zaWduYXR1cmU`;

class Recorder implements SttHandlers {
  ready = 0;
  readonly interim: string[] = [];
  readonly finals: string[] = [];
  readonly languages: string[] = [];
  readonly dones: (number | null)[] = [];
  readonly errors: AppError[] = [];

  onReady(): void {
    this.ready++;
  }
  onInterim(text: string): void {
    this.interim.push(text);
  }
  onFinal(text: string): void {
    this.finals.push(text);
  }
  onLanguageDetected(code: string): void {
    this.languages.push(code);
  }
  onDone(durationSec: number | null): void {
    this.dones.push(durationSec);
  }
  onError(error: AppError): void {
    this.errors.push(error);
  }
}

function staticAuth(token = FAKE_JWT): AuthPort {
  return {
    getBearer(): Promise<Result<Bearer>> {
      return Promise.resolve(ok({ token, expiresAt: new Date(Date.now() + 3_600_000) }));
    },
  };
}

function failingAuth(error: AppError): AuthPort {
  return {
    getBearer(): Promise<Result<Bearer>> {
      return Promise.resolve(err(error));
    },
  };
}

const TURN: SttTurnOptions = {
  sessionId: 'session-1',
  language: null,
  endpointingMs: 400,
  keyterms: [],
  useFinalize: false,
};

const pcm = (fill: number): Uint8Array => new Uint8Array(CHUNK_BYTES).fill(fill);

let server: FakeSttServer;
const records: LogRecord[] = [];
const lines: string[] = [];
const openTurns: SttTurn[] = [];

beforeEach(async () => {
  server = await FakeSttServer.start();
  records.length = 0;
  lines.length = 0;
  openTurns.length = 0;
  clearLogSinks();
  setLogLevel('debug');
  addLogSink((line, record) => {
    lines.push(line);
    records.push(record);
  });
});

afterEach(async () => {
  for (const turn of openTurns.splice(0)) turn.abort();
  clearLogSinks();
  await server.stop();
});

interface Started {
  turn: SttTurn;
  handlers: Recorder;
}

function start(
  options: Partial<SttTurnOptions> = {},
  client: Partial<ConstructorParameters<typeof XaiSttClient>[0]> = {},
): Started {
  const stt = new XaiSttClient({
    auth: staticAuth(),
    logger: createLogger('test'),
    apiBase: server.base,
    random: () => 0, // deterministic full-jitter backoff
    ...client,
  });
  const handlers = new Recorder();
  const turn = stt.startTurn({ ...TURN, ...options }, handlers);
  openTurns.push(turn);
  return { turn, handlers };
}

/* ------------------------------------------------------------------ */

describe('the connection', () => {
  it('sends the bearer in a header and never in the URL', async () => {
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0);

    const request = server.requests[0];
    expect(request).toBeDefined();
    if (request === undefined) return;
    expect(request.headers.authorization).toBe(`Bearer ${FAKE_JWT}`);
    expect(request.url).not.toContain(FAKE_JWT);
    // Attribution headers only; `streaming.rs:49-55` says they are optional.
    expect(request.headers['x-grok-client-identifier']).toBe('grok-dictate');
  });

  it('carries the query contract from config.rs and the spikes', async () => {
    const { handlers } = start({
      language: 'de',
      endpointingMs: 50,
      keyterms: ['kubectl', 'Vitest'],
    });
    await waitFor(() => handlers.ready > 0);

    const url = new URL(server.requests[0]?.url ?? '', 'ws://x');
    expect(url.searchParams.get('sample_rate')).toBe('16000');
    expect(url.searchParams.get('encoding')).toBe('pcm');
    expect(url.searchParams.get('interim_results')).toBe('true');
    expect(url.searchParams.get('endpointing')).toBe('50');
    expect(url.searchParams.get('language')).toBe('de');
    expect(url.searchParams.getAll('keyterm')).toEqual(['kubectl', 'Vitest']);
  });

  it('reports an auth failure through onError, with the hint intact', async () => {
    const { handlers } = start(
      {},
      {
        auth: failingAuth(
          appError('auth_expired', 'The Grok token expired at 21:58.', 'Run `grok` to refresh it.'),
        ),
      },
    );
    await waitFor(() => handlers.errors.length > 0);
    expect(handlers.errors[0]?.code).toBe('auth_expired');
    expect(handlers.errors[0]?.hint).toContain('grok');
    // No socket was ever opened.
    expect(server.requests).toHaveLength(0);
  });
});

describe('connect-time PCM buffering', () => {
  it('accepts PCM before the session exists and flushes it in order', async () => {
    server.autoCreate = false;
    const { turn, handlers } = start();
    await server.waitForConnections(1);

    turn.sendPcm(pcm(1));
    turn.sendPcm(pcm(2));
    turn.sendPcm(pcm(3));
    // Nothing may reach the server before `transcript.created`.
    await new Promise((r) => setTimeout(r, 30));
    expect(server.binary).toHaveLength(0);

    server.created();
    await waitFor(() => handlers.ready > 0);
    turn.sendPcm(pcm(4));
    await waitFor(() => server.binary.length === 4);

    expect(server.binary.map((b) => b[0])).toEqual([1, 2, 3, 4]);
    expect(server.binary.every((b) => b.byteLength === CHUNK_BYTES)).toBe(true);
  });

  it('sends the backlog before the end-of-turn, even for a hold shorter than the handshake', async () => {
    server.autoCreate = false;
    const { turn, handlers } = start();
    await server.waitForConnections(1);

    turn.sendPcm(pcm(7));
    turn.finish(); // released the key while still connecting

    server.created();
    await waitFor(() => server.text.length > 0);

    // Audio first, then `audio.done` — the other order ends the turn on nothing.
    expect(server.messages.map((m) => m.kind)).toEqual(['binary', 'text']);
    expect(server.text[0]).toBe('{"type":"audio.done"}');
    expect(handlers.errors).toHaveLength(0);
  });
});

describe('transcript semantics (pipeline.rs:273-279)', () => {
  it('commits only speech_final, and previews the deltas', async () => {
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0);

    server.partial({ text: '', isFinal: true, language: 'de' }); // the empty first frame
    server.partial({ text: 'hello', language: 'en' });
    server.partial({ text: 'hello there', isFinal: true, language: 'en' });
    server.partial({ text: 'please confirm', language: 'en' });
    await waitFor(() => handlers.interim.length === 3);

    expect(handlers.interim).toEqual(['hello', 'hello there', 'hello there please confirm']);
    expect(handlers.finals).toHaveLength(0);

    server.partial({
      text: 'Hello there, this is a test. Please confirm the details.',
      isFinal: true,
      speechFinal: true,
      language: 'de',
    });
    await waitFor(() => handlers.finals.length === 1);
    expect(handlers.finals).toEqual(['Hello there, this is a test. Please confirm the details.']);
  });

  it('produces many finals for a long hold (spike 4 — 70 across 15 minutes)', async () => {
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0);
    server.partial({ text: 'First sentence.', speechFinal: true, language: 'en' });
    server.partial({ text: 'Second sentence.', speechFinal: true, language: 'en' });
    await waitFor(() => handlers.finals.length === 2);
    // The state machine accumulates these into one insertion; the client's job
    // is only to report each one.
    expect(handlers.finals).toEqual(['First sentence.', 'Second sentence.']);
  });

  it('reports the detected language once per change (spike 1)', async () => {
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0);
    server.partial({ text: 'one', language: 'en' });
    server.partial({ text: 'one two', language: 'en' });
    server.partial({ text: 'eins zwei drei', language: 'de' });
    await waitFor(() => handlers.interim.length === 3);
    expect(handlers.languages).toEqual(['en', 'de']);
  });

  it('reports transcript.done duration, the telemetry the CLI discards', async () => {
    const { turn, handlers } = start();
    await waitFor(() => handlers.ready > 0);
    server.partial({ text: 'Hallo.', speechFinal: true, language: 'de' });
    turn.finish();
    await waitFor(() => server.text.length > 0);
    server.done(12.865);
    await waitFor(() => handlers.dones.length === 1);
    expect(handlers.dones).toEqual([12.865]);
    expect(handlers.errors).toHaveLength(0);
  });

  it('survives unknown and unparseable frames', async () => {
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0);
    server.send({ type: 'speech.started' });
    server.latest.send('this is not json');
    server.partial({ text: 'still working', speechFinal: true });
    await waitFor(() => handlers.finals.length === 1);
    expect(handlers.errors).toHaveLength(0);
    expect(records.some((r) => r.msg.includes('unmodelled server frame'))).toBe(true);
  });

  it('surfaces a server error frame with actionable text', async () => {
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0);
    server.serverError('audio encoding not supported');
    await waitFor(() => handlers.errors.length === 1);
    expect(handlers.errors[0]?.code).toBe('stt_protocol');
    expect(handlers.errors[0]?.message).toContain('audio encoding not supported');
    expect(handlers.errors[0]?.hint).not.toBeNull();
  });
});

describe('end of turn', () => {
  it('sends audio.done by default (spike 2)', async () => {
    const { turn, handlers } = start();
    await waitFor(() => handlers.ready > 0);
    turn.finish();
    await waitFor(() => server.text.length === 1);
    expect(server.text[0]).toBe('{"type":"audio.done"}');
  });

  it('sends finalize when configured, and ends the turn on the guard timer', async () => {
    // Spike 2: `finalize` produces no `transcript.done` and never closes, so
    // without the guard the state machine parks in `processing` forever.
    const { turn, handlers } = start({ useFinalize: true }, { timeouts: { finishMs: 120 } });
    await waitFor(() => handlers.ready > 0);
    turn.finish();
    await waitFor(() => server.text.length === 1);
    expect(server.text[0]).toBe('{"type":"finalize"}');

    await waitFor(() => handlers.dones.length === 1, 2000);
    expect(handlers.dones).toEqual([null]);
    expect(handlers.errors).toHaveLength(0);
    expect(records.some((r) => r.msg.includes('finish timeout'))).toBe(true);
  });

  it('treats a 1006 reset after the turn as benign (streaming.rs:206-213)', async () => {
    // The measured behaviour of this endpoint: it drops the connection with no
    // closing handshake after `transcript.done`. Every dictation would otherwise
    // end in an error toast.
    const { turn, handlers } = start();
    await waitFor(() => handlers.ready > 0);
    server.partial({ text: 'Fertig.', speechFinal: true, language: 'de' });
    turn.finish();
    await waitFor(() => server.text.length === 1);
    server.done(3.2);
    await waitFor(() => handlers.dones.length === 1);
    server.reset();

    await new Promise((r) => setTimeout(r, 60));
    expect(handlers.errors).toHaveLength(0);
  });

  it('ends the turn if the socket closes after finish without transcript.done', async () => {
    const { turn, handlers } = start();
    await waitFor(() => handlers.ready > 0);
    turn.finish();
    await waitFor(() => server.text.length === 1);
    server.reset();

    await waitFor(() => handlers.dones.length === 1);
    expect(handlers.dones).toEqual([null]);
    expect(handlers.errors).toHaveLength(0);
  });

  it('reports a drop that happens mid-utterance, which is not benign', async () => {
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0);
    server.reset(); // Wi-Fi went away while the key is still held

    await waitFor(() => handlers.errors.length === 1);
    expect(handlers.errors[0]?.code).toBe('stt_connect');
    expect(handlers.errors[0]?.message).toContain('dropped');
    expect(handlers.errors[0]?.hint).toContain('network');
  });

  it('stops producing callbacks after abort', async () => {
    const { turn, handlers } = start();
    await waitFor(() => handlers.ready > 0);
    turn.abort();
    server.partial({ text: 'too late', speechFinal: true });
    server.done(1);
    server.reset();
    await new Promise((r) => setTimeout(r, 60));

    expect(handlers.finals).toHaveLength(0);
    expect(handlers.dones).toHaveLength(0);
    expect(handlers.errors).toHaveLength(0);
  });
});

describe('liveness — the HT-5 regression', () => {
  /**
   * Human test HT-5 (Wi-Fi off mid-utterance) failed: the connection went away
   * without a close event or an error, the client waited out the whole finish
   * timeout, and the turn ended "successfully" with the single three-character
   * fragment that had arrived before the link died. `blackhole()` reproduces the
   * cause — a socket that is still open but never reads, so pings get no pong.
   */
  it('detects a connection that stops responding while recording', async () => {
    const { handlers } = start({}, { timeouts: { livenessMs: 400, noSpeechMs: 60_000 } });
    await waitFor(() => handlers.ready > 0);
    server.blackhole();

    await waitFor(() => handlers.errors.length === 1, 3000);
    expect(handlers.errors[0]?.code).toBe('stt_connect');
    expect(handlers.errors[0]?.message).toContain('stopped responding');
    expect(handlers.errors[0]?.hint).toContain('nothing was typed');
    // …and it must not masquerade as a completed turn.
    expect(handlers.dones).toHaveLength(0);
  });

  it('does not wait out the finish timeout when the link is already dead', async () => {
    // This is the exact HT-5 shape: audio, one small final, link dies, key up.
    const { turn, handlers } = start(
      {},
      { timeouts: { livenessMs: 5_000, finishLivenessMs: 300, finishMs: 30_000 } },
    );
    await waitFor(() => handlers.ready > 0);
    server.partial({ text: 'So.', speechFinal: true, language: 'en' });
    await waitFor(() => handlers.finals.length === 1);

    server.blackhole();
    turn.finish();

    await waitFor(() => handlers.errors.length === 1, 3000);
    expect(handlers.errors[0]?.code).toBe('stt_connect');
    // The fragment is *not* delivered as a finished turn. Reporting a
    // three-character transcript as a success is the failure being fixed.
    expect(handlers.dones).toHaveLength(0);
  });

  it('leaves a healthy but silent connection alone', async () => {
    // The server sends nothing at all during silence in this test, so only the
    // pong keeps the session alive. If liveness were keyed on transcripts
    // instead, a genuine pause in dictation would be killed as a dead link.
    const { handlers } = start({}, { timeouts: { livenessMs: 300, noSpeechMs: 60_000 } });
    await waitFor(() => handlers.ready > 0);

    await new Promise((r) => setTimeout(r, 1_200));
    expect(handlers.errors).toHaveLength(0);

    server.partial({ text: 'immer noch da', language: 'de' });
    await waitFor(() => handlers.interim.length === 1);
  });
});

describe('rate limiting', () => {
  it('retries a 429 with backoff and succeeds', async () => {
    server.rejections.push({ status: 429, headers: { 'retry-after': '0' } });
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0, 5000);
    expect(server.requests).toHaveLength(2);
    expect(handlers.errors).toHaveLength(0);
    expect(records.some((r) => r.msg.includes('retrying after rate limit'))).toBe(true);
  });

  it('logs every rate-limit response with its headers, which is how §9.1 gets answered', async () => {
    server.rejections.push({
      status: 429,
      headers: { 'retry-after': '0', 'x-ratelimit-limit-requests': '60' },
    });
    const { handlers } = start();
    await waitFor(() => handlers.ready > 0, 5000);

    const warning = records.find((r) => r.msg.includes('rate limited'));
    expect(warning).toBeDefined();
    const headers = warning?.fields?.['headers'] as Record<string, string> | undefined;
    expect(headers?.['retry-after']).toBe('0');
    expect(headers?.['x-ratelimit-limit-requests']).toBe('60');
  });

  it('gives up with an actionable error after the retry budget', async () => {
    for (let i = 0; i < 4; i++) server.rejections.push({ status: 429 });
    const { handlers } = start();
    await waitFor(() => handlers.errors.length === 1, 5000);
    expect(server.requests).toHaveLength(4);
    expect(handlers.errors[0]?.code).toBe('stt_rate_limited');
    expect(handlers.errors[0]?.hint).toContain('try again');
  });

  it('does not sit on a long Retry-After; it says how long to wait', async () => {
    server.rejections.push({ status: 429, headers: { 'retry-after': '60' } });
    const { handlers } = start();
    await waitFor(() => handlers.errors.length === 1, 5000);
    expect(server.requests).toHaveLength(1);
    expect(handlers.errors[0]?.code).toBe('stt_rate_limited');
    expect(handlers.errors[0]?.hint).toContain('60 seconds');
  });

  it('maps 401 to an expired token, with the `grok` fix and no refresh attempt', async () => {
    server.rejections.push({ status: 401 });
    const { handlers } = start();
    await waitFor(() => handlers.errors.length === 1, 5000);
    expect(handlers.errors[0]?.code).toBe('auth_expired');
    expect(handlers.errors[0]?.hint).toMatch(/Sign in|`grok`/);
    expect(server.requests).toHaveLength(1); // no retry, and above all no refresh
  });
});

describe('the no-speech watchdog (pipeline.rs:198-209)', () => {
  it('fires when nothing is transcribed, with a microphone hint', async () => {
    // It exists because "macOS may return silence instead of an error" when
    // microphone permission is denied — indistinguishable from not talking.
    const { handlers } = start({}, { timeouts: { noSpeechMs: 120 } });
    await waitFor(() => handlers.errors.length === 1, 3000);
    expect(handlers.errors[0]?.code).toBe('stt_no_speech');
    expect(handlers.errors[0]?.hint).toContain('Microphone');
  });

  it('is disarmed by the first real transcript, not by an empty one', async () => {
    const { handlers } = start({}, { timeouts: { noSpeechMs: 250 } });
    await waitFor(() => handlers.ready > 0);
    // The empty leading partial must not count (docs/spike-results.md).
    server.partial({ text: '', isFinal: true });
    await new Promise((r) => setTimeout(r, 60));
    server.partial({ text: 'jetzt spreche ich' });
    await waitFor(() => handlers.interim.length === 1);

    await new Promise((r) => setTimeout(r, 350));
    expect(handlers.errors).toHaveLength(0);
  });
});

describe('the token never reaches a log', () => {
  function assertClean(where: string, haystack: string): void {
    // Written so a failure never prints the secret.
    expect(`${where}:${String(haystack.includes(FAKE_JWT))}`).toBe(`${where}:false`);
  }

  it('is absent from every line of a successful turn and of every failure path', async () => {
    const { turn, handlers } = start({ keyterms: ['kubectl'] });
    await waitFor(() => handlers.ready > 0);
    turn.sendPcm(pcm(1));
    server.partial({ text: 'Hallo.', speechFinal: true, language: 'de' });
    turn.finish();
    await waitFor(() => server.text.length === 1);
    server.done(1.5);
    await waitFor(() => handlers.dones.length === 1);

    // …and a failure, where error messages tend to quote the request.
    server.rejections.push({ status: 500 });
    const failed = start();
    await waitFor(() => failed.handlers.errors.length === 1, 5000);

    expect(lines.length).toBeGreaterThan(5);
    for (const line of lines) assertClean('log line', line);
    for (const record of records) assertClean('log record', JSON.stringify(record));
    for (const error of [...handlers.errors, ...failed.handlers.errors]) {
      assertClean('AppError', JSON.stringify(error));
    }
  });
});
