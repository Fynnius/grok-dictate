/**
 * FROZEN CONTRACT — the seams between phases.
 *
 * This file is an addition to the four contracts listed in
 * IMPLEMENTATION-PLAN.md §3.1.2, and it is the one that makes the parallel
 * phases actually parallel. §2 requires that Phase 2 "rewrites the *body* of
 * `native/`; it never edits `src/main/index.ts`" — that is only possible if the
 * composition root depends on interfaces rather than implementations. These are
 * those interfaces.
 *
 * Phase 1 ships a mock implementation of each. Phases 2-4 replace the body
 * behind the same interface; `src/main/index.ts` is never touched again.
 *
 * Two shapes here encode hard-won behaviour rather than mere typing:
 *
 *   1. `SttClientPort.startTurn` returns **synchronously**. The caller may push
 *      PCM before the socket is up, and the implementation buffers internally.
 *      That is `forward_pcm` in `pipeline.rs:147-192`; the comment at
 *      `pipeline.rs:218-220` records that running mic-open and connect in
 *      series "clipp[ed] the first word of a hold". A `Promise`-returning
 *      connect would reintroduce exactly that bug, so the port forbids it.
 *
 *   2. `AudioSourcePort.start` likewise returns synchronously and reports
 *      failure through handlers. : the microphone must never
 *      be pre-warmed, because the macOS orange indicator would sit on
 *      permanently and read as spyware — so the device opens on demand, in the
 *      same window as the connect.
 */

import type { AppConfig, HotkeyBindings } from './config.js';
import type { HistoryEntry, HudView, SessionState } from './events.js';
import type { InsertDeclineReason, InsertTier } from './helper-protocol.js';
import type { AppError, Result } from '../src/shared/result.js';

/* ------------------------------------------------------------------ *
 * Native helper — Phase 2
 * ------------------------------------------------------------------ */

export interface FrontmostApp {
  readonly bundleId: string | null;
  readonly name: string | null;
}

export interface InsertOutcome {
  readonly tier: InsertTier;
  readonly ok: boolean;
  /** Prose for a human — the real `AXError`, or what the ladder tried. */
  readonly error: string | null;
  /**
   * The same failure in a form the state machine can branch on. Added in
   * Phase 5 — see `InsertDeclineReason`.
   *
   * Optional rather than required, to match the wire schema: an older helper
   * binary sends no `reason`, and every synthesised outcome the app makes for
   * itself (a dead helper, a timeout) has nothing to classify. Absent means
   * "not stated", and the caller's own fallback is used.
   */
  readonly reason?: InsertDeclineReason | null;
  /**
   * Whether the helper **confirmed the text landed**, rather than merely having
   * posted it. `true` confirmed, `false` proved-not-landed, `null` could not be
   * checked for this target.
   *
   * Added by the 2026-08-09 incident (BUG-1): Unicode injection has no return
   * channel, so `ok` alone cannot tell a successful insert from a silent drop —
   * a 60.3 s dictation posted into a terminal that ignored every event was
   * reported as a success. **`ok: true` with `verified` not `true` means
   * "typed, unconfirmed"**, and the app says so.
   *
   * Optional in the same style as `reason` and `frontmost` above, and for the
   * same two reasons: an older helper binary sends no `verified`, and every
   * outcome the app synthesises for itself (a dead helper, a timeout) has
   * nothing to verify — no text was posted, so there is nothing to confirm.
   * Absent means "not stated", which reads as unconfirmed.
   */
  readonly verified?: boolean | null;
  /**
   * The application the helper actually inserted into, which since Phase 5 is
   * whatever was frontmost at the end of the turn rather than at the start —
   * see `contracts/state-machine.md` §11. This is what a history row records.
   * `null` when the helper declined before resolving it, or synthesised by the
   * app for a helper that never answered.
   */
  readonly frontmost?: FrontmostApp | null;
}

export interface NativeHelperEvents {
  onReady(listener: (caps: readonly string[]) => void): () => void;
  onHotkey(
    listener: (action: 'ptt_down' | 'ptt_up' | 'toggle' | 'retry_insert', ts: number) => void,
  ): () => void;
  onSecureInput(listener: (enabled: boolean) => void): () => void;
  onFrontmostChanged(listener: (app: FrontmostApp) => void): () => void;
  /**
   * Whether the hotkey is actually alive. Added in Phase 5: the tray used to
   * say "Ready" while the event tap had failed to install and `Fn` was dead —
   *  "no error, no log, no crash", in the one surface built to
   * prevent it.
   */
  onPermissions(listener: (permissions: HelperPermissions) => void): () => void;
}

export interface HelperPermissions {
  readonly accessibility: boolean;
  readonly hotkeyActive: boolean;
}

export interface NativeHelperPort extends NativeHelperEvents {
  readonly isReady: boolean;

  /**
   * Run the insertion ladder. Always resolves — a dead helper or a timeout
   * resolves to `{tier:'none', ok:false, error:…}` rather than rejecting, so
   * the state machine has exactly one shape to handle and a transcript is
   * never lost to an exception.
   */
  insert(text: string, targetBundleId: string | null): Promise<InsertOutcome>;

  /**
   * Write to the pasteboard. The ONLY method in this interface that may do so,
   * and it must only ever be called from an explicit user action — the HUD's
   * *Copy* button or history. Phase 5 audits every call site.
   */
  copy(text: string): void;

  getFrontmost(): Promise<FrontmostApp>;
  setHotkeys(bindings: HotkeyBindings): void;
  shutdown(): Promise<void>;
}

/* ------------------------------------------------------------------ *
 * Auth — Phase 3
 * ------------------------------------------------------------------ */

export interface Bearer {
  /**
   * The raw token. **Never log this, never put it in an error message, never
   * send it to the helper, never write it to history.** The logger's redaction
   * layer is the backstop, not the plan.
   */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AuthPort {
  /**
   * Read `~/.grok/auth.json` fresh at each activation.
   *
   * There is **no refresh path anywhere in this app, by design**. Refreshing
   * without writing the rotated token back under `auth.json.lock` can silently
   * invalidate the user's Grok CLI login, and the failure surfaces later, in a
   * different program. Phase 5 audits that no refresh exists (§5b).
   *
   * What this *may* do on expiry is run the Grok CLI and read the file again.
   * That is not a refresh path and the distinction is the whole point: `grok`
   * owns `auth.json`, owns its lock and owns the rotation, so asking it to renew
   * is the same act as the user typing `grok` themselves — which is what the
   * error hint used to tell them to do. No token is minted, rotated or written
   * here. See `src/main/auth/renew.ts`, and note that §5b's source scan passes
   * over it unchanged.
   */
  getBearer(): Promise<Result<Bearer>>;
}

/* ------------------------------------------------------------------ *
 * Audio capture — Phase 3
 * ------------------------------------------------------------------ */

export interface AudioHandlers {
  /** PCM16 mono @ 16 kHz, 100 ms / 3200-byte chunks. */
  onChunk(pcm: Uint8Array): void;
  /** RMS 0..1 for the HUD meter. */
  onLevel(level: number): void;
  onError(error: AppError): void;
  /**
   * **Every chunk of this session has now been delivered.** Fired once after
   * `stop()`, and it is what tells the caller it may end the turn.
   *
   * Added by the 2026-08-09 incident (BUG-2): the capture renderer flushes its
   * encoder tail *after* it is told to stop, so a `stop()` that closed the
   * session synchronously threw away the last ~100–300 ms of every dictation —
   * the end of the last word — while `audio.done` had already been sent.
   *
   * **An implementation must call this exactly once per `stop()`, and within a
   * bounded time even when whatever it is waiting for never answers.** The turn
   * is held open until it fires; a port that stays silent hangs the dictation.
   * `CaptureCoordinator` honours that with a short timer and says so in the log.
   */
  onDrained(): void;
  /** Fired once the device is genuinely open. `actualSampleRate` exists to
   *  check assumption 10.4 — that the AudioContext really runs at 16 kHz and
   *  is not double-resampling. */
  onStarted(actualSampleRate: number): void;
}

export interface AudioSourcePort {
  /** Opens the device. Returns immediately; failures arrive via `onError`. */
  start(sessionId: string, handlers: AudioHandlers): void;
  /**
   * Graceful end of turn: stop the device, keep the buffered audio.
   *
   * **Two-phase.** It returns immediately, but the session stays addressable —
   * still delivering `onChunk` — until `onDrained` fires. See `onDrained`.
   */
  stop(sessionId: string): void;
  /** Discard everything, including the buffer (Esc — ). */
  cancel(sessionId: string): void;
  /**
   * The full utterance PCM. Load-bearing, not an
   * optimisation: needed for retry-after-failed-insertion, Layer-2 language
   * replay, and retry-after-network-failure.
   */
  getUtteranceBuffer(sessionId: string): Uint8Array | null;
}

/* ------------------------------------------------------------------ *
 * STT — Phase 3
 * ------------------------------------------------------------------ */

export interface SttTurnOptions {
  readonly sessionId: string;
  /**
   * The `language` query parameter, or `null` to omit it. Never the string
   * `auto` — see `resolveWireLanguage`, and docs/spike-results.md for why
   * omission is the default rather than a detected code.
   */
  readonly language: string | null;
  readonly endpointingMs: number;
  readonly keyterms: readonly string[];
  /** `finalize` (documented for push-to-talk) vs `audio.done` (what the CLI
   *  sends, `streaming.rs:82`). Chosen by spike 2. */
  readonly useFinalize: boolean;
}

export interface SttHandlers {
  onReady(): void;
  /**
   * Live preview only.  / `pipeline.rs:273-279`: chunk-final
   * deltas are stitched into the preview, but **the committed text never comes
   * from here**.
   */
  onInterim(text: string): void;
  /** A `speech_final` segment — the ONLY text that may be inserted. */
  onFinal(text: string): void;
  /**
   * The language the server *detected*, from the `language` field on
   * `transcript.partial` (spike 1, docs/spike-results.md). This is real
   * acoustic detection, not an echo of the request parameter, and it is what
   * history records. May fire several times per turn; the last value wins.
   */
  onLanguageDetected(code: string): void;
  /** `transcript.done`; `durationSec` is the server's audio-seconds figure,
   *  which the Grok CLI parses and discards. */
  onDone(durationSec: number | null): void;
  onError(error: AppError): void;
}

export interface SttTurn {
  /** Safe to call before the socket is ready; buffered internally (§4.3). */
  sendPcm(pcm: Uint8Array): void;
  /** End of turn: `finalize` or `audio.done` per `SttTurnOptions`. */
  finish(): void;
  /** Tear down without waiting for a final (Esc, or a superseding press). */
  abort(): void;
}

export interface SttClientPort {
  /** Synchronous by contract — see the note at the top of this file. */
  startTurn(options: SttTurnOptions, handlers: SttHandlers): SttTurn;
}

/* ------------------------------------------------------------------ *
 * UI surfaces — Phase 4
 * ------------------------------------------------------------------ */

export interface HudPort {
  show(view: HudView): void;
  hide(): void;
}

export interface TrayPort {
  setState(state: SessionState, secureInput: boolean): void;
}

export type AudioCue = 'start' | 'stop' | 'error';

export interface SoundPort {
  /** Under ~80 ms. */
  play(cue: AudioCue): void;
}

export interface HistoryPort {
  append(entry: HistoryEntry): Promise<void>;
  list(query: string | null, limit: number): Promise<readonly HistoryEntry[]>;
  /**  — the history file is a partial keylogger; a purge command
   *  is the minimum mitigation. */
  purge(): Promise<void>;
  count(): Promise<number>;
}

export interface ConfigPort {
  get(): AppConfig;
  set(config: AppConfig): Promise<void>;
  onChange(listener: (config: AppConfig) => void): () => void;
}
