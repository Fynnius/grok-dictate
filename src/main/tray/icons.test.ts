/**
 * The tray icons are the only surface that can tell the user why the hotkey has
 * stopped responding, so "the icon decodes and is
 * the right size" is worth asserting rather than eyeballing once.
 */

import { describe, expect, it } from 'vitest';
import { TRAY_ICON_PNG_BASE64, trayIconDataUrl, type TrayIconName } from './icons.js';

const NAMES: TrayIconName[] = ['idle', 'recording', 'blocked'];

/** Read a PNG's IHDR without a decoder: signature (8) + length (4) + type (4). */
function pngHeader(base64: string): { width: number; height: number; colourType: number } {
  const buffer = Buffer.from(base64, 'base64');
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  expect([...buffer.subarray(0, 8)]).toEqual(signature);
  expect(buffer.subarray(12, 16).toString('ascii')).toBe('IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    colourType: buffer[25] ?? -1,
  };
}

describe('TRAY_ICON_PNG_BASE64', () => {
  it('has an icon for each of the three states the tray must distinguish', () => {
    for (const name of NAMES) {
      expect(TRAY_ICON_PNG_BASE64[name].x1.length).toBeGreaterThan(0);
      expect(TRAY_ICON_PNG_BASE64[name].x2.length).toBeGreaterThan(0);
    }
  });

  it('decodes to 16x16 and 32x32 RGBA PNGs', () => {
    for (const name of NAMES) {
      const x1 = pngHeader(TRAY_ICON_PNG_BASE64[name].x1);
      expect([x1.width, x1.height]).toEqual([16, 16]);
      const x2 = pngHeader(TRAY_ICON_PNG_BASE64[name].x2);
      expect([x2.width, x2.height]).toEqual([32, 32]);
      // Colour type 6 = RGBA. A template image lives entirely in its alpha
      // channel, so the alpha channel has to exist.
      expect(x1.colourType).toBe(6);
      expect(x2.colourType).toBe(6);
    }
  });

  it('gives every state a visually distinct glyph', () => {
    // Identical bytes would mean the user cannot tell recording from blocked —
    // which is the entire job of the icon.
    const seen = new Set(NAMES.map((n) => TRAY_ICON_PNG_BASE64[n].x1));
    expect(seen.size).toBe(NAMES.length);
  });

  it('stays small enough to be worth embedding', () => {
    for (const name of NAMES) {
      const bytes = Buffer.from(TRAY_ICON_PNG_BASE64[name].x2, 'base64').byteLength;
      expect(bytes).toBeLessThan(4_096);
    }
  });
});

describe('trayIconDataUrl', () => {
  it('produces what nativeImage.createFromDataURL expects', () => {
    expect(trayIconDataUrl('AAAA')).toBe('data:image/png;base64,AAAA');
  });
});
