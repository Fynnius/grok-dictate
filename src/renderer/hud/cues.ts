/**
 * OWNER: **Phase 4**. The audio cues, played in the HUD renderer.
 *
 * `src/main/sound/` drives this through `executeJavaScript`; the header there
 * explains why the HUD's renderer is the right place for it. In short: it is
 * the one renderer that exists for the whole life of the app, and its
 * `backgroundThrottling: false` is set precisely so this keeps working while
 * the pill is hidden.
 *
 * The `AudioContext` is built at module load rather than on the first cue.
 * Creating one costs a few milliseconds of CoreAudio setup, and the whole
 * cue has an ~80 ms budget — paying that on the first
 * dictation of every launch would blow it exactly once per session, which is
 * the worst possible distribution.
 */

export interface CueSpec {
  readonly fromHz: number;
  readonly toHz: number;
  readonly durationMs: number;
  readonly gain: number;
  readonly wave: 'sine' | 'triangle';
}

declare global {
  interface Window {
    __grokDictateCues?: { play(spec: CueSpec): void };
  }
}

let context: AudioContext | null = null;

function audioContext(): AudioContext | null {
  if (context === null) {
    try {
      context = new AudioContext();
    } catch {
      // No audio device at all. Cues are feedback, never correctness — the app
      // keeps dictating in silence.
      return null;
    }
  }
  // Electron runs with `autoplayPolicy: no-user-gesture-required`, so the
  // context normally starts running; resuming covers the case where the OS
  // suspended it (device change, sleep/wake).
  if (context.state === 'suspended') void context.resume();
  return context;
}

function play(spec: CueSpec): void {
  const ctx = audioContext();
  if (ctx === null) return;

  const now = ctx.currentTime;
  const seconds = spec.durationMs / 1000;

  const oscillator = ctx.createOscillator();
  oscillator.type = spec.wave;
  oscillator.frequency.setValueAtTime(spec.fromHz, now);
  oscillator.frequency.linearRampToValueAtTime(spec.toHz, now + seconds);

  // A raw square edge on a bare oscillator clicks audibly. A short attack and a
  // decay to (near) zero is what makes a 55 ms tone read as a blip rather than
  // a pop — `exponentialRampToValueAtTime` cannot reach 0, hence the epsilon.
  const envelope = ctx.createGain();
  envelope.gain.setValueAtTime(0.0001, now);
  envelope.gain.exponentialRampToValueAtTime(spec.gain, now + Math.min(0.008, seconds / 4));
  envelope.gain.exponentialRampToValueAtTime(0.0001, now + seconds);

  oscillator.connect(envelope).connect(ctx.destination);
  oscillator.start(now);
  oscillator.stop(now + seconds);
  oscillator.onended = () => {
    // Each cue gets fresh nodes (an OscillatorNode is single-use); disconnect so
    // they are collectable rather than accumulating over a day of dictation.
    oscillator.disconnect();
    envelope.disconnect();
  };
}

export function installCuePlayer(): void {
  window.__grokDictateCues = { play };
  // Warm the device now, at load, not on the first dictation.
  audioContext();
}
