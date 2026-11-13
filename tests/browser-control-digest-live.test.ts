/* Live measurement of the reading layer against a real Chrome.
 *
 * The unit tests prove the ranking; this file proves the point of the ranking,
 * which is that a page which costs a lot to read as a page costs little to
 * read as an answer. It is opt-in with OXRAIL_BROWSER_LIVE=1 like the other
 * live files, and it asserts ratios rather than exact counts so a change in
 * Chrome's `innerText` cannot break it.
 */

import { describe, expect, it } from "vitest";

import {
  chromeBinary,
  profileDir,
} from "../packages/browser-control/src/chrome.js";
import { CdpBrowserRoute } from "../packages/browser-control/src/route.js";

const live = process.env.OXRAIL_BROWSER_LIVE === "1";
const hasChrome = (() => {
  try {
    chromeBinary();
    return true;
  } catch {
    return false;
  }
})();

/* A page shaped like the ones that actually poison a context: a long body of
   near-identical prose, a link farm in the middle, and one sentence that
   answers a question. Nothing here is private. */
const filler = Array.from(
  { length: 40 },
  (_, at) =>
    `<p>Section ${at + 1}: this paragraph repeats what the page is about so that the reader has to spend a budget on it.</p>`,
).join("\n");
const links = Array.from(
  { length: 60 },
  (_, at) => `<li><a href="#n${at}">Related reading number ${at + 1}</a></li>`,
).join("\n");
const page = `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html>
<html><head><title>Long page</title></head>
<body>
<main>
  <h1>Long page</h1>
  <h2>Shipping</h2>
  ${filler}
  <h2>Returns</h2>
  <p>Refunds are paid within three working days of the parcel arriving.</p>
  <ul>${links}</ul>
  <h2>Contact</h2>
  <p>Write to the team if the parcel never arrived.</p>
</main>
</body></html>`)}`;

describe.skipIf(!live || !hasChrome)("Browser Control reading layer", () => {
  it(
    "answers a question with a fraction of what reading the page costs",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-read-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      try {
        await route.open({ url: page });

        const viewStarted = Date.now();
        const view = await route.read({});
        const viewMs = Date.now() - viewStarted;

        const articleStarted = Date.now();
        const article = await route.digest({ mode: "article" });
        const articleMs = Date.now() - articleStarted;

        /* Same column with a budget big enough not to cut it, so the number
           in the docs is the page and not the clamp. */
        const full = await route.digest({ mode: "article", maxChars: 24_000 });

        const mapStarted = Date.now();
        const map = await route.digest({ mode: "map" });
        const mapMs = Date.now() - mapStarted;

        const queryStarted = Date.now();
        const answer = await route.digest({
          mode: "query",
          query: "how long do refunds take",
        });
        const queryMs = Date.now() - queryStarted;

        /* A ref has to survive a re-read, or a delta between two reads is just
           the page renumbering itself. */
        const before = view.controls.map((control) => control.ref);
        const again = await route.read({});
        const after = again.controls.map((control) => control.ref);
        const refs = {
          before,
          after,
          stable: JSON.stringify(before) === JSON.stringify(after),
        };

        /* The first changed read has nothing to compare against, so it returns
           the page and says so instead of pretending everything is new. */
        const firstChanged = await route.digest({ mode: "changed" });
        const secondChanged = await route.digest({ mode: "changed" });

        const viewChars = view.text.length;
        const report = {
          view: { chars: viewChars, ms: viewMs },
          article: { chars: article.text.length, ms: articleMs },
          articleFull: { chars: full.text.length, truncated: full.truncated },
          map: { chars: map.text.length, ms: mapMs },
          query: { chars: answer.text.length, ms: queryMs },
          refs,
          changed: {
            first: firstChanged.text.length,
            second: secondChanged.text.length,
          },
        };
        console.log(JSON.stringify(report, null, 2));

        /* The answer is the sentence and its heading, not forty paragraphs. */
        expect(answer.text).toContain("three working days");
        expect(answer.text.length).toBeLessThan(viewChars * 0.1);
        expect(answer.matched ?? 0).toBeGreaterThan(0);
        expect(answer.total ?? 0).toBeGreaterThan(answer.matched ?? 0);

        /* Reading the column costs far less than reading the page: the link
           farm and the surrounding chrome are not prose. */
        expect(article.text.length).toBeLessThan(viewChars * 0.8);

        /* The map is headings plus nothing, so it is smaller still. */
        expect(map.text).toContain("Returns");
        expect(map.text.length).toBeLessThan(viewChars * 0.4);

        /* Nothing changed between two reads of a static page. */
        expect(secondChanged.text).toBe("(no change since the last read)");

        /* The point of the whole layer: a page that is cheap to read stays
           cheap to read, so the budget is spent on the answer. */
        expect(queryMs).toBeLessThan(2_000);
      } finally {
        await route.close();
        const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
        if (dir !== "")
          await import("node:fs").then((fs) =>
            fs.rmSync(dir, { recursive: true, force: true }),
          );
      }
    },
  );
});
