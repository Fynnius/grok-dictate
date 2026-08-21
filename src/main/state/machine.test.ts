import { describe, expect, it } from 'vitest';
import type { InsertOutcome } from '@contracts/ports.js';
import { appError } from '@shared/result.js';
import {
  INITIAL_SNAPSHOT,
  committedText,
  reduce,
  type Effect,
  type MachineEnv,
  type SessionEvent,
  type Snapshot,
} from './machine.js';

/** Deterministic environment: ids are s1, s2, … and the clock ticks 1000 ms. */
function testEnv(): MachineEnv {
  let n = 0;
  let t = 1_000_000;
  return {
    newSessionId: () => `s${String(++n)}`,
    now: () => (t += 1000),
  };
}

interface Run {
  snapshot: Snapshot;
  effects: Effect[];
  /** Every effect emitted across the whole run, for invariant checks. */
  all: Effect[];
}

/** Drive a sequence of events, threading the snapshot. */
function run(events: readonly SessionEvent[], env = testEnv(), from = INITIAL_SNAPSHOT): Run {
  let snapshot = from;
  let effects: Effect[] = [];
  const all: Effect[] = [];
  for (const event of events) {
    const stepped = reduce(snapshot, event, env);
    snapshot = stepped.snapshot;
    effects = [...stepped.effects];
    all.push(...stepped.effects);
  }
  return { snapshot, effects, all };
}

const inserts = (effects: readonly Effect[]): Extract<Effect, { type: 'insert' }>[] =>
  effects.filter((e): e is Extract<Effect, { type: 'insert' }> => e.type === 'insert');
const histories = (effects: readonly Effect[]): Extract<Effect, { type: 'history_append' }>[] =>
  effects.filter(
    (e): e is Extract<Effect, { type: 'history_append' }> => e.type === 'history_append',
  );
const huds = (effects: readonly Effect[]): Extract<Effect, { type: 'hud' }>[] =>
  effects.filter((e): e is Extract<Effect, { type: 'hud' }> => e.type === 'hud');
const kinds = (effects: readonly Effect[]): string[] => effects.map((e) => e.type);

/**
 * A confirmed insert, as the helper reports one. `verified: true` is not
 * decoration: since the 2026-08-09 incident, `ok: true` on its own means
 * "posted", and only this shape renders the bare green check.
 */
const CONFIRMED: InsertOutcome = { tier: 'ax', ok: true, error: null, verified: true };

/** The happy path: press, speak, release, final, turn ends, insert. */
const HAPPY: readonly SessionEvent[] = [
  { type: 'PTT_DOWN', ts: 1 },
  { type: 'FRONTMOST', sessionId: 's1', app: { bundleId: 'com.microsoft.VSCode', name: 'Code' } },
  { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'hello' },
  { type: 'PTT_UP', ts: 2 },
  { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Hello there, this is a test.' },
  { type: 'TURN_ENDED', sessionId: 's1', durationSec: 3.1 },
  { type: 'INSERT_RESULT', sessionId: 's1', outcome: CONFIRMED },
];

/**
 * The prefix of `HAPPY` that ends in `inserting`, with the insert dispatched
 * and no result yet.
 *
 * A named constant rather than `HAPPY.slice(0, 5)`: the insert now fires on
 * `TURN_ENDED` rather than on the first `TRANSCRIPT_FINAL` (2026-08-09
 * incident, BUG-4), so the index moved and a slice would have moved silently
 * with it.
 */
const TO_INSERTING: readonly SessionEvent[] = HAPPY.slice(0, 6);

describe('happy path', () => {
  it('walks idle → recording → processing → inserting → idle', () => {
    const env = testEnv();
    let snapshot = INITIAL_SNAPSHOT;
    const states: string[] = [];
    for (const event of HAPPY) {
      snapshot = reduce(snapshot, event, env).snapshot;
      // Consecutive repeats collapsed: this test is about the *route*, and
      // which event inside `processing` finally dispatches the insert is
      // pinned separately (see "the insert waits for transcript.done").
      if (states.at(-1) !== snapshot.state) states.push(snapshot.state);
    }
    expect(states).toEqual(['recording', 'processing', 'inserting', 'idle']);
  });

  it('opens the mic and the socket concurrently on ptt_down, with no delay', () => {
    // : a disambiguation delay before opening the mic
    // clips the first word. Both effects must be in the same step.
    const { effects } = run([{ type: 'PTT_DOWN', ts: 1 }]);
    expect(kinds(effects)).toEqual([
      'request_frontmost',
      'start_capture',
      'start_stt',
      'hud',
      'tray',
      'cue',
    ]);
  });

  it('inserts the speech_final text wherever the user is pointing at the end', () => {
    // `targetBundleId: null` disables the helper's frontmost check. Phase 5
    // reversed  at the user's direction — "i want to start
    // wherever i want and then paste it somewhere i release or toggle" — which
    // is the natural reading of hands-free mode and the rule ⌃⌘V always had.
    // See `beginInsert` for what that gives up.
    const { all } = run(HAPPY);
    expect(inserts(all)).toEqual([
      {
        type: 'insert',
        sessionId: 's1',
        text: 'Hello there, this is a test.',
        targetBundleId: null,
      },
    ]);
  });

  it('records history and shows the full transcript after a successful insert', () => {
    const { all, snapshot } = run(HAPPY);
    expect(histories(all)[0]?.entry).toMatchObject({
      text: 'Hello there, this is a test.',
      frontmostBundleId: 'com.microsoft.VSCode',
      tier: 'ax',
      inserted: true,
      // The row records that the helper *confirmed* it, not merely that it
      // accepted the request (2026-08-09 incident).
      verified: true,
    });
    // §12.5: the view carries the full transcript even on success —
    // `presentation.ts` is what decides whether to draw it, and it draws it
    // whenever the insert was not confirmed.
    expect(huds(all).at(-1)?.view).toEqual({
      kind: 'inserted',
      text: 'Hello there, this is a test.',
      tier: 'ax',
      verified: true,
    });
    expect(snapshot.ctx.lastTranscript).toBe('Hello there, this is a test.');
  });
});

describe('interim text never reaches insertion', () => {
  it('drives only the HUD from interim frames', () => {
    const { all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'this is only a preview' },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'This is the committed text.' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 2 },
    ]);
    expect(inserts(all)).toHaveLength(1);
    expect(inserts(all)[0]?.text).toBe('This is the committed text.');
    expect(JSON.stringify(inserts(all))).not.toContain('preview');
  });

  it('accumulates multiple speech_finals into one insertion (contract §7)', () => {
    // endpointing=400 makes the server emit speech_final mid-hold whenever the
    // user pauses. One hold must still produce exactly one insertion.
    const { all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'First part.' },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Second part.' },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Third part.' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 5 },
    ]);
    expect(inserts(all)).toHaveLength(1);
    expect(inserts(all)[0]?.text).toBe('First part. Second part. Third part.');
  });

  it('repairs the joins between segments on the way to the helper', () => {
    // Each speech_final is re-transcribed on its own, so the seam carries a
    // duplicated word and a fresh sentence capital. `src/shared/stitch.ts` has
    // the evidence; this asserts that the reducer actually routes through it.
    const { all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'at the end of the day, you' },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'You have an index of every path' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 5 },
    ]);
    expect(inserts(all)[0]?.text).toBe('at the end of the day, you have an index of every path');
  });

  it('leaves the segments alone when the user has turned seam repair off', () => {
    const env: MachineEnv = { ...testEnv(), repairSeams: () => false };
    const { all } = run(
      [
        { type: 'PTT_DOWN', ts: 1 },
        { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'and it should' },
        { type: 'PTT_UP', ts: 2 },
        { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Do any code changes yet' },
        { type: 'TURN_ENDED', sessionId: 's1', durationSec: 5 },
      ],
      env,
    );
    expect(inserts(all)[0]?.text).toBe('and it should Do any code changes yet');
  });

  it('snapshots the setting per turn, so a mid-dictation toggle cannot change it', () => {
    let repair = true;
    const env: MachineEnv = { ...testEnv(), repairSeams: () => repair };
    let snapshot = reduce(INITIAL_SNAPSHOT, { type: 'PTT_DOWN', ts: 1 }, env).snapshot;
    repair = false;
    for (const event of [
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'and it should' },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Do any code changes yet' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 5 },
    ] satisfies SessionEvent[]) {
      snapshot = reduce(snapshot, event, env).snapshot;
    }
    expect(snapshot.ctx.inserting).toBe('and it should do any code changes yet');
  });
});

describe('the insert waits for transcript.done (2026-08-09 incident, BUG-4)', () => {
  /**
   * On a long turn where the user pauses just before pressing stop, the server
   * owes **two** `speech_final`s at `audio.done` time: the endpointing-triggered
   * one for the segment before the pause, and the post-`audio.done` one for the
   * tail. `processing` used to insert on the first, so the pasted text was
   * missing its ending — every time, silently.
   */
  const twoFinals: readonly SessionEvent[] = [
    { type: 'PTT_DOWN', ts: 1 },
    { type: 'PTT_UP', ts: 2 },
    { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'The first half of it.' },
    { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'And the second half.' },
  ];

  it('does not dispatch on the first final', () => {
    const { snapshot, all } = run(twoFinals);
    expect(snapshot.state).toBe('processing');
    expect(inserts(all)).toHaveLength(0);
  });

  it('types both halves once transcript.done arrives', () => {
    const { snapshot, all } = run([
      ...twoFinals,
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 61.4 },
    ]);
    expect(snapshot.state).toBe('inserting');
    expect(inserts(all)).toHaveLength(1);
    expect(inserts(all)[0]?.text).toBe('The first half of it. And the second half.');
  });

  it('emits no HUD frame per final — the processing capsule is a spinner', () => {
    // The pill shows neither the interim nor the committed text while
    // transcribing, so a frame here would be an IPC round trip that changes no
    // pixels (BUG-7).
    const { effects } = run(twoFinals);
    expect(huds(effects)).toHaveLength(0);
  });

  it('ends the turn with the no-speech copy when done arrives with nothing at all', () => {
    // The other half of moving the trigger: `TURN_ENDED` is now the only way a
    // turn leaves `processing` on its own, so it has to handle the empty case
    // as well as the full one.
    const { snapshot, effects } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 0 },
    ]);
    expect(snapshot.state).toBe('idle');
    expect(huds(effects)[0]?.view).toMatchObject({ kind: 'error' });
  });

  it('salvages rather than dropping when the turn dies before done arrives', () => {
    // If `transcript.done` never comes, the STT client's finish timeout or its
    // liveness watchdog ends the turn — the watchdog through `SESSION_ERROR`,
    // which must keep the text rather than throw away a transcript that was
    // one frame from being typed.
    const { snapshot, effects } = run([
      ...twoFinals,
      {
        type: 'SESSION_ERROR',
        sessionId: 's1',
        error: appError(
          'stt_connect',
          'The connection to the xAI speech service stopped responding.',
          'Check your network connection and try again — nothing was typed.',
        ),
      },
    ]);
    expect(snapshot.state).toBe('idle');
    expect(snapshot.ctx.lastTranscript).toBe('The first half of it. And the second half.');
    expect(histories(effects)).toHaveLength(1);
    expect(huds(effects).at(-1)?.view).toMatchObject({
      kind: 'not_inserted',
      reason: 'session_error',
    });
  });
});

describe('a speech_final that arrives after the insert was dispatched', () => {
  /** Through to `inserting`, with one segment already handed to the helper. */
  const DISPATCHED: readonly SessionEvent[] = [
    { type: 'PTT_DOWN', ts: 1 },
    { type: 'PTT_UP', ts: 2 },
    { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'The first half of it.' },
    // `transcript.done` is what dispatches the insert (BUG-4). A final that
    // arrives after it is the straggler this block is about — rarer now, and
    // still not allowed to vanish.
    { type: 'TURN_ENDED', sessionId: 's1', durationSec: 6 },
  ];

  it('keeps the straggler instead of dropping it on the floor', () => {
    const { snapshot } = run([
      ...DISPATCHED,
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'And the second half.' },
    ]);
    expect(snapshot.state).toBe('inserting');
    expect(committedText(snapshot.ctx)).toBe('The first half of it. And the second half.');
  });

  it('does not type it — one hold is still one insertion', () => {
    const { all } = run([
      ...DISPATCHED,
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'And the second half.' },
    ]);
    expect(inserts(all)).toHaveLength(1);
    expect(inserts(all)[0]?.text).toBe('The first half of it.');
  });

  it('warns, because text the user said and did not get is worth a log line', () => {
    const { effects } = run([
      ...DISPATCHED,
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'And the second half.' },
    ]);
    const logs = effects.filter((e) => e.type === 'log');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ level: 'warn' });
  });

  it('gives history and ⌃⌘V the whole transcript, not the part that was typed', () => {
    const { all, snapshot } = run([
      ...DISPATCHED,
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'And the second half.' },
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: { tier: 'unicode', ok: true, error: null },
      },
    ]);
    const whole = 'The first half of it. And the second half.';
    expect(histories(all)[0]?.entry.text).toBe(whole);
    expect(snapshot.ctx.lastTranscript).toBe(whole);
  });
});

describe('Fn versus Fn+Space (contract §4)', () => {
  it('converts a hold into hands-free when Space arrives, so the Fn release does not stop it', () => {
    const { snapshot } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TOGGLE', ts: 2 },
      { type: 'PTT_UP', ts: 3 },
    ]);
    expect(snapshot.state).toBe('recording');
    expect(snapshot.ctx.mode).toBe('toggle');
  });

  it('stops hands-free on the next Fn+Space, ignoring the surrounding Fn frames', () => {
    const { snapshot } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TOGGLE', ts: 2 },
      { type: 'PTT_UP', ts: 3 },
      // second Fn+Space: down, toggle, up
      { type: 'PTT_DOWN', ts: 4 },
      { type: 'TOGGLE', ts: 5 },
      { type: 'PTT_UP', ts: 6 },
    ]);
    expect(snapshot.state).toBe('processing');
    // Crucially the second ptt_down must not have reset the mode to 'hold',
    // and must not have started a second session.
    expect(snapshot.ctx.sessionId).toBe('s1');
  });

  it('starts hands-free directly from a toggle', () => {
    const { snapshot } = run([{ type: 'TOGGLE', ts: 1 }]);
    expect(snapshot.state).toBe('recording');
    expect(snapshot.ctx.mode).toBe('toggle');
  });
});

describe('ptt_down while busy —  (contract §5)', () => {
  it('queues a press that arrives while inserting, then starts a NEW session', () => {
    const { snapshot, all } = run([
      ...TO_INSERTING, // through TURN_ENDED → inserting
      { type: 'PTT_DOWN', ts: 10 },
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: CONFIRMED },
    ]);
    expect(snapshot.state).toBe('recording');
    expect(snapshot.ctx.sessionId).toBe('s2');
    // The first session's insert still happened and was recorded.
    expect(inserts(all)).toHaveLength(1);
    expect(histories(all)).toHaveLength(1);
  });

  it('queues a press that arrives while processing', () => {
    const { snapshot } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'PTT_UP', ts: 2 },
      { type: 'PTT_DOWN', ts: 3 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'erste Aufnahme' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 2 },
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: { tier: 'unicode', ok: true, error: null },
      },
    ]);
    expect(snapshot.state).toBe('recording');
    expect(snapshot.ctx.sessionId).toBe('s2');
  });

  it('discards the queued press if the key is released before the drain', () => {
    // The user tapped Fn and let go while we were still busy — there is nothing
    // to record, and starting would open a hot mic they are not holding.
    const { snapshot } = run([
      ...TO_INSERTING,
      { type: 'PTT_DOWN', ts: 10 },
      { type: 'PTT_UP', ts: 11 },
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: CONFIRMED },
    ]);
    expect(snapshot.state).toBe('idle');
    expect(snapshot.ctx.pendingStart).toBe(false);
  });

  it('never silently drops a press: it is either queued or explicitly cleared', () => {
    const { snapshot } = run([...TO_INSERTING, { type: 'PTT_DOWN', ts: 10 }]);
    expect(snapshot.ctx.pendingStart).toBe(true);
  });
});

describe('Ctrl+Cmd+V re-insert (contract §6, )', () => {
  it('re-inserts the last transcript with no target pin, so it lands wherever focus is now', () => {
    const env = testEnv();
    const after = run(HAPPY, env);
    const retry = reduce(after.snapshot, { type: 'RETRY_INSERT' }, env);
    expect(retry.snapshot.state).toBe('inserting');
    // One history row per dictation: the retry must not append a second.
    expect(histories(retry.effects)).toHaveLength(0);
    // The retry gets its own session id so the helper's `insert_result` can be
    // correlated; `targetBundleId: null` is what makes it land wherever focus is.
    expect(inserts(retry.effects)).toEqual([
      {
        type: 'insert',
        sessionId: 's2',
        text: 'Hello there, this is a test.',
        targetBundleId: null,
      },
    ]);
  });

  it('explains itself when there is nothing to re-insert', () => {
    const { snapshot, effects } = run([{ type: 'RETRY_INSERT' }]);
    expect(snapshot.state).toBe('idle');
    expect(huds(effects)[0]?.view).toMatchObject({ kind: 'error' });
    expect(inserts(effects)).toHaveLength(0);
  });

  it('keeps the last transcript after a failed insert, so retry has something to use', () => {
    const { snapshot } = run([
      ...TO_INSERTING,
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: { tier: 'none', ok: false, error: 'no AX element' },
      },
    ]);
    expect(snapshot.ctx.lastTranscript).toBe('Hello there, this is a test.');
  });
});

describe('cancel (Esc — )', () => {
  it('discards a recording without inserting or storing anything', () => {
    const { snapshot, all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'vergiss das' },
      { type: 'CANCEL' },
    ]);
    expect(snapshot.state).toBe('idle');
    expect(inserts(all)).toHaveLength(0);
    expect(histories(all)).toHaveLength(0);
    expect(kinds(all)).toContain('cancel_capture');
    expect(kinds(all)).toContain('abort_stt');
  });

  it('discards during processing too', () => {
    const { snapshot, all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'PTT_UP', ts: 2 },
      { type: 'CANCEL' },
    ]);
    expect(snapshot.state).toBe('idle');
    expect(inserts(all)).toHaveLength(0);
  });

  it('cannot recall an insert already dispatched to the helper', () => {
    const { snapshot } = run([...TO_INSERTING, { type: 'CANCEL' }]);
    expect(snapshot.state).toBe('inserting');
  });
});

describe('Secure Input (contract §8, )', () => {
  it('enters blocked from idle and refuses ptt_down', () => {
    const { snapshot, effects } = run([
      { type: 'SECURE_INPUT', enabled: true },
      { type: 'PTT_DOWN', ts: 1 },
    ]);
    expect(snapshot.state).toBe('blocked');
    expect(kinds(effects)).not.toContain('start_capture');
    expect(huds(effects)[0]?.view).toEqual({ kind: 'blocked' });
  });

  it('refuses the toggle and the re-insert too', () => {
    const env = testEnv();
    const blocked = run([{ type: 'SECURE_INPUT', enabled: true }], env);
    for (const event of [{ type: 'TOGGLE', ts: 1 }, { type: 'RETRY_INSERT' }] as const) {
      const stepped = reduce(blocked.snapshot, event, env);
      expect(stepped.snapshot.state).toBe('blocked');
      expect(inserts(stepped.effects)).toHaveLength(0);
      expect(kinds(stepped.effects)).not.toContain('start_capture');
    }
  });

  it('finalises an in-flight recording so the transcript is not lost, but never inserts it', () => {
    const { snapshot, all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'SECURE_INPUT', enabled: true },
      {
        type: 'TRANSCRIPT_FINAL',
        sessionId: 's1',
        text: 'mein geheimes Passwort ist nicht das hier',
      },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 2.5 },
    ]);
    expect(snapshot.state).toBe('blocked');
    expect(inserts(all)).toHaveLength(0);
    // Capture is stopped and the turn is finished so the text still arrives.
    expect(kinds(all)).toContain('stop_capture');
    expect(kinds(all)).toContain('finish_stt');
    // …and it is shown and stored, marked as not inserted.
    expect(huds(all).at(-1)?.view).toMatchObject({ kind: 'not_inserted', reason: 'secure_input' });
    expect(histories(all)[0]?.entry).toMatchObject({ inserted: false, tier: 'none' });
    expect(snapshot.ctx.lastTranscript).toBe('mein geheimes Passwort ist nicht das hier');
  });

  it('returns to idle when Secure Input clears', () => {
    const { snapshot } = run([
      { type: 'SECURE_INPUT', enabled: true },
      { type: 'SECURE_INPUT', enabled: false },
    ]);
    expect(snapshot.state).toBe('idle');
    expect(snapshot.ctx.secureInput).toBe(false);
  });

  it('does not auto-start a queued recording when unblocking', () => {
    const { snapshot } = run([
      ...TO_INSERTING,
      { type: 'PTT_DOWN', ts: 10 }, // queued while inserting
      { type: 'SECURE_INPUT', enabled: true },
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: CONFIRMED },
      { type: 'SECURE_INPUT', enabled: false },
    ]);
    expect(snapshot.state).toBe('idle');
    expect(snapshot.ctx.pendingStart).toBe(false);
  });

  it('lets an insert already in flight complete, then lands in blocked', () => {
    const { snapshot, all } = run([
      ...TO_INSERTING,
      { type: 'SECURE_INPUT', enabled: true },
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: CONFIRMED },
    ]);
    expect(snapshot.state).toBe('blocked');
    expect(histories(all)).toHaveLength(1);
  });
});

describe('superseded sessions (pipeline.rs:50-63)', () => {
  it("drops an old session's final so it cannot land on the new target", () => {
    const env = testEnv();
    const first = run(HAPPY, env);
    // A new session starts…
    const second = reduce(first.snapshot, { type: 'PTT_DOWN', ts: 20 }, env);
    expect(second.snapshot.ctx.sessionId).toBe('s2');
    // …and a straggler from s1 arrives.
    const straggler = reduce(
      second.snapshot,
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'zu spät' },
      env,
    );
    expect(committedText(straggler.snapshot.ctx)).toBe('');
    expect(inserts(straggler.effects)).toHaveLength(0);
  });

  it('drops a stale insert result', () => {
    const env = testEnv();
    const after = run(HAPPY, env);
    const stale = reduce(
      after.snapshot,
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: CONFIRMED },
      env,
    );
    expect(histories(stale.effects)).toHaveLength(0);
  });
});

describe('failure paths', () => {
  it('shows the transcript when both insertion tiers decline', () => {
    const { all } = run([
      ...TO_INSERTING,
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: {
          tier: 'none',
          ok: false,
          error: 'no focused AX element; app blocks synthetic input',
        },
      },
    ]);
    expect(huds(all).at(-1)?.view).toMatchObject({
      kind: 'not_inserted',
      text: 'Hello there, this is a test.',
      reason: 'insert_failed',
      detail: 'no focused AX element; app blocks synthetic input',
    });
  });

  it('treats an insert timeout as a failed insert rather than losing the text', () => {
    const { snapshot, all } = run([...TO_INSERTING, { type: 'INSERT_TIMEOUT', sessionId: 's1' }]);
    expect(snapshot.state).toBe('idle');
    expect(huds(all).at(-1)?.view).toMatchObject({
      kind: 'not_inserted',
      reason: 'helper_unavailable',
    });
    expect(snapshot.ctx.lastTranscript).toBe('Hello there, this is a test.');
  });

  it('blames the microphone when the turn ends empty and nothing was ever heard', () => {
    const { snapshot, effects } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 0 },
    ]);
    expect(snapshot.state).toBe('idle');
    const view = huds(effects)[0]?.view;
    expect(view).toMatchObject({ kind: 'error', message: 'The microphone sent no sound.' });
    // §4: "Errors carry actionable text."
    expect(view && 'hint' in view ? view.hint : null).toContain('Microphone permission');
  });

  it('blames the silence when the microphone was working (§19.4)', () => {
    // The distinction the user asked for by name: with levels on the record,
    // "the microphone is dead" and "I did not say anything" are different
    // failures and must not share one sentence.
    const { effects } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'LEVEL', sessionId: 's1', level: 0.06 },
      { type: 'LEVEL', sessionId: 's1', level: 0.001 },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 3 },
    ]);
    const view = huds(effects)[0]?.view;
    expect(view).toMatchObject({ kind: 'error', message: 'No speech was detected.' });
    expect(view && 'hint' in view ? view.hint : null).toContain('picking up sound');
  });

  it('gives the no-speech watchdog the same diagnosis as an empty turn (§19.4)', () => {
    // Otherwise one silence gets two different explanations depending on which
    // timer noticed it first.
    const heard = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'LEVEL', sessionId: 's1', level: 0.08 },
      {
        type: 'SESSION_ERROR',
        sessionId: 's1',
        error: appError('stt_no_speech', 'No speech reached the xAI speech service.', 'Check it.'),
      },
    ]);
    expect(huds(heard.effects)[0]?.view).toMatchObject({ message: 'No speech was detected.' });

    const silent = run([
      { type: 'PTT_DOWN', ts: 1 },
      {
        type: 'SESSION_ERROR',
        sessionId: 's1',
        error: appError('stt_no_speech', 'No speech reached the xAI speech service.', 'Check it.'),
      },
    ]);
    expect(huds(silent.effects)[0]?.view).toMatchObject({
      message: 'The microphone sent no sound.',
    });
  });

  it('inserts what it has when the server closes the turn on its own', () => {
    // Spike 4 territory: the session hits a server-side duration cap mid-hold.
    const { all, snapshot } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'ein sehr langer Diktattext' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 360 },
    ]);
    expect(snapshot.state).toBe('inserting');
    expect(inserts(all)[0]?.text).toBe('ein sehr langer Diktattext');
  });

  it('surfaces a session error and returns to idle', () => {
    const { snapshot, effects } = run([
      { type: 'PTT_DOWN', ts: 1 },
      {
        type: 'SESSION_ERROR',
        sessionId: 's1',
        error: {
          code: 'auth_expired',
          message: 'The Grok token expired at 21:58.',
          hint: 'Run `grok` in a terminal to refresh it.',
          cause: undefined,
        },
      },
    ]);
    expect(snapshot.state).toBe('idle');
    expect(huds(effects)[0]?.view).toMatchObject({
      kind: 'error',
      message: 'The Grok token expired at 21:58.',
      hint: 'Run `grok` in a terminal to refresh it.',
    });
  });
});

/* ------------------------------------------------------------------ *
 * Contract §9 invariants — Phase 5 (§5b) re-checks these.
 * ------------------------------------------------------------------ */

describe('contract §9 invariants', () => {
  /** A long, adversarial event sequence touching every state and both failures. */
  const SOAK: readonly SessionEvent[] = [
    { type: 'PTT_DOWN', ts: 1 },
    { type: 'FRONTMOST', sessionId: 's1', app: { bundleId: 'com.apple.Notes', name: 'Notes' } },
    { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'interim one' },
    { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Satz eins.' },
    { type: 'TOGGLE', ts: 2 },
    { type: 'PTT_UP', ts: 3 },
    { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'interim two' },
    { type: 'TOGGLE', ts: 4 },
    { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Satz zwei.' },
    { type: 'TURN_ENDED', sessionId: 's1', durationSec: 7 },
    { type: 'PTT_DOWN', ts: 5 },
    { type: 'INSERT_RESULT', sessionId: 's1', outcome: { tier: 'unicode', ok: true, error: null } },
    { type: 'TRANSCRIPT_INTERIM', sessionId: 's2', text: 'interim three' },
    { type: 'SECURE_INPUT', enabled: true },
    { type: 'PTT_DOWN', ts: 6 },
    { type: 'TRANSCRIPT_FINAL', sessionId: 's2', text: 'Satz drei.' },
    { type: 'TURN_ENDED', sessionId: 's2', durationSec: 4 },
    { type: 'RETRY_INSERT' },
    { type: 'SECURE_INPUT', enabled: false },
    { type: 'PTT_DOWN', ts: 7 },
    { type: 'CANCEL' },
  ];

  it('1. only committed speech_final text is ever inserted', () => {
    const { all } = run(SOAK);
    for (const insert of inserts(all)) {
      expect(insert.text).not.toContain('interim');
    }
    expect(inserts(all).map((i) => i.text)).toEqual(['Satz eins. Satz zwei.']);
  });

  it('2. no insertion is dispatched from a blocked state', () => {
    // Replay the soak, asserting on each step that a blocked state emits no insert.
    const env = testEnv();
    let snapshot = INITIAL_SNAPSHOT;
    for (const event of SOAK) {
      const before = snapshot.state;
      const stepped = reduce(snapshot, event, env);
      if (before === 'blocked') {
        expect(
          inserts(stepped.effects),
          `insert emitted from blocked on ${event.type}`,
        ).toHaveLength(0);
      }
      snapshot = stepped.snapshot;
    }
  });

  it('3. no effect ever references a stale session id', () => {
    const env = testEnv();
    let snapshot = INITIAL_SNAPSHOT;
    for (const event of SOAK) {
      const current = snapshot.ctx.sessionId;
      const stepped = reduce(snapshot, event, env);
      for (const effect of stepped.effects) {
        if ('sessionId' in effect && effect.sessionId !== '') {
          const acceptable = [current, stepped.snapshot.ctx.sessionId];
          expect(acceptable, `${effect.type} used ${effect.sessionId}`).toContain(effect.sessionId);
        }
      }
      snapshot = stepped.snapshot;
    }
  });

  it('4. a ptt_down while busy is queued, never silently dropped', () => {
    const env = testEnv();
    let snapshot = INITIAL_SNAPSHOT;
    for (const event of SOAK) {
      const before = snapshot;
      const stepped = reduce(snapshot, event, env);
      if (
        event.type === 'PTT_DOWN' &&
        (before.state === 'inserting' || before.state === 'processing')
      ) {
        expect(stepped.snapshot.ctx.pendingStart).toBe(true);
      }
      snapshot = stepped.snapshot;
    }
  });

  it('5. cancel produces no insert and no history row', () => {
    const env = testEnv();
    let snapshot = INITIAL_SNAPSHOT;
    for (const event of SOAK) {
      const stepped = reduce(snapshot, event, env);
      if (event.type === 'CANCEL' && snapshot.state !== 'inserting') {
        expect(inserts(stepped.effects)).toHaveLength(0);
        expect(histories(stepped.effects)).toHaveLength(0);
      }
      snapshot = stepped.snapshot;
    }
  });

  it('6. the machine never emits a clipboard effect — copy originates in the renderer', () => {
    const { all } = run(SOAK);
    // : the pasteboard is written only on an explicit user click.
    // There is deliberately no `copy` member of `Effect`; this asserts no effect
    // name has crept in that could reach the pasteboard.
    expect(kinds(all).filter((k) => /copy|clipboard|paste/i.test(k))).toEqual([]);
  });

  it('7. every transcript that existed either inserts, is shown, or is explained', () => {
    const { all } = run(SOAK);
    const shown = huds(all).filter(
      (h) => h.view.kind === 'inserted' || h.view.kind === 'not_inserted',
    );
    const insertedTexts = inserts(all).map((i) => i.text);
    const shownTexts = shown.map((h) =>
      h.view.kind === 'inserted' || h.view.kind === 'not_inserted' ? h.view.text : '',
    );
    for (const text of ['Satz eins. Satz zwei.', 'Satz drei.']) {
      expect([...insertedTexts, ...shownTexts]).toContain(text);
    }
  });
});

describe('level and tick frames are coalesced (2026-08-09 incident, BUG-7)', () => {
  /**
   * `LEVEL` fires per 100 ms audio chunk and `TICK` per 100 ms HUD tick, and
   * each used to emit its own `hud` effect — roughly twenty IPC round trips a
   * second for as long as the key was held, every one allocating a fresh view.
   *
   * A clock the test moves by hand, because the coalescing window is the whole
   * subject and a real one would make the assertions a race.
   */
  function clockEnv(): MachineEnv & { at: (ms: number) => void } {
    let n = 0;
    let now = 1_000_000;
    return {
      newSessionId: () => `s${String(++n)}`,
      now: () => now,
      at: (ms: number) => {
        now = 1_000_000 + ms;
      },
    };
  }

  it('emits one frame, not two, for a level and a tick in the same window', () => {
    const env = clockEnv();
    let snapshot = reduce(INITIAL_SNAPSHOT, { type: 'PTT_DOWN', ts: 1 }, env).snapshot;

    env.at(50);
    const level = reduce(snapshot, { type: 'LEVEL', sessionId: 's1', level: 0.4 }, env);
    snapshot = level.snapshot;
    const tick = reduce(snapshot, { type: 'TICK', now: 1_000_060 }, env);

    expect(huds(level.effects)).toHaveLength(0); // 50 ms after the start frame
    expect(huds(tick.effects)).toHaveLength(0); // 60 ms
  });

  it('loses the frame but never the measurement', () => {
    // The suppressed event still updates the context, so the next frame that
    // does go out carries its value.
    const env = clockEnv();
    let snapshot = reduce(INITIAL_SNAPSHOT, { type: 'PTT_DOWN', ts: 1 }, env).snapshot;

    env.at(40);
    snapshot = reduce(snapshot, { type: 'LEVEL', sessionId: 's1', level: 0.77 }, env).snapshot;
    env.at(150);
    const tick = reduce(snapshot, { type: 'TICK', now: 1_000_150 }, env);

    expect(huds(tick.effects)).toHaveLength(1);
    expect(huds(tick.effects)[0]?.view).toMatchObject({ level: 0.77, elapsedMs: 150 });
  });

  it('roughly halves the frames over a second of recording', () => {
    // Ten levels and ten ticks, interleaved at 50 ms as they arrive in
    // production: twenty events, and no longer twenty frames.
    const env = clockEnv();
    let snapshot = reduce(INITIAL_SNAPSHOT, { type: 'PTT_DOWN', ts: 1 }, env).snapshot;
    const frames: Effect[] = [];

    for (let ms = 100; ms <= 1000; ms += 50) {
      env.at(ms);
      const event: SessionEvent =
        ms % 100 === 0
          ? { type: 'LEVEL', sessionId: 's1', level: (ms % 700) / 1000 }
          : { type: 'TICK', now: 1_000_000 + ms };
      const stepped = reduce(snapshot, event, env);
      snapshot = stepped.snapshot;
      frames.push(...huds(stepped.effects));
    }

    expect(frames.length).toBeLessThanOrEqual(11);
    expect(frames.length).toBeGreaterThanOrEqual(9);
  });

  it('still tracks the peak level from a suppressed frame (§19.4)', () => {
    // `peakLevel` is what separates "the microphone is dead" from "nobody
    // spoke", and it must not depend on whether a frame was drawn.
    const env = clockEnv();
    let snapshot = reduce(INITIAL_SNAPSHOT, { type: 'PTT_DOWN', ts: 1 }, env).snapshot;
    env.at(10);
    snapshot = reduce(snapshot, { type: 'LEVEL', sessionId: 's1', level: 0.9 }, env).snapshot;
    expect(snapshot.ctx.peakLevel).toBe(0.9);
  });
});

describe('every event is handled in every state without throwing', () => {
  const ALL_EVENTS: readonly SessionEvent[] = [
    { type: 'PTT_DOWN', ts: 1 },
    { type: 'PTT_UP', ts: 1 },
    { type: 'TOGGLE', ts: 1 },
    { type: 'RETRY_INSERT' },
    { type: 'INSERT_TEXT', text: 'x' },
    { type: 'CANCEL' },
    { type: 'SECURE_INPUT', enabled: true },
    { type: 'SECURE_INPUT', enabled: false },
    { type: 'FRONTMOST', sessionId: 's1', app: { bundleId: null, name: null } },
    { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'x' },
    { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'x' },
    { type: 'TURN_ENDED', sessionId: 's1', durationSec: null },
    {
      type: 'SESSION_ERROR',
      sessionId: null,
      error: { code: 'internal', message: 'x', hint: null },
    },
    { type: 'INSERT_RESULT', sessionId: 's1', outcome: { tier: 'none', ok: false, error: null } },
    { type: 'INSERT_TIMEOUT', sessionId: 's1' },
    { type: 'RECORDING_CAP_REACHED', sessionId: 's1' },
    { type: 'LEVEL', sessionId: 's1', level: 0.5 },
    { type: 'TICK', now: 1_005_000 },
  ];

  const REACHABLE: Record<string, readonly SessionEvent[]> = {
    idle: [],
    recording: [{ type: 'PTT_DOWN', ts: 1 }],
    processing: [
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'PTT_UP', ts: 2 },
    ],
    inserting: [
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'text' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 1 },
    ],
    blocked: [{ type: 'SECURE_INPUT', enabled: true }],
  };

  for (const [state, prefix] of Object.entries(REACHABLE)) {
    for (const event of ALL_EVENTS) {
      it(`${state} + ${event.type}${'enabled' in event ? `(${String(event.enabled)})` : ''}`, () => {
        const env = testEnv();
        const base = run(prefix, env);
        expect(base.snapshot.state).toBe(state);
        expect(() => reduce(base.snapshot, event, env)).not.toThrow();
      });
    }
  }
});

/* ------------------------------------------------------------------ *
 * Phase 5 — defects found at the seams between the parallel phases
 * ------------------------------------------------------------------ */

describe("the helper's decline reason drives the HUD copy", () => {
  const toInserting: readonly SessionEvent[] = [
    { type: 'PTT_DOWN', ts: 1 },
    {
      type: 'FRONTMOST',
      sessionId: 's1',
      app: { bundleId: 'com.microsoft.VSCode', name: 'Code' },
    },
    { type: 'PTT_UP', ts: 2 },
    { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Hello there, this is a test.' },
    { type: 'TURN_ENDED', sessionId: 's1', durationSec: 3 },
  ];

  it('maps target_changed to its own reason rather than "neither tier worked"', () => {
    // The Swift ladder has always declined when focus moved, but it said so
    // only in prose, so the app reported `insert_failed` and told the user
    // "neither insertion method was accepted by that app" — wrong, and
    // unactionable. `NotInsertedReason.target_changed` existed in the contract
    // from Phase 1 with nothing anywhere able to produce it.
    const { effects } = run([
      ...toInserting,
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: {
          tier: 'none',
          ok: false,
          error: 'focus moved to Safari since you started dictating',
          reason: 'target_changed',
        },
      },
    ]);
    const view = huds(effects).at(-1)?.view;
    expect(view).toMatchObject({ kind: 'not_inserted', reason: 'target_changed' });
  });

  it("falls back to the caller's reason when the helper classified nothing", () => {
    const { effects } = run([
      ...toInserting,
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: { tier: 'none', ok: false, error: 'something went wrong' },
      },
    ]);
    expect(huds(effects).at(-1)?.view).toMatchObject({
      kind: 'not_inserted',
      reason: 'insert_failed',
    });
  });

  it('treats no_tier as the generic insertion failure', () => {
    const { effects } = run([
      ...toInserting,
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: { tier: 'none', ok: false, error: 'both tiers declined', reason: 'no_tier' },
      },
    ]);
    expect(huds(effects).at(-1)?.view).toMatchObject({
      kind: 'not_inserted',
      reason: 'insert_failed',
    });
  });
});

describe('an insert the helper could not verify (2026-08-09 incident, BUG-1)', () => {
  /**
   * `CGEventKeyboardSetUnicodeString` has no return channel, so `ok: true` has
   * always meant "posted". On 2026-08-09 a 60.3 s dictation was posted as 38
   * events in 245 ms into an Electron terminal that dropped every one; the app
   * showed a green check, played no error cue and wrote `inserted: true`. The
   * text was gone and nothing on screen said so.
   */
  const unverified = (verified: boolean | null): InsertOutcome => ({
    tier: 'unicode',
    ok: true,
    error: null,
    verified,
  });

  it('marks the pill unconfirmed rather than claiming the insert landed', () => {
    const { all } = run([
      ...TO_INSERTING,
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: unverified(null) },
    ]);
    expect(huds(all).at(-1)?.view).toEqual({
      kind: 'inserted',
      text: 'Hello there, this is a test.',
      tier: 'unicode',
      verified: null,
    });
  });

  it('treats a helper that never mentions verification as unconfirmed, not as confirmed', () => {
    // An older helper binary sends no `verified` at all. Reading absent as
    // "yes" is the whole bug.
    const { all } = run([
      ...TO_INSERTING,
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: { tier: 'unicode', ok: true, error: null },
      },
    ]);
    expect(huds(all).at(-1)?.view).toMatchObject({ kind: 'inserted', verified: null });
  });

  it('records the distinction in history instead of asserting inserted: true alone', () => {
    const { all } = run([
      ...TO_INSERTING,
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: unverified(null) },
    ]);
    expect(histories(all)[0]?.entry).toMatchObject({ inserted: true, verified: null });
  });

  it('still plays no error cue — nothing has necessarily failed', () => {
    // The trade is stated in `finishInsert`: verification is impossible for a
    // whole class of ordinary targets, so a cue here would fire on good
    // dictations and train the user to ignore the one sound that means
    // something. The amber pill carrying the full transcript is the signal.
    const { effects } = run([
      ...TO_INSERTING,
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: unverified(null) },
    ]);
    expect(effects.filter((e) => e.type === 'cue')).toHaveLength(0);
  });

  it('a confirmed insert keeps the plain green check', () => {
    const { all, effects } = run([
      ...TO_INSERTING,
      { type: 'INSERT_RESULT', sessionId: 's1', outcome: CONFIRMED },
    ]);
    expect(huds(all).at(-1)?.view).toMatchObject({ kind: 'inserted', verified: true });
    expect(effects.filter((e) => e.type === 'cue')).toHaveLength(0);
  });

  it('a proven-not-landed insert is a failure with its own reason and an error cue', () => {
    const { all, effects } = run([
      ...TO_INSERTING,
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: {
          tier: 'unicode',
          ok: false,
          error: 'the focused element’s text did not change',
          reason: 'verification_failed',
          verified: false,
        },
      },
    ]);
    expect(huds(all).at(-1)?.view).toMatchObject({
      kind: 'not_inserted',
      text: 'Hello there, this is a test.',
      reason: 'verification_failed',
    });
    // The helper reports `tier: 'unicode'` here — it *did* act, the text just
    // did not arrive — so the row records the tier that ran rather than `none`,
    // and nothing anywhere may use `tier === 'none'` to mean "it failed".
    expect(histories(all)[0]?.entry).toMatchObject({
      inserted: false,
      verified: false,
      tier: 'unicode',
    });
    expect(effects).toContainEqual({ type: 'cue', cue: 'error' });
  });
});

describe('a mid-utterance failure keeps what was already transcribed', () => {
  const NETWORK_DROP = {
    type: 'SESSION_ERROR',
    sessionId: 's1',
    error: {
      code: 'stt_connect' as const,
      message: 'The connection to the xAI speech service stopped responding.',
      hint: 'Check your network connection and try again — nothing was typed.',
    },
  } satisfies SessionEvent;

  it('shows it, stores it, and makes ⌃⌘V able to type it', () => {
    // docs/phase-3-report.md §5.2: `toIdleWithError` used to clear `committed`
    // and leave `lastTranscript` alone, so a drop after a minute of good
    // dictation lost all of it.
    const { snapshot, effects } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'First sentence.' },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Second sentence.' },
      NETWORK_DROP,
    ]);

    expect(snapshot.state).toBe('idle');
    expect(snapshot.ctx.lastTranscript).toBe('First sentence. Second sentence.');
    expect(huds(effects).at(-1)?.view).toMatchObject({
      kind: 'not_inserted',
      reason: 'session_error',
      text: 'First sentence. Second sentence.',
    });
    expect(histories(effects)).toHaveLength(1);
    expect(histories(effects)[0]?.entry).toMatchObject({
      text: 'First sentence. Second sentence.',
      inserted: false,
      tier: 'none',
    });
  });

  it('never attempts an insert — half a sentence must not land in the editor', () => {
    const { all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'First sentence.' },
      NETWORK_DROP,
    ]);
    expect(inserts(all)).toHaveLength(0);
  });

  it('still shows a plain error when nothing had been transcribed', () => {
    const { snapshot, effects } = run([{ type: 'PTT_DOWN', ts: 1 }, NETWORK_DROP]);
    expect(snapshot.ctx.lastTranscript).toBeNull();
    expect(huds(effects).at(-1)?.view).toMatchObject({ kind: 'error' });
    expect(histories(effects)).toHaveLength(0);
  });

  /* ---------------------------------------------------------------- *
   * BUG-3 — the interim tail
   * ---------------------------------------------------------------- */

  /**
   * Speaking continuously produces no `speech_final` at all: the server emits
   * one when it hears an endpoint, and there is none. So `committed` stays
   * empty for the whole minute while the text streams past as interim, and a
   * drop used to salvage exactly nothing — not history, not `lastTranscript`,
   * nothing for ⌃⌘V. Total silent loss (2026-08-09 incident, BUG-3).
   */
  const CONTINUOUS: readonly SessionEvent[] = [
    { type: 'PTT_DOWN', ts: 1 },
    { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'so the first thing to do is' },
    {
      type: 'TRANSCRIPT_INTERIM',
      sessionId: 's1',
      text: 'so the first thing to do is open the terminal and run the migration',
    },
  ];

  it('salvages the interim tail when nothing was ever confirmed', () => {
    const { snapshot, effects } = run([...CONTINUOUS, NETWORK_DROP]);
    const spoken = 'so the first thing to do is open the terminal and run the migration';

    expect(snapshot.ctx.lastTranscript).toBe(spoken);
    expect(huds(effects).at(-1)?.view).toMatchObject({ kind: 'not_inserted', text: spoken });
    expect(histories(effects)[0]?.entry).toMatchObject({ text: spoken, inserted: false });
  });

  it('says out loud that the tail was never confirmed, in the pill and in the row', () => {
    const { effects } = run([...CONTINUOUS, NETWORK_DROP]);
    expect(huds(effects).at(-1)?.view).toMatchObject({ reason: 'session_error_unconfirmed' });
    expect(histories(effects)[0]?.entry).toMatchObject({ unconfirmedTail: true });
  });

  it('appends the interim to the confirmed segments rather than replacing them', () => {
    const { snapshot, effects } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'First sentence.' },
      { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'and then the second one was' },
      NETWORK_DROP,
    ]);
    expect(snapshot.ctx.lastTranscript).toBe('First sentence. And then the second one was');
    expect(histories(effects)[0]?.entry).toMatchObject({ unconfirmedTail: true });
  });

  it('leaves a fully confirmed salvage unlabelled', () => {
    // The interim is cleared by every `speech_final`, so a turn that died just
    // after one has nothing unconfirmed to declare.
    const { effects } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'first sen' },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'First sentence.' },
      NETWORK_DROP,
    ]);
    expect(huds(effects).at(-1)?.view).toMatchObject({ reason: 'session_error' });
    expect(histories(effects)[0]?.entry).toMatchObject({ unconfirmedTail: false });
  });

  it('never types it — unconfirmed text must not reach the editor', () => {
    // The whole point of the interim/committed split (§9.1). Salvage makes the
    // words *reachable*; it does not make them insertable.
    const { all } = run([...CONTINUOUS, NETWORK_DROP]);
    expect(inserts(all)).toHaveLength(0);
    expect(JSON.stringify(inserts(all))).not.toContain('terminal');
  });

  it('salvages the interim tail when the watchdog kills the turn, too', () => {
    // The liveness watchdog reaches the same reducer path, and it is the one
    // that fires when the link dies silently — HT-5's shape, and the one that
    // combined with this bug to lose a whole dictation.
    const { snapshot } = run([
      ...CONTINUOUS,
      {
        type: 'SESSION_ERROR',
        sessionId: 's1',
        error: appError(
          'stt_connect',
          'The connection to the xAI speech service stopped responding.',
          'Check your network connection and try again — nothing was typed.',
        ),
      },
    ]);
    expect(snapshot.ctx.lastTranscript).toContain('run the migration');
  });
});

describe('a turn that dies while Secure Input is blocking (BUG-3)', () => {
  const blockedMidSentence: readonly SessionEvent[] = [
    { type: 'PTT_DOWN', ts: 1 },
    { type: 'TRANSCRIPT_INTERIM', sessionId: 's1', text: 'the deploy went out at half past' },
    { type: 'SECURE_INPUT', enabled: true },
  ];

  it('keeps the unconfirmed tail when the turn is finalised from blocked', () => {
    const { snapshot, all } = run([
      ...blockedMidSentence,
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 4 },
    ]);
    expect(snapshot.ctx.lastTranscript).toBe('the deploy went out at half past');
    expect(histories(all)[0]?.entry).toMatchObject({ inserted: false, unconfirmedTail: true });
    // Secure Input is still the reason nothing was typed — that is the advice
    // the user needs — so the tail is disclosed in the detail line.
    const view = huds(all).at(-1)?.view;
    expect(view).toMatchObject({ kind: 'not_inserted', reason: 'secure_input' });
    expect(view && 'detail' in view ? view.detail : '').toContain('never confirmed');
    expect(inserts(all)).toHaveLength(0);
  });

  it('no longer discards everything when the session then errors', () => {
    // §9.7: "a transcript never vanishes without a trace". This path used to
    // clear `committed` and `interim` and emit nothing but a log line.
    const { snapshot, all } = run([
      ...blockedMidSentence,
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'The deploy went out at half past.' },
      {
        type: 'SESSION_ERROR',
        sessionId: 's1',
        error: appError('stt_connect', 'The connection dropped.', 'Try again.'),
      },
    ]);
    expect(snapshot.state).toBe('blocked');
    expect(snapshot.ctx.lastTranscript).toBe('The deploy went out at half past.');
    expect(histories(all).at(-1)?.entry).toMatchObject({ inserted: false, tier: 'none' });
    // The blocked pill stays: Secure Input is still what the user must clear.
    expect(huds(all).at(-1)?.view).toEqual({ kind: 'blocked' });
    expect(inserts(all)).toHaveLength(0);
  });
});

describe('INSERT_TEXT — an older history row, or a Scratchpad edit', () => {
  it('inserts the given text with the frontmost check disabled', () => {
    const { snapshot, effects } = run([{ type: 'INSERT_TEXT', text: 'etwas ganz anderes' }]);
    expect(snapshot.state).toBe('inserting');
    expect(inserts(effects)).toEqual([
      { type: 'insert', sessionId: 's1', text: 'etwas ganz anderes', targetBundleId: null },
    ]);
  });

  it('appends no history row — the text already has one', () => {
    const { all } = run([
      { type: 'INSERT_TEXT', text: 'etwas ganz anderes' },
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: { tier: 'unicode', ok: true, error: null },
      },
    ]);
    expect(histories(all)).toHaveLength(0);
  });

  it('is refused while blocked, exactly like every other insertion path (§8)', () => {
    const { snapshot, all } = run([
      { type: 'SECURE_INPUT', enabled: true },
      { type: 'INSERT_TEXT', text: 'nope' },
    ]);
    expect(snapshot.state).toBe('blocked');
    expect(inserts(all)).toHaveLength(0);
  });

  it('ignores empty text rather than dispatching an insert of nothing', () => {
    const { snapshot, effects } = run([{ type: 'INSERT_TEXT', text: '' }]);
    expect(snapshot.state).toBe('idle');
    expect(inserts(effects)).toHaveLength(0);
  });
});

describe('the microphone is always closed before the machine leaves recording', () => {
  it('closes it when the server ends the turn while the key is still held', () => {
    // Without this the device stays open through insertion and beyond, with
    // the macOS orange indicator lit, and the elapsed and
    // cap timers keep running — the orchestrator clears them on `stop_capture`.
    const { all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Ein Satz.' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 4.2 },
    ]);
    expect(kinds(all)).toContain('stop_capture');
  });

  it('closes it when the recording cap is reached, and moves the tray on', () => {
    const { effects } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'RECORDING_CAP_REACHED', sessionId: 's1' },
    ]);
    expect(kinds(effects)).toContain('stop_capture');
    expect(effects).toContainEqual({ type: 'tray', state: 'processing', secureInput: false });
  });
});

describe('transcript.done.duration reaches the history row', () => {
  it('is absorbed while inserting, where it always lands', () => {
    // `speech_final` and `transcript.done` arrive in the same millisecond in
    // every captured session, so the machine is always already in `inserting`
    // (docs/phase-3-report.md §5.1, docs/phase-4-report.md §5.4).
    const { all } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Ein Satz.' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 12.865 },
      {
        type: 'INSERT_RESULT',
        sessionId: 's1',
        outcome: { tier: 'ax', ok: true, error: null },
      },
    ]);
    expect(histories(all)[0]?.entry.durationSec).toBe(12.865);
  });
});

describe('hands-free ends on a bare Fn as well as on Fn+Space', () => {
  const INTO_HANDS_FREE: readonly SessionEvent[] = [
    { type: 'PTT_DOWN', ts: 1 },
    { type: 'TOGGLE', ts: 2 },
    { type: 'PTT_UP', ts: 3 },
  ];

  it('stops on the next Fn press', () => {
    // Added in Phase 5 at the user's direction. The HT-9 log caught the old
    // behaviour turning the gesture down — `ignored PTT_DOWN: already
    // recording` — immediately before the user reached for Fn+Space instead.
    const { snapshot, effects } = run([...INTO_HANDS_FREE, { type: 'PTT_DOWN', ts: 4 }]);
    expect(snapshot.state).toBe('processing');
    expect(kinds(effects)).toContain('stop_capture');
    expect(kinds(effects)).toContain('finish_stt');
  });

  it('does not restart on the release that follows', () => {
    // The `PTT_UP` lands in `processing`, where it clears `pendingStart`
    // rather than queueing one (§5). Without that, ending a hands-free session
    // would immediately begin another.
    const { snapshot } = run([
      ...INTO_HANDS_FREE,
      { type: 'PTT_DOWN', ts: 4 },
      { type: 'PTT_UP', ts: 5 },
    ]);
    expect(snapshot.state).toBe('processing');
    expect(snapshot.ctx.pendingStart).toBe(false);
  });

  it('still stops on Fn+Space', () => {
    const { snapshot } = run([...INTO_HANDS_FREE, { type: 'TOGGLE', ts: 4 }]);
    expect(snapshot.state).toBe('processing');
  });

  it('leaves a hold alone — a second PTT_DOWN there is key repeat', () => {
    const { snapshot } = run([
      { type: 'PTT_DOWN', ts: 1 },
      { type: 'PTT_DOWN', ts: 2 },
    ]);
    expect(snapshot.state).toBe('recording');
    expect(snapshot.ctx.mode).toBe('hold');
  });
});

describe('history records the application the text actually reached', () => {
  const dictate = (outcome: InsertOutcome): ReturnType<typeof run> =>
    run([
      { type: 'PTT_DOWN', ts: 1 },
      {
        type: 'FRONTMOST',
        sessionId: 's1',
        app: { bundleId: 'com.apple.TextEdit', name: 'TextEdit' },
      },
      { type: 'PTT_UP', ts: 2 },
      { type: 'TRANSCRIPT_FINAL', sessionId: 's1', text: 'Ein Satz.' },
      { type: 'TURN_ENDED', sessionId: 's1', durationSec: 2 },
      { type: 'INSERT_RESULT', sessionId: 's1', outcome },
    ]);

  it('prefers what the helper reports over the app captured at press time', () => {
    // The two now differ by design: the user starts dictating in one window and
    // clicks into another before releasing.
    const { all } = dictate({
      tier: 'unicode',
      ok: true,
      error: null,
      frontmost: { bundleId: 'com.apple.Notes', name: 'Notes' },
    });
    expect(histories(all)[0]?.entry).toMatchObject({
      frontmostBundleId: 'com.apple.Notes',
      frontmostName: 'Notes',
    });
  });

  it('falls back to the press-time app when the helper reported none', () => {
    const { all } = dictate({ tier: 'none', ok: false, error: 'the helper is not running' });
    expect(histories(all)[0]?.entry).toMatchObject({
      frontmostBundleId: 'com.apple.TextEdit',
      frontmostName: 'TextEdit',
    });
  });
});
