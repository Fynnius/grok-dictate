/**
 * Drives the *shipped* worklet source, not a copy of the fill algorithm.
 *
 * A reused AudioWorkletNode keeps `_fill` across dictations. Empty input
 * after disconnect does not reset it. These tests instantiate the processor
 * string that `pcmWorkletUrl` blobs into the audio thread.
 */

import { describe, expect, it } from 'vitest';
import {
  PCM_WORKLET_NAME,
  PCM_WORKLET_SOURCE,
  WORKLET_RESET,
  resetWorkletPort,
} from './pcm-worklet.js';

interface ProcessorPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  posted: Float32Array[];
  postMessage: (data: ArrayBuffer) => void;
}

interface ProcessorInstance {
  port: ProcessorPort;
  process: (inputs: Float32Array[][]) => boolean;
}

function loadShippedProcessor(): new (options: unknown) => ProcessorInstance {
  let Ctor: (new (options: unknown) => ProcessorInstance) | undefined;
  class FakeAudioWorkletProcessor {
    port: ProcessorPort;
    constructor() {
      const port: ProcessorPort = {
        onmessage: null,
        posted: [],
        postMessage(data: ArrayBuffer) {
          port.posted.push(new Float32Array(data.slice(0)));
        },
      };
      this.port = port;
    }
  }
  // The processor cannot be imported (it runs in the worklet scope). `Function`
  // is the only way to instantiate the same string `pcmWorkletUrl` blobs.
  // eslint-disable-next-line @typescript-eslint/no-implied-eval -- driving the shipped source string, not eval of user input
  const run = new Function('AudioWorkletProcessor', 'registerProcessor', PCM_WORKLET_SOURCE) as (
    AudioWorkletProcessor: new () => { port: ProcessorPort },
    registerProcessor: (name: string, ctor: new (options: unknown) => ProcessorInstance) => void,
  ) => void;
  run(FakeAudioWorkletProcessor, (_name, ctor) => {
    Ctor = ctor;
  });
  if (Ctor === undefined)
    throw new Error('the shipped worklet source did not register a processor');
  return Ctor;
}

function process(proc: ProcessorInstance, frames: number[]): void {
  proc.process([[new Float32Array(frames)]]);
}

describe('the shipped worklet source', () => {
  it('is what pcmWorkletUrl blobs — not a parallel copy', () => {
    expect(PCM_WORKLET_SOURCE).toContain(`registerProcessor("${PCM_WORKLET_NAME}"`);
    expect(PCM_WORKLET_SOURCE).toContain("data.type === 'reset'");
  });

  it('does not reset leftover frames on empty input (the mix bug, if unfixed)', () => {
    const Ctor = loadShippedProcessor();
    const proc = new Ctor({ processorOptions: { framesPerPost: 4 } });
    process(proc, [1, 1, 1]);
    expect(proc.port.posted).toHaveLength(0);
    proc.process([[]]);
    process(proc, [0.25]);
    expect(proc.port.posted).toHaveLength(1);
    expect([...proc.port.posted[0]!]).toEqual([1, 1, 1, 0.25]);
  });

  it('discards leftover frames on reset so session N+1 is not prepended with session N', () => {
    const Ctor = loadShippedProcessor();
    const proc = new Ctor({ processorOptions: { framesPerPost: 4 } });
    process(proc, [1, 1, 1]);
    expect(proc.port.posted).toHaveLength(0);

    const handler = proc.port.onmessage;
    expect(handler).toBeTypeOf('function');
    handler?.({ data: WORKLET_RESET });

    process(proc, [0.25, 0.25, 0.25, 0.25]);
    expect(proc.port.posted).toHaveLength(1);
    expect([...proc.port.posted[0]!]).toEqual([0.25, 0.25, 0.25, 0.25]);
  });
});

describe('resetWorkletPort', () => {
  it('posts the reset message the processor listens for', () => {
    const sent: unknown[] = [];
    resetWorkletPort({ postMessage: (message) => sent.push(message) });
    expect(sent).toEqual([WORKLET_RESET]);
  });
});
