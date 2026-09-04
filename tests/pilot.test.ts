import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createResetReceipt } from "../benchmarks/harness/server.mjs";
import {
  preparePilot,
  recordPilotReceipt,
  type PilotRunnerInput,
} from "../packages/evidence/src/pilot.js";

const temporaryDirectories: string[] = [];
const manifestPath = "benchmarks/manifests/v0.1-luna-pilot.json";

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "oxrail-pilot-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Luna pilot preparation and recording", () => {
  it("freezes the fixed paired plan without running a browser", async () => {
    const firstDirectory = await temporaryDirectory();
    const secondDirectory = await temporaryDirectory();
    const options = {
      alphaCommit: "a".repeat(40),
      manifestPath,
      runId: "pilot-test-1",
    };
    const first = await preparePilot({
      ...options,
      outputDirectory: firstDirectory,
    });
    const second = await preparePilot({
      ...options,
      outputDirectory: secondDirectory,
    });
    const preregistration = JSON.parse(
      await readFile(first.preregistrationPath, "utf8"),
    );
    const ledger = JSON.parse(await readFile(first.ledgerPath, "utf8"));

    expect(preregistration.default_task_order).toEqual([
      "P0-LUNA-001",
      "P0-LUNA-004",
      "P0-LUNA-002",
      "P0-LUNA-003",
    ]);
    expect(preregistration.browser_execution).toBe("NONE_BY_PREPARE_OR_RECORD");
    expect(first.runnerInputPaths).toHaveLength(16);
    expect(ledger.entries).toHaveLength(16);
    expect(
      ledger.entries.every(
        ({ status }: { status: string }) => status === "NOT_RUN",
      ),
    ).toBe(true);
    expect(
      ledger.entries
        .slice(0, 8)
        .map(({ task_id }: { task_id: string }) => task_id),
    ).toEqual([
      "P0-LUNA-001",
      "P0-LUNA-001",
      "P0-LUNA-004",
      "P0-LUNA-004",
      "P0-LUNA-002",
      "P0-LUNA-002",
      "P0-LUNA-003",
      "P0-LUNA-003",
    ]);
    expect(await readFile(first.preregistrationPath, "utf8")).toBe(
      await readFile(second.preregistrationPath, "utf8"),
    );
    expect(await readFile(first.ledgerPath, "utf8")).toBe(
      await readFile(second.ledgerPath, "utf8"),
    );
    const firstRunner = JSON.parse(
      await readFile(first.runnerInputPaths[0]!, "utf8"),
    );
    const firstReserve = JSON.parse(
      await readFile(first.runnerInputPaths[8]!, "utf8"),
    );
    expect(firstRunner.activation).toBe("DEFAULT");
    expect(firstReserve.activation).toBe("RESERVE_REQUIRES_GATE");
    expect(firstRunner.model_settings).toEqual({
      browser_control: "ENABLED",
      model_id: "gpt-5.6-luna",
      reasoning_effort: "medium",
      site_tools_webmcp: "UNAVAILABLE_BY_MODEL_CONTRACT",
    });
    expect(preregistration.model_settings_hash).toBe(
      firstRunner.model_settings_hash,
    );
  });

  it("validates bindings and atomically records one sanitized arm receipt", async () => {
    const directory = await temporaryDirectory();
    const prepared = await preparePilot({
      alphaCommit: "b".repeat(40),
      manifestPath,
      outputDirectory: path.join(directory, "plan"),
      runId: "pilot-test-2",
    });
    const runnerInputPath = prepared.runnerInputPaths[0]!;
    const runner = JSON.parse(
      await readFile(runnerInputPath, "utf8"),
    ) as PilotRunnerInput;
    const reset = await createResetReceipt({
      run_id: runner.run_id,
      arm_id: runner.arm_id,
      task_id: runner.task_id,
      seed: runner.seed,
    });
    const resetReceiptPath = path.join(directory, "reset.json");
    const inputPath = path.join(directory, "receipt-input.json");
    const outputPath = path.join(directory, "receipt.json");
    await writeFile(resetReceiptPath, `${JSON.stringify(reset)}\n`);
    const receiptInput = {
      schema_version: 1,
      run_id: runner.run_id,
      task_id: runner.task_id,
      pair_id: runner.pair_id,
      arm_id: runner.arm_id,
      model_id: runner.model_id,
      variant: runner.variant,
      runner_id: "1".repeat(64),
      context_isolation_id: "2".repeat(64),
      host_profile_id: "local-test-profile",
      hook_definition_hash: "3".repeat(64),
      model_settings_hash: runner.model_settings_hash,
      control_hash: "5".repeat(64),
      started_at: "2026-09-04T10:00:00.000Z",
      finished_at: "2026-09-04T10:00:01.000Z",
      status: "PASSED",
      status_code: "OK",
      postcondition: "PASSED",
      forbidden_side_effects_observed: [],
      original_input_hash: "6".repeat(64),
      forwarded_input_hash: "6".repeat(64),
      native_result_hash: "7".repeat(64),
      browser_invocations: 1,
      duration_ms: 1000,
    };
    await writeFile(inputPath, `${JSON.stringify(receiptInput)}\n`);

    const forgedInputPath = path.join(directory, "forged-input.json");
    await writeFile(
      forgedInputPath,
      `${JSON.stringify({
        ...receiptInput,
        model_settings_hash: "9".repeat(64),
      })}\n`,
    );
    await expect(
      recordPilotReceipt({
        inputPath: forgedInputPath,
        outputPath: path.join(directory, "forged-receipt.json"),
        resetReceiptPath,
        runnerInputPath,
      }),
    ).rejects.toThrow("does not match frozen runner settings");

    const unavailableInputPath = path.join(directory, "unavailable-input.json");
    await writeFile(
      unavailableInputPath,
      `${JSON.stringify({
        ...receiptInput,
        model_settings_hash: null,
        status: "BLOCKED",
        status_code: "MODEL_SETTINGS_UNAVAILABLE",
        postcondition: "UNKNOWN",
        original_input_hash: null,
        forwarded_input_hash: null,
        native_result_hash: null,
        browser_invocations: 0,
      })}\n`,
    );
    expect(
      await recordPilotReceipt({
        inputPath: unavailableInputPath,
        outputPath: path.join(directory, "unavailable-receipt.json"),
        resetReceiptPath,
        runnerInputPath,
      }),
    ).toMatchObject({
      status: "BLOCKED",
      status_code: "MODEL_SETTINGS_UNAVAILABLE",
      model_settings_hash: null,
      browser_invocations: 0,
    });

    const receipt = await recordPilotReceipt({
      inputPath,
      outputPath,
      resetReceiptPath,
      runnerInputPath,
    });
    const written = await readFile(outputPath, "utf8");
    expect(receipt.reset_receipt_id).toBe(reset.receipt_id);
    expect(receipt.task_manifest_hash).toBe(runner.task_manifest_hash);
    expect(written).not.toContain("password");
    await expect(
      recordPilotReceipt({
        inputPath,
        outputPath,
        resetReceiptPath,
        runnerInputPath,
      }),
    ).rejects.toThrow("already exists");
  });
});
