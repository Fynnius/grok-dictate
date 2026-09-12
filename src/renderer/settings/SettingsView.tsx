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
 * Where a note's content is *dynamic* — which login dictation will actually
 * use — it stays visible as a caption.
 */

import { useCallback, useEffect, useState } from 'react';
import type { AppConfig, LanguageMode, SttModel } from '@contracts/config.js';
import { DEFAULT_CONFIG } from '@contracts/config.js';
import type { AuthStatus, CliAuthStatus } from '@contracts/events.js';
import { KEYTERM_MAX_COUNT, KEYTERM_MAX_LENGTH } from '@shared/constants.js';
import { request } from './ipc.js';
import { InfoTip, PanelShell, Segmented, Switch } from './shell.js';
import { CheckIcon } from './icons.js';
import { formatKeyterms, parseBoundedInteger, parseKeyterms } from './validation.js';

const api = window.grokDictate;

const LANGUAGE_OPTIONS: readonly (readonly [LanguageMode, string])[] = [
  ['auto', 'Automatic'],
  ['de', 'Deutsch'],
  ['en', 'English'],
];

const STT_MODEL_OPTIONS: readonly (readonly [SttModel, string])[] = [
  ['grok-stt', 'Standard'],
  ['grok-stt-2-fast', 'STT 2 Fast'],
];

/**
 * `Automatic` first because it is the default and the one most people should
 * leave alone; `Typing` last because it is the escape hatch, not the goal.
 */
const INSERT_METHOD_OPTIONS: readonly (readonly [AppConfig['insertMethod'], string])[] = [
  ['auto', 'Automatic'],
  ['paste', 'Pasting'],
  ['type', 'Typing'],
];

export function SettingsView(): React.JSX.Element {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [cli, setCli] = useState<CliAuthStatus | null>(null);
  const [cliBinaryFound, setCliBinaryFound] = useState(true);
  const [cliLoginWaiting, setCliLoginWaiting] = useState(false);
  const [cliRenewWaiting, setCliRenewWaiting] = useState(false);
  const [grokComSignedIn, setGrokComSignedIn] = useState<boolean | null>(null);
  const [chromePasskeyWaiting, setChromePasskeyWaiting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [keytermText, setKeytermText] = useState('');
  const [issues, setIssues] = useState<readonly string[]>([]);
  const [saved, setSaved] = useState(false);

  const applyCliStatus = useCallback((status: CliAuthStatus, binaryFound: boolean) => {
    setCli(status);
    setCliBinaryFound(binaryFound);
  }, []);

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
    void request({ type: 'get-cli-status' }, 'cli-status').then((outcome) => {
      if (outcome.ok) applyCliStatus(outcome.value.status, outcome.value.binaryFound);
    });
    void request({ type: 'get-grok-com-status' }, 'grok-com-status').then((outcome) => {
      if (outcome.ok) setGrokComSignedIn(outcome.value.signedIn);
    });
    // The tray can change language and audio cues behind this window's back.
    return api.on((message) => {
      if (message.type === 'config-updated') setConfig(message.config);
      if (message.type === 'auth-updated') {
        setAuth(message.status);
        void request({ type: 'get-cli-status' }, 'cli-status').then((outcome) => {
          if (outcome.ok) applyCliStatus(outcome.value.status, outcome.value.binaryFound);
        });
      }
      if (message.type === 'grok-com-updated') setGrokComSignedIn(message.signedIn);
    });
  }, [applyCliStatus]);

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
  const apiKeySignedIn = auth?.state === 'signed-in' && auth.source === 'api-key';

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
            <span className="row-label">xAI API key</span>
            <span className="control">
              {auth === null ? (
                <span className="unit">Checking…</span>
              ) : apiKeySignedIn ? (
                <>
                  <span className="chip ok">Signed in</span>
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
                </>
              ) : (
                <>
                  <span className="chip">Not signed in</span>
                  <button
                    type="button"
                    onClick={() => {
                      api.send({ type: 'open-window', window: 'signin' });
                    }}
                  >
                    Sign in…
                  </button>
                </>
              )}
            </span>
          </div>
          <div className="card-row">
            <span className="row-label">
              grok.com
              <InfoTip text="STT 2 Fast talks to grok.com with this login, not the xAI API key. The in-app window cannot use macOS iCloud passkeys — Electron is not Safari. Passkeys (Chrome) opens a real Chrome window where those passkeys work, then copies only grok.com cookies back here." />
            </span>
            <span className="control">
              {grokComSignedIn === null ? (
                <span className="unit">Checking…</span>
              ) : grokComSignedIn ? (
                <>
                  <span className="chip ok">Signed in</span>
                  <button
                    type="button"
                    className="ghost destructive"
                    onClick={() => {
                      void request({ type: 'grok-com-sign-out' }, 'grok-com-status').then(
                        (outcome) => {
                          if (outcome.ok) setGrokComSignedIn(outcome.value.signedIn);
                        },
                      );
                    }}
                  >
                    Sign out
                  </button>
                </>
              ) : chromePasskeyWaiting ? (
                <span className="unit">Waiting for Chrome…</span>
              ) : (
                <>
                  <span className="chip">Not signed in</span>
                  <button
                    type="button"
                    onClick={() => {
                      api.send({ type: 'open-window', window: 'grok-com-signin' });
                    }}
                  >
                    Sign in…
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setChromePasskeyWaiting(true);
                      void request({ type: 'grok-com-passkey-signin' }, 'grok-com-status').then(
                        (outcome) => {
                          setChromePasskeyWaiting(false);
                          if (outcome.ok) setGrokComSignedIn(outcome.value.signedIn);
                          else setIssues([`Passkey sign-in — ${outcome.message}`]);
                        },
                      );
                    }}
                  >
                    Passkeys (Chrome)…
                  </button>
                </>
              )}
            </span>
          </div>
          <div className="card-row">
            <span className="row-label">
              Grok CLI
              <InfoTip text="Sign in opens Terminal and runs `grok login`. Grok Dictate reads ~/.grok/auth.json and never writes it, so there is no Sign out here — that file belongs to the Grok CLI." />
            </span>
            <span className="control">
              {cliRowControls({
                cli,
                binaryFound: cliBinaryFound,
                waiting: cliLoginWaiting,
                renewing: cliRenewWaiting,
                onSignIn: () => {
                  setCliLoginWaiting(true);
                  setIssues([]);
                  void request({ type: 'start-grok-cli-login' }, 'cli-status').then((outcome) => {
                    setCliLoginWaiting(false);
                    if (outcome.ok) applyCliStatus(outcome.value.status, outcome.value.binaryFound);
                    else setIssues([outcome.message]);
                  });
                },
                onCancel: () => {
                  void request({ type: 'cancel-grok-cli-login' }, 'cli-status').then((outcome) => {
                    setCliLoginWaiting(false);
                    if (outcome.ok) applyCliStatus(outcome.value.status, outcome.value.binaryFound);
                  });
                },
                onRenew: () => {
                  setCliRenewWaiting(true);
                  setIssues([]);
                  void request({ type: 'renew-cli-login' }, 'cli-status').then((outcome) => {
                    setCliRenewWaiting(false);
                    if (!outcome.ok) {
                      setIssues([outcome.message]);
                      return;
                    }
                    applyCliStatus(outcome.value.status, outcome.value.binaryFound);
                    if (outcome.value.status.state !== 'signed-in') {
                      setIssues([
                        'The Grok CLI could not renew the login. Try Sign in… which opens Terminal.',
                      ]);
                    }
                  });
                },
              })}
            </span>
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
        <p className="card-caption">{dictationSourceCaption(auth)}</p>
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
              Speech model
              <InfoTip text="Standard uses the xAI API. STT 2 Fast needs the grok.com login under Account." />
            </span>
            <span className="control">
              <Segmented
                options={STT_MODEL_OPTIONS}
                value={config.sttModel ?? 'grok-stt'}
                onChange={(model) => save({ sttModel: model })}
                ariaLabel="Speech recognition model"
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
              Ignore accidental taps
              <InfoTip text="A brushed Fn key used to open a socket, ship a sliver of room tone, and show a failure. On, a short tap that is measurably silent is dropped without waiting on the server. Real one-word dictations — yes, no, OK — are kept. Off sends every release to the recogniser." />
            </span>
            <Switch
              checked={config.silenceGate}
              onChange={(next) => save({ silenceGate: next })}
              ariaLabel="Ignore accidental silent taps"
            />
          </div>
          <div className="card-row">
            <span className="row-label">
              Repair segment joins
              <InfoTip text="A long dictation is cut into segments, each transcribed without seeing the one before it, which leaves a duplicated word, a capital letter mid-sentence, a stray “Thank you.”, or a pause punctuated as “. ,”. This tidies those before the text is inserted. It is the only thing in the app that edits what you said — turn it off to get the transcript exactly as the server sent it." />
            </span>
            <Switch
              checked={config.repairSeams}
              onChange={(next) => save({ repairSeams: next })}
              ariaLabel="Repair the joins between transcript segments"
            />
          </div>
          <div className="card-row">
            <span className="row-label">
              Microphone processing
              <InfoTip text="Chromium echo cancellation, noise suppression and auto-gain. Tuned for phone calls, not dictation. Off by default. Has no effect when the app is using native capture." />
            </span>
            <Switch
              checked={config.micProcessing}
              onChange={(next) => save({ micProcessing: next })}
              ariaLabel="Microphone echo cancellation and noise suppression"
            />
          </div>
          <div className="card-row">
            <span className="row-label">
              Insert text by
              <InfoTip text="Pasting is fast whatever the length, and it is the only thing that reliably works in a terminal — but it replaces whatever is on your clipboard, every time, and does not put it back. Typing leaves your clipboard alone and is instant for a short reply, but it types one character at a time, so a long dictation visibly streams in and some apps drop it. Automatic pastes long text and terminals, types everything else." />
            </span>
            <span className="control">
              <Segmented
                options={INSERT_METHOD_OPTIONS}
                value={config.insertMethod}
                onChange={(method) => save({ insertMethod: method })}
                ariaLabel="How text is inserted into other applications"
              />
            </span>
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
        <p className="card-caption">
          Transcripts stay until you delete them. Audio is kept for one day so a recording can be
          retried.
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
            <span className="row-label">
              Mute other audio while recording
              <InfoTip text="Mutes system output while the microphone is open and restores it when you stop — including on Esc, errors, and quit. Your podcast keeps playing; you just do not hear it over yourself. Does not pause other apps. Off leaves the volume alone." />
            </span>
            <Switch
              checked={config.muteWhileRecording}
              onChange={(next) => save({ muteWhileRecording: next })}
              ariaLabel="Mute other audio while recording"
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
        </div>
      </div>
    </PanelShell>
  );
}

function dictationSourceCaption(auth: AuthStatus | null): string {
  const grokCom = 'grok.com is only for STT 2 Fast.';
  if (auth === null) return `Checking which login dictation will use… ${grokCom}`;
  if (auth.state === 'signed-out') {
    return `Dictation has no login yet. Add an xAI API key or a Grok CLI login. ${grokCom}`;
  }
  if (auth.state === 'expired') {
    return `Dictation will use the Grok CLI login once it is renewed. ${grokCom}`;
  }
  switch (auth.source) {
    case 'api-key':
      return `Dictation will use the xAI API key. ${grokCom}`;
    case 'environment':
      return `Dictation will use XAI_API_KEY from the environment. ${grokCom}`;
    case 'grok-cli':
      return `Dictation will use the Grok CLI login. ${grokCom}`;
  }
}

function formatExpiryClock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

function cliRowControls({
  cli,
  binaryFound,
  waiting,
  renewing,
  onSignIn,
  onCancel,
  onRenew,
}: {
  readonly cli: CliAuthStatus | null;
  readonly binaryFound: boolean;
  readonly waiting: boolean;
  readonly renewing: boolean;
  readonly onSignIn: () => void;
  readonly onCancel: () => void;
  readonly onRenew: () => void;
}): React.JSX.Element {
  if (cli === null) return <span className="unit">Checking…</span>;
  if (waiting) {
    return (
      <>
        <span className="unit">Waiting for Terminal…</span>
        <button type="button" className="ghost" onClick={onCancel}>
          Cancel
        </button>
      </>
    );
  }
  if (cli.state === 'signed-in') {
    const clock = formatExpiryClock(cli.expiresAt);
    return (
      <>
        <span className="chip ok">Signed in</span>
        {clock.length > 0 ? <span className="unit">Expires {clock}</span> : null}
      </>
    );
  }
  if (cli.state === 'expired') {
    return (
      <>
        <span className="chip">Expired</span>
        <button type="button" disabled={renewing} onClick={onRenew}>
          {renewing ? 'Refreshing…' : 'Refresh now'}
        </button>
        <button type="button" onClick={onSignIn}>
          Sign in…
        </button>
      </>
    );
  }
  return (
    <>
      <span className="chip">{binaryFound ? 'Not signed in' : 'CLI not found'}</span>
      <button type="button" onClick={onSignIn}>
        Sign in…
      </button>
    </>
  );
}
