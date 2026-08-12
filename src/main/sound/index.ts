/**
 * OWNER: **Phase 4**. Start / stop / error cues.
 *
 * ## Where the sound actually comes from
 *
 * Cues are played by **the HUD renderer's** Web Audio context, driven from here
 * by `executeJavaScript`. Three alternatives were rejected:
 *
 *   - `shell.beep()` — one sound, no way to distinguish start from stop, and it
 *     is the system alert, which is wrong for a routine event.
 *   - spawning `afplay` per cue — a process spawn plus CoreAudio start-up blows
 *     the ~80 ms budget §11.1.4 sets, and it would need audio files, which
 *     would need an asset pipeline in the frozen `electron.vite.config.ts`.
 *   - a dedicated hidden window — correct, but a second renderer process (tens
 *     of megabytes) for two oscillator ramps.
 *
 * The HUD window already exists for the whole life of the app, already has a
 * renderer process, and carries `backgroundThrottling: false` precisely so this
 * stays responsive while it is hidden (see `src/main/hud/flags.ts`).
 *
 * If the HUD is not up yet, `error` falls back to `shell.beep()` — the one cue
 * where being heard matters more than being right. `start` and `stop` stay
 * silent rather than firing the system alert on every dictation.
 */

import { shell, type BrowserWindow } from 'electron';
import type { AudioCue, SoundPort } from '@contracts/ports.js';
import type { Logger } from '@shared/logger.js';
import { cueSpec } from './cues.js';

/** The renderer-side entry point, defined in `src/renderer/hud/cues.ts`. */
const RENDERER_GLOBAL = '__grokDictateCues';

export function cueScript(cue: AudioCue): string {
  // The spec travels as JSON so the tone table has exactly one home.
  return `void window.${RENDERER_GLOBAL}?.play(${JSON.stringify(cueSpec(cue))});`;
}

/** Resolves the HUD's renderer, or `null` before it exists. */
export type CueHost = () => BrowserWindow | null;

export function createSound(logger: Logger, host: CueHost): SoundPort {
  const log = logger.child('sound');
  let warnedUnavailable = false;

  return {
    play(cue: AudioCue): void {
      const window = host();
      if (window === null) {
        if (cue === 'error') shell.beep();
        else if (!warnedUnavailable) {
          warnedUnavailable = true;
          log.warn('no HUD renderer yet, so start/stop cues are silent for now');
        }
        return;
      }

      // Fire and forget: nothing in the dictation path may wait on a sound.
      window.webContents.executeJavaScript(cueScript(cue), true).catch((cause: unknown) => {
        log.debug('could not play a cue', { cue, err: cause });
        if (cue === 'error') shell.beep();
      });
    },
  };
}
