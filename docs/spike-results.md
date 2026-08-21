# xAI streaming STT — measured behaviour

Notes from probing `wss://api.x.ai/v1/stt` with `scripts/probe-stt.ts`.
Cited by the client and the contracts.
Official docs: [Speech to Text](https://docs.x.ai/developers/model-capabilities/audio/speech-to-text).

Default query: `sample_rate=16000&encoding=pcm&interim_results=true`.

## Summary

| #   | Question                            | Finding                                                                                                    |
| --- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| 1   | Do partials carry extra fields?     | Yes — `language` and `words[]` with timings. Read them; do not invent a detector.                          |
| 2   | `finalize` vs `audio.done`?         | Same latency (~320–345 ms). `finalize` produces no `transcript.done` and does not close. Use `audio.done`. |
| 3   | Does `language=` steer recognition? | `de`, `auto`, and omitted were indistinguishable. `auto` omits the parameter.                              |
| 4   | Session duration cap?               | No cut at 15 minutes in testing. One hold can emit many `speech_final`s.                                   |
| 5   | Do `keyterm`s work?                 | Yes. Repeat the query parameter; CSV also works.                                                           |

## 1. `transcript.partial` fields

Every run saw: `duration`, `id`, `is_final`, `language`, `speech_final`, `start`, `text`, `type`, `words`.

`language` is detected from the audio, not echoed from the request. English audio sent with `language=de` came back as English, with English number formatting.

`words[]` is per-word start/end. Unused in v1.

## 2. End of turn

`audio.done` → `speech_final` in ~318–344 ms. `endpointing` did not change that latency when the client ended the turn. It only affects mid-hold auto-splits.

> **Superseded 2026-08-21: "keep 400 ms" was wrong, and this section is why.**
> Measuring the latency and finding it flat made `endpointing` look like a free
> parameter, so nobody measured what the mid-hold auto-splits _cost_. Over 67
> real dictations at 400 ms a hold was cut into **4.9 segments on average** (one
> every ~8 s, worst case 41) — and finding 4 below already said each segment is
> re-transcribed on its own. Every split is therefore a splice between two
> transcriptions that never saw each other, and the splices lose words. From a
> real user's history: `From the Mac.` + `A book at home.` for "MacBook";
> `you` + `You have like index?`; `and it should` + `Do any code changes yet`
> for "it shouldn't do any code changes yet".
> The default is now 2,000 ms. Latency is unaffected, exactly as measured here.
> See `DEFAULT_ENDPOINTING_MS` and `src/shared/stitch.ts`.

`finalize` flushes the current utterance and leaves the socket open: no `transcript.done`, no duration, no server close.

## 3. Language parameter

`language=de`, `language=auto`, and omitting the parameter produced the same recognition in these tests. The tray language control is a preference, not a force.

## 4. Duration

A ~900 s realtime stream was not cut by the server. The app’s 6-minute cap is a memory bound, not a protocol one.

## 5. Keyterms

Repeated `keyterm=` parameters and a comma-separated value both biased recognition. Prefer repeats so a term can contain a comma.

## Incidental

- Handshake was ~518–591 ms. Buffer PCM from key-down or the first word is lost.
- `transcript.done` is a duration receipt (`text` was empty). The transcript is the last `speech_final` partial.
- The socket often closes with code 1006 and no closing handshake after a turn. Treat that as benign once the turn has ended.
