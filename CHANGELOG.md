# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-08-27

The round trip is now measurable, and the app shows what it already knew. A dictation session writes a greppable timing line per lifecycle event. The pill stays wordless while you speak. Accidental silent taps no longer wait on the server. System output mutes while the microphone is open. Unicode injection prefers the target process over the global event stream. The audio graph stays warm across holds without lighting the orange indicator. Stats, derived only from history, sit next to History in the menu. Insert outcomes no longer raise a paragraph overlay — History and ⌃⌘V are the recovery.

Transcript accuracy. A hold is cut into segments whenever the speaker pauses, and each segment is re-transcribed with no knowledge of the one before it — so the joins, not the recognition, were where the text was going wrong. Measured over 67 real dictations: 4.9 segments per hold, one every ~8 s, worst case 41.

Insertion honesty. A code review on 2026-08-09, cross-checked against the log of an incident where a 60-second dictation was typed into a terminal, dropped by it, and reported back with a green check, found seven bugs. All seven are fixed here. Four of them were silent data loss: text that was said, was not delivered, and had nothing anywhere admitting it.

### Changed

- **`endpointingMs` now defaults to 2,000 ms, not 400.** 400 came from the Grok CLI, where each segment is its own submitted line; here it cut a hold into five. Ending a turn does not wait for silence, so the longer value costs nothing in latency. Existing settings are untouched — change it under Settings → Dictation.
- Segment joins are repaired before insertion: a duplicated word across the seam is dropped, a sentence capital that lands mid-sentence is lowered, and a "Thank you." hallucinated out of the leading or trailing silence is removed. Deterministic and conservative — no model, and content words are never touched. New **Settings → Dictation → Repair segment joins** turns it off.
- The applied microphone processing (`echoCancellation`, `noiseSuppression`, `autoGainControl` as the device actually reports them) is logged with every capture, so whether Chromium's telephony-tuned processing helps or hurts accuracy here can finally be measured.
- **Insertion waits for the server to finish the turn** instead of firing on the first completed sentence after you stop. It costs the milliseconds between the last segment and the end of the turn — 3 ms in the incident log — and it is what stops a pause just before you release the key from cutting the ending off the text that gets typed.
- **`insert_result` carries `verified`** (`contracts/helper-protocol.md` §2). `true` means the helper confirmed the text landed. `null` means it could not be checked. History records the distinction; the HUD is a wordless green check either way. Unicode length-checking is **off unless `GROK_DICTATE_INJECT_VERIFY=1`** — a false "not inserted" over text that landed (cmux reporting AX length 0) was worse than noticing a drop yourself and pressing ⌃⌘V.
- **Long text is typed more slowly.** Above 200 characters the gap between keystroke events rises from a flat 5 ms to 15 ms, so a minute of dictation takes about half a second to type instead of a quarter. Short insertions are untouched — they were never the ones being dropped. `GROK_DICTATE_INJECT_DELAY_MS` still overrides at any length.
- **History is journalled rather than rewritten on every row.** `history.json` is still rewritten atomically and is still valid JSON at rest; rows appended since the last rewrite live one per line in `history.pending.jsonl` and are folded back at launch. A build older than this one would not see rows still sitting in the journal.
- Roughly half the interface updates while you speak: HUD frames are floored at 90 ms and a frame identical to the one before it is not sent at all.

### Added

- **A timing channel for every dictation.** One `key=value` line per lifecycle event (hotkey → first PCM in main → socket → insert → idle) plus a summary, lengths and counts only. On by default; `GROK_DICTATE_TIMING=0` turns it off. The reducer is still pure — the orchestrator stamps the clock.
- **The pill does not show live words.** A leftover Settings flag from an earlier build is ignored; the capsule is bars and a spinner.
- **Accidental taps are dropped.** A short hold that is measurably silent no longer opens a wait on the server or shows an error. "Yes" / "no" / "OK" are kept. If any partial with text already arrived, nothing is dropped. Off under Settings → Dictation. Distinct from the ten-second no-speech watchdog.
- **Other audio mutes while you talk.** System output mutes after the start cue and restores before the stop cue, on Esc, errors, timeouts, and quit. A crash leaves a lock file the next launch restores. A user who unmutes during the recording is not overwritten. Off under Settings → General.
- **Stats.** Menu bar → Stats. Words, time spent, dictations, insertion rate, where it went, language split — from history, labelled as the retention window (default 90 days), never lifetime. "Time saved" shows the 40 words/minute assumption. Purge zeros the numbers. No transcripts on that screen.
- Unicode injection **posts to the target pid** when it has one, and falls back to the global tap when it does not. Private event source, cleared flags, and the modifier wait stay on both routes. Length-checking is off by default. Pacing is kept.

- **The Grok CLI login now renews itself.** A CLI token lasts hours, so a menu-bar app left running reliably met an expired one — and the result was a dead `Fn` key and an error pill telling you to go and run `grok` yourself. Grok Dictate now runs that command for you: `grok models`, in the background, about four minutes before the token expires, and again at startup if it expired while the app was closed. A dictation that still meets an expired token renews on the spot and continues.

  It is **not** a token refresh path, and the distinction is deliberate — §5.6 forbids one, and `test/e2e/audit-5b.test.ts` still passes over this code unchanged. Nothing here mints, rotates or writes a token; `grok` does all of it, holding `auth.json.lock` exactly as it does when a human runs it.

  Two behaviours worth knowing, both measured against `grok 1.0.5` and documented in `src/main/auth/renew.ts`: a refresh the **server rejects** makes the CLI clear `auth.json` — the login really is gone at that point and you will get the Sign in window — while a refresh that fails because you are **offline** leaves your credentials untouched. Turn the whole thing off with **Settings → General → Keep the Grok CLI login signed in**. Does nothing if you use an xAI API key, which does not expire.

- `npm run replay:history` — replays your own transcripts through the seam repairer and prints what it would have changed. Run it before and after touching a rule; a rule that fires on well-formed sentences is too eager whatever its unit tests say. Reads only, prints locally, sends nothing anywhere.

### Fixed

- **Unmute restores the device that was muted**, even if the default output changed mid-recording. The first mute build compared numeric `AudioDeviceID`s, dropped the lock, and left speakers silent. Restore now looks up a stable CoreAudio UID and only drops the lock after a successful apply (or if the user already unmuted).
- **A reused capture worklet no longer prepends the previous session's leftover frames** onto the next hold. Stop (and the next start) posts a reset; empty input after disconnect does not count as one.
- **The HUD no longer puts issue paragraphs over the document.** "Typed — not confirmed" and "Not inserted — the app ignored the keystrokes" were overlaying text that had in fact landed (cmux reports AX length 0 whether or not it took the keystrokes). Insert outcomes are a wordless check or a red flash; History and ⌃⌘V are the recovery. `0 → 0` AX length is unverifiable, not a failure, if length-checking is turned back on.
- **The end of the last word never reached the server — on every single dictation.** The capture window flushes its final ~100 ms of audio after being told to stop, and the main process was discarding that chunk and ending the turn without it. Stopping is now two-phase: the tail is forwarded, acknowledged, and only then is the turn closed. A capture window that never answers cannot hold a dictation open — it gets 250 ms.
- **Speaking without pausing lost everything if the connection dropped.** Continuous speech produces no confirmed segments at all, so a drop mid-utterance discarded the lot: not in the pill, not in History, not reachable by `Ctrl+Cmd+V`. What was transcribed is now kept, shown and searchable, labelled where the end of it was never confirmed. It is still never typed — half a sentence appearing in your editor is worse than none.
- **A `speech_final` arriving after the insert was dispatched was silently discarded**, losing the last segment of the turn from the pill, from History and from `Ctrl+Cmd+V`. Insertion now waits for the turn to end, so that segment is typed with the rest; the late-arrival path is kept as a safety net and says so in the log when it fires.
- **Typing a password no longer puts a message on screen.** macOS turns on Secure Input whenever a password field takes focus, and the app announced it every single time — a pill explaining that dictation is unavailable, raised at someone who was signing in to something and had no thought of dictating, on top of whatever was on screen before it. It is now said only when you ask for it: press `Fn` (or `Fn+Space`, or `Ctrl+Cmd+V`) inside a password field and it refuses exactly as loudly as before, cue and all, and Secure Input arriving in the middle of a dictation still interrupts you visibly. Otherwise the menu-bar icon changes and nothing else does.
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
