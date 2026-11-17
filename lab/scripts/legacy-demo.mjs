#!/usr/bin/env node

import { lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const target = path.join(homedir(), ".oxrail", "credential-demo");
const action = process.argv[2];
if (
  !["status", "purge-build-cache"].includes(action) ||
  process.argv.length !== 3
) {
  process.stderr.write("usage: legacy-demo <status|purge-build-cache>\n");
  process.exit(64);
}

let state;
try {
  state = await lstat(target);
} catch (error) {
  if (error?.code !== "ENOENT") process.exit(1);
}
if (state && (!state.isDirectory() || state.isSymbolicLink())) {
  process.stderr.write("legacy fixture cache is not a safe directory\n");
  process.exit(1);
}

if (action === "purge-build-cache" && state) {
  await rm(target, { recursive: true, force: false });
}
process.stdout.write(
  `${JSON.stringify({
    schemaVersion: 1,
    resource: "LEGACY_FIXTURE_BUILD_CACHE_ONLY",
    status:
      action === "status"
        ? state
          ? "PRESENT"
          : "ABSENT"
        : state
          ? "PURGED"
          : "ABSENT",
    keychainTouched: false,
    productStateTouched: false,
  })}\n`,
);
