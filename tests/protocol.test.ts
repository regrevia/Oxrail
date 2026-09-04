import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { generateProtocolSchemas } from "../packages/protocol/src/generate.js";
import {
  BrowserTaskStateSchema,
  HostProfileSchema,
  NativePrimitiveSchema,
  ReasonCodeSchema,
  SetupVerificationSchema,
  redactedDeterministicDigest,
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
    schemaVersion: 3,
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

  it("round-trips the v3 HostProfile and rejects unknown enum values", () => {
    const parsed = HostProfileSchema.parse(hostProfile());
    expect(HostProfileSchema.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(
      parsed,
    );
    expect(ReasonCodeSchema.safeParse("OXRAIL_MADE_UP").success).toBe(false);
    expect(
      HostProfileSchema.safeParse({ ...hostProfile(), schemaVersion: 4 })
        .success,
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
      resultingMode: "UNSUPPORTED",
    });
    expect(result.success).toBe(true);
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

  it("generates byte-deterministic, stable JSON schema filenames", async () => {
    const first = await mkdtemp(join(tmpdir(), "oxrail-schema-a-"));
    const second = await mkdtemp(join(tmpdir(), "oxrail-schema-b-"));
    await generateProtocolSchemas(first);
    await generateProtocolSchemas(second);
    const names = (await readdir(first)).sort();
    expect(names).toContain("host-profile.schema.json");
    expect(names).toContain("browser-task-state.schema.json");
    for (const name of names) {
      expect(await readFile(join(first, name), "utf8")).toBe(
        await readFile(join(second, name), "utf8"),
      );
    }
  });
});
