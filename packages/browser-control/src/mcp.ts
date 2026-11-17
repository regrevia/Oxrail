/* A dual-era MCP server over stdio for the Browser Control route.
 *
 * The transport is newline-delimited JSON-RPC 2.0 on stdin/stdout. Two eras are
 * served: the modern `server/discover` handshake and the legacy
 * `initialize` / `tools/list` / `tools/call` sequence. Nothing but protocol
 * messages reaches stdout; diagnostics go to stderr.
 */

import type { BrowserRoute, ToolResult } from "./types.js";
import { TOOL_DEFINITIONS, dispatch } from "./tools.js";

export interface ServeOptions {
  stdin: NodeJS.ReadableStream;
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  route: BrowserRoute;
  version: string;
  instructions?: string;
}

export interface McpServer {
  /** Resolves once the server stopped reading and shut down. */
  readonly closed: Promise<void>;
  /** Stop at once; idempotent, and makes later writes no-ops. */
  close(): void;
}

const SERVER_NAME = "oxrail-browser-control";
const MODERN_VERSION = "2026-07-28";
const LEGACY_VERSION = "2025-11-25";
const SUPPORTED_VERSIONS: readonly string[] = [MODERN_VERSION];
const LEGACY_VERSIONS: readonly string[] = [MODERN_VERSION, LEGACY_VERSION];
const PROTOCOL_META_KEY = "io.modelcontextprotocol/protocolVersion";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const UNSUPPORTED_PROTOCOL_VERSION = -32022;

/** Serve JSON-RPC over the given streams until stdin ends or `close()` runs. */
export function serveMcp(options: ServeOptions): McpServer {
  const { stdin, stdout, stderr, route, version } = options;
  const instructions = options.instructions;

  let closed = false;
  let finishing = false;
  let buffer = "";
  let writeQueue: Promise<void> = Promise.resolve();
  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  /** Ids of calls still running, and ids that were cancelled meanwhile. */
  const inFlight = new Set<string>();
  const cancelled = new Set<string>();

  function write(payload: unknown): void {
    if (closed) return;
    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
    } catch (error) {
      note(stderr, "could not serialise a reply", error);
      return;
    }
    writeQueue = writeQueue
      .then(
        () =>
          new Promise<void>((resolve) => {
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
          }),
      )
      .catch((error: unknown) => {
        note(stderr, "the reply queue failed", error);
      });
  }

  function sendError(
    id: unknown,
    code: number,
    message: string,
    data?: unknown,
  ): void {
    const error: Record<string, unknown> = { code, message };
    if (data !== undefined) error.data = data;
    write({ jsonrpc: "2.0", id, error });
  }

  function handleLine(line: string): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      sendError(null, PARSE_ERROR, "parse error");
      return;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      sendError(null, INVALID_REQUEST, "invalid request");
      return;
    }
    handleMessage(parsed as Record<string, unknown>);
  }

  function handleMessage(message: Record<string, unknown>): void {
    const method = message.method;
    const id = message.id;
    const params = message.params;
    const hasId = id !== undefined;
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
          result: { tools: TOOL_DEFINITIONS },
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

  function handleNotification(method: string, params: unknown): void {
    if (method === "notifications/cancelled") {
      const requestId = readCancelledId(params);
      if (requestId !== undefined) {
        const key = idKey(requestId);
        if (key !== null && inFlight.has(key)) cancelled.add(key);
      }
    }
    // Unknown and lifecycle notifications are ignored; they cannot be answered.
  }

  function sendDiscover(id: unknown, params: unknown): void {
    const requested = readRequestedVersion(params);
    if (requested !== undefined && !SUPPORTED_VERSIONS.includes(requested)) {
      sendError(
        id,
        UNSUPPORTED_PROTOCOL_VERSION,
        "Unsupported protocol version",
        {
          supported: [...SUPPORTED_VERSIONS],
        },
      );
      return;
    }
    const result: Record<string, unknown> = {
      supportedVersions: [...SUPPORTED_VERSIONS],
      capabilities: { tools: {} },
      _meta: {
        [SERVER_INFO_META_KEY]: { name: SERVER_NAME, version },
      },
    };
    if (instructions !== undefined) result.instructions = instructions;
    write({ jsonrpc: "2.0", id, result });
  }

  function sendInitialize(id: unknown, params: unknown): void {
    const requested = readProtocolVersion(params);
    const protocolVersion =
      requested !== undefined && LEGACY_VERSIONS.includes(requested)
        ? requested
        : LEGACY_VERSION;
    write({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version },
      },
    });
  }

  function startToolCall(id: unknown, params: unknown): void {
    const name = readToolName(params);
    if (name === null) {
      sendError(id, INVALID_PARAMS, "invalid params: tool name is required");
      return;
    }
    const key = idKey(id);
    if (key !== null) inFlight.add(key);
    const args = readToolArguments(params);
    void (async () => {
      let result: ToolResult;
      try {
        result = await dispatch(route, name, args as Record<string, unknown>);
      } catch (error) {
        result = failure(error);
      }
      const wasCancelled = key !== null && cancelled.delete(key);
      if (key !== null) inFlight.delete(key);
      if (wasCancelled) return;
      write({ jsonrpc: "2.0", id, result: toCallResult(result) });
    })();
  }

  function handleData(chunk: string | Buffer): void {
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

  async function finish(): Promise<void> {
    if (finishing) return;
    finishing = true;
    try {
      await route.close();
    } catch (error) {
      note(stderr, "closing the browser route failed", error);
    }
    const drained = writeQueue;
    await drained.catch(() => undefined);
    if (!closed) {
      closed = true;
      resolveClosed();
    }
  }

  function close(): void {
    if (closed) return;
    closed = true;
    stdin.removeListener("data", handleData);
    resolveClosed();
  }

  stdin.setEncoding?.("utf8");
  stdin.on("data", handleData);
  stdin.on("error", (error: unknown) => {
    note(stderr, "stdin failed", error);
  });
  stdin.on("end", () => {
    void finish();
  });

  return { closed: closedPromise, close };
}

function idKey(id: unknown): string | null {
  if (typeof id === "number") return `n:${id}`;
  if (typeof id === "string") return `s:${id}`;
  return null;
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readProtocolVersion(params: unknown): string | undefined {
  const object = readObject(params);
  if (object === null) return undefined;
  const value = object.protocolVersion;
  return typeof value === "string" ? value : undefined;
}

function readRequestedVersion(params: unknown): string | undefined {
  const object = readObject(params);
  if (object === null) return undefined;
  const meta = readObject(object._meta);
  if (meta !== null && typeof meta[PROTOCOL_META_KEY] === "string") {
    return meta[PROTOCOL_META_KEY] as string;
  }
  return readProtocolVersion(object);
}

function readCancelledId(params: unknown): unknown {
  const object = readObject(params);
  if (object === null) return undefined;
  return object.requestId;
}

function readToolName(params: unknown): string | null {
  const object = readObject(params);
  if (object === null) return null;
  return typeof object.name === "string" ? object.name : null;
}

function readToolArguments(params: unknown): unknown {
  const object = readObject(params);
  if (object === null) return {};
  return object.arguments ?? {};
}

function toCallResult(result: ToolResult): Record<string, unknown> {
  const content = result.content.map((block) =>
    block.type === "text"
      ? { type: "text", text: block.text }
      : { type: "image", data: block.data, mimeType: block.mimeType },
  );
  const payload: Record<string, unknown> = { content };
  if (result.isError === true) payload.isError = true;
  return payload;
}

function failure(error: unknown): ToolResult {
  const message =
    error instanceof Error && error.message !== ""
      ? error.message
      : "browser tool failed.";
  return { content: [{ type: "text", text: message }], isError: true };
}

function note(
  stderr: NodeJS.WritableStream,
  message: string,
  error?: unknown,
): void {
  const detail =
    error === undefined
      ? ""
      : error instanceof Error
        ? error.message
        : String(error);
  const line =
    detail === ""
      ? `browser-control: ${message}\n`
      : `browser-control: ${message}: ${detail}\n`;
  try {
    stderr.write(line);
  } catch {
    // stderr is gone; there is nowhere left to report that.
  }
}
