/**
 * OWNER: **Phase 4**; reshaped by the design overhaul, session 1
 * (grok-dictate-design-overhaul-2026-08-09.md §16.3).
 *
 * The HUD's view model: `HudView` (frozen, `contracts/events.ts`) in, a flat
 * description of what to draw out. Pure, so every state is unit-tested without
 * a window server — the React component below it is only markup.
 *
 * The HUD is two stacked pills (overhaul §16.3): a permanent-grammar **capsule**
 * at the bottom — waveform while recording, spinner while transcribing, a green
 * check when it landed, a red/amber fill when it did not — and a transient
 * **message pill** above it for the states that need words. Which states get
 * which surface is `hudLayer` in `src/shared/hud-view.ts`, the switch the main
 * process reads too.
 *
 * Two rules are encoded here rather than left to the markup, because they are
 * the parts that can silently regress:
 *
 *   - **`not_inserted` carries the full transcript** (§12.5, §16.5a). It is
 *     the one state where the words exist and are nowhere else on screen.
 *     `message.body` is therefore never truncated for it. (`inserted` no
 *     longer shows the transcript at all — that trade is argued in overhaul
 *     §16.4 and was the user's call, not an accident.)
 *   - **Every not-inserted reason gets its own words** (`NotInsertedReason`).
 *     "We couldn't type it" and "you were in a password field" call for
 *     different actions, and IMPLEMENTATION-PLAN.md §4 requires the actionable
 *     one ("Errors carry actionable text").
 */

import type { HudView, NotInsertedReason } from '@contracts/events.js';
import type { InsertTier } from '@contracts/helper-protocol.js';
import { hudLayer, type HudLayer } from '@shared/hud-view.js';

/**
 * The capsule's fill drives the tone: red for a failure the user must act on,
 * amber for a self-clearing pause (`blocked` — overhaul §16.5b: red for a
 * state the user causes by clicking a password field would train them to
 * ignore red).
 */
export type HudTone = 'idle' | 'recording' | 'processing' | 'success' | 'warning' | 'error';

/** Buttons the message pill can offer. `id` maps to a `RendererToMain` message. */
export type HudActionId = 'copy' | 'retry' | 'scratchpad' | 'dismiss';

export interface HudAction {
  readonly id: HudActionId;
  readonly label: string;
}

/** What the bottom capsule draws. */
export type HudCapsule =
  /** Ten level-driven bars; `buttons` adds ✕/✓ — hands-free only (§16.5c). */
  | { readonly kind: 'waveform'; readonly buttons: boolean }
  /** Flat bars with the spinner on the right. */
  | { readonly kind: 'processing' }
  /** The animated green check. */
  | { readonly kind: 'check' }
  /** A red or amber fill (by `tone`); the words are in the message pill. */
  | { readonly kind: 'alert' };

/** The transient pill above the capsule, for states that need words. */
export interface HudMessage {
  /** One short line. Never the transcript. */
  readonly title: string;
  /** The transcript, in full where §12.5 requires it. `null` when there is none. */
  readonly body: string | null;
  /** Secondary line: what to do about it. */
  readonly detail: string | null;
  readonly actions: readonly HudAction[];
}

export interface HudPresentation {
  readonly layer: HudLayer;
  readonly tone: HudTone;
  /** For assistive tech — the capsule itself carries no text. */
  readonly label: string;
  readonly capsule: HudCapsule | null;
  readonly message: HudMessage | null;
}

const RETRY_HINT = 'Press ⌃⌘V to try again wherever you are now pointing.';

export function tierLabel(tier: InsertTier): string {
  switch (tier) {
    case 'ax':
      return 'Accessibility';
    case 'unicode':
      return 'Keystrokes';
    case 'none':
      return 'not typed';
  }
}

/** Each reason gets its own sentence and its own advice. */
export function notInsertedCopy(reason: NotInsertedReason): { title: string; detail: string } {
  switch (reason) {
    case 'insert_failed':
      return {
        title: 'Not inserted',
        detail: `Neither insertion method was accepted by that app. ${RETRY_HINT}`,
      };
    case 'secure_input':
      return {
        title: 'Not inserted — password field',
        detail:
          'macOS Secure Input was active, so nothing was typed. Click out of the password field, then press ⌃⌘V.',
      };
    case 'target_changed':
      return {
        title: 'Not inserted — focus moved',
        detail: `The app you started dictating into is no longer frontmost. ${RETRY_HINT}`,
      };
    case 'helper_unavailable':
      return {
        title: 'Not inserted — helper unavailable',
        detail: `The input helper did not answer. Your text is safe below and in history. ${RETRY_HINT}`,
      };
    case 'session_error':
      // The turn itself failed part-way through. What is shown below is what
      // was transcribed before it did, and it is deliberately *not* typed —
      // half a sentence appearing in the user's editor is worse than none.
      // The specific failure arrives in `detail` and is appended to this.
      return {
        title: 'Not inserted — dictation interrupted',
        detail: `This is what had been transcribed before it failed. It was not typed, and it is in history. ${RETRY_HINT}`,
      };
  }
}

export function present(view: HudView): HudPresentation {
  const layer = hudLayer(view);
  switch (view.kind) {
    case 'hidden':
      return { layer, tone: 'idle', label: '', capsule: null, message: null };

    case 'recording':
      // No text, no timer, no interim preview: the reference capsule is
      // 71 × 30 pt and holds nothing but the bars (overhaul §4.2, §11.2.6 —
      // the interim was never the text that gets inserted anyway). Hands-free
      // is distinguished by its ✕/✓ buttons, not by a word.
      return {
        layer,
        tone: 'recording',
        label: view.mode === 'toggle' ? 'Hands-free recording' : 'Listening',
        capsule: { kind: 'waveform', buttons: view.mode === 'toggle' },
        message: null,
      };

    case 'processing':
      return {
        layer,
        tone: 'processing',
        label: 'Transcribing',
        capsule: { kind: 'processing' },
        message: null,
      };

    case 'inserted':
      // The green check, and nothing else — overhaul §16.4 records what this
      // trades away and why the user chose it.
      return {
        layer,
        tone: 'success',
        label: 'Inserted',
        capsule: { kind: 'check' },
        message: null,
      };

    case 'not_inserted': {
      const { title, detail } = notInsertedCopy(view.reason);
      return {
        layer,
        // Red, not amber: this is the failure the user must act on (§16.3).
        tone: 'error',
        label: title,
        capsule: { kind: 'alert' },
        message: {
          title,
          // Full text, not a summary: §12.5 / §16.5a.
          body: view.text,
          detail: view.detail === null ? detail : `${detail} (${view.detail})`,
          actions: [
            { id: 'copy', label: 'Copy' },
            { id: 'retry', label: 'Re-insert' },
            { id: 'scratchpad', label: 'Scratchpad' },
            { id: 'dismiss', label: 'Dismiss' },
          ],
        },
      };
    }

    case 'blocked':
      return {
        layer,
        // Amber: a self-clearing pause, not a failure (§16.5b).
        tone: 'warning',
        label: 'Blocked — Secure Input',
        capsule: { kind: 'alert' },
        message: {
          title: 'Blocked — Secure Input',
          body: null,
          // : this is one of the two silent failures.
          // Saying it out loud is the entire mitigation.
          detail:
            'A password field has focus. macOS blocks all key monitoring while it does, so dictation is paused.',
          actions: [],
        },
      };

    case 'error':
      return {
        layer,
        tone: 'error',
        label: view.message,
        capsule: { kind: 'alert' },
        message: {
          title: view.message,
          body: null,
          detail: view.hint,
          // No Dismiss (§19.3). Nothing here needs rescuing — the words are a
          // diagnosis, not a decision — so the button was one more thing to
          // aim at for something that leaves on its own in five seconds. It is
          // also what lets `error` stay click-through (`hudInteractive`): with
          // no button, the window has no reason to take a click meant for the
          // app underneath.
          actions: [],
        },
      };
  }
}
