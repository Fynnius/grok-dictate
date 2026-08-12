# Security policy

## Supported versions

The `main` branch is the only supported line. There is no long-term release train yet.

## What this app holds

- An xAI API key, encrypted with Electron `safeStorage` (macOS Keychain) in the app's user-data folder
- Or a read-only view of `~/.grok/auth.json` (the Grok CLI's own store)
- Local transcript history in the app's user-data folder
- Microphone audio, streamed to `wss://api.x.ai/v1/stt` only while a turn is active

The Swift helper runs with Accessibility and Input Monitoring. It never sees a bearer token.

## Please report

- Anything that could put a bearer token or API key in a log, an error, history, or a helper frame
- A path that writes the clipboard without an explicit Copy click
- A way to inject PCM or insertion commands from a renderer that should not own that surface
- Privilege issues in the Swift helper

## Please do not report

- “The app is unsigned / Gatekeeper warns” — known, documented in the README
- Rate limits or outages of the xAI speech service
- Missing permissions after a rebuild — TCC is keyed to the bundle identity

## How to report

Use [GitHub private vulnerability reporting](https://github.com/Fynnius/grok-dictate/security/advisories/new) on this repository.

Include the version (`0.1.0` or the commit), what you did, and what leaked or escalated. Do not attach live tokens.

We will acknowledge a valid report within a few days and credit you in the advisory if you want that.
