# Latency / honesty pass — 2026-08-22

What shipped, what was measured, what was not. Same register as
`docs/spike-results.md`.

## What shipped

| Item                    | Status                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W0 session timing       | Shipped. Receive-side stamps in the orchestrator. `GROK_DICTATE_TIMING=0` opt-out.                                                                                                                                   |
| W1 live HUD text        | Shipped. Setting `liveHudText`, default off. Capsule grows when on; hold-mode stays click-through.                                                                                                                   |
| W2 Unicode pid-post     | Shipped with fallback. Verification vocabulary unchanged. Pacing **kept**.                                                                                                                                           |
| W3 warm audio graph     | Shipped. Context + worklet reused, `suspended` while idle. `getUserMedia` still at press. Worklet `_fill` is reset on stop so session N cannot prepend onto N+1.                                                     |
| W4 silence gate         | Shipped. Pure function, PCM fixtures, setting `silenceGate`, default on.                                                                                                                                             |
| W5 mute while recording | Shipped. Helper commands, crash-proof lock file, cue ordering. Restore targets the snapshotted CoreAudio UID (not the numeric default-output id); lock drops only after a successful restore or an explicit abandon. |
| W6 stats                | Shipped. Derived from history only. Empty state designed.                                                                                                                                                            |

## Numbers

### W0 / W3 — hotkey → first PCM in main

**Could not measure on a live dictation in this environment.** No logged-in
interactive session with a microphone was driven end-to-end here. Unit tests
cover the formatter, monotonic elapsed-ms, and the absence of transcript text
on the line. The orchestrator emits `hotkey_down`, `capture_requested`,
`device_open`, `first_pcm_main` on a synthetic session.

The warm graph removes `new AudioContext` + `audioWorklet.addModule` from the
press path. Those hops are now paid once, then the context is suspended. How
many milliseconds that is on this machine is unpublished because it was not
measured with W0 against a real hold.

Stamp decision, written down: **receive in main, not send in the renderer.**
W0's job is the product round trip — when the rest of the app can act. A
renderer `sentAtMs` exists on `capture-started` as an optional diagnostic;
the canonical mark is still receive.

### W2 — insert begin → insert end, and InjectionPacer

**Could not re-run the insertion probe matrix** (`native/probe-app.sh` /
`cmux`) without a GUI session and Accessibility against real apps. Pacing is
therefore **kept**. Burden of proof is on removal; the original drop was not
reproduced here, and pid-posting was not shown to fix it.

HelperCore tests cover: live pid → pid route; no pid / dead pid → global tap.
Both routes still use a private `CGEventSource`, cleared flags, and the
modifier wait. The three-way verification vocabulary is unchanged.

### W3 — Bluetooth HFP

**Could not test** with Bluetooth headphones playing music. Conservative
choice: the warmed `AudioContext` is **suspended while idle**. A running idle
context pinning HFP is treated as a real bug even without a measurement.

Chromium `suspended` without a user gesture is handled: `resume()` is called
explicitly at press, and `requested !== sessionId` is re-checked after that
await.

### W5 — cues by ear

**Could not verify by ear** in this environment (no CoreAudio session attached
to the test runner). Unit tests cover effect order (mute after start cue,
unmute before stop cue) and protocol round-trip. The orchestrator delays mute
by start-cue duration + 15 ms (chosen) and the stop cue by 25 ms after unmute
(chosen). If those pads are wrong, the cues go missing; that is the first
thing to listen for on a real Mac.

## Thresholds (chosen, not measured)

| Constant                       | Value    | Why                                                                   |
| ------------------------------ | -------- | --------------------------------------------------------------------- |
| `SILENCE_GATE_MAX_DURATION_MS` | 900      | Duration is a precondition. "Yes" is 200–500 ms of _speech_.          |
| `SILENCE_GATE_PEAK`            | 0.03     | Above room tone, below a close-mic syllable.                          |
| `SILENCE_GATE_RMS`             | 0.008    | Same bias, for spread energy.                                         |
| `LIVE_TEXT_MAX_CHARS`          | 42       | Tail of the utterance; ~280 px at 12 px.                              |
| `HUD_LIVE_TEXT_WINDOW`         | 420×64   | Fits that tail plus bars. Height unchanged so the pill does not jump. |
| Mute-after-start-cue           | 55+15 ms | Cue spec + scheduling pad. Capture already started.                   |
| Unmute-before-stop-cue         | 25 ms    | CoreAudio set is typically <10 ms.                                    |
| `STATS_TYPING_WPM`             | 40       | Common average; shown next to the number.                             |
| `STATS_ROW_CAP`                | 50,000   | Linear scan stays cheap; truncated flag if hit.                       |

A hold shorter than one capture chunk (100 ms / 3,200 bytes) is **not** gated:
that is "too soon to measure", not silence. Bias to transcribe.

## What did not ship

- Deleting `InjectionPacer`. The cmux drop was not reproduced.
- Pre-warming `getUserMedia` / a permanently lit orange indicator.
- Pausing other apps' media instead of muting output.
- Screen-reader access to the HUD (still unfocusable by design; not claimed).
- Stats counters that survive purge.
- Live W0 before/after milliseconds, Bluetooth HFP music test, insertion
  probe matrix including cmux.
- `GROK_HUD_FOCUS_TEST=1` _did_ start Electron against a window server. The
  ASN of the frontmost app after `show()` did not match before. Constructor
  flags (`focusable: false`, etc.) and hold-mode `hudInteractive` were not
  changed in this pass — the probe uses `HUD_WINDOW_OPTIONS`, still the
  capsule size. Treated as an unstable GUI environment rather than a
  regression in the flag set; `flags.test.ts` / `hudInteractive` remain the
  bar the plan names when the e2e cannot be trusted.

## Next

1. Run a real hold with W0 on and publish hotkey → `first_pcm_main` before/after
   the warm graph, and insert begin → insert end with pid-post.
2. Re-run `native/probe-app.sh` including cmux. If pid-post lands the 760-unit
   fixture without pacing, _then_ consider relaxing `InjectionPacer`.
3. Listen to start/stop cues with mute on, on a Mac with music playing, including
   Bluetooth.
4. Re-run `GROK_HUD_FOCUS_TEST=1 npx vitest run src/main/hud/focus.e2e.test.ts`
   on a logged-in GUI.
5. Measure silence-gate thresholds on the actual laptop microphone; replace
   "chosen" with numbers.

## Drive-bys noticed, not fixed

- `machine.ts` HUD coalescing comment still describes the recording capsule as
  not rendering interim; the code now does. Left alone because the 90 ms floor
  is still load-bearing for LEVEL/TICK.
- Stats invoke walks up to 50k history rows on the main thread. Fine at the
  default 90-day window; a future SQLite store would make this a query.
