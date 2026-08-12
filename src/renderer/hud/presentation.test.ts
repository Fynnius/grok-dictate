import { describe, expect, it } from 'vitest';
import type { HudView, NotInsertedReason } from '@contracts/events.js';
import { INSERT_TIERS } from '@contracts/helper-protocol.js';
import { notInsertedCopy, present, tierLabel } from './presentation.js';

/** A transcript long enough that any truncation would be obvious. */
const LONG =
  'Deployed that on the staging server and then ran the migration, ' +
  'weil der Pod sonst neu gestartet wäre — plus Umlaute äöü und ein Emoji 🎧.';

const ALL_VIEWS: HudView[] = [
  { kind: 'hidden' },
  { kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' },
  { kind: 'recording', elapsedMs: 61_000, level: 0.4, interim: 'guten', mode: 'toggle' },
  { kind: 'processing', interim: 'hello there' },
  { kind: 'inserted', text: LONG, tier: 'ax' },
  { kind: 'not_inserted', text: LONG, reason: 'insert_failed', detail: null },
  { kind: 'blocked' },
  { kind: 'error', message: 'No speech was detected.', hint: 'Check the microphone.' },
];

describe('present', () => {
  it('handles every HudView kind without throwing', () => {
    for (const view of ALL_VIEWS) expect(() => present(view)).not.toThrow();
  });

  it('shows the FULL transcript in not_inserted', () => {
    // This is the assertion that stops a "tidy" truncation from hiding the one
    // state where the words exist and are nowhere else on screen.
    expect(
      present({ kind: 'not_inserted', text: LONG, reason: 'insert_failed', detail: null }).message
        ?.body,
    ).toBe(LONG);
  });

  it('reduces inserted to the green check — no transcript, by decision (overhaul §16.4)', () => {
    const p = present({ kind: 'inserted', text: LONG, tier: 'unicode' });
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

  it('offers Copy and Re-insert only where the text still needs rescuing', () => {
    const ids = (view: HudView): string[] =>
      (present(view).message?.actions ?? []).map((a) => a.id);
    expect(
      ids({ kind: 'not_inserted', text: LONG, reason: 'insert_failed', detail: null }),
    ).toEqual(['copy', 'retry', 'scratchpad', 'dismiss']);
    expect(ids({ kind: 'inserted', text: LONG, tier: 'ax' })).toEqual([]);
    expect(ids({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'hold' })).toEqual(
      [],
    );
    expect(ids({ kind: 'blocked' })).toEqual([]);
    // `error` too, since §19.3: it diagnoses, it does not ask for a decision,
    // and it fades on its own. A button would be one more thing to aim at.
    expect(ids({ kind: 'error', message: 'boom', hint: 'try again' })).toEqual([]);
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

  it('appends the helper diagnostic when there is one', () => {
    const p = present({
      kind: 'not_inserted',
      text: 'hi',
      reason: 'insert_failed',
      detail: 'kAXErrorAttributeUnsupported',
    });
    expect(p.message?.detail).toContain('kAXErrorAttributeUnsupported');
  });

  it('agrees with the shared layer switch about who gets the message pill', () => {
    for (const view of ALL_VIEWS) {
      const p = present(view);
      expect(p.message !== null).toBe(p.layer === 'capsule-message');
      expect(p.capsule !== null).toBe(p.layer !== 'none');
    }
  });
});

describe('notInsertedCopy', () => {
  const reasons: NotInsertedReason[] = [
    'insert_failed',
    'secure_input',
    'target_changed',
    'helper_unavailable',
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
});

describe('tierLabel', () => {
  it('has a human name for every tier in the frozen contract', () => {
    for (const tier of INSERT_TIERS) expect(tierLabel(tier).length).toBeGreaterThan(0);
  });
});
