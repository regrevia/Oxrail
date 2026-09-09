import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

const result = await build({
  entryPoints: {
    bootstrap: "packages/host-openai/src/bootstrap-cli.ts",
    "hooks/pre-tool": "hooks/pre-tool.ts",
    "hooks/post-tool": "hooks/post-tool.ts",
    doctor: "packages/host-openai/src/doctor-cli.ts",
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
  metafile: true,
});

await writeFile(
  "dist/product-dependencies.json",
  `${JSON.stringify(
    {
      schemaVersion: 1,
      build: "product",
      inputs: Object.keys(result.metafile.inputs).sort(),
      outputs: Object.keys(result.metafile.outputs).sort(),
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
