/**
 * OWNER: Design overhaul 2026-08-09 (session 2). Settings.
 *
 * Saves as you go, the way a macOS preferences pane does: toggles and
 * segments write immediately, text fields write on blur. There is no *Save*
 * button and therefore no way to leave the window holding unsaved state. The
 * "Saved" acknowledgement lives in the non-scrolling header, where it can
 * actually be seen (overhaul §4.7 — it used to fade in inside a scrolling
 * header).
 *
 * The layout is the grouped inset card macOS System Settings uses — label
 * left, control right, hairlines between rows — instead of one long web-form
 * column (overhaul §4.7). The explanatory prose stays, because it is honest
 * about settings that do less than their names suggest (spikes 2 and 3), but
 * moves behind ⓘ disclosures so the pane stops reading as documentation.
 * Where a note's content is *dynamic* — what retention will actually do —
 * it stays visible as a caption.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, LanguageMode } from '@contracts/config.js';
import { DEFAULT_CONFIG } from '@contracts/config.js';
import type { AuthStatus } from '@contracts/events.js';
import { KEYTERM_MAX_COUNT, KEYTERM_MAX_LENGTH } from '@shared/constants.js';
import { request } from './ipc.js';
import { InfoTip, PanelShell, Segmented, Switch } from './shell.js';
import { CheckIcon } from './icons.js';
import {
  describeRetention,
  formatKeyterms,
  parseBoundedInteger,
  parseKeyterms,
} from './validation.js';

const api = window.grokDictate;

const LANGUAGE_OPTIONS: readonly (readonly [LanguageMode, string])[] = [
  ['auto', 'Automatic'],
  ['de', 'Deutsch'],
  ['en', 'English'],
];

export function SettingsView(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keytermText, setKeytermText] = useState('');
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    void request({ type: 'get-config' }, 'config').then((outcome) => {
      if (!outcome.ok) {
        setLoadError(outcome.message);
        return;
      }
      setConfig(outcome.value.config);
      setKeytermText(formatKeyterms(outcome.value.config.keyterms));
    });
    void request({ type: 'get-auth-status' }, 'auth-status').then((outcome) => {
      if (outcome.ok) setAuth(outcome.value.status);
    });
    // The tray can change language and audio cues behind this window's back.
    return api.on((message) => {
      if (message.type === 'config-updated') setConfig(message.config);
      if (message.type === 'auth-updated') setAuth(message.status);
    });
  }, []);

  const save = useCallback((patch: Partial<AppConfig>, nextIssues: readonly string[] = []) => {
    setConfig((current) => {
      if (current === null) return current;
      const next = { ...current, ...patch };
      void request({ type: 'set-config', config: next }, 'config').then((outcome) => {
        // A rejected save must be visible: silently keeping the new value on
        // screen while the file still holds the old one is the worst outcome.
        setIssues(outcome.ok ? nextIssues : [`Not saved — ${outcome.message}`]);
      });
      return next;
    });
    setIssues(nextIssues);
    setSaved(true);
    window.setTimeout(() => setSaved(false), 1_200);
  }, []);

  if (loadError !== null) {
    return (
      <PanelShell title="Settings">
        <div className="issues" role="alert">
          <p>Could not load your settings: {loadError}</p>
          <p>
            Dictation still works — the defaults are in use. Restarting the app usually fixes it.
          </p>
        </div>
      </PanelShell>
    );
  }

  if (config === null) {
    return (
      <PanelShell title="Settings">
        <div className="empty-state">
          <p className="primary">Loading…</p>
        </div>
      </PanelShell>
    );
  }

  const keyterms = parseKeyterms(keytermText);

  return (
    <PanelShell
      title="Settings"
      accessory={
        <span className={`chip ok fade ${saved ? 'on' : ''}`} role="status">
          <CheckIcon size={11} />
          Saved
        </span>
      }
    >
      {issues.length === 0 ? null : (
        <div className="issues" role="status">
          {issues.map((issue) => (
            <p key={issue}>{issue}</p>
          ))}
        </div>
      )}

      <div className="group">
        <h2 className="group-title">Account</h2>
        <div className="card">
          <div className="card-row">
            <span className="row-label">{accountLabel(auth)}</span>
            <span className="control">
              {auth?.state === 'signed-in' && auth.source === 'api-key' ? (
                <button
                  type="button"
                  className="ghost destructive"
                  onClick={() => {
                    void request({ type: 'clear-api-key' }, 'auth-status').then((outcome) => {
                      if (outcome.ok) setAuth(outcome.value.status);
                    });
                  }}
                >
                  Sign out
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    api.send({ type: 'open-window', window: 'signin' });
                  }}
                >
                  Sign in…
                </button>
              )}
            </span>
          </div>
        </div>
        <p className="card-caption">
          An xAI API key is stored in the macOS Keychain. A Grok CLI login is read from
          ~/.grok/auth.json and is never written back.
        </p>
      </div>

      <div className="group">
        <h2 className="group-title">Dictation</h2>
        <div className="card">
          <div className="card-row">
            <span className="row-label">
              Language
              <InfoTip text="The server detects the language it hears and reports it back, so this is a preference rather than an override — English speech sent as German still came back as English in testing. Every transcript records the language that was actually detected." />
            </span>
            <span className="control">
              <Segmented
                options={LANGUAGE_OPTIONS}
                value={config.languageMode}
                onChange={(mode) => save({ languageMode: mode })}
                ariaLabel="Language preference"
              />
            </span>
          </div>
          <div className="card-row">
            <span className="row-label">
              Endpointing
              <InfoTip text="How long a pause has to be before the server cuts your dictation into a new segment. Each segment is transcribed on its own, so every cut is a chance to lose the word across it — shorter values mean more cuts and worse text. It does not delay your transcript when you let go of the key: measured, that is the same at 50 ms and at 2,000 ms." />
            </span>
            <span className="control">
              <input
                type="number"
                min={10}
                max={5_000}
                step={10}
                aria-label="Endpointing in milliseconds"
                defaultValue={config.endpointingMs}
                onBlur={(event) => {
                  const result = parseBoundedInteger(event.target.value, {
                    min: 10,
                    max: 5_000,
                    fallback: DEFAULT_CONFIG.endpointingMs,
                    label: 'Endpointing',
                  });
                  event.target.value = String(result.value);
                  save(
                    { endpointingMs: result.value },
                    result.issue === null ? [] : [result.issue],
                  );
                }}
              />
              <span className="unit">ms of silence</span>
            </span>
          </div>
          <div className="card-row">
            <span className="row-label">
              Repair segment joins
              <InfoTip text="A long dictation is cut into segments, each transcribed without seeing the one before it, which leaves a duplicated word, a capital letter mid-sentence, or a stray “Thank you.” where the two meet. This tidies those joins before the text is inserted. It is the only thing in the app that edits what you said — turn it off to get the transcript exactly as the server sent it." />
            </span>
            <Switch
              checked={config.repairSeams}
              onChange={(next) => save({ repairSeams: next })}
              ariaLabel="Repair the joins between transcript segments"
            />
          </div>
        </div>
      </div>

      <div className="group">
        <h2 className="group-title">Keyterms</h2>
        <div className="card">
          <div className="card-stack">
            <span className="row-label">
              One term per line
              <InfoTip text="Sent to the recogniser as hints. The most effective accuracy lever — product names and jargon a language setting will not fix." />
              <span className="spacer" />
              <span className="unit">
                {keyterms.terms.length} of {KEYTERM_MAX_COUNT}
              </span>
            </span>
            <textarea
              className="keyterms"
              spellCheck={false}
              aria-label="Keyterms, one per line"
              value={keytermText}
              placeholder={'kubectl\nVitest\nStaging-Server'}
              onChange={(event) => setKeytermText(event.target.value)}
              onBlur={() => {
                const parsed = parseKeyterms(keytermText);
                setKeytermText(formatKeyterms(parsed.terms));
                save({ keyterms: [...parsed.terms] }, parsed.issues);
              }}
            />
          </div>
        </div>
        <p className="card-caption">Up to {KEYTERM_MAX_LENGTH} characters each.</p>
      </div>

      <div className="group">
        <h2 className="group-title">Hotkeys</h2>
        <div className="card">
          <div className="card-row">
            <span className="row-label">Push to talk</span>
            <kbd>{config.hotkeys.ptt}</kbd>
          </div>
          <div className="card-row">
            <span className="row-label">Hands-free</span>
            <kbd>{config.hotkeys.toggle}</kbd>
          </div>
          <div className="card-row">
            <span className="row-label">Re-insert the last transcript</span>
            <kbd>{config.hotkeys.retry}</kbd>
          </div>
          <div className="card-row">
            <span className="row-label">Cancel</span>
            <kbd>esc</kbd>
          </div>
        </div>
        <p className="card-caption">Fixed in this version.</p>
      </div>

      <div className="group">
        <h2 className="group-title">History</h2>
        <div className="card">
          <div className="card-row">
            <span className="row-label">
              Keep for
              <InfoTip text="Everything you dictate is stored locally and is searchable, including anything said into a private context. The History window has a delete-everything button." />
            </span>
            <span className="control">
              <input
                type="number"
                min={0}
                max={3_650}
                aria-label="History retention in days"
                defaultValue={config.historyRetentionDays}
                onBlur={(event) => {
                  const result = parseBoundedInteger(event.target.value, {
                    min: 0,
                    max: 3_650,
                    fallback: DEFAULT_CONFIG.historyRetentionDays,
                    label: 'Retention',
                  });
                  event.target.value = String(result.value);
                  save(
                    { historyRetentionDays: result.value },
                    result.issue === null ? [] : [result.issue],
                  );
                }}
              />
              <span className="unit">days</span>
            </span>
          </div>
        </div>
        <p className="card-caption">
          {describeRetention(config.historyRetentionDays)} 0 keeps everything.
        </p>
      </div>

      <div className="group">
        <h2 className="group-title">General</h2>
        <div className="card">
          <div className="card-row">
            <span className="row-label">Audio cues when recording starts and stops</span>
            <Switch
              checked={config.audioCues}
              onChange={(next) => save({ audioCues: next })}
              ariaLabel="Audio cues when recording starts and stops"
            />
          </div>
          <div className="card-row">
            <span className="row-label">Open Grok Dictate at login</span>
            <Switch
              checked={config.launchAtLogin}
              onChange={(next) => save({ launchAtLogin: next })}
              ariaLabel="Open Grok Dictate at login"
            />
          </div>
          <div className="card-row">
            <span className="row-label">
              Keep the Grok CLI login signed in
              <InfoTip text="A Grok CLI login lasts a few hours. Rather than failing a dictation and asking you to run `grok` yourself, Grok Dictate runs `grok models` in the background shortly before the token expires and lets the CLI renew its own login. It never handles the token itself. Does nothing if you signed in with an xAI API key, which does not expire." />
            </span>
            <Switch
              checked={config.autoRenewLogin}
              onChange={(next) => save({ autoRenewLogin: next })}
              ariaLabel="Keep the Grok CLI login signed in"
            />
          </div>
        </div>
      </div>
    </PanelShell>
  );
}

function accountLabel(auth: AuthStatus | null): string {
  if (auth === null) return 'Checking login…';
  if (auth.state === 'expired') return 'Grok CLI login expired';
  if (auth.state === 'signed-out') return 'Not signed in';
  switch (auth.source) {
    case 'api-key':
      return 'Signed in with an xAI API key';
    case 'environment':
      return 'Signed in via XAI_API_KEY';
    case 'grok-cli':
      return 'Signed in via the Grok CLI';
  }
}
