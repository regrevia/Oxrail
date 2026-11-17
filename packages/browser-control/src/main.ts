/* The stdio entry point for the Browser Control route.
 *
 * The route is imported lazily so `--version` and `--help` cost nothing, and so
 * a bundled build starts Chrome only when the host actually calls a tool.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { BrowserRoute } from "./types.js";
import { serveMcp } from "./mcp.js";

/** Kept in step with the package version that ships this file. */
export const VERSION = "0.1.0-alpha.8";

const USAGE =
  "usage: oxrail-browser-control [--version|--help]  (stdio MCP server for the Browser Control route)";

const INSTRUCTIONS =
  "This server drives its own headless Chrome through the Browser Control route. It is opt-in and separate from the person's browser: call browser_open before any other browser tool, and browser_close when the work is done.";

/**
 * Run the server until stdin ends.
 *
 * `--version` and `--help` print one line to stdout and exit before the server
 * starts, so no non-protocol bytes ever reach a host that is already talking
 * JSON-RPC. Any other argument is reported on stderr and ignored.
 */
export async function main(
  argv: readonly string[] = process.argv.slice(2),
): Promise<number> {
  if (argv.includes("--version")) {
    process.stdout.write(`oxrail-browser-control ${VERSION}\n`);
    return 0;
  }
  if (argv.includes("--help")) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  for (const argument of argv) {
    if (!argument.startsWith("-")) continue;
    process.stderr.write(
      `browser-control: ignoring unknown argument ${argument}\n`,
    );
  }

  const { CdpBrowserRoute } = await import("./route.js");
  const route: BrowserRoute = new CdpBrowserRoute();
  const server = serveMcp({
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
    route,
    version: VERSION,
    instructions: INSTRUCTIONS,
  });

  let shutdown: Promise<void> | null = null;
  const stop = (): Promise<void> => {
    shutdown ??= (async () => {
      try {
        await route.close();
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(
          `browser-control: closing the browser route failed: ${detail}\n`,
        );
      }
      server.close();
    })();
    return shutdown;
  };
  const onSignal = (): void => {
    void stop();
  };
  process.once("SIGTERM", onSignal);
  process.once("SIGINT", onSignal);

  await server.closed;
  // The route's close waits for Chrome to actually exit, so the process must
  // stay alive until then; exiting earlier leaves a headless browser behind.
  await stop();
  process.exit(0);
}

/** Whether `left` and `right` name the same file, following symlinks. */
function samePath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return left === right;
  }
}

const entry = process.argv[1];
// A host may reach the bundle through a symlink (macOS /tmp is one), where a
// plain URL comparison silently decided it was imported and did nothing.
if (entry !== undefined && samePath(entry, fileURLToPath(import.meta.url))) {
  process.exitCode = await main();
}
