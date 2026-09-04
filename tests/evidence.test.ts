import { mkdtemp, readFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  atomicWriteSanitizedJson,
  writeEvidenceTrace,
} from "../packages/evidence/src/index.js";

describe("sanitized atomic evidence", () => {
  it("redacts secrets and URL queries before the first byte reaches disk", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oxrail-evidence-"));
    const path = join(directory, "trace.json");
    await atomicWriteSanitizedJson(path, {
      password: "canary-password",
      command:
        "probe --token canary-token https://example.test/path?otp=123456#private",
      target: { text: "page secret" },
      safe: true,
    });
    const contents = await readFile(path, "utf8");
    expect(contents).not.toMatch(
      /canary-password|canary-token|123456|page secret|private/,
    );
    expect(contents).toContain("https://example.test/path");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
  });

  it("validates the trace contract and refuses secret exposure claims", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oxrail-trace-"));
    const trace = {
      schema_version: 4,
      run_id: "run",
      task_id: "task",
      suite: "NATIVE_INTERACTION",
      test_id: "TEST-NIF-001",
      model_id: "gpt-5.6-sol",
      variant: "OXRAIL_GUARD",
      pair_id: "pair",
      run_index: 1,
      seed: "seed",
      control_hash: "a".repeat(64),
      model_settings_hash: "b".repeat(64),
      context_isolation_id: "c".repeat(64),
      runner_id: "d".repeat(64),
      spec_version: "0.5.0",
      work_package_ids: ["WP-NIF-002"],
      host_profile_id: "hp",
      host: {
        surface: "codex-desktop",
        build: "test",
        computer_use_plugin: "test",
        browser_path: "chrome-extension",
        browser_version: "test",
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
        hook_overhead_ms: 1,
        secret_exposure: false,
      },
      artifact_hashes: {},
    } as const;
    await expect(
      writeEvidenceTrace(join(directory, "ok.json"), trace),
    ).resolves.toMatchObject({
      schema_version: 4,
    });
    await expect(
      writeEvidenceTrace(join(directory, "bad.json"), {
        ...trace,
        metrics: { ...trace.metrics, secret_exposure: true },
      }),
    ).rejects.toThrow();
    await expect(
      writeEvidenceTrace(join(directory, "false-precision.json"), {
        ...trace,
        metrics: {
          ...trace.metrics,
          token_measurement_source: "HOST_EXACT",
        },
      }),
    ).rejects.toThrow("Only HOST_EXACT evidence may report total model tokens");
  });
});
