/**
 * The native capture engine is Swift and needs a microphone, so this file
 * cannot instantiate it. The assertion is that the shipped source actually
 * keeps the prepare/start split: `pause()` on session stop (so `prepare()`
 * survives), `stop()` only on process exit, and an idle `prepareIdle`.
 *
 * Same shape as `worklet-reset-call.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const enginePath = resolve('native/Sources/grok-dictate-capture/Engine.swift');
const appPath = resolve('native/Sources/grok-dictate-capture/CaptureApp.swift');

describe('native capture keeps the graph warm across holds', () => {
  it('pauses on session stop and only stop()s on dispose', () => {
    const src = readFileSync(enginePath, 'utf8');
    expect(src).toMatch(/func prepareIdle\(/);
    expect(src).toMatch(/func dispose\(/);
    expect(src).toMatch(/private func releaseSession[\s\S]*?engine\.pause\(\)/);

    const disposeFn = src.split('func dispose(')[1]?.split('private func releaseSession')[0] ?? '';
    expect(disposeFn).toMatch(/engine\.stop\(\)/);
    expect(disposeFn).not.toMatch(/engine\.pause\(\)/);
  });

  it('prepares the graph once the run loop is up, not at process init', () => {
    const app = readFileSync(appPath, 'utf8');
    expect(app).toMatch(/engine\.prepareIdle\(sampleRate:/);
    const init = app.split('init(dryRun:')[1]?.split('func startReadingStdin')[0] ?? '';
    expect(init).not.toMatch(/prepareIdle/);
    const stdin = app.split('func startReadingStdin')[1] ?? '';
    expect(stdin).toMatch(/prepareIdle/);
  });

  it('creates the input node before calling prepare()', () => {
    const src = readFileSync(enginePath, 'utf8');
    const rebuild = src.split('private func finishRebuild')[1] ?? '';
    const prepareAt = rebuild.indexOf('engine.prepare()');
    const nodeAt = rebuild.indexOf('engine.inputNode');
    expect(nodeAt).toBeGreaterThanOrEqual(0);
    expect(prepareAt).toBeGreaterThan(nodeAt);
    expect(src).toMatch(/GDCatchException/);
  });
});
