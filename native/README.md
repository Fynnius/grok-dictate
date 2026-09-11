# `grok-dictate-helper`

The native half of Grok Dictate. Two binaries:

- `grok-dictate-helper` — watch the `Fn` key, and put text into another application. No network, no credentials, no microphone, no idea what a transcript is. Contract §5: _"No token, ever."_
- `grok-dictate-capture` — default-input capture as raw 16 kHz mono PCM16. No event tap, no pasteboard, no token, no STT. Chromium `getUserMedia` is the fallback when this binary is missing.

---

## Build and test

```sh
./build.sh          # → build/grok-dictate-helper and grok-dictate-capture, ad-hoc signed
./test.sh           # Swift unit tests, warnings as errors
```

`build.sh` puts the binary at `native/build/grok-dictate-helper`, which is where
`resolveHelperBinary()` in `src/main/native/index.ts` looks in development. A
packaged build will find it in the app bundle's `Resources` instead; set
`GROK_DICTATE_HELPER` to override either.

Both scripts pass `--scratch-path ../out/native-build`. That is not a
preference: `npm run lint` runs `prettier --check .`, Prettier reads only the
root `.prettierignore`, and a default-placed `native/.build` would fail the
lint with its own `.json` and `.yaml` files. `.prettierignore` belongs to Phase
1 (IMPLEMENTATION-PLAN.md §2), so the build moved instead.

## Architecture

| Target                 | Contents                                                                                                                                       |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `HelperCore`           | Pure logic — protocol, framing, hotkey recognition, chunking, the insertion ladder and the two AX policies. No CoreGraphics, no AppKit, no AX. |
| `grok-dictate-helper`  | The thin shell binding that logic to `CGEventTap`, the AX API, `NSWorkspace`, `NSPasteboard` and `IsSecureEventInputEnabled`.                  |
| `CaptureCore`          | Pure PCM chunking, RMS, and the capture JSON protocol. No CoreAudio.                                                                           |
| `grok-dictate-capture` | AVAudioEngine + HAL input tap. Graph is prepared at launch; the microphone opens only on `start`.                                              |

The split is what makes the interesting parts testable: `swift test` runs
headless, with no windowserver and no TCC grants, and covers the whole hotkey
matrix, every malformed-input rule and both tap-recovery paths.

**Threading.** Single-threaded apart from one serial queue. The main thread runs
a `CFRunLoop` owning the event tap, both timers, and every stdout write.
Insertion is pushed to a background queue — a tier that waits would stall the tap
callback long enough for macOS to disable the tap, which is our own success path
causing the canonical hotkey bug. The paste tier hops back to main for two short
moments, because promised pasteboard data is serviced by AppKit on the main run
loop; `PasteInserter` documents that split and it is not optional.

## Probe modes

Several human-in-the-loop tests cannot be automated. Each has a mode here so it
is one command instead of a session with the whole app.

```sh
./build/grok-dictate-helper --probe-tap            # hotkey events, live
./build/grok-dictate-helper --probe-insert         # insert 300 known characters
./build/grok-dictate-helper --probe-paste          # publish a promise, press ⌘V, report every read receipt
./build/grok-dictate-helper --probe-chunk          # how many UTF-16 units one key event can carry
./build/grok-dictate-helper --probe-ax             # does the AX tier work here — and is it telling the truth?
./build/grok-dictate-helper --probe-secure-ax      # AX write under Secure Input (§9.5)
./build/grok-dictate-helper --help                 # options and environment
```

### Does the paste tier work in this application?

```sh
./build/grok-dictate-helper --probe-paste --delay 5
# …switch to the app, click where a paste should land, wait
```

It publishes a promised pasteboard item, posts ⌘V, and prints every request for
the data with its latency measured from both the publish and the chord. The
difference between those two is the entire correctness argument: a request that
arrives _before_ the chord is a clipboard manager reacting to the pasteboard
change, not the paste target. `--route pid|hid|none` compares where the chord
enters the system; `none` posts no chord at all, so `pbpaste` from another shell
is enough to check that the promise machinery itself works.

### When dictation goes missing in an application

This is the diagnostic, and it is one command. Point it at the app, in the field
the text should have gone into:

```sh
./build/grok-dictate-helper --probe-ax --delay 8
# …switch to the app, click into the text field, wait
```

It reports the frontmost app, which AX route reaches the focused element, that
element's role and subrole, whether `kAXSelectedTextAttribute` is settable, the
selected range and character count before and after a real test write, the
`AXError` from every call with its timing, and what the shipping policy —
`AXSelectedTextGate` and `AXWriteVerification`, the same code the helper runs —
concludes from all of it. It exits `0` only if the AX tier would run **and** be
believed.

There are two known kinds of liar. A terminal reports `settable: false` and then
returns `kAXErrorSuccess` from the write while inserting nothing. Arc's web
content reports `settable: true` and does the same, which is worse: the ladder
used to stop there and report `tier: ax, ok: true` with a green pill and nothing
on screen. Both now fall through to Unicode injection; `--probe-ax` says which
one you are looking at, and `VERDICT: DID NOT LAND` is the second.

**Caveat.** Run from a terminal, this binary inherits the _terminal's_ TCC
grants, not Electron's. That is fine for "which tier handles which app" and
"did the bytes survive", neither of which depends on which process holds the
grant — but it cannot answer assumption 10.5 (do dev grants attach to the
Electron binary and survive rebuilds). Only the real app can.

## Environment variables

There used to be twelve. **Five went on 2026-09-06.**
`GROK_DICTATE_INJECT_CHUNK`, `_INJECT_DELAY_MS`, `_INJECT_TAP` and
`_INJECT_VERIFY` were scaffolding for a measurement session that concluded in
August, and the pacing and length verification they steered are gone
(`docs/report-insertion-2026-09-06.md` §3). `_AX_SKIP` was the escape hatch for
an application that lies about AX writes; it was never used once, and
`InsertRouting` rule 3 now does the same job from what an application _does_
rather than from a list of the ones somebody tested.

What replaced all five is one user-visible setting, **Insert text by**, which
travels to the helper on the `insert` frame as `route`.

| Variable                            | Default | Meaning                                     |
| ----------------------------------- | ------- | ------------------------------------------- |
| `GROK_DICTATE_MODIFIER_SETTLE_MS`   | `500`   | wait for held modifiers before inserting    |
| `GROK_DICTATE_SECURE_INPUT_POLL_MS` | `1000`  | Secure Input and frontmost poll interval    |
| `GROK_DICTATE_TAP_WATCHDOG_MS`      | `5000`  | how often to check the tap is still enabled |
| `GROK_DICTATE_AX_VERIFY`            | **on**  | read the caret back to confirm an AX write  |
| `GROK_DICTATE_HELPER_DRY_RUN`       | off     | run the ladder but never insert anything    |
| `GROK_DICTATE_HELPER_NO_TAP`        | off     | do not install the event tap                |
| `GROK_DICTATE_HELPER_PROMPT`        | off     | show the macOS Accessibility prompt         |

The last three exist so `src/main/native/helper-binary.test.ts` can spawn this
binary for real without typing into the developer's screen or raising a TCC
dialog mid-test-run. All three announce themselves as `log` frames when set.

`GROK_DICTATE_AX_VERIFY` is the only one whose default is **on**, and the only
one that costs the user something when it is off: `=0` restores the behaviour
where an AX write is believed because it returned `kAXErrorSuccess`, which is
how a 13.8 s dictation disappeared into Arc behind a green "Inserted" pill. It
exists so the check can be bisected against a real application in one session
rather than one rebuild, and it warns on every start-up when set.

The chunk size is now a constant, `TextChunker.defaultMaxUTF16Units` — 200
UTF-16 units, from a `--probe-chunk` run on macOS 26.6 showing that
`CGEventKeyboardSetUnicodeString` does not truncate at 20, 200, 1,000 or 2,000.
That measures the API and not any application; sweeping it against a real target
means editing the constant and rebuilding. A known limit rather than an
overlooked one.

## Permissions

The tap is created with `.defaultTap`, not `.listenOnly`, because `Fn+Space` and
`Ctrl+Cmd+V` must be **consumed** — otherwise every hands-free toggle also types
a space into whatever the user is looking at. That requires **Accessibility**,
which also gates the AX insertion tier.

Both are reported at start-up as `log` frames with the exact System Settings
path, because a missing grant otherwise looks exactly like a broken app.
