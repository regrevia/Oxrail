import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateProtocolSchemas } from "../packages/protocol/src/generate.js";
import {
  CREDENTIAL_ACTIVATION_UNAVAILABLE_ERROR,
  hostProfileBindingHash,
  validateHostProfile,
  writeHostProfile,
} from "../packages/host-openai/src/profile.js";
import {
  BrowserTaskStateSchema,
  HandoffCurrentTabReceiptSchema,
  HandoffCompletionSignalSchema,
  HandoffRequestSchema,
  HandoffResultSchema,
  HandoffToolInputSchema,
  HandoffToolResultSchema,
  HandoffVerificationMarkerSchema,
  HandoffVerificationSampleSchema,
  HostProfileSchema,
  NativePrimitiveSchema,
  ReasonCodeSchema,
  SetupVerificationSchema,
  redactedDeterministicDigest,
  toolRegistryManifestBinding,
} from "../packages/protocol/src/index.js";

const unknown = "unknown" as const;
const sha = "a".repeat(64);
const handoffNonce = "A".repeat(43);

const handoffToolInput = () => ({
  schemaVersion: 1 as const,
  type: "MFA_REQUIRED" as const,
});

const handoffRequest = () => ({
  schemaVersion: 1 as const,
  handoffId: "handoff-1",
  sessionId: "session-1",
  taskId: "task-1",
  toolUseId: "tool-1",
  leaseEpoch: 2,
  nonce: handoffNonce,
  type: "MFA_REQUIRED" as const,
  tabBinding: {
    tabId: 17,
    windowId: 7,
    index: 1,
    topOrigin: "https://accounts.example.test",
    allowedRedirectOrigins: ["https://id.example.test"],
    initialDocumentBinding: "document-1",
  },
  completionPolicy: "AUTH_FLOW_COMPLETED" as const,
  timeoutMs: 300_000,
  createdAt: 1_000,
});

const handoffCompletionSignal = () => ({
  schemaVersion: 1 as const,
  handoffId: "handoff-1",
  sessionId: "session-1",
  taskId: "task-1",
  leaseEpoch: 2,
  nonce: handoffNonce,
  tabId: 17,
  initialDocumentBinding: "document-1",
  observedDocumentBinding: "document-2",
  origin: "https://accounts.example.test",
  source: "ISOLATED_VERIFIER" as const,
  kind: "AUTH_MARKER_PRESENT" as const,
  confidence: "DETERMINISTIC" as const,
  observedAt: 2_000,
});

const handoffVerificationSample = () => ({
  schemaVersion: 1 as const,
  handoffId: "handoff-1",
  sessionId: "session-1",
  taskId: "task-1",
  leaseEpoch: 2,
  nonce: handoffNonce,
  probeSequence: 1,
  verifierContextBindingHash: sha,
  tabId: 17,
  initialDocumentBinding: "document-1",
  observedDocumentBinding: "document-2",
  origin: "https://accounts.example.test",
  stateEpoch: 3,
  completionState: "CONFIRMED" as const,
  automaticPhase: "AUTH_MARKER_PRESENT" as const,
  tabState: "BOUND" as const,
  navigationState: "IDLE" as const,
  redirectState: "CONTINUOUSLY_ALLOWED" as const,
  sensitivePhase: "CLEARED" as const,
});

const handoffVerificationMarker = () => ({
  schemaVersion: 1 as const,
  authority: "FIXTURE_ONLY_NON_AUTHORIZING" as const,
  leaseEpoch: 2,
  candidateDigest: "a".repeat(64),
  activationAnchorDigest: "b".repeat(64),
  currentTabReceiptDigest: "c".repeat(64),
  verifierContextBindingHash: "d".repeat(64),
  stateEpoch: 3,
  firstProbeSequence: 10,
  secondProbeSequence: 11,
  basis: "DETERMINISTIC" as const,
  phaseSignal: "AUTH_MARKER_PRESENT" as const,
});

const handoffCurrentTabReceipt = () => ({
  schemaVersion: 1 as const,
  authority: "FIXTURE_ONLY_NON_AUTHORIZING" as const,
  candidateDigest: "a".repeat(64),
  admissionGeneration: 2,
  hostProfileBindingHash: "b".repeat(64),
  browserInstanceBindingHash: "c".repeat(64),
  activationNativeActionFenceHash: "d".repeat(64),
  activationTabBindingReceiptHash: "e".repeat(64),
  completionNativeActionFenceHash: "f".repeat(64),
  completionReceiptHash: "1".repeat(64),
  exclusiveTabLease: "HELD" as const,
  agentActionLane: "SUSPENDED" as const,
  agentObservationLane: "SUSPENDED" as const,
  tabId: 17,
  initialDocumentBinding: "document-1",
  observedDocumentBinding: "document-2",
  origin: "http://127.0.0.1:4173",
  verifierContextBindingHash: "2".repeat(64),
  stateEpoch: 3,
  lastAcceptedProbeSequence: 11,
  completionState: "CONFIRMED" as const,
  automaticPhase: "AUTH_MARKER_PRESENT" as const,
  tabState: "BOUND" as const,
  navigationState: "IDLE" as const,
  redirectState: "CONTINUOUSLY_ALLOWED" as const,
  sensitivePhase: "CLEARED" as const,
});

const handoffResult = () => ({
  schemaVersion: 1 as const,
  handoffId: "handoff-1",
  sessionId: "session-1",
  taskId: "task-1",
  leaseEpoch: 2,
  nonce: handoffNonce,
  completionPolicy: "AUTH_FLOW_COMPLETED" as const,
  outcome: "VERIFIED_COMPLETE" as const,
  finalOrigin: "https://accounts.example.test",
  phaseSignal: "AUTH_MARKER_PRESENT" as const,
  sameTab: true,
  tabRestored: true,
  agentLeaseRestored: true,
  secretObserved: false as const,
});

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

  it("binds Host receipts to complete current Profile content", () => {
    const profile = HostProfileSchema.parse(hostProfile());
    const drifted = {
      ...profile,
      setup: { ...profile.setup, firstBrowserHookSeen: true },
    };

    expect(drifted.profileId).toBe(profile.profileId);
    expect(hostProfileBindingHash(drifted)).not.toBe(
      hostProfileBindingHash(profile),
    );
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

  it("round-trips the five non-authorizing Handoff wire contracts", () => {
    expect(HandoffToolInputSchema.parse(handoffToolInput())).toEqual(
      handoffToolInput(),
    );
    expect(HandoffRequestSchema.parse(handoffRequest())).toEqual(
      handoffRequest(),
    );
    expect(
      HandoffCompletionSignalSchema.parse(handoffCompletionSignal()),
    ).toEqual(handoffCompletionSignal());
    expect(HandoffResultSchema.parse(handoffResult())).toEqual(handoffResult());
    const {
      handoffId: _handoffId,
      sessionId: _sessionId,
      taskId: _taskId,
      leaseEpoch: _leaseEpoch,
      nonce: _nonce,
      completionPolicy: _completionPolicy,
      finalOrigin: _finalOrigin,
      ...toolResult
    } = handoffResult();
    expect(HandoffToolResultSchema.parse(toolResult)).toEqual(toolResult);
    expect(
      HandoffRequestSchema.safeParse({
        ...handoffRequest(),
        tabBinding: {
          ...handoffRequest().tabBinding,
          topOrigin: "http://127.0.0.1:4173",
          allowedRedirectOrigins: ["https://id.example.test"],
        },
      }).success,
    ).toBe(true);
  });

  it("keeps Host-owned Handoff binding fields out of Agent input", () => {
    for (const forbidden of [
      { reason: "page supplied text" },
      { tabId: 17 },
      { origin: "https://accounts.example.test" },
      { allowedRedirectOrigins: ["https://evil.example.test"] },
      { sessionId: "session-1" },
      { leaseEpoch: 2 },
      { nonce: handoffNonce },
      { completionPolicy: "AUTH_FLOW_COMPLETED" },
      { timeoutMs: 300_000 },
      { password: "content-canary" },
    ]) {
      expect(
        HandoffToolInputSchema.safeParse({
          ...handoffToolInput(),
          ...forbidden,
        }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { ...handoffToolInput(), schemaVersion: 2 },
      { ...handoffToolInput(), type: "PAGE_DEFINED" },
    ]) {
      expect(HandoffToolInputSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("validates exact Handoff request and completion bindings", () => {
    const request = handoffRequest();
    const policyByType = {
      AUTH_REQUIRED: "AUTH_FLOW_COMPLETED",
      MFA_REQUIRED: "AUTH_FLOW_COMPLETED",
      PASSKEY_REQUIRED: "AUTH_FLOW_COMPLETED",
      CAPTCHA_REQUIRED: "AUTH_FLOW_COMPLETED",
      SENSITIVE_INPUT: "AUTH_FLOW_COMPLETED",
      PERMISSION_REQUIRED: "DIALOG_OR_ROUTE_COMPLETED",
      HIGH_IMPACT_CONFIRMATION: "DIALOG_OR_ROUTE_COMPLETED",
      FILE_PICKER_REQUIRED: "DIALOG_OR_ROUTE_COMPLETED",
      OS_DIALOG_REQUIRED: "DIALOG_OR_ROUTE_COMPLETED",
      UNKNOWN_MANUAL_BOUNDARY: "MANUAL_DONE_THEN_VERIFY",
    } as const;
    for (const [type, completionPolicy] of Object.entries(policyByType)) {
      expect(
        HandoffRequestSchema.safeParse({
          ...request,
          type,
          completionPolicy,
        }).success,
      ).toBe(true);
      expect(
        HandoffRequestSchema.safeParse({
          ...request,
          type,
          completionPolicy:
            completionPolicy === "AUTH_FLOW_COMPLETED"
              ? "DIALOG_OR_ROUTE_COMPLETED"
              : "AUTH_FLOW_COMPLETED",
        }).success,
      ).toBe(false);
    }
    for (const invalid of [
      { ...request, handoffId: "bad\0id" },
      { ...request, taskId: "bad\nid" },
      { ...request, sessionId: "s".repeat(4_097) },
      { ...request, leaseEpoch: 0 },
      { ...request, nonce: "A".repeat(42) },
      { ...request, nonce: "A".repeat(44) },
      { ...request, nonce: `${"A".repeat(42)}!` },
      { ...request, nonce: `${"A".repeat(42)}n` },
      { ...request, timeoutMs: 999 },
      { ...request, timeoutMs: 900_001 },
      {
        ...request,
        createdAt: Number.MAX_SAFE_INTEGER,
        timeoutMs: 1_000,
      },
      {
        ...request,
        tabBinding: {
          ...request.tabBinding,
          topOrigin: "http://accounts.example.test",
        },
      },
      {
        ...request,
        tabBinding: {
          ...request.tabBinding,
          topOrigin: "http://localhost:4173",
        },
      },
      {
        ...request,
        tabBinding: {
          ...request.tabBinding,
          topOrigin: "https://accounts.example.test/path",
        },
      },
      {
        ...request,
        tabBinding: {
          ...request.tabBinding,
          allowedRedirectOrigins: [
            "https://id.example.test",
            "https://id.example.test",
          ],
        },
      },
      {
        ...request,
        tabBinding: {
          ...request.tabBinding,
          allowedRedirectOrigins: [request.tabBinding.topOrigin],
        },
      },
      {
        ...request,
        tabBinding: {
          ...request.tabBinding,
          allowedRedirectOrigins: Array.from(
            { length: 9 },
            (_, index) => `https://id-${index}.example.test`,
          ),
        },
      },
      { ...request, display: { instruction: "enter a secret" } },
    ]) {
      expect(HandoffRequestSchema.safeParse(invalid).success).toBe(false);
    }

    const signal = handoffCompletionSignal();
    for (const valid of [
      {
        ...signal,
        source: "EXTENSION_OWNED_UI",
        kind: "MANUAL_DONE",
        confidence: "USER_ASSERTED",
      },
      {
        ...signal,
        source: "EXTENSION_OWNED_UI",
        kind: "CANCELLED",
        confidence: "USER_ASSERTED",
      },
      { ...signal, kind: "UNSAFE_ORIGIN", confidence: "DETERMINISTIC" },
      { ...signal, kind: "EXPECTED_ROUTE", confidence: "HEURISTIC" },
    ]) {
      expect(HandoffCompletionSignalSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      { ...signal, kind: "MANUAL_DONE", confidence: "DETERMINISTIC" },
      {
        ...signal,
        source: "ISOLATED_VERIFIER",
        kind: "CANCELLED",
        confidence: "USER_ASSERTED",
      },
      {
        ...signal,
        source: "EXTENSION_OWNED_UI",
        kind: "EXPECTED_ROUTE",
        confidence: "DETERMINISTIC",
      },
      { ...signal, kind: "UNSAFE_ORIGIN", confidence: "HEURISTIC" },
      { ...signal, kind: "EXPECTED_ROUTE", confidence: "USER_ASSERTED" },
      { ...signal, observedAt: Number.MAX_SAFE_INTEGER + 1 },
      { ...signal, source: "PAGE_SCRIPT" },
      { ...signal, value: "content-canary" },
      { ...signal, text: "content-canary" },
      { ...signal, clipboard: "content-canary" },
      { ...signal, screenshot: "content-canary" },
      { ...signal, cookie: "content-canary" },
      { ...signal, token: "content-canary" },
      { ...signal, fullUrl: "https://accounts.example.test/private?q=x" },
      { ...signal, origin: "https://accounts.example.test/path?secret=x" },
    ]) {
      expect(HandoffCompletionSignalSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("accepts only non-secret, internally consistent Handoff verification samples", () => {
    const sample = handoffVerificationSample();
    expect(HandoffVerificationSampleSchema.parse(sample)).toEqual(sample);

    for (const invalid of [
      { ...sample, verifierContextBindingHash: "A".repeat(64) },
      { ...sample, stateEpoch: 0 },
      {
        ...sample,
        completionState: "NOT_CONFIRMED",
        automaticPhase: "AUTH_MARKER_PRESENT",
      },
      {
        ...sample,
        completionState: "UNKNOWN",
        automaticPhase: "EXPECTED_ROUTE",
      },
      { ...sample, secret: "content-canary" },
      { ...sample, fullUrl: "https://accounts.example.test/private?q=x" },
      { ...sample, DOM: "content-canary" },
    ]) {
      expect(HandoffVerificationSampleSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("accepts only strict, timestamp-free fixture current-tab receipts", () => {
    const receipt = handoffCurrentTabReceipt();
    expect(HandoffCurrentTabReceiptSchema.parse(receipt)).toEqual(receipt);

    for (const invalid of [
      { ...receipt, candidateDigest: "A".repeat(64) },
      { ...receipt, admissionGeneration: Number.MAX_SAFE_INTEGER + 1 },
      {
        ...receipt,
        completionState: "UNKNOWN",
        automaticPhase: "AUTH_MARKER_PRESENT",
      },
      { ...receipt, observedAt: 1_000 },
      { ...receipt, fullUrl: "http://127.0.0.1:4173/private?secret=x" },
      { ...receipt, secret: "content-canary" },
    ]) {
      expect(HandoffCurrentTabReceiptSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
  });

  it("allows only consistent, secret-free Handoff results", () => {
    const result = handoffResult();
    const {
      handoffId: _handoffId,
      sessionId: _sessionId,
      taskId: _taskId,
      leaseEpoch: _leaseEpoch,
      nonce: _nonce,
      completionPolicy: _completionPolicy,
      finalOrigin: _finalOrigin,
      ...toolResult
    } = result;
    for (const valid of [
      {
        ...result,
        outcome: "USER_ASSERTED_AND_VERIFIED",
        phaseSignal: "MANUAL_DONE",
      },
      {
        ...result,
        completionPolicy: "DIALOG_OR_ROUTE_COMPLETED",
        outcome: "USER_ASSERTED_AND_VERIFIED",
        phaseSignal: "MANUAL_DONE",
      },
      {
        ...result,
        completionPolicy: "MANUAL_DONE_THEN_VERIFY",
        outcome: "USER_ASSERTED_AND_VERIFIED",
        phaseSignal: "MANUAL_DONE",
      },
      {
        ...result,
        completionPolicy: "DIALOG_OR_ROUTE_COMPLETED",
        phaseSignal: "DIALOG_CLOSED",
      },
      {
        ...result,
        outcome: "CANCELLED",
        phaseSignal: undefined,
      },
      {
        ...result,
        outcome: "TIMED_OUT",
        phaseSignal: undefined,
        agentLeaseRestored: false,
      },
      {
        ...result,
        outcome: "TAB_CLOSED",
        phaseSignal: undefined,
        sameTab: false,
        tabRestored: false,
        agentLeaseRestored: false,
      },
    ]) {
      expect(HandoffResultSchema.safeParse(valid).success).toBe(true);
    }
    for (const invalid of [
      { ...result, phaseSignal: undefined },
      { ...result, finalOrigin: undefined },
      { ...result, sameTab: false },
      { ...result, agentLeaseRestored: false },
      {
        ...result,
        outcome: "USER_ASSERTED_AND_VERIFIED",
        phaseSignal: "AUTH_MARKER_PRESENT",
      },
      { ...result, phaseSignal: "MANUAL_DONE" },
      {
        ...result,
        completionPolicy: "AUTH_FLOW_COMPLETED",
        phaseSignal: "DIALOG_CLOSED",
      },
      {
        ...result,
        completionPolicy: "DIALOG_OR_ROUTE_COMPLETED",
        phaseSignal: "AUTH_MARKER_PRESENT",
      },
      {
        ...result,
        completionPolicy: "MANUAL_DONE_THEN_VERIFY",
        phaseSignal: "EXPECTED_ROUTE",
      },
      { ...result, outcome: "CANCELLED" },
      {
        ...result,
        outcome: "TIMED_OUT",
        phaseSignal: undefined,
        agentLeaseRestored: true,
      },
      {
        ...result,
        outcome: "UNSAFE_ORIGIN",
        phaseSignal: undefined,
        agentLeaseRestored: true,
      },
      {
        ...result,
        outcome: "TAB_CLOSED",
        phaseSignal: undefined,
        agentLeaseRestored: false,
      },
      {
        ...result,
        outcome: "TAB_CLOSED",
        phaseSignal: undefined,
        sameTab: false,
        tabRestored: true,
        agentLeaseRestored: false,
      },
      { ...result, secretObserved: true },
      { ...result, phaseSignal: "PAGE_TEXT" },
      { ...result, finalOrigin: "https://accounts.example.test/private?q=x" },
      { ...result, cookie: "content-canary" },
    ]) {
      expect(HandoffResultSchema.safeParse(invalid).success).toBe(false);
    }
    for (const internalField of [
      "handoffId",
      "sessionId",
      "taskId",
      "leaseEpoch",
      "nonce",
      "completionPolicy",
      "finalOrigin",
    ]) {
      expect(
        HandoffToolResultSchema.safeParse({
          ...toolResult,
          [internalField]: "content-canary",
        }).success,
      ).toBe(false);
    }
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

  it("binds a strict fixture-only verification marker to the active Human lease", () => {
    const active = {
      schemaVersion: 3,
      sessionId: "s",
      taskId: "t",
      goalSummary: "safe",
      hostProfileId: "hp",
      hostProfileStatus: "VALID",
      mode: "ADVISORY_ONLY",
      phase: "USER_LEASE_ACTIVE",
      revision: 0,
      noProgressCount: 0,
      recoveryLevel: 0,
      recoveryTransitions: 0,
      authState: "UNKNOWN",
      activeHandoffId: "handoff",
      leaseEpoch: 2,
      pointerOwner: "HUMAN",
      targetCacheEpoch: 0,
      pendingNativeActionIds: [],
      stateVersion: 1,
    } as const;
    const marker = handoffVerificationMarker();

    expect(HandoffVerificationMarkerSchema.safeParse(marker).success).toBe(
      true,
    );
    expect(
      BrowserTaskStateSchema.safeParse({
        ...active,
        handoffVerificationMarker: marker,
      }).success,
    ).toBe(true);
    expect(
      BrowserTaskStateSchema.safeParse({
        ...active,
        phase: "HANDOFF_VERIFYING",
      }).success,
    ).toBe(true); // markerless v3 is retained only for legacy recovery.

    for (const invalid of [
      { ...marker, secondProbeSequence: marker.firstProbeSequence },
      { ...marker, candidateDigest: "A".repeat(64) },
      { ...marker, secret: "must-not-become-a-field" },
    ]) {
      expect(HandoffVerificationMarkerSchema.safeParse(invalid).success).toBe(
        false,
      );
    }
    for (const invalid of [
      {
        ...active,
        handoffVerificationMarker: { ...marker, leaseEpoch: 3 },
      },
      {
        ...active,
        activeHandoffId: undefined,
        handoffVerificationMarker: marker,
        leaseEpoch: 2,
        phase: "RUNNING",
        pointerOwner: "NATIVE",
      },
    ]) {
      expect(BrowserTaskStateSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("bounds every shared non-negative integer at Number.MAX_SAFE_INTEGER", () => {
    const state = {
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
      stateVersion: Number.MAX_SAFE_INTEGER,
    } as const;

    expect(BrowserTaskStateSchema.safeParse(state).success).toBe(true);
    expect(
      BrowserTaskStateSchema.safeParse({
        ...state,
        stateVersion: Number.MAX_SAFE_INTEGER + 1,
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
    const browserTaskStateJson = await readFile(
      join(first, "browser-task-state.schema.json"),
      "utf8",
    );
    expect(browserTaskStateJson).toContain(
      "generated JSON Schema validates the exchange shape only",
    );
    expect(browserTaskStateJson).toContain(
      "is not transition or resume authority",
    );
    expect(names).toContain("handoff-tool-input.schema.json");
    for (const runtimeOnly of [
      "handoff-completion-signal.schema.json",
      "handoff-current-tab-receipt.schema.json",
      "handoff-request.schema.json",
      "handoff-result.schema.json",
      "handoff-tool-result.schema.json",
      "handoff-verification-sample.schema.json",
    ]) {
      expect(names).not.toContain(runtimeOnly);
    }
    for (const name of names) {
      expect(await readFile(join(first, name), "utf8")).toBe(
        await readFile(join(second, name), "utf8"),
      );
    }
  });
});
