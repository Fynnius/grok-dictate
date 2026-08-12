import { describe, expect, it } from 'vitest';
import { KEYTERM_MAX_COUNT, KEYTERM_MAX_LENGTH } from '@shared/constants.js';
import { buildSttUrl, checkTransportSecurity, selectKeyterms } from './url.js';

const base = 'https://api.x.ai';

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

describe('buildSttUrl', () => {
  it('sends the five parameters the Grok CLI sends (config.rs:36-48)', () => {
    const url = buildSttUrl({ apiBase: base, language: 'de', endpointingMs: 400, keyterms: [] });
    expect(url.startsWith('wss://api.x.ai/v1/stt?')).toBe(true);
    const q = query(url);
    expect(q.get('sample_rate')).toBe('16000');
    expect(q.get('encoding')).toBe('pcm');
    expect(q.get('interim_results')).toBe('true');
    expect(q.get('endpointing')).toBe('400');
    expect(q.get('language')).toBe('de');
  });

  it('omits `language` entirely when it is null (spike 1 and 3)', () => {
    // `resolveWireLanguage` returns null for `auto`. Sending a code the server
    // ignores is inert at best, and  shows a wrong code fails
    // silently — the server accepted `xx99` without complaint.
    const q = query(
      buildSttUrl({ apiBase: base, language: null, endpointingMs: 400, keyterms: [] }),
    );
    expect(q.has('language')).toBe(false);
  });

  it('never sends the literal string `auto`', () => {
    // `language.rs:176-186` / `streaming.rs:268`: "must never send auto to STT
    // API". The type forbids it; this asserts the type is honoured end to end.
    const url = buildSttUrl({ apiBase: base, language: null, endpointingMs: 400, keyterms: [] });
    expect(url).not.toContain('auto');
  });

  it('repeats `keyterm` rather than joining with commas (spike 5)', () => {
    const url = buildSttUrl({
      apiBase: base,
      language: null,
      endpointingMs: 400,
      keyterms: ['kubectl', 'Vitest', 'Grok Dictate'],
    });
    expect(query(url).getAll('keyterm')).toEqual(['kubectl', 'Vitest', 'Grok Dictate']);
    // A term containing a comma is unrepresentable in the CSV form; that is why
    // repetition was chosen even though both encodings worked identically.
    const comma = buildSttUrl({
      apiBase: base,
      language: null,
      endpointingMs: 400,
      keyterms: ['Foo, Inc.'],
    });
    expect(query(comma).getAll('keyterm')).toEqual(['Foo, Inc.']);
  });

  it('turns an http base into ws, so the loopback test server is reachable', () => {
    const url = buildSttUrl({
      apiBase: 'http://127.0.0.1:5555',
      language: null,
      endpointingMs: 50,
      keyterms: [],
    });
    expect(url.startsWith('ws://127.0.0.1:5555/v1/stt?')).toBe(true);
  });
});

describe('selectKeyterms', () => {
  it('trims, drops empties and de-duplicates case-insensitively', () => {
    const { accepted } = selectKeyterms(['  kubectl ', 'kubectl', 'KUBECTL', '', '   ', 'Vitest']);
    expect(accepted).toEqual(['kubectl', 'Vitest']);
  });

  it('drops terms over the 50-character limit, with a reason', () => {
    const long = 'x'.repeat(KEYTERM_MAX_LENGTH + 1);
    const { accepted, dropped } = selectKeyterms(['ok', long]);
    expect(accepted).toEqual(['ok']);
    expect(dropped).toEqual([
      { term: long, reason: `longer than ${String(KEYTERM_MAX_LENGTH)} characters` },
    ]);
  });

  it('caps at 100 terms rather than sending an over-long query', () => {
    const terms = Array.from({ length: KEYTERM_MAX_COUNT + 5 }, (_, i) => `term${String(i)}`);
    const { accepted, dropped } = selectKeyterms(terms);
    expect(accepted).toHaveLength(KEYTERM_MAX_COUNT);
    expect(dropped).toHaveLength(5);
  });
});

describe('checkTransportSecurity (config.rs:100-119)', () => {
  it('accepts wss', () => {
    expect(checkTransportSecurity('wss://api.x.ai/v1/stt').ok).toBe(true);
  });

  it('refuses to send the bearer over plaintext to a remote host', () => {
    const result = checkTransportSecurity('ws://api.x.ai/v1/stt');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('plaintext');
  });

  it('exempts loopback, which is the only reason the exemption exists', () => {
    expect(checkTransportSecurity('ws://127.0.0.1:1234/v1/stt').ok).toBe(true);
    expect(checkTransportSecurity('ws://localhost:1234/v1/stt').ok).toBe(true);
  });
});
