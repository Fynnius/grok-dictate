/**
 * Sign in to grok.com inside a real Chromium browser so macOS passkeys work.
 *
 * Electron's grok.com window cannot show iCloud Keychain passkeys: it is not a
 * registered browser, and `app.configureWebAuthn({ touchID })` stores *new*
 * device-bound credentials in our keychain group — not the grok.com passkeys
 * already in iCloud. Chrome/Edge/Brave can use those passkeys. We open one
 * with a dedicated profile, wait for an `sso` / `sso-rw` cookie, then copy
 * grok.com / x.ai cookies into `persist:grok-com`.
 *
 * Never log cookie values.
 */

import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';
import { createServer, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import WebSocket from 'ws';
import type { Logger } from '@shared/logger.js';
import { appError, err, ok, type Result } from '@shared/result.js';
import type { GrokComCookieRecord, GrokComSession } from './grok-com.js';

const SIGN_IN_URL = 'https://grok.com/';
const POLL_MS = 750;
const TIMEOUT_MS = 10 * 60 * 1000;
const COOKIE_DOMAINS = ['grok.com', 'x.ai'];

export const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
] as const;

export function findChromeBinary(exists: (path: string) => boolean = existsSync): string | null {
  for (const path of CHROME_CANDIDATES) {
    if (exists(path)) return path;
  }
  return null;
}

export function cookieBelongsToGrok(domain: string): boolean {
  const host = domain.replace(/^\./, '').toLowerCase();
  return COOKIE_DOMAINS.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

export function cdpCookieToRecord(cookie: CdpCookie): GrokComCookieRecord | null {
  if (cookie.name.length === 0) return null;
  if (!cookieBelongsToGrok(cookie.domain)) return null;
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path.length > 0 ? cookie.path : '/',
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    ...(cookie.session || cookie.expires < 0 ? {} : { expirationDate: cookie.expires }),
  };
}

export interface CdpCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly session: boolean;
  readonly expires: number;
}

interface ChromePasskeyDeps {
  readonly logger: Logger;
  readonly grokCom: GrokComSession;
  readonly userDataDir: string;
  readonly exists?: (path: string) => boolean;
  readonly spawnChrome?: (binary: string, args: string[]) => ChildProcess;
  readonly now?: () => number;
}

export class ChromePasskeySignIn {
  readonly #log: Logger;
  readonly #grokCom: GrokComSession;
  readonly #userDataDir: string;
  readonly #exists: (path: string) => boolean;
  readonly #spawnChrome: (binary: string, args: string[]) => ChildProcess;
  readonly #now: () => number;
  #child: ChildProcess | null = null;
  #running: Promise<Result<void>> | null = null;

  constructor(deps: ChromePasskeyDeps) {
    this.#log = deps.logger.child('chrome-passkey');
    this.#grokCom = deps.grokCom;
    this.#userDataDir = deps.userDataDir;
    this.#exists = deps.exists ?? existsSync;
    this.#spawnChrome =
      deps.spawnChrome ?? ((binary, args) => spawn(binary, args, { stdio: 'ignore' }));
    this.#now = deps.now ?? Date.now;
  }

  get available(): boolean {
    return findChromeBinary(this.#exists) !== null;
  }

  async start(): Promise<Result<void>> {
    if (this.#running !== null) return this.#running;
    const run = this.#run();
    this.#running = run;
    try {
      return await run;
    } finally {
      this.#running = null;
    }
  }

  dispose(): void {
    this.#killChild();
  }

  async #run(): Promise<Result<void>> {
    const binary = findChromeBinary(this.#exists);
    if (binary === null) {
      return err(
        appError(
          'internal',
          'Chrome is not installed.',
          'Passkeys need Google Chrome, Edge, or Brave. Install one of those, or sign in with a password in the grok.com window.',
        ),
      );
    }

    const profile = join(this.#userDataDir, 'grok-com-chrome');
    await mkdir(profile, { recursive: true });
    const port = await freePort();
    const args = [
      `--user-data-dir=${profile}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${String(port)}`,
      '--no-first-run',
      '--no-default-browser-check',
      SIGN_IN_URL,
    ];

    this.#log.info('opening Chromium for passkey sign-in', { binary, port });
    const child = this.#spawnChrome(binary, args);
    this.#child = child;

    const deadline = this.#now() + TIMEOUT_MS;
    try {
      while (this.#now() < deadline) {
        if (child.exitCode !== null) {
          return err(
            appError(
              'auth_missing',
              'Chrome closed before sign-in finished.',
              'Open Settings and try Passkeys again, and stay on grok.com until it loads.',
            ),
          );
        }
        const cookies = await readCdpCookies(port).catch(() => null);
        if (cookies !== null) {
          const records = cookies
            .map(cdpCookieToRecord)
            .filter((cookie): cookie is GrokComCookieRecord => cookie !== null);
          const signedIn = records.some(
            (cookie) =>
              (cookie.name === 'sso' || cookie.name === 'sso-rw') && cookie.value.length > 0,
          );
          if (signedIn) {
            await this.#grokCom.importCookies(records);
            this.#log.info('imported grok.com session from Chrome', {
              names: records.map((cookie) => cookie.name),
            });
            return ok(undefined);
          }
        }
        await sleep(POLL_MS);
      }
      return err(
        appError(
          'auth_missing',
          'Timed out waiting for a grok.com passkey sign-in.',
          'Try again, and complete the passkey prompt in Chrome.',
        ),
      );
    } finally {
      this.#killChild();
    }
  }

  #killChild(): void {
    const child = this.#child;
    this.#child = null;
    if (child === null || child.killed) return;
    child.kill('SIGTERM');
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

async function readCdpCookies(port: number): Promise<CdpCookie[]> {
  const version = (await getJson(`http://127.0.0.1:${String(port)}/json/version`)) as {
    webSocketDebuggerUrl?: string;
  };
  const browserWs = version.webSocketDebuggerUrl;
  if (typeof browserWs === 'string' && browserWs.length > 0) {
    try {
      const result = await cdpCall(browserWs, 'Storage.getCookies', {});
      const cookies = (result as { cookies?: CdpCookie[] }).cookies;
      if (Array.isArray(cookies)) return cookies;
    } catch {
      /* older Chrome: fall through to a page target */
    }
  }

  const pages = (await getJson(`http://127.0.0.1:${String(port)}/json/list`)) as {
    webSocketDebuggerUrl?: string;
    url?: string;
  }[];
  const page =
    pages.find((entry) => typeof entry.url === 'string' && /grok\.com|x\.ai/.test(entry.url)) ??
    pages[0];
  const pageWs = page?.webSocketDebuggerUrl;
  if (typeof pageWs !== 'string' || pageWs.length === 0) {
    throw new Error('Chrome DevTools endpoint is not ready');
  }
  const result = await cdpCall(pageWs, 'Network.getAllCookies', {});
  const cookies = (result as { cookies?: CdpCookie[] }).cookies;
  return Array.isArray(cookies) ? cookies : [];
}

function websocketPayload(data: WebSocket.RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function getJson(url: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { timeout: 800 }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        } catch (cause) {
          reject(cause instanceof Error ? cause : new Error(String(cause)));
        }
      });
    });
    request.on('error', reject);
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('timeout'));
    });
  });
}

function cdpCall(wsUrl: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(wsUrl, { handshakeTimeout: 1500 });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error('cdp timeout'));
    }, 2500);
    timer.unref?.();
    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on('open', () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });
    socket.on('message', (data) => {
      clearTimeout(timer);
      try {
        const parsed = JSON.parse(websocketPayload(data)) as {
          id?: number;
          result?: unknown;
          error?: unknown;
        };
        if (parsed.id !== 1) return;
        socket.close();
        if (parsed.error !== undefined) reject(new Error('cdp error'));
        else resolve(parsed.result ?? {});
      } catch (cause) {
        socket.terminate();
        reject(cause instanceof Error ? cause : new Error(String(cause)));
      }
    });
  });
}
