import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  selectAcceptedReleaseManifest,
  validateEvidenceManifestFile,
} from "../packages/evidence/src/index.js";
import {
  EvidenceManifestSchema,
  toolRegistryManifestBinding,
} from "../packages/protocol/src/index.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");

const blocked = {
  work_package: "WP-RLS-010",
  status: "BLOCKED",
  commit: "WORKTREE",
  spec_version: "0.5.0",
  environment: {},
  schema_hashes: {},
  host_profiles: [],
  commands: [],
  test_results: [],
  reviewers: [],
  sha256_manifest: null,
  accepted_at: null,
  blockers: ["real-host evidence unavailable"],
  dependency_manifests: [],
  experiment_protocol: {
    runner_isolation: "ISOLATED_SUBAGENT_PER_ARM",
    coordinator_result_sharing: "NONE_BEFORE_PAIR_COMPLETE",
  },
} as const;

describe("evidence release gate", () => {
  it("enforces BLOCKED/ACCEPTED completeness and safe artifact paths", () => {
    expect(
      EvidenceManifestSchema.safeParse({ ...blocked, blockers: [] }).success,
    ).toBe(false);
    expect(
      EvidenceManifestSchema.safeParse({
        ...blocked,
        status: "ACCEPTED",
        blockers: [],
      }).success,
    ).toBe(false);
    expect(
      EvidenceManifestSchema.safeParse({
        ...blocked,
        host_profiles: ["../host-profile.json"],
      }).success,
    ).toBe(false);
  });

  it("verifies the full release matrix and rejects a single trace", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "oxrail-gate-"));
    const runRoot = join(repositoryRoot, "evidence/WP-RLS-010/run");
    await mkdir(runRoot, { recursive: true });
    const runGit = (...args: string[]) => {
      const result = spawnSync("git", args, {
        cwd: repositoryRoot,
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    runGit("init", "-q");
    runGit("config", "user.email", "gate@example.test");
    runGit("config", "user.name", "Gate Test");
    const hookDefinition = '{"hooks":{}}\n';
    const schemaContents = "{}\n";
    await mkdir(join(repositoryRoot, "hooks"), { recursive: true });
    await mkdir(join(repositoryRoot, "packages/protocol/schemas"), {
      recursive: true,
    });
    await writeFile(join(repositoryRoot, "hooks/hooks.json"), hookDefinition);
    for (const schema of [
      "evidence-manifest.schema.json",
      "evidence-trace.schema.json",
      "host-profile.schema.json",
    ]) {
      await writeFile(
        join(repositoryRoot, "packages/protocol/schemas", schema),
        schemaContents,
      );
    }
    await writeFile(join(repositoryRoot, "implementation.txt"), "tested\n");
    runGit("add", ".");
    runGit("commit", "-qm", "implementation");
    const commit = runGit("rev-parse", "HEAD");

    const profile = {
      schemaVersion: 5,
      profileId: "hp_gate",
      setup: {
        lifecycle: "VERIFIED",
        pluginInstalled: "passed",
        skillAvailable: "passed",
        hooksRegistered: "passed",
        hooksTrusted: "passed",
        preToolUseAvailable: "passed",
        postToolUseAvailable: "passed",
        chromeComputerUseDetectable: "passed",
        matcherProfileValid: "passed",
        syntheticProbe: "passed",
        firstBrowserHookSeen: false,
        verificationSource: "synthetic-probe",
        optimization: "ACTIVE",
      },
      identity: {
        surface: "codex-desktop",
        hostBuild: "fixture",
        computerUsePluginVersion: "fixture",
        browserPath: "chrome-extension",
        os: "linux",
      },
      route: {
        toolRoute: "direct-mcp",
        canonicalToolMatchers: ["browser.fixture"],
        matcherEvidenceHash: "a".repeat(64),
        toolSchemaRegistryHash: "e".repeat(64),
        toolSchemaRegistryEvidenceId: "EVID-HOST-TOOL-SCHEMA-FIXTURE",
        browserTools: [
          {
            canonicalToolName: "browser.fixture",
            inputSchemaHash: "f".repeat(64),
            registryManifestBinding: toolRegistryManifestBinding({
              profileId: "hp_gate",
              definitionHash: sha(hookDefinition),
              matcherEvidenceHash: "a".repeat(64),
              toolSchemaRegistryHash: "e".repeat(64),
              toolSchemaRegistryEvidenceId: "EVID-HOST-TOOL-SCHEMA-FIXTURE",
              canonicalToolName: "browser.fixture",
              inputSchemaHash: "f".repeat(64),
            }),
          },
        ],
      },
      action: {
        control: "MICRO_ACTION",
        preToolCoverage: {
          observed: 1,
          expected: 1,
          bypassCases: [],
          confidence: "PROVEN",
        },
        denyPreventedSideEffect: true,
        rewriteFidelity: "unsupported",
      },
      nativeInteraction: {
        fidelity: "PROVEN_PASS_THROUGH",
        pointerOwnerInRunning: "NATIVE",
        passThroughFingerprint: "passed",
        primitiveParity: Object.fromEntries(
          [
            "move_click",
            "double_click",
            "hover",
            "scroll_vertical",
            "scroll_horizontal",
            "drag_slider",
            "drag_drop",
            "typing",
            "keyboard_shortcut",
            "focus_switch",
            "dropdown_combobox",
            "iframe",
            "canvas_target",
            "rerender_after_click",
            "new_tab",
            "modal",
            "handoff_resume",
          ].map((name) => [name, "passed"]),
        ),
        cursorVisualization: "passed",
        viewportCoordinateMapping: "passed",
        screenshotFrameFeedback: "passed",
        unexpectedPointerInterference: 0,
        unexpectedFocusInterference: 0,
        unexpectedScrollInterference: 0,
        incorrectNormalActionBlocks: 0,
        overlayPolicy: "NONE",
      },
      result: {
        postToolCoverage: {
          observed: 1,
          expected: 1,
          bypassCases: [],
          confidence: "PROVEN",
        },
        control: "OBSERVE_ONLY",
        replacementTiming: "model-visible-only",
        media: {
          text: "passed",
          structured: "passed",
          image: "passed",
          error: "passed",
          attachment: "passed",
        },
        codeModePromiseSemantics: "passed",
        controlCriticalContract: {
          status: "passed",
          matrixHash: "b".repeat(64),
          requiredFields: [],
          conditionalFields: [],
          unknownFields: [],
          testedNextStepPrimitives: [],
        },
        rawPersistence: ["none-observed"],
      },
      hooks: {
        policy: "plugin",
        trustState: "active",
        definitionHash: sha(hookDefinition),
        concurrentConflictProbe: "passed",
      },
      nativeCapabilities: {
        outputTokenLimit: "passed",
        webMcp: "unknown",
        structuredObservation: "unknown",
        readOnlyDeveloperTools: "unknown",
        nativeApprovalFlow: "passed",
      },
      handoff: {
        activation: "INACTIVE",
        inactiveReasons: ["not in v0.1"],
        capability: {
          surface: "NONE",
          lease: "NONE",
          resume: "NONE",
          conversationContextPreserved: false,
          sameTabBinding: false,
          originalPlacementRestorable: false,
        },
        conversationContinuity: "unknown",
        sameTabBinding: "unknown",
        detachRealTabWindow: "unknown",
        focusExistingTab: "unknown",
        exclusiveBrowserLease: "unknown",
        noAgentObservationDuringLease: "unknown",
        nonSecretCompletionDetector: "unknown",
        originAndStateVerification: "unknown",
        restoreOriginalWindowIndex: "unknown",
        restorePinnedAndGroupState: "unknown",
        automaticToolOrEventResume: "unknown",
        oneClickFallback: "unknown",
        chatMessageRequired: "unknown",
      },
      credentialChannel: {
        activation: "INACTIVE",
        inactiveReasons: ["unsupported on this host"],
        capability: {
          platform: "unsupported",
          surface: "NONE",
          storage: "NONE",
          acceptedKinds: [],
          consumerMode: "NONE",
          consumerReadiness: "UNSUPPORTED",
          opaqueReferenceOnly: false,
          genericSecretExport: "DENIED",
        },
      },
      evidence: {
        probeSuiteVersion: "fixture",
        fixtureRevision: "fixture",
        traceManifestHash: "d".repeat(64),
        testedAt: "2026-09-04T00:00:00.000Z",
        validUntilHostChange: true,
        unresolved: [],
      },
      derived: {
        mode: "MICRO_ACTION_GUARD",
        safety: "ACTIVE",
        handoff: "INACTIVE",
        credentialProtection: "INACTIVE",
        allowedClaims: ["guard"],
        forbiddenClaims: ["handoff"],
      },
    };
    const suites = {
      HOST_REALITY: Array.from({ length: 7 }, (_, index) => `HR-${index + 39}`),
      NATIVE_INTERACTION: Array.from(
        { length: 23 },
        (_, index) => `TEST-NIF-${String(index + 1).padStart(3, "0")}`,
      ),
      OXRAIL: Array.from(
        { length: 30 },
        (_, index) => `oxrail-${String(index + 1).padStart(3, "0")}`,
      ),
      STALL: Array.from(
        { length: 10 },
        (_, index) => `stall-${String(index + 1).padStart(3, "0")}`,
      ),
      SECRET_LEAK: ["secret-smoke-001"],
    } as const;
    const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"] as const;
    const artifacts: Record<string, string> = {};
    const resultReferences: string[] = [];
    for (const [suite, testIds] of Object.entries(suites)) {
      for (const testId of testIds) {
        const suiteModels =
          suite === "HOST_REALITY" ? ["host-profile"] : models;
        const runCount =
          suite === "HOST_REALITY" || suite === "SECRET_LEAK" ? 1 : 5;
        for (const modelId of suiteModels) {
          for (let runIndex = 1; runIndex <= runCount; runIndex += 1) {
            const pairId = `${suite}-${testId}-${modelId}-${runIndex}`;
            const variants =
              suite === "HOST_REALITY"
                ? (["OXRAIL_GUARD"] as const)
                : (["NATIVE_TUNED", "OXRAIL_GUARD"] as const);
            for (const variant of variants) {
              const reference = `traces/${pairId}-${variant}.json`;
              resultReferences.push(reference);
              artifacts[reference] = `${JSON.stringify({
                schema_version: 4,
                run_id: `${pairId}-${variant}`,
                task_id: testId,
                suite,
                test_id: testId,
                model_id: modelId,
                variant,
                pair_id: pairId,
                run_index: runIndex,
                seed: `seed-${runIndex}`,
                control_hash: sha(`${suite}-${testId}-control`),
                model_settings_hash: sha(`${modelId}-settings`),
                context_isolation_id: sha(`${pairId}-${variant}-context`),
                runner_id: sha(`${pairId}-${variant}-runner`),
                spec_version: "0.5.0",
                work_package_ids: ["WP-RLS-010"],
                host_profile_id: "hp_gate",
                host: {
                  surface: "codex-desktop",
                  build: "fixture",
                  computer_use_plugin: "fixture",
                  browser_path: "chrome-extension",
                  browser_version: "fixture",
                  os: "linux",
                },
                capabilities: {
                  tool_route: "direct-mcp",
                  action_control: "MICRO_ACTION",
                  result_control: "OBSERVE_ONLY",
                  interaction_fidelity: "PROVEN_PASS_THROUGH",
                  control_critical_contract_id: "none",
                  handoff: "NONE",
                },
                metrics: {
                  success: true,
                  duration_ms: 1,
                  browser_invocations: 1,
                  redundant_actions: 0,
                  browser_observation_payload_tokens: 0,
                  oxrail_context_tokens: 0,
                  total_model_input_tokens: null,
                  total_model_output_tokens: null,
                  token_measurement_source: "UNAVAILABLE",
                  native_primitive_parity: true,
                  pointer_interference: 0,
                  focus_interference: 0,
                  scroll_interference: 0,
                  incorrect_normal_blocks: 0,
                  oxrail_generated_page_write_events: 0,
                  post_handoff_stale_target_executions: 0,
                  known_supported_path_hook_bypasses: 0,
                  deny_side_effect_failures: 0,
                  unapproved_high_impact_actions: 0,
                  agent_actions_during_user_lease: 0,
                  agent_observations_during_user_lease: 0,
                  secret_occurrences: 0,
                  hook_overhead_ms: variant === "OXRAIL_GUARD" ? 5 : 0,
                  secret_exposure: false,
                },
                artifact_hashes: {},
              })}\n`;
            }
          }
        }
      }
    }
    const traceList = `${resultReferences
      .map((reference) => `${sha(artifacts[reference]!)}  ${reference}`)
      .join("\n")}\n`;
    profile.evidence.traceManifestHash = sha(traceList);
    artifacts["host-profile.json"] = `${JSON.stringify(profile)}\n`;
    for (const [reference, contents] of Object.entries(artifacts)) {
      const file = join(runRoot, reference);
      await mkdir(join(file, ".."), { recursive: true });
      await writeFile(file, contents);
    }
    let sums = `${Object.entries(artifacts)
      .map(([reference, contents]) => `${sha(contents)}  ${reference}`)
      .join("\n")}\n`;
    await writeFile(join(runRoot, "SHA256SUMS"), sums);

    const dependencies = [
      "WP-HOST-008",
      "WP-GRD-006",
      "WP-NIF-005",
      "WP-SEC-000",
    ];
    const dependencyManifests = [];
    for (const workPackage of dependencies) {
      const dependencyRoot = join(
        repositoryRoot,
        "evidence",
        workPackage,
        "run",
      );
      await mkdir(dependencyRoot, { recursive: true });
      const dependencyArtifacts = {
        "host-profile.json": artifacts["host-profile.json"]!,
        "result.json": artifacts[resultReferences[0]!]!,
      };
      for (const [reference, contents] of Object.entries(dependencyArtifacts)) {
        await writeFile(join(dependencyRoot, reference), contents);
      }
      const dependencySums = `${Object.entries(dependencyArtifacts)
        .map(([reference, contents]) => `${sha(contents)}  ${reference}`)
        .join("\n")}\n`;
      await writeFile(join(dependencyRoot, "SHA256SUMS"), dependencySums);
      const dependencyPath = `evidence/${workPackage}/run/manifest.json`;
      dependencyManifests.push({
        work_package: workPackage,
        path: dependencyPath,
      });
      await writeFile(
        join(repositoryRoot, dependencyPath),
        `${JSON.stringify({
          ...blocked,
          work_package: workPackage,
          status: "ACCEPTED",
          commit,
          environment: {
            surface: "codex-desktop",
            host_build: "fixture",
            computer_use_plugin: "fixture",
            browser: "chrome-extension",
            os: "linux",
          },
          schema_hashes: {
            "packages/protocol/schemas/host-profile.schema.json":
              sha(schemaContents),
          },
          host_profiles: ["host-profile.json"],
          commands: ["pnpm check"],
          test_results: ["result.json"],
          reviewers: ["reviewer"],
          sha256_manifest: sha(dependencySums),
          accepted_at: "2026-09-04T00:00:00.000Z",
          blockers: [],
        })}\n`,
      );
    }

    const releaseManifest = {
      work_package: "WP-RLS-010",
      status: "ACCEPTED",
      commit,
      spec_version: "0.5.0",
      environment: {
        surface: "codex-desktop",
        host_build: "fixture",
        computer_use_plugin: "fixture",
        browser: "chrome-extension",
        os: "linux",
      },
      schema_hashes: Object.fromEntries(
        [
          "evidence-manifest.schema.json",
          "evidence-trace.schema.json",
          "host-profile.schema.json",
        ].map((name) => [
          `packages/protocol/schemas/${name}`,
          sha(schemaContents),
        ]),
      ),
      host_profiles: ["host-profile.json"],
      commands: ["pnpm check"],
      test_results: resultReferences,
      reviewers: ["reviewer"],
      sha256_manifest: sha(sums),
      accepted_at: "2026-09-04T00:00:00.000Z",
      blockers: [],
      dependency_manifests: dependencyManifests,
      experiment_protocol: blocked.experiment_protocol,
    };
    await writeFile(
      join(runRoot, "manifest.json"),
      `${JSON.stringify(releaseManifest)}\n`,
    );
    const localRoot = join(repositoryRoot, "evidence/WP-RLS-010/local");
    await mkdir(localRoot, { recursive: true });
    await writeFile(
      join(localRoot, "manifest.json"),
      `${JSON.stringify(blocked)}\n`,
    );
    runGit("add", ".");
    runGit("commit", "-qm", "evidence");

    await expect(
      validateEvidenceManifestFile("evidence/WP-RLS-010/run/manifest.json", {
        repositoryRoot,
      }),
    ).resolves.toMatchObject({ manifest: { status: "ACCEPTED" } });
    await expect(
      selectAcceptedReleaseManifest(repositoryRoot),
    ).resolves.toMatchObject({ path: join(runRoot, "manifest.json") });

    const reusedArmReferences = resultReferences.filter(
      (reference) =>
        reference.includes("NATIVE_INTERACTION") &&
        reference.endsWith("OXRAIL_GUARD.json"),
    );
    const sourceArm = JSON.parse(artifacts[reusedArmReferences[0]!]!) as {
      test_id: string;
      model_id: string;
      run_index: number;
      runner_id: string;
      context_isolation_id: string;
    };
    const reusedArmReference = reusedArmReferences.find((reference) => {
      const candidate = JSON.parse(artifacts[reference]!) as {
        test_id: string;
        model_id: string;
        run_index: number;
      };
      return (
        candidate.test_id !== sourceArm.test_id &&
        candidate.model_id === sourceArm.model_id &&
        candidate.run_index === sourceArm.run_index
      );
    })!;
    const reusedArm = JSON.parse(artifacts[reusedArmReference]!) as {
      runner_id: string;
      context_isolation_id: string;
    };
    reusedArm.runner_id = sourceArm.runner_id;
    reusedArm.context_isolation_id = sourceArm.context_isolation_id;
    artifacts[reusedArmReference] = `${JSON.stringify(reusedArm)}\n`;
    await writeFile(
      join(runRoot, reusedArmReference),
      artifacts[reusedArmReference]!,
    );
    const changedTraceList = `${resultReferences
      .map((reference) => `${sha(artifacts[reference]!)}  ${reference}`)
      .join("\n")}\n`;
    profile.evidence.traceManifestHash = sha(changedTraceList);
    artifacts["host-profile.json"] = `${JSON.stringify(profile)}\n`;
    await writeFile(
      join(runRoot, "host-profile.json"),
      artifacts["host-profile.json"],
    );
    sums = `${Object.entries(artifacts)
      .map(([reference, contents]) => `${sha(contents)}  ${reference}`)
      .join("\n")}\n`;
    await writeFile(join(runRoot, "SHA256SUMS"), sums);
    releaseManifest.sha256_manifest = sha(sums);
    await writeFile(
      join(runRoot, "manifest.json"),
      `${JSON.stringify(releaseManifest)}\n`,
    );
    runGit("add", ".");
    runGit("commit", "-qm", "isolation regression fixture");
    await expect(
      validateEvidenceManifestFile("evidence/WP-RLS-010/run/manifest.json", {
        repositoryRoot,
      }),
    ).rejects.toThrow(
      "each suite/task/model/variant/repeat arm requires a globally unique runner and context",
    );

    const singleRoot = join(repositoryRoot, "evidence/WP-RLS-010/single");
    await mkdir(singleRoot, { recursive: true });
    const singleReference = resultReferences[0]!;
    const singleResult = artifacts[singleReference]!;
    const singleTraceLine = `${sha(singleResult)}  result.json\n`;
    profile.evidence.traceManifestHash = sha(singleTraceLine);
    const singleProfile = `${JSON.stringify(profile)}\n`;
    await writeFile(join(singleRoot, "host-profile.json"), singleProfile);
    await writeFile(join(singleRoot, "result.json"), singleResult);
    const singleSums = `${sha(singleProfile)}  host-profile.json\n${singleTraceLine}`;
    await writeFile(join(singleRoot, "SHA256SUMS"), singleSums);
    await writeFile(
      join(singleRoot, "manifest.json"),
      `${JSON.stringify({
        ...releaseManifest,
        host_profiles: ["host-profile.json"],
        test_results: ["result.json"],
        sha256_manifest: sha(singleSums),
      })}\n`,
    );
    runGit("add", ".");
    runGit("commit", "-qm", "single trace regression fixture");
    await expect(
      validateEvidenceManifestFile("evidence/WP-RLS-010/single/manifest.json", {
        repositoryRoot,
      }),
    ).rejects.toThrow("HostRealityBench is missing");
  }, 30_000);
});
