#!/usr/bin/env node
/**
 * Measure this product against another browser MCP on the same page and the
 * same question, in characters the caller receives.
 *
 * The table this prints is deliberately not a scoreboard. Two numbers decide
 * each row: what the call costs, and whether the answer is in it. A cheap call
 * that does not answer is worthless, and this script says so on the row.
 *
 * Method: serve a fixture over loopback, drive both products at it, and count
 * the characters of the tool result -- the part that occupies a context
 * window. The answer is checked by literal substring, so a case only passes if
 * the exact text the page used comes back.
 *
 * Requirements: network (the competitor is fetched with `npx -y`), Chrome.
 * Deliberately outside `pnpm check`: a comparison that depends on a network
 * download must never be the reason the suite is red.
 *
 * Usage:
 *   node benchmarks/harness/compare-competitors.mjs
 *   node benchmarks/harness/compare-competitors.mjs --case long-page
 *   node benchmarks/harness/compare-competitors.mjs --json
 *
 * Pin the competitor version. "Whatever is latest" is not a comparison.
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
const COMPETITOR = { pkg: "@playwright/mcp", version: "0.0.86" };

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
    term: "refund",
  },
  {
    fixture: "wide-page",
    question: "when should i water",
    answer: "Watering schedule",
    term: "watering",
  },
  {
    fixture: "huge-dom",
    question: "how many warehouses are listed",
    answer: "Warehouse list",
    term: "warehouse",
  },
  {
    fixture: "huge-label",
    question: "confirm the order",
    answer: "Show delivery status",
    term: "deliver",
  },
];

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
      answered: view.includes(testCase.answer),
    });
    const query = asRendered(
      await route.digest({ mode: "query", query: testCase.question }),
    );
    rows.push({
      product: "oxrail",
      call: `browser_read query(${JSON.stringify(testCase.question)})`,
      chars: query.length,
      answered: query.includes(testCase.answer),
    });
  } finally {
    await route.close().catch(() => {});
    await rm(bundled, { force: true });
  }
  return rows;
}

async function measureCompetitor(origin, testCase) {
  // The competitor writes snapshot sidecars into its working directory, so
  // it runs in one that is thrown away rather than in the checkout.
  const scratch = await mkdtemp(join(tmpdir(), "compare-competitor-"));
  const { child, send } = connect(
    "npx",
    [
      "-y",
      `${COMPETITOR.pkg}@${COMPETITOR.version}`,
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
      answered: snapshot.includes(testCase.answer),
    });
    for (const maxResults of [1, 2, 3, 5, 40]) {
      const found = await call("browser_find", {
        text: testCase.term,
        maxResults,
      });
      rows.push({
        product: "playwright-mcp",
        call: `browser_find(${JSON.stringify(testCase.term)}, maxResults:${maxResults})`,
        chars: found.length,
        answered: found.includes(testCase.answer),
      });
    }
    await call("browser_close", {});
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
      ...(await measureCompetitor(origin, testCase)),
    ];
    report.push({ ...testCase, sourceChars: body.length, rows });
    if (!asJson) {
      console.log(`\n${testCase.fixture}  —  ${body.length} chars served`);
      console.log(
        `  question: ${JSON.stringify(testCase.question)}   answer: ${JSON.stringify(testCase.answer)}`,
      );
      for (const row of rows) {
        const verdict = row.answered ? "answers" : "does not answer";
        console.log(
          `    ${String(row.chars).padStart(7)}  ${row.product.padEnd(15)} ${row.call}   (${verdict})`,
        );
      }
      const answered = rows
        .filter((row) => row.answered)
        .sort((a, b) => a.chars - b.chars);
      if (answered.length > 0) {
        console.log(
          `  smallest call that actually answers: ${answered[0].chars} chars, ${answered[0].product} ${answered[0].call}`,
        );
      }
    }
  } finally {
    server.close();
  }
}

if (asJson) console.log(JSON.stringify(report, null, 1));
