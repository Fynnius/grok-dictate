# Handoff — latency, feedback and honesty pass (2026-08-22)

> **This file is a prompt.** Paste it whole into a fresh agent session whose
> working directory is this repository. Everything the agent needs is here or
> reachable from a path named here. Do not summarise it before handing it over.

---

## 1. Who you are and what you are doing

You are the lead engineer on **Grok Dictate**, a macOS menu-bar dictation app:
hold `Fn`, speak, release, and the transcript is typed into whatever app has
focus. It is an Electron main process plus a small Swift helper, and it streams
audio to the xAI speech-to-text API over a WebSocket.

You are shipping **seven changes** in one coordinated pass. They are not a
grab-bag; they share one thesis:

> The app is slower than it needs to be at both ends of a dictation, it does not
> show the user what it already knows, and it cannot prove any claim it makes
> about its own speed.

Every item below either removes latency, surfaces information the app already
has, or makes the first two measurable. You have subagents available and should
use them. You have a reference implementation to learn from and a hard rule
about how you may use it.

**Work at a high level.** This codebase is unusually well-reasoned — read a few
files before you touch anything and you will see what the bar is. Match it.
Code that works but does not explain itself is not finished here.

---

## 2. Orientation

### Build, run, test

```bash
npm install
./native/build.sh          # builds the Swift helper into native/build/
npm run dev                # Electron dev
npm run package            # full .app into /Applications

npm test                   # Vitest — no Electron, no network, no microphone
npm run lint               # ESLint + Prettier
npm run typecheck
./native/test.sh           # swift test for HelperCore
```

All four checks must pass before you call anything done. `npm test` is fast and
hermetic — run it constantly, not at the end.

### The shape of the thing

```
contracts/            FROZEN interfaces. events, ports, config, helper protocol.
src/main/state/       machine.ts   — pure reducer: (state, event) → {state, effects[]}
                      orchestrator.ts — the ONLY thing that interprets effects against ports
src/main/audio/       coordinator.ts — session bookkeeping, full-utterance buffer
src/main/stt/         client.ts — xAI WebSocket; frames.ts — wire parsing
src/main/hud/         HUD window, layout, flags
src/main/native/      helper client + supervisor
src/renderer/capture/ hidden window: getUserMedia → AudioWorklet → PCM16 16 kHz
src/renderer/hud/     the pill
src/renderer/settings/ settings, history, scratchpad panels
src/shared/           logger, redact, result, stitch, hud-view (shared with web)
native/Sources/HelperCore/          pure, unit-tested Swift
native/Sources/grok-dictate-helper/ the executable: event tap, AX, Unicode injection
```

Read these three files before writing any code. They are short and they encode
the design:

- `docs/ARCHITECTURE.md`
- `contracts/state-machine.md`
- `contracts/helper-protocol.md`

**The central idea:** the dictation round-trip is a pure state machine that
returns side effects as _data_. `machine.ts` never touches Electron, a socket or
a microphone; `orchestrator.ts` interprets its effects against ports defined in
`contracts/ports.ts`. This is why a full round-trip is unit-testable with no
hardware, and it is why `machine.test.ts` is 1,524 lines. **Do not erode it.**
If your change needs a new side effect, add an effect to the machine and
interpret it in the orchestrator. Do not reach around the seam.

---

## 3. The reference implementation, and the rule about it

There is a mature open-source competitor, **FluidVoice** (native Swift, ~91k
LOC, macOS dictation with local models):

```bash
git clone --depth 50 https://github.com/altic-dev/FluidVoice.git /tmp/refrepos/FluidVoice
```

You are **encouraged** to read it. It has solved several of these problems in
production and its audio pipeline in particular is worth studying. Specific
files that repay reading are named under each work item below.

### The rule

**FluidVoice is GPLv3. Grok Dictate is MIT. You may not copy code across.**

Not a line, not a function, not a renamed function. Copying would force this
repository to relicense.

What you _may_ do: read it, understand the technique, close the file, and
implement the idea yourself against this codebase's own architecture. The
techniques — "prepare the device without starting it", "post the event to the
pid instead of the global tap", "gate on measured silence" — are not
copyrightable and are exactly what you should take.

The practical test: **if your implementation looks like theirs, you did it
wrong.** Their code is Swift services around a 4,600-line SwiftUI view. Yours
must be a pure reducer, effects as data, and ports. The same idea expressed in
this codebase's grammar will not resemble the source you learned it from.

When an item below is inspired by their work, say so in the code comment, cite
what you learned, and make clear it was reimplemented. Honest attribution of an
_idea_ is good engineering and costs you nothing.

---

## 4. The laws of this codebase

These are not preferences. Breaking one is a failed change.

1. **The clipboard is never written automatically.** `NSPasteboard` is reachable
   from exactly one file (`native/Sources/HelperCore/Pasteboard.swift`), wired to
   exactly one command (`copy`), and `ClipboardContainmentTests` asserts it with
   a spy that counts zero writes across every branch including every failure
   branch. FluidVoice's fastest insertion path is a clipboard paste. **You may
   not adopt it.** If you find yourself wanting to, you have misread the
   product.

2. **No `console.*` in app code.** ESLint enforces it. Everything goes through
   `src/shared/logger.ts`, which redacts via `src/shared/redact.ts`. The capture
   renderer has no logger — it reports diagnostics over contract messages and
   main logs them. Preserve that.

3. **Never log transcript text.** Log lengths, durations, counts, codes. The
   history file is already described in-repo as "a partial keylogger"; the log
   must not become a second one.

4. **`contracts/` is frozen by default.** You will need to change it for two
   items below. When you do: change it _deliberately_, in one pass, before any
   implementation work fans out, and document the change in the file itself in
   the style already there. Never let two parallel workstreams edit `contracts/`.

5. **Anything that discards or rewrites what the user said is a setting.**
   `repairSeams` is the precedent — it rewrites transcripts and it has a switch,
   because "a user who disagrees with a repair must be able to switch it off
   without waiting for a release". The silence gate discards audio. It gets a
   switch.

6. **Do not do drive-by refactors.** Seven changes is already a large diff. If
   you spot something unrelated and wrong, write it down in your final report;
   do not fix it.

7. **Report honestly.** If an item is half-done, say which half. If a
   measurement came out worse than expected, publish the number. This codebase's
   comments are full of "chosen, not measured" and "this is a known, unhandled
   limit rather than an overlooked one". That register is the house style and it
   applies to your report as much as your code.

---

## 5. The documentation duty

**You document as you go, in the style already in the repo.** This is not
optional polish; it is half the deliverable.

The house style documents _why_, cites the evidence, and names the things that
were guessed. Here is a real comment from `native/Sources/HelperCore/InjectionPacing.swift`:

```swift
/// Above this many UTF-16 units, slow down.
///
/// **Chosen, not measured**, and the evidence brackets it loosely on both
/// sides: 79 units landed in cmux, 760 did not, and Phase 2's 317-unit
/// fixture landed byte-identically in six other applications at 5 ms
/// (`native/probe-out/*.log`). Anywhere in 80–759 would be defensible; the
/// incident report proposed ~200 and nothing measured contradicts it.
```

Note what it does: states the rule, gives the numbers behind it, brackets the
uncertainty, names the source, and admits what is arbitrary. Do that.

Concretely, for every change you make:

- **Every threshold, timeout and magic number** gets a comment saying whether it
  was measured or chosen, and against what.
- **Every file you create** gets a header explaining why it exists and what
  would go wrong without it.
- **Every non-obvious decision** gets the alternative you rejected and why.
- **Every trade-off you cannot resolve** gets stated as an open question rather
  than hidden behind a confident-sounding sentence.

You must also:

- Add a `CHANGELOG.md` entry in the existing voice.
- Update `docs/ARCHITECTURE.md` where the architecture actually changed (the
  warm audio context and the mute command both change it).
- Write `docs/report-latency-ux-2026-08-22.md`: what you did, the before/after
  numbers, what you could not finish, what you would do next. Follow the tone of
  `docs/spike-results.md`.

---

## 6. The work

Seven items. Each states **why**, **what exists today** (with exact paths so you
do not have to hunt), **what done looks like**, and **the constraints that will
bite you**.

You own the design. These are not implementation instructions — where a
constraint is stated, honour it; where it is not, use judgement and write down
what you decided.

---

### W0 — Latency instrumentation _(do this first)_

**Why.** Three of the items below are latency claims. Right now this app can
measure almost nothing about itself: a grep for timing turns up `handshakeMs` in
`src/main/stt/client.ts:409` and essentially nothing else. You cannot ship "the
microphone is warm now" as a claim you cannot substantiate. Land the ruler
before you start cutting.

FluidVoice does this well and it is worth seeing the shape:
`Sources/Fluid/Services/ASRService.swift` has 53 `benchmarkLog` calls with a
consistent `key=value` grammar (`recording_start`, `first_pcm_wait_end`,
`stop_audio_drained`, `stop_end totalMs=`), plus `bench(...)` in
`Sources/Fluid/Services/TypingService.swift` for the insertion path. "Where did
the 800 ms go" becomes a grep.

**What exists today.** `src/shared/logger.ts` with levels and child loggers;
`src/shared/redact.ts` as the token backstop. The state machine already knows
every lifecycle transition — that is where the events live.

**Done looks like.**

- A structured timing channel through the existing logger. One line per
  lifecycle event, stable `key=value` grammar, greppable, machine-parseable.
- Coverage of the whole round trip, at minimum: hotkey down → capture requested
  → device open → **first PCM chunk in main** → socket open → first partial →
  hotkey up → audio done → final transcript → insert begin → insert end → idle.
  Each carries elapsed-ms from session start.
- One summary line per session so a single dictation's whole budget reads at a
  glance.
- Zero transcript text. Lengths and counts only. Law 3.
- Cheap enough to leave on. If that means a level or an env flag, fine — but the
  default must be useful, because a diagnostic nobody enables diagnoses nothing.
- Unit tests for the formatting, in the manner of the rest of `src/shared/`.

**Constraints.**

- The capture renderer cannot use the logger (law 2). Timing that originates
  there must ride the contract's messages and be stamped in main. Decide
  deliberately whether you stamp on send or on receive, and **write down which
  and why** — it is the difference between measuring the device and measuring
  the IPC.
- Do not thread a clock through the pure reducer. `machine.ts` stays pure.
  Instrument in the orchestrator.

---

### W1 — Live transcript in the HUD

**Why.** The app already receives `transcript.partial` frames from xAI, already
parses them, and already carries the text through the state machine as
`ctx.interim`. The HUD then draws **ten level-driven bars** instead of the
words (`src/main/state/machine.ts:267`). The single largest perceived-speed win
available is to show the user what the app already knows. Words appearing as you
speak is most of what "fast" means to a person.

**What exists today.**

- `contracts/events.ts:105-106` — **`HudView.recording` and `HudView.processing`
  already carry `interim: string`.** The contract is done. You are wiring a leaf.
- `src/shared/hud-view.ts:53` — `hudLayer()` maps `recording`/`processing` to
  `'capsule'`.
- `src/renderer/hud/presentation.ts` — the pure view model. `HudCapsule` is
  currently `waveform | processing | check | alert`.
- `src/renderer/hud/main.tsx`, `hud.css`, `waveform.ts` — the markup and paint.
- `src/main/hud/layout.ts` — window sizing; `hud-window.ts` — window flags.
- `src/main/tray/menu.ts:118` — a `PREVIEW_VIEWS` dev affordance that pushes
  synthetic `HudView`s at the pill. **Use it.** You can iterate on the visual
  design without dictating a word, and you should extend it with interim-text
  cases.

**Done looks like.**

- Interim text renders live in the pill while recording and while processing.
- The design is genuinely good, not merely present. See §7 for the bar.
- A setting to turn it off, defaulting on. `audioCues` in `contracts/config.ts`
  is the precedent to copy for shape and for how the option is documented.
- Presentation logic stays in `presentation.ts` and stays pure, so every state is
  unit-tested with no window server. The component remains markup. That
  separation is load-bearing — `presentation.test.ts` exists because of it.

**Constraints that will bite you.**

- **The pill must not take focus. Ever.** It is `focusable: false` and
  deliberately click-through in hold mode. If it took focus, the frontmost app
  would change and the transcript would be typed into Grok Dictate itself. The
  rules live in `hudInteractive()` (`src/shared/hud-view.ts:93`) and are
  regression-tested by `src/main/hud/focus.e2e.test.ts`. **If you change window
  size, shape or hit-testing, you must re-run that test** — its header says so
  explicitly.
- A growing pill must not become a bigger click target in hold mode. Growth and
  interactivity are independent axes; keep them that way.
- A 60-second dictation is a lot of text and the pill is small. Decide what the
  user sees — almost certainly the most recent words rather than the beginning —
  and justify it in a comment. Do not let the pill grow without bound.
- Partials arrive roughly every 500 ms, and `sameHudView()`
  (`src/shared/hud-view.ts:32`) already drops redundant renders. Do not
  re-render at level-update frequency to paint text. Check what BUG-7 cost
  before you wire anything to the 60 fps path.
- The HUD is not focusable, so assistive technology will not read it. Note that
  honestly rather than claiming an accessibility win you did not deliver.

---

### W2 — Post Unicode events to the target pid

**Why.** On 2026-08-09 a 60.3-second dictation into `cmux` was posted as 38
synthetic key events in ~245 ms, dropped in full, and reported as success. The
fix shipped was length-based pacing (`native/Sources/HelperCore/InjectionPacing.swift`),
which costs ~570 ms on a long insert and treats event _density_ as the cause.

That diagnosis is probably one layer short. Events are posted to
`.cghidEventTap` — the global HID stream — by default
(`native/Sources/grok-dictate-helper/Settings.swift:104`). FluidVoice posts the
identical Unicode events with `CGEvent.postToPid(_:)`, in 200-unit chunks, with
**zero** inter-chunk delay (`Sources/Fluid/Services/TypingService.swift`, around
`postUnicodeChunks` — its own log line reads `interChunkDelayMs=0`), into
Electron apps and terminals, and it works.

Delivering straight to one process's event queue bypasses the global stream and
every event tap sitting on it. Bursts cannot be coalesced or dropped by a layer
they never enter.

**Two bonuses if it holds.** The focus-moved race disappears — events go to the
pid you captured at key-down, not to whatever is frontmost now. And the pacing
may become deletable.

**What exists today.**

- `native/Sources/grok-dictate-helper/UnicodeInserter.swift` — the tier. Posts
  with `keyDown.post(tap: settings.injectTap)`.
- `native/Sources/HelperCore/InsertionLadder.swift:41` — **`FrontmostAppInfo`
  already carries `processId`.** The pid is in your hand already.
- `native/Sources/grok-dictate-helper/InjectionVerifier.swift` and
  `native/Sources/HelperCore/UnicodeWriteVerification.swift` — measure the
  target's text length around the injection and report landed / did not land /
  cannot tell.
- `native/probe-app.sh`, `native/verify-insert.sh`, `native/probe-out/*` — an
  existing insertion probe harness with recorded results from six applications.

**Done looks like.**

- Unicode injection prefers posting to the resolved target pid, and falls back
  to the current global-tap path when there is no pid or the pid route fails.
- Verification still runs on both routes and still reports the honest three-way
  outcome. **Do not weaken the verification vocabulary to make a number look
  better** — the `.confirmed` / `.succeeded` / `.notLanded` distinction is the
  most valuable thing in this file and it exists because of the incident above.
- The probe matrix is re-run and `native/probe-out/` gains fresh results,
  **including a `cmux` case**, which is the application that started this.
- `HelperCoreTests` covers the new routing decision.
- A **data-driven** recommendation on `InjectionPacer`: keep, relax, or delete.
  Publish the numbers. If pid-posting fixes the drop, deleting 570 ms of
  artificial delay is a real win — but the incident cost a minute of somebody's
  speech, so **the burden of proof is on removal**. If you cannot reproduce the
  original failure at all, say that, and keep the pacing.

**Constraints.**

- `CGEventSource(stateID: .privateState)` and explicitly cleared flags stay,
  on both routes. The retry hotkey is `Ctrl+Cmd+V`, so at retry time those
  modifiers are usually still physically down, and an injected `a` carrying Cmd
  is ⌘A — select-all, followed by every subsequent character replacing the
  selection. `UnicodeInserter.swift:25` documents this. Do not lose it.
- The bounded wait for physical modifiers to clear stays, for the mirror-image
  reason documented at `UnicodeInserter.swift:33`.
- Some apps ignore events posted to a pid. That is precisely why the fallback
  is mandatory rather than tidy.
- The ladder runs off the main thread on purpose — a paced injection on the main
  run loop stalls the `CGEventTap` callback long enough for macOS to disable the
  tap with `kCGEventTapDisabledByTimeout`. See `InsertionLadder.swift:179`.
  Keep it that way.

---

### W3 — Warm the audio graph without lighting the microphone

**Why.** `src/renderer/capture/main.ts:17` states the rule:

> **The microphone is never pre-warmed** … pre-warming buys nothing that
> connect-time buffering does not already cover.

The privacy half of that is right and stays. The performance half has a hole:
connect-time buffering rescues audio _already captured_ while the socket
handshakes. It cannot rescue audio from a device that is not open yet. Today
every hold pays, serially: `getUserMedia`, then `new AudioContext`, then
`await context.audioWorklet.addModule(...)`. Three async hops before the first
sample exists. That is the front of the first word.

FluidVoice's insight is that **prepare and start are different operations**.
`prepareDirectAudioInput` in `Sources/Fluid/Services/ASRService.swift` registers
the device callback and allocates the ring while idle — no hardware running, no
indicator — so the hotkey path is only "start". Read their comment on it.

The Electron analogue: the `AudioContext` and the worklet module need **no
microphone permission and light nothing**. Only `getUserMedia` does. Build and
warm the graph at launch; call `getUserMedia` at press.

**What exists today.** `src/renderer/capture/main.ts` (`startCapture`, and
`ActiveCapture` which is torn down completely on every stop),
`src/renderer/capture/pcm-worklet.ts`, `src/renderer/capture/pcm.ts`,
`src/main/audio/coordinator.ts`.

**Done looks like.**

- The `AudioContext` and worklet module are created once and survive across
  dictations. The hot path loses those hops.
- **The orange indicator behaviour is unchanged.** It appears when recording
  starts and disappears when it ends. This is non-negotiable; the existing
  comment calls a permanently lit indicator "reads as spyware" and it is right.
- Before/after numbers for hotkey → first PCM chunk in main, measured with W0,
  published in your report. This is the item that most needs a number attached.
- The device-restart path (`watchDevice`, `restartDevice` — AirPods connecting
  mid-utterance) still works. It currently relies on keeping the context and
  encoder alive across a restart; make sure warm reuse does not break it.

**Constraints that will bite you.**

- **A running `AudioContext` holds an output device open.** FluidVoice hit
  exactly this and documented it: an idle-warm engine pinned Bluetooth headsets
  in low-bandwidth HFP instead of A2DP, so the user's music sounded like a phone
  call all day. Their fix was a standby timer that retires the warm engine after
  idle. You must decide between keeping the context `suspended` when idle and
  resuming on press (resume is cheap; `addModule` is the expensive part) or
  keeping it running and paying for it. **Test with Bluetooth headphones
  playing music.** If you cannot test it, say so and choose the conservative
  option.
- Chromium may start an `AudioContext` in `suspended` state without a user
  gesture. Handle it explicitly; do not assume it is running.
- `sampleRate` is fixed at construction, so warming commits to 16 kHz up front.
  That is already what the code does — but say it out loud in the comment,
  because the explicit-resampler fallback at `coordinator.ts:348` depends on it.
- A hold short enough to end during `getUserMedia` must still leave the
  microphone closed. The `requested !== sessionId` re-checks after every `await`
  are load-bearing. Warm reuse adds new await points; audit every one.
- Do not weaken the two-phase drain (`DRAIN_TIMEOUT_MS`,
  `coordinator.ts:157-171`). It exists because the tail-flush was silently dead
  code and the last 100–300 ms of every utterance was being dropped. Reusing the
  graph across sessions puts fresh pressure on exactly that logic — the encoder
  must not carry samples from one session into the next. Prove it with a test.

---

### W4 — Silence gate for accidental taps

**Why.** A brushed hotkey produces 0.3 s of room tone, which today opens a
socket, ships audio to xAI, waits for a result, and shows the user a failure.
It costs latency, noise and money. FluidVoice gates on measured silence before
transcribing (`assessShortAudioSilence` in
`Sources/Fluid/Services/ASRService.swift`) using duration plus peak plus RMS plus
max-frame RMS.

**Done looks like.**

- At end of turn, an utterance that is both short and measurably silent is
  dropped without waiting on the server, and the user sees something calm and
  non-alarming rather than an error.
- The decision function is **pure and unit-tested** with real fixtures. This is
  a natural fit for `src/shared/`. Test with actual silence, actual room tone,
  and — critically — actual short speech.
- A config setting, defaulting on, documented in `contracts/config.ts` in the
  style of its neighbours. Law 5.
- The gate's decision is visible in the W0 timing output. A gate that silently
  eats a real utterance and leaves no trace is the worst possible outcome; make
  it leave a trace.

**Constraints that will bite you.**

- **It must never eat a real short utterance.** "Yes", "no", "OK", "ship it"
  are legitimate one-word dictations and are short by definition. Duration alone
  is not a gate — it is a precondition for even looking. Bias hard toward
  transcribing: a wasted API call costs a fraction of a cent, a swallowed
  sentence costs the user's trust in the product.
- **If any partial transcript already arrived with text, never gate.** The
  server heard speech; that outranks your amplitude heuristic. FluidVoice does
  exactly this and it is the right call.
- Do not confuse this with the existing `NO_SPEECH_TIMEOUT_MS` watchdog in
  `src/main/stt/client.ts`, which handles a different case — a long recording
  with no speech in it. Yours is about short accidental ones. Say how they
  differ in a comment, or someone will merge them later and break both.
- Every threshold is a guess until you measure it. Measure it, on the actual
  laptop microphone, and record the numbers in the comment per §5.
- Do not gate _before_ connecting the socket. You cannot know an utterance is
  silent until it ends, and deferring the connect would add latency to every
  real dictation to save cost on rare fake ones. Gate at release.

---

### W5 — Mute system output while recording

**Why.** Music playing through the speakers while you dictate is both a
distraction and something the microphone can hear. FluidVoice _pauses_ media.
**We mute instead, and that is the better design:** pausing reaches into another
application's state, depends on media-key semantics that differ per app, cannot
be reliably undone, and races the start of recording. Muting is instant, local,
reversible, and leaves the user's media exactly where it was — the podcast keeps
playing and they lose the six seconds they were talking over, which is what they
wanted.

**What exists today.** Nothing. This is new, and it needs a contract change: a
new command in `contracts/helper-protocol.ts` (see `InsertCommand`, `CopyCommand`
etc. around lines 260–275 for the shape), the corresponding Swift side in
`native/Sources/HelperCore/CommandRouter.swift` and the helper executable, and a
new effect in the state machine interpreted by the orchestrator.

**Done looks like.**

- System output mutes when recording starts and restores when it ends —
  including on cancel (`Esc`), on error, on timeout, on supersede, and on quit.
  Every path. Enumerate them from `contracts/state-machine.md` rather than
  guessing.
- A config setting, defaulting on, documented like its neighbours.
- Restoration is **crash-proof**. See constraints.
- `CommandRouterTests` covers the new command; the protocol round-trip is
  covered like the existing frames in `ProtocolTests`.

**Constraints that will bite you. Read these twice.**

- **The audio cues.** `src/main/sound/cues.ts` synthesises the start/stop tones
  as oscillator ramps, played through system output. Its header says: _"Dictation
  is eyes-free; this is the entire feedback channel."_ **A device-level mute will
  silence them**, so a naive implementation deletes the user's only confirmation
  that the microphone opened. Solve this — ordering the mute after the start cue
  and the unmute before the stop cue is the obvious approach, but verify by ear,
  and if the cues are asynchronous make sure you are not racing them. **A test
  or a documented manual verification that the cues are still audible is part of
  done.**
- **Leaving a user muted is the worst bug you can ship here.** If the helper is
  killed mid-recording the machine must not stay silent. Restore on signal
  handlers and on process exit; have the app unmute defensively on startup if it
  finds evidence it died while muted; do not rely on a single happy path. Think
  about what happens on force-quit, on crash, on logout, on sleep.
- **Do not clobber the user.** If they change volume or unmute manually while
  recording, do not stamp your remembered state over their choice on restore.
  FluidVoice's clipboard restore has a good pattern to learn from here — it
  checks whether the value it wrote is still the value present before restoring.
  Same idea, different resource.
- Prefer muting the device over setting volume to zero if the hardware supports
  a real mute, because the two restore differently and volume-to-zero loses the
  original level if anything goes wrong between. Handle devices that expose no
  mute. Handle the default output device changing mid-recording.
- Mute must not delay the start of capture. FluidVoice explicitly pauses media
  only _after_ capture is live so it cannot delay first PCM. Same principle:
  audio capture wins the race, always.

---

### W6 — Stats overview

**Why.** The app has recorded every dictation the user has ever made and shows
them nothing about it. A small, honest overview — words dictated, time spent,
where it went — is a genuinely nice thing to open, and the data is already on
disk.

**What exists today.**

- `contracts/events.ts:117` — `HistoryEntry`: `at`, `text`, `durationSec`,
  `language`, `frontmostBundleId`, `frontmostName`, `tier`, `inserted`,
  `verified?`, `unconfirmedTail?`. Everything you need is here.
- `src/main/history/index.ts` — the store; `contracts/ports.ts:292` — `HistoryPort`.
- `src/renderer/settings/` — the panels. `src/main/ui/panel-target.ts:23`
  registers `'settings' | 'history' | 'scratchpad'`.
- `src/renderer/settings/shell.tsx` — `PanelShell`, the header/toolbar/body/footer
  grid every panel renders into. Use it; it is the structural fix for a real bug
  and going around it will reintroduce that bug.
- `src/main/tray/menu.ts` — where an entry point would live.

**Done looks like.**

- A stats view that is worth opening: total and recent words dictated, time
  spent dictating, number of dictations, an estimate of time saved versus
  typing, most-used applications, language split, insertion success rate. Pick
  the ones that are actually interesting and cut the rest — **six good numbers
  beat fourteen mediocre ones.**
- The aggregation is pure and unit-tested, separate from the React. Same
  discipline as `presentation.ts`.
- Design that matches §7 and the existing panels. Not a table of numbers.

**Constraints that will bite you.**

- **Honesty about the denominator.** History retention defaults to 90 days
  (`contracts/config.ts`). "Total words dictated" therefore means "in the last
  90 days" and the UI must not imply otherwise. Label it accurately. This
  codebase would rather show a smaller true number than a bigger flattering one.
- **"Time saved" is an estimate built on an assumption** about typing speed.
  Show the assumption, or do not show the number. An unqualified "you saved 14
  hours" is marketing, not information — and it is exactly the kind of claim §5
  exists to prevent.
- **Purge must zero the stats.** The purge command exists because the history
  file is a partial keylogger; a surviving counter that says "1.2M words" after
  a purge violates the promise the purge made. If you want counters that survive
  purge, that is a real design question with a real privacy answer — **raise it
  in your report, do not decide it silently.** Default to deriving everything
  from history, which is the simplest honest thing and adds no new persistence.
- Loading the entire history to compute stats has a cost at scale. Measure it
  with a large fixture and handle it, or document the limit.
- No transcript text on the stats screen. Aggregates only.

---

## 7. The UX and UI bar

Two surfaces get real design work: **the HUD's live text (W1)** and **the stats
view (W6)**. The bar is high. "It renders" is not done.

**Read the existing design language first.** `src/renderer/hud/hud.css`,
`src/renderer/settings/panels.css`, `presentation.ts`, and `shell.tsx`. There is
a considered visual system here — two stacked pills, a permanent-grammar capsule
plus a transient message pill, drawn NSSwitch-shaped toggles, an ⓘ disclosure
pattern for explanatory prose. **Extend it. Do not introduce a second design
language.**

Specifics:

- **Motion has meaning or it does not happen.** Text should appear the way
  speech arrives, not fly in. No easing for its own sake.
- **Never reflow the user's attention.** The pill grows to fit text; it must not
  jump, jitter per partial, or shift the point the eye is resting on. Partials
  revise themselves — the word you just saw may change. Handle that gracefully
  rather than flickering.
- **Legible over decorative.** This is read at a glance, in peripheral vision,
  over arbitrary application backgrounds. Contrast and weight beat effects.
  Respect light and dark.
- **Respect `prefers-reduced-motion`.**
- **Every state has a considered empty and error case.** Stats with no history
  yet is a real state a real user will see on day one. Design it.
- **Keyboard and assistive access are not optional** on the stats panel. The
  existing `Switch` keeps a real focusable checkbox in the tree precisely so
  keyboard and assistive access are the native input's rather than a
  reimplementation. Match that standard.
- **Density.** Stats should read in about three seconds. If it needs a legend,
  it is too complicated.

Use the tray's `PREVIEW_VIEWS` affordance (`src/main/tray/menu.ts:118`) to
iterate on HUD states without dictating, and extend it with interim-text cases.
Screenshot your work and look at it. If it looks like a default-styled form, it
is not finished.

---

## 8. How to run this with subagents

You have subagents. Use them — but this repo has frozen contracts and a shared
state machine, so uncoordinated parallelism will produce a merge disaster.

### The rule that prevents that

**You personally make every change under `contracts/` — all of it, up front, in
one pass, before any implementation fans out.** W4, W5 and W6 all want to touch
it. Land the contract surface first, with its documentation, then hand
implementers a stable target. No subagent edits `contracts/`.

The same goes for `src/main/state/machine.ts` and `orchestrator.ts`: W4 and W5
both add effects. Do those yourself, together, once.

### Suggested shape

**Phase 1 — you, alone.** Read the three architecture docs. Skim FluidVoice's
audio pipeline and typing service. Land W0 (instrumentation), then all contract
and state-machine changes for W4/W5/W6 with their documentation. Nothing fans
out until this is committed and green.

**Phase 2 — fan out.** These touch disjoint trees and can run in parallel:

| Agent | Item                  | Owns                                                           |
| ----- | --------------------- | -------------------------------------------------------------- |
| A     | W2 — postToPid        | `native/` only. Different language, zero overlap.              |
| B     | W1 — HUD live text    | `src/renderer/hud/`, `src/shared/hud-view.ts`, `src/main/hud/` |
| C     | W3 — warm audio graph | `src/renderer/capture/`, `src/main/audio/`                     |
| D     | W6 — stats            | `src/renderer/settings/`, `src/main/history/`                  |

W4 and W5 implementation follows your Phase 1 machine work and can be a fifth
agent or your own hands, but its Swift side must not collide with agent A —
**sequence the helper work, do not parallelise it.**

**Phase 3 — you, alone.** Integrate, run all four checks, do the measurement
pass with W0, write the report and the changelog.

### Rules for delegation

- **Give each subagent this document's §4 (laws), §5 (documentation duty) and §7
  (UX bar) verbatim.** They are not optional context and a subagent that has not
  read them will produce code you have to rewrite.
- Give each subagent the exact file list it owns and tell it to touch nothing
  else.
- **Require every subagent to report what it could not do.** A subagent that
  reports success on a half-finished item is worse than one that reports
  failure, because you will not check.
- **Verify their claims yourself.** Run the tests. Read the diff. If a subagent
  says a measurement improved, reproduce it before it goes in the report.
- Do not let a subagent decide a product question — the purge/stats question in
  W6, the pacing-removal decision in W2, the Bluetooth trade-off in W3. Those
  come back to you.

---

## 9. Definition of done

Nothing ships until all of these are true:

- [ ] `npm test`, `npm run lint`, `npm run typecheck`, `./native/test.sh` all pass.
- [ ] `src/main/hud/focus.e2e.test.ts` re-run and passing (mandatory — W1 changes
      the HUD window).
- [ ] The insertion probe matrix re-run, fresh results in `native/probe-out/`,
      including `cmux`.
- [ ] Before/after latency numbers for W3 and W2, produced with W0, in the report.
- [ ] Every new threshold, timeout and magic number carries a comment saying
      measured or chosen, and against what.
- [ ] New settings documented in `contracts/config.ts` in the existing style.
- [ ] `CHANGELOG.md` entry in the existing voice.
- [ ] `docs/ARCHITECTURE.md` updated where the architecture changed.
- [ ] `docs/report-latency-ux-2026-08-22.md` written: what shipped, the numbers,
      what did not ship and why, what you would do next.
- [ ] No `console.*`. No automatic clipboard write. No transcript text in logs.
- [ ] Zero lines copied from FluidVoice.
- [ ] The two designed surfaces screenshotted and actually looked at.

---

## 10. Order of operations

1. Read `docs/ARCHITECTURE.md`, `contracts/state-machine.md`,
   `contracts/helper-protocol.md`. Then read `machine.ts` and `orchestrator.ts`
   properly. Do not skip this; everything else depends on understanding the
   effects-as-data seam.
2. Clone and skim FluidVoice. Note the techniques. Close it.
3. Ship **W0**. Measure the current app and record the baseline. **You cannot
   claim an improvement you have no baseline for.**
4. Land all `contracts/` and state-machine changes yourself.
5. Fan out W1, W2, W3, W6.
6. Land W4 and W5.
7. Integrate, measure again, verify every subagent claim.
8. Write the report. Publish the numbers, including any that disappointed you.

---

## 11. If you get stuck

- **A constraint here conflicts with something you find in the code.** The code
  wins, and the conflict goes in your report — it means this brief is wrong and
  that is worth knowing.
- **A change would require breaking one of the §4 laws.** Stop and report.
  Do not break it and mention it afterwards.
- **A measurement contradicts a premise here** — for instance, the warm audio
  graph turns out not to help, or pid-posting does not fix the cmux drop.
  **Publish the negative result and keep the existing behaviour.** A well-measured
  "this idea did not work" is a genuinely valuable deliverable and this codebase
  already contains several — `docs/spike-results.md` is largely a record of
  expectations that did not survive contact with the server. You are in good
  company.
