# Contract — Helper protocol

**Status: frozen at the end of Phase 1, reopened by Phase 5** (IMPLEMENTATION-PLAN.md §2). Phases 2–4 built against it exactly and requested no change to it; Phase 5 made one, described under `insert_result`.

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
{ "v": 1, "type": "ready", "version": "0.1.0", "caps": ["ax", "unicode"] }
```

First frame after start-up. `caps` lists the insertion tiers this build can actually attempt. The app does not send commands before `ready`.

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
  "error": null,
  "reason": null,
}
```

Answers exactly one `insert`, echoing its `id`.

`reason` is a **Phase 5 addition** and the one change made to this contract after Phase 1. `error` is prose written for a human, so the app had no way to distinguish "focus moved to another application" from "neither tier worked" — and showed the wrong, unactionable advice for exactly the case exists to handle. `NotInsertedReason.target_changed` had sat in `contracts/events.ts` since Phase 1 with nothing anywhere able to produce it.

| `reason`         | Means                                              |
| ---------------- | -------------------------------------------------- |
| `target_changed` | The frontmost app is no longer `targetBundleId`.   |
| `empty_text`     | There was nothing to insert.                       |
| `no_tier`        | AX declined and Unicode injection failed.          |
| `null` / absent  | Success, or a failure the helper did not classify. |

It is optional on the wire (`nullish`), so an older helper binary still parses; the app treats an absent value as "not stated" and falls back to its own knowledge of the request.

`frontmostBundleId` / `frontmostName` are the application the ladder actually acted on, and are also a Phase 5 addition. They exist because the app stopped sending `targetBundleId` — the text now goes wherever the user is pointing when the turn ends (`state-machine.md` §6), so the app no longer knows which application received it, and a history row built from the press-time value would name the wrong one. Both are `nullish` for the same backward-compatibility reason, and are `null` when the ladder declined before resolving the frontmost app.

| `tier`    | Means                                                                                                                                                                                                                  |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ax`      | Handled by `AXUIElementSetAttributeValue` on `kAXSelectedTextAttribute`, **and confirmed by reading the caret back** — see §3. Still the only tier whose `ok` is trustworthy, but no longer because of the error code. |
| `unicode` | Handled by `CGEventKeyboardSetUnicodeString`. `ok:true` means _the events were posted_, not that the characters landed. It can half-succeed silently — which is why the HUD shows the full transcript.                 |
| `none`    | Neither tier would take it. `ok` is `false`. **The clipboard has not been touched.**                                                                                                                                   |

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
{ "v": 1, "type": "insert", "id": "<uuid>", "text": "…", "targetBundleId": "com.microsoft.VSCode" }
```

Run the insertion ladder. `id` must be unique per request; the helper answers with exactly one `insert_result` carrying the same `id`.

`targetBundleId` names an app the caller requires to still be frontmost. If it does not match, the helper must **decline** with `tier:"none"`, `ok:false`, `reason:"target_changed"` and an explanatory `error` rather than inserting into whatever is in front now. `null` disables the check.

> **The app always sends `null` as of Phase 5.** The user asked for dictation that starts in one window and lands in whichever one they are pointing at when they stop (`state-machine.md` §6), so the check is off in the product. The helper keeps implementing it: `--probe-insert` exercises it, and re-enabling is one line in `beginInsert`.

**The ladder, in order:**

1. **AX** — `AXUIElementCreateApplication(pid)` → `kAXFocusedUIElementAttribute` → set `kAXSelectedTextAttribute`, having first confirmed the attribute is settable **and that `kAXSelectedTextRange` can be read**, then confirmed after the write that the caret moved. Report the real `AXError`.

   > Two corrections from Phase 2's human tests, both of which this sketch got wrong. `AXUIElementCreateSystemWide()` — what IMPLEMENTATION-PLAN.md §3.2 and this contract originally named — returns `kAXErrorCannotComplete` universally on macOS 26; the application element works. And a terminal emulator reports `kAXSelectedTextAttribute` as **not settable**, then returns `kAXErrorSuccess` from the write while inserting nothing, so the settable check is what stops the ladder trusting a tier that lied (docs/phase-2-report.md §3).

   > **A third, from Phase 5: the `AXError` is not evidence.** Arc's web content (`company.thebrowser.Browser`) reports the attribute as settable, returns `kAXErrorSuccess`, and discards the write — 13.8 s of dictation, an 11 ms insert, a green "Inserted" pill and nothing on screen. So the tier now reads `kAXSelectedTextRange` immediately before and immediately after the write and requires the caret to have moved forward. If it did not move, or if either read fails, the tier **declines** and the ladder falls through to Unicode injection: a false decline costs ~140 ms, a missed lie costs the user their words. The before-read happens before the write, so an element that cannot be verified is never written to and the fall-through cannot duplicate text. `native/Sources/HelperCore/AXWriteVerification.swift` carries the reasoning; `--probe-ax` prints every input to the decision for any app you point it at.

2. **Unicode injection** — `CGEventKeyboardSetUnicodeString`, chunked at ~20 UTF-16 units with a tuned inter-chunk delay.
3. **Neither** → `tier:"none"`, `ok:false`. **Do not touch the clipboard.**

### `copy`

```jsonc
{ "v": 1, "type": "copy", "text": "…" }
```

**The only frame in this protocol that may write to the pasteboard, and it is only ever sent in response to an explicit user click** — the _Copy_ button in the HUD or history. This is a hard product requirement, it is on Phase 5's audit list (§5b), and Phase 2 must prove by test that no insertion path writes the clipboard.

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

Remove the event tap, flush stdout, exit 0. The app waits briefly, then sends `SIGTERM`, then `SIGKILL`.

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
- **No clipboard read.** Nothing in this protocol can read the pasteboard, by design.
- **No token, ever.** The helper has no need for the bearer and must never be sent it.
