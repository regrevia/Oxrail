import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const handoffProbeSources = [
  "package.json",
  "pnpm-lock.yaml",
  "scripts/build.mjs",
  "packages/handoff-extension/chrome/manifest.json",
  "packages/handoff-extension/src/presenter.ts",
  "packages/handoff-extension/src/probe.ts",
  "packages/handoff-extension/src/service-worker.ts",
];
const handoffProbeHash = createHash("sha256");
const hashPart = (value) => {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  handoffProbeHash.update(length).update(bytes);
};
hashPart("oxrail-handoff-probe-source-binding-v1");
for (const filename of handoffProbeSources) {
  hashPart(filename);
  hashPart(await readFile(filename));
}
const handoffProbeBuildHash = handoffProbeHash.digest("hex");

await build({
  entryPoints: {
    bootstrap: "packages/host-openai/src/bootstrap-cli.ts",
    "hooks/pre-tool": "hooks/pre-tool.ts",
    "hooks/post-tool": "hooks/post-tool.ts",
    doctor: "packages/host-openai/src/doctor-cli.ts",
    "verify-evidence": "packages/evidence/src/verify-cli.ts",
    "release-gate": "packages/evidence/src/release-gate-cli.ts",
    pilot: "packages/evidence/src/pilot-cli.ts",
    "generate-schemas": "packages/protocol/src/generate.ts",
  },
  outdir: "dist",
  outExtension: { ".js": ".mjs" },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
  legalComments: "none",
});

await build({
  entryPoints: ["packages/handoff-extension/src/service-worker.ts"],
  outfile: "dist/handoff-control/service-worker.js",
  bundle: true,
  define: {
    __OXRAIL_HANDOFF_PROBE_BUILD_HASH__: JSON.stringify(handoffProbeBuildHash),
  },
  format: "esm",
  platform: "browser",
  target: "chrome120",
  sourcemap: false,
  legalComments: "none",
});
await copyFile(
  "packages/handoff-extension/chrome/manifest.json",
  "dist/handoff-control/manifest.json",
);
await writeFile(
  "dist/handoff-control/build-evidence.json",
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceBindingSha256: handoffProbeBuildHash,
      manifestSha256: createHash("sha256")
        .update(await readFile("dist/handoff-control/manifest.json"))
        .digest("hex"),
      serviceWorkerSha256: createHash("sha256")
        .update(await readFile("dist/handoff-control/service-worker.js"))
        .digest("hex"),
    },
    null,
    2,
  )}\n`,
);

const generated = spawnSync(process.execPath, ["dist/generate-schemas.mjs"], {
  stdio: "inherit",
});
if (generated.status !== 0) process.exit(generated.status ?? 1);
await rm("dist/generate-schemas.mjs", { force: true });
