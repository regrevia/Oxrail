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

/* Frames nest, so embedding markup in a `srcdoc` attribute has to escape one
   level at a time: escaping only the quotes turns the inner attribute's own
   `&quot;` back into a raw quote one level down and the frame parses as
   garbage. `&` first, then `"`. */
const esc = (html: string) =>
  html.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
const fixturePage = (body: string) =>
  `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><html><head><title>Composed</title></head><body>${body}</body></html>`)}`;

/* The way real pages are built now: one control in a shadow root, one in a
   frame, one in the document. A flat query on the document sees only the last
   of them, and then a click tool is right and useless. */
const composed = fixturePage(`<button id="plain">Plain button</button>
<div id="host"></div>
<iframe id="frame" srcdoc="${esc(`<!doctype html><html><body>
<p>Widget price: 42 euros.</p>
<button id="buy" onclick="document.getElementById('said').textContent='Bought'">Buy now</button>
<p id="said">Not bought</p></body></html>`)}"></iframe>
<script>
  const root = document.getElementById("host").attachShadow({ mode: "open" });
  root.innerHTML = '<p>Account</p><button id="deep">Delete account</button>';
</script>`);

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

  it(
    "numbers a control inside a shadow root and inside a frame, and clicks both",
    { timeout: 90_000 },
    async () => {
      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-frames-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      try {
        await route.open({ url: composed });
        const view = await route.read({});

        const deep = view.controls.find(
          (control) => control.name === "Delete account",
        );
        const framed = view.controls.find(
          (control) => control.name === "Buy now",
        );
        /* A shadow root is part of the page, so its control is numbered like
           any other and lives in the main frame. */
        expect(deep).toBeDefined();
        expect(deep?.frame).toBe(0);
        /* A frame's controls carry the frame, so the number says which
           document to look in. */
        expect(framed).toBeDefined();
        expect(framed?.frame).toBe(1);
        expect(framed?.ref ?? 0).toBeGreaterThanOrEqual(900_000);

        const report = {
          controls: view.controls.map((control) => ({
            ref: control.ref,
            name: control.name,
            frame: control.frame,
          })),
          blindFrames: view.blindFrames ?? 0,
          text: view.text,
        };
        console.log(JSON.stringify(report, null, 2));

        /* The frame's words are numbered as part of the page, or a price or an
           error inside a widget would be invisible to the reader. */
        expect(view.text).toContain("Widget");

        /* The press has to land on the control inside the frame, not on the
           frame's corner: the button's own handler is the proof. */
        expect(framed).toBeDefined();
        if (framed !== undefined) await route.click({ ref: framed.ref });
        const after = await route.read({});
        expect(after.text).toContain("Bought");

        /* A control in a shadow root is not behind anything, so it clicks too. */
        if (deep !== undefined) {
          const clicked = await route.click({ ref: deep.ref });
          expect(JSON.stringify(clicked)).toContain("Delete account");
        }
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

  it(
    "reaches a control two frames deep, and counts a frame it cannot read",
    { timeout: 90_000 },
    async () => {
      /* A cross-origin frame only stops being readable once its own document
         has committed; before that an iframe holds an initial about:blank, which
         is the parent's origin and reads as empty rather than as hidden. So the
         fixture needs two real origins, and a local pair of ports is one without
         reaching the network. */
      const { createServer } = await import("node:http");
      const serve = (body: string) =>
        new Promise<{ port: number; close: () => void }>((resolve) => {
          const server = createServer((_request, response) => {
            response.writeHead(200, {
              "content-type": "text/html; charset=utf-8",
            });
            response.end(body);
          });
          server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            const port =
              typeof address === "object" && address !== null
                ? address.port
                : 0;
            resolve({ port, close: () => server.close() });
          });
        });

      const foreign = await serve("<p>Another origin</p>");
      const nested = await serve(`<!doctype html><html><body>
<iframe id="outer" srcdoc="${esc(`<!doctype html><html><body>
<p>Outer frame</p>
<iframe id="inner" srcdoc="${esc(`<!doctype html><html><body>
<button id="save" onclick="document.getElementById('said').textContent='Saved'">Save</button>
<p id="said">Not saved</p></body></html>`)}"></iframe>
</body></html>`)}"></iframe>
<iframe id="foreign" src="http://127.0.0.1:${foreign.port}/widget"></iframe>
</body></html>`);

      const env = {
        ...process.env,
        OXRAIL_BROWSER_HEADLESS: "1",
        OXRAIL_BROWSER_PROFILE: `live-nested-${process.pid}-${Date.now()}`,
        OXRAIL_BROWSER_IDLE_MS: "60000",
      } as NodeJS.ProcessEnv;
      const route = new CdpBrowserRoute({ env });
      try {
        await route.open({ url: `http://127.0.0.1:${nested.port}/page` });
        /* Frames nest asynchronously: the inner document does not exist at the
           moment the outer one does, so a first read is allowed to be shallow.
           Poll the page the way a caller would. */
        let view = await route.read({});
        const deadline = Date.now() + 5_000;
        while (
          view.controls.every((control) => control.name !== "Save") &&
          Date.now() < deadline
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          view = await route.read({});
        }

        const save = view.controls.find((control) => control.name === "Save");
        expect(save).toBeDefined();
        /* The outer frame is frame 1 and the inner one is frame 2, in the same
           order the snapshot walked them. */
        expect(save?.frame).toBe(2);
        /* The frame the route cannot read is reported, not omitted: a page that
           visibly holds more must not read as complete. */
        expect(view.blindFrames ?? 0).toBeGreaterThanOrEqual(1);

        if (save !== undefined) {
          await route.click({ ref: save.ref });
          const after = await route.read({});
          expect(after.text).toContain("Saved");
        }
      } finally {
        await route.close();
        foreign.close();
        nested.close();
        const dir = profileDir(env.OXRAIL_BROWSER_PROFILE ?? "live", env);
        if (dir !== "")
          await import("node:fs").then((fs) =>
            fs.rmSync(dir, { recursive: true, force: true }),
          );
      }
    },
  );
});
