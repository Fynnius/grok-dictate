import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CAPTURE_BINARY_NAME, CAPTURE_DEV_PATH, resolveCaptureBinary } from './capture-binary.js';

describe('resolveCaptureBinary', () => {
  const nothingExists = (): boolean => false;
  const everythingExists = (): boolean => true;

  it('prefers an explicit override', () => {
    const lookup = resolveCaptureBinary({
      override: '/tmp/my-capture',
      resourcesPath: '/Applications/Grok Dictate.app/Contents/Resources',
      exists: everythingExists,
    });
    expect(lookup).toEqual({ path: '/tmp/my-capture', source: 'override', found: true });
  });

  it('reports an override that does not exist rather than falling back', () => {
    const lookup = resolveCaptureBinary({ override: '/tmp/gone', exists: nothingExists });
    expect(lookup).toEqual({ path: '/tmp/gone', source: 'override', found: false });
  });

  it('ignores an empty or whitespace override', () => {
    expect(resolveCaptureBinary({ override: '   ', exists: nothingExists }).source).toBe(
      'development',
    );
  });

  it('uses the bundled copy when it is there', () => {
    const resourcesPath = '/Applications/Grok Dictate.app/Contents/Resources';
    const lookup = resolveCaptureBinary({
      resourcesPath,
      exists: (path) => path === join(resourcesPath, CAPTURE_BINARY_NAME),
    });
    expect(lookup).toEqual({
      path: join(resourcesPath, CAPTURE_BINARY_NAME),
      source: 'bundle',
      found: true,
    });
  });

  it('falls back to the development build when resourcesPath points elsewhere', () => {
    const lookup = resolveCaptureBinary({
      resourcesPath: '/opt/electron/Electron.app/Contents/Resources',
      exists: (path) => path === resolve(CAPTURE_DEV_PATH),
    });
    expect(lookup).toEqual({ path: resolve(CAPTURE_DEV_PATH), source: 'development', found: true });
  });

  it('reports not-found rather than throwing when nothing is built', () => {
    const lookup = resolveCaptureBinary({ exists: nothingExists });
    expect(lookup.found).toBe(false);
    expect(lookup.source).toBe('development');
    expect(lookup.path).toBe(resolve('native', 'build', CAPTURE_BINARY_NAME));
  });
});
