/* A WebSocket client built on `node:net`: the package may not depend on `ws`
 * and Node 20 has no global WebSocket. DevTools only needs text frames, so
 * this is RFC 6455 minus extensions and compression, and it only ever dials
 * loopback because Chrome's debugging port is never reachable from elsewhere.
 */

import { createHash, randomBytes } from "node:crypto";
import { connect, type Socket } from "node:net";

const WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;
const MAX_BUFFERED_BYTES = MAX_FRAME_BYTES + 14;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

const CONTINUATION = 0;
const TEXT = 1;
const BINARY = 2;
const CLOSE = 8;
const PING = 9;
const PONG = 10;

/** The tiny surface the DevTools connection needs from a WebSocket. */
export interface WsSocket {
  send(text: string): void;
  onMessage(handler: (text: string) => void): void;
  onClose(handler: (reason: string) => void): void;
  close(): void;
}

export interface ConnectWsOptions {
  readonly timeoutMs?: number;
}

class WsProtocolError extends Error {}

interface DecodedFrame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/** Base64 of the SHA-1 the server proves it read our key. */
export function acceptKey(key: string): string {
  return createHash("sha1")
    .update(key + WEB_SOCKET_GUID)
    .digest("base64");
}

/** One frame; `mask` is true for frames a client sends and false for a server. */
export function encodeFrame(
  opcode: number,
  payload: Buffer,
  mask: boolean,
): Buffer {
  const maskKey = mask ? randomBytes(4) : null;
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length < 65_536 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + (maskKey ? 4 : 0) + length);
  frame.writeUInt8(0x80 | (opcode & 0x0f), 0);
  let offset = 2;
  if (length < 126) {
    frame.writeUInt8((maskKey ? 0x80 : 0) | length, 1);
  } else if (length < 65_536) {
    frame.writeUInt8((maskKey ? 0x80 : 0) | 126, 1);
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame.writeUInt8((maskKey ? 0x80 : 0) | 127, 1);
    frame.writeBigUInt64BE(BigInt(length), 2);
    offset = 10;
  }
  if (!maskKey) {
    payload.copy(frame, offset);
    return frame;
  }
  maskKey.copy(frame, offset);
  offset += 4;
  for (let index = 0; index < length; index += 1) {
    const masked =
      payload.readUInt8(index) ^ maskKey.readUInt8(index % maskKey.length);
    frame.writeUInt8(masked, offset + index);
  }
  return frame;
}

/** Reassembles frames from arbitrary TCP chunks, one frame at a time. */
class FrameDecoder {
  #buffered: Buffer = Buffer.alloc(0);

  push(chunk: Buffer): DecodedFrame[] {
    this.#buffered =
      this.#buffered.length === 0
        ? chunk
        : Buffer.concat([this.#buffered, chunk]);
    const frames: DecodedFrame[] = [];
    for (;;) {
      const next = this.#next();
      if (next === null) break;
      frames.push(next.frame);
      this.#buffered = next.rest;
    }
    if (this.#buffered.length > MAX_BUFFERED_BYTES) {
      throw new WsProtocolError("ws: unread frame bytes exceed the limit");
    }
    return frames;
  }

  #next(): { frame: DecodedFrame; rest: Buffer } | null {
    const buffered = this.#buffered;
    if (buffered.length < 2) return null;
    const first = buffered.readUInt8(0);
    const second = buffered.readUInt8(1);
    const fin = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (buffered.length < 4) return null;
      length = buffered.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (buffered.length < 10) return null;
      const declared = buffered.readBigUInt64BE(2);
      if (declared > BigInt(MAX_FRAME_BYTES)) {
        throw new WsProtocolError(
          `ws: frame of ${declared.toString()} bytes exceeds the 64 MiB limit`,
        );
      }
      length = Number(declared);
      offset = 10;
    }
    if (length > MAX_FRAME_BYTES) {
      throw new WsProtocolError(
        `ws: frame of ${length} bytes exceeds the 64 MiB limit`,
      );
    }
    // RFC 6455: servers must not mask, clients must. Treat the other way round
    // as a broken peer rather than trying to read a frame we cannot trust.
    if (masked)
      throw new WsProtocolError("ws: server frame must not be masked");
    if (buffered.length < offset + length) return null;
    return {
      frame: {
        fin,
        opcode,
        payload: buffered.subarray(offset, offset + length),
      },
      rest: buffered.subarray(offset + length),
    };
  }
}

class NetWsSocket implements WsSocket {
  readonly #socket: Socket;
  readonly #decoder = new FrameDecoder();
  #messageHandler: ((text: string) => void) | null = null;
  #closeHandler: ((reason: string) => void) | null = null;
  #queued: string[] = [];
  #closed = false;
  #closeNotified = false;
  #closeReason: string | null = null;
  #fragments: Buffer[] | null = null;
  #fragmentOpcode = 0;

  constructor(socket: Socket) {
    this.#socket = socket;
    socket.setNoDelay(true);
    socket.on("data", (chunk: Buffer) => {
      this.#receive(chunk);
    });
    socket.on("error", (error: Error) => {
      this.#shutdown(`ws: ${error.message}`);
    });
    socket.on("close", () => {
      this.#closed = true;
      this.#notifyClose(this.#closeReason ?? "ws: socket closed");
    });
  }

  pushData(chunk: Buffer): void {
    if (chunk.length > 0) this.#receive(chunk);
  }

  send(text: string): void {
    if (this.#closed)
      throw new Error("ws: cannot send after the socket closed");
    this.#writeFrame(TEXT, Buffer.from(text, "utf8"));
  }

  onMessage(handler: (text: string) => void): void {
    this.#messageHandler = handler;
    const queued = this.#queued;
    this.#queued = [];
    for (const text of queued) handler(text);
  }

  onClose(handler: (reason: string) => void): void {
    this.#closeHandler = handler;
    if (this.#closeNotified) handler(this.#closeReason ?? "ws: socket closed");
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    try {
      this.#writeFrame(CLOSE, Buffer.alloc(0));
    } catch {
      // The socket may already be gone; destroying below is what matters.
    }
    this.#socket.destroy();
    this.#notifyClose("ws: closed by the client");
  }

  #receive(chunk: Buffer): void {
    let frames: DecodedFrame[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (error) {
      this.#protocolFailure(error);
      return;
    }
    for (const frame of frames) this.#handleFrame(frame);
  }

  #handleFrame(frame: DecodedFrame): void {
    if (frame.opcode >= CLOSE) {
      if (!frame.fin || frame.payload.length > 125) {
        this.#protocolFailure(new WsProtocolError("ws: bad control frame"));
        return;
      }
      if (frame.opcode === PING) {
        this.#writeFrame(PONG, frame.payload);
        return;
      }
      if (frame.opcode === PONG) return;
      if (frame.opcode !== CLOSE) {
        this.#protocolFailure(
          new WsProtocolError(`ws: unknown control opcode ${frame.opcode}`),
        );
        return;
      }
      const reason = describeClose(frame.payload);
      this.#closeReason = reason;
      try {
        this.#writeFrame(CLOSE, Buffer.alloc(0));
      } catch {
        // Peer is already leaving; the destroy below still unblocks us.
      }
      this.#shutdown(reason);
      return;
    }

    if (frame.opcode === CONTINUATION) {
      if (this.#fragments === null) {
        this.#protocolFailure(new WsProtocolError("ws: stray continuation"));
        return;
      }
      this.#fragments.push(frame.payload);
      if (frame.fin) this.#deliverFragment();
      return;
    }

    if (frame.fin) {
      this.#deliver(frame.opcode, frame.payload);
      return;
    }
    if (this.#fragments !== null) {
      this.#protocolFailure(
        new WsProtocolError("ws: fragment started inside a fragment"),
      );
      return;
    }
    this.#fragments = [frame.payload];
    this.#fragmentOpcode = frame.opcode;
  }

  #deliverFragment(): void {
    const fragments = this.#fragments ?? [];
    const opcode = this.#fragmentOpcode;
    this.#fragments = null;
    this.#deliver(opcode, Buffer.concat(fragments));
  }

  #deliver(opcode: number, payload: Buffer): void {
    // Binary frames are not part of the DevTools protocol; ignore them rather
    // than fail a session over a peer that sends something extra.
    if (opcode !== TEXT) return;
    if (this.#closed) return;
    const text = payload.toString("utf8");
    if (this.#messageHandler !== null) this.#messageHandler(text);
    else this.#queued.push(text);
  }

  #writeFrame(opcode: number, payload: Buffer): void {
    this.#socket.write(encodeFrame(opcode, payload, true));
  }

  #protocolFailure(error: unknown): void {
    if (this.#closed) return;
    const payload = Buffer.alloc(2);
    payload.writeUInt16BE(1002, 0);
    try {
      this.#writeFrame(CLOSE, payload);
    } catch {
      // Writing here is best effort; the shutdown below is the real cleanup.
    }
    this.#shutdown(
      error instanceof Error ? error.message : "ws: protocol failure",
    );
  }

  #shutdown(reason: string): void {
    if (!this.#closed) {
      this.#closed = true;
      this.#socket.destroy();
    }
    this.#notifyClose(reason);
  }

  #notifyClose(reason: string): void {
    if (this.#closeNotified) return;
    this.#closeNotified = true;
    this.#closeReason = reason;
    this.#closeHandler?.(reason);
  }
}

function describeClose(payload: Buffer): string {
  if (payload.length < 2) return "ws: closed by the peer";
  const code = payload.readUInt16BE(0);
  const text = payload.subarray(2).toString("utf8").trim();
  return text.length > 0
    ? `ws: closed by the peer (${code} ${text})`
    : `ws: closed by the peer (${code})`;
}

function parseLoopbackTarget(url: string): {
  host: string;
  port: number;
  path: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ws: not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "ws:") {
    throw new Error(
      `ws: only ws:// URLs are supported, got ${parsed.protocol}`,
    );
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `ws: refusing to connect to ${parsed.hostname}; only 127.0.0.1 and localhost are allowed`,
    );
  }
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`ws: invalid port in ${url}`);
  }
  return {
    host: parsed.hostname,
    port,
    path: `${parsed.pathname === "" ? "/" : parsed.pathname}${parsed.search}`,
  };
}

function findHeaderEnd(
  buffer: Buffer,
): { index: number; length: number } | null {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { index: crlf, length: 4 };
  // Some peers answer with bare LF line endings; the header block itself is
  // still usable, so accept it rather than hang on the timeout.
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { index: lf, length: 2 };
  return null;
}

function parseHandshake(head: string): { status: number; accept: string } {
  const lines = head.split("\r\n").flatMap((line) => line.split("\n"));
  const statusLine = (lines.shift() ?? "").trim();
  const statusMatch = /^HTTP\/\d\.\d\s+(\d{3})/.exec(statusLine);
  if (statusMatch === null) {
    throw new Error("ws: malformed handshake status line");
  }
  const status = Number.parseInt(statusMatch[1] ?? "", 10);
  let accept = "";
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (name === "sec-websocket-accept") {
      accept = line.slice(colon + 1).trim();
    }
  }
  return { status, accept };
}

/**
 * Opens a WebSocket to a Chrome debugging endpoint on this machine.
 *
 * The handshake is verified here rather than trusted: a non-101 answer, a wrong
 * `Sec-WebSocket-Accept`, or a non-loopback URL all fail before any traffic is
 * treated as protocol data.
 */
export async function connectWs(
  url: string,
  options: ConnectWsOptions = {},
): Promise<WsSocket> {
  const target = parseLoopbackTarget(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = randomBytes(16).toString("base64");

  return await new Promise<WsSocket>((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let timer: NodeJS.Timeout;
    let socket: Socket;

    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    const onHandshakeData = (chunk: Buffer): void => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = findHeaderEnd(buffer);
      if (end === null) {
        if (buffer.length > MAX_HEADER_BYTES) {
          fail(new Error("ws: handshake response headers are too large"));
        }
        return;
      }
      socket.off("data", onHandshakeData);
      socket.off("error", onHandshakeError);
      socket.off("close", onHandshakeClose);
      let handshake: { status: number; accept: string };
      try {
        handshake = parseHandshake(
          buffer.subarray(0, end.index).toString("latin1"),
        );
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (handshake.status !== 101) {
        fail(new Error(`ws: handshake rejected with HTTP ${handshake.status}`));
        return;
      }
      const expected = acceptKey(key);
      if (handshake.accept !== expected) {
        fail(
          new Error(
            "ws: handshake returned an unexpected Sec-WebSocket-Accept",
          ),
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      const wsSocket = new NetWsSocket(socket);
      // Frames may share the TCP chunk with the handshake response; deliver
      // them after the handlers are attached so nothing is lost.
      wsSocket.pushData(buffer.subarray(end.index + end.length));
      resolve(wsSocket);
    };

    const onHandshakeError = (error: Error): void => {
      fail(new Error(`ws: ${error.message}`));
    };

    const onHandshakeClose = (): void => {
      fail(new Error("ws: socket closed during the handshake"));
    };

    socket = connect({ host: target.host, port: target.port });
    socket.on("data", onHandshakeData);
    // Attaching a listener now means a connection error can never escape as an
    // uncaught 'error' event, even after the handshake finished.
    socket.on("error", onHandshakeError);
    socket.on("close", onHandshakeClose);
    timer = setTimeout(() => {
      fail(new Error(`ws: handshake timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    socket.write(
      [
        `GET ${target.path} HTTP/1.1`,
        `Host: ${target.host}:${target.port}`,
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Key: ${key}`,
        "Sec-WebSocket-Version: 13",
        "",
        "",
      ].join("\r\n"),
    );
  });
}
