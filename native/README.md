# `grok-dictate-helper`

The native half of Grok Dictate. It does the two things Electron cannot: watch the `Fn` key, and put text into another application.

Everything else — audio, STT, history, the HUD — lives in the Electron app. This
binary has no network access, no credentials, and no idea what a transcript is.
Contract §5: _"No token, ever. The helper has no need for the bearer and must
never be sent it."_

---

## Build and test

```sh
./build.sh          # → build/grok-dictate-helper, ad-hoc signed
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

| Target                | Contents                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `HelperCore`          | Pure logic — protocol, framing, hotkey recognition, chunking, the insertion ladder and the two AX policies. No CoreGraphics, no AppKit, no AX. |
| `grok-dictate-helper` | The thin shell binding that logic to `CGEventTap`, the AX API, `NSWorkspace`, `NSPasteboard` and `IsSecureEventInputEnabled`.                  |

The split is what makes the interesting parts testable: `swift test` runs
headless, with no windowserver and no TCC grants, and covers the whole hotkey
matrix, every malformed-input rule and both tap-recovery paths.

**Threading.** Single-threaded apart from one serial queue. The main thread runs
a `CFRunLoop` owning the event tap, both timers, and every stdout write.
Insertion is pushed to a background queue — Unicode injection paces itself
between chunks, and a paced loop on the main thread would stall the tap callback
long enough for macOS to disable the tap, which is our own
success path causing the canonical hotkey bug.

## Probe modes

Several human-in-the-loop tests cannot be automated. Each has a mode here so it
is one command instead of a session with the whole app.

```sh
./build/grok-dictate-helper --probe-tap            # hotkey events, live
./build/grok-dictate-helper --probe-insert         # inject 300 known characters
./build/grok-dictate-helper --probe-ax             # does the AX tier work here — and is it telling the truth?
./build/grok-dictate-helper --probe-secure-ax      # AX write under Secure Input (§9.5)
./build/grok-dictate-helper --help                 # options and environment
```

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

The injection knobs are variables rather than constants because
leaves chunk size and inter-chunk delay unmeasured, and measuring them is a
human test. Tuning a constant means a rebuild between attempts.

| Variable                            | Default | Meaning                                     |
| ----------------------------------- | ------- | ------------------------------------------- |
| `GROK_DICTATE_INJECT_CHUNK`         | `20`    | UTF-16 units per event                      |
| `GROK_DICTATE_INJECT_DELAY_MS`      | `5`     | pause between chunks                        |
| `GROK_DICTATE_INJECT_TAP`           | `hid`   | `hid` or `session` — where injections enter |
| `GROK_DICTATE_MODIFIER_SETTLE_MS`   | `500`   | wait for held modifiers before injecting    |
| `GROK_DICTATE_SECURE_INPUT_POLL_MS` | `1000`  | Secure Input and frontmost poll interval    |
| `GROK_DICTATE_TAP_WATCHDOG_MS`      | `5000`  | how often to check the tap is still enabled |
| `GROK_DICTATE_AX_SKIP`              | none    | bundle ids to skip the AX tier for          |
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

`GROK_DICTATE_AX_SKIP` is still the last resort, for an application that lies in
a way the verification cannot see — one that moves the caret and shows nothing.
No application is on it by default, deliberately: a denylist protects only the
apps someone has already lost text in, which is the argument
`docs/phase-2-report.md` §3.2 made against listing terminal bundle ids and which
applies to Arc for the same reason. Chromium is not one browser.

## Permissions

The tap is created with `.defaultTap`, not `.listenOnly`, because `Fn+Space` and
`Ctrl+Cmd+V` must be **consumed** — otherwise every hands-free toggle also types
a space into whatever the user is looking at. That requires **Accessibility**,
which also gates the AX insertion tier.

Both are reported at start-up as `log` frames with the exact System Settings
path, because a missing grant otherwise looks exactly like a broken app.
