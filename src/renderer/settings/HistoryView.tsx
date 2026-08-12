/**
 * OWNER: Design overhaul 2026-08-09 (session 2). History.
 *
 *  — and this is the point that matters — history is not a
 * log, it is **the recovery surface**. When an insertion fails, or lands in
 * the wrong app, or half-lands (§12.5), this is where the text still is. That
 * is why a failed row stays visually marked rather than filtered out, and why
 * *Copy* is on every row.
 *
 * The row is the sentence plus a time (overhaul §4.5): the app name, language,
 * duration and tier were five metadata fields dominating what is, in use, a
 * list of sentences. They moved into the row's tooltip — still recorded, still
 * *searchable* (`get-history` matches transcripts and app names, overhaul
 * §11.1.4), no longer displayed.
 *
 * Re-insert is gone (overhaul §4.4, §16.2): the button targeted whatever app
 * is frontmost *now*, and clicking it in this window made that Grok Dictate
 * itself. Copy is the only coherent action from a focused window, and stays
 * the product's only route to the pasteboard.
 *
 *  is the counterweight to keeping everything: "everything
 * dictated, including into private contexts, in one searchable local store".
 * *Delete everything* is therefore a first-class control, not something
 * buried in Settings.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '@contracts/events.js';
import { request } from './ipc.js';
import { PanelShell } from './shell.js';
import { CheckIcon, CopyIcon, SearchIcon, XIcon } from './icons.js';

const api = window.grokDictate;
const PAGE = 200;
/** §11.1.11 — keystroke-to-requery without a debounce is an IPC round trip
 *  plus a full list re-render per character. */
const SEARCH_DEBOUNCE_MS = 140;

/**
 * The time, at the weight a sentence list can carry: clock time today, day
 * plus clock time within the week, date beyond it. The full timestamp lives
 * in the row tooltip.
 */
function when(iso: string, now: Date): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (at >= startOfDay) return time;
  if (at.getTime() >= startOfDay.getTime() - 6 * 86_400_000) {
    return `${at.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`;
  }
  return at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** Everything the row no longer displays, for the hover tooltip (§4.5). */
function rowDetail(entry: HistoryEntry): string {
  const parts = [
    new Date(entry.at).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }),
  ];
  if (entry.frontmostName !== null) parts.push(entry.frontmostName);
  parts.push(entry.language);
  if (entry.durationSec !== null) parts.push(`${entry.durationSec.toFixed(1)}s`);
  parts.push(entry.inserted ? `inserted · ${entry.tier}` : 'not inserted');
  return parts.join('  ·  ');
}

export function HistoryView(): React.JSX.Element {
  const [query, setQuery] = useState('');
  const [entries, setEntries] = useState<readonly HistoryEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirmingPurge, setConfirmingPurge] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  // The live-update listener needs the current query, but must not
  // re-subscribe on every keystroke.
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  const reload = useCallback((search: string) => {
    void request(
      { type: 'get-history', query: search.length === 0 ? null : search, limit: PAGE },
      'history',
    ).then((outcome) => {
      if (outcome.ok) {
        setEntries(outcome.value.entries);
        setLoadError(null);
        return;
      }
      // Never show "nothing dictated yet" when the truth is "we could not
      // read it" — that would look like data loss.
      setEntries([]);
      setLoadError(outcome.message);
    });
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => reload(query), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query, reload]);

  useEffect(
    () =>
      api.on((message) => {
        if (message.type === 'history-updated') reload(queryRef.current);
      }),
    [reload],
  );

  const copy = (entry: HistoryEntry): void => {
    //  — an explicit user action is the only thing that may
    // write the pasteboard.
    api.send({ type: 'copy', text: entry.text });
    setCopied(entry.id);
    window.setTimeout(() => setCopied(null), 1_200);
  };

  const now = new Date();

  return (
    <PanelShell
      title="History"
      className="history"
      toolbar={
        <div className="searchfield">
          <SearchIcon />
          <input
            type="search"
            placeholder="Search transcripts and apps"
            aria-label="Search transcripts and apps"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          {query.length === 0 ? null : (
            <button
              type="button"
              className="icon clear"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <XIcon size={12} />
            </button>
          )}
        </div>
      }
      footer={
        <>
          <p className="note">Stored on this machine only. Retention is set in Settings.</p>
          {confirmingPurge ? (
            <>
              <button
                type="button"
                className="danger"
                onClick={() => {
                  void request({ type: 'purge-history' }, 'ok').then((outcome) => {
                    setConfirmingPurge(false);
                    if (outcome.ok) reload(query);
                    else setLoadError(outcome.message);
                  });
                }}
              >
                Delete everything, permanently
              </button>
              <button type="button" className="ghost" onClick={() => setConfirmingPurge(false)}>
                Cancel
              </button>
            </>
          ) : (
            <button
              type="button"
              className="ghost destructive"
              onClick={() => setConfirmingPurge(true)}
            >
              Delete All…
            </button>
          )}
        </>
      }
    >
      {loadError !== null ? (
        <div className="issues" role="alert">
          <p>Could not read your history: {loadError}</p>
          <p>Nothing has been deleted — the file is still on disk.</p>
        </div>
      ) : entries.length === 0 ? (
        <div className="empty-state">
          <p className="primary">{query.length === 0 ? 'Nothing dictated yet' : 'No matches'}</p>
          <p className="secondary">
            {query.length === 0
              ? 'Hold Fn and speak — every transcript lands here.'
              : `Nothing matches “${query}”.`}
          </p>
        </div>
      ) : (
        <ul className="rows">
          {entries.map((entry) => (
            <li key={entry.id} title={rowDetail(entry)}>
              <p className="row-text">{entry.text}</p>
              <span className="row-side">
                <time dateTime={entry.at}>{when(entry.at, now)}</time>
                {entry.inserted ? null : <span className="row-flag">Not inserted</span>}
              </span>
              <button
                type="button"
                className={`icon row-copy${copied === entry.id ? ' copied' : ''}`}
                aria-label="Copy this transcript"
                onClick={() => copy(entry)}
              >
                {copied === entry.id ? <CheckIcon /> : <CopyIcon />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </PanelShell>
  );
}
