/**
 * Local, encrypted storage for an xAI API key.
 *
 * The key never goes in `config.json` (that file is plain JSON next to logs)
 * and never goes in `~/.grok/auth.json` (that file belongs to the Grok CLI).
 * Electron `safeStorage` puts it in the macOS Keychain-backed store, and we
 * keep only the ciphertext on disk.
 *
 * There is no refresh path here. An API key is a static secret; a Grok CLI
 * token is handled by `GrokAuthProvider` and is never written back.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { CREDENTIALS_FILE_NAME } from '@shared/constants.js';
import type { Logger } from '@shared/logger.js';
import { appError, err, ok, type Result } from '@shared/result.js';

export interface SecretBox {
  isAvailable(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(cipher: Buffer): string;
}

interface CredentialsFile {
  readonly v: 1;
  readonly apiKey: string;
}

export class CredentialStore {
  readonly #path: string;
  readonly #box: SecretBox;
  readonly #log: Logger;

  constructor(filePath: string, box: SecretBox, logger: Logger) {
    this.#path = filePath;
    this.#box = box;
    this.#log = logger.child('credentials');
  }

  async getApiKey(): Promise<string | null> {
    let text: string;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException | null)?.code;
      if (code === 'ENOENT') return null;
      this.#log.warn('could not read the credentials file', { code: code ?? 'unknown' });
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      this.#log.warn('credentials file is not valid JSON; ignoring it');
      return null;
    }

    if (!isCredentialsFile(parsed)) {
      this.#log.warn('credentials file is not in the expected shape; ignoring it');
      return null;
    }

    if (!this.#box.isAvailable()) {
      this.#log.warn('OS encryption is unavailable; cannot read a stored API key');
      return null;
    }

    try {
      const key = this.#box.decrypt(Buffer.from(parsed.apiKey, 'base64'));
      return key.length === 0 ? null : key;
    } catch {
      this.#log.warn('could not decrypt the stored API key; sign in again');
      return null;
    }
  }

  async setApiKey(key: string): Promise<Result<void>> {
    if (!this.#box.isAvailable()) {
      return err(
        appError(
          'auth_malformed',
          'Grok Dictate cannot store an API key on this Mac.',
          'OS encryption is unavailable. Sign in to the Grok CLI instead, or set the XAI_API_KEY environment variable.',
        ),
      );
    }

    let cipher: Buffer;
    try {
      cipher = this.#box.encrypt(key);
    } catch (cause) {
      return err(
        appError(
          'auth_malformed',
          'Grok Dictate could not encrypt the API key.',
          'Try again. If it keeps failing, set XAI_API_KEY in the environment instead.',
          cause,
        ),
      );
    }

    const body: CredentialsFile = { v: 1, apiKey: cipher.toString('base64') };
    try {
      await mkdir(dirname(this.#path), { recursive: true });
      await writeFile(this.#path, `${JSON.stringify(body)}\n`, { mode: 0o600 });
    } catch (cause) {
      return err(
        appError(
          'auth_malformed',
          'Grok Dictate could not save the API key.',
          'Check that the app can write to its data folder, then try again.',
          cause,
        ),
      );
    }

    this.#log.info('stored an encrypted API key');
    return ok(undefined);
  }

  async clearApiKey(): Promise<void> {
    try {
      await rm(this.#path, { force: true });
    } catch (cause) {
      this.#log.warn('could not remove the credentials file', { err: cause });
      return;
    }
    this.#log.info('cleared the stored API key');
  }
}

export function credentialsPath(userDataDir: string): string {
  return join(userDataDir, CREDENTIALS_FILE_NAME);
}

function isCredentialsFile(value: unknown): value is CredentialsFile {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return record['v'] === 1 && typeof record['apiKey'] === 'string' && record['apiKey'].length > 0;
}
