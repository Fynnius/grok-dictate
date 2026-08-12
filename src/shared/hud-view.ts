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
 * Which surfaces a view puts on screen — the overhaul's §16.3 two-pill design.
 *
 * - `none`             — nothing; the window hides.
 * - `capsule`          — only the bottom capsule (waveform / spinner / check).
 * - `capsule-message`  — the capsule plus the transient message pill above it,
 *                        for the states that need words: `not_inserted`,
 *                        `blocked`, `error`.
 */
export type HudLayer = 'none' | 'capsule' | 'capsule-message';

export function hudLayer(view: HudView): HudLayer {
  switch (view.kind) {
    case 'hidden':
      return 'none';
    case 'recording':
    case 'processing':
    case 'inserted':
      return 'capsule';
    case 'not_inserted':
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
 * `blocked` shows a message pill but stays click-through — it has nothing to
 * press, and it can sit on screen for as long as a password field has focus.
 * `error` joined it in §19.3, for the same reason: its Dismiss button is gone,
 * so the only click it could take is one the user did not mean for it.
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
    case 'not_inserted':
      return true;
    case 'recording':
      return view.mode === 'toggle';
    case 'hidden':
    case 'processing':
    case 'inserted':
    case 'blocked':
    case 'error':
      return false;
  }
}
