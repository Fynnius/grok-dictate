# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Transcript accuracy. A hold is cut into segments whenever the speaker pauses, and each segment is re-transcribed with no knowledge of the one before it — so the joins, not the recognition, were where the text was going wrong. Measured over 67 real dictations: 4.9 segments per hold, one every ~8 s, worst case 41.

### Changed

- **`endpointingMs` now defaults to 2,000 ms, not 400.** 400 came from the Grok CLI, where each segment is its own submitted line; here it cut a hold into five. Ending a turn does not wait for silence, so the longer value costs nothing in latency. Existing settings are untouched — change it under Settings → Dictation.
- Segment joins are repaired before insertion: a duplicated word across the seam is dropped, a sentence capital that lands mid-sentence is lowered, and a "Thank you." hallucinated out of the leading or trailing silence is removed. Deterministic and conservative — no model, and content words are never touched. New **Settings → Dictation → Repair segment joins** turns it off.
- The applied microphone processing (`echoCancellation`, `noiseSuppression`, `autoGainControl` as the device actually reports them) is logged with every capture, so whether Chromium's telephony-tuned processing helps or hurts accuracy here can finally be measured.

### Added

- **The Grok CLI login now renews itself.** A CLI token lasts hours, so a menu-bar app left running reliably met an expired one — and the result was a dead `Fn` key and an error pill telling you to go and run `grok` yourself. Grok Dictate now runs that command for you: `grok models`, in the background, about four minutes before the token expires, and again at startup if it expired while the app was closed. A dictation that still meets an expired token renews on the spot and continues.

  It is **not** a token refresh path, and the distinction is deliberate — §5.6 forbids one, and `test/e2e/audit-5b.test.ts` still passes over this code unchanged. Nothing here mints, rotates or writes a token; `grok` does all of it, holding `auth.json.lock` exactly as it does when a human runs it.

  Two behaviours worth knowing, both measured against `grok 1.0.5` and documented in `src/main/auth/renew.ts`: a refresh the **server rejects** makes the CLI clear `auth.json` — the login really is gone at that point and you will get the Sign in window — while a refresh that fails because you are **offline** leaves your credentials untouched. Turn the whole thing off with **Settings → General → Keep the Grok CLI login signed in**. Does nothing if you use an xAI API key, which does not expire.

- `npm run replay:history` — replays your own transcripts through the seam repairer and prints what it would have changed. Run it before and after touching a rule; a rule that fires on well-formed sentences is too eager whatever its unit tests say. Reads only, prints locally, sends nothing anywhere.

### Fixed

- A `speech_final` arriving after the insert was dispatched was silently discarded — losing the last segment of the turn from the pill, from History and from `Ctrl+Cmd+V`. It is now kept everywhere except the keystrokes, and logged.
- `src/main/stt/frames.ts` described `speech_final` as a re-transcription "of the whole turn". It is one segment. That sentence is why the joins were treated as concatenation for so long.

## [0.1.0] — 2026-08-12

First public-ready release of Grok Dictate. Ad-hoc signed Apple Silicon build — not notarized. See the Gatekeeper note in the [release](https://github.com/Fynnius/grok-dictate/releases/tag/v0.1.0).

### Added

- Hold `Fn` to dictate; `Fn+Space` for hands-free; `Ctrl+Cmd+V` to re-insert
- Streaming transcription against `wss://api.x.ai/v1/stt`
- First-run Sign in window for an xAI API key (Keychain via Electron safeStorage)
- Automatic use of an existing Grok CLI login at `~/.grok/auth.json`
- Menu-bar HUD, History, Scratchpad, and Settings
- Swift helper for the global hotkey and the Accessibility → Unicode insertion ladder
- The clipboard is written only when the user clicks Copy
