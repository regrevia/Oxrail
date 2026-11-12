var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};

// packages/browser-control/src/types.ts
var RouteClosedError, StaleRefError;
var init_types = __esm({
  "packages/browser-control/src/types.ts"() {
    "use strict";
    RouteClosedError = class extends Error {
      name = "RouteClosedError";
    };
    StaleRefError = class extends Error {
      name = "StaleRefError";
    };
  }
});

// packages/browser-control/src/ws.ts
import { createHash, randomBytes } from "node:crypto";
import { connect } from "node:net";
function acceptKey(key) {
  return createHash("sha1").update(key + WEB_SOCKET_GUID).digest("base64");
}
function encodeFrame(opcode, payload, mask) {
  const maskKey = mask ? randomBytes(4) : null;
  const length = payload.length;
  const headerLength = length < 126 ? 2 : length < 65536 ? 4 : 10;
  const frame = Buffer.allocUnsafe(headerLength + (maskKey ? 4 : 0) + length);
  frame.writeUInt8(128 | opcode & 15, 0);
  let offset = 2;
  if (length < 126) {
    frame.writeUInt8((maskKey ? 128 : 0) | length, 1);
  } else if (length < 65536) {
    frame.writeUInt8((maskKey ? 128 : 0) | 126, 1);
    frame.writeUInt16BE(length, 2);
    offset = 4;
  } else {
    frame.writeUInt8((maskKey ? 128 : 0) | 127, 1);
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
    const masked = payload.readUInt8(index) ^ maskKey.readUInt8(index % maskKey.length);
    frame.writeUInt8(masked, offset + index);
  }
  return frame;
}
function describeClose(payload) {
  if (payload.length < 2) return "ws: closed by the peer";
  const code = payload.readUInt16BE(0);
  const text = payload.subarray(2).toString("utf8").trim();
  return text.length > 0 ? `ws: closed by the peer (${code} ${text})` : `ws: closed by the peer (${code})`;
}
function parseLoopbackTarget(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`ws: not a valid URL: ${url}`);
  }
  if (parsed.protocol !== "ws:") {
    throw new Error(
      `ws: only ws:// URLs are supported, got ${parsed.protocol}`
    );
  }
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `ws: refusing to connect to ${parsed.hostname}; only 127.0.0.1 and localhost are allowed`
    );
  }
  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`ws: invalid port in ${url}`);
  }
  return {
    host: parsed.hostname,
    port,
    path: `${parsed.pathname === "" ? "/" : parsed.pathname}${parsed.search}`
  };
}
function findHeaderEnd(buffer) {
  const crlf = buffer.indexOf("\r\n\r\n");
  if (crlf >= 0) return { index: crlf, length: 4 };
  const lf = buffer.indexOf("\n\n");
  if (lf >= 0) return { index: lf, length: 2 };
  return null;
}
function parseHandshake(head) {
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
async function connectWs(url, options = {}) {
  const target = parseLoopbackTarget(url);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const key = randomBytes(16).toString("base64");
  return await new Promise((resolve, reject) => {
    let settled = false;
    let buffer = Buffer.alloc(0);
    let timer;
    let socket;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };
    const onHandshakeData = (chunk) => {
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
      let handshake;
      try {
        handshake = parseHandshake(
          buffer.subarray(0, end.index).toString("latin1")
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
            "ws: handshake returned an unexpected Sec-WebSocket-Accept"
          )
        );
        return;
      }
      settled = true;
      clearTimeout(timer);
      const wsSocket = new NetWsSocket(socket);
      wsSocket.pushData(buffer.subarray(end.index + end.length));
      resolve(wsSocket);
    };
    const onHandshakeError = (error) => {
      fail(new Error(`ws: ${error.message}`));
    };
    const onHandshakeClose = () => {
      fail(new Error("ws: socket closed during the handshake"));
    };
    socket = connect({ host: target.host, port: target.port });
    socket.on("data", onHandshakeData);
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
        ""
      ].join("\r\n")
    );
  });
}
var WEB_SOCKET_GUID, DEFAULT_TIMEOUT_MS, MAX_FRAME_BYTES, MAX_HEADER_BYTES, MAX_BUFFERED_BYTES, LOOPBACK_HOSTS, CONTINUATION, TEXT, CLOSE, PING, PONG, WsProtocolError, FrameDecoder, NetWsSocket;
var init_ws = __esm({
  "packages/browser-control/src/ws.ts"() {
    "use strict";
    WEB_SOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
    DEFAULT_TIMEOUT_MS = 1e4;
    MAX_FRAME_BYTES = 64 * 1024 * 1024;
    MAX_HEADER_BYTES = 64 * 1024;
    MAX_BUFFERED_BYTES = MAX_FRAME_BYTES + 14;
    LOOPBACK_HOSTS = /* @__PURE__ */ new Set(["127.0.0.1", "localhost"]);
    CONTINUATION = 0;
    TEXT = 1;
    CLOSE = 8;
    PING = 9;
    PONG = 10;
    WsProtocolError = class extends Error {
    };
    FrameDecoder = class {
      #buffered = Buffer.alloc(0);
      push(chunk) {
        this.#buffered = this.#buffered.length === 0 ? chunk : Buffer.concat([this.#buffered, chunk]);
        const frames = [];
        for (; ; ) {
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
      #next() {
        const buffered = this.#buffered;
        if (buffered.length < 2) return null;
        const first = buffered.readUInt8(0);
        const second = buffered.readUInt8(1);
        const fin = (first & 128) !== 0;
        const opcode = first & 15;
        const masked = (second & 128) !== 0;
        let length = second & 127;
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
              `ws: frame of ${declared.toString()} bytes exceeds the 64 MiB limit`
            );
          }
          length = Number(declared);
          offset = 10;
        }
        if (length > MAX_FRAME_BYTES) {
          throw new WsProtocolError(
            `ws: frame of ${length} bytes exceeds the 64 MiB limit`
          );
        }
        if (masked)
          throw new WsProtocolError("ws: server frame must not be masked");
        if (buffered.length < offset + length) return null;
        return {
          frame: {
            fin,
            opcode,
            payload: buffered.subarray(offset, offset + length)
          },
          rest: buffered.subarray(offset + length)
        };
      }
    };
    NetWsSocket = class {
      #socket;
      #decoder = new FrameDecoder();
      #messageHandler = null;
      #closeHandler = null;
      #queued = [];
      #closed = false;
      #closeNotified = false;
      #closeReason = null;
      #fragments = null;
      #fragmentOpcode = 0;
      constructor(socket) {
        this.#socket = socket;
        socket.setNoDelay(true);
        socket.on("data", (chunk) => {
          this.#receive(chunk);
        });
        socket.on("error", (error) => {
          this.#shutdown(`ws: ${error.message}`);
        });
        socket.on("close", () => {
          this.#closed = true;
          this.#notifyClose(this.#closeReason ?? "ws: socket closed");
        });
      }
      pushData(chunk) {
        if (chunk.length > 0) this.#receive(chunk);
      }
      send(text) {
        if (this.#closed)
          throw new Error("ws: cannot send after the socket closed");
        this.#writeFrame(TEXT, Buffer.from(text, "utf8"));
      }
      onMessage(handler) {
        this.#messageHandler = handler;
        const queued = this.#queued;
        this.#queued = [];
        for (const text of queued) handler(text);
      }
      onClose(handler) {
        this.#closeHandler = handler;
        if (this.#closeNotified) handler(this.#closeReason ?? "ws: socket closed");
      }
      close() {
        if (this.#closed) return;
        this.#closed = true;
        try {
          this.#writeFrame(CLOSE, Buffer.alloc(0));
        } catch {
        }
        this.#socket.destroy();
        this.#notifyClose("ws: closed by the client");
      }
      #receive(chunk) {
        let frames;
        try {
          frames = this.#decoder.push(chunk);
        } catch (error) {
          this.#protocolFailure(error);
          return;
        }
        for (const frame of frames) this.#handleFrame(frame);
      }
      #handleFrame(frame) {
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
              new WsProtocolError(`ws: unknown control opcode ${frame.opcode}`)
            );
            return;
          }
          const reason = describeClose(frame.payload);
          this.#closeReason = reason;
          try {
            this.#writeFrame(CLOSE, Buffer.alloc(0));
          } catch {
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
            new WsProtocolError("ws: fragment started inside a fragment")
          );
          return;
        }
        this.#fragments = [frame.payload];
        this.#fragmentOpcode = frame.opcode;
      }
      #deliverFragment() {
        const fragments = this.#fragments ?? [];
        const opcode = this.#fragmentOpcode;
        this.#fragments = null;
        this.#deliver(opcode, Buffer.concat(fragments));
      }
      #deliver(opcode, payload) {
        if (opcode !== TEXT) return;
        if (this.#closed) return;
        const text = payload.toString("utf8");
        if (this.#messageHandler !== null) this.#messageHandler(text);
        else this.#queued.push(text);
      }
      #writeFrame(opcode, payload) {
        this.#socket.write(encodeFrame(opcode, payload, true));
      }
      #protocolFailure(error) {
        if (this.#closed) return;
        const payload = Buffer.alloc(2);
        payload.writeUInt16BE(1002, 0);
        try {
          this.#writeFrame(CLOSE, payload);
        } catch {
        }
        this.#shutdown(
          error instanceof Error ? error.message : "ws: protocol failure"
        );
      }
      #shutdown(reason) {
        if (!this.#closed) {
          this.#closed = true;
          this.#socket.destroy();
        }
        this.#notifyClose(reason);
      }
      #notifyClose(reason) {
        if (this.#closeNotified) return;
        this.#closeNotified = true;
        this.#closeReason = reason;
        this.#closeHandler?.(reason);
      }
    };
  }
});

// packages/browser-control/src/cdp.ts
function toCdpError(error) {
  const failure3 = new Error(error.message ?? "cdp: request failed");
  if (error.code !== void 0) failure3.code = error.code;
  if (error.data !== void 0) failure3.data = error.data;
  return failure3;
}
var CLOSED_BEFORE, CdpConnection;
var init_cdp = __esm({
  "packages/browser-control/src/cdp.ts"() {
    "use strict";
    init_ws();
    CLOSED_BEFORE = "cdp: connection closed before ";
    CdpConnection = class _CdpConnection {
      #socket;
      #onError;
      #handlers = /* @__PURE__ */ new Map();
      #pending = /* @__PURE__ */ new Map();
      #nextId = 1;
      #closed = false;
      /**
       * Wraps an already-open socket. `connect` is the usual entry point; this is
       * public so the transport can be replaced in tests.
       */
      constructor(socket, options = {}) {
        this.#socket = socket;
        this.#onError = options.onError ?? (() => void 0);
        socket.onMessage((text) => {
          this.#receive(text);
        });
        socket.onClose(() => {
          this.#handleSocketClose();
        });
      }
      static async connect(wsUrl, options = {}) {
        const socket = await connectWs(
          wsUrl,
          options.timeoutMs === void 0 ? {} : { timeoutMs: options.timeoutMs }
        );
        return new _CdpConnection(socket, options);
      }
      get closed() {
        return this.#closed;
      }
      send(method, params, sessionId) {
        if (this.#closed)
          return Promise.reject(new Error("cdp: connection closed"));
        const id = this.#nextId;
        this.#nextId += 1;
        const message = { id, method };
        if (params !== void 0) message.params = params;
        if (sessionId !== void 0) message.sessionId = sessionId;
        return new Promise((resolve, reject) => {
          this.#pending.set(id, {
            method,
            resolve: (value) => {
              resolve(value);
            },
            reject
          });
          try {
            this.#socket.send(JSON.stringify(message));
          } catch (error) {
            this.#pending.delete(id);
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      }
      on(method, handler) {
        const handlers = this.#handlers.get(method);
        if (handlers === void 0) this.#handlers.set(method, [handler]);
        else handlers.push(handler);
      }
      close() {
        if (this.#closed) return;
        this.#closed = true;
        this.#rejectPending();
        try {
          this.#socket.close();
        } catch {
        }
      }
      #receive(text) {
        let message;
        try {
          message = JSON.parse(text);
        } catch (error) {
          this.#report(error);
          return;
        }
        if (typeof message.id === "number") {
          this.#settle(message.id, message);
          return;
        }
        if (typeof message.method === "string") {
          this.#dispatch(message.method, message.params ?? {});
        }
      }
      #settle(id, message) {
        const pending = this.#pending.get(id);
        if (pending === void 0) return;
        this.#pending.delete(id);
        if (message.error !== void 0) {
          pending.reject(toCdpError(message.error));
          return;
        }
        pending.resolve(message.result);
      }
      #dispatch(method, params) {
        const handlers = this.#handlers.get(method);
        if (handlers === void 0) return;
        for (const handler of handlers) {
          try {
            handler(params);
          } catch (error) {
            this.#report(error);
          }
        }
      }
      #handleSocketClose() {
        if (this.#closed) return;
        this.#closed = true;
        this.#rejectPending();
      }
      #rejectPending() {
        for (const [id, pending] of this.#pending) {
          this.#pending.delete(id);
          pending.reject(new Error(`${CLOSED_BEFORE}${pending.method} answered`));
        }
      }
      #report(error) {
        try {
          this.#onError(error);
        } catch {
        }
      }
    };
  }
});

// packages/browser-control/src/chrome.ts
import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  truncateSync
} from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
function defaultSleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
function trimExcerpt(text) {
  return text.replace(/\s+/g, " ").trim().slice(-STDERR_EXCERPT_CHARS).trim();
}
function chromeBinary(env = process.env) {
  const override = env.OXRAIL_CHROME?.trim();
  if (override !== void 0 && override.length > 0) {
    if (!existsSync(override)) {
      throw new Error(
        `oxrail-browser: OXRAIL_CHROME points at ${override}, which does not exist`
      );
    }
    return { path: override, args: [] };
  }
  for (const candidate of MAC_BINARIES) {
    if (existsSync(candidate)) return { path: candidate, args: [] };
  }
  const searchPath = env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter)) {
    if (directory.length === 0) continue;
    for (const name of PATH_BINARIES) {
      const candidate = path.join(directory, name);
      if (existsSync(candidate)) return { path: candidate, args: [] };
    }
  }
  throw new Error(
    "oxrail-browser: no Chrome or Chromium found; install one or set OXRAIL_CHROME"
  );
}
function chromeArgs(options) {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const args = [];
  if (options.headless) args.push("--headless=new");
  args.push(
    `--user-data-dir=${options.userDataDir}`,
    "--remote-debugging-port=0",
    "--remote-allow-origins=*",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    "--disable-blink-features=AutomationControlled",
    "--disable-sync",
    "--disable-popup-blocking",
    "--hide-crash-restore-bubble",
    "--disable-session-crashed-bubble",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
    "--disable-backgrounding-occluded-windows",
    "--disable-features=Translate,MediaRouter,OptimizationHints",
    `--window-size=${windowSize.width},${windowSize.height}`
  );
  if (options.extraFlags !== void 0) args.push(...options.extraFlags);
  return args;
}
function stateDir(env = process.env) {
  const override = env.OXRAIL_BROWSER_STATE_DIR?.trim();
  if (override !== void 0 && override.length > 0)
    return path.resolve(override);
  return path.join(homedir(), ".oxrail", "browser-control");
}
function profileName(profile) {
  const cleaned = profile.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").replace(/[.-]+$/, "");
  return cleaned.length > 0 ? cleaned.slice(0, 64) : "default";
}
function profileDir(profile, env = process.env) {
  const root = path.join(stateDir(env), "profiles");
  const directory = path.join(root, profileName(profile));
  const relative = path.relative(root, directory);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(
      `oxrail-browser: profile ${profile} escapes the profile root`
    );
  }
  return directory;
}
function clearStaleDevToolsPort(userDataDir) {
  rmSync(path.join(userDataDir, DEVTOOLS_PORT_FILE), { force: true });
}
function readDevToolsPort(userDataDir) {
  let text;
  try {
    text = readFileSync(path.join(userDataDir, DEVTOOLS_PORT_FILE), "utf8");
  } catch {
    return null;
  }
  const lines = text.split(/\r?\n/);
  const port = Number.parseInt(lines[0]?.trim() ?? "", 10);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  const wsPath = lines[1]?.trim() ?? "";
  return { port, path: wsPath.length > 0 ? wsPath : "/devtools/browser" };
}
function pollDelayMs(attempt) {
  if (attempt < 10) return 5;
  if (attempt < 25) return 40;
  return 100;
}
function deathMessage(death) {
  const how = death.signal !== null ? `signal ${death.signal}` : `exit code ${death.code ?? "unknown"}`;
  const stderr = trimExcerpt(death.stderr);
  const detail = stderr.length > 0 ? ` \u2014 ${stderr}` : "";
  return `oxrail-browser: Chrome ended before it opened a debugging port (${how} after ${death.ms} ms${detail})`;
}
async function waitForDevToolsPort(userDataDir, options = {}) {
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS;
  const isDead = options.isDead ?? (() => null);
  const sleep = options.sleep ?? defaultSleep;
  let elapsed = 0;
  let attempt = 0;
  for (; ; ) {
    const death = isDead();
    if (death !== null) throw new Error(deathMessage(death));
    const found = readDevToolsPort(userDataDir);
    if (found !== null) return found;
    if (elapsed >= deadlineMs) {
      throw new Error("oxrail-browser: Chrome did not open a debugging port");
    }
    const delay = Math.min(
      pollDelayMs(attempt),
      Math.max(deadlineMs - elapsed, 1)
    );
    await sleep(delay);
    elapsed += delay;
    attempt += 1;
  }
}
function stderrOffset(logPath) {
  try {
    const size = statSync(logPath).size;
    if (size > STDERR_LOG_LIMIT_BYTES) {
      truncateSync(logPath, 0);
      return 0;
    }
    return size;
  } catch {
    return 0;
  }
}
var DEVTOOLS_PORT_FILE, DEFAULT_DEADLINE_MS, DEFAULT_WINDOW_SIZE, STDERR_LOG_NAME, STDERR_LOG_LIMIT_BYTES, STDERR_EXCERPT_CHARS, GRACEFUL_EXIT_WAIT_MS, TERMINATE_WAIT_MS, KILL_WAIT_MS, MAC_BINARIES, PATH_BINARIES, ChromeProcess;
var init_chrome = __esm({
  "packages/browser-control/src/chrome.ts"() {
    "use strict";
    init_cdp();
    DEVTOOLS_PORT_FILE = "DevToolsActivePort";
    DEFAULT_DEADLINE_MS = 15e3;
    DEFAULT_WINDOW_SIZE = { width: 1280, height: 900 };
    STDERR_LOG_NAME = "browser.err.log";
    STDERR_LOG_LIMIT_BYTES = 1024 * 1024;
    STDERR_EXCERPT_CHARS = 240;
    GRACEFUL_EXIT_WAIT_MS = 400;
    TERMINATE_WAIT_MS = 2e3;
    KILL_WAIT_MS = 1e3;
    MAC_BINARIES = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium"
    ];
    PATH_BINARIES = [
      "google-chrome",
      "google-chrome-stable",
      "chromium",
      "chromium-browser",
      "chrome"
    ];
    ChromeProcess = class _ChromeProcess {
      pid;
      profile;
      headless;
      #child;
      #startedAt;
      #stderrLogPath;
      #stderrOffset;
      #wsUrl = null;
      #death = null;
      #exited = false;
      #exitWaiters = [];
      constructor(child, profile, headless, stderrLogPath, stderrOffsetBytes) {
        this.#child = child;
        this.pid = child.pid ?? null;
        this.profile = profile;
        this.headless = headless;
        this.#startedAt = Date.now();
        this.#stderrLogPath = stderrLogPath;
        this.#stderrOffset = stderrOffsetBytes;
        child.once("exit", (code, signal) => {
          this.#recordDeath(code, signal);
        });
        child.once("error", () => {
          this.#recordDeath(null, null);
        });
      }
      static async launch(options) {
        const env = options.env ?? process.env;
        const binary = options.binaryPath === void 0 ? chromeBinary(env) : { path: options.binaryPath, args: [] };
        if (!existsSync(binary.path)) {
          throw new Error(
            `oxrail-browser: Chrome binary not found at ${binary.path}`
          );
        }
        const userDataDir = profileDir(options.profile, env);
        mkdirSync(userDataDir, { recursive: true, mode: 448 });
        clearStaleDevToolsPort(userDataDir);
        const logs = stateDir(env);
        mkdirSync(logs, { recursive: true, mode: 448 });
        const logPath = path.join(logs, STDERR_LOG_NAME);
        const offset = stderrOffset(logPath);
        const args = chromeArgs({
          userDataDir,
          headless: options.headless,
          ...options.extraFlags === void 0 ? {} : { extraFlags: options.extraFlags },
          ...options.windowSize === void 0 ? {} : { windowSize: options.windowSize }
        });
        const logFd = openSync(logPath, "a", 384);
        let child;
        try {
          child = spawn(binary.path, args, {
            stdio: ["ignore", logFd, logFd],
            env
          });
        } finally {
          closeSync(logFd);
        }
        const chrome = new _ChromeProcess(
          child,
          options.profile,
          options.headless,
          logPath,
          offset
        );
        try {
          const port = await waitForDevToolsPort(userDataDir, {
            isDead: () => chrome.lastDeath()
          });
          chrome.#attachPort(port);
          return chrome;
        } catch (error) {
          await chrome.close();
          throw error;
        }
      }
      /** The browser-wide DevTools endpoint, known once the port file appeared. */
      get browserWsUrl() {
        if (this.#wsUrl === null) {
          throw new Error(
            "oxrail-browser: the debugging port was never discovered"
          );
        }
        return this.#wsUrl;
      }
      alive() {
        const child = this.#child;
        return child !== null && !this.#exited && child.exitCode === null && child.signalCode === null;
      }
      /** What the process reported when it ended, if it has ended. */
      lastDeath() {
        return this.#death;
      }
      /**
       * Releases the process. A protocol-level `Browser.close` lets Chrome flush
       * its profile; signals are only the fallback. This never throws and is safe
       * to call twice, because a leaked Chrome would outlive the route.
       */
      async close(options = {}) {
        const child = this.#child;
        if (child === null) return;
        try {
          if (this.#wsUrl !== null && this.alive()) {
            await this.#requestBrowserClose();
          }
          if (await this.#waitForExit(GRACEFUL_EXIT_WAIT_MS)) return;
          this.#signal(child, "SIGTERM");
          if (await this.#waitForExit(options.timeoutMs ?? TERMINATE_WAIT_MS)) {
            return;
          }
          this.#signal(child, "SIGKILL");
          await this.#waitForExit(KILL_WAIT_MS);
        } catch {
        } finally {
          this.#child = null;
        }
      }
      #attachPort(port) {
        const wsPath = port.path.startsWith("/") ? port.path : "/devtools/browser";
        this.#wsUrl = `ws://127.0.0.1:${port.port}${wsPath}`;
      }
      async #requestBrowserClose() {
        if (this.#wsUrl === null) return;
        let connection = null;
        try {
          connection = await CdpConnection.connect(this.#wsUrl, {
            timeoutMs: 2e3
          });
          await connection.send("Browser.close");
        } catch {
        } finally {
          connection?.close();
        }
      }
      #signal(child, signal) {
        try {
          child.kill(signal);
        } catch {
        }
      }
      async #waitForExit(ms) {
        if (!this.alive()) return true;
        return await new Promise((resolve) => {
          let settled = false;
          const finish = (exited) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(exited);
          };
          const timer = setTimeout(() => {
            finish(false);
          }, ms);
          this.#exitWaiters.push(() => {
            finish(true);
          });
          if (!this.alive()) finish(true);
        });
      }
      #recordDeath(code, signal) {
        if (this.#death !== null) return;
        this.#death = {
          code,
          signal,
          ms: Date.now() - this.#startedAt,
          // Only this run's appended bytes, and only the tail the message shows, so
          // a chatty Chrome cannot hold a megabyte of log in memory per route.
          stderr: trimExcerpt(this.#readAppendedStderr())
        };
        this.#exited = true;
        const waiters = this.#exitWaiters;
        this.#exitWaiters = [];
        for (const waiter of waiters) waiter();
      }
      #readAppendedStderr() {
        try {
          const contents = readFileSync(this.#stderrLogPath);
          if (this.#stderrOffset >= contents.length) return "";
          return contents.subarray(this.#stderrOffset).toString("utf8");
        } catch {
          return "";
        }
      }
    };
  }
});

// packages/browser-control/src/route.ts
var route_exports = {};
__export(route_exports, {
  CdpBrowserRoute: () => CdpBrowserRoute,
  headlessFromEnv: () => headlessFromEnv,
  idleMs: () => idleMs,
  inspectBinary: () => inspectBinary,
  profileFromEnv: () => profileFromEnv,
  shotClip: () => shotClip,
  snapshotExpression: () => snapshotExpression,
  viewSize: () => viewSize
});
import { existsSync as existsSync2, mkdirSync as mkdirSync2, statSync as statSync2, writeFileSync } from "node:fs";
import { join } from "node:path";
function idleMs(env = process.env) {
  const raw = Number(env.OXRAIL_BROWSER_IDLE_MS);
  if (!Number.isFinite(raw)) return DEFAULT_IDLE_MS;
  return Math.min(MAX_IDLE_MS, Math.max(MIN_IDLE_MS, Math.floor(raw)));
}
function headlessFromEnv(env = process.env) {
  return env.OXRAIL_BROWSER_HEADLESS !== "0";
}
function shotClip(view, fullPage) {
  const width = Math.max(1, Math.round(view.width));
  if (fullPage) {
    return {
      x: 0,
      y: 0,
      width,
      height: Math.max(1, Math.round(view.documentHeight)),
      scale: 1
    };
  }
  return {
    x: Math.round(view.scrollX),
    y: Math.round(view.scrollY),
    width,
    height: Math.max(1, Math.round(view.height)),
    scale: 1
  };
}
function profileFromEnv(env = process.env) {
  const raw = env.OXRAIL_BROWSER_PROFILE;
  return raw !== void 0 && raw.trim() !== "" ? raw.trim() : "default";
}
function viewSize(env = process.env) {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(env.OXRAIL_BROWSER_VIEW ?? "");
  if (match === null) return { width: VIEW_WIDTH, height: VIEW_HEIGHT };
  return { width: Number(match[1]), height: Number(match[2]) };
}
function snapshotExpression(options) {
  const mode = JSON.stringify(options.mode);
  const maxChars = Math.max(400, Math.floor(options.maxChars));
  return `(() => {
  const MODE = ${mode};
  const MAX_CHARS = ${maxChars};
  const MAX_CONTROLS = 160;
  const MAX_NODES = 9000;

  const visible = (el) => {
    if (!(el instanceof Element)) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return false;
    if (style.opacity !== "" && Number(style.opacity) < 0.05) return false;
    return true;
  };

  const nameOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria && aria.trim() !== "") return aria.trim();
    const text = (el.innerText || el.textContent || "").replace(/\\s+/g, " ").trim();
    if (text !== "") return text.slice(0, 160);
    const title = el.getAttribute("title");
    if (title && title.trim() !== "") return title.trim().slice(0, 160);
    const placeholder = el.getAttribute("placeholder");
    if (placeholder && placeholder.trim() !== "") return placeholder.trim().slice(0, 160);
    const alt = el.getAttribute("alt");
    if (alt && alt.trim() !== "") return alt.trim().slice(0, 160);
    const value = el.value;
    if (typeof value === "string" && value.trim() !== "") return value.trim().slice(0, 160);
    return "";
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "button") return "button";
    if (tag === "input") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    if (tag === "textarea") return "textbox";
    if (tag === "select") return "combobox";
    return "control";
  };

  let nodes = 0;
  let truncated = false;
  const clickable = document.querySelectorAll(
    'a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="tab"],[role="menuitem"],[contenteditable="true"],[tabindex]:not([tabindex="-1"])'
  );
  const controls = [];
  for (const el of clickable) {
    if (controls.length >= MAX_CONTROLS) { truncated = true; break; }
    nodes += 1;
    if (nodes > MAX_NODES) { truncated = true; break; }
    if (!visible(el)) continue;
    const name = nameOf(el);
    if (name === "" && !el.hasAttribute("contenteditable") && el.tagName.toLowerCase() !== "input") continue;
    const ref = controls.length + 1;
    el.setAttribute("data-oxrail-ref", String(ref));
    controls.push({ ref, role: roleOf(el), name, tag: el.tagName.toLowerCase() });
  }

  const body = document.body;
  let text = body ? body.innerText || "" : "";
  if (text.length > MAX_CHARS) { text = text.slice(0, MAX_CHARS); truncated = true; }
  text = text.replace(/\\n{3,}/g, "\\n\\n").trim();

  if (MODE === "links") {
    const links = [];
    for (const el of document.querySelectorAll("a[href]")) {
      if (!visible(el)) continue;
      const name = nameOf(el);
      if (name === "") continue;
      links.push("- [" + name + "](" + el.href + ")");
      if (links.length >= 200) break;
    }
    text = links.length > 0 ? links.join("\\n") : "(no visible links)";
  }
  if (MODE === "forms") {
    const rows = [];
    for (const el of controls) {
      const node = document.querySelector('[data-oxrail-ref="' + el.ref + '"]');
      const value = node && typeof node.value === "string" ? node.value : "";
      const type = node ? (node.getAttribute("type") || "") : "";
      rows.push("[" + el.ref + "] " + el.role + (type ? ":" + type : "") + (value ? " = " + value : "") + (el.name ? " \u2014 " + el.name : ""));
    }
    text = rows.length > 0 ? rows.join("\\n") : "(no visible controls)";
  }

  return {
    url: location.href,
    title: document.title || "",
    text,
    controls,
    truncated,
  };
})()`;
}
function inspectBinary(env = process.env) {
  const binary = (env.OXRAIL_CHROME ?? "").trim();
  if (binary !== "" && existsSync2(binary)) {
    return {
      path: binary,
      args: chromeArgs({ userDataDir: "", headless: true })
    };
  }
  throw new Error("set OXRAIL_CHROME to a Chrome or Chromium binary path");
}
var VIEW_WIDTH, VIEW_HEIGHT, DEFAULT_MAX_CHARS, DEFAULT_IDLE_MS, MAX_IDLE_MS, MIN_IDLE_MS, LOAD_TIMEOUT_MS, CdpBrowserRoute;
var init_route = __esm({
  "packages/browser-control/src/route.ts"() {
    "use strict";
    init_cdp();
    init_chrome();
    init_types();
    VIEW_WIDTH = 1280;
    VIEW_HEIGHT = 900;
    DEFAULT_MAX_CHARS = 6e3;
    DEFAULT_IDLE_MS = 5 * 6e4;
    MAX_IDLE_MS = 15 * 6e4;
    MIN_IDLE_MS = 6e4;
    LOAD_TIMEOUT_MS = 2e4;
    CdpBrowserRoute = class {
      chrome = null;
      cdp = null;
      page = null;
      idleWindow;
      lastUse = 0;
      restTimer = null;
      profile;
      headless;
      size;
      queue = Promise.resolve();
      closed = false;
      constructor(options) {
        const env = options?.env ?? process.env;
        this.idleWindow = idleMs(env);
        this.profile = profileFromEnv(env);
        this.headless = headlessFromEnv(env);
        this.size = viewSize(env);
      }
      /** Tools must not interleave on one page; one queue keeps refs coherent. */
      serial(work) {
        const run = this.queue.then(work, work);
        this.queue = run.catch(() => void 0);
        return run;
      }
      touch() {
        this.lastUse = Date.now();
        this.armRest();
      }
      armRest() {
        if (this.restTimer !== null) clearTimeout(this.restTimer);
        this.restTimer = null;
        if (this.chrome === null) return;
        const wait = Math.max(1e3, this.lastUse + this.idleWindow - Date.now());
        this.restTimer = setTimeout(() => {
          this.restTimer = null;
          void this.close().catch(() => void 0);
        }, wait);
        this.restTimer.unref();
      }
      async ensure() {
        if (this.chrome === null || this.cdp === null || this.page === null) {
          throw new RouteClosedError(
            "browser is not open; call browser_open first"
          );
        }
        return { cdp: this.cdp, page: this.page };
      }
      async open(options = {}) {
        return this.serial(async () => {
          if (this.chrome !== null && this.cdp !== null && this.page !== null) {
            if (options.url !== void 0 && options.url !== "")
              await this.navigate(options.url);
            return this.state();
          }
          const profile = options.profile ?? this.profile;
          const headless = options.headless ?? this.headless;
          const dir = profileDir(profile);
          mkdirSync2(dir, { recursive: true });
          const chrome = await ChromeProcess.launch({
            headless,
            profile,
            ...process.env.OXRAIL_CHROME !== void 0 ? { binaryPath: process.env.OXRAIL_CHROME } : {},
            windowSize: this.size
          });
          this.chrome = chrome;
          const cdp = await CdpConnection.connect(chrome.browserWsUrl, {
            timeoutMs: 1e4
          });
          this.cdp = cdp;
          const page = await this.attachPage(cdp);
          this.page = page;
          this.closed = false;
          this.touch();
          if (options.url !== void 0 && options.url !== "")
            await this.navigate(options.url);
          return this.state();
        });
      }
      async attachPage(cdp) {
        await cdp.send("Target.setDiscoverTargets", { discover: true });
        let targetId = null;
        for (let attempt = 0; attempt < 50 && targetId === null; attempt += 1) {
          const targets = await cdp.send("Target.getTargets");
          const page = targets.targetInfos.find((info) => info.type === "page");
          targetId = page?.targetId ?? null;
          if (targetId === null)
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
        if (targetId === null) {
          const created = await cdp.send(
            "Target.createTarget",
            { url: "about:blank" }
          );
          targetId = created.targetId;
        }
        const attached = await cdp.send(
          "Target.attachToTarget",
          {
            targetId,
            flatten: true
          }
        );
        const sessionId = attached.sessionId;
        await cdp.send("Page.enable", {}, sessionId);
        await cdp.send("Runtime.enable", {}, sessionId);
        return { sessionId, targetId };
      }
      async navigate(url) {
        const { cdp, page } = await this.ensure();
        const loaded = new Promise((resolve) => {
          const timer = setTimeout(() => resolve(), LOAD_TIMEOUT_MS);
          timer.unref();
          cdp.on("Page.loadEventFired", () => {
            clearTimeout(timer);
            resolve();
          });
        });
        await cdp.send("Page.navigate", { url }, page.sessionId);
        await loaded;
      }
      async evaluate(expression) {
        const { cdp, page } = await this.ensure();
        const reply = await cdp.send(
          "Runtime.evaluate",
          {
            expression,
            returnByValue: true,
            awaitPromise: true,
            userGesture: true
          },
          page.sessionId
        );
        if (reply.exceptionDetails !== void 0) {
          const message = reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text ?? "evaluation failed";
          throw new Error(message.split("\n")[0] ?? "evaluation failed");
        }
        return reply.result?.value;
      }
      async read(options = {}) {
        return this.serial(async () => {
          await this.ensure();
          const mode = options.mode ?? "text";
          const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
          const snapshot = await this.evaluate(
            snapshotExpression({ mode, maxChars })
          );
          this.touch();
          return {
            url: snapshot.url,
            title: snapshot.title,
            text: snapshot.text,
            controls: snapshot.controls,
            truncated: snapshot.truncated === true
          };
        });
      }
      /** Resolve a numbered control or a text match to a point that will hit it. */
      async locate(target) {
        if (target.ref !== void 0 && target.text !== void 0) {
          throw new Error("give either ref or text, not both");
        }
        const expression = `(() => {
  const el = ${target.ref !== void 0 ? `document.querySelector('[data-oxrail-ref="${target.ref}"]')` : `(() => {
    const needle = ${JSON.stringify(target.text ?? "")}.replace(/\\s+/g, " ").trim().toLowerCase();
    if (needle === "") return null;
    const all = document.querySelectorAll('a[href],button,input,textarea,select,summary,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"]');
    let best = null, bestArea = Infinity;
    for (const node of all) {
      const text = (node.innerText || node.value || node.getAttribute("aria-label") || node.getAttribute("title") || "").replace(/\\s+/g, " ").trim().toLowerCase();
      if (text === "" || !text.includes(needle)) continue;
      const box = node.getBoundingClientRect();
      if (box.width < 2 || box.height < 2) continue;
      const area = box.width * box.height;
      if (area < bestArea) { best = node; bestArea = area; }
    }
    return best;
  })()`};
  if (!el) return { found: false };
  /* Instant, not smooth: a page with scroll-behavior:smooth animates this call,
     and the rect read one line later is the one it had before the scroll, so
     every point below would be computed against where the control used to be. */
  el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
  const label = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title") || "").replace(/\\s+/g, " ").trim().slice(0, 80);
  const box = el.getBoundingClientRect();
  if (box.width < 2 || box.height < 2) return { found: true, label, blocked: "it has no area on screen to click" };
  /* Only the part of the control the viewport shows can be pressed. Clamping a
     point that lies outside it invents a place the control is not, and the
     press then lands wherever the clamp put it. */
  const seenLeft = Math.max(box.left, 0);
  const seenTop = Math.max(box.top, 0);
  const seenRight = Math.min(box.right, innerWidth);
  const seenBottom = Math.min(box.bottom, innerHeight);
  if (seenRight - seenLeft < 2 || seenBottom - seenTop < 2)
    return { found: true, label, blocked: "it is outside the visible area even after scrolling it into view" };
  /* The point must be one where a real press would reach this control: an
     overlay, a sticky header or a modal owns that pixel otherwise, and clicking
     it anyway would report success while the page never heard the press. Five
     samples, centre first, so a control covered only in the middle still gets
     clicked where it is reachable.
     A descendant counts, because the press bubbles up to the control. An
     ancestor does not: body contains every control, and an element with
     pointer-events:none is painted under the thing that really takes the
     press, so a click there is heard by the page and by nobody the caller
     asked for. */
  const within = (value, limit) => Math.min(Math.max(value, 1), Math.max(limit - 2, 1));
  const spread = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7]];
  for (const [fx, fy] of spread) {
    const x = within(seenLeft + (seenRight - seenLeft) * fx, innerWidth);
    const y = within(seenTop + (seenBottom - seenTop) * fy, innerHeight);
    const hit = document.elementFromPoint(x, y);
    if (hit !== null && (hit === el || el.contains(hit))) return { found: true, x, y, label };
  }
  const top = document.elementFromPoint(
    within(seenLeft + (seenRight - seenLeft) / 2, innerWidth),
    within(seenTop + (seenBottom - seenTop) / 2, innerHeight),
  );
  const owner = top === null
    ? "the page has nothing at that point"
    : "it is behind " + top.tagName.toLowerCase() + (top.id ? "#" + top.id : "") + (typeof top.className === "string" && top.className.trim() !== "" ? "." + top.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") + " \\"" + (top.innerText || top.getAttribute("aria-label") || "").replace(/\\s+/g, " ").trim().slice(0, 60) + "\\"";
  return { found: true, label, blocked: owner };
})()`;
        const found = await this.evaluate(expression);
        if (found.found !== true) {
          if (target.ref !== void 0)
            throw new StaleRefError(
              `the page changed; control ${target.ref} is gone \u2014 call browser_view again`
            );
          throw new Error(
            `no visible control contains ${JSON.stringify(target.text ?? "")}`
          );
        }
        const label = found.label ?? "";
        if (found.blocked !== void 0) {
          const named = label === "" ? "control" : JSON.stringify(label);
          throw new Error(
            found.blocked.startsWith("it has no area") ? `${named} cannot be clicked: ${found.blocked}.` : `${named} cannot be clicked because ${found.blocked}. Close or dismiss what covers it, then call browser_view and retry.`
          );
        }
        if (found.x === void 0 || found.y === void 0) {
          throw new Error(
            `${label === "" ? "control" : JSON.stringify(label)} has no reachable point on screen.`
          );
        }
        return { x: found.x, y: found.y, label };
      }
      async mouseClick(x, y) {
        const { cdp, page } = await this.ensure();
        const base = {
          x: Math.round(x),
          y: Math.round(y),
          button: "left",
          clickCount: 1,
          modifiers: 0
        };
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseMoved", ...base, buttons: 0 },
          page.sessionId
        );
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mousePressed", ...base, buttons: 1 },
          page.sessionId
        );
        await cdp.send(
          "Input.dispatchMouseEvent",
          { type: "mouseReleased", ...base, buttons: 0 },
          page.sessionId
        );
      }
      async click(target) {
        return this.serial(async () => {
          await this.ensure();
          const box = await this.locate(target);
          await this.mouseClick(box.x, box.y);
          this.touch();
          return {
            content: [
              {
                type: "text",
                text: `clicked ${box.label === "" ? "control" : JSON.stringify(box.label)}`
              }
            ]
          };
        });
      }
      keyEvent(key) {
        const table = {
          Enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
          Tab: { key: "Tab", code: "Tab", keyCode: 9 },
          Escape: { key: "Escape", code: "Escape", keyCode: 27 },
          Backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
          Delete: { key: "Delete", code: "Delete", keyCode: 46 },
          ArrowUp: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
          ArrowDown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
          ArrowLeft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
          ArrowRight: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
          PageUp: { key: "PageUp", code: "PageUp", keyCode: 33 },
          PageDown: { key: "PageDown", code: "PageDown", keyCode: 34 },
          Home: { key: "Home", code: "Home", keyCode: 36 },
          End: { key: "End", code: "End", keyCode: 35 }
        };
        const named = table[key];
        if (named !== void 0) return named;
        if (key.length === 1) {
          const upper = key.toUpperCase();
          return { key, code: `Key${upper}`, keyCode: upper.charCodeAt(0) };
        }
        throw new Error(`unknown key ${JSON.stringify(key)}`);
      }
      async key(key) {
        return this.serial(async () => {
          await this.ensure();
          const event = this.keyEvent(key);
          const { cdp, page } = await this.ensure();
          await cdp.send(
            "Input.dispatchKeyEvent",
            {
              type: "rawKeyDown",
              key: event.key,
              code: event.code,
              windowsVirtualKeyCode: event.keyCode,
              nativeVirtualKeyCode: event.keyCode
            },
            page.sessionId
          );
          if (event.text !== void 0) {
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "char",
                text: event.text,
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode: event.keyCode
              },
              page.sessionId
            );
          }
          await cdp.send(
            "Input.dispatchKeyEvent",
            {
              type: "keyUp",
              key: event.key,
              code: event.code,
              windowsVirtualKeyCode: event.keyCode,
              nativeVirtualKeyCode: event.keyCode
            },
            page.sessionId
          );
          this.touch();
          return { content: [{ type: "text", text: `pressed ${key}` }] };
        });
      }
      async type(target) {
        return this.serial(async () => {
          await this.ensure();
          if (target.ref !== void 0) {
            const ok = await this.focus(target.ref);
            if (!ok)
              throw new StaleRefError(
                `the page changed; control ${target.ref} is gone \u2014 call browser_view again`
              );
          }
          if (target.clear === true) {
            await this.evaluate(`(() => {
  const el = document.activeElement;
  if (el && typeof el.select === "function") { el.select(); return true; }
  if (el && el.isContentEditable) { document.execCommand("selectAll"); return true; }
  return false;
})()`);
            await this.evaluate(
              `(() => { const el = document.activeElement; if (el && "value" in el) { el.value = ""; el.dispatchEvent(new Event("input", { bubbles: true })); } else if (el && el.isContentEditable) { document.execCommand("delete"); } return true; })()`
            );
          }
          const { cdp, page } = await this.ensure();
          await cdp.send("Input.insertText", { text: target.text }, page.sessionId);
          if (target.submit === true) {
            const event = this.keyEvent("Enter");
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "rawKeyDown",
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode: event.keyCode,
                nativeVirtualKeyCode: event.keyCode
              },
              page.sessionId
            );
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "char",
                text: "\r",
                key: "Enter",
                code: "Enter",
                windowsVirtualKeyCode: 13
              },
              page.sessionId
            );
            await cdp.send(
              "Input.dispatchKeyEvent",
              {
                type: "keyUp",
                key: event.key,
                code: event.code,
                windowsVirtualKeyCode: event.keyCode
              },
              page.sessionId
            );
          }
          this.touch();
          return {
            content: [
              {
                type: "text",
                text: `typed ${target.text.length} characters${target.submit === true ? " and pressed Enter" : ""}`
              }
            ]
          };
        });
      }
      async focus(ref) {
        return this.evaluate(`(() => {
  const el = document.querySelector('[data-oxrail-ref="${ref}"]');
  if (!el) return false;
  el.scrollIntoView({ block: "center", inline: "center" });
  el.focus();
  return document.activeElement === el;
})()`);
      }
      async nav(options) {
        return this.serial(async () => {
          await this.ensure();
          if (options.url !== void 0 && options.url !== "") {
            await this.navigate(options.url);
          } else if (options.back === true) {
            await this.evaluate("history.back()");
            await this.waitIdle();
          } else if (options.reload === true) {
            const { cdp, page } = await this.ensure();
            await cdp.send("Page.reload", {}, page.sessionId);
            await this.waitIdle();
          }
          this.touch();
          return this.state();
        });
      }
      async waitIdle() {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const state = await this.evaluate("document.readyState");
          if (state === "complete") return;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      }
      async shot(options = {}) {
        return this.serial(async () => {
          const { cdp, page } = await this.ensure();
          const view = await this.evaluate(`({
  width: innerWidth,
  height: innerHeight,
  scrollX: pageXOffset,
  scrollY: pageYOffset,
  documentHeight: Math.max(document.documentElement.scrollHeight, innerHeight)
})`);
          const clip = shotClip(view, options.fullPage === true);
          const reply = await cdp.send(
            "Page.captureScreenshot",
            {
              format: "png",
              clip,
              captureBeyondViewport: true
            },
            page.sessionId
          );
          const dir = join(stateDir(), "shots");
          mkdirSync2(dir, { recursive: true });
          const path2 = join(dir, `shot-${Date.now()}.png`);
          writeFileSync(path2, Buffer.from(reply.data, "base64"));
          this.touch();
          return { png: reply.data, path: path2 };
        });
      }
      stateSync() {
        const running = this.chrome !== null && this.cdp !== null && this.page !== null;
        return {
          running,
          pid: this.chrome?.pid ?? null,
          profile: this.profile,
          url: null,
          title: null,
          headless: this.headless,
          idleMs: running ? Math.max(0, Date.now() - this.lastUse) : 0,
          closesInMs: running ? Math.max(0, this.lastUse + this.idleWindow - Date.now()) : null
        };
      }
      async state() {
        const base = this.stateSync();
        if (base.running !== true) return base;
        try {
          const page = await this.evaluate(
            `({ url: location.href, title: document.title || "" })`
          );
          return { ...base, url: page.url, title: page.title };
        } catch {
          return base;
        }
      }
      async login() {
        const dir = profileDir(this.profile);
        const cookies = join(dir, "Default", "Cookies");
        let saved = false;
        try {
          saved = existsSync2(cookies) && statSync2(cookies).size > 1024;
        } catch {
          saved = false;
        }
        return {
          profile: this.profile,
          saved,
          text: `profile ${this.profile}: ${saved ? "saved sign-ins present" : "no saved sign-ins yet"} (${dir})`
        };
      }
      async close() {
        if (this.restTimer !== null) clearTimeout(this.restTimer);
        this.restTimer = null;
        const chrome = this.chrome;
        const cdp = this.cdp;
        this.chrome = null;
        this.cdp = null;
        this.page = null;
        this.closed = true;
        if (cdp !== null) cdp.close();
        if (chrome !== null) await chrome.close().catch(() => void 0);
        return this.stateSync();
      }
    };
  }
});

// packages/browser-control/src/main.ts
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

// packages/browser-control/src/tools.ts
init_types();
var ArgumentError = class extends Error {
  name = "ArgumentError";
};
var TOOLS = [
  {
    name: "browser_open",
    title: "Open the browser",
    description: "Start this route's own Chrome, or reuse the one already running, and return its state. Call it before any other browser tool and after browser_close. This browser is not the person's browser: it has its own profile, windows and sign-ins. The first open of a profile pays a cold start.",
    properties: {
      url: {
        kind: "string",
        description: "Page to open. Defaults to a blank page."
      },
      headless: {
        kind: "boolean",
        description: "Run without a visible window. Defaults to true.",
        extras: { default: true }
      },
      profile: {
        kind: "string",
        description: 'Named profile to use. Defaults to "default"; sign-ins are kept per profile directory.',
        extras: { default: "default" }
      }
    },
    async run(route, args) {
      const url = stringValue(args, "url");
      const headless = booleanValue(args, "headless");
      const profile = stringValue(args, "profile");
      const options = {
        ...url === void 0 ? {} : { url },
        ...headless === void 0 ? {} : { headless },
        ...profile === void 0 ? {} : { profile }
      };
      return textResult(formatState(await route.open(options)));
    }
  },
  {
    name: "browser_view",
    title: "Read the page",
    description: 'Read the current page as text. This is the cheap way to see the words and the controls: each control sits on its own line as [12] button "Sign in", and 12 is the ref that browser_click and browser_type take. Use browser_shot only when layout or appearance matters. mode narrows the read to links or form controls; maxChars stops it early.',
    properties: {
      mode: {
        kind: "enum",
        values: ["text", "links", "forms"],
        description: "What to read: page text (default), links only, or form controls only."
      },
      maxChars: {
        kind: "integer",
        description: "Stop reading after this many characters.",
        extras: { minimum: 1 }
      }
    },
    async run(route, args) {
      const mode = stringValue(args, "mode");
      const maxChars = integerValue(args, "maxChars");
      const options = {
        ...mode === void 0 ? {} : { mode },
        ...maxChars === void 0 ? {} : { maxChars }
      };
      return textResult(formatSnapshot(await route.read(options)));
    }
  },
  {
    name: "browser_click",
    title: "Click a control",
    description: "Activate one control: give its ref from the last browser_view, or its visible text. Pass exactly one of the two. A click usually changes the page, so read again before the next ref-based call.",
    properties: {
      ref: {
        kind: "integer",
        description: "Number of a control from the last browser_view."
      },
      text: {
        kind: "string",
        description: "Visible text of the control to click."
      }
    },
    async run(route, args) {
      const ref = integerValue(args, "ref");
      const text = stringValue(args, "text");
      if (ref !== void 0 && text !== void 0) {
        return failure('pass either "ref" or "text", not both.');
      }
      if (ref !== void 0) return route.click({ ref });
      if (text !== void 0) return route.click({ text });
      return failure('pass "ref" from the last browser_view, or "text".');
    }
  },
  {
    name: "browser_type",
    title: "Type into a control",
    description: "Type text into a control: give the text and, when known, the ref of the field from the last browser_view. clear empties the field first; submit presses Enter afterwards. For a bare key press use browser_key.",
    properties: {
      ref: {
        kind: "integer",
        description: "Number of the field from the last browser_view."
      },
      text: {
        kind: "string",
        description: "Text to type."
      },
      clear: {
        kind: "boolean",
        description: "Empty the field before typing.",
        extras: { default: false }
      },
      submit: {
        kind: "boolean",
        description: "Press Enter after typing.",
        extras: { default: false }
      }
    },
    required: ["text"],
    async run(route, args) {
      const text = stringValue(args, "text");
      if (text === void 0) return failure('"text" is required.');
      const ref = integerValue(args, "ref");
      const clear = booleanValue(args, "clear");
      const submit = booleanValue(args, "submit");
      return route.type({
        text,
        ...ref === void 0 ? {} : { ref },
        ...clear === void 0 ? {} : { clear },
        ...submit === void 0 ? {} : { submit }
      });
    }
  },
  {
    name: "browser_key",
    title: "Press a key",
    description: "Press a single key on the page, such as Enter, Tab, Escape or ArrowDown. Use it when the key matters and no control needs a ref; type text with browser_type instead.",
    properties: {
      key: {
        kind: "string",
        description: "Key name, for example Enter or Tab."
      }
    },
    required: ["key"],
    async run(route, args) {
      const key = stringValue(args, "key");
      if (key === void 0) return failure('"key" is required.');
      return route.key(key);
    }
  },
  {
    name: "browser_nav",
    title: "Navigate",
    description: "Move the browser to a url, back one page, or reload. Use browser_click for a link already on the page; use this when the destination is known.",
    properties: {
      url: {
        kind: "string",
        description: "Page to open."
      },
      back: {
        kind: "boolean",
        description: "Go back one history entry.",
        extras: { default: false }
      },
      reload: {
        kind: "boolean",
        description: "Reload the current page.",
        extras: { default: false }
      }
    },
    async run(route, args) {
      const url = stringValue(args, "url");
      const back = booleanValue(args, "back");
      const reload = booleanValue(args, "reload");
      if (url === void 0 && back !== true && reload !== true) {
        return failure("pass url, back or reload.");
      }
      return textResult(
        formatState(
          await route.nav({
            ...url === void 0 ? {} : { url },
            ...back === void 0 ? {} : { back },
            ...reload === void 0 ? {} : { reload }
          })
        )
      );
    }
  },
  {
    name: "browser_shot",
    title: "Take a screenshot",
    description: "Capture the page as a PNG: the viewport by default, or the full page with fullPage. Use it when layout, color or an image matters; browser_view is cheaper for text. Returns the image plus the saved file path.",
    properties: {
      fullPage: {
        kind: "boolean",
        description: "Capture the whole page instead of the viewport.",
        extras: { default: false }
      }
    },
    async run(route, args) {
      const fullPage = booleanValue(args, "fullPage");
      const options = fullPage === void 0 ? {} : { fullPage };
      const shot = await route.shot(options);
      return {
        content: [
          {
            type: "image",
            data: shot.png,
            mimeType: "image/png"
          },
          { type: "text", text: `saved ${shot.path}` }
        ]
      };
    }
  },
  {
    name: "browser_state",
    title: "Browser state",
    description: "Report the browser: running or closed, profile, current url and title, headless, and the idle clock (idleMs, closesInMs). Cheap; use it to decide whether browser_open is needed and how long the browser will stay.",
    properties: {},
    async run(route) {
      return textResult(formatState(await route.state()));
    }
  },
  {
    name: "browser_login",
    title: "Saved sign-in",
    description: "Report the saved sign-in for the current profile. Sign-ins persist per profile directory, so this says whether a sign-in already exists; it does not read, fill or submit login forms.",
    properties: {},
    async run(route) {
      return textResult(formatLogin(await route.login()));
    }
  },
  {
    name: "browser_close",
    title: "Close the browser",
    description: "Close the browser now and release its process. Do it when the work is done; the next browser_open cold-starts Chrome again. The browser also closes by itself after the idle window.",
    properties: {},
    async run(route) {
      return textResult(formatState(await route.close()));
    }
  }
];
var TOOL_DEFINITIONS = TOOLS.map(toDefinition);
var TOOL_BY_NAME = new Map(
  TOOLS.map((tool) => [tool.name, tool])
);
async function dispatch(route, name, args) {
  const tool = TOOL_BY_NAME.get(name);
  if (tool === void 0) return unknownTool(name);
  try {
    const validated = validate(tool, args);
    return await tool.run(route, validated);
  } catch (error) {
    return failure(describeError(error));
  }
}
function unknownTool(name) {
  return failure(`unknown tool: ${name}`);
}
function validate(tool, raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ArgumentError(`${tool.name}: arguments must be an object.`);
  }
  const input = raw;
  for (const key of Object.keys(input)) {
    if (!Object.prototype.hasOwnProperty.call(tool.properties, key)) {
      throw new ArgumentError(`${tool.name}: unexpected argument "${key}".`);
    }
  }
  const output = {};
  for (const [key, property] of Object.entries(tool.properties)) {
    const value = input[key];
    if (value === void 0 || value === null) continue;
    output[key] = coerce(tool.name, key, property, value);
  }
  for (const key of tool.required ?? []) {
    if (!Object.prototype.hasOwnProperty.call(output, key)) {
      throw new ArgumentError(`${tool.name}: "${key}" is required.`);
    }
  }
  return output;
}
function coerce(tool, key, property, value) {
  switch (property.kind) {
    case "string":
      if (typeof value !== "string") {
        throw new ArgumentError(`${tool}: "${key}" must be a string.`);
      }
      return value;
    case "boolean":
      if (typeof value !== "boolean") {
        throw new ArgumentError(`${tool}: "${key}" must be a boolean.`);
      }
      return value;
    case "integer": {
      if (typeof value === "number" && Number.isSafeInteger(value)) {
        return value;
      }
      if (typeof value === "string" && /^-?\d+$/.test(value)) {
        const parsed = Number(value);
        if (Number.isSafeInteger(parsed)) return parsed;
      }
      throw new ArgumentError(`${tool}: "${key}" must be an integer.`);
    }
    case "enum": {
      const values = property.values ?? [];
      if (typeof value !== "string" || !values.includes(value)) {
        throw new ArgumentError(
          `${tool}: "${key}" must be one of ${values.join(", ")}.`
        );
      }
      return value;
    }
  }
}
function describeError(error) {
  if (error instanceof RouteClosedError) {
    return "no browser is running. Call browser_open first.";
  }
  if (error instanceof StaleRefError) {
    return "the page changed since the last read. Call browser_view and use the new refs.";
  }
  if (error instanceof Error) {
    return error.message === "" ? "browser tool failed." : error.message;
  }
  return "browser tool failed.";
}
function stringValue(args, key) {
  const value = args[key];
  return typeof value === "string" ? value : void 0;
}
function integerValue(args, key) {
  const value = args[key];
  return typeof value === "number" ? value : void 0;
}
function booleanValue(args, key) {
  const value = args[key];
  return typeof value === "boolean" ? value : void 0;
}
function textResult(text) {
  return { content: [{ type: "text", text }] };
}
function failure(text) {
  return { content: [{ type: "text", text }], isError: true };
}
function formatSnapshot(snapshot) {
  const lines = [];
  if (snapshot.text !== "") lines.push(snapshot.text);
  for (const control of snapshot.controls) {
    if (control.name === "") continue;
    lines.push(`[${control.ref}] ${control.role} "${control.name}"`);
  }
  if (lines.length === 0) lines.push("(blank page)");
  if (snapshot.url !== "") lines.push(`url: ${snapshot.url}`);
  if (snapshot.title !== "") lines.push(`title: ${snapshot.title}`);
  if (snapshot.truncated) {
    lines.push(`controls: ${snapshot.controls.length}`, "truncated: true");
  }
  return lines.join("\n");
}
function formatState(state) {
  if (!state.running) {
    return [`running: false`, `profile: ${state.profile}`].join("\n");
  }
  return [
    `running: ${state.running}`,
    `pid: ${state.pid === null ? "null" : state.pid}`,
    `profile: ${state.profile}`,
    `url: ${state.url === null ? "null" : state.url}`,
    `title: ${state.title === null ? "null" : state.title}`,
    `headless: ${state.headless}`,
    `idleMs: ${state.idleMs}`,
    `closesInMs: ${state.closesInMs === null ? "null" : state.closesInMs}`
  ].join("\n");
}
function formatLogin(state) {
  const lines = [`profile: ${state.profile}`, `saved: ${state.saved}`];
  if (state.text !== "") lines.push(state.text);
  return lines.join("\n");
}
function toDefinition(tool) {
  const properties = {};
  for (const [key, property] of Object.entries(tool.properties)) {
    properties[key] = toPropertySchema(property);
  }
  const inputSchema = {
    type: "object",
    properties,
    additionalProperties: false
  };
  if (tool.required !== void 0 && tool.required.length > 0) {
    inputSchema.required = [...tool.required];
  }
  return {
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema
  };
}
function toPropertySchema(property) {
  const schema = {
    type: property.kind === "enum" ? "string" : property.kind,
    description: property.description
  };
  if (property.values !== void 0) schema.enum = [...property.values];
  if (property.extras !== void 0) Object.assign(schema, property.extras);
  return schema;
}

// packages/browser-control/src/mcp.ts
var SERVER_NAME = "oxrail-browser-control";
var MODERN_VERSION = "2026-07-28";
var LEGACY_VERSION = "2025-11-25";
var SUPPORTED_VERSIONS = [MODERN_VERSION];
var LEGACY_VERSIONS = [MODERN_VERSION, LEGACY_VERSION];
var PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion";
var SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";
var PARSE_ERROR = -32700;
var INVALID_REQUEST = -32600;
var METHOD_NOT_FOUND = -32601;
var INVALID_PARAMS = -32602;
var UNSUPPORTED_PROTOCOL_VERSION = -32022;
function serveMcp(options) {
  const { stdin, stdout, stderr, route, version } = options;
  const instructions = options.instructions;
  let closed = false;
  let finishing = false;
  let buffer = "";
  let writeQueue = Promise.resolve();
  let resolveClosed = () => {
  };
  const closedPromise = new Promise((resolve) => {
    resolveClosed = resolve;
  });
  const inFlight = /* @__PURE__ */ new Set();
  const cancelled = /* @__PURE__ */ new Set();
  function write(payload) {
    if (closed) return;
    let line;
    try {
      line = `${JSON.stringify(payload)}
`;
    } catch (error) {
      note(stderr, "could not serialise a reply", error);
      return;
    }
    writeQueue = writeQueue.then(
      () => new Promise((resolve) => {
        if (closed) {
          resolve();
          return;
        }
        try {
          stdout.write(line, () => resolve());
        } catch (error) {
          note(stderr, "could not write a reply", error);
          resolve();
        }
      })
    ).catch((error) => {
      note(stderr, "the reply queue failed", error);
    });
  }
  function sendError(id, code, message, data) {
    const error = { code, message };
    if (data !== void 0) error.data = data;
    write({ jsonrpc: "2.0", id, error });
  }
  function handleLine(line) {
    if (line.trim() === "") return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      sendError(null, PARSE_ERROR, "parse error");
      return;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      sendError(null, INVALID_REQUEST, "invalid request");
      return;
    }
    handleMessage(parsed);
  }
  function handleMessage(message) {
    const method = message.method;
    const id = message.id;
    const params = message.params;
    const hasId = id !== void 0;
    if (typeof method !== "string") {
      if (hasId) sendError(id, INVALID_REQUEST, "invalid request");
      return;
    }
    if (!hasId) {
      handleNotification(method, params);
      return;
    }
    switch (method) {
      case "server/discover":
        sendDiscover(id, params);
        return;
      case "initialize":
        sendInitialize(id, params);
        return;
      case "tools/list":
        write({
          jsonrpc: "2.0",
          id,
          result: { tools: TOOL_DEFINITIONS }
        });
        return;
      case "tools/call":
        startToolCall(id, params);
        return;
      case "ping":
        write({ jsonrpc: "2.0", id, result: {} });
        return;
      default:
        sendError(id, METHOD_NOT_FOUND, `method not found: ${method}`);
    }
  }
  function handleNotification(method, params) {
    if (method === "notifications/cancelled") {
      const requestId = readCancelledId(params);
      if (requestId !== void 0) {
        const key = idKey(requestId);
        if (key !== null && inFlight.has(key)) cancelled.add(key);
      }
    }
  }
  function sendDiscover(id, params) {
    const requested = readRequestedVersion(params);
    if (requested !== void 0 && !SUPPORTED_VERSIONS.includes(requested)) {
      sendError(
        id,
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version",
        {
          supported: [...SUPPORTED_VERSIONS]
        }
      );
      return;
    }
    const result = {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      _meta: {
        [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version }
      }
    };
    if (instructions !== void 0) result.instructions = instructions;
    write({ jsonrpc: "2.0", id, result });
  }
  function sendInitialize(id, params) {
    const requested = readProtocolVersion(params);
    const protocolVersion = requested !== void 0 && LEGACY_VERSIONS.includes(requested) ? requested : LEGACY_VERSION;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version }
      }
    });
  }
  function startToolCall(id, params) {
    const name = readToolName(params);
    if (name === null) {
      sendError(id, INVALID_PARAMS, "invalid params: tool name is required");
      return;
    }
    const key = idKey(id);
    if (key !== null) inFlight.add(key);
    const args = readToolArguments(params);
    void (async () => {
      let result;
      try {
        result = await dispatch(route, name, args);
      } catch (error) {
        result = failure2(error);
      }
      const wasCancelled = key !== null && cancelled.delete(key);
      if (key !== null) inFlight.delete(key);
      if (wasCancelled) return;
      write({ jsonrpc: "2.0", id, result: toCallResult(result) });
    })();
  }
  function handleData(chunk) {
    if (closed) return;
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      handleLine(line);
      index = buffer.indexOf("\n");
    }
  }
  async function finish() {
    if (finishing) return;
    finishing = true;
    try {
      await route.close();
    } catch (error) {
      note(stderr, "closing the browser route failed", error);
    }
    const drained = writeQueue;
    await drained.catch(() => void 0);
    if (!closed) {
      closed = true;
      resolveClosed();
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    stdin.removeListener("data", handleData);
    resolveClosed();
  }
  stdin.setEncoding?.("utf8");
  stdin.on("data", handleData);
  stdin.on("error", (error) => {
    note(stderr, "stdin failed", error);
  });
  stdin.on("end", () => {
    void finish();
  });
  return { closed: closedPromise, close };
}
function idKey(id) {
  if (typeof id === "number") return `n:${id}`;
  if (typeof id === "string") return `s:${id}`;
  return null;
}
function readObject(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value;
}
function readProtocolVersion(params) {
  const object = readObject(params);
  if (object === null) return void 0;
  const value = object.protocolVersion;
  return typeof value === "string" ? value : void 0;
}
function readRequestedVersion(params) {
  const object = readObject(params);
  if (object === null) return void 0;
  const meta = readObject(object._meta);
  if (meta !== null && typeof meta[PROTOCOL_META_KEY] === "string") {
    return meta[PROTOCOL_META_KEY];
  }
  return readProtocolVersion(object);
}
function readCancelledId(params) {
  const object = readObject(params);
  if (object === null) return void 0;
  return object.requestId;
}
function readToolName(params) {
  const object = readObject(params);
  if (object === null) return null;
  return typeof object.name === "string" ? object.name : null;
}
function readToolArguments(params) {
  const object = readObject(params);
  if (object === null) return {};
  return object.arguments ?? {};
}
function toCallResult(result) {
  const content = result.content.map(
    (block) => block.type === "text" ? { type: "text", text: block.text } : { type: "image", data: block.data, mimeType: block.mimeType }
  );
  const payload = { content };
  if (result.isError === true) payload.isError = true;
  return payload;
}
function failure2(error) {
  const message = error instanceof Error && error.message !== "" ? error.message : "browser tool failed.";
  return { content: [{ type: "text", text: message }], isError: true };
}
function note(stderr, message, error) {
  const detail = error === void 0 ? "" : error instanceof Error ? error.message : String(error);
  const line = detail === "" ? `browser-control: ${message}
` : `browser-control: ${message}: ${detail}
`;
  try {
    stderr.write(line);
  } catch {
  }
}

// packages/browser-control/src/main.ts
var VERSION = "0.1.0-alpha.8";
var USAGE = "usage: oxrail-browser-control [--version|--help]  (stdio MCP server for the Browser Control route)";
var INSTRUCTIONS = "This server drives its own headless Chrome through the Browser Control route. It is opt-in and separate from the person's browser: call browser_open before any other browser tool, and browser_close when the work is done.";
async function main(argv = process.argv.slice(2)) {
  if (argv.includes("--version")) {
    process.stdout.write(`oxrail-browser-control ${VERSION}
`);
    return 0;
  }
  if (argv.includes("--help")) {
    process.stdout.write(`${USAGE}
`);
    return 0;
  }
  for (const argument of argv) {
    if (!argument.startsWith("-")) continue;
    process.stderr.write(
      `browser-control: ignoring unknown argument ${argument}
`
    );
  }
  const { CdpBrowserRoute: CdpBrowserRoute2 } = await Promise.resolve().then(() => (init_route(), route_exports));
  const route = new CdpBrowserRoute2();
  const server = serveMcp({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    route,
    version: VERSION,
    instructions: INSTRUCTIONS
  });
  let shutdown = null;
  const stop = () => {
    shutdown ??= (async () => {
      try {
        await route.close();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `browser-control: closing the browser route failed: ${detail}
`
        );
      }
      server.close();
    })();
    return shutdown;
  };
  const onSignal = () => {
    void stop();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);
  await server.closed;
  await stop();
  process.exit(0);
}
function samePath(left, right) {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}
var entry = process.argv[1];
if (entry !== void 0 && samePath(entry, fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
export {
  VERSION,
  main
};
