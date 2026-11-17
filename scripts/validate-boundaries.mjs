import { readFile } from "node:fs/promises";

const manifest = JSON.parse(
  await readFile("dist/product-dependencies.json", "utf8"),
);
const forbidden = [
  "lab/",
  "benchmarks/",
  "lab/evidence/",
  "packages/native-fidelity/",
];
const violations = manifest.inputs.filter((input) =>
  forbidden.some((prefix) => input.startsWith(prefix)),
);
if (violations.length > 0) {
  console.error(
    `product dependency boundary violation:\n${violations.join("\n")}`,
  );
  process.exit(1);
}
console.log("product dependency boundaries: ok");

const labManifest = JSON.parse(
  await readFile("lab/dist/lab-dependencies.json", "utf8"),
);
const forbiddenMonitorInputs = [
  "hooks/",
  "packages/core/",
  "packages/host-openai/",
  "packages/handoff-extension/",
];
const monitorViolations = labManifest.monitorInputs.filter((input) =>
  forbiddenMonitorInputs.some((prefix) => input.startsWith(prefix)),
);
if (monitorViolations.length > 0) {
  console.error(
    `Lab monitor dependency boundary violation:\n${monitorViolations.join("\n")}`,
  );
  process.exit(1);
}
console.log("Lab monitor dependency boundaries: ok");

const hostHookViolations = labManifest.hostHookInputs.filter((input) =>
  forbiddenMonitorInputs.some((prefix) => input.startsWith(prefix)),
);
if (hostHookViolations.length > 0) {
  console.error(
    `Lab Host Hook dependency boundary violation:\n${hostHookViolations.join("\n")}`,
  );
  process.exit(1);
}
console.log("Lab Host Hook dependency boundaries: ok");
