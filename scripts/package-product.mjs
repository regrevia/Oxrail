import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const releaseRoot = path.resolve("release/oxrail");
const manifest = JSON.parse(await readFile("product-files.json", "utf8"));
const sourcePackage = JSON.parse(await readFile("package.json", "utf8"));

await rm(releaseRoot, { recursive: true, force: true });
await mkdir(releaseRoot, { recursive: true, mode: 0o755 });
for (const entry of manifest.files) {
  const destination = path.join(releaseRoot, entry.destination);
  await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
  await cp(path.resolve(entry.source), destination, { force: true });
}

await writeFile(
  path.join(releaseRoot, "package.json"),
  `${JSON.stringify(
    {
      name: "oxrail",
      version: sourcePackage.version,
      private: true,
      type: "module",
      engines: sourcePackage.engines,
      scripts: {
        bootstrap: "node dist/bootstrap.mjs",
        doctor: "node dist/doctor.mjs",
        "verify-install": "node skills/oxrail/scripts/verify-install.mjs",
        "trial-check": "node skills/oxrail/scripts/trial-check.mjs",
      },
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  path.join(releaseRoot, "product-files.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      files: [
        ...manifest.files.map((entry) => entry.destination),
        "package.json",
        "product-files.json",
        "release-manifest.json",
      ].sort(),
    },
    null,
    2,
  )}\n`,
);

const integrityFiles = [
  ...manifest.files.map((entry) => entry.destination),
  "package.json",
  "product-files.json",
].sort();
const hashes = {};
for (const filename of integrityFiles) {
  hashes[filename] = createHash("sha256")
    .update(await readFile(path.join(releaseRoot, filename)))
    .digest("hex");
}
await writeFile(
  path.join(releaseRoot, "release-manifest.json"),
  `${JSON.stringify(
    {
      schemaVersion: 1,
      product: "oxrail",
      version: sourcePackage.version,
      immutableRef: `product-v${sourcePackage.version}`,
      hashAlgorithm: "sha256",
      selfExcluded: "release-manifest.json",
      files: hashes,
    },
    null,
    2,
  )}\n`,
);

console.log(`product package staged at ${releaseRoot}`);
