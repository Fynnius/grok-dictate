/**
 * Server frame parsing, and the transcript semantics that hang off it.
 *
 * ## What the server actually sends
 *
 * The Grok CLI's `serde` struct (`stt/types.rs`) deserialises only `text`,
 * `is_final` and `speech_final`, with an `Unknown` catch-all.
 * suspected that was dropping something; spike 1 confirmed it. Across every
 * captured session (`docs/spike-raw/*.jsonl`) the server sent:
 *
 *     duration, id, is_final, language, speech_final, start, text, type, words
 *
 * `language` is **real acoustic detection** — English audio sent with
 * `language=de` came back `"language":"en"` — which is why
 * three-layer detection design does not exist in this codebase.
 *
 * `words[]` (per-word start/end times) is parsed to nothing on purpose: v1 has
 * no use for it, and the finding is recorded in docs/spike-results.md so nobody
 * re-derives it. Note if you ever do want it: interim timings are turn-relative
 * from 0.0, the `speech_final` frame's are on a different clock.
 *
 * ## The three-way partial rule
 *
 * `pipeline.rs:273-279`, which  calls the most important design
 * comment in the crate:
 *
 * > Chunk-final (`is_final && !speech_final`) text is locked: the server sends
 * > it as a delta of the turn. Stitch those deltas into the live preview …
 * > **The committed prompt text never comes from here — only from
 * > `speech_final`, which the server produces as a clean one-pass
 * > re-transcription of the whole turn (better than stitched deltas).**
 *
 * The spike saw that difference directly: mid-stream partials read
 * "…ungefähr **20 Minuten**", the `speech_final` re-transcription reads
 * "…ungefähr **zwanzig Minuten**", with punctuation and casing added.
 */

import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * Wire schemas
 * ------------------------------------------------------------------ */

/**
 * Tolerant by design. A field the server adds tomorrow must not break
 * dictation, and a field it stops sending must degrade to a default rather than
 * to a rejected frame — `z.object` in Zod 4 strips unknown keys instead of
 * failing, which is exactly the `Unknown` catch-all behaviour the Rust struct
 * has.
 */
const CreatedSchema = z.object({
  type: z.literal('transcript.created'),
  id: z.string().optional(),
});

const PartialSchema = z.object({
  type: z.literal('transcript.partial'),
  text: z.string().optional(),
  is_final: z.boolean().optional(),
  speech_final: z.boolean().optional(),
  /** Spike 1. The whole of the app's language detection. */
  language: z.string().optional(),
  duration: z.number().nullish(),
});

const DoneSchema = z.object({
  type: z.literal('transcript.done'),
  /**
   * Always `""` in every captured run — `transcript.done` is a duration
   * receipt, not a transcript (docs/spike-results.md, "Incidental findings").
   */
  text: z.string().optional(),
  /** The free telemetry  wants. Audio seconds. */
  duration: z.number().nullish(),
});

const ErrorSchema = z.object({
  type: z.literal('error'),
  message: z.string().optional(),
});

const TypedSchema = z.object({ type: z.string() });

/* ------------------------------------------------------------------ *
 * Parsed shape
 * ------------------------------------------------------------------ */

export type ServerFrame =
  | { readonly kind: 'created'; readonly id: string | null }
  | {
      readonly kind: 'partial';
      readonly text: string;
      readonly isFinal: boolean;
      readonly speechFinal: boolean;
      readonly language: string | null;
      readonly durationSec: number | null;
    }
  | { readonly kind: 'done'; readonly durationSec: number | null }
  | { readonly kind: 'error'; readonly message: string }
  /** A `type` we do not model. Logged, never fatal — as `stt/types.rs` does. */
  | { readonly kind: 'unknown'; readonly type: string }
  | { readonly kind: 'unparseable'; readonly reason: string };

/** Total: never throws, whatever the server or the network produces. */
export function parseServerFrame(raw: string): ServerFrame {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { kind: 'unparseable', reason: 'not JSON' };
  }

  const typed = TypedSchema.safeParse(json);
  if (!typed.success) return { kind: 'unparseable', reason: 'no `type` field' };

  switch (typed.data.type) {
    case 'transcript.created': {
      const parsed = CreatedSchema.safeParse(json);
      return { kind: 'created', id: parsed.success ? (parsed.data.id ?? null) : null };
    }
    case 'transcript.partial': {
      const parsed = PartialSchema.safeParse(json);
      if (!parsed.success) return { kind: 'unparseable', reason: 'malformed transcript.partial' };
      return {
        kind: 'partial',
        text: parsed.data.text ?? '',
        isFinal: parsed.data.is_final ?? false,
        speechFinal: parsed.data.speech_final ?? false,
        language: parsed.data.language ?? null,
        durationSec: parsed.data.duration ?? null,
      };
    }
    case 'transcript.done': {
      const parsed = DoneSchema.safeParse(json);
      if (!parsed.success) return { kind: 'unparseable', reason: 'malformed transcript.done' };
      return { kind: 'done', durationSec: parsed.data.duration ?? null };
    }
    case 'error': {
      const parsed = ErrorSchema.safeParse(json);
      return {
        kind: 'error',
        message:
          parsed.success && parsed.data.message !== undefined && parsed.data.message.length > 0
            ? parsed.data.message
            : 'the xAI speech service reported an error with no message',
      };
    }
    default:
      return { kind: 'unknown', type: typed.data.type };
  }
}

/* ------------------------------------------------------------------ *
 * The three-way partial rule (`pipeline.rs:310-330`)
 * ------------------------------------------------------------------ */

export type TranscriptUpdate =
  /** Live preview text only. : never inserted. */
  | { readonly kind: 'interim'; readonly text: string }
  /** A `speech_final` segment — the ONLY text that may be inserted. */
  | { readonly kind: 'final'; readonly text: string }
  | { readonly kind: 'none' };

/**
 * Turns a stream of `transcript.partial` frames into preview text and committed
 * segments, exactly as `pipeline.rs:310-330` does:
 *
 *   - `speech_final`        → clear the locked prefix, emit a final
 *   - `is_final` (only)     → append to the locked prefix, emit as interim
 *   - neither               → emit `locked prefix + text` as interim
 *
 * Empty frames are skipped rather than emitted. Spike observation: the first one
 * or two partials of a turn carry `"text":""` and sometimes `is_final:true`, so
 * a naive "first partial means speech started" check misfires — the Grok CLI
 * guards this the same way at `pipeline.rs:303-306`.
 */
export class TranscriptAccumulator {
  #locked = '';

  /** Text a caller would show right now, without a new frame. */
  get preview(): string {
    return this.#locked;
  }

  accept(frame: Extract<ServerFrame, { kind: 'partial' }>): TranscriptUpdate {
    const text = frame.text.trim();
    if (text.length === 0) return { kind: 'none' };

    if (frame.speechFinal) {
      // The clean one-pass re-transcription of the whole turn. Everything
      // stitched so far is superseded by it.
      this.#locked = '';
      return { kind: 'final', text };
    }

    if (frame.isFinal) {
      this.#locked = join(this.#locked, text);
      return { kind: 'interim', text: this.#locked };
    }

    return { kind: 'interim', text: join(this.#locked, text) };
  }

  /** A new turn on the same client must not inherit the previous prefix. */
  reset(): void {
    this.#locked = '';
  }
}

function join(prefix: string, text: string): string {
  return prefix.length === 0 ? text : `${prefix} ${text}`;
}
