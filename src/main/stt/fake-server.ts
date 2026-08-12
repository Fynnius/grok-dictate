/**
 * A controllable stand-in for `wss://api.x.ai/v1/stt`, for tests.
 *
 * Deliberately a **real** `ws` server on a loopback port rather than a fake
 * socket object. The parts of the STT client most likely to break are the ones a
 * fake socket cannot exercise: the handshake, non-101 responses and their
 * headers, close codes with no closing handshake (spike 2's
 * 1006), binary frame delivery, and back-pressure. A fake would prove that the
 * client calls methods on a fake.
 *
 * The frames it emits are copied from the captured spike sessions in
 * `docs/spike-raw/*.jsonl`, so the tests assert against what the server really
 * sent, including the fields the Grok CLI drops.
 *
 * Not shipped: nothing in `src/main` imports this outside `*.test.ts`.
 */

import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';

export interface ObservedRequest {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}

export interface HandshakeRejection {
  readonly status: number;
  readonly headers?: Record<string, string>;
}

/** Fields of a real `transcript.partial`; see `docs/spike-raw/01-de-lang-de.jsonl`. */
export interface PartialFrame {
  readonly text: string;
  readonly isFinal?: boolean;
  readonly speechFinal?: boolean;
  readonly language?: string;
}

export type ClientMessage =
  | { readonly kind: 'binary'; readonly data: Buffer }
  | { readonly kind: 'text'; readonly data: string };

export class FakeSttServer {
  readonly requests: ObservedRequest[] = [];
  /**
   * Everything the client sent, interleaved. Ordering matters: the backlog must
   * reach the server *before* `audio.done`, or the server ends the turn without
   * the audio.
   */
  readonly messages: ClientMessage[] = [];
  /** PCM the client sent, in the order it arrived. */
  readonly binary: Buffer[] = [];
  /** JSON control messages the client sent (`audio.done` / `finalize`). */
  readonly text: string[] = [];
  readonly sockets: ServerSocket[] = [];

  /** Handshakes to reject before accepting, shifted one per attempt. */
  readonly rejections: HandshakeRejection[] = [];
  /** When false, the test drives `transcript.created` by hand. */
  autoCreate = true;

  #http: Server;
  #wss: WebSocketServer;
  #port = 0;

  private constructor(http: Server, wss: WebSocketServer) {
    this.#http = http;
    this.#wss = wss;
  }

  static async start(): Promise<FakeSttServer> {
    const http = createServer();
    // Bound late so the closure can see the instance.
    let self: FakeSttServer | null = null;
    const wss = new WebSocketServer({
      server: http,
      verifyClient: (info, cb) => {
        const server = self;
        if (server === null) {
          cb(true);
          return;
        }
        server.requests.push({ url: info.req.url ?? '', headers: info.req.headers });
        const rejection = server.rejections.shift();
        if (rejection !== undefined) {
          cb(false, rejection.status, 'rejected by the test', rejection.headers);
          return;
        }
        cb(true);
      },
    });

    const instance = new FakeSttServer(http, wss);
    self = instance;

    wss.on('connection', (socket) => {
      instance.sockets.push(socket);
      socket.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          const copy = Buffer.from(data);
          instance.binary.push(copy);
          instance.messages.push({ kind: 'binary', data: copy });
        } else {
          const decoded = data.toString('utf8');
          instance.text.push(decoded);
          instance.messages.push({ kind: 'text', data: decoded });
        }
      });
      if (instance.autoCreate) instance.created();
    });

    await new Promise<void>((resolve) => {
      http.listen(0, '127.0.0.1', resolve);
    });
    instance.#port = (http.address() as AddressInfo).port;
    return instance;
  }

  /** The `apiBase` to hand the client. `http:` becomes `ws:` in `buildSttUrl`. */
  get base(): string {
    return `http://127.0.0.1:${String(this.#port)}`;
  }

  get latest(): ServerSocket {
    const socket = this.sockets.at(-1);
    if (socket === undefined) throw new Error('no client has connected yet');
    return socket;
  }

  send(frame: unknown): void {
    this.latest.send(JSON.stringify(frame));
  }

  created(id = 'f078bb34-98f0-4104-b521-205955787fa6'): void {
    this.send({ type: 'transcript.created', id });
  }

  /** A partial with the full field set the server really sends (spike 1). */
  partial(frame: PartialFrame): void {
    this.send({
      type: 'transcript.partial',
      text: frame.text,
      words: [],
      is_final: frame.isFinal ?? false,
      speech_final: frame.speechFinal ?? false,
      start: 0,
      duration: 5.5,
      ...(frame.language === undefined ? {} : { language: frame.language }),
    });
  }

  /** `transcript.done` is a duration receipt, not a transcript. */
  done(durationSec = 12.865): void {
    this.send({ type: 'transcript.done', text: '', words: [], duration: durationSec });
  }

  serverError(message: string): void {
    this.send({ type: 'error', message });
  }

  /**
   * Drop the connection the way the real endpoint does: code 1006, no closing
   * handshake (docs/spike-results.md §2).
   */
  reset(): void {
    this.latest.terminate();
  }

  /**
   * Stop reading from the socket without closing it — the behaviour that broke
   * human test HT-5.
   *
   * Switching Wi-Fi off does not produce an error or a close: the client's
   * writes keep succeeding into the kernel send buffer and nothing ever comes
   * back. Pausing the server's socket reproduces that exactly, including the
   * part that matters — pings are never read, so no pong is sent.
   */
  blackhole(): void {
    this.latest.pause();
  }

  async waitForConnections(count: number, timeoutMs = 5000): Promise<void> {
    await waitFor(() => this.sockets.length >= count, timeoutMs, `${String(count)} connection(s)`);
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) socket.terminate();
    await new Promise<void>((resolve) => this.#wss.close(() => resolve()));
    await new Promise<void>((resolve) => this.#http.close(() => resolve()));
  }
}

export async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  what = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}
