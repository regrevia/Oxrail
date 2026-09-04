import {
  type ActionDigest,
  type ActionEnvelope,
  type BrowserTaskState,
  type HostProfile,
  type PolicyDecision,
  redactedDeterministicDigest,
} from "../../protocol/src/index.js";

export interface PolicyContext {
  action: ActionEnvelope;
  state: BrowserTaskState;
  routeCovered?: boolean;
  currentTargetFingerprint?: string;
  hostApprovalAvailable?: boolean;
  handoffAvailable?: boolean;
  requiresHumanBoundary?: boolean;
}

const pass = (reasonCode: PolicyDecision["reasonCode"]): PolicyDecision => ({
  disposition: "PASS_THROUGH_ORIGINAL",
  reasonCode,
  recoverable: true,
});

export function actionIdentity(action: ActionEnvelope): string {
  return redactedDeterministicDigest("oxrail-action-identity-v1", {
    route: action.route,
    granularity: action.granularity,
    actionType: action.actionType,
    targetSignature: action.target
      ? redactedDeterministicDigest("oxrail-target-signature-v1", action.target)
      : undefined,
    inputSignature: action.inputDigest,
  });
}

export function actionDigestIdentity(action: ActionDigest): string {
  return redactedDeterministicDigest("oxrail-action-identity-v1", {
    route: action.route,
    granularity: action.granularity,
    actionType: action.actionType,
    targetSignature: action.targetSignature,
    inputSignature: action.inputSignature,
  });
}

export function createActionDigest(
  action: ActionEnvelope,
  decision: PolicyDecision,
  timestamp = Date.now(),
): ActionDigest {
  const decisionKind: ActionDigest["decision"] =
    decision.disposition === "PASS_THROUGH_ORIGINAL"
      ? "ALLOW"
      : decision.disposition === "SEMANTIC_HINT_ONLY"
        ? "REWRITE"
        : decision.disposition === "REQUEST_HUMAN_HANDOFF"
          ? "HANDOFF"
          : "DENY";
  return {
    toolUseId: action.toolUseId,
    route: action.route,
    granularity: action.granularity,
    actionType: action.actionType,
    ...(action.target
      ? {
          targetSignature: redactedDeterministicDigest(
            "oxrail-target-signature-v1",
            action.target,
          ),
          sourceRevision: action.target.sourceRevision,
        }
      : {}),
    ...(action.inputDigest ? { inputSignature: action.inputDigest } : {}),
    decision: decisionKind,
    reasonCode: decision.reasonCode,
    timestamp,
  };
}

function targetIsStale(context: PolicyContext): boolean {
  const { action, state, currentTargetFingerprint } = context;
  if (action.revision !== undefined && action.revision !== state.revision)
    return true;
  if (!action.target) return false;
  if (action.target.sourceRevision !== state.revision) return true;
  if (
    action.target.documentBinding !== undefined &&
    state.documentBinding !== undefined &&
    action.target.documentBinding !== state.documentBinding
  ) {
    return true;
  }
  return (
    currentTargetFingerprint !== undefined &&
    action.target.fingerprint !== undefined &&
    currentTargetFingerprint !== action.target.fingerprint
  );
}

function repeatsWithoutProgress(
  action: ActionEnvelope,
  state: BrowserTaskState,
): boolean {
  if (
    !state.lastAction ||
    state.noProgressCount < 2 ||
    action.granularity === "NONE"
  )
    return false;
  return actionIdentity(action) === actionDigestIdentity(state.lastAction);
}

export function evaluateAction(context: PolicyContext): PolicyDecision {
  const { action, state } = context;

  if (
    state.phase === "USER_LEASE_ACTIVE" ||
    state.phase === "HANDOFF_VERIFYING" ||
    state.pointerOwner === "HUMAN"
  ) {
    return {
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_USER_LEASE_ACTIVE",
      recoverable: true,
    };
  }
  if (state.phase === "RESUMING" || state.pointerOwner === "NONE") {
    return {
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_POST_HANDOFF_TARGET_INVALIDATED",
      recoverable: true,
    };
  }

  const freshAndCovered =
    context.routeCovered !== false && state.hostProfileStatus === "VALID";
  if (
    !freshAndCovered ||
    state.mode === "ADVISORY_ONLY" ||
    state.mode === "UNSUPPORTED"
  ) {
    return pass(
      !freshAndCovered
        ? state.hostProfileStatus === "VALID"
          ? "OXRAIL_HOST_ROUTE_UNPROVEN"
          : "OXRAIL_HOST_PROFILE_STALE"
        : "OXRAIL_HOST_ROUTE_UNPROVEN",
    );
  }

  if (
    state.currentOrigin !== undefined &&
    action.origin !== undefined &&
    action.origin !== state.currentOrigin
  ) {
    return {
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_UNSAFE_ORIGIN",
      recoverable: true,
    };
  }

  if (context.requiresHumanBoundary) {
    return context.handoffAvailable
      ? {
          disposition: "REQUEST_HUMAN_HANDOFF",
          reasonCode: "OXRAIL_HUMAN_BOUNDARY",
          recoverable: true,
        }
      : {
          disposition: "BLOCK_BEFORE_EXECUTION",
          reasonCode: "OXRAIL_HUMAN_BOUNDARY",
          recoverable: false,
        };
  }

  if (targetIsStale(context) && action.impact !== "read") {
    return {
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_STALE_TARGET",
      recoverable: true,
    };
  }

  if (action.impact === "high-impact") {
    if (context.hostApprovalAvailable) {
      return {
        disposition: "REQUEST_HOST_APPROVAL",
        reasonCode: "OXRAIL_HUMAN_BOUNDARY",
        recoverable: true,
      };
    }
    if (context.handoffAvailable) {
      return {
        disposition: "REQUEST_HUMAN_HANDOFF",
        reasonCode: "OXRAIL_HUMAN_BOUNDARY",
        recoverable: true,
      };
    }
    return {
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_HUMAN_BOUNDARY",
      recoverable: false,
    };
  }

  if (repeatsWithoutProgress(action, state)) {
    return {
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_REDUNDANT_ACTION",
      recoverable: true,
    };
  }

  return pass("OXRAIL_NORMAL_ACTION_PASSTHROUGH");
}

export function deriveHostMode(
  profile: HostProfile,
): HostProfile["derived"]["mode"] {
  const coverageComplete = (
    coverage: HostProfile["action"]["preToolCoverage"],
  ) =>
    coverage.confidence === "PROVEN" &&
    coverage.expected > 0 &&
    coverage.observed === coverage.expected &&
    coverage.bypassCases.length === 0;
  if (
    profile.setup.lifecycle === "INSTALLED" ||
    profile.hooks.trustState !== "active" ||
    profile.hooks.policy === "disabled" ||
    profile.hooks.policy === "managed-only" ||
    !profile.evidence.validUntilHostChange
  ) {
    return "UNSUPPORTED";
  }
  if (
    profile.setup.lifecycle !== "VERIFIED" ||
    profile.setup.optimization !== "ACTIVE"
  ) {
    return "ADVISORY_ONLY";
  }
  const pinnedToolNames = new Set(
    profile.route.browserTools.map((tool) => tool.canonicalToolName),
  );
  if (
    !profile.route.toolSchemaRegistryHash ||
    !profile.route.toolSchemaRegistryEvidenceId ||
    pinnedToolNames.size !== profile.route.canonicalToolMatchers.length ||
    profile.route.canonicalToolMatchers.some(
      (toolName) => !pinnedToolNames.has(toolName),
    )
  ) {
    return "ADVISORY_ONLY";
  }
  if (profile.nativeInteraction.fidelity !== "PROVEN_PASS_THROUGH") {
    return "ADVISORY_ONLY";
  }
  const nativeSafe =
    profile.nativeInteraction.passThroughFingerprint === "passed" &&
    profile.nativeInteraction.cursorVisualization === "passed" &&
    profile.nativeInteraction.viewportCoordinateMapping === "passed" &&
    profile.nativeInteraction.screenshotFrameFeedback === "passed" &&
    Object.values(profile.nativeInteraction.primitiveParity).every(
      (verdict) => verdict === "passed",
    ) &&
    profile.nativeInteraction.unexpectedPointerInterference === 0 &&
    profile.nativeInteraction.unexpectedFocusInterference === 0 &&
    profile.nativeInteraction.unexpectedScrollInterference === 0 &&
    profile.nativeInteraction.incorrectNormalActionBlocks === 0;
  const actionProven =
    nativeSafe &&
    coverageComplete(profile.action.preToolCoverage) &&
    profile.action.denyPreventedSideEffect === true;
  if (!actionProven || profile.action.control === "NONE")
    return "ADVISORY_ONLY";
  const fullResultPath =
    profile.result.control === "NATIVE_TYPED_REWRITE" &&
    coverageComplete(profile.result.postToolCoverage) &&
    profile.result.replacementTiming === "before-model-proven" &&
    profile.result.controlCriticalContract.status === "passed" &&
    Object.values(profile.result.media).every(
      (verdict) => verdict === "passed",
    ) &&
    profile.result.rawPersistence.length === 1 &&
    profile.result.rawPersistence[0] === "none-observed";
  if (profile.action.control === "MICRO_ACTION" && fullResultPath)
    return "FULL_INTERPOSE";
  if (profile.action.control === "MICRO_ACTION") return "MICRO_ACTION_GUARD";
  return "TRANSACTION_GUARD";
}
