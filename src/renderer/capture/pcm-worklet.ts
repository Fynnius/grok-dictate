/**
 * The `AudioWorkletProcessor` that pulls microphone frames off the audio thread.
 *
 * ## Why the source is a string
 *
 * `audioWorklet.addModule()` takes a URL, and the module runs in a separate
 * global scope with no bundler and no imports. The three ways to give it one:
 *
 *   1. a second renderer entry in `electron.vite.config.ts` — that file belongs
 *      to Phase 1 and Phase 3 may not touch it (IMPLEMENTATION-PLAN.md §2);
 *   2. `new URL('./worklet.js', import.meta.url)` — works, but puts a plain
 *      `.js` file in `src/renderer/` that neither tsconfig nor ESLint can make
 *      sense of (`AudioWorkletProcessor` is not a global they know);
 *   3. a `blob:` URL built at runtime — self-contained, identical in dev and in
 *      a packaged build, no build configuration at all.
 *
 * (3) it is. The cost is that this string is not typechecked, which is why it
 * does as little as possible: buffer frames, post them, nothing else. Every
 * decision that could be wrong — sample conversion, resampling, chunk
 * boundaries — lives in `pcm.ts`, where it is a unit test.
 *
 * ## What it does
 *
 * Accumulates `framesPerPost` mono frames and transfers them to the renderer as
 * one `Float32Array`. Posting each 128-frame quantum instead would be 125
 * messages a second across the thread boundary for no benefit; at 16 kHz,
 * `framesPerPost = 1600` makes that ten.
 */

export const PCM_WORKLET_NAME = 'grok-pcm-capture';

/**
 * Posted at the processor on stop (and again at the next start) so a reused
 * `AudioWorkletNode` cannot prepend session N's leftover `_fill` onto
 * session N+1. Empty `process()` after `source.disconnect()` does **not**
 * reset — that is the bug this message exists to close.
 */
export const WORKLET_RESET = { type: 'reset' } as const;

/**
 * The processor body. Exported so tests can instantiate the *shipped* source
 * against a fake `AudioWorkletProcessor` — a copy of this algorithm in the
 * test would pass while the worklet still mixed sessions.
 */
export const PCM_WORKLET_SOURCE = `
class GrokPcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const size = (options && options.processorOptions && options.processorOptions.framesPerPost) || 1600;
    this._size = size;
    this._buffer = new Float32Array(size);
    this._fill = 0;
    var self = this;
    this.port.onmessage = function (event) {
      var data = event && event.data;
      if (data && data.type === 'reset') {
        self._fill = 0;
        self._buffer = new Float32Array(self._size);
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    // An empty input is normal: the device is still warming up, or the source
    // was disconnected. Returning true keeps the processor alive for the next
    // quantum rather than tearing the graph down. It deliberately does **not**
    // reset _fill: that leftover is what a reused node would prepend to the
    // next session unless a reset message arrives.
    if (!input || input.length === 0) return true;
    const channel = input[0];
    if (!channel || channel.length === 0) return true;

    let offset = 0;
    while (offset < channel.length) {
      const take = Math.min(channel.length - offset, this._size - this._fill);
      this._buffer.set(channel.subarray(offset, offset + take), this._fill);
      this._fill += take;
      offset += take;
      if (this._fill === this._size) {
        const out = this._buffer;
        this._buffer = new Float32Array(this._size);
        this._fill = 0;
        this.port.postMessage(out.buffer, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor(${JSON.stringify(PCM_WORKLET_NAME)}, GrokPcmCapture);
`;

/** Main-thread half of the reset: the capture renderer posts this at stop
 *  and again at the next start. Extracted so a test can drive the same call. */
export function resetWorkletPort(port: {
  postMessage: (message: { readonly type: 'reset' }) => void;
}): void {
  port.postMessage(WORKLET_RESET);
}

let cachedUrl: string | null = null;

/** A `blob:` URL for the processor above. Built once per renderer. */
export function pcmWorkletUrl(): string {
  cachedUrl ??= URL.createObjectURL(new Blob([PCM_WORKLET_SOURCE], { type: 'text/javascript' }));
  return cachedUrl;
}
