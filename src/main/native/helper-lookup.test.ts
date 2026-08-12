import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HELPER_BINARY_NAME, HELPER_DEV_PATH, resolveHelperBinary } from './index.js';

describe('resolveHelperBinary', () => {
  const nothingExists = (): boolean => false;
  const everythingExists = (): boolean => true;

  it('prefers an explicit override', () => {
    const lookup = resolveHelperBinary({
      override: '/tmp/my-helper',
      resourcesPath: '/Applications/Grok Dictate.app/Contents/Resources',
      exists: everythingExists,
    });
    expect(lookup).toEqual({ path: '/tmp/my-helper', source: 'override', found: true });
  });

  it('reports an override that does not exist rather than falling back', () => {
    // Falling back would silently run a different binary than the one asked
    // for, which is the worst possible answer while debugging.
    const lookup = resolveHelperBinary({ override: '/tmp/gone', exists: nothingExists });
    expect(lookup).toEqual({ path: '/tmp/gone', source: 'override', found: false });
  });

  it('ignores an empty or whitespace override', () => {
    expect(resolveHelperBinary({ override: '   ', exists: nothingExists }).source).toBe(
      'development',
    );
  });

  it('uses the bundled copy when it is there', () => {
    const resourcesPath = '/Applications/Grok Dictate.app/Contents/Resources';
    const lookup = resolveHelperBinary({
      resourcesPath,
      exists: (path) => path === join(resourcesPath, HELPER_BINARY_NAME),
    });
    expect(lookup).toEqual({
      path: join(resourcesPath, HELPER_BINARY_NAME),
      source: 'bundle',
      found: true,
    });
  });

  it('falls back to the development build when resourcesPath points elsewhere', () => {
    // `process.resourcesPath` is set in development too — it points into the
    // Electron framework, where our binary is not. Assuming it would make every
    // `npm run dev` spawn a path that does not exist.
    const lookup = resolveHelperBinary({
      resourcesPath: '/opt/electron/Electron.app/Contents/Resources',
      exists: (path) => path === resolve(HELPER_DEV_PATH),
    });
    expect(lookup).toEqual({ path: resolve(HELPER_DEV_PATH), source: 'development', found: true });
  });

  it('reports not-found rather than throwing when nothing is built', () => {
    const lookup = resolveHelperBinary({ exists: nothingExists });
    expect(lookup.found).toBe(false);
    expect(lookup.source).toBe('development');
    expect(lookup.path).toBe(resolve('native', 'build', HELPER_BINARY_NAME));
  });

  it('no longer points at the Phase 1 mock', () => {
    // Phase 1 report §5.4: the one line this phase was asked to change.
    const lookup = resolveHelperBinary({ exists: nothingExists });
    expect(lookup.path).not.toContain('mock-helper');
  });
});
