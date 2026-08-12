import { describe, expect, it } from 'vitest';
import {
  PANEL_ENTRY,
  PANEL_NAMES,
  panelFromHash,
  panelTarget,
  panelWindowSpec,
} from './panel-target.js';

describe('panelTarget', () => {
  it('loads from the dev server when electron-vite provides one', () => {
    const target = panelTarget('history', 'http://localhost:5173', '/irrelevant');
    expect(target).toEqual({
      kind: 'url',
      url: 'http://localhost:5173/settings/index.html#/history',
    });
  });

  it('loads from disk in a packaged build, with the hash passed separately', () => {
    const target = panelTarget('scratchpad', undefined, '/app/out/renderer');
    // Electron's loadFile takes `hash` as an option and adds the `#` itself.
    expect(target).toEqual({
      kind: 'file',
      path: '/app/out/renderer/settings/index.html',
      hash: '/scratchpad',
    });
  });

  it('routes all three panels through the one entry Phase 1 froze', () => {
    for (const panel of PANEL_NAMES) {
      const dev = panelTarget(panel, 'http://x', '/r');
      const packaged = panelTarget(panel, undefined, '/r');
      if (dev.kind !== 'url' || packaged.kind !== 'file') throw new Error('unexpected target kind');
      expect(dev.url).toContain(`/${PANEL_ENTRY}/index.html#/${panel}`);
      expect(packaged.path).toContain(`/${PANEL_ENTRY}/index.html`);
      expect(packaged.hash).toBe(`/${panel}`);
    }
  });
});

describe('panelFromHash', () => {
  it('reads the route the window was opened for', () => {
    expect(panelFromHash('#/history')).toBe('history');
    expect(panelFromHash('#/scratchpad')).toBe('scratchpad');
    expect(panelFromHash('#/settings')).toBe('settings');
  });

  it('tolerates the shapes a browser actually produces', () => {
    expect(panelFromHash('#history')).toBe('history');
    expect(panelFromHash('')).toBe('settings');
    expect(panelFromHash('#')).toBe('settings');
  });

  it('falls back to Settings rather than rendering nothing', () => {
    expect(panelFromHash('#/nonsense')).toBe('settings');
    expect(panelFromHash('#/../../etc/passwd')).toBe('settings');
  });

  it('round-trips every panel through its own target', () => {
    for (const panel of PANEL_NAMES) {
      const target = panelTarget(panel, 'http://x', '/r');
      if (target.kind !== 'url') throw new Error('expected a url target');
      const hash = target.url.slice(target.url.indexOf('#'));
      expect(panelFromHash(hash)).toBe(panel);
    }
  });
});

describe('panelWindowSpec', () => {
  it('gives every panel a title and a usable minimum size', () => {
    for (const panel of PANEL_NAMES) {
      const spec = panelWindowSpec(panel);
      expect(spec.title).toContain('Grok Dictate');
      expect(spec.minWidth).toBeLessThanOrEqual(spec.width);
      expect(spec.minHeight).toBeLessThanOrEqual(spec.height);
      expect(spec.minWidth).toBeGreaterThan(200);
    }
  });

  it('gives History the most room, since it is the searchable surface', () => {
    expect(panelWindowSpec('history').width).toBeGreaterThan(panelWindowSpec('scratchpad').width);
  });
});
