# Contract — Session state machine

**Status: frozen at the end of Phase 1, reopened by Phase 5** — the only phase permitted to change a contract (IMPLEMENTATION-PLAN.md §2). The single source of truth for session state (§3.1.2).

**Reopened again by the 2026-08-09 incident**, which found four defects in this document as much as in the code: insertion fired on the first final rather than on `transcript.done` (§12), the audio tail was dropped before the turn ended (§13), interim text was discarded when a turn died (§10), and a posted insert was presented as a landed one (§14). Each is written up below in the section it belongs to; the transition tables above them are current.

**Reopened 2026-08-22 (latency/honesty pass).** Three additive effects, none of which change the state diagram:

1. `mute_output` / `unmute_output` — system output mutes after the start cue and restores before the stop cue, on every path that leaves `recording` (release, Esc, error, cap, blocked, server-ended turn, quit). Capture still starts first; mute must not delay first PCM.
2. `SILENCE_GATED` — an orchestrator-injected event after drain, when the utterance was short _and_ silent _and_ no partial text arrived. `processing` → `idle` with `abort_stt` and `hud(hidden)`, not an error. Distinct from `NO_SPEECH_TIMEOUT_MS`.
3. `liveHudText` is snapshotted per turn like `repairSeams`. Off blanks `HudView.interim` on the way out; the context still keeps the real preview for salvage and the silence gate.

**Phase 5 changed four things**, each because the integration found the original wrong rather than incomplete:

1. `TURN_ENDED` in `recording` now emits `stop_capture`. It did not, so a turn the server ended while the key was still held left the microphone open — the macOS orange indicator lit through insertion and beyond, and the elapsed and cap timers still running.
2. `TURN_ENDED` in `inserting` now absorbs `durationSec` instead of ignoring it. `speech_final` always arrives first, so `inserting` is the state the duration lands in, and every history row the product had ever written carried `durationSec: null` (docs/phase-3-report.md §5.1).
3. `SESSION_ERROR` now keeps whatever was already transcribed rather than discarding it (§10).
4. `INSERT_TEXT` was added, and `RECORDING_CAP_REACHED` now emits a `tray` effect.

Implementation: [`src/main/state/machine.ts`](../src/main/state/machine.ts) — a **pure reducer**, `(state, event) → { state, effects[] }`. Purity is deliberate: the entire round-trip is then unit-testable with no Electron, no microphone and no socket, which is what lets Phase 1 prove the design before any real I/O exists.

State names are exported from [`events.ts`](./events.ts) as `SessionState` so the renderer can render them.

---

## 1. The diagram

```
                     ┌──────────────────────────────────────────────┐
                     │                                              │
  ptt_down /         ▼                                              │
  toggle       ┌───────────┐  ptt_up (hold)   ┌────────────┐        │
   ┌──────────▶│ recording │─────────────────▶│ processing │        │
   │           │           │  toggle (toggle) │            │        │
┌──┴───┐       └─────┬─────┘                  └──────┬─────┘        │
│ idle │             │                               │ final        │
│      │◀────────────┴──── cancel (Esc) ─────────────┤              │
└──┬───┘                                             ▼              │
   │ ▲                                        ┌────────────┐        │
   │ │           insert_result                │ inserting  │────────┘
   │ └────────────────────────────────────────┤            │
   │                                          └────────────┘
   │  retry_insert                                   ▲
   └─────────────────────────────────────────────────┘

  ┌─────────┐
  │ blocked │  ◀── secure_input=true, from ANY state
  └─────────┘  ──▶ idle, on secure_input=false
               refuses ptt_down / toggle / retry_insert
```

---

## 2. Context

Carried alongside the state; not part of it.

| Field            | Meaning                                                                                                                                                                                                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessionId`      | Identifies the current turn. **Every transcript, audio and insert event carries one; events whose id does not match are dropped.** This is the "press supersedes press" guard from `pipeline.rs:50-63` — without it, a superseded session's `speech_final` lands on the _new_ target. |
| `mode`           | `hold` or `toggle`. See §4.                                                                                                                                                                                                                                                           |
| `targetBundleId` | The frontmost app captured at session start.                                                                                                                                                                                                                                          |
| `committed`      | `speech_final` segments accumulated this turn. **The only text ever inserted.**                                                                                                                                                                                                       |
| `interim`        | Live preview text. Never inserted.                                                                                                                                                                                                                                                    |
| `lastTranscript` | Survives the session; what `Ctrl+Cmd+V` re-inserts.                                                                                                                                                                                                                                   |
| `pendingStart`   | A `ptt_down` that arrived while busy. See §5.                                                                                                                                                                                                                                         |
| `secureInput`    | Latest value from the helper.                                                                                                                                                                                                                                                         |
| `startedAt`      | For the HUD's elapsed timer and the recording cap.                                                                                                                                                                                                                                    |

---

## 3. Transition table

`—` means the event is ignored in that state (logged at debug, never an error).

### From `idle`

| Event                                 | →                           | Effects                                                                                                                                  |
| ------------------------------------- | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `PTT_DOWN`                            | `recording` (`mode=hold`)   | new `sessionId`; `request_frontmost`, `start_capture`, `start_stt`, `hud(recording)`, `cue(start)`, `mute_output` (if the setting is on) |
| `TOGGLE`                              | `recording` (`mode=toggle`) | as above                                                                                                                                 |
| `RETRY_INSERT` with `lastTranscript`  | `inserting`                 | `insert(lastTranscript, targetBundleId=null)` — see §6                                                                                   |
| `RETRY_INSERT` without                | `idle`                      | `hud(error "nothing to re-insert")`                                                                                                      |
| `INSERT_TEXT` with text               | `inserting`                 | `insert(text, targetBundleId=null)` — a history row or a Scratchpad edit; also §6                                                        |
| `INSERT_TEXT` with empty text         | —                           |                                                                                                                                          |
| `SECURE_INPUT(true)`                  | `blocked`                   | `hud(blocked)`, `tray(blocked)`                                                                                                          |
| `PTT_UP`, `CANCEL`, transcript events | —                           |                                                                                                                                          |

### From `recording`

| Event                       | →                            | Effects                                                                                                                         |
| --------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `PTT_UP` when `mode=hold`   | `processing`                 | `stop_capture`, `unmute_output`, `finish_stt`, `hud(processing)`, `cue(stop)`                                                   |
| `PTT_UP` when `mode=toggle` | —                            | the Fn release that follows an `Fn+Space`                                                                                       |
| `TOGGLE` when `mode=hold`   | `recording` (`mode=toggle`)  | **converts a hold into hands-free** — see §4                                                                                    |
| `TOGGLE` when `mode=toggle` | `processing`                 | `stop_capture`, `unmute_output`, `finish_stt`, `hud(processing)`, `cue(stop)`                                                   |
| `PTT_DOWN`                  | —                            | already recording; must not reset `mode`                                                                                        |
| `CANCEL`                    | `idle`                       | `cancel_capture`, `abort_stt`, `unmute_output`, `hud(hidden)` — nothing inserted, nothing stored                                |
| `TRANSCRIPT_INTERIM`        | `recording`                  | `hud(recording)` with the new preview                                                                                           |
| `TRANSCRIPT_FINAL`          | `recording`                  | append to `committed`; **not inserted yet** — see §7                                                                            |
| `FRONTMOST`                 | `recording`                  | records `targetBundleId`                                                                                                        |
| `TURN_ENDED`                | as `processing`+`TURN_ENDED` | `stop_capture` first — the key may still be held, and the device must not stay open — then the server ended the turn on its own |
| `SECURE_INPUT(true)`        | `blocked`                    | `stop_capture`, `finish_stt` — the turn still finishes so the text is not lost, but it will never be inserted (§8)              |
| `SESSION_ERROR`             | `idle`                       | `cancel_capture`, `abort_stt`, then §10                                                                                         |
| `RECORDING_CAP_REACHED`     | `processing`                 | `stop_capture`, `finish_stt`, `tray(processing)`                                                                                |

### From `processing`

| Event                                   | →            | Effects                                                                  |
| --------------------------------------- | ------------ | ------------------------------------------------------------------------ |
| `TRANSCRIPT_FINAL`                      | `processing` | append to `committed`; **no insert, no HUD frame** — see §12             |
| `TRANSCRIPT_INTERIM`                    | `processing` | `hud(processing)`                                                        |
| `TURN_ENDED` with `committed` non-empty | `inserting`  | `insert(committed, targetBundleId)`                                      |
| `TURN_ENDED` with `committed` empty     | `idle`       | `hud(error "no speech detected")`                                        |
| `CANCEL`                                | `idle`       | `abort_stt`, `unmute_output`, `hud(hidden)`                              |
| `SILENCE_GATED`                         | `idle`       | `abort_stt`, `hud(hidden)` — a short silent tap; not an error            |
| `PTT_DOWN`                              | `processing` | `pendingStart = true` — see §5                                           |
| `PTT_UP`                                | `processing` | `pendingStart = false`                                                   |
| `SECURE_INPUT(true)`                    | `blocked`    | the in-flight turn still lands in `blocked` and is shown, never inserted |
| `SESSION_ERROR`                         | `idle`       | see §10                                                                  |

### From `inserting`

| Event                | →                                        | Effects                                                                  |
| -------------------- | ---------------------------------------- | ------------------------------------------------------------------------ |
| `INSERT_RESULT(ok)`  | `idle`, or `recording` if `pendingStart` | `hud(inserted, full text)`, `history_append`, set `lastTranscript`       |
| `INSERT_RESULT(!ok)` | `idle`, or `recording` if `pendingStart` | `hud(not_inserted, full text)`, `history_append`, set `lastTranscript`   |
| `INSERT_TIMEOUT`     | `idle`                                   | treated exactly as `INSERT_RESULT(tier:'none', ok:false)`                |
| `TURN_ENDED`         | `inserting`                              | absorbs `durationSec`; reachable only for an ad-hoc insert since §12     |
| `TRANSCRIPT_FINAL`   | `inserting`                              | appended to `committed` and logged at `warn`; **not typed** — see §7     |
| **`PTT_DOWN`**       | `inserting`                              | **`pendingStart = true`** — the §11.3 resolution, see §5                 |
| `PTT_UP`             | `inserting`                              | `pendingStart = false`                                                   |
| `CANCEL`             | —                                        | an insert in flight cannot be recalled; the events may already be posted |
| `SECURE_INPUT(true)` | `inserting`                              | flagged; the state becomes `blocked` when the result arrives             |
| `SESSION_ERROR`      | `idle`                                   | `hud(not_inserted)` — the transcript is preserved, so nothing is lost    |

### From `blocked`

| Event                 | →         | Effects                                                                                                                              |
| --------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `SECURE_INPUT(false)` | `idle`    | `hud(hidden)`, `tray(idle)`; `pendingStart` cleared                                                                                  |
| `PTT_DOWN` / `TOGGLE` | `blocked` | **refused**; `hud(blocked)`, `cue(error)`                                                                                            |
| `RETRY_INSERT`        | `blocked` | refused — see §8                                                                                                                     |
| `INSERT_TEXT`         | `blocked` | refused — every insertion path is, without exception                                                                                 |
| `TRANSCRIPT_FINAL`    | `blocked` | appended to `committed`                                                                                                              |
| `TURN_ENDED`          | `blocked` | `hud(not_inserted, reason='secure_input')`, `history_append(inserted:false)`, set `lastTranscript` — including the interim tail, §10 |
| `SESSION_ERROR`       | `blocked` | `history_append(inserted:false)` and set `lastTranscript`; the pill stays `blocked` — §10                                            |
| `INSERT_RESULT`       | `blocked` | an insert that was already in flight completes normally and is recorded                                                              |

---

## 4. Fn versus Fn+Space

The helper reports raw key events; disambiguation is the app's job (`helper-protocol.md` §2).

Pressing `Fn+Space` produces **three** frames: `ptt_down` (Fn), `toggle` (Space with the Fn flag), `ptt_up` (Fn released). So:

- `idle` + `ptt_down` starts recording in `hold` mode **immediately** — no delay. and §11.2.6: a ~180 ms disambiguation window would clip the first word. The WebSocket handshake window is the disambiguation window instead, and the PCM captured during it is buffered (§4.3), so nothing is lost either way.
- A `toggle` arriving while `mode=hold` converts the session to hands-free, so the following `ptt_up` does not stop it.
- **In hands-free, a bare `ptt_down` also stops.** Added in Phase 5 at the user's direction — _"i want to toggle not by pressing fn + space AGAIN, but only pressing fn should be possible aswell"_. It is the obvious gesture, and Phase 5's HT-9 log caught the old behaviour turning it down (`ignored PTT_DOWN: already recording`) immediately before the user reached for Fn+Space instead.
- Fn+Space still stops hands-free — on its `ptt_down`, now. The `toggle` and `ptt_up` that follow both arrive in `processing`, where `toggle` is ignored and `ptt_up` clears `pendingStart`, so nothing restarts and no stray space is typed.
- In `hold` mode a second `ptt_down` is still ignored: it is the key that is already down.

**Known consequence:** pressing Space mid-hold converts an intended push-to-talk into hands-free. That is inherent to the gesture, not a bug in the machine.

---

## 5. `ptt_down` while busy — resolving

lists this under "Not thought through": _"what happens if the user holds Fn while the previous utterance is still being inserted. The Rust crate's 'press supersedes press' logic handles the capture side; the insertion side has no equivalent guard."_ IMPLEMENTATION-PLAN.md §3.1.2 requires Phase 1 to settle it, and §5b requires Phase 5 to verify the answer.

**Resolution: the press is queued, not dropped, and not honoured immediately.**

- `PTT_DOWN` in `inserting` or `processing` sets `pendingStart`.
- On reaching `idle`, if `pendingStart` is set, the machine transitions straight to `recording` with a **new** `sessionId` and re-runs the start effects.
- A `PTT_UP` arriving before the drain **clears** `pendingStart`. The key was released before we could start, so there is nothing to record — starting then would open a hot mic the user is no longer holding.
- `pendingStart` is cleared on `CANCEL`, on `SESSION_ERROR`, and on entering `blocked`.

**Why queue rather than drop:** dropping loses the user's intent silently, and the user is already speaking — this is the failure the Rust crate's superseding logic exists to prevent on the capture side (`pipeline.rs:50-63`).

**Why queue rather than pre-empt:** the insert has already been dispatched to the helper and may have posted `CGEvent`s. Aborting mid-ladder would leave a partial injection with no record of how much landed. The insert window is tens of milliseconds; the queue is imperceptible.

---

## 6. Every insertion targets _now_, not _then_

**All four insertion paths send `targetBundleId = null`**, which disables the helper's frontmost check: a session's own insert, `RETRY_INSERT`, `INSERT_TEXT`, and the `pendingStart` drain.

For `RETRY_INSERT` this was always the design — , the user's own words: _"The Control+Command+V would then be just a shortcut … which knows that that means it should try again to paste but it's not really in my clipboard."_ The whole point is to re-invoke insertion **wherever the user is now pointed**; pinning the original target would defeat it, since the usual reason to retry is that the first attempt went to the wrong place.

**Phase 5 extended the same rule to a session's own insert, reversing ** The user's direction after HT-4: _"i want to start wherever i want and then paste it somewhere i release or toggle"_. That is the natural reading of hands-free mode — begin dictating, walk over to the window you actually want the text in, stop — and it makes all four paths behave alike.

What it gives up is the guard §11.1.10 was written for: an accidental ⌘-Tab during the ~300 ms processing window now types the transcript into whatever arrived in front, instead of declining. The recovery is unchanged — the full text is in the pill and in history, and ⌃⌘V re-inserts it — so the cost is a stray paste to undo rather than lost words.

Two consequences follow:

- **`ctx.targetBundleId` is no longer a target.** It still records the app that was frontmost at press time, and it is still what a history row falls back to when no insertion is attempted at all (Secure Input, a failed session). Where an insertion _is_ attempted, the helper reports the application its ladder acted on and that wins — see §11.
- **`NotInsertedReason.target_changed` is unreachable in this configuration.** The helper still implements the check and still reports `reason:"target_changed"` when asked, which `--probe-insert` exercises; the app simply never asks. Re-enabling is one line in `beginInsert`.

Two more, about retries specifically:

- **A retry gets its own `sessionId`**, so the helper's `insert_result` can still be correlated. It is a fresh insertion attempt, not a resumption of the old session.
- **A retry appends no history row.** History holds one entry per _dictation_, not per insertion attempt — a second row carrying the same text would clutter the search surface that relies on as the recovery path. The retry's outcome is shown in the HUD immediately, which is where it matters. Mechanically this falls out of the machine appending history only when the insert had `committed` segments behind it.

---

## 7. Why a `speech_final` during `recording` is not inserted immediately

A pause longer than `endpointingMs` mid-hold makes the server emit `speech_final` while the user is still holding Fn. The Grok CLI appends each one to its prompt box (`pipeline.rs:310-330`) — fine for a text field, wrong here.

**This machine accumulates them into `committed` and inserts once, at end of turn.** One hold produces exactly one insertion. That is what makes the rest coherent:

- `Ctrl+Cmd+V` re-inserts _the_ transcript, not an ambiguous fragment of one;
- the frontmost check (§11.1.10) happens once, against one target;
- history holds one entry per hold;
- §5's queueing has a well-defined "busy" window.

**A `speech_final` that arrives during `inserting` is kept but not typed.** `processing` used to insert on the _first_ final it saw, so a server that flushes two segments after `audio.done` — which it does when the buffered tail contains a pause — lost the second one entirely: not typed, not in the pill, not in history, not on ⌃⌘V. It is appended to `committed`, which is what the pill, the history row and ⌃⌘V are built from, and logged at `warn`. It is still not typed, because the helper is already committed and one hold produces one insertion.

Since §12 the everyday version of that case no longer reaches `inserting` at all — both segments are typed — and this rule is the safety net for a final that arrives after `transcript.done` or after the finish timeout ended the turn early. It stays, because the difference between truncated text and truncated text nobody knows about is the whole point of it.

**`committed` segments are not joined with a single space.** Each `speech_final` re-transcribes one endpointed segment with no knowledge of the one before it, so the joins are splices, and splices lose words — a duplicated seam word, a mid-sentence capital, a "Thank you." hallucinated out of the closing silence. [`src/shared/stitch.ts`](../src/shared/stitch.ts) holds the measured evidence and the three deterministic repairs; the `repairSeams` setting turns them off and restores the plain join.

---

## 8. Secure Input

`IsSecureEventInputEnabled()` is true when focus is in a password field. While it is, **no third-party process can install a `CGEventTap`**, so the hotkey is dead system-wide with no error and no log. §12.2 calls this one of two silent failures that "will make a working app look broken".

- `SECURE_INPUT(true)` from **any** state → `blocked`, exactly as IMPLEMENTATION-PLAN.md §3.1.2 specifies.
- **The pill is raised on intent, not on focus.** Entering `blocked` from `idle` emits no HUD view at all: the tray icon turns, the warn line is logged, and nothing appears on screen. Secure Input turns on whenever a password field takes focus, which for a menu-bar app is usually a sign-in with no thought of dictating — announcing it there put a message up every time the user typed a password, and covered whatever pill was already there. Entering from `recording`, `processing` or `inserting` still announces, because a turn the user asked for is being taken away mid-sentence. `ctx.blockedNoticeShown` records which of the two happened, so that `SECURE_INPUT(false)` dismisses the app's own message and never a transcript the user was still reading.
- `blocked` **refuses** `ptt_down`, `toggle` and `retry_insert`, and says so in the HUD, with the error cue, and in the tray icon. Refusing visibly is the entire point — and a refusal is the moment there is finally something to refuse.
- An in-flight turn is **not discarded**. Capture stops and the turn is finalised, so the transcript still arrives; it is shown as `not_inserted` with `reason='secure_input'` and stored in history with `inserted:false`. Discarding what the user just said would be a worse failure than not typing it.
- Insertion is **never attempted** while blocked. Whether Secure Input also blocks AX writes is , unresolved — Phase 2 measures it. Until then the app does not find out the hard way inside a password field.

---

## 9. Invariants

Phase 5 (§5b) checks these. Each is covered by a unit test in `src/main/state/machine.test.ts`.

1. **Only `committed` text is ever inserted.** No `insert` effect may carry interim text. (`pipeline.rs:273-279`, )
2. **No insertion in `blocked`.** No path from a `blocked` state produces an `insert` effect.
3. **No `insert` uses a stale `sessionId`.** Events from a superseded session are dropped before they can produce effects.
4. **A `ptt_down` is never silently dropped while busy** — it is queued or explicitly cleared by a `ptt_up`.
5. **`CANCEL` produces no `insert` and no `history_append`.**
6. **The clipboard is written only by an explicit `copy` effect**, which the machine emits from no transition at all — it originates in the renderer, from a user click.
7. **Every terminal transition either inserts, shows the transcript, or explains itself.** A transcript never vanishes without a trace.

---

## 10. A session that fails part-way through

`SESSION_ERROR` reaches `idle`, and what happens there depends on what the turn had produced.

| `committed` | `interim` | HUD                                                | History                                             | `lastTranscript` |
| ----------- | --------- | -------------------------------------------------- | --------------------------------------------------- | ---------------- |
| empty       | empty     | `error(message, hint)`                             | nothing                                             | unchanged        |
| non-empty   | empty     | `not_inserted(reason='session_error')`             | one row, `inserted: false`                          | set              |
| any         | non-empty | `not_inserted(reason='session_error_unconfirmed')` | one row, `inserted: false`, `unconfirmedTail: true` | set              |

**Insertion is never attempted in any of them.** The turn is incomplete, and half a sentence appearing in the user's editor is worse than none — the recovery is ⌃⌘V once they have decided they want it. Salvaged interim text is emphatically not an exception: §9.1 still holds, and `beginInsert` still reads `committed` alone.

Phase 1 wrote only the first row, so the second case lost everything: a network drop after a minute of good dictation cleared `committed`, left `lastTranscript` alone, and gave ⌃⌘V nothing to re-insert. docs/phase-3-report.md §5.2 recorded that as "a product judgement, not a defect, but it should be a conscious one". This is the conscious one.

**The third row is the 2026-08-09 incident.** The server emits a `speech_final` when it hears an endpoint, so speaking continuously with no pause long enough to trigger one leaves `committed` **empty** for the whole utterance while a minute of text streams past as interim. A drop then salvaged nothing at all — the minute was in neither history nor `lastTranscript` nor reachable by ⌃⌘V. Interim text is imperfect and its last words are the least settled, which is why it is kept _and labelled_: the HUD reason and the history row's `unconfirmedTail` both say which half of the text the server stood behind. The same salvage runs when a turn dies or is finalised while `blocked`; there the reason stays `secure_input` — that is what the user must act on — and the unconfirmed tail is disclosed in the detail line.

---

## 11. Which application a history row names

Since §6 removed the target check, the app that was frontmost when a turn started is no longer the app that received the text. A history row built from the press-time value would therefore name the wrong one — and history is the recovery surface, so "which window did that go into?" is the question it most needs to answer correctly.

`insert_result` carries `frontmostBundleId` / `frontmostName`: the application the helper's ladder actually acted on, resolved once inside `run()` alongside the AX skip list. The row prefers those and falls back to `ctx.targetBundleId` when the helper reported none — a decline before it resolved one, or an outcome the app synthesised for a helper that never answered.

---

## 12. Insertion fires on `transcript.done`, not on the first final

`processing` + `TRANSCRIPT_FINAL` used to go straight to `inserting`. On a long turn where the user pauses just before pressing stop, the server owes **two** `speech_final`s at `audio.done` time — the endpointing-triggered one for the segment before the pause, and the post-`audio.done` one for the tail — so inserting on the first typed the sentence without its ending, every time, with nothing on screen to say so.

**`processing` now accumulates finals and inserts on `TURN_ENDED`**, which the protocol guarantees arrives after the last one. The measured cost is single-digit milliseconds: in the 2026-08-09 incident log the final landed at `.065` and `transcript.done` at `.068`.

The obvious risk is a turn that never ends. It is covered twice over, and neither cover is new:

- **`FINISH_TIMEOUT_MS`** (`src/main/stt/client.ts`, 8 s) is armed by `finish()` and synthesises `onDone(null)` → `TURN_ENDED`, which inserts what the turn had. A benign close after `audio.done` does the same thing immediately.
- **The liveness watchdog** (§13 of that file) fails a dead link into `SESSION_ERROR` → §10, which salvages rather than dropping.

`TRANSCRIPT_FINAL` in `processing` emits no `hud` effect: the transcribing capsule is a spinner and shows neither the interim nor the committed text, so a frame there would be an IPC round trip that changes no pixels (§14).

---

## 13. `audio.done` waits for the capture tail

`stop_capture` and `finish_stt` are emitted in the same step and always have been. What changed is how the composition root interprets them: **`finish_stt` is held until the audio source reports the session drained** (`AudioHandlers.onDrained`).

The capture renderer flushes its encoder tail as one final `capture-chunk` _after_ `capture-stop` reaches it — up to 100 ms, and "the last 100 ms of a hold is the end of the last word". The main process used to drop the session synchronously inside `stop()`, so that chunk was discarded and `audio.done` had gone out before it anyway. The renderer's tail-flush was dead code and the last ~100–300 ms of speech never reached the server on any dictation: clipped or wrong final words, and a full-utterance buffer missing the same tail.

The drain is bounded by a short timer in `CaptureCoordinator` (`DRAIN_TIMEOUT_MS`, 250 ms) and the port requires `onDrained` to fire exactly once within a bounded time. **A dead or slow renderer must not be able to hang a turn**, so when the timer wins it logs and the turn proceeds with whatever arrived. `cancel_capture` never drains: Esc throws the audio away, so there is nothing for a tail to be kept for.

---

## 14. What an insert is allowed to claim

`insert_result.ok` means the helper **posted** the text. For the Unicode tier that is not the same as the text having arrived — `CGEventKeyboardSetUnicodeString` has no return channel — and on 2026-08-09 a 60.3 s dictation was posted as 38 events in 245 ms into a terminal that dropped every one. The app showed a green check, played no error cue and wrote `inserted: true`.

`insert_result.verified` closes it. Three outcomes now leave `inserting`:

| Outcome                | HUD                                   | History                          | Cue     |
| ---------------------- | ------------------------------------- | -------------------------------- | ------- |
| `ok`, `verified: true` | `inserted` — the bare green check     | `inserted: true, verified: true` | none    |
| `ok`, otherwise        | `inserted` — the same green check     | `inserted: true, verified: null` | none    |
| `!ok`                  | `not_inserted` — wordless red capsule | `inserted: false`                | `error` |

**`ok: true` with `verified` not `true` means "typed, unconfirmed" on the wire and in history.** The HUD does not overlay a paragraph for it — a false "not inserted" / "typed, unconfirmed" pill over text that landed was worse than a silent drop the user will retry with ⌃⌘V. Unicode length-checking is off unless `GROK_DICTATE_INJECT_VERIFY=1`.

Two deliberate trades. The unconfirmed pill plays **no error cue**: verification is impossible for a whole class of ordinary targets, so a cue there would fire on good dictations and train the user to ignore the one sound that means something. And `verification_failed` — posted, and proven not to have landed — arrives with `tier: 'unicode'`, because the tier that _ran_ is what a history row should name; nothing may read `tier === 'none'` as "it failed".
