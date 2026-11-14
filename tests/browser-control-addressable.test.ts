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
