/**
 * OWNER: **Phase 2**.
 *
 * The composition root calls `createNativeHelper()` and receives a
 * `NativeHelperPort`. It does not know, and must never learn, which process is
 * on the other end — that is why Phase 2 lands without editing
 * `src/main/index.ts` (IMPLEMENTATION-PLAN.md §2).
 *
 * Phase 1's report §5.4 asked for exactly one change here: point
 * `helperSpawnSpec()` at the binary from `native/build.sh` and drop the
 * `ELECTRON_RUN_AS_NODE` variable. That is what this is, plus a lookup that
 * covers the packaged case and an up-front existence check — see
 * `createNativeHelper` for why the check is not optional.
 */

import { accessSync, constants, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { NativeHelperPort } from '@contracts/ports.js';
import { envString } from '@shared/env.js';
import type { Logger } from '@shared/logger.js';
import { HelperSupervisor, type HelperSpawnSpec } from '../bridge/helper-supervisor.js';
import { HelperClient } from './helper-client.js';

export const HELPER_BINARY_NAME = 'grok-dictate-helper';

/** Where `native/build.sh` leaves the binary, relative to the repository root. */
export const HELPER_DEV_PATH = join('native', 'build', HELPER_BINARY_NAME);

export interface HelperLookupEnvironment {
  /** Explicit override — an absolute path to a helper binary. */
  readonly override?: string | undefined;
  /** `process.resourcesPath`; only set inside Electron. */
  readonly resourcesPath?: string | undefined;
  /** Injected so the lookup is testable without touching the filesystem. */
  readonly exists?: (path: string) => boolean;
}

export interface HelperLookup {
  readonly path: string;
  readonly source: 'override' | 'bundle' | 'development';
  readonly found: boolean;
}

/**
 * Resolve the helper binary.
 *
 * Order matters: the override wins so a developer can point at a debug build
 * without rebuilding the app, then the packaged copy, then the development
 * build tree. The packaged path is checked for existence rather than assumed
 * because `process.resourcesPath` is set in development too — it points into
 * the Electron framework, where our binary is not.
 */
export function resolveHelperBinary(environment: HelperLookupEnvironment = {}): HelperLookup {
  const exists = environment.exists ?? existsSync;

  const override = environment.override?.trim();
  if (override !== undefined && override.length > 0) {
    return { path: override, source: 'override', found: exists(override) };
  }

  const { resourcesPath } = environment;
  if (resourcesPath !== undefined && resourcesPath.length > 0) {
    const bundled = join(resourcesPath, HELPER_BINARY_NAME);
    if (exists(bundled)) return { path: bundled, source: 'bundle', found: true };
  }

  const development = resolve(HELPER_DEV_PATH);
  return { path: development, source: 'development', found: exists(development) };
}

export function helperSpawnSpec(): HelperSpawnSpec {
  return { command: resolveHelperBinary(currentLookupEnvironment()).path, args: [] };
}

function currentLookupEnvironment(): HelperLookupEnvironment {
  return {
    // Through `envString` because `src/shared/env.ts` is the only sanctioned
    // reader of `process.env` (eslint.config.js enforces it): the environment
    // is a common accidental route for a token into a log.
    override: envString('GROK_DICTATE_HELPER'),
    // `resourcesPath` is an Electron addition to `process`; it is absent when
    // this module is loaded by the test runner under plain Node.
    resourcesPath: (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  };
}

export interface NativeHelperHandle {
  readonly port: NativeHelperPort;
  readonly supervisor: HelperSupervisor;
}

export function createNativeHelper(logger: Logger): NativeHelperHandle {
  const lookup = resolveHelperBinary(currentLookupEnvironment());
  const log = logger.child('native');

  // The supervisor restarts the helper when it *exits*, but a missing binary
  // never produces an exit — Node reports `ENOENT` through the `error` event
  // and the process never starts. Without this check the failure is a single
  // line in the log and then permanent silence, which is precisely the shape of
  // failure  says will make a working app look broken. So say it
  // once, loudly, with the command that fixes it.
  if (!lookup.found) {
    log.error('the native helper binary is missing — the Fn hotkey and text insertion are dead', {
      expectedAt: lookup.path,
      resolvedFrom: lookup.source,
      hint: 'Build it with `./native/build.sh`, then restart the app.',
    });
  } else {
    try {
      accessSync(lookup.path, constants.X_OK);
    } catch {
      log.error('the native helper binary is not executable', {
        path: lookup.path,
        hint: 'Run `chmod +x native/build/grok-dictate-helper`, or rebuild with `./native/build.sh`.',
      });
    }
  }

  const supervisor = new HelperSupervisor({ spec: helperSpawnSpec(), logger });
  const port = new HelperClient(supervisor, logger);
  supervisor.start();
  return { port, supervisor };
}
