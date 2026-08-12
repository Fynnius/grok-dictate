/**
 * OWNER: Design overhaul 2026-08-09 (session 2). The Scratchpad
 *.
 *
 * A **real focusable window** holding the last transcript, so the text can be
 * selected and edited rather than only looked at — that is the whole
 * difference from the HUD pill, which can never take focus. This is the
 * tier-3 surface when insertion has failed and the user needs the words out
 * by hand.
 *
 * The design is no visible chrome at all (overhaul §11.1.7): the window *is*
 * the text — no textarea border, no focus ring (the window frame already
 * signals focus) — with a footer carrying the actions.
 *
 * *Insert* is gone (overhaul §4.4, §16.2). It typed into whatever app was
 * frontmost *now*, and pressing the button made that this window — the
 * "about to click into the app they actually want it in" sequence the
 * Phase 4 docstring imagined runs backwards. Copy is the coherent action
 * from a focused window, and remains the product's only route to the
 * pasteboard; ⌃⌘V from inside the target app re-types the
 * original.
 */

import { useEffect, useRef, useState } from 'react';
import { request } from './ipc.js';
import { PanelShell } from './shell.js';
import { CheckIcon, CopyIcon } from './icons.js';

const api = window.grokDictate;

export function ScratchpadView(): React.JSX.Element {
  const [original, setOriginal] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const editedRef = useRef(false);

  useEffect(() => {
    const load = (): void => {
      void request({ type: 'get-snapshot' }, 'snapshot').then((outcome) => {
        if (!outcome.ok) {
          setLoadError(outcome.message);
          return;
        }
        setLoadError(null);
        const latest = outcome.value.snapshot.lastTranscript;
        setOriginal(latest);
        // Never overwrite something the user is in the middle of editing.
        if (!editedRef.current) setText(latest ?? '');
      });
    };
    load();
    return api.on((message) => {
      if (message.type === 'hud') load();
    });
  }, []);

  const dirty = original !== null && text !== original;

  return (
    <PanelShell
      title="Scratchpad"
      className="scratchpad"
      accessory={dirty ? <span className="chip">Edited</span> : undefined}
      footer={
        original === null ? undefined : (
          <>
            <p className="note">
              {dirty
                ? 'Copy uses what you see; Revert puts the original back.'
                : 'The last transcript. Edit it here, or press ⌃⌘V in any app to type the original again.'}
            </p>
            {dirty ? (
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  editedRef.current = false;
                  setText(original);
                }}
              >
                Revert
              </button>
            ) : null}
            <button
              type="button"
              className="labelled"
              onClick={() => {
                // : the pasteboard is written here and nowhere
                // else that the user did not click.
                api.send({ type: 'copy', text });
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1_200);
              }}
            >
              {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </>
        )
      }
    >
      {loadError !== null ? (
        <div className="issues" role="alert">
          <p>Could not read the last transcript: {loadError}</p>
        </div>
      ) : original === null ? (
        <div className="empty-state">
          <p className="primary">Nothing dictated yet</p>
          <p className="secondary">The last transcript lands here, ready to edit.</p>
        </div>
      ) : (
        <textarea
          className="pad"
          value={text}
          spellCheck={false}
          autoFocus
          aria-label="Last transcript"
          onChange={(event) => {
            editedRef.current = true;
            setText(event.target.value);
          }}
        />
      )}
    </PanelShell>
  );
}
