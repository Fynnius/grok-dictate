/**
 * The session state machine — see `contracts/state-machine.md` for the contract
 * this implements, including the resolution of
 *
 * A reducer: `(snapshot, event) → { snapshot, effects }`. All non-determinism
 * (clock, id generation) is injected via `MachineEnv`, so the whole thing is
 * deterministic under test. Side effects are *returned as data* and interpreted
 * by the composition root, which is what lets Phase 1 prove the entire
 * round-trip without Electron, a microphone or a socket.
 */

import type { AudioCue, FrontmostApp, InsertOutcome } from '@contracts/ports.js';
import type {
  HistoryEntry,
  HudView,
  NotInsertedReason,
  SessionMode,
  SessionState,
} from '@contracts/events.js';
import type { AppError } from '@shared/result.js';
import type { LogLevel } from '@shared/logger.js';
import { stitchSegments } from '@shared/stitch.js';

/* ------------------------------------------------------------------ *
 * Events in
 * ------------------------------------------------------------------ */

export type SessionEvent =
  | { type: 'PTT_DOWN'; ts: number }
  | { type: 'PTT_UP'; ts: number }
  | { type: 'TOGGLE'; ts: number }
  | { type: 'RETRY_INSERT' }
  /**
   * Insert arbitrary text — an older history row, or a Scratchpad edit. Same
   * shape as `RETRY_INSERT` but the text comes from the caller rather than from
   * `lastTranscript`. Added in Phase 5; see `contracts/events.ts`.
   */
  | { type: 'INSERT_TEXT'; text: string }
  | { type: 'CANCEL' }
  | { type: 'SECURE_INPUT'; enabled: boolean }
  | { type: 'FRONTMOST'; sessionId: string; app: FrontmostApp }
  | { type: 'TRANSCRIPT_INTERIM'; sessionId: string; text: string }
  | { type: 'TRANSCRIPT_FINAL'; sessionId: string; text: string }
  | { type: 'TURN_ENDED'; sessionId: string; durationSec: number | null }
  | { type: 'SESSION_ERROR'; sessionId: string | null; error: AppError }
  | { type: 'INSERT_RESULT'; sessionId: string; outcome: InsertOutcome }
  | { type: 'INSERT_TIMEOUT'; sessionId: string }
  | { type: 'RECORDING_CAP_REACHED'; sessionId: string }
  | { type: 'LEVEL'; sessionId: string; level: number }
  | { type: 'TICK'; now: number };

/**
 * Everything except `SECURE_INPUT`, which `reduce` handles up front for every
 * state (contract §8). The sub-reducers take this narrower type so TypeScript
 * can prove their switches are exhaustive.
 */
type PostSecureEvent = Exclude<SessionEvent, { type: 'SECURE_INPUT' }>;

/* ------------------------------------------------------------------ *
 * Effects out
 * ------------------------------------------------------------------ */

/**
 * A history row without the fields the reducer cannot know: `id` and `at` are
 * non-deterministic, and `language` is whatever the STT layer actually put on
 * the wire. The
 * composition root fills all three in.
 */
export type HistoryDraft = Omit<HistoryEntry, 'id' | 'at' | 'language'>;

export type Effect =
  | { type: 'start_capture'; sessionId: string }
  | { type: 'stop_capture'; sessionId: string }
  | { type: 'cancel_capture'; sessionId: string }
  | { type: 'start_stt'; sessionId: string }
  | { type: 'finish_stt'; sessionId: string }
  | { type: 'abort_stt'; sessionId: string }
  | { type: 'request_frontmost'; sessionId: string }
  | { type: 'insert'; sessionId: string; text: string; targetBundleId: string | null }
  | { type: 'hud'; view: HudView }
  | { type: 'tray'; state: SessionState; secureInput: boolean }
  | { type: 'cue'; cue: AudioCue }
  | { type: 'history_append'; entry: HistoryDraft }
  | { type: 'log'; level: LogLevel; message: string; fields?: Record<string, unknown> };

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

export interface SessionContext {
  readonly sessionId: string | null;
  readonly mode: SessionMode;
  readonly targetBundleId: string | null;
  readonly targetName: string | null;
  /** `speech_final` segments this turn. The ONLY text that may be inserted. */
  readonly committed: readonly string[];
  /** Live preview. Never inserted. */
  readonly interim: string;
  readonly level: number;
  /**
   * The loudest `LEVEL` of this turn. Kept because it is the only evidence that
   * separates "the microphone is dead" from "nobody spoke" once the turn ends
   * with no words — see `noSpeechCopy`.
   */
  readonly peakLevel: number;
  readonly lastTranscript: string | null;
  readonly pendingStart: boolean;
  readonly secureInput: boolean;
  readonly startedAt: number | null;
  readonly elapsedMs: number;
  readonly durationSec: number | null;
  /** Text handed to the helper, held until `insert_result` comes back. */
  readonly inserting: string | null;
  /**
   * Whether `committedText` repairs the joins between `speech_final` segments
   * (`src/shared/stitch.ts`).
   *
   * Snapshotted per turn from the config rather than read at join time, so
   * toggling the setting mid-dictation cannot change how the dictation already
   * in flight is assembled.
   */
  readonly repairSeams: boolean;
}

export interface Snapshot {
  readonly state: SessionState;
  readonly ctx: SessionContext;
}

export interface MachineEnv {
  newSessionId(): string;
  now(): number;
  /**
   * The `repairSeams` setting, read once per turn. Optional so that a test may
   * supply a two-field env and get the shipping behaviour.
   */
  repairSeams?: () => boolean;
}

export interface Step {
  readonly snapshot: Snapshot;
  readonly effects: readonly Effect[];
}

export const INITIAL_CONTEXT: SessionContext = {
  sessionId: null,
  mode: 'hold',
  targetBundleId: null,
  targetName: null,
  committed: [],
  interim: '',
  level: 0,
  peakLevel: 0,
  lastTranscript: null,
  pendingStart: false,
  secureInput: false,
  startedAt: null,
  elapsedMs: 0,
  durationSec: null,
  inserting: null,
  repairSeams: true,
};

export const INITIAL_SNAPSHOT: Snapshot = { state: 'idle', ctx: INITIAL_CONTEXT };

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Committed segments joined into the text that will actually be inserted.
 *
 * The join is not a `' '` — one hold routinely produces several `speech_final`
 * segments (4.9 on average across 67 measured dictations), each re-transcribed
 * with no knowledge of the one before it, and the joins are where the text goes
 * wrong. `src/shared/stitch.ts` documents the three artefacts and what is done
 * about them.
 */
export function committedText(ctx: SessionContext): string {
  return stitchSegments(ctx.committed, ctx.repairSeams);
}

function recordingView(ctx: SessionContext): HudView {
  return {
    kind: 'recording',
    elapsedMs: ctx.elapsedMs,
    level: ctx.level,
    interim: ctx.interim,
    mode: ctx.mode,
  };
}

function step(state: SessionState, ctx: SessionContext, effects: Effect[]): Step {
  return { snapshot: { state, ctx }, effects };
}

function ignored(snapshot: Snapshot, reason: string, event: PostSecureEvent): Step {
  return {
    snapshot,
    effects: [
      {
        type: 'log',
        level: 'debug',
        message: `ignored ${event.type}: ${reason}`,
        fields: { state: snapshot.state },
      },
    ],
  };
}

/**
 * Events carrying a `sessionId` are only meaningful for the current session.
 *  / `pipeline.rs:50-63`: a superseded session's trailing final
 * must never land on the new target.
 */
function isStale(ctx: SessionContext, event: SessionEvent): boolean {
  if (!('sessionId' in event) || event.sessionId === null) return false;
  return event.sessionId !== ctx.sessionId;
}

/** Begin a new turn. Shared by `idle` starts and the `pendingStart` drain (§5). */
function startSession(ctx: SessionContext, mode: SessionMode, env: MachineEnv): Step {
  const sessionId = env.newSessionId();
  const next: SessionContext = {
    ...ctx,
    sessionId,
    mode,
    targetBundleId: null,
    targetName: null,
    committed: [],
    interim: '',
    level: 0,
    // Per turn, not per app: last turn's loud microphone says nothing about
    // whether this one's is muted.
    peakLevel: 0,
    pendingStart: false,
    startedAt: env.now(),
    elapsedMs: 0,
    durationSec: null,
    inserting: null,
    repairSeams: env.repairSeams?.() ?? true,
  };
  return step('recording', next, [
    // The frontmost app is captured *now*, at press time, and verified before
    // insertion — focus can move during the processing window (§11.1.10).
    { type: 'request_frontmost', sessionId },
    // Mic and socket open concurrently; PCM captured during the handshake is
    // buffered rather than dropped (`pipeline.rs:218-220`, ).
    { type: 'start_capture', sessionId },
    { type: 'start_stt', sessionId },
    { type: 'hud', view: recordingView(next) },
    { type: 'tray', state: 'recording', secureInput: next.secureInput },
    { type: 'cue', cue: 'start' },
  ]);
}

/** Enter `blocked`, finalising any in-flight capture so the text is not lost (§8). */
function enterBlocked(snapshot: Snapshot): Step {
  const { state, ctx } = snapshot;
  const effects: Effect[] = [];
  if (state === 'recording' && ctx.sessionId !== null) {
    effects.push({ type: 'stop_capture', sessionId: ctx.sessionId });
    effects.push({ type: 'finish_stt', sessionId: ctx.sessionId });
  }
  effects.push({ type: 'hud', view: { kind: 'blocked' } });
  effects.push({ type: 'tray', state: 'blocked', secureInput: true });
  effects.push({
    type: 'log',
    level: 'warn',
    message: 'Secure Input is active — the event tap is disabled system-wide',
    fields: { previousState: state },
  });
  // An insert already dispatched to the helper cannot be recalled; stay in
  // `inserting` and let the result land, which routes to `blocked` below.
  const nextState: SessionState = state === 'inserting' ? 'inserting' : 'blocked';
  return step(nextState, { ...ctx, secureInput: true, pendingStart: false }, effects);
}

/**
 * Why the HUD should say a transcript was not inserted.
 *
 * `reasonWhenFailed` is what the *caller* knows (the helper never answered, we
 * were blocked); the helper's own `reason` is what actually happened at the
 * other end and wins when it is present. Before Phase 5 there was no such
 * field, so a focus change during the processing window was reported as
 * "neither insertion method was accepted by that app", which is both wrong
 * and unactionable.
 */
function notInsertedReason(outcome: InsertOutcome, fallback: NotInsertedReason): NotInsertedReason {
  const reason = outcome.reason ?? null;
  if (reason === null) return fallback;
  switch (reason) {
    case 'target_changed':
      return 'target_changed';
    case 'empty_text':
    case 'no_tier':
      // Both mean "the ladder had nothing it could do", which is what
      // `insert_failed`'s HUD copy already says.
      return 'insert_failed';
  }
}

/** Complete an insert: HUD, history, `lastTranscript`, then drain `pendingStart`. */
function finishInsert(
  snapshot: Snapshot,
  outcome: InsertOutcome,
  env: MachineEnv,
  fallbackReason: NotInsertedReason = 'insert_failed',
): Step {
  const { ctx } = snapshot;
  const reasonWhenFailed = notInsertedReason(outcome, fallbackReason);
  // The segments win over `ctx.inserting` whenever there are any. In the
  // ordinary case the two are the same string — `beginInsert` derives one from
  // the other — but a `speech_final` that arrives *after* the insert was
  // dispatched appends to `committed` only (see `reduceInserting`), and the
  // pill, the history row and ⌃⌘V should all carry the whole transcript rather
  // than the prefix that happened to be typed. An ad-hoc insert (⌃⌘V, a history
  // row, a Scratchpad edit) has no segments at all and falls back to the text it
  // was handed.
  const text = ctx.committed.length > 0 ? committedText(ctx) : (ctx.inserting ?? '');
  const effects: Effect[] = [];

  // History gets one row per *dictation*, not per insertion attempt. A
  // `Ctrl+Cmd+V` retry has no `committed` segments of its own (they were
  // cleared when the original insert completed), and appending a second row
  // for the same text would clutter the search surface that
  // relies on. The retry's outcome is still visible immediately in the HUD.
  if (ctx.committed.length > 0) {
    // Where the text actually went, which since Phase 5 is not where the turn
    // started (see `beginInsert`). The helper reports the application its
    // ladder acted on; `ctx` holds the press-time app and is the fallback for
    // a helper that declined before resolving one, or never answered at all.
    const landedIn = outcome.frontmost ?? null;
    effects.push({
      type: 'history_append',
      entry: {
        text,
        durationSec: ctx.durationSec,
        frontmostBundleId: landedIn?.bundleId ?? ctx.targetBundleId,
        frontmostName: landedIn?.name ?? ctx.targetName,
        tier: outcome.tier,
        inserted: outcome.ok,
      },
    });
  }

  const cleared: SessionContext = {
    ...ctx,
    lastTranscript: text.length > 0 ? text : ctx.lastTranscript,
    committed: [],
    interim: '',
    inserting: null,
    sessionId: null,
  };

  // Secure Input arrived while the insert was in flight → land in `blocked`.
  if (ctx.secureInput) {
    effects.push({
      type: 'hud',
      view: outcome.ok
        ? { kind: 'inserted', text, tier: outcome.tier }
        : { kind: 'not_inserted', text, reason: reasonWhenFailed, detail: outcome.error },
    });
    effects.push({ type: 'tray', state: 'blocked', secureInput: true });
    return step('blocked', { ...cleared, pendingStart: false }, effects);
  }

  if (cleared.pendingStart) {
    // Draining straight into a new recording: the transient "inserted" HUD
    // would be replaced within a frame, so it is skipped deliberately.
    const started = startSession({ ...cleared, pendingStart: false }, 'hold', env);
    return { snapshot: started.snapshot, effects: [...effects, ...started.effects] };
  }

  effects.push({
    type: 'hud',
    // Both states show the FULL transcript — : a half-successful
    // Unicode injection is silent, and seeing the whole text next to what
    // landed is the only way to catch it.
    view: outcome.ok
      ? { kind: 'inserted', text, tier: outcome.tier }
      : { kind: 'not_inserted', text, reason: reasonWhenFailed, detail: outcome.error },
  });
  effects.push({ type: 'tray', state: 'idle', secureInput: false });
  if (!outcome.ok) effects.push({ type: 'cue', cue: 'error' });
  return step('idle', cleared, effects);
}

/**
 * Insert text that is not the product of the turn we are in — `Ctrl+Cmd+V`, a
 * history row, or a Scratchpad edit.
 *
 * §6: these target wherever the user is pointing **now**, so `targetBundleId`
 * is deliberately `null` and the helper's frontmost check is disabled
 *. `committed` stays empty
 * so `finishInsert` appends no second history row for text that already has one.
 */
function adHocInsert(ctx: SessionContext, text: string, env: MachineEnv): Step {
  const insertId = env.newSessionId();
  return step(
    'inserting',
    { ...ctx, sessionId: insertId, inserting: text, targetBundleId: null, targetName: null },
    [
      { type: 'insert', sessionId: insertId, text, targetBundleId: null },
      { type: 'tray', state: 'inserting', secureInput: ctx.secureInput },
    ],
  );
}

/**
 * End a turn that produced text: dispatch the insert.
 *
 * **The text goes wherever the user is pointing when the turn ends, not where
 * it started.** `targetBundleId` is `null`, which disables the helper's
 * frontmost check.
 *
 * This reverses , at the user's explicit direction after
 * Phase 5's HT-4: _"i want to start wherever i want and then paste it somewhere
 * i release or toggle"_. It is the natural reading of hands-free mode — begin
 * dictating, walk over to the window you actually want the text in, stop — and
 * it is the same rule ⌃⌘V has always followed (§6, : the human is
 * the failure detector).
 *
 * What it gives up is the guard §11.1.10 was written for: an accidental ⌘-Tab
 * during the ~300 ms processing window now types the transcript into whatever
 * arrived in front, instead of declining. The recovery is unchanged — the full
 * text is in the pill and in history, and ⌃⌘V re-inserts it — so the cost is a
 * stray paste to undo rather than lost words. Stated because it is a real
 * trade, not an oversight.
 *
 * `ctx.targetBundleId` still holds the app that was frontmost at press time,
 * and is still what a history row falls back to when no insertion is attempted
 * at all (Secure Input, a failed session). Where an insertion *is* attempted,
 * the helper reports the application it actually acted on and that wins.
 */
function beginInsert(ctx: SessionContext, extraFinal: string | null): Step {
  const committed = extraFinal === null ? ctx.committed : [...ctx.committed, extraFinal];
  const next: SessionContext = { ...ctx, committed, interim: '' };
  const text = committedText(next);
  return step('inserting', { ...next, inserting: text }, [
    { type: 'insert', sessionId: ctx.sessionId ?? '', text, targetBundleId: null },
    { type: 'tray', state: 'inserting', secureInput: ctx.secureInput },
  ]);
}

/**
 * A session died — the network dropped, the token expired, the server errored.
 *
 * **What already got transcribed is kept.** Until Phase 5 this cleared
 * `committed` and left `lastTranscript` alone, so a drop after a minute of
 * successful dictation threw all of it away and `Ctrl+Cmd+V` had nothing to
 * re-insert (docs/phase-3-report.md §5.2). Insertion is still never attempted —
 * the turn is incomplete and typing half a sentence into the user's editor is
 * worse than not typing it — but the text is shown in full, stored in history
 * (the recovery surface, ) and made available to ⌃⌘V.
 *
 * With nothing committed the behaviour is unchanged: a plain error pill, which
 * is right for HT-5's three-character fragment and for a failure before any
 * speech arrived.
 */
function toIdleWithError(ctx: SessionContext, error: AppError): Step {
  const effects: Effect[] = [];
  if (ctx.sessionId !== null) {
    effects.push({ type: 'cancel_capture', sessionId: ctx.sessionId });
    effects.push({ type: 'abort_stt', sessionId: ctx.sessionId });
  }

  const salvaged = committedText(ctx);
  if (salvaged.length > 0) {
    effects.push({
      type: 'history_append',
      entry: {
        text: salvaged,
        durationSec: ctx.durationSec,
        frontmostBundleId: ctx.targetBundleId,
        frontmostName: ctx.targetName,
        tier: 'none',
        inserted: false,
      },
    });
    effects.push({
      type: 'hud',
      view: {
        kind: 'not_inserted',
        text: salvaged,
        reason: 'session_error',
        detail: error.hint === null ? error.message : `${error.message} ${error.hint}`,
      },
    });
  } else if (error.code === 'stt_no_speech') {
    // The watchdog's own copy has to hedge — it fires in the STT client, which
    // has never seen a microphone level. Here we have one, so the same turn
    // gets the same answer as `endTurn`'s (§19.4) rather than two different
    // explanations of one silence depending on which timer noticed it.
    const { message, hint } = noSpeechCopy(ctx.peakLevel);
    effects.push({ type: 'hud', view: { kind: 'error', message, hint } });
  } else {
    effects.push({
      type: 'hud',
      view: { kind: 'error', message: error.message, hint: error.hint },
    });
  }

  effects.push({ type: 'tray', state: 'idle', secureInput: ctx.secureInput });
  effects.push({ type: 'cue', cue: 'error' });
  return step(
    'idle',
    {
      ...ctx,
      sessionId: null,
      committed: [],
      interim: '',
      inserting: null,
      pendingStart: false,
      lastTranscript: salvaged.length > 0 ? salvaged : ctx.lastTranscript,
    },
    effects,
  );
}

/**
 * Below this peak RMS, nothing reached the microphone that could have been
 * speech. A muted or permission-denied device reports exact digital silence
 * (0.0); an open microphone in a quiet room still reports room tone well above
 * this, even with Chromium's noise suppression on. −54 dBFS sits between them.
 */
const SILENT_PEAK = 0.002;

/**
 * Why a turn produced no words — the one piece of this the user cannot work out
 * from the outside.
 *
 * `pipeline.rs:200-209` and the comment this replaces both stated that a denied
 * microphone grant is *indistinguishable* from not speaking, because macOS
 * returns silence rather than an error. That is true of the audio, but not of
 * this process: `LEVEL` events carry the RMS of every 100 ms of it, so the peak
 * over the turn separates the two cases exactly. The user asked for that
 * distinction by name — "then you can just search for the issue if the
 * microphone is dead or if I just didn't speak" (§19.4).
 */
export function noSpeechCopy(peakLevel: number): { message: string; hint: string } {
  return peakLevel < SILENT_PEAK
    ? {
        message: 'The microphone sent no sound.',
        hint: 'It is muted, or Grok Dictate has no Microphone permission in System Settings → Privacy & Security.',
      }
    : {
        message: 'No speech was detected.',
        hint: 'The microphone was picking up sound, but nothing recognisable was said.',
      };
}

/** The turn ended with nothing said, or with text but no more finals coming. */
function endTurn(ctx: SessionContext, durationSec: number | null): Step {
  const withDuration: SessionContext = { ...ctx, durationSec };
  if (committedText(withDuration).length === 0) {
    const { message, hint } = noSpeechCopy(withDuration.peakLevel);
    return step('idle', { ...withDuration, sessionId: null, interim: '', pendingStart: false }, [
      { type: 'hud', view: { kind: 'error', message, hint } },
      { type: 'tray', state: 'idle', secureInput: withDuration.secureInput },
      { type: 'cue', cue: 'error' },
    ]);
  }
  return beginInsert(withDuration, null);
}

/* ------------------------------------------------------------------ *
 * The reducer
 * ------------------------------------------------------------------ */

export function reduce(snapshot: Snapshot, event: SessionEvent, env: MachineEnv): Step {
  const { state, ctx } = snapshot;

  // Secure Input wins from any state (contract §8 / IMPLEMENTATION-PLAN §3.1.2).
  if (event.type === 'SECURE_INPUT') {
    if (event.enabled === ctx.secureInput && state !== 'blocked') {
      return { snapshot, effects: [] };
    }
    if (event.enabled) return enterBlocked(snapshot);
    if (state === 'blocked') {
      return step('idle', { ...ctx, secureInput: false, pendingStart: false, sessionId: null }, [
        { type: 'hud', view: { kind: 'hidden' } },
        { type: 'tray', state: 'idle', secureInput: false },
      ]);
    }
    return step(state, { ...ctx, secureInput: false }, [
      { type: 'tray', state, secureInput: false },
    ]);
  }

  if (isStale(ctx, event)) {
    return ignored(snapshot, 'event belongs to a superseded session', event);
  }

  switch (state) {
    case 'idle':
      return reduceIdle(snapshot, event, env);
    case 'recording':
      return reduceRecording(snapshot, event);
    case 'processing':
      return reduceProcessing(snapshot, event);
    case 'inserting':
      return reduceInserting(snapshot, event, env);
    case 'blocked':
      return reduceBlocked(snapshot, event, env);
  }
}

function reduceIdle(snapshot: Snapshot, event: PostSecureEvent, env: MachineEnv): Step {
  const { ctx } = snapshot;
  switch (event.type) {
    case 'PTT_DOWN':
      return startSession(ctx, 'hold', env);
    case 'TOGGLE':
      return startSession(ctx, 'toggle', env);
    case 'RETRY_INSERT': {
      const text = ctx.lastTranscript;
      if (text === null || text.length === 0) {
        return step('idle', ctx, [
          {
            type: 'hud',
            view: {
              kind: 'error',
              message: 'Nothing to re-insert.',
              hint: 'Dictate something first.',
            },
          },
        ]);
      }
      return adHocInsert(ctx, text, env);
    }
    case 'INSERT_TEXT':
      return event.text.length === 0
        ? ignored(snapshot, 'there was no text to insert', event)
        : adHocInsert(ctx, event.text, env);
    case 'SESSION_ERROR':
      return toIdleWithError(ctx, event.error);
    case 'PTT_UP':
    case 'CANCEL':
    case 'TICK':
    case 'LEVEL':
    case 'FRONTMOST':
    case 'TRANSCRIPT_INTERIM':
    case 'TRANSCRIPT_FINAL':
    case 'TURN_ENDED':
    case 'INSERT_RESULT':
    case 'INSERT_TIMEOUT':
    case 'RECORDING_CAP_REACHED':
      return ignored(snapshot, 'not meaningful while idle', event);
  }
}

function reduceRecording(snapshot: Snapshot, event: PostSecureEvent): Step {
  const { ctx } = snapshot;
  const sessionId = ctx.sessionId ?? '';

  const stopAndProcess = (): Step =>
    step('processing', { ...ctx, level: 0 }, [
      { type: 'stop_capture', sessionId },
      { type: 'finish_stt', sessionId },
      { type: 'hud', view: { kind: 'processing', interim: ctx.interim } },
      { type: 'tray', state: 'processing', secureInput: ctx.secureInput },
      { type: 'cue', cue: 'stop' },
    ]);

  switch (event.type) {
    case 'PTT_UP':
      // In toggle mode this is the Fn release that follows Fn+Space (§4).
      return ctx.mode === 'hold'
        ? stopAndProcess()
        : ignored(snapshot, 'toggle mode ignores the Fn release', event);

    case 'TOGGLE':
      // §4: a `toggle` during a hold converts the session to hands-free; a
      // `toggle` during hands-free stops it.
      return ctx.mode === 'hold'
        ? step('recording', { ...ctx, mode: 'toggle' }, [
            { type: 'hud', view: recordingView({ ...ctx, mode: 'toggle' }) },
            { type: 'log', level: 'info', message: 'hold converted to hands-free (Fn+Space)' },
          ])
        : stopAndProcess();

    case 'PTT_DOWN':
      // **A bare Fn also ends hands-free.** Added in Phase 5 at the user's
      // direction: _"i want to toggle not by pressing fn + space AGAIN, but
      // only pressing fn should be possible aswell"_. It is the obvious
      // gesture, and the HT-9 log caught the old behaviour turning it down —
      // `ignored PTT_DOWN: already recording`, immediately before the user
      // reached for Fn+Space instead.
      //
      // Nothing restarts on the release: the `PTT_UP` that follows arrives in
      // `processing`, where it clears `pendingStart` rather than queueing one
      // (§5). Fn+Space still works, and now stops on its Fn-down; the `toggle`
      // that follows is ignored in `processing`, so no stray space is typed.
      //
      // In hold mode a second `PTT_DOWN` is still a repeat of the key that is
      // already down.
      return ctx.mode === 'toggle'
        ? stopAndProcess()
        : ignored(snapshot, 'already recording', event);

    case 'CANCEL':
      return step(
        'idle',
        { ...ctx, sessionId: null, committed: [], interim: '', pendingStart: false, level: 0 },
        [
          { type: 'cancel_capture', sessionId },
          { type: 'abort_stt', sessionId },
          { type: 'hud', view: { kind: 'hidden' } },
          { type: 'tray', state: 'idle', secureInput: ctx.secureInput },
        ],
      );

    case 'FRONTMOST':
      return step(
        'recording',
        { ...ctx, targetBundleId: event.app.bundleId, targetName: event.app.name },
        [],
      );

    case 'TRANSCRIPT_INTERIM': {
      const next = { ...ctx, interim: event.text };
      return step('recording', next, [{ type: 'hud', view: recordingView(next) }]);
    }

    case 'TRANSCRIPT_FINAL': {
      // §7: accumulate, do not insert. One hold produces one insertion.
      const next = { ...ctx, committed: [...ctx.committed, event.text], interim: '' };
      return step('recording', next, [{ type: 'hud', view: recordingView(next) }]);
    }

    case 'TURN_ENDED': {
      // The server ended the turn on its own — it errored, or it closed the
      // socket. The user may still be holding the key, so the device has to be
      // closed here: without this the microphone stays open and the macOS
      // orange indicator stays lit through insertion and beyond, which reads as
      // spyware — and the elapsed/cap timers keep ticking
      // because the orchestrator clears them on `stop_capture`.
      const ended = endTurn(ctx, event.durationSec);
      return {
        snapshot: ended.snapshot,
        effects: [{ type: 'stop_capture', sessionId }, ...ended.effects],
      };
    }

    case 'RECORDING_CAP_REACHED':
      return step('processing', ctx, [
        { type: 'stop_capture', sessionId },
        { type: 'finish_stt', sessionId },
        { type: 'hud', view: { kind: 'processing', interim: ctx.interim } },
        // Without this the icon sits on `recording` through the whole
        // processing window after a capped hold, and Escape stays armed for a
        // state that is no longer recording.
        { type: 'tray', state: 'processing', secureInput: ctx.secureInput },
        { type: 'log', level: 'warn', message: 'recording cap reached; finishing the turn' },
      ]);

    case 'LEVEL': {
      const next = { ...ctx, level: event.level, peakLevel: Math.max(ctx.peakLevel, event.level) };
      return step('recording', next, [{ type: 'hud', view: recordingView(next) }]);
    }

    case 'TICK': {
      const next = {
        ...ctx,
        elapsedMs: ctx.startedAt === null ? 0 : Math.max(0, event.now - ctx.startedAt),
      };
      return step('recording', next, [{ type: 'hud', view: recordingView(next) }]);
    }

    case 'SESSION_ERROR':
      return toIdleWithError(ctx, event.error);

    case 'RETRY_INSERT':
    case 'INSERT_TEXT':
    case 'INSERT_RESULT':
    case 'INSERT_TIMEOUT':
      return ignored(snapshot, 'not meaningful while recording', event);
  }
}

function reduceProcessing(snapshot: Snapshot, event: PostSecureEvent): Step {
  const { ctx } = snapshot;
  const sessionId = ctx.sessionId ?? '';

  switch (event.type) {
    case 'TRANSCRIPT_FINAL':
      return beginInsert(ctx, event.text);

    case 'TURN_ENDED':
      return endTurn(ctx, event.durationSec);

    case 'TRANSCRIPT_INTERIM': {
      const next = { ...ctx, interim: event.text };
      return step('processing', next, [
        { type: 'hud', view: { kind: 'processing', interim: event.text } },
      ]);
    }

    case 'CANCEL':
      return step(
        'idle',
        { ...ctx, sessionId: null, committed: [], interim: '', pendingStart: false },
        [
          { type: 'abort_stt', sessionId },
          { type: 'hud', view: { kind: 'hidden' } },
          { type: 'tray', state: 'idle', secureInput: ctx.secureInput },
        ],
      );

    // §5: queue the press rather than dropping it.
    case 'PTT_DOWN':
      return step('processing', { ...ctx, pendingStart: true }, [
        { type: 'log', level: 'debug', message: 'ptt_down queued while processing' },
      ]);
    case 'PTT_UP':
      return step('processing', { ...ctx, pendingStart: false }, []);

    case 'SESSION_ERROR':
      return toIdleWithError(ctx, event.error);

    case 'FRONTMOST':
      return step(
        'processing',
        { ...ctx, targetBundleId: event.app.bundleId, targetName: event.app.name },
        [],
      );

    case 'TOGGLE':
    case 'RETRY_INSERT':
    case 'INSERT_TEXT':
    case 'INSERT_RESULT':
    case 'INSERT_TIMEOUT':
    case 'RECORDING_CAP_REACHED':
    case 'LEVEL':
    case 'TICK':
      return ignored(snapshot, 'not meaningful while processing', event);
  }
}

function reduceInserting(snapshot: Snapshot, event: PostSecureEvent, env: MachineEnv): Step {
  const { ctx } = snapshot;
  switch (event.type) {
    case 'INSERT_RESULT':
      return finishInsert(snapshot, event.outcome, env);

    case 'INSERT_TIMEOUT':
      return finishInsert(
        snapshot,
        { tier: 'none', ok: false, error: 'the helper did not answer in time' },
        env,
        'helper_unavailable',
      );

    // §5 — the  resolution.
    case 'PTT_DOWN':
      return step('inserting', { ...ctx, pendingStart: true }, [
        { type: 'log', level: 'debug', message: 'ptt_down queued while inserting' },
      ]);
    case 'PTT_UP':
      return step('inserting', { ...ctx, pendingStart: false }, []);

    case 'SESSION_ERROR':
      return finishInsert(
        snapshot,
        { tier: 'none', ok: false, error: event.error.message },
        env,
        'helper_unavailable',
      );

    case 'CANCEL':
      return ignored(snapshot, 'an insert in flight cannot be recalled', event);

    /**
     * `transcript.done` lands here, not in `processing`.
     *
     * `speech_final` always arrives first (the two are in the same millisecond
     * in every captured session, `docs/spike-raw/02a-done-ep400.jsonl`), so
     * `TRANSCRIPT_FINAL` has already moved the machine into `inserting` by the
     * time the duration shows up. Phase 1 wrote this case as `ignored`, which
     * meant `ctx.durationSec` was still `null` when `finishInsert` built the
     * history row — every row in the user's real `history.json` had
     * `durationSec: null`, including the ones produced by the real STT client
     * (docs/phase-3-report.md §5.1, docs/phase-4-report.md §5.4). It is the only
     * audio-seconds figure the product has, and  wants it to
     * answer §9.1's cost question.
     */
    case 'TURN_ENDED':
      return step('inserting', { ...ctx, durationSec: event.durationSec }, []);

    /**
     * A `speech_final` that lands after the insert was dispatched.
     *
     * Until this case existed it was dropped on the floor, and with it the last
     * segment of the turn: `processing` inserts on the *first* final it sees, so
     * a server that flushes two segments after `audio.done` — which it does when
     * the buffered tail contains a pause — lost the second one from the pill,
     * from history and from ⌃⌘V. Silent truncation, no warning anywhere.
     *
     * It still is not typed: one hold produces one insertion (§7), and the
     * helper is already committed. But it is kept, so every recovery surface has
     * the whole transcript, and it is logged, because text the user said and did
     * not get is worth a line in the log.
     */
    case 'TRANSCRIPT_FINAL':
      return step('inserting', { ...ctx, committed: [...ctx.committed, event.text], interim: '' }, [
        {
          type: 'log',
          level: 'warn',
          message:
            'a speech_final arrived after the insert was dispatched — kept in history and on ⌃⌘V, but not typed',
          fields: { chars: event.text.length },
        },
      ]);

    case 'TOGGLE':
    case 'RETRY_INSERT':
    case 'INSERT_TEXT':
    case 'FRONTMOST':
    case 'TRANSCRIPT_INTERIM':
    case 'RECORDING_CAP_REACHED':
    case 'LEVEL':
    case 'TICK':
      return ignored(snapshot, 'not meaningful while inserting', event);
  }
}

function reduceBlocked(snapshot: Snapshot, event: PostSecureEvent, env: MachineEnv): Step {
  const { ctx } = snapshot;
  const refuse = (what: string): Step =>
    step('blocked', ctx, [
      { type: 'hud', view: { kind: 'blocked' } },
      { type: 'cue', cue: 'error' },
      { type: 'log', level: 'warn', message: `${what} refused: Secure Input is active` },
    ]);

  switch (event.type) {
    case 'PTT_DOWN':
      return refuse('push-to-talk');
    case 'TOGGLE':
      return refuse('hands-free toggle');
    case 'RETRY_INSERT':
      // §8: insertion is never attempted while blocked. Phase 2's HT-5 settled
      //  — Secure Input does *not* block AX writes, only event
      // taps — so this rule is a deliberate safety choice rather than a
      // technical necessity. We could type into a focused password field. We
      // do not.
      return refuse('re-insert');
    case 'INSERT_TEXT':
      return refuse('insert');

    case 'TRANSCRIPT_FINAL':
      return step(
        'blocked',
        { ...ctx, committed: [...ctx.committed, event.text], interim: '' },
        [],
      );

    case 'TRANSCRIPT_INTERIM':
      return step('blocked', { ...ctx, interim: event.text }, []);

    case 'TURN_ENDED': {
      const withDuration = { ...ctx, durationSec: event.durationSec };
      const text = committedText(withDuration);
      if (text.length === 0) return step('blocked', { ...withDuration, sessionId: null }, []);
      return step(
        'blocked',
        { ...withDuration, sessionId: null, lastTranscript: text, committed: [], interim: '' },
        [
          {
            type: 'history_append',
            entry: {
              text,
              durationSec: event.durationSec,
              frontmostBundleId: ctx.targetBundleId,
              frontmostName: ctx.targetName,
              tier: 'none',
              inserted: false,
            },
          },
          {
            type: 'hud',
            view: {
              kind: 'not_inserted',
              text,
              reason: 'secure_input',
              detail: 'A password field had focus, so nothing was typed.',
            },
          },
        ],
      );
    }

    case 'INSERT_RESULT':
      return finishInsert(snapshot, event.outcome, env);

    case 'SESSION_ERROR':
      return step('blocked', { ...ctx, sessionId: null, committed: [], interim: '' }, [
        { type: 'log', level: 'warn', message: `error while blocked: ${event.error.message}` },
      ]);

    case 'PTT_UP':
    case 'CANCEL':
    case 'FRONTMOST':
    case 'INSERT_TIMEOUT':
    case 'RECORDING_CAP_REACHED':
    case 'LEVEL':
    case 'TICK':
      return ignored(snapshot, 'not meaningful while blocked', event);
  }
}
