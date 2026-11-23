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
  DigestOptions,
  LoginState,
  OpenOptions,
  ReadOptions,
  RouteState,
  Shot,
  ShotOptions,
  Snapshot,
  ToolResult,
  AskOptions,
  ModeOptions,
  ReviewOptions,
  ReviewVerdictOptions,
  CheckOptions,
  ClipboardOptions,
  CookieOptions,
  DialogOptions,
  DragOptions,
  EvalOptions,
  ExtractOptions,
  FindOptions,
  GrabOptions,
  HoverOptions,
  LogOptions,
  LookOptions,
  MediaOptions,
  NetworkOptions,
  PrepareOptions,
  ScrollOptions,
  SelectOptions,
  Step,
  TabsOptions,
  UploadOptions,
  WaitOptions,
} from "../packages/browser-control/src/types.js";

const TEST_VERSION = "0.1.0-alpha.8";

const TOOL_NAMES = [
  "browser_open",
  "browser_view",
  "browser_read",
  "browser_click",
  "browser_type",
  "browser_key",
  "browser_nav",
  "browser_shot",
  "browser_state",
  "browser_login",
  "browser_find",
  "browser_extract",
  "browser_look",
  "browser_wait",
  "browser_scroll",
  "browser_hover",
  "browser_check",
  "browser_select",
  "browser_drag",
  "browser_upload",
  "browser_grab",
  "browser_eval",
  "browser_do",
  "browser_dialog",
  "browser_cookie",
  "browser_clipboard",
  "browser_console",
  "browser_network",
  "browser_failed",
  "browser_tabs",
  "browser_downloads",
  "browser_media",
  "browser_pdf",
  "browser_prepare",
  "browser_mode",
  "browser_ask",
  "browser_review",
  "browser_review_verdict",
  "browser_resume",
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
    headless: false,
    idleMs: 0,
    closesInMs: null,
  };
  loginValue: LoginState = {
    profile: "default",
    saved: true,
    text: "saved sign-in for example.test",
  };
  readImpl: () => Promise<Snapshot> = async () => this.snapshot;
  lastDigestOptions: DigestOptions | undefined = undefined;
  digestImpl: (options: DigestOptions) => Promise<Snapshot> = async () =>
    this.snapshot;
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

  async digest(options: DigestOptions): Promise<Snapshot> {
    this.lastDigestOptions = options;
    return this.digestImpl(options);
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

  /* The tools beyond the first eleven. Each records that it was reached and
     what it was handed, so a test can assert the tool handed the route the
     arguments it parsed instead of a plausible-looking default. */
  reached: string[] = [];
  handedTo: Record<string, unknown> = {};

  #reached(name: string, options: unknown): ToolResult {
    this.reached.push(name);
    this.handedTo[name] = options;
    return ok(`${name} ok`);
  }

  async find(options: FindOptions): Promise<ToolResult> {
    return this.#reached("find", options);
  }
  async extract(options: ExtractOptions): Promise<ToolResult> {
    return this.#reached("extract", options);
  }
  async look(options: LookOptions): Promise<ToolResult> {
    return this.#reached("look", options);
  }
  async wait(options: WaitOptions): Promise<ToolResult> {
    return this.#reached("wait", options);
  }
  async scroll(options: ScrollOptions): Promise<ToolResult> {
    return this.#reached("scroll", options);
  }
  async hover(options: HoverOptions): Promise<ToolResult> {
    return this.#reached("hover", options);
  }
  async check(options: CheckOptions): Promise<ToolResult> {
    return this.#reached("check", options);
  }
  async select(options: SelectOptions): Promise<ToolResult> {
    return this.#reached("select", options);
  }
  async drag(options: DragOptions): Promise<ToolResult> {
    return this.#reached("drag", options);
  }
  async upload(options: UploadOptions): Promise<ToolResult> {
    return this.#reached("upload", options);
  }
  async grab(options: GrabOptions): Promise<ToolResult> {
    return this.#reached("grab", options);
  }
  async evaluatePage(options: EvalOptions): Promise<ToolResult> {
    return this.#reached("evaluatePage", options);
  }
  async run(steps: readonly Step[]): Promise<ToolResult> {
    return this.#reached("run", steps);
  }
  async dialog(options: DialogOptions): Promise<ToolResult> {
    return this.#reached("dialog", options);
  }
  async cookie(options: CookieOptions): Promise<ToolResult> {
    return this.#reached("cookie", options);
  }
  async clipboard(options: ClipboardOptions): Promise<ToolResult> {
    return this.#reached("clipboard", options);
  }
  async console(options: LogOptions): Promise<ToolResult> {
    return this.#reached("console", options);
  }
  async network(options: NetworkOptions): Promise<ToolResult> {
    return this.#reached("network", options);
  }
  async failed(options: LogOptions): Promise<ToolResult> {
    return this.#reached("failed", options);
  }
  async tabs(options: TabsOptions): Promise<ToolResult> {
    return this.#reached("tabs", options);
  }
  async downloads(): Promise<ToolResult> {
    return this.#reached("downloads", {});
  }
  async media(options: MediaOptions): Promise<ToolResult> {
    return this.#reached("media", options);
  }
  async pdf(): Promise<ToolResult> {
    return this.#reached("pdf", {});
  }
  async prepare(options: PrepareOptions): Promise<ToolResult> {
    return this.#reached("prepare", options);
  }
  async mode(options?: ModeOptions): Promise<ToolResult> {
    return this.#reached("mode", options);
  }
  async ask(options: AskOptions): Promise<ToolResult> {
    return this.#reached("ask", options);
  }
  async review(options?: ReviewOptions): Promise<ToolResult> {
    return this.#reached("review", options);
  }
  async reviewVerdict(options?: ReviewVerdictOptions): Promise<ToolResult> {
    return this.#reached("reviewVerdict", options);
  }
  async resume(): Promise<ToolResult> {
    return this.#reached("resume", {});
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

  /* Every tool past the first eleven has to arrive at the route with its
   * arguments translated, not merely be listed. A spec whose validator drops a
   * field, or whose `run` forgets a spread, still lists and still answers, so
   * listing alone proves nothing: each case below names the route method that
   * must be reached and the arguments it must receive. */
  it("carries every later tool through to the route with its arguments", async () => {
    const cases: Array<{
      tool: string;
      args: Record<string, unknown>;
      reaches: string;
      expect: Record<string, unknown>;
    }> = [
      {
        tool: "browser_find",
        args: { query: "pricing", regex: true, limit: 5 },
        reaches: "find",
        expect: { query: "pricing", regex: true, limit: 5 },
      },
      {
        tool: "browser_extract",
        args: { select: "h1", ref: 2, limit: 3 },
        reaches: "extract",
        expect: { select: "h1", ref: 2, limit: 3 },
      },
      {
        tool: "browser_look",
        args: { cols: 8, diff: false },
        reaches: "look",
        expect: { cols: 8, diff: false },
      },
      {
        tool: "browser_wait",
        args: { gone: "Loading", timeoutMs: 250 },
        reaches: "wait",
        expect: { gone: "Loading", timeoutMs: 250 },
      },
      {
        tool: "browser_scroll",
        args: { dy: 400, read: true },
        reaches: "scroll",
        expect: { dy: 400, read: true },
      },
      {
        tool: "browser_hover",
        args: { text: "Menu", read: false },
        reaches: "hover",
        expect: { text: "Menu", read: false },
      },
      {
        tool: "browser_check",
        args: { ref: 4, checked: true },
        reaches: "check",
        expect: { ref: 4, checked: true },
      },
      {
        tool: "browser_select",
        args: { field: "country", value: "JP" },
        reaches: "select",
        expect: { field: "country", value: "JP" },
      },
      {
        tool: "browser_drag",
        args: { fromRef: 3, toRef: 4 },
        reaches: "drag",
        expect: { fromRef: 3, toRef: 4 },
      },
      {
        tool: "browser_upload",
        args: { ref: 7, files: ["/tmp/a.txt"] },
        reaches: "upload",
        expect: { ref: 7, files: ["/tmp/a.txt"] },
      },
      {
        tool: "browser_grab",
        args: { name: "logo", count: 2 },
        reaches: "grab",
        expect: { name: "logo", count: 2 },
      },
      {
        tool: "browser_eval",
        args: { code: "1 + 1", awaitPromise: false },
        reaches: "evaluatePage",
        expect: { code: "1 + 1", awaitPromise: false },
      },
      {
        tool: "browser_dialog",
        args: { accept: false, text: "no" },
        reaches: "dialog",
        expect: { accept: false, text: "no" },
      },
      {
        tool: "browser_cookie",
        args: { domain: "example.com", clear: true },
        reaches: "cookie",
        expect: { domain: "example.com", clear: true },
      },
      {
        tool: "browser_clipboard",
        args: { set: "hello" },
        reaches: "clipboard",
        expect: { set: "hello" },
      },
      {
        tool: "browser_console",
        args: { limit: 5 },
        reaches: "console",
        expect: { limit: 5 },
      },
      {
        tool: "browser_network",
        args: { filter: "api", limit: 4 },
        reaches: "network",
        expect: { filter: "api", limit: 4 },
      },
      { tool: "browser_failed", args: {}, reaches: "failed", expect: {} },
      {
        tool: "browser_tabs",
        args: { action: "switch", index: 1 },
        reaches: "tabs",
        expect: { action: "switch", index: 1 },
      },
      { tool: "browser_downloads", args: {}, reaches: "downloads", expect: {} },
      {
        tool: "browser_media",
        args: { all: true, save: "/tmp/x.mp4" },
        reaches: "media",
        expect: { all: true, save: "/tmp/x.mp4" },
      },
      { tool: "browser_pdf", args: {}, reaches: "pdf", expect: {} },
      {
        tool: "browser_prepare",
        args: { seconds: 3, focus: false },
        reaches: "prepare",
        expect: { seconds: 3, focus: false },
      },
      { tool: "browser_mode", args: {}, reaches: "mode", expect: {} },
      {
        tool: "browser_mode",
        args: { display: "headless" },
        reaches: "mode",
        expect: { display: "headless" },
      },
      {
        tool: "browser_ask",
        args: { text: "Message", said: "hello", submit: false, timeoutMs: 900 },
        reaches: "ask",
        expect: {
          text: "Message",
          said: "hello",
          submit: false,
          timeoutMs: 900,
        },
      },
      {
        tool: "browser_review",
        args: { ref: 3, timeoutMs: 700 },
        reaches: "review",
        expect: { ref: 3, timeoutMs: 700 },
      },
      {
        tool: "browser_review_verdict",
        args: { marks: [{ point: 2, verdict: "fixed" }] },
        reaches: "reviewVerdict",
        expect: { marks: [{ point: 2, verdict: "fixed" }] },
      },
      { tool: "browser_resume", args: {}, reaches: "resume", expect: {} },
    ];
    for (const [index, testCase] of cases.entries()) {
      const harness = createHarness();
      harness.send({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: { name: testCase.tool, arguments: testCase.args },
      });
      const reply = await harness.waitForReply(index + 1);
      expect(
        resultRecord(reply).isError,
        `${testCase.tool} answered with an error: ${JSON.stringify(resultRecord(reply).content)}`,
      ).toBeUndefined();
      expect(
        harness.route.reached,
        `${testCase.tool} did not reach ${testCase.reaches}`,
      ).toContain(testCase.reaches);
      expect(
        harness.route.handedTo[testCase.reaches],
        `${testCase.tool} handed the wrong arguments to ${testCase.reaches}`,
      ).toEqual(testCase.expect);
      await harness.end();
    }
  });

  it("rejects a display value the mode tool cannot honour", async () => {
    const harness = createHarness();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_mode", arguments: { display: "hidden" } },
    });
    const reply = await harness.waitForReply(1);
    expect(resultRecord(reply).isError).toBe(true);
    expect(harness.route.reached).not.toContain("mode");
    await harness.end();
  });

  it("refuses a drag that names only one end", async () => {
    for (const args of [{ fromRef: 3 }, { toRef: 4 }, {}]) {
      const harness = createHarness();
      harness.send({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "browser_drag", arguments: args },
      });
      const reply = await harness.waitForReply(1);
      expect(
        resultRecord(reply).isError,
        `${JSON.stringify(args)} was allowed`,
      ).toBe(true);
      expect(harness.route.reached).not.toContain("drag");
      await harness.end();
    }
  });

  it("lists every tool in order with object schemas", async () => {
    const harness = createHarness();
    harness.send({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    const reply = await harness.waitForReply(1);
    const tools = resultRecord(reply).tools as Array<Record<string, unknown>>;
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_NAMES);
    expect(tools).toHaveLength(TOOL_NAMES.length);
    expect(tools).toHaveLength(TOOL_DEFINITIONS.length);
    // SEP-2549 makes a 2026-07-28 list result cacheable, and the client rejects
    // the reply without both fields rather than defaulting them.
    expect(typeof resultRecord(reply).ttlMs).toBe("number");
    expect(resultRecord(reply).cacheScope).toBe("private");
    for (const tool of tools) {
      expect(typeof tool.description).toBe("string");
      expect((tool.description as string).trim().length).toBeGreaterThan(0);
      const schema = tool.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
    }
    await harness.end();
  });

  // Revision 2026-07-28 makes resultType mandatory on every result; the older
  // codec deletes it before validating, so a missing discriminator passes at
  // 2025-11-25 and is rejected only by a modern client. Guarding every envelope
  // here keeps a modern client from rejecting the handshake for one method.
  it("stamps resultType complete on every result envelope", async () => {
    const cases: Array<{
      id: number;
      method: string;
      params: Record<string, unknown>;
    }> = [
      {
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2026-07-28" },
      },
      { id: 2, method: "server/discover", params: {} },
      { id: 3, method: "tools/list", params: {} },
      { id: 4, method: "ping", params: {} },
      {
        id: 5,
        method: "tools/call",
        params: { name: "browser_state", arguments: {} },
      },
    ];
    for (const testCase of cases) {
      const harness = createHarness();
      harness.send({
        jsonrpc: "2.0",
        id: testCase.id,
        method: testCase.method,
        params: testCase.params,
      });
      const reply = await harness.waitForReply(testCase.id);
      expect(reply.error, `${testCase.method} failed`).toBeUndefined();
      expect(resultRecord(reply).resultType, testCase.method).toBe("complete");
      await harness.end();
    }
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
    /* A bare `truncated` leaves the caller unable to tell a control budget
       from a character one, and the two ask for different next reads. */
    expect(second).not.toContain("limit:");
    expect(second).not.toContain("title:");

    /* When a cap did fire, the render says which one, so the caller knows
       whether to re-read with `map` or with `article`. */
    harness.route.snapshot = {
      ...harness.route.snapshot,
      title: "",
      truncated: true,
      limit: "controls",
    };
    harness.send({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "browser_view", arguments: { maxChars: 40 } },
    });
    const third = firstBlock(await harness.waitForReply(3)).text as string;
    expect(third).toContain("limit: controls");
    expect(third).toContain("truncated: true");

    expect(harness.route.lastReadOptions).toEqual({ maxChars: 40 });
    await harness.end();
  });

  it("passes a reading request through and renders its counts", async () => {
    const harness = createHarness();
    /* An article read has no controls to number: the column is prose. */
    harness.route.digestImpl = async () => ({
      ...harness.route.snapshot,
      mode: "article",
      text: "## Returns\nRefunds are paid within three working days.",
      controls: [],
      truncated: true,
      chars: 52,
      words: 812,
    });
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_read", arguments: {} },
    });
    const text = firstBlock(await harness.waitForReply(1)).text as string;
    /* The default is the reading column, not the page, and no budget was
       asked for so none is invented. */
    expect(harness.route.lastDigestOptions).toEqual({ mode: "article" });
    expect(text).toContain("three working days");
    expect(text).toContain("url: https://example.test/login");
    expect(text).toContain("title: Example login");
    expect(text).toContain("controls: 0");
    expect(text).toContain("truncated: true");

    /* The answer mode carries the question and its own counts. The controls
       come back with it: a read that numbers nothing makes every write on the
       page unaddressable, so the column and the refs travel together. */
    harness.route.digestImpl = async () => ({
      ...harness.route.snapshot,
      mode: "query",
      text: "## Returns\nRefunds are paid within three working days.",
      controls: [
        { ref: 1, role: "button", name: "Track parcel" },
        { ref: 2, role: "link", name: "Start a return" },
      ],
      truncated: false,
      chars: 52,
      words: 812,
      matched: 1,
      total: 40,
    });
    harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "browser_read",
        arguments: {
          mode: "query",
          query: "how long do refunds take",
          maxChars: 900,
        },
      },
    });
    const answer = firstBlock(await harness.waitForReply(2)).text as string;
    expect(harness.route.lastDigestOptions).toEqual({
      mode: "query",
      query: "how long do refunds take",
      maxChars: 900,
    });
    expect(answer).toContain("three working days");
    expect(answer).toContain("chars: 52");
    expect(answer).toContain("words: 812");
    expect(answer).toContain("passages: 1 of 40 blocks");
    expect(answer).not.toContain("truncated");
    /* Both numbered controls came back with the answer, so the answer itself
       is addressable rather than only readable. */
    expect(answer).toContain(`[1] button "Track parcel"`);
    expect(answer).toContain(`[2] link "Start a return"`);
    await harness.end();
  });

  it("shortens a page-supplied URL instead of handing it over whole", async () => {
    const harness = createHarness();
    /* A `data:` URL carries an entire document in its own address, so the
       address is page text and gets the same suspicion as page text. The
       snapshot keeps it exact — a `changed` read compares it against the last
       one — and only the rendering is cut. */
    const long = `https://example.test/search?q=${"x".repeat(5000)}`;
    harness.route.snapshot = { ...harness.route.snapshot, url: long };
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const text = firstBlock(await harness.waitForReply(1)).text as string;
    expect(text.length).toBeLessThan(long.length);
    expect(text).toContain("more characters)");
    expect(text).not.toContain(long);
    /* What is kept is the part that identifies the page, not a prefix so short
       that two pages look alike. */
    expect(text).toContain("https://example.test/search?q=xxxx");
    await harness.end();
  });

  it("a reading that left controls out says how many, and they still work", async () => {
    const harness = createHarness();
    /* A page that generates its list is the normal case: answering one
       question is worth leaving most of the numbering out, but only if the
       reading admits it — a page with three buttons and a page whose other
       157 were not printed look identical otherwise. */
    harness.route.readImpl = async () => ({
      ...harness.route.snapshot,
      controls: [{ ref: 0, role: "button", name: "Add to cart" }],
      omitted: 157,
    });
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const text = firstBlock(await harness.waitForReply(1)).text as string;
    expect(text).toContain("controls not shown: 157");
    /* The sentence has to say the numbers survive, or the count reads as a
       warning that the rest of the page is unreachable. */
    expect(text).toContain("their numbers still work");
    await harness.end();
  });

  it("a reading that left nothing out says nothing about it", async () => {
    const harness = createHarness();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const text = firstBlock(await harness.waitForReply(1)).text as string;
    expect(text).not.toContain("controls not shown");
    await harness.end();
  });

  it("the answer mode hands its question to the route", async () => {
    const harness = createHarness();
    /* The question is the whole point of the mode; a route that never sees it
       cannot rank passages, and the failure looks like a page that is short
       rather than a read that was never asked. */
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "browser_read",
        arguments: { mode: "query", query: "refund policy" },
      },
    });
    await harness.waitForReply(1);
    expect(harness.route.lastDigestOptions?.query).toBe("refund policy");
    await harness.end();
  });

  it("the description promises the folded form the read actually prints", async () => {
    const harness = createHarness();
    /* A caller learns the folded shape from the tool description before it
       ever reads a page, so the example there has to be one this read really
       produces — otherwise the first folded line looks like a different
       control and the range is never used. */
    harness.send({ jsonrpc: "2.0", id: 9, method: "tools/list", params: {} });
    const listed = resultRecord(await harness.waitForReply(9)).tools as Array<
      Record<string, unknown>
    >;
    const view = listed.find((one) => one.name === "browser_view");
    const said = String(view?.description ?? "");
    harness.route.snapshot = {
      ...harness.route.snapshot,
      controls: Array.from({ length: 40 }, (_, at) => ({
        ref: at,
        role: "button",
        name: `Item ${at}`,
      })),
    };
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const printed = firstBlock(await harness.waitForReply(1)).text as string;
    for (const piece of ["[0]-[39]", "40 controls, one line", '"Item 0"'])
      expect(said).toContain(piece);
    expect(said).toContain("[0]-[39]");
    expect(printed).toContain("[0]-[39]");
    await harness.end();
  });

  it("no query is no filter", async () => {
    const harness = createHarness();
    harness.route.snapshot = {
      ...harness.route.snapshot,
      controls: [
        { ref: 0, role: "button", name: "Add to cart" },
        { ref: 1, role: "link", name: "Help" },
      ],
    };
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const text = firstBlock(await harness.waitForReply(1)).text as string;
    expect(text).toContain('[0] button "Add to cart"');
    expect(text).toContain('[1] link "Help"');
    expect(text).not.toContain("controls not shown");
    await harness.end();
  });

  it("a long run of generated controls is one line, not forty", async () => {
    const harness = createHarness();
    harness.route.snapshot = {
      ...harness.route.snapshot,
      controls: Array.from({ length: 40 }, (_, at) => ({
        ref: at,
        role: "button",
        name: `Item ${at}`,
      })),
    };
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_view", arguments: {} },
    });
    const text = firstBlock(await harness.waitForReply(1)).text as string;
    expect(text).toContain("40 controls, one line");
    expect(text).toContain("[0]-[39]");
    expect(text).not.toContain('[7] button "Item 7"');
    await harness.end();
  });

  it("refuses the answer mode without a question", async () => {
    const harness = createHarness();
    harness.send({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "browser_read", arguments: { mode: "query" } },
    });
    const reply = await harness.waitForReply(1);
    expect(JSON.stringify(reply)).toContain("needs a query");
    await harness.end();
  });

  it("rejects an unknown reading mode", async () => {
    const harness = createHarness();
    const result = await dispatch(harness.route, "browser_read", {
      mode: "summary",
    });
    expect(JSON.stringify(result)).toContain("mode");
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

    /* A refusal that comes with its own sentence keeps it: the throw site is
       the only place that knows whether the number was never read, has left
       the page, or names content inside a frame, and those need different next
       steps. Only a refusal with nothing to say gets the blanket line. */
    harness.route.clickImpl = async () => {
      throw new StaleRefError(
        "control 3 cannot be addressed: the last read of https://example.com/ did not contain it — call browser_view again and use a number it returns",
      );
    };
    harness.send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "browser_click", arguments: { ref: 3 } },
    });
    const stale = await harness.waitForReply(2);
    expect(resultRecord(stale).isError).toBe(true);
    expect(firstBlock(stale).text as string).toContain(
      "control 3 cannot be addressed",
    );
    expect(firstBlock(stale).text as string).toContain("browser_view");

    harness.route.clickImpl = async () => {
      throw new StaleRefError("");
    };
    harness.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "browser_click", arguments: { ref: 4 } },
    });
    const wordless = await harness.waitForReply(4);
    expect(resultRecord(wordless).isError).toBe(true);
    expect(firstBlock(wordless).text as string).toContain("browser_view");

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
    // A ping result is empty apart from the mandatory discriminator.
    expect(resultRecord(await harness.waitForReply(6))).toEqual({
      resultType: "complete",
    });
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

  /* One refusal per argument kind, because a kind that silently accepts the
     wrong shape is how a typo becomes a click on the wrong control. Each of
     these is the shape a caller actually sends by mistake. */
  it("refuses the wrong shape for every argument kind", async () => {
    const route = new FakeRoute();
    const cases: Array<{
      tool: string;
      args: Record<string, unknown>;
      says: string;
    }> = [
      { tool: "browser_open", args: { url: 7 }, says: "must be a string" },
      {
        tool: "browser_open",
        args: { headless: "yes" },
        says: "must be a boolean",
      },
      {
        tool: "browser_view",
        args: { maxChars: 1.5 },
        says: "must be an integer",
      },
      {
        tool: "browser_read",
        args: { mode: "everything" },
        says: "must be one of",
      },
      {
        tool: "browser_upload",
        args: { files: "/tmp/one.png" },
        says: "must be a list of strings",
      },
      {
        tool: "browser_upload",
        args: { files: [7] },
        says: "must be a list of strings",
      },
      {
        tool: "browser_do",
        args: { steps: "click the button" },
        says: "must be a list of steps",
      },
      {
        tool: "browser_do",
        args: { steps: ["click"] },
        says: "must be an object",
      },
      {
        tool: "browser_review_verdict",
        args: { marks: "all fixed" },
        says: "must be a list of marks",
      },
      {
        tool: "browser_review_verdict",
        args: { marks: [{ point: "3", verdict: "fixed" }] },
        says: "point has to be a whole number",
      },
      {
        tool: "browser_review_verdict",
        args: { marks: [{ point: 3, verdict: "maybe" }] },
        says: "verdict has to be",
      },
    ];
    for (const { tool, args, says } of cases) {
      const result = await dispatch(route, tool, args);
      expect(result.isError, `${tool} ${JSON.stringify(args)}`).toBe(true);
      expect(firstText(result), `${tool} ${JSON.stringify(args)}`).toContain(
        says,
      );
    }
  });

  it("answers an unknown tool with a short isError result", async () => {
    const route = new FakeRoute();
    const result = await dispatch(route, "browser_nope", {});
    expect(result.isError).toBe(true);
    expect(firstText(result)).toBe("unknown tool: browser_nope");
  });
});
