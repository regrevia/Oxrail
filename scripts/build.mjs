import { mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

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

const generated = spawnSync(process.execPath, ["dist/generate-schemas.mjs"], {
  stdio: "inherit",
});
if (generated.status !== 0) process.exit(generated.status ?? 1);
await rm("dist/generate-schemas.mjs", { force: true });
