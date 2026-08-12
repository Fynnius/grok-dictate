import { describe, expect, it } from 'vitest';
import { SESSION_STATES } from '@contracts/events.js';
import { createLogger } from '@shared/logger.js';
import {
  EscapeCancel,
  ESCAPE_ACCELERATOR,
  shouldArmEscape,
  type ShortcutRegistrar,
} from './escape.js';

const log = createLogger('test');

class FakeRegistrar implements ShortcutRegistrar {
  readonly calls: string[] = [];
  handler: (() => void) | null = null;
  /** Simulates another application already holding the key. */
  refuse = false;

  register(accelerator: string, callback: () => void): boolean {
    this.calls.push(`register:${accelerator}`);
    if (this.refuse) return false;
    this.handler = callback;
    return true;
  }
  unregister(accelerator: string): void {
    this.calls.push(`unregister:${accelerator}`);
    this.handler = null;
  }
  isRegistered(): boolean {
    return this.handler !== null;
  }
}

describe('shouldArmEscape', () => {
  it('arms while there is still a turn to throw away', () => {
    expect(shouldArmEscape('recording')).toBe(true);
    expect(shouldArmEscape('processing')).toBe(true);
  });

  it('does not arm where the machine ignores CANCEL anyway', () => {
    // state-machine.md §3: an insert already dispatched cannot be recalled.
    expect(shouldArmEscape('inserting')).toBe(false);
    expect(shouldArmEscape('idle')).toBe(false);
    expect(shouldArmEscape('blocked')).toBe(false);
  });

  it('decides for every session state', () => {
    for (const state of SESSION_STATES) expect(typeof shouldArmEscape(state)).toBe('boolean');
  });
});

describe('EscapeCancel', () => {
  it('takes Escape only while dictating and gives it straight back', () => {
    const registrar = new FakeRegistrar();
    const escape = new EscapeCancel(registrar, () => undefined, log);

    escape.setState('idle');
    expect(registrar.calls).toEqual([]); // never held while idle

    escape.setState('recording');
    expect(escape.armed).toBe(true);
    expect(registrar.calls).toEqual([`register:${ESCAPE_ACCELERATOR}`]);

    escape.setState('idle');
    expect(escape.armed).toBe(false);
    expect(registrar.calls).toEqual([
      `register:${ESCAPE_ACCELERATOR}`,
      `unregister:${ESCAPE_ACCELERATOR}`,
    ]);
  });

  it('stays armed across recording → processing without re-registering', () => {
    const registrar = new FakeRegistrar();
    const escape = new EscapeCancel(registrar, () => undefined, log);
    escape.setState('recording');
    escape.setState('processing');
    expect(registrar.calls).toEqual([`register:${ESCAPE_ACCELERATOR}`]);
    expect(escape.armed).toBe(true);
  });

  it('releases Escape when an insert starts', () => {
    const registrar = new FakeRegistrar();
    const escape = new EscapeCancel(registrar, () => undefined, log);
    escape.setState('recording');
    escape.setState('inserting');
    expect(escape.armed).toBe(false);
    expect(registrar.isRegistered()).toBe(false);
  });

  it('cancels when the key is pressed', () => {
    const registrar = new FakeRegistrar();
    let cancels = 0;
    const escape = new EscapeCancel(registrar, () => (cancels += 1), log);
    escape.setState('recording');
    registrar.handler?.();
    expect(cancels).toBe(1);
  });

  it('is idempotent under repeated transitions', () => {
    const registrar = new FakeRegistrar();
    const escape = new EscapeCancel(registrar, () => undefined, log);
    for (let n = 0; n < 3; n += 1) escape.setState('recording');
    for (let n = 0; n < 3; n += 1) escape.setState('idle');
    expect(registrar.calls).toEqual([
      `register:${ESCAPE_ACCELERATOR}`,
      `unregister:${ESCAPE_ACCELERATOR}`,
    ]);
  });

  it('stays disarmed, and does not pretend otherwise, when another app holds Escape', () => {
    const registrar = new FakeRegistrar();
    registrar.refuse = true;
    const escape = new EscapeCancel(registrar, () => undefined, log);
    escape.setState('recording');
    expect(escape.armed).toBe(false);
    // No unregister for a key we never got.
    escape.setState('idle');
    expect(registrar.calls).toEqual([`register:${ESCAPE_ACCELERATOR}`]);
  });

  it('releases the key on dispose', () => {
    const registrar = new FakeRegistrar();
    const escape = new EscapeCancel(registrar, () => undefined, log);
    escape.setState('recording');
    escape.dispose();
    expect(registrar.isRegistered()).toBe(false);
    expect(escape.armed).toBe(false);
  });
});
