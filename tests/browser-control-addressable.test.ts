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

describe("typing with no number still needs a read", () => {
  it("refuses to type into the page before anything has been read", async () => {
    const route = coldRoute();
    await expect(route.type({ text: "hello" })).rejects.toThrow(
      /nothing has been read/u,
    );
  });
});
