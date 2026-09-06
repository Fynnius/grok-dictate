# Contract — Helper protocol

**Status: frozen at the end of Phase 1, reopened by Phase 5, reopened again for BUG-1, reopened 2026-08-22 for mute commands** (IMPLEMENTATION-PLAN.md §2). Phases 2–4 built against it exactly and requested no change to it. Two changes have been made since to `insert_result`: Phase 5 added `reason`, and BUG-1 added `verified` and the `verification_failed` decline. Both are additive and `nullish`, so an older build on either side of the wire keeps parsing.

**2026-08-22** added `mute_output` and `unmute_output`. Fire-and-forget, like `copy`. An older helper ignores them under §1 rule 2.

**2026-09-06 reopened it for the paste tier**, and this one is not additive in spirit even though it is on the wire. `insert` gains `route`, `insert_result` gains the `paste` tier, `ready.caps` gains `paste` — all optional or enum extensions, so an older build on either side still parses — but §5.1 repeals the rule that the clipboard is never written automatically. Read that section before changing anything here.

Machine-readable form: [`helper-protocol.ts`](./helper-protocol.ts). Where the two disagree, the `.ts` file wins — it is what the code parses with.

---

## 1. Transport

Newline-delimited JSON over the Swift helper's **stdin** (app → helper) and **stdout** (helper → app). One frame per line, UTF-8.

- Every frame carries `"v": 1`. A frame with a different `v` is rejected, not coerced.
- `stderr` is **not** protocol. It is captured and logged as helper diagnostics. Anything the helper wants the app to act on goes over stdout as a `log` frame.
- Frames may contain newlines _inside string values_ — transcripts routinely do. `JSON.stringify` escapes them to `\n`, so a frame can never span lines. All framing rests on this.
- Order is preserved in both directions. There is no interleaving and no partial frame: a reader must buffer until it sees `\n`.

### Robustness rules — both directions

1. **A malformed line must never crash either side.** It is logged and skipped. (IMPLEMENTATION-PLAN.md §3.2; is a catalogue of silent breakage, and a parser that throws turns a bad byte into a dead hotkey.)
2. **Unknown `type` values must be ignored, not fatal.** This is the forward-compatibility seam: a newer helper talking to an older app degrades instead of dying.
3. **Unknown _fields_ on a known type must be ignored.** records exactly this bug on the other side of the wire — the Grok CLI's `serde` struct silently drops fields `transcript.partial` may carry. Do not repeat it here; if you need a field, add it to this contract.
4. The helper must not write anything to stdout that is not a frame. No banners, no progress output.

---

## 2. Helper → App

### `ready`

```jsonc
{ "v": 1, "type": "ready", "version": "0.1.0", "caps": ["paste", "ax", "unicode"] }
```

First frame after start-up. `caps` lists the insertion tiers this build can actually attempt. The app does not send commands before `ready`. A helper that omits `paste` predates 2026-09-06 and will ignore `insert.route`; that is the difference between "the helper chose not to paste" and "this build cannot".

### `hotkey`

```jsonc
{ "v": 1, "type": "hotkey", "action": "ptt_down", "ts": 1754683200000 }
```

| `action`       | Source                                                           | Meaning                                                              |
| -------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------- |
| `ptt_down`     | `kCGEventFlagMaskSecondaryFn` **set** in a `.flagsChanged` event | Fn pressed — start recording                                         |
| `ptt_up`       | that flag **cleared**                                            | Fn released — end the turn                                           |
| `toggle`       | Space `keyDown` carrying the SecondaryFn flag                    | Hands-free start/stop                                                |
| `retry_insert` | `Ctrl+Cmd+V`                                                     | Re-run the insertion ladder against the transcript already in memory |

`ts` is milliseconds since the Unix epoch from the helper's clock. Same machine as the app, so no skew correction; it exists to measure hold duration.

**`retry_insert` is not a paste.** It re-invokes insertion against `lastTranscript` held in the app's memory. The clipboard is not read and not written.

**Fn/Fn+Space disambiguation is the app's problem, not the helper's.** The helper reports both `ptt_down` and a subsequent `toggle` verbatim. : the mic opens immediately on `ptt_down` and the WebSocket handshake window doubles as the disambiguation window — a timer before opening the mic would clip the first word.

### `secure_input`

```jsonc
{ "v": 1, "type": "secure_input", "enabled": true }
```

Emitted **on change only**, plus once shortly after `ready` to establish the initial value. Sourced from `IsSecureEventInputEnabled()` on a timer.

While `enabled` is true no third-party process can install a `CGEventTap`, so the hotkey is dead system-wide. This frame is the _only_ thing that turns that into a visible state instead of "the app is broken" (§12.2).

### `frontmost`

```jsonc
{"v":1,"type":"frontmost","bundleId":"com.microsoft.VSCode","name":"Code"}
{"v":1,"type":"frontmost","bundleId":"com.microsoft.VSCode","name":"Code","id":"<uuid>"}
```

Two forms:

- **unsolicited** — pushed when the frontmost application changes;
- **reply** — carries the `id` of the `get_frontmost` it answers.

`bundleId` and `name` are `null` when no application owns the menu bar.

> **Addition to the plan's sketch.** IMPLEMENTATION-PLAN.md §3.1.2 shows `frontmost` with no `id` while `get_frontmost` carries one, which leaves a reply uncorrelatable. requires capturing the frontmost app at `ptt_down` and verifying it before inserting, and that needs request/response correlation. The optional `id` is a strict superset: the unsolicited form is exactly as the plan wrote it.

### `permissions`

```jsonc
{ "v": 1, "type": "permissions", "accessibility": true, "hotkeyActive": true }
```

Emitted once the tap install has been attempted, and again whenever either
answer changes. **A Phase 5 addition, and it closes the application's own
instance of ** Until it existed the tray said "Ready" while the
event tap had failed to install and the `Fn` key was dead — the product looked
healthy and did nothing, in the one surface built to prevent exactly that. It
was hit on the first launch of the packaged app, where a fresh TCC identity
means Accessibility starts ungranted (docs/phase-2-report.md §4, HT-1).

`ready` cannot carry this: §2 requires `ready` to be the first frame out, and
the tap install happens after it — deliberately, so a tap failure is reported
rather than fatal.

| Field           | Means                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `accessibility` | `AXIsProcessTrusted()`. Gates both the tap and the AX insertion tier.                                                                                                    |
| `hotkeyActive`  | A `CGEventTap` is installed **and enabled right now** — the honest question, since Secure Input tears the tap down system-wide while Accessibility stays granted (§4.6). |

The helper also **retries the tap** on the same poll: granting Accessibility to
a running app is enough, with no restart.

### `insert_result`

```jsonc
{
  "v": 1,
  "type": "insert_result",
  "id": "<uuid>",
  "tier": "ax",
  "ok": true,
  "verified": true,
  "error": null,
  "reason": null,
}
```

Answers exactly one `insert`, echoing its `id`.

#### `verified` — did the text actually arrive?

**A BUG-1 addition, and the second change made to this contract after Phase 1.**

| `verified`      | Means                                                                                                                                                      |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `true`          | The helper **confirmed** the text landed — `paste`: a consumer read the promise after our chord; `ax`: the caret moved; `unicode`: the target's text grew. |
| `false`         | Verification ran and **proved nothing landed**. Always accompanied by `ok:false` and `reason:"verification_failed"`.                                       |
| `null` / absent | Verification was not possible for this target, or the frame came from an older helper build.                                                               |

> **The paste tier made this a stronger claim, 2026-09-06.** Every earlier `true` was an inference from a side effect the helper measured itself — a caret position, a text length — in a target that might expose neither. In `cmux`, where 59 % of dictations land, `kAXNumberOfCharacters` is permanently `0` and neither verifier could say anything at all. A receipt is the operating system reporting that the target _asked us for the text_. It is still not proof the text was kept: a target that reads and then discards produces a receipt too. Strictly better than what it replaces, not a guarantee.

The invariant on the wire: **`ok:true` with `verified` not `true` means "typed, unconfirmed"**. History records that; the HUD draws the same green check as a confirmed insert. A paragraph overlay for the unconfirmed case was not wanted. It is optional on the wire for the same backward-compatibility reason as `reason`; this helper always sends the key, using `null` for "not possible", because "this build cannot tell you" and "this target cannot be measured" are the same claim from the app's side. The Unicode tier no longer checks anything: it always reports `verified: null`, and the length check that used to produce `true` and `false` there was deleted on 2026-09-06 after 7 false alarms and 0 true positives (§3).

> **Why it exists.** 2026-08-09: a 60.3 s hands-free dictation into `cmux` (Electron + xterm.js). The ladder correctly refused the AX tier — a terminal reports `kAXSelectedTextAttribute` as not settable — and the Unicode tier posted 760 UTF-16 units as **38 synthetic key events inside ~245 ms**. cmux dropped the burst. `CGEvent.post` has no return channel, so the tier reported "posted", the ladder mapped that to `ok:true`, the HUD showed a green "Inserted" pill, no error cue played, and history recorded `inserted:true`. The user lost a minute of dictation and recovered it by hand through History → Copy. Three earlier insertions into the same application that day — 42, 49 and 79 units — had landed, which is why nothing looked wrong until it was.

`reason` is a **Phase 5 addition** and the first of the two changes made to this contract after Phase 1. `error` is prose written for a human, so the app had no way to distinguish "focus moved to another application" from "neither tier worked" — and showed the wrong, unactionable advice for exactly the case exists to handle. `NotInsertedReason.target_changed` had sat in `contracts/events.ts` since Phase 1 with nothing anywhere able to produce it.

| `reason`              | Means                                                                                                                         |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `target_changed`      | The frontmost app is no longer `targetBundleId`.                                                                              |
| `empty_text`          | There was nothing to insert.                                                                                                  |
| `no_tier`             | AX declined and Unicode injection failed.                                                                                     |
| `verification_failed` | Unicode events were posted but the target's text did not change. Sent with `ok:false`, `verified:false` and `tier:"unicode"`. |
| `null` / absent       | Success, or a failure the helper did not classify.                                                                            |

`verification_failed` keeps `tier:"unicode"` rather than falling back to `"none"`: the events really were posted, so this is not the "nothing was attempted" case — something may yet be on screen, and `none`'s promise that the clipboard was not touched is not the claim being made here. `ok:false` is, and it is what fires the app's not-inserted HUD, its error cue and its re-insert path.

It is optional on the wire (`nullish`), so an older helper binary still parses; the app treats an absent value as "not stated" and falls back to its own knowledge of the request.

`frontmostBundleId` / `frontmostName` are the application the ladder actually acted on, and are also a Phase 5 addition. They exist because the app stopped sending `targetBundleId` — the text now goes wherever the user is pointing when the turn ends (`state-machine.md` §6), so the app no longer knows which application received it, and a history row built from the press-time value would name the wrong one. Both are `nullish` for the same backward-compatibility reason, and are `null` when the ladder declined before resolving the frontmost app.

| `tier`    | Means                                                                                                                                                                                                                                                                                                  |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paste`   | The transcript was promised on the pasteboard and a synthetic ⌘V was posted, **and a consumer read the promise afterwards** — see §3. Always `verified:true`: a paste with no receipt is not reported, it falls through to injection.                                                                  |
| `ax`      | Handled by `AXUIElementSetAttributeValue` on `kAXSelectedTextAttribute`, **and confirmed by reading the caret back** — see §3. Reports `verified:true`; `verified:null` only when `GROK_DICTATE_AX_VERIFY=0` turned the read-back off.                                                                 |
| `unicode` | Handled by `CGEventKeyboardSetUnicodeString`. Posting proves nothing and this tier claims nothing: always `ok:true, verified:null` — "typed, unconfirmed" in history, and the same green check in the HUD. The length check that used to answer `true` or `false` here was deleted on 2026-09-06 (§3). |
| `none`    | No tier would take it. `ok` is `false`. Nothing is left on the pasteboard — a paste that was attempted and produced no receipt still settles before the ladder gives up.                                                                                                                               |

`error` carries real diagnostic text — for the `ax` tier, the actual `AXError` value, which is what settles

### `log`

```jsonc
{
  "v": 1,
  "type": "log",
  "level": "warn",
  "msg": "event tap re-armed after kCGEventTapDisabledByTimeout",
}
```

Helper diagnostics, merged into the app's log stream under scope `helper`. Passes through the app's redaction layer like everything else.

---

## 3. App → Helper

### `insert`

```jsonc
{
  "v": 1,
  "type": "insert",
  "id": "<uuid>",
  "text": "…",
  "targetBundleId": "com.microsoft.VSCode",
  "route": "auto",
}
```

Run the insertion ladder. `id` must be unique per request; the helper answers with exactly one `insert_result` carrying the same `id`.

`targetBundleId` names an app the caller requires to still be frontmost. If it does not match, the helper must **decline** with `tier:"none"`, `ok:false`, `reason:"target_changed"` and an explanatory `error` rather than inserting into whatever is in front now. `null` disables the check.

> **The app always sends `null` as of Phase 5.** The user asked for dictation that starts in one window and lands in whichever one they are pointing at when they stop (`state-machine.md` §6), so the check is off in the product. The helper keeps implementing it: `--probe-insert` exercises it, and re-enabling is one line in `beginInsert`.

`route` is `"auto"`, `"paste"` or `"type"`, and it carries `AppConfig.insertMethod` verbatim. **The app sends policy; the helper decides.** Only the helper can see the focused element's AX signature and the target's pid, so only it can tell an xterm.js terminal from a text field — but the preference is the user's and lives in `config.json`, which the helper cannot read. Optional on the wire, defaulting to `"auto"`, so an older app still parses.

**The ladder, in order:**

0. **Route** — `paste` or `type` from the request wins outright. Under `auto` the helper pastes when the text is longer than 120 UTF-16 units, or when the focused element has the xterm.js signature (`kAXSelectedTextAttribute` not settable **and** `kAXNumberOfCharacters == 0`), and types otherwise. There is deliberately **no bundle-id table**: a list of the applications somebody happened to test is exactly what `AXSelectedTextGate` argues against, and the argument has not changed.

1. **Paste** _(paste route only)_ — publish the transcript as a **promise** on the general pasteboard: `declareTypes:owner:` with `public.utf8-plain-text`, `org.nspasteboard.TransientType`, `org.nspasteboard.AutoGeneratedType` and a private session type, and **no data behind any of them**. Record the `changeCount`. Post ⌘V. When AppKit calls `pasteboard:provideDataForType:` for the text type, hand over the transcript — **that callback is the read receipt.** Settle by `clearContents()` once the receipts have been quiet for 200 ms, and only while the `changeCount` still matches. A paste with no receipt inside 8 s falls through to Unicode injection; **a paste with a receipt never does**, because falling through after a landed paste double-types the transcript. `native/Sources/HelperCore/PasteTransaction.swift` owns every one of those decisions as a pure function, and §5 records why writing the pasteboard became allowed at all.

   > The AX tier is **skipped entirely** on the paste route. In a terminal we already know it declines, and the settable check costs an AX round trip for an answer we have.

2. **AX** _(type route only)_ — `AXUIElementCreateApplication(pid)` → `kAXFocusedUIElementAttribute` → set `kAXSelectedTextAttribute`, having first confirmed the attribute is settable **and that `kAXSelectedTextRange` can be read**, then confirmed after the write that the caret moved. Report the real `AXError`.

   > Two corrections from Phase 2's human tests, both of which this sketch got wrong. `AXUIElementCreateSystemWide()` — what IMPLEMENTATION-PLAN.md §3.2 and this contract originally named — returns `kAXErrorCannotComplete` universally on macOS 26; the application element works. And a terminal emulator reports `kAXSelectedTextAttribute` as **not settable**, then returns `kAXErrorSuccess` from the write while inserting nothing, so the settable check is what stops the ladder trusting a tier that lied (docs/phase-2-report.md §3).

   > **A third, from Phase 5: the `AXError` is not evidence.** Arc's web content (`company.thebrowser.Browser`) reports the attribute as settable, returns `kAXErrorSuccess`, and discards the write — 13.8 s of dictation, an 11 ms insert, a green "Inserted" pill and nothing on screen. So the tier now reads `kAXSelectedTextRange` immediately before and immediately after the write and requires the caret to have moved forward. If it did not move, or if either read fails, the tier **declines** and the ladder falls through to Unicode injection: a false decline costs ~140 ms, a missed lie costs the user their words. The before-read happens before the write, so an element that cannot be verified is never written to and the fall-through cannot duplicate text. `native/Sources/HelperCore/AXWriteVerification.swift` carries the reasoning; `--probe-ax` prints every input to the decision for any app you point it at.

3. **Unicode injection** — `CGEventKeyboardSetUnicodeString`, chunked at 200 UTF-16 units, posted back to back.

   > **The chunk size was 20 until 2026-09-06, and it was folklore.** The number came from 2015-era reports against Quicksilver and Qt that the call truncates. `--probe-chunk` sets N units on a real event and reads them back: no truncation at 20, 200, 1,000 or 2,000 on macOS 26.6. 200 is FluidVoice's value and gives 10× fewer events for the same text. Measured for the API, **not** for any particular target — whether an application accepts a 200-unit event is a different question, The knob that used to sweep it without a rebuild went with the rest of the August measurement scaffolding, so re-measuring means changing `TextChunker.defaultMaxUTF16Units` and rebuilding. Grapheme-safe splitting is unchanged.
   >
   > **The pacing rule is gone, and so is length verification.** Both were BUG-1 fixes against the wrong diagnosis. The 2026-08-09 cmux drop was not a rate problem: xterm.js with the kitty keyboard protocol calls `preventDefault()` on the synthetic keydown, which cancels Chromium's native `insertText` before the glyph reaches the PTY — protocol-level interception that no amount of spacing addresses. The pacing rule taxed 39 % of dictations at ~0.9 ms/character and fixed nothing. The length check shipped **off** after producing 7 false "not inserted" alarms and 0 true positives, because `kAXNumberOfCharacters` is permanently `0` in the application the incident happened in. The paste tier bypasses the keydown path entirely and comes with a receipt; that is the actual fix. `docs/report-insertion-2026-09-06.md` §3 has the evidence.

4. **Nothing worked** → `tier:"none"`, `ok:false`. If a paste was attempted on the way here it has already settled, so nothing is left on the pasteboard.

### `copy`

```jsonc
{ "v": 1, "type": "copy", "text": "…" }
```

**The only pasteboard write a user asks for directly**, and it is only ever sent in response to a click on _Copy_ in the HUD or history. It writes plain text with no marker types, so clipboard managers record it the way they record any ⌘C — the opposite of what the paste tier wants, and deliberately so.

Until 2026-09-06 this was the only pasteboard write of any kind; §5.1 records why that changed and what replaced the rule. The containment that survives is still asserted by test from both sides: this is the only path from a user action to the pasteboard, and the paste tier is the only other way to reach it.

No reply frame.

### `get_frontmost`

```jsonc
{ "v": 1, "type": "get_frontmost", "id": "<uuid>" }
```

Answered by one `frontmost` frame echoing `id`.

### `set_hotkeys`

```jsonc
{ "v": 1, "type": "set_hotkeys", "ptt": "fn", "toggle": "fn+space", "retry": "ctrl+cmd+v" }
```

Sent once after `ready` and again whenever settings change. Values are lower-case, `+`-separated tokens. v1 recognises exactly `fn`, `fn+space` and `ctrl+cmd+v`; an unrecognised binding must be reported via `log` at `warn` and the previous binding kept, never silently ignored.

### `shutdown`

```jsonc
{ "v": 1, "type": "shutdown" }
```

Remove the event tap, restore output if this process muted it, flush stdout, exit 0. The app waits briefly, then sends `SIGTERM`, then `SIGKILL`.

### `mute_output`

```jsonc
{ "v": 1, "type": "mute_output" }
```

Mute the default output device. **Added 2026-08-22.** Fire-and-forget, no reply — the same shape as `copy`. Prefer the device's hardware mute over volume-to-zero. Snapshot what changed (device UID, mute-vs-volume, previous value) so restore can refuse to clobber a user who unmuted or moved the volume themselves.

Must not delay capture: the app sends this _after_ the microphone is opening and _after_ the start cue has been asked to play.

### `unmute_output`

```jsonc
{ "v": 1, "type": "unmute_output" }
```

Restore output after `mute_output`. Idempotent: a helper that did not mute, whose snapshot no longer matches the live device, or whose lock file is absent is a no-op. Sent on every session exit (release, Esc, error, timeout, supersede, quit) and defensively when the app starts, in case the previous helper died muted.

Signal handlers and process-exit restore the same snapshot; a lock file on disk is the belt for `SIGKILL`.

---

## 4. Lifecycle

```
app spawns helper
      │
      ├──────────────── helper: {"type":"ready"} ────────────────▶
      │
      ◀── {"type":"set_hotkeys"} ──
      │
      ├── {"type":"secure_input","enabled":false} ──▶     (initial value)
      │
      ├── {"type":"hotkey","action":"ptt_down"} ────▶
      ◀── {"type":"get_frontmost","id":"a"} ──
      ├── {"type":"frontmost",…,"id":"a"} ──────────▶
      ├── {"type":"hotkey","action":"ptt_up"} ──────▶
      ◀── {"type":"insert","id":"b",…} ──
      ├── {"type":"insert_result","id":"b",…} ──────▶
```

**Death and restart.** If the helper exits for any reason the app restarts it with exponential backoff, then re-sends `set_hotkeys`. An `insert` in flight when the helper dies is reported to the app as a synthetic failure — the transcript is kept and the HUD shows the "not inserted" state, so nothing is lost. Requests are never silently dropped.

---

## 5. What this contract deliberately does not do

- **No content-length framing.** floats LSP-style headers if the helper grows. Bare NDJSON is enough at this size and is trivially debuggable by eye; revisit only if binary payloads appear.
- **No streaming insert.** Text goes over in one frame. Chunking is the helper's internal concern.
- **No clipboard read.** Nothing in this protocol can read the pasteboard, by design. See below — this rule survived the 2026-09-06 change and is now the _only_ pasteboard rule, which makes it load-bearing in a way it was not before.
- **No token, ever.** The helper has no need for the bearer and must never be sent it.

### 5.1 The repeal — the clipboard, 2026-09-06

**The rule that used to be here:**

> **The clipboard is never written automatically.** The `copy` command is the only frame that may write to the pasteboard, and it is only ever sent in response to an explicit user click. FluidVoice's fastest insertion path is a clipboard paste. **You may not adopt it.** If you find yourself wanting to, you have misread the product.

**Why it existed.** It came from the user directly, in the design conversation that produced this app: _"Is that the idea because I like that more instead of it automatically pasting into my clipboard? I don't want that."_ The clipboard tier was dropped from the ladder before a line of it was written. Containment was made checkable rather than promised — `NSPasteboard` reachable from one file, wired to one command, with a source scan and a behavioural spy asserting it from both the Swift package and `npm test`.

**What replaced it.** The paste tier described in §3, on the user's explicit instruction of 2026-09-06, with the evidence in `docs/report-insertion-2026-09-06.md`. The three facts that changed the answer:

- The tier the rule protected has **never run**. Across 240 real dictations the AX tier fired zero times; 239 went through Unicode injection.
- Injection is O(n): 1,785 ms for a 2,000-character transcript, and 39 % of dictations are long enough to be paced.
- In the application where 59 % of dictations land, injection is defeated by a mechanism spacing cannot fix. A paste is O(1), gets bracketed paste, and is the only route macOS gives a read receipt for.

**What answers the original objection.** The objection was to the transcript _lingering_ on the clipboard, and the design answers it rather than overriding it: the transcript is never resident as plain data (it is a promise until someone asks), it carries the markers that tell clipboard managers to skip it, and it is gone within ~200 ms of the target reading it. Under `insertMethod: "type"` the pasteboard is not touched at all, which is exactly the old behaviour, one setting away.

**What was given up, stated plainly.** Two things.

1. **The user's previous clipboard is destroyed on every pasted dictation, and is not restored.** That is deliberate, not an omission. Restoring means first _reading_ what was there, and reading is the operation macOS 15.4 previewed a permission prompt for and macOS 26 carries — no "always allow", no explanation string. Writing never prompts. A design that only ever writes is immune to that permanently; VoiceInk's and Handy's snapshot-and-restore are on a clock. The cost is real and lands on the user, not on us.
2. **The absolute guarantee is gone.** "Never written" is checkable by scanning for a symbol. "Written only in these two ways, never read, always settled" needs three assertions and a behavioural test to hold it up (`ClipboardDisciplineTests`). A weaker invariant defended by more machinery is a worse kind of promise, and it is the price of the change.

The replacement rule, in full: **the pasteboard is written, never read.** No `pasteboardItems`, no `string(forType:)`, no `data(forType:)`, no `readObjects(forClasses:)`, anywhere in `native/`. Every write carries the transient markers. Every publish is followed by exactly one settle, on every branch including the failing ones.
