/**
 * Newline-delimited framing over a byte stream.
 *
 * stdout arrives in arbitrary chunks that have nothing to do with line
 * boundaries — a frame can be split across two reads, and two frames can arrive
 * in one read. Getting this wrong produces exactly the kind of intermittent,
 * unreproducible failure  warns about, so it lives in its own
 * unit-tested module rather than inline in the supervisor.
 */

/**
 * Cap on a single line. A helper that never emits a newline would otherwise
 * grow this buffer without bound. 1 MiB is far above any real frame (the
 * largest is an `insert` carrying a transcript) and far below trouble.
 */
export const MAX_LINE_BYTES = 1024 * 1024;

export interface FramerOverflow {
  readonly droppedBytes: number;
}

export class LineFramer {
  #buffer = '';
  #overflowed = false;

  /**
   * Feed a chunk; get back the complete lines it finished. Incomplete trailing
   * data is retained for the next call.
   */
  feed(chunk: string): string[] {
    this.#buffer += chunk;

    if (this.#buffer.length > MAX_LINE_BYTES && !this.#buffer.includes('\n')) {
      // Runaway line: drop what we have and resynchronise at the next newline
      // rather than accumulating for ever.
      this.#overflowed = true;
      this.#buffer = '';
      return [];
    }

    const parts = this.#buffer.split('\n');
    // The last element is either '' (chunk ended on a newline) or a partial line.
    this.#buffer = parts.pop() ?? '';

    if (this.#overflowed) {
      // We resynchronised on a newline; the first line here is the tail of the
      // discarded one and must not be parsed.
      this.#overflowed = false;
      parts.shift();
    }

    return parts
      .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
      .filter((l) => l.length > 0);
  }

  /** Any trailing partial line, e.g. when the stream closes without a newline. */
  flush(): string[] {
    const remaining = this.#buffer.trim();
    this.#buffer = '';
    this.#overflowed = false;
    return remaining.length > 0 ? [remaining] : [];
  }

  reset(): void {
    this.#buffer = '';
    this.#overflowed = false;
  }
}
