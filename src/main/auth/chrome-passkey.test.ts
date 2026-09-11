import { describe, expect, it } from 'vitest';
import {
  CHROME_CANDIDATES,
  cdpCookieToRecord,
  cookieBelongsToGrok,
  findChromeBinary,
} from './chrome-passkey.js';

describe('findChromeBinary', () => {
  it('returns the first candidate that exists', () => {
    const path = findChromeBinary((candidate) => candidate.includes('Brave'));
    expect(path).toBe('/Applications/Brave Browser.app/Contents/MacOS/Brave Browser');
  });

  it('returns null when none exist', () => {
    expect(findChromeBinary(() => false)).toBeNull();
  });

  it('lists Chrome before Edge and Brave', () => {
    expect(CHROME_CANDIDATES[0]).toContain('Google Chrome.app');
  });
});

describe('cookieBelongsToGrok', () => {
  it('accepts grok.com and x.ai, including a leading dot', () => {
    expect(cookieBelongsToGrok('grok.com')).toBe(true);
    expect(cookieBelongsToGrok('.grok.com')).toBe(true);
    expect(cookieBelongsToGrok('accounts.x.ai')).toBe(true);
    expect(cookieBelongsToGrok('x.ai')).toBe(true);
  });

  it('rejects unrelated hosts', () => {
    expect(cookieBelongsToGrok('google.com')).toBe(false);
    expect(cookieBelongsToGrok('notgrok.com')).toBe(false);
  });
});

describe('cdpCookieToRecord', () => {
  it('keeps a grok.com session cookie and drops others', () => {
    const grok = cdpCookieToRecord({
      name: 'sso-rw',
      value: 'fake',
      domain: '.grok.com',
      path: '/',
      secure: true,
      httpOnly: true,
      session: true,
      expires: -1,
    });
    expect(grok).toEqual({
      name: 'sso-rw',
      value: 'fake',
      domain: '.grok.com',
      path: '/',
      secure: true,
      httpOnly: true,
    });

    expect(
      cdpCookieToRecord({
        name: 'NID',
        value: 'nope',
        domain: '.google.com',
        path: '/',
        secure: true,
        httpOnly: true,
        session: false,
        expires: 1_700_000_000,
      }),
    ).toBeNull();
  });
});
