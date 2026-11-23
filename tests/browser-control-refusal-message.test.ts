/* A refusal is only useful if it reaches the caller.
 *
 * Every refusal of a stale address is written where it happens, and each one
 * names the number or the name that failed and what to do about it. Those
 * sentences are the product surface: the docs quote them. Passing them through
 * one generic line turns "this number is inside a frame, fill it from a read of
 * the top document" into "the page changed", which is a different problem and
 * sends the caller to redo work that was never wrong.
 *
 * So this file holds the boundary rather than any single message: whatever a
 * tool throws comes out of `dispatch` with its own words, and only an error
 * that arrived without words falls back to the blanket sentence.
 */
import { describe, expect, it } from "vitest";

import { dispatch } from "../packages/browser-control/src/tools.js";
import { StaleRefError } from "../packages/browser-control/src/types.js";
import type { BrowserRoute } from "../packages/browser-control/src/types.js";

const BLANKET =
  "the page changed since the last read. Call browser_view and use the new refs.";

/** A route whose single tool throws what the test wants to see come back. */
function routeThrowing(error: unknown): BrowserRoute {
  return {
    upload: async () => {
      throw error;
    },
  } as unknown as BrowserRoute;
}

const said = (result: {
  content: readonly { type: string; text?: string }[];
}) => result.content.map((part) => part.text ?? "").join("");

describe("a refusal reaches the caller in its own words", () => {
  it("passes the sentence the throw site wrote straight through", async () => {
    const message =
      "control 900018 is inside a frame, so its input cannot be filled by number — pass a ref from a read that saw the top document";
    const result = await dispatch(
      routeThrowing(new StaleRefError(message)),
      "browser_upload",
      {
        ref: 900_018,
        files: ["/tmp/x.txt"],
      },
    );
    expect(said(result)).toBe(message);
    // The blanket line is a different claim about a different problem.
    expect(said(result)).not.toBe(BLANKET);
  });

  it("keeps the number and the page in the refusal, not a restatement", async () => {
    const result = await dispatch(
      routeThrowing(
        new StaleRefError(
          "control 12 cannot be addressed: the last read of https://example.com/ did not contain it — call browser_view again and use a number it returns",
        ),
      ),
      "browser_upload",
      { ref: 12, files: ["/tmp/x.txt"] },
    );
    expect(said(result)).toContain("control 12");
    expect(said(result)).toContain("https://example.com/");
  });

  it("still says something when a refusal arrives without words", async () => {
    const result = await dispatch(
      routeThrowing(new StaleRefError("")),
      "browser_upload",
      {
        ref: 3,
        files: ["/tmp/x.txt"],
      },
    );
    expect(said(result)).toBe(BLANKET);
  });
});
