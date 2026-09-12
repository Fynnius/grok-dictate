/**
 * OWNER: **Phase 4**; rebuilt by the design overhaul, session 1
 * (grok-dictate-design-overhaul-2026-08-09.md §16.3, geometry §15.1).
 *
 * The two stacked pills the user actually sees. The decisions live in
 * `presentation.ts` (pure, unit-tested); this file is markup and event wiring.
 *
 * Load-bearing, not decorative:
 *
 *   - **`installCuePlayer()` below is the app's entire sound system** (overhaul
 *     §4.14, §12.9). `src/main/sound/` plays every start/stop/error cue by
 *     `executeJavaScript` into THIS renderer against `window.__grokDictateCues`.
 *     Removing the call deletes all audio with no build error, no failing test
 *     and no visible symptom. It survives every rewrite of this file.
 *   - Insert outcomes are wordless. The transcript lives in History; ⌃⌘V
 *     re-inserts it. *Copy* in History (and the menu-bar History submenu) is
 *     the **only** route to the pasteboard, and it exists solely because the
 *     user clicked it.
 */

import { StrictMode, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { HudView } from '@contracts/events.js';
import { installCuePlayer } from './cues.js';
import { present, type HudActionId, type HudPresentation, type HudTone } from './presentation.js';
import { BAR_COUNT, barScale, DELAY_MS, ENVELOPE, LevelHistory, loudness } from './waveform.js';
import './hud.css';

const api = window.grokDictate;

/** Clicks shorter than this (screen px) on an error pill dismiss; longer drags. */
const DRAG_SLOP_PX = 4;

type ChromeHandlers = {
  onPointerEnter: () => void;
  onPointerLeave: (event: React.PointerEvent) => void;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent) => void;
  onPointerUp: (event: React.PointerEvent) => void;
  onPointerCancel: (event: React.PointerEvent) => void;
};

function isNoDragTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('button, .no-drag') !== null;
}

function isHudChrome(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('.capsule, .message') !== null;
}

function runAction(id: HudActionId, text: string | null): void {
  switch (id) {
    case 'copy':
      //  — the one sanctioned pasteboard write, from a click.
      if (text !== null) api.send({ type: 'copy', text });
      return;
    case 'retry':
      api.send({ type: 'retry-insert' });
      return;
    case 'dismiss':
      // Offered only if a presentation still carries a Dismiss action.
      api.send({ type: 'dismiss-hud' });
      return;
  }
}

/**
 * The ten bars. The maths is in `waveform.ts`; this is the loop that runs it.
 *
 * The level arrives ten times a second, but the bars are redrawn on every
 * animation frame: the follower keeps moving between packets and each bar reads
 * the level from `DELAY_MS[i]` ago, so a syllable travels outward from the
 * centre instead of all ten bars twitching at once (§19.1 — the fix for "I
 * speak normally and they don't move properly").
 *
 * `transform` is written straight to the DOM rather than through React state.
 * At 60 fps a re-render per frame would be 600 reconciliations a second for a
 * decoration — and the capsule is on screen while the user's own typing target
 * is the thing that must stay responsive.
 */
function Waveform({ level }: { level: number }): React.JSX.Element {
  const bars = useRef<(HTMLSpanElement | null)[]>([]);
  // The loop reads the newest level through a ref, so a level packet ten times
  // a second does not tear down and rebuild the animation.
  const latest = useRef(0);
  useEffect(() => {
    latest.current = level;
  }, [level]);

  useEffect(() => {
    // §11.1.13: with reduced motion the CSS pins the bars to a constant dash,
    // and it does it with `!important` — an inline transform could not win
    // anyway, so the loop simply does not run.
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const history = new LevelHistory();
    let frame = 0;
    let last = performance.now();

    const tick = (now: number): void => {
      const dt = now - last;
      last = now;
      history.advance(dt, loudness(latest.current));
      for (let i = 0; i < BAR_COUNT; i++) {
        const bar = bars.current[i];
        if (bar)
          bar.style.transform = `scaleY(${String(barScale(i, history.at(DELAY_MS[i] ?? 0), now / 1000))})`;
      }
      frame = requestAnimationFrame(tick);
    };

    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <span className="bars" aria-hidden="true">
      {ENVELOPE.map((_, i) => (
        <span
          // The envelope is positional and the list never reorders.
          key={i}
          className="bar"
          ref={(node) => {
            bars.current[i] = node;
          }}
        />
      ))}
    </span>
  );
}

/** The macOS-style 8-spoke spinner, white at ~60% (overhaul §16.7 on §9.5). */
function Spinner(): React.JSX.Element {
  return (
    <svg className="spinner" viewBox="0 0 16 16" aria-hidden="true">
      {Array.from({ length: 8 }, (_, i) => (
        <rect
          // Spokes are positional by construction.
          key={i}
          x="7.3"
          y="1"
          width="1.4"
          height="4.2"
          rx="0.7"
          transform={`rotate(${String(i * 45)} 8 8)`}
          opacity={(i + 1) / 8}
        />
      ))}
    </svg>
  );
}

/** The animated green check for `inserted` — draws itself on mount. */
function Check(): React.JSX.Element {
  return (
    <svg className="check" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M5.5 12.5l4.5 4.5 8.5-9.5"
        pathLength={1}
        fill="none"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Red gets an exclamation, amber a lock — the words are in the message pill. */
function AlertGlyph({ tone }: { tone: HudTone }): React.JSX.Element {
  if (tone === 'warning') {
    return (
      <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5.5" y="10.5" width="13" height="9" rx="2" fill="none" strokeWidth="2" />
        <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" strokeWidth="2" />
      </svg>
    );
  }
  return (
    <svg className="glyph" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5.5v8" strokeWidth="2.4" strokeLinecap="round" />
      <circle cx="12" cy="17.75" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

/**
 * The bottom capsule — the app's permanent grammar (§16.3): one shape, always
 * in the same place, whose contents carry the state.
 */
function capsuleClass(base: string, dragging: boolean): string {
  return dragging ? `${base} is-dragging` : base;
}

function Capsule({
  view,
  p,
  dragging,
  chrome,
}: {
  view: HudView;
  p: HudPresentation;
  dragging: boolean;
  chrome: ChromeHandlers;
}): React.JSX.Element | null {
  const capsule = p.capsule;
  if (capsule === null) return null;

  switch (capsule.kind) {
    case 'waveform': {
      const level = view.kind === 'recording' ? view.level : 0;
      const live = p.liveText;
      if (!capsule.buttons) {
        return (
          <div
            className={capsuleClass(
              `capsule is-hold${live === null ? '' : ' is-live'} tone-${p.tone}`,
              dragging,
            )}
            {...chrome}
          >
            <Waveform level={level} />
            {live === null ? null : <span className="live-text">{live}</span>}
          </div>
        );
      }
      // Hands-free: ✕ discards the turn, ✓ ends it and transcribes. These are
      // real buttons (§16.5c) — hands-free is exactly the mode where a hand is
      // free to click, and the window takes the mouse only in this mode.
      // `no-drag` + stopPropagation: a press on ✕/✓ must not start a window drag.
      return (
        <div
          className={capsuleClass(
            `capsule is-toggle${live === null ? '' : ' is-live'} tone-${p.tone}`,
            dragging,
          )}
          {...chrome}
        >
          <button
            type="button"
            className="round cancel no-drag"
            aria-label="Cancel dictation"
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={() => {
              api.send({ type: 'cancel' });
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7.5 7.5l9 9m0-9l-9 9" strokeWidth="2.4" strokeLinecap="round" />
            </svg>
          </button>
          <Waveform level={level} />
          {live === null ? null : <span className="live-text">{live}</span>}
          <button
            type="button"
            className="round confirm no-drag"
            aria-label="Stop and insert"
            onPointerDown={(event) => {
              event.stopPropagation();
            }}
            onClick={() => {
              api.send({ type: 'stop-recording' });
            }}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path
                d="M6.5 12.5l4 4 7-8.5"
                fill="none"
                strokeWidth="2.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      );
    }
    case 'processing':
      return (
        <div
          className={capsuleClass(
            `capsule is-processing${p.liveText === null ? '' : ' is-live'}`,
            dragging,
          )}
          {...chrome}
        >
          <Waveform level={0} />
          {p.liveText === null ? null : <span className="live-text">{p.liveText}</span>}
          <Spinner />
        </div>
      );
    case 'check':
      return (
        <div className={capsuleClass('capsule is-check', dragging)} {...chrome}>
          <Check />
        </div>
      );
    case 'alert':
      return (
        <div className={capsuleClass(`capsule is-alert tone-${p.tone}`, dragging)} {...chrome}>
          <AlertGlyph tone={p.tone} />
        </div>
      );
  }
}

function Hud(): React.JSX.Element | null {
  const [view, setView] = useState<HudView>({ kind: 'hidden' });
  const [dragging, setDragging] = useState(false);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const dragMoved = useRef(false);

  useEffect(
    () =>
      api.on((message) => {
        if (message.type === 'hud') setView(message.view);
      }),
    [],
  );

  const chrome: ChromeHandlers = {
    onPointerEnter: () => {
      api.send({ type: 'hud-pointer', phase: 'enter' });
    },
    onPointerLeave: (event) => {
      if (dragStart.current !== null) return;
      if (isHudChrome(event.relatedTarget)) return;
      api.send({ type: 'hud-pointer', phase: 'leave' });
    },
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      if (isNoDragTarget(event.target)) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      dragStart.current = { x: event.screenX, y: event.screenY };
      dragMoved.current = false;
    },
    onPointerMove: (event) => {
      const start = dragStart.current;
      if (start === null) return;
      if (!dragMoved.current) {
        if (Math.hypot(event.screenX - start.x, event.screenY - start.y) < DRAG_SLOP_PX) return;
        // Start the drag from the original press, not this sample, so the
        // first move is not short by the slop.
        dragMoved.current = true;
        setDragging(true);
        api.send({ type: 'hud-drag-start', screenX: start.x, screenY: start.y });
      }
      api.send({ type: 'hud-drag-move', screenX: event.screenX, screenY: event.screenY });
    },
    onPointerUp: (event) => {
      if (dragStart.current === null) return;
      const moved = dragMoved.current;
      dragStart.current = null;
      setDragging(false);
      if (moved) {
        api.send({ type: 'hud-drag-end' });
      } else if (view.kind === 'error') {
        api.send({ type: 'dismiss-hud' });
      }
      const under = document.elementFromPoint(event.clientX, event.clientY);
      if (!isHudChrome(under)) {
        api.send({ type: 'hud-pointer', phase: 'leave' });
      }
    },
    onPointerCancel: (event) => {
      if (dragStart.current === null) return;
      const moved = dragMoved.current;
      dragStart.current = null;
      setDragging(false);
      if (moved) api.send({ type: 'hud-drag-end' });
      const under = document.elementFromPoint(event.clientX, event.clientY);
      if (!isHudChrome(under)) {
        api.send({ type: 'hud-pointer', phase: 'leave' });
      }
    },
  };

  if (view.kind === 'hidden') return null;
  const p = present(view);
  const m = p.message;
  const messageClass = [
    'message',
    `tone-${p.tone}`,
    view.kind === 'error' ? 'is-error' : '',
    dragging ? 'is-dragging' : '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return (
    <div className="hud" role="status" aria-label={p.label}>
      {m === null ? null : (
        <div className={messageClass} {...chrome}>
          <div className="message-title">{m.title}</div>
          {m.body === null ? null : <div className="message-body">{m.body}</div>}
          {m.detail === null ? null : <div className="message-detail">{m.detail}</div>}
          {m.actions.length === 0 ? null : (
            <div className="actions">
              {m.actions.map((action) => (
                <button
                  key={action.id}
                  type="button"
                  className={action.id === 'dismiss' ? 'quiet no-drag' : 'no-drag'}
                  onPointerDown={(event) => {
                    event.stopPropagation();
                  }}
                  onClick={() => {
                    runAction(action.id, m.body);
                  }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <Capsule view={view} p={p} dragging={dragging} chrome={chrome} />
    </div>
  );
}

// The app's entire sound system reaches the speakers through this call — see
// the header. Do not remove it; nothing would fail visibly if you did.
installCuePlayer();

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <Hud />
    </StrictMode>,
  );
}
