/**
 * FROZEN CONTRACT — user configuration schema and defaults.
 *
 * Frozen at the end of Phase 1 (IMPLEMENTATION-PLAN.md §2). Phase 4 owns the
 * settings UI and the on-disk store; this file owns the shape and the defaults.
 *
 * Parsing is forgiving in one specific way: an unreadable or partially invalid
 * file falls back to defaults per field rather than failing the app to a stop.
 * Dictation must still work when the config is corrupt.
 */

import { z } from 'zod';
import {
  DEFAULT_ENDPOINTING_MS,
  KEYTERM_MAX_COUNT,
  KEYTERM_MAX_LENGTH,
} from '../src/shared/constants.js';

/**
 * `auto` here means *the app's own detection*, not the wire value. Grok's
 * `auto` never reaches the wire — `language.rs` resolves it from the process
 * locale and the code asserts "must never send auto to STT API". Whatever we
 * send is always a concrete catalog code.
 *
 * What `auto` actually does is decided by spike 1 and 3 (docs/spike-results.md):
 * if the server reports a detected language, read it; otherwise sticky
 * per-utterance detection.
 */
export const LANGUAGE_MODES = ['auto', 'de', 'en'] as const;
export const LanguageModeSchema = z.enum(LANGUAGE_MODES);
export type LanguageMode = (typeof LANGUAGE_MODES)[number];

/** The 25-code xAI STT catalog. */
export const STT_LANGUAGE_CATALOG = [
  'ar',
  'cs',
  'da',
  'nl',
  'en',
  'fil',
  'fr',
  'de',
  'hi',
  'id',
  'it',
  'ja',
  'ko',
  'mk',
  'ms',
  'fa',
  'pl',
  'pt',
  'ro',
  'ru',
  'es',
  'sv',
  'th',
  'tr',
  'vi',
] as const;

/** `language.rs:30` — `STT_LANGUAGE_DEFAULT = "en"`. */
export const STT_LANGUAGE_DEFAULT = 'en';

export const HotkeyBindingsSchema = z.object({
  /** Push-to-talk. `fn` is `kCGEventFlagMaskSecondaryFn`. */
  ptt: z.string().min(1).default('fn'),
  /** Hands-free toggle. */
  toggle: z.string().min(1).default('fn+space'),
  /**
   * In-memory re-insertion, NOT a paste. Wispr Flow uses the
   * same combination for "Paste Last Transcript" (§4.7) — convergent design.
   */
  retry: z.string().min(1).default('ctrl+cmd+v'),
});
export type HotkeyBindings = z.infer<typeof HotkeyBindingsSchema>;

export const AppConfigSchema = z.object({
  languageMode: LanguageModeSchema.default('auto'),

  /**
   * Server-side custom dictionary: max 100 terms × 50 chars.
   *  expects this to improve real accuracy *more* than
   * language detection does, because the user's speech is code-switched
   * ("deployed that on the staging server") and no language setting
   * handles a sentence whose correct answer is neither language.
   */
  keyterms: z.array(z.string().min(1).max(KEYTERM_MAX_LENGTH)).max(KEYTERM_MAX_COUNT).default([]),

  /**
   * Silence before the server declares end of utterance — and, measured, the
   * single biggest lever on transcript quality this app has. See
   * `DEFAULT_ENDPOINTING_MS` for the field data behind the default.
   */
  endpointingMs: z.number().int().min(10).max(5000).default(DEFAULT_ENDPOINTING_MS),

  /**
   * Repair the joins between `speech_final` segments before inserting.
   *
   * One hold produces several segments, each re-transcribed with no knowledge
   * of the one before it, and the joins are where the text goes wrong —
   * duplicated seam words, mid-sentence capitals, "Thank you." hallucinated out
   * of the closing silence. `src/shared/stitch.ts` has the evidence and the
   * three rules.
   *
   * On by default because every rule is a measured artefact, and a setting
   * because this is the one thing in the app that rewrites what a person said:
   * a user who disagrees with a repair must be able to switch it off without
   * waiting for a release. Off restores the historical `segments.join(' ')`.
   */
  repairSeams: z.boolean().default(true),

  hotkeys: HotkeyBindingsSchema.default({
    ptt: 'fn',
    toggle: 'fn+space',
    retry: 'ctrl+cmd+v',
  }),

  /**
   * Days of history to keep; 0 means keep forever. : the history
   * file is "a partial keylogger" — everything ever dictated, searchable, in
   * one place. Retention plus an explicit purge is the conscious mitigation.
   */
  historyRetentionDays: z.number().int().min(0).max(3650).default(90),

  /** Short start/stop cues, under ~80 ms. Dictation is
   *  eyes-free; this is the entire feedback channel. */
  audioCues: z.boolean().default(true),

  launchAtLogin: z.boolean().default(false),

  /**
   * Keep the Grok CLI login alive by running `grok models` in the background
   * when the token is near expiry, instead of failing the dictation and telling
   * the user to run `grok` themselves.
   *
   * **This is not the refresh path §5.6 forbids** — the CLI does the refresh,
   * the rotation and the locked write, exactly as it does when a human runs it.
   * `src/main/auth/renew.ts` documents the measured behaviour, including the one
   * surprising case (a refresh the *server* rejects makes the CLI clear
   * `auth.json`; a network failure leaves it alone).
   *
   * A setting because it spawns a process and talks to the network on the user's
   * behalf, and somebody will reasonably want neither. Off means the previous
   * behaviour: an expired token is an error that says to run `grok`.
   */
  autoRenewLogin: z.boolean().default(true),

  /**
   * Emit `{"type":"finalize"}` instead of `{"type":"audio.done"}` at end of turn.
   *
   * **Defaults to false on the evidence of spike 2** (docs/spike-results.md).
   *  expected `finalize` to be faster because it is documented
   * specifically for push-to-talk; measured, the two are indistinguishable
   * (318-344 ms end-of-audio → `speech_final`, across `endpointing` 50 and 400).
   * `audio.done` additionally produces `transcript.done` — the only source of
   * the `duration` telemetry §11.1.6 wants — and lets the server close the
   * socket, whereas `finalize` leaves it open with no terminal frame.
   *
   * Kept as a setting rather than deleted because `finalize` is the right
   * choice if the app ever holds one socket across several utterances.
   */
  useFinalize: z.boolean().default(false),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;

export const DEFAULT_CONFIG: AppConfig = AppConfigSchema.parse({});

/**
 * Parse a config value that came from disk. Never throws and never returns
 * `undefined`: unknown or invalid fields fall back to their default, and the
 * rejected fields are reported so the caller can warn instead of silently
 * changing the user's settings.
 */
export function parseConfig(raw: unknown): { config: AppConfig; issues: string[] } {
  const parsed = AppConfigSchema.safeParse(raw);
  if (parsed.success) return { config: parsed.data, issues: [] };

  const issues = parsed.error.issues.map(
    (issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`,
  );

  // Retry field-by-field so one bad value does not discard the whole file.
  const source = raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const salvaged: Record<string, unknown> = {};
  for (const key of Object.keys(AppConfigSchema.shape)) {
    if (!(key in source)) continue;
    const fieldSchema = AppConfigSchema.shape[key as keyof typeof AppConfigSchema.shape];
    const fieldResult = fieldSchema.safeParse(source[key]);
    if (fieldResult.success) salvaged[key] = fieldResult.data;
  }
  return { config: AppConfigSchema.parse(salvaged), issues };
}

/**
 * Resolve the value to put in the `language` query parameter, or `null` to omit
 * it entirely.
 *
 * **This is not what  planned, and spike 1/3 are why**
 * (docs/spike-results.md). The server performs real acoustic language detection
 * and reports it in every `transcript.partial` as a `language` field — a field
 * the Grok CLI's `serde` struct silently discards (`stt/types.rs`). English
 * audio sent with `language=de` came back `"language":"en"` with a correctly
 * formatted English transcript, so the parameter did not steer recognition or
 * formatting in any test we could construct.
 *
 * Consequences:
 *   - `auto` **omits** the parameter. Sending a wrong code is at best inert and
 *     at worst a silent trap.
 *   - `de`/`en` still send the code, because it costs nothing and it is the
 *     honest expression of the user's intent — but see the note in
 *     docs/spike-results.md: it is **not** a reliable override. Phase 4's tray
 *     "force DE/EN" escape hatch (§5.9) cannot be implemented this way.
 *   - The former Layer 1 "sticky detection" and Layer 2 "replay" designs are
 *     unnecessary. Read the field.
 *
 * `localeSubtag` is retained only as the last resort for an explicit mode, in
 * the spirit of `language.rs:176-186`; it is unused on the `auto` path.
 */
export function resolveWireLanguage(
  mode: LanguageMode,
  detected: string | undefined,
  localeSubtag: string | undefined,
): string | null {
  if (mode === 'auto') return null;
  if (isCatalogLanguage(mode)) return mode;
  if (detected !== undefined && isCatalogLanguage(detected)) return detected;
  if (localeSubtag !== undefined && isCatalogLanguage(localeSubtag)) return localeSubtag;
  return STT_LANGUAGE_DEFAULT;
}

export function isCatalogLanguage(code: string): boolean {
  return (STT_LANGUAGE_CATALOG as readonly string[]).includes(code);
}
