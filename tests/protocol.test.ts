import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateProtocolSchemas } from "../packages/protocol/src/generate.js";
import {
  CREDENTIAL_ACTIVATION_UNAVAILABLE_ERROR,
  validateHostProfile,
  writeHostProfile,
} from "../packages/host-openai/src/profile.js";
import {
  BrowserTaskStateSchema,
  HostProfileSchema,
  NativePrimitiveSchema,
  ReasonCodeSchema,
  SetupVerificationSchema,
  redactedDeterministicDigest,
  toolRegistryManifestBinding,
} from "../packages/protocol/src/index.js";

const unknown = "unknown" as const;
const sha = "a".repeat(64);

function hostProfile() {
  const verdicts = {
    text: unknown,
    structured: unknown,
    image: unknown,
    error: unknown,
    attachment: unknown,
  };
  return {
    schemaVersion: 5,
    profileId: "hp_test",
    setup: {
      lifecycle: "INSTALLED",
      pluginInstalled: "passed",
      skillAvailable: "passed",
      hooksRegistered: "passed",
      hooksTrusted: unknown,
      preToolUseAvailable: unknown,
      postToolUseAvailable: unknown,
      chromeComputerUseDetectable: unknown,
      matcherProfileValid: unknown,
      syntheticProbe: unknown,
      firstBrowserHookSeen: false,
      verificationSource: "none",
      optimization: "BYPASSED",
    },
    identity: {
      surface: "codex-desktop",
      hostBuild: "test",
      browserPath: "chrome-extension",
      os: "linux",
    },
    route: {
      toolRoute: "direct-mcp",
      canonicalToolMatchers: ["computer.use"],
      matcherEvidenceHash: sha,
      browserTools: [],
    },
    action: {
      control: "MICRO_ACTION",
      preToolCoverage: {
        observed: 0,
        expected: 0,
        bypassCases: [],
        confidence: "UNKNOWN",
      },
      denyPreventedSideEffect: unknown,
      rewriteFidelity: unknown,
    },
    nativeInteraction: {
      fidelity: "UNKNOWN",
      pointerOwnerInRunning: unknown,
      passThroughFingerprint: unknown,
      primitiveParity: Object.fromEntries(
        NativePrimitiveSchema.options.map((primitive) => [primitive, unknown]),
      ),
      cursorVisualization: unknown,
      viewportCoordinateMapping: unknown,
      screenshotFrameFeedback: unknown,
      unexpectedPointerInterference: unknown,
      unexpectedFocusInterference: unknown,
      unexpectedScrollInterference: unknown,
      incorrectNormalActionBlocks: unknown,
      overlayPolicy: unknown,
    },
    result: {
      postToolCoverage: {
        observed: 0,
        expected: 0,
        bypassCases: [],
        confidence: "UNKNOWN",
      },
      control: "NONE",
      replacementTiming: unknown,
      media: verdicts,
      codeModePromiseSemantics: unknown,
      controlCriticalContract: {
        status: unknown,
        requiredFields: [],
        conditionalFields: [],
        unknownFields: [],
        testedNextStepPrimitives: [],
      },
      rawPersistence: [unknown],
    },
    hooks: {
      policy: unknown,
      trustState: "review-required",
      definitionHash: sha,
      concurrentConflictProbe: unknown,
    },
    nativeCapabilities: {
      outputTokenLimit: unknown,
      webMcp: unknown,
      structuredObservation: unknown,
      readOnlyDeveloperTools: unknown,
      nativeApprovalFlow: unknown,
    },
    handoff: {
      activation: "INACTIVE",
      inactiveReasons: ["unverified"],
      capability: {
        surface: "NONE",
        lease: "NONE",
        resume: "NONE",
        conversationContextPreserved: false,
        sameTabBinding: false,
        originalPlacementRestorable: false,
      },
      conversationContinuity: unknown,
      sameTabBinding: unknown,
      detachRealTabWindow: unknown,
      focusExistingTab: unknown,
      exclusiveBrowserLease: unknown,
      noAgentObservationDuringLease: unknown,
      nonSecretCompletionDetector: unknown,
      originAndStateVerification: unknown,
      restoreOriginalWindowIndex: unknown,
      restorePinnedAndGroupState: unknown,
      automaticToolOrEventResume: unknown,
      oneClickFallback: unknown,
      chatMessageRequired: unknown,
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
      probeSuiteVersion: "0.1",
      fixtureRevision: "fixture",
      traceManifestHash: sha,
      testedAt: "2026-09-04T00:00:00.000Z",
      validUntilHostChange: true,
      unresolved: [],
    },
    derived: {
      mode: "UNSUPPORTED",
      safety: "INACTIVE",
      handoff: "INACTIVE",
      credentialProtection: "INACTIVE",
      allowedClaims: [],
      forbiddenClaims: ["enforcement"],
    },
  } as const;
}

describe("versioned protocol", () => {
  it("does not make low-entropy secret values dictionary-testable", () => {
    const digest = redactedDeterministicDigest("evidence", {
      action: "type",
      otp: "000000",
    });

    expect(
      redactedDeterministicDigest("evidence", {
        action: "type",
        otp: "831924",
      }),
    ).toBe(digest);
    expect(
      redactedDeterministicDigest("evidence", {
        action: "click",
        otp: "831924",
      }),
    ).not.toBe(digest);
  });

  it("does not inspect an opaque sensitive value before redaction", () => {
    const cyclicSecret: Record<string, unknown> = {};
    cyclicSecret.self = cyclicSecret;

    expect(() =>
      redactedDeterministicDigest("evidence", {
        action: "type",
        password: cyclicSecret,
      }),
    ).not.toThrow();
  });

  it("round-trips the v5 HostProfile and rejects the previous version", () => {
    const parsed = HostProfileSchema.parse(hostProfile());
    expect(HostProfileSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
    expect(ReasonCodeSchema.safeParse("OXRAIL_MADE_UP").success).toBe(false);
    expect(
      HostProfileSchema.safeParse({ ...hostProfile(), schemaVersion: 4 })
        .success,
    ).toBe(false);
    expect(
      validateHostProfile({ ...hostProfile(), schemaVersion: 4 }).errors,
    ).toEqual([
      "host profile schema v4 is stale; run Oxrail setup to create a v5 profile",
    ]);
    expect(
      validateHostProfile({ ...hostProfile(), schemaVersion: 3 }).errors,
    ).toEqual([
      "host profile schema v3 is stale; run Oxrail setup to create a v5 profile",
    ]);
  });

  it("requires externally pinned browser contracts before optimization", () => {
    const active = {
      ...hostProfile(),
      setup: {
        ...hostProfile().setup,
        lifecycle: "VERIFIED",
        hooksTrusted: "passed",
        preToolUseAvailable: "passed",
        postToolUseAvailable: "passed",
        chromeComputerUseDetectable: "passed",
        matcherProfileValid: "passed",
        syntheticProbe: "passed",
        verificationSource: "synthetic-probe",
        optimization: "ACTIVE",
      },
      hooks: { ...hostProfile().hooks, trustState: "active" },
      derived: { ...hostProfile().derived, mode: "MICRO_ACTION_GUARD" },
    } as const;

    expect(HostProfileSchema.safeParse(active).success).toBe(false);
    const pinned = {
      ...active,
      route: {
        ...active.route,
        toolSchemaRegistryHash: "b".repeat(64),
        toolSchemaRegistryEvidenceId: "EVID-HOST-TOOL-SCHEMA-001",
        browserTools: [
          {
            canonicalToolName: "computer.use",
            inputSchemaHash: "c".repeat(64),
            registryManifestBinding: toolRegistryManifestBinding({
              profileId: "hp_test",
              definitionHash: sha,
              matcherEvidenceHash: sha,
              toolSchemaRegistryHash: "b".repeat(64),
              toolSchemaRegistryEvidenceId: "EVID-HOST-TOOL-SCHEMA-001",
              canonicalToolName: "computer.use",
              inputSchemaHash: "c".repeat(64),
            }),
          },
        ],
      },
    } as const;
    expect(HostProfileSchema.safeParse(pinned).success).toBe(true);
    expect(
      HostProfileSchema.safeParse({
        ...pinned,
        route: {
          ...pinned.route,
          browserTools: [
            {
              ...pinned.route.browserTools[0],
              registryManifestBinding: "d".repeat(64),
            },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("keeps structurally valid credential activation behind the native verifier", async () => {
    const active = {
      ...hostProfile(),
      setup: {
        ...hostProfile().setup,
        lifecycle: "VERIFIED",
        hooksTrusted: "passed",
        preToolUseAvailable: "passed",
        postToolUseAvailable: "passed",
        chromeComputerUseDetectable: "passed",
        matcherProfileValid: "passed",
        syntheticProbe: "passed",
        verificationSource: "synthetic-probe",
        optimization: "ACTIVE",
      },
      identity: { ...hostProfile().identity, os: "macos" },
      route: {
        ...hostProfile().route,
        toolSchemaRegistryHash: "1".repeat(64),
        toolSchemaRegistryEvidenceId: "EVID-HOST-CREDENTIAL-FIXTURE",
        browserTools: [
          {
            canonicalToolName: "computer.use",
            inputSchemaHash: "2".repeat(64),
            registryManifestBinding: toolRegistryManifestBinding({
              profileId: "hp_test",
              definitionHash: sha,
              matcherEvidenceHash: sha,
              toolSchemaRegistryHash: "1".repeat(64),
              toolSchemaRegistryEvidenceId: "EVID-HOST-CREDENTIAL-FIXTURE",
              canonicalToolName: "computer.use",
              inputSchemaHash: "2".repeat(64),
            }),
          },
        ],
      },
      hooks: { ...hostProfile().hooks, trustState: "active" },
      handoff: {
        ...hostProfile().handoff,
        activation: "ACTIVE",
        inactiveReasons: [],
        capability: {
          surface: "FOCUSED_REAL_TAB",
          lease: "EXCLUSIVE_USER_LEASE",
          resume: "AUTO_VERIFIED",
          conversationContextPreserved: true,
          sameTabBinding: true,
          originalPlacementRestorable: true,
        },
        conversationContinuity: "passed",
        sameTabBinding: "passed",
        focusExistingTab: "passed",
        exclusiveBrowserLease: "passed",
        noAgentObservationDuringLease: "passed",
        nonSecretCompletionDetector: "passed",
        originAndStateVerification: "passed",
        automaticToolOrEventResume: "passed",
      },
      credentialChannel: {
        activation: "ACTIVE",
        inactiveReasons: [],
        capability: {
          platform: "macos",
          surface: "MACOS_NATIVE_SECURE_PROMPT",
          storage: "MACOS_KEYCHAIN",
          acceptedKinds: ["API_KEY"],
          consumerMode: "REGISTERED_IN_ENCLAVE_ADAPTER_ONLY",
          consumerReadiness: "AUDITED_REAL_CONSUMER",
          opaqueReferenceOnly: true,
          genericSecretExport: "DENIED",
        },
        helperIdentity: "passed",
        helperBundleId: "dev.oxrail.credentials",
        helperBuild: "fixture-build",
        helperCodeDirectoryHash: "b".repeat(40),
        helperTeamId: "ABCDE12345",
        helperDesignatedRequirement:
          'identifier "dev.oxrail.credentials" and anchor apple generic',
        launcherIdentity: "passed",
        launcherBundleId: "dev.oxrail.launcher",
        launcherBuild: "fixture-launcher-build",
        launcherCodeDirectoryHash: "0".repeat(40),
        launcherTeamId: "ABCDE12345",
        launcherDesignatedRequirement:
          'identifier "dev.oxrail.launcher" and anchor apple generic',
        secureInput: "passed",
        agentExecutionIsolation: "passed",
        pasteboardHygiene: "passed",
        templateRegistryHash: "c".repeat(64),
        consumerRegistryHash: "d".repeat(64),
        registryManifestHash: "e".repeat(64),
        registryManifestVerification: "passed",
        registryVersion: 2,
        registryRollbackFloor: 1,
        credentialEvidenceManifestHash: "f".repeat(64),
        secretLeakBench: "passed",
        realConsumerProbe: "passed",
        keychainRoundTrip: "passed",
        opaqueRefOnly: "passed",
        scopeBinding: "passed",
        expiryAndRevocation: "passed",
        genericExportDenied: "passed",
      },
      derived: {
        ...hostProfile().derived,
        mode: "MICRO_ACTION_GUARD",
        handoff: "ACTIVE",
        credentialProtection: "ACTIVE",
      },
    } as const;

    expect(HostProfileSchema.safeParse(active).success).toBe(true);
    for (const invalidCodeDirectoryHash of [
      "a".repeat(39),
      "a".repeat(41),
      "A".repeat(40),
      "g".repeat(40),
    ]) {
      expect(
        HostProfileSchema.safeParse({
          ...active,
          credentialChannel: {
            ...active.credentialChannel,
            helperCodeDirectoryHash: invalidCodeDirectoryHash,
          },
        }).success,
      ).toBe(false);
    }
    expect(validateHostProfile(active)).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([CREDENTIAL_ACTIVATION_UNAVAILABLE_ERROR]),
    });
    const pluginData = await mkdtemp(join(tmpdir(), "oxrail-profile-write-"));
    try {
      await expect(writeHostProfile(pluginData, active)).rejects.toThrow(
        CREDENTIAL_ACTIVATION_UNAVAILABLE_ERROR,
      );
      await expect(
        writeHostProfile(pluginData, hostProfile()),
      ).resolves.toEqual(hostProfile());
    } finally {
      await rm(pluginData, { force: true, recursive: true });
    }
    expect(
      HostProfileSchema.safeParse({
        ...active,
        identity: { ...active.identity, browserPath: "built-in-browser" },
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        handoff: {
          ...active.handoff,
          nonSecretCompletionDetector: "unknown",
        },
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        handoff: {
          ...active.handoff,
          originAndStateVerification: "unknown",
        },
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        handoff: hostProfile().handoff,
        derived: { ...active.derived, handoff: "INACTIVE" },
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        identity: { ...active.identity, os: "windows" },
      }).success,
    ).toBe(false);
    const { helperTeamId: _helperTeamId, ...withoutPinnedSigner } =
      active.credentialChannel;
    expect(
      HostProfileSchema.safeParse({
        ...active,
        credentialChannel: withoutPinnedSigner,
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        credentialChannel: {
          ...active.credentialChannel,
          launcherBundleId: active.credentialChannel.helperBundleId,
        },
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        credentialChannel: {
          ...active.credentialChannel,
          capability: {
            ...active.credentialChannel.capability,
            consumerReadiness: "FIXTURE_ONLY",
          },
        },
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        credentialChannel: {
          ...active.credentialChannel,
          secretLeakBench: "failed",
        },
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        credentialChannel: {
          ...active.credentialChannel,
          agentExecutionIsolation: "failed",
        },
      }).success,
    ).toBe(false);
    expect(
      HostProfileSchema.safeParse({
        ...active,
        credentialChannel: {
          ...active.credentialChannel,
          registryVersion: 1,
          registryRollbackFloor: 2,
        },
      }).success,
    ).toBe(false);
  });

  it("requires explicit setup state and inactive protection while bypassed", () => {
    const result = SetupVerificationSchema.safeParse({
      schemaVersion: 1,
      stage: "INSTALLED",
      pluginInstalled: true,
      skillAvailable: true,
      hooksRegistered: true,
      hooksTrusted: false,
      preToolUseAvailable: unknown,
      postToolUseAvailable: unknown,
      chromeComputerUseDetectable: unknown,
      matcherProfileValid: false,
      handoffCapability: hostProfile().handoff.capability,
      syntheticProbeUsed: false,
      firstBrowserHookSeen: false,
      verificationSource: "none",
      optimization: "BYPASSED",
      safetyProtectionActive: false,
      handoffProtectionActive: false,
      credentialProtectionActive: false,
      resultingMode: "UNSUPPORTED",
    });
    expect(result.success).toBe(true);
    if (!result.success) throw result.error;
    expect(
      SetupVerificationSchema.safeParse({
        ...result.data,
        credentialProtectionActive: true,
      }).success,
    ).toBe(false);
  });

  it("rejects unknown BrowserTaskState fields", () => {
    expect(
      BrowserTaskStateSchema.safeParse({
        schemaVersion: 3,
        sessionId: "s",
        taskId: "t",
        goalSummary: "safe",
        hostProfileId: "hp",
        hostProfileStatus: "VALID",
        mode: "ADVISORY_ONLY",
        phase: "RUNNING",
        revision: 0,
        noProgressCount: 0,
        recoveryLevel: 0,
        recoveryTransitions: 0,
        authState: "UNKNOWN",
        leaseEpoch: 0,
        pointerOwner: "NATIVE",
        targetCacheEpoch: 0,
        pendingNativeActionIds: [],
        stateVersion: 0,
        password: "must not become a field",
      }).success,
    ).toBe(false);
  });

  it("rejects contradictory Handoff phase and ownership state", () => {
    const running = {
      schemaVersion: 3,
      sessionId: "s",
      taskId: "t",
      goalSummary: "safe",
      hostProfileId: "hp",
      hostProfileStatus: "VALID",
      mode: "ADVISORY_ONLY",
      phase: "RUNNING",
      revision: 0,
      noProgressCount: 0,
      recoveryLevel: 0,
      recoveryTransitions: 0,
      authState: "UNKNOWN",
      leaseEpoch: 0,
      pointerOwner: "NATIVE",
      targetCacheEpoch: 0,
      pendingNativeActionIds: [],
      stateVersion: 0,
    } as const;

    expect(
      BrowserTaskStateSchema.safeParse({
        ...running,
        phase: "USER_LEASE_ACTIVE",
        pointerOwner: "NATIVE",
      }).success,
    ).toBe(false);
    expect(
      BrowserTaskStateSchema.safeParse({
        ...running,
        activeHandoffId: "handoff",
        pendingNativeActionIds: ["pending"],
        phase: "USER_LEASE_ACTIVE",
        pointerOwner: "HUMAN",
      }).success,
    ).toBe(false);
    expect(
      BrowserTaskStateSchema.safeParse({
        ...running,
        pendingNativeActionIds: ["pending"],
        phase: "DONE",
        pointerOwner: "NONE",
      }).success,
    ).toBe(false);
  });

  it("generates byte-deterministic, stable JSON schema filenames", async () => {
    const first = await mkdtemp(join(tmpdir(), "oxrail-schema-a-"));
    const second = await mkdtemp(join(tmpdir(), "oxrail-schema-b-"));
    await generateProtocolSchemas(first);
    await generateProtocolSchemas(second);
    const names = (await readdir(first)).sort();
    expect(names).toContain("host-profile.schema.json");
    const hostProfileJson = await readFile(
      join(first, "host-profile.schema.json"),
      "utf8",
    );
    expect(hostProfileJson).toContain('"maxItems": 1');
    expect(hostProfileJson).toContain('"maxItems": 0');
    expect(hostProfileJson).not.toContain('"prefixItems"');
    expect(hostProfileJson).toContain(
      "generated JSON Schema validates the exchange shape only",
    );
    expect(hostProfileJson).toContain(
      "Neither authorizes credential activation",
    );
    expect(names).toContain("browser-task-state.schema.json");
    for (const name of names) {
      expect(await readFile(join(first, name), "utf8")).toBe(
        await readFile(join(second, name), "utf8"),
      );
    }
  });
});
