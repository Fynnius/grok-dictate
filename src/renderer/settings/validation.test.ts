import { describe, expect, it } from 'vitest';
import { AppConfigSchema } from '@contracts/config.js';
import { KEYTERM_MAX_COUNT, KEYTERM_MAX_LENGTH } from '@shared/constants.js';
import {
  describeRetention,
  formatKeyterms,
  parseBoundedInteger,
  parseKeyterms,
} from './validation.js';

describe('parseKeyterms', () => {
  it('takes one term per line and trims whitespace', () => {
    // Line-per-term, not CSV: a term containing a comma is unrepresentable in
    // CSV (docs/spike-results.md).
    const { terms } = parseKeyterms('  kubectl \nVitest\n\n  Staging-Server  \n');
    expect(terms).toEqual(['kubectl', 'Vitest', 'Staging-Server']);
  });

  it('keeps a term that contains a comma', () => {
    const { terms } = parseKeyterms('Meyer, Schulz & Partner');
    expect(terms).toEqual(['Meyer, Schulz & Partner']);
  });

  it('drops case-insensitive duplicates and says so', () => {
    const { terms, issues } = parseKeyterms('kubectl\nKubectl\nKUBECTL');
    expect(terms).toEqual(['kubectl']);
    expect(issues.join(' ')).toMatch(/2 duplicates removed/);
  });

  it('drops over-long terms and says how many', () => {
    const long = 'x'.repeat(KEYTERM_MAX_LENGTH + 1);
    const { terms, issues } = parseKeyterms(`ok\n${long}`);
    expect(terms).toEqual(['ok']);
    expect(issues.join(' ')).toMatch(new RegExp(`longer than ${String(KEYTERM_MAX_LENGTH)}`));
  });

  it('keeps a term of exactly the maximum length', () => {
    const exact = 'x'.repeat(KEYTERM_MAX_LENGTH);
    expect(parseKeyterms(exact).terms).toEqual([exact]);
  });

  it('caps at the server limit and reports the overflow', () => {
    const many = Array.from({ length: KEYTERM_MAX_COUNT + 5 }, (_v, i) => `term${String(i)}`);
    const { terms, issues } = parseKeyterms(many.join('\n'));
    expect(terms).toHaveLength(KEYTERM_MAX_COUNT);
    expect(issues.join(' ')).toMatch(/5 were dropped/);
  });

  it('always produces something the frozen schema accepts', () => {
    const filler = Array.from({ length: 150 }, (_v, i) => `filler${String(i)}`);
    const nasty = ['', '   ', 'a'.repeat(200), 'ok', 'OK', ...filler].join('\n');
    const { terms } = parseKeyterms(nasty);
    expect(AppConfigSchema.safeParse({ keyterms: terms }).success).toBe(true);
  });

  it('round-trips through the editor format', () => {
    const terms = ['kubectl', 'Vitest', 'Meyer, Schulz'];
    expect(parseKeyterms(formatKeyterms(terms)).terms).toEqual(terms);
  });

  it('treats an empty editor as no keyterms', () => {
    expect(parseKeyterms('').terms).toEqual([]);
    expect(parseKeyterms('\n\n  \n').terms).toEqual([]);
    expect(parseKeyterms('').issues).toEqual([]);
  });
});

describe('parseBoundedInteger', () => {
  const endpointing = { min: 10, max: 5_000, fallback: 400, label: 'Endpointing' };

  it('accepts a value in range', () => {
    expect(parseBoundedInteger('250', endpointing)).toEqual({ value: 250, issue: null });
  });

  it('clamps rather than refusing to save, and explains', () => {
    expect(parseBoundedInteger('9999', endpointing).value).toBe(5_000);
    expect(parseBoundedInteger('9999', endpointing).issue).toMatch(/cannot be above 5000/);
    expect(parseBoundedInteger('1', endpointing).value).toBe(10);
  });

  it('falls back when the field is not a number at all', () => {
    const result = parseBoundedInteger('soon', endpointing);
    expect(result.value).toBe(400);
    expect(result.issue).toMatch(/must be a number/);
  });

  it('produces values the frozen schema accepts for any input', () => {
    for (const raw of ['', '-5', '0', '10', '5000', '5001', 'NaN', '3.7', '1e9']) {
      const { value } = parseBoundedInteger(raw, endpointing);
      expect(AppConfigSchema.safeParse({ endpointingMs: value }).success).toBe(true);
    }
  });
});

describe('describeRetention', () => {
  it('says plainly that 0 means forever', () => {
    // The history file is a partial keylogger; "0" must never read as "off".
    expect(describeRetention(0)).toMatch(/forever/i);
  });

  it('reads naturally for one day and for many', () => {
    expect(describeRetention(1)).toBe('Deleted after 1 day.');
    expect(describeRetention(90)).toBe('Deleted after 90 days.');
  });
});
