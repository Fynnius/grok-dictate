/**
 * Where the native capture binary lives.
 *
 * Mirrors `resolveHelperBinary` in `src/main/native/index.ts`. The capture
 * process is a *different* executable from the helper — the helper stays
 * hotkey + insertion, with no microphone — so the lookup is a sibling, not a
 * reuse of the helper path.
 */

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { envString } from '@shared/env.js';

export const CAPTURE_BINARY_NAME = 'grok-dictate-capture';

/** Where `native/build.sh` leaves the binary, relative to the repository root. */
export const CAPTURE_DEV_PATH = join('native', 'build', CAPTURE_BINARY_NAME);

export interface CaptureLookupEnvironment {
  /** Explicit override — an absolute path to a capture binary. */
  readonly override?: string | undefined;
  /** `process.resourcesPath`; only set inside Electron. */
  readonly resourcesPath?: string | undefined;
  /** Injected so the lookup is testable without touching the filesystem. */
  readonly exists?: (path: string) => boolean;
}

export interface CaptureLookup {
  readonly path: string;
  readonly source: 'override' | 'bundle' | 'development';
  readonly found: boolean;
}

/**
 * Resolve the capture binary.
 *
 * Order matters: the override wins so a developer can point at a debug build
 * without rebuilding the app, then the packaged copy, then the development
 * build tree. The packaged path is checked for existence rather than assumed
 * because `process.resourcesPath` is set in development too — it points into
 * the Electron framework, where our binary is not.
 */
export function resolveCaptureBinary(environment: CaptureLookupEnvironment = {}): CaptureLookup {
  const exists = environment.exists ?? existsSync;

  const override = environment.override?.trim();
  if (override !== undefined && override.length > 0) {
    return { path: override, source: 'override', found: exists(override) };
  }

  const { resourcesPath } = environment;
  if (resourcesPath !== undefined && resourcesPath.length > 0) {
    const bundled = join(resourcesPath, CAPTURE_BINARY_NAME);
    if (exists(bundled)) return { path: bundled, source: 'bundle', found: true };
  }

  const development = resolve(CAPTURE_DEV_PATH);
  return { path: development, source: 'development', found: exists(development) };
}

export function currentCaptureLookupEnvironment(): CaptureLookupEnvironment {
  return {
    override: envString('GROK_DICTATE_CAPTURE'),
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  };
}
