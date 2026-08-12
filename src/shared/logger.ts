/**
 * Structured logging with redaction wired into the core.
 *
 * IMPLEMENTATION-PLAN.md §3.1.1 / §4: every sink receives text that has already
 * passed through `serialiseRedacted`. There is deliberately no way to register
 * a sink that sees the raw record — `emit()` redacts first and hands sinks a
 * finished line plus a *redacted* record. That is the whole point: call-site
 * discipline fails eventually, structure does not.
 */

import { redactString, serialiseRedacted } from './redact.js';

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const LEVEL_RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/** Structured fields attached to a log line. Redacted before any sink sees them. */
export type LogFields = Record<string, unknown>;

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly scope: string;
  readonly msg: string;
  readonly fields?: LogFields;
}

/**
 * A destination for log lines. `line` is the serialised, redacted JSON; `record`
 * is the same content structurally, also redacted, for sinks that want fields.
 */
export type LogSink = (line: string, record: LogRecord) => void;

export interface Logger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** Derive a logger with a nested scope, e.g. `stt` → `stt.socket`. */
  child(scope: string): Logger;
}

let sinks: LogSink[] = [];
let minLevel: LogLevel = 'debug';
/** Injectable clock so tests get deterministic timestamps. */
let now: () => Date = () => new Date();

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export function addLogSink(sink: LogSink): () => void {
  sinks.push(sink);
  return () => {
    sinks = sinks.filter((s) => s !== sink);
  };
}

export function clearLogSinks(): void {
  sinks = [];
}

/** Test seam only. Not used by application code. */
export function __setLogClock(clock: () => Date): void {
  now = clock;
}

function emit(level: LogLevel, scope: string, msg: string, fields?: LogFields): void {
  if (LEVEL_RANK[level] < LEVEL_RANK[minLevel]) return;
  if (sinks.length === 0) return;

  // Redact before anything is shared. `msg` is scrubbed as a string; `fields`
  // go through the structural walk plus the serialised second pass.
  const safeMsg = redactString(msg);
  const safeFields = fields === undefined ? undefined : parseRedactedFields(fields);
  const record: LogRecord = {
    ts: now().toISOString(),
    level,
    scope,
    msg: safeMsg,
    ...(safeFields === undefined ? {} : { fields: safeFields }),
  };
  const line = serialiseRedacted(record);

  for (const sink of sinks) {
    try {
      sink(line, record);
    } catch {
      // A failing sink must never break the app, and must never be reported
      // through the logger (that would recurse).
    }
  }
}

/**
 * Round-trip fields through the redaction serialiser so the `record` handed to
 * sinks is provably the same redacted content as `line` — not a parallel,
 * less-scrubbed copy. Returns `undefined` rather than throwing if anything is
 * unserialisable, because losing a field is better than losing the process.
 */
function parseRedactedFields(fields: LogFields): LogFields | undefined {
  try {
    const parsed: unknown = JSON.parse(serialiseRedacted(fields));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as LogFields;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export function createLogger(scope: string): Logger {
  return {
    debug: (msg, fields) => emit('debug', scope, msg, fields),
    info: (msg, fields) => emit('info', scope, msg, fields),
    warn: (msg, fields) => emit('warn', scope, msg, fields),
    error: (msg, fields) => emit('error', scope, msg, fields),
    child: (sub) => createLogger(`${scope}.${sub}`),
  };
}

/** Human-readable sink for the terminal during development. */
export function consoleSink(write: (s: string) => void): LogSink {
  return (_line, record) => {
    const fields =
      record.fields === undefined || Object.keys(record.fields).length === 0
        ? ''
        : ` ${serialiseRedacted(record.fields)}`;
    write(
      `${record.ts} ${record.level.toUpperCase().padEnd(5)} ${record.scope}: ${record.msg}${fields}`,
    );
  };
}
