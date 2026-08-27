import { describe, expect, it } from 'vitest';
import type { HudView, NotInsertedReason } from '@contracts/events.js';
import { INSERT_TIERS } from '@contracts/helper-protocol.js';
import {
  LIVE_TEXT_MAX_CHARS,
  notInsertedCopy,
  present,
  recentLiveText,
  tierLabel,
  unconfirmedInsertCopy,
} from './presentation.js';

/** A transcript long enough that any truncation would be obvious. */
const LONG =
  'Deployed that on the staging server and then ran the migration, ' +
  'weil der Pod sonst neu gestartet wäre — plus Umlaute äöü und ein Emoji 🎧.';

const ALL_VIEWS: HudView[] = [
  { kind: 'hidden' },
  { kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' },
  { kind: 'recording', elapsedMs: 61_000, level: 0.4, interim: 'guten', mode: 'toggle' },
  { kind: 'processing', interim: 'hello there' },
  { kind: 'inserted', text: LONG, tier: 'ax', verified: true },
  { kind: 'inserted', text: LONG, tier: 'unicode', verified: null },
  { kind: 'inserted', text: LONG, tier: 'unicode', verified: false },
  { kind: 'not_inserted', text: LONG, reason: 'insert_failed', detail: null },
  { kind: 'not_inserted', text: LONG, reason: 'verification_failed', detail: null },
  { kind: 'not_inserted', text: LONG, reason: 'session_error_unconfirmed', detail: null },
  { kind: 'blocked' },
  { kind: 'error', message: 'No speech was detected.', hint: 'Check the microphone.' },
];

describe('present', () => {
  it('handles every HudView kind without throwing', () => {
    for (const view of ALL_VIEWS) expect(() => present(view)).not.toThrow();
  });

  it('keeps not_inserted wordless — the transcript is in history, not on the overlay', () => {
    const p = present({
      kind: 'not_inserted',
      text: LONG,
      reason: 'insert_failed',
      detail: null,
    });
    expect(p.message).toBeNull();
    expect(p.capsule).toEqual({ kind: 'alert' });
    expect(p.layer).toBe('capsule');
  });

  it('reduces a CONFIRMED insert to the green check — no transcript (overhaul §16.4)', () => {
    const p = present({ kind: 'inserted', text: LONG, tier: 'unicode', verified: true });
    expect(p.capsule).toEqual({ kind: 'check' });
    expect(p.message).toBeNull();
  });

  it('never puts the transcript in the title', () => {
    for (const view of ALL_VIEWS) {
      const p = present(view);
      const body = p.message?.body;
      if (body !== undefined && body !== null && body.length > 0) {
        expect(p.message?.title).not.toContain(body);
      }
    }
  });

  it('offers no overlay buttons on insert outcomes — recovery is History and ⌃⌘V', () => {
    const ids = (view: HudView): string[] =>
      (present(view).message?.actions ?? []).map((a) => a.id);
    expect(
      ids({ kind: 'not_inserted', text: LONG, reason: 'insert_failed', detail: null }),
    ).toEqual([]);
    expect(ids({ kind: 'inserted', text: LONG, tier: 'ax', verified: true })).toEqual([]);
    expect(ids({ kind: 'inserted', text: LONG, tier: 'unicode', verified: null })).toEqual([]);
    expect(ids({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' })).toEqual(
      [],
    );
    expect(ids({ kind: 'blocked' })).toEqual([]);
    // `error` too, since §19.3: it diagnoses, it does not ask for a decision,
    // and it fades on its own. A button would be one more thing to aim at.
    expect(ids({ kind: 'error', message: 'boom', hint: 'try again' })).toEqual([]);
  });

  it('never draws live words, even when the view still carries an interim', () => {
    const recording = present({
      kind: 'recording',
      elapsedMs: 1_200,
      level: 0.3,
      interim: 'hello there',
      mode: 'hold',
    });
    expect(recording.liveText).toBeNull();
    expect(recording.capsule).toEqual({ kind: 'waveform', buttons: false });
    expect(recording.message).toBeNull();

    const processing = present({ kind: 'processing', interim: 'hello there' });
    expect(processing.liveText).toBeNull();
    expect(processing.capsule).toEqual({ kind: 'processing' });
  });

  it('leaves the capsule wordless when interim is empty', () => {
    expect(
      present({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' }).liveText,
    ).toBeNull();
    expect(present({ kind: 'processing', interim: '' }).liveText).toBeNull();
  });

  it('truncates a long interim to the tail if a surface ever asks', () => {
    const long = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo lima';
    const shown = recentLiveText(long);
    expect(shown.startsWith('…')).toBe(true);
    expect(shown.length).toBeLessThanOrEqual(LIVE_TEXT_MAX_CHARS + 1);
    expect(shown).toContain('lima');
  });

  it('gives the ✕/✓ buttons to hands-free only (overhaul §16.5c)', () => {
    expect(
      present({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' }).capsule,
    ).toEqual({ kind: 'waveform', buttons: false });
    expect(
      present({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'toggle' }).capsule,
    ).toEqual({ kind: 'waveform', buttons: true });
  });

  it('keeps the recording capsule wordless — no interim preview, no timer (overhaul §4.2)', () => {
    const p = present({
      kind: 'recording',
      elapsedMs: 61_000,
      level: 0.4,
      interim: 'halb fertig',
      mode: 'hold',
    });
    // 71 × 30 pt holds nothing but the bars; the interim was never the text
    // that gets inserted anyway.
    expect(p.message).toBeNull();
    expect(p.liveText).toBeNull();
  });

  it('colours failure red and the self-clearing pause amber (overhaul §16.5b)', () => {
    expect(
      present({ kind: 'not_inserted', text: LONG, reason: 'insert_failed', detail: null }).tone,
    ).toBe('error');
    expect(present({ kind: 'error', message: 'boom', hint: null }).tone).toBe('error');
    expect(present({ kind: 'blocked' }).tone).toBe('warning');
  });

  it('names Secure Input explicitly rather than failing silently (§12.2)', () => {
    const p = present({ kind: 'blocked' });
    expect(p.message?.title).toContain('Secure Input');
    expect(p.message?.detail).toMatch(/password field/i);
  });

  it('carries the error hint through', () => {
    const p = present({ kind: 'error', message: 'Token expired.', hint: 'Run `grok` to refresh.' });
    expect(p.message?.title).toBe('Token expired.');
    expect(p.message?.detail).toBe('Run `grok` to refresh.');
  });

  it('does not put helper diagnostics on the overlay when verification failed', () => {
    const fromHelper =
      'Terminal did not accept the keystrokes. Copy the text from the pill, or press ⌃⌘V somewhere else.';
    const p = present({
      kind: 'not_inserted',
      text: 'hi',
      reason: 'verification_failed',
      detail: fromHelper,
    });
    expect(p.message).toBeNull();
    expect(p.layer).toBe('capsule');
    expect(p.tone).toBe('error');
  });

  it('does not read a failed verification as "no tier would take it"', () => {
    // The helper reports `tier: 'unicode'` on this path — it *did* act — so
    // nothing may key on `tier === 'none'` to decide it was a failure.
    const p = present({
      kind: 'not_inserted',
      text: 'hi',
      reason: 'verification_failed',
      detail: null,
    });
    expect(p.label).not.toBe(notInsertedCopy('insert_failed').title);
    expect(p.tone).toBe('error');
  });

  it('keeps a helper diagnostic off the overlay even when there is one', () => {
    const p = present({
      kind: 'not_inserted',
      text: 'hi',
      reason: 'insert_failed',
      detail: 'kAXErrorAttributeUnsupported',
    });
    expect(p.message).toBeNull();
  });

  it('agrees with the shared layer switch about who gets the message pill', () => {
    for (const view of ALL_VIEWS) {
      const p = present(view);
      expect(p.message !== null).toBe(p.layer === 'capsule-message');
      expect(p.capsule !== null).toBe(p.layer !== 'none');
    }
  });
});

describe('an insert the helper could not confirm', () => {
  /**
   * The overlay that used to distinguish this from a confirmed insert was a
   * paragraph in the middle of the screen ("Typed — not confirmed"). That was
   * not wanted. History still records `verified`; the HUD is the same check.
   */
  const unconfirmed = (verified: boolean | null): HudView => ({
    kind: 'inserted',
    text: LONG,
    tier: 'unicode',
    verified,
  });

  it('draws the same wordless check as a confirmed insert', () => {
    const confirmed = present({ kind: 'inserted', text: LONG, tier: 'unicode', verified: true });
    for (const view of [unconfirmed(null), unconfirmed(false)]) {
      expect(present(view)).toEqual(confirmed);
    }
  });

  it('puts no transcript and no buttons on the overlay', () => {
    const p = present(unconfirmed(null));
    expect(p.message).toBeNull();
    expect(p.capsule).toEqual({ kind: 'check' });
    expect(p.layer).toBe('capsule');
  });
});

describe('notInsertedCopy', () => {
  const reasons: NotInsertedReason[] = [
    'insert_failed',
    'secure_input',
    'target_changed',
    'helper_unavailable',
    'verification_failed',
    'session_error',
    'session_error_unconfirmed',
  ];

  it('gives every reason its own words and something to do about it', () => {
    const titles = new Set<string>();
    for (const reason of reasons) {
      const { title, detail } = notInsertedCopy(reason);
      titles.add(title);
      expect(detail.length).toBeGreaterThan(20);
      // IMPLEMENTATION-PLAN.md §4: an error without an action is a defect.
      expect(detail).toMatch(/⌃⌘V|password field/);
    }
    expect(titles.size).toBe(reasons.length);
  });

  it('does not reuse a failure title for the "typed, unconfirmed" pill', () => {
    // Three different situations — it failed, it was typed but unverified, it
    // was typed and proved not to have arrived — and three different sentences.
    const titles = new Set(reasons.map((r) => notInsertedCopy(r).title));
    expect(titles.has(unconfirmedInsertCopy().title)).toBe(false);
  });
});

describe('tierLabel', () => {
  it('has a human name for every tier in the frozen contract', () => {
    for (const tier of INSERT_TIERS) expect(tierLabel(tier).length).toBeGreaterThan(0);
  });
});
