import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const outputRoot = "lab/dist";
await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const probeSources = [
  "package.json",
  "pnpm-lock.yaml",
  "scripts/build-lab.mjs",
  "lab/probes/handoff-control/manifest.json",
  "packages/handoff-extension/src/presenter.ts",
  "lab/probes/handoff-control/probe.ts",
  "lab/probes/handoff-control/service-worker.ts",
];
const probeHash = createHash("sha256");
const hashPart = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  probeHash.update(length).update(bytes);
};
hashPart("oxrail-handoff-probe-source-binding-v1");
for (const filename of probeSources) {
  hashPart(filename);
  hashPart(await readFile(filename));
}
const probeBuildHash = probeHash.digest("hex");

const result = await build({
  entryPoints: {
    "verify-evidence": "lab/evidence/src/verify-cli.ts",
    "release-gate": "lab/evidence/src/release-gate-cli.ts",
    pilot: "lab/evidence/src/pilot-cli.ts",
  },
  outdir: outputRoot,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
  metafile: true,
});

await build({
  entryPoints: ["lab/probes/handoff-control/service-worker.ts"],
  outfile: `${outputRoot}/handoff-control/service-worker.js`,
  bundle: true,
  define: {
    __OXRAIL_HANDOFF_PROBE_BUILD_HASH__: JSON.stringify(probeBuildHash),
  },
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  legalComments: "none",
});
await copyFile(
  "lab/probes/handoff-control/manifest.json",
  `${outputRoot}/handoff-control/manifest.json`,
);
await writeFile(
  `${outputRoot}/handoff-control/build-evidence.json`,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceBindingSha256: probeBuildHash,
      manifestSha256: createHash("sha256")
        .update(await readFile(`${outputRoot}/handoff-control/manifest.json`))
        .digest("hex"),
      serviceWorkerSha256: createHash("sha256")
        .update(
          await readFile(`${outputRoot}/handoff-control/service-worker.js`),
        )
        .digest("hex"),
    },
    null,
    2,
  )}\n`,
);
await writeFile(
  `${outputRoot}/lab-dependencies.json`,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      build: "lab",
      inputs: Object.keys(result.metafile.inputs).sort(),
      outputs: Object.keys(result.metafile.outputs).sort(),
    },
    null,
    2,
  )}\n`,
);
