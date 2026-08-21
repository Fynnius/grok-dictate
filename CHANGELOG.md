# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

Transcript accuracy. A hold is cut into segments whenever the speaker pauses, and each segment is re-transcribed with no knowledge of the one before it — so the joins, not the recognition, were where the text was going wrong. Measured over 67 real dictations: 4.9 segments per hold, one every ~8 s, worst case 41.

Insertion honesty. A code review on 2026-08-09, cross-checked against the log of an incident where a 60-second dictation was typed into a terminal, dropped by it, and reported back with a green check, found seven bugs. All seven are fixed here. Four of them were silent data loss: text that was said, was not delivered, and had nothing anywhere admitting it.

### Changed

- **`endpointingMs` now defaults to 2,000 ms, not 400.** 400 came from the Grok CLI, where each segment is its own submitted line; here it cut a hold into five. Ending a turn does not wait for silence, so the longer value costs nothing in latency. Existing settings are untouched — change it under Settings → Dictation.
- Segment joins are repaired before insertion: a duplicated word across the seam is dropped, a sentence capital that lands mid-sentence is lowered, and a "Thank you." hallucinated out of the leading or trailing silence is removed. Deterministic and conservative — no model, and content words are never touched. New **Settings → Dictation → Repair segment joins** turns it off.
- The applied microphone processing (`echoCancellation`, `noiseSuppression`, `autoGainControl` as the device actually reports them) is logged with every capture, so whether Chromium's telephony-tuned processing helps or hurts accuracy here can finally be measured.
- **Insertion waits for the server to finish the turn** instead of firing on the first completed sentence after you stop. It costs the milliseconds between the last segment and the end of the turn — 3 ms in the incident log — and it is what stops a pause just before you release the key from cutting the ending off the text that gets typed.
- **`insert_result` carries `verified`** (`contracts/helper-protocol.md` §2). `true` means the helper confirmed the text landed: the caret moved, or the target's own text grew by what was typed. `null` means it could not be checked for that app, which is the honest answer for a whole class of ordinary targets. `ok: true` without `verified: true` means "typed, unconfirmed" and is no longer rendered as plain success. `GROK_DICTATE_INJECT_VERIFY=0` turns the check off if it ever gets an app wrong.
- **Long text is typed more slowly.** Above 200 characters the gap between keystroke events rises from a flat 5 ms to 15 ms, so a minute of dictation takes about half a second to type instead of a quarter. Short insertions are untouched — they were never the ones being dropped. `GROK_DICTATE_INJECT_DELAY_MS` still overrides at any length.
- **History is journalled rather than rewritten on every row.** `history.json` is still rewritten atomically and is still valid JSON at rest; rows appended since the last rewrite live one per line in `history.pending.jsonl` and are folded back at launch. A build older than this one would not see rows still sitting in the journal.
- Roughly half the interface updates while you speak: HUD frames are floored at 90 ms and a frame identical to the one before it is not sent at all.

### Added

- **The Grok CLI login now renews itself.** A CLI token lasts hours, so a menu-bar app left running reliably met an expired one — and the result was a dead `Fn` key and an error pill telling you to go and run `grok` yourself. Grok Dictate now runs that command for you: `grok models`, in the background, about four minutes before the token expires, and again at startup if it expired while the app was closed. A dictation that still meets an expired token renews on the spot and continues.

  It is **not** a token refresh path, and the distinction is deliberate — §5.6 forbids one, and `test/e2e/audit-5b.test.ts` still passes over this code unchanged. Nothing here mints, rotates or writes a token; `grok` does all of it, holding `auth.json.lock` exactly as it does when a human runs it.

  Two behaviours worth knowing, both measured against `grok 1.0.5` and documented in `src/main/auth/renew.ts`: a refresh the **server rejects** makes the CLI clear `auth.json` — the login really is gone at that point and you will get the Sign in window — while a refresh that fails because you are **offline** leaves your credentials untouched. Turn the whole thing off with **Settings → General → Keep the Grok CLI login signed in**. Does nothing if you use an xAI API key, which does not expire.

- `npm run replay:history` — replays your own transcripts through the seam repairer and prints what it would have changed. Run it before and after touching a rule; a rule that fires on well-formed sentences is too eager whatever its unit tests say. Reads only, prints locally, sends nothing anywhere.

### Fixed

- **A long dictation could vanish into a terminal behind a green "Inserted" pill.** Where the Accessibility tier cannot be used — terminals, most Electron apps — text is typed as synthetic keystrokes, and the API that posts them reports nothing about whether they arrived. Sixty seconds of speech went out as 38 events in a quarter of a second, the terminal dropped every one, and the app showed a green check, played no error cue and wrote `inserted: true` to History. The helper now measures the target's own text length before and after typing, and the app tells the truth about the answer: a confirmed insert keeps the green check, an unconfirmed one shows an amber pill with the full transcript and Copy / Re-insert / Scratchpad, and one the helper proved did not arrive is reported as the failure it is. History records the same distinction.
- **The end of the last word never reached the server — on every single dictation.** The capture window flushes its final ~100 ms of audio after being told to stop, and the main process was discarding that chunk and ending the turn without it. Stopping is now two-phase: the tail is forwarded, acknowledged, and only then is the turn closed. A capture window that never answers cannot hold a dictation open — it gets 250 ms.
- **Speaking without pausing lost everything if the connection dropped.** Continuous speech produces no confirmed segments at all, so a drop mid-utterance discarded the lot: not in the pill, not in History, not reachable by `Ctrl+Cmd+V`. What was transcribed is now kept, shown and searchable, labelled where the end of it was never confirmed. It is still never typed — half a sentence appearing in your editor is worse than none.
- **A `speech_final` arriving after the insert was dispatched was silently discarded**, losing the last segment of the turn from the pill, from History and from `Ctrl+Cmd+V`. Insertion now waits for the turn to end, so that segment is typed with the rest; the late-arrival path is kept as a safety net and says so in the log when it fires.
- **Sleeping the Mac mid-dictation could kill the turn** with "the connection stopped responding" on a connection that was perfectly fine. A gap between watchdog checks far longer than the interval means this process was not running, not that the link died; it re-arms and probes instead of failing.
- **Every successful dictation leaked the object holding it** — handlers, accumulated text and options — for the life of the app. A tray app runs for weeks.
- `src/main/stt/frames.ts` described `speech_final` as a re-transcription "of the whole turn". It is one segment. That sentence is why the joins were treated as concatenation for so long.

## [0.1.0] — 2026-08-12

First public-ready release of Grok Dictate. Ad-hoc signed Apple Silicon build — not notarized. See the Gatekeeper note in the [release](https://github.com/Fynnius/grok-dictate/releases/tag/v0.1.0).

### Added

- Hold `Fn` to dictate; `Fn+Space` for hands-free; `Ctrl+Cmd+V` to re-insert
- Streaming transcription against `wss://api.x.ai/v1/stt`
- First-run Sign in window for an xAI API key (Keychain via Electron safeStorage)
- Automatic use of an existing Grok CLI login at `~/.grok/auth.json`
- Menu-bar HUD, History, Scratchpad, and Settings
- Swift helper for the global hotkey and the Accessibility → Unicode insertion ladder
- The clipboard is written only when the user clicks Copy
