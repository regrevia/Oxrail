import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  HookSessionConfigSchema,
  classifyChromeHookTrial,
  projectCodexHookEvent,
} from "../host-codex/index.js";
import {
  LabCollector,
  readPersistedEvents,
  startCollectorIpc,
} from "../monitor/index.js";

const secretCanary = "credential-canary-must-never-persist";

const config = {
  runId: "chrome-hook-smoke",
  pairId: "control",
  sessionToken: "s".repeat(43),
  toolBindings: {
    Bash: "OTHER_REGISTERED",
    computer_use: "NATIVE_BROWSER",
  },
} as const;

const hookInput = (
  event: "PreToolUse" | "PostToolUse",
  toolName: string,
  callId: string,
) => ({
  session_id: "host-session-with-private-identity",
  turn_id: "host-turn",
  cwd: "/private/worktree",
  hook_event_name: event,
  tool_name: toolName,
  tool_use_id: callId,
  tool_input: { prompt: secretCanary },
  tool_response: { page: secretCanary },
});

describe("WP-LAB-004 Codex Hook adapter", () => {
  it("projects only bounded metadata and exact inventory bindings", () => {
    const event = projectCodexHookEvent(
      hookInput("PreToolUse", "computer_use", "browser-call"),
      config,
      { eventId: "00000000-0000-4000-8000-000000000001", nowMs: 12 },
    );

    expect(event).toMatchObject({
      runId: "chrome-hook-smoke",
      pairId: "control",
      source: "HOST_HOOK",
      kind: "TOOL_REQUEST_OBSERVED",
      toolName: "computer_use",
      toolAlias: "NATIVE_BROWSER",
      granularity: "UNKNOWN",
      outcome: "UNKNOWN",
    });
    expect(event.sessionRef).toMatch(/^[a-f0-9]{64}$/);
    expect(event.callRef).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(event)).not.toContain(secretCanary);
    expect(JSON.stringify(event)).not.toContain("private/worktree");
    expect(JSON.stringify(event)).not.toContain("host-session");
  });

  it("rejects malformed events without stringifying private payloads", () => {
    expect(() =>
      projectCodexHookEvent(
        {
          ...hookInput("PreToolUse", "computer_use", "call"),
          tool_name: `invalid tool ${secretCanary}`,
        },
        config,
      ),
    ).toThrow("INVALID_HOOK_METADATA");
    expect(() =>
      projectCodexHookEvent(
        {
          ...hookInput("PreToolUse", "computer_use", "call"),
          extra: secretCanary,
        },
        config,
      ),
    ).not.toThrow();
  });

  it("distinguishes control failure, Chrome failure, opacity, and inventory-bound visibility", () => {
    const project = (
      phase: "control" | "chrome",
      hook: "PreToolUse" | "PostToolUse",
      tool: "Bash" | "computer_use",
      call: string,
    ) =>
      projectCodexHookEvent(hookInput(hook, tool, call), {
        ...config,
        pairId: phase,
      });

    const control = [
      project("control", "PreToolUse", "Bash", "control-call"),
      project("control", "PostToolUse", "Bash", "control-call"),
    ];
    const chrome = [
      project("chrome", "PreToolUse", "computer_use", "chrome-call"),
      project("chrome", "PostToolUse", "computer_use", "chrome-call"),
    ];

    expect(classifyChromeHookTrial([], "PASS").verdict).toBe(
      "CONTROL_HOOK_NOT_OBSERVED",
    );
    expect(classifyChromeHookTrial(control, "FAIL").verdict).toBe(
      "CHROME_ACTION_NOT_CONFIRMED",
    );
    expect(classifyChromeHookTrial(control, "PASS").verdict).toBe(
      "CHROME_ROUTE_NOT_OBSERVED",
    );
    expect(
      classifyChromeHookTrial([...control, ...chrome], "PASS"),
    ).toMatchObject({
      verdict: "CHROME_ROUTE_OBSERVED",
      matchedChromeCalls: 1,
      chromeToolNames: ["computer_use"],
    });
  });

  it("runs the built neutral Hook through authenticated local IPC", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "oxrail-lab-hook-e2e-"));
    const collector = await LabCollector.create({
      root,
      runId: config.runId,
    });
    const ipc = await startCollectorIpc({ root, collector });
    const configRoot = path.join(root, "codex-local-hook-v1");
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    const activePath = path.join(configRoot, "active.json");
    const active = HookSessionConfigSchema.parse({
      schemaVersion: 1,
      status: "ACTIVE",
      runId: config.runId,
      pairId: "chrome",
      socketPath: ipc.socketPath,
      sessionToken: ipc.sessionToken,
      inventoryStatus: "PROVIDED_UNVERIFIED",
      toolBindings: config.toolBindings,
    });
    await writeFile(activePath, `${JSON.stringify(active)}\n`, { mode: 0o600 });
    await chmod(activePath, 0o600);

    try {
      const result = await new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        const child = spawn(
          process.execPath,
          [
            "lab/dist/codex-hook-marketplace/plugins/oxrail-lab-codex-hook/dist/hook.mjs",
          ],
          {
            cwd: process.cwd(),
            env: { ...process.env, OXRAIL_LAB_ROOT: root },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk) => (stdout += String(chunk)));
        child.stderr.on("data", (chunk) => (stderr += String(chunk)));
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(
          JSON.stringify(hookInput("PreToolUse", "computer_use", "e2e-call")),
        );
      });
      expect(result).toEqual({ code: 0, stdout: "", stderr: "" });
      await collector.flush();
      const events = await readPersistedEvents(root, config.runId);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        pairId: "chrome",
        toolName: "computer_use",
        toolAlias: "NATIVE_BROWSER",
      });
      expect(await readFile(activePath, "utf8")).not.toContain(secretCanary);
    } finally {
      await ipc.close();
    }
  });

  it("packages a wildcard-only neutral Lab plugin", async () => {
    const hooks = JSON.parse(
      await readFile("lab/host-codex/plugin/hooks/hooks.json", "utf8"),
    );
    expect(Object.keys(hooks.hooks).sort()).toEqual([
      "PostToolUse",
      "PreToolUse",
    ]);
    const serialized = JSON.stringify(hooks);
    expect(serialized).not.toMatch(
      /permissionDecision|additionalContext|systemMessage|updatedInput|deny|allow/i,
    );
    for (const groups of Object.values(hooks.hooks) as Array<
      Array<{ matcher: string }>
    >) {
      expect(groups).toHaveLength(1);
      expect(groups[0]?.matcher).toBe("*");
    }
  });
});
