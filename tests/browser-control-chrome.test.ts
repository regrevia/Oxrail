/* The transport pieces of the Browser Control route, tested without launching
 * Chrome: flag construction, the DevTools port wait, and the WebSocket/CDP
 * plumbing against a fake loopback server and a fake socket.
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CdpConnection,
  type CdpError,
} from "../packages/browser-control/src/cdp.js";
import {
  chromeArgs,
  chromeBinary,
  clearStaleDevToolsPort,
  profileDir,
  waitForDevToolsPort,
  type ChromeDeath,
  type DevToolsPort,
} from "../packages/browser-control/src/chrome.js";
import {
  acceptKey,
  connectWs,
  encodeFrame,
  type WsSocket,
} from "../packages/browser-control/src/ws.js";

const temporaryDirectories: string[] = [];
const openServers: Server[] = [];
const openSockets: Socket[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "oxrail-browser-"));
  temporaryDirectories.push(directory);
  return directory;
}

function trackServer(server: Server): void {
  openServers.push(server);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("expected a TCP address");
  }
  return address.port;
}

afterEach(async () => {
  for (const socket of openSockets.splice(0)) socket.destroy();
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        }),
    ),
  );
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("chromeArgs", () => {
  it("passes the flags the route depends on", () => {
    const userDataDir = "/tmp/oxrail-browser-test/profile";
    const args = chromeArgs({ userDataDir, headless: false });

    expect(args).toContain(`--user-data-dir=${userDataDir}`);
    expect(args).toContain("--remote-debugging-port=0");
    expect(args).toContain("--remote-allow-origins=*");
    expect(args).toContain("--no-first-run");
    expect(args).toContain("--no-default-browser-check");
    expect(args).toContain("--use-mock-keychain");
    expect(args).toContain("--disable-blink-features=AutomationControlled");
    expect(args).toContain("--disable-sync");
    expect(args).toContain("--disable-popup-blocking");
    expect(args).toContain("--hide-crash-restore-bubble");
    expect(args).toContain("--disable-session-crashed-bubble");
    expect(args).toContain("--disable-background-timer-throttling");
    expect(args).toContain("--disable-renderer-backgrounding");
    expect(args).toContain("--disable-backgrounding-occluded-windows");
    expect(args).toContain(
      "--disable-features=Translate,MediaRouter,OptimizationHints",
    );
    expect(args).toContain("--window-size=1280,800");
    expect(args).not.toContain("--headless=new");
    // Sandboxing is the host's decision; turning it off would weaken it.
    expect(args).not.toContain("--no-sandbox");
  });

  it("puts the headless mode first and appends extra flags", () => {
    const args = chromeArgs({
      userDataDir: "/tmp/oxrail-browser-test/profile",
      headless: true,
      extraFlags: ["--lang=en-US"],
      windowSize: { width: 800, height: 600 },
    });

    expect(args[0]).toBe("--headless=new");
    expect(args).toContain("--window-size=800,600");
    expect(args.at(-1)).toBe("--lang=en-US");
  });
});

describe("profileDir", () => {
  const env = { OXRAIL_BROWSER_STATE_DIR: "/tmp/oxrail-browser-state" };

  it("keeps a hostile profile name inside the profiles root", () => {
    const directory = profileDir("../x", env);
    const root = path.join("/tmp/oxrail-browser-state", "profiles");

    expect(directory.startsWith(`${root}${path.sep}`)).toBe(true);
    expect(directory).not.toContain("..");
    expect(path.relative(root, directory).startsWith("..")).toBe(false);
  });

  it("keeps an ordinary name readable", () => {
    expect(profileDir("work", env)).toBe(
      path.join("/tmp/oxrail-browser-state", "profiles", "work"),
    );
  });
});

describe("chromeBinary", () => {
  it("prefers the OXRAIL_CHROME override", async () => {
    const directory = await temporaryDirectory();
    const binary = path.join(directory, "chrome");
    await writeFile(binary, "");

    expect(chromeBinary({ OXRAIL_CHROME: binary }).path).toBe(binary);
  });

  it("refuses an override that does not exist", () => {
    expect(() =>
      chromeBinary({ OXRAIL_CHROME: "/nonexistent/chrome" }),
    ).toThrow(/OXRAIL_CHROME/);
  });
});

describe("waitForDevToolsPort", () => {
  it("reports the port and the browser path once the file appears", async () => {
    const directory = await temporaryDirectory();
    await writeFile(
      path.join(directory, "DevToolsActivePort"),
      "41234\n/devtools/browser/abc-123\n",
    );

    const port = await waitForDevToolsPort(directory, {
      sleep: () => Promise.resolve(),
    });

    expect(port).toEqual({ port: 41234, path: "/devtools/browser/abc-123" });
  });

  it("throws at once when Chrome died before opening a port", async () => {
    const directory = await temporaryDirectory();
    const slept: number[] = [];
    const death: ChromeDeath = {
      code: 21,
      signal: null,
      ms: 123,
      stderr: "Fatal error in the profile\nline two",
    };
    const started = Date.now();

    const attempt = waitForDevToolsPort(directory, {
      deadlineMs: 15_000,
      isDead: () => death,
      sleep: (ms) => {
        slept.push(ms);
        return Promise.resolve();
      },
    });

    await expect(attempt).rejects.toThrow(
      "oxrail-browser: Chrome ended before it opened a debugging port (exit code 21 after 123 ms — Fatal error in the profile line two)",
    );
    expect(Date.now() - started).toBeLessThan(1000);
    expect(slept).toHaveLength(0);
  });

  it("names the signal when Chrome was killed", async () => {
    const directory = await temporaryDirectory();

    await expect(
      waitForDevToolsPort(directory, {
        isDead: () => ({ code: null, signal: "SIGKILL", ms: 5, stderr: "" }),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toThrow(
      "oxrail-browser: Chrome ended before it opened a debugging port (signal SIGKILL after 5 ms)",
    );
  });

  it("gives up after the deadline without sleeping past it", async () => {
    const directory = await temporaryDirectory();
    const slept: number[] = [];
    const started = Date.now();

    await expect(
      waitForDevToolsPort(directory, {
        deadlineMs: 500,
        sleep: (ms) => {
          slept.push(ms);
          return Promise.resolve();
        },
      }),
    ).rejects.toThrow("oxrail-browser: Chrome did not open a debugging port");

    expect(slept.reduce((total, delay) => total + delay, 0)).toBe(500);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

interface ClientFrame {
  readonly text: string;
  readonly masked: boolean;
}

/** Reads one client frame; the test server has to unmask it itself. */
function readClientFrame(
  buffer: Buffer,
): { frame: ClientFrame; rest: Buffer } | null {
  if (buffer.length < 2) return null;
  const second = buffer.readUInt8(1);
  const masked = (second & 0x80) !== 0;
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    return null;
  }
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  const key = buffer.subarray(offset, offset + maskBytes);
  offset += maskBytes;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    for (let index = 0; index < payload.length; index += 1) {
      payload.writeUInt8(
        payload.readUInt8(index) ^ key.readUInt8(index % key.length),
        index,
      );
    }
  }
  return {
    frame: { text: payload.toString("utf8"), masked },
    rest: buffer.subarray(offset + length),
  };
}

describe("connectWs", () => {
  it("refuses to dial a debugging port that is not on this machine", async () => {
    await expect(
      connectWs("ws://example.com:9222/devtools/browser"),
    ).rejects.toThrow(/only 127\.0\.0\.1 and localhost/);
  });

  it("upgrades a loopback session and exchanges text frames", async () => {
    const clientFrames: ClientFrame[] = [];
    const server = createServer((socket) => {
      openSockets.push(socket);
      let buffered: Buffer = Buffer.alloc(0);
      let upgraded = false;
      socket.on("data", (chunk: Buffer) => {
        buffered = Buffer.concat([buffered, chunk]);
        if (!upgraded) {
          const end = buffered.indexOf("\r\n\r\n");
          if (end < 0) return;
          const head = buffered.subarray(0, end).toString("latin1");
          const key = /sec-websocket-key:\s*(\S+)/i.exec(head)?.[1];
          if (key === undefined) {
            socket.destroy();
            return;
          }
          buffered = buffered.subarray(end + 4);
          upgraded = true;
          socket.write(
            [
              "HTTP/1.1 101 Switching Protocols",
              "Upgrade: websocket",
              "Connection: Upgrade",
              `Sec-WebSocket-Accept: ${acceptKey(key)}`,
              "",
              "",
            ].join("\r\n"),
          );
          // Sent in the same chunk as the handshake: the client has to hold the
          // text until a message handler is registered.
          socket.write(
            encodeFrame(1, Buffer.from("hello from chrome", "utf8"), false),
          );
        }
        for (;;) {
          const parsed = readClientFrame(buffered);
          if (parsed === null) break;
          buffered = parsed.rest;
          clientFrames.push(parsed.frame);
        }
      });
    });
    trackServer(server);
    const port = await listen(server);

    const socket = await connectWs(`ws://127.0.0.1:${port}/devtools/browser`);
    const messages: string[] = [];
    socket.onMessage((text) => {
      messages.push(text);
    });
    try {
      await vi.waitFor(() => {
        expect(messages).toEqual(["hello from chrome"]);
      });
      socket.send("hi from the client");
      await vi.waitFor(() => {
        expect(clientFrames).toHaveLength(1);
      });
      expect(clientFrames[0]?.masked).toBe(true);
      expect(clientFrames[0]?.text).toBe("hi from the client");
    } finally {
      socket.close();
    }
  });
});

class FakeSocket implements WsSocket {
  readonly sent: string[] = [];
  #message: ((text: string) => void) | null = null;
  #closed: ((reason: string) => void) | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  onMessage(handler: (text: string) => void): void {
    this.#message = handler;
  }

  onClose(handler: (reason: string) => void): void {
    this.#closed = handler;
  }

  close(): void {
    this.#closed?.("ws: closed by the client");
  }

  deliver(message: unknown): void {
    this.#message?.(JSON.stringify(message));
  }

  drop(reason: string): void {
    this.#closed?.(reason);
  }
}

interface SentRequest {
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
}

function sentRequest(socket: FakeSocket, index: number): SentRequest {
  const raw = socket.sent[index];
  if (raw === undefined) {
    throw new Error(`the connection sent no request at index ${index}`);
  }
  return JSON.parse(raw) as SentRequest;
}

describe("CdpConnection", () => {
  it("pairs replies with requests by id", async () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);

    const navigate = cdp.send<{ frameId: string }>("Page.navigate", {
      url: "https://example.test/",
    });
    const tree = cdp.send("Page.getFrameTree", {}, "session-7");

    const first = sentRequest(socket, 0);
    const second = sentRequest(socket, 1);
    expect(first.method).toBe("Page.navigate");
    expect(first.params).toEqual({ url: "https://example.test/" });
    expect(second.method).toBe("Page.getFrameTree");
    expect(second.sessionId).toBe("session-7");
    expect(second.id).toBe(first.id + 1);

    socket.deliver({ id: second.id, result: { tree: "x" } });
    socket.deliver({ id: first.id, result: { frameId: "frame-1" } });

    await expect(navigate).resolves.toEqual({ frameId: "frame-1" });
    await expect(tree).resolves.toEqual({ tree: "x" });
  });

  it("rejects an error reply with the CDP message and code", async () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);
    const pending = cdp.send("Page.navigate");

    socket.deliver({
      id: sentRequest(socket, 0).id,
      error: {
        code: -32000,
        message: "Cannot navigate",
        data: { detail: 1 },
      },
    });

    let failure: CdpError | null = null;
    try {
      await pending;
    } catch (error) {
      failure = error as CdpError;
    }
    expect(failure?.message).toBe("Cannot navigate");
    expect(failure?.code).toBe(-32000);
    expect(failure?.data).toEqual({ detail: 1 });
  });

  it("fails pending work when the socket closes and refuses more sends", async () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);
    const evaluate = cdp.send("Runtime.evaluate", { expression: "1" });
    const enable = cdp.send("Page.enable");

    socket.drop("ws: closed by the peer");

    await expect(evaluate).rejects.toThrow(
      "cdp: connection closed before Runtime.evaluate answered",
    );
    await expect(enable).rejects.toThrow(
      "cdp: connection closed before Page.enable answered",
    );
    expect(cdp.closed).toBe(true);
    await expect(cdp.send("Page.enable")).rejects.toThrow(
      "cdp: connection closed",
    );
  });

  it("hands session events to the method handler with params only", () => {
    const socket = new FakeSocket();
    const cdp = new CdpConnection(socket);
    const received: Record<string, unknown>[] = [];
    cdp.on("Runtime.consoleAPICalled", (params) => {
      received.push(params);
    });

    socket.deliver({
      method: "Runtime.consoleAPICalled",
      params: { type: "log" },
      sessionId: "session-1",
    });

    expect(received).toEqual([{ type: "log" }]);
  });

  it("keeps reading after an event handler throws", async () => {
    const socket = new FakeSocket();
    const reported: unknown[] = [];
    const cdp = new CdpConnection(socket, {
      onError: (error) => {
        reported.push(error);
      },
    });
    let handled = 0;
    cdp.on("Page.loadEventFired", () => {
      handled += 1;
      throw new Error("handler blew up");
    });

    socket.deliver({ method: "Page.loadEventFired", params: {} });
    expect(handled).toBe(1);
    expect(reported).toHaveLength(1);
    expect(cdp.closed).toBe(false);

    const version = cdp.send<{ product: string }>("Browser.getVersion");
    socket.deliver({
      id: sentRequest(socket, 0).id,
      result: { product: "Chrome/1" },
    });
    await expect(version).resolves.toEqual({ product: "Chrome/1" });
  });
});

describe("clearStaleDevToolsPort", () => {
  it("removes a port file a previous run left behind", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oxrail-port-"));
    try {
      const stale = path.join(dir, "DevToolsActivePort");
      await writeFile(stale, "61234\n/devtools/browser\n");
      clearStaleDevToolsPort(dir);
      await expect(readFile(stale, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("is a no-op when the profile never ran, so a first launch is unchanged", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "oxrail-port-"));
    try {
      expect(() => {
        clearStaleDevToolsPort(dir);
      }).not.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// A `DevToolsPort` is only ever produced by the wait above; keeping the type
// imported here documents that the shape stays what the launcher consumes.
const _portShape: DevToolsPort = { port: 1, path: "/devtools/browser" };
void _portShape;
