import { preparePilot, recordPilotReceipt } from "./pilot.js";

const args = process.argv.slice(2).filter((argument) => argument !== "--");
const command = args.shift();

function flags(allowed: readonly string[]): Map<string, string> {
  const parsed = new Map<string, string>();
  while (args.length > 0) {
    const flag = args.shift();
    const value = args.shift();
    if (!flag || !allowed.includes(flag) || value === undefined) {
      throw new Error(`invalid pilot argument: ${flag ?? "missing"}`);
    }
    parsed.set(flag, value);
  }
  return parsed;
}

const required = (values: Map<string, string>, flag: string): string => {
  const value = values.get(flag);
  if (!value) throw new Error(`missing ${flag}`);
  return value;
};

try {
  if (command === "prepare") {
    const values = flags([
      "--commit",
      "--manifest",
      "--output",
      "--run-id",
      "--seed",
    ]);
    const seed = values.get("--seed");
    const result = await preparePilot({
      alphaCommit: required(values, "--commit"),
      manifestPath:
        values.get("--manifest") ?? "benchmarks/manifests/v0.1-luna-pilot.json",
      outputDirectory: required(values, "--output"),
      runId: required(values, "--run-id"),
      ...(seed ? { seed } : {}),
    });
    process.stdout.write(
      `${JSON.stringify({ command: "prepare", browser_actions: 0, ...result }, null, 2)}\n`,
    );
  } else if (command === "record") {
    const values = flags([
      "--input",
      "--output",
      "--reset-receipt",
      "--runner-input",
    ]);
    const receipt = await recordPilotReceipt({
      inputPath: required(values, "--input"),
      outputPath: required(values, "--output"),
      resetReceiptPath: required(values, "--reset-receipt"),
      runnerInputPath: required(values, "--runner-input"),
    });
    process.stdout.write(
      `${JSON.stringify({ command: "record", browser_actions: 0, arm_id: receipt.arm_id, status: receipt.status }, null, 2)}\n`,
    );
  } else {
    throw new Error(
      "usage: pilot prepare --commit <40hex> --run-id <id> --output <dir> [--seed <seed>] | pilot record --input <json> --runner-input <json> --reset-receipt <json> --output <json>",
    );
  }
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`Oxrail pilot: ${message}\n`);
  process.exitCode = 1;
}
