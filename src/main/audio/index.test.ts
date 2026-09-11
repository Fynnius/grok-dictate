import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from '@shared/logger.js';
import type { WebContents } from 'electron';

const { resolveCaptureBinary, nativeCommands, captureWindows, whenReady, accessSync } = vi.hoisted(
  () => ({
    resolveCaptureBinary: vi.fn(),
    nativeCommands: [] as string[],
    captureWindows: [] as unknown[],
    whenReady: vi.fn(() => new Promise<void>(() => undefined)),
    accessSync: vi.fn(),
  }),
);

vi.mock('node:fs', () => ({
  accessSync,
  constants: { X_OK: 1 },
}));

vi.mock('electron', () => ({
  app: {
    whenReady,
    on: vi.fn(),
  },
  systemPreferences: {
    getMediaAccessStatus: (): string => 'granted',
  },
}));

vi.mock('./capture-binary.js', () => ({
  resolveCaptureBinary,
  currentCaptureLookupEnvironment: () => ({}),
  CAPTURE_BINARY_NAME: 'grok-dictate-capture',
  CAPTURE_DEV_PATH: 'native/build/grok-dictate-capture',
}));

vi.mock('./native-transport.js', () => ({
  NativeCaptureTransport: class {
    constructor(options: { command: string }) {
      nativeCommands.push(options.command);
    }
    attach(): void {}
    start(): void {}
    stop(): Promise<void> {
      return Promise.resolve();
    }
    send(): void {}
  },
}));

vi.mock('./capture-window.js', () => ({
  CaptureWindow: class {
    constructor() {
      captureWindows.push(this);
    }
    create(): Promise<void> {
      return Promise.resolve();
    }
    destroy(): void {}
    owns(): boolean {
      return false;
    }
    send(): void {}
  },
}));

import { createAudioSource } from './index.js';

describe('createAudioSource adapter selection', () => {
  beforeEach(() => {
    nativeCommands.length = 0;
    captureWindows.length = 0;
    whenReady.mockClear();
    resolveCaptureBinary.mockReset();
    accessSync.mockReset();
    accessSync.mockImplementation(() => undefined);
  });

  it('uses the Chromium capture window when the binary is missing', () => {
    resolveCaptureBinary.mockReturnValue({
      path: '/nope/grok-dictate-capture',
      source: 'development',
      found: false,
    });

    const audio = createAudioSource(createLogger('test'));
    expect(captureWindows).toHaveLength(1);
    expect(nativeCommands).toHaveLength(0);
    expect(whenReady).toHaveBeenCalled();
    expect(audio.ownsSender({} as WebContents)).toBe(false);
  });

  it('falls back to Chromium when the native binary exists but is not executable', () => {
    resolveCaptureBinary.mockReturnValue({
      path: '/built/grok-dictate-capture',
      source: 'development',
      found: true,
    });
    accessSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    createAudioSource(createLogger('test'));
    expect(nativeCommands).toHaveLength(0);
    expect(captureWindows).toHaveLength(1);
  });

  it('uses native capture and does not create the Chromium window when the binary is present', () => {
    resolveCaptureBinary.mockReturnValue({
      path: '/built/grok-dictate-capture',
      source: 'development',
      found: true,
    });

    const audio = createAudioSource(createLogger('test'));
    expect(nativeCommands).toEqual(['/built/grok-dictate-capture']);
    expect(captureWindows).toHaveLength(0);
    expect(whenReady).not.toHaveBeenCalled();
    expect(audio.ownsSender({} as WebContents)).toBe(false);
  });

  it('passes micProcessing through to the coordinator on either path', () => {
    resolveCaptureBinary.mockReturnValue({
      path: '/nope',
      source: 'development',
      found: false,
    });
    const audio = createAudioSource(createLogger('test'), { micProcessing: () => true });
    audio.start('s1', {
      onChunk: () => undefined,
      onLevel: () => undefined,
      onError: () => undefined,
      onDrained: () => undefined,
      onStarted: () => undefined,
    });
    expect(captureWindows).toHaveLength(1);
  });
});
