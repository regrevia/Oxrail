/* Measure what each reading mode costs on one fixture, in one browser session.
 *
 * `docs/product/browser-control.md` quotes five character counts. Quoted
 * numbers that no script produces are numbers that drift, so this is the
 * script: it serves one fixture, opens it once, and runs the five calls the
 * document describes.
 *
 *   node benchmarks/harness/measure-reading.mjs [--fixture <name>] [--json]
 *
 * The default fixture is `benchmarks/fixtures/long-page/`; `--fixture
 * article-page` runs the same five calls on `benchmarks/fixtures/article-page/`.
 * `wide-page` (many controls, little prose) and `deep-outline` (many headings,
 * one control) reach the control and outline ceilings, which `capped:` names.
 *
 * It reports characters returned to the caller -- the part that occupies a
 * context window -- not bytes on the wire. The distinction matters: a control's
 * ref costs characters, and the browser does not care about that.
 *
 * Above the table it prints what the page costs when nothing is bounded: the
 * characters the server sends, and the characters its prose occupies once the
 * markup is gone. Without those two numbers the table is a list of sizes with
 * nothing to be small against, and "255 characters" reads as a win even on a
 * page that only had 300. The ratio between them is the only honest headline:
 * it is large when a page is long somewhere other than its words, and close to
 * one when the page is prose, which is a normal page and not a failure.
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
const QUESTION = "how long do refunds take";

/* One fixture by default, so the numbers the document quotes stay reproducible
   by the command it quotes. `--fixture article-page` runs the same five calls
   on a page of the opposite shape -- long prose, three links -- which is how
   the shape claim is checked rather than asserted: if a mode only saves on one
   page shape it is a property of that page, not of the mode. */
const fixtureName =
  (() => {
    const flag = process.argv.indexOf("--fixture");
    if (flag !== -1 && process.argv[flag + 1])
      return process.argv[flag + 1].replace(/\/+$/, "");
    const inline = process.argv.find((arg) => arg.startsWith("--fixture="));
    return inline
      ? inline.slice("--fixture=".length).replace(/\/+$/, "")
      : null;
  })() ?? "long-page";
const fixturePath = resolve(here, "../fixtures", fixtureName);

/* A second question, so the document can quote a named one honestly. */
function askedQueryArg() {
  const flag = process.argv.indexOf("--query");
  if (flag !== -1 && process.argv[flag + 1]) return process.argv[flag + 1];
  const inline = process.argv.find((arg) => arg.startsWith("--query="));
  return inline ? inline.slice("--query=".length) : null;
}
const askedQuery = askedQueryArg();
/* Imported from source so the measurement uses the shipped serialiser.
   Module scope, because `receiptOf` is called from the report builder. */
const { controlLines } = await import(
  pathToFileURL(resolve(here, "../../packages/browser-control/src/read.ts"))
    .href
);
const pagePath = resolve(fixturePath, "index.html");

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
  const body = await readFile(pagePath, "utf8").catch(() => {
    throw new Error(
      `no fixture at ${pagePath}; pass --fixture <name> for a directory under benchmarks/fixtures/`,
    );
  });
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
  /* The bytes the server hands over are the fixture file verbatim, so this
     length is a measurement, not an estimate. It is the comparison the five
     calls above are missing: without it "255 characters" is a number with
     nothing to be small against. */
  return {
    origin: `http://127.0.0.1:${port}/`,
    server,
    sourceChars: body.length,
  };
}

/** What the caller actually receives as text: the words plus the control lines.
 *
 * The lines come from `controlLines`, the same function the server uses, so a
 * run that got folded is measured as folded. Re-serialising here -- one row per
 * control -- would report the page this layer exists to stop sending, and every
 * number in the document would be a size the caller never received. */
function receiptOf(snapshot) {
  const controls = controlLines(snapshot.controls).join("\n");
  return {
    text: snapshot.text,
    controls,
    chars: snapshot.text.length + controls.length,
  };
}

async function main() {
  const { origin, server, sourceChars } = await serve();
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
  let wholeProseChars = 0;
  let asked = null;
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
        /* Which ceiling fired, not only that one did: a row that says
           "truncated" without naming the cap cannot be compared with one
           that hit a different cap on the same page. */
        limit: snapshot.truncated === true ? (snapshot.limit ?? null) : null,
        ms: Math.round(elapsed * 100) / 100,
      });
    }
    /* One more question, asked of the same session: what does this page cost
       if nothing is bounded? An article read with a budget larger than the page
       returns the whole column, so this is the prose size itself. It is the
       second half of the comparison -- the source is what an unbounded reader
       forwards, this is what one actually has to read. */
    const whole = await route.digest({ mode: "article", maxChars: 1_000_000 });
    wholeProseChars = whole.text.length;
    /* A question the caller names, not only the fixed one above. The document
       claims what a named question does to the control list, and a claim about
       a question is only checkable if that question can be run. Measured
       before the session closes, and reported apart from the table because it
       answers a different thing: how much of the list survives, not how many
       characters the page cost. */
    if (askedQuery !== null) {
      const snapshot = await route.digest({
        mode: "query",
        query: askedQuery,
      });
      const controls = controlLines(snapshot.controls).join("\n");
      asked = {
        query: askedQuery,
        chars: snapshot.text.length + controls.length,
        controlChars: controls.length,
        kept: snapshot.controls.length,
        omitted: snapshot.omitted ?? 0,
      };
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
        {
          fixture: `benchmarks/fixtures/${fixtureName}`,
          page: { sourceChars, wholeProseChars },
          rows,
        },
        null,
        2,
      ),
    );
    return;
  }
  /* The page measured two ways that involve no budget: what the server sends,
     and what is left of it once the markup is gone. `browser_view` is then
     stated against the first, because what a bounded read buys is the ratio
     between the two -- a number is only small against something. */
  const multiple =
    view === 0 ? null : Math.round((sourceChars / view) * 10) / 10;
  console.log(`the page as served: ${sourceChars} chars of HTML`);
  console.log(`read whole, as prose: ${wholeProseChars} chars`);
  if (multiple !== null)
    console.log(
      `browser_view sends 1 char for every ${multiple} the page serves`,
    );
  console.log("");
  const width = Math.max(...rows.map((row) => row.call.length));
  console.log(`${"".padEnd(width)}  text chars | controls | total`);
  for (const row of rows)
    console.log(
      `${row.call.padEnd(width)}  ${String(row.textChars).padStart(10)} | ${String(row.controlChars).padStart(8)} | ${String(row.chars).padStart(5)}`,
    );
  console.log("");
  if (asked !== null) {
    const left =
      asked.omitted === 0 ? "every control kept" : `${asked.omitted} left out`;
    console.log(
      `question "${asked.query}": ${asked.kept} control${asked.kept === 1 ? "" : "s"} kept, ${left}`,
    );
    console.log(
      `  ${asked.chars} chars (${asked.controlChars} of them control lines)`,
    );
    console.log("");
  }
  for (const row of rows) {
    const percent =
      row.ofView === null ? "" : ` (${(row.ofView * 100).toFixed(1)}%)`;
    const capped = row.limit === null ? "" : `  capped: ${row.limit}`;
    console.log(
      `${row.call.padEnd(width)}  ${String(row.chars).padStart(5)} chars${percent.padEnd(9)} ${String(row.ms).padStart(6)}ms${capped}  ${row.why}`,
    );
  }
  console.log(
    `\nOne fixture on one machine, headless Chrome: benchmarks/fixtures/${fixtureName}. Not a benchmark, and not a claim about other pages.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
