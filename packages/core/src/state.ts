import {
  BrowserTaskStateSchema,
  type ActionEnvelope,
  type BrowserTaskState,
  type HostMode,
  type PolicyDecision,
  type StateFingerprint,
  redactedDeterministicDigest,
} from "../../protocol/src/index.js";

import {
  actionDigestIdentity,
  actionIdentity,
  createActionDigest,
} from "./policy.js";
import {
  canonicalPersistentHandoffId,
  canonicalPersistentToolUseId,
  persistentHandoffId,
  persistentToolUseId,
} from "./safe-state.js";

export class StateVersionConflictError extends Error {
  constructor(expected: number, actual: number) {
    super(
      `BrowserTaskState version conflict: expected ${expected}, received ${actual}`,
    );
    this.name = "StateVersionConflictError";
  }
}

export interface NewBrowserTaskState {
  sessionId: string;
  taskId: string;
  hostProfileId: string;
  mode: HostMode;
}

export function createBrowserTaskState(
  input: NewBrowserTaskState,
): BrowserTaskState {
  return BrowserTaskStateSchema.parse({
    schemaVersion: 3,
    sessionId: input.sessionId,
    taskId: input.taskId,
    goalSummary: "browser task",
    hostProfileId: input.hostProfileId,
    hostProfileStatus: "VALID",
    mode: input.mode,
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
  });
}

export function stateFingerprintDigest(fingerprint: StateFingerprint): string {
  return redactedDeterministicDigest(
    "oxrail-state-fingerprint-v1",
    fingerprint,
  );
}

export function stageToolDecision(
  state: BrowserTaskState,
  action: ActionEnvelope,
  decision: PolicyDecision,
): BrowserTaskState {
  const toolUseId = persistentToolUseId(action.toolUseId);
  const executed =
    decision.disposition === "PASS_THROUGH_ORIGINAL" ||
    decision.disposition === "SEMANTIC_HINT_ONLY";
  const pendingNativeActionIds = [
    ...new Set(state.pendingNativeActionIds.map(canonicalPersistentToolUseId)),
  ];
  if (executed && !pendingNativeActionIds.includes(toolUseId)) {
    pendingNativeActionIds.push(toolUseId);
  }
  return BrowserTaskStateSchema.parse({
    ...state,
    lastAction: {
      ...createActionDigest(action, decision),
      toolUseId,
    },
    pendingNativeActionIds,
    stateVersion: state.stateVersion + 1,
  });
}

export function completePendingTool(
  state: BrowserTaskState,
  toolUseId: string,
): BrowserTaskState {
  const persistentId = persistentToolUseId(toolUseId);
  if (
    !state.pendingNativeActionIds.some(
      (pendingId) => canonicalPersistentToolUseId(pendingId) === persistentId,
    )
  ) {
    return state;
  }
  return BrowserTaskStateSchema.parse({
    ...state,
    pendingNativeActionIds: state.pendingNativeActionIds
      .map(canonicalPersistentToolUseId)
      .filter((pendingId) => pendingId !== persistentId),
    stateVersion: state.stateVersion + 1,
  });
}

export interface ActionOutcome {
  meaningfulProgress: boolean;
  expectedStateVersion?: number;
  timestamp?: number;
}

export function recordActionOutcome(
  state: BrowserTaskState,
  action: ActionEnvelope,
  decision: PolicyDecision,
  outcome: ActionOutcome,
): BrowserTaskState {
  if (
    outcome.expectedStateVersion !== undefined &&
    outcome.expectedStateVersion !== state.stateVersion
  ) {
    throw new StateVersionConflictError(
      outcome.expectedStateVersion,
      state.stateVersion,
    );
  }
  const executed =
    decision.disposition === "PASS_THROUGH_ORIGINAL" ||
    decision.disposition === "SEMANTIC_HINT_ONLY";
  const sameAsLast =
    state.lastAction !== undefined &&
    actionIdentity(action) === actionDigestIdentity(state.lastAction);
  if (!executed) {
    return BrowserTaskStateSchema.parse({
      ...state,
      stateVersion: state.stateVersion + 1,
    });
  }
  return BrowserTaskStateSchema.parse({
    ...state,
    lastAction: {
      ...createActionDigest(action, decision, outcome.timestamp),
      toolUseId: persistentToolUseId(action.toolUseId),
    },
    noProgressCount: outcome.meaningfulProgress
      ? 0
      : sameAsLast
        ? state.noProgressCount + 1
        : 1,
    stateVersion: state.stateVersion + 1,
  });
}

function assertVersion(
  state: BrowserTaskState,
  expectedStateVersion: number,
): void {
  if (state.stateVersion !== expectedStateVersion) {
    throw new StateVersionConflictError(
      expectedStateVersion,
      state.stateVersion,
    );
  }
}

export function activateUserLease(
  state: BrowserTaskState,
  handoffId: string,
  expectedStateVersion = state.stateVersion,
): BrowserTaskState {
  assertVersion(state, expectedStateVersion);
  if (state.pendingNativeActionIds.length > 0) {
    throw new Error("User lease cannot start while native actions are pending");
  }
  if (state.pointerOwner !== "NATIVE" || state.phase !== "RUNNING") {
    throw new Error(
      "User lease can only start while Native owns a running task",
    );
  }
  return BrowserTaskStateSchema.parse({
    ...state,
    phase: "USER_LEASE_ACTIVE",
    activeHandoffId: persistentHandoffId(handoffId),
    leaseEpoch: state.leaseEpoch + 1,
    pointerOwner: "HUMAN",
    stateVersion: state.stateVersion + 1,
  });
}

export function beginResume(
  state: BrowserTaskState,
  handoffId: string,
  leaseEpoch: number,
): BrowserTaskState {
  if (
    state.phase !== "USER_LEASE_ACTIVE" ||
    !state.activeHandoffId ||
    canonicalPersistentHandoffId(state.activeHandoffId) !==
      persistentHandoffId(handoffId) ||
    state.leaseEpoch !== leaseEpoch
  ) {
    throw new Error("Only the active handoff and lease epoch may begin resume");
  }
  const {
    lastAction: _lastAction,
    lastObservation: _lastObservation,
    ...safeState
  } = state;
  return BrowserTaskStateSchema.parse({
    ...safeState,
    phase: "RESUMING",
    pointerOwner: "NONE",
    revision: state.revision + 1,
    targetCacheEpoch: state.targetCacheEpoch + 1,
    pendingNativeActionIds: [],
    stateVersion: state.stateVersion + 1,
  });
}

export function finishResume(
  state: BrowserTaskState,
  handoffId: string,
  leaseEpoch: number,
): BrowserTaskState {
  if (
    state.phase !== "RESUMING" ||
    !state.activeHandoffId ||
    canonicalPersistentHandoffId(state.activeHandoffId) !==
      persistentHandoffId(handoffId) ||
    state.leaseEpoch !== leaseEpoch
  ) {
    throw new Error(
      "Only the verified active handoff and lease epoch may finish resume",
    );
  }
  const { activeHandoffId: _activeHandoffId, ...safeState } = state;
  return BrowserTaskStateSchema.parse({
    ...safeState,
    phase: "RUNNING",
    pointerOwner: "NATIVE",
    stateVersion: state.stateVersion + 1,
  });
}
