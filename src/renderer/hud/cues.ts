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
 * Each tap is a filtered-noise strike plus a few inharmonic sines (glass bar
 * ratios). That is what stops these reading as a 55 ms oscillator beep.
 */

export interface CueNote {
  readonly hz: number;
  readonly atMs: number;
  readonly brightness: number;
}

export interface CueSpec {
  readonly durationMs: number;
  readonly gain: number;
  readonly material: 'glass' | 'muted';
  readonly notes: readonly CueNote[];
}

interface PartialSpec {
  readonly ratio: number;
  readonly gain: number;
  readonly decayMs: number;
  readonly detuneCents: number;
}

/** Inharmonic bar / glass partials. High ones die fast; they are the sparkle. */
const GLASS_PARTIALS: readonly PartialSpec[] = [
  { ratio: 1, gain: 1, decayMs: 18, detuneCents: 0 },
  { ratio: 2.76, gain: 0.26, decayMs: 11, detuneCents: 5 },
  { ratio: 5.4, gain: 0.07, decayMs: 7, detuneCents: -7 },
];

const MUTED_PARTIALS: readonly PartialSpec[] = [
  { ratio: 1, gain: 1, decayMs: 38, detuneCents: 0 },
  { ratio: 2.03, gain: 0.16, decayMs: 18, detuneCents: -10 },
];

declare global {
  interface Window {
    __grokDictateCues?: { play(spec: CueSpec): void };
  }
}

let context: AudioContext | null = null;
let noiseBuffer: AudioBuffer | null = null;

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

function noiseSample(ctx: AudioContext): AudioBuffer {
  if (noiseBuffer !== null && noiseBuffer.sampleRate === ctx.sampleRate) return noiseBuffer;
  const length = Math.max(1, Math.floor(ctx.sampleRate * 0.05));
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buffer;
  return buffer;
}

function play(spec: CueSpec): void {
  const ctx = audioContext();
  if (ctx === null) return;
  if (spec.notes.length === 0) return;

  const now = ctx.currentTime;
  const seconds = spec.durationMs / 1000;
  const nodes: AudioNode[] = [];
  const glass = spec.material === 'glass';
  const partials = glass ? GLASS_PARTIALS : MUTED_PARTIALS;

  const master = ctx.createGain();
  master.gain.setValueAtTime(0.0001, now);
  master.gain.exponentialRampToValueAtTime(spec.gain, now + 0.001);
  master.gain.setValueAtTime(spec.gain, now + Math.max(0.002, seconds - 0.01));
  master.gain.exponentialRampToValueAtTime(0.0001, now + seconds);
  master.connect(ctx.destination);
  nodes.push(master);

  // Keep error from rumbling laptop speakers; glass already lives well above this.
  const hipass = ctx.createBiquadFilter();
  hipass.type = 'highpass';
  hipass.frequency.setValueAtTime(glass ? 180 : 120, now);
  hipass.Q.setValueAtTime(0.7, now);
  hipass.connect(master);
  nodes.push(hipass);

  for (const note of spec.notes) strike(ctx, hipass, spec, note, partials, now, nodes);

  window.setTimeout(() => {
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // Already disconnected; a second cue may have torn the graph down.
      }
    }
  }, spec.durationMs + 50);
}

function strike(
  ctx: AudioContext,
  dest: AudioNode,
  spec: CueSpec,
  note: CueNote,
  partials: readonly PartialSpec[],
  now: number,
  nodes: AudioNode[],
): void {
  const t0 = now + note.atMs / 1000;
  const remain = (spec.durationMs - note.atMs) / 1000;
  if (remain <= 0.004) return;

  const glass = spec.material === 'glass';
  const noiseDur = glass ? 0.0035 : 0.006;
  const noiseFilter = ctx.createBiquadFilter();
  noiseFilter.type = 'bandpass';
  noiseFilter.frequency.setValueAtTime(glass ? 5400 : 1500, t0);
  noiseFilter.Q.setValueAtTime(glass ? 1.35 : 0.65, t0);

  const noiseGain = ctx.createGain();
  const noisePeak = Math.max(0.0002, glass ? 0.16 * note.brightness : 0.24);
  noiseGain.gain.setValueAtTime(0.0001, t0);
  noiseGain.gain.exponentialRampToValueAtTime(noisePeak, t0 + 0.0012);
  noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + noiseDur);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseSample(ctx);
  noise.connect(noiseFilter);
  noiseFilter.connect(noiseGain);
  noiseGain.connect(dest);
  noise.start(t0);
  noise.stop(t0 + noiseDur + 0.002);
  nodes.push(noise, noiseFilter, noiseGain);

  const attack = glass ? 0.0025 : 0.004;
  for (const partial of partials) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    const hz = note.hz * partial.ratio * 2 ** (partial.detuneCents / 1200);
    osc.frequency.setValueAtTime(hz, t0);
    if (!glass) osc.frequency.exponentialRampToValueAtTime(hz * 0.94, t0 + remain);

    const envelope = ctx.createGain();
    const peak = Math.max(0.0002, partial.gain * (partial.ratio === 1 ? 1 : note.brightness));
    const decay = Math.min(partial.decayMs / 1000, remain);
    envelope.gain.setValueAtTime(0.0001, t0);
    envelope.gain.exponentialRampToValueAtTime(peak, t0 + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, t0 + Math.max(attack + 0.006, decay));

    osc.connect(envelope);
    envelope.connect(dest);
    osc.start(t0);
    osc.stop(t0 + remain);
    nodes.push(osc, envelope);
  }
}

export function installCuePlayer(): void {
  window.__grokDictateCues = { play };
  // Warm the device now, at load, not on the first dictation.
  audioContext();
}
