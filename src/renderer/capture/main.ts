/**
 * OWNER: **Phase 3**. The hidden capture renderer.
 *
 * `getUserMedia` → `AudioContext` → `AudioWorklet` → PCM16 mono 16 kHz in
 * 100 ms / 3,200-byte chunks, posted to the main process as `capture-chunk`
 * (IMPLEMENTATION-PLAN.md §3.3, ).
 *
 * ## Why a renderer at all
 *
 * The main process has no `getUserMedia`, and  chose an
 * `AudioContext` over the Rust crate's `cpal` capture precisely because
 * "resampling/downmix is free from a renderer `AudioContext` at
 * `sampleRate: 16000`". The window is hidden and has one job.
 *
 * ## The two rules this file exists to keep
 *
 * 1. **The microphone is never pre-warmed**. `getUserMedia`
 *    is called when a hold starts and the tracks are stopped when it ends, so
 *    the macOS orange indicator is lit exactly while recording. A permanently
 *    lit indicator reads as spyware. The `AudioContext` and worklet *are*
 *    warmed at the first press and reused: they light nothing. Connect-time
 *    buffering still covers the socket handshake; warming the graph covers
 *    the hops before the first sample exists.
 *
 * 2. **Opening the device must not delay anything.** `AudioSourcePort.start` is
 *    synchronous by contract; everything here is asynchronous and reports
 *    failure through `capture-error`. Audio captured while the socket is still
 *    handshaking is buffered by the STT client, not dropped.
 *
 * No `console` in this file: the renderer has no access to the redacting logger
 * (`src/shared/logger.ts` is Node-side), so diagnostics travel over the
 * contract's own messages and are logged in main.
 */

import type { AppError } from '@shared/result.js';
import { appError } from '@shared/result.js';
import type { CaptureTrackSettings, MainToRenderer } from '@contracts/events.js';
import { PcmEncoder, rmsOf } from './pcm.js';
import { PCM_WORKLET_NAME, resetWorkletPort, pcmWorkletUrl } from './pcm-worklet.js';

const api = window.grokDictate;

/**
 * Chromium's default input processing. Kept on deliberately rather than
 * requesting raw audio: noise suppression and gain control help a laptop
 * microphone at conversational distance, and echo cancellation stops the app's
 * own start/stop cues being transcribed.
 *
 * **Still a tuning knob, and still unmeasured.** Chromium's WebRTC processing
 * is tuned for telephony intelligibility, not for a recogniser, and the Rust
 * CLI this app is modelled on takes raw `cpal` capture with none of it — so
 * "the CLI sounds better" has a plausible cause here as well as in the
 * segmentation. What settles it is a transcript comparison, not an opinion, and
 * that needs the *applied* values on the record: they now travel with
 * `capture-started` and are logged next to every dictation.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  channelCount: { ideal: 1 },
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

/** Guard against a device that flaps; three attempts, then report (§11.1.8). */
const MAX_DEVICE_RESTARTS = 3;

interface WarmGraph {
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  readonly sink: GainNode;
  readonly sampleRate: number;
}

interface ActiveCapture {
  readonly sessionId: string;
  readonly graph: WarmGraph;
  readonly encoder: PcmEncoder;
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  restarts: number;
}

let graph: WarmGraph | null = null;
let active: ActiveCapture | null = null;
/**
 * The session main last asked for. Every `await` below re-checks it: a hold
 * short enough to end during `getUserMedia` must leave the microphone closed,
 * not open with nobody listening.
 */
let requested: string | null = null;

/**
 * Prepare the `AudioContext` and worklet once. They need no microphone
 * permission and light nothing.
 *
 * Idea from FluidVoice's prepare/start split; reimplemented against this
 * capture renderer. No source copied.
 *
 * **The context is suspended while idle.** A running idle context holds an
 * output device open and can pin Bluetooth headsets in HFP instead of A2DP
 * (music sounding like a phone call all day). That was not measurable here,
 * so the conservative choice is suspend. Chromium may also construct the
 * context already `suspended` without a user gesture — `resume()` is called
 * explicitly at press.
 *
 * `sampleRate` is committed at construction (16 kHz). The explicit-resampler
 * fallback in the coordinator depends on that; a later context at 48 kHz
 * would double-resample.
 */
async function ensureGraph(sampleRate: number, chunkBytes: number): Promise<WarmGraph> {
  if (graph !== null && graph.sampleRate === sampleRate && graph.context.state !== 'closed') {
    return graph;
  }
  if (graph !== null) {
    try {
      await graph.context.close();
    } catch {
      // Already gone.
    }
    graph = null;
  }

  const context = new AudioContext({ sampleRate, latencyHint: 'interactive' });
  await context.audioWorklet.addModule(pcmWorkletUrl());
  const node = new AudioWorkletNode(context, PCM_WORKLET_NAME, {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    outputChannelCount: [1],
    channelCount: 1,
    channelCountMode: 'explicit',
    channelInterpretation: 'speakers',
    processorOptions: {
      framesPerPost: Math.max(128, Math.round((context.sampleRate * chunkBytes) / 32_000)),
    },
  });
  const sink = context.createGain();
  sink.gain.value = 0;
  node.connect(sink);
  sink.connect(context.destination);

  if (context.state === 'running') {
    // Idle-running is the Bluetooth-HFP hazard. Suspend until press.
    await context.suspend();
  }

  const warmed: WarmGraph = { context, node, sink, sampleRate: context.sampleRate };
  graph = warmed;
  return warmed;
}

// Only two of `MainToRenderer`'s members concern this window; the rest are for
// the HUD and settings, so this is an `if` rather than an exhaustive switch.
api.on((message: MainToRenderer) => {
  if (message.type === 'capture-start') {
    requested = message.sessionId;
    void startCapture(message.sessionId, message.sampleRate, message.chunkBytes);
    return;
  }
  if (message.type === 'capture-stop') {
    if (requested === message.sessionId) requested = null;
    stopCapture(message.sessionId);
  }
});

async function startCapture(
  sessionId: string,
  sampleRate: number,
  chunkBytes: number,
): Promise<void> {
  // Press supersedes press (`pipeline.rs:50-63`): tear the old one down first so
  // two sessions can never hold the device at once.
  if (active !== null) stopCapture(active.sessionId);

  let warmed: WarmGraph;
  try {
    warmed = await ensureGraph(sampleRate, chunkBytes);
  } catch (cause) {
    api.send({
      type: 'capture-error',
      sessionId,
      error: appError(
        'audio_device',
        'Grok Dictate could not start the audio pipeline.',
        'Try again. If it keeps happening, restart Grok Dictate.',
        cause instanceof Error ? cause.message : String(cause),
      ),
    });
    return;
  }
  if (requested !== sessionId) return;

  let stream: MediaStream;
  try {
    // **The only call that lights the orange indicator.** The graph is warm;
    // the microphone is not. getUserMedia happens at press, never earlier.
    stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  } catch (cause) {
    api.send({ type: 'capture-error', sessionId, error: describeMediaError(cause) });
    return;
  }
  if (requested !== sessionId) {
    // The key was released before the device opened. Close it again immediately.
    stopTracks(stream);
    return;
  }

  try {
    if (warmed.context.state === 'suspended') {
      await warmed.context.resume();
    }
  } catch (cause) {
    stopTracks(stream);
    api.send({
      type: 'capture-error',
      sessionId,
      error: appError(
        'audio_device',
        'Grok Dictate could not start the audio pipeline.',
        'Try again. If it keeps happening, restart Grok Dictate.',
        cause instanceof Error ? cause.message : String(cause),
      ),
    });
    return;
  }
  if (requested !== sessionId) {
    stopTracks(stream);
    void warmed.context.suspend().catch(() => undefined);
    return;
  }

  let source: MediaStreamAudioSourceNode;
  try {
    source = warmed.context.createMediaStreamSource(stream);
    source.connect(warmed.node);
  } catch (cause) {
    stopTracks(stream);
    api.send({
      type: 'capture-error',
      sessionId,
      error: appError(
        'audio_device',
        'Grok Dictate could not start the audio pipeline.',
        'Try again. If it keeps happening, restart Grok Dictate.',
        cause instanceof Error ? cause.message : String(cause),
      ),
    });
    return;
  }

  // A fresh encoder per session. Reusing one across dictations would carry
  // the previous turn's pending bytes into the next (the two-phase drain
  // flushes, but only if stop ran; a cancelled start must not leak either).
  const capture: ActiveCapture = {
    sessionId,
    graph: warmed,
    stream,
    source,
    encoder: new PcmEncoder({
      inputSampleRate: warmed.context.sampleRate,
      outputSampleRate: sampleRate,
      chunkBytes,
    }),
    restarts: 0,
  };
  active = capture;

  // Belt: a missed reset on the previous stop must not mix sessions.
  resetWorkletPort(warmed.node.port);

  warmed.node.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
    if (active !== capture) return;
    const samples = new Float32Array(event.data);
    api.send({ type: 'capture-level', sessionId, level: rmsOf(samples) });
    for (const chunk of capture.encoder.push(samples)) {
      api.send({ type: 'capture-chunk', sessionId, pcm: toArrayBuffer(chunk) });
    }
  };

  watchDevice(capture);

  // `actualSampleRate` is how assumption 10.4 gets checked: main logs it, and a
  // value that is not 16,000 means the explicit resampler is doing the work.
  api.send({
    type: 'capture-started',
    sessionId,
    actualSampleRate: warmed.context.sampleRate,
    sentAtMs: Date.now(),
    ...trackSettingsOf(stream),
  });
}

function stopCapture(sessionId: string): void {
  const capture = active;
  if (capture === null || capture.sessionId !== sessionId) return;
  active = null;

  // Send the tail before closing: it is up to 100 ms, and the last 100 ms of a
  // hold is the end of the last word.
  const tail = capture.encoder.flush();
  if (tail !== null) {
    api.send({ type: 'capture-chunk', sessionId, pcm: toArrayBuffer(tail) });
  }
  // **Then say so.** Until the 2026-08-09 incident this function's tail-flush
  // was dead code: the main process dropped the session synchronously when it
  // sent `capture-stop`, so the chunk above arrived with nowhere to go and
  // `audio.done` had gone out before it anyway. The ack is what makes the two
  // sides agree on when a turn's audio is complete — sent unconditionally,
  // including when there was no tail, because it means "that was all of it"
  // rather than "here is one more".
  api.send({ type: 'capture-drained', sessionId });

  // Drop the processor's leftover frames *before* disconnecting: empty
  // `process()` after disconnect does not reset `_fill`, and a reused node
  // would prepend those samples to the next session.
  resetWorkletPort(capture.graph.node.port);
  capture.graph.node.port.onmessage = null;
  try {
    capture.source.disconnect();
  } catch {
    // A context already torn down by a device failure; nothing to do.
  }
  // Stopping the tracks is what turns the orange indicator off (§11.2.4).
  // The graph stays: only the microphone is released.
  stopTracks(capture.stream);
  void capture.graph.context.suspend().catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Device changes
 * ------------------------------------------------------------------ */

/**
 * AirPods connecting mid-utterance is the common case, and it otherwise kills
 * the stream silently — the worklet simply stops being fed and the user watches
 * an empty HUD until the no-speech watchdog fires ten seconds later.
 *
 * The warm graph and the encoder are kept across a restart, so chunk framing
 * and the sample rate stay continuous; only the source node is replaced.
 */
function watchDevice(capture: ActiveCapture): void {
  for (const track of capture.stream.getAudioTracks()) {
    track.addEventListener('ended', () => {
      if (active === capture) void restartDevice(capture);
    });
  }
}

navigator.mediaDevices.addEventListener('devicechange', () => {
  const capture = active;
  if (capture === null) return;
  const track = capture.stream.getAudioTracks()[0];
  // A device list change that does not affect the live track is none of our
  // business — restarting would drop audio for no reason.
  if (track === undefined || track.readyState === 'ended') void restartDevice(capture);
});

async function restartDevice(capture: ActiveCapture): Promise<void> {
  if (active !== capture) return;
  if (capture.restarts >= MAX_DEVICE_RESTARTS) {
    api.send({
      type: 'capture-error',
      sessionId: capture.sessionId,
      error: appError(
        'audio_device',
        'The microphone kept disconnecting during recording.',
        'Check the input device in System Settings → Sound, then try again.',
      ),
    });
    stopCapture(capture.sessionId);
    return;
  }
  capture.restarts++;

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: AUDIO_CONSTRAINTS });
  } catch (cause) {
    if (active !== capture) return;
    api.send({
      type: 'capture-error',
      sessionId: capture.sessionId,
      error: describeMediaError(cause),
    });
    stopCapture(capture.sessionId);
    return;
  }
  if (active !== capture) {
    stopTracks(stream);
    return;
  }

  try {
    capture.source.disconnect();
  } catch {
    // Already gone with the old device.
  }
  stopTracks(capture.stream);

  capture.stream = stream;
  capture.source = capture.graph.context.createMediaStreamSource(stream);
  capture.source.connect(capture.graph.node);
  watchDevice(capture);

  // Re-announcing the open device is the only channel this renderer has for
  // "something happened": main logs a second `capture started`, which is what
  // makes a mid-hold device switch visible afterwards.
  api.send({
    type: 'capture-started',
    sessionId: capture.sessionId,
    actualSampleRate: capture.graph.context.sampleRate,
    sentAtMs: Date.now(),
    ...trackSettingsOf(stream),
  });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

/**
 * What the device actually agreed to, as opposed to what `AUDIO_CONSTRAINTS`
 * asked for. Absent keys are omitted rather than sent as `undefined`, so the
 * log distinguishes "the device says echo cancellation is off" from "the device
 * does not report echo cancellation at all".
 */
function trackSettingsOf(stream: MediaStream): { trackSettings?: CaptureTrackSettings } {
  const track = stream.getAudioTracks()[0];
  if (track === undefined) return {};
  const applied = track.getSettings();
  const settings: { -readonly [K in keyof CaptureTrackSettings]?: CaptureTrackSettings[K] } = {};
  if (applied.deviceId !== undefined) settings.deviceId = applied.deviceId;
  if (applied.channelCount !== undefined) settings.channelCount = applied.channelCount;
  if (applied.sampleRate !== undefined) settings.sampleRate = applied.sampleRate;
  if (applied.echoCancellation !== undefined) settings.echoCancellation = applied.echoCancellation;
  if (applied.noiseSuppression !== undefined) settings.noiseSuppression = applied.noiseSuppression;
  if (applied.autoGainControl !== undefined) settings.autoGainControl = applied.autoGainControl;
  return { trackSettings: settings };
}

/** Exactly-sized, so IPC transfers the chunk and nothing around it. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/**
 * `getUserMedia` failures, translated into something a person can act on.
 * §4: "'STT failed' is a defect."
 */
function describeMediaError(cause: unknown): AppError {
  const name = cause instanceof Error ? cause.name : '';
  const detail = cause instanceof Error ? cause.message : String(cause);

  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return appError(
        'audio_permission',
        'Grok Dictate is not allowed to use the microphone.',
        'Grant Microphone access in System Settings → Privacy & Security → Microphone, then try again.',
        detail,
      );
    case 'NotFoundError':
    case 'OverconstrainedError':
      return appError(
        'audio_device',
        'No microphone is available.',
        'Connect an input device, or choose one in System Settings → Sound, then try again.',
        detail,
      );
    case 'NotReadableError':
      return appError(
        'audio_device',
        'The microphone is in use by another application.',
        'Quit whatever is holding the microphone, then try again.',
        detail,
      );
    default:
      return appError(
        'audio_device',
        'Grok Dictate could not open the microphone.',
        'Check System Settings → Sound, then try again.',
        detail,
      );
  }
}
