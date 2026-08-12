/**
 * Tuning constants, most of them ported from the Grok Build CLI Rust source.
 *
 *  is explicit that the Rust crate is to be treated as an
 * executable *specification* rather than forked — "its tuning constants and
 * edge-case handling are hard-won". Every value below therefore cites the file
 * and line it came from, so a future reader can check the reasoning instead of
 * re-deriving it (IMPLEMENTATION-PLAN.md §4, "Comment the non-obvious").
 *
 * Paths are relative to `grok-build/crates/codegen/xai-grok-voice/`.
 */

/** xAI streaming STT endpoint. `config.rs:36-48`,  */
export const STT_API_BASE = 'https://api.x.ai';
export const STT_WS_PATH = '/v1/stt';

/**
 * 16 kHz mono PCM16. `config.rs:36-48` (`sample_rate = 16000`).
 */
export const SAMPLE_RATE_HZ = 16_000;
export const CHANNELS = 1;
export const BYTES_PER_SAMPLE = 2;

/**
 * 100 ms per chunk = 3,200 bytes at 16 kHz PCM16 mono. This is xAI's own
 * recommended chunk size and what IMPLEMENTATION-PLAN.md
 * §3.3 requires the capture renderer to emit.
 */
export const CHUNK_DURATION_MS = 100;
export const CHUNK_BYTES =
  (SAMPLE_RATE_HZ * CHANNELS * BYTES_PER_SAMPLE * CHUNK_DURATION_MS) / 1000;

/** 32,000 bytes per second of audio — used to size and cap buffers. */
export const BYTES_PER_SECOND = SAMPLE_RATE_HZ * CHANNELS * BYTES_PER_SAMPLE;

/**
 * Cap on the pre-connect PCM backlog. `pipeline.rs:145`
 * (`BACKLOG_MAX_CHUNKS = 1024`). Sized far above any real connect: the connect
 * timeout aborts long before this is reached, so in practice it never drops —
 * it only bounds a pathological hang. 1024 × 100 ms ≈ 102 s of audio.
 */
export const BACKLOG_MAX_CHUNKS = 1024;

/**
 * How long a session may run without any transcript before teardown.
 * `pipeline.rs:198` (`NO_SPEECH_TIMEOUT = 10s`). Disarmed by the first
 * transcript, so long dictation with pauses is unaffected. It exists because
 * "macOS may return silence instead of an error" when mic permission is denied
 * (`pipeline.rs:200-209`).
 */
export const NO_SPEECH_TIMEOUT_MS = 10_000;

/** `streaming.rs:63-68` — 15 s on the WebSocket connect. */
export const STT_CONNECT_TIMEOUT_MS = 15_000;

/** `streaming.rs:154` — 10 s waiting for `transcript.created` after connect. */
export const STT_READY_TIMEOUT_MS = 10_000;

/**
 * Silence, in ms, before the server declares end of utterance.
 * `config.rs:36-48` sets 400; xAI's documented default is 10.
 * 400 was tuned for a TUI prompt box, not push-to-talk, where the user defines
 * the turn boundary — see spike 2 in docs/spike-results.md.
 */
export const DEFAULT_ENDPOINTING_MS = 400;

/** `keyterm`: max 100 terms of 50 chars each. */
export const KEYTERM_MAX_COUNT = 100;
export const KEYTERM_MAX_LENGTH = 50;

/**
 * Hard ceiling on a single recording.  flags the real server-side
 * limit as unknown and Wispr Flow caps at ~6 min; spike 4 measures ours. Until
 * then this bounds the full-utterance buffer (§11.1.1) at 6 min × 32 KB/s ≈
 * 11.5 MB.
 */
export const MAX_RECORDING_MS = 6 * 60 * 1000;
export const MAX_UTTERANCE_BUFFER_BYTES = (MAX_RECORDING_MS / 1000) * BYTES_PER_SECOND;

/**
 * Unicode injection chunking. : "~20 UTF-16 units per event as
 * the commonly-cited safe chunk". Phase 2 tunes the delay empirically.
 */
export const UNICODE_CHUNK_UTF16_UNITS = 20;

/**
 * Margin before `expires_at` at which the token is treated as already expired,
 * so a session cannot die mid-utterance. IMPLEMENTATION-PLAN.md §3.3: "use
 * `key` as bearer if `expires_at` is in the future with ≥ 60 s margin".
 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Where the Grok CLI keeps its OIDC tokens. */
export const AUTH_JSON_RELATIVE_PATH = '.grok/auth.json';

/** Encrypted API-key file, relative to Electron `userData`. */
export const CREDENTIALS_FILE_NAME = 'credentials.json';

/** Official page for creating an xAI API key. */
export const XAI_CONSOLE_API_KEYS_URL = 'https://console.x.ai/team/default/api-keys';

/** Official streaming STT docs. */
export const XAI_STT_DOCS_URL =
  'https://docs.x.ai/developers/model-capabilities/audio/speech-to-text';

/**
 * Sentinel expiry for an xAI API key. The speech service does not tell us when
 * a key will be revoked, so `getBearer` treats a stored key as always valid
 * and lets a 401 surface the real failure.
 */
export const API_KEY_SENTINEL_EXPIRY = new Date('2099-01-01T00:00:00.000Z');

/** Protocol version carried by every helper frame (IMPLEMENTATION-PLAN.md §3.1.2). */
export const HELPER_PROTOCOL_VERSION = 1;
