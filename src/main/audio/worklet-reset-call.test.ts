/**
 * The worklet reset only helps if the capture renderer posts it. That call
 * lives in `src/renderer/capture/main.ts`, which this test cannot instantiate
 * (no window, no getUserMedia). The assertion is that the shipped file
 * actually posts the reset at stop and at the next start.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('capture renderer posts the worklet reset', () => {
  it('calls resetWorkletPort on stop and on the next start', () => {
    const main = readFileSync(resolve('src/renderer/capture/main.ts'), 'utf8');
    const calls = main.match(/resetWorkletPort\(/g);
    expect(calls?.length).toBeGreaterThanOrEqual(2);
    expect(main).toMatch(/function stopCapture[\s\S]*resetWorkletPort\(/);
  });
});
