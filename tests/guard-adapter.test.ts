import { describe, expect, it } from "vitest";

import {
  HostProfileSchema,
  NativePrimitiveSchema,
  deterministicDigest,
  redactedDeterministicDigest,
  toolRegistryManifestBinding,
  type BrowserTaskState,
  type HostProfile,
  type PolicyDecision,
} from "../packages/protocol/src/index.js";
import {
  createBrowserTaskState,
  persistentDocumentBinding,
  recordActionOutcome,
} from "../packages/core/src/index.js";
import {
  ToolSchemaRegistrySchema,
  buildPreToolUseOutput,
  decodeBrowserAction,
  runGuardPreToolUse,
} from "../packages/host-openai/src/guard.js";

const hash = (value: string) => value.repeat(64);
const signatureProtector = {
  keyId: hash("f"),
  protect: (purpose: "input" | "target", digest: string) =>
    redactedDeterministicDigest("oxrail-fixture-action-signature-v1", {
      digest,
      purpose,
    }),
};

function profile(): HostProfile {
  return HostProfileSchema.parse({
    schemaVersion: 5,
    profileId: "hp_guard_fixture",
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
      syntheticProbe: "unknown",
      firstBrowserHookSeen: true,
      verificationSource: "passive-first-browser-call",
      optimization: "ACTIVE",
    },
    identity: {
      surface: "codex-desktop",
      hostBuild: "fixture-host",
      codexVersion: "fixture-codex",
      computerUsePluginVersion: "fixture-cu",
      browserPath: "chrome-extension",
      os: "macos",
    },
    route: {
      toolRoute: "direct-mcp",
      canonicalToolMatchers: ["fixture.native.browser"],
      matcherEvidenceHash: hash("a"),
      toolSchemaRegistryHash: hash("e"),
      toolSchemaRegistryEvidenceId: "EVID-HOST-TOOL-SCHEMA-FIXTURE",
      browserTools: [
        {
          canonicalToolName: "fixture.native.browser",
          inputSchemaHash: hash("d"),
          registryManifestBinding: toolRegistryManifestBinding({
            profileId: "hp_guard_fixture",
            definitionHash: hash("b"),
            matcherEvidenceHash: hash("a"),
            toolSchemaRegistryHash: hash("e"),
            toolSchemaRegistryEvidenceId: "EVID-HOST-TOOL-SCHEMA-FIXTURE",
            canonicalToolName: "fixture.native.browser",
            inputSchemaHash: hash("d"),
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
        observed: 0,
        expected: 0,
        bypassCases: [],
        confidence: "UNKNOWN",
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
      definitionHash: hash("b"),
      concurrentConflictProbe: "passed",
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
      inactiveReasons: ["not connected"],
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
      inactiveReasons: ["fixture has no credential helper"],
      capability: {
        platform: "macos",
        surface: "NONE",
        storage: "NONE",
        acceptedKinds: [],
        consumerMode: "NONE",
        consumerReadiness: "UNSUPPORTED",
        opaqueReferenceOnly: false,
        genericSecretExport: "DENIED",
      },
      helperIdentity: "unknown",
      launcherIdentity: "unknown",
      secureInput: "unknown",
      agentExecutionIsolation: "unknown",
      pasteboardHygiene: "unknown",
      registryManifestVerification: "unknown",
      secretLeakBench: "unknown",
      realConsumerProbe: "unknown",
      keychainRoundTrip: "unknown",
      opaqueRefOnly: "unknown",
      scopeBinding: "unknown",
      expiryAndRevocation: "unknown",
      genericExportDenied: "unknown",
    },
    evidence: {
      probeSuiteVersion: "fixture",
      fixtureRevision: "fixture",
      traceManifestHash: hash("c"),
      testedAt: "2026-09-04T00:00:00.000Z",
      validUntilHostChange: true,
      unresolved: ["real host"],
    },
    derived: {
      mode: "MICRO_ACTION_GUARD",
      safety: "ACTIVE",
      handoff: "INACTIVE",
      credentialProtection: "INACTIVE",
      allowedClaims: ["fixture guard"],
      forbiddenClaims: ["handoff"],
    },
  });
}

const registry = {
  schemaVersion: 1,
  profileId: "hp_guard_fixture",
  definitionHash: hash("b"),
  matcherEvidenceHash: hash("a"),
  tools: [
    {
      toolName: "fixture.native.browser",
      inputSchemaHash: hash("d"),
      route: "direct-mcp",
      granularity: "MICRO_ACTION",
      actionTypePath: ["action"],
      identityPaths: [["axis"]],
      impactByAction: { inspect: "read", click: "reversible" },
      defaultImpact: "high-impact",
    },
  ],
} as const;

const registryWithTarget = {
  ...registry,
  tools: [
    {
      ...registry.tools[0],
      originPath: ["origin"],
      revisionPath: ["revision"],
      targetPath: ["target"],
    },
  ],
} as const;

// Fixture convenience only: production pins must come from a separate trusted manifest.
const registryBinding = (registryValue: unknown = registry) => ({
  expectedRegistryHash: deterministicDigest(
    "oxrail-host-tool-schema-registry-v1",
    registryValue,
  ),
  expectedInputSchemaHash: hash("d"),
});

const targetFingerprint = (value: string) =>
  redactedDeterministicDigest("oxrail-host-target-fingerprint-v1", value);

const stateScope = (state: BrowserTaskState) => ({
  sessionId: state.sessionId,
  taskId: state.taskId,
});

describe("host Guard adapter", () => {
  it("requires every enforceable tool contract to declare input identity", () => {
    expect(
      ToolSchemaRegistrySchema.safeParse({
        ...registry,
        tools: [{ ...registry.tools[0], identityPaths: [] }],
      }).success,
    ).toBe(false);
  });

  it.each(["__proto__", "prototype", "constructor"])(
    "rejects magic property path segment %s",
    (segment) => {
      expect(
        ToolSchemaRegistrySchema.safeParse({
          ...registry,
          tools: [{ ...registry.tools[0], actionTypePath: [segment] }],
        }).success,
      ).toBe(false);
    },
  );

  it.each(["otpCode", "access_token", "card-number"])(
    "rejects camel, snake, and kebab sensitive identity path %s",
    (segment) => {
      expect(
        ToolSchemaRegistrySchema.safeParse({
          ...registry,
          tools: [{ ...registry.tools[0], identityPaths: [[segment]] }],
        }).success,
      ).toBe(false);
    },
  );

  it("accepts only bounded schema action identifiers", () => {
    expect(
      ToolSchemaRegistrySchema.safeParse({
        ...registry,
        tools: [
          {
            ...registry.tools[0],
            impactByAction: { "click page text": "high-impact" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      decodeBrowserAction(
        profile(),
        registry,
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-page-text",
          toolInput: { action: "Click Buy now!", axis: "primary" },
        },
        registryBinding(),
      ),
    ).toMatchObject({
      kind: "BLOCK_HIGH_IMPACT",
      reasonCode: "OXRAIL_HUMAN_BOUNDARY",
    });
  });

  it.each(["Click Buy now!", "constructor"])(
    "fails closed without retaining an invalid or unknown action type: %s",
    (action) => {
      const state = createBrowserTaskState({
        sessionId: "session-unknown-action",
        taskId: "task-unknown-action",
        hostProfileId: profile().profileId,
        mode: "MICRO_ACTION_GUARD",
      });
      const result = runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        profile: profile(),
        registry,
        state,
        call: {
          toolName: "fixture.native.browser",
          toolUseId: "call-unknown-action",
          toolInput: { action, axis: "primary" },
        },
      });

      expect(result).toMatchObject({
        mode: "ACTIVE",
        decision: {
          disposition: "BLOCK_BEFORE_EXECUTION",
          reasonCode: "OXRAIL_HUMAN_BOUNDARY",
          recoverable: false,
        },
        output: {
          hookSpecificOutput: { permissionDecision: "deny" },
        },
      });
      expect(JSON.stringify(result)).not.toContain(action);
    },
  );

  it("requires unknown schema actions to default to high impact", () => {
    expect(
      ToolSchemaRegistrySchema.safeParse({
        ...registry,
        tools: [{ ...registry.tools[0], defaultImpact: "reversible" }],
      }).success,
    ).toBe(false);
  });

  it.each([
    ["USER_LEASE_ACTIVE", "NATIVE", "OXRAIL_USER_LEASE_ACTIVE"],
    ["HANDOFF_VERIFYING", "NATIVE", "OXRAIL_USER_LEASE_ACTIVE"],
    ["RUNNING", "HUMAN", "OXRAIL_USER_LEASE_ACTIVE"],
    ["HANDOFF_PREPARING", "NATIVE", "OXRAIL_VERIFICATION_INCONCLUSIVE"],
    ["RESTORING_TAB", "NONE", "OXRAIL_POST_HANDOFF_TARGET_INVALIDATED"],
    ["RESUMING", "NONE", "OXRAIL_POST_HANDOFF_TARGET_INVALIDATED"],
  ] as const)(
    "denies an exact browser tool before decoding while phase=%s and owner=%s",
    (phase, pointerOwner, reasonCode) => {
      const state = {
        ...createBrowserTaskState({
          sessionId: "session-lease",
          taskId: "task-lease",
          hostProfileId: profile().profileId,
          mode: "MICRO_ACTION_GUARD",
        }),
        phase,
        pointerOwner,
      };
      const result = runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        profile: profile(),
        registry: { invalid: true },
        state,
        call: {
          toolName: "fixture.native.browser",
          toolUseId: "call-during-lease",
          toolInput: { malformed: true },
        },
      });

      expect(result).toMatchObject({
        mode: "ACTIVE",
        decision: {
          disposition: "BLOCK_BEFORE_EXECUTION",
          reasonCode,
        },
        output: {
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
          },
        },
      });
      expect(JSON.stringify(result)).not.toContain('"ask"');
    },
  );

  it("does not enforce a seeded lease after profile activation drifts", () => {
    const activeProfile = profile();
    const state = {
      ...createBrowserTaskState({
        sessionId: "session-bound",
        taskId: "task-bound",
        hostProfileId: activeProfile.profileId,
        mode: "MICRO_ACTION_GUARD",
      }),
      phase: "USER_LEASE_ACTIVE" as const,
      pointerOwner: "HUMAN" as const,
    };
    const call = {
      toolName: "fixture.native.browser",
      toolUseId: "call-bound",
      toolInput: {},
    };
    const bypassed = {
      mode: "BYPASSED",
      output: {},
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
    } as const;

    const inactiveProfile = structuredClone(activeProfile);
    inactiveProfile.setup.lifecycle = "CONFIGURED";
    inactiveProfile.setup.optimization = "BYPASSED";
    inactiveProfile.hooks.trustState = "review-required";
    inactiveProfile.evidence.validUntilHostChange = false;
    inactiveProfile.derived.mode = "ADVISORY_ONLY";
    expect(
      runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        call,
        profile: inactiveProfile,
        registry,
        state,
      }),
    ).toEqual(bypassed);

    for (const scope of [
      { sessionId: "other-session", taskId: state.taskId },
      { sessionId: state.sessionId, taskId: "other-task" },
    ]) {
      expect(
        runGuardPreToolUse({
          ...registryBinding(),
          ...scope,
          call,
          profile: activeProfile,
          registry,
          state,
        }),
      ).toEqual(bypassed);
    }
  });

  it("does not apply the browser lease guard to an unrelated tool", () => {
    const state = {
      ...createBrowserTaskState({
        sessionId: "session-unrelated",
        taskId: "task-unrelated",
        hostProfileId: profile().profileId,
        mode: "MICRO_ACTION_GUARD",
      }),
      phase: "USER_LEASE_ACTIVE" as const,
      pointerOwner: "HUMAN" as const,
    };

    expect(
      runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        profile: profile(),
        registry: { invalid: true },
        state,
        call: {
          toolName: "fixture.unrelated.tool",
          toolUseId: "call-unrelated",
          toolInput: {},
        },
      }),
    ).toEqual({
      mode: "BYPASSED",
      output: {},
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
    });
  });

  it("does not enforce when the profile reports Safety inactive", () => {
    const inactiveSafety = structuredClone(profile());
    inactiveSafety.derived.safety = "INACTIVE";
    const state = createBrowserTaskState({
      sessionId: "session-safety-inactive",
      taskId: "task-safety-inactive",
      hostProfileId: inactiveSafety.profileId,
      mode: "MICRO_ACTION_GUARD",
    });

    expect(
      runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        call: {
          toolName: "fixture.native.browser",
          toolUseId: "call-safety-inactive",
          toolInput: { action: "click", axis: "primary" },
        },
        profile: inactiveSafety,
        registry,
        state,
      }),
    ).toEqual({
      mode: "BYPASSED",
      output: {},
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
    });
  });

  it("decodes only an exact, evidence-bound tool contract", () => {
    const decoded = decodeBrowserAction(
      profile(),
      registryWithTarget,
      {
        toolName: "fixture.native.browser",
        toolUseId: "call-1",
        toolInput: {
          action: "click",
          axis: "primary",
          password: "must-not-survive",
          origin: "https://example.test",
          revision: 2,
          target: {
            source: "NATIVE_VISUAL",
            sourceRevision: 2,
            semanticRef: "target-secret-canary",
            documentBinding: "doc-2",
            role: "button",
            name: "target-secret-canary",
            label: "target-secret-canary",
            text: "target-secret-canary",
            regionPath: ["target-secret-canary"],
            fingerprint: "target-fingerprint-canary",
            bbox: { x: 1, y: 2, width: 3, height: 4 },
            confidence: 1,
            risk: ["target-secret-canary"],
          },
        },
      },
      registryBinding(registryWithTarget),
    );

    expect(decoded).toMatchObject({
      kind: "ACTION",
      action: {
        toolUseId: "call-1",
        route: "direct-mcp",
        granularity: "MICRO_ACTION",
        actionType: "click",
        impact: "reversible",
        origin: "https://example.test",
        revision: 2,
      },
    });
    expect(JSON.stringify(decoded)).not.toContain("must-not-survive");
    expect(JSON.stringify(decoded)).not.toContain("target-secret-canary");
    expect(JSON.stringify(decoded)).not.toContain("target-fingerprint-canary");
    expect(JSON.stringify(decoded)).not.toContain('"doc-2"');
    if (decoded.kind !== "ACTION") throw new Error("fixture did not decode");
    expect(decoded.action.target).toEqual({
      source: "NATIVE_VISUAL",
      sourceRevision: 2,
      documentBinding: persistentDocumentBinding("doc-2"),
      fingerprint: targetFingerprint("target-fingerprint-canary"),
      confidence: 1,
      risk: [],
    });
    expect(decoded.action.inputDigest).toBe(
      redactedDeterministicDigest("oxrail-host-tool-input-identity-v1", [
        [["axis"], "primary"],
      ]),
    );
  });

  it("keeps dotted identity path segments unambiguous", () => {
    const dottedRegistry = {
      ...registry,
      tools: [
        {
          ...registry.tools[0],
          identityPaths: [
            ["a.b", "c"],
            ["a", "b.c"],
          ],
        },
      ],
    } as const;
    const decode = (first: string) =>
      decodeBrowserAction(
        profile(),
        dottedRegistry,
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-dotted-path",
          toolInput: {
            action: "click",
            "a.b": { c: first },
            a: { "b.c": "constant" },
          },
        },
        registryBinding(dottedRegistry),
      );
    const first = decode("first");
    const second = decode("second");
    if (first.kind !== "ACTION" || second.kind !== "ACTION")
      throw new Error("dotted path fixtures did not decode");

    expect(first.action.inputDigest).not.toBe(second.action.inputDigest);
  });

  it("always domain-hashes target fingerprints, including 64-hex input", () => {
    const rawHex = hash("e");
    const decoded = decodeBrowserAction(
      profile(),
      registryWithTarget,
      {
        toolName: "fixture.native.browser",
        toolUseId: "call-hex-fingerprint",
        toolInput: {
          action: "click",
          axis: "primary",
          origin: "https://example.test",
          revision: 0,
          target: {
            source: "NATIVE_VISUAL",
            sourceRevision: 0,
            fingerprint: rawHex,
            confidence: 1,
            risk: [],
          },
        },
      },
      registryBinding(registryWithTarget),
    );

    expect(decoded).toMatchObject({
      kind: "ACTION",
      action: { target: { fingerprint: targetFingerprint(rawHex) } },
    });
    expect(JSON.stringify(decoded)).not.toContain(rawHex);
  });

  it("treats every declared origin, revision, and target path as required", () => {
    for (const omitted of ["origin", "revision", "target"] as const) {
      const toolInput: Record<string, unknown> = {
        action: "click",
        axis: "primary",
        origin: "https://example.test",
        revision: 0,
        target: {
          source: "NATIVE_VISUAL",
          sourceRevision: 0,
          confidence: 1,
          risk: [],
        },
      };
      delete toolInput[omitted];
      expect(
        decodeBrowserAction(
          profile(),
          registryWithTarget,
          {
            toolName: "fixture.native.browser",
            toolUseId: `call-missing-${omitted}`,
            toolInput,
          },
          registryBinding(registryWithTarget),
        ),
      ).toMatchObject({ kind: "UNSUPPORTED" });
    }
  });

  it("rejects registry content drift and an unpinned input schema", () => {
    const call = {
      toolName: "fixture.native.browser",
      toolUseId: "call-1",
      toolInput: { action: "click", axis: "primary" },
    };
    for (const drifted of [
      {
        ...registry,
        tools: [{ ...registry.tools[0], actionTypePath: ["different-action"] }],
      },
      {
        ...registry,
        tools: [
          {
            ...registry.tools[0],
            impactByAction: {
              ...registry.tools[0].impactByAction,
              click: "read",
            },
          },
        ],
      },
      {
        ...registry,
        tools: [{ ...registry.tools[0], identityPaths: [["different-axis"]] }],
      },
    ] as const) {
      expect(
        decodeBrowserAction(profile(), drifted, call, registryBinding()),
      ).toMatchObject({
        kind: "UNSUPPORTED",
        reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
      });
    }

    expect(
      decodeBrowserAction(profile(), registry, call, {
        ...registryBinding(),
        expectedInputSchemaHash: hash("e"),
      }),
    ).toMatchObject({
      kind: "UNSUPPORTED",
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
    });
  });

  it("fails closed for malformed trusted high-impact actions only", () => {
    const highImpactRegistry = {
      ...registryWithTarget,
      tools: [
        {
          ...registryWithTarget.tools[0],
          impactByAction: {
            ...registry.tools[0].impactByAction,
            submit: "high-impact",
          },
        },
      ],
    } as const;
    const state = createBrowserTaskState({
      sessionId: "session-high-impact",
      taskId: "task-high-impact",
      hostProfileId: profile().profileId,
      mode: "MICRO_ACTION_GUARD",
    });

    for (const toolInput of [
      {
        action: "submit",
        axis: "primary",
        origin: "https://example.test",
        revision: -1,
        target: {
          source: "NATIVE_VISUAL",
          sourceRevision: 0,
          confidence: 1,
          risk: [],
        },
      },
      {
        action: "submit",
        axis: "primary",
        origin: "https://example.test",
        revision: 0,
        target: { source: "NATIVE_VISUAL" },
      },
    ]) {
      const result = runGuardPreToolUse({
        ...registryBinding(highImpactRegistry),
        ...stateScope(state),
        profile: profile(),
        registry: highImpactRegistry,
        state,
        call: {
          toolName: "fixture.native.browser",
          toolUseId: "call-high-impact",
          toolInput,
        },
      });
      expect(result).toMatchObject({
        mode: "ACTIVE",
        decision: {
          disposition: "BLOCK_BEFORE_EXECUTION",
          reasonCode: "OXRAIL_HUMAN_BOUNDARY",
          recoverable: false,
        },
        output: {
          hookSpecificOutput: { permissionDecision: "deny" },
        },
      });
      expect(result).not.toHaveProperty("action");
    }

    expect(
      runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        profile: profile(),
        registry: { invalid: true },
        state,
        call: {
          toolName: "fixture.native.browser",
          toolUseId: "call-untrusted-registry",
          toolInput: { action: "submit" },
        },
      }),
    ).toEqual({
      mode: "BYPASSED",
      output: {},
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
    });
  });

  it("falls back without enforcement for unknown or drifted schemas", () => {
    expect(
      decodeBrowserAction(
        profile(),
        registry,
        {
          toolName: "fixture.native.browser.other",
          toolUseId: "call-1",
          toolInput: { action: "click" },
        },
        registryBinding(),
      ),
    ).toEqual({ kind: "UNRELATED" });

    expect(
      decodeBrowserAction(
        profile(),
        { ...registry, matcherEvidenceHash: hash("e") },
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-1",
          toolInput: { action: "click" },
        },
        registryBinding({ ...registry, matcherEvidenceHash: hash("e") }),
      ),
    ).toMatchObject({
      kind: "UNSUPPORTED",
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
    });

    expect(
      decodeBrowserAction(
        profile(),
        registry,
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-1",
          toolInput: { unknown: true },
        },
        registryBinding(),
      ),
    ).toMatchObject({
      kind: "BLOCK_HIGH_IMPACT",
      reasonCode: "OXRAIL_HUMAN_BOUNDARY",
    });
  });

  it("rejects sensitive identity paths and malformed identity values", () => {
    expect(
      decodeBrowserAction(
        profile(),
        {
          ...registry,
          tools: [{ ...registry.tools[0], identityPaths: [["otp"]] }],
        },
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-1",
          toolInput: { action: "click", otp: "123456" },
        },
        registryBinding({
          ...registry,
          tools: [{ ...registry.tools[0], identityPaths: [["otp"]] }],
        }),
      ),
    ).toMatchObject({ kind: "UNSUPPORTED" });

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() =>
      decodeBrowserAction(
        profile(),
        registry,
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-1",
          toolInput: { action: "click", axis: cyclic },
        },
        registryBinding(),
      ),
    ).not.toThrow();
    expect(
      decodeBrowserAction(
        profile(),
        registry,
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-1",
          toolInput: { action: "click", axis: cyclic },
        },
        registryBinding(),
      ),
    ).toMatchObject({ kind: "UNSUPPORTED" });

    const accessorInput = Object.defineProperty({ action: "click" }, "axis", {
      enumerable: true,
      get: () => {
        throw new Error("must not escape Guard");
      },
    });
    expect(() =>
      decodeBrowserAction(
        profile(),
        registry,
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-accessor",
          toolInput: accessorInput,
        },
        registryBinding(),
      ),
    ).not.toThrow();

    const proxyInput = new Proxy(
      { action: "click", axis: "primary" },
      {
        getOwnPropertyDescriptor: () => {
          throw new Error("must not escape Guard");
        },
      },
    );
    expect(() =>
      decodeBrowserAction(
        profile(),
        registry,
        {
          toolName: "fixture.native.browser",
          toolUseId: "call-proxy",
          toolInput: proxyInput,
        },
        registryBinding(),
      ),
    ).not.toThrow();
  });

  it("uses only supported PreToolUse output and never emits ask", () => {
    const denied: PolicyDecision = {
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_REDUNDANT_ACTION",
      recoverable: true,
    };
    const output = buildPreToolUseOutput(denied);
    expect(output).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason:
          "OXRAIL_REDUNDANT_ACTION: Oxrail blocked this browser action before execution.",
      },
    });
    expect(JSON.stringify(output)).not.toContain('"ask"');
    expect(
      buildPreToolUseOutput({
        disposition: "PASS_THROUGH_ORIGINAL",
        reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
        recoverable: true,
      }),
    ).toEqual({});
  });

  it("passes two unchanged attempts and denies the third proven no-progress call", () => {
    const toolInput = {
      action: "click",
      axis: "primary",
      origin: "https://example.test",
      revision: 0,
    };
    let state = createBrowserTaskState({
      sessionId: "session-1",
      taskId: "task-1",
      hostProfileId: profile().profileId,
      mode: "MICRO_ACTION_GUARD",
    });

    for (const toolUseId of ["call-1", "call-2"]) {
      const result = runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        profile: profile(),
        registry,
        signatureProtector,
        state,
        call: { toolName: "fixture.native.browser", toolUseId, toolInput },
      });
      expect(result).toMatchObject({ mode: "ACTIVE", output: {} });
      if (result.mode !== "ACTIVE" || !result.action) {
        throw new Error("fixture guard bypassed or did not decode an action");
      }
      state = recordActionOutcome(
        state,
        result.action,
        result.decision,
        { meaningfulProgress: false },
        signatureProtector,
      );
    }

    const before = structuredClone(toolInput);
    const third = runGuardPreToolUse({
      ...registryBinding(),
      ...stateScope(state),
      profile: profile(),
      registry,
      signatureProtector,
      state,
      call: {
        toolName: "fixture.native.browser",
        toolUseId: "call-3",
        toolInput,
      },
    });
    expect(third).toMatchObject({
      mode: "ACTIVE",
      decision: {
        disposition: "BLOCK_BEFORE_EXECUTION",
        reasonCode: "OXRAIL_REDUNDANT_ACTION",
      },
      output: {
        hookSpecificOutput: { permissionDecision: "deny" },
      },
    });
    expect(toolInput).toEqual(before);
  });

  it("does not accumulate repeated-action denial across distinct identities", () => {
    let state = createBrowserTaskState({
      sessionId: "session-distinct",
      taskId: "task-distinct",
      hostProfileId: profile().profileId,
      mode: "MICRO_ACTION_GUARD",
    });

    for (const [index, axis] of ["first", "second"].entries()) {
      const result = runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        profile: profile(),
        registry,
        signatureProtector,
        state,
        call: {
          toolName: "fixture.native.browser",
          toolUseId: `call-distinct-${index}`,
          toolInput: { action: "click", axis },
        },
      });
      expect(result).toMatchObject({ mode: "ACTIVE", output: {} });
      if (result.mode !== "ACTIVE" || !result.action) {
        throw new Error("fixture guard did not decode an ordinary action");
      }
      state = recordActionOutcome(
        state,
        result.action,
        result.decision,
        { meaningfulProgress: false },
        signatureProtector,
      );
    }

    expect(
      runGuardPreToolUse({
        ...registryBinding(),
        ...stateScope(state),
        profile: profile(),
        registry,
        signatureProtector,
        state,
        call: {
          toolName: "fixture.native.browser",
          toolUseId: "call-distinct-third",
          toolInput: { action: "click", axis: "third" },
        },
      }),
    ).toMatchObject({
      mode: "ACTIVE",
      decision: {
        disposition: "PASS_THROUGH_ORIGINAL",
        reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
      },
      output: {},
    });
  });

  it("passes the current observed target fingerprint into stale-target policy", () => {
    const state = {
      ...createBrowserTaskState({
        sessionId: "session-stale-target",
        taskId: "task-stale-target",
        hostProfileId: profile().profileId,
        mode: "MICRO_ACTION_GUARD",
      }),
      documentBinding: persistentDocumentBinding("doc-2"),
      revision: 2,
    };

    expect(
      runGuardPreToolUse({
        ...registryBinding(registryWithTarget),
        ...stateScope(state),
        currentTargetFingerprint: "button-current",
        profile: profile(),
        registry: registryWithTarget,
        state,
        call: {
          toolName: "fixture.native.browser",
          toolUseId: "call-stale-target",
          toolInput: {
            action: "click",
            axis: "primary",
            origin: "https://example.test",
            revision: 2,
            target: {
              source: "NATIVE_VISUAL",
              sourceRevision: 2,
              documentBinding: "doc-2",
              fingerprint: "button-stale",
              confidence: 1,
              risk: [],
            },
          },
        },
      }),
    ).toMatchObject({
      mode: "ACTIVE",
      decision: {
        disposition: "BLOCK_BEFORE_EXECUTION",
        reasonCode: "OXRAIL_STALE_TARGET",
      },
      output: {
        hookSpecificOutput: { permissionDecision: "deny" },
      },
    });
  });
});
