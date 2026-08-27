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
 *
 * ## 2026-08-22 latency/honesty pass
 *
 * - Optional `sentAtMs` on `capture-started` / `capture-chunk` so a renderer
 *   that has no logger can still report when it sent. Canonical W0 marks are
 *   stamped in main on **receive** (see `src/shared/timing.ts`).
 * - Panel `'stats'` and `get-stats` invoke: aggregates only, no transcripts.
 * - `open-window` accepts `'stats'`.
 */

import type { InsertTier } from './helper-protocol.js';
import type { AppError } from '../src/shared/result.js';
import type { AppConfig, LanguageMode } from './config.js';
import type { StatsViewModel } from '../src/shared/stats.js';

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
   * The helper posted the keystrokes and then proved that the target's text
   * did not change. Added by the 2026-08-09 incident (BUG-1) together with
   * `InsertDeclineReason.verification_failed`: this is the case that used to
   * arrive as `ok: true` and render as a green check, so it needs copy of its
   * own — "we typed it and it did not arrive" is a different instruction to
   * the user from "no tier would take it".
   */
  | 'verification_failed'
  /**
   * The dictation itself failed — the network dropped, the token expired, the
   * server errored — after some text had already been transcribed. Added in
   * Phase 5: until then `toIdleWithError` discarded whatever was already
   * committed, so a drop after a minute of good dictation lost all of it and
   * `Ctrl+Cmd+V` had nothing to re-insert (docs/phase-3-report.md §5.2).
   */
  | 'session_error'
  /**
   * The same, but the turn died mid-sentence, so the tail of what is shown was
   * still interim text that the server never confirmed. Added by the
   * 2026-08-09 incident (BUG-3): speaking continuously produces no
   * `speech_final` at all, so a drop used to lose the whole minute rather than
   * salvaging an imperfect version of it. Separate from `session_error`
   * because the user has to be told the end may be wrong.
   */
  | 'session_error_unconfirmed';

/**
 * Everything the HUD needs to render, as one value. Phase 4 owns the pixels;
 * this is the data.
 *
 * `inserted` and `not_inserted` both still carry the **full transcript** on
 * the view, for History and ⌃⌘V. The HUD itself is wordless for both: a green
 * check or a red flash. A paragraph overlay in the middle of the screen was
 * not wanted.
 *
 * `inserted.verified` is recorded, not shown. `true` means the helper
 * confirmed a landing; anything else means it could not tell. They draw the
 * same check.
 */
export type HudView =
  | { kind: 'hidden' }
  | { kind: 'recording'; elapsedMs: number; level: number; interim: string; mode: SessionMode }
  | { kind: 'processing'; interim: string }
  | { kind: 'inserted'; text: string; tier: InsertTier; verified: boolean | null }
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
  /**
   * Whether the helper **confirmed** the text landed, as opposed to having
   * posted it and hoped. `true` confirmed, `false` proved-not-landed, `null`
   * not checkable for that target.
   *
   * **Optional, and old rows must keep loading.** The file on disk predates
   * this field by every dictation the user has ever made, and `isHistoryEntry`
   * in `src/main/history/index.ts` drops any row it does not recognise — so a
   * required field here would silently delete the user's entire history on the
   * first launch after the update. Absent means "written before the app could
   * tell", which is exactly what it was.
   *
   * Added by the 2026-08-09 incident (BUG-1), where `inserted: true` was
   * written for a 60.3 s dictation that never reached the screen. History is
   * the recovery surface; a row that overstates what happened is worse than no
   * row at all.
   */
  readonly verified?: boolean | null;
  /**
   * Whether the tail of `text` is unconfirmed interim text rather than a
   * `speech_final` the server stood behind.
   *
   * Only ever `true` on a salvage row — a turn that died mid-sentence
   * (BUG-3). Optional for the same reason as `verified`: absent means the row
   * predates the field, or the whole row is confirmed, which is the same
   * assurance every row before it carried.
   */
  readonly unconfirmedTail?: boolean;
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
  | { type: 'open-window'; window: 'settings' | 'history' | 'scratchpad' | 'signin' | 'stats' }
  /** PCM16 mono @16 kHz, 100 ms / 3200-byte chunks. */
  | { type: 'capture-chunk'; sessionId: string; pcm: ArrayBuffer; sentAtMs?: number }
  /**
   * **The last `capture-chunk` of this session has been sent.** The renderer's
   * answer to `capture-stop`, and the reason `stop` is two-phase.
   *
   * Added by the 2026-08-09 incident (BUG-2). The capture renderer flushes its
   * encoder tail as one final chunk *after* `capture-stop` arrives — "the last
   * 100 ms of a hold is the end of the last word" — but the main process
   * dropped its session synchronously inside `stop()`, so that chunk was
   * discarded and `audio.done` had already gone out anyway. The tail-flush was
   * dead code, and the final ~100–300 ms of speech never reached the server on
   * any dictation.
   *
   * The main process holds the session addressable until this arrives, then
   * ends the turn. It is a promise the renderer may fail to keep — a dead or
   * wedged window sends nothing — so the drain is also bounded by a timer
   * (`DRAIN_TIMEOUT_MS` in `src/main/audio/coordinator.ts`).
   */
  | { type: 'capture-drained'; sessionId: string }
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
      /**
       * Renderer `Date.now()` at send. Optional diagnostic; W0 stamps the
       * canonical `device_open` mark when main *receives* this frame.
       */
      sentAtMs?: number;
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
  /**
   * Aggregates over history for the stats panel. No transcript text in the
   * reply — the view-model is counts and sums only.
   */
  | { type: 'get-stats' }
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
  | { type: 'stats'; stats: StatsViewModel }
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
