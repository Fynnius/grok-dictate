/**
 * OWNER: **Phase 3**. The microphone seam.
 *
 * `src/main/index.ts` calls `createAudioSource(logger)`; everything below it —
 * native capture or the hidden Chromium window, the IPC routing, the
 * full-utterance buffer — is assembled here so the composition root never
 * learns which adapter is in use.
 *
 * Native `grok-dictate-capture` is the primary adapter. The process is spawned
 * at app start and prepares its AVAudioEngine graph while idle; the device
 * still opens only on `start`. The Chromium capture window is created only
 * when that binary is missing, so a machine with the native path never opens
 * an AudioContext or a getUserMedia stream.
 *
 * ## How the capture messages get here
 *
 * `contracts/events.ts` routes `capture-*` over the same
 * `RENDERER_TO_MAIN_CHANNEL` as every other renderer message. Phase 3 could not
 * edit the then-frozen composition root, so it registered a *second*
 * `ipcMain.on` listener here — which made the root log `unhandled renderer
 * message` twice per 100 ms chunk (docs/phase-3-report.md §5.4). Phase 5 routes
 * from the single listener in `src/main/index.ts` instead, into
 * `handleRendererMessage` below.
 *
 * The sender check survives the move and is not decoration: without it any
 * renderer could inject PCM into a live session, so the root asks `ownsSender`
 * before handing anything over. On the native path `ownsSender` is false for
 * every WebContents — there is no capture renderer, and a HUD or settings
 * window that sent `capture-chunk` must not drive the session.
 */

import { accessSync, constants } from 'node:fs';
import { app, systemPreferences, type WebContents } from 'electron';
import type { RendererToMain } from '@contracts/events.js';
import type { AudioSourcePort } from '@contracts/ports.js';
import type { Logger } from '@shared/logger.js';
import { appError, type AppError } from '@shared/result.js';
import { currentCaptureLookupEnvironment, resolveCaptureBinary } from './capture-binary.js';
import { CaptureWindow } from './capture-window.js';
import { CaptureCoordinator } from './coordinator.js';
import { NativeCaptureTransport } from './native-transport.js';

export { CaptureCoordinator } from './coordinator.js';
export type { CaptureTransport, CoordinatorOptions } from './coordinator.js';
export { resolveCaptureBinary } from './capture-binary.js';

/**
 * Ask macOS before asking the renderer.
 *
 * `getUserMedia` would fail with `NotAllowedError` anyway, but only after
 * Chromium has opened a device path — and a denied grant is the one case where
 * `pipeline.rs:200-209`'s warning bites: "macOS may return silence instead of an
 * error", which is indistinguishable from a user who has not started talking.
 * Catching it here turns a ten-second wait for the no-speech watchdog into an
 * immediate instruction.
 *
 * `not-determined` deliberately falls through: the TCC prompt is raised by the
 * renderer's first `getUserMedia`, at the moment the user has actually asked to
 * dictate, rather than by a dialog at launch. The native capture binary does
 * not prompt either — the Electron app identity owns Microphone.
 */
export function microphonePermissionError(): AppError | null {
  let status: string;
  try {
    status = systemPreferences.getMediaAccessStatus('microphone');
  } catch {
    return null; // Not a macOS build; let the renderer decide.
  }
  if (status !== 'denied' && status !== 'restricted') return null;

  return appError(
    'audio_permission',
    status === 'restricted'
      ? 'Microphone access is blocked by a system policy.'
      : 'Grok Dictate is not allowed to use the microphone.',
    'Open System Settings → Privacy & Security → Microphone and switch Grok Dictate on, then try again.',
  );
}

export interface AudioSource extends AudioSourcePort {
  /** True when `contents` is the capture renderer — nothing else may drive it. */
  ownsSender(contents: WebContents): boolean;
  /** Returns true when the message belonged to capture and was consumed. */
  handleRendererMessage(message: RendererToMain): boolean;
}

export function createAudioSource(
  logger: Logger,
  options?: { micProcessing?: () => boolean },
): AudioSource {
  const lookup = resolveCaptureBinary(currentCaptureLookupEnvironment());
  const log = logger.child('audio');

  if (lookup.found) {
    try {
      accessSync(lookup.path, constants.X_OK);
      log.info('using native capture; Chromium capture window will not be created', {
        path: lookup.path,
        resolvedFrom: lookup.source,
      });
      return createNativeAudioSource(logger, lookup.path, options);
    } catch {
      log.error('the native capture binary is not executable; falling back to Chromium', {
        path: lookup.path,
        hint: 'Run `chmod +x native/build/grok-dictate-capture`, or rebuild with `./native/build.sh`.',
      });
    }
  }

  log.info('native capture binary missing; falling back to Chromium capture window', {
    expectedAt: lookup.path,
    resolvedFrom: lookup.source,
    hint: 'Build it with `./native/build.sh` to capture without Chromium.',
  });
  return createChromiumAudioSource(logger, options);
}

function createNativeAudioSource(
  logger: Logger,
  command: string,
  options?: { micProcessing?: () => boolean },
): AudioSource {
  const transport = new NativeCaptureTransport({ command, logger });
  const coordinator = new CaptureCoordinator({
    transport,
    logger,
    checkPermission: microphonePermissionError,
    micProcessing: options?.micProcessing ?? (() => false),
  });
  transport.attach((message) => {
    coordinator.handleRendererMessage(message);
  });
  transport.start();

  app.on('before-quit', () => {
    coordinator.dispose();
    void transport.stop();
  });

  return Object.assign(coordinator, {
    ownsSender: (_contents: WebContents) => false,
  });
}

function createChromiumAudioSource(
  logger: Logger,
  options?: { micProcessing?: () => boolean },
): AudioSource {
  const window = new CaptureWindow(logger);
  const coordinator = new CaptureCoordinator({
    transport: window,
    logger,
    checkPermission: microphonePermissionError,
    micProcessing: options?.micProcessing ?? (() => false),
  });

  // Created eagerly at startup — not lazily on the first hold — so the first
  // dictation of the session does not pay for window creation and worklet
  // compilation. The microphone is still opened only when recording starts:
  // an existing window holds no device. Native capture prepares its graph
  // the same way (see CaptureEngine.prepareIdle). This path is the fallback;
  // the native adapter never constructs this window.
  void app.whenReady().then(async () => {
    try {
      await window.create();
    } catch (cause) {
      logger.child('audio').error('could not create the capture window', { err: cause });
    }
  });

  app.on('before-quit', () => {
    coordinator.dispose();
    window.destroy();
  });

  // `CaptureCoordinator` already implements `handleRendererMessage`; only the
  // sender check needs the window, which the coordinator deliberately does not
  // know about.
  return Object.assign(coordinator, {
    ownsSender: (contents: WebContents) => window.owns(contents),
  });
}
