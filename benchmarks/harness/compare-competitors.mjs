#!/usr/bin/env node
/**
 * Measure this product against two other browser MCPs on the same page and the
 * same question, in characters the caller receives.
 *
 * The table this prints is deliberately not a scoreboard. Two numbers decide
 * each row: what the call costs, and whether the answer is in it. A cheap call
 * that does not answer is worthless, and this script says so on the row.
 *
 * Method: serve a fixture over loopback, drive all three products at it, and
 * count the characters of the tool result -- the part that occupies a context
 * window. A call answers only if it contains the exact text the page used, and
 * for a question about a control, only if that text is on a line carrying a
 * handle the product can act on. Each product is measured across everything it
 * has: this one across all four read modes, Playwright across three keywords
 * times five `maxResults`, Chrome DevTools at its one reading call.
 *
 * Requirements: network (the competitors are fetched with `npx -y`), Chrome.
 * Deliberately outside `pnpm check`: a comparison that depends on a network
 * download must never be the reason the suite is red.
 *
 * Usage:
 *   node benchmarks/harness/compare-competitors.mjs
 *   node benchmarks/harness/compare-competitors.mjs --case long-page
 *   node benchmarks/harness/compare-competitors.mjs --json
 *
 * Pin the competitor versions. "Whatever is latest" is not a comparison.
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname } from "node:path";
import { spawn } from "node:child_process";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const PLAYWRIGHT = { pkg: "@playwright/mcp", version: "0.0.86" };
const CHROME_DEVTOOLS = { pkg: "chrome-devtools-mcp", version: "1.13.0" };

/**
 * Each case names a page, a question a user would actually ask, the text the
 * page uses to answer it, and a word the competitor can search for. The search
 * word is the competitor's best case: it is what a competent agent would type.
 */
const CASES = [
  {
    fixture: "long-page",
    question: "how long do refunds take",
    answer: "five to seven business days",
    /* `business days` is in the answer, not the question, so only a caller who
       already knows the answer could search for it. Kept in the sweep and
       labelled, because hiding it would overstate the gap just as much as
       reporting it unlabelled understates it. */
    terms: ["refund", "refunds take", "business days"],
    oracleTerms: ["business days"],
  },
  {
    fixture: "wide-page",
    question: "what does each row button do",
    answer: "opens that bed for editing",
    terms: ["row", "bed", "opens that bed"],
    oracleTerms: ["opens that bed", "bed"],
  },
  {
    fixture: "huge-dom",
    question: "when do deliveries leave the depot",
    answer: "seven in the morning",
    terms: ["deliver", "depot", "seven"],
    oracleTerms: ["seven"],
  },
  {
    fixture: "huge-label",
    question: "which control shows the delivery status",
    answer: "Show delivery status",
    terms: ["deliver", "status"],
    oracleTerms: [],
    needsAddress: true,
  },
];

/* An address each product prints next to a control it can act on: this
   product's `[12]`, Playwright's `[ref=e12]`, Chrome DevTools' `uid=1_4`. The
   formats differ; what matters is that the line a control's name appears on
   also carries a handle. A control whose name is all a reading returns names
   it without letting anyone click it, which is not an answer to "which control
   shows the delivery status". */
const ADDRESS = /(\[\d+\]|\[ref=[^\]]+\]|uid=\d+_\d+)/;

function answers(text, testCase) {
  const named = text.split("\n").filter((one) => one.includes(testCase.answer));
  if (named.length === 0) return false;
  /* "Mentioned" is not "reachable": a control question is answered only by a
     mention that carries a handle, and the mention in the prose never does. */
  return testCase.needsAddress === true
    ? named.some((one) => ADDRESS.test(one))
    : true;
}

const argv = process.argv.slice(2);
const asJson = argv.includes("--json");
const only = argv.includes("--case") ? argv[argv.indexOf("--case") + 1] : null;

function serve(body) {
  const server = createServer((req, res) => {
    if (req.url !== "/" && req.url !== "/index.html") {
      res.writeHead(404).end("not found");
      return;
    }
    res
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(body);
  });
  return new Promise((done) =>
    server.listen(0, "127.0.0.1", () =>
      done({ server, origin: `http://127.0.0.1:${server.address().port}/` }),
    ),
  );
}

function connect(cmd, args, cwd) {
  const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], cwd });
  let buffer = "";
  let id = 0;
  const pending = new Map();
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    }
  });
  child.stderr.on("data", () => {});
  const send = (method, params) =>
    new Promise((resolveCall) => {
      const callId = ++id;
      pending.set(callId, resolveCall);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id: callId, method, params })}\n`,
      );
    });
  return { child, send };
}

const resultText = (message) =>
  (message?.result?.content ?? []).map((part) => part.text ?? "").join("\n");
const asRendered = (reading) =>
  `${reading.text}\n${reading.controls.map((control) => `[${control.ref}] ${control.role} ${control.name}`).join("\n")}`;

async function measureOxrail(origin, testCase) {
  const bundled = resolve(tmpdir(), `oxrail-compare-${process.pid}.mjs`);
  await build({
    entryPoints: [resolve(HERE, "../../packages/browser-control/src/route.ts")],
    outfile: bundled,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { CdpBrowserRoute } = await import(
    `${pathToFileURL(bundled).href}?run=${Date.now()}`
  );
  const route = new CdpBrowserRoute({
    env: {
      ...process.env,
      OXRAIL_BROWSER_HEADLESS: "1",
      OXRAIL_BROWSER_PROFILE: `oxrail-compare-${process.pid}`,
      OXRAIL_BROWSER_IDLE_MS: "60000",
    },
  });
  const rows = [];
  try {
    await route.open({ url: origin });
    const view = asRendered(await route.read());
    rows.push({
      product: "oxrail",
      call: "browser_view",
      chars: view.length,
      answered: answers(view, testCase),
    });
    const query = asRendered(
      await route.digest({ mode: "query", query: testCase.question }),
    );
    rows.push({
      product: "oxrail",
      call: `browser_read query(${JSON.stringify(testCase.question)})`,
      chars: query.length,
      answered: answers(query, testCase),
    });
    /* Every mode this product has, so "its best call" means the same thing for
       both sides: the cheapest one that actually answered, not the one the
       author expected to win. */
    const map = asRendered(await route.digest({ mode: "map" }));
    rows.push({
      product: "oxrail",
      call: "browser_read map",
      chars: map.length,
      answered: answers(map, testCase),
    });
    const article = asRendered(
      await route.digest({ mode: "article", maxChars: 1_000_000 }),
    );
    rows.push({
      product: "oxrail",
      call: "browser_read article",
      chars: article.length,
      answered: answers(article, testCase),
    });
  } finally {
    await route.close().catch(() => {});
    await rm(bundled, { force: true });
  }
  return rows;
}

async function measurePlaywright(origin, testCase) {
  // The competitor writes snapshot sidecars into its working directory, so
  // it runs in one that is thrown away rather than in the checkout.
  const scratch = await mkdtemp(join(tmpdir(), "compare-competitor-"));
  const { child, send } = connect(
    "npx",
    [
      "-y",
      `${PLAYWRIGHT.pkg}@${PLAYWRIGHT.version}`,
      "--headless",
      "--isolated",
    ],
    scratch,
  );
  const call = async (name, callArgs) =>
    resultText(await send("tools/call", { name, arguments: callArgs }));
  const rows = [];
  try {
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "compare", version: "0" },
    });
    await send("notifications/initialized", {});
    await call("browser_navigate", { url: origin });
    const snapshot = await call("browser_snapshot", {});
    rows.push({
      product: "playwright-mcp",
      call: "browser_snapshot",
      chars: snapshot.length,
      answered: answers(snapshot, testCase),
    });
    /* A keyword search is only as good as the keyword, so every term a
       competent caller might pick is tried and the cheapest that answers is
       what gets reported. Picking one term here would be picking the result. */
    for (const term of testCase.terms)
      for (const maxResults of [1, 2, 3, 5, 40]) {
        const found = await call("browser_find", { text: term, maxResults });
        rows.push({
          product: "playwright-mcp",
          call: `browser_find(${JSON.stringify(term)}, maxResults:${maxResults})`,
          chars: found.length,
          answered: answers(found, testCase),
          blind: !testCase.oracleTerms.includes(term),
        });
      }
    await call("browser_close", {});
  } finally {
    child.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  }
  return rows;
}

/**
 * chrome-devtools-mcp reads a page with `take_snapshot`, an accessibility dump.
 * It has no keyword search, so a full snapshot is its only way to answer a
 * question -- `wait_for` re-sends the snapshot rather than a matching snippet.
 * Every call after `list_pages` has to name a page id, so the id is looked up
 * per run rather than assumed.
 */
async function measureChromeDevtools(origin, testCase) {
  const scratch = await mkdtemp(join(tmpdir(), "compare-devtools-"));
  const { child, send } = connect(
    "npx",
    [
      "-y",
      `${CHROME_DEVTOOLS.pkg}@${CHROME_DEVTOOLS.version}`,
      "--headless",
      "--isolated",
    ],
    scratch,
  );
  const call = async (name, callArgs) =>
    resultText(await send("tools/call", { name, arguments: callArgs }));
  const rows = [];
  try {
    await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "compare", version: "0" },
    });
    await send("notifications/initialized", {});
    const pages = await call("list_pages", {});
    const listed = /^\s*(\d+):/m.exec(pages);
    const pageId = listed ? Number(listed[1]) : 1;
    await call("navigate_page", { url: origin, pageId });
    const snapshot = await call("take_snapshot", { pageId });
    rows.push({
      product: "chrome-devtools",
      call: "take_snapshot",
      chars: snapshot.length,
      answered: answers(snapshot, testCase),
    });
  } finally {
    child.kill("SIGKILL");
    await rm(scratch, { recursive: true, force: true });
  }
  return rows;
}

const report = [];
for (const testCase of CASES) {
  if (only && testCase.fixture !== only) continue;
  const body = await readFile(
    resolve(HERE, `../fixtures/${testCase.fixture}/index.html`),
    "utf8",
  );
  const { server, origin } = await serve(body);
  try {
    const rows = [
      ...(await measureOxrail(origin, testCase)),
      ...(await measurePlaywright(origin, testCase)),
      ...(await measureChromeDevtools(origin, testCase)),
    ];
    report.push({ ...testCase, sourceChars: body.length, rows });
    if (!asJson) {
      console.log(`\n${testCase.fixture}  —  ${body.length} chars served`);
      console.log(
        `  question: ${JSON.stringify(testCase.question)}   answer: ${JSON.stringify(testCase.answer)}`,
      );
      for (const row of rows) {
        const verdict = row.answered ? "answers" : "does not answer";
        const caveat =
          row.blind === false ? ", but needs a word from the answer" : "";
        console.log(
          `    ${String(row.chars).padStart(7)}  ${row.product.padEnd(15)} ${row.call}   (${verdict}${caveat})`,
        );
      }
      /* Two summaries, because one would hide a real dependency. The blind one
         is what a caller who only has the question can actually achieve; the
         other is what opening with a word from the answer buys. This product's
         `query` takes the question itself, and `map`/`article`/`view` need no
         words at all, so all of its rows are blind. */
      for (const [label, pool] of [
        [
          "smallest call that answers, given only the question",
          rows.filter((row) => row.blind !== false),
        ],
        ["smallest call that answers, given a word from the answer", rows],
      ]) {
        const answered = pool
          .filter((row) => row.answered)
          .sort((a, b) => a.chars - b.chars);
        console.log(
          answered.length === 0
            ? `  ${label}: none`
            : `  ${label}: ${answered[0].chars} chars, ${answered[0].product} ${answered[0].call}`,
        );
      }
    }
  } finally {
    server.close();
  }
}

if (asJson) console.log(JSON.stringify(report, null, 1));
