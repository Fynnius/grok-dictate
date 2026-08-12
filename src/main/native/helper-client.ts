/**
 * Typed client for the helper protocol — implements `NativeHelperPort`.
 *
 * OWNERSHIP: this directory belongs to **Phase 2** (IMPLEMENTATION-PLAN.md §2,
 * "TS-side client for the helper protocol (P1 leaves a stub)"). What is here is
 * Phase 1's stub: it is a complete, working client, but it talks to whatever
 * process the supervisor was given — in Phase 1 that is `mocks/mock-helper.mjs`.
 * Phase 2 owns this file and may rewrite it freely; the composition root only
 * knows `NativeHelperPort` from the frozen contract.
 *
 * The split against `src/main/bridge/` (Phase 1) is transport vs semantics: the
 * supervisor moves bytes and restarts processes, this file understands what the
 * frames mean and correlates requests to replies.
 */

import { randomUUID } from 'node:crypto';
import type { HelperToApp } from '@contracts/helper-protocol.js';
import type {
  FrontmostApp,
  HelperPermissions,
  InsertOutcome,
  NativeHelperPort,
} from '@contracts/ports.js';
import type { HotkeyBindings } from '@contracts/config.js';
import type { Logger } from '@shared/logger.js';
import type { HelperSupervisor } from '../bridge/helper-supervisor.js';

/**
 * How long to wait for an `insert_result` before giving up. Generous: the
 * Unicode tier deliberately paces itself (~20 UTF-16 units per event), so a
 * long transcript legitimately takes a while.
 */
export const INSERT_TIMEOUT_MS = 15_000;
export const FRONTMOST_TIMEOUT_MS = 2_000;

type Pending<T> = {
  resolve: (value: T) => void;
  timer: NodeJS.Timeout;
};

export class HelperClient implements NativeHelperPort {
  readonly #supervisor: HelperSupervisor;
  readonly #log: Logger;
  readonly #pendingInserts = new Map<string, Pending<InsertOutcome>>();
  readonly #pendingFrontmost = new Map<string, Pending<FrontmostApp>>();

  readonly #readyListeners = new Set<(caps: readonly string[]) => void>();
  readonly #hotkeyListeners = new Set<
    (action: 'ptt_down' | 'ptt_up' | 'toggle' | 'retry_insert', ts: number) => void
  >();
  readonly #secureInputListeners = new Set<(enabled: boolean) => void>();
  readonly #frontmostListeners = new Set<(app: FrontmostApp) => void>();
  readonly #permissionListeners = new Set<(permissions: HelperPermissions) => void>();

  #ready = false;
  #hotkeys: HotkeyBindings | null = null;
  /**
   * Last reported state, replayed to a late subscriber.
   *
   * The helper emits `permissions` moments after `ready`, and the tray
   * subscribes from `app.whenReady()`, so without this the first — and usually
   * only — report is missed and the tray shows a stale "Ready" for ever.
   */
  #permissions: HelperPermissions | null = null;

  constructor(supervisor: HelperSupervisor, logger: Logger) {
    this.#supervisor = supervisor;
    this.#log = logger.child('native');
    supervisor.onFrame((frame) => this.#onFrame(frame));
    supervisor.onExit((info) => this.#onExit(info.willRestart));
  }

  get isReady(): boolean {
    return this.#ready;
  }

  onReady(listener: (caps: readonly string[]) => void): () => void {
    this.#readyListeners.add(listener);
    return () => this.#readyListeners.delete(listener);
  }

  onHotkey(
    listener: (action: 'ptt_down' | 'ptt_up' | 'toggle' | 'retry_insert', ts: number) => void,
  ): () => void {
    this.#hotkeyListeners.add(listener);
    return () => this.#hotkeyListeners.delete(listener);
  }

  onSecureInput(listener: (enabled: boolean) => void): () => void {
    this.#secureInputListeners.add(listener);
    return () => this.#secureInputListeners.delete(listener);
  }

  onFrontmostChanged(listener: (app: FrontmostApp) => void): () => void {
    this.#frontmostListeners.add(listener);
    return () => this.#frontmostListeners.delete(listener);
  }

  onPermissions(listener: (permissions: HelperPermissions) => void): () => void {
    this.#permissionListeners.add(listener);
    if (this.#permissions !== null) listener(this.#permissions);
    return () => this.#permissionListeners.delete(listener);
  }

  /**
   * Always resolves — never rejects. A transcript must not be lost to an
   * exception, so a dead helper or a timeout comes back as a normal failed
   * outcome that the state machine already knows how to show.
   */
  insert(text: string, targetBundleId: string | null): Promise<InsertOutcome> {
    const id = randomUUID();
    const sent = this.#supervisor.send({ v: 1, type: 'insert', id, text, targetBundleId });
    if (!sent) {
      return Promise.resolve({
        tier: 'none',
        ok: false,
        error: 'the text-insertion helper is not running',
        reason: null,
      });
    }
    return new Promise<InsertOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingInserts.delete(id);
        this.#log.warn('insert timed out', { id, timeoutMs: INSERT_TIMEOUT_MS });
        resolve({
          tier: 'none',
          ok: false,
          error: 'the helper did not answer in time',
          reason: null,
        });
      }, INSERT_TIMEOUT_MS);
      timer.unref?.();
      this.#pendingInserts.set(id, { resolve, timer });
    });
  }

  copy(text: string): void {
    // : the ONLY pasteboard write in the whole application, and
    // only from an explicit user click. Phase 5 (§5b) audits every caller.
    this.#log.info('clipboard write requested by explicit user action', { chars: text.length });
    this.#supervisor.send({ v: 1, type: 'copy', text });
  }

  getFrontmost(): Promise<FrontmostApp> {
    const id = randomUUID();
    const sent = this.#supervisor.send({ v: 1, type: 'get_frontmost', id });
    if (!sent) return Promise.resolve({ bundleId: null, name: null });
    return new Promise<FrontmostApp>((resolve) => {
      const timer = setTimeout(() => {
        this.#pendingFrontmost.delete(id);
        resolve({ bundleId: null, name: null });
      }, FRONTMOST_TIMEOUT_MS);
      timer.unref?.();
      this.#pendingFrontmost.set(id, { resolve, timer });
    });
  }

  setHotkeys(bindings: HotkeyBindings): void {
    this.#hotkeys = bindings;
    this.#supervisor.send({
      v: 1,
      type: 'set_hotkeys',
      ptt: bindings.ptt,
      toggle: bindings.toggle,
      retry: bindings.retry,
    });
  }

  async shutdown(): Promise<void> {
    await this.#supervisor.stop();
  }

  #onFrame(frame: HelperToApp): void {
    switch (frame.type) {
      case 'ready': {
        this.#ready = true;
        this.#log.info('helper ready', { version: frame.version, caps: frame.caps });
        // Re-apply hotkeys after a restart, or the bindings silently revert to
        // the helper's defaults — another invisible failure.
        if (this.#hotkeys !== null) this.setHotkeys(this.#hotkeys);
        for (const l of this.#readyListeners) l(frame.caps);
        return;
      }
      case 'hotkey':
        for (const l of this.#hotkeyListeners) l(frame.action, frame.ts);
        return;
      case 'secure_input':
        for (const l of this.#secureInputListeners) l(frame.enabled);
        return;
      case 'permissions': {
        const permissions: HelperPermissions = {
          accessibility: frame.accessibility,
          hotkeyActive: frame.hotkeyActive,
        };
        this.#permissions = permissions;
        for (const l of this.#permissionListeners) l(permissions);
        return;
      }
      case 'frontmost': {
        const app: FrontmostApp = { bundleId: frame.bundleId, name: frame.name };
        if (frame.id !== undefined) {
          const pending = this.#pendingFrontmost.get(frame.id);
          if (pending !== undefined) {
            clearTimeout(pending.timer);
            this.#pendingFrontmost.delete(frame.id);
            pending.resolve(app);
            return;
          }
        }
        for (const l of this.#frontmostListeners) l(app);
        return;
      }
      case 'insert_result': {
        const pending = this.#pendingInserts.get(frame.id);
        if (pending === undefined) {
          this.#log.warn('insert_result for an unknown request', { id: frame.id });
          return;
        }
        clearTimeout(pending.timer);
        this.#pendingInserts.delete(frame.id);
        pending.resolve({
          tier: frame.tier,
          ok: frame.ok,
          error: frame.error,
          // `nullish` on the wire: an older helper build sends neither field.
          reason: frame.reason ?? null,
          frontmost: {
            bundleId: frame.frontmostBundleId ?? null,
            name: frame.frontmostName ?? null,
          },
        });
        return;
      }
      case 'log':
        // Consumed by the supervisor; never reaches here.
        return;
    }
  }

  #onExit(willRestart: boolean): void {
    this.#ready = false;
    // A dead helper has no hotkey, whatever it last reported.
    if (this.#permissions !== null) {
      this.#permissions = { ...this.#permissions, hotkeyActive: false };
      for (const l of this.#permissionListeners) l(this.#permissions);
    }
    // Fail every in-flight request rather than letting it hang to its timeout:
    // the user gets the "not inserted" HUD immediately and keeps the text.
    const reason = willRestart
      ? 'the text-insertion helper crashed and is restarting'
      : 'the text-insertion helper stopped';
    for (const [id, pending] of this.#pendingInserts) {
      clearTimeout(pending.timer);
      this.#pendingInserts.delete(id);
      pending.resolve({ tier: 'none', ok: false, error: reason, reason: null });
    }
    for (const [id, pending] of this.#pendingFrontmost) {
      clearTimeout(pending.timer);
      this.#pendingFrontmost.delete(id);
      pending.resolve({ bundleId: null, name: null });
    }
  }
}
