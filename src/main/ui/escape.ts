/**
 * OWNER: **Phase 4**. Escape cancels a recording.
 *
 * "Without it, a misfire forces the user to insert garbage" — so this is a
 * correctness feature, not a convenience.
 *
 * ## Why a global shortcut, and only sometimes
 *
 * The HUD is `focusable: false` and can therefore never receive a key event, and
 * the app has no other window in front of the user while dictating. The only
 * way to see Escape is `globalShortcut`, which takes the key system-wide — so
 * it is registered **only while a turn is actually in flight** and released the
 * moment it is not. Holding Escape permanently would break Escape in every
 * other application on the machine.
 *
 * `recording` and `processing` are both armed: the "oh no, not that" reaction
 * usually lands just after the key is released, and `processing` is a few
 * hundred milliseconds (docs/spike-results.md: 318–344 ms end-of-audio to
 * `speech_final`). `inserting` is not armed, because `state-machine.md` §3
 * ignores `CANCEL` there — an insert already dispatched cannot be recalled.
 */

import type { SessionState } from '@contracts/events.js';
import type { Logger } from '@shared/logger.js';

export const ESCAPE_ACCELERATOR = 'Escape';

/** The slice of Electron's `globalShortcut` this needs — so it can be faked. */
export interface ShortcutRegistrar {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
  isRegistered(accelerator: string): boolean;
}

/** Escape is only meaningful while there is a turn to throw away. */
export function shouldArmEscape(state: SessionState): boolean {
  switch (state) {
    case 'recording':
    case 'processing':
      return true;
    case 'idle':
    case 'inserting':
    case 'blocked':
      return false;
  }
}

export class EscapeCancel {
  #armed = false;
  readonly #registrar: ShortcutRegistrar;
  readonly #onCancel: () => void;
  readonly #log: Logger;

  constructor(registrar: ShortcutRegistrar, onCancel: () => void, logger: Logger) {
    this.#registrar = registrar;
    this.#onCancel = onCancel;
    this.#log = logger.child('escape');
  }

  get armed(): boolean {
    return this.#armed;
  }

  /** Drive from every session transition. Idempotent. */
  setState(state: SessionState): void {
    const want = shouldArmEscape(state);
    if (want === this.#armed) return;
    if (want) this.#arm();
    else this.#disarm();
  }

  dispose(): void {
    this.#disarm();
  }

  #arm(): void {
    const ok = this.#registrar.register(ESCAPE_ACCELERATOR, () => {
      this.#log.info('escape pressed — cancelling the turn');
      this.#onCancel();
    });
    if (!ok) {
      // Another application holds Escape. Say so once rather than leaving the
      // user to discover that cancel silently does nothing.
      this.#log.warn('could not take Escape; another app holds it, so cancel is unavailable');
      return;
    }
    this.#armed = true;
  }

  #disarm(): void {
    if (!this.#armed) return;
    this.#armed = false;
    // Give Escape straight back: holding it while idle would break Escape
    // everywhere else on the machine.
    if (this.#registrar.isRegistered(ESCAPE_ACCELERATOR)) {
      this.#registrar.unregister(ESCAPE_ACCELERATOR);
    }
  }
}
