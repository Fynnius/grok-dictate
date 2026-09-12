# Architecture

Grok Dictate is an Electron menu-bar app plus two small Swift binaries: a
helper (hotkey + insertion) and a capture process (microphone).

## Why two processes

macOS will not let a sandboxed Chromium process install a `CGEventTap` or write
to another app via the Accessibility API in a way that survives focus changes.
The helper (`grok-dictate-helper`) owns the hotkey and the insertion ladder —
no network, no token, no transcript, no microphone. Capture is a second
binary (`grok-dictate-capture`) so that split stays intact. Electron owns
the xAI WebSocket, the HUD, and settings.

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

grok.com is a separate session (`persist:grok-com`) used only by STT 2 Fast.

There is no token-refresh path in this app. Refreshing a Grok CLI token from a
second client can rotate it out from under the CLI. To keep a CLI login alive,
the app runs `grok models` and lets the CLI rewrite `auth.json` itself
(`src/main/auth/renew.ts`). Settings → Account can also open Terminal.app for
`grok login`.

## Insertion

The helper picks a **route** first (`InsertRouting`), and the route decides which
rungs exist. The user's `insertMethod` setting wins outright; otherwise text over
120 UTF-16 units pastes, as does a focused element with the xterm.js signature —
`kAXSelectedText` not settable _and_ `kAXNumberOfCharacters == 0`. Everything
else types. There is no bundle-id table.

**Paste route.** The transcript is published as a _promise_ on the general
pasteboard — `declareTypes:owner:` with `public.utf8-plain-text` plus the
nspasteboard.org transient markers, and no data behind any of them — and a ⌘V
chord goes out on the HID tap. When a consumer asks for the text AppKit calls
back, and **that callback is the read receipt**: the only native "the target took
it" signal on macOS, and a stronger one than either verifier this app used to
ship. The pasteboard is cleared 200 ms after the last receipt, and always before
the ladder falls through to injection, so a fall-through cannot type the
transcript a second time. `PasteTransaction` is a pure function and holds every
one of those decisions; `PasteInserter` is the syscalls under it. The pasteboard
is **written, never read** — no snapshot, no restore, so the user's previous
clipboard is lost. `contracts/helper-protocol.md` §5.1 records the repeal that
allowed this and what it cost.

**Type route.** Accessibility (`AXUIElement`) first, confirmed by reading the
caret back, then Unicode key synthesis at 200 UTF-16 units per event with no
inter-chunk delay. Unicode events prefer `CGEvent.postToPid` to the resolved
target process and fall back to the global HID tap when there is no live pid.
The injection tier verifies nothing and claims nothing — "typed, unconfirmed" is
the strongest honest thing it can say.

The frontmost app is snapshotted at key-down, but **the check is off in the
product**: `machine.ts` sends `targetBundleId: null` on every insert, so the text
goes wherever the user is pointing when the turn ends rather than where it
started. That reverses the original design, at the user's direction after Phase 5
(`contracts/state-machine.md` §6); the helper still implements the check and
`--probe-insert` exercises it.

## HUD

The pill is a `focusable: false` always-on-top window. If it took focus, the
frontmost app would change and insertion would target Grok Dictate itself.
Insert outcomes are wordless (green check or red flash). The capsule does not
show live interim text. Hold-mode stays click-through.

## Audio graph

Native capture is primary: `grok-dictate-capture` prepares the AVAudioEngine
graph at process launch (`prepare()`, no IO) and **pauses** it between holds
so those allocations survive. `start` only installs the tap and starts
hardware — that is what lights the orange indicator. `AVAudioEngine.stop()`
would release `prepare()` and make every press a cold HAL open, which clipped
the first word of a hold. Capture is raw 16 kHz mono PCM16 in 100 ms /
3200-byte chunks (no echo cancellation, noise suppression, or AGC). The
`micProcessing` setting is Chromium-only. The start cue waits for the device
to actually be open.

When the native binary is missing, the hidden capture renderer is the
fallback. That path keeps one `AudioContext` and worklet across dictations
(`suspended` while idle so a running context cannot pin Bluetooth in HFP).
`getUserMedia` still happens only at press. The native path does not create
this window.

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
- `docs/report-insertion-2026-09-06.md` — what the ladder costs, what the field data says, and the case for a paste tier
- `docs/report-paste-tier-2026-09-06.md` — what shipped from it, what it measured, and what is still unverified
- [xAI Speech to Text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text)
