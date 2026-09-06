#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const publicError = (errorCode) => ({
  schemaVersion: 1,
  status: "ERROR",
  errorCode,
});
const emit = (value, status) => {
  process.stdout.write(`${JSON.stringify(value)}\n`);
  process.exit(status);
};
const actions = {
  prompt: "--prompt-fixture",
  status: "--status-fixture",
  consume: "--consume-fixture",
  revoke: "--revoke-fixture",
};
const [action, reference, ...extra] = process.argv.slice(2);
const referenceRequired = ["status", "consume", "revoke"].includes(action);
const validReference = /^ocref1_[A-Za-z0-9_-]{43}$/;

if (
  !Object.hasOwn(actions, action ?? "") ||
  extra.length > 0 ||
  (referenceRequired
    ? !reference || !validReference.test(reference)
    : reference)
) {
  emit(publicError("SCOPE_MISMATCH"), 64);
}

const platform = process.env.OXRAIL_TEST_PLATFORM ?? process.platform;
if (platform !== "darwin") emit(publicError("UNAVAILABLE"), 1);

process.umask(0o077);
const skillDirectory = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(skillDirectory, "../../..");
const packageRoot = path.join(pluginRoot, "native", "macos");
let version;
try {
  version = JSON.parse(
    readFileSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"), "utf8"),
  ).version;
} catch {
  emit(publicError("UNAVAILABLE"), 1);
}
const buildRoot = path.join(
  homedir(),
  ".oxrail",
  "credential-demo",
  String(version).replace(/[^A-Za-z0-9._-]/g, "_"),
);
await mkdir(buildRoot, { recursive: true, mode: 0o700 });

const build = spawnSync(
  "swift",
  [
    "build",
    "--package-path",
    packageRoot,
    "--scratch-path",
    buildRoot,
    "-c",
    "release",
    "--product",
    "oxrail-credential-demo",
  ],
  { encoding: "utf8", stdio: "ignore" },
);
if (build.status !== 0) emit(publicError("UNAVAILABLE"), 1);

const binary = path.join(buildRoot, "release", "oxrail-credential-demo");
const invocation = [actions[action]];
if (referenceRequired) invocation.push(reference);
const result = spawnSync(binary, invocation, {
  encoding: "utf8",
  maxBuffer: 16_384,
  stdio: ["ignore", "pipe", "ignore"],
});

let output;
try {
  output = JSON.parse(result.stdout.trim());
} catch {
  emit(publicError("UNAVAILABLE"), 1);
}
const keys = Object.keys(output).sort().join(",");
const valid =
  output.schemaVersion === 1 &&
  ((["READY", "STORED"].includes(output.status) &&
    keys === "credentialRef,schemaVersion,status" &&
    validReference.test(output.credentialRef)) ||
    (output.status === "CANCELLED" && keys === "schemaVersion,status") ||
    (output.status === "ERROR" &&
      keys === "errorCode,schemaVersion,status" &&
      [
        "UNAVAILABLE",
        "NOT_AUTHORIZED",
        "SCOPE_MISMATCH",
        "EXPIRED",
        "REVOKED",
        "INTERNAL_ERROR",
      ].includes(output.errorCode)));

emit(
  valid ? output : publicError("UNAVAILABLE"),
  valid && output.status !== "ERROR" ? 0 : 1,
);
