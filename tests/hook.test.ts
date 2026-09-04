import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HostProfileSchema,
  NativePrimitiveSchema,
  toolRegistryManifestBinding,
  type HostProfile,
} from "../packages/protocol/src/index.js";
import {
  MAX_BROWSER_TASK_STATE_BYTES,
  activateUserLease,
  createBrowserTaskState,
  readBrowserTaskState,
  sanitizeBrowserTaskStateForPersistence,
  writeBrowserTaskState,
} from "../packages/core/src/index.js";
import {
  digestSessionId,
  digestToolUseId,
  handleHookEvent,
  hookBrowserTaskScope,
  hookDefinitionHash,
  hookRuntimeStateDirectory,
  markerMatches,
  MAX_BROWSER_ROUTE_OBSERVATIONS,
  oxrailDataDirectory,
  recordBrowserHookPhase,
  readBrowserRouteObservations,
  readHookMarker,
  TOOL_SCHEMA_REGISTRY_FILENAME,
  ToolSchemaRegistrySchema,
  toolSchemaRegistryHash,
  writeHostProfile,
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
    schemaVersion: 4,
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
      browserTools: [],
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
      credentialProtection: "INACTIVE",
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
  const profile = await fixtureProfile(definitionHash);
  await writeHostProfile(pluginData, profile);
  return { definitionHash, pluginData, pluginRoot, profile };
}

const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");

async function setupActiveGuard(
  toolContractPatch: Record<string, unknown> = {},
) {
  const environment = await setup();
  const registry = ToolSchemaRegistrySchema.parse({
    schemaVersion: 1,
    profileId: "hp_fixture_active",
    definitionHash: environment.definitionHash,
    matcherEvidenceHash: "a".repeat(64),
    tools: [
      {
        toolName: "fixture.native.browser",
        inputSchemaHash: "d".repeat(64),
        route: "direct-mcp",
        granularity: "MICRO_ACTION",
        actionTypePath: ["action"],
        identityPaths: [["axis"]],
        impactByAction: { click: "reversible", submit: "high-impact" },
        defaultImpact: "high-impact",
        ...toolContractPatch,
      },
    ],
  });
  const registryHash = toolSchemaRegistryHash(registry);
  const base = await fixtureProfile(environment.definitionHash);
  const profile = HostProfileSchema.parse({
    ...base,
    profileId: registry.profileId,
    setup: {
      ...base.setup,
      lifecycle: "VERIFIED",
      firstBrowserHookSeen: true,
      verificationSource: "passive-first-browser-call",
      optimization: "ACTIVE",
    },
    route: {
      ...base.route,
      toolSchemaRegistryHash: registryHash,
      toolSchemaRegistryEvidenceId: "EVID-HOST-HOOK-ACTIVE-FIXTURE",
      browserTools: [
        {
          canonicalToolName: "fixture.native.browser",
          inputSchemaHash: registry.tools[0]!.inputSchemaHash,
          registryManifestBinding: toolRegistryManifestBinding({
            profileId: registry.profileId,
            definitionHash: environment.definitionHash,
            matcherEvidenceHash: registry.matcherEvidenceHash,
            toolSchemaRegistryHash: registryHash,
            toolSchemaRegistryEvidenceId: "EVID-HOST-HOOK-ACTIVE-FIXTURE",
            canonicalToolName: "fixture.native.browser",
            inputSchemaHash: registry.tools[0]!.inputSchemaHash,
          }),
        },
      ],
    },
    derived: {
      ...base.derived,
      mode: "MICRO_ACTION_GUARD",
      safety: "ACTIVE",
    },
    hooks: {
      ...base.hooks,
      concurrentConflictProbe: "passed",
    },
  });
  await writeHostProfile(environment.pluginData, profile);
  const directory = path.join(
    environment.pluginData,
    "hosts",
    profile.profileId,
  );
  const registryContents = `${JSON.stringify(registry, null, 2)}\n`;
  await writeFile(
    path.join(directory, TOOL_SCHEMA_REGISTRY_FILENAME),
    registryContents,
  );
  const profileContents = await readFile(path.join(directory, "profile.json"));
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profileId: profile.profileId,
        profileSha256: sha256(profileContents),
        guard: {
          toolSchemaRegistryFileSha256: sha256(registryContents),
          toolSchemaRegistryHash: registryHash,
          toolSchemaRegistryEvidenceId:
            profile.route.toolSchemaRegistryEvidenceId,
          browserTools: profile.route.browserTools,
        },
      },
      null,
      2,
    )}\n`,
  );
  return {
    ...environment,
    profile,
    registry,
    verifyGuardActivation: (candidate: HostProfile) =>
      candidate.profileId === profile.profileId,
  };
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

async function runtimeStateLockPath(runtimeRoot: string): Promise<string> {
  const state = (await allFiles(runtimeRoot)).find(
    (filename) => path.basename(filename) === "browser-task-state.json",
  );
  if (!state) throw new Error("fixture runtime state was not created");
  return path.join(path.dirname(state), ".browser-task-state.lock");
}

async function seedUserLease(
  pluginData: string,
  profile: HostProfile,
  sessionId: string,
): Promise<void> {
  const scope = hookBrowserTaskScope(sessionId);
  const runtimeRoot = hookRuntimeStateDirectory(pluginData);
  const running = createBrowserTaskState({
    ...scope,
    hostProfileId: profile.profileId,
    mode: profile.derived.mode,
  });
  await writeBrowserTaskState(runtimeRoot, running, null);
  await writeBrowserTaskState(
    runtimeRoot,
    activateUserLease(running, "fixture-handoff"),
    running.stateVersion,
  );
}

describe("public Codex hooks", () => {
  it("shares one state directory with installed Skill commands", () => {
    expect(oxrailDataDirectory("/fixture/home")).toBe(
      path.join("/fixture/home", ".oxrail"),
    );
  });

  it("binds the Hook definition hash to its executable bundles", async () => {
    const pluginRoot = await mkdtemp(path.join(tmpdir(), "oxrail-hook-hash-"));
    temporaryDirectories.push(pluginRoot);
    await Promise.all([
      mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true }),
      mkdir(path.join(pluginRoot, "hooks"), { recursive: true }),
      mkdir(path.join(pluginRoot, "dist", "hooks"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        '{"name":"oxrail","version":"fixture"}\n',
      ),
      writeFile(path.join(pluginRoot, "hooks", "hooks.json"), "{}\n"),
      writeFile(
        path.join(pluginRoot, "dist", "hooks", "pre-tool.mjs"),
        "// first\n",
      ),
      writeFile(
        path.join(pluginRoot, "dist", "hooks", "post-tool.mjs"),
        "// post\n",
      ),
    ]);
    const first = await hookDefinitionHash(pluginRoot);
    await writeFile(
      path.join(pluginRoot, "dist", "hooks", "pre-tool.mjs"),
      "// changed\n",
    );

    expect(await hookDefinitionHash(pluginRoot)).not.toBe(first);
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
    expect(await readBrowserRouteObservations(environment.pluginData)).toEqual(
      [],
    );

    const toolUseId = "fixture-browser-call";
    const pre = await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionCanary,
        tool_name: "fixture.native.browser",
        tool_use_id: toolUseId,
        tool_input: { value: canary },
      },
      environment,
    );
    const post = await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        session_id: sessionCanary,
        tool_name: "fixture.native.browser",
        tool_use_id: toolUseId,
        tool_input: { value: canary },
        tool_response: { raw: canary },
      },
      environment,
    );

    expect(pre).toEqual({});
    expect(post).toEqual({});
    const firstMarker = (
      await readBrowserRouteObservations(environment.pluginData)
    )[0];
    expect(firstMarker).toMatchObject({
      definitionHash: environment.definitionHash,
      profileId: "hp_fixture",
      toolUseDigest: digestToolUseId(toolUseId),
    });
    expect(firstMarker?.preObservedAt).toBeTypeOf("string");
    expect(firstMarker?.postObservedAt).toBeTypeOf("string");
    expect(firstMarker?.sessionDigest).toBe(digestSessionId(sessionCanary));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionCanary,
        tool_name: "fixture.native.browser",
        tool_use_id: toolUseId,
        tool_input: { value: canary },
      },
      environment,
    );
    expect(
      (await readBrowserRouteObservations(environment.pluginData))[0],
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
    await writeHostProfile(pluginData, profile);
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

  it("does not record browser-route evidence without a host session id", async () => {
    const environment = await setup();
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await expect(
        handleHookEvent(
          {
            hook_event_name,
            tool_name: "fixture.native.browser",
            tool_use_id: "sessionless-browser-call",
            tool_input: { action: "fixture-no-op" },
            ...(hook_event_name === "PostToolUse"
              ? { tool_response: { ok: true } }
              : {}),
          },
          environment,
        ),
      ).resolves.toEqual({});
    }

    await expect(
      readBrowserRouteObservations(environment.pluginData),
    ).resolves.toEqual([]);
  });

  it("completes metadata-only Post after activation evidence drifts", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "raw-active-session-canary";
    const turnId = "raw-active-turn-canary";
    const toolUseId = "raw-active-tool-canary";
    const pre = await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        turn_id: turnId,
        tool_name: "fixture.native.browser",
        tool_use_id: toolUseId,
        tool_input: { action: "click", axis: "primary" },
      },
      environment,
    );
    expect(pre).toEqual({});

    const scope = hookBrowserTaskScope(sessionId);
    const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
    await expect(
      readBrowserTaskState(runtimeRoot, scope),
    ).resolves.toMatchObject({
      lastAction: {
        actionType: "click",
        decision: "ALLOW",
        reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
      },
      pendingNativeActionIds: [expect.stringMatching(/^oxrail-id:/)],
    });
    await writeFile(
      path.join(
        environment.pluginData,
        "hosts",
        environment.profile.profileId,
        TOOL_SCHEMA_REGISTRY_FILENAME,
      ),
      "{}\n",
    );
    await writeFile(
      path.join(
        environment.pluginData,
        "hosts",
        environment.profile.profileId,
        "manifest.json",
      ),
      "{}\n",
    );
    environment.verifyGuardActivation = () => {
      throw new Error("Post cleanup must not require fresh attestation");
    };

    let responseRead = false;
    let postInputRead = false;
    const post: Record<string, unknown> = {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      turn_id: `${turnId}-next`,
      tool_name: "fixture.native.browser",
      tool_use_id: toolUseId,
    };
    Object.defineProperties(post, {
      tool_input: {
        enumerable: true,
        get() {
          postInputRead = true;
          throw new Error("PostToolUse must not inspect tool_input");
        },
      },
      tool_response: {
        enumerable: true,
        get() {
          responseRead = true;
          throw new Error("PostToolUse must not inspect tool_response");
        },
      },
    });
    await expect(handleHookEvent(post, environment)).resolves.toEqual({});
    expect(postInputRead).toBe(false);
    expect(responseRead).toBe(false);
    await expect(
      readBrowserTaskState(runtimeRoot, scope),
    ).resolves.toMatchObject({ pendingNativeActionIds: [] });

    const persisted = await Promise.all(
      (await allFiles(environment.pluginData)).map((filename) =>
        readFile(filename, "utf8"),
      ),
    );
    expect(persisted.join("\n")).not.toContain(sessionId);
    expect(persisted.join("\n")).not.toContain(turnId);
    expect(persisted.join("\n")).not.toContain(toolUseId);
  });

  it("does not enforce a seeded lease without an external attestation verifier", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "unattested-session";
    await seedUserLease(environment.pluginData, environment.profile, sessionId);
    const { verifyGuardActivation: _untrustedTestSeam, ...production } =
      environment;

    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          tool_name: "fixture.native.browser",
          tool_use_id: "unattested-call",
          tool_input: { action: "submit", axis: "primary" },
        },
        production,
      ),
    ).resolves.toMatchObject({
      systemMessage: expect.stringContaining("BYPASSED"),
    });
  });

  it("keeps CONFIGURED first-call verification passive despite seeded state", async () => {
    const environment = await setup();
    const sessionId = "configured-seeded-session";
    await seedUserLease(environment.pluginData, environment.profile, sessionId);

    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          tool_name: "fixture.native.browser",
          tool_use_id: "configured-seeded-call",
          tool_input: { action: "click" },
        },
        environment,
      ),
    ).resolves.toEqual({});
  });

  it("never applies a browser lease to an unrelated tool", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "unrelated-seeded-session";
    await seedUserLease(environment.pluginData, environment.profile, sessionId);

    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          tool_name: "fixture.unrelated.tool",
          tool_use_id: "unrelated-seeded-call",
          tool_input: { action: "click" },
        },
        environment,
      ),
    ).resolves.toEqual({});
  });

  it("migrates an idle session state to the current verified profile", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "profile-migration-session";
    const scope = hookBrowserTaskScope(sessionId);
    const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
    await writeBrowserTaskState(
      runtimeRoot,
      createBrowserTaskState({
        ...scope,
        hostProfileId: "hp_previous_fixture",
        mode: "ADVISORY_ONLY",
      }),
      null,
    );

    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          tool_name: "fixture.native.browser",
          tool_use_id: "profile-migration-call",
          tool_input: { action: "click", axis: "primary" },
        },
        environment,
      ),
    ).resolves.toEqual({});
    await expect(
      readBrowserTaskState(runtimeRoot, scope),
    ).resolves.toMatchObject({
      hostProfileId: environment.profile.profileId,
      actionSignatureKeyId: expect.stringMatching(/^[a-f0-9]{64}$/),
      mode: "MICRO_ACTION_GUARD",
      revision: 1,
      targetCacheEpoch: 1,
      stateVersion: 1,
      pendingNativeActionIds: [expect.stringMatching(/^oxrail-id:/)],
    });
  });

  it("denies a trusted high-impact action through the official PreToolUse shape", async () => {
    const environment = await setupActiveGuard();
    const input = {
      hook_event_name: "PreToolUse" as const,
      session_id: "high-impact-session",
      turn_id: "high-impact-turn",
      tool_name: "fixture.native.browser",
      tool_use_id: "high-impact-call",
      tool_input: { action: "submit", axis: "primary" },
    };

    const first = await handleHookEvent(input, environment);
    const duplicate = await handleHookEvent(input, environment);
    for (const output of [first, duplicate]) {
      expect(output).toEqual({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason:
            "OXRAIL_HUMAN_BOUNDARY: This action requires host-native approval; Oxrail cannot create approval proactively.",
        },
      });
    }
  });

  it("never replays an allowed native action for duplicate or mismatched Pre delivery", async () => {
    const environment = await setupActiveGuard({
      originPath: ["origin"],
      revisionPath: ["revision"],
    });
    const input = {
      hook_event_name: "PreToolUse" as const,
      session_id: "duplicate-allow-session",
      tool_name: "fixture.native.browser",
      tool_use_id: "duplicate-allow-call",
      tool_input: {
        action: "click",
        axis: "primary",
        origin: "https://example.test",
        revision: 0,
      },
    };

    await expect(handleHookEvent(input, environment)).resolves.toEqual({});
    for (const duplicate of [
      input,
      {
        ...input,
        tool_input: {
          ...input.tool_input,
          axis: "changed",
        },
      },
      {
        ...input,
        tool_input: {
          ...input.tool_input,
          origin: "https://changed.example.test",
        },
      },
      {
        ...input,
        tool_input: {
          ...input.tool_input,
          revision: 1,
        },
      },
    ]) {
      await expect(
        handleHookEvent(duplicate, environment),
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining(
            "OXRAIL_VERIFICATION_INCONCLUSIVE",
          ),
        },
      });
    }
  });

  it("serializes concurrent duplicate Pre delivery before native execution", async () => {
    const environment = await setupActiveGuard();
    const input = {
      hook_event_name: "PreToolUse" as const,
      session_id: "concurrent-duplicate-session",
      tool_name: "fixture.native.browser",
      tool_use_id: "concurrent-duplicate-call",
      tool_input: { action: "click", axis: "primary" },
    };
    const outputs = await Promise.all(
      Array.from({ length: 2 }, () => handleHookEvent(input, environment)),
    );

    expect(
      outputs.filter((output) => JSON.stringify(output) === "{}"),
    ).toHaveLength(1);
    expect(
      outputs.filter(
        (output) =>
          "hookSpecificOutput" in output &&
          output.hookSpecificOutput.permissionDecision === "deny",
      ),
    ).toHaveLength(1);

    const highImpact = {
      ...input,
      session_id: "concurrent-high-impact-session",
      tool_use_id: "concurrent-high-impact-call",
      tool_input: { action: "submit", axis: "primary" },
    };
    const denials = await Promise.all(
      Array.from({ length: 2 }, () => handleHookEvent(highImpact, environment)),
    );
    expect(
      denials.every(
        (output) =>
          "hookSpecificOutput" in output &&
          output.hookSpecificOutput.permissionDecision === "deny" &&
          output.hookSpecificOutput.permissionDecisionReason.includes(
            "OXRAIL_HUMAN_BOUNDARY",
          ),
      ),
    ).toBe(true);
  });

  it("preserves a computed high-impact deny when state persistence fails", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "oversized-state-session";
    const scope = hookBrowserTaskScope(sessionId);
    const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
    const initial = {
      ...createBrowserTaskState({
        ...scope,
        hostProfileId: environment.profile.profileId,
        mode: environment.profile.derived.mode,
      }),
      pendingNativeActionIds: Array.from(
        { length: 843 },
        (_, index) => `oxrail-id:${index.toString(16).padStart(64, "0")}`,
      ),
    };
    expect(
      Buffer.byteLength(
        `${JSON.stringify(sanitizeBrowserTaskStateForPersistence(initial))}\n`,
      ),
    ).toBeLessThanOrEqual(MAX_BROWSER_TASK_STATE_BYTES);
    await writeBrowserTaskState(runtimeRoot, initial, null);

    const request = {
      hook_event_name: "PreToolUse" as const,
      session_id: sessionId,
      tool_name: "fixture.native.browser",
      tool_use_id: "oversized-state-call",
      tool_input: { action: "submit", axis: "primary" },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(
        handleHookEvent(request, environment),
      ).resolves.toMatchObject({
        hookSpecificOutput: {
          permissionDecision: "deny",
          permissionDecisionReason: expect.stringContaining(
            "OXRAIL_HUMAN_BOUNDARY",
          ),
        },
      });
    }
    await expect(readBrowserTaskState(runtimeRoot, scope)).resolves.toEqual(
      initial,
    );
  });

  it("preserves ownership and high-impact denials when local digest protection is unavailable", async () => {
    const environment = await setupActiveGuard();
    const leasedSession = "digest-key-lease-session";
    const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
    await seedUserLease(
      environment.pluginData,
      environment.profile,
      leasedSession,
    );
    await writeFile(
      path.join(runtimeRoot, ".local-digest-key.json"),
      Buffer.alloc(32),
      {
        mode: 0o644,
      },
    );

    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          session_id: leasedSession,
          tool_name: "fixture.native.browser",
          tool_use_id: "call-during-lease",
          tool_input: { action: "click", axis: "primary" },
        },
        environment,
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(
          "OXRAIL_USER_LEASE_ACTIVE",
        ),
      },
    });
    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          session_id: "digest-key-high-impact-session",
          tool_name: "fixture.native.browser",
          tool_use_id: "high-impact-call",
          tool_input: { action: "submit", axis: "primary" },
        },
        environment,
      ),
    ).resolves.toMatchObject({
      hookSpecificOutput: {
        permissionDecision: "deny",
        permissionDecisionReason: expect.stringContaining(
          "OXRAIL_HUMAN_BOUNDARY",
        ),
      },
    });
    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          session_id: "digest-key-pass-through-session",
          tool_name: "fixture.native.browser",
          tool_use_id: "ordinary-call",
          tool_input: { action: "click", axis: "primary" },
        },
        environment,
      ),
    ).resolves.toMatchObject({
      systemMessage: expect.stringContaining("BYPASSED"),
    });
  });

  it("does not compare or overwrite action signatures after key loss", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "digest-key-loss-session";
    const request = {
      hook_event_name: "PreToolUse" as const,
      session_id: sessionId,
      tool_name: "fixture.native.browser",
      tool_use_id: "keyed-call-1",
      tool_input: { action: "click", axis: "primary" },
    };
    await expect(handleHookEvent(request, environment)).resolves.toEqual({});
    await handleHookEvent(
      { ...request, hook_event_name: "PostToolUse" as const },
      environment,
    );

    const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
    const scope = hookBrowserTaskScope(sessionId);
    const keyed = await readBrowserTaskState(runtimeRoot, scope);
    if (!keyed?.actionSignatureKeyId) {
      throw new Error("fixture action signature key was not persisted");
    }
    await writeBrowserTaskState(
      runtimeRoot,
      { ...keyed, noProgressCount: 2, stateVersion: keyed.stateVersion + 1 },
      keyed.stateVersion,
    );
    await unlink(path.join(runtimeRoot, ".local-digest-key.json"));

    await expect(
      handleHookEvent({ ...request, tool_use_id: "keyed-call-2" }, environment),
    ).resolves.toMatchObject({
      systemMessage: expect.stringContaining("BYPASSED"),
    });
    await expect(
      readBrowserTaskState(runtimeRoot, scope),
    ).resolves.toMatchObject({
      actionSignatureKeyId: keyed.actionSignatureKeyId,
      noProgressCount: 2,
      pendingNativeActionIds: [],
    });
  });

  it("does not enforce a persisted lease after activation evidence drifts", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "lease-session";
    const turnId = "lease-turn";
    const seedTool = "seed-call";
    await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        turn_id: turnId,
        tool_name: "fixture.native.browser",
        tool_use_id: seedTool,
        tool_input: { action: "click", axis: "primary" },
      },
      environment,
    );
    await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        turn_id: turnId,
        tool_name: "fixture.native.browser",
        tool_use_id: seedTool,
      },
      environment,
    );
    const scope = hookBrowserTaskScope(sessionId);
    const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
    const running = await readBrowserTaskState(runtimeRoot, scope);
    if (!running) throw new Error("fixture state was not created");
    const leased = activateUserLease(running, "fixture-handoff");
    await writeBrowserTaskState(runtimeRoot, leased, running.stateVersion);
    const driftedProfileId = "hp_fixture_active_drifted";
    const driftedProfile = HostProfileSchema.parse({
      ...environment.profile,
      profileId: driftedProfileId,
      setup: {
        ...environment.profile.setup,
        lifecycle: "CONFIGURED",
        firstBrowserHookSeen: false,
        verificationSource: "none",
        optimization: "BYPASSED",
      },
      route: {
        ...environment.profile.route,
        browserTools: environment.profile.route.browserTools.map((tool) => ({
          ...tool,
          registryManifestBinding: toolRegistryManifestBinding({
            profileId: driftedProfileId,
            definitionHash: environment.profile.hooks.definitionHash,
            matcherEvidenceHash: environment.profile.route.matcherEvidenceHash,
            toolSchemaRegistryHash:
              environment.profile.route.toolSchemaRegistryHash!,
            toolSchemaRegistryEvidenceId:
              environment.profile.route.toolSchemaRegistryEvidenceId!,
            canonicalToolName: tool.canonicalToolName,
            inputSchemaHash: tool.inputSchemaHash,
          }),
        })),
      },
      derived: {
        ...environment.profile.derived,
        mode: "ADVISORY_ONLY",
        safety: "INACTIVE",
      },
    });
    await writeHostProfile(environment.pluginData, driftedProfile);

    const request = {
      hook_event_name: "PreToolUse" as const,
      session_id: sessionId,
      turn_id: `${turnId}-next`,
      tool_name: "fixture.native.browser",
      tool_use_id: "call-during-user-lease",
      tool_input: { action: "click", axis: "primary" },
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await expect(handleHookEvent(request, environment)).resolves.toEqual({});
    }

    await writeFile(
      path.join(
        environment.pluginData,
        "hosts",
        driftedProfileId,
        "manifest.json",
      ),
      "{}\n",
    );
    await expect(handleHookEvent(request, environment)).resolves.toEqual({});
  });

  it("fails open when the session state lock is unavailable", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "locked-session";
    await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "fixture.native.browser",
        tool_use_id: "seed-lock-state",
        tool_input: { action: "click", axis: "seed" },
      },
      environment,
    );
    await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        tool_name: "fixture.native.browser",
        tool_use_id: "seed-lock-state",
      },
      environment,
    );
    const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
    const lockPath = await runtimeStateLockPath(runtimeRoot);
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        createdAt: Date.now(),
        nonce: "00000000-0000-4000-8000-000000000000",
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );

    await expect(
      handleHookEvent(
        {
          hook_event_name: "PreToolUse",
          session_id: sessionId,
          turn_id: "next-turn",
          tool_name: "fixture.native.browser",
          tool_use_id: "call-during-lock",
          tool_input: { action: "click", axis: "next" },
        },
        environment,
      ),
    ).resolves.toMatchObject({
      systemMessage: expect.stringContaining("BYPASSED"),
    });
    await unlink(lockPath);
  });

  it("retries metadata-only Post cleanup after a transient state lock", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "post-retry-session";
    const toolUseId = "post-retry-call";
    await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "fixture.native.browser",
        tool_use_id: toolUseId,
        tool_input: { action: "click", axis: "primary" },
      },
      environment,
    );
    const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
    const lockPath = await runtimeStateLockPath(runtimeRoot);
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: process.pid,
        createdAt: Date.now(),
        nonce: "00000000-0000-4000-8000-000000000000",
      })}\n`,
      { flag: "wx", mode: 0o600 },
    );
    const post = {
      hook_event_name: "PostToolUse" as const,
      session_id: sessionId,
      turn_id: "later-turn",
      tool_name: "fixture.native.browser",
      tool_use_id: toolUseId,
    };
    const releaseLock = new Promise<void>((resolve, reject) => {
      setTimeout(() => void unlink(lockPath).then(resolve, reject), 1);
    });
    await expect(handleHookEvent(post, environment)).resolves.toEqual({});
    await releaseLock;
    await expect(
      readBrowserTaskState(runtimeRoot, hookBrowserTaskScope(sessionId)),
    ).resolves.toMatchObject({ pendingNativeActionIds: [] });
  });

  it("does not invent no-progress outcomes from metadata-only Post events", async () => {
    const environment = await setupActiveGuard();
    const sessionId = "no-progress-session";
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const toolUseId = `no-progress-call-${attempt}`;
      await expect(
        handleHookEvent(
          {
            hook_event_name: "PreToolUse",
            session_id: sessionId,
            tool_name: "fixture.native.browser",
            tool_use_id: toolUseId,
            tool_input: { action: "click", axis: "same" },
          },
          environment,
        ),
      ).resolves.toEqual({});
      await handleHookEvent(
        {
          hook_event_name: "PostToolUse",
          session_id: sessionId,
          tool_name: "fixture.native.browser",
          tool_use_id: toolUseId,
        },
        environment,
      );
    }

    await expect(
      readBrowserTaskState(
        hookRuntimeStateDirectory(environment.pluginData),
        hookBrowserTaskScope(sessionId),
      ),
    ).resolves.toMatchObject({ noProgressCount: 0 });
  });

  it("bounds passive browser-route evidence without storing tool ids", async () => {
    const environment = await setup();
    for (let index = 0; index < MAX_BROWSER_ROUTE_OBSERVATIONS + 32; index++) {
      await recordBrowserHookPhase(
        environment.pluginData,
        "PreToolUse",
        {
          definitionHash: environment.definitionHash,
          profileId: "hp_fixture",
          sessionDigest: digestSessionId("bounded-session"),
          synthetic: false,
          toolUseDigest: digestToolUseId(`raw-tool-use-${index}`),
        },
        index,
      );
    }

    const observations = await readBrowserRouteObservations(
      environment.pluginData,
    );
    expect(observations.length).toBeLessThanOrEqual(
      MAX_BROWSER_ROUTE_OBSERVATIONS,
    );
    const persisted = await Promise.all(
      (await allFiles(environment.pluginData)).map((filename) =>
        readFile(filename, "utf8"),
      ),
    );
    expect(persisted.join("\n")).not.toContain("raw-tool-use-");
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
        "Oxrail safety protection: INACTIVE. Oxrail handoff protection: INACTIVE. " +
        "Oxrail credential protection: INACTIVE.",
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
