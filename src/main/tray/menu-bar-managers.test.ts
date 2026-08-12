import { describe, expect, it } from 'vitest';
import { detectMenuBarManagers, KNOWN_MENU_BAR_MANAGERS } from './menu-bar-managers.js';

/**
 * A real fragment of `lsappinfo list`, trimmed. The shape that matters is the
 * `bundleID="…"` field, which is what the detector matches on.
 */
const LSAPPINFO = `
   1) "Finder" ASN:0x0-0x1e01e: bundleID="com.apple.finder" version="1622" arch=arm64
      pid = 636 type="Foreground" flavor="Carbon" fbsPid=636
   2) "Hidden Bar" ASN:0x0-0x2f02f: bundleID="com.dwarvesv.minimalbar" version="1.9"
      pid = 850 type="UIElement" flavor="Cocoa" fbsPid=850
   3) "Electron" ASN:0x0-0x3a03a: bundleID="com.github.Electron" version="43.3.0"
      pid = 63206 type="UIElement" flavor="Cocoa" fbsPid=63206
`;

describe('detectMenuBarManagers', () => {
  it('finds a running manager by bundle id', () => {
    // The real observation from Phase 5: `Hidden Bar.app` was running with
    // auto-hide on and its separators hidden, which is why Phase 4's HT-6
    // could not find the tray icon in three attempts.
    expect(detectMenuBarManagers(LSAPPINFO).map((m) => m.name)).toEqual(['Hidden Bar']);
  });

  it('reports nothing on a machine with none installed', () => {
    expect(detectMenuBarManagers('   1) "Finder" bundleID="com.apple.finder"')).toEqual([]);
  });

  it('does not match on a name that merely resembles one', () => {
    // `Ice` is a short word; matching anything looser than the bundle id would
    // fire on half the machines in the world.
    expect(detectMenuBarManagers('"Ice Cubes" bundleID="com.example.icecubes"')).toEqual([]);
  });

  it('gives every manager an actionable remedy', () => {
    // IMPLEMENTATION-PLAN.md §4: "Errors carry actionable text." A warning that
    // says only "a menu-bar manager is running" would leave the user exactly
    // where Phase 4's HT-6 left them.
    for (const manager of KNOWN_MENU_BAR_MANAGERS) {
      expect(manager.remedy.length).toBeGreaterThan(20);
      expect(manager.bundleId).toMatch(/^[a-z0-9.-]+$/i);
    }
  });
});
