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
  controlLines,
  deltaOf,
  formatSnapshot,
  evidence,
  passagesToText,
  rank,
  relevant,
  sentences,
  terms,
  trailOf,
  type Block,
} from "../packages/browser-control/src/read.js";

import type { Control } from "../packages/browser-control/src/types.js";

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

  /* The passage limit drops blocks that did answer the question. If "matched"
     only counted what came back it would always equal rows.length, and a caller
     could not tell a page that mentions refunds twice from one that mentions
     them everywhere. */
  it("counts every block that answered, not just the ones it returned", () => {
    const many = [
      long,
      block("Refunds are reviewed by a person within one working day.", {
        h: "Refunds",
      }),
      block("Refund requests older than a year need a manager.", {
        h: "Refunds",
      }),
      other,
    ];
    const capped = evidence(many, "refund", { limit: 1 });
    expect(capped.rows.length).toBe(1);
    expect(capped.matched).toBeGreaterThan(capped.rows.length);
    const wide = evidence(many, "refund", { limit: 24 });
    expect(wide.matched).toBe(wide.rows.length);
  });

  it("returns nothing rather than a random sentence when nothing matches", () => {
    const found = evidence([long, other], "quantum chromodynamics");
    expect(found.rows).toEqual([]);
    expect(passagesToText(found)).toBe("");
  });

  /* The ceiling is a promise the caller can rely on before it calls: whatever
     the page says, a passage set cannot cost more than the budget asked for.
     Three inputs used to break it — one sentence as long as the block cap
     allows, a heading repeated at the top of every section, and the first
     sentence being the only one that matches — so each is checked here rather
     than only on a page that has to be fetched. */
  /* A heading is not a sentence, so a page that only names its subject used to
     read as silent about it. The measured case is the `wide-page` fixture: its
     h1 says "Watering schedule", no paragraph repeats the word, and `query`
     answered "(nothing on this page answers …)" over 173 blocks. Only the
     labels are read this way, and only once no sentence answered. */
  it("answers from the label when no sentence repeats the word", () => {
    const page = [
      block("Beds", { h: "Watering schedule", p: "Watering schedule › Beds" }),
      block("Our office is open from nine to five.", { h: "Contact" }),
    ];
    const found = evidence(page, "when should i water");
    expect(found.matched).toBe(1);
    expect(passagesToText(found)).toContain("Watering schedule");
  });

  it("never lets a label displace a sentence that answered", () => {
    const page = [
      block("Refunds take three working days.", { h: "Refunds" }),
      block("Refunds", { h: "Refunds", p: "Help › Refunds" }),
    ];
    const found = evidence(page, "how long do refunds take");
    expect(passagesToText(found)).toContain("three working days");
  });

  it("keeps passages inside the ceiling whatever the page says", () => {
    const ceiling = 2_000;
    const cases: Block[][] = [
      // 4000 characters is the largest block the page expression will push.
      [block(`refund ${"x".repeat(3_993)}`, { h: "Refunds" })],
      // A trail is printed once per group, and the page picks its length.
      [
        block("A refund takes five days.", {
          h: `Refunds ${"y".repeat(5_000)}`,
        }),
      ],
      [
        block("Refunds take a week.", {
          h: "Refunds",
          p: `Help › ${"z".repeat(9_000)}`,
        }),
      ],
      // The first match is the only match: it still may not exceed the whole.
      [block(`refund ${"w".repeat(59_000)}`, { h: "Refunds" })],
      // Many sentences, each short, in a page that mentions the word everywhere.
      ...Array.from({ length: 40 }, (_, at) => [
        block(`Refund ${at} is reviewed within ${at + 1} days.`, {
          h: "Refunds",
        }),
      ]),
    ];
    for (const blocks of cases) {
      const rendered = passagesToText(
        evidence(blocks, "refund", { maxChars: ceiling }),
      );
      expect(rendered.length, rendered.slice(0, 80)).toBeLessThanOrEqual(
        ceiling,
      );
    }
  });

  /* A ninety-word trail fits a large budget, so the ceiling alone would let it
     through. A field has a ceiling of its own, the way a title does. */
  it("caps the trail even when the budget would allow it", () => {
    const found = evidence(
      [
        block("A refund takes five days.", {
          h: `Refunds ${"y".repeat(5_000)}`,
        }),
      ],
      "refund",
      { maxChars: 24_000 },
    );
    const text = passagesToText(found);
    expect(text.length).toBeLessThanOrEqual(
      200 + 8 + "A refund takes five days.".length,
    );
    expect(text).toContain("A refund takes five days.");
  });

  /* A cut passage is worth more than no passage, but only when it is still a
     passage: four words and an ellipsis is not an answer. */
  it("cuts the first answer to fit rather than returning it whole or not at all", () => {
    const one = evidence(
      [block(`refund ${"x".repeat(3_800)}`, { h: "Refunds" })],
      "refund",
      {
        maxChars: 2_000,
      },
    );
    expect(one.rows.length).toBe(1);
    const text = passagesToText(one);
    expect(text.length).toBeLessThanOrEqual(2_000);
    expect(text.endsWith("…")).toBe(true);
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

  it("walks open shadow roots and same-origin frames instead of one flat query", () => {
    const source = snapshotExpression({ mode: "text", maxChars: 6_000 });
    /* A page whose button lives in a shadow root or a framed checkout is the
       normal case now, and a flat document.querySelectorAll reports it as
       having nothing to click. */
    expect(source).toContain("shadowRoot");
    expect(source).toContain("contentDocument");
    /* Cross-origin frames cannot be read from the page; they must be counted
       rather than silently dropped, or the blank looks like an empty page. */
    expect(source).toContain("unseen.push");
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

/** One control, with a role and a name, and nothing else it does not need. */
const control = (ref: number, role: string, name: string): Control => ({
  ref,
  role,
  name,
});

describe("a run of controls is one line, or it is not a run", () => {
  it("folds a long run of numbered buttons into one line", () => {
    const rows = Array.from({ length: 20 }, (_, at) =>
      control(at, "button", `Item ${at}`),
    );
    const lines = controlLines(rows);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("20 controls, one line");
  });

  it("prints a short run flat, because each one is its own decision", () => {
    const rows = Array.from({ length: 3 }, (_, at) =>
      control(at, "button", `Item ${at}`),
    );
    expect(controlLines(rows)).toEqual([
      '[0] button "Item 0"',
      '[1] button "Item 1"',
      '[2] button "Item 2"',
    ]);
  });

  it("a run whose word changes at the number is two runs, not one", () => {
    /* The count has to carry on across the change, or the numbering rule stops
       the run first and this says nothing about the word. */
    const rows = [
      ...Array.from({ length: 9 }, (_, at) =>
        control(at, "button", `Item ${at}`),
      ),
      ...Array.from({ length: 9 }, (_, at) =>
        control(at + 9, "button", `Unit ${at + 9}`),
      ),
    ];
    const lines = controlLines(rows);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('"Item 0"');
    expect(lines[0]).toContain('"Item 8"');
    expect(lines[1]).toContain('"Unit 9"');
    expect(lines[1]).toContain('"Unit 17"');
  });

  it("a run of numbers is one role, not two", () => {
    const rows = Array.from({ length: 10 }, (_, at) =>
      control(at, at % 2 === 0 ? "button" : "link", `Item ${at}`),
    );
    expect(controlLines(rows)).toHaveLength(10);
  });

  it("rows that count up but are not neighbours are not one line", () => {
    const rows = Array.from({ length: 10 }, (_, at) =>
      control(at * 2, "button", `Item ${at}`),
    );
    expect(controlLines(rows)).toHaveLength(10);
  });

  it("a control with no name is left out of the numbering it cannot use", () => {
    expect(
      controlLines([control(0, "button", "Go"), control(1, "button", "  ")]),
    ).toEqual(['[0] button "Go"']);
  });

  /* The walk numbers a control it cannot name — an upload field a page forgot
     to label is still a field a write accepts — so the number exists and the
     line does not. Printing `textbox ""` would be a name the page never wrote,
     and printing nothing at all leaves a caller holding a number it cannot
     account for. The reading says how many it did that to instead. */
  it("says how many numbered controls it could not print a name for", () => {
    const page = {
      url: "https://example.test/",
      title: "Untitled",
      text: "Pick a file",
      truncated: false,
      controls: [
        control(1, "button", "Send"),
        control(2, "textbox", ""),
        control(3, "textbox", "   "),
      ],
    };
    const printed = formatSnapshot(page);
    expect(printed).toContain('[1] button "Send"');
    expect(printed).not.toContain('textbox ""');
    expect(printed).toContain("controls without a name: 2");
    /* Both numbers are still refs a write accepts, so the line has to say so
       rather than read as "these were dropped". */
    expect(printed).toContain("a write still accepts them");
  });

  it("says nothing when every control it numbered has a name", () => {
    const printed = formatSnapshot({
      url: "https://example.test/",
      title: "Untitled",
      text: "",
      truncated: false,
      controls: [control(1, "button", "Send")],
    });
    expect(printed).not.toContain("controls without a name");
  });
});

describe("a query lists what it matched, and says what it left out", () => {
  const shop = [
    control(0, "button", "Add to cart"),
    control(1, "link", "Help"),
    ...Array.from({ length: 60 }, (_, at) =>
      control(at + 2, "button", `Unit ${at}`),
    ),
  ];

  it("keeps the match and drops the numbering the query never asked about", () => {
    const picked = relevant(shop, "cart");
    expect(picked.controls.map((one) => one.name)).toContain("Add to cart");
    expect(picked.controls.some((one) => one.name.startsWith("Unit"))).toBe(
      false,
    );
    expect(picked.omitted).toBeGreaterThan(0);
  });

  it("a query the page never answers hands back every control", () => {
    /* A wrong guess about relevance that empties the list is worse than a long
       read: nothing is addressable if nothing is printed. */
    const picked = relevant(shop, "refund");
    expect(picked.controls).toHaveLength(shop.length);
    expect(picked.omitted).toBe(0);
  });

  it("no query is no filter", () => {
    const picked = relevant(shop, "  ");
    expect(picked.controls).toHaveLength(shop.length);
    expect(picked.omitted).toBe(0);
  });

  it("a query that matches more than fits still prints within its budget", () => {
    const rows = Array.from({ length: 200 }, (_, at) =>
      control(at, "button", `Buy widget number ${at} at this price`),
    );
    const picked = relevant(rows, "buy widget", { maxChars: 600 });
    const spent = picked.controls.reduce(
      (sum, one) => sum + one.role.length + one.name.length + 8,
      0,
    );
    expect(spent).toBeLessThanOrEqual(600);
    expect(picked.controls.length).toBeGreaterThan(0);
  });

  it("a match is never lost to space alone, and the count says so", () => {
    const rows = [
      control(0, "button", "Refund it"),
      control(1, "button", `Refund ${"x".repeat(400)}`),
    ];
    const picked = relevant(rows, "refund", { maxChars: 200 });
    expect(picked.controls.length).toBeGreaterThanOrEqual(1);
    expect(picked.omitted).toBe(rows.length - picked.controls.length);
  });
});
