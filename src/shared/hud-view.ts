/**
 * OWNER: **Design overhaul, session 1** (grok-dictate-design-overhaul-2026-08-09.md
 * §11.1.6, §12.2, §16).
 *
 * The HUD facts that BOTH processes need, stated once.
 *
 * Until this file existed, `hudSize`/`hudInteractive` in `src/main/hud/layout.ts`
 * and `present()` in `src/renderer/hud/presentation.ts` restated the same
 * knowledge — which states put words on screen, which take the mouse — in two
 * files that cannot import each other: `tsconfig.node.json` and
 * `tsconfig.web.json` are both `composite` with disjoint file lists (TS6307).
 * The redesign changes both switches, so the duplication had to go first.
 *
 * This module is visible to both projects the same way `src/shared/result.ts`
 * is: it is listed explicitly in `tsconfig.web.json`'s `include`, and it may
 * import nothing that needs `@types/node` or the DOM. Keep it pure.
 */

import type { HudView } from '@contracts/events.js';

/**
 * Whether two views would draw the same pixels.
 *
 * Every member of `HudView` is a flat record of primitives, so a shallow
 * comparison is an exact one — there is nowhere for a nested difference to
 * hide, and the type keeps it that way.
 *
 * Used to drop a redundant `hud.show` (2026-08-09 incident, BUG-7). Sending one
 * costs an IPC round trip and a re-render for a state the HUD is already in,
 * and while recording that used to happen about twenty times a second.
 */
export function sameHudView(a: HudView, b: HudView): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
}

/**
 * Which surfaces a view puts on screen — the overhaul's §16.3 two-pill design.
 *
 * - `none`             — nothing; the window hides.
 * - `capsule`          — only the bottom capsule (waveform / spinner / check).
 * - `capsule-message`  — the capsule plus the transient message pill above it,
 *                        for the states that need words: `blocked` (Secure
 *                        Input) and `error` (auth / no speech). Insert
 *                        outcomes stay in the capsule — a paragraph overlay
 *                        over the document was not wanted.
 */
export type HudLayer = 'none' | 'capsule' | 'capsule-message';

export function hudLayer(view: HudView): HudLayer {
  switch (view.kind) {
    case 'hidden':
      return 'none';
    case 'recording':
    case 'processing':
    case 'inserted':
    case 'not_inserted':
      return 'capsule';
    case 'blocked':
    case 'error':
      return 'capsule-message';
  }
}

/**
 * Whether the window takes the mouse at all.
 *
 * Click-through is a focus-safety property, not an ergonomic one: every moment
 * the pill is clickable is a moment a click aimed at the app underneath can be
 * swallowed by a window floating over it. Only states that
 * actually offer a button take the mouse.
 *
 * Insert outcomes, `blocked`, and `error` stay click-through — they have
 * nothing to press. Recovery is History and ⌃⌘V, not buttons on the overlay.
 *
 * Recording splits by mode (overhaul §16.5c): hold stays click-through — your
 * finger is on Fn and you could not click anyway — while hands-free takes the
 * mouse, because its ✕/✓ are real buttons and hands-free is exactly the mode
 * where a hand is free to press them. This is the one behaviour change in the
 * safety-critical direction, which is why `focus.e2e.test.ts` must be re-run
 * whenever it moves (§9.8, §12.1).
 */
export function hudInteractive(view: HudView): boolean {
  switch (view.kind) {
    case 'recording':
      return view.mode === 'toggle';
    case 'hidden':
    case 'processing':
    case 'inserted':
    case 'not_inserted':
    case 'blocked':
    case 'error':
      return false;
  }
}
