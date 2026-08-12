/**
 * OWNER: **Phase 4**. Turning what the user typed into a valid `AppConfig`.
 *
 * `contracts/config.ts` is the authority on what is valid; this module is the
 * editor's half — it explains *why* something was rejected before the user
 * saves, rather than letting a zod error surface as "Those settings are not
 * valid" (which is what `src/main/index.ts` returns, and is exactly the
 * unhelpful message IMPLEMENTATION-PLAN.md §4 calls a defect).
 *
 * Keyterms are edited **one per line**, not comma-separated. That is a finding,
 * not a preference: docs/spike-results.md established that repeated `keyterm`
 * parameters and a comma-separated list behave identically on the wire, and
 * that repeated is the right form because *a term containing a comma is
 * unrepresentable in CSV*. Line-per-term is the editor shape that matches.
 *
 * Pure, so all of it is unit-tested.
 */

import { KEYTERM_MAX_COUNT, KEYTERM_MAX_LENGTH } from '@shared/constants.js';

export interface KeytermParse {
  /** What would actually be sent, in order, deduplicated. */
  readonly terms: readonly string[];
  /** Human-readable reasons anything was dropped or trimmed. */
  readonly issues: readonly string[];
}

export function parseKeyterms(text: string): KeytermParse {
  const issues: string[] = [];
  const terms: string[] = [];
  const seen = new Set<string>();
  let overLong = 0;
  let duplicates = 0;

  for (const raw of text.split('\n')) {
    const term = raw.trim();
    if (term.length === 0) continue;

    if (term.length > KEYTERM_MAX_LENGTH) {
      overLong += 1;
      continue;
    }
    // Case-insensitive dedupe: the server treats "Kubectl" and "kubectl" as the
    // same hint, and a duplicate silently costs one of the 100 slots.
    const key = term.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    terms.push(term);
  }

  if (overLong > 0) {
    issues.push(
      `${String(overLong)} term${overLong === 1 ? '' : 's'} longer than ${String(KEYTERM_MAX_LENGTH)} characters ${overLong === 1 ? 'was' : 'were'} dropped.`,
    );
  }
  if (duplicates > 0) {
    issues.push(`${String(duplicates)} duplicate${duplicates === 1 ? '' : 's'} removed.`);
  }
  if (terms.length > KEYTERM_MAX_COUNT) {
    issues.push(
      `Only the first ${String(KEYTERM_MAX_COUNT)} terms are sent; ${String(terms.length - KEYTERM_MAX_COUNT)} were dropped.`,
    );
    return { terms: terms.slice(0, KEYTERM_MAX_COUNT), issues };
  }

  return { terms, issues };
}

export function formatKeyterms(terms: readonly string[]): string {
  return terms.join('\n');
}

export interface NumberFieldResult {
  readonly value: number;
  readonly issue: string | null;
}

/**
 * Clamp rather than reject. A settings field that refuses to save is worse than
 * one that says "I used 5000, the maximum" — the user still gets a working app
 * and knows what happened.
 */
export function parseBoundedInteger(
  raw: string,
  bounds: { min: number; max: number; fallback: number; label: string },
): NumberFieldResult {
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return {
      value: bounds.fallback,
      issue: `${bounds.label} must be a number; using the default.`,
    };
  }
  if (parsed < bounds.min) {
    return { value: bounds.min, issue: `${bounds.label} cannot be below ${String(bounds.min)}.` };
  }
  if (parsed > bounds.max) {
    return { value: bounds.max, issue: `${bounds.label} cannot be above ${String(bounds.max)}.` };
  }
  return { value: parsed, issue: null };
}

/** How the retention setting reads in the UI, where `0` means "keep forever". */
export function describeRetention(days: number): string {
  if (days <= 0) return 'Kept forever.';
  if (days === 1) return 'Deleted after 1 day.';
  return `Deleted after ${String(days)} days.`;
}
