import { z } from "zod";

import {
  type ActionSignatureProtector,
  browserOwnershipDecision,
  evaluateAction,
} from "../../core/src/index.js";
import { persistentDocumentBinding } from "../../core/src/safe-state.js";
import {
  ActionControlSchema,
  ActionEnvelopeSchema,
  TargetDescriptorSchema,
  ToolRouteSchema,
  deterministicDigest,
  redactedDeterministicDigest,
  type ActionEnvelope,
  type BrowserTaskState,
  type HostProfile,
  type PolicyDecision,
  type ReasonCode,
} from "../../protocol/src/index.js";
import { classifyTool } from "./matcher.js";

const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const magicPropertySegments = new Set([
  "__proto__",
  "prototype",
  "constructor",
]);
const fieldPath = z
  .array(z.string().min(1).max(128))
  .min(1)
  .max(8)
  .refine(
    (segments) =>
      segments.every((segment) => !magicPropertySegments.has(segment)),
    "magic property segments are not allowed",
  );
const sensitiveIdentityTokens = new Set([
  "authorization",
  "card",
  "clipboard",
  "cookie",
  "credential",
  "cvc",
  "cvv",
  "input",
  "key",
  "keys",
  "otp",
  "passcode",
  "passwd",
  "password",
  "pin",
  "pwd",
  "secret",
  "text",
  "token",
  "value",
]);
const sensitiveIdentityCompounds = [
  "apikey",
  "cardnumber",
  "clientsecret",
  "privatekey",
  "recoverycode",
];
const sensitiveIdentitySegment = (segment: string): boolean => {
  const words = segment
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const compact = words.join("");
  return (
    words.some((word) => sensitiveIdentityTokens.has(word)) ||
    sensitiveIdentityCompounds.some((word) => compact.includes(word))
  );
};
const identityFieldPath = fieldPath.refine(
  (segments) => segments.every((segment) => !sensitiveIdentitySegment(segment)),
  "sensitive fields cannot participate in input identity",
);
const identityValue = z.union([
  z.string().max(256),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const exactToolName = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9_.:/-]+$/);
const actionIdentifier = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/);
const impact = z.enum(["read", "reversible", "high-impact"]);
const registryBinding = z.strictObject({
  expectedRegistryHash: hash,
  expectedInputSchemaHash: hash,
});
const REGISTRY_DIGEST_DOMAIN = "oxrail-host-tool-schema-registry-v1";
const enforceableModes = new Set<HostProfile["derived"]["mode"]>([
  "MICRO_ACTION_GUARD",
  "TRANSACTION_GUARD",
  "FULL_INTERPOSE",
]);

const policyTargetFingerprint = (value: string): string =>
  redactedDeterministicDigest("oxrail-host-target-fingerprint-v1", value);

const profileAllowsEnforcement = (profile: HostProfile): boolean =>
  profile.setup.lifecycle === "VERIFIED" &&
  profile.setup.optimization === "ACTIVE" &&
  profile.derived.safety === "ACTIVE" &&
  profile.hooks.trustState === "active" &&
  profile.hooks.concurrentConflictProbe === "passed" &&
  profile.evidence.validUntilHostChange &&
  enforceableModes.has(profile.derived.mode);

const ToolContractSchema = z.strictObject({
  toolName: exactToolName,
  inputSchemaHash: hash,
  route: ToolRouteSchema,
  granularity: ActionControlSchema,
  actionTypePath: fieldPath,
  originPath: fieldPath.optional(),
  revisionPath: fieldPath.optional(),
  targetPath: fieldPath.optional(),
  identityPaths: z.array(identityFieldPath).min(1).max(16),
  impactByAction: z.record(actionIdentifier, impact),
  defaultImpact: z.literal("high-impact"),
});

export const ToolSchemaRegistrySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    profileId: z.string().min(1).max(128),
    definitionHash: hash,
    matcherEvidenceHash: hash,
    tools: z.array(ToolContractSchema).min(1).max(32),
  })
  .superRefine((registry, context) => {
    if (
      new Set(registry.tools.map((tool) => tool.toolName)).size !==
      registry.tools.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["tools"],
        message: "tool contracts must be unique",
      });
    }
  });

export type ToolSchemaRegistry = z.infer<typeof ToolSchemaRegistrySchema>;

export const toolSchemaRegistryHash = (registry: ToolSchemaRegistry): string =>
  deterministicDigest(REGISTRY_DIGEST_DOMAIN, registry);

export interface RawBrowserToolCall {
  toolInput: unknown;
  toolName: string;
  toolUseId: string;
}

export interface GuardRegistryBinding {
  /** Both pins must come from an independently trusted manifest, never registryValue. */
  expectedRegistryHash: string;
  expectedInputSchemaHash: string;
}

export type BrowserActionDecode =
  | { kind: "ACTION"; action: ActionEnvelope; inputSchemaHash: string }
  | {
      kind: "BLOCK_HIGH_IMPACT";
      detail: string;
      reasonCode: Extract<ReasonCode, "OXRAIL_HUMAN_BOUNDARY">;
    }
  | { kind: "UNRELATED" }
  | {
      kind: "UNSUPPORTED";
      detail: string;
      reasonCode: Extract<ReasonCode, "OXRAIL_HOST_ROUTE_UNPROVEN">;
    };

const unsupported = (detail: string): BrowserActionDecode => ({
  kind: "UNSUPPORTED",
  detail,
  reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
});

const blockMalformedHighImpact = (detail: string): BrowserActionDecode => ({
  kind: "BLOCK_HIGH_IMPACT",
  detail,
  reasonCode: "OXRAIL_HUMAN_BOUNDARY",
});

function valueAt(value: unknown, segments: readonly string[]): unknown {
  try {
    let current = value;
    for (const segment of segments) {
      if (
        !current ||
        typeof current !== "object" ||
        !Object.prototype.hasOwnProperty.call(current, segment)
      ) {
        return undefined;
      }
      current = (current as Record<string, unknown>)[segment];
    }
    return current;
  } catch {
    return undefined;
  }
}

function canonicalOrigin(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") return undefined;
  try {
    const parsed = new URL(value);
    return parsed.origin === value ? value : undefined;
  } catch {
    return undefined;
  }
}

export function decodeBrowserAction(
  profile: HostProfile,
  registryValue: unknown,
  call: RawBrowserToolCall,
  bindingValue: GuardRegistryBinding,
): BrowserActionDecode {
  if (classifyTool(profile, call.toolName) === "UNRELATED") {
    return { kind: "UNRELATED" };
  }
  if (!profileAllowsEnforcement(profile)) {
    return unsupported("the active Host Profile does not permit enforcement");
  }

  const parsedRegistry = ToolSchemaRegistrySchema.safeParse(registryValue);
  if (!parsedRegistry.success) return unsupported("tool registry is invalid");
  const registry = parsedRegistry.data;
  const parsedBinding = registryBinding.safeParse(bindingValue);
  if (!parsedBinding.success) {
    return unsupported("tool registry or input schema is not pinned");
  }
  const binding = parsedBinding.data;
  if (
    toolSchemaRegistryHash(registry) !==
    binding.expectedRegistryHash.toLowerCase()
  ) {
    return unsupported("tool registry content does not match its pinned hash");
  }
  if (
    registry.profileId !== profile.profileId ||
    registry.definitionHash !== profile.hooks.definitionHash ||
    registry.matcherEvidenceHash !== profile.route.matcherEvidenceHash
  ) {
    return unsupported("tool registry does not match the active Host Profile");
  }
  const contract = registry.tools.find(
    (tool) => tool.toolName === call.toolName,
  );
  if (!contract) return unsupported("browser tool has no schema contract");
  if (
    contract.inputSchemaHash.toLowerCase() !==
    binding.expectedInputSchemaHash.toLowerCase()
  ) {
    return unsupported(
      "browser tool input schema does not match its pinned hash",
    );
  }
  if (
    contract.route !== profile.route.toolRoute ||
    contract.granularity !== profile.action.control
  ) {
    return unsupported("tool contract route or granularity drifted");
  }

  const parsedActionType = actionIdentifier.safeParse(
    valueAt(call.toolInput, contract.actionTypePath),
  );
  if (!parsedActionType.success) {
    return blockMalformedHighImpact(
      "tool input does not match the action type contract",
    );
  }
  const actionType = parsedActionType.data;
  if (
    !Object.prototype.hasOwnProperty.call(contract.impactByAction, actionType)
  ) {
    return blockMalformedHighImpact(
      "tool input contains an action type absent from the trusted contract",
    );
  }
  const actionImpact = contract.impactByAction[actionType]!;
  const malformedAction = (detail: string): BrowserActionDecode =>
    actionImpact === "high-impact"
      ? blockMalformedHighImpact(detail)
      : unsupported(detail);
  const revision = contract.revisionPath
    ? valueAt(call.toolInput, contract.revisionPath)
    : undefined;
  if (contract.revisionPath && revision === undefined) {
    return malformedAction("tool input is missing the declared revision field");
  }
  if (
    revision !== undefined &&
    (!Number.isSafeInteger(revision) || (revision as number) < 0)
  ) {
    return malformedAction("tool input does not match the revision contract");
  }
  const originValue = contract.originPath
    ? valueAt(call.toolInput, contract.originPath)
    : undefined;
  if (contract.originPath && originValue === undefined) {
    return malformedAction("tool input is missing the declared origin field");
  }
  const origin = canonicalOrigin(originValue);
  if (originValue !== undefined && origin === undefined) {
    return malformedAction("tool input does not contain a canonical origin");
  }
  const targetValue = contract.targetPath
    ? valueAt(call.toolInput, contract.targetPath)
    : undefined;
  if (contract.targetPath && targetValue === undefined) {
    return malformedAction("tool input is missing the declared target field");
  }
  const parsedTarget =
    targetValue === undefined
      ? undefined
      : TargetDescriptorSchema.safeParse(targetValue);
  if (parsedTarget && !parsedTarget.success) {
    return malformedAction("tool input does not match the target contract");
  }
  const target = parsedTarget?.success
    ? {
        source: parsedTarget.data.source,
        sourceRevision: parsedTarget.data.sourceRevision,
        ...(parsedTarget.data.documentBinding
          ? {
              documentBinding: persistentDocumentBinding(
                parsedTarget.data.documentBinding,
              ),
            }
          : {}),
        ...(parsedTarget.data.fingerprint
          ? {
              fingerprint: policyTargetFingerprint(
                parsedTarget.data.fingerprint,
              ),
            }
          : {}),
        confidence: parsedTarget.data.confidence,
        risk: [],
      }
    : undefined;
  const identity: Array<
    readonly [readonly string[], z.infer<typeof identityValue>]
  > = [];
  for (const segments of contract.identityPaths) {
    const value = identityValue.safeParse(valueAt(call.toolInput, segments));
    if (!value.success) {
      return malformedAction(
        "tool input has an invalid declared identity field",
      );
    }
    identity.push([segments, value.data]);
  }

  let inputDigest: string;
  try {
    inputDigest = redactedDeterministicDigest(
      "oxrail-host-tool-input-identity-v1",
      identity,
    );
  } catch {
    return malformedAction("tool input identity is not safe JSON");
  }
  const candidate = ActionEnvelopeSchema.safeParse({
    toolUseId: call.toolUseId,
    route: contract.route,
    granularity: contract.granularity,
    actionType,
    ...(target ? { target } : {}),
    inputDigest,
    ...(origin ? { origin } : {}),
    ...(revision !== undefined ? { revision } : {}),
    impact: actionImpact,
  });
  return candidate.success
    ? {
        kind: "ACTION",
        action: candidate.data,
        inputSchemaHash: contract.inputSchemaHash,
      }
    : malformedAction("tool input could not be normalized safely");
}

export type PreToolUseOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "PreToolUse";
        permissionDecision: "deny";
        permissionDecisionReason: string;
      };
    };

export function buildPreToolUseOutput(
  decision: PolicyDecision,
): PreToolUseOutput {
  if (
    decision.disposition === "PASS_THROUGH_ORIGINAL" ||
    decision.disposition === "SEMANTIC_HINT_ONLY"
  ) {
    return {};
  }
  const explanation =
    decision.disposition === "REQUEST_HOST_APPROVAL"
      ? "This action requires host-native approval; Oxrail cannot create approval proactively."
      : decision.disposition === "REQUEST_HUMAN_HANDOFF"
        ? "This action requires an available, verified human Handoff."
        : "Oxrail blocked this browser action before execution.";
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: `${decision.reasonCode}: ${explanation}`,
    },
  };
}

export type GuardPreToolUseResult =
  | {
      mode: "ACTIVE";
      action: ActionEnvelope;
      decision: PolicyDecision;
      output: PreToolUseOutput;
    }
  | {
      mode: "ACTIVE";
      action?: never;
      decision: PolicyDecision;
      output: PreToolUseOutput;
    }
  | {
      mode: "BYPASSED";
      output: Record<string, never>;
      reasonCode: Extract<ReasonCode, "OXRAIL_HOST_ROUTE_UNPROVEN">;
    };

function activeSafetyDeny(
  reasonCode: Extract<
    ReasonCode,
    "OXRAIL_HUMAN_BOUNDARY" | "OXRAIL_USER_LEASE_ACTIVE"
  >,
): GuardPreToolUseResult {
  const decision: PolicyDecision = {
    disposition: "BLOCK_BEFORE_EXECUTION",
    reasonCode,
    recoverable: reasonCode === "OXRAIL_USER_LEASE_ACTIVE",
  };
  return {
    mode: "ACTIVE",
    decision,
    output: buildPreToolUseOutput(decision),
  };
}

export function runGuardPreToolUse(input: {
  call: RawBrowserToolCall;
  currentTargetFingerprint?: string;
  expectedInputSchemaHash: string;
  expectedRegistryHash: string;
  handoffAvailable?: boolean;
  hostApprovalAvailable?: boolean;
  profile: HostProfile;
  registry: unknown;
  requiresHumanBoundary?: boolean;
  sessionId: string;
  signatureProtector?: ActionSignatureProtector;
  state: BrowserTaskState;
  taskId: string;
}): GuardPreToolUseResult {
  const browserTool =
    classifyTool(input.profile, input.call.toolName) === "BROWSER";
  const stateScopeValid =
    input.state.sessionId === input.sessionId &&
    input.state.taskId === input.taskId;
  const enforcementContextValid =
    browserTool &&
    profileAllowsEnforcement(input.profile) &&
    input.state.hostProfileId === input.profile.profileId &&
    input.state.hostProfileStatus === "VALID" &&
    input.state.mode === input.profile.derived.mode &&
    stateScopeValid;
  if (!enforcementContextValid) {
    return {
      mode: "BYPASSED",
      output: {},
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
    };
  }
  const ownershipDecision = browserOwnershipDecision(input.state);
  if (ownershipDecision) {
    return {
      mode: "ACTIVE",
      decision: ownershipDecision,
      output: buildPreToolUseOutput(ownershipDecision),
    };
  }
  const decoded = decodeBrowserAction(
    input.profile,
    input.registry,
    input.call,
    {
      expectedInputSchemaHash: input.expectedInputSchemaHash,
      expectedRegistryHash: input.expectedRegistryHash,
    },
  );
  if (decoded.kind === "BLOCK_HIGH_IMPACT") {
    return activeSafetyDeny(decoded.reasonCode);
  }
  if (decoded.kind !== "ACTION") {
    return {
      mode: "BYPASSED",
      output: {},
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
    };
  }
  const decision = evaluateAction({
    action: decoded.action,
    state: input.state,
    ...(input.signatureProtector
      ? { signatureProtector: input.signatureProtector }
      : {}),
    routeCovered: true,
    ...(input.currentTargetFingerprint !== undefined
      ? {
          currentTargetFingerprint: policyTargetFingerprint(
            input.currentTargetFingerprint,
          ),
        }
      : {}),
    ...(input.handoffAvailable !== undefined
      ? { handoffAvailable: input.handoffAvailable }
      : {}),
    ...(input.hostApprovalAvailable !== undefined
      ? { hostApprovalAvailable: input.hostApprovalAvailable }
      : {}),
    ...(input.requiresHumanBoundary !== undefined
      ? { requiresHumanBoundary: input.requiresHumanBoundary }
      : {}),
  });
  return {
    mode: "ACTIVE",
    action: decoded.action,
    decision,
    output: buildPreToolUseOutput(decision),
  };
}
