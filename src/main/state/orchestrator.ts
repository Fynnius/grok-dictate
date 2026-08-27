/**
 * The composition root's engine: runs the reducer and interprets its effects
 * against the ports.
 *
 * This is where the walking skeleton actually walks. It contains no Electron
 * and no I/O of its own — every outward action goes through a port from
 * `contracts/ports.ts` — which is what lets the full dictation round-trip be
 * exercised by an automated test (IMPLEMENTATION-PLAN.md §3.1.3) and lets
 * Phases 2-4 swap real implementations in without touching `src/main/index.ts`.
 */

import { randomUUID } from 'node:crypto';
import type {
  AudioCue,
  AudioSourcePort,
  ConfigPort,
  HistoryPort,
  HudPort,
  NativeHelperPort,
  SoundPort,
  SttClientPort,
  SttTurn,
  TrayPort,
} from '@contracts/ports.js';
import type { AppSnapshot, HudView } from '@contracts/events.js';
import { resolveWireLanguage } from '@contracts/config.js';
import { MAX_RECORDING_MS } from '@shared/constants.js';
import { systemLanguageSubtag } from '@shared/env.js';
import { sameHudView } from '@shared/hud-view.js';
import type { Logger } from '@shared/logger.js';
import { appError } from '@shared/result.js';
import { CUE_SPECS } from '../sound/cues.js';
import { assessSilenceGate, pcmDurationMs } from '@shared/silence-gate.js';
import {
  TimingSession,
  formatTimingLine,
  timingEnabled,
  type TimingEvent,
  type TimingFields,
} from '@shared/timing.js';
import {
  INITIAL_SNAPSHOT,
  reduce,
  type Effect,
  type MachineEnv,
  type SessionEvent,
  type Snapshot,
} from './machine.js';

export interface OrchestratorDeps {
  readonly native: NativeHelperPort;
  readonly audio: AudioSourcePort;
  readonly stt: SttClientPort;
  readonly hud: HudPort;
  readonly tray: TrayPort;
  readonly sound: SoundPort;
  readonly history: HistoryPort;
  readonly config: ConfigPort;
  readonly logger: Logger;
  readonly env?: MachineEnv;
  /** Notified after every transition, for the renderers. */
  readonly onChange?: (snapshot: Snapshot, hud: HudView) => void;
  /** HUD elapsed-time refresh. 0 disables it (tests). */
  readonly tickIntervalMs?: number;
  /**
   * How long to wait after the start cue before muting output.
   * Production: start-cue duration + 15 ms pad. Tests pass 0 so they stay
   * synchronous. **Chosen, not measured:** the cue is 55 ms by spec; 15 ms
   * covers executeJavaScript scheduling without delaying first PCM (capture
   * already started).
   */
  readonly muteAfterCueMs?: number;
  /**
   * How long to wait after unmute before playing the stop cue, so a device
   * mute does not swallow it. **Chosen, not measured:** CoreAudio property
   * sets are typically <10 ms; 25 ms is well under the 55 ms cue. Tests pass 0.
   */
  readonly unmuteBeforeCueMs?: number;
}

function productionEnv(config: ConfigPort): MachineEnv {
  return {
    newSessionId: () => randomUUID(),
    now: () => Date.now(),
    // Read per turn, not captured once: the settings window can toggle this
    // between two dictations and the next one should honour it.
    repairSeams: () => config.get().repairSeams,
    liveHudText: () => config.get().liveHudText,
    silenceGate: () => config.get().silenceGate,
    muteWhileRecording: () => config.get().muteWhileRecording,
  };
}

export class Orchestrator {
  readonly #deps: OrchestratorDeps;
  readonly #log: Logger;
  readonly #env: MachineEnv;
  readonly #unsubscribes: (() => void)[] = [];

  #snapshot: Snapshot = INITIAL_SNAPSHOT;
  #hudView: HudView = { kind: 'hidden' };
  #turns = new Map<string, SttTurn>();
  /**
   * Sessions between `stop_capture` and `onDrained`, and whether the machine
   * has already asked for the turn to be finished while we waited.
   *
   * The 2026-08-09 incident (BUG-2): `finish_stt` used to run in the same tick
   * as `stop_capture`, so `audio.done` was on the wire before the capture
   * renderer had flushed its encoder tail — the last ~100–300 ms of every
   * dictation, thrown away twice over. The turn now waits for the audio to be
   * complete. `AudioHandlers.onDrained` is contractually bounded in time, which
   * is what stops a wedged renderer parking the session in `processing`.
   */
  #draining = new Map<string, { finishRequested: boolean }>();
  #tickTimer: NodeJS.Timeout | null = null;
  #capTimer: NodeJS.Timeout | null = null;
  /**
   * What the `language` parameter was set to for the current turn, and what the
   * server actually *detected* (spike 1). History records the detection when we
   * have one, because that is what really happened.
   */
  #wireLanguage: string | null = null;
  #detectedLanguage: string | null = null;
  /** Set while dispatch is running, so effects can queue follow-up events. */
  #dispatching = false;
  readonly #queue: SessionEvent[] = [];
  #timing: TimingSession | null = null;
  readonly #timingOn = timingEnabled();
  #muteTimer: NodeJS.Timeout | null = null;
  #cueTimer: NodeJS.Timeout | null = null;
  #awaitingUnmuteCue = false;

  constructor(deps: OrchestratorDeps) {
    this.#deps = deps;
    this.#log = deps.logger.child('session');
    this.#env = deps.env ?? productionEnv(deps.config);
  }

  get snapshot(): Snapshot {
    return this.#snapshot;
  }

  get appSnapshot(): AppSnapshot {
    return {
      state: this.#snapshot.state,
      mode: this.#snapshot.ctx.mode,
      hud: this.#hudView,
      secureInput: this.#snapshot.ctx.secureInput,
      helperReady: this.#deps.native.isReady,
      lastTranscript: this.#snapshot.ctx.lastTranscript,
    };
  }

  /** Wire up the helper. Call once, after construction. */
  start(): void {
    const { native, config } = this.#deps;
    this.#unsubscribes.push(
      native.onReady(() => {
        // Re-assert bindings on every ready, including after a restart.
        native.setHotkeys(config.get().hotkeys);
        // Defensive: a previous helper may have died muted. Idempotent if not.
        native.unmuteOutput();
      }),
      native.onHotkey((action, ts) => {
        switch (action) {
          case 'ptt_down':
            this.dispatch({ type: 'PTT_DOWN', ts });
            return;
          case 'ptt_up':
            this.dispatch({ type: 'PTT_UP', ts });
            return;
          case 'toggle':
            this.dispatch({ type: 'TOGGLE', ts });
            return;
          case 'retry_insert':
            this.dispatch({ type: 'RETRY_INSERT' });
            return;
        }
      }),
      native.onSecureInput((enabled) => {
        this.dispatch({ type: 'SECURE_INPUT', enabled });
      }),
    );
    if (native.isReady) {
      native.setHotkeys(config.get().hotkeys);
      native.unmuteOutput();
    }
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    this.#clearTimers();
    this.#cancelMuteTimers();
    // Leaving the user muted is the worst bug in this pass. Dispose is the
    // quit path; the helper also restores on its own teardown.
    this.#deps.native.unmuteOutput();
    for (const turn of this.#turns.values()) turn.abort();
    this.#turns.clear();
    this.#draining.clear();
    this.#timing = null;
  }

  /**
   * Feed an event through the machine and run its effects.
   *
   * Re-entrancy is real here: an effect may synchronously produce another event
   * (a mocked STT with a 0 ms script does exactly that). Queueing rather than
   * recursing keeps the transition order identical to the sequential case.
   */
  dispatch(event: SessionEvent): void {
    this.#queue.push(event);
    if (this.#dispatching) return;
    this.#dispatching = true;
    try {
      while (this.#queue.length > 0) {
        const next = this.#queue.shift();
        if (next === undefined) break;
        const before = this.#snapshot.state;
        this.#noteEvent(next, before);
        const stepped = reduce(this.#snapshot, next, this.#env);
        this.#snapshot = stepped.snapshot;
        if (before !== stepped.snapshot.state) {
          this.#log.debug('state', { from: before, to: stepped.snapshot.state, event: next.type });
        }
        for (const effect of stepped.effects) this.#run(effect);
        if (before !== 'idle' && stepped.snapshot.state === 'idle') {
          this.#mark('idle');
          this.#emitSummary();
        }
        this.#deps.onChange?.(this.#snapshot, this.#hudView);
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #run(effect: Effect): void {
    const { audio, stt, native, hud, tray, history, config } = this.#deps;

    switch (effect.type) {
      case 'start_capture': {
        const sessionId = effect.sessionId;
        audio.start(sessionId, {
          onChunk: (pcm) => {
            const timing = this.#timing;
            if (timing !== null && timing.sessionId === sessionId) {
              timing.pcmChunks += 1;
              if (timing.mark('first_pcm_main', this.#env.now()).first) {
                this.#emitMark('first_pcm_main', timing.elapsed(this.#env.now()), {
                  pcm_bytes: pcm.byteLength,
                });
              }
            }
            this.#turns.get(sessionId)?.sendPcm(pcm);
          },
          onLevel: (level) => this.dispatch({ type: 'LEVEL', sessionId, level }),
          onError: (error) => this.dispatch({ type: 'SESSION_ERROR', sessionId, error }),
          onDrained: () => this.#onDrained(sessionId),
          onStarted: (actualSampleRate) => {
            // Assumption 10.4: verify the context really runs at 16 kHz rather
            // than resampling twice (device → 48 k → 16 k).
            this.#log.info('capture started', { actualSampleRate });
            this.#mark('device_open');
          },
        });
        this.#beginTiming(sessionId);
        this.#mark('capture_requested');
        this.#startTimers(sessionId);
        return;
      }

      case 'stop_capture':
        // Registered *before* the call: a port that drains synchronously —
        // `MockAudioSource` does — would otherwise call back into `#onDrained`
        // with nothing recorded and the later `finish_stt` would wait for a
        // drain that had already happened.
        this.#draining.set(effect.sessionId, { finishRequested: false });
        audio.stop(effect.sessionId);
        this.#clearTimers();
        return;

      case 'cancel_capture':
        audio.cancel(effect.sessionId);
        // Esc and a failed session both discard the audio, so there is nothing
        // to drain for and no turn left to finish.
        this.#draining.delete(effect.sessionId);
        this.#clearTimers();
        return;

      case 'start_stt': {
        const sessionId = effect.sessionId;
        const cfg = config.get();
        // Never `auto` on the wire — `language.rs:176-186`,
        this.#wireLanguage = resolveWireLanguage(
          cfg.languageMode,
          undefined,
          systemLanguageSubtag(),
        );
        this.#detectedLanguage = null;
        const turn = stt.startTurn(
          {
            sessionId,
            language: this.#wireLanguage,
            endpointingMs: cfg.endpointingMs,
            keyterms: cfg.keyterms,
            useFinalize: cfg.useFinalize,
          },
          {
            onReady: () => {
              this.#log.debug('stt ready', { sessionId });
              this.#mark('socket_open');
            },
            onInterim: (text) => {
              if (text.trim().length > 0) {
                const timing = this.#timing;
                if (timing !== null && timing.sessionId === sessionId) {
                  timing.partials += 1;
                  if (timing.mark('first_partial', this.#env.now()).first) {
                    this.#emitMark('first_partial', timing.elapsed(this.#env.now()), {
                      text_len: text.length,
                    });
                  }
                }
              }
              this.dispatch({ type: 'TRANSCRIPT_INTERIM', sessionId, text });
            },
            onFinal: (text) => {
              const timing = this.#timing;
              if (timing !== null && timing.sessionId === sessionId) {
                timing.finals += 1;
                timing.textLen += text.length;
              }
              this.dispatch({ type: 'TRANSCRIPT_FINAL', sessionId, text });
            },
            onLanguageDetected: (code) => {
              this.#detectedLanguage = code;
            },
            onDone: (durationSec) => {
              // Free telemetry the Grok CLI parses and discards (§7.7, §11.1.6).
              this.#log.info('turn done', {
                sessionId,
                durationSec,
                sent: this.#wireLanguage,
                detected: this.#detectedLanguage,
              });
              this.#mark('final_transcript', {
                duration_ms: durationSec === null ? 0 : durationSec * 1000,
              });
              this.#releaseTurn(sessionId);
              this.dispatch({ type: 'TURN_ENDED', sessionId, durationSec });
            },
            onError: (error) => {
              this.#releaseTurn(sessionId);
              this.dispatch({ type: 'SESSION_ERROR', sessionId, error });
            },
          },
        );
        this.#turns.set(sessionId, turn);
        this.#log.info('turn started', { sessionId, language: this.#wireLanguage ?? '(omitted)' });
        return;
      }

      case 'finish_stt': {
        const pending = this.#draining.get(effect.sessionId);
        if (pending !== undefined) {
          // The capture renderer still owes us the tail of the utterance.
          // Sending `audio.done` now is what cut the last word off every
          // dictation before the 2026-08-09 incident.
          pending.finishRequested = true;
          this.#log.debug('holding audio.done until the capture tail arrives', {
            sessionId: effect.sessionId,
          });
          return;
        }
        // Drain already completed (MockAudioSource drains inside stop()).
        this.#finishOrGate(effect.sessionId);
        return;
      }

      case 'abort_stt': {
        this.#turns.get(effect.sessionId)?.abort();
        this.#turns.delete(effect.sessionId);
        this.#draining.delete(effect.sessionId);
        return;
      }

      case 'request_frontmost': {
        const sessionId = effect.sessionId;
        void native.getFrontmost().then((app) => {
          this.dispatch({ type: 'FRONTMOST', sessionId, app });
        });
        return;
      }

      case 'insert': {
        const sessionId = effect.sessionId;
        this.#mark('insert_begin', { text_len: effect.text.length });
        void native.insert(effect.text, effect.targetBundleId).then((outcome) => {
          this.dispatch({ type: 'INSERT_RESULT', sessionId, outcome });
        });
        return;
      }

      case 'mute_output': {
        this.#scheduleMute();
        return;
      }

      case 'unmute_output': {
        this.#unmuteNow();
        return;
      }

      case 'hud': {
        const previous = this.#hudView;
        this.#hudView = effect.view;
        if (effect.view.kind === 'hidden') {
          // `hide()` is not deduplicated: it also cancels the dwell timer in
          // the real HUD, and a second one is cheap and rare.
          hud.hide();
          return;
        }
        // A frame identical to the one on screen is an IPC round trip and a
        // re-render for nothing — and not restarting the dwell timer for it is
        // right as well, since the state has not changed (BUG-7).
        if (sameHudView(previous, effect.view)) return;
        hud.show(effect.view);
        return;
      }

      case 'tray':
        tray.setState(effect.state, effect.secureInput);
        return;

      case 'cue':
        this.#playCue(effect.cue);
        return;

      case 'history_append': {
        // The reducer cannot know these three (machine.ts, `HistoryDraft`).
        const entry = {
          ...effect.entry,
          id: randomUUID(),
          at: new Date(this.#env.now()).toISOString(),
          language: this.#detectedLanguage ?? this.#wireLanguage ?? 'unknown',
        };
        void history.append(entry).catch((cause: unknown) => {
          this.#log.error('failed to append history', { err: cause });
        });
        return;
      }

      case 'log':
        this.#log[effect.level](effect.message, effect.fields);
        return;
    }
  }

  /**
   * Let go of a turn that has reached a terminal state of its own.
   *
   * **Where the leak was** (2026-08-09 incident, BUG-5): `start_stt` put every
   * turn in `#turns` and the only `delete` was in `abort_stt`, which the normal
   * completion path never runs. Every successful dictation therefore leaked an
   * `SttTurnImpl` — its handler closures, its transcript accumulator and its
   * options including the keyterms — for the life of the process, and this is a
   * tray app that runs for weeks.
   *
   * It belongs here rather than in `finish_stt` for two reasons: a turn is not
   * finished when `audio.done` is *sent*, only when the server says so or the
   * client gives up; and since BUG-2 `finish_stt` may not even have run yet
   * when the drain is still outstanding. `onDone` and `onError` are the two
   * terminal callbacks, and the client guarantees no handler fires after them.
   */
  #releaseTurn(sessionId: string): void {
    this.#turns.delete(sessionId);
    this.#draining.delete(sessionId);
  }

  /**
   * The capture side has delivered everything it has for this session.
   *
   * Either the renderer acknowledged its tail chunk or the coordinator's drain
   * timer gave up on it; from here the two look the same and the turn ends
   * either way. See `AudioHandlers.onDrained`.
   */
  #onDrained(sessionId: string): void {
    const pending = this.#draining.get(sessionId);
    if (pending === undefined) return;
    this.#draining.delete(sessionId);
    if (!pending.finishRequested) return;
    this.#finishOrGate(sessionId);
  }

  /**
   * End of capture: either finish the STT turn or drop a short silent tap.
   *
   * Called once the drain has completed *and* the machine has asked to
   * finish — order of those two is not guaranteed (the mock audio port
   * drains inside `stop()`, the real renderer acks after).
   */
  #finishOrGate(sessionId: string): void {
    const pcm = this.#deps.audio.getUtteranceBuffer(sessionId);
    const ctx = this.#snapshot.ctx;
    const durationMs =
      ctx.startedAt === null
        ? pcm === null
          ? 0
          : pcmDurationMs(pcm)
        : this.#env.now() - ctx.startedAt;
    const decision = assessSilenceGate({
      pcm,
      durationMs,
      hasTranscriptText:
        ctx.interim.trim().length > 0 || ctx.committed.some((segment) => segment.trim().length > 0),
      enabled: ctx.silenceGate,
    });
    this.#mark('audio_done', {
      gated: decision.gated,
      reason: decision.reason,
      peak: decision.peak,
      rms: decision.rms,
      duration_ms: decision.durationMs,
      pcm_bytes: pcm?.byteLength ?? 0,
    });

    if (decision.gated) {
      this.#mark('silence_gated', {
        gated: true,
        reason: decision.reason,
        duration_ms: decision.durationMs,
      });
      this.#turns.get(sessionId)?.abort();
      this.#turns.delete(sessionId);
      this.dispatch({ type: 'SILENCE_GATED', sessionId });
      return;
    }

    this.#turns.get(sessionId)?.finish();
  }

  #startTimers(sessionId: string): void {
    this.#clearTimers();
    const interval = this.#deps.tickIntervalMs ?? 100;
    if (interval > 0) {
      this.#tickTimer = setInterval(() => {
        this.dispatch({ type: 'TICK', now: this.#env.now() });
      }, interval);
      this.#tickTimer.unref?.();
    }
    //  — the real server-side session limit is unknown until
    // spike 4; this bounds the utterance buffer meanwhile.
    this.#capTimer = setTimeout(() => {
      this.#log.warn('recording cap reached', { sessionId, capMs: MAX_RECORDING_MS });
      this.dispatch({ type: 'RECORDING_CAP_REACHED', sessionId });
    }, MAX_RECORDING_MS);
    this.#capTimer.unref?.();
  }

  #clearTimers(): void {
    if (this.#tickTimer !== null) {
      clearInterval(this.#tickTimer);
      this.#tickTimer = null;
    }
    if (this.#capTimer !== null) {
      clearTimeout(this.#capTimer);
      this.#capTimer = null;
    }
  }

  #noteEvent(event: SessionEvent, before: Snapshot['state']): void {
    if ((event.type === 'PTT_DOWN' || event.type === 'TOGGLE') && before === 'idle') {
      // Session id is assigned inside reduce; we start the clock *after* the
      // step below. Hotkey is marked from #run(start_capture) via #beginTiming.
      return;
    }
    if (event.type === 'PTT_UP' || (event.type === 'TOGGLE' && before === 'recording')) {
      this.#mark('hotkey_up');
    }
    if (event.type === 'INSERT_RESULT' || event.type === 'INSERT_TIMEOUT') {
      this.#mark('insert_end', {
        ok: event.type === 'INSERT_RESULT' ? event.outcome.ok : false,
      });
    }
  }

  #beginTiming(sessionId: string): void {
    const now = this.#env.now();
    this.#timing = new TimingSession(sessionId, now);
    this.#emitMark('hotkey_down', 0);
  }

  #mark(event: TimingEvent, extra: TimingFields = {}): void {
    const timing = this.#timing;
    if (timing === null) return;
    const { elapsedMs, first } = timing.mark(event, this.#env.now());
    if (!first && event !== 'summary') return;
    this.#emitMark(event, elapsedMs, extra);
  }

  #emitMark(event: TimingEvent, elapsedMs: number, extra: TimingFields = {}): void {
    if (!this.#timingOn || this.#timing === null) return;
    const line = formatTimingLine(this.#timing.sessionId, event, elapsedMs, extra);
    this.#log.info(`timing ${line}`);
  }

  #emitSummary(): void {
    const timing = this.#timing;
    if (timing === null) return;
    const now = this.#env.now();
    const elapsedMs = timing.elapsed(now);
    this.#emitMark('summary', elapsedMs, timing.summaryFields(now));
    this.#timing = null;
  }

  #scheduleMute(): void {
    const delay = this.#deps.muteAfterCueMs ?? CUE_SPECS.start.durationMs + 15;
    if (this.#muteTimer !== null) {
      clearTimeout(this.#muteTimer);
      this.#muteTimer = null;
    }
    const mute = (): void => {
      this.#muteTimer = null;
      if (this.#snapshot.state !== 'recording') return;
      this.#deps.native.muteOutput();
    };
    if (delay <= 0) {
      mute();
      return;
    }
    this.#muteTimer = setTimeout(mute, delay);
    this.#muteTimer.unref?.();
  }

  #unmuteNow(): void {
    if (this.#muteTimer !== null) {
      clearTimeout(this.#muteTimer);
      this.#muteTimer = null;
    }
    this.#deps.native.unmuteOutput();
    this.#awaitingUnmuteCue = true;
  }

  #playCue(cue: AudioCue): void {
    const play = (): void => {
      if (this.#deps.config.get().audioCues) this.#deps.sound.play(cue);
    };
    if (cue === 'stop' && this.#awaitingUnmuteCue) {
      this.#awaitingUnmuteCue = false;
      const gap = this.#deps.unmuteBeforeCueMs ?? 25;
      if (gap > 0) {
        if (this.#cueTimer !== null) clearTimeout(this.#cueTimer);
        this.#cueTimer = setTimeout(() => {
          this.#cueTimer = null;
          play();
        }, gap);
        this.#cueTimer.unref?.();
        return;
      }
    }
    play();
  }

  #cancelMuteTimers(): void {
    if (this.#muteTimer !== null) {
      clearTimeout(this.#muteTimer);
      this.#muteTimer = null;
    }
    if (this.#cueTimer !== null) {
      clearTimeout(this.#cueTimer);
      this.#cueTimer = null;
    }
  }

  /** The renderer's *Copy* button — the only route to the pasteboard (§5.8). */
  copyToClipboard(text: string): void {
    this.#deps.native.copy(text);
  }

  /** Surface an error raised outside a session (auth, config, helper death). */
  reportError(code: Parameters<typeof appError>[0], message: string, hint: string | null): void {
    this.dispatch({
      type: 'SESSION_ERROR',
      sessionId: this.#snapshot.ctx.sessionId,
      error: appError(code, message, hint),
    });
  }
}
