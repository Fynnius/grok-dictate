import { describe, expect, it } from 'vitest';
import type { HudView } from '@contracts/events.js';
import { hudInteractive, hudLayer } from './hud-view.js';

const VIEWS: Record<HudView['kind'], HudView> = {
  hidden: { kind: 'hidden' },
  recording: { kind: 'recording', elapsedMs: 3_000, level: 0.3, interim: 'hallo', mode: 'hold' },
  processing: { kind: 'processing', interim: 'hallo' },
  inserted: { kind: 'inserted', text: 'hallo', tier: 'ax' },
  not_inserted: { kind: 'not_inserted', text: 'hallo', reason: 'insert_failed', detail: null },
  blocked: { kind: 'blocked' },
  error: { kind: 'error', message: 'boom', hint: null },
};

describe('hudLayer', () => {
  it('shows the message pill exactly for the states that need words (§16.3)', () => {
    expect(hudLayer(VIEWS.not_inserted)).toBe('capsule-message');
    expect(hudLayer(VIEWS.blocked)).toBe('capsule-message');
    expect(hudLayer(VIEWS.error)).toBe('capsule-message');
  });

  it('keeps the live and success states down to the capsule alone', () => {
    expect(hudLayer(VIEWS.recording)).toBe('capsule');
    expect(hudLayer(VIEWS.processing)).toBe('capsule');
    expect(hudLayer(VIEWS.inserted)).toBe('capsule');
  });

  it('hides for hidden', () => {
    expect(hudLayer(VIEWS.hidden)).toBe('none');
  });
});

describe('hudInteractive', () => {
  it('takes the mouse only where there is a button to press', () => {
    // `not_inserted` is the last one: its Copy button is the only route to the
    // pasteboard in the product, and the text exists nowhere else on screen.
    expect(hudInteractive(VIEWS.not_inserted)).toBe(true);
  });

  it('is click-through everywhere else, so a click reaches the app underneath', () => {
    expect(hudInteractive(VIEWS.hidden)).toBe(false);
    expect(hudInteractive(VIEWS.processing)).toBe(false);
    expect(hudInteractive(VIEWS.inserted)).toBe(false);
    // `blocked` shows words but offers nothing to press — it must never
    // swallow the click that dismisses the password field it points at.
    expect(hudInteractive(VIEWS.blocked)).toBe(false);
    // `error` is the same shape since §19.3 took its Dismiss button away: it
    // is a sentence that leaves on its own, not something to interact with.
    expect(hudInteractive(VIEWS.error)).toBe(false);
  });

  it('splits recording by mode (§16.5c): hold is click-through, hands-free takes the mouse', () => {
    expect(hudInteractive(VIEWS.recording)).toBe(false);
    expect(
      hudInteractive({ kind: 'recording', elapsedMs: 0, level: 0, interim: '', mode: 'toggle' }),
    ).toBe(true);
  });
});
