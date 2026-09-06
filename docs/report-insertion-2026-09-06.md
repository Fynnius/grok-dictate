# Report — the insertion mechanism, what it costs us, and what to replace it with

2026-09-06. Research and recommendation, no code changed.

---

## 0. The short version

**We have never used tier 1.** Across 240 real dictations (2026-08-12 → 2026-09-06,
`history.json`), the Accessibility tier fired **zero** times. 239 went through Unicode
injection, one through nothing at all. Every line of `AXInserter`, `AXWriteVerification`,
`AXSelectedTextGate` and the caret read-back — 736 lines of production Swift plus 604 lines
of tests — has never executed on a real transcript on this machine.

**The tier that does all the work is the one whose failure mode we cannot fix by tuning.**
Unicode injection is O(n) in transcript length: 13 ms for a short reply, **1,785 ms for a
2,000-character dictation**. And in the application where 59 % of dictations land (`cmux`),
the mechanism that drops text is not rate-related at all — xterm.js with the kitty keyboard
protocol calls `preventDefault()` on the synthetic keydown, which cancels Chromium's native
`insertText` before the glyph reaches the PTY. `InjectionPacer` slows the burst down against
a problem that was never about speed.

**The premise about backups is half right.** There is no clipboard save-and-restore anywhere
in this codebase — `NSPasteboard` appears in exactly one file, wired to one command, and a
test enforces that. So there is nothing of that kind to cut. But the over-engineering is
real; it is just somewhere else. We ship **two independent verification subsystems**, one of
which is off by default and produced seven false "not inserted" alarms in the field and zero
true positives, and **seven environment knobs** left over from a measurement session that
concluded a month ago.

**What I would do.** Add a *receipt-sequenced clipboard paste* as the primary tier for
terminals and long text, keep Unicode injection as the fallback, and delete both
verification subsystems along with the pacing rule. The read receipt that macOS gives you
for free with a promised pasteboard item is a stronger correctness signal than either
verifier we wrote, it makes insertion O(1) instead of O(n), and it is the only route that
gets bracketed paste — which is what a terminal actually wants. Net: roughly **−1,300 lines,
+250 lines**, one new user-visible setting, and a real fix for the failure we have been
patching around since August.

The one thing it costs is the absolute guarantee that the pasteboard is never written. That
was your call in `braindump` turn 7 and it is still yours; §9.4 sets out exactly what the
weaker guarantee would be so you can decide against it with the facts in hand.

---

## 1. What we ship today

The ladder is `contracts/helper-protocol.md` §3, implemented across eleven files.

### 1.1 The two rungs

**Tier 1 — Accessibility.** `AXUIElementCreateApplication(pid)` →
`kAXFocusedUIElementAttribute` → set `kAXSelectedTextAttribute`. Setting *selected text* is
insert-at-caret when nothing is selected, replace when something is — exactly dictation's
semantics. Guarded twice:

- `AXSelectedTextGate` consults `AXUIElementIsAttributeSettable` first, because terminals
  report `settable: false` and then return `kAXErrorSuccess` from the write while inserting
  nothing (phase-2 §3.2, measured against Terminal.app and cmux).
- `AXWriteVerification` reads `kAXSelectedTextRange` before and after and requires the caret
  to have moved forward, because Arc's web content reports `settable: true`, returns
  `kAXErrorSuccess`, and discards the write anyway (2026-08-09, 13.8 s of dictation, an
  11 ms insert, a green pill, nothing on screen).

**Tier 2 — Unicode injection.** `CGEventKeyboardSetUnicodeString` on a virtual-key-0 event,
chunked at 20 UTF-16 units, posted to the target pid where one is live and to the global HID
tap otherwise. Layout-independent. Guarded by:

- `InjectionPacer` — above 200 UTF-16 units, 15 ms between chunks instead of 5 ms.
- `InjectionVerifier` + `UnicodeWriteVerification` — measure the focused element's
  `kAXNumberOfCharacters` (or `kAXValue` length) before and poll it after, ≤ 300 ms budget.
  **Off by default** (`GROK_DICTATE_INJECT_VERIFY=1` to enable).

**Tier 3 — nothing.** The clipboard is not touched. `ClipboardContainmentTests` asserts both
that `NSPasteboard` occurs in exactly one source file and that a spy records zero writes
across every branch, including every failure branch.

### 1.2 What that costs in code

| File | Prod | Tests | What it is |
| --- | ---: | ---: | --- |
| `HelperCore/InsertionLadder.swift` | 362 | 383 | tier orchestration, decline reasons, `AXSelectedTextGate` |
| `helper/AXInserter.swift` | 334 | — | tier 1 |
| `helper/InjectionVerifier.swift` | 324 | — | AX plumbing + poll loop for the tier-2 check |
| `helper/UnicodeInserter.swift` | 233 | — | tier 2 |
| `HelperCore/AXWriteVerification.swift` | 181 | 221 | caret-movement verdict |
| `HelperCore/UnicodeWriteVerification.swift` | 178 | 254 | length-delta verdict |
| `HelperCore/InjectionPacing.swift` | 147 | 149 | the long-text delay rule |
| `HelperCore/TextChunker.swift` | 55 | 90 | grapheme-safe UTF-16 chunking |
| `HelperCore/UnicodePostRouting.swift` | 44 | 26 | pid vs global tap |
| `HelperCore/Pasteboard.swift` | 22 | 232 | the containment protocol + its tests |
| `helper/SystemPasteboard.swift` | 23 | — | the one `NSPasteboard` call site |
| **Total** | **1,903** | **1,355** | **3,258 lines** |

Plus seven environment knobs (`GROK_DICTATE_INJECT_DELAY_MS`, `_INJECT_CHUNK`,
`_INJECT_TAP`, `_MODIFIER_SETTLE_MS`, `_AX_SKIP`, `_AX_VERIFY`, `_INJECT_VERIFY`), a
`--probe-ax` and a `--probe-insert` mode in `Probes.swift`, and three prose sections of
contract.

That is not gratuitous. Every one of those guards was written against a real incident, and
the comments name them. The problem is not that any single piece is wrong; it is that the
whole structure is a defence of a tier we do not use, wrapped around a tier we cannot fix.

---

## 2. What the field data actually says

### 2.1 Tier and target distribution — 240 dictations

`~/Library/Application Support/grok-dictate/history.json`, 2026-08-12 → 2026-09-06.

| tier | count |
| --- | ---: |
| `unicode` | 239 |
| `none` | 1 |
| `ax` | **0** |

| target | count | share |
| --- | ---: | ---: |
| cmux | 142 | 59 % |
| Terminal | 65 | 27 % |
| Arc | 20 | 8 % |
| Claude | 6 | 3 % |
| Safari, Finder, Cursor, Docker Desktop, Grok Dictate | 7 | 3 % |

86 % of dictation goes into a terminal. Every terminal declines the AX tier at
`IsAttributeSettable`. Arc reports settable and then fails the caret read-back, so it
declines too. **There is no application in a month of real use where tier 1 survived to a
successful write.**

### 2.2 Latency, by transcript length

From the timing channel (`insert_begin` → `insert_end`), 168 inserts with usable spans:

| length | n | median | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| 0–50 chars | 48 | 13 ms | 207 ms | 225 ms |
| 50–100 | 34 | 25 ms | 32 ms | 43 ms |
| 100–200 | 27 | 48 ms | 63 ms | 68 ms |
| 200–400 | 31 | **247 ms** | 322 ms | 358 ms |
| 400–800 | 25 | **470 ms** | 656 ms | 725 ms |
| 800–1600 | 1 | 1,128 ms | — | — |
| 1600+ | 2 | **1,785 ms** | — | — |

Above the 200-unit pacing threshold this is a clean straight line at roughly **0.9 ms per
character**. 93 of 240 dictations (39 %) are over 200 characters, so this is the common case,
not the tail. The 0–50 bucket's p90 of 207 ms is the 500 ms modifier-settle wait firing on
⌃⌘V retries, not injection cost.

Half a second to a second and a half of characters visibly streaming into a window is not a
cosmetic problem. It is long enough for the user to click away, long enough for shell
autosuggestion and TUI keybindings to react per-character, and it is time we spend on every
long dictation.

### 2.3 The failures

Eight rows with `inserted: false`:

- **Seven false alarms**, all cmux, 2026-08-22, transcripts of 6–45 characters. Every one is
  the `InjectionVerifier` reporting `0 → 0` on an xterm.js element that does not expose its
  buffer. The text was on screen. We fired a red HUD and an error cue over words the user
  could see. This is what caused the check to be turned off by default and `0 → 0`
  reclassified as `unverifiable` — the fix is correct, but the resulting subsystem is one
  that ships disabled and has never produced a true positive.
- **One real failure**, 2026-09-01, 510 characters into cmux, `tier: none` — both rungs
  declined and the text was left in the pill.

There were also 89 Secure Input refusals (an unrelated, correct behaviour) and 7
Accessibility-permission errors after app updates.

### 2.4 What this means

The measured picture is unambiguous:

1. The AX tier is dead weight *for this user's actual workload*. It is not wrong — it would
   fire in Notes, TextEdit and Safari's plain text areas — but those are 4 of 240 sessions.
2. The verification machinery has a negative track record: 7 false positives, 0 true
   positives, and it is shipped off.
3. The pacing rule taxes 39 % of dictations to defend against a mechanism that, as §3 shows,
   is not a rate problem.

---

## 3. Why the Unicode tier fails where it fails

`InjectionPacing.swift` reasons from the 2026-08-09 incident that "the variable is … how
many events arrive back to back". That was a defensible inference from the evidence
available. It appears to be the wrong diagnosis.

**The mechanism, confirmed elsewhere.** A peer project running an xterm.js-based terminal
(stablyai/orca #6513) traced exactly our symptom to the input path, not the event rate:

1. The tool posts a `CGEvent` with `keyboardSetUnicodeString`.
2. Chromium converts it into a DOM `keydown` plus a native `insertText` call.
3. With the kitty keyboard protocol active, xterm.js encodes the keydown itself and calls
   `preventDefault()`.
4. That cancellation suppresses the native `insertText`, so the `input` event carrying the
   real glyph never fires.
5. The text never reaches the PTY. No error anywhere.

Their words: *"xterm encodes+sends that ASCII on keydown and preventDefaults it, so the input
event carrying the real glyph is dropped."* They name dictation tools, text expanders and
accessibility utilities as the affected class.

**Apple documents the general case.** The CoreGraphics header for
`CGEventKeyboardSetUnicodeString` says outright that *application frameworks may ignore the
Unicode string in a keyboard event and do their own translation based on the virtual keycode
and perceived event state*. We post virtual key 0. Any framework that re-derives characters
from the keycode gets nothing. This is not a bug in our code and no amount of spacing fixes
it.

**There is also a length folklore, and it cuts the other way.** Quicksilver and Qt both hit
`CGEventKeyboardSetUnicodeString` truncating around 20 UTF-16 units, which is where our
20-unit chunk constant comes from. But FluidVoice (10.3k stars) ships a **200-unit** chunk
with **zero** inter-chunk delay via `postToPid` and it works. So our chunk size is probably
10× more conservative than it needs to be — which is 10× more events, which is more exposure
to whatever coalescing or interception is happening. If we keep injection, that is worth a
measurement.

**Conclusion.** Pacing is a guess that costs 0.9 ms/char forever and does not address the
named mechanism. The mechanism is defeated by not going through the key-event path at all.

---

## 4. What comparable tools do

Five implementations read at source level or from primary docs.

### 4.1 Espanso (Rust, ~10k stars, the most battle-tested text injector on macOS)

Two backends, `Inject` (key synthesis) and `Clipboard`, with `Auto` as the default:
**inject below `clipboard_threshold`, clipboard above it. The threshold is 100 characters**,
"because injecting a long match through separate events becomes slow for long strings".

Their tuning constants, which are a decade of field reports compressed into numbers:

| option | default | why |
| --- | ---: | --- |
| `clipboard_threshold` | 100 chars | inject is slow above it |
| `pre_paste_delay` | 300 ms | ensure the write lands before ⌘V |
| `restore_clipboard_delay` | 300 ms | "sometimes the target detects the previous content instead" |
| `paste_shortcut_event_delay` | 10 ms | "without a delay some keystrokes were not registered correctly" |
| `inject_delay` / `key_delay` | 0–1 ms | raise if the app misses characters |

Known cost, stated plainly by the maintainers: the clipboard backend **destroys non-text
clipboard contents** — they restore text but cannot restore images or file promises. The
community pattern is `Auto` globally with per-app overrides forcing clipboard for Electron
targets, "since Electron apps tend to drop injected keystrokes".

Also relevant to us: inject makes the app see *real keystrokes*, so autocorrect and smart
typography fire on it. That is the TextEdit smart-quote substitution phase-2 §4 saw and left
unresolved.

### 4.2 VoiceInk (Swift, GPLv3 — the closest analogue to us)

**Clipboard only.** No AX write path at all. `CursorPaster.swift`:

- snapshot the full pasteboard — every item, every type, as `Data`
- write the transcript through `ClipboardManager`, tagged `org.nspasteboard.TransientType`,
  `AutoGeneratedType`, `org.nspasteboard.source`, plus a private `com.VoiceInk.PasteSession`
  type carrying a UUID
- 100 ms pre-paste delay, then ⌘V — either four `CGEvent`s at `.cghidEventTap` with a 10 ms
  gap, or AppleScript `keystroke "v" using command down`
- restore after a user-configurable delay, floor 250 ms, **only if the pasteboard still holds
  our exact string *and* our session UUID**

Two details worth stealing. The keyboard-layout handling: layouts whose name ends in `⌘`
remap to QWERTY when Command is held, so they send `key code 9` (physical V) instead of
`keystroke "v"`. And the AppleScript path exists specifically as a workaround for machines
where `CGEvent` ⌘V misfires.

Their docs also name the failure mode that comes with the approach: *"if old clipboard content
gets pasted instead of your transcription, the clipboard was restored before the target app
finished pasting — increase the Restore Delay."* A fixed delay is a race, and they lose it
often enough to document the workaround.

### 4.3 FluidVoice (Swift, GPLv3, ~10.3k stars) — the everything ladder

`TypingService.swift`, 1,565 lines. Two user-selectable modes.

*Standard (direct typing)*, in order: Unicode `postToPid` at the **preferred** pid → Unicode
`postToPid` at the **AX-focused** pid → AX focused-element write → Unicode on the HID tap →
clipboard ⌘V → character-by-character at 1 ms. Chunk size **200 UTF-16 units**, inter-chunk
delay **0**, surrogate-pair-safe splitting only.

*Reliable Paste*: clipboard ⌘V `postToPid` → global clipboard ⌘V → **AppleScript click of the
Edit ▸ Paste menu item**. Forced regardless of mode when the target is Ghostty.

Note the ordering: FluidVoice tries **Unicode before AX**, the reverse of us. And it keeps a
clipboard rung under everything.

Their restore is smarter than a delay: `waitForFocusedTextVerification` polls the focused
element for up to 5 s and only restores once the focused text actually *contains* the
expected string (or the caret advanced by the expected length), then checks `changeCount`
before writing back. They deliberately tag Transient + AutoGenerated but **not** `Concealed`,
with the comment that concealed "signals sensitive/password content, which would be
misleading for a dictation transcript".

### 4.4 Handy (Rust/Tauri, MIT) — the best mechanism I found

`src-tauri/src/paste_tx/`. Handy's own header states the problem with everything above:

> The legacy clipboard paste restores the previous clipboard after a fixed delay. The paste
> keystroke is only *enqueued* at that point — the target application reads the clipboard
> whenever its event loop gets to it, so any fixed delay can lose the race and the user gets
> their old clipboard pasted back.

Their fix: **do not put data on the pasteboard. Put a promise on it, and let macOS tell you
when someone reads it.**

- `declareTypes:owner:` with an owner object publishes `public.utf8-plain-text` plus the three
  concealment marker types, with no data behind them.
- When a consumer actually asks for the text, AppKit calls
  `pasteboard:provideDataForType:` on the owner. **That callback is a read receipt.**
- `pasteboardChangedOwner:` fires if anyone else takes the pasteboard.

Two rules make the receipt trustworthy, and they are the clever part:

1. **Only receipts after the ⌘V chord counts.** An earlier read is a clipboard manager or an
   antivirus reacting to the change, not the paste target.
2. **Restore only while we still own the pasteboard** — `changeCount` unchanged and no
   ownership-lost event. If the user copied something in the meantime, their action wins.

Timing: restore 200 ms after the *last* receipt (Chromium probes then reads, so several
receipts arrive per paste); hard ceiling 8 s; 500 ms if the chord could not be sent at all.
The whole decision is a pure function, `evaluate(&TxState, now)`, with seven unit tests.
Their stated failure mode: *"the transcript stays on the clipboard a bit longer, never stale
content gets pasted."*

They also gate auto-submit Enter on the receipt — never press Enter after an unconfirmed
paste, because that would submit stale content.

### 4.5 Wispr Flow (closed, but documented)

Accessibility write first, clipboard fallback, restores the original clipboard, marks
dictated text concealed so clipboard managers skip it. Insertion is skipped in password
fields, banking apps and very large text fields. If insertion fails, the text is left on the
clipboard and there is a "Paste last transcript" recovery. Their docs warn that on a failed
paste your dictated text may no longer be on the clipboard — the same restore race as
VoiceInk.

### 4.6 Side by side

| | primary | fallbacks | verification | restore guard |
| --- | --- | --- | --- | --- |
| **Grok Dictate** | AX write | Unicode inject | caret read-back + AX length poll | n/a — never writes |
| Espanso | inject < 100 chars | clipboard ≥ 100 | none | fixed 300 ms delay |
| VoiceInk | clipboard ⌘V | AppleScript ⌘V | none | content + session-UUID match, ≥ 250 ms |
| FluidVoice | Unicode → pid | AX → HID → clipboard → menu paste → char-by-char | focused text *contains* expected | text match + `changeCount`, ≤ 5 s |
| Handy | promised clipboard | legacy clipboard | **OS read receipt** | receipt quiet period + `changeCount` + ownership |
| Wispr Flow | AX write | clipboard | unknown | fixed delay |

**Nobody except us ships without a clipboard rung.** And the two projects that thought
hardest about it — Handy and FluidVoice — both replaced the fixed restore delay with an
observable signal, which is the same instinct that produced our two verifiers, applied to a
mechanism where the signal actually exists.

---

## 5. The full menu of macOS insertion mechanisms

| mechanism | reaches | cost | verifiable? | notes |
| --- | --- | --- | --- | --- |
| AX `kAXSelectedTextAttribute` | native AppKit text views | 32–50 ms, O(1) | caret read-back | dead in terminals, Electron, most web content. 0/240 for us |
| AX `kAXValue` set | same | O(1) | value read-back | replaces the *entire* field — destructive, do not |
| `CGEventKeyboardSetUnicodeString` | anywhere a keyboard works | **O(n)**, ~0.9 ms/char | none native | frameworks may ignore the payload (Apple's own header); kitty protocol cancels it |
| `CGEvent.postToPid` | one process's queue | same | none | bypasses global taps. Already used. Some apps ignore pid-posted events |
| clipboard + synthetic ⌘V | anywhere ⌘V works | **O(1)**, ~20–120 ms | none by itself | gets **bracketed paste** in terminals |
| clipboard **promise** + ⌘V | same | O(1) | **`provideDataForType:` receipt** | Handy's route; the only mechanism with a native "it was read" signal |
| AX click of Edit ▸ Paste | apps with a real menu bar | ~200 ms + AppleScript | menu item state | FluidVoice's last rung; survives blocked key events |
| Input Method Kit `insertText` | everywhere, bypasses key handling entirely | O(1) | none | **needs no Accessibility grant**, but the user must select the input source — impractical unless we switch input sources around each dictation |

The bracketed-paste line deserves emphasis, because it is a correctness difference and not a
performance one. When a terminal performs a *paste*, it wraps the payload in `ESC[200~` …
`ESC[201~`, and readline/zsh/TUIs treat the block atomically: no per-character keybindings,
no autosuggestion churn, and **embedded newlines do not submit**. Synthetic keystrokes skip
that entirely — the terminal never knows a paste happened, so every `\n` is Enter. We have
been lucky that STT transcripts rarely contain newlines. Any future formatting or
punctuation-command feature makes that a live bug on the injection path and a non-issue on
the paste path.

---

## 6. Platform risks a clipboard route has to price in

These are the reasons not to do it, stated before the recommendation.

**Pasteboard privacy prompts.** macOS 15.4 previewed, and macOS 26 carries, an alert when an
app *programmatically reads* the general pasteboard outside a user-initiated paste.
`NSPasteboard.accessBehavior` reports always-allowed / never-allowed / ask, and new `detect`
methods let you inspect types without triggering it. As of macOS 26 it appears to still be
gated behind `EnablePasteboardPrivacyDeveloperPreview` rather than on by default — but the
direction is settled, and the developer complaints are specific: no "always allow", no
explanation string, and a first-launch permission prompt.

**This is the single strongest argument against snapshot-and-restore**, and it is why Handy's
promise design matters more than it first appears: **writing** the pasteboard never prompts.
Only reading does. A design that reads the old contents in order to restore them is the one
that will eventually prompt; a design that only writes is future-proof. (Handy itself still
reads, to snapshot — that part of their design is the vulnerable one.)

**macOS 26.4 Terminal paste protection.** Terminal now inspects clipboard provenance via a
private `_sourceSigningIdentifier` and can intervene when content pasted from another app
looks risky, against a list of 74 source apps. Reported to be suppressed when developer tools
are installed or Terminal was used recently. We are on Darwin 25.6 (macOS 26.6) and 27 % of
dictations go into Terminal.app, so this is worth one manual test before committing.

**Clipboard managers.** The `org.nspasteboard.*` markers are a *convention*, not an
enforcement. Maccy honours all three; others do not, and the maintainers of the convention
publicly disagree about whether `AutoGeneratedType` implies transient. Some users' history
will capture transcripts. FluidVoice's reasoning on `ConcealedType` is right: do not claim
the transcript is a password, because a manager may then obfuscate it in ways that are worse.

**Secure Input.** Blocks event taps and synthetic key events, so it blocks a synthetic ⌘V
exactly as it blocks Unicode injection. It does **not** block AX writes (phase-2 HT-5,
measured — Terminal's `sudo` prompt accepted an AX write). We already refuse to insert while
blocked, which stays correct.

**Non-text clipboard contents.** Espanso cannot restore images or file promises. VoiceInk
snapshots every item and every type as `Data` and can. Handy handles text and image only. If
we restore, we should do it VoiceInk's way — but note that reading `NSPasteboardItem.data`
for every type is exactly the pasteboard read that will prompt someday.

---

## 7. Recommendation

### 7.1 The shape

**Make the paste a first-class tier, keep injection as the fallback, and let the receipt do
the verifying.**

```
insert(text):
  if secure input          → refuse (unchanged)
  choose route:
     paste   if target is a terminal / Electron, or text > ~120 chars, or user forced it
     inject  otherwise
  ── paste ──────────────────────────────────────────────
     publish a promise on the general pasteboard
       declareTypes: [public.utf8-plain-text,
                      org.nspasteboard.TransientType,
                      org.nspasteboard.AutoGeneratedType,
                      com.fynnius.grokdictate.PasteSession]  owner: self
       record changeCount
     post ⌘V to the target pid (fall back to the HID tap)
     wait for provideDataForType: on the text type
        ↳ receipt after the chord  → landed. verified: true, honestly.
        ↳ no receipt within ~3 s   → not landed. fall through to inject.
     200 ms after the last receipt, if changeCount is unchanged
        and ownership was not lost → restore
  ── inject ─────────────────────────────────────────────
     today's UnicodeInserter, minus the pacing rule,
     with the chunk size re-measured (20 → up to 200)
```

Three things fall out of this that we currently pay for separately:

1. **Verification becomes free and correct.** The receipt is a signal from the operating
   system that the target read our text. It is strictly stronger than `kAXNumberOfCharacters`
   polling — it works in cmux, where AX length is permanently `0` and our verifier cannot say
   anything at all — and it does not need a 300 ms budget, an element-identity re-check, or a
   `0 → 0` special case. `InjectionVerifier` and `UnicodeWriteVerification` can go.
2. **Latency stops scaling with length.** The 1,785 ms insert becomes ~20 ms of chord plus
   however long the target takes to read. `InjectionPacing` becomes unnecessary because we
   will not be injecting 2,000 characters any more.
3. **Terminals get bracketed paste**, so newlines and future formatting are safe, shell
   autosuggestion does not churn per character, and the kitty-protocol interception is
   bypassed entirely — it only affects keydown handling.

### 7.2 The restore, and the one design choice that matters

**Do not snapshot the old pasteboard by reading it.** That is the step that will prompt on a
future macOS, and it is the step that both VoiceInk and Handy still perform.

Two options, and I would take the first:

- **(a) Do not restore at all; leave the transcript.** Publish it as a promise, hand it out
  on read, and once the receipt goes quiet, **replace it with nothing** — call
  `clearContents()` and leave the pasteboard empty, or leave the transcript as plain text if
  the user prefers. No read, ever, so no prompt, ever. The cost is that the user's previous
  clipboard is gone. For a dictation tool this is much less bad than it sounds — the thing
  most recently copied is usually less valuable than the thing just dictated — but it is a
  visible behaviour change and it needs to be a setting.
- **(b) Snapshot and restore, VoiceInk-style**, accepting a future prompt and using
  `NSPasteboard.accessBehavior` / `detect` to degrade gracefully when the prompt arrives.
  More faithful to "we never disturb anything", more machinery, and on a clock.

If we go with (a), the honest user-facing sentence changes from *"the clipboard is never
written"* to *"dictation replaces your clipboard, and is marked so clipboard managers ignore
it"*. That is a real regression against your original requirement and you should decide it
explicitly, not have it decided by an implementation detail.

### 7.3 Routing: how to choose paste vs inject

Do not build a bundle-id table. Three rules, in order:

1. **User override**, per app, from Settings — the pattern every comparable tool converged on
   (Espanso `force_mode`, VoiceInk Paste Method, FluidVoice insertion mode). This is the
   escape hatch that replaces four of our environment variables.
2. **Length**, Espanso's rule: above ~120 characters, paste. Below it, inject — a short reply
   should stay instant and leave the clipboard alone. Our own data says 39 % of dictations
   are over 200 chars and those are the ones that hurt.
3. **A negative signal from the AX tier**: if `kAXSelectedTextAttribute` is not settable
   *and* the element reports `kAXNumberOfCharacters == 0`, that is the xterm.js signature.
   Paste. This is general — no bundle ids — and it reuses a check we already perform.

### 7.4 What happens to the AX tier

Keep it, demoted, and stop defending it so hard. It fires in 4 of 240 sessions but it is
genuinely the best route in those 4 — 32–50 ms, no clipboard, no synthetic events, works
under Secure Input. Two changes:

- Try it **only when the route rules above chose `inject`**. In a terminal we already know it
  will decline; the settable check costs an AX round trip we can skip.
- Consider deleting `AXWriteVerification` and the pre-write caret read. It exists for one
  application (Arc's web content, 20 sessions, all of which now go through Unicode anyway).
  If paste becomes the route for web content too, the Arc case is gone and 402 lines with it.
  This one is genuinely arguable — the Arc bug was real and silent — so measure first: run
  `--probe-ax` against Arc once and see whether the caret check still catches it under
  macOS 26.6.

---

## 8. What to cut, precisely

Ordered by confidence. Everything here is contingent on the paste tier landing first.

| # | Cut | Lines | Confidence | Why |
| --- | --- | ---: | --- | --- |
| 1 | `InjectionVerifier.swift` + `UnicodeWriteVerification.swift` + tests | 756 | **high** | ships off; 7 false positives, 0 true positives; the receipt replaces it with a better signal |
| 2 | `InjectionPacing.swift` + tests | 296 | **high** | wrong diagnosis (§3); taxes 39 % of dictations; unnecessary once long text pastes |
| 3 | `axSkipBundleIds` + `GROK_DICTATE_AX_SKIP` | ~25 | **high** | never used; §7.3 rule 3 does the job generically |
| 4 | `GROK_DICTATE_INJECT_TAP`, `_INJECT_CHUNK`, `_INJECT_DELAY_MS`, `_INJECT_VERIFY` | ~60 | **high** | the measurement session they existed for concluded in August |
| 5 | `AXWriteVerification.swift` + tests + the pre-write caret read | 402+ | **medium** | only defends Arc; re-measure before deciding |
| 6 | `TextChunker` grapheme logic | — | **keep** | still needed for injection; re-measure the 20→200 limit |
| 7 | `ClipboardContainmentTests` structural assertion | 232 | **must change** | the "`NSPasteboard` in exactly one file" assertion becomes false by construction. Replace with: no pasteboard **read**; every write carries the transient markers; every write is followed by a settle |

Net if 1–5 land: **−1,539 lines**, against roughly **+250** for the paste transaction
(Handy's `paste_tx` is ~380 lines of Rust including tests and Windows). Seven environment
knobs become one user-visible setting.

---

## 9. Costs, risks, and the things I am not sure about

**9.1 This is a real behaviour change, not a refactor.** The pasteboard gets written on most
dictations. `contracts/helper-protocol.md` §5 ("No clipboard read. Nothing in this protocol
can read the pasteboard, by design") survives under option (a) and dies under option (b).
`README.md`'s headline promise — *"The clipboard is never written automatically"* — has to
change either way.

**9.2 The receipt is not universal.** `provideDataForType:` fires when someone *reads* the
pasteboard. A target that reads and then discards still produces a receipt. It is a strictly
better signal than anything we have, not a proof of insertion. Handy is explicit that its
failure mode is "the transcript sits on the clipboard longer", never "stale content pasted" —
we would inherit both the guarantee and its limit.

**9.3 ⌘V is not universal either.** Apps with a non-standard paste binding, or a focused
element that ignores ⌘V, will not paste. That is what the injection fallback is for, and it
is why the receipt timeout must fall through rather than report failure. Note the ordering
hazard: falling through to injection after a paste that *did* land duplicates the text. The
receipt is what makes that decision safe, and it is why a fixed delay would not be.

**9.4 The pasteboard-privacy clock.** Option (a) is immune. Option (b) is on a timer of
unknown length. If we take (b), write the `accessBehavior` check in from day one.

**9.5 Measured, 2026-09-06, on Darwin 25.6 (macOS 26.6).** Four questions were open when this
was written. One is answered by measurement, one by an argument that turns out not to need the
measurement, and two are still open because they cannot be run from this machine's shell. Two
facts the list did not think to ask for turned up; both are load-bearing.

**Q1 — Does ⌘V posted with `postToPid` actually paste into cmux? OPEN.** Not measurable from
here. `--probe-paste` reports `Accessibility: NOT TRUSTED`, because TCC attributes the grant to
the *responsible process* — the terminal that launched the probe, cmux
(`com.cmuxterm.app`) — and that terminal does not hold it. `CGEvent.post` from an untrusted
process is dropped silently, so no chord can be posted and no route compared.
*What it changed:* the chord goes on **`.cghidEventTap`**, chosen and not measured. That is
where Espanso, cliclick and Karabiner put their events, and FluidVoice forcing the *global*
clipboard path for Ghostty is evidence that pid-posted ⌘V is unreliable in exactly the
Electron terminals that take 59 % of our traffic. The cost of guessing wrong is bounded and
visible — no receipt, so the ladder falls through to injection and the user gets their text at
today's speed. `PasteChord.Route` carries both cases, so flipping the default is one line once
somebody can run, from a terminal that holds Accessibility and with cmux frontmost:

```bash
./native/build/grok-dictate-helper --probe-paste --route pid --delay 5
./native/build/grok-dictate-helper --probe-paste --route hid --delay 5
```

**Q2 — Does the macOS 26.4 Terminal paste-protection dialog fire for us? OPEN**, for the same
reason: it needs a chord, and a chord needs the grant. 27 % of dictations go into Terminal.app,
so this is the one open question that could still be a product problem rather than a tuning
problem. `--probe-paste --delay 5` with Terminal.app frontmost answers it in one run. If a
dialog appears, `insertMethod: "type"` in Settings restores today's behaviour without a
rebuild.

**Q3 — Is the 20-UTF-16-unit chunk limit still real on macOS 26? NO.** `--probe-chunk` sets N
units on a key event and reads them back off the same event:

| units set | read back |
| ---: | ---: |
| 20 | 20 |
| 200 | 200 |
| 1,000 | 1,000 |
| 2,000 | 2,000 |

`CGEventKeyboardSetUnicodeString` does not truncate at any size tried. The 20-unit constant is
folklore about an API limit that no longer exists — if it ever applied to this call rather than
to the callers' own buffers.
*What it changed:* `TextChunker.defaultMaxUTF16Units` goes 20 → 200, FluidVoice's value: 10×
fewer events for the same text and 10× less exposure to whatever coalesces or intercepts them.
It does **not** prove a target *accepts* a 200-unit event; that is a different question, and
changing `TextChunker.defaultMaxUTF16Units` and rebuilding is how it gets asked. The grapheme-safe
splitting is untouched — only the ceiling moved.

**Q4 — Does `AXWriteVerification` still catch Arc's discarded write? Not run, and kept anyway,
on an argument that does not need the measurement.** §8 row 5 assumed the Arc case disappears
because "20 sessions now go through paste". It does not. The routing rules send text to the
paste tier on length, or on the xterm.js signature (`kAXSelectedText` not settable *and*
`kAXNumberOfCharacters == 0`). Arc reports `settable: true`, so it never matches the signature —
and our own median transcript is 109 characters, under the 120-unit length threshold. **Roughly
half of Arc's dictations still take the AX tier**, and deleting the caret read-back would
restore the 2026-08-09 silent data-loss bug for them. Keeping it costs 402 lines against a
deletion target. Restoring silent data loss costs a dictation the user never learns was lost.
That asymmetry decides it, the same way it decided `AXSelectedTextGate`.

**New fact 1 — promised pasteboard data *is* serviced in a process with no `NSApplication`.**
This was an unexamined assumption and the whole design rests on it: every implementation of the
technique that could be read (Handy, VoiceInk, FluidVoice) is a full app bundle, while our
helper is a command-line tool running a bare `CFRunLoop`. Measured with
`--probe-paste --route none` and a `pbpaste` from another shell — the promise resolved to the
right string and `pasteboard:provideDataForType:` fired on the main run loop 1,942 ms later,
i.e. when the reader asked and not before. `changeCount` was unchanged by the read (107 → 107),
which is what makes it usable as an ownership token.

**New fact 2 — `clearContents()` fires `pasteboardChangedOwner:` on the process that calls
it.** Our own settle looks exactly like the user copying something else. Anything that treats
ownership-lost as "abandon the transaction" therefore has to ignore the event once it has
settled, or the settle path runs twice on every successful paste. This is why
`PasteTransaction` carries an explicit `settled` flag instead of deriving settlement from its
inputs.

**9.6 What I would not do.** Input Method Kit is the technically cleanest insertion channel
on macOS — it bypasses key-event handling entirely and needs no Accessibility grant — but it
requires the user to *select* our input source, so we would have to switch input sources
around every dictation, tearing down and rebuilding an `IMKInputController` each time. It is
a research direction, not a plan.

---

## 10. A staged plan

Each stage is independently shippable and independently revertible.

1. **Measure (§9.5).** Half an hour with `--probe-insert` and `--probe-ax`. No code changes.
   *Done when:* the four questions have answers written into this file.
2. **Land the paste tier behind `GROK_DICTATE_PASTE=1`**, off by default, routed by length
   only. Restore via option (a). *Done when:* a 2,000-character dictation into cmux lands in
   under 150 ms and the log shows a receipt.
3. **Flip the default and add the Settings control** ("Insert text by: Typing / Pasting /
   Auto", plus a per-app override list). Update `README.md` and contract §5 in the same
   commit as the behaviour change, not after. *Done when:* a week of real use shows no
   `tier: none` rows and no restore-race reports.
4. **Delete §8 rows 1–4.** *Done when:* `swift test` and `npm test` pass with the files gone.
5. **Decide row 5 on the Arc evidence.**

---

## 11. Two smaller findings, unrelated to the mechanism

- **`docs/ARCHITECTURE.md` lines 52–54 are stale.** They say "The frontmost app is
  snapshotted at key-down; if focus moved during processing, the transcript is kept and
  offered for re-insert instead of being typed into the wrong window." `machine.ts:659` passes
  `targetBundleId: null` on every insert, which disables that check — deliberately, at your
  direction after Phase 5 HT-4, and `beginInsert`'s doc comment explains it well. The
  architecture doc never caught up.
- **`InsertionLadder.swift`, `AXInserter.swift` and several others cite documents that are
  not in this repository** — `IMPLEMENTATION-PLAN.md`, `docs/phase-2-report.md`,
  `docs/phase-3-report.md`, `braindump`. They exist in the `Grok_STT-injection-pacing`
  worktree and are indexed in SecondBrain, which is how the measurements in §1–2 above were
  recovered, but a reader of this repo alone cannot follow any of those references.

---

## 12. Sources

Primary source read directly:

- Handy, `src-tauri/src/paste_tx/mod.rs` and `paste_tx/macos.rs` — [github.com/cjpais/Handy](https://github.com/cjpais/Handy)
- VoiceInk, `VoiceInk/Infrastructure/SystemIntegration/Paste/CursorPaster.swift` and `ClipboardManager.swift` — [github.com/Beingpax/VoiceInk](https://github.com/beingpax/VoiceInk)
- FluidVoice, `Sources/Fluid/Services/TypingService.swift` — [github.com/altic-dev/FluidVoice](https://github.com/altic-dev/FluidVoice)

Documentation and reports:

- [Espanso — configuration options](https://espanso.org/docs/configuration/options/) and [matches basics](https://espanso.org/docs/matches/basics/)
- [Espanso discussion #1226 — restoring image and file clipboard contents](https://github.com/espanso/espanso/discussions/1226)
- [stablyai/orca #6513 — synthesized/dictated text dropped when the kitty keyboard protocol is active](https://github.com/stablyai/orca/issues/6513)
- [Quicksilver PR #1536 — `CGEventKeyboardSetUnicodeString` truncates after 20 characters](https://github.com/quicksilver/Quicksilver/pull/1536)
- [Qt Forum — CGEventKeyboardSetUnicodeString will only process up to 20 characters](https://forum.qt.io/topic/46579/cgeventkeyboardsetunicodestring-will-only-process-up-to-20-characters)
- [CoreGraphics `CGEvent.h` — "application frameworks may ignore the Unicode string"](https://github.com/phracker/MacOSX-SDKs/blob/master/MacOSX10.9.sdk/System/Library/Frameworks/CoreGraphics.framework/Versions/A/Headers/CGEvent.h)
- [NSPasteboard.org — transient / concealed / auto-generated marker types](https://nspasteboard.org/)
- [Michael Tsai — Pasteboard Privacy Preview in macOS 15.4](https://mjtsai.com/blog/2025/05/12/pasteboard-privacy-preview-in-macos-15-4/) and [macOS 26.4 Paste Protection](https://mjtsai.com/blog/2026/04/03/macos-26-4-paste-protection/)
- [Lapcat Software — Making my app worse because of macOS privacy protections](https://lapcatsoftware.com/articles/2025/5/3.html)
- [feedback-assistant #655 — NSPasteboard needs a way to request full access](https://github.com/feedback-assistant/reports/issues/655)
- [Wispr Flow — permissions](https://docs.wisprflow.ai/articles/5510622673-re-verify-wispr-flow-permissions-after-updating) and [terminal applications](https://docs.wisprflow.ai/articles/6478598909-using-flow-with-linux-wsl-and-terminal-applications)
- [VoiceInk — clipboard issues](https://tryvoiceink.com/docs/clipboard-issues)
- [Bracketed paste mode](https://cirw.in/blog/bracketed-paste) and [xterm's bracketed-paste documentation](https://invisible-island.net/xterm/xterm-paste64.html)
- [macOS Input Method Development Guidelines for 2026](https://shikisuen.medium.com/macos-input-method-development-guidelines-for-2026-5123461fa53b)

Internal, via SecondBrain (the `Grok_STT-injection-pacing` worktree, not in this repo):
`docs/phase-2-report.md` §3–4, `docs/bug-report-2026-08-09-no-paste.md` BUG-1.

Field data: `~/Library/Application Support/grok-dictate/history.json` (240 rows) and
`~/Library/Logs/grok-dictate/main.log` (6,307 lines), both as of 2026-09-06 12:50 UTC.

---

## 13. What shipped

Written 2026-09-06, after the work. Branch `feat/paste-tier`, worktree
`Grok_STT-paste-tier`. The full account is in
`docs/report-paste-tier-2026-09-06.md`; this is the diff against what §7–§10
proposed, so that a reader of the analysis knows where it was followed and where
it was not.

**Followed.** The receipt-sequenced paste tier of §7.1, the routing rules of §7.3
(user override, 120-unit length threshold, the xterm.js signature, no bundle-id
table), option **(a)** of §7.2 — clear, never restore, never read — and the
deletions in §8 rows 1–4. `insertMethod` is one user-visible setting where seven
environment knobs used to be. `TextChunker` went 20 → 200 on §9.5 Q3.

**Departed from, and why.**

- **§8 row 5 — `AXWriteVerification` is kept.** The row assumed Arc's 20 sessions
  move to the paste tier. They do not: Arc reports `kAXSelectedText` as settable
  so it never matches the xterm.js signature, and the median transcript is 109
  characters, under the length threshold. Roughly half of Arc's dictations still
  take the AX tier, and deleting the caret read-back would restore the
  2026-08-09 silent data-loss bug for them. See §9.5 Q4.
- **The line count.** §8 projected −1,539 against +250. The real Swift figure is
  roughly **−1,000 removed against +1,500 added**, a net *increase*. Three
  reasons, none of them the plan being wrong about what to delete: row 5 was
  kept (−402 not taken); the two new probes and the shared modifier wait are
  ~360 lines the estimate did not budget for at all; and the +250 was
  benchmarked against Handy's ~380 lines of Rust, in a codebase whose comment
  density is a fraction of this one's. The three new decision files are 55–70 %
  comment by line. `docs/report-paste-tier-2026-09-06.md` §4 has the breakdown.
- **The staging of §10 was collapsed.** Stages 2 and 3 — land behind
  `GROK_DICTATE_PASTE=1`, then flip the default — became one pass, on the user's
  instruction of 2026-09-06. There is no flag; the setting is the escape hatch.

**Still open, and both are in §9.5.** Whether a ⌘V posted with
`CGEvent.postToPid` reaches an Electron terminal (Q1), and whether macOS 26's
Terminal paste-protection dialog fires for us (Q2). Neither can be answered from
this machine's shell, because posting a chord needs an Accessibility grant the
launching terminal does not hold. `--probe-paste` answers both in one run from a
terminal that does.
