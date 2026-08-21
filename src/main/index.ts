/**
 * Composition root.
 *
 * Phase 1 wrote this and froze it, so that Phases 2–4 could each replace an
 * implementation behind a factory without ever touching the file — which is
 * what made those three merges conflict-free by construction
 * (IMPLEMENTATION-PLAN.md §2). It worked: none of them edited it.
 *
 * The cost only became visible once all three landed. Phase 4 could not be
 * handed the config store, the history store or the HUD, so it reached them
 * through module-level singletons and started its whole main-process surface as
 * a side effect of `createTray`. It could not reach the state machine either,
 * so Escape-to-cancel went through `ipcMain.emit` with a synthetic event. Phase
 * 3 could not be handed the capture messages, so it added a second listener on
 * the same channel — and every 100 ms chunk was logged here as "unhandled"
 * (docs/phase-3-report.md §5.4, docs/phase-4-report.md §5.5).
 *
 * Phase 5 is the only phase allowed to cross those boundaries, so the freeze is
 * lifted and everything is wired explicitly: one `ipcMain.on` listener for the
 * whole application, no module singletons, no synthetic IPC events.
 */

import { app, globalShortcut, ipcMain, safeStorage, shell } from 'electron';
import {
  INVOKE_CHANNEL,
  RENDERER_TO_MAIN_CHANNEL,
  type AppSnapshot,
  type InvokeRequest,
  type InvokeResponse,
  type MainToRenderer,
  type RendererToMain,
} from '@contracts/events.js';
import { AppConfigSchema } from '@contracts/config.js';
import { addLogSink, consoleSink, createLogger, setLogLevel } from '@shared/logger.js';
import { appError } from '@shared/result.js';
import { envString } from '@shared/env.js';
import { createAudioSource } from './audio/index.js';
import { createAuthProvider } from './auth/index.js';
import { CredentialStore, credentialsPath } from './auth/store.js';
import { GrokCliRenewer } from './auth/renew.js';
import { fileSink, logFilePath } from './log-file.js';
import { createConfigStore } from './config/index.js';
import { createHistoryStore } from './history/index.js';
import { createHud } from './hud/index.js';
import { createHudPreview } from './hud/preview.js';
import { createNativeHelper } from './native/index.js';
import { createSound } from './sound/index.js';
import { createSttClient } from './stt/index.js';
import { createTray } from './tray/index.js';
import { Orchestrator } from './state/orchestrator.js';
import { createUiServices } from './ui/index.js';
import { PanelWindows } from './ui/panels.js';
import { SignInWindow } from './ui/signin.js';

// Everything goes through the redacting logger; nothing calls console directly
// (enforced by the `no-console` rule in eslint.config.js). This is the one
// sanctioned stdout writer, and it only ever receives already-redacted text.

addLogSink(consoleSink((line) => process.stdout.write(`${line}\n`)));

/**
 * Debug while developing; info in a packaged build so a shared log file is
 * readable. The file sink still rotates at 2 MB.
 */
setLogLevel(app.isPackaged ? 'info' : 'debug');
const log = createLogger('app');

function isAllowedExternalUrl(url: string): boolean {
  return url.startsWith('https://console.x.ai/') || url.startsWith('https://docs.x.ai/');
}

function main(): void {
  // Menu-bar app: no dock icon.
  app.dock?.hide();

  let isQuitting = false;

  // A packaged menu-bar app has no terminal, so stdout goes nowhere and the
  // only record of what happened would be gone. See `log-file.ts`.
  const logsDir = app.getPath('logs');
  addLogSink(fileSink(logsDir));

  const userDataDir = app.getPath('userData');
  const config = createConfigStore(userDataDir, log);
  const history = createHistoryStore(userDataDir, log);
  const auth = createAuthProvider(log, {
    store: new CredentialStore(
      credentialsPath(userDataDir),
      {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain) => safeStorage.encryptString(plain),
        decrypt: (cipher) => safeStorage.decryptString(cipher),
      },
      log,
    ),
    envToken: envString('XAI_API_KEY'),
    // Spawns `grok models` so the CLI renews its own login. The app still never
    // touches a refresh token — see the header of `auth/renew.ts`.
    renewer: new GrokCliRenewer({ logger: log }),
    autoRenew: () => config.get().autoRenewLogin,
  });
  const panels = new PanelWindows(log);
  const signIn = new SignInWindow(log);
  const hud = createHud(log, (message) => {
    panels.broadcast(message);
    signIn.send(message);
  });
  const sound = createSound(log, () => hud.window);
  const { port: native, supervisor } = createNativeHelper(log);
  const audio = createAudioSource(log);
  const stt = createSttClient(log, auth);
  const preview = createHudPreview(hud);
  let signedIn = false;
  const tray = createTray({
    logger: log,
    config,
    history,
    onPermissions: (listener) => native.onPermissions(listener),
    openPanel: (panel) => panels.open(panel),
    previewHud: (view, delayMs) => {
      preview.show(view, delayMs);
    },
    getSignedIn: () => signedIn,
    onAuthChange: (listener) => auth.onChange(() => listener()),
    openSignIn: () => signIn.open(),
  });

  const broadcast = (message: MainToRenderer): void => {
    panels.broadcast(message);
    signIn.send(message);
  };

  auth.onChange((status) => {
    signedIn = status.state === 'signed-in';
    broadcast({ type: 'auth-updated', status });
    if (status.state === 'signed-in') signIn.close();
  });

  // Escape is caught by a global shortcut, which the UI services own, and it
  // has to reach the machine — which does not exist yet. One assignment breaks
  // the cycle, and it is a great deal less surprising than Phase 4's
  // `ipcMain.emit` with a synthetic event (docs/phase-4-report.md §5.5).
  let cancelFromEscape = (): void => {};

  const ui = createUiServices({
    app,
    globalShortcut,
    config,
    history,
    panels,
    logger: log,
    onCancel: () => {
      cancelFromEscape();
    },
  });

  const orchestrator = new Orchestrator({
    native,
    audio,
    stt,
    hud,
    tray,
    sound,
    history,
    config,
    logger: log,
    onChange: (snapshot) => {
      // Every transition, not only the ones that emit a `tray` effect — which
      // is what makes Escape arm and disarm reliably (see `src/main/ui/`).
      ui.setSessionState(snapshot.state);
      broadcast({
        type: 'state',
        state: snapshot.state,
        mode: snapshot.ctx.mode,
        sessionId: snapshot.ctx.sessionId,
      });
    },
  });

  cancelFromEscape = () => {
    orchestrator.dispatch({ type: 'CANCEL' });
  };

  orchestrator.start();

  native.onSecureInput((enabled) => {
    broadcast({ type: 'secure-input', enabled });
  });

  /**
   * A helper that is not coming back has to be visible.
   *
   * The supervisor restarts a dead helper with backoff and gives up after ten
   * consecutive failures, at which point the Fn key is dead, insertion is dead,
   * and — until Phase 5 — the only trace was a log line the user never sees.
   * That is  whole thesis: "no error, no log, no crash — the
   * hotkey simply stops responding", which reads as "my app is broken".
   *
   * Only the permanent case surfaces. A restart takes a few hundred
   * milliseconds and nagging about each one would train the user to ignore the
   * pill.
   */
  supervisor.onExit((info) => {
    if (info.willRestart) return;
    if (isQuitting) return;
    orchestrator.reportError(
      'helper_unavailable',
      'The Grok Dictate input helper stopped and could not be restarted.',
      'The Fn key and text insertion are not working. Quit and reopen Grok Dictate; if it keeps happening, rebuild the helper with `./native/build.sh`.',
    );
  });

  /* ---- renderer → main: the only listener on this channel ---- */
  ipcMain.on(RENDERER_TO_MAIN_CHANNEL, (event, message: RendererToMain) => {
    // Capture frames arrive every 100 ms and may only come from the hidden
    // capture renderer — without the sender check any window could inject PCM
    // into a live session.
    if (message.type.startsWith('capture-')) {
      if (audio.ownsSender(event.sender)) audio.handleRendererMessage(message);
      return;
    }

    switch (message.type) {
      case 'cancel':
        orchestrator.dispatch({ type: 'CANCEL' });
        return;
      case 'stop-recording':
        // The hands-free ✓. Same event a second Fn+Space dispatches, so the
        // machine treats both endings identically (overhaul §16.7).
        orchestrator.dispatch({ type: 'TOGGLE', ts: Date.now() });
        return;
      case 'dismiss-hud':
        hud.hide();
        return;
      case 'retry-insert':
        orchestrator.dispatch({ type: 'RETRY_INSERT' });
        return;
      case 'insert-text':
        orchestrator.dispatch({ type: 'INSERT_TEXT', text: message.text });
        return;
      case 'copy':
        // : the ONLY route to the pasteboard, and it can only be
        // reached from an explicit click in the HUD, history or the Scratchpad.
        orchestrator.copyToClipboard(message.text);
        return;
      case 'set-language-mode':
        void config.set({ ...config.get(), languageMode: message.mode });
        return;
      case 'open-window':
        if (message.window === 'signin') {
          void signIn.open().catch((cause: unknown) => {
            log.error('could not open the sign-in window', { err: cause });
          });
          return;
        }
        void panels.open(message.window).catch((cause: unknown) => {
          log.error('could not open a panel', { window: message.window, err: cause });
        });
        return;
      case 'capture-chunk':
      case 'capture-level':
      case 'capture-error':
      case 'capture-started':
        // Handled by the `capture-` branch above; named so the switch stays
        // exhaustive and a new message type is a compile error.
        return;
    }
  });

  /* ---- renderer ⇄ main request/response ---- */
  ipcMain.handle(
    INVOKE_CHANNEL,
    async (_event, request: InvokeRequest): Promise<InvokeResponse> => {
      switch (request.type) {
        case 'get-config':
          return { type: 'config', config: config.get() };
        case 'set-config': {
          const parsed = AppConfigSchema.safeParse(request.config);
          if (!parsed.success) {
            return {
              type: 'error',
              error: appError(
                'config_invalid',
                'Those settings are not valid.',
                parsed.error.message,
              ),
            };
          }
          await config.set(parsed.data);
          return { type: 'config', config: parsed.data };
        }
        case 'get-history':
          return { type: 'history', entries: await history.list(request.query, request.limit) };
        case 'purge-history':
          await history.purge();
          return { type: 'ok' };
        case 'get-snapshot': {
          const snapshot: AppSnapshot = orchestrator.appSnapshot;
          return { type: 'snapshot', snapshot };
        }
        case 'get-auth-status':
          return { type: 'auth-status', status: await auth.status() };
        case 'set-api-key': {
          const result = await auth.setApiKey(request.key);
          if (!result.ok) return { type: 'error', error: result.error };
          return { type: 'auth-status', status: result.value };
        }
        case 'clear-api-key':
          return { type: 'auth-status', status: await auth.clearApiKey() };
        case 'open-external': {
          if (!isAllowedExternalUrl(request.url)) {
            return {
              type: 'error',
              error: appError(
                'internal',
                'That link is not allowed.',
                'Grok Dictate only opens the xAI console and documentation.',
              ),
            };
          }
          await shell.openExternal(request.url);
          return { type: 'ok' };
        }
      }
    },
  );

  void app.whenReady().then(async () => {
    await hud.create();
    ui.ready();
    // Before deciding whether to put a sign-in window in front of the user:
    // a token that expired while the app was closed is the CLI's to renew, and
    // asking it takes about a second. Awaited so the decision below sees the
    // outcome rather than racing it.
    await auth.renewIfExpiringSoon();
    const status = await auth.refresh();
    log.info('grok-dictate ready', {
      helper: native.isReady,
      configIssues: config.loadIssues.length,
      logFile: logFilePath(logsDir),
      auth: status.state === 'signed-in' ? status.source : status.state,
    });
    if (status.state !== 'signed-in') {
      await signIn.open();
    }
    // From here the token is kept alive in the background, so a dictation should
    // never meet an expired one.
    auth.startAutoRenew();
  });

  app.on('window-all-closed', () => {
    // A menu-bar app stays alive with no windows open.
  });

  app.on('before-quit', () => {
    // `native.shutdown()` stops the helper, which reports an exit that is not
    // going to restart — correct, and not something to put on screen while the
    // app is closing.
    isQuitting = true;
    auth.stopAutoRenew();
    orchestrator.dispose();
    ui.dispose();
    preview.dispose();
    hud.destroy();
    void native.shutdown();
  });
}

main();
