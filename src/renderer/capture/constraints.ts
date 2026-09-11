/**
 * Chromium `getUserMedia` constraints for one capture session.
 *
 * The three DSP flags — echo cancellation, noise suppression, auto-gain — are
 * Chromium's telephony processing, not a recogniser's. The Grok CLI captures
 * raw, and this app mutes output while recording, so there is usually nothing
 * to cancel. Off by default (`micProcessing: false`); a setting turns them
 * back on together because they change what the recogniser hears.
 *
 * Applied values still travel on `capture-started` (`CaptureTrackSettings`)
 * so a transcript can be compared against what the device actually did.
 */
export function audioConstraints(micProcessing: boolean): MediaTrackConstraints {
  return {
    channelCount: { ideal: 1 },
    echoCancellation: micProcessing,
    noiseSuppression: micProcessing,
    autoGainControl: micProcessing,
  };
}
