import { relative } from "node:path";

import { selectAcceptedReleaseManifest } from "./gate.js";

const reportOnly = process.argv.includes("--report-only");
const manifestArgument = process.argv.findIndex(
  (argument) => argument === "--manifest",
);
const explicitPath =
  manifestArgument >= 0 ? process.argv[manifestArgument + 1] : undefined;

try {
  if (manifestArgument >= 0 && !explicitPath) {
    throw new Error("--manifest requires an evidence manifest path");
  }
  const selected = await selectAcceptedReleaseManifest(
    process.cwd(),
    explicitPath,
  );
  const { manifest } = selected;
  console.log(
    JSON.stringify(
      {
        milestone: "V0.1",
        passed: true,
        status: manifest.status,
        manifest: relative(process.cwd(), selected.path),
        blockers: manifest.blockers,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        milestone: "V0.1",
        passed: false,
        error: error instanceof Error ? error.message : String(error),
      },
      null,
      2,
    ),
  );
  if (!reportOnly) process.exitCode = 1;
}
