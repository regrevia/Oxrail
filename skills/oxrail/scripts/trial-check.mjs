import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(scriptRoot, "../../..");
const run = (script, args = []) =>
  spawnSync(process.execPath, [path.join(pluginRoot, script), ...args], {
    cwd: pluginRoot,
    encoding: "utf8",
  });

const integrity = run("skills/oxrail/scripts/verify-install.mjs");
if (integrity.status !== 0) {
  process.stderr.write(integrity.stderr || integrity.stdout);
  process.exit(1);
}

const doctor = run("dist/doctor.mjs", ["--json"]);
if (doctor.status !== 0) {
  process.stderr.write(doctor.stderr || doctor.stdout);
  process.exit(1);
}

const integrityReport = JSON.parse(integrity.stdout);
const doctorReport = JSON.parse(doctor.stdout);
const readiness =
  doctorReport.stage === "VERIFIED"
    ? "PASSIVE_ROUTE_OBSERVED"
    : doctorReport.stage === "CONFIGURED"
      ? "READY_AWAITING_NATIVE_CALL"
      : "HOST_SETUP_REQUIRED";

console.log(
  JSON.stringify(
    {
      schemaVersion: 1,
      product: "oxrail",
      version: integrityReport.version,
      artifactIntegrity: integrityReport.artifactIntegrity,
      stage: doctorReport.stage,
      readiness,
      hookDefinitionHash: doctorReport.hookDefinitionHash,
      optimization: doctorReport.optimization,
      resultingMode: doctorReport.resultingMode,
      safetyProtection: doctorReport.safetyProtectionActive
        ? "ACTIVE"
        : "INACTIVE",
      handoffProtection: doctorReport.handoffProtectionActive
        ? "ACTIVE"
        : "INACTIVE",
      credentialProtection: doctorReport.credentialProtectionActive
        ? "ACTIVE"
        : "INACTIVE",
      notices: doctorReport.notices,
    },
    null,
    2,
  ),
);
