import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '@shared/logger.js';
import { CredentialStore, type SecretBox } from './store.js';

function identityBox(): SecretBox {
  return {
    isAvailable: () => true,
    encrypt: (plain) => Buffer.from(plain, 'utf8'),
    decrypt: (cipher) => cipher.toString('utf8'),
  };
}

function unavailableBox(): SecretBox {
  return {
    isAvailable: () => false,
    encrypt: () => {
      throw new Error('unavailable');
    },
    decrypt: () => {
      throw new Error('unavailable');
    },
  };
}

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'grok-dictate-cred-'));
  path = join(dir, 'credentials.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('CredentialStore', () => {
  it('round-trips a key without writing the plaintext', async () => {
    const store = new CredentialStore(path, identityBox(), createLogger('test'));
    const written = await store.setApiKey('xai-test-key-value');
    expect(written.ok).toBe(true);
    const onDisk = readFileSync(path, 'utf8');
    expect(onDisk).not.toContain('xai-test-key-value');
    expect(onDisk).toContain('"v":1');
    await expect(store.getApiKey()).resolves.toBe('xai-test-key-value');
  });

  it('returns null when the file is missing', async () => {
    const store = new CredentialStore(path, identityBox(), createLogger('test'));
    await expect(store.getApiKey()).resolves.toBeNull();
  });

  it('refuses to store a key when encryption is unavailable', async () => {
    const store = new CredentialStore(path, unavailableBox(), createLogger('test'));
    const written = await store.setApiKey('xai-test-key-value');
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(written.error.code).toBe('auth_malformed');
    await expect(store.getApiKey()).resolves.toBeNull();
  });

  it('clears the file', async () => {
    const store = new CredentialStore(path, identityBox(), createLogger('test'));
    await store.setApiKey('xai-test-key-value');
    await store.clearApiKey();
    await expect(store.getApiKey()).resolves.toBeNull();
  });

  it('never echoes the key in an error', async () => {
    const store = new CredentialStore(
      '/no/such/dir/credentials.json',
      identityBox(),
      createLogger('test'),
    );
    const written = await store.setApiKey('xai-super-secret-key');
    expect(written.ok).toBe(false);
    if (written.ok) return;
    expect(JSON.stringify(written.error)).not.toContain('xai-super-secret-key');
  });
});
