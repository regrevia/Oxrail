/* A write tool may refresh the refs it invalidated, and it runs inside the
 * route's one ordering queue. If that refresh took the queue again it would
 * wait for the turn it is already holding: the call never returns, and every
 * later call waits behind it — one drag turns the whole route into
 * "Request timed out" until the process is reloaded.
 *
 * Chrome is never opened here. Each private step the write needs is stood in
 * for, so the only thing under test is the ordering.
 */

import { describe, expect, it } from "vitest";

import { CdpBrowserRoute } from "../packages/browser-control/src/route.js";

/* Long enough that a healthy path never sees it, short enough that a
   regression fails the file instead of hanging the suite. */
const HANG_MS = 3_000;

function withDeadline<T>(work: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`${what} never returned: the queue is stuck`)),
        HANG_MS,
      );
    }),
  ]);
}

const PAGE = {
  url: "https://example.test/",
  title: "Fixture",
  text: "a page",
  controls: [
    { ref: 1, role: "button", name: "Press me" },
    { ref: 2, role: "link", name: "second" },
  ],
  truncated: false,
  limit: 4_000,
  blindFrames: 0,
  words: 2,
};

/* A route whose browser is already open and whose page answers every step a
   write needs, so nothing below touches Chrome or the network. */
async function stubbedRoute(): Promise<CdpBrowserRoute> {
  const route = new CdpBrowserRoute({
    env: {
      ...process.env,
      OXRAIL_BROWSER_HEADLESS: "1",
      OXRAIL_BROWSER_PROFILE: `queue-${process.pid}`,
    } as NodeJS.ProcessEnv,
  });
  const inner = route as unknown as Record<string, unknown>;
  inner.ensure = async () => ({
    cdp: { send: async () => ({}), on: () => undefined },
    page: { sessionId: "session", targetId: "target" },
  });
  inner.evaluate = async (expression: string) => {
    if (expression.includes("el.checked === true")) {
      return { found: true, checked: false, kind: "checkbox" };
    }
    if (expression.includes("no dropdown matched")) {
      return JSON.stringify({ ok: true, value: "one" });
    }
    return structuredClone(PAGE);
  };
  inner.waitIdle = async () => undefined;
  inner.locate = async (target: { ref?: number }) => ({
    x: target.ref === 2 ? 20 : 10,
    y: target.ref === 2 ? 20 : 10,
    label: `control ${String(target.ref)}`,
  });
  inner.touch = () => undefined;
  /* A real read, so the refs below are the numbers a read actually handed out
     and the write tools' provenance check passes for the stated reason. */
  await route.read({ maxChars: 100 });
  return route;
}

describe("a write that refreshes refs does not take the queue twice", () => {
  it("returns from a drag that reads afterwards", async () => {
    const route = await stubbedRoute();
    const result = await withDeadline(
      route.drag({ fromRef: 1, toRef: 2, read: true }),
      "browser_drag",
    );
    const text = result.content
      .filter((part): part is { type: "text"; text: string } => {
        return part.type === "text";
      })
      .map((part) => part.text)
      .join("");
    // It reported the page it read rather than only the move it made.
    expect(text).toContain("Fixture");
  });

  it("still answers later calls in the same route", async () => {
    const route = await stubbedRoute();
    await withDeadline(
      route.drag({ fromRef: 1, toRef: 2, read: true }),
      "browser_drag",
    );
    // The poisoned queue is the harm; a later read proves it survived.
    const after = await withDeadline(route.read({ maxChars: 100 }), "read");
    expect(after.title).toBe("Fixture");
  });

  it("returns from a hover that reads afterwards", async () => {
    const route = await stubbedRoute();
    await withDeadline(route.hover({ ref: 1 }), "browser_hover");
  });

  it("returns from a check that reads afterwards", async () => {
    const route = await stubbedRoute();
    /* Without `checked` the tool only reports and never refreshes refs, so it
       has to be given a state to move the control to. */
    await withDeadline(route.check({ ref: 1, checked: true }), "browser_check");
  });

  it("returns from a scroll that reads afterwards", async () => {
    const route = await stubbedRoute();
    await withDeadline(route.scroll({ dy: 200 }), "browser_scroll");
  });

  it("returns from an upload that reads afterwards", async () => {
    const route = await stubbedRoute();
    const inner = route as unknown as Record<string, unknown>;
    /* The file input is resolved and filled through CDP directly, so the
       stand-in connection answers those calls the way Chrome does: an object
       comes back under `result`, which is what `setFileInputFiles` is then
       handed. */
    inner.ensure = async () => ({
      cdp: {
        send: async (method: string) => {
          if (method === "Runtime.evaluate") {
            return { result: { objectId: "object-1" } };
          }
          return {};
        },
        on: () => undefined,
      },
      page: { sessionId: "session", targetId: "target" },
    });
    await withDeadline(
      route.upload({ ref: 1, files: ["/tmp/note.txt"] }),
      "browser_upload",
    );
  });

  it("returns from a select that reads afterwards", async () => {
    const route = await stubbedRoute();
    await withDeadline(
      route.select({ ref: 1, value: "one" }),
      "browser_select",
    );
  });
});
