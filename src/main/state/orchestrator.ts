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
}

function productionEnv(config: ConfigPort): MachineEnv {
  return {
    newSessionId: () => randomUUID(),
    now: () => Date.now(),
    // Read per turn, not captured once: the settings window can toggle this
    // between two dictations and the next one should honour it.
    repairSeams: () => config.get().repairSeams,
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
    if (native.isReady) native.setHotkeys(config.get().hotkeys);
  }

  dispose(): void {
    for (const unsubscribe of this.#unsubscribes.splice(0)) unsubscribe();
    this.#clearTimers();
    for (const turn of this.#turns.values()) turn.abort();
    this.#turns.clear();
    this.#draining.clear();
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
        const stepped = reduce(this.#snapshot, next, this.#env);
        this.#snapshot = stepped.snapshot;
        if (before !== stepped.snapshot.state) {
          this.#log.debug('state', { from: before, to: stepped.snapshot.state, event: next.type });
        }
        for (const effect of stepped.effects) this.#run(effect);
        this.#deps.onChange?.(this.#snapshot, this.#hudView);
      }
    } finally {
      this.#dispatching = false;
    }
  }

  #run(effect: Effect): void {
    const { audio, stt, native, hud, tray, sound, history, config } = this.#deps;

    switch (effect.type) {
      case 'start_capture': {
        const sessionId = effect.sessionId;
        audio.start(sessionId, {
          onChunk: (pcm) => this.#turns.get(sessionId)?.sendPcm(pcm),
          onLevel: (level) => this.dispatch({ type: 'LEVEL', sessionId, level }),
          onError: (error) => this.dispatch({ type: 'SESSION_ERROR', sessionId, error }),
          onDrained: () => this.#onDrained(sessionId),
          onStarted: (actualSampleRate) => {
            // Assumption 10.4: verify the context really runs at 16 kHz rather
            // than resampling twice (device → 48 k → 16 k).
            this.#log.info('capture started', { actualSampleRate });
          },
        });
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
            onReady: () => this.#log.debug('stt ready', { sessionId }),
            onInterim: (text) => this.dispatch({ type: 'TRANSCRIPT_INTERIM', sessionId, text }),
            onFinal: (text) => this.dispatch({ type: 'TRANSCRIPT_FINAL', sessionId, text }),
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
        this.#turns.get(effect.sessionId)?.finish();
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
        void native.insert(effect.text, effect.targetBundleId).then((outcome) => {
          this.dispatch({ type: 'INSERT_RESULT', sessionId, outcome });
        });
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
        if (config.get().audioCues) sound.play(effect.cue);
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
