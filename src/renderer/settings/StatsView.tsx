/**
 * OWNER: 2026-08-22 latency/honesty pass. Stats overview.
 *
 * Derived only from history — purge zeros the numbers, because a surviving
 * counter after a purge would violate the promise the purge made. No
 * transcript text on this surface: the main process aggregates and this
 * view renders the view-model.
 *
 * Retention is labelled as the configured window (default 90 days), never
 * "lifetime". "Time saved" shows the 40 WPM assumption or it would be
 * marketing. Empty history is a designed first-run state.
 *
 * Keyboard/assistive access matches the other panels: no custom widgets,
 * native text, a real heading. The HUD is unfocusable and is not claimed
 * as an accessibility win; this window is an ordinary panel.
 */

import { useCallback, useEffect, useState } from 'react';
import type { StatsViewModel } from '@shared/stats.js';
import { STATS_TYPING_WPM } from '@shared/stats.js';
import { request } from './ipc.js';
import { PanelShell } from './shell.js';

const api = window.grokDictate;

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${String(Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  if (minutes < 60)
    return rest === 0 ? `${String(minutes)}m` : `${String(minutes)}m ${String(rest)}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  return mins === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(mins)}m`;
}

function formatRate(rate: number | null): string {
  if (rate === null) return '—';
  return `${String(Math.round(rate * 100))}%`;
}

function formatWords(count: number): string {
  return count.toLocaleString();
}

export function StatsView(): React.JSX.Element {
  const [stats, setStats] = useState<StatsViewModel | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const reload = useCallback(() => {
    void request({ type: 'get-stats' }, 'stats').then((outcome) => {
      if (!outcome.ok) {
        setLoadError(outcome.message);
        return;
      }
      setLoadError(null);
      setStats(outcome.value.stats);
    });
  }, []);

  useEffect(() => {
    reload();
    return api.on((message) => {
      if (message.type === 'history-updated' || message.type === 'config-updated') reload();
    });
  }, [reload]);

  if (loadError !== null) {
    return (
      <PanelShell title="Stats">
        <div className="issues" role="alert">
          <p>Could not load stats: {loadError}</p>
        </div>
      </PanelShell>
    );
  }

  if (stats === null) {
    return (
      <PanelShell title="Stats">
        <div className="empty-state">
          <p className="primary">Loading…</p>
        </div>
      </PanelShell>
    );
  }

  if (stats.empty) {
    return (
      <PanelShell title="Stats" accessory={<span className="chip">{stats.windowLabel}</span>}>
        <div className="empty-state stats-empty">
          <p className="primary">Nothing dictated yet</p>
          <p className="secondary">
            Hold Fn and speak. Stats appear here from your history —{' '}
            {stats.windowLabel.toLowerCase()}— and vanish if you delete it.
          </p>
        </div>
      </PanelShell>
    );
  }

  return (
    <PanelShell title="Stats" accessory={<span className="chip">{stats.windowLabel}</span>}>
      <div className="stats-grid" role="list">
        <Stat
          label="Words"
          value={formatWords(stats.wordCount)}
          hint="In the retention window, not all time."
        />
        <Stat
          label="Time spent"
          value={formatDuration(stats.durationSec)}
          hint="Sum of utterance lengths the server reported."
        />
        <Stat
          label="Dictations"
          value={formatWords(stats.dictationCount)}
          hint="One row per hold."
        />
        <Stat
          label="Inserted"
          value={formatRate(stats.insertionRate)}
          hint={`${String(stats.insertedCount)} of ${String(stats.dictationCount)} accepted by the helper, including unconfirmed keystrokes.`}
        />
      </div>

      <div className="group">
        <h2 className="group-title">Time saved</h2>
        <div className="card">
          <div className="card-row">
            <span className="row-label">
              Versus typing
              <span className="stats-assumption"> at {String(STATS_TYPING_WPM)} words/minute</span>
            </span>
            <span className="stats-saved">{formatDuration(stats.timeSavedMinutes * 60)}</span>
          </div>
        </div>
        <p className="card-caption">
          An estimate, not a measurement. {String(STATS_TYPING_WPM)} WPM is a common average; faster
          typists saved less, hunt-and-peck more.
        </p>
      </div>

      <div className="group">
        <h2 className="group-title">Where it went</h2>
        <div className="card">
          {stats.topApps.length === 0 ? (
            <div className="card-row">
              <span className="row-label">No app recorded</span>
            </div>
          ) : (
            stats.topApps.map((app) => (
              <div className="card-row" key={app.name}>
                <span className="row-label">{app.name}</span>
                <span className="unit">{app.count}</span>
              </div>
            ))
          )}
        </div>
      </div>

      <div className="group">
        <h2 className="group-title">Languages</h2>
        <div className="card">
          {stats.languages.map((language) => (
            <div className="card-row" key={language.code}>
              <span className="row-label">{language.code}</span>
              <span className="unit">{language.count}</span>
            </div>
          ))}
        </div>
      </div>

      {stats.truncated ? (
        <p className="card-caption">Showing the newest 50,000 rows in the window.</p>
      ) : null}
    </PanelShell>
  );
}

function Stat({
  label,
  value,
  hint,
}: {
  readonly label: string;
  readonly value: string;
  readonly hint: string;
}): React.JSX.Element {
  return (
    <div className="stat" role="listitem">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
      <p className="stat-hint">{hint}</p>
    </div>
  );
}
