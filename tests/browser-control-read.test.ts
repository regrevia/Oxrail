/* The reading layer, tested without a browser.
 *
 * `read.ts` is deliberately free of the route: the page expressions are
 * strings, and everything that ranks, cuts or diffs their output is plain
 * JavaScript. That is what makes the token budget testable at all — the
 * numbers below are the contract, not a screenshot of one page.
 */

import { describe, expect, it } from "vitest";

import { snapshotExpression } from "../packages/browser-control/src/route.js";

import {
  articleExpression,
  blocksExpression,
  brief,
  deltaOf,
  evidence,
  passagesToText,
  rank,
  sentences,
  terms,
  trailOf,
  type Block,
} from "../packages/browser-control/src/read.js";

const block = (t: string, extra: Partial<Block> = {}): Block => ({
  h: "",
  p: "",
  t,
  d: 0,
  q: 0.5,
  ...extra,
});

describe("terms", () => {
  it("cuts English and Chinese the same way", () => {
    expect(terms("Refunds and Returns")).toEqual(["refund", "and", "return"]);
    expect(terms("退款 政策")).toEqual(["退", "款", "政", "策"]);
  });

  it("folds plurals and participles so a query matches the page", () => {
    expect(terms("policies")).toEqual(["policy"]);
    expect(terms("shipping")).toEqual(["ship"]);
    expect(terms("cancelled")).toEqual(["cancel"]);
  });

  it("leaves short words and non-ASCII alone", () => {
    expect(terms("is as us")).toEqual(["is", "as", "us"]);
    expect(terms("")).toEqual([]);
  });
});

describe("sentences", () => {
  it("keeps a sentence whole across an abbreviation", () => {
    expect(sentences("Use e.g. this form. Then wait.")).toEqual([
      "Use e.g. this form.",
      "Then wait.",
    ]);
  });

  it("breaks Chinese on its own punctuation", () => {
    expect(sentences("退款需要三天。节假日除外！")).toEqual([
      "退款需要三天。",
      "节假日除外！",
    ]);
  });
});

describe("rank", () => {
  const blocks = [
    block("Our refund policy lets you return an item within 30 days.", {
      h: "Refunds",
    }),
    block("We ship worldwide, usually within five working days.", {
      h: "Shipping",
    }),
    block("Contact support for anything else.", { h: "Contact" }),
  ];

  it("puts the block that answers the query first", () => {
    const ranked = rank(blocks, "how long do refunds take");
    expect(ranked[0]?.block.h).toBe("Refunds");
    expect(ranked[0]?.score).toBeGreaterThan(ranked[1]?.score ?? 0);
  });

  it("counts the heading as a place a term can match", () => {
    const ranked = rank(blocks, "shipping");
    expect(ranked[0]?.block.h).toBe("Shipping");
  });

  it("returns nothing for a query with no terms", () => {
    expect(rank(blocks, "   ")).toEqual([]);
  });

  it("does not reward a link farm", () => {
    const prose = block(
      "The refund window is 30 days from delivery, and the item must be unused.",
    );
    const links = block("refund refund refund refund refund", { d: 0.95 });
    const ranked = rank([links, prose], "refund window");
    expect(ranked[0]?.block).toBe(prose);
  });
});

describe("evidence", () => {
  const long = block(
    "Refunds take three working days to reach your card. " +
      "Shipping is free over fifty pounds. " +
      "Returns need the original packaging. " +
      "Contact support if the parcel never arrived.",
    { h: "Refunds", p: "Help › Refunds" },
  );
  const other = block("Our office is open from nine to five.", {
    h: "Contact",
  });

  it("returns the sentence, not the paragraph", () => {
    const found = evidence([long, other], "how long do refunds take");
    expect(found.rows.length).toBeGreaterThan(0);
    const text = passagesToText(found);
    expect(text).toContain("three working days");
    expect(text).not.toContain("original packaging");
  });

  it("labels a passage with the heading trail it sits under", () => {
    const found = evidence([long, other], "refunds");
    expect(passagesToText(found).startsWith("## Help › Refunds")).toBe(true);
  });

  it("honours the character budget", () => {
    const found = evidence([long, other], "refund shipping returns support", {
      maxChars: 200,
    });
    expect(passagesToText(found).length).toBeLessThanOrEqual(200);
  });

  it("says how much it chose from, so a caller knows it saw part of a page", () => {
    const found = evidence([long, other], "refund");
    expect(found.total).toBe(2);
    expect(found.matched).toBeLessThanOrEqual(found.total);
  });

  it("returns nothing rather than a random sentence when nothing matches", () => {
    const found = evidence([long, other], "quantum chromodynamics");
    expect(found.rows).toEqual([]);
    expect(passagesToText(found)).toBe("");
  });
});

describe("trailOf and brief", () => {
  it("prefers the trail when it says more than the heading", () => {
    expect(trailOf({ h: "Refunds", p: "Help › Refunds" })).toBe(
      "Help › Refunds",
    );
    expect(trailOf({ h: "Refunds", p: "Refunds" })).toBe("Refunds");
    expect(trailOf({ h: "Refunds" })).toBe("Refunds");
  });

  it("cuts a long line with an ellipsis", () => {
    const cut = brief("a".repeat(400));
    expect(cut.length).toBeLessThanOrEqual(261);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("deltaOf", () => {
  const before = {
    text: "Sign in\nForgot password?",
    controls: [
      { ref: 0, role: "button", name: "Sign in" },
      { ref: 1, role: "link", name: "Forgot password?" },
    ],
  };

  it("returns only the lines that are new", () => {
    const delta = deltaOf(before, {
      text: "Sign in\nForgot password?\nWrong password",
      controls: before.controls,
    });
    expect(delta.text).toBe("Wrong password");
    expect(delta.controls).toEqual([]);
  });

  it("returns only the controls that are new", () => {
    const delta = deltaOf(before, {
      text: "Sign in\nForgot password?",
      controls: [
        ...before.controls,
        { ref: 2, role: "button", name: "Try again" },
      ],
    });
    expect(delta.text).toBe("");
    expect(delta.controls.map((control) => control.ref)).toEqual([2]);
  });

  it("is empty when nothing changed", () => {
    const delta = deltaOf(before, before);
    expect(delta).toEqual({ text: "", controls: [] });
  });
});

describe("page expressions", () => {
  it("numbers a control once and keeps that number on later reads", () => {
    const source = snapshotExpression({ mode: "text", maxChars: 6_000 });
    /* A fresh list renumbered from 1 would make every read of a page whose
       first control disappeared look like the whole page changed. */
    expect(source).toContain("__oxrailRefs");
    expect(source).toContain("byEl");
    expect(source).not.toContain("const ref = controls.length + 1");
  });

  it("hands back JSON, so one evaluate call is enough", () => {
    expect(blocksExpression(2_000)).toContain("JSON.stringify");
    expect(articleExpression(2_000)).toContain("JSON.stringify");
  });

  it("never interpolates a raw budget", () => {
    expect(blocksExpression(Number.NaN)).toContain("const limit = 200");
    expect(articleExpression(Number.NaN)).toContain("const limit = 400");
  });
});
