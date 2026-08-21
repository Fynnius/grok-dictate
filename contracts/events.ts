/**
 * Internal event types crossing the main↔renderer boundary.
 *
 * Frozen at the end of Phase 1 (IMPLEMENTATION-PLAN.md §2) and reopened by
 * Phase 5, which is the only phase permitted to change a contract. The preload
 * script (`src/preload/index.ts`) exposes exactly this surface and nothing
 * else, so every window — HUD, settings, capture — talks to the main process
 * through these types.
 *
 * ## Phase 5 changes, and why
 *
 * - **Added `insert-text`.** `retry-insert` re-inserts the app's own
 *   `lastTranscript` and nothing else, so history could only offer *Re-insert*
 *   on the row that happened to be the last one, and the Scratchpad could not
 *   insert an edited transcript at all (docs/phase-4-report.md §5.1). Both
 *   features were shipped stunted and labelled as such.
 * - **Added `dismiss-hud`.** There was no "hide the pill" message, so the HUD's
 *   *Dismiss* button sent `cancel` and the main process hid the pill on any
 *   `cancel` the machine ignored (§5.2). That conflated "stop showing me this"
 *   with "throw away what I just said".
 * - **Removed `debug-command` and `DebugCommand`.** The walking skeleton's
 *   control surface is gone (docs/phase-1-report.md §5.3).
 * - **Removed `interim`, `final` and `level` from `MainToRenderer`.** All three
 *   were defined in Phase 1, never sent by anybody, and are already carried by
 *   `HudView` — which is what the HUD actually reads. docs/phase-1-report.md
 *   §7.7 flagged them as unvalidated and IMPLEMENTATION-PLAN.md §5.1 says to
 *   treat an unvalidated contract element as a gap. They were duplicates, so
 *   the gap closes by deletion rather than by inventing a consumer.
 *
 * See `state-machine.md` for what drives the session states below.
 */

import type { InsertTier } from './helper-protocol.js';
import type { AppError } from '../src/shared/result.js';
import type { AppConfig, LanguageMode } from './config.js';

/* ------------------------------------------------------------------ *
 * Session state (see state-machine.md)
 * ------------------------------------------------------------------ */

export const SESSION_STATES = ['idle', 'recording', 'processing', 'inserting', 'blocked'] as const;
export type SessionState = (typeof SESSION_STATES)[number];

/** How the current session was started. `toggle` is hands-free (Fn+Space). */
export type SessionMode = 'hold' | 'toggle';

/* ------------------------------------------------------------------ *
 * HUD view model
 * ------------------------------------------------------------------ */

/**
 * Why a transcript was not inserted. Each maps to different HUD copy, because
 * "we couldn't type it" and "you were in a password field" need different
 * advice from the user's point of view.
 */
export type NotInsertedReason =
  | 'insert_failed' // both tiers declined
  | 'secure_input' // Secure Input was active
  | 'target_changed' // focus moved during processing
  | 'helper_unavailable' // the Swift helper died mid-request
  /**
   * The dictation itself failed — the network dropped, the token expired, the
   * server errored — after some text had already been transcribed. Added in
   * Phase 5: until then `toIdleWithError` discarded whatever was already
   * committed, so a drop after a minute of good dictation lost all of it and
   * `Ctrl+Cmd+V` had nothing to re-insert (docs/phase-3-report.md §5.2).
   */
  | 'session_error';

/**
 * Everything the HUD needs to render, as one value. Phase 4 owns the pixels;
 * this is the data.
 *
 * `inserted` and `not_inserted` both carry the **full transcript**. That is not
 * decoration:  — Unicode injection can half-succeed silently,
 * and seeing the full text next to what actually landed is the only way a user
 * catches it at a glance.
 */
export type HudView =
  | { kind: 'hidden' }
  | { kind: 'recording'; elapsedMs: number; level: number; interim: string; mode: SessionMode }
  | { kind: 'processing'; interim: string }
  | { kind: 'inserted'; text: string; tier: InsertTier }
  | { kind: 'not_inserted'; text: string; reason: NotInsertedReason; detail: string | null }
  | { kind: 'blocked' }
  | { kind: 'error'; message: string; hint: string | null };

/* ------------------------------------------------------------------ *
 * History
 * ------------------------------------------------------------------ */

/** One dictation, as stored by Phase 4. */
export interface HistoryEntry {
  readonly id: string;
  /** ISO-8601 UTC. */
  readonly at: string;
  readonly text: string;
  /** Audio seconds reported by the server in `transcript.done`. */
  readonly durationSec: number | null;
  /**
   * The language the server detected for this utterance (spike 1). Falls back
   * to whatever was sent when the server reported nothing.
   * warns that a typo'd code fails silently, so this records what actually
   * happened rather than what was configured.
   */
  readonly language: string;
  readonly frontmostBundleId: string | null;
  readonly frontmostName: string | null;
  readonly tier: InsertTier;
  readonly inserted: boolean;
}

/* ------------------------------------------------------------------ *
 * Main → Renderer
 * ------------------------------------------------------------------ */

export type MainToRenderer =
  | { type: 'state'; state: SessionState; mode: SessionMode; sessionId: string | null }
  /**
   * The whole render surface. Carries the interim preview text, the microphone
   * level and the committed transcript, which is why the three separate
   * members Phase 1 defined for them were removed in Phase 5 — see the header.
   */
  | { type: 'hud'; view: HudView }
  | { type: 'error'; error: AppError }
  | { type: 'history-updated'; count: number }
  | { type: 'config-updated'; config: AppConfig }
  | { type: 'secure-input'; enabled: boolean }
  /** Main asks the hidden capture renderer to start/stop the microphone.
   *  §11.2.4: the mic is never pre-warmed — the orange indicator must appear
   *  only while actually recording. */
  | { type: 'capture-start'; sessionId: string; sampleRate: number; chunkBytes: number }
  | { type: 'capture-stop'; sessionId: string }
  /** The stored API key, Grok CLI file, or environment token changed. */
  | { type: 'auth-updated'; status: AuthStatus };

export const MAIN_TO_RENDERER_CHANNEL = 'grok-dictate:main-to-renderer';

/* ------------------------------------------------------------------ *
 * Renderer → Main
 * ------------------------------------------------------------------ */

export type RendererToMain =
  /** Esc while recording. */
  | { type: 'cancel' }
  /** The HUD's *Copy* button, or history. The ONLY route to the clipboard
   * — no other message may cause a pasteboard write. */
  | { type: 'copy'; text: string }
  /** Re-run the insertion ladder against the last transcript, wherever the user
   *  is now pointed. */
  | { type: 'retry-insert' }
  /**
   * Run the insertion ladder against arbitrary text — an older history row, or
   * a transcript the user edited in the Scratchpad. Added in Phase 5; see the
   * header. Like `retry-insert` it targets wherever the user is pointing now,
   * so the frontmost check is deliberately not applied.
   */
  | { type: 'insert-text'; text: string }
  /**
   * End a hands-free turn and transcribe what was said — the HUD's ✓ button.
   * Added by the design overhaul (its §16.7): the machine's `TOGGLE` event has
   * always meant "stop and keep it" (stop_capture + finish_stt, as opposed to
   * `cancel`'s cancel_capture + abort_stt), but no renderer message reached it.
   * Routed as `TOGGLE`, so in any state it means exactly what a second
   * Fn+Space means there.
   */
  | { type: 'stop-recording' }
  /** Take the pill off the screen without touching the session. Added in
   *  Phase 5, replacing a `cancel` that meant two different things. */
  | { type: 'dismiss-hud' }
  | { type: 'set-language-mode'; mode: LanguageMode }
  | { type: 'open-window'; window: 'settings' | 'history' | 'scratchpad' | 'signin' }
  /** PCM16 mono @16 kHz, 100 ms / 3200-byte chunks. */
  | { type: 'capture-chunk'; sessionId: string; pcm: ArrayBuffer }
  | { type: 'capture-level'; sessionId: string; level: number }
  | { type: 'capture-error'; sessionId: string; error: AppError }
  /** The capture renderer confirms the device is open and streaming. */
  | {
      type: 'capture-started';
      sessionId: string;
      actualSampleRate: number;
      /**
       * What the device actually agreed to, from `MediaStreamTrack.getSettings()`.
       *
       * Chromium treats `echoCancellation`, `noiseSuppression` and
       * `autoGainControl` as requests, and its own processing is tuned for
       * telephony intelligibility rather than for a recogniser. Whether that
       * helps or hurts accuracy here is an open question that can only be
       * settled by comparing transcripts, and it cannot be compared at all
       * unless the applied values are in the log next to the transcript they
       * produced. Optional because a device may report none of them.
       */
      trackSettings?: CaptureTrackSettings;
    };

/** The subset of `MediaTrackSettings` worth carrying across the IPC boundary. */
export interface CaptureTrackSettings {
  readonly deviceId?: string;
  readonly channelCount?: number;
  readonly sampleRate?: number;
  /**
   * `boolean | string`, not `boolean`: the spec lets a device report *which*
   * canceller it used (`"all"`, `"remote-only"`) rather than merely that it did,
   * and for a diagnostic the distinction is the interesting part.
   */
  readonly echoCancellation?: boolean | string;
  readonly noiseSuppression?: boolean;
  readonly autoGainControl?: boolean;
}

export const RENDERER_TO_MAIN_CHANNEL = 'grok-dictate:renderer-to-main';

/* ------------------------------------------------------------------ *
 * Request/response (renderer asks, main answers)
 * ------------------------------------------------------------------ */

export const INVOKE_CHANNEL = 'grok-dictate:invoke';

export type InvokeRequest =
  | { type: 'get-config' }
  | { type: 'set-config'; config: AppConfig }
  | { type: 'get-history'; query: string | null; limit: number }
  | { type: 'purge-history' }
  | { type: 'get-snapshot' }
  | { type: 'get-auth-status' }
  | { type: 'set-api-key'; key: string }
  | { type: 'clear-api-key' }
  | { type: 'open-external'; url: string };

export interface AppSnapshot {
  readonly state: SessionState;
  readonly mode: SessionMode;
  readonly hud: HudView;
  readonly secureInput: boolean;
  readonly helperReady: boolean;
  readonly lastTranscript: string | null;
}

export type InvokeResponse =
  | { type: 'config'; config: AppConfig }
  | { type: 'history'; entries: readonly HistoryEntry[] }
  | { type: 'snapshot'; snapshot: AppSnapshot }
  | { type: 'auth-status'; status: AuthStatus }
  | { type: 'ok' }
  | { type: 'error'; error: AppError };

/* ------------------------------------------------------------------ *
 * Auth status (sign-in window + Settings)
 * ------------------------------------------------------------------ */

export const AUTH_SOURCES = ['api-key', 'grok-cli', 'environment'] as const;
export type AuthSource = (typeof AUTH_SOURCES)[number];

/**
 * What the user needs to see about login. The token itself is never included.
 *
 * `expiresAt` is an ISO-8601 string when the source is the Grok CLI file, and
 * `null` for an xAI API key (those do not expire on a clock we can read).
 */
export type AuthStatus =
  | { state: 'signed-in'; source: AuthSource; expiresAt: string | null }
  | { state: 'signed-out' }
  | { state: 'expired'; source: 'grok-cli'; expiresAt: string };

/**
 * The complete API the preload script exposes on `window.grokDictate`. Phase 3
 * and Phase 4 renderers use this and nothing else — there is no `ipcRenderer`
 * in any renderer (`contextIsolation: true`).
 */
export interface RendererApi {
  send(message: RendererToMain): void;
  on(listener: (message: MainToRenderer) => void): () => void;
  invoke(request: InvokeRequest): Promise<InvokeResponse>;
}
