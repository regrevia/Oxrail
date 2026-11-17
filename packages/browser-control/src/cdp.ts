/* The DevTools connection the Browser Control route drives Chrome with:
 * requests matched to replies by id, events routed by method name, and one
 * clear error when the socket dies with work still in flight.
 */

import { connectWs, type WsSocket } from "./ws.js";

const CLOSED_BEFORE = "cdp: connection closed before ";

export type CdpHandler = (params: Record<string, unknown>) => void;

export interface CdpConnectionOptions {
  readonly timeoutMs?: number;
  /** Where event-handler failures go; never stdout, so a caller stays quiet. */
  readonly onError?: (error: unknown) => void;
}

/** The reply error object DevTools sends, kept usable for callers. */
export interface CdpError extends Error {
  code?: number;
  data?: unknown;
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface CdpReplyError {
  readonly code?: number;
  readonly message?: string;
  readonly data?: unknown;
}

interface CdpMessage {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: CdpReplyError;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

function toCdpError(error: CdpReplyError): CdpError {
  const failure: CdpError = new Error(error.message ?? "cdp: request failed");
  if (error.code !== undefined) failure.code = error.code;
  if (error.data !== undefined) failure.data = error.data;
  return failure;
}

export class CdpConnection {
  readonly #socket: WsSocket;
  readonly #onError: (error: unknown) => void;
  readonly #handlers = new Map<string, CdpHandler[]>();
  readonly #pending = new Map<number, PendingRequest>();
  #nextId = 1;
  #closed = false;

  /**
   * Wraps an already-open socket. `connect` is the usual entry point; this is
   * public so the transport can be replaced in tests.
   */
  constructor(socket: WsSocket, options: CdpConnectionOptions = {}) {
    this.#socket = socket;
    this.#onError = options.onError ?? (() => undefined);
    socket.onMessage((text) => {
      this.#receive(text);
    });
    socket.onClose(() => {
      this.#handleSocketClose();
    });
  }

  static async connect(
    wsUrl: string,
    options: CdpConnectionOptions = {},
  ): Promise<CdpConnection> {
    const socket = await connectWs(
      wsUrl,
      options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs },
    );
    return new CdpConnection(socket, options);
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T> {
    if (this.#closed)
      return Promise.reject(new Error("cdp: connection closed"));
    const id = this.#nextId;
    this.#nextId += 1;
    const message: Record<string, unknown> = { id, method };
    if (params !== undefined) message.params = params;
    if (sessionId !== undefined) message.sessionId = sessionId;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        method,
        resolve: (value) => {
          resolve(value as T);
        },
        reject,
      });
      try {
        this.#socket.send(JSON.stringify(message));
      } catch (error) {
        // The socket may have closed between the check and the write.
        this.#pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  on(method: string, handler: CdpHandler): void {
    const handlers = this.#handlers.get(method);
    if (handlers === undefined) this.#handlers.set(method, [handler]);
    else handlers.push(handler);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending();
    try {
      this.#socket.close();
    } catch {
      // Closing is best effort; the connection is already marked dead.
    }
  }

  #receive(text: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(text) as CdpMessage;
    } catch (error) {
      this.#report(error);
      return;
    }
    if (typeof message.id === "number") {
      this.#settle(message.id, message);
      return;
    }
    if (typeof message.method === "string") {
      // Session-scoped events still belong to their method; the handler only
      // ever wants the params, the route tracks sessions itself.
      this.#dispatch(message.method, message.params ?? {});
    }
  }

  #settle(id: number, message: CdpMessage): void {
    const pending = this.#pending.get(id);
    if (pending === undefined) return;
    this.#pending.delete(id);
    if (message.error !== undefined) {
      pending.reject(toCdpError(message.error));
      return;
    }
    pending.resolve(message.result);
  }

  #dispatch(method: string, params: Record<string, unknown>): void {
    const handlers = this.#handlers.get(method);
    if (handlers === undefined) return;
    for (const handler of handlers) {
      try {
        handler(params);
      } catch (error) {
        // A handler is caller code: it must not stall the reader for everyone
        // else, but the failure should still be visible to the owner.
        this.#report(error);
      }
    }
  }

  #handleSocketClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectPending();
  }

  #rejectPending(): void {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      pending.reject(new Error(`${CLOSED_BEFORE}${pending.method} answered`));
    }
  }

  #report(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // An error reporter that throws would break the only path that reports.
    }
  }
}
