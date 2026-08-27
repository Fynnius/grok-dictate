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
synthesis. Unicode events prefer `CGEvent.postToPid` to the resolved target
process, and fall back to the global HID tap when there is no live pid.
Unicode length-checking is off unless `GROK_DICTATE_INJECT_VERIFY=1`.
It never writes the pasteboard. The frontmost app is snapshotted at
key-down; if focus moved during processing, the transcript is kept and offered
for re-insert instead of being typed into the wrong window.

## HUD

The pill is a `focusable: false` always-on-top window. If it took focus, the
frontmost app would change and insertion would target Grok Dictate itself.
Insert outcomes are wordless (green check or red flash). The capsule does not
show live interim text. Hold-mode stays click-through.

## Audio graph

The capture renderer keeps one `AudioContext` and worklet across dictations
(`suspended` while idle so a running context cannot pin Bluetooth in HFP).
`getUserMedia` still happens only at press — that is what lights the orange
indicator. A fresh PCM encoder is created per session so a reused graph cannot
carry samples from one turn into the next.

## Mute while recording

`mute_output` / `unmute_output` helper commands mute default system output
after the start cue and restore before the stop cue. Capture starts first.
Restore is crash-proof: helper shutdown, SIGTERM, a lock file the next launch
reads, and a defensive unmute when the helper becomes ready. A user who
unmutes or changes volume during the recording is not clobbered. If the
default output changes mid-recording, restore still targets the device that
was muted (stable CoreAudio UID); the lock is not dropped until that restore
succeeds or the user has already taken the device back.

## Logging

Everything goes through `src/shared/logger.ts`. `src/shared/redact.ts` is the
backstop for tokens. `console.*` is banned in the app by ESLint. A session
timing channel (`src/shared/timing.ts`) emits one greppable `key=value` line
per lifecycle event, stamped in the orchestrator on receive. Zero transcript
text.

## Further reading

- `contracts/state-machine.md` — states, events, effects
- `contracts/helper-protocol.md` — helper frames
- `docs/spike-results.md` — measured STT socket behaviour
- `docs/report-latency-ux-2026-08-22.md` — timing channel, warm graph, mute, live HUD, stats
- [xAI Speech to Text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
