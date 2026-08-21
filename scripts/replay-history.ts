/**
 * Replay your own dictation history through the seam repairer.
 *
 *     npx tsx scripts/replay-history.ts
 *
 * ## What it is for
 *
 * `src/shared/stitch.ts` rewrites what a person said, and its unit tests can
 * only prove it does what its author expected. This proves what it does to real
 * text — yours — which is the only corpus that matters and the only one nobody
 * can commit to the repository.
 *
 * Run it before and after changing a rule. A rule that fires on a lot of
 * well-formed sentences is a rule that is too eager, whatever its tests say.
 *
 * ## What it can and cannot tell you
 *
 * History stores the *joined* transcript, not the segments it was joined from —
 * so the real seams are gone and this re-cuts each entry at every sentence
 * boundary instead. That is deliberately pessimistic: it manufactures far more
 * seams than a dictation actually has (measured: ~4.9 per hold, at sentence
 * boundaries and mid-sentence pauses alike), so every rule gets many more
 * chances to fire here than in practice.
 *
 * Read the output accordingly. "Reproduced byte-for-byte" is the number that
 * matters: it is the evidence that the rules leave well-punctuated text alone.
 * The alterations are worth reading one by one — each is a rule firing on a seam
 * that this script invented, and whether it would have been an improvement on a
 * real one is a judgement no assertion can make for you.
 *
 * Nothing is written. Your transcripts are printed to your own terminal and go
 * nowhere else.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stitchSegments } from '../src/shared/stitch.js';

/** Electron's `app.getPath('userData')` for this app, on macOS. */
const HISTORY_PATH = join(
  homedir(),
  'Library',
  'Application Support',
  'grok-dictate',
  'history.json',
);

/** How much of each altered entry to show on either side of the first change. */
const CONTEXT_CHARS = 70;

interface HistoryRow {
  readonly text: string;
}

function readHistory(path: string): HistoryRow[] {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    console.error(`No history at ${path} — dictate something first.`);
    process.exit(1);
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    console.error('history.json is not an array of entries.');
    process.exit(1);
  }
  return parsed.filter(
    (row): row is HistoryRow =>
      typeof row === 'object' && row !== null && typeof (row as HistoryRow).text === 'string',
  );
}

/** Where the two strings first diverge, or -1 if they do not. */
function firstDifference(a: string, b: string): number {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : shared;
}

function excerpt(text: string, around: number): string {
  const from = Math.max(0, around - CONTEXT_CHARS);
  const to = Math.min(text.length, around + CONTEXT_CHARS);
  return `${from > 0 ? '…' : ''}${text.slice(from, to)}${to < text.length ? '…' : ''}`;
}

const rows = readHistory(HISTORY_PATH);
const altered: { before: string; after: string; at: number }[] = [];
let identical = 0;

for (const row of rows) {
  const before = row.text.trim();
  // Re-cut at sentence boundaries. See the note above: this over-produces seams
  // on purpose, so the rules face a harder corpus than reality.
  const segments = before.split(/(?<=[.!?])\s+/).filter((piece) => piece.trim().length > 0);
  if (segments.length < 2) continue;

  const after = stitchSegments(segments);
  if (after === before) {
    identical++;
    continue;
  }
  altered.push({ before, after, at: firstDifference(before, after) });
}

const considered = identical + altered.length;
console.log(`entries in history:            ${String(rows.length)}`);
console.log(`re-cut into two or more parts: ${String(considered)}`);
console.log(`reproduced byte-for-byte:      ${String(identical)}`);
console.log(`altered:                       ${String(altered.length)}`);

for (const { before, after, at } of altered) {
  console.log('\n─── altered ───');
  console.log(`  before: ${excerpt(before, at)}`);
  console.log(`  after:  ${excerpt(after, at)}`);
}
