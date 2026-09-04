import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HostProfileSchema,
  NativePrimitiveSchema,
} from "../packages/protocol/src/index.js";
import {
  formatDoctorReport,
  handleHookEvent,
  HOOK_MARKER_FRESHNESS_MS,
  hookDefinitionHash,
  runDoctor,
} from "../packages/host-openai/src/index.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const fixtureProfile = (definitionHash: string) =>
  HostProfileSchema.parse({
    schemaVersion: 3,
    profileId: "hp_doctor_fixture",
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

async function setup() {
  const pluginRoot = await mkdtemp(path.join(tmpdir(), "oxrail-plugin-"));
  const pluginData = await mkdtemp(path.join(tmpdir(), "oxrail-doctor-"));
  temporaryDirectories.push(pluginRoot, pluginData);
  await Promise.all([
    mkdir(path.join(pluginRoot, ".codex-plugin"), { recursive: true }),
    mkdir(path.join(pluginRoot, "hooks"), { recursive: true }),
    mkdir(path.join(pluginRoot, "skills", "oxrail"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json"),
      '{"name":"oxrail"}\n',
    ),
    writeFile(
      path.join(pluginRoot, "skills", "oxrail", "SKILL.md"),
      "# Oxrail fixture\n",
    ),
    copyFile(
      path.join(process.cwd(), "hooks", "hooks.json"),
      path.join(pluginRoot, "hooks", "hooks.json"),
    ),
  ]);
  const definitionHash = await hookDefinitionHash(pluginRoot);
  await writeFile(
    path.join(pluginData, "host-profile.json"),
    `${JSON.stringify(fixtureProfile(definitionHash))}\n`,
  );
  return {
    definitionHash,
    pluginData,
    pluginRoot,
    currentIdentity: {
      surface: "codex-desktop",
      hostBuild: "fixture-host",
      codexVersion: "fixture-codex",
      computerUsePluginVersion: "fixture-computer-use",
      browserPath: "chrome-extension",
      os: "linux",
    } as const,
  };
}

describe("oxrail doctor", () => {
  it("reports INSTALLED until the host has run the trusted hook definition", async () => {
    const environment = await setup();
    const report = await runDoctor({
      ...environment,
      browserPath: "chrome-extension",
      surface: "codex-desktop",
    });

    expect(report.stage).toBe("INSTALLED");
    expect(report.pluginInstalled).toBe(true);
    expect(report.skillAvailable).toBe(true);
    expect(report.hooksRegistered).toBe(true);
    expect(report.hooksTrusted).toBe(false);
    expect(report.matcherProfileValid).toBe(true);
    expect(report.optimization).toBe("BYPASSED");
    expect(report.safetyProtectionActive).toBe(false);
    expect(report.handoffProtectionActive).toBe(false);
    const formatted = formatDoctorReport(report);
    expect(formatted).toContain("Review and trust");
    expect(formatted).toContain("Plugin package manifest present: PASS");
    expect(formatted).toContain("Oxrail Skill definition present: PASS");
    expect(formatted).toContain("Required Hook definitions present: PASS");
    expect(report.notices).toContain(
      "Package/definition checks are local file-presence checks, not host registry queries.",
    );
    expect(report.notices).toContain(
      "Current-thread Skill availability is proven only by invoking doctor through the Oxrail Skill.",
    );
  });

  it("reports CONFIGURED while passively awaiting the first native browser call", async () => {
    const environment = await setup();
    const sessionId = "configured-browser-session";
    await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: "fixture.safe.probe",
        tool_use_id: "verified-generic-pre",
        tool_input: {},
      },
      environment,
    );
    await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        tool_name: "fixture.safe.probe",
        tool_use_id: "verified-generic-post",
        tool_input: {},
        tool_response: {},
      },
      environment,
    );

    const report = await runDoctor({ ...environment, sessionId });
    expect(report.stage).toBe("CONFIGURED");
    expect(report.preToolUseAvailable).toBe("passed");
    expect(report.postToolUseAvailable).toBe("passed");
    expect(report.chromeComputerUseDetectable).toBe("passed");
    expect(report.firstBrowserHookSeen).toBe(false);
    expect(report.optimization).toBe("BYPASSED");
    expect(report.resultingMode).toBe("ADVISORY_ONLY");
    expect(report.notices).toContain(
      "READY — awaiting first native browser call",
    );
    expect(report.safetyProtectionActive).toBe(false);
    expect(report.handoffProtectionActive).toBe(false);
  });

  it("becomes VERIFIED after both passive browser hook phases are seen", async () => {
    const environment = await setup();
    const browserEvent = {
      session_id: "verified-browser-session",
      tool_name: "fixture.native.browser",
      tool_use_id: "verified-browser-call",
      tool_input: { action: "fixture-no-op" },
    };

    await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id: browserEvent.session_id,
        tool_name: "fixture.safe.probe",
        tool_use_id: "verified-generic-pre",
        tool_input: {},
      },
      environment,
    );
    await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        session_id: browserEvent.session_id,
        tool_name: "fixture.safe.probe",
        tool_use_id: "verified-generic-post",
        tool_input: {},
        tool_response: {},
      },
      environment,
    );
    await handleHookEvent(
      { hook_event_name: "PreToolUse", ...browserEvent },
      environment,
    );
    const duringCall = await runDoctor({
      ...environment,
      sessionId: browserEvent.session_id,
    });
    expect(duringCall.stage).toBe("CONFIGURED");
    expect(duringCall.firstBrowserHookSeen).toBe(true);
    expect(duringCall.optimization).toBe("BYPASSED");

    await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        ...browserEvent,
        tool_response: { ok: true },
      },
      environment,
    );
    const afterCall = await runDoctor({
      ...environment,
      sessionId: browserEvent.session_id,
    });
    expect(afterCall.stage).toBe("VERIFIED");
    expect(afterCall.resultingMode).toBe("ADVISORY_ONLY");
    expect(afterCall.optimization).toBe("BYPASSED");
    expect(afterCall.safetyProtectionActive).toBe(false);
    expect(afterCall.handoffProtectionActive).toBe(false);
    expect(formatDoctorReport(afterCall)).toContain(
      "Handoff protection: INACTIVE",
    );
  });

  it("pairs passive browser verification by one exact tool call", async () => {
    const environment = await setup();
    const session_id = "paired-browser-session";
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await handleHookEvent(
        {
          hook_event_name,
          session_id,
          tool_name: "fixture.safe.probe",
          tool_use_id: `generic-${hook_event_name}`,
          tool_input: {},
        },
        environment,
      );
    }

    await handleHookEvent(
      {
        hook_event_name: "PreToolUse",
        session_id,
        tool_name: "fixture.native.browser",
        tool_use_id: "browser-call-1",
        tool_input: { action: "fixture-no-op" },
      },
      environment,
    );
    await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        session_id,
        tool_name: "fixture.native.browser",
        tool_use_id: "browser-call-2",
        tool_input: { action: "fixture-no-op" },
        tool_response: { ok: true },
      },
      environment,
    );

    const mismatched = await runDoctor({
      ...environment,
      sessionId: session_id,
    });
    expect(mismatched).toMatchObject({
      stage: "CONFIGURED",
      firstBrowserHookSeen: true,
      verificationSource: "none",
    });

    await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        session_id,
        tool_name: "fixture.native.browser",
        tool_use_id: "browser-call-1",
        tool_input: { action: "fixture-no-op" },
        tool_response: { ok: true },
      },
      environment,
    );

    await expect(
      runDoctor({ ...environment, sessionId: session_id }),
    ).resolves.toMatchObject({
      stage: "VERIFIED",
      firstBrowserHookSeen: true,
      verificationSource: "passive-first-browser-call",
    });
  });

  it("does not complete passive verification from an out-of-order Post event", async () => {
    const environment = await setup();
    const session_id = "ordered-browser-session";
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await handleHookEvent(
        {
          hook_event_name,
          session_id,
          tool_name: "fixture.safe.probe",
          tool_use_id: `generic-${hook_event_name}`,
          tool_input: {},
        },
        environment,
      );
    }
    const browserEvent = {
      session_id,
      tool_name: "fixture.native.browser",
      tool_use_id: "out-of-order-browser-call",
      tool_input: { action: "fixture-no-op" },
    };
    await handleHookEvent(
      {
        hook_event_name: "PostToolUse",
        ...browserEvent,
        tool_response: { ok: true },
      },
      environment,
    );
    await handleHookEvent(
      { hook_event_name: "PreToolUse", ...browserEvent },
      environment,
    );

    await expect(
      runDoctor({ ...environment, sessionId: session_id }),
    ).resolves.toMatchObject({
      stage: "CONFIGURED",
      verificationSource: "none",
    });
  });

  it("fails open after hook observations expire", async () => {
    const environment = await setup();
    const observedAt = Date.UTC(2026, 8, 4, 12);
    const sessionId = "session-secret-not-for-disk";
    const hookEnvironment = {
      ...environment,
      now: () => observedAt,
    };
    const browserEvent = {
      session_id: sessionId,
      tool_name: "fixture.native.browser",
      tool_use_id: "expiring-browser-call",
      tool_input: { action: "fixture-no-op" },
    };

    await expect(
      handleHookEvent(
        { hook_event_name: "PreToolUse", ...browserEvent },
        hookEnvironment,
      ),
    ).resolves.toEqual({});
    await expect(
      handleHookEvent(
        {
          hook_event_name: "PostToolUse",
          ...browserEvent,
          tool_response: { ok: true },
        },
        hookEnvironment,
      ),
    ).resolves.toEqual({});

    const fresh = await runDoctor({
      ...environment,
      now: () => observedAt + HOOK_MARKER_FRESHNESS_MS,
      sessionId,
    });
    expect(fresh.stage).toBe("VERIFIED");
    expect(fresh.resultingMode).toBe("ADVISORY_ONLY");
    expect(fresh.optimization).toBe("BYPASSED");

    const otherSession = await runDoctor({
      ...environment,
      now: () => observedAt + 1,
      sessionId: "another-session",
    });
    expect(otherSession.stage).toBe("INSTALLED");
    expect(otherSession.optimization).toBe("BYPASSED");

    const stale = await runDoctor({
      ...environment,
      now: () => observedAt + HOOK_MARKER_FRESHNESS_MS + 1,
      sessionId,
    });
    expect(stale.stage).toBe("INSTALLED");
    expect(stale.hooksTrusted).toBe(false);
    expect(stale.preToolUseAvailable).toBe("unknown");
    expect(stale.postToolUseAvailable).toBe("unknown");
    expect(stale.firstBrowserHookSeen).toBe(true);
    expect(stale.resultingMode).toBe("UNSUPPORTED");
    expect(stale.optimization).toBe("BYPASSED");
    expect(stale.safetyProtectionActive).toBe(false);
    expect(stale.handoffProtectionActive).toBe(false);

    const persistedAfterStale = JSON.parse(
      await readFile(
        path.join(environment.pluginData, "host-profile.json"),
        "utf8",
      ),
    ) as { setup: { lifecycle: string; verificationSource: string } };
    expect(persistedAfterStale.setup).toMatchObject({
      lifecycle: "VERIFIED",
      verificationSource: "passive-first-browser-call",
    });

    const refreshedAt = observedAt + HOOK_MARKER_FRESHNESS_MS + 2;
    const refreshedEnvironment = {
      ...environment,
      now: () => refreshedAt,
    };
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await handleHookEvent(
        {
          hook_event_name,
          session_id: sessionId,
          tool_name: "fixture.safe.probe",
        },
        refreshedEnvironment,
      );
    }
    const recovered = await runDoctor({
      ...refreshedEnvironment,
      sessionId,
    });
    expect(recovered).toMatchObject({
      stage: "VERIFIED",
      firstBrowserHookSeen: true,
      verificationSource: "passive-first-browser-call",
    });
  });

  it("uses a harmless host-provided synthetic probe when available", async () => {
    const environment = await setup();
    const report = await runDoctor({
      ...environment,
      syntheticProbe: async ({ toolMatchers }) => {
        expect(toolMatchers).toEqual(["fixture.native.browser"]);
        return {
          chromeComputerUse: true,
          matcherMatched: true,
          postToolUse: true,
          preToolUse: true,
        };
      },
    });

    expect(report.syntheticProbeUsed).toBe(true);
    expect(report.stage).toBe("VERIFIED");
    expect(report.firstBrowserHookSeen).toBe(true);
  });

  it("does not combine partial synthetic probes from separate runs", async () => {
    const environment = await setup();
    await runDoctor({
      ...environment,
      syntheticProbe: async () => ({
        chromeComputerUse: true,
        matcherMatched: true,
        postToolUse: false,
        preToolUse: true,
      }),
    });

    const report = await runDoctor({
      ...environment,
      syntheticProbe: async () => ({
        chromeComputerUse: true,
        matcherMatched: true,
        postToolUse: true,
        preToolUse: false,
      }),
    });

    expect(report.stage).not.toBe("VERIFIED");
    expect(report.verificationSource).toBe("none");
  });

  it("invalidates setup when the profile carries an old hook hash", async () => {
    const environment = await setup();
    await writeFile(
      path.join(environment.pluginData, "host-profile.json"),
      JSON.stringify(fixtureProfile("0".repeat(64))),
    );
    const report = await runDoctor(environment);

    expect(report.stage).toBe("INSTALLED");
    expect(report.matcherProfileValid).toBe(false);
    expect(report.profileErrors).toContain("hook definition hash changed");
    expect(report.resultingMode).toBe("UNSUPPORTED");
    expect(report.optimization).toBe("BYPASSED");
  });

  it("invalidates a profile when the current Computer Use version changes", async () => {
    const environment = await setup();
    const report = await runDoctor({
      ...environment,
      currentIdentity: {
        ...environment.currentIdentity,
        computerUsePluginVersion: "fixture-computer-use-next",
      },
    });

    expect(report.stage).toBe("INSTALLED");
    expect(report.matcherProfileValid).toBe(false);
    expect(report.profileErrors).toContain(
      "profile computerUsePluginVersion does not match the current host",
    );
    expect(report.optimization).toBe("BYPASSED");
    expect(report.safetyProtectionActive).toBe(false);
    expect(report.handoffProtectionActive).toBe(false);
  });

  it("never claims an unimplemented runtime Handoff adapter", async () => {
    const environment = await setup();
    const profile = fixtureProfile(environment.definitionHash);
    const activeHandoffProfile = HostProfileSchema.parse({
      ...profile,
      setup: {
        ...profile.setup,
        lifecycle: "VERIFIED",
        firstBrowserHookSeen: true,
        verificationSource: "passive-first-browser-call",
        optimization: "ACTIVE",
      },
      handoff: {
        ...profile.handoff,
        activation: "ACTIVE",
        inactiveReasons: [],
        capability: {
          surface: "FOCUSED_REAL_TAB",
          lease: "EXCLUSIVE_USER_LEASE",
          resume: "AUTO_VERIFIED",
          conversationContextPreserved: true,
          sameTabBinding: true,
          originalPlacementRestorable: false,
        },
        sameTabBinding: "passed",
        exclusiveBrowserLease: "passed",
        noAgentObservationDuringLease: "passed",
        nonSecretCompletionDetector: "passed",
        originAndStateVerification: "passed",
        automaticToolOrEventResume: "passed",
      },
      derived: {
        ...profile.derived,
        mode: "MICRO_ACTION_GUARD",
        handoff: "ACTIVE",
      },
    });
    await writeFile(
      path.join(environment.pluginData, "host-profile.json"),
      JSON.stringify(activeHandoffProfile),
    );
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await handleHookEvent(
        {
          hook_event_name,
          session_id: "unconfirmed-host-session",
          tool_name: "fixture.native.browser",
        },
        environment,
      );
    }

    const report = await runDoctor({
      ...environment,
      sessionId: "unconfirmed-host-session",
    });
    expect(report).toMatchObject({
      stage: "VERIFIED",
      resultingMode: "ADVISORY_ONLY",
      optimization: "BYPASSED",
      handoffProtectionActive: false,
    });
    expect(report.handoffInactiveReasons).toContain(
      "runtime handoff adapter is not active in this build",
    );
  });

  it("keeps an explicitly disabled Hook profile disabled", async () => {
    const environment = await setup();
    const profile = fixtureProfile(environment.definitionHash);
    const disabledProfile = HostProfileSchema.parse({
      ...profile,
      setup: {
        ...profile.setup,
        lifecycle: "INSTALLED",
        hooksTrusted: "unknown",
        preToolUseAvailable: "unknown",
        postToolUseAvailable: "unknown",
        firstBrowserHookSeen: false,
        verificationSource: "none",
        optimization: "BYPASSED",
      },
      hooks: { ...profile.hooks, trustState: "disabled" },
      derived: {
        ...profile.derived,
        mode: "UNSUPPORTED",
        safety: "INACTIVE",
        handoff: "INACTIVE",
      },
    });
    await writeFile(
      path.join(environment.pluginData, "host-profile.json"),
      JSON.stringify(disabledProfile),
    );
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await handleHookEvent(
        {
          hook_event_name,
          session_id: "disabled-session",
          tool_name: "fixture.native.browser",
        },
        environment,
      );
    }

    const report = await runDoctor({
      ...environment,
      sessionId: "disabled-session",
    });
    expect(report).toMatchObject({
      stage: "INSTALLED",
      hooksTrusted: false,
      optimization: "BYPASSED",
      safetyProtectionActive: false,
      handoffProtectionActive: false,
    });
    const persisted = JSON.parse(
      await readFile(
        path.join(environment.pluginData, "host-profile.json"),
        "utf8",
      ),
    ) as { hooks: { trustState: string } };
    expect(persisted.hooks.trustState).toBe("disabled");
  });

  it("fails open when a setup transition cannot be persisted", async () => {
    const environment = await setup();
    const browserEvent = {
      session_id: "persistence-session",
      tool_name: "fixture.native.browser",
    };
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await handleHookEvent({ hook_event_name, ...browserEvent }, environment);
    }

    const report = await runDoctor({
      ...environment,
      sessionId: "persistence-session",
      persistProfile: async () => {
        throw new Error("fixture write failure");
      },
    });
    expect(report).toMatchObject({
      stage: "INSTALLED",
      optimization: "BYPASSED",
      safetyProtectionActive: false,
      handoffProtectionActive: false,
      resultingMode: "UNSUPPORTED",
    });
    expect(report.safetyInactiveReasons).toContain(
      "setup state could not be persisted",
    );
  });
});
