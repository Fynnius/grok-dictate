# Handoff — the paste tier (2026-09-06)

> **This file is a prompt.** Paste it whole into a fresh agent session whose
> working directory is the worktree created in §2. Everything the agent needs is
> here or reachable from a path named here. Do not summarise it before handing
> it over.

---

## 1. Who you are and what you are doing

You are the lead engineer on **Grok Dictate**, a macOS menu-bar dictation app:
hold `Fn`, speak, release, and the transcript is typed into whatever app has
focus. It is an Electron main process plus a small Swift helper, and it streams
audio to the xAI speech-to-text API over a WebSocket.

You are landing **one coordinated change**: a clipboard-based insertion tier that
becomes the default route for terminals and long transcripts, and the deletion of
roughly 1,500 lines of machinery built to defend a tier that has never fired.

The evidence for the change is `docs/report-insertion-2026-09-06.md`. Read it
before anything else; it is 12 sections and it is the authoritative brief. The
one-paragraph version:

> Across 240 real dictations the Accessibility tier fired **zero** times. Unicode
> injection did all the work, it costs ~0.9 ms per character (1,785 ms for a
> 2,000-character transcript), and in the application where 59 % of dictations
> land it is defeated by a mechanism that spacing cannot fix — xterm.js with the
> kitty keyboard protocol calls `preventDefault()` on the synthetic keydown,
> cancelling Chromium's native `insertText` before the glyph reaches the PTY. A
> promised-pasteboard paste is O(1), gets bracketed paste in terminals, and comes
> with a read receipt from the OS that is a stronger correctness signal than
> either verifier this repo currently ships.

**You are driving this yourself.** The two product decisions that were the user's
to make have been made (§3.2) and are not open. Everything else is engineering
judgement and it is yours. Do not stop to ask permission for design choices;
write down what you decided and why, in the code, and report anything you could
not resolve.

**Work at a high level.** This codebase is unusually well-reasoned — read a few
files before you touch anything and you will see what the bar is. Match it. Code
that works but does not explain itself is not finished here.

---

## 2. The worktree

Do the work in a fresh worktree off `dev`, sibling to the main checkout. The
repo has used this pattern before (`Grok_STT-injection-pacing`).

```bash
git -C /Users/fynnauerbach/Documents/Programmieren/Grok_STT \
    worktree add ../Grok_STT-paste-tier -b feat/paste-tier dev

cd /Users/fynnauerbach/Documents/Programmieren/Grok_STT-paste-tier
npm install
./native/build.sh
```

`native/build.sh` writes its SwiftPM scratch tree to `out/native-build` inside
the worktree, so the two checkouts do not fight over a build directory. It also
ad-hoc-signs the helper, which the Accessibility API requires.

Commit on `feat/paste-tier`. **Never commit to `main`.** Push only if asked.

---

## 3. Where things stand

### 3.1 Facts, dated

- **2026-09-06** — `docs/report-insertion-2026-09-06.md` landed on `dev` as
  commit `1d5986a`, together with a pointer from `docs/ARCHITECTURE.md`. No code
  was changed. That commit is the whole of the prior work.
- **`dev` is at `fa1ee12`** as of this handoff — this file. The two commits under
  it (`f547536`, `0936524`) are unrelated audio-cue work that landed the same
  day; they touch `src/main/sound/*` and `src/renderer/hud/cues.ts` and have
  nothing to do with insertion. Branch from `dev` as it stands and leave those
  files alone. Confirm the tree is clean before you branch (`git status`).
- **Nothing is half-implemented.** There is no paste code anywhere. You are
  starting from a clean two-tier ladder.
- **The measurements in §9.5 of the report have not been run.** They are W0
  below and they are the first thing you do.

### 3.2 The two decisions already taken

These came from the user on 2026-09-06 and are **not** open for you to revisit:

1. **Full pass, default on.** You implement the paste tier, flip the default to
   `auto`, add the Settings control, delete the machinery in §9 W4, and rewrite
   `README.md`, `contracts/helper-protocol.md` §5, `docs/ARCHITECTURE.md` and
   `CHANGELOG.md` — all in the same branch. This is not a flag-gated experiment.
2. **Never read the pasteboard.** Publish a promise, hand out the text when it is
   asked for, and settle by clearing. **There is no snapshot and no restore.**
   The user's previous clipboard is gone after a dictation. This is deliberate:
   reading the pasteboard is the operation macOS 15.4+ prompts on, and a design
   that only ever writes is immune to that forever. See §11 trap 6.

### 3.3 What this reverses

`docs/handoff-latency-ux-2026-08-22.md` §4 law 1 says:

> **The clipboard is never written automatically.** … FluidVoice's fastest
> insertion path is a clipboard paste. **You may not adopt it.** If you find
> yourself wanting to, you have misread the product.

**That law is repealed by this work, on the user's explicit instruction.** The
original objection (`braindump` turn 7 — *"I don't want it automatically pasting
into my clipboard"*) was about the transcript *lingering* on the clipboard, and
the promise-plus-settle design answers it: the transcript is never resident as
plain data, it is marked so clipboard managers skip it, and it is gone within
~200 ms of the target reading it.

The replacement law is in §8. Write the repeal down in
`contracts/helper-protocol.md` §5 in the house style — state the old rule, why it
existed, what replaced it, and what was given up. Do not quietly delete the old
text.

---

## 4. Read first, in order

1. **`docs/report-insertion-2026-09-06.md`** — authoritative, written today, not
   yet stale. §2 is the field data, §4 is the survey of other tools, §7 is the
   design, §8 is the deletion list, §9.5 is your W0.
2. **`native/Sources/HelperCore/InsertionLadder.swift`** — the tier orchestration
   you are extending. The file header is the contract for what a tier may claim.
3. **`native/Sources/grok-dictate-helper/UnicodeInserter.swift`** — tier 2. Its
   two "load-bearing and easy to get wrong" details (private `CGEventSource`,
   cleared flags, the modifier-settle wait) apply verbatim to the ⌘V chord you
   are about to write. Reuse the reasoning, not by copy-paste.
4. **`contracts/helper-protocol.md`** §2, §3 (`insert`), §5 — the frame shapes and
   the clipboard rule you are rewriting.
5. **`contracts/helper-protocol.ts:30-45`** (`INSERT_TIERS`), **`:95-175`**
   (`INSERT_DECLINE_REASONS`, `InsertResultFrameSchema`), **`:227-238`**
   (`InsertCommandSchema`) — the exact schemas to extend.
6. **`docs/ARCHITECTURE.md`** and **`contracts/state-machine.md`** — short, and
   they encode the design. The central idea: `src/main/state/machine.ts` is a
   pure reducer returning effects as *data*, and `src/main/state/orchestrator.ts`
   is the only thing that interprets them against `contracts/ports.ts`. **Do not
   erode that seam.**
7. **`docs/handoff-latency-ux-2026-08-22.md`** §4–5 — the laws and the
   documentation duty. Still current except law 1 (see §3.3).

---

## 5. Verify before you trust this

This brief describes the repository as it was at 2026-09-06 12:50 UTC. It is a
claim about the past. Confirm anything load-bearing before you act on it.

```bash
# Branch point and the report commit
git log --oneline -3 dev
git show --stat 1d5986a

# The line counts §9 W4 tells you to delete — confirm before deleting
wc -l native/Sources/HelperCore/{InsertionLadder,AXWriteVerification,UnicodeWriteVerification,InjectionPacing,TextChunker,UnicodePostRouting,Pasteboard}.swift \
      native/Sources/grok-dictate-helper/{AXInserter,UnicodeInserter,InjectionVerifier,SystemPasteboard}.swift

# The claim that NSPasteboard is reachable from exactly one file today
grep -rn "NSPasteboard" native/Sources

# The field data behind §2 of the report — re-derive it, do not trust the table
python3 -c "
import json,collections
rows=json.load(open('$HOME/Library/Application Support/grok-dictate/history.json'))
print(len(rows),'rows'); print(collections.Counter(r['tier'] for r in rows))
print(collections.Counter(r.get('frontmostName') for r in rows).most_common(8))"
```

The two things most likely to have moved: **your own macOS version** (the report
assumes Darwin 25.6 / macOS 26.6 — check `uname -r`), and **whether the app is
currently granted Accessibility**, which resets after some updates and produced
7 errors in the existing log.

> Reading a setting is not observing a behaviour. Confirm what a thing *does*,
> not what it *says*. Every claim in the report about another application —
> cmux, Terminal, Arc — is either measured in `docs/phase-2-report.md` (which is
> **not in this repository**, see §12) or inferred. W0 exists to turn the
> inferences into measurements before you build on them.

---

## 6. Orientation

### Build, run, test

```bash
npm install
./native/build.sh          # Swift helper → native/build/grok-dictate-helper
npm run dev                # Electron dev
npm run package            # full .app into /Applications

npm test                   # Vitest — no Electron, no network, no microphone
npm run lint               # ESLint + Prettier
npm run typecheck
./native/test.sh           # swift test for HelperCore
```

**All four checks must pass before you call anything done.** `npm test` is fast
and hermetic — run it constantly, not at the end.

### The permission trap that will cost you an hour

macOS attributes TCC grants to the **responsible process** — the top of the
launch chain — not to the binary making the call. Running `npm run dev` from a
terminal means the *terminal application* needs Accessibility and Input
Monitoring, not Electron and not the helper. This was measured in phase 2
(HT-1) and it refuted the assumption the project started with. Symptom if you
get it wrong: `Accessibility trusted: false` and no event tap, with everything
apparently configured correctly.

The upside: the terminal's signature never changes, so the grant survives every
rebuild of both Electron and the ad-hoc-signed helper.

### Where the evidence lives

```
~/Library/Logs/grok-dictate/main.log                          NDJSON, one line per event
~/Library/Application Support/grok-dictate/history.json       one row per dictation, has `tier`
```

The timing channel emits `event=insert_begin` / `event=insert_end` /
`event=summary` lines with `key=value` fields. Grep those to measure your own
change; that channel is how §2.2 of the report was produced.

### The shape of the thing

```
contracts/            events, ports, config, helper protocol. Change deliberately, in one pass.
src/main/state/       machine.ts   — pure reducer: (state, event) → {state, effects[]}
                      orchestrator.ts — the ONLY thing that interprets effects against ports
src/main/native/      helper client + supervisor
src/renderer/settings/ settings, history, scratchpad panels
native/Sources/HelperCore/          pure, unit-tested Swift. No AppKit, no CoreGraphics, no AX.
native/Sources/grok-dictate-helper/ the executable: event tap, AX, Unicode injection, pasteboard
```

The `HelperCore` / executable split is what makes the interesting parts testable:
`swift test` runs headless with no windowserver and no TCC grants. **Every
decision you write must be a pure function in `HelperCore`; only the syscalls
belong in the executable.** That split is why §9 W2 is two files and not one.

---

## 7. Research standard

Do not answer from memory on anything versioned or vendor-controlled. Three
topics in this work have already burned someone:

- **`NSPasteboard` promised data and ownership.** `declareTypes:owner:`,
  `pasteboard:provideDataForType:`, `pasteboardChangedOwner:`, `changeCount`.
  Read Apple's current documentation. The owner is held weakly by AppKit and the
  lifetime rules are the part people get wrong.
- **Pasteboard privacy.** `NSPasteboard.accessBehavior` and the `detect` methods
  arrived in macOS 15.4. Check what the *current* OS on this machine does before
  you assume the design is safe; the design in §9 W2 is safe by construction
  because it never reads, but verify rather than assume.
- **`CGEventKeyboardSetUnicodeString` limits.** The 20-UTF-16-unit chunk this
  repo uses comes from 2015-era reports (Quicksilver, Qt). FluidVoice ships 200
  with zero delay. W0 settles which is true on macOS 26.

Use WebSearch / WebFetch for platform behaviour and context7 for library docs.
Read other projects' source directly — the report cites exact file paths in
Handy, VoiceInk and FluidVoice.

---

## 8. The laws of this codebase

Breaking one is a failed change. Law 1 is new; the rest are unchanged from
`docs/handoff-latency-ux-2026-08-22.md` §4.

1. **The pasteboard is written, never read.** Replaces the old "never written"
   law (§3.3). Concretely: no `pasteboardItems`, no `string(forType:)`, no
   `data(forType:)`, no `readObjects(forClasses:)`, anywhere in `native/`. Every
   write carries the transient markers. Every publish is followed by exactly one
   settle. `ClipboardDisciplineTests` (§9 W5) enforces all three — structurally
   *and* behaviourally, the way `ClipboardContainmentTests` does today.
2. **No `console.*` in app code.** ESLint enforces it. Everything goes through
   `src/shared/logger.ts`, which redacts via `src/shared/redact.ts`.
3. **Never log transcript text.** Log lengths, durations, counts, codes. The
   history file is already described in-repo as "a partial keylogger"; the log
   must not become a second one. **This applies to the paste path too** — never
   log the string you published, and never log what a receipt returned.
4. **`contracts/` changes happen deliberately, in one pass, before implementation
   fans out.** You need three of them (§9 W1). Do them first, in one commit.
5. **Anything that discards or rewrites what the user said is a setting.**
   `repairSeams` is the precedent. Replacing the user's clipboard is in this
   category — hence `insertMethod` in §9 W1.
6. **Do not do drive-by refactors.** If you spot something unrelated and wrong,
   write it in your final report; do not fix it.
7. **Report honestly.** If an item is half-done, say which half. If a
   measurement came out worse than expected, publish the number. The house style
   is full of "chosen, not measured" and "a known, unhandled limit rather than an
   overlooked one". That register applies to your report as much as your code.

---

## 9. The work

Seven items, ordered. Each states **why**, **what exists today** with exact
paths, and **what done looks like**. You own the design; where a constraint is
stated, honour it, and where it is not, use judgement and write down what you
decided.

---

### W0 — Measure, before you build anything

**Why.** Four claims in the report are inferences, and three of them would change
the design if they are wrong. This is half an hour of work and it is the
cheapest half hour in the project.

`native/Sources/grok-dictate-helper/Probes.swift` (624 lines) already has
`--probe-ax`, `--probe-insert`, `--probe-tap` and `--probe-secure-ax`. Add what
you need there, in the same style. Remember the TCC note in §6: a probe run from
a terminal inherits the *terminal's* grants.

Answer these four, and write the numbers into
`docs/report-insertion-2026-09-06.md` §9.5, replacing the questions:

1. **Does ⌘V posted with `CGEvent.postToPid` actually paste into cmux?** This
   matters because FluidVoice forces the *global* clipboard path for Ghostty,
   which suggests pid-posted ⌘V is unreliable in Electron terminals. If it fails,
   the chord goes on `.cghidEventTap` and W2 gets simpler.
2. **Does the macOS 26.4 Terminal paste-protection dialog fire for us?** Terminal
   inspects clipboard provenance via a private `_sourceSigningIdentifier` against
   a list of 74 source apps, reportedly suppressed when developer tools are
   installed. 27 % of dictations go into Terminal.app. One dictation answers it.
   If it fires, that is a product problem and you stop and report it.
3. **Is the 20-UTF-16-unit chunk limit still real on macOS 26?** Try 200, the
   FluidVoice value, with zero inter-chunk delay. If 200 works, the injection
   fallback gets 10× fewer events and W4's deletion of `InjectionPacing` is
   unambiguously safe.
4. **Does `AXWriteVerification` still catch Arc's discarded write?** Run
   `--probe-ax` against a text field on a web page in Arc
   (`company.thebrowser.Browser`). This decides whether §9 W4 row 5 is a deletion
   or a keep.

**Done when** all four have a number or a verdict in the report, and you have
said in one line what each result changes.

---

### W1 — Contracts, in one pass

**Why.** Law 4. Three files, one commit, before any implementation.

**`contracts/helper-protocol.ts`:**

- `INSERT_TIERS` (line 37) gains `'paste'`. Rewrite the doc comment above it —
  the current text says `none` means "the clipboard is NOT touched (§5.8)",
  which becomes false.
- `HELPER_CAPABILITIES` (line 49) gains `'paste'`, so an older app talking to a
  newer helper can tell.
- `InsertCommandSchema` (line 227) gains
  `route: z.enum(['auto', 'paste', 'type']).default('auto')`. **The app sends
  policy; the helper resolves it.** The helper is the only process that can see
  the focused element's AX signature and the target pid, so it must own the
  decision — but the *user's* preference lives app-side, so it has to travel.
  Optional-with-a-default on the wire so an older app still parses.
- `INSERT_DECLINE_REASONS` (line 121): the existing `verification_failed` now
  also covers "the paste chord was sent and nothing ever read the pasteboard".
  Decide whether that deserves its own reason (`paste_not_read`) — it produces
  different user-facing advice, which is the test the existing four were chosen
  by. Write down what you chose.
- `InsertResultFrameSchema.verified` (line 158): the semantics **improve** and
  the doc comment must say so. `true` now means "a consumer read the pasteboard
  after our chord", which is a real signal rather than an inference from a
  length delta.

**`contracts/config.ts`:** add

```ts
insertMethod: z.enum(['auto', 'paste', 'type']).default('auto'),
```

with a comment in the house style. `repairSeams` (line 124) and
`muteWhileRecording` (line 176) are the precedents for both the schema entry and
the prose block at the top of the file.

**`contracts/helper-protocol.md` §5:** the repeal (§3.3). State the old rule, why
it existed, what replaced it, and what was given up. `contracts/state-machine.md`
needs no change — the state machine does not know how insertion happens.

**Done when** `npm run typecheck` passes and `contracts/config.test.ts` and
`contracts/helper-protocol.test.ts` cover the new fields including the
older-peer-parses cases.

---

### W2 — The paste transaction

**Why.** This is the whole change. Everything else is plumbing or deletion.

Two new files, split along the `HelperCore` / executable line (§6):

**`native/Sources/HelperCore/PasteTransaction.swift`** — pure, unit-tested, no
AppKit. It owns the *decision*: receipt bookkeeping and when to settle.

```
state:  publishedAt, injectedAt, injectionFailed,
        receipts[], ownershipLost, settled

settle when:
  ownershipLost                                    → immediately
  a receipt after injectedAt, quiet for 200 ms     → landed
  injectionFailed and 500 ms elapsed               → failed, fall through
  8 s since publishedAt                            → timeout, fall through
```

Two rules make the receipt trustworthy, and they are the entire correctness
argument:

1. **Only receipts observed *after* the chord was posted count.** An earlier read
   is a clipboard manager or an antivirus reacting to the pasteboard change
   itself, not the paste target.
2. **Only settle while we still own the pasteboard** — `changeCount` unchanged
   and no ownership-lost callback. If the user copied something in the meantime,
   their action wins and we do not touch it.

The quiet period exists because Chromium probes the pasteboard and then reads it,
so several receipts arrive per paste. Every one of those numbers is **chosen, not
measured** — say so in the comment, and say what the failure mode of each is.

**`native/Sources/grok-dictate-helper/PasteInserter.swift`** — the syscalls.

- Publish with `declareTypes:owner:` carrying `public.utf8-plain-text` plus
  `org.nspasteboard.TransientType`, `org.nspasteboard.AutoGeneratedType`, and a
  private `com.fynnius.grokdictate.PasteSession` type holding a UUID. **No data
  behind any of them** — that is what makes it a promise. Record the returned
  `changeCount`.
- Implement `pasteboard:provideDataForType:` on the owner. **Only a request for
  the text type is a receipt**; a request for a marker type is a clipboard
  manager inspecting the markers. Hand out the transcript for the text type and
  an empty string for the markers.
- Implement `pasteboardChangedOwner:` → ownership lost.
- Post ⌘V. The physical V keycode is `0x09`; **do not derive it from the current
  layout by character**, because layouts whose name ends in `⌘` remap to QWERTY
  when Command is held and `keystroke "v"` resolves to the wrong key. Reuse
  `UnicodeInserter`'s two load-bearing details verbatim in spirit: a
  `CGEventSource(stateID: .privateState)` and explicitly cleared-then-set flags,
  because the retry hotkey is ⌃⌘V and a stray Control on the chord is not paste.
  Reuse `waitForModifiersToClear()` for the same reason.
- Settle by `clearContents()`. **No read, no snapshot, no restore** (§3.2). If
  the user has asked to keep the transcript on the clipboard, re-write it as
  plain text *without* the markers so managers record it — that is a
  configuration you may add if it falls out cheaply, not a requirement.

**Threading, and this one will bite you.** Promised pasteboard data is serviced
by AppKit **on the main run loop**. The helper's main thread runs a `CFRunLoop`
that owns the `CGEventTap`, and blocking it long enough gets the tap disabled by
macOS with `kCGEventTapDisabledByTimeout` — the canonical hotkey bug, caused by
our own success path. Insertion already runs on `BackgroundInsertion`'s serial
queue. So:

- **publish and post the chord on the main thread** (promised data needs the main
  run loop to be turning),
- **wait on the worker**,
- **dispatch the settle back to main.**

Read the note at the top of `native/Sources/grok-dictate-helper/HelperApp.swift`
before you move anything between threads.

**Done when** `swift test` covers every branch of `PasteTransaction` as a pure
function (Handy's equivalent has seven tests and they are the right seven), and a
real dictation into cmux logs a receipt with its latency.

---

### W3 — Routing

**Why.** Choosing the tier is a decision, so it is a pure function in
`HelperCore`, not an `if` buried in the ladder.

New `native/Sources/HelperCore/InsertRouting.swift`. Three rules, in order:

1. **User override** — `route` from the `insert` command. `paste` or `type` wins
   outright. This escape hatch replaces four environment variables.
2. **Length** — above ~120 UTF-16 units, paste. Espanso's threshold is 100 and it
   is the most battle-tested number in this space. Below it, type: a short reply
   should stay instant and leave the clipboard alone. **Chosen, not measured** —
   our own data says the median transcript is 109 characters and 39 % are over
   200, so the threshold decides roughly half the traffic. Say that in the
   comment.
3. **The xterm.js signature** — `kAXSelectedTextAttribute` not settable *and* the
   focused element reports `kAXNumberOfCharacters == 0`. That is the shape of a
   terminal that will silently swallow injected keys. Paste.

**No bundle-id table.** A list of the applications somebody happened to test is
exactly the thing this repo rejected in phase 2 (`AXSelectedTextGate`'s comment
argues it at length) and the argument has not changed.

Then wire it into `InsertionLadder.run`. The resulting ladder:

```
route == paste  →  paste, then inject on no-receipt
route == type   →  AX, then inject
```

**The one hazard.** Falling through to injection after a paste that *did* land
double-types the transcript. The receipt is what makes the fall-through safe, and
it is precisely why a fixed delay would not be. Never fall through on a timeout
that had a receipt in it.

Skip the AX tier entirely on the paste route — in a terminal we already know it
declines, and the settable check costs an AX round trip.

---

### W4 — Delete

Only after W2 and W3 are green. Confirm the line counts with the command in §5
before removing anything.

| Cut | Lines | Why |
| --- | ---: | --- |
| `InjectionVerifier.swift` + `UnicodeWriteVerification.swift` + `UnicodeWriteVerificationTests.swift` | 756 | Ships off by default. 7 false positives in the field, 0 true positives. The receipt replaces it with a better signal that works in cmux, where AX length is permanently 0 and this verifier can say nothing at all. |
| `InjectionPacing.swift` + `InjectionPacingTests.swift` | 296 | Wrong diagnosis (report §3). Taxes 39 % of dictations. Unnecessary once long text pastes. |
| `axSkipBundleIds` + `GROK_DICTATE_AX_SKIP` | ~25 | Never used. W3 rule 3 does the job generically. |
| `GROK_DICTATE_INJECT_TAP`, `_INJECT_CHUNK`, `_INJECT_DELAY_MS`, `_INJECT_VERIFY` | ~60 | The measurement session they existed for concluded in August. |
| `AXWriteVerification.swift` + tests + the pre-write caret read in `AXInserter` | 402+ | **Conditional on W0 question 4.** It defends one application (Arc), whose 20 sessions now route to paste. If W0 shows it still catches a live discarded write, keep it and say so. |

Keep `TextChunker` — the injection fallback still needs grapheme-safe chunking —
but re-tune its constant from W0 question 3.

Remove imports, settings fields and env parsing that *your* deletions orphan.
Do not remove pre-existing dead code you happen to notice.

**Expected net: −1,500 lines against roughly +250.** If your diff is not
substantially negative, something has gone wrong with the plan and you should say
so rather than pad it out.

---

### W5 — Rewrite the clipboard tests

`native/Tests/HelperCoreTests/ClipboardContainmentTests.swift` (232 lines) asserts
two things that are about to become false by construction: that `NSPasteboard`
occurs in exactly one source file, and that a spy records zero writes across every
insertion branch.

**Do not delete it. Rewrite it into `ClipboardDisciplineTests`** enforcing law 1,
with the same two-pronged structure — structural *and* behavioural — because the
existing file's reasoning about why either alone is weak is correct and still
applies:

- **Structural:** no pasteboard *read* anywhere in `native/Sources`. Scan for
  `pasteboardItems`, `string(forType:`, `data(forType:`, `readObjects(`,
  `canReadObject`. This is the assertion that catches a "helpful" snapshot added
  later in good faith, which is exactly the change someone would make.
- **Behavioural:** every publish carries all three marker types; every publish is
  followed by exactly one settle, including on every failure branch; the `copy`
  command still writes plain text without markers; a transaction whose
  `changeCount` moved does not clear.

The spy pattern and the `CommandRouter`-driven harness in the existing file are
good — keep the shape, change the invariants.

---

### W6 — The app side, and the documentation

**Settings.** Add the control to `src/renderer/settings/SettingsView.tsx`.
`repairSeams` (line 230) and `muteWhileRecording` (line 346) are the precedents
for the wiring through `src/main/config/index.ts` and
`src/renderer/settings/ipc.ts`. Copy that reads honestly, e.g.:

> **Insert text by** — Pasting / Typing / Automatic.
> Pasting is faster and works in terminals, and replaces what is on your
> clipboard. Typing leaves your clipboard alone.

**The orchestrator** passes `config.insertMethod` through as the `route` field on
the `insert` effect. Add the field to the effect in `src/main/state/machine.ts`
(the `insert` effect is at line 86) and read it in
`src/main/state/orchestrator.ts:395`. Keep the reducer pure — the config value
arrives as part of the event/context, it is not read from disk inside the
machine.

**History** already records `tier`; `paste` flows through with no change. Check
`src/renderer/settings/StatsView.tsx` renders the new tier sensibly rather than
falling off the end of a lookup.

**Documentation is half the deliverable, and it ships in the same commit as the
behaviour change, not after.** The house style states the rule, gives the numbers
behind it, brackets the uncertainty, names the source, and admits what is
arbitrary. From `InjectionPacing.swift`, which you are deleting — read it once
before you do, as a style reference:

```swift
/// Above this many UTF-16 units, slow down.
///
/// **Chosen, not measured**, and the evidence brackets it loosely on both
/// sides: 79 units landed in cmux, 760 did not, and Phase 2's 317-unit
/// fixture landed byte-identically in six other applications at 5 ms
/// (`native/probe-out/*.log`). Anywhere in 80–759 would be defensible; the
/// incident report proposed ~200 and nothing measured contradicts it.
```

Concretely:

- Every threshold and timeout you introduce says whether it was measured or
  chosen, and against what.
- Every file you create gets a header explaining why it exists and what would go
  wrong without it.
- **`README.md`** — the headline promise *"The clipboard is never written
  automatically"* is now false. Replace it honestly; do not soften it into
  something ambiguous.
- **`docs/ARCHITECTURE.md`** §Insertion — rewrite. It currently describes a
  two-tier ladder and says "It never writes the pasteboard". Note also that lines
  52–54 are already stale about the frontmost check (report §11); fix that while
  you are in the paragraph, since it is the same paragraph and not a drive-by.
- **`CHANGELOG.md`** under `## [Unreleased]` in the existing voice — read the
  0.2.0 entry first. It leads with what changed for the user, gives the number
  behind it, and states the trade rather than hiding it.
- **`docs/report-insertion-2026-09-06.md`** — update §9.5 with the W0 results and
  append a short "what shipped" section. Do not rewrite the analysis; it is the
  record of why this was done.
- **A new `docs/report-paste-tier-<date>.md`** — what you did, before/after
  numbers from the timing channel, what you could not finish, what you would do
  next. Follow the tone of `docs/spike-results.md`.

---

## 10. Order of operations

1. **W0** — measure. Do not write insertion code first; three of the four answers
   change the design.
2. **W1** — contracts, one commit, before implementation fans out.
3. **W2** — the transaction. `PasteTransaction` (pure, tested) before
   `PasteInserter` (syscalls).
4. **W3** — routing, wired into the ladder.
5. **Run it.** A real dictation into cmux, Terminal, Arc and Notes before you
   delete anything. Four apps, four log lines.
6. **W4** — delete, now that the replacement is proven.
7. **W5** — rewrite the clipboard tests.
8. **W6** — app side and documentation.

Commit at each numbered step with a real message. Several small commits beat one
large one.

---

## 11. Traps

Each is *what was believed* → *what was true* → *what it cost*.

1. **"The AX tier is the reliable one, so defend it."** → It has fired **0 times
   in 240 real dictations**; every terminal declines it at `IsAttributeSettable`
   and Arc fails the caret read-back. → 736 lines of production Swift and 604 of
   tests defending a path that never runs.
2. **"cmux drops the text because 38 events in 245 ms is too fast."** → xterm.js
   with the kitty keyboard protocol calls `preventDefault()` on the synthetic
   keydown, which cancels Chromium's native `insertText` before the glyph reaches
   the PTY. It is protocol-level interception, not a rate limit. → `InjectionPacer`
   taxes 39 % of dictations at ~0.9 ms/char and fixes nothing.
3. **"A fixed delay before restoring the clipboard is enough."** → The ⌘V
   keystroke is only *enqueued*; the target reads the pasteboard whenever its
   event loop gets to it. → Both VoiceInk and Wispr Flow document users getting
   their *old* clipboard pasted instead of the transcript, and both ship a
   "increase the restore delay" workaround. This is the single reason the design
   is receipt-driven.
4. **"An AX length that did not change means the text did not land."** → xterm.js
   reports `kAXNumberOfCharacters == 0` permanently, landed or not. → 7 red HUD
   flashes and error cues fired over text that was on screen, which is a worse
   failure than the silent drop it was built to catch.
5. **"`AXUIElementCreateSystemWide()` reaches the focused element."** → On
   macOS 26 it returns `kAXErrorCannotComplete (-25204)` in every application
   tested, at every messaging timeout. Only `AXUIElementCreateApplication(pid)`
   works. → The AX tier was silently dead through all of phase 2 and nothing
   looked broken, because Unicode injection covered for it.
6. **"Reading the pasteboard is free."** → macOS 15.4 previewed and macOS 26
   carries an alert on programmatic reads outside a user-initiated paste, with no
   "always allow" and no explanation string. **Writing never prompts.** → This is
   why §3.2 decision 2 exists, and why you must not add a snapshot "just to be
   safe".
7. **"Blocking the main thread briefly is fine."** → The helper's main thread
   runs the `CFRunLoop` owning the `CGEventTap`; stalling it gets the tap disabled
   with `kCGEventTapDisabledByTimeout`. → The canonical dead-hotkey bug, triggered
   by the app's own success path. Promised pasteboard data is serviced on main,
   so W2's threading split is not optional.

---

## 12. Do not do

- **Do not copy code from FluidVoice or VoiceInk.** Both are **GPLv3**; this
  repository is **MIT**. Copying — even a renamed function — would force a
  relicense. You may read them, understand the technique, close the file and
  implement the idea against this codebase's own architecture. Handy is MIT, and
  you should still reimplement rather than vendor, because its shape is Rust +
  Tauri and yours must be a pure `HelperCore` decision plus a thin executable
  binding. **Attribute the idea in the code comment** — `UnicodePostRouting.swift`
  already does this correctly for FluidVoice and is the model.
- **Do not use `org.nspasteboard.ConcealedType`.** It signals password-grade
  content, which is misleading for a dictation transcript and makes some managers
  visually obfuscate it. Transient + AutoGenerated only.
- **Do not snapshot and restore the pasteboard.** Decided (§3.2). It is also the
  step that will eventually prompt.
- **Do not build a bundle-id routing table.** W3 rule 3 is general and covers
  applications nobody has tested.
- **Do not set `kAXValue`** as an insertion route. It replaces the entire field.
- **Do not chase Input Method Kit.** It is genuinely the cleanest insertion
  channel on macOS — it bypasses key-event handling entirely and needs no
  Accessibility grant — but it requires the user to *select* the input source, so
  it would mean switching input sources around every dictation and rebuilding an
  `IMKInputController` each time. Research direction, not this session.
- **Do not fall through to injection after a receipt.** Double-types the
  transcript.
- **Do not reduce the modifier-settle wait** while you are in
  `UnicodeInserter.swift`. It exists because ⌃⌘V is the retry hotkey and an
  injected `a` carrying Command is ⌘A. Unrelated to this change.
- **Do not commit to `main`,** and do not push without being asked.

---

## 13. Done when

Every one of these is checkable. If you cannot demonstrate one, say so plainly
rather than reporting the item as done.

```bash
npm test && npm run lint && npm run typecheck && ./native/test.sh
```

- [ ] All four checks pass.
- [ ] A **2,000-character dictation into cmux completes in under 150 ms**
      (`event=insert_end` minus `event=insert_begin` in
      `~/Library/Logs/grok-dictate/main.log`). Today's measured value for that
      length is **1,785 ms**. That single number is the headline result.
- [ ] The log shows a receipt line with its latency for that dictation, and
      `history.json` records `tier: "paste"`.
- [ ] A short dictation (under the W3 threshold) into Notes still records
      `tier: "ax"` or `tier: "unicode"` and does not touch the pasteboard.
- [ ] `grep -rnE "pasteboardItems|string\(forType:|data\(forType:|readObjects\(" native/Sources`
      returns nothing.
- [ ] `git diff --stat dev` shows a **net reduction of at least 1,000 lines**.
- [ ] `README.md`, `contracts/helper-protocol.md` §5, `docs/ARCHITECTURE.md` and
      `CHANGELOG.md` are updated in the same branch as the behaviour change.
- [ ] `docs/report-insertion-2026-09-06.md` §9.5 contains the four W0 answers.

**And say in advance what would show this made things worse**, then check for it:
a dictation that lands twice (fall-through after a landed paste), a dictation
where the transcript is still on the clipboard a minute later (settle never ran),
or a Terminal paste-protection dialog. Look for all three explicitly before you
report success.

---

## 14. Environment

- **Worktree:** `/Users/fynnauerbach/Documents/Programmieren/Grok_STT-paste-tier`,
  branch `feat/paste-tier`, branched from `dev`.
- **Main checkout:** `/Users/fynnauerbach/Documents/Programmieren/Grok_STT` — the
  user's own working copy on `dev`. Do not edit it; do all work in the worktree.
- **Log:** `~/Library/Logs/grok-dictate/main.log` (NDJSON).
- **History:** `~/Library/Application Support/grok-dictate/history.json`.
- **Config:** `~/Library/Application Support/grok-dictate/config.json`.
- **Helper binary:** `native/build/grok-dictate-helper`, rebuilt by
  `./native/build.sh`, ad-hoc signed on every build.
- **Accessibility grant** goes to the terminal application that launches
  `npm run dev`, not to Electron (§6).
- **No credentials in this document.** Auth resolves from a `safeStorage` key,
  then `XAI_API_KEY`, then `~/.grok/auth.json` — see `docs/ARCHITECTURE.md` §Auth.
  If the token is dead the app now runs `grok models` to renew it; if that fails
  you will see `no usable token in auth.json` and dictation cannot be tested
  end-to-end. Say so rather than working around it.

---

## 15. Record progress in

`docs/report-insertion-2026-09-06.md` §9.5 for the W0 measurements, as you get
them — not at the end.

Everything else goes in the new `docs/report-paste-tier-<date>.md` (§9 W6), plus
commit messages at each step of §10.

---

## 16. Suggested skills

- **`/code-review`** at `high` before the final commit. This change deletes
  1,500 lines and rewrites a safety test; the two failure modes worth hunting are
  a deleted branch that was load-bearing and a settle path that can run twice.
- **`/run`** to drive the packaged app and confirm the change in the real
  application rather than only in tests. Half of this work is unobservable from
  `npm test`.
- **`/braindump`** only if the session produces findings that exist nowhere but
  the conversation — a measurement that contradicts the report, or an application
  that behaves unlike any of the four in W0.

Do **not** use subagents unless the user asks for them in their own words.

---

## 17. If you get stuck

- **The receipt never arrives.** Check the chord actually reached the target: is
  the pasteboard `changeCount` still yours, did `pasteboardChangedOwner:` fire,
  and does a manual ⌘V in that app paste the transcript? A manual paste that
  works while the synthetic one does not isolates the chord, not the promise.
- **The tap dies after your first paste.** Trap 7. You are blocking main.
- **`Accessibility trusted: false`** with everything apparently granted. §6 — the
  grant is attributed to the terminal, not to Electron.
- **A test asserts something you have deliberately made false.** That is `W5`, and
  it is expected for `ClipboardContainmentTests` only. Any *other* test failing
  that way is a signal you have broken an invariant that still holds — read its
  comment before changing it. The comments in this repo explain why the assertion
  exists, and they are usually right.
- **You cannot resolve a trade-off.** State it as an open question in your report
  rather than hiding it behind a confident sentence. That is the house style and
  it is what the existing comments do.
