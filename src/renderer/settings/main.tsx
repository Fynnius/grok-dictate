/**
 * OWNER: **Phase 4**. The three panel windows, in one renderer entry.
 *
 * Which view renders is decided by the URL hash, which `src/main/ui/panels.ts`
 * sets when it opens the window. See `panel-target.ts` for why they share an
 * entry — `electron.vite.config.ts` is frozen.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HistoryView } from './HistoryView.js';
import { ScratchpadView } from './ScratchpadView.js';
import { SettingsView } from './SettingsView.js';
import { StatsView } from './StatsView.js';
import './panels.css';

/**
 * Mirrors `panelFromHash` in `src/main/ui/panel-target.ts` — the two tsconfig
 * projects are disjoint and `composite`, so a main-process module cannot be
 * imported here (see the header of `src/main/hud/layout.ts` for the same
 * constraint and the cross-boundary request it raises).
 */
function viewFromHash(hash: string): React.JSX.Element {
  switch (hash.replace(/^#\/?/, '')) {
    case 'history':
      return <HistoryView />;
    case 'scratchpad':
      return <ScratchpadView />;
    case 'stats':
      return <StatsView />;
    default:
      return <SettingsView />;
  }
}

const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<StrictMode>{viewFromHash(window.location.hash)}</StrictMode>);
}
