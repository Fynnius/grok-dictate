/**
 * JSON-lines protocol for `grok-dictate-capture`.
 *
 * Electron-free on purpose: the parser is unit-tested under plain Node, and a
 * renderer message shape is synthesised here so `CaptureCoordinator` never
 * learns which process produced the PCM.
 */

import type { RendererToMain } from '@contracts/events.js';
import { appError, err, ok, type Result } from '@shared/result.js';
import type { AppError } from '@shared/result.js';

export type AppToCapture =
  | { type: 'start'; sessionId: string; sampleRate: number; chunkBytes: number }
  | { type: 'stop'; sessionId: string }
  | { type: 'cancel'; sessionId: string };

export type CaptureToApp =
  | { type: 'started'; sessionId: string; actualSampleRate: number }
  | { type: 'chunk'; sessionId: string; pcm: string }
  | { type: 'level'; sessionId: string; level: number }
  | { type: 'drained'; sessionId: string }
  | {
      type: 'error';
      sessionId: string;
      code: 'audio_device' | 'audio_permission';
      message: string;
      hint: string;
    };

export function encodeCaptureCommand(command: AppToCapture): string {
  return `${JSON.stringify(command)}\n`;
}

export function parseCaptureFrame(line: string): Result<CaptureToApp> {
  const trimmed = line.trim();
  if (trimmed.length === 0) return err(appError('helper_protocol', 'empty line', null));

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed) as unknown;
  } catch {
    return err(appError('helper_protocol', 'not JSON', null));
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return err(appError('helper_protocol', 'top-level value is not a JSON object', null));
  }
  const object = parsed as Record<string, unknown>;
  const type = object['type'];
  if (typeof type !== 'string') {
    return err(appError('helper_protocol', 'missing or non-string "type"', null));
  }

  switch (type) {
    case 'started': {
      const sessionId = stringField(object, 'sessionId');
      const actualSampleRate = numberField(object, 'actualSampleRate');
      if (sessionId === null || actualSampleRate === null) {
        return err(
          appError('helper_protocol', 'started is missing sessionId or actualSampleRate', null),
        );
      }
      return ok({ type: 'started', sessionId, actualSampleRate });
    }
    case 'chunk': {
      const sessionId = stringField(object, 'sessionId');
      const pcm = stringField(object, 'pcm');
      if (sessionId === null || pcm === null) {
        return err(appError('helper_protocol', 'chunk is missing sessionId or pcm', null));
      }
      return ok({ type: 'chunk', sessionId, pcm });
    }
    case 'level': {
      const sessionId = stringField(object, 'sessionId');
      const level = numberField(object, 'level');
      if (sessionId === null || level === null) {
        return err(appError('helper_protocol', 'level is missing sessionId or level', null));
      }
      return ok({ type: 'level', sessionId, level });
    }
    case 'drained': {
      const sessionId = stringField(object, 'sessionId');
      if (sessionId === null) {
        return err(appError('helper_protocol', 'drained is missing sessionId', null));
      }
      return ok({ type: 'drained', sessionId });
    }
    case 'error': {
      const sessionId = stringField(object, 'sessionId');
      const codeRaw = stringField(object, 'code');
      const message = stringField(object, 'message') ?? 'capture failed';
      const hint = stringField(object, 'hint') ?? '';
      if (sessionId === null) {
        return err(appError('helper_protocol', 'error is missing sessionId', null));
      }
      const code = codeRaw === 'audio_permission' ? 'audio_permission' : 'audio_device';
      return ok({ type: 'error', sessionId, code, message, hint });
    }
    default:
      return err(appError('helper_protocol', `unknown capture frame type "${type}"`, null));
  }
}

/**
 * Turn a capture-process frame into the renderer-shaped message the
 * coordinator already understands. Base64 is decoded here so the rest of the
 * app never sees the wire encoding.
 */
export function captureFrameToRenderer(frame: CaptureToApp): RendererToMain | null {
  switch (frame.type) {
    case 'started':
      return {
        type: 'capture-started',
        sessionId: frame.sessionId,
        actualSampleRate: frame.actualSampleRate,
      };
    case 'chunk': {
      const pcm = decodeBase64(frame.pcm);
      if (pcm === null) return null;
      return { type: 'capture-chunk', sessionId: frame.sessionId, pcm };
    }
    case 'level':
      return { type: 'capture-level', sessionId: frame.sessionId, level: clampLevel(frame.level) };
    case 'drained':
      return { type: 'capture-drained', sessionId: frame.sessionId };
    case 'error':
      return {
        type: 'capture-error',
        sessionId: frame.sessionId,
        error: captureError(frame),
      };
  }
}

export function captureError(frame: Extract<CaptureToApp, { type: 'error' }>): AppError {
  return appError(frame.code, frame.message, frame.hint.length > 0 ? frame.hint : null);
}

function stringField(object: Record<string, unknown>, key: string): string | null {
  const value = object[key];
  return typeof value === 'string' ? value : null;
}

function numberField(object: Record<string, unknown>, key: string): number | null {
  const value = object[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampLevel(level: number): number {
  if (!Number.isFinite(level)) return 0;
  if (level < 0) return 0;
  if (level > 1) return 1;
  return level;
}

function decodeBase64(value: string): ArrayBuffer | null {
  try {
    const buffer = Buffer.from(value, 'base64');
    const copy = new Uint8Array(buffer.byteLength);
    copy.set(buffer);
    return copy.buffer;
  } catch {
    return null;
  }
}
