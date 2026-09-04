import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { fingerprint } from "./paired.mjs";

const fixturePath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/interaction-primitives/index.html",
);
const safeId = /^[A-Za-z0-9._-]{1,160}$/;
const DEFAULT_ORIGIN = "http://127.0.0.1:4173";
const responseHeaders = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'self' 'unsafe-inline'; frame-src 'self'",
});

export const FIXTURE_INITIAL_POSTCONDITIONS = Object.freeze({
  click_count: 0,
  click_target_clicks: 0,
  dragstart_events: 0,
  drop_events: 0,
  drop_state: "drop target",
  frame_click_count: 0,
  horizontal_end_visible: false,
  horizontal_scroll: 0,
  no_progress_attempts: 0,
  no_progress_state: "unchanged",
  no_progress_target_clicks: 0,
  rerender_generation: 1,
  rerender_target_clicks: 0,
  typed_length: 0,
  typed_matches_fixture_token: false,
  typing_input_events: 0,
  vertical_end_visible: false,
  vertical_scroll: 0,
});

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function localOrigin(value = DEFAULT_ORIGIN) {
  const url = new URL(value);
  if (
    url.protocol !== "http:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("fixture origin must be explicit loopback HTTP");
  }
  return url.origin;
}

function parseResetInput(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("invalid reset request");
  const keys = Object.keys(value).sort();
  if (keys.join(",") !== "arm_id,run_id,seed,task_id")
    throw new Error("invalid reset request");
  for (const key of keys) {
    if (typeof value[key] !== "string" || !safeId.test(value[key]))
      throw new Error("invalid reset request");
  }
  return value;
}

export async function createResetReceipt(input, options = {}) {
  const parsed = parseResetInput(input);
  const fixture = await readFile(options.fixturePath ?? fixturePath);
  const fixture_sha256 = sha256(fixture);
  const initial_state = { ...FIXTURE_INITIAL_POSTCONDITIONS };
  const initial_state_hash = fingerprint(initial_state);
  const receipt_id = fingerprint({
    fixture_sha256,
    initial_state_hash,
    run_id: parsed.run_id,
    arm_id: parsed.arm_id,
    task_id: parsed.task_id,
    seed: parsed.seed,
  });
  const origin = localOrigin(options.origin);
  return {
    schema_version: 1,
    receipt_id,
    ...parsed,
    fixture_sha256,
    initial_state_hash,
    initial_state,
    reset_url: `${origin}/?reset=${receipt_id}`,
  };
}

async function readBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 16_384) throw new Error("request too large");
  }
  return JSON.parse(body);
}

export function createFixtureServer(options = {}) {
  const servedFixture = options.fixturePath ?? fixturePath;
  const origin = localOrigin(options.origin);
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", origin);
      if (request.method === "GET" && url.pathname === "/health") {
        response.writeHead(200, {
          ...responseHeaders,
          "content-type": "application/json",
        });
        response.end('{"ok":true}\n');
        return;
      }
      if (request.method === "POST" && url.pathname === "/reset") {
        const receipt = await createResetReceipt(await readBody(request), {
          fixturePath: servedFixture,
          origin,
        });
        response.writeHead(200, {
          ...responseHeaders,
          "content-type": "application/json",
        });
        response.end(`${JSON.stringify(receipt, null, 2)}\n`);
        return;
      }
      if (
        request.method === "GET" &&
        ["/", "/index.html"].includes(url.pathname)
      ) {
        const details = await stat(servedFixture);
        response.writeHead(200, {
          ...responseHeaders,
          "content-length": details.size,
          "content-type": "text/html; charset=utf-8",
        });
        createReadStream(servedFixture).pipe(response);
        return;
      }
      response.writeHead(404).end();
    } catch {
      response.writeHead(400, { "content-type": "application/json" });
      response.end('{"error":"invalid request"}\n');
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const host = "127.0.0.1";
  const port = Number(process.env.OXRAIL_FIXTURE_PORT ?? 4173);
  const server = createFixtureServer({ origin: `http://${host}:${port}` });
  server.listen(port, host, () =>
    process.stdout.write(`Oxrail fixture: http://${host}:${port}\n`),
  );
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
}
