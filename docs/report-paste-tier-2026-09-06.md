# Report — the paste tier, as built

2026-09-06. Branch `feat/paste-tier`, off `dev` at `2b29c71`. Written after the
work, from `docs/handoff-insertion-2026-09-06.md` and the analysis in
`docs/report-insertion-2026-09-06.md`.

---

## 1. The short version

**Dictation now pastes.** A promised pasteboard item plus a synthetic ⌘V, with
the operating system's read receipt as the proof it landed — and Unicode
injection kept as the fallback for everything the paste route cannot reach. One
user-visible setting replaced five environment knobs. Two BUG-1 defences that
were written against the wrong diagnosis are gone.

**Three things I could not verify, and two of them matter.** The ⌘V chord itself
has never been posted on this machine: TCC attributes the Accessibility grant to
the _terminal that launched the process_, and this terminal (`cmux`) does not
hold it. So the paste tier's machinery is proven end to end — publish, chord
construction, receipt, verdict, release — but the last link, _does a synthetic
⌘V actually paste into cmux and Terminal.app_, is not. §5 says exactly what to
run and what to look for.

**The diff is a net increase, not the −1,000 the plan projected.** §4 has the
numbers and the three reasons. I would rather say that plainly than trim the
comments to hit a target that was an estimate in the first place.

---

## 2. What shipped

### 2.1 The tier

`native/Sources/HelperCore/PasteTransaction.swift` (217 lines, 64 of them code)
owns every decision and is a pure value type, so `swift test` covers every
branch headless. `native/Sources/grok-dictate-helper/PasteInserter.swift` (486
lines) is the syscall binding: `declareTypes:owner:` with no data behind any
type, a ⌘V chord on the HID tap, and `clearContents()` to settle.

Four decisions in it are worth naming, because each is a way the change could go
wrong silently.

**Only receipts after the chord count.** An earlier request for the data is a
clipboard manager reacting to the pasteboard _change_, not the paste target
reacting to ⌘V. Counting one of those as a landing would report success for text
nobody pasted.

**A receipt outranks a later loss of ownership.** If the target read our text and
_then_ the user copied something, the paste landed. Reporting `ownershipLost`
there would fall through to injection and type the transcript twice — the one
outcome this whole design exists to prevent.

**The insertion resolves on the first receipt; the pasteboard is released after
the last one plus 200 ms.** Two questions, not one, and they resolve at different
times. Chromium probes the pasteboard and then reads it, so clearing on the first
receipt hands the real read an empty pasteboard — but making the _user_ wait out
the quiet period would put 200 ms into the number this tier exists to reduce.
The release therefore happens after the insertion has already been reported,
which is why `PasteInserter` holds the live transaction and why
`HelperApp.shutdown` settles it.

**The pasteboard is cleared before the ladder falls through.** A target that
reads late reads an empty pasteboard. That ordering, plus one re-read of the
verdict on the callback thread _after_ the clear, is what makes falling through
to injection safe from double-typing; there is no window left in which a receipt
can arrive unseen.

### 2.2 Routing

`native/Sources/HelperCore/InsertRouting.swift`, three rules in order: the user's
`insertMethod` wins outright; above 120 UTF-16 units, paste; otherwise paste if
the focused element has the xterm.js signature — `kAXSelectedText` not settable
**and** `kAXNumberOfCharacters == 0`. No bundle-id table.

Only the third rule costs anything, so the focus probe is a closure and long text
never calls it. Both halves of the signature are required: Terminal.app reports
`settable: false` and types perfectly well, and an ordinary empty text field
reports zero characters.

The AX tier is skipped entirely on the paste route. Every terminal declines it at
`IsAttributeSettable`, and the check would be a second AX round trip for an
answer the routing already has.

### 2.3 The contract

`insert` gains `route`, defaulted to `auto` so an older app still parses.
`insert_result` gains the `paste` tier; `ready.caps` gains `paste`, so an app can
tell "this helper build cannot paste" from "the helper chose not to". The decoder
**rejects** a `route` it does not recognise rather than coercing it — the
opposite trade from `targetBundleId`, where absent and null mean the same thing,
because a route named by a newer app means something specific we cannot honour
and reading it as `auto` could paste when the user asked us not to.

`INSERT_DECLINE_REASONS` is unchanged. A `paste_not_read` was considered and
rejected on the test the existing four were chosen by: it produces no different
user-facing advice, because a paste with no receipt is never a terminal outcome.

`contracts/helper-protocol.md` §5.1 is the repeal of "the clipboard is never
written automatically" — the old rule, why it existed, what replaced it, and what
was given up, in that order.

### 2.4 Deleted

| Cut                                                         | Lines |
| ----------------------------------------------------------- | ----: |
| `InjectionVerifier` + `UnicodeWriteVerification` + tests    |   756 |
| `InjectionPacing` + tests                                   |   296 |
| `GROK_DICTATE_INJECT_CHUNK`, `_DELAY_MS`, `_TAP`, `_VERIFY` |   ~60 |
| `GROK_DICTATE_AX_SKIP` and `axSkipBundleIds`                |   ~30 |

`AXWriteVerification` (402 lines) was on the list and is **kept**. §8 row 5
assumed Arc's 20 sessions all move to the paste tier; they do not. Arc reports
`kAXSelectedText` as settable so it never matches the xterm.js signature, and the
median transcript is 109 characters — under the length threshold. Roughly half of
Arc's dictations still take the AX tier, and deleting the caret read-back would
restore the 2026-08-09 silent data-loss bug for them.

---

## 3. What was measured

### 3.1 `CGEventKeyboardSetUnicodeString` does not truncate

`--probe-chunk` sets N UTF-16 units on a real key event and reads them back off
the same event:

| units set | read back |
| --------: | --------: |
|        20 |        20 |
|       200 |       200 |
|     1,000 |     1,000 |
|     2,000 |     2,000 |

The 20-unit chunk constant came from 2015-era Quicksilver and Qt reports. On
macOS 26.6 the API does not truncate at any size tried, so the ceiling is now
200 — FluidVoice's value, and 10× fewer events for the same text.

**This measures the API, not any application.** Whether a given target _accepts_
a 200-unit event is a different question; change `TextChunker.defaultMaxUTF16Units`
and rebuild to ask it. A known limit rather than an overlooked one.

### 3.2 Promised pasteboard data is serviced without an `NSApplication`

This was an unexamined assumption and the whole design rested on it. Every
implementation of the technique that could be read — Handy, VoiceInk, FluidVoice
— is a full app bundle. Our helper is a command-line tool running a bare
`CFRunLoop`.

Measured with `--probe-paste --route none` and a `pbpaste` from another shell:
the promise resolved to the right string and `pasteboard:provideDataForType:`
fired on the main run loop when the reader asked, 1,942 ms after the publish and
not before. `changeCount` was unchanged by the read (107 → 107), which is what
makes it usable as an ownership token.

### 3.3 `clearContents()` fires `pasteboardChangedOwner:` on the caller

Our own settle looks exactly like the user copying something else. Without a
`settled` flag the settle path runs a second time on every successful paste. This
is why `PasteTransaction` carries one explicitly rather than deriving settlement
from its inputs, and why `recordOwnershipLost` is a no-op afterwards.

### 3.4 The tier works end to end, minus the chord

Driving the built binary in protocol mode:

```
{"v":1,"type":"insert","id":"e2e","text":"…","targetBundleId":null,"route":"paste"}
```

…and reading the pasteboard from another process produced:

```
log   pasted 21 UTF-16 units — cmux read the pasteboard 1067 ms after the chord
frame {"type":"insert_result","tier":"paste","ok":true,"verified":true,…}
log   took the transcript back off the pasteboard
```

`pbpaste` one second later returned empty. That exercises routing, the publish on
main, the wait on the insertion queue, the receipt on main, the verdict, the
scheduled release and the frame emission — with `pbpaste` standing in for a paste
target. The latency in that line is my `sleep`, not a real target's.

---

## 4. The line count, honestly

The plan projected **−1,539 against +250**. What actually happened:

|                  | insertions | deletions |        net |
| ---------------- | ---------: | --------: | ---------: |
| `native/Sources` |      1,559 |       969 |   **+590** |
| `native/Tests`   |        891 |       684 |   **+207** |
| TypeScript       |       ~350 |       ~45 |   **+305** |
| Markdown         |       ~300 |       ~60 |   **+240** |
| **Total**        |  **3,100** | **1,757** | **+1,343** |

The handoff's §13 asked for a net reduction of at least 1,000 lines and said to
say so rather than pad if the diff was not substantially negative. It is not.
Three reasons, and none of them is the plan being wrong about _what_ to delete:

1. **`AXWriteVerification` was kept** — 402 lines of the deletion target not
   taken, for the reason in §2.4.
2. **The instruments were not budgeted for.** `--probe-paste` and `--probe-chunk`
   are 304 lines in `Probes.swift`, and `ModifierSettle` is 60 more. The estimate
   counted the tier and nothing else. They are the only way anyone will ever
   settle the two open questions in §5, so I would write them again.
3. **The +250 was benchmarked against the wrong codebase.** It came from Handy's
   `paste_tx` being ~380 lines of Rust including tests and Windows support. This
   repository documents at a density that roughly triples that: of the three new
   decision files, `PasteTransaction.swift` is 217 lines with 64 of code,
   `InsertRouting.swift` is 128 with 42, and `PasteInserter.swift` is 486 with 234. **By executable statement the new tier is about 340 lines**, which is in
   the neighbourhood the plan expected.

The honest summary: the _machinery_ shrank roughly as intended — 1,142 lines of
production Swift and tests removed — and the replacement plus its instruments and
their documentation is larger than the estimate. Trimming comments to make the
number come out would be the wrong trade in this repository.

---

## 5. What is not verified, and how to verify it

Both need a terminal that holds **Accessibility**. `CGEvent.post` from an
untrusted process is dropped silently, which is why neither could be answered
here: TCC attributes the grant to the responsible process — the terminal that
launched the helper — and `cmux` does not hold it. Granting it to the terminal is
a one-time action in System Settings → Privacy & Security → Accessibility.

**Q1 — does a pid-posted ⌘V paste into an Electron terminal?** The chord ships on
`.cghidEventTap`, chosen and not measured. That is where Espanso, cliclick and
Karabiner put their events; the alternative is `postToPid`, which the injection
tier prefers, and FluidVoice forcing the _global_ clipboard path for Ghostty is
evidence that pid-posted ⌘V is unreliable in exactly the Electron terminals that
take 59 % of this app's traffic. With cmux frontmost:

```bash
./native/build/grok-dictate-helper --probe-paste --route hid --delay 5
./native/build/grok-dictate-helper --probe-paste --route pid --delay 5
```

Exit 0 means something read the text after the chord. If `pid` works and `hid`
does not, flip `PasteInserter.chordRoute`. The cost of the current guess being
wrong is bounded and visible: no receipt, so the ladder falls through to
injection and the user gets their text at the old speed.

**Q2 — does macOS 26's Terminal paste-protection dialog fire for us?** Terminal
inspects clipboard provenance via a private `_sourceSigningIdentifier` against a
list of 74 source apps, reportedly suppressed when developer tools are installed.
27 % of dictations go into Terminal.app, so this is the one open question that
could still be a _product_ problem rather than a tuning problem. Same command,
with Terminal.app frontmost, and watch the screen. If a dialog appears,
**Settings → Dictation → Insert text by → Typing** restores the old behaviour
without a rebuild — but say so, because the default would then be wrong.

**Q3 — does the headline number hold?** The target is a 2,000-character dictation
into cmux completing in under 150 ms, measured as `insert_end` minus
`insert_begin` in `~/Library/Logs/grok-dictate/main.log`. Today's measured value
for that length is 1,785 ms. Nothing in this branch has produced a real
end-to-end dictation, because the app was never run: that needs the packaged
build and a live xAI token.

---

## 6. What would show this made things worse

Three failure modes, named in advance, none of which raises an error anywhere.
Look for all three explicitly before trusting the default.

**A dictation that lands twice.** The fall-through after a paste that did land.
`PasteTransaction` prevents it three ways — a receipt outranks everything, the
pasteboard is cleared before injecting, and the verdict is re-read on the
callback thread after the clear — and `PasteTransactionTests` covers each. It
would still be the most expensive bug here, and it is visible: the transcript
appears twice in the target.

**The transcript still on the clipboard a minute later.** The release never ran.
The paths that could cause it are a crash between the receipt and the quiet
period — which cannot leak the transcript, because a promise whose owner process
is gone resolves to nothing — and a quit in the same window, which
`HelperApp.shutdown` handles by settling first. Check with `pbpaste` after a
dictation.

**A Terminal paste-protection dialog.** §5 Q2. Unmeasured.

And one that is not a failure but will surprise: **the user's previous clipboard
is gone after every pasted dictation.** That is the deliberate cost of never
reading the pasteboard, it is in the README's second paragraph and in the
CHANGELOG's first entry, and `Insert text by → Typing` is the way out.

---

## 7. Things noticed and deliberately not fixed

Law 6 — no drive-by refactors. Each of these is real and none of them is this
change's business.

- **`npm run lint` fails on `dev` and still fails here**, on three markdown files
  none of this branch created: `docs/handoff-insertion-2026-09-06.md`,
  `docs/report-insertion-2026-09-06.md` and `sound-lab/README.md`. Prettier wants
  to reformat their tables and italics wholesale. Running `prettier --write` over
  them would bury this branch's diff in reflowed prose. Every TypeScript file
  this branch touches passes.
- **`TierAttempt.notLanded`, `InsertionVerification.provenNotLanded` and
  `InsertDeclineReason.verificationFailed` now have no producer** in the shipping
  helper, because the Unicode length check that made them was deleted. They are
  kept: the ladder branch that maps them is exercised through the protocol's test
  stub, the app's handling of them is correct and tested, `mocks/mock-helper.mjs`
  still emits the frame, and old history rows can carry the state. Removing the
  vocabulary would mean deleting working user-facing copy to close a hole nothing
  can fall into.
- **`docs/report-insertion-2026-09-06.md` §11 lists in-repo citations of
  documents that are not in this repository** — `IMPLEMENTATION-PLAN.md`,
  `docs/phase-2-report.md`, `braindump`. Still true, and now truer: several
  comments this branch wrote cite `docs/report-insertion-2026-09-06.md`, which
  _is_ here, but the older references it inherits are still unresolvable by a
  reader of this repo alone.

---

## 8. Open questions I could not resolve

- **Is 120 UTF-16 units the right threshold?** Chosen, not measured. Espanso's
  is 100 after a decade of field reports; ours decides roughly half this user's
  traffic, since the median transcript is 109 characters. A week of real use with
  `history.json` split by tier would answer whether the split feels right, and
  nothing shorter will.
- **Is the 200 ms quiet period right for targets other than Chromium?** It is
  Handy's number, chosen for the same reason — Chromium asks more than once per
  paste. Nothing here measured how many receipts a native AppKit target produces,
  or whether any target's second read arrives later than 200 ms after its first.
  The failure mode if it is too short is an empty paste, which is loud.
- **Should the retry hotkey force the paste route?** ⌃⌘V currently follows
  `insertMethod` like any other insert. There is an argument that a retry is
  precisely the moment to use the most reliable route regardless of preference,
  and an argument that overriding a user's explicit `type` is exactly what a
  setting exists to prevent. I left it following the setting and did not resolve
  the argument.
- **Is 8 s the right fall-through ceiling?** It was Handy's restore number and
  the handoff specified it, so it is what first shipped. A later review
  shortened it to **0.5 s** (`PasteTransaction.timeout`): Handy used 8 s for a
  restore, where overrunning costs nothing, and here it was how long a user
  waited before injection started. The cost of shortening is near zero,
  because the pasteboard is cleared before the ladder injects. Too short is an
  empty paste then injection (loud); too long is a stuck HUD (silent).

---

## 10. Two bugs found reviewing this, and fixed

Both were in the paste tier as first written, both silent, and neither would have
been caught by any test that existed at the time.

**A missing Accessibility grant cost 8 seconds per dictation.** `CGEvent.post`
from an untrusted process is dropped with no error and no return value, so the
tier published a promise, posted a chord nobody received, waited out the full
ceiling and only then fell through — on _every_ dictation, on a machine where the
grant is simply absent. That is the state a freshly packaged build starts in, and
it recurs after some macOS updates. `PasteInserter.paste` now checks
`AXIsProcessTrusted()` before publishing anything and declines immediately with a
reason naming the System Settings pane, which is the same guard `AXInserter` has
had since Phase 2. Verified against the built binary: the tier declines, the
ladder falls through to injection at once, and no promise is published.

**Shutting down mid-paste span the insertion queue forever.**
`HelperApp.shutdown` settles a live transaction so that quitting cannot leave the
transcript on the clipboard — and it can do that while the insertion queue is
still inside its wait loop. `PasteTransaction.outcome` answered `nil` once
`settled` was set, which the loop reads as "keep waiting", so it span until the
process died. Bounded by process death in practice and wrong regardless.
`outcome` now answers `.abandoned` — or `.landed`, if a receipt had already
arrived, because the truth there is that the target has the text and the shutdown
is beside the point.

---

## 11. Sources

The analysis this implements: `docs/report-insertion-2026-09-06.md`, whose §12
carries the full source list. The mechanism is Handy's
(`src-tauri/src/paste_tx/`, MIT) — read, understood, closed, and reimplemented
against this codebase's own architecture, with the attribution in
`PasteInserter.swift`'s header. No source copied from any of Handy, VoiceInk or
FluidVoice; the latter two are GPLv3 and this repository is MIT.

---

## 12. Review pass (same day, later session)

The implementation above was reviewed against the handoff and the code. Five
things that would have failed silently in the field were fixed on this branch
before merge; the chord-into-cmux / Terminal-dialog measurements in §5 are
still open.

- **Do not fulfil the transcript until the chord.** A pre-chord `setString` let
  a clipboard manager cache the bytes, so the real paste never generated a
  receipt. Combined with posting the chord in the same `onMain` block as
  `declareTypes`, every manager read counted as a landing. The promise now
  provides text only after `recordChord`, and there is a 50 ms observer grace
  between publish and ⌘V.
- **`verdict` was asked before the runloop drained.** GCD `main.sync` is not
  AppKit's pasteboard callback queue. A pending `provideDataForType:` could be
  dropped by `markSettled` on the fail path. The fail path now drains
  `CFRunLoopRunInMode` once, then verdicts, then releases.
- **8 s was a restore budget used as a user wait.** `PasteTransaction.timeout`
  is 0.5 s. The serial insertion queue no longer sits for eight seconds on a
  target that does not paste with ⌘V.
- **Shutdown mid-paste fell through to Unicode injection.** `.abandoned`
  mapped to `.failed`, and every paste failure injects. It is now
  `TierAttempt.aborted` and the ladder stops.
- **`kAXNumberOfCharacters` was unpacked with `as? Int` on a `CFTypeRef`.**
  AX returns `CFNumber`; that cast often fails, so rule 3 never fired and
  short cmux dictations typed. Unpacked as `NSNumber`. `settable: false` with
  an unreadable count now pastes.

Still not done, and not fixable from this machine's shell: `--probe-paste`
into cmux and Terminal.app from a process that holds Accessibility (§5 Q1,
Q2), and a real 2,000-character dictation timed off `insert_end −
insert_begin`. The default is `auto`; those two runs are what would tell you
whether the default is wrong.
