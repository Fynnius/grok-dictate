import { describe, expect, it } from 'vitest';
import {
  AppConfigSchema,
  DEFAULT_CONFIG,
  DEFAULT_STT_MODEL,
  GROK_COM_STT_MODEL,
  parseConfig,
  resolveTurnSttModel,
  resolveWireLanguage,
  resolveWireSttModel,
} from './config.js';

describe('config defaults', () => {
  it('defaults to auto language and no keyterms', () => {
    expect(DEFAULT_CONFIG.languageMode).toBe('auto');
    expect(DEFAULT_CONFIG.keyterms).toEqual([]);
  });

  it('defaults dictation to the xAI API with Transcribe 2.0 pinned', () => {
    expect(DEFAULT_CONFIG.sttTransport).toBe('api');
    expect(DEFAULT_CONFIG.sttModel).toBe(DEFAULT_STT_MODEL);
  });

  it('migrates legacy `grok-stt-2-fast` to the grok.com transport', () => {
    const { config, issues } = parseConfig({ sttModel: 'grok-stt-2-fast' });
    expect(issues).toEqual([]);
    expect(config.sttTransport).toBe('grok-com');
    expect(config.sttModel).toBe(DEFAULT_STT_MODEL);
  });

  it('migrates legacy `grok-stt` to a Transcribe 2.0 pin on the API', () => {
    const { config, issues } = parseConfig({ sttModel: 'grok-stt' });
    expect(issues).toEqual([]);
    expect(config.sttTransport).toBe('api');
    expect(config.sttModel).toBe('grok-voice-transcribe-2.0');
  });

  it('keeps an unknown sttModel rather than rewriting it to the default', () => {
    const { config, issues } = parseConfig({
      sttModel: 'grok-voice-transcribe-3.0',
      endpointingMs: 250,
    });
    expect(issues).toEqual([]);
    expect(config.sttTransport).toBe('api');
    expect(config.sttModel).toBe('grok-voice-transcribe-3.0');
    expect(config.endpointingMs).toBe(250);
  });

  it('keeps an explicit grok.com transport when the API model is already pinned', () => {
    const { config, issues } = parseConfig({
      sttTransport: 'grok-com',
      sttModel: 'grok-voice-transcribe-1.0',
    });
    expect(issues).toEqual([]);
    expect(config.sttTransport).toBe('grok-com');
    expect(config.sttModel).toBe('grok-voice-transcribe-1.0');
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

  it('prefers the built-in microphone over a Bluetooth headset by default, and can be turned off', () => {
    expect(DEFAULT_CONFIG.preferBuiltInMic).toBe(true);
    const { config, issues } = parseConfig({ preferBuiltInMic: false });
    expect(issues).toEqual([]);
    expect(config.preferBuiltInMic).toBe(false);
  });

  it('lets the helper choose the insertion route by default', () => {
    expect(DEFAULT_CONFIG.insertMethod).toBe('auto');
  });

  it('keeps transcript history forever by default', () => {
    expect(DEFAULT_CONFIG.historyRetentionDays).toBe(0);
  });

  it('still parses an older config that set a retention window', () => {
    const { config, issues } = parseConfig({ historyRetentionDays: 90 });
    expect(issues).toEqual([]);
    expect(config.historyRetentionDays).toBe(90);
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
    expect(config.sttTransport).toBe('api');
    expect(config.sttModel).toBe(DEFAULT_STT_MODEL);
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
  it('pins Transcribe 2.0 for missing, empty, or legacy `grok-stt`', () => {
    expect(resolveWireSttModel(undefined)).toBe('grok-voice-transcribe-2.0');
    expect(resolveWireSttModel(null)).toBe('grok-voice-transcribe-2.0');
    expect(resolveWireSttModel('')).toBe('grok-voice-transcribe-2.0');
    expect(resolveWireSttModel('grok-stt')).toBe('grok-voice-transcribe-2.0');
  });

  it('sends catalog slugs and grok.com Fast as written', () => {
    expect(resolveWireSttModel('grok-voice-transcribe-2.0')).toBe('grok-voice-transcribe-2.0');
    expect(resolveWireSttModel('grok-voice-transcribe-1.0')).toBe('grok-voice-transcribe-1.0');
    expect(resolveWireSttModel(GROK_COM_STT_MODEL)).toBe(GROK_COM_STT_MODEL);
    expect(resolveWireSttModel('grok-voice-transcribe-3.0')).toBe('grok-voice-transcribe-3.0');
  });
});

describe('resolveTurnSttModel', () => {
  it('sends Fast on the grok.com transport regardless of the stored API model', () => {
    expect(
      resolveTurnSttModel({
        sttTransport: 'grok-com',
        sttModel: 'grok-voice-transcribe-1.0',
      }),
    ).toBe(GROK_COM_STT_MODEL);
  });

  it('sends the pinned API slug on the api transport', () => {
    expect(
      resolveTurnSttModel({
        sttTransport: 'api',
        sttModel: 'grok-voice-transcribe-1.0',
      }),
    ).toBe('grok-voice-transcribe-1.0');
  });

  it('does not send Fast at api.x.ai even if the leftover slug is still in sttModel', () => {
    expect(resolveTurnSttModel({ sttTransport: 'api', sttModel: GROK_COM_STT_MODEL })).toBe(
      DEFAULT_STT_MODEL,
    );
  });
});
