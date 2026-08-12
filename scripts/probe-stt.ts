/**
 * Protocol spike — stream a WAV to `wss://api.x.ai/v1/stt` and dump every raw
 * frame verbatim (IMPLEMENTATION-PLAN.md §3.1.4).
 *
 * This exists to answer five questions whose answers change Phase 3's design,
 * so it is deliberately a *recorder*, not a client: it prints what the server
 * actually sends, byte for byte, rather than what a typed client would keep.
 *  flags precisely that failure — the Grok CLI's `serde` struct
 * silently drops any field it does not know, and if `transcript.partial` were
 * already reporting a detected language, the whole of §5.9 would collapse into
 * reading it.
 *
 * Owned by Phase 1 (`scripts/`). Standalone: it reads the bearer itself rather
 * than going through `src/main/auth/`, which belongs to Phase 3.
 *
 * The token is never printed, never logged, and never written to the raw dump.
 *
 * Usage:
 *   npx tsx scripts/probe-stt.ts --wav path/to/clip.wav --language de
 *   npx tsx scripts/probe-stt.ts --wav … --end finalize --endpointing 50
 *   npx tsx scripts/probe-stt.ts --wav … --keyterm kubectl --keyterm Vitest
 *
 * Auth: `XAI_API_KEY`, or a logged-in Grok CLI (`~/.grok/auth.json`).
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { WebSocket } from 'ws';
import {
  API_KEY_SENTINEL_EXPIRY,
  AUTH_JSON_RELATIVE_PATH,
  CHUNK_BYTES,
  CHUNK_DURATION_MS,
  SAMPLE_RATE_HZ,
  STT_API_BASE,
  STT_WS_PATH,
} from '../src/shared/constants.js';
import { envString } from '../src/shared/env.js';
import { redactString } from '../src/shared/redact.js';
import { chunkPcm, parseWav, trimTrailingSilence } from '../src/shared/wav.js';

/* ------------------------------------------------------------------ *
 * Arguments
 * ------------------------------------------------------------------ */

interface Options {
  wav: string;
  language: string | null; // null = omit the parameter entirely
  endpointing: number;
  interimResults: boolean;
  end: 'finalize' | 'audio.done' | 'none';
  keyterms: string[];
  keytermMode: 'repeat' | 'csv';
  loops: number;
  realtime: boolean;
  trimSilence: boolean;
  label: string;
  extraParams: [string, string][];
  maxSeconds: number;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    wav: '',
    language: 'de',
    endpointing: 400,
    interimResults: true,
    end: 'audio.done',
    keyterms: [],
    keytermMode: 'repeat',
    loops: 1,
    realtime: true,
    trimSilence: true,
    label: 'probe',
    extraParams: [],
    maxSeconds: 120,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${String(arg)} needs a value`);
      return value;
    };
    switch (arg) {
      case '--wav':
        options.wav = next();
        break;
      case '--language':
        options.language = next();
        break;
      case '--no-language':
        options.language = null;
        break;
      case '--endpointing':
        options.endpointing = Number(next());
        break;
      case '--no-interim':
        options.interimResults = false;
        break;
      case '--end':
        options.end = next() as Options['end'];
        break;
      case '--keyterm':
        options.keyterms.push(next());
        break;
      case '--keyterm-mode':
        options.keytermMode = next() as Options['keytermMode'];
        break;
      case '--loops':
        options.loops = Number(next());
        break;
      case '--fast':
        options.realtime = false;
        break;
      case '--no-trim':
        options.trimSilence = false;
        break;
      case '--label':
        options.label = next();
        break;
      case '--max-seconds':
        options.maxSeconds = Number(next());
        break;
      case '--param': {
        const [key, ...rest] = next().split('=');
        options.extraParams.push([key ?? '', rest.join('=')]);
        break;
      }
      default:
        throw new Error(`unknown argument: ${String(arg)}`);
    }
  }
  return options;
}

/* ------------------------------------------------------------------ *
 * Auth — read only, never refresh
 * ------------------------------------------------------------------ */

interface BearerInfo {
  token: string;
  expiresAt: Date;
}

function readBearer(): BearerInfo {
  const fromEnv = envString('XAI_API_KEY');
  if (fromEnv !== undefined) {
    return { token: fromEnv, expiresAt: API_KEY_SENTINEL_EXPIRY };
  }

  const path = join(homedir(), AUTH_JSON_RELATIVE_PATH);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (cause) {
    throw new Error(`Could not read ${path}. Run \`grok login\` first.`, { cause });
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error(`${path} is not a JSON object — the Grok CLI format may have changed.`);
  }
  // Single top-level key: the auth *scope* (`issuer::client_id`),
  const scopes = Object.values(parsed as Record<string, unknown>);
  const scope = scopes[0];
  if (scopes.length === 0 || scope === null || typeof scope !== 'object') {
    throw new Error(`${path} has no auth scope entry — run \`grok login\`.`);
  }
  const record = scope as Record<string, unknown>;
  const token = record['key'];
  const expiresAt = record['expires_at'];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`${path} has no \`key\` field — the Grok CLI format may have changed.`);
  }
  if (typeof expiresAt !== 'string') {
    throw new Error(`${path} has no \`expires_at\` field — the Grok CLI format may have changed.`);
  }
  const expiry = new Date(expiresAt);
  if (expiry.getTime() <= Date.now()) {
    throw new Error(
      `The Grok token expired at ${expiry.toISOString()} — run \`grok\` in a terminal to refresh it.`,
    );
  }
  return { token, expiresAt: expiry };
}

/* ------------------------------------------------------------------ *
 * URL
 * ------------------------------------------------------------------ */

function buildUrl(options: Options): string {
  const url = new URL(STT_WS_PATH, STT_API_BASE);
  url.protocol = 'wss:';
  url.searchParams.set('sample_rate', String(SAMPLE_RATE_HZ));
  url.searchParams.set('encoding', 'pcm');
  url.searchParams.set('interim_results', String(options.interimResults));
  if (options.language !== null) url.searchParams.set('language', options.language);
  url.searchParams.set('endpointing', String(options.endpointing));

  if (options.keyterms.length > 0) {
    //  explicitly leaves this open: "never checked whether the
    // STT socket accepts a `keyterm` parameter repeated multiple times or as a
    // comma-separated list". Spike 5 tries both.
    if (options.keytermMode === 'csv') {
      url.searchParams.set('keyterm', options.keyterms.join(','));
    } else {
      for (const term of options.keyterms) url.searchParams.append('keyterm', term);
    }
  }
  for (const [key, value] of options.extraParams) url.searchParams.append(key, value);
  return url.toString();
}

/* ------------------------------------------------------------------ *
 * Run
 * ------------------------------------------------------------------ */

interface FrameRecord {
  /** ms since the socket opened. */
  tConnect: number;
  /** ms since the last PCM byte was written; negative before end of audio. */
  tSinceAudioEnd: number | null;
  direction: 'recv' | 'send';
  raw: string;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * A sleep whose timer does not hold the Node event loop open. The cap below is
 * up to 15 minutes for the duration probe; without `unref` the process would
 * sit there long after the session finished.
 */
const sleepUnref = (ms: number): Promise<void> =>
  new Promise((r) => {
    const timer = setTimeout(r, ms);
    timer.unref();
  });

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (options.wav.length === 0) {
    throw new Error('pass --wav path/to/clip.wav (16 kHz mono PCM16)');
  }
  const bearer = readBearer();

  const wavPath = resolve(options.wav);
  const parsedWav = parseWav(readFileSync(wavPath), options.wav);
  if (!parsedWav.ok) {
    throw new Error(`${parsedWav.error.message} — ${parsedWav.error.hint ?? ''}`);
  }
  const wav = parsedWav.value;
  if (wav.sampleRate !== SAMPLE_RATE_HZ || wav.channels !== 1) {
    throw new Error(
      `${options.wav} is ${String(wav.sampleRate)} Hz / ${String(wav.channels)}ch; the probe sends ${String(SAMPLE_RATE_HZ)} Hz mono. ` +
        `Convert with: ffmpeg -i ${options.wav} -ac 1 -ar 16000 -sample_fmt s16 out.wav`,
    );
  }

  // Trailing silence would let the server endpoint *before* we send `finalize`
  // or `audio.done`, so spike 2 would measure the silence rather than the
  // message. Trim it unless explicitly asked not to.
  let pcm = options.trimSilence ? trimTrailingSilence(wav.pcm, wav.sampleRate) : wav.pcm;
  const trimmedMs = ((wav.pcm.length - pcm.length) / 2 / wav.sampleRate) * 1000;
  if (options.loops > 1) pcm = Buffer.concat(new Array<Buffer>(options.loops).fill(pcm));

  const chunks = chunkPcm(pcm, CHUNK_BYTES);
  const audioSeconds = pcm.length / 2 / wav.sampleRate;
  const url = buildUrl(options);

  const frames: FrameRecord[] = [];
  const started = Date.now();
  let openedAt = 0;
  let audioEndAt: number | null = null;

  // Query string only — the Authorization header is never printed.
  const printableUrl = url.replace(/^wss:\/\/[^?]+/, `wss://api.x.ai${STT_WS_PATH}`);
  console.log(`# probe: ${options.label}`);
  console.log(`# url: ${printableUrl}`);
  console.log(
    `# audio: ${options.wav} ${audioSeconds.toFixed(2)}s (${String(chunks.length)} chunks of ${String(CHUNK_BYTES)}B)` +
      (trimmedMs > 0 ? `, trimmed ${trimmedMs.toFixed(0)}ms of trailing silence` : ''),
  );
  console.log(
    `# end-of-turn: ${options.end}; pacing: ${options.realtime ? 'realtime' : 'as fast as possible'}`,
  );
  console.log(`# token expires ${bearer.expiresAt.toISOString()}`);

  const socket = new WebSocket(url, {
    headers: {
      Authorization: `Bearer ${bearer.token}`,
      // Attribution only; the connection is fully authorised without them
      // (`streaming.rs:49-55`).
      'x-grok-client-identifier': 'grok-dictate-probe',
      'User-Agent': 'grok-dictate-probe/0.1',
    },
  });

  const record = (direction: FrameRecord['direction'], raw: string): void => {
    const now = Date.now();
    const frame: FrameRecord = {
      tConnect: openedAt === 0 ? 0 : now - openedAt,
      tSinceAudioEnd: audioEndAt === null ? null : now - audioEndAt,
      direction,
      // Belt and braces: nothing from this process may carry the bearer.
      raw: redactString(raw),
    };
    frames.push(frame);
    const marker =
      frame.tSinceAudioEnd === null ? '   ---' : `${String(frame.tSinceAudioEnd).padStart(6)}`;
    console.log(
      `${String(frame.tConnect).padStart(6)}ms  ${marker}ms  ${direction === 'recv' ? '<--' : '-->'}  ${frame.raw}`,
    );
  };

  const closed = new Promise<{ code: number; reason: string }>((resolveClose, rejectClose) => {
    socket.on('close', (code: number, reason: Buffer) => {
      resolveClose({ code, reason: reason.toString('utf8') });
    });
    socket.on('error', (error: Error) => {
      // A 429 or 401 surfaces here as an "Unexpected server response" error.
      //  makes logging rate-limit responses a v1 requirement.
      rejectClose(error);
    });
  });

  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once('open', () => {
      openedAt = Date.now();
      console.log(`# handshake: ${String(openedAt - started)}ms`);
      resolveOpen();
    });
    socket.once('error', rejectOpen);
  });

  // `transcript.done` marks the end of the turn. Waiting for the socket close
  // as well is unreliable: the server drops the connection without a closing
  // handshake (observed close code 1006), which is exactly the
  // `ResetWithoutClosingHandshake` case `streaming.rs:206-213` treats as benign.
  let resolveDone: (() => void) | null = null;
  const turnDone = new Promise<void>((r) => {
    resolveDone = r;
  });

  socket.on('message', (data: Buffer, isBinary: boolean) => {
    const text = isBinary ? `<binary ${String(data.length)} bytes>` : data.toString('utf8');
    record('recv', text);
    if (text.includes('"transcript.done"')) {
      // Small grace period in case anything trails it.
      setTimeout(() => resolveDone?.(), 400).unref();
    }
  });

  // Stream. Realtime pacing matters for the duration probe (spike 4), where a
  // server-side cap would be wall-clock rather than byte-count based.
  const sendStarted = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (chunk === undefined) continue;
    if (socket.readyState !== WebSocket.OPEN) {
      console.log(
        `# socket closed after ${String(i)} chunks (${((i * CHUNK_DURATION_MS) / 1000).toFixed(1)}s of audio)`,
      );
      break;
    }
    socket.send(chunk);
    if (options.realtime) {
      const target = sendStarted + (i + 1) * CHUNK_DURATION_MS;
      const wait = target - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
  audioEndAt = Date.now();
  console.log(
    `# end of audio at ${String(audioEndAt - openedAt)}ms; timings below are relative to it`,
  );

  if (socket.readyState === WebSocket.OPEN && options.end !== 'none') {
    const message = options.end === 'finalize' ? '{"type":"finalize"}' : '{"type":"audio.done"}';
    socket.send(message);
    record('send', message);
  }

  // Wait for the server to finish, or for the cap.
  const result = await Promise.race([
    closed.then((c) => ({ kind: 'closed' as const, ...c })),
    turnDone.then(() => ({ kind: 'transcript_done' as const })),
    sleepUnref(options.maxSeconds * 1000).then(() => ({ kind: 'timeout' as const })),
  ]).catch((error: unknown) => ({
    kind: 'error' as const,
    message: error instanceof Error ? redactString(error.message) : String(error),
  }));

  if (socket.readyState === WebSocket.OPEN) socket.close();

  /* ---- summary ---- */
  const firstSpeechFinal = frames.find(
    (f) => f.direction === 'recv' && f.raw.includes('"speech_final":true'),
  );
  const done = frames.find((f) => f.direction === 'recv' && f.raw.includes('"transcript.done"'));

  console.log('\n# ---- summary ----');
  console.log(`# outcome: ${JSON.stringify(result)}`);
  console.log(`# frames received: ${String(frames.filter((f) => f.direction === 'recv').length)}`);
  console.log(
    `# end-of-audio → first speech_final: ${firstSpeechFinal === undefined ? 'never arrived' : `${String(firstSpeechFinal.tSinceAudioEnd)}ms`}`,
  );
  console.log(
    `# end-of-audio → transcript.done:   ${done === undefined ? 'never arrived' : `${String(done.tSinceAudioEnd)}ms`}`,
  );
  console.log(`# session wall-clock: ${((Date.now() - openedAt) / 1000).toFixed(1)}s`);

  // Every distinct field name the server used, so a field the Grok CLI's serde
  // struct would drop cannot go unnoticed (spike 1, ).
  const fields = new Set<string>();
  for (const frame of frames) {
    if (frame.direction !== 'recv') continue;
    try {
      const parsed: unknown = JSON.parse(frame.raw);
      if (parsed !== null && typeof parsed === 'object') {
        for (const key of Object.keys(parsed)) fields.add(key);
      }
    } catch {
      /* non-JSON frame; already recorded verbatim */
    }
  }
  console.log(`# server field names seen: ${[...fields].sort().join(', ')}`);

  const outPath = resolve('docs/spike-raw', `${options.label}.jsonl`);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    `${[
      JSON.stringify({
        label: options.label,
        url: printableUrl,
        wav: options.wav,
        audioSeconds,
        options: { ...options, extraParams: options.extraParams },
        result,
      }),
      ...frames.map((f) => JSON.stringify(f)),
    ].join('\n')}\n`,
    'utf8',
  );
  console.log(`# raw frames written to ${outPath}`);
}

main().catch((error: unknown) => {
  console.error(redactString(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
