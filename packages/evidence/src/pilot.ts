import { createHash } from "node:crypto";
import { access, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import {
  pairedSchedule,
  fingerprint,
} from "../../../benchmarks/harness/paired.mjs";
import { sanitizedJson } from "./sanitize.js";
import { atomicWriteSanitizedJson } from "./writer.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9._-]+$/);
const text = z.string().min(1).max(2_000);
const statusCode = z.enum([
  "OK",
  "POSTCONDITION_FAILED",
  "FORBIDDEN_SIDE_EFFECT",
  "TIMEOUT",
  "HOST_UNAVAILABLE",
  "RUNNER_ISOLATION_UNPROVEN",
  "GUARD_ADAPTER_UNAVAILABLE",
  "MODEL_SETTINGS_UNAVAILABLE",
  "OTHER_BLOCKER",
]);

export const LUNA_PILOT_TASK_ORDER = [
  "P0-LUNA-001",
  "P0-LUNA-004",
  "P0-LUNA-002",
  "P0-LUNA-003",
  "P0-LUNA-R01",
  "P0-LUNA-R02",
  "P0-LUNA-R03",
  "P0-LUNA-R04",
] as const;

const postconditionSchema = z.strictObject({
  description: text,
  observations: z.array(identifier).min(1),
});

const modelSettingsSchema = z.strictObject({
  model_id: z.literal("gpt-5.6-luna"),
  reasoning_effort: z.literal("medium"),
  site_tools_webmcp: z.literal("UNAVAILABLE_BY_MODEL_CONTRACT"),
  browser_control: z.literal("ENABLED"),
});

const pilotTaskSchema = z.strictObject({
  id: z.enum(LUNA_PILOT_TASK_ORDER),
  tier: z.enum(["default", "reserve"]),
  prompt: text,
  start_url: z.string().url(),
  setup: z.array(text).min(1),
  postcondition: postconditionSchema,
  forbidden_side_effects: z.array(identifier).min(1),
  timeout_ms: z.number().int().positive().max(600_000),
  risk: z.literal("CONTROLLED_LOW"),
});

export const LunaPilotManifestSchema = z
  .strictObject({
    schema_version: z.literal(1),
    manifest_id: z.literal("v0.1-luna-pilot"),
    model_id: z.literal("gpt-5.6-luna"),
    model_settings: modelSettingsSchema,
    seed_contract: z.strictObject({
      algorithm: z.literal("paired-schedule-sha256-v1"),
      default_seed: identifier,
      scope: z.literal("variant-direction-only"),
      task_order: z.tuple([
        z.literal("P0-LUNA-001"),
        z.literal("P0-LUNA-004"),
        z.literal("P0-LUNA-002"),
        z.literal("P0-LUNA-003"),
        z.literal("P0-LUNA-R01"),
        z.literal("P0-LUNA-R02"),
        z.literal("P0-LUNA-R03"),
        z.literal("P0-LUNA-R04"),
      ]),
      per_task_domain: z.literal("<pilot-seed>\\0<task-id>"),
    }),
    tasks: z.array(pilotTaskSchema).length(LUNA_PILOT_TASK_ORDER.length),
  })
  .superRefine((manifest, context) => {
    for (const [index, expectedId] of LUNA_PILOT_TASK_ORDER.entries()) {
      const task = manifest.tasks[index];
      if (task?.id !== expectedId) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "id"],
          message: `expected fixed task order ${expectedId}`,
        });
      }
      const expectedTier = index < 4 ? "default" : "reserve";
      if (task?.tier !== expectedTier) {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "tier"],
          message: `expected ${expectedTier} task`,
        });
      }
      if (task && new URL(task.start_url).origin !== "http://127.0.0.1:4173") {
        context.addIssue({
          code: "custom",
          path: ["tasks", index, "start_url"],
          message: "pilot tasks must use the controlled local fixture",
        });
      }
    }
  });

export type LunaPilotManifest = z.infer<typeof LunaPilotManifestSchema>;
type Variant = "NATIVE_TUNED" | "OXRAIL_GUARD";

const runnerInputSchema = z.strictObject({
  schema_version: z.literal(1),
  run_id: identifier,
  alpha_commit: z.string().regex(/^[a-f0-9]{40}$/),
  manifest_id: z.literal("v0.1-luna-pilot"),
  task_manifest_hash: hash,
  model_id: z.literal("gpt-5.6-luna"),
  model_settings: modelSettingsSchema,
  model_settings_hash: hash,
  task_id: z.enum(LUNA_PILOT_TASK_ORDER),
  pair_id: identifier,
  arm_id: identifier,
  run_index: z.literal(1),
  seed: identifier,
  variant: z.enum(["NATIVE_TUNED", "OXRAIL_GUARD"]),
  status: z.literal("NOT_RUN"),
  prompt: text,
  start_url: z.string().url(),
  setup: z.array(text).min(1),
  postcondition: postconditionSchema,
  forbidden_side_effects: z.array(identifier).min(1),
  timeout_ms: z.number().int().positive(),
  risk: z.literal("CONTROLLED_LOW"),
  activation: z.enum(["DEFAULT", "RESERVE_REQUIRES_GATE"]),
  browser_execution: z.literal("RUNNER_ONLY"),
});
export type PilotRunnerInput = z.infer<typeof runnerInputSchema>;

const resetReceiptSchema = z.strictObject({
  schema_version: z.literal(1),
  receipt_id: hash,
  run_id: identifier,
  arm_id: identifier,
  task_id: z.enum(LUNA_PILOT_TASK_ORDER),
  seed: identifier,
  fixture_sha256: hash,
  initial_state_hash: hash,
  initial_state: z.record(
    identifier,
    z.union([z.string(), z.number().finite(), z.boolean()]),
  ),
  reset_url: z.string().url(),
});

const receiptInputSchema = z
  .strictObject({
    schema_version: z.literal(1),
    run_id: identifier,
    task_id: z.enum(LUNA_PILOT_TASK_ORDER),
    pair_id: identifier,
    arm_id: identifier,
    model_id: z.literal("gpt-5.6-luna"),
    variant: z.enum(["NATIVE_TUNED", "OXRAIL_GUARD"]),
    runner_id: hash,
    context_isolation_id: hash,
    host_profile_id: identifier,
    hook_definition_hash: hash,
    model_settings_hash: hash.nullable(),
    control_hash: hash,
    started_at: z.string().datetime(),
    finished_at: z.string().datetime(),
    status: z.enum(["PASSED", "FAILED", "BLOCKED", "TIMED_OUT"]),
    status_code: statusCode,
    postcondition: z.enum(["PASSED", "FAILED", "UNKNOWN"]),
    forbidden_side_effects_observed: z.array(identifier),
    original_input_hash: hash.nullable(),
    forwarded_input_hash: hash.nullable(),
    native_result_hash: hash.nullable(),
    browser_invocations: z.number().int().nonnegative(),
    duration_ms: z.number().finite().nonnegative(),
  })
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.finished_at) < Date.parse(receipt.started_at)) {
      context.addIssue({
        code: "custom",
        path: ["finished_at"],
        message: "finished_at precedes started_at",
      });
    }
    if (
      receipt.status === "PASSED" &&
      (receipt.status_code !== "OK" ||
        receipt.postcondition !== "PASSED" ||
        receipt.forbidden_side_effects_observed.length > 0 ||
        receipt.original_input_hash === null ||
        receipt.forwarded_input_hash === null ||
        receipt.native_result_hash === null)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "PASSED requires OK, a passed postcondition, no forbidden side effect, and all native hashes",
      });
    }
    if (receipt.status === "TIMED_OUT" && receipt.status_code !== "TIMEOUT") {
      context.addIssue({
        code: "custom",
        path: ["status_code"],
        message: "TIMED_OUT requires TIMEOUT",
      });
    }
    if (
      receipt.model_settings_hash === null &&
      !(
        receipt.status === "BLOCKED" &&
        receipt.status_code === "MODEL_SETTINGS_UNAVAILABLE" &&
        receipt.postcondition === "UNKNOWN" &&
        receipt.browser_invocations === 0
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["model_settings_hash"],
        message:
          "unavailable frozen model settings require a pre-browser BLOCKED receipt",
      });
    }
    if (
      receipt.status_code === "MODEL_SETTINGS_UNAVAILABLE" &&
      receipt.model_settings_hash !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["model_settings_hash"],
        message: "unavailable model settings cannot claim the frozen hash",
      });
    }
  });

const armReceiptSchema = receiptInputSchema.safeExtend({
  runner_input_hash: hash,
  reset_receipt_hash: hash,
  reset_receipt_id: hash,
  task_manifest_hash: hash,
});
export type PilotArmReceipt = z.infer<typeof armReceiptSchema>;

const sha256 = (contents: string | Buffer): string =>
  createHash("sha256").update(contents).digest("hex");

async function readJsonFile(file: string): Promise<{
  raw: Buffer;
  value: unknown;
}> {
  const raw = await readFile(file);
  return { raw, value: JSON.parse(raw.toString("utf8")) as unknown };
}

async function assertAbsent(files: readonly string[]): Promise<void> {
  for (const file of files) {
    const exists = await access(file).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`pilot artifact already exists: ${file}`);
  }
}

const formalVariants = (seed: string, taskId: string): Variant[] => {
  const item = pairedSchedule([taskId], `${seed}\0${taskId}`)[0];
  if (!item) throw new Error(`could not schedule ${taskId}`);
  return item.variants.map((variant) =>
    variant === "baseline" ? "NATIVE_TUNED" : "OXRAIL_GUARD",
  );
};

export interface PreparePilotOptions {
  alphaCommit: string;
  fixturePath?: string;
  manifestPath: string;
  outputDirectory: string;
  pairedHarnessPath?: string;
  runId: string;
  seed?: string;
}

export async function preparePilot(options: PreparePilotOptions): Promise<{
  ledgerPath: string;
  preregistrationPath: string;
  runnerInputPaths: string[];
}> {
  const runId = identifier.parse(options.runId);
  const alphaCommit = z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .parse(options.alphaCommit);
  const manifestFile = await readJsonFile(options.manifestPath);
  const manifest = LunaPilotManifestSchema.parse(manifestFile.value);
  const seed = identifier.parse(
    options.seed ?? manifest.seed_contract.default_seed,
  );
  const fixturePath =
    options.fixturePath ??
    "benchmarks/fixtures/interaction-primitives/index.html";
  const pairedHarnessPath =
    options.pairedHarnessPath ?? "benchmarks/harness/paired.mjs";
  const [fixture, pairedHarness] = await Promise.all([
    readFile(fixturePath),
    readFile(pairedHarnessPath),
  ]);
  const manifestHash = sha256(manifestFile.raw);
  const modelSettingsHash = fingerprint(manifest.model_settings);
  const plannedEntries: Array<Record<string, unknown>> = [];
  const runnerInputs: PilotRunnerInput[] = [];
  let planIndex = 0;

  for (const [taskIndex, task] of manifest.tasks.entries()) {
    const pairId = `${runId}-${task.id}-pair-1`;
    for (const variant of formalVariants(seed, task.id)) {
      planIndex += 1;
      const armId = `${runId}-${task.id}-${variant.toLowerCase()}`;
      const entry = {
        plan_index: planIndex,
        task_order: taskIndex + 1,
        task_id: task.id,
        tier: task.tier,
        pair_id: pairId,
        arm_id: armId,
        model_id: manifest.model_id,
        model_settings_hash: modelSettingsHash,
        variant,
        run_index: 1,
        seed,
        status: "NOT_RUN",
        status_code:
          task.tier === "default" ? "AWAITING_RUN" : "RESERVE_NOT_ACTIVATED",
      };
      plannedEntries.push(entry);
      runnerInputs.push(
        runnerInputSchema.parse({
          schema_version: 1,
          run_id: runId,
          alpha_commit: alphaCommit,
          manifest_id: manifest.manifest_id,
          task_manifest_hash: manifestHash,
          model_id: manifest.model_id,
          model_settings: manifest.model_settings,
          model_settings_hash: modelSettingsHash,
          task_id: task.id,
          pair_id: pairId,
          arm_id: armId,
          run_index: 1,
          seed,
          variant,
          status: "NOT_RUN",
          prompt: task.prompt,
          start_url: task.start_url,
          setup: task.setup,
          postcondition: task.postcondition,
          forbidden_side_effects: task.forbidden_side_effects,
          timeout_ms: task.timeout_ms,
          risk: task.risk,
          activation:
            task.tier === "default" ? "DEFAULT" : "RESERVE_REQUIRES_GATE",
          browser_execution: "RUNNER_ONLY",
        }),
      );
    }
  }

  const runnerDirectory = path.join(options.outputDirectory, "runner-inputs");
  const runnerInputPaths = runnerInputs.map((input, index) =>
    path.join(
      runnerDirectory,
      `${String(index + 1).padStart(2, "0")}-${input.task_id.toLowerCase()}-${input.variant.toLowerCase()}.json`,
    ),
  );
  const ledgerPath = path.join(options.outputDirectory, "planned-ledger.json");
  const preregistrationPath = path.join(
    options.outputDirectory,
    "preregistration.json",
  );
  await assertAbsent([preregistrationPath, ledgerPath, ...runnerInputPaths]);
  await mkdir(runnerDirectory, { recursive: true, mode: 0o700 });

  const runnerInputHashes = Object.fromEntries(
    runnerInputs.map((input, index) => [
      path
        .relative(options.outputDirectory, runnerInputPaths[index]!)
        .replaceAll("\\", "/"),
      sha256(sanitizedJson(input)),
    ]),
  );
  const preregistration = {
    schema_version: 1,
    run_id: runId,
    alpha_commit: alphaCommit,
    manifest_id: manifest.manifest_id,
    model_id: manifest.model_id,
    model_settings: manifest.model_settings,
    model_settings_hash: modelSettingsHash,
    pilot_seed: seed,
    seed_contract: manifest.seed_contract,
    source_hashes: {
      task_manifest: manifestHash,
      fixture: sha256(fixture),
      paired_harness: sha256(pairedHarness),
    },
    default_task_order: manifest.tasks
      .filter(({ tier }) => tier === "default")
      .map(({ id }) => id),
    reserve_task_order: manifest.tasks
      .filter(({ tier }) => tier === "reserve")
      .map(({ id }) => id),
    default_arm_count: 8,
    maximum_arm_count: 16,
    runner_input_count: 16,
    reserve_activation:
      "ONLY_AFTER_ALL_DEFAULT_ARMS_PASS_AND_PREREGISTERED_UNKNOWN_REMAINS",
    browser_execution: "NONE_BY_PREPARE_OR_RECORD",
    runner_input_hashes: runnerInputHashes,
  };
  const ledger = {
    schema_version: 1,
    run_id: runId,
    alpha_commit: alphaCommit,
    manifest_id: manifest.manifest_id,
    task_manifest_hash: manifestHash,
    model_id: manifest.model_id,
    planned_arm_count: plannedEntries.length,
    entries: plannedEntries,
  };

  for (const [index, input] of runnerInputs.entries()) {
    await atomicWriteSanitizedJson(runnerInputPaths[index]!, input);
  }
  await atomicWriteSanitizedJson(ledgerPath, ledger);
  await atomicWriteSanitizedJson(preregistrationPath, preregistration);
  return { ledgerPath, preregistrationPath, runnerInputPaths };
}

export interface RecordPilotOptions {
  inputPath: string;
  outputPath: string;
  resetReceiptPath: string;
  runnerInputPath: string;
}

export async function recordPilotReceipt(
  options: RecordPilotOptions,
): Promise<PilotArmReceipt> {
  const [inputFile, runnerFile, resetFile] = await Promise.all([
    readJsonFile(options.inputPath),
    readJsonFile(options.runnerInputPath),
    readJsonFile(options.resetReceiptPath),
  ]);
  const input = receiptInputSchema.parse(inputFile.value);
  const runner = runnerInputSchema.parse(runnerFile.value);
  const reset = resetReceiptSchema.parse(resetFile.value);
  if (runner.model_settings_hash !== fingerprint(runner.model_settings)) {
    throw new Error("runner input frozen model settings hash is invalid");
  }
  if (
    input.model_settings_hash !== null &&
    input.model_settings_hash !== runner.model_settings_hash
  ) {
    throw new Error(
      "receipt model settings hash does not match frozen runner settings",
    );
  }
  const expectedResetId = fingerprint({
    fixture_sha256: reset.fixture_sha256,
    initial_state_hash: reset.initial_state_hash,
    run_id: reset.run_id,
    arm_id: reset.arm_id,
    task_id: reset.task_id,
    seed: reset.seed,
  });
  if (
    reset.initial_state_hash !== fingerprint(reset.initial_state) ||
    reset.receipt_id !== expectedResetId ||
    new URL(reset.reset_url).searchParams.get("reset") !== reset.receipt_id
  ) {
    throw new Error("reset receipt integrity check failed");
  }
  for (const key of [
    "run_id",
    "task_id",
    "pair_id",
    "arm_id",
    "model_id",
    "variant",
  ] as const) {
    if (input[key] !== runner[key]) {
      throw new Error(`receipt does not match runner input: ${key}`);
    }
  }
  for (const key of ["run_id", "task_id", "arm_id", "seed"] as const) {
    if (reset[key] !== runner[key]) {
      throw new Error(`reset receipt does not match runner input: ${key}`);
    }
  }
  if (
    input.forbidden_side_effects_observed.some(
      (effect) => !runner.forbidden_side_effects.includes(effect),
    )
  ) {
    throw new Error("receipt names an undeclared forbidden side effect");
  }

  const receipt = armReceiptSchema.parse({
    ...input,
    runner_input_hash: sha256(runnerFile.raw),
    reset_receipt_hash: sha256(resetFile.raw),
    reset_receipt_id: reset.receipt_id,
    task_manifest_hash: runner.task_manifest_hash,
  });
  await assertAbsent([options.outputPath]);
  await atomicWriteSanitizedJson(options.outputPath, receipt);
  return receipt;
}
