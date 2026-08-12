import { appError, err, ok, type Result } from '@shared/result.js';

const MIN_KEY_LENGTH = 16;

/**
 * Accept a pasted xAI API key. Reject empty, too-short, and JWT-shaped
 * values — those belong in `~/.grok/auth.json`, not here.
 */
export function validateApiKey(raw: string): Result<string> {
  const key = raw.trim();
  if (key.length === 0) {
    return err(
      appError(
        'auth_malformed',
        'Paste an xAI API key first.',
        'Create one at console.x.ai, then paste it here.',
      ),
    );
  }
  if (key.length < MIN_KEY_LENGTH) {
    return err(
      appError(
        'auth_malformed',
        'That does not look like an xAI API key.',
        'Keys are created at console.x.ai and are longer than this.',
      ),
    );
  }
  if (key.startsWith('eyJ') && key.split('.').length === 3) {
    return err(
      appError(
        'auth_malformed',
        'That looks like a Grok CLI token, not an API key.',
        'If you already use the Grok CLI, Grok Dictate will pick it up automatically. Otherwise create an API key at console.x.ai.',
      ),
    );
  }
  return ok(key);
}
