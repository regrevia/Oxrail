/* The transport has no clock of its own. A renderer that stops answering a
 * request leaves that request pending forever, and because every tool runs in
 * the route's one ordering queue, one unanswered request is the whole route.
 * These cases stand a socket in for Chrome and never send a reply.
 */

import { describe, expect, it } from "vitest";
import {
  CdpConnection,
  DEFAULT_REQUEST_TIMEOUT_MS,
} from "../packages/browser-control/src/cdp.js";
import { requestTimeoutMs } from "../packages/browser-control/src/route.js";
import type { WsSocket } from "../packages/browser-control/src/ws.js";

function silentSocket(): { socket: WsSocket; sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    socket: {
      send: (text: string) => {
        sent.push(text);
      },
      onMessage: () => undefined,
      onClose: () => undefined,
      close: () => undefined,
    },
  };
}

describe("a request nobody answers", () => {
  it("fails with the method it was waiting on", async () => {
    const { socket, sent } = silentSocket();
    const cdp = new CdpConnection(socket, { requestTimeoutMs: 60 });
    await expect(cdp.send("Runtime.evaluate")).rejects.toThrow(
      /cdp: Runtime\.evaluate did not answer within 60ms/u,
    );
    expect(sent).toHaveLength(1);
  });

  it("frees the connection for the next request", async () => {
    const { socket } = silentSocket();
    const cdp = new CdpConnection(socket, { requestTimeoutMs: 60 });
    await expect(cdp.send("Page.captureScreenshot")).rejects.toThrow(
      /did not answer/u,
    );
    await expect(cdp.send("Target.getTargets")).rejects.toThrow(
      /did not answer/u,
    );
  });

  it("leaves a connection with the clock off waiting", async () => {
    const { socket } = silentSocket();
    const cdp = new CdpConnection(socket, { requestTimeoutMs: 0 });
    let settled = false;
    void cdp.send("Browser.getVersion").then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(settled).toBe(false);
  });
});

describe("choosing the ceiling from the environment", () => {
  it("uses the shipped default when nothing says otherwise", () => {
    expect(requestTimeoutMs({} as NodeJS.ProcessEnv)).toBe(
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    expect(
      requestTimeoutMs({
        OXRAIL_BROWSER_REQUEST_TIMEOUT_MS: "soon",
      } as NodeJS.ProcessEnv),
    ).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it("takes a millisecond count, and 0 turns the clock off", () => {
    expect(
      requestTimeoutMs({
        OXRAIL_BROWSER_REQUEST_TIMEOUT_MS: "45000",
      } as NodeJS.ProcessEnv),
    ).toBe(45_000);
    expect(
      requestTimeoutMs({
        OXRAIL_BROWSER_REQUEST_TIMEOUT_MS: "0",
      } as NodeJS.ProcessEnv),
    ).toBe(0);
    expect(
      requestTimeoutMs({
        OXRAIL_BROWSER_REQUEST_TIMEOUT_MS: "-5",
      } as NodeJS.ProcessEnv),
    ).toBe(0);
  });
});
