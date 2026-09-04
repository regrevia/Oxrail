import { z } from "zod";

import { ReasonCodeSchema } from "./reason-codes.js";

const nonEmpty = z.string().min(1);
const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "expected a SHA-256 hex digest");
const finiteNonNegative = z.number().finite().nonnegative();
const nonNegativeInt = z.number().int().nonnegative();

export const ActionControlSchema = z.enum([
  "MICRO_ACTION",
  "TRANSACTION",
  "SCRIPT_WRAPPER",
  "NONE",
]);
export type ActionControl = z.infer<typeof ActionControlSchema>;

export const InteractionFidelitySchema = z.enum([
  "PROVEN_PASS_THROUGH",
  "PARTIAL",
  "FAILED",
  "UNKNOWN",
]);
export type InteractionFidelity = z.infer<typeof InteractionFidelitySchema>;

export const PointerOwnerSchema = z.enum(["NATIVE", "HUMAN", "NONE"]);
export type PointerOwner = z.infer<typeof PointerOwnerSchema>;

export const ResultControlSchema = z.enum([
  "NATIVE_TYPED_REWRITE",
  "HOOK_FEEDBACK_SUBSTITUTION",
  "NATIVE_TRUNCATION_ONLY",
  "OBSERVE_ONLY",
  "NONE",
]);
export type ResultControl = z.infer<typeof ResultControlSchema>;

export const ObservationSourceSchema = z.enum([
  "SITE_TOOL_WEBMCP",
  "NATIVE_STRUCTURED",
  "NATIVE_READONLY_DEVTOOLS",
  "READONLY_COMPANION",
  "NATIVE_VISUAL",
  "NONE",
]);
export type ObservationSource = z.infer<typeof ObservationSourceSchema>;

export const HostModeSchema = z.enum([
  "FULL_INTERPOSE",
  "MICRO_ACTION_GUARD",
  "TRANSACTION_GUARD",
  "ADVISORY_ONLY",
  "UNSUPPORTED",
]);
export type HostMode = z.infer<typeof HostModeSchema>;

export const ProbeVerdictSchema = z.enum([
  "passed",
  "partial",
  "failed",
  "unsupported",
  "unknown",
]);
export type ProbeVerdict = z.infer<typeof ProbeVerdictSchema>;

export const NativePrimitiveSchema = z.enum([
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
]);
export type NativePrimitive = z.infer<typeof NativePrimitiveSchema>;

export const ToolRouteSchema = z.enum([
  "direct-mcp",
  "code-mode-nested-mcp",
  "outer-transaction",
  "script-wrapper",
  "local-function",
  "specialized",
  "opaque",
]);
export type ToolRoute = z.infer<typeof ToolRouteSchema>;

export const CoverageEvidenceSchema = z.strictObject({
  observed: nonNegativeInt,
  expected: nonNegativeInt,
  bypassCases: z.array(nonEmpty),
  confidence: z.enum(["PROVEN", "PARTIAL", "UNKNOWN"]),
});
export type CoverageEvidence = z.infer<typeof CoverageEvidenceSchema>;

export const HandoffCapabilitySchema = z.strictObject({
  surface: z.enum([
    "DETACHED_REAL_TAB_WINDOW",
    "FOCUSED_REAL_TAB",
    "HOST_NATIVE_SAME_SESSION_VIEW",
    "NOTICE_ONLY",
    "NONE",
  ]),
  lease: z.enum(["EXCLUSIVE_USER_LEASE", "BEST_EFFORT_LOCK", "NONE"]),
  resume: z.enum([
    "AUTO_VERIFIED",
    "ONE_CLICK_VERIFIED",
    "CHAT_MESSAGE_REQUIRED",
    "NONE",
  ]),
  conversationContextPreserved: z.boolean(),
  sameTabBinding: z.boolean(),
  originalPlacementRestorable: z.boolean(),
});
export type HandoffCapability = z.infer<typeof HandoffCapabilitySchema>;

const mediaVerdicts = z.strictObject({
  text: ProbeVerdictSchema,
  structured: ProbeVerdictSchema,
  image: ProbeVerdictSchema,
  error: ProbeVerdictSchema,
  attachment: ProbeVerdictSchema,
});

export const HostSetupSchema = z.strictObject({
  lifecycle: z.enum(["INSTALLED", "CONFIGURED", "VERIFIED"]),
  pluginInstalled: ProbeVerdictSchema,
  skillAvailable: ProbeVerdictSchema,
  hooksRegistered: ProbeVerdictSchema,
  hooksTrusted: ProbeVerdictSchema,
  preToolUseAvailable: ProbeVerdictSchema,
  postToolUseAvailable: ProbeVerdictSchema,
  chromeComputerUseDetectable: ProbeVerdictSchema,
  matcherProfileValid: ProbeVerdictSchema,
  syntheticProbe: ProbeVerdictSchema,
  firstBrowserHookSeen: z.boolean(),
  verificationSource: z.enum([
    "synthetic-probe",
    "passive-first-browser-call",
    "none",
  ]),
  optimization: z.enum(["ACTIVE", "BYPASSED"]),
});
export type HostSetup = z.infer<typeof HostSetupSchema>;

const HostProfileBaseSchema = z.strictObject({
  schemaVersion: z.literal(3),
  profileId: nonEmpty,
  setup: HostSetupSchema,
  identity: z.strictObject({
    surface: z.enum([
      "chatgpt-chat",
      "chatgpt-work",
      "codex-desktop",
      "codex-cli",
    ]),
    hostBuild: nonEmpty,
    codexVersion: nonEmpty.optional(),
    computerUsePluginVersion: nonEmpty.optional(),
    browserPath: z.enum([
      "chrome-extension",
      "built-in-browser",
      "other-browser-extension",
      "none",
    ]),
    os: z.enum(["macos", "windows", "linux", "unknown"]),
  }),
  route: z.strictObject({
    toolRoute: ToolRouteSchema,
    canonicalToolMatchers: z.array(nonEmpty),
    matcherEvidenceHash: hash,
  }),
  action: z.strictObject({
    control: ActionControlSchema,
    preToolCoverage: CoverageEvidenceSchema,
    denyPreventedSideEffect: z.union([z.boolean(), z.literal("unknown")]),
    rewriteFidelity: z.enum([
      "passed",
      "partial",
      "failed",
      "unsupported",
      "unknown",
    ]),
  }),
  nativeInteraction: z.strictObject({
    fidelity: InteractionFidelitySchema,
    pointerOwnerInRunning: z.union([z.literal("NATIVE"), z.literal("unknown")]),
    passThroughFingerprint: ProbeVerdictSchema,
    primitiveParity: z.record(NativePrimitiveSchema, ProbeVerdictSchema),
    cursorVisualization: ProbeVerdictSchema,
    viewportCoordinateMapping: ProbeVerdictSchema,
    screenshotFrameFeedback: ProbeVerdictSchema,
    unexpectedPointerInterference: z.union([
      finiteNonNegative,
      z.literal("unknown"),
    ]),
    unexpectedFocusInterference: z.union([
      finiteNonNegative,
      z.literal("unknown"),
    ]),
    unexpectedScrollInterference: z.union([
      finiteNonNegative,
      z.literal("unknown"),
    ]),
    incorrectNormalActionBlocks: z.union([
      finiteNonNegative,
      z.literal("unknown"),
    ]),
    overlayPolicy: z.enum([
      "NONE",
      "DEBUG_NONINTERACTIVE",
      "UNSAFE",
      "unknown",
    ]),
  }),
  result: z.strictObject({
    postToolCoverage: CoverageEvidenceSchema,
    control: ResultControlSchema,
    replacementTiming: z.enum([
      "before-model-proven",
      "model-visible-only",
      "after-persistence",
      "unknown",
    ]),
    media: mediaVerdicts,
    codeModePromiseSemantics: ProbeVerdictSchema,
    controlCriticalContract: z.strictObject({
      status: z.enum(["passed", "failed", "unknown"]),
      matrixHash: hash.optional(),
      requiredFields: z.array(nonEmpty),
      conditionalFields: z.array(nonEmpty),
      unknownFields: z.array(nonEmpty),
      testedNextStepPrimitives: z.array(NativePrimitiveSchema),
    }),
    rawPersistence: z.array(
      z.enum([
        "none-observed",
        "transcript",
        "completion-event",
        "temporary-file",
        "log",
        "unknown",
      ]),
    ),
  }),
  hooks: z.strictObject({
    policy: z.enum([
      "plugin",
      "user",
      "project",
      "managed-only",
      "disabled",
      "unknown",
    ]),
    trustState: z.enum([
      "active",
      "review-required",
      "skipped",
      "disabled",
      "unknown",
    ]),
    definitionHash: hash,
    concurrentConflictProbe: ProbeVerdictSchema,
  }),
  nativeCapabilities: z.strictObject({
    outputTokenLimit: ProbeVerdictSchema,
    webMcp: ProbeVerdictSchema,
    structuredObservation: ProbeVerdictSchema,
    readOnlyDeveloperTools: ProbeVerdictSchema,
    nativeApprovalFlow: ProbeVerdictSchema,
  }),
  handoff: z.strictObject({
    activation: z.enum(["ACTIVE", "INACTIVE"]),
    inactiveReasons: z.array(nonEmpty),
    capability: HandoffCapabilitySchema,
    conversationContinuity: ProbeVerdictSchema,
    sameTabBinding: ProbeVerdictSchema,
    detachRealTabWindow: ProbeVerdictSchema,
    focusExistingTab: ProbeVerdictSchema,
    exclusiveBrowserLease: ProbeVerdictSchema,
    noAgentObservationDuringLease: ProbeVerdictSchema,
    nonSecretCompletionDetector: ProbeVerdictSchema,
    originAndStateVerification: ProbeVerdictSchema,
    restoreOriginalWindowIndex: ProbeVerdictSchema,
    restorePinnedAndGroupState: ProbeVerdictSchema,
    automaticToolOrEventResume: ProbeVerdictSchema,
    oneClickFallback: ProbeVerdictSchema,
    chatMessageRequired: ProbeVerdictSchema,
  }),
  evidence: z.strictObject({
    probeSuiteVersion: nonEmpty,
    fixtureRevision: nonEmpty,
    traceManifestHash: hash,
    testedAt: z.string().datetime(),
    validUntilHostChange: z.boolean(),
    unresolved: z.array(nonEmpty),
  }),
  derived: z.strictObject({
    mode: HostModeSchema,
    safety: z.enum(["ACTIVE", "INACTIVE"]),
    handoff: z.enum(["ACTIVE", "INACTIVE"]),
    allowedClaims: z.array(nonEmpty),
    forbiddenClaims: z.array(nonEmpty),
  }),
});
export const HostProfileSchema = HostProfileBaseSchema.superRefine(
  (profile, context) => {
    const setupConfigured = [
      profile.setup.pluginInstalled,
      profile.setup.skillAvailable,
      profile.setup.hooksRegistered,
      profile.setup.hooksTrusted,
      profile.setup.preToolUseAvailable,
      profile.setup.postToolUseAvailable,
      profile.setup.chromeComputerUseDetectable,
      profile.setup.matcherProfileValid,
    ].every((verdict) => verdict === "passed");
    if (profile.setup.lifecycle !== "INSTALLED" && !setupConfigured) {
      context.addIssue({
        code: "custom",
        path: ["setup"],
        message: "Configured setup prerequisites must all pass",
      });
    }
    const verifiedBySource =
      (profile.setup.verificationSource === "synthetic-probe" &&
        profile.setup.syntheticProbe === "passed") ||
      (profile.setup.verificationSource === "passive-first-browser-call" &&
        profile.setup.firstBrowserHookSeen);
    if (profile.setup.lifecycle === "VERIFIED" && !verifiedBySource) {
      context.addIssue({
        code: "custom",
        path: ["setup"],
        message: "VERIFIED requires matching route evidence",
      });
    }
    if (
      profile.setup.lifecycle !== "VERIFIED" &&
      profile.setup.verificationSource !== "none"
    ) {
      context.addIssue({
        code: "custom",
        path: ["setup", "verificationSource"],
        message: "Only VERIFIED setup may name a verification source",
      });
    }
    if (
      profile.setup.hooksTrusted === "passed" &&
      profile.hooks.trustState !== "active"
    ) {
      context.addIssue({
        code: "custom",
        path: ["hooks", "trustState"],
        message: "Setup trust evidence and Hook trust state disagree",
      });
    }
    if (profile.setup.lifecycle !== "VERIFIED") {
      if (
        profile.setup.optimization !== "BYPASSED" ||
        profile.derived.safety !== "INACTIVE" ||
        profile.derived.handoff !== "INACTIVE" ||
        profile.handoff.activation !== "INACTIVE"
      ) {
        context.addIssue({
          code: "custom",
          message: "Unverified Oxrail capabilities must be BYPASSED/INACTIVE",
        });
      }
    }
    if (
      profile.setup.optimization === "ACTIVE" &&
      (profile.setup.lifecycle !== "VERIFIED" ||
        profile.derived.mode === "ADVISORY_ONLY" ||
        profile.derived.mode === "UNSUPPORTED")
    ) {
      context.addIssue({
        code: "custom",
        path: ["setup", "optimization"],
        message: "Active optimization requires a verified enforcement mode",
      });
    }
    if (
      profile.derived.safety === "ACTIVE" &&
      profile.setup.optimization !== "ACTIVE"
    ) {
      context.addIssue({
        code: "custom",
        path: ["derived", "safety"],
        message: "Safety cannot be active on a bypassed path",
      });
    }
    if (
      profile.handoff.activation === "ACTIVE" ||
      profile.derived.handoff === "ACTIVE"
    ) {
      if (
        profile.handoff.activation !== "ACTIVE" ||
        profile.derived.handoff !== "ACTIVE" ||
        profile.setup.lifecycle !== "VERIFIED" ||
        profile.setup.optimization !== "ACTIVE" ||
        profile.handoff.capability.lease !== "EXCLUSIVE_USER_LEASE" ||
        ["NONE", "NOTICE_ONLY"].includes(profile.handoff.capability.surface) ||
        ["NONE", "CHAT_MESSAGE_REQUIRED"].includes(
          profile.handoff.capability.resume,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["handoff"],
          message:
            "Active handoff requires verified structured handoff capabilities",
        });
      }
    }
    if (
      (profile.handoff.activation === "INACTIVE" &&
        profile.handoff.inactiveReasons.length === 0) ||
      (profile.handoff.activation === "ACTIVE" &&
        profile.handoff.inactiveReasons.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["handoff", "inactiveReasons"],
        message: "Handoff inactive reasons must match activation",
      });
    }
  },
);
export type HostProfile = z.infer<typeof HostProfileSchema>;

export const RectSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  width: finiteNonNegative,
  height: finiteNonNegative,
});

export const TargetDescriptorSchema = z.strictObject({
  semanticRef: nonEmpty.optional(),
  source: ObservationSourceSchema,
  sourceRevision: nonNegativeInt,
  documentBinding: nonEmpty.optional(),
  role: nonEmpty.optional(),
  name: nonEmpty.optional(),
  label: nonEmpty.optional(),
  text: nonEmpty.optional(),
  regionPath: z.array(nonEmpty).optional(),
  fingerprint: nonEmpty.optional(),
  bbox: RectSchema.optional(),
  confidence: z.number().finite().min(0).max(1),
  risk: z.array(nonEmpty),
});
export type TargetDescriptor = z.infer<typeof TargetDescriptorSchema>;

export const ActionEnvelopeSchema = z.strictObject({
  toolUseId: nonEmpty,
  route: ToolRouteSchema,
  granularity: ActionControlSchema,
  actionType: nonEmpty,
  target: TargetDescriptorSchema.optional(),
  inputDigest: hash.optional(),
  origin: nonEmpty.optional(),
  revision: nonNegativeInt.optional(),
  impact: z.enum(["read", "reversible", "high-impact"]),
});
export type ActionEnvelope = z.infer<typeof ActionEnvelopeSchema>;

export const ActionDigestSchema = z.strictObject({
  toolUseId: nonEmpty,
  route: ToolRouteSchema,
  granularity: ActionControlSchema,
  actionType: nonEmpty,
  targetSignature: hash.optional(),
  inputSignature: hash.optional(),
  sourceRevision: nonNegativeInt.optional(),
  decision: z.enum(["ALLOW", "DENY", "REWRITE", "REQUERY", "HANDOFF"]),
  reasonCode: ReasonCodeSchema,
  timestamp: nonNegativeInt,
});
export type ActionDigest = z.infer<typeof ActionDigestSchema>;

export const ObservationDigestSchema = z.strictObject({
  source: ObservationSourceSchema,
  tier: z.enum(["O0", "O1", "O2", "O3", "O4", "O5"]),
  stateHash: hash,
  urlKey: nonEmpty.optional(),
  documentBinding: nonEmpty.optional(),
  revision: nonNegativeInt,
  relevantRegionHash: hash.optional(),
  actionableHash: hash.optional(),
  blockerType: nonEmpty.optional(),
  payloadTokenEstimate: nonNegativeInt.optional(),
  omittedFields: z.array(nonEmpty).optional(),
  controlCriticalFieldsRetained: z.array(nonEmpty).optional(),
  screenshotFrameCorrelationId: nonEmpty.optional(),
  viewportBinding: nonEmpty.optional(),
});
export type ObservationDigest = z.infer<typeof ObservationDigestSchema>;

export const StateFingerprintSchema = z.strictObject({
  originKey: nonEmpty,
  routeKey: nonEmpty.optional(),
  taskPhase: nonEmpty.optional(),
  relevantRegionHash: hash.optional(),
  actionableHash: hash.optional(),
  dialogHash: hash.optional(),
  goalSignalHash: hash.optional(),
  blockerHash: hash.optional(),
  revision: nonNegativeInt,
});
export type StateFingerprint = z.infer<typeof StateFingerprintSchema>;

export const BrowserTaskStateSchema = z.strictObject({
  schemaVersion: z.literal(3),
  sessionId: nonEmpty,
  turnId: nonEmpty.optional(),
  taskId: nonEmpty,
  goalSummary: z.string().max(500),
  hostProfileId: nonEmpty,
  hostProfileStatus: z.enum(["VALID", "STALE", "DRIFTED", "UNSUPPORTED"]),
  mode: HostModeSchema,
  phase: z.enum([
    "RUNNING",
    "RECOVERING",
    "HANDOFF_PREPARING",
    "USER_LEASE_ACTIVE",
    "HANDOFF_VERIFYING",
    "RESTORING_TAB",
    "RESUMING",
    "DONE",
    "FAILED",
    "CANCELLED",
  ]),
  currentOrigin: nonEmpty.optional(),
  currentUrlKey: nonEmpty.optional(),
  documentBinding: nonEmpty.optional(),
  revision: nonNegativeInt,
  lastObservation: ObservationDigestSchema.optional(),
  lastAction: ActionDigestSchema.optional(),
  noProgressCount: nonNegativeInt,
  recoveryLevel: nonNegativeInt,
  recoveryTransitions: nonNegativeInt,
  authState: z.enum([
    "UNKNOWN",
    "AUTHENTICATED",
    "UNAUTHENTICATED",
    "CHALLENGE",
    "MANUAL_BOUNDARY",
  ]),
  activeHandoffId: nonEmpty.optional(),
  leaseEpoch: nonNegativeInt,
  pointerOwner: PointerOwnerSchema,
  targetCacheEpoch: nonNegativeInt,
  pendingNativeActionIds: z.array(nonEmpty),
  stateVersion: nonNegativeInt,
});
export type BrowserTaskState = z.infer<typeof BrowserTaskStateSchema>;

export const NativeActionDispositionSchema = z.enum([
  "PASS_THROUGH_ORIGINAL",
  "SEMANTIC_HINT_ONLY",
  "BLOCK_BEFORE_EXECUTION",
  "REQUEST_HOST_APPROVAL",
  "REQUEST_HUMAN_HANDOFF",
]);
export type NativeActionDisposition = z.infer<
  typeof NativeActionDispositionSchema
>;

export const PolicyDecisionSchema = z.strictObject({
  disposition: NativeActionDispositionSchema,
  reasonCode: ReasonCodeSchema,
  recoverable: z.boolean(),
});
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;

export const GuardDecisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("ALLOW"), reasonCode: ReasonCodeSchema }),
  z.strictObject({
    kind: z.literal("DENY"),
    reasonCode: ReasonCodeSchema,
    recoverable: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("REWRITE"),
    reasonCode: ReasonCodeSchema,
    updatedInput: z.unknown(),
  }),
  z.strictObject({
    kind: z.literal("REQUERY"),
    reasonCode: ReasonCodeSchema,
    requiredTier: nonEmpty,
  }),
  z.strictObject({
    kind: z.literal("HANDOFF"),
    reasonCode: ReasonCodeSchema,
    handoffType: nonEmpty,
  }),
]);
export type GuardDecision = z.infer<typeof GuardDecisionSchema>;

export const ControlOwnershipStateSchema = z.strictObject({
  phase: z.enum(["RUNNING", "USER_LEASE_ACTIVE", "RESUMING"]),
  pointerOwner: PointerOwnerSchema,
  keyboardOwner: PointerOwnerSchema,
  browserObservationAllowedForAgent: z.boolean(),
  browserActionAllowedForAgent: z.boolean(),
  leaseEpoch: nonNegativeInt,
  targetCacheEpoch: nonNegativeInt,
});
export type ControlOwnershipState = z.infer<typeof ControlOwnershipStateSchema>;

export const ControlCriticalFieldRuleSchema = z.strictObject({
  fieldPath: nonEmpty,
  criticality: z.enum(["REQUIRED", "CONDITIONAL", "OPTIMIZABLE", "UNKNOWN"]),
  conditions: z.array(nonEmpty).optional(),
  nextPrimitivesTested: z.array(NativePrimitiveSchema),
  hostProfileId: nonEmpty,
  evidenceIds: z.array(nonEmpty),
  rationale: nonEmpty,
});

export const ControlCriticalContractSchema = z.strictObject({
  contractId: nonEmpty,
  hostProfileId: nonEmpty,
  resultMedia: z.enum(["text", "structured", "image", "error", "attachment"]),
  rules: z.array(ControlCriticalFieldRuleSchema),
  originalResultTiming: z.enum(["PRE_MODEL_PROVEN", "UNKNOWN"]),
  verdict: z.enum(["PASS", "FAIL", "INCOMPLETE"]),
  matrixHash: hash,
});
export type ControlCriticalContract = z.infer<
  typeof ControlCriticalContractSchema
>;

export const SetupVerificationSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    stage: z.enum(["INSTALLED", "CONFIGURED", "VERIFIED"]),
    pluginInstalled: z.boolean(),
    skillAvailable: z.boolean(),
    hooksRegistered: z.boolean(),
    hooksTrusted: z.boolean(),
    preToolUseAvailable: ProbeVerdictSchema,
    postToolUseAvailable: ProbeVerdictSchema,
    chromeComputerUseDetectable: ProbeVerdictSchema,
    matcherProfileValid: z.boolean(),
    handoffCapability: HandoffCapabilitySchema,
    syntheticProbeUsed: z.boolean(),
    firstBrowserHookSeen: z.boolean(),
    verificationSource: z.enum([
      "synthetic-probe",
      "passive-first-browser-call",
      "none",
    ]),
    optimization: z.enum(["ACTIVE", "BYPASSED"]),
    safetyProtectionActive: z.boolean(),
    handoffProtectionActive: z.boolean(),
    resultingMode: HostModeSchema,
  })
  .superRefine((setup, context) => {
    const configured =
      setup.pluginInstalled &&
      setup.skillAvailable &&
      setup.hooksRegistered &&
      setup.hooksTrusted &&
      setup.preToolUseAvailable === "passed" &&
      setup.postToolUseAvailable === "passed" &&
      setup.chromeComputerUseDetectable === "passed" &&
      setup.matcherProfileValid;
    if (setup.stage !== "INSTALLED" && !configured) {
      context.addIssue({
        code: "custom",
        message: `${setup.stage} requires trusted, valid configuration`,
      });
    }
    if (setup.stage === "VERIFIED" && setup.verificationSource === "none") {
      context.addIssue({
        code: "custom",
        message:
          "VERIFIED requires a real or harmless synthetic hook-path probe",
      });
    }
    if (setup.stage !== "VERIFIED" && setup.verificationSource !== "none") {
      context.addIssue({
        code: "custom",
        message: "Only VERIFIED setup may name a verification source",
      });
    }
    if (
      setup.verificationSource === "synthetic-probe" &&
      !setup.syntheticProbeUsed
    ) {
      context.addIssue({
        code: "custom",
        message: "Synthetic verification requires a synthetic probe",
      });
    }
    if (
      setup.verificationSource === "passive-first-browser-call" &&
      !setup.firstBrowserHookSeen
    ) {
      context.addIssue({
        code: "custom",
        message: "Passive verification requires a browser Hook observation",
      });
    }
    if (!setup.hooksTrusted || setup.optimization === "BYPASSED") {
      if (setup.safetyProtectionActive || setup.handoffProtectionActive) {
        context.addIssue({
          code: "custom",
          message: "Bypassed or untrusted hooks cannot claim active protection",
        });
      }
    }
    if (setup.optimization === "ACTIVE" && setup.stage !== "VERIFIED") {
      context.addIssue({
        code: "custom",
        message: "Active optimization requires VERIFIED state",
      });
    }
    if (setup.stage !== "VERIFIED") {
      if (
        setup.optimization !== "BYPASSED" ||
        setup.safetyProtectionActive ||
        setup.handoffProtectionActive
      ) {
        context.addIssue({
          code: "custom",
          message: "Unverified setup must remain BYPASSED/INACTIVE",
        });
      }
      if (
        setup.stage === "CONFIGURED" &&
        setup.resultingMode !== "ADVISORY_ONLY"
      ) {
        context.addIssue({
          code: "custom",
          message: "Pending route verification is ADVISORY_ONLY",
        });
      }
    }
    if (
      setup.handoffProtectionActive &&
      (setup.handoffCapability.lease !== "EXCLUSIVE_USER_LEASE" ||
        setup.handoffCapability.surface === "NONE" ||
        setup.handoffCapability.surface === "NOTICE_ONLY" ||
        setup.handoffCapability.resume === "NONE" ||
        setup.handoffCapability.resume === "CHAT_MESSAGE_REQUIRED")
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Handoff protection requires an effective lease, surface, and continuation",
      });
    }
  });
export type SetupVerification = z.infer<typeof SetupVerificationSchema>;

const evidenceArtifactPath = nonEmpty.refine((value) => {
  const normalized = value.replaceAll("\\", "/");
  return (
    value === normalized &&
    !normalized.startsWith("/") &&
    !/^[a-z]:/i.test(normalized) &&
    normalized
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== "..")
  );
}, "expected a relative artifact path without traversal");

const workPackageId = nonEmpty.regex(/^WP-[A-Z0-9]+-\d{3}$/);
const releaseDependencies = [
  "WP-HOST-008",
  "WP-GRD-006",
  "WP-NIF-005",
  "WP-SEC-000",
] as const;

export const EvidenceManifestSchema = z
  .strictObject({
    work_package: workPackageId,
    status: z.enum([
      "PLANNED",
      "READY",
      "IN_PROGRESS",
      "IN_REVIEW",
      "ACCEPTED",
      "BLOCKED",
      "REJECTED",
      "KILLED",
    ]),
    commit: nonEmpty,
    spec_version: z.literal("0.5.0"),
    environment: z.record(nonEmpty, nonEmpty),
    schema_hashes: z.record(evidenceArtifactPath, hash),
    host_profiles: z.array(evidenceArtifactPath),
    commands: z.array(nonEmpty),
    test_results: z.array(evidenceArtifactPath),
    reviewers: z.array(nonEmpty),
    sha256_manifest: hash.nullable(),
    accepted_at: z.string().datetime().nullable(),
    blockers: z.array(nonEmpty),
    dependency_manifests: z
      .array(
        z.strictObject({
          work_package: workPackageId,
          path: evidenceArtifactPath,
        }),
      )
      .default([]),
    experiment_protocol: z
      .strictObject({
        runner_isolation: z.literal("ISOLATED_SUBAGENT_PER_ARM"),
        coordinator_result_sharing: z.literal("NONE_BEFORE_PAIR_COMPLETE"),
      })
      .optional(),
  })
  .superRefine((manifest, context) => {
    if (manifest.status === "BLOCKED" && manifest.blockers.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["blockers"],
        message: "BLOCKED evidence must name at least one blocker",
      });
    }
    if (manifest.status !== "ACCEPTED") return;

    const requiredCollections = [
      ["environment", Object.keys(manifest.environment).length],
      ["schema_hashes", Object.keys(manifest.schema_hashes).length],
      ["host_profiles", manifest.host_profiles.length],
      ["commands", manifest.commands.length],
      ["test_results", manifest.test_results.length],
      ["reviewers", manifest.reviewers.length],
    ] as const;
    for (const [path, size] of requiredCollections) {
      if (size === 0) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `ACCEPTED evidence requires ${path}`,
        });
      }
    }
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(manifest.commit)) {
      context.addIssue({
        code: "custom",
        path: ["commit"],
        message: "ACCEPTED evidence requires a full Git commit id",
      });
    }
    if (manifest.blockers.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["blockers"],
        message: "ACCEPTED evidence cannot retain blockers",
      });
    }
    if (manifest.sha256_manifest === null) {
      context.addIssue({
        code: "custom",
        path: ["sha256_manifest"],
        message: "ACCEPTED evidence requires a SHA256SUMS digest",
      });
    }
    if (manifest.accepted_at === null) {
      context.addIssue({
        code: "custom",
        path: ["accepted_at"],
        message: "ACCEPTED evidence requires an acceptance timestamp",
      });
    }
    if (manifest.work_package === "WP-RLS-010") {
      const dependencies = manifest.dependency_manifests.map(
        ({ work_package }) => work_package,
      );
      if (
        dependencies.length !== releaseDependencies.length ||
        releaseDependencies.some(
          (workPackage) =>
            dependencies.filter((candidate) => candidate === workPackage)
              .length !== 1,
        )
      ) {
        context.addIssue({
          code: "custom",
          path: ["dependency_manifests"],
          message: `WP-RLS-010 requires exactly ${releaseDependencies.join(", ")}`,
        });
      }
      if (!manifest.experiment_protocol) {
        context.addIssue({
          code: "custom",
          path: ["experiment_protocol"],
          message: "WP-RLS-010 requires the isolated A/B experiment protocol",
        });
      }
    }
  });
export type EvidenceManifest = z.infer<typeof EvidenceManifestSchema>;

export const EvidenceTraceSchema = z
  .strictObject({
    schema_version: z.literal(4),
    run_id: nonEmpty,
    task_id: nonEmpty,
    suite: z.enum([
      "HOST_REALITY",
      "NATIVE_INTERACTION",
      "OXRAIL",
      "STALL",
      "SECRET_LEAK",
    ]),
    test_id: nonEmpty,
    model_id: nonEmpty,
    variant: z.enum(["NATIVE_TUNED", "OXRAIL_GUARD"]),
    pair_id: nonEmpty,
    run_index: z.number().int().positive(),
    seed: nonEmpty,
    control_hash: hash,
    model_settings_hash: hash,
    context_isolation_id: hash.describe(
      "Salted SHA-256 digest of the isolated runner's parent Hook session_id",
    ),
    runner_id: hash,
    spec_version: z.literal("0.5.0"),
    work_package_ids: z.array(nonEmpty),
    host_profile_id: nonEmpty,
    host: z.strictObject({
      surface: nonEmpty,
      build: nonEmpty,
      computer_use_plugin: nonEmpty,
      browser_path: nonEmpty,
      browser_version: nonEmpty,
      os: nonEmpty,
    }),
    capabilities: z.strictObject({
      tool_route: nonEmpty,
      action_control: ActionControlSchema,
      result_control: ResultControlSchema,
      interaction_fidelity: InteractionFidelitySchema,
      control_critical_contract_id: nonEmpty,
      handoff: nonEmpty,
    }),
    metrics: z.strictObject({
      success: z.boolean(),
      duration_ms: finiteNonNegative,
      browser_invocations: nonNegativeInt,
      redundant_actions: nonNegativeInt,
      browser_observation_payload_tokens: nonNegativeInt,
      oxrail_context_tokens: nonNegativeInt,
      total_model_input_tokens: nonNegativeInt.nullable(),
      total_model_output_tokens: nonNegativeInt.nullable(),
      token_measurement_source: z.enum([
        "HOST_EXACT",
        "PAYLOAD_ONLY",
        "UNAVAILABLE",
      ]),
      native_primitive_parity: z.boolean(),
      pointer_interference: nonNegativeInt,
      focus_interference: nonNegativeInt,
      scroll_interference: nonNegativeInt,
      incorrect_normal_blocks: nonNegativeInt,
      oxrail_generated_page_write_events: nonNegativeInt,
      post_handoff_stale_target_executions: nonNegativeInt,
      known_supported_path_hook_bypasses: nonNegativeInt,
      deny_side_effect_failures: nonNegativeInt,
      unapproved_high_impact_actions: nonNegativeInt,
      agent_actions_during_user_lease: nonNegativeInt,
      agent_observations_during_user_lease: nonNegativeInt,
      secret_occurrences: nonNegativeInt,
      hook_overhead_ms: finiteNonNegative,
      secret_exposure: z.literal(false),
    }),
    artifact_hashes: z.record(nonEmpty, hash),
  })
  .superRefine((trace, context) => {
    const totals = [
      trace.metrics.total_model_input_tokens,
      trace.metrics.total_model_output_tokens,
    ];
    const invalidTotals =
      trace.metrics.token_measurement_source === "HOST_EXACT"
        ? totals.some((value) => value === null)
        : totals.some((value) => value !== null);
    if (invalidTotals) {
      context.addIssue({
        code: "custom",
        path: ["metrics", "token_measurement_source"],
        message: "Only HOST_EXACT evidence may report total model tokens",
      });
    }
  });
export type EvidenceTrace = z.infer<typeof EvidenceTraceSchema>;

export const ProtocolSchemas = {
  "host-profile": HostProfileSchema,
  "browser-task-state": BrowserTaskStateSchema,
  "action-envelope": ActionEnvelopeSchema,
  "action-digest": ActionDigestSchema,
  "observation-digest": ObservationDigestSchema,
  "state-fingerprint": StateFingerprintSchema,
  "control-critical-contract": ControlCriticalContractSchema,
  "setup-verification": SetupVerificationSchema,
  "evidence-manifest": EvidenceManifestSchema,
  "evidence-trace": EvidenceTraceSchema,
} as const;
