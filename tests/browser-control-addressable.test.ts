/* A write may only address a control by a number a read produced. That is the
 * rule that makes this route different from a Computer Use loop: there is no
 * coordinate to invent, so the only way to act on the page is to read it first.
 *
 * Checked before Chrome is opened, so the refusals below cost nothing.
 */

import { describe, expect, it } from "vitest";

import { CdpBrowserRoute } from "../packages/browser-control/src/route.js";

function coldRoute(): CdpBrowserRoute {
  return new CdpBrowserRoute({
    env: {
      ...process.env,
      OXRAIL_BROWSER_HEADLESS: "1",
      OXRAIL_BROWSER_PROFILE: `addressable-${process.pid}`,
    } as NodeJS.ProcessEnv,
  });
}

describe("a write must be addressed by a read", () => {
  it("refuses a number before anything has been read", async () => {
    const route = coldRoute();
    await expect(route.click({ ref: 1 })).rejects.toThrow(/browser_view/u);
    await expect(route.click({ ref: 1 })).rejects.toThrow(
      /nothing has been read/u,
    );
  });

  it("refuses a click by text before anything has been read", async () => {
    const route = coldRoute();
    await expect(route.click({ text: "Sign in" })).rejects.toThrow(
      /browser_view/u,
    );
  });

  it("refuses a number to type into before anything has been read", async () => {
    const route = coldRoute();
    await expect(route.type({ ref: 2, text: "hello" })).rejects.toThrow(
      /browser_view/u,
    );
  });

  it("opens no browser to answer a refusal", async () => {
    const route = coldRoute();
    await route.click({ ref: 1 }).catch(() => undefined);
    // A refusal that had launched Chrome would report a page here.
    expect((await route.state().catch(() => null))?.url ?? "").toBe("");
  });
});

/* A name is an address only if a read said it. Without this, a click by text
 * reaches whatever the page happens to match now — which is the one thing a
 * read-addressed route must not do, since the caller never saw that control. */

describe("a click by text must be a name a read handed out", () => {
  it("refuses a text whose read did not name it", async () => {
    const route = coldRoute();
    // Pretend a read happened, then hold the route to what that read said.
    const handed = (route as unknown as { handed: unknown }).handed;
    expect(handed).toBe(null);
    await expect(route.click({ text: "Sign in" })).rejects.toThrow(
      /nothing has been read/u,
    );
  });

  it("names the page whose read did not contain the text", async () => {
    const route = coldRoute();
    (route as unknown as { handed: unknown }).handed = {
      url: "https://example.test/a",
      refs: new Set([1, 2]),
      names: ["second", "free action"],
    };
    await expect(route.click({ text: "Delete account" })).rejects.toThrow(
      /the last read of https:\/\/example\.test\/a did not name it/u,
    );
    await expect(route.click({ text: "Delete account" })).rejects.toThrow(
      /use a number it returns/u,
    );
  });

  it("refuses an empty selector even after a read", async () => {
    /* Every name contains the empty string, so an empty selector would pass a
       containment check against any read and then land on whatever control
       happens to come first. */
    const route = coldRoute();
    (route as unknown as { handed: unknown }).handed = {
      url: "https://example.test/a",
      refs: new Set([1, 2]),
      names: ["second", "free action"],
    };
    await expect(route.click({ text: "   " })).rejects.toThrow(/has neither/u);
  });

  it("lets a name the read did say through to the page", async () => {
    const route = coldRoute();
    (route as unknown as { handed: unknown }).handed = {
      url: "https://example.test/a",
      refs: new Set([1, 2]),
      names: ["second", "free action"],
    };
    // It passes the gate and fails later, in the browser: the refusal must not
    // be the address error, because this name was addressable.
    const failure = await route.click({ text: "Free Action" }).catch((e) => e);
    expect(String(failure)).not.toMatch(/cannot be addressed/u);
  });
});

/* A read that answers one question still has to leave the rest of the page
 * addressable. `hand` takes the whole list before anything is filtered, so a
 * ref left out of the printed reading is still a valid landing place — that is
 * the difference between a shorter read and a page whose controls are gone. */

describe("a query narrows the reading, not the page", () => {
  const page = {
    url: "https://example.test/shop",
    title: "Shop",
    text: "Shop",
    controls: [
      { ref: 0, role: "button", name: "Add to cart" },
      { ref: 1, role: "link", name: "Help" },
      ...Array.from({ length: 40 }, (_, at) => ({
        ref: at + 2,
        role: "button",
        name: `Unit ${at}`,
      })),
    ],
    truncated: false,
    words: 400,
    limit: undefined,
    blindFrames: 0,
  };

  function routeWith(blocks: unknown[]): CdpBrowserRoute {
    const route = coldRoute();
    const inner = route as unknown as {
      ensure: () => Promise<unknown>;
      evaluate: () => Promise<unknown>;
      blocksFor: () => Promise<unknown[]>;
    };
    /* Nothing here opens Chrome: the two expressions the query branch asks the
       page for are the only things it needs, and their answers are what these
       three stand in for. */
    inner.ensure = async () => ({ cdp: null, page: null });
    inner.evaluate = async () => page;
    inner.blocksFor = async () => blocks;
    return route;
  }

  it("prints only the controls its question touched", async () => {
    const route = routeWith([
      { h: "Cart", p: "Cart", t: "Add to cart holds the refund policy" },
    ]);
    const read = await route.digest({ mode: "query", query: "cart" });
    expect(read.controls.map((one) => one.name)).toEqual(["Add to cart"]);
  });

  it("counts what it left out instead of reporting a short page", async () => {
    const route = routeWith([
      { h: "Cart", p: "Cart", t: "Add to cart holds the refund policy" },
    ]);
    const read = await route.digest({ mode: "query", query: "cart" });
    expect(read.omitted).toBe(41);
    /* The count is only honest if the numbers survive, so the same route must
       still accept a ref no line mentioned. */
    const handed = (route as unknown as { handed: { refs: Set<number> } })
      .handed;
    expect(handed.refs.has(3)).toBe(true);
  });

  it("a question the page never answers keeps every control", async () => {
    const route = routeWith([{ h: "Shop", p: "Shop", t: "nothing here" }]);
    const read = await route.digest({ mode: "query", query: "refund" });
    expect(read.controls).toHaveLength(42);
    expect(read.omitted).toBeUndefined();
  });
});

describe("typing with no number still needs a read", () => {
  it("refuses to type into the page before anything has been read", async () => {
    const route = coldRoute();
    await expect(route.type({ text: "hello" })).rejects.toThrow(
      /nothing has been read/u,
    );
  });
});
