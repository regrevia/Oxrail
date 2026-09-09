import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const readJson = async (filename) =>
  JSON.parse(await readFile(path.join(pluginRoot, filename), "utf8"));
const walk = async (directory, prefix = "") => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (prefix === "" && entry.name === ".git" && entry.isDirectory()) continue;
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`SYMLINK_REJECTED:${relative}`);
    if (entry.isDirectory()) {
      files.push(...(await walk(path.join(directory, entry.name), relative)));
    } else if (entry.isFile()) {
      files.push(relative);
    } else {
      throw new Error(`SPECIAL_FILE_REJECTED:${relative}`);
    }
  }
  return files;
};

try {
  const [inventory, release, manifest, pkg] = await Promise.all([
    readJson("product-files.json"),
    readJson("release-manifest.json"),
    readJson(".codex-plugin/plugin.json"),
    readJson("package.json"),
  ]);
  if (
    inventory.schemaVersion !== 1 ||
    release.schemaVersion !== 1 ||
    release.hashAlgorithm !== "sha256" ||
    release.selfExcluded !== "release-manifest.json"
  ) {
    throw new Error("MANIFEST_SCHEMA_INVALID");
  }
  if (
    release.product !== "oxrail" ||
    release.version !== manifest.version ||
    release.version !== pkg.version ||
    release.immutableRef !== `product-v${release.version}`
  ) {
    throw new Error("VERSION_BINDING_INVALID");
  }
  const actual = (await walk(pluginRoot)).sort();
  const expected = [...inventory.files].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("FILE_ALLOWLIST_MISMATCH");
  }
  const hashedFiles = Object.keys(release.files).sort();
  const expectedHashed = expected
    .filter((filename) => filename !== release.selfExcluded)
    .sort();
  if (JSON.stringify(hashedFiles) !== JSON.stringify(expectedHashed)) {
    throw new Error("HASH_ALLOWLIST_MISMATCH");
  }
  for (const filename of hashedFiles) {
    const info = await lstat(path.join(pluginRoot, filename));
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`NON_REGULAR_FILE:${filename}`);
    }
    const actualHash = createHash("sha256")
      .update(await readFile(path.join(pluginRoot, filename)))
      .digest("hex");
    if (actualHash !== release.files[filename]) {
      throw new Error(`HASH_MISMATCH:${filename}`);
    }
  }
  console.log(
    JSON.stringify({
      schemaVersion: 1,
      product: "oxrail",
      version: release.version,
      immutableRef: release.immutableRef,
      artifactIntegrity: "PASS",
      fileCount: expected.length,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      schemaVersion: 1,
      product: "oxrail",
      artifactIntegrity: "FAIL",
      code: error instanceof Error ? error.message : "VERIFY_FAILED",
    }),
  );
  process.exitCode = 1;
}
