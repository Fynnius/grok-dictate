/**
 * The real STT client, driven by the real state machine.
 *
 * `src/main/state/round-trip.test.ts` (Phase 1) proves the round-trip with the
 * *mock* STT; this proves the same round-trip with the real WebSocket client
 * against a loopback server. It is the test that would have caught a client
 * which satisfies `SttClientPort`'s types but not its behaviour — most of all
 * the requirement that `startTurn` be synchronous, because the orchestrator
 * pushes PCM into the returned turn on the very next tick
 * (`orchestrator.ts`, `start_capture` → `onChunk`).
 *
 * Audio stays mocked here. Real capture needs a device, a permission grant and a
 * person to speak; that is the human test batch in `docs/phase-3-report.md`.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockAudioSource } from '@mocks/mock-audio.js';
import { MemoryConfig, MemoryHistory, MemoryHud, MemorySound, MemoryTray } from '@mocks/mock-ui.js';
import type {
  AuthPort,
  Bearer,
  FrontmostApp,
  InsertOutcome,
  NativeHelperPort,
} from '@contracts/ports.js';
import type { HotkeyBindings } from '@contracts/config.js';
import { CHUNK_BYTES } from '@shared/constants.js';
import { clearLogSinks, createLogger } from '@shared/logger.js';
import { ok, type Result } from '@shared/result.js';
import { Orchestrator } from '../state/orchestrator.js';
import { XaiSttClient, type SttTimeouts } from './client.js';
import { FakeSttServer, waitFor } from './fake-server.js';

/** A helper that always inserts successfully and never touches the clipboard. */
class StubHelper implements NativeHelperPort {
  readonly isReady = true;
  readonly inserted: string[] = [];
  readonly copied: string[] = [];

  insert(text: string): Promise<InsertOutcome> {
    this.inserted.push(text);
    // `verified: true` — this stub stands in for a helper whose AX write
    // succeeded and was read back. Without it the app would correctly report
    // every insertion here as "typed, unconfirmed" (2026-08-09 incident).
    return Promise.resolve({ tier: 'ax', ok: true, error: null, verified: true });
  }
  copy(text: string): void {
    this.copied.push(text);
  }
  getFrontmost(): Promise<FrontmostApp> {
    return Promise.resolve({ bundleId: 'com.apple.TextEdit', name: 'TextEdit' });
  }
  setHotkeys(_bindings: HotkeyBindings): void {
    /* nothing to bind in a stub */
  }
  shutdown(): Promise<void> {
    return Promise.resolve();
  }
  onReady(): () => void {
    return () => undefined;
  }
  onHotkey(): () => void {
    return () => undefined;
  }
  onSecureInput(): () => void {
    return () => undefined;
  }
  onPermissions(): () => void {
    return () => {};
  }
  onFrontmostChanged(): () => void {
    return () => undefined;
  }
}

const FAKE_JWT = `eyJhbGciOiJSUzI1NiJ9.${'aW50ZWdyYXRpb24tdGVzdC1wYXlsb2Fk'.repeat(3)}.c2ln`;

const auth: AuthPort = {
  getBearer(): Promise<Result<Bearer>> {
    return Promise.resolve(ok({ token: FAKE_JWT, expiresAt: new Date(Date.now() + 3_600_000) }));
  },
};

let server: FakeSttServer;
let orchestrator: Orchestrator;
let helper: StubHelper;
let hud: MemoryHud;
let history: MemoryHistory;

/**
 * Wire the real client to the loopback server behind the real orchestrator.
 *
 * `timeouts` is a test seam only — production always uses the constants in
 * `client.ts`. It exists so the finish-timeout backstop can be exercised
 * without an eight-second test.
 */
function buildOrchestrator(timeouts: Partial<SttTimeouts> = {}): void {
  const logger = createLogger('integration');
  helper = new StubHelper();
  hud = new MemoryHud();
  history = new MemoryHistory();

  orchestrator = new Orchestrator({
    native: helper,
    // 10 ms chunk cadence: a 200 ms hold produces ~20 chunks, enough to see the
    // backlog behaviour without making the test slow.
    audio: new MockAudioSource({ chunkIntervalMs: 10, loop: true }),
    stt: new XaiSttClient({ auth, logger, apiBase: server.base, timeouts }),
    hud,
    tray: new MemoryTray(),
    sound: new MemorySound(),
    history,
    config: new MemoryConfig({ keyterms: ['kubectl'] }),
    logger,
    tickIntervalMs: 0,
  });
  orchestrator.start();
}

beforeEach(async () => {
  server = await FakeSttServer.start();
  buildOrchestrator();
});

afterEach(async () => {
  orchestrator.dispose();
  clearLogSinks();
  await server.stop();
});

describe('press → capture → real socket → insert', () => {
  it('completes a dictation and inserts only the speech_final text', async () => {
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);
    await waitFor(() => server.binary.length > 3);

    // Preview text, which must never be inserted.
    server.partial({ text: 'hello there', language: 'en' });
    await waitFor(() => hud.last?.kind === 'recording');

    orchestrator.dispatch({ type: 'PTT_UP', ts: Date.now() });
    await waitFor(() => server.text.includes('{"type":"audio.done"}'));

    server.partial({
      text: 'Hello there, this is a test. Please confirm the details.',
      isFinal: true,
      speechFinal: true,
      language: 'de',
    });
    server.done(12.865);

    await waitFor(() => orchestrator.snapshot.state === 'idle');
    expect(helper.inserted).toEqual(['Hello there, this is a test. Please confirm the details.']);
    expect(hud.last).toEqual({
      kind: 'inserted',
      text: 'Hello there, this is a test. Please confirm the details.',
      tier: 'ax',
      verified: true,
    });

    // History records the language the server *detected* (spike 1).
    expect(history.entries[0]).toMatchObject({
      language: 'de',
      inserted: true,
      frontmostBundleId: 'com.apple.TextEdit',
    });
    // Nothing reached the pasteboard.
    expect(helper.copied).toEqual([]);
  });

  it('waits for transcript.done before inserting, so a second final is not lost', async () => {
    /**
     * The 2026-08-09 incident, BUG-4. On a long turn where the user pauses just
     * before releasing, the server owes **two** `speech_final`s at `audio.done`
     * time: the endpointing-triggered one for the segment before the pause, and
     * the post-`audio.done` one for the tail. The machine used to insert on the
     * first, and the pasted text was missing its ending.
     *
     * The measured cost of waiting is single-digit milliseconds — in the
     * incident log the final landed at `.065` and `done` at `.068`.
     */
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);
    orchestrator.dispatch({ type: 'PTT_UP', ts: Date.now() });
    await waitFor(() => server.text.includes('{"type":"audio.done"}'));

    server.partial({ text: 'The first half of it.', speechFinal: true, language: 'en' });
    await waitFor(() => orchestrator.snapshot.ctx.committed.length === 1);
    // Nothing has been typed yet — this is the assertion the old behaviour failed.
    expect(helper.inserted).toEqual([]);
    expect(orchestrator.snapshot.state).toBe('processing');

    server.partial({ text: 'And the second half.', speechFinal: true, language: 'en' });
    server.done(9.5);

    await waitFor(() => orchestrator.snapshot.state === 'idle');
    expect(helper.inserted).toEqual(['The first half of it. And the second half.']);
    expect(history.entries).toHaveLength(1);
  });

  it('still ends the turn and types the text when transcript.done never arrives', async () => {
    /**
     * The hang BUG-4 must not create. Insertion now waits for
     * `transcript.done`, so the question "what if it never comes?" has to have
     * an answer: **`FINISH_TIMEOUT_MS` in `src/main/stt/client.ts`**, armed by
     * `finish()` and shortened here to keep the test quick. It synthesises
     * `onDone(null)` → `TURN_ENDED`, which reaches `endTurn` and inserts what
     * the turn had. The server below sends the final and then nothing at all:
     * no `done`, no close.
     */
    orchestrator.dispose();
    buildOrchestrator({ finishMs: 300 });

    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);
    server.partial({ text: 'Der Server bleibt stumm.', speechFinal: true, language: 'de' });
    await waitFor(() => orchestrator.snapshot.ctx.committed.length === 1);
    orchestrator.dispatch({ type: 'PTT_UP', ts: Date.now() });

    await waitFor(() => orchestrator.snapshot.state === 'idle', 5000);
    expect(helper.inserted).toEqual(['Der Server bleibt stumm.']);
    expect(hud.last).toMatchObject({ kind: 'inserted' });
    expect(history.entries).toHaveLength(1);
  });

  it('carries transcript.done.duration into the history row', async () => {
    //  and §11.1.6 both want this field — it is the only
    // audio-seconds figure available, and the one to compare against billing
    // when answering §9.1.
    //
    // Until Phase 5 it never arrived. The frames are ordered:
    //
    //   `speech_final`    → `TRANSCRIPT_FINAL` → `beginInsert` → `inserting`
    //   `transcript.done` → `TURN_ENDED`       → *ignored in `inserting`*
    //   `INSERT_RESULT`   → `finishInsert`     → history row reads
    //                                            `ctx.durationSec`, still null
    //
    // and the first two arrive in the same millisecond in every captured
    // session (`docs/spike-raw/02a-done-ep400.jsonl`), so `inserting` is always
    // the state the duration lands in. Every row in the user's real
    // `history.json` had `durationSec: null`, including the ones written by
    // this client (docs/phase-3-report.md §5.1, docs/phase-4-report.md §5.4).
    // `reduceInserting` now absorbs it.
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);
    orchestrator.dispatch({ type: 'PTT_UP', ts: Date.now() });
    await waitFor(() => server.text.length > 0);

    server.partial({ text: 'Kurz und gut.', speechFinal: true, language: 'de' });
    server.done(12.865);
    await waitFor(() => orchestrator.snapshot.state === 'idle');

    expect(history.entries[0]?.durationSec).toBe(12.865);
  });

  it('does not lose the audio captured during the handshake', async () => {
    server.autoCreate = false;
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);

    // Let a few hundred milliseconds of audio pile up with no session yet — the
    // real handshake measured 518-591 ms (docs/spike-results.md).
    await new Promise((r) => setTimeout(r, 250));
    expect(server.binary).toHaveLength(0);
    server.created();

    await waitFor(() => server.binary.length > 15, 3000);
    expect(server.binary.every((b) => b.byteLength === CHUNK_BYTES)).toBe(true);

    orchestrator.dispatch({ type: 'CANCEL' });
  });

  it('accumulates several speech_finals from one hold into a single insertion', async () => {
    // Spike 4: 15 minutes of speech produced 70 `speech_final` segments. An
    // implementation that inserted per final would have typed 70 fragments.
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);

    server.partial({ text: 'First sentence.', speechFinal: true, language: 'en' });
    server.partial({ text: 'Second sentence.', speechFinal: true, language: 'en' });
    await waitFor(() => orchestrator.snapshot.ctx.committed.length === 2);

    orchestrator.dispatch({ type: 'PTT_UP', ts: Date.now() });
    await waitFor(() => server.text.length > 0);
    server.done(6.5);

    await waitFor(() => orchestrator.snapshot.state === 'idle');
    expect(helper.inserted).toEqual(['First sentence. Second sentence.']);
    expect(history.entries).toHaveLength(1);
  });

  it('sends the configured keyterms on the wire', async () => {
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);
    const url = new URL(server.requests[0]?.url ?? '', 'ws://x');
    expect(url.searchParams.getAll('keyterm')).toEqual(['kubectl']);
    // Default `languageMode: 'auto'` omits the parameter (spike 1 and 3).
    expect(url.searchParams.has('language')).toBe(false);
    orchestrator.dispatch({ type: 'CANCEL' });
  });

  it('surfaces a mid-utterance disconnect as an actionable error, typing nothing', async () => {
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);
    await waitFor(() => server.binary.length > 2);
    server.reset(); // the network went away

    await waitFor(() => hud.last?.kind === 'error');
    const view = hud.last;
    expect(view?.kind).toBe('error');
    if (view?.kind !== 'error') return;
    expect(view.hint).toContain('network');
    expect(helper.inserted).toEqual([]);
    expect(history.entries).toHaveLength(0);
  });

  it('ends the turn when the server resets after audio.done without a done frame', async () => {
    orchestrator.dispatch({ type: 'PTT_DOWN', ts: Date.now() });
    await server.waitForConnections(1);
    server.partial({ text: 'Kurz.', speechFinal: true, language: 'de' });
    await waitFor(() => orchestrator.snapshot.ctx.committed.length === 1);

    orchestrator.dispatch({ type: 'PTT_UP', ts: Date.now() });
    await waitFor(() => server.text.length > 0);
    // Exactly what the real endpoint does: 1006, no closing handshake.
    server.reset();

    await waitFor(() => orchestrator.snapshot.state === 'idle');
    expect(helper.inserted).toEqual(['Kurz.']);
    // The benign-close filter is what stops this being an error toast.
    expect(hud.last?.kind).toBe('inserted');
  });
});
