# Architecture

Grok Dictate is an Electron menu-bar app plus a small Swift helper.

## Why two processes

macOS will not let a sandboxed Chromium process install a `CGEventTap` or write
to another app via the Accessibility API in a way that survives focus changes.
The helper (`native/`) owns the hotkey and the insertion ladder. Electron owns
the microphone, the xAI WebSocket, the HUD, and settings.

They talk JSON-lines on stdin/stdout. The contract is `contracts/helper-protocol.ts`.

## State machine

`src/main/state/machine.ts` is a pure reducer:

```
(state, event) → { state, effects[] }
```

Effects are data (`start_capture`, `connect_stt`, `insert_text`, `show_hud`, …).
`Orchestrator` is the only thing that interprets them against ports. That is
what makes a full dictation round-trip unit-testable without Electron.

Session states: `idle` → `recording` → `processing` → `inserting` → `idle`.
`blocked` is Secure Input (password fields). `Esc` and a second `Fn+Space` are
first-class events.

## Ports

`contracts/ports.ts` is the seam. The composition root in `src/main/index.ts`
wires the real implementations. Tests wire mocks from `mocks/`.

## Auth

`DictateAuth` tries, in order:

1. An API key stored by the Sign in window (`safeStorage`)
2. `XAI_API_KEY`
3. `~/.grok/auth.json` from the Grok CLI

There is no token-refresh path. Refreshing a Grok CLI token from a second
client can rotate it out from under the CLI.

## Insertion

The helper tries Accessibility (`AXUIElement`) first, then Unicode key
synthesis. It never writes the pasteboard. The frontmost app is snapshotted at
key-down; if focus moved during processing, the transcript is kept and offered
for re-insert instead of being typed into the wrong window.

## HUD

The pill is a `focusable: false` always-on-top window. If it took focus, the
frontmost app would change and insertion would target Grok Dictate itself.

## Logging

Everything goes through `src/shared/logger.ts`. `src/shared/redact.ts` is the
backstop for tokens. `console.*` is banned in the app by ESLint.

## Further reading

- `contracts/state-machine.md` — states, events, effects
- `contracts/helper-protocol.md` — helper frames
- `docs/spike-results.md` — measured STT socket behaviour
- [xAI Speech to Text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
