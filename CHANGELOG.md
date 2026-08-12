# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
