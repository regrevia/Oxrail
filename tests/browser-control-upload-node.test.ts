/* `DOM.setFileInputFiles` takes a front-end node id, a backend node id, or a
 * remote object id, and Chrome numbers all three separately. Two ways of
 * naming the input got that wrong:
 *
 *   - the ref path read the remote object off `object` instead of `result`,
 *     so Chrome was handed `undefined` and the call failed with an error about
 *     a property of undefined;
 *   - the no-ref path passed the `nodeId` from `DOM.querySelector` as
 *     `backendNodeId`, so Chrome was told to fill a different element.
 *
 * Neither showed up on a small page, where the node id and the backend id are
 * both small and usually equal. So the assertions here are about the exact
 * argument Chrome is given, not about whether a call was made at all.
 *
 * Chrome is never opened. The connection is a recorder, and every check is on
 * what the route asked it to do.
 */

import { describe, expect, it } from "vitest";

import { CdpBrowserRoute } from "../packages/browser-control/src/route.js";
import { StaleRefError } from "../packages/browser-control/src/types.js";

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

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

interface Answering {
  /* What `Runtime.evaluate` returns for the ref lookup. `undefined` stands for
     an element that is no longer on the page. */
  readonly objectId?: string | undefined;
  /* What the page threw while resolving the ref, the way Chrome reports it:
     the description carries the marker the route looks for. */
  readonly thrown?: string | undefined;
  /* What `DOM.querySelector` returns for the whole-page lookup. Zero is how
     Chrome says the page has no file input. */
  readonly nodeId?: number;
}

/* A route whose browser is open and whose page answers the way Chrome does,
   recording each CDP call. A real read runs first so `ref 1` is a number a
   read actually handed out and the provenance check passes for the stated
   reason rather than by accident. */
function routeAnswering(options: Answering): {
  route: CdpBrowserRoute;
  sent: Sent[];
  install: () => void;
} {
  const route = new CdpBrowserRoute({
    env: {
      ...process.env,
      OXRAIL_BROWSER_HEADLESS: "1",
      OXRAIL_BROWSER_PROFILE: `upload-${process.pid}`,
    } as NodeJS.ProcessEnv,
  });
  const inner = route as unknown as Record<string, unknown>;
  const sent: Sent[] = [];
  const install = (): void => {
    inner.ensure = async () => ({
      cdp: {
        send: async (method: string, params: Record<string, unknown> = {}) => {
          sent.push({ method, params });
          if (method === "Runtime.evaluate") {
            if (options.thrown !== undefined)
              return {
                result: {},
                exceptionDetails: {
                  exception: { description: options.thrown },
                },
              };
            return options.objectId === undefined
              ? { result: {} }
              : { result: { objectId: options.objectId } };
          }
          if (method === "DOM.getDocument") return { root: { nodeId: 1 } };
          if (method === "DOM.querySelector")
            return { nodeId: options.nodeId ?? 0 };
          return {};
        },
        on: () => undefined,
      },
      page: { sessionId: "session", targetId: "target" },
    });
  };
  install();
  inner.evaluate = async () => structuredClone(PAGE);
  inner.waitIdle = async () => undefined;
  inner.touch = () => undefined;
  return { route, sent, install };
}

async function ready(options: Answering): Promise<{
  route: CdpBrowserRoute;
  sent: Sent[];
}> {
  const { route, sent, install } = routeAnswering(options);
  await route.read({ maxChars: 100 });
  /* Re-installing after the read keeps the recording to the upload itself. */
  install();
  sent.length = 0;
  return { route, sent };
}

function fill(sent: Sent[]): Record<string, unknown> | undefined {
  return sent.find((call) => call.method === "DOM.setFileInputFiles")?.params;
}

describe("a file input is named to Chrome in the form Chrome asked for", () => {
  it("hands a ref over as the remote object the evaluation returned", async () => {
    const { route, sent } = await ready({ objectId: "object-1", nodeId: 42 });
    await route.upload({ ref: 1, files: ["/tmp/note.txt"], read: false });
    /* The bug this replaces: the object was looked for one level too high, so
       Chrome received no way to name the element at all. */
    expect(fill(sent)).toEqual({
      files: ["/tmp/note.txt"],
      objectId: "object-1",
    });
    expect(fill(sent)).not.toHaveProperty("backendNodeId");
    expect(fill(sent)).not.toHaveProperty("nodeId");
  });

  it("hands a whole-page match over as the node id it came back as", async () => {
    const { route, sent } = await ready({ objectId: "object-1", nodeId: 42 });
    await route.upload({ files: ["/tmp/note.txt"], read: false });
    /* A front-end node id is not a backend node id: passing it as one asks
       Chrome to fill whatever element carries that backend number. */
    expect(fill(sent)).toEqual({ files: ["/tmp/note.txt"], nodeId: 42 });
    expect(fill(sent)).not.toHaveProperty("backendNodeId");
  });

  it("reports a ref that is no longer on the page as a stale ref", async () => {
    /* An element that disappeared between the read and the upload evaluates to
       an object with no id, which is a stale ref and not a crash. */
    const { route } = await ready({ objectId: undefined, nodeId: 42 });
    await expect(
      route.upload({ ref: 1, files: ["/tmp/note.txt"], read: false }),
    ).rejects.toBeInstanceOf(StaleRefError);
  });

  it("names the control when a ref is not a file input", async () => {
    /* Chrome's own wording for this is "Node is not a file input element",
       which does not say which number was wrong nor what to pass instead. */
    const { route } = await ready({
      objectId: "object-1",
      thrown: "Error: not-a-file-input",
    });
    await expect(
      route.upload({ ref: 1, files: ["/tmp/note.txt"], read: false }),
    ).rejects.toThrow(/control 1 is not one/u);
  });

  it("says so when the page has no file input at all", async () => {
    const { route } = await ready({ objectId: "object-1", nodeId: 0 });
    await expect(
      route.upload({ files: ["/tmp/note.txt"], read: false }),
    ).rejects.toThrow(/no file input/u);
  });
});
