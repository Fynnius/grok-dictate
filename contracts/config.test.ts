import { describe, expect, it } from 'vitest';
import {
  AppConfigSchema,
  DEFAULT_CONFIG,
  parseConfig,
  resolveWireLanguage,
  resolveWireSttModel,
} from './config.js';

describe('config defaults', () => {
  it('defaults to auto language and no keyterms', () => {
    expect(DEFAULT_CONFIG.languageMode).toBe('auto');
    expect(DEFAULT_CONFIG.keyterms).toEqual([]);
  });

  it('defaults `sttModel` to `grok-stt` so the wire URL stays bit-identical', () => {
    expect(DEFAULT_CONFIG.sttModel).toBe('grok-stt');
  });

  it('keeps `grok-stt-2-fast` when the user asks for grok.com dictate', () => {
    const { config, issues } = parseConfig({ sttModel: 'grok-stt-2-fast' });
    expect(issues).toEqual([]);
    expect(config.sttModel).toBe('grok-stt-2-fast');
  });

  it('falls back to `grok-stt` for an sttModel it does not recognise', () => {
    const { config, issues } = parseConfig({ sttModel: 'whisper', endpointingMs: 250 });
    expect(issues.length).toBeGreaterThan(0);
    expect(config.sttModel).toBe('grok-stt');
    expect(config.endpointingMs).toBe(250);
  });

  it('defaults `useFinalize` to false on the evidence of spike 2', () => {
    // `finalize` measured 318-344 ms, the same as `audio.done`, and produced no
    // `transcript.done` — so no duration telemetry and no clean close.
    expect(DEFAULT_CONFIG.useFinalize).toBe(false);
  });

  it('departs from the Grok CLI endpointing default, deliberately', () => {
    // `config.rs:36-48` sets 400, which is right for a TUI prompt box and wrong
    // here: at 400 ms a hold was cut into 4.9 independently-transcribed segments
    // on average across 67 measured dictations, and every cut costs text. Ending
    // the turn does not wait for silence (spike 2), so a longer value is free.
    // See `DEFAULT_ENDPOINTING_MS`.
    expect(DEFAULT_CONFIG.endpointingMs).toBe(2_000);
  });

  it('repairs segment joins by default', () => {
    expect(DEFAULT_CONFIG.repairSeams).toBe(true);
  });

  it('keeps the pill wordless by default, and gates silent taps and mute on', () => {
    expect(DEFAULT_CONFIG.liveHudText).toBe(false);
    expect(DEFAULT_CONFIG.silenceGate).toBe(true);
    expect(DEFAULT_CONFIG.muteWhileRecording).toBe(true);
  });

  it('leaves Chromium microphone processing off by default', () => {
    expect(DEFAULT_CONFIG.micProcessing).toBe(false);
  });

  it('persists the new flags when they leave the default, so old behaviour is restorable', () => {
    const { config, issues } = parseConfig({
      liveHudText: true,
      silenceGate: false,
      muteWhileRecording: false,
      micProcessing: true,
    });
    expect(issues).toEqual([]);
    expect(config.liveHudText).toBe(true);
    expect(config.silenceGate).toBe(false);
    expect(config.muteWhileRecording).toBe(false);
    expect(config.micProcessing).toBe(true);
  });

  it('lets the helper choose the insertion route by default', () => {
    expect(DEFAULT_CONFIG.insertMethod).toBe('auto');
  });

  it('keeps `type` reachable, which is the pre-paste behaviour exactly', () => {
    // The escape hatch matters more than the default: it is what a user reaches
    // for if pasting trips macOS 26's Terminal paste-protection dialog, and
    // `type` never touches the pasteboard at all.
    const { config, issues } = parseConfig({ insertMethod: 'type' });
    expect(issues).toEqual([]);
    expect(config.insertMethod).toBe('type');
  });

  it('falls back to auto for an insertMethod it does not recognise', () => {
    // A config written by a future build, or hand-edited. Per-field salvage:
    // the bad value is reported and everything else survives.
    const { config, issues } = parseConfig({ insertMethod: 'telepathy', endpointingMs: 250 });
    expect(issues.length).toBeGreaterThan(0);
    expect(config.insertMethod).toBe('auto');
    expect(config.endpointingMs).toBe(250);
  });

  it('parses a config.json written before the setting existed', () => {
    const { config, issues } = parseConfig({ languageMode: 'de' });
    expect(issues).toEqual([]);
    expect(config.insertMethod).toBe('auto');
    expect(config.sttModel).toBe('grok-stt');
    expect(config.micProcessing).toBe(false);
  });

  it('ignores unknown extra fields rather than rejecting the file', () => {
    const { config, issues } = parseConfig({ languageMode: 'de', someFutureFlag: true });
    expect(issues).toEqual([]);
    expect(config.languageMode).toBe('de');
    expect(config.micProcessing).toBe(false);
  });
});

describe('parseConfig', () => {
  it('accepts a valid config unchanged', () => {
    const { config, issues } = parseConfig({ ...DEFAULT_CONFIG, languageMode: 'de' });
    expect(issues).toEqual([]);
    expect(config.languageMode).toBe('de');
  });

  it('salvages the good fields when one is invalid, rather than discarding the file', () => {
    const { config, issues } = parseConfig({ languageMode: 'klingon', endpointingMs: 250 });
    expect(issues.length).toBeGreaterThan(0);
    expect(config.languageMode).toBe('auto'); // fell back
    expect(config.endpointingMs).toBe(250); // survived
  });

  it('rejects a keyterm list that exceeds the documented limits', () => {
    // 100 terms x 50 chars.
    expect(AppConfigSchema.safeParse({ keyterms: [`${'x'.repeat(51)}`] }).success).toBe(false);
    expect(AppConfigSchema.safeParse({ keyterms: new Array<string>(101).fill('x') }).success).toBe(
      false,
    );
    expect(AppConfigSchema.safeParse({ keyterms: new Array<string>(100).fill('x') }).success).toBe(
      true,
    );
  });

  it('never throws on garbage', () => {
    for (const bad of [null, 42, 'nope', [], { keyterms: 'not an array' }]) {
      expect(() => parseConfig(bad)).not.toThrow();
    }
  });
});

describe('resolveWireLanguage', () => {
  // Spike 1/3: the server detects the language acoustically and reports it, so
  // `auto` omits the parameter rather than guessing a code.
  it('omits the parameter for auto', () => {
    expect(resolveWireLanguage('auto', undefined, 'de')).toBeNull();
    expect(resolveWireLanguage('auto', 'de', 'en')).toBeNull();
  });

  it('sends the explicit code for de and en', () => {
    expect(resolveWireLanguage('de', undefined, undefined)).toBe('de');
    expect(resolveWireLanguage('en', undefined, undefined)).toBe('en');
  });

  it('never returns the string "auto" — `language.rs:176-186`', () => {
    for (const mode of ['auto', 'de', 'en'] as const) {
      expect(resolveWireLanguage(mode, 'auto', 'auto')).not.toBe('auto');
    }
  });
});

describe('resolveWireSttModel', () => {
  it('omits `grok-stt` so the default URL stays bit-identical', () => {
    expect(resolveWireSttModel('grok-stt')).toBeNull();
  });

  it('sends `grok-stt-2-fast` (grok.com composer dictate)', () => {
    expect(resolveWireSttModel('grok-stt-2-fast')).toBe('grok-stt-2-fast');
  });
});
