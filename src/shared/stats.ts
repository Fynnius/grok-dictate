/**
 * Stats overview, derived only from history.
 *
 * No extra persistence: purge of history zeros the numbers, because a
 * surviving counter after a purge would violate the promise the purge made.
 * The history file is already "a partial keylogger"; this view is aggregates
 * only — no transcript text leaves this function.
 *
 * Honesty about the denominator: retention defaults to 90 days, so "total
 * words" means "in the configured window", labelled as such. "Time saved" is
 * an estimate built on a typing-speed assumption and is labelled with that
 * assumption or not shown.
 */

/**
 * The history fields stats actually read. Declared here rather than imported
 * from `contracts/events.ts` so that file can re-export `StatsViewModel`
 * without a cycle.
 */
export interface StatsSourceRow {
  readonly at: string;
  readonly text: string;
  readonly durationSec: number | null;
  readonly language: string;
  readonly frontmostBundleId: string | null;
  readonly frontmostName: string | null;
  readonly inserted: boolean;
}

/**
 * Assumed typing speed for the "time saved" estimate.
 *
 * **Chosen, not measured.** 40 words/minute is a commonly cited average for
 * transcription-vs-typing comparisons (hunt-and-peck is slower, trained
 * typists faster). An unqualified "you saved 14 hours" is marketing; showing
 * the 40 WPM assumption is the difference.
 */
export const STATS_TYPING_WPM = 40;

/**
 * How many history rows the aggregator will walk.
 *
 * **Chosen, not measured.** 50,000 rows is years of heavy dictation at the
 * 90-day default, and a linear scan of that many records is well under a
 * second. Beyond this the numbers are computed from the newest 50,000 and
 * the view-model says so rather than pretending it saw everything.
 */
export const STATS_ROW_CAP = 50_000;

export interface StatsAppCount {
  readonly name: string;
  readonly count: number;
}

export interface StatsLanguageCount {
  readonly code: string;
  readonly count: number;
}

export interface StatsViewModel {
  /** e.g. "Last 90 days", never "lifetime" unless retention is 0. */
  readonly windowLabel: string;
  readonly retentionDays: number;
  readonly dictationCount: number;
  readonly wordCount: number;
  readonly durationSec: number;
  readonly timeSavedMinutes: number;
  readonly typingWpmAssumption: number;
  readonly insertedCount: number;
  /** `null` when there are no dictations — a rate of 0% would be a lie. */
  readonly insertionRate: number | null;
  readonly topApps: readonly StatsAppCount[];
  readonly languages: readonly StatsLanguageCount[];
  readonly empty: boolean;
  /** True when the walk stopped at `STATS_ROW_CAP`. */
  readonly truncated: boolean;
}

export function windowLabel(retentionDays: number): string {
  if (retentionDays === 0) return 'All history on disk';
  return `Last ${String(retentionDays)} days`;
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export function aggregateStats(
  entries: readonly StatsSourceRow[],
  nowMs: number,
  retentionDays: number,
): StatsViewModel {
  const windowMs = retentionDays === 0 ? Number.POSITIVE_INFINITY : retentionDays * 86_400_000;
  const inWindow = entries.filter((entry) => {
    const at = Date.parse(entry.at);
    if (Number.isNaN(at)) return false;
    return nowMs - at <= windowMs;
  });
  const truncated = inWindow.length > STATS_ROW_CAP;
  const rows = truncated ? inWindow.slice(0, STATS_ROW_CAP) : inWindow;

  let wordCount = 0;
  let durationSec = 0;
  let insertedCount = 0;
  const apps = new Map<string, number>();
  const languages = new Map<string, number>();

  for (const entry of rows) {
    wordCount += countWords(entry.text);
    if (entry.durationSec !== null) durationSec += entry.durationSec;
    if (entry.inserted) insertedCount += 1;
    const appName = entry.frontmostName ?? entry.frontmostBundleId ?? 'Unknown';
    apps.set(appName, (apps.get(appName) ?? 0) + 1);
    const language = entry.language.length > 0 ? entry.language : 'unknown';
    languages.set(language, (languages.get(language) ?? 0) + 1);
  }

  const dictationCount = rows.length;
  const timeSavedMinutes = Math.round((wordCount / STATS_TYPING_WPM) * 10) / 10;

  return {
    windowLabel: windowLabel(retentionDays),
    retentionDays,
    dictationCount,
    wordCount,
    durationSec: Math.round(durationSec * 10) / 10,
    timeSavedMinutes,
    typingWpmAssumption: STATS_TYPING_WPM,
    insertedCount,
    insertionRate: dictationCount === 0 ? null : insertedCount / dictationCount,
    topApps: topCounts(apps, 3),
    languages: topCounts(languages, 8).map(({ name, count }) => ({ code: name, count })),
    empty: dictationCount === 0,
    truncated,
  };
}

function topCounts(map: Map<string, number>, limit: number): StatsAppCount[] {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([name, count]) => ({ name, count }));
}

/**
 * Structural check: the view-model must not carry transcript text. Used by
 * tests so a future field cannot quietly become a second keylogger.
 */
export function statsContainsTranscript(stats: StatsViewModel, transcript: string): boolean {
  if (transcript.length === 0) return false;
  return JSON.stringify(stats).includes(transcript);
}
