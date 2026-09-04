import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HostProfileSchema,
  NativePrimitiveSchema,
  type HostProfile,
} from "../packages/protocol/src/index.js";
import {
  digestSessionId,
  handleHookEvent,
  hookDefinitionHash,
  markerMatches,
  oxrailDataDirectory,
  readHookMarker,
} from "../packages/host-openai/src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function fixtureProfile(definitionHash: string): Promise<HostProfile> {
  return HostProfileSchema.parse({
    schemaVersion: 3,
    profileId: "hp_fixture",
    setup: {
      lifecycle: "CONFIGURED",
      pluginInstalled: "passed",
      skillAvailable: "passed",
      hooksRegistered: "passed",
      hooksTrusted: "passed",
      preToolUseAvailable: "passed",
      postToolUseAvailable: "passed",
      chromeComputerUseDetectable: "passed",
      matcherProfileValid: "passed",
      syntheticProbe: "unknown",
      firstBrowserHookSeen: false,
      verificationSource: "none",
      optimization: "BYPASSED",
    },
    identity: {
      surface: "codex-desktop",
      hostBuild: "fixture-host",
      codexVersion: "fixture-codex",
      computerUsePluginVersion: "fixture-computer-use",
      browserPath: "chrome-extension",
      os: "linux",
    },
    route: {
      toolRoute: "direct-mcp",
      canonicalToolMatchers: ["fixture.native.browser"],
      matcherEvidenceHash: "a".repeat(64),
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
        NativePrimitiveSchema.options.map((primitive) => [primitive, "passed"]),
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
      replacementTiming: "unknown",
      media: {
        text: "unknown",
        structured: "unknown",
        image: "unknown",
        error: "unknown",
        attachment: "unknown",
      },
      codeModePromiseSemantics: "unknown",
      controlCriticalContract: {
        status: "unknown",
        requiredFields: [],
        conditionalFields: [],
        unknownFields: ["native-result"],
        testedNextStepPrimitives: [],
      },
      rawPersistence: ["unknown"],
    },
    hooks: {
      policy: "plugin",
      trustState: "active",
      definitionHash,
      concurrentConflictProbe: "unknown",
    },
    nativeCapabilities: {
      outputTokenLimit: "unknown",
      webMcp: "unknown",
      structuredObservation: "unknown",
      readOnlyDeveloperTools: "unknown",
      nativeApprovalFlow: "passed",
    },
    handoff: {
      activation: "INACTIVE",
      inactiveReasons: ["fixture has no handoff implementation"],
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
      exclusiveBrowserLease: "unsupported",
      noAgentObservationDuringLease: "unsupported",
      nonSecretCompletionDetector: "unsupported",
      originAndStateVerification: "unsupported",
      restoreOriginalWindowIndex: "unsupported",
      restorePinnedAndGroupState: "unsupported",
      automaticToolOrEventResume: "unsupported",
      oneClickFallback: "unsupported",
      chatMessageRequired: "unknown",
    },
    evidence: {
      probeSuiteVersion: "fixture-1",
      fixtureRevision: "fixture-1",
      traceManifestHash: "b".repeat(64),
      testedAt: "2026-09-04T00:00:00.000Z",
      validUntilHostChange: true,
      unresolved: ["result-replacement", "handoff"],
    },
    derived: {
      mode: "ADVISORY_ONLY",
      safety: "INACTIVE",
      handoff: "INACTIVE",
      allowedClaims: ["fixture-only action guard"],
      forbiddenClaims: ["secret protection", "handoff"],
    },
  });
}

async function setup() {
  const pluginRoot = process.cwd();
  const pluginData = await mkdtemp(path.join(tmpdir(), "oxrail-hook-"));
  temporaryDirectories.push(pluginData);
  const definitionHash = await hookDefinitionHash(pluginRoot);
  await writeFile(
    path.join(pluginData, "host-profile.json"),
    `${JSON.stringify(await fixtureProfile(definitionHash))}\n`,
  );
  return { definitionHash, pluginData, pluginRoot };
}

async function allFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory() ? allFiles(filename) : [filename];
      }),
    )
  ).flat();
}

describe("public Codex hooks", () => {
  it("shares one state directory with installed Skill commands", () => {
    expect(oxrailDataDirectory("/fixture/home")).toBe(
      path.join("/fixture/home", ".oxrail"),
    );
  });

  it("matches broadly but classifies only the exact evidence-backed tool name", async () => {
    const environment = await setup();
    const canary = "OXRAIL_SECRET_CANARY_DO_NOT_STORE";
    const sessionCanary = "OXRAIL_SESSION_CANARY_DO_NOT_STORE";

    const unrelated = await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        tool_name: "fixture.native.browser.extra",
        tool_input: { value: canary },
      },
      environment,
    );
    expect(unrelated).toEqual({});
    expect(
      await markerMatches(
        environment.pluginData,
        "PreToolUse",
        environment.definitionHash,
        {
          browserHook: true,
          profileId: "hp_fixture",
        },
      ),
    ).toBe(false);

    const pre = await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionCanary,
        tool_name: "fixture.native.browser",
        tool_input: { value: canary },
      },
      environment,
    );
    const post = await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        session_id: sessionCanary,
        tool_name: "fixture.native.browser",
        tool_input: { value: canary },
        tool_response: { raw: canary },
      },
      environment,
    );

    expect(pre).toEqual({});
    expect(post).toEqual({});
    expect(
      await markerMatches(
        environment.pluginData,
        "PreToolUse",
        environment.definitionHash,
        {
          browserHook: true,
          profileId: "hp_fixture",
        },
      ),
    ).toBe(true);
    expect(
      await markerMatches(
        environment.pluginData,
        "PostToolUse",
        environment.definitionHash,
        {
          browserHook: true,
          profileId: "hp_fixture",
        },
      ),
    ).toBe(true);
    const firstMarker = await readHookMarker(
      environment.pluginData,
      "PreToolUse",
      true,
    );
    expect(firstMarker?.first_browser_hook_seen).toBe(true);
    expect(firstMarker?.sessionDigest).toBe(digestSessionId(sessionCanary));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionCanary,
        tool_name: "fixture.native.browser",
        tool_input: { value: canary },
      },
      environment,
    );
    expect(
      await readHookMarker(environment.pluginData, "PreToolUse", true),
    ).toEqual(firstMarker);
    const persisted = await Promise.all(
      (await allFiles(environment.pluginData)).map((filename) =>
        readFile(filename, "utf8"),
      ),
    );
    expect(persisted.join("\n")).not.toContain(canary);
    expect(persisted.join("\n")).not.toContain(sessionCanary);
  });

  it("fails open when the profile is missing or the hook hash changed", async () => {
    const pluginRoot = process.cwd();
    const pluginData = await mkdtemp(path.join(tmpdir(), "oxrail-hook-open-"));
    temporaryDirectories.push(pluginData);

    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          tool_name: "anything",
          tool_input: { action: "click" },
        },
        { pluginData, pluginRoot },
      ),
    ).resolves.toEqual({});

    const profile = await fixtureProfile("0".repeat(64));
    await writeFile(
      path.join(pluginData, "host-profile.json"),
      JSON.stringify(profile),
    );
    const staleProfileOutput = await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        tool_name: "fixture.native.browser",
        tool_input: { action: "click" },
      },
      { pluginData, pluginRoot },
    );
    expect(staleProfileOutput).toMatchObject({
      systemMessage: expect.stringContaining(
        "Oxrail optimization unavailable / BYPASSED",
      ),
    });
    expect(JSON.stringify(staleProfileOutput)).not.toContain(
      "permissionDecision",
    );
    expect(JSON.stringify(staleProfileOutput)).not.toContain("updatedInput");
  });

  it("surfaces a fixed inactive status when the Hook CLI fails internally", () => {
    const canary = "OXRAIL_INTERNAL_ERROR_INPUT_MUST_NOT_LEAK";
    const result = spawnSync(
      process.execPath,
      [path.join(process.cwd(), "dist", "hooks", "pre-tool.mjs")],
      {
        encoding: "utf8",
        env: {
          PLUGIN_ROOT: path.join(
            tmpdir(),
            `oxrail-missing-plugin-root-${process.pid}`,
          ),
        },
        input: `${JSON.stringify({
          hook_event_name: "PreToolUse",
          tool_input: { value: canary },
          tool_name: "fixture.native.browser",
        })}\n`,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage:
        "Oxrail optimization unavailable / BYPASSED. Native Computer Use remains available. " +
        "Oxrail safety protection: INACTIVE. Oxrail handoff protection: INACTIVE.",
    });
    expect(result.stdout).not.toContain(canary);
  });

  it("never bypasses host approvals or hook trust", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.join(process.cwd(), ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    ) as { version: string };
    const expectedBuildStamp = `--oxrail-build ${manifest.version}`;
    const definition = await readFile(
      path.join(process.cwd(), "hooks", "hooks.json"),
      "utf8",
    );
    const hooks = JSON.parse(definition) as {
      hooks: Record<
        string,
        Array<{
          hooks: Array<{
            command?: string;
            commandWindows?: string;
            type: string;
          }>;
          matcher?: string;
        }>
      >;
    };

    for (const groups of Object.values(hooks.hooks)) {
      for (const group of groups) {
        for (const handler of group.hooks) {
          if (handler.type !== "command") continue;
          expect(handler.command?.endsWith(expectedBuildStamp)).toBe(true);
          expect(handler.commandWindows?.endsWith(expectedBuildStamp)).toBe(
            true,
          );
        }
      }
    }

    expect(hooks.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    expect(hooks.hooks.PostToolUse?.[0]?.matcher).toBe("*");
    expect(definition).not.toContain("bypass-hook-trust");
    expect(definition).not.toContain('"permissionDecision"');
  });
});
