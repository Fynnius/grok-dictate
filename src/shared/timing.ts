/**
 * Session round-trip timing channel.
 *
 * One greppable `key=value` line per lifecycle event, plus one `event=summary`
 * line when the session returns to idle. The formatter is pure so Vitest can
 * drive it without Electron; the orchestrator is the only thing that stamps
 * a clock and hands the line to the logger.
 *
 * **Stamp on receive, not on send.** Events that originate in the capture
 * renderer (device open, first PCM) have no logger of their own (the renderer
 * cannot use `src/shared/logger.ts`). They ride contract messages and are
 * marked when main *receives* them. That answers "when could the rest of the
 * app act" — hotkey → first PCM the STT client can forward — which is the
 * product latency later items claim to move. Stamping on send would measure
 * the device and hide the IPC hop; that split can be added as an extra field
 * later, it is not needed to land the ruler.
 *
 * Zero transcript text. Lengths and counts only. Law 3.
 *
 * Default on: a diagnostic nobody enables diagnoses nothing. `GROK_DICTATE_TIMING=0`
 * turns the channel off.
 */

import { envString } from './env.js';

export const TIMING_EVENTS = [
  'hotkey_down',
  'capture_requested',
  'device_open',
  'first_pcm_main',
  'socket_open',
  'first_partial',
  'hotkey_up',
  'audio_done',
  'final_transcript',
  'silence_gated',
  'insert_begin',
  'insert_end',
  'idle',
  'summary',
] as const;

export type TimingEvent = (typeof TIMING_EVENTS)[number];

/**
 * Extra fields on a timing line. Values are scalars only; a string that looks
 * like transcript text is dropped rather than logged — the backstop for a
 * caller who handed over `text` by habit.
 */
export type TimingFields = Record<string, string | number | boolean | null | undefined>;

const KEY_ORDER = [
  'session',
  'event',
  'elapsed_ms',
  'gated',
  'reason',
  'peak',
  'rms',
  'duration_ms',
  'text_len',
  'pcm_chunks',
  'partials',
  'finals',
  'pcm_bytes',
  'ok',
  'verified',
  'tier',
] as const;

const FORBIDDEN_KEYS = new Set([
  'text',
  'transcript',
  'interim',
  'committed',
  'body',
  'message',
  'partial',
  'final',
]);

/**
 * True unless the operator has explicitly switched the channel off.
 *
 * Chosen as an opt-out rather than an opt-in: W0 exists to make later latency
 * claims greppable from a normal log, and a flag nobody sets diagnoses
 * nothing. The line is one `info` record per lifecycle event, cheap enough
 * to leave on.
 */
export function timingEnabled(): boolean {
  const value = envString('GROK_DICTATE_TIMING');
  if (value === undefined) return true;
  return value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Format one timing line. Stable key order, `key=value` grammar, no spaces
 * inside values (booleans are `true`/`false`, numbers are decimal).
 *
 * Unknown extra keys are appended in alphabetical order after the known ones
 * so a new measurement does not reshuffle the line a grep already knows.
 */
export function formatTimingLine(
  sessionId: string,
  event: TimingEvent,
  elapsedMs: number,
  extra: TimingFields = {},
): string {
  const fields: TimingFields = {
    session: sessionId,
    event,
    elapsed_ms: elapsedMs,
    ...extra,
  };
  const seen = new Set<string>();
  const parts: string[] = [];

  for (const key of KEY_ORDER) {
    if (!(key in fields)) continue;
    const formatted = formatField(key, fields[key]);
    if (formatted === null) continue;
    parts.push(formatted);
    seen.add(key);
  }

  const rest = Object.keys(fields)
    .filter((key) => !seen.has(key))
    .sort();
  for (const key of rest) {
    const formatted = formatField(key, fields[key]);
    if (formatted === null) continue;
    parts.push(formatted);
  }

  return parts.join(' ');
}

function formatField(key: string, value: TimingFields[string]): string | null {
  if (FORBIDDEN_KEYS.has(key)) return null;
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' && looksLikeTranscript(value)) return null;
  if (!isSafeKey(key)) return null;
  return `${key}=${formatValue(value)}`;
}

function formatValue(value: string | number | boolean): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '0';
    return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
  }
  // Values must stay a single token. Spaces would break the grammar.
  return value.replace(/\s+/g, '_').slice(0, 64);
}

function isSafeKey(key: string): boolean {
  return /^[a-z][a-z0-9_]*$/.test(key);
}

/**
 * A string long enough and word-like enough that putting it on a timing line
 * would be logging what the user said. Lengths and short codes (`ax`, `en`)
 * pass; a sentence does not.
 *
 * **Chosen, not measured.** 24 characters is longer than any field this
 * channel is supposed to carry (`session` UUIDs aside, which are hex and fail
 * the word-like test) and shorter than "yes that's the one".
 */
function looksLikeTranscript(value: string): boolean {
  if (value.length < 24) return false;
  return /[a-zA-Z]{3,}\s+[a-zA-Z]{3,}/.test(value);
}

/**
 * One session's marks, no I/O. The orchestrator constructs one per turn and
 * logs each `mark` / the `summary` through the existing logger.
 */
export class TimingSession {
  readonly sessionId: string;
  readonly startedAt: number;
  readonly marks: { event: TimingEvent; elapsedMs: number }[] = [];
  pcmChunks = 0;
  partials = 0;
  finals = 0;
  textLen = 0;

  constructor(sessionId: string, startedAt: number) {
    this.sessionId = sessionId;
    this.startedAt = startedAt;
  }

  elapsed(now: number): number {
    return Math.max(0, now - this.startedAt);
  }

  /**
   * Record a mark. First write of a given event wins — "first PCM", "first
   * partial" — so a second call is a no-op for that name. `summary` and
   * `silence_gated` may fire once by construction.
   */
  mark(event: TimingEvent, now: number): { elapsedMs: number; first: boolean } {
    const elapsedMs = this.elapsed(now);
    const already = this.marks.some((entry) => entry.event === event);
    if (already) return { elapsedMs, first: false };
    this.marks.push({ event, elapsedMs });
    return { elapsedMs, first: true };
  }

  summaryFields(now: number): TimingFields {
    const fields: TimingFields = {
      elapsed_ms: this.elapsed(now),
      pcm_chunks: this.pcmChunks,
      partials: this.partials,
      finals: this.finals,
      text_len: this.textLen,
    };
    for (const { event, elapsedMs } of this.marks) {
      if (event === 'summary') continue;
      fields[event] = elapsedMs;
    }
    return fields;
  }
}
