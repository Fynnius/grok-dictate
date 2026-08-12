/**
 * Exponential backoff with jitter.
 *
 * Two callers need this and both are load-bearing:
 *   - the helper supervisor, restarting a crashed Swift process;
 *   - Phase 3's STT client on HTTP 429, which  calls "a v1
 *     requirement, not polish" — the subscription's rate limits are unpublished,
 *     so a retry storm is a real way to make the product unusable.
 *
 * Full jitter (`random() * capped`) rather than the more obvious
 * `capped ± jitter`: it is what actually decorrelates retries, and with a
 * single client it also avoids a fixed, predictable retry cadence.
 */

export interface BackoffOptions {
  readonly baseMs: number;
  readonly maxMs: number;
  /** Injectable for deterministic tests. */
  readonly random?: () => number;
}

/**
 * Delay before attempt `n` (0-based: attempt 0 is the first *retry*).
 * Returns a value in `[0, min(maxMs, baseMs * 2^n)]`.
 */
export function backoffDelayMs(attempt: number, options: BackoffOptions): number {
  const random = options.random ?? Math.random;
  const exponent = Math.min(attempt, 30); // 2^31 overflows the useful range
  const capped = Math.min(options.maxMs, options.baseMs * 2 ** exponent);
  return Math.round(random() * capped);
}

export class Backoff {
  #attempt = 0;
  readonly #options: BackoffOptions;

  constructor(options: BackoffOptions) {
    this.#options = options;
  }

  /** Delay for the next retry, advancing the sequence. */
  next(): number {
    return backoffDelayMs(this.#attempt++, this.#options);
  }

  /** Call after a success so the next failure starts from the bottom again. */
  reset(): void {
    this.#attempt = 0;
  }

  get attempts(): number {
    return this.#attempt;
  }
}
