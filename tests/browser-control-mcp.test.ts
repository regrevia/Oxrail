import { PassThrough } from "node:stream";

import { describe, expect, it } from "vitest";

import type { McpServer } from "../packages/browser-control/src/mcp.js";
import { serveMcp } from "../packages/browser-control/src/mcp.js";
import {
  TOOL_DEFINITIONS,
  dispatch,
} from "../packages/browser-control/src/tools.js";
import {
  RouteClosedError,
  StaleRefError,
} from "../packages/browser-control/src/types.js";
import type {
  BrowserRoute,
  LoginState,
  OpenOptions,
  ReadOptions,
  RouteState,
  Shot,
  ShotOptions,
  Snapshot,
  ToolResult,
} from "../packages/browser-control/src/types.js";

const TEST_VERSION = "0.1.0-alpha.8";

const TOOL_NAMES = [
  "browser_open",
  "browser_view",
  "browser_click",
  "browser_type",
  "browser_key",
  "browser_nav",
  "browser_shot",
  "browser_state",
  "browser_login",
  "browser_close",
];

interface RpcReply {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: unknown;
  params?: unknown;
}

interface Waiter {
  predicate: (reply: RpcReply) => boolean;
  resolve: (reply: RpcReply) => void;
}

interface Harness {
  route: FakeRoute;
  server: McpServer;
  messages: RpcReply[];
  outLines: string[];
  parseFailures: string[];
  stderrText(): string;
  send(message: Record<string, unknown>): void;
  sendRaw(line: string): void;
  waitFor(
    predicate: (reply: RpcReply) => boolean,
    timeoutMs?: number,
  ): Promise<RpcReply>;
  waitForReply(id: number | string): Promise<RpcReply>;
  pause(ms: number): Promise<void>;
  end(): Promise<void>;
}

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

/** A route that answers from fixed state; tests swap the impls to fail or hang. */
class FakeRoute implements BrowserRoute {
  closeCalls = 0;
  lastOpenOptions: OpenOptions | undefined = undefined;
  lastReadOptions: ReadOptions | undefined = undefined;
  shotPng = "iVBORw0KGgoAAAANSUhEUg==";
  shotPath = "/tmp/oxrail-browser-control/shot.png";
  snapshot: Snapshot = {
    url: "https://example.test/login",
    title: "Example login",
    text: "Sign in",
    controls: [
      { ref: 0, role: "button", name: "Sign in", tag: "button" },
      { ref: 1, role: "textbox", name: "Email", tag: "input" },
    ],
    truncated: false,
  };
  stateValue: RouteState = {
    running: true,
    pid: 4242,
    profile: "default",
    url: "https://example.test/login",
    title: "Example login",
    headless: true,
    idleMs: 0,
    closesInMs: null,
  };
  loginValue: LoginState = {
    profile: "default",
    saved: true,
    text: "saved sign-in for example.test",
  };
  readImpl: () => Promise<Snapshot> = async () => this.snapshot;
  clickImpl: (target: { ref?: number; text?: string }) => Promise<ToolResult> =
    async () => ok("clicked");
  stateImpl: () => Promise<RouteState> = async () => this.stateValue;

  async open(options?: OpenOptions): Promise<RouteState> {
    this.lastOpenOptions = options;
    return this.stateValue;
  }

  async read(options?: ReadOptions): Promise<Snapshot> {
    this.lastReadOptions = options;
    return this.readImpl();
  }

  async click(target: { ref?: number; text?: string }): Promise<ToolResult> {
    return this.clickImpl(target);
  }

  async type(target: {
    ref?: number;
    text: string;
    submit?: boolean;
    clear?: boolean;
  }): Promise<ToolResult> {
    return ok(`typed ${target.text}`);
  }

  async key(key: string): Promise<ToolResult> {
    return ok(`pressed ${key}`);
  }

  async nav(options: {
    url?: string;
    back?: boolean;
    reload?: boolean;
  }): Promise<RouteState> {
    return options.url === undefined ? this.stateValue : { ...this.stateValue };
  }

  async shot(options?: ShotOptions): Promise<Shot> {
    return options?.fullPage === true
      ? { png: this.shotPng, path: this.shotPath }
      : { png: this.shotPng, path: this.shotPath };
  }

  async state(): Promise<RouteState> {
    return this.stateImpl();
  }

  async login(): Promise<LoginState> {
    return this.loginValue;
  }

  async close(): Promise<RouteState> {
    this.closeCalls += 1;
    return { ...this.stateValue, running: false };
  }
}

function createHarness(
  overrides: { instructions?: string; version?: string } = {},
): Harness {
  const route = new FakeRoute();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const messages: RpcReply[] = [];
  const outLines: string[] = [];
  const parseFailures: string[] = [];
  const stderrChunks: string[] = [];
  const waiters: Waiter[] = [];
  let pending = "";

  const resolveWaiters = (reply: RpcReply): void => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index];
      if (waiter === undefined || !waiter.predicate(reply)) continue;
      waiters.splice(index, 1);
      waiter.resolve(reply);
    }
  };

  const handleChunk = (chunk: string | Buffer): void => {
    pending += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = pending.indexOf("\n");
    while (index !== -1) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (line.trim() !== "") {
        outLines.push(line);
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          parseFailures.push(line);
          index = pending.indexOf("\n");
          continue;
        }
        const reply = parsed as RpcReply;
        messages.push(reply);
        resolveWaiters(reply);
      }
      index = pending.indexOf("\n");
    }
  };

  stdout.setEncoding("utf8");
  stdout.on("data", handleChunk);
  stderr.setEncoding("utf8");
  stderr.on("data", (chunk: string | Buffer) => {
    stderrChunks.push(
      typeof chunk === "string" ? chunk : chunk.toString("utf8"),
    );
  });

  const server = serveMcp({
    stdin,
    stdout,
    stderr,
    route,
    version: overrides.version ?? TEST_VERSION,
    ...(overrides.instructions === undefined
      ? {}
      : { instructions: overrides.instructions }),
  });

  const harness: Harness = {
    route,
    server,
    messages,
    outLines,
    parseFailures,
    stderrText: () => stderrChunks.join(""),
    send: (message) => {
      stdin.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw: (line) => {
      stdin.write(`${line}\n`);
    },
    waitFor: (predicate, timeoutMs = 1000) => {
      const existing = messages.find((reply) => predicate(reply));
      if (existing !== undefined) return Promise.resolve(existing);
      return new Promise<RpcReply>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new Error(
              `timed out waiting for a reply; saw ${JSON.stringify(messages)}`,
            ),
          );
        }, timeoutMs);
        waiters.push({
          predicate,
          resolve: (reply) => {
            clearTimeout(timer);
            resolve(reply);
          },
        });
      });
    },
    waitForReply: (id) => harness.waitFor((reply) => reply.id === id),
    pause: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
    end: async () => {
      stdin.end();
      await server.closed;
    },
  };
  return harness;
}

function resultRecord(reply: RpcReply): Record<string, unknown> {
  if (
    typeof reply.result !== "object" ||
    reply.result === null ||
    Array.isArray(reply.result)
  ) {
    throw new Error(`reply has no result object: ${JSON.stringify(reply)}`);
  }
  return reply.result as Record<string, unknown>;
}

function contentBlocks(reply: RpcReply): Array<Record<string, unknown>> {
  const content = resultRecord(reply).content;
  if (!Array.isArray(content)) {
    throw new Error(`reply has no content array: ${JSON.stringify(reply)}`);
  }
  return content as Array<Record<string, unknown>>;
}

function firstBlock(reply: RpcReply): Record<string, unknown> {
  const block = contentBlocks(reply)[0];
  if (block === undefined) {
    throw new Error(`reply has no content block: ${JSON.stringify(reply)}`);
  }
  return block;
}

function firstText(result: ToolResult): string {
  const block = result.content[0];
  return block !== undefined && block.type === "text" ? block.text : "";
}

function expectCleanStdout(harness: Harness): void {
  expect(harness.parseFailures).toEqual([]);
  expect(harness.outLines.length).toBeGreaterThan(0);
  for (const line of harness.outLines) {
    expect(() => JSON.parse(line)).not.toThrow();
  }
}

describe("MCP server", () => {
  it("answers server/discover before any initialize", async () => {
    const harness = createHarness({ instructions: "read the page first" });
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {},
    });
    const reply = await harness.waitForReply(1);
    const result = resultRecord(reply);
    expect(result.supportedVersions).toEqual(["2026-07-28"]);
    expect(result.capabilities).toEqual({ tools: {} });
    expect(result.instructions).toBe("read the page first");
    const meta = result._meta as Record<string, unknown>;
    const serverInfo = meta["io.modelcontextprotocol/serverInfo"] as Record<
      string,
      unknown
    >;
    expect(serverInfo.name).toBe("oxrail-browser-control");
    expect(serverInfo.version).toBe(TEST_VERSION);
    await harness.end();
  });

  it("rejects an unsupported protocol version with -32022", async () => {
    const harness = createHarness();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "server/discover",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2000-01-01" },
      },
    });
    const failed = await harness.waitForReply(1);
    expect(failed.error?.code).toBe(-32022);
    expect(failed.error?.data).toEqual({ supported: ["2026-07-28"] });

    harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "server/discover",
      params: {
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" },
      },
    });
    const accepted = await harness.waitForReply(2);
    expect(resultRecord(accepted).supportedVersions).toEqual(["2026-07-28"]);
    await harness.end();
  });

  it("echoes a supported legacy version and stays silent on initialized", async () => {
    const harness = createHarness();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "test-host", version: "1.0.0" },
      },
    });
    const reply = await harness.waitForReply(1);
    const result = resultRecord(reply);
    expect(result.protocolVersion).toBe("2025-11-25");
    const serverInfo = result.serverInfo as Record<string, unknown>;
    expect(serverInfo.name).toBe("oxrail-browser-control");
    expect(serverInfo.version).toBe(TEST_VERSION);

    harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    await harness.pause(80);
    expect(harness.messages).toHaveLength(1);

    harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: { protocolVersion: "1999-01-01" },
    });
    const fallback = await harness.waitForReply(2);
    expect(resultRecord(fallback).protocolVersion).toBe("2025-11-25");
    await harness.end();
  });

  it("lists the ten tools in order with object schemas", async () => {
    const harness = createHarness();
    harness.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const reply = await harness.waitForReply(1);
    const tools = resultRecord(reply).tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(tools).toHaveLength(10);
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length);
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).trim().length).toBeGreaterThan(0);
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
    }
    await harness.end();
  });

  it("renders a page read as text with url and title", async () => {
    const harness = createHarness();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const text = firstBlock(await harness.waitForReply(1)).text as string;
    expect(text).toContain("Sign in");
    expect(text).toContain('[0] button "Sign in"');
    expect(text).toContain("url: https://example.test/login");
    expect(text).toContain("title: Example login");
    expect(text).not.toContain("truncated");

    harness.route.snapshot = {
      ...harness.route.snapshot,
      title: "",
      truncated: true,
    };
    harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_view", arguments: { maxChars: 40 } },
    });
    const second = firstBlock(await harness.waitForReply(2)).text as string;
    expect(second).toContain("truncated: true");
    expect(second).toContain("controls: 2");
    expect(second).not.toContain("title:");
    expect(harness.route.lastReadOptions).toEqual({ maxChars: 40 });
    await harness.end();
  });

  it("renders each named control as a numbered ref line", async () => {
    const harness = createHarness();
    harness.route.snapshot = {
      url: "https://example.test/",
      title: "",
      text: "hello there",
      controls: [
        { ref: 1, role: "button", name: "Go", tag: "button" },
        { ref: 2, role: "generic", name: "", tag: "div" },
      ],
      truncated: false,
    };
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const text = firstBlock(await harness.waitForReply(1)).text as string;
    expect(text).toBe(
      'hello there\n[1] button "Go"\nurl: https://example.test/',
    );
    await harness.end();
  });

  it("says (blank page) when a read has no text and no controls", async () => {
    const harness = createHarness();
    harness.route.snapshot = {
      url: "",
      title: "",
      text: "",
      controls: [],
      truncated: false,
    };
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    expect(firstBlock(await harness.waitForReply(1)).text).toBe("(blank page)");
    await harness.end();
  });

  it("tells the model to open the browser when the route is closed", async () => {
    const harness = createHarness();
    harness.route.readImpl = async () => {
      throw new RouteClosedError("closed");
    };
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const result = await harness.waitForReply(1);
    expect(resultRecord(result).isError).toBe(true);
    expect(firstBlock(result).text).toBe(
      "no browser is running. Call browser_open first.",
    );
    await harness.end();
  });

  it("reports browser state and sign-in state as compact text", async () => {
    const harness = createHarness();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_state", arguments: {} },
    });
    const stateText = firstBlock(await harness.waitForReply(1)).text as string;
    expect(stateText).toContain("running: true");
    expect(stateText).toContain("pid: 4242");
    expect(stateText).toContain("profile: default");
    expect(stateText).toContain("idleMs: 0");
    expect(stateText).toContain("closesInMs: null");

    harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_login", arguments: {} },
    });
    const loginText = firstBlock(await harness.waitForReply(2)).text as string;
    expect(loginText).toContain("profile: default");
    expect(loginText).toContain("saved: true");
    expect(loginText).toContain("saved sign-in for example.test");

    harness.route.stateValue = {
      ...harness.route.stateValue,
      running: false,
      pid: null,
      url: null,
      title: null,
      closesInMs: null,
    };
    harness.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "browser_state", arguments: {} },
    });
    const stopped = firstBlock(await harness.waitForReply(3)).text as string;
    expect(stopped).toBe("running: false\nprofile: default");
    await harness.end();
  });

  it("returns a screenshot as an image block then the saved path", async () => {
    const harness = createHarness();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_shot", arguments: { fullPage: true } },
    });
    const blocks = contentBlocks(await harness.waitForReply(1));
    expect(blocks[0]?.type).toBe("image");
    expect(blocks[0]?.mimeType).toBe("image/png");
    expect(blocks[0]?.data).toBe(harness.route.shotPng);
    expect(blocks[1]?.type).toBe("text");
    expect(blocks[1]?.text).toBe(`saved ${harness.route.shotPath}`);
    await harness.end();
  });

  it("turns thrown route errors into isError results", async () => {
    const harness = createHarness();
    harness.route.readImpl = async () => {
      throw new Error("page is gone");
    };
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const gone = await harness.waitForReply(1);
    expect(resultRecord(gone).isError).toBe(true);
    expect(firstBlock(gone).text).toBe("page is gone");
    expect(harness.stderrText()).not.toContain("page is gone");

    harness.route.clickImpl = async () => {
      throw new StaleRefError("stale");
    };
    harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_click", arguments: { ref: 3 } },
    });
    const stale = await harness.waitForReply(2);
    expect(resultRecord(stale).isError).toBe(true);
    expect(firstBlock(stale).text as string).toContain("browser_view");

    harness.route.stateImpl = async () => {
      throw new RouteClosedError("closed");
    };
    harness.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "browser_state", arguments: {} },
    });
    const closed = await harness.waitForReply(3);
    expect(firstBlock(closed).text as string).toContain("browser_open");
    await harness.end();
  });

  it("drops the reply for a cancelled call and keeps serving", async () => {
    const harness = createHarness();
    let release: () => void = () => {};
    harness.route.clickImpl = () =>
      new Promise<ToolResult>((resolve) => {
        release = () => resolve(ok("late"));
      });
    harness.send({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name: "browser_click", arguments: { ref: 0 } },
    });
    harness.send({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 20, reason: "moved on" },
    });
    await harness.pause(60);
    release();
    await harness.pause(120);
    expect(
      harness.messages.filter((message) => message.id === 20),
    ).toHaveLength(0);

    harness.route.clickImpl = async () => ok("clicked");
    harness.send({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: { name: "browser_click", arguments: { text: "Sign in" } },
    });
    const reply = await harness.waitForReply(21);
    expect(firstBlock(reply).text).toBe("clicked");
    await harness.end();
  });

  it("answers a parse error and an unknown method, and ignores notifications", async () => {
    const harness = createHarness();
    harness.sendRaw("{not json");
    const parseError = await harness.waitFor(
      (reply) => reply.error?.code === -32700,
    );
    expect(parseError.id).toBeNull();

    harness.send({ jsonrpc: "2.0", id: 5, method: "tools/frobnicate" });
    const unknown = await harness.waitForReply(5);
    expect(unknown.error?.code).toBe(-32601);

    harness.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    harness.send({
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "p" },
    });
    await harness.pause(80);
    expect(harness.messages).toHaveLength(2);

    harness.send({ jsonrpc: "2.0", id: 6, method: "ping" });
    expect(resultRecord(await harness.waitForReply(6))).toEqual({});
    expectCleanStdout(harness);
    await harness.end();
  });

  it("closes the route once when stdin ends, and close is idempotent", async () => {
    const harness = createHarness();
    await harness.end();
    expect(harness.route.closeCalls).toBe(1);
    harness.server.close();
    harness.server.close();
    await expect(harness.server.closed).resolves.toBeUndefined();
  });
});

describe("tool dispatch", () => {
  it("rejects an unknown argument instead of crashing", async () => {
    const route = new FakeRoute();
    const result = await dispatch(route, "browser_view", { bogus: true });
    expect(result.isError).toBe(true);
    expect(firstText(result)).toContain("bogus");
  });

  it("requires exactly one of ref and text for a click", async () => {
    const route = new FakeRoute();
    const both = await dispatch(route, "browser_click", {
      ref: 1,
      text: "Sign in",
    });
    expect(both.isError).toBe(true);
    expect(firstText(both)).toContain("not both");

    const neither = await dispatch(route, "browser_click", {});
    expect(neither.isError).toBe(true);

    const clicked = await dispatch(route, "browser_click", { ref: 1 });
    expect(clicked.isError).toBeUndefined();
    expect(firstText(clicked)).toBe("clicked");
  });

  it("coerces an unambiguous integer string and rejects a non-object argument", async () => {
    const route = new FakeRoute();
    const result = await dispatch(route, "browser_view", { maxChars: "12" });
    expect(result.isError).toBeUndefined();
    expect(route.lastReadOptions?.maxChars).toBe(12);

    const bad = await dispatch(
      route,
      "browser_view",
      7 as unknown as Record<string, unknown>,
    );
    expect(bad.isError).toBe(true);
    expect(firstText(bad)).toContain("object");
  });

  it("answers an unknown tool with a short isError result", async () => {
    const route = new FakeRoute();
    const result = await dispatch(route, "browser_nope", {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("unknown tool: browser_nope");
  });
});
