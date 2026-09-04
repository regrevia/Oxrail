import { z } from "zod";

import { deterministicDigest } from "./digest.js";
import { ReasonCodeSchema } from "./reason-codes.js";

const nonEmpty = z.string().min(1);
const hash = z
  .string()
  .regex(/^[a-f0-9]{64}$/i, "expected a SHA-256 hex digest");
const lowercaseHash = z
  .string()
  .regex(/^[a-f0-9]{64}$/, "expected a lowercase SHA-256 hex digest");
const codeDirectoryHash = z
  .string()
  .regex(
    /^[a-f0-9]{40}$/,
    "expected a lowercase 20-byte CodeDirectory hash (CDHash)",
  );
const exactToolName = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9_.:/-]+$/,
    "expected an exact tool name, not a matcher expression",
  );
const finiteNonNegative = z.number().finite().nonnegative();
const nonNegativeInt = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const positiveInt = nonNegativeInt.min(1);
const noCredentialKinds = z.array(z.literal("API_KEY")).length(0);
const apiKeyOnly = z.array(z.literal("API_KEY")).length(1);
const credentialRegistryId = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._:-]*$/);
const canonicalHttpsOrigin = z
  .string()
  .max(2_048)
  .superRefine((value, ctx) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:" || parsed.origin !== value) {
        ctx.addIssue({
          code: "custom",
          message: "expected a canonical HTTPS origin",
        });
      }
    } catch {
      ctx.addIssue({
        code: "custom",
        message: "expected a canonical HTTPS origin",
      });
    }
  });

export function toolRegistryManifestBinding(input: {
  canonicalToolName: string;
  definitionHash: string;
  inputSchemaHash: string;
  matcherEvidenceHash: string;
  profileId: string;
  toolSchemaRegistryEvidenceId: string;
  toolSchemaRegistryHash: string;
}): string {
  return deterministicDigest("oxrail-tool-registry-manifest-binding-v1", input);
}

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

const handoffText = z
  .string()
  .min(1)
  .max(4_096)
  .regex(/^[^\u0000-\u001f\u007f]+$/, "must not contain control characters");
const handoffSafeNonNegativeInt = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);
const handoffSafePositiveInt = handoffSafeNonNegativeInt.min(1);
const handoffNonce = z
  .string()
  .regex(
    /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/,
    "expected a canonical 32-byte base64url nonce",
  );
const handoffTimeout = z.number().int().min(1_000).max(900_000);
const handoffType = z.enum([
  "AUTH_REQUIRED",
  "MFA_REQUIRED",
  "PASSKEY_REQUIRED",
  "CAPTCHA_REQUIRED",
  "SENSITIVE_INPUT",
  "PERMISSION_REQUIRED",
  "HIGH_IMPACT_CONFIRMATION",
  "FILE_PICKER_REQUIRED",
  "OS_DIALOG_REQUIRED",
  "UNKNOWN_MANUAL_BOUNDARY",
]);
const handoffCompletionPolicy = z.enum([
  "AUTH_FLOW_COMPLETED",
  "DIALOG_OR_ROUTE_COMPLETED",
  "MANUAL_DONE_THEN_VERIFY",
]);
const completionPolicyByType = {
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
} as const satisfies Record<
  z.infer<typeof handoffType>,
  z.infer<typeof handoffCompletionPolicy>
>;
function phaseMatchesPolicy(policy: string, phase: string): boolean {
  if (policy === "AUTH_FLOW_COMPLETED") {
    return ["CHALLENGE_GONE", "AUTH_MARKER_PRESENT", "EXPECTED_ROUTE"].includes(
      phase,
    );
  }
  return (
    policy === "DIALOG_OR_ROUTE_COMPLETED" &&
    ["DIALOG_CLOSED", "EXPECTED_ROUTE"].includes(phase)
  );
}
const handoffCompletionKind = z.enum([
  "CHALLENGE_GONE",
  "AUTH_MARKER_PRESENT",
  "EXPECTED_ROUTE",
  "DIALOG_CLOSED",
  "MANUAL_DONE",
  "CANCELLED",
  "UNSAFE_ORIGIN",
]);
const handoffAutomaticPhase = z.enum([
  "CHALLENGE_GONE",
  "AUTH_MARKER_PRESENT",
  "EXPECTED_ROUTE",
  "DIALOG_CLOSED",
]);
const handoffCompletionState = z.enum([
  "CONFIRMED",
  "NOT_CONFIRMED",
  "UNKNOWN",
]);
const handoffTabState = z.enum(["BOUND", "CLOSED", "MISMATCH", "UNKNOWN"]);
const handoffNavigationState = z.enum(["IDLE", "CHANGING", "UNKNOWN"]);
const handoffRedirectState = z.enum([
  "CONTINUOUSLY_ALLOWED",
  "UNSAFE_SEEN",
  "UNKNOWN",
]);
const handoffSensitivePhase = z.enum(["CLEARED", "ACTIVE", "UNKNOWN"]);
const handoffPhaseSignal = z.enum([
  "CHALLENGE_GONE",
  "AUTH_MARKER_PRESENT",
  "EXPECTED_ROUTE",
  "DIALOG_CLOSED",
  "MANUAL_DONE",
]);
const handoffOutcome = z.enum([
  "VERIFIED_COMPLETE",
  "USER_ASSERTED_AND_VERIFIED",
  "CANCELLED",
  "TIMED_OUT",
  "UNSAFE_ORIGIN",
  "TAB_CLOSED",
  "VERIFICATION_FAILED",
]);
const loopbackFixtureOrigin = "http://127.0.0.1:4173";
const handoffOrigin = z
  .string()
  .max(2_048)
  .superRefine((value, context) => {
    try {
      const parsed = new URL(value);
      if (
        parsed.origin !== value ||
        (parsed.protocol !== "https:" && value !== loopbackFixtureOrigin)
      ) {
        context.addIssue({
          code: "custom",
          message:
            "expected a canonical HTTPS origin or the build-fixed loopback fixture origin",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message:
          "expected a canonical HTTPS origin or the build-fixed loopback fixture origin",
      });
    }
  });

/** Complete Agent-visible input. Host-owned binding fields are rejected. */
export const HandoffToolInputSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    type: handoffType,
  })
  .describe(
    "Strict Agent-visible Handoff input. Shape validation is non-authorizing and does not activate Handoff.",
  );
export type HandoffToolInput = z.infer<typeof HandoffToolInputSchema>;

/** Host-bound request. Its values still require a trusted current Host context. */
export const HandoffRequestSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    handoffId: handoffText,
    sessionId: handoffText,
    taskId: handoffText,
    toolUseId: handoffText.optional(),
    leaseEpoch: handoffSafePositiveInt,
    nonce: handoffNonce,
    type: handoffType,
    tabBinding: z
      .strictObject({
        tabId: handoffSafeNonNegativeInt,
        windowId: handoffSafeNonNegativeInt,
        index: handoffSafeNonNegativeInt,
        pinned: z.boolean().optional(),
        groupId: handoffSafeNonNegativeInt.optional(),
        topOrigin: handoffOrigin,
        allowedRedirectOrigins: z.array(handoffOrigin).max(8).optional(),
        initialDocumentBinding: handoffText,
      })
      .superRefine((binding, context) => {
        const redirects = binding.allowedRedirectOrigins ?? [];
        if (
          new Set(redirects).size !== redirects.length ||
          redirects.includes(binding.topOrigin)
        ) {
          context.addIssue({
            code: "custom",
            path: ["allowedRedirectOrigins"],
            message:
              "redirect origins must be unique and must not repeat topOrigin",
          });
        }
      }),
    completionPolicy: handoffCompletionPolicy,
    timeoutMs: handoffTimeout,
    createdAt: handoffSafeNonNegativeInt,
  })
  .superRefine((request, context) => {
    if (request.completionPolicy !== completionPolicyByType[request.type]) {
      context.addIssue({
        code: "custom",
        path: ["completionPolicy"],
        message: "Handoff type and Host-derived completion policy disagree",
      });
    }
    if (request.createdAt > Number.MAX_SAFE_INTEGER - request.timeoutMs) {
      context.addIssue({
        code: "custom",
        path: ["timeoutMs"],
        message: "createdAt + timeoutMs must be a safe integer",
      });
    }
  })
  .describe(
    "Strict runtime-only Host-bound Handoff request. It is not published as portable JSON Schema because its refinements require @oxrail/protocol; validation is non-authorizing and does not prove its Host binding.",
  );
export type HandoffRequest = z.infer<typeof HandoffRequestSchema>;

export const HandoffCompletionSignalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    handoffId: handoffText,
    sessionId: handoffText,
    taskId: handoffText,
    leaseEpoch: handoffSafePositiveInt,
    nonce: handoffNonce,
    tabId: handoffSafeNonNegativeInt,
    initialDocumentBinding: handoffText,
    observedDocumentBinding: handoffText,
    origin: handoffOrigin,
    source: z.enum(["ISOLATED_VERIFIER", "EXTENSION_OWNED_UI"]),
    kind: handoffCompletionKind,
    confidence: z.enum(["DETERMINISTIC", "HEURISTIC", "USER_ASSERTED"]),
    observedAt: handoffSafeNonNegativeInt,
  })
  .superRefine((signal, context) => {
    const userSignal = ["MANUAL_DONE", "CANCELLED"].includes(signal.kind);
    const validConfidence =
      (userSignal &&
        signal.source === "EXTENSION_OWNED_UI" &&
        signal.confidence === "USER_ASSERTED") ||
      (signal.kind === "UNSAFE_ORIGIN" &&
        signal.source === "ISOLATED_VERIFIER" &&
        signal.confidence === "DETERMINISTIC") ||
      (!userSignal &&
        signal.kind !== "UNSAFE_ORIGIN" &&
        signal.source === "ISOLATED_VERIFIER" &&
        signal.confidence !== "USER_ASSERTED");
    if (!validConfidence) {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "completion kind and confidence are inconsistent",
      });
    }
  })
  .describe(
    "Strict runtime-only non-secret Handoff completion signal. It is not published as portable JSON Schema because its refinements require @oxrail/protocol; validation is non-authorizing and the current lease binding must still be verified.",
  );
export type HandoffCompletionSignal = z.infer<
  typeof HandoffCompletionSignalSchema
>;

export const HandoffVerificationSampleSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    handoffId: handoffText,
    sessionId: handoffText,
    taskId: handoffText,
    leaseEpoch: handoffSafePositiveInt,
    nonce: handoffNonce,
    probeSequence: handoffSafePositiveInt,
    verifierContextBindingHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/, "expected a lowercase SHA-256 hex digest"),
    tabId: handoffSafeNonNegativeInt,
    initialDocumentBinding: handoffText,
    observedDocumentBinding: handoffText,
    origin: handoffOrigin,
    stateEpoch: handoffSafePositiveInt,
    completionState: handoffCompletionState,
    automaticPhase: handoffAutomaticPhase.optional(),
    tabState: handoffTabState,
    navigationState: handoffNavigationState,
    redirectState: handoffRedirectState,
    sensitivePhase: handoffSensitivePhase,
  })
  .superRefine((sample, context) => {
    if (
      sample.completionState !== "CONFIRMED" &&
      sample.automaticPhase !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["automaticPhase"],
        message: "only a confirmed completion may report an automatic phase",
      });
    }
  })
  .describe(
    "Strict runtime-only non-secret Handoff verification sample. It is non-authorizing and is not published as portable JSON Schema; authenticated transport provenance and current Host bindings must still be verified, and the context hash is not authentication.",
  );
export type HandoffVerificationSample = z.infer<
  typeof HandoffVerificationSampleSchema
>;

export const HandoffCurrentTabReceiptSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    authority: z.literal("FIXTURE_ONLY_NON_AUTHORIZING"),
    candidateDigest: lowercaseHash,
    admissionGeneration: handoffSafePositiveInt,
    hostProfileBindingHash: lowercaseHash,
    browserInstanceBindingHash: lowercaseHash,
    activationNativeActionFenceHash: lowercaseHash,
    activationTabBindingReceiptHash: lowercaseHash,
    completionNativeActionFenceHash: lowercaseHash,
    completionReceiptHash: lowercaseHash,
    exclusiveTabLease: z.enum(["HELD", "NOT_HELD", "UNKNOWN"]),
    agentActionLane: z.enum(["SUSPENDED", "ACTIVE", "UNKNOWN"]),
    agentObservationLane: z.enum(["SUSPENDED", "ACTIVE", "UNKNOWN"]),
    tabId: handoffSafeNonNegativeInt,
    initialDocumentBinding: handoffText,
    observedDocumentBinding: handoffText,
    origin: handoffOrigin,
    verifierContextBindingHash: lowercaseHash,
    stateEpoch: handoffSafePositiveInt,
    lastAcceptedProbeSequence: handoffSafePositiveInt,
    completionState: handoffCompletionState,
    automaticPhase: handoffAutomaticPhase.optional(),
    tabState: handoffTabState,
    navigationState: handoffNavigationState,
    redirectState: handoffRedirectState,
    sensitivePhase: handoffSensitivePhase,
  })
  .superRefine((receipt, context) => {
    if (
      receipt.completionState !== "CONFIRMED" &&
      receipt.automaticPhase !== undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["automaticPhase"],
        message: "only a confirmed completion may report an automatic phase",
      });
    }
  })
  .describe(
    "Strict runtime-only fixture current-tab receipt. It is non-authorizing, contains no sender time or page content, and is not published as portable JSON Schema.",
  );
export type HandoffCurrentTabReceipt = z.infer<
  typeof HandoffCurrentTabReceiptSchema
>;

const HandoffResultBodySchema = z.strictObject({
  outcome: handoffOutcome,
  phaseSignal: handoffPhaseSignal.optional(),
  sameTab: z.boolean(),
  tabRestored: z.boolean(),
  agentLeaseRestored: z.boolean(),
  secretObserved: z.literal(false),
});
type HandoffResultBody = z.infer<typeof HandoffResultBodySchema>;

function handoffResultError(
  result: HandoffResultBody & {
    completionPolicy?: z.infer<typeof handoffCompletionPolicy> | undefined;
    finalOrigin?: string | undefined;
  },
  requireInternalBindings: boolean,
): string | undefined {
  const successful = [
    "VERIFIED_COMPLETE",
    "USER_ASSERTED_AND_VERIFIED",
  ].includes(result.outcome);
  if (
    successful &&
    (!result.phaseSignal ||
      !result.sameTab ||
      !result.agentLeaseRestored ||
      (requireInternalBindings && !result.finalOrigin))
  ) {
    return "successful Handoff results require the applicable verified fields, same tab, and restored Agent lease";
  }
  if (
    result.outcome === "USER_ASSERTED_AND_VERIFIED" &&
    result.phaseSignal !== "MANUAL_DONE"
  ) {
    return "user-asserted verified results require MANUAL_DONE";
  }
  if (
    result.outcome === "VERIFIED_COMPLETE" &&
    result.phaseSignal === "MANUAL_DONE"
  ) {
    return "automatic verified results cannot use MANUAL_DONE";
  }
  if (
    requireInternalBindings &&
    result.outcome === "VERIFIED_COMPLETE" &&
    result.completionPolicy &&
    result.phaseSignal &&
    !phaseMatchesPolicy(result.completionPolicy, result.phaseSignal)
  ) {
    return "phase signal does not belong to the current completion policy";
  }
  if (!successful && result.phaseSignal !== undefined) {
    return "non-success Handoff results cannot include a phase signal";
  }
  if (
    [
      "TIMED_OUT",
      "UNSAFE_ORIGIN",
      "TAB_CLOSED",
      "VERIFICATION_FAILED",
    ].includes(result.outcome) &&
    result.agentLeaseRestored
  ) {
    return "unsafe Handoff failures cannot restore the Agent lease";
  }
  if (result.outcome === "TAB_CLOSED" && result.sameTab) {
    return "TAB_CLOSED cannot report same-tab continuity";
  }
  if (result.outcome === "TAB_CLOSED" && result.tabRestored) {
    return "TAB_CLOSED cannot report restored tab placement";
  }
}

export const HandoffResultSchema = HandoffResultBodySchema.extend({
  schemaVersion: z.literal(1),
  handoffId: handoffText,
  sessionId: handoffText,
  taskId: handoffText,
  leaseEpoch: handoffSafePositiveInt,
  nonce: handoffNonce,
  completionPolicy: handoffCompletionPolicy,
  finalOrigin: handoffOrigin.optional(),
})
  .superRefine((result, context) => {
    const message = handoffResultError(result, true);
    if (message) context.addIssue({ code: "custom", message });
  })
  .describe(
    "Strict runtime-only Host-internal bound Handoff result. It is not published as portable JSON Schema because its refinements require @oxrail/protocol; validation is non-authorizing and does not resume a continuation.",
  );
export type HandoffResult = z.infer<typeof HandoffResultSchema>;

export const HandoffToolResultSchema = HandoffResultBodySchema.extend({
  schemaVersion: z.literal(1),
})
  .superRefine((result, context) => {
    const message = handoffResultError(result, false);
    if (message) context.addIssue({ code: "custom", message });
  })
  .describe(
    "Strict runtime-only model-visible Handoff result projection. It is not published as portable JSON Schema because its cross-field refinements require @oxrail/protocol; it contains no internal binding or origin fields and is non-authorizing.",
  );
export type HandoffToolResult = z.infer<typeof HandoffToolResultSchema>;

export const CredentialChannelCapabilitySchema = z.strictObject({
  platform: z.enum(["macos", "unsupported"]),
  surface: z.enum(["MACOS_NATIVE_SECURE_PROMPT", "NONE"]),
  storage: z.enum(["MACOS_KEYCHAIN", "NONE"]),
  acceptedKinds: z.union([apiKeyOnly, noCredentialKinds]),
  consumerMode: z.enum(["REGISTERED_IN_ENCLAVE_ADAPTER_ONLY", "NONE"]),
  consumerReadiness: z.enum([
    "AUDITED_REAL_CONSUMER",
    "FIXTURE_ONLY",
    "UNSUPPORTED",
  ]),
  opaqueReferenceOnly: z.boolean(),
  genericSecretExport: z.literal("DENIED"),
});
export type CredentialChannelCapability = z.infer<
  typeof CredentialChannelCapabilitySchema
>;

/** The only Agent-visible request shape; page content has no caller authority. */
export const CredentialProvisionIntentSchema = z.strictObject({
  schemaVersion: z.literal(1),
  credentialUseId: credentialRegistryId,
});
export type CredentialProvisionIntent = z.infer<
  typeof CredentialProvisionIntentSchema
>;

/** Secret-free entry loaded from a fixed, sealed registry. */
export const CredentialUseRegistryEntrySchema = z.strictObject({
  schemaVersion: z.literal(1),
  credentialUseId: credentialRegistryId,
  credentialKind: z.literal("API_KEY"),
  templateId: credentialRegistryId,
  serviceId: credentialRegistryId,
  provisioningOrigin: canonicalHttpsOrigin,
  purposeId: credentialRegistryId,
  consumerId: credentialRegistryId,
  grantTtlSeconds: z.number().int().positive().max(31_536_000),
  generation: positiveInt,
  readiness: z.literal("FIXTURE_ONLY"),
  registryVersion: positiveInt,
  templateRegistryHash: hash,
  consumerRegistryHash: hash,
  registryManifestHash: hash,
});
export type CredentialUseRegistryEntry = z.infer<
  typeof CredentialUseRegistryEntrySchema
>;

/**
 * Internal, secret-free fixture ticket. It is deliberately non-authorizing:
 * a future signed macOS verifier must mint the real enclave launch authority.
 */
export const CredentialEnclaveTicketSchema = z.strictObject({
  schemaVersion: z.literal(1),
  authority: z.literal("FIXTURE_ONLY_NON_AUTHORIZING"),
  ticketId: z.string().regex(/^oct1_[a-f0-9]{64}$/),
  credentialUseId: credentialRegistryId,
  credentialKind: z.literal("API_KEY"),
  templateId: credentialRegistryId,
  serviceId: credentialRegistryId,
  provisioningOrigin: canonicalHttpsOrigin,
  purposeId: credentialRegistryId,
  consumerId: credentialRegistryId,
  grantTtlSeconds: z.number().int().positive().max(31_536_000),
  generation: positiveInt,
  registryVersion: positiveInt,
  templateRegistryHash: hash,
  consumerRegistryHash: hash,
  registryManifestHash: hash,
  issuedAt: nonNegativeInt,
  handoff: z.strictObject({
    handoffId: nonEmpty.max(4_096),
    sessionId: nonEmpty.max(4_096),
    taskId: nonEmpty.max(4_096),
    tabId: nonNegativeInt,
    topOrigin: canonicalHttpsOrigin,
    documentBinding: nonEmpty.max(4_096),
    leaseEpoch: positiveInt,
    acquiredAt: nonNegativeInt,
    expiresAt: nonNegativeInt,
    bindingHash: hash,
  }),
});
export type CredentialEnclaveTicket = z.infer<
  typeof CredentialEnclaveTicketSchema
>;

const opaqueCredentialRef = z
  .string()
  .regex(/^ocref1_[A-Za-z0-9_-]{43}$/, "expected an opaque credential ref");
const credentialPublicResultBase = {
  schemaVersion: z.literal(1),
};

/** The complete model-visible result surface; no free-form error text exists. */
export const CredentialPublicResultSchema = z.union([
  z.strictObject({
    ...credentialPublicResultBase,
    status: z.enum(["READY", "STORED"]),
    credentialRef: opaqueCredentialRef,
  }),
  z.strictObject({
    ...credentialPublicResultBase,
    status: z.literal("CANCELLED"),
  }),
  z.strictObject({
    ...credentialPublicResultBase,
    status: z.literal("ERROR"),
    errorCode: z.enum([
      "UNAVAILABLE",
      "NOT_AUTHORIZED",
      "SCOPE_MISMATCH",
      "EXPIRED",
      "REVOKED",
      "INTERNAL_ERROR",
    ]),
  }),
]);
export type CredentialPublicResult = z.infer<
  typeof CredentialPublicResultSchema
>;

const credentialKeychainProbeBase = {
  schemaVersion: z.literal(1),
  probe: z.literal("KEYCHAIN_ROUND_TRIP"),
};

/** Secret-free output from the explicit, fixture-only macOS extended probe. */
export const CredentialKeychainProbeResultSchema = z.union([
  z.strictObject({
    ...credentialKeychainProbeBase,
    status: z.enum(["PASSED", "FAILED", "USAGE"]),
  }),
  z.strictObject({
    ...credentialKeychainProbeBase,
    status: z.literal("CLEANUP_FAILED"),
    probeId: z.string().regex(/^[a-f0-9]{32}$/),
  }),
]);
export type CredentialKeychainProbeResult = z.infer<
  typeof CredentialKeychainProbeResultSchema
>;

const UnsupportedCredentialChannelSchema = z.strictObject({
  activation: z.literal("INACTIVE"),
  inactiveReasons: z.array(nonEmpty).min(1),
  capability: CredentialChannelCapabilitySchema.extend({
    platform: z.literal("unsupported"),
    surface: z.literal("NONE"),
    storage: z.literal("NONE"),
    acceptedKinds: noCredentialKinds,
    consumerMode: z.literal("NONE"),
    consumerReadiness: z.literal("UNSUPPORTED"),
    opaqueReferenceOnly: z.literal(false),
  }),
});

const appleTeamId = z.string().regex(/^[A-Z0-9]{10}$/);

const InactiveMacosCredentialChannelSchema = z.strictObject({
  activation: z.literal("INACTIVE"),
  inactiveReasons: z.array(nonEmpty).min(1),
  capability: CredentialChannelCapabilitySchema.extend({
    platform: z.literal("macos"),
  }),
  helperIdentity: ProbeVerdictSchema,
  helperBundleId: nonEmpty.optional(),
  helperBuild: nonEmpty.optional(),
  helperCodeDirectoryHash: codeDirectoryHash.optional(),
  helperTeamId: appleTeamId.optional(),
  helperDesignatedRequirement: z.string().min(1).max(4096).optional(),
  launcherIdentity: ProbeVerdictSchema,
  launcherBundleId: nonEmpty.optional(),
  launcherBuild: nonEmpty.optional(),
  launcherCodeDirectoryHash: codeDirectoryHash.optional(),
  launcherTeamId: appleTeamId.optional(),
  launcherDesignatedRequirement: z.string().min(1).max(4096).optional(),
  secureInput: ProbeVerdictSchema,
  agentExecutionIsolation: ProbeVerdictSchema,
  pasteboardHygiene: ProbeVerdictSchema,
  templateRegistryHash: hash.optional(),
  consumerRegistryHash: hash.optional(),
  registryManifestHash: hash.optional(),
  registryManifestVerification: ProbeVerdictSchema,
  registryVersion: positiveInt.optional(),
  registryRollbackFloor: positiveInt.optional(),
  credentialEvidenceManifestHash: hash.optional(),
  secretLeakBench: ProbeVerdictSchema,
  realConsumerProbe: ProbeVerdictSchema,
  keychainRoundTrip: ProbeVerdictSchema,
  opaqueRefOnly: ProbeVerdictSchema,
  scopeBinding: ProbeVerdictSchema,
  expiryAndRevocation: ProbeVerdictSchema,
  genericExportDenied: ProbeVerdictSchema,
});

const ActiveMacosCredentialChannelSchema = z.strictObject({
  activation: z.literal("ACTIVE"),
  inactiveReasons: z.array(nonEmpty).length(0),
  capability: CredentialChannelCapabilitySchema.extend({
    platform: z.literal("macos"),
    surface: z.literal("MACOS_NATIVE_SECURE_PROMPT"),
    storage: z.literal("MACOS_KEYCHAIN"),
    acceptedKinds: apiKeyOnly,
    consumerMode: z.literal("REGISTERED_IN_ENCLAVE_ADAPTER_ONLY"),
    consumerReadiness: z.literal("AUDITED_REAL_CONSUMER"),
    opaqueReferenceOnly: z.literal(true),
  }),
  helperIdentity: z.literal("passed"),
  helperBundleId: nonEmpty,
  helperBuild: nonEmpty,
  helperCodeDirectoryHash: codeDirectoryHash,
  helperTeamId: appleTeamId,
  helperDesignatedRequirement: z.string().min(1).max(4096),
  launcherIdentity: z.literal("passed"),
  launcherBundleId: nonEmpty,
  launcherBuild: nonEmpty,
  launcherCodeDirectoryHash: codeDirectoryHash,
  launcherTeamId: appleTeamId,
  launcherDesignatedRequirement: z.string().min(1).max(4096),
  secureInput: z.literal("passed"),
  agentExecutionIsolation: z.literal("passed"),
  pasteboardHygiene: z.literal("passed"),
  templateRegistryHash: hash,
  consumerRegistryHash: hash,
  registryManifestHash: hash,
  registryManifestVerification: z.literal("passed"),
  registryVersion: positiveInt,
  registryRollbackFloor: positiveInt,
  credentialEvidenceManifestHash: hash,
  secretLeakBench: z.literal("passed"),
  realConsumerProbe: z.literal("passed"),
  keychainRoundTrip: z.literal("passed"),
  opaqueRefOnly: z.literal("passed"),
  scopeBinding: z.literal("passed"),
  expiryAndRevocation: z.literal("passed"),
  genericExportDenied: z.literal("passed"),
});

export const CredentialChannelProfileSchema = z.union([
  UnsupportedCredentialChannelSchema,
  InactiveMacosCredentialChannelSchema,
  ActiveMacosCredentialChannelSchema,
]);
export type CredentialChannelProfile = z.infer<
  typeof CredentialChannelProfileSchema
>;

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
  schemaVersion: z.literal(5),
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
    canonicalToolMatchers: z.array(exactToolName),
    matcherEvidenceHash: hash,
    toolSchemaRegistryHash: hash.optional(),
    toolSchemaRegistryEvidenceId: nonEmpty.optional(),
    browserTools: z.array(
      z.strictObject({
        canonicalToolName: exactToolName,
        inputSchemaHash: hash,
        registryManifestBinding: hash,
      }),
    ),
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
  credentialChannel: CredentialChannelProfileSchema,
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
    credentialProtection: z.enum(["ACTIVE", "INACTIVE"]),
    allowedClaims: z.array(nonEmpty),
    forbiddenClaims: z.array(nonEmpty),
  }),
});
export const HostProfileSchema = HostProfileBaseSchema.superRefine(
  (profile, context) => {
    const routePinParts = [
      Boolean(profile.route.toolSchemaRegistryHash),
      Boolean(profile.route.toolSchemaRegistryEvidenceId),
      profile.route.browserTools.length > 0,
    ];
    const routePinsComplete = routePinParts.every(Boolean);
    if (routePinParts.some(Boolean) && !routePinsComplete) {
      context.addIssue({
        code: "custom",
        path: ["route"],
        message: "External tool schema pins must be complete or absent",
      });
    }
    if (
      profile.route.toolSchemaRegistryHash &&
      profile.route.toolSchemaRegistryEvidenceId
    ) {
      for (const [index, tool] of profile.route.browserTools.entries()) {
        const expected = toolRegistryManifestBinding({
          profileId: profile.profileId,
          definitionHash: profile.hooks.definitionHash,
          matcherEvidenceHash: profile.route.matcherEvidenceHash,
          toolSchemaRegistryHash: profile.route.toolSchemaRegistryHash,
          toolSchemaRegistryEvidenceId:
            profile.route.toolSchemaRegistryEvidenceId,
          canonicalToolName: tool.canonicalToolName,
          inputSchemaHash: tool.inputSchemaHash,
        });
        if (tool.registryManifestBinding.toLowerCase() !== expected) {
          context.addIssue({
            code: "custom",
            path: ["route", "browserTools", index, "registryManifestBinding"],
            message: "Browser tool pin does not match its manifest binding",
          });
        }
      }
    }
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
        profile.handoff.activation !== "INACTIVE" ||
        profile.credentialChannel.activation !== "INACTIVE" ||
        profile.derived.credentialProtection !== "INACTIVE"
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
        profile.derived.mode === "UNSUPPORTED" ||
        !routePinsComplete ||
        profile.route.browserTools.length !==
          profile.route.canonicalToolMatchers.length ||
        profile.route.browserTools.some(
          (tool) =>
            !profile.route.canonicalToolMatchers.includes(
              tool.canonicalToolName,
            ),
        ))
    ) {
      context.addIssue({
        code: "custom",
        path: ["setup", "optimization"],
        message:
          "Active optimization requires a verified enforcement mode and complete external tool schema pins",
      });
    }
    if (
      new Set(profile.route.browserTools.map((tool) => tool.canonicalToolName))
        .size !== profile.route.browserTools.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["route", "browserTools"],
        message: "Pinned browser tools must be unique",
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

    const credential = profile.credentialChannel;
    if (
      profile.identity.os !== "macos" &&
      credential.capability.platform !== "unsupported"
    ) {
      context.addIssue({
        code: "custom",
        path: ["credentialChannel", "capability", "platform"],
        message: "Credential Channel is unsupported outside macOS",
      });
    }
    if (credential.activation !== profile.derived.credentialProtection) {
      context.addIssue({
        code: "custom",
        path: ["derived", "credentialProtection"],
        message: "Credential protection must match channel activation",
      });
    }
    if (credential.activation === "ACTIVE") {
      if (
        profile.identity.os !== "macos" ||
        profile.identity.browserPath !== "chrome-extension" ||
        profile.setup.lifecycle !== "VERIFIED" ||
        !profile.evidence.validUntilHostChange ||
        profile.handoff.activation !== "ACTIVE" ||
        profile.derived.handoff !== "ACTIVE" ||
        !profile.handoff.capability.sameTabBinding ||
        profile.handoff.capability.lease !== "EXCLUSIVE_USER_LEASE" ||
        profile.handoff.sameTabBinding !== "passed" ||
        profile.handoff.exclusiveBrowserLease !== "passed" ||
        profile.handoff.noAgentObservationDuringLease !== "passed" ||
        profile.handoff.nonSecretCompletionDetector !== "passed" ||
        profile.handoff.originAndStateVerification !== "passed" ||
        credential.helperBundleId === credential.launcherBundleId ||
        credential.helperDesignatedRequirement ===
          credential.launcherDesignatedRequirement ||
        credential.registryVersion < credential.registryRollbackFloor
      ) {
        context.addIssue({
          code: "custom",
          path: ["credentialChannel"],
          message:
            "Active Credential Channel requires current macOS G15 evidence and an audited real consumer",
        });
      }
    }
  },
).describe(
  "The runtime HostProfileSchema validates structure and cross-field invariants; its generated JSON Schema validates the exchange shape only. Neither authorizes credential activation. An independent macOS activation verifier is required.",
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

export const HandoffVerificationMarkerSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    authority: z.literal("FIXTURE_ONLY_NON_AUTHORIZING"),
    leaseEpoch: handoffSafePositiveInt,
    candidateDigest: lowercaseHash,
    activationAnchorDigest: lowercaseHash,
    currentTabReceiptDigest: lowercaseHash,
    verifierContextBindingHash: lowercaseHash,
    stateEpoch: handoffSafePositiveInt,
    firstProbeSequence: handoffSafePositiveInt,
    secondProbeSequence: handoffSafePositiveInt,
    basis: z.enum(["DETERMINISTIC", "HEURISTIC", "USER_ASSERTED"]),
    phaseSignal: handoffPhaseSignal,
  })
  .superRefine((marker, context) => {
    if (marker.firstProbeSequence >= marker.secondProbeSequence) {
      context.addIssue({
        code: "custom",
        path: ["secondProbeSequence"],
        message: "probe sequences must be strictly increasing",
      });
    }
  });
export type HandoffVerificationMarker = z.infer<
  typeof HandoffVerificationMarkerSchema
>;

export const BrowserTaskStateSchema = z
  .strictObject({
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
    actionSignatureKeyId: hash.optional(),
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
    handoffVerificationMarker: HandoffVerificationMarkerSchema.optional(),
    leaseEpoch: nonNegativeInt,
    pointerOwner: PointerOwnerSchema,
    targetCacheEpoch: nonNegativeInt,
    pendingNativeActionIds: z.array(nonEmpty),
    stateVersion: nonNegativeInt,
  })
  .superRefine((state, context) => {
    const activeHumanPhase = [
      "HANDOFF_VERIFYING",
      "USER_LEASE_ACTIVE",
    ].includes(state.phase);
    const noOwnerPhase = ["RESTORING_TAB", "RESUMING"].includes(state.phase);
    const markerAllowed = ["HANDOFF_VERIFYING", "USER_LEASE_ACTIVE"].includes(
      state.phase,
    );
    if (
      (state.phase === "RUNNING" &&
        (state.pointerOwner !== "NATIVE" || state.activeHandoffId)) ||
      (activeHumanPhase &&
        (state.pointerOwner !== "HUMAN" || !state.activeHandoffId)) ||
      (noOwnerPhase &&
        (state.pointerOwner !== "NONE" || !state.activeHandoffId)) ||
      (state.phase === "HANDOFF_PREPARING" && state.pointerOwner !== "NATIVE")
    ) {
      context.addIssue({
        code: "custom",
        path: ["pointerOwner"],
        message: "Browser task phase and ownership are inconsistent",
      });
    }
    if (
      state.pointerOwner !== "NATIVE" &&
      state.pendingNativeActionIds.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["pendingNativeActionIds"],
        message: "Non-Native ownership cannot retain pending native actions",
      });
    }
    if (
      state.handoffVerificationMarker &&
      (!markerAllowed ||
        state.handoffVerificationMarker.leaseEpoch !== state.leaseEpoch)
    ) {
      context.addIssue({
        code: "custom",
        path: ["handoffVerificationMarker"],
        message: "Handoff verification marker is outside its active lease",
      });
    }
  })
  .describe(
    "The runtime BrowserTaskStateSchema enforces phase, ownership, lease, marker, and sequence invariants; its generated JSON Schema validates the exchange shape only and is not transition or resume authority.",
  );
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
    credentialProtectionActive: z.boolean(),
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
      if (
        setup.safetyProtectionActive ||
        setup.handoffProtectionActive ||
        setup.credentialProtectionActive
      ) {
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
        setup.handoffProtectionActive ||
        setup.credentialProtectionActive
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
    run_index: positiveInt,
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
  "credential-enclave-ticket": CredentialEnclaveTicketSchema,
  "credential-keychain-probe-result": CredentialKeychainProbeResultSchema,
  "credential-provision-intent": CredentialProvisionIntentSchema,
  "credential-public-result": CredentialPublicResultSchema,
  "credential-use-registry-entry": CredentialUseRegistryEntrySchema,
  "handoff-tool-input": HandoffToolInputSchema,
  "observation-digest": ObservationDigestSchema,
  "state-fingerprint": StateFingerprintSchema,
  "control-critical-contract": ControlCriticalContractSchema,
  "setup-verification": SetupVerificationSchema,
  "evidence-manifest": EvidenceManifestSchema,
  "evidence-trace": EvidenceTraceSchema,
} as const;
