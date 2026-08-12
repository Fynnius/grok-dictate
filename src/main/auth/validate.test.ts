import { describe, expect, it } from 'vitest';
import { validateApiKey } from './validate.js';

describe('validateApiKey', () => {
  it('accepts a trimmed xAI-shaped key', () => {
    const result = validateApiKey('  xai-abcdefghijklmnopqrstuvwxyz  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBe('xai-abcdefghijklmnopqrstuvwxyz');
  });

  it('rejects an empty paste', () => {
    const result = validateApiKey('   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Paste an xAI API key/);
  });

  it('rejects a JWT, which belongs in the Grok CLI file', () => {
    const jwt = `eyJhbGciOiJSUzI1NiJ9.${'abc'.repeat(20)}.sig`;
    const result = validateApiKey(jwt);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/Grok CLI token/);
    expect(JSON.stringify(result.error)).not.toContain(jwt);
  });
});
