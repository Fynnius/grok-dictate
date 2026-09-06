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
 *
 * One cue at a time. A dead microphone fires `stop` (key up) and `error`
 * (empty turn) a few milliseconds apart; playing both is the horrible chord
 * the user reported. A new `play` ducks whatever is still ringing.
 */

export interface CueSpec {
  readonly durationMs: number;
  readonly gain: number;
  readonly fromHz: number;
  readonly toHz: number;
  readonly attackMs: number;
  readonly harmonic: number;
}

interface Voice {
  readonly master: GainNode;
  readonly oscillators: OscillatorNode[];
}

declare global {
  interface Window {
    __grokDictateCues?: { play(spec: CueSpec): void };
  }
}

let context: AudioContext | null = null;
let voice: Voice | null = null;

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

function duck(ctx: AudioContext): void {
  const current = voice;
  if (current === null) return;
  voice = null;
  const now = ctx.currentTime;
  current.master.gain.cancelScheduledValues(now);
  current.master.gain.setTargetAtTime(0.0001, now, 0.006);
  for (const oscillator of current.oscillators) {
    try {
      oscillator.stop(now + 0.02);
    } catch {
      // Already stopped.
    }
  }
}

function play(spec: CueSpec): void {
  const ctx = audioContext();
  if (ctx === null) return;

  duck(ctx);

  const now = ctx.currentTime;
  const seconds = spec.durationMs / 1000;
  const attack = Math.min(spec.attackMs / 1000, seconds * 0.45);

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.linearRampToValueAtTime(spec.gain, now + attack);
  master.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  master.connect(ctx.destination);

  // Nothing above a couple of kHz belongs in these cues; the old glass
  // sparkle lived at 5 kHz and is what made them feel hard.
  const lowpass = ctx.createBiquadFilter();
  lowpass.type = 'lowpass';
  lowpass.frequency.setValueAtTime(2400, now);
  lowpass.Q.setValueAtTime(0.5, now);
  lowpass.connect(master);

  const oscillators: OscillatorNode[] = [];
  const parts: { hzFrom: number; hzTo: number; mix: number }[] = [
    { hzFrom: spec.fromHz, hzTo: spec.toHz, mix: 1 },
  ];
  if (spec.harmonic > 0) {
    parts.push({
      hzFrom: spec.fromHz * 2,
      hzTo: spec.toHz * 2,
      mix: spec.harmonic,
    });
  }

  for (const part of parts) {
    const oscillator = ctx.createOscillator();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(part.hzFrom, now);
    if (part.hzFrom !== part.hzTo) {
      oscillator.frequency.exponentialRampToValueAtTime(part.hzTo, now + seconds);
    }
    const mix = ctx.createGain();
    mix.gain.setValueAtTime(part.mix, now);
    oscillator.connect(mix);
    mix.connect(lowpass);
    oscillator.start(now);
    oscillator.stop(now + seconds);
    oscillators.push(oscillator);
  }

  voice = { master, oscillators };
  const played = voice;
  window.setTimeout(() => {
    if (voice === played) voice = null;
    try {
      master.disconnect();
      lowpass.disconnect();
    } catch {
      // Already disconnected by a later cue.
    }
  }, spec.durationMs + 40);
}

export function installCuePlayer(): void {
  window.__grokDictateCues = { play };
  // Warm the device now, at load, not on the first dictation.
  audioContext();
}
