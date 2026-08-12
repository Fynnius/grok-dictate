import { useEffect, useState } from 'react';
import type { AuthStatus } from '@contracts/events.js';
import { XAI_CONSOLE_API_KEYS_URL, XAI_STT_DOCS_URL } from '@shared/constants.js';
import { request } from '../settings/ipc.js';

const api = window.grokDictate;

function statusCopy(status: AuthStatus): { kind: 'ok' | 'warn' | 'idle'; text: string } {
  if (status.state === 'expired') {
    return {
      kind: 'warn',
      text: 'Your Grok CLI login has expired. Paste an API key, or run `grok` in a terminal.',
    };
  }
  if (status.state === 'signed-out') return { kind: 'idle', text: '' };
  switch (status.source) {
    case 'api-key':
      return { kind: 'ok', text: 'Signed in with an xAI API key.' };
    case 'environment':
      return { kind: 'ok', text: 'Signed in via the XAI_API_KEY environment variable.' };
    case 'grok-cli':
      return { kind: 'ok', text: 'Signed in via the Grok CLI. You can start dictating.' };
  }
}

export function SignInView(): React.JSX.Element {
  const [status, setStatus] = useState<AuthStatus | null>(null);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void request({ type: 'get-auth-status' }, 'auth-status').then((outcome) => {
      if (outcome.ok) setStatus(outcome.value.status);
      else setError(outcome.message);
    });
    return api.on((message) => {
      if (message.type === 'auth-updated') setStatus(message.status);
    });
  }, []);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const outcome = await request({ type: 'set-api-key', key }, 'auth-status');
    setBusy(false);
    if (!outcome.ok) {
      setError(outcome.message);
      return;
    }
    setKey('');
    setStatus(outcome.value.status);
  };

  const openConsole = (event: React.MouseEvent<HTMLAnchorElement>, url: string): void => {
    event.preventDefault();
    void request({ type: 'open-external', url }, 'ok');
  };

  const copy = status === null ? null : statusCopy(status);
  const alreadyIn = status?.state === 'signed-in';

  return (
    <main className="panel signin">
      <header className="panel-head">
        <h1>Sign in</h1>
      </header>
      <div className="panel-body">
        <p className="signin-lead">
          Grok Dictate sends audio to xAI&apos;s streaming speech-to-text API. Paste an API key from
          your xAI console — or use an existing Grok CLI login.
        </p>

        {copy !== null && copy.kind !== 'idle' ? (
          <p className={`signin-status ${copy.kind}`} role="status">
            {copy.text}
          </p>
        ) : null}

        {error !== null ? (
          <div className="issues" role="alert">
            <p>{error}</p>
          </div>
        ) : null}

        {alreadyIn ? (
          <p className="signin-lead">You can close this window and hold Fn to dictate.</p>
        ) : (
          <>
            <label className="field">
              xAI API key
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                placeholder="xai-…"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                }}
              />
            </label>
            <div className="actions">
              <button type="button" className="primary" disabled={busy} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save and continue'}
              </button>
              <a
                href={XAI_CONSOLE_API_KEYS_URL}
                onClick={(event) => openConsole(event, XAI_CONSOLE_API_KEYS_URL)}
              >
                Get an API key from the xAI console
              </a>
            </div>
          </>
        )}

        <div className="alt">
          <p>
            Already signed in to the Grok CLI? Grok Dictate reads <code>~/.grok/auth.json</code> and
            will not ask again.
          </p>
          <p>
            The key is stored in the macOS Keychain via Electron safeStorage. It is never logged.{' '}
            <a href={XAI_STT_DOCS_URL} onClick={(event) => openConsole(event, XAI_STT_DOCS_URL)}>
              Speech-to-text docs
            </a>
          </p>
        </div>
      </div>
    </main>
  );
}
