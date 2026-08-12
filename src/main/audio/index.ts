/**
 * OWNER: **Phase 3**. The microphone seam.
 *
 * `src/main/index.ts` calls `createAudioSource(logger)`; everything below it —
 * the hidden capture window, the IPC routing, the full-utterance buffer — is
 * assembled here so the composition root never learns that capture involves a
 * renderer at all.
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
 * before handing anything over.
 */

import { app, systemPreferences, type WebContents } from 'electron';
import type { RendererToMain } from '@contracts/events.js';
import type { AudioSourcePort } from '@contracts/ports.js';
import type { Logger } from '@shared/logger.js';
import { appError, type AppError } from '@shared/result.js';
import { CaptureWindow } from './capture-window.js';
import { CaptureCoordinator } from './coordinator.js';

export { CaptureCoordinator } from './coordinator.js';
export type { CaptureTransport, CoordinatorOptions } from './coordinator.js';

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
 * dictate, rather than by a dialog at launch.
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

export function createAudioSource(logger: Logger): AudioSource {
  const window = new CaptureWindow(logger);
  const coordinator = new CaptureCoordinator({
    transport: window,
    logger,
    checkPermission: microphonePermissionError,
  });

  // Created eagerly at startup — not lazily on the first hold — so the first
  // dictation of the session does not pay for window creation and worklet
  // compilation. The microphone is still opened only when recording starts
  //: an existing window holds no device.
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
