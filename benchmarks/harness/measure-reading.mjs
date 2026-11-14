/* Measure what each reading mode costs on one fixture, in one browser session.
 *
 * `docs/product/browser-control.md` quotes five character counts. Quoted
 * numbers that no script produces are numbers that drift, so this is the
 * script: it serves `benchmarks/fixtures/long-page/`, opens it once, and runs
 * the five calls the document describes.
 *
 *   node benchmarks/harness/measure-reading.mjs [--json]
 *
 * It reports characters returned to the caller -- the part that occupies a
 * context window -- not bytes on the wire. The distinction matters: a control's
 * ref costs characters, and the browser does not care about that.
 *
 * This is one fixture on one machine. It is not a benchmark and the output says
 * so; the claim being checked is a shape (a question costs the answer, not the
 * page), and a shape that only holds in a script is worth less than one that
 * holds here. */
import { createServer } from "node:http";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const pagePath = resolve(here, "../fixtures/long-page/index.html");
const QUESTION = "how long do refunds take";

/* The five calls the document tabulates, in the order it lists them. Each entry
   says what it is for, so a mode that stops being useful is visible as a number
   that stopped moving rather than as an unexplained column. */
const CALLS = [
  {
    label: "browser_view",
    why: "whole page, numbered controls",
    run: (route) => route.read(),
  },
  {
    label: 'browser_read {mode:"article", maxChars:24000}',
    why: "the page as a reading column",
    run: (route) => route.digest({ mode: "article", maxChars: 24_000 }),
  },
  {
    label: 'browser_read {mode:"map"}',
    why: "the shape, without the words",
    run: (route) => route.digest({ mode: "map" }),
  },
  {
    label: `browser_read {mode:"query", query:"${QUESTION}"}`,
    why: "the passages that answer the question",
    run: (route) => route.digest({ mode: "query", query: QUESTION }),
  },
  {
    label: 'browser_read {mode:"changed"} after a click',
    why: "only what the previous read did not say",
    run: (route) => route.digest({ mode: "changed" }),
  },
];

async function serve() {
  const body = await readFile(pagePath, "utf8");
  const server = createServer((request, response) => {
    if (request.url !== "/" && request.url !== "/index.html") {
      response.writeHead(404).end("not found");
      return;
    }
    response
      .writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      })
      .end(body);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}/`, server };
}

/** What the caller actually receives as text: the words plus the control lines. */
function receiptOf(snapshot) {
  const controls = snapshot.controls
    .map((control) => `[${control.ref}] ${control.role} ${control.name}`)
    .join("\n");
  return {
    text: snapshot.text,
    controls,
    chars: snapshot.text.length + controls.length,
  };
}

async function main() {
  const { origin, server } = await serve();
  /* The route is TypeScript and the product build only emits the MCP entry, so
     the route is bundled here rather than requiring a build first: measuring
     should not depend on an artefact that exists only in a release layout. */
  /* Written outside the repository so a measurement run leaves nothing behind
     for git to see. */
  const bundled = resolve(tmpdir(), `oxrail-measure-${process.pid}.mjs`);
  await build({
    entryPoints: [resolve(here, "../../packages/browser-control/src/route.ts")],
    outfile: bundled,
    bundle: true,
    platform: "node",
    format: "esm",
    logLevel: "silent",
  });
  const { CdpBrowserRoute } = await import(
    `${pathToFileURL(bundled).href}?t=${Date.now()}`
  );
  const route = new CdpBrowserRoute({
    env: {
      ...process.env,
      OXRAIL_BROWSER_HEADLESS: "1",
      OXRAIL_BROWSER_PROFILE: `measure-${process.pid}`,
      OXRAIL_BROWSER_IDLE_MS: "60000",
    },
  });

  const rows = [];
  try {
    await route.open({ url: origin });
    for (const call of CALLS) {
      if (call.label.includes("changed")) {
        /* `changed` diffs against the last text-shaped read, so it needs one
           after the click or it is reporting first-read cost. The fixture's
           button does not navigate, so the delta is about the change and not
           about a new address. */
        await route.click({ text: "Show delivery status" });
      }
      const started = process.hrtime.bigint();
      const snapshot = await call.run(route);
      const elapsed = Number(process.hrtime.bigint() - started) / 1e6;
      const receipt = receiptOf(snapshot);
      rows.push({
        call: call.label,
        why: call.why,
        chars: receipt.chars,
        textChars: receipt.text.length,
        controlChars: receipt.controls.length,
        words: snapshot.words ?? null,
        truncated: snapshot.truncated === true,
        ms: Math.round(elapsed * 100) / 100,
      });
    }
  } finally {
    await route.close().catch(() => {});
    server.close();
    await rm(bundled, { force: true }).catch(() => {});
  }

  const view = rows[0].chars;
  for (const row of rows) {
    row.ofView =
      view === 0 ? null : Math.round((row.chars / view) * 1000) / 1000;
  }

  if (process.argv.includes("--json")) {
    console.log(
      JSON.stringify(
        { fixture: "benchmarks/fixtures/long-page", rows },
        null,
        2,
      ),
    );
    return;
  }
  const width = Math.max(...rows.map((row) => row.call.length));
  console.log(`${"".padEnd(width)}  text chars | controls | total`);
  for (const row of rows)
    console.log(
      `${row.call.padEnd(width)}  ${String(row.textChars).padStart(10)} | ${String(row.controlChars).padStart(8)} | ${String(row.chars).padStart(5)}`,
    );
  console.log("");
  for (const row of rows) {
    const percent =
      row.ofView === null ? "" : ` (${(row.ofView * 100).toFixed(1)}%)`;
    console.log(
      `${row.call.padEnd(width)}  ${String(row.chars).padStart(5)} chars${percent.padEnd(9)} ${String(row.ms).padStart(6)}ms  ${row.why}`,
    );
  }
  console.log(
    "\nOne fixture on one machine, headless Chrome. Not a benchmark, and not a claim about other pages.",
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
