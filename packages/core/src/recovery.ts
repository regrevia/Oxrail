import type {
  ActionControl,
  ReasonCode,
  StateFingerprint,
} from "../../protocol/src/index.js";

import { sameTaskRelevantState, type ProgressAssessment } from "./progress.js";

export type RecoveryLevel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export type RecoveryStrategy =
  | "VERIFY_TASK_STATE"
  | "RERESOLVE_TARGET"
  | "INSPECT_BLOCKER"
  | "QUERY_ALTERNATE_CANDIDATE"
  | "EXPAND_SCOPED_STRUCTURE"
  | "REQUEST_RICHER_NATIVE_OBSERVATION"
  | "PROPOSE_SAFE_NATIVE_NAVIGATION"
  | "SECURE_MICRO_HANDOFF"
  | "TERMINAL_FAILURE";

export interface RecoveryDecision {
  status:
    | "CONTINUE"
    | "OBSERVE"
    | "STALL"
    | "LOOP_DETECTED"
    | "HANDOFF_REQUIRED"
    | "TERMINAL"
    | "BYPASSED";
  recoveryLevel: RecoveryLevel;
  strategy: RecoveryStrategy;
  reasonCode: ReasonCode;
  reason: string;
  observableGranularity: ActionControl;
  prerequisiteEvidence: string[];
  consumesRetry: boolean;
  interventionRequired: boolean;
}

export interface DecideRecoveryInput {
  progress: ProgressAssessment;
  equivalentNoProgressAttempts: number;
  attemptedLevels?: readonly RecoveryLevel[];
  safeNavigationPrerequisitesMet?: boolean;
  handoffAvailable?: boolean;
  humanBoundary?: boolean;
  fingerprintHistory?: readonly StateFingerprint[];
  prerequisiteEvidence?: readonly string[];
}

const strategies: Record<RecoveryLevel, RecoveryStrategy> = {
  0: "VERIFY_TASK_STATE",
  1: "RERESOLVE_TARGET",
  2: "INSPECT_BLOCKER",
  3: "QUERY_ALTERNATE_CANDIDATE",
  4: "EXPAND_SCOPED_STRUCTURE",
  5: "REQUEST_RICHER_NATIVE_OBSERVATION",
  6: "PROPOSE_SAFE_NATIVE_NAVIGATION",
  7: "SECURE_MICRO_HANDOFF",
  8: "TERMINAL_FAILURE",
};

function granularityLabel(granularity: ActionControl): string {
  if (granularity === "MICRO_ACTION") return "micro-action";
  if (granularity === "TRANSACTION") return "outer transaction";
  if (granularity === "SCRIPT_WRAPPER") return "outer script invocation";
  return "unobservable action";
}

function granularityPlural(granularity: ActionControl): string {
  return `${granularityLabel(granularity)}s`;
}

function nextRecoveryLevel(
  input: DecideRecoveryInput,
  minimum: RecoveryLevel = 1,
): RecoveryLevel {
  const attempted = new Set(input.attemptedLevels ?? []);
  const lastAttempted = Math.max(0, ...attempted);
  const floor = Math.max(minimum, Math.min(lastAttempted + 1, 8));
  for (const level of [1, 2, 3, 4, 5, 6, 7, 8] as const) {
    if (level < floor) continue;
    if (attempted.has(level)) continue;
    if (level === 6 && !input.safeNavigationPrerequisitesMet) continue;
    if (level === 7 && !input.handoffAvailable) continue;
    return level;
  }
  return 8;
}

function oscillates(history: readonly StateFingerprint[] = []): boolean {
  if (history.length < 4) return false;
  const [a, b, nextA, nextB] = history.slice(-4) as [
    StateFingerprint,
    StateFingerprint,
    StateFingerprint,
    StateFingerprint,
  ];
  return (
    !sameTaskRelevantState(a, b) &&
    sameTaskRelevantState(a, nextA) &&
    sameTaskRelevantState(b, nextB)
  );
}

function transitionEvidence(input: DecideRecoveryInput): string[] {
  const evidence = [...(input.prerequisiteEvidence ?? [])];
  if (evidence.length === 0 || evidence.some((item) => item.length === 0)) {
    throw new TypeError("recovery transition requires prerequisite evidence");
  }
  return evidence;
}

export function decideRecovery(input: DecideRecoveryInput): RecoveryDecision {
  const granularity = input.progress.observableGranularity;
  if (granularity === "NONE") {
    return {
      status: "BYPASSED",
      recoveryLevel: 0,
      strategy: "VERIFY_TASK_STATE",
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
      reason: "action granularity is unavailable; recovery is advisory only",
      observableGranularity: "NONE",
      prerequisiteEvidence: [...(input.prerequisiteEvidence ?? [])],
      consumesRetry: false,
      interventionRequired: false,
    };
  }
  if (input.humanBoundary) {
    return {
      status: input.handoffAvailable ? "HANDOFF_REQUIRED" : "TERMINAL",
      recoveryLevel: input.handoffAvailable ? 7 : 8,
      strategy: input.handoffAvailable
        ? "SECURE_MICRO_HANDOFF"
        : "TERMINAL_FAILURE",
      reasonCode: "OXRAIL_HUMAN_BOUNDARY",
      reason: input.handoffAvailable
        ? "human boundary requires secure micro-handoff"
        : "human boundary reached without an available handoff",
      observableGranularity: granularity,
      prerequisiteEvidence: transitionEvidence(input),
      consumesRetry: false,
      interventionRequired: true,
    };
  }
  if (oscillates(input.fingerprintHistory)) {
    const recoveryLevel = nextRecoveryLevel(input, 3);
    return {
      status:
        recoveryLevel === 7
          ? "HANDOFF_REQUIRED"
          : recoveryLevel === 8
            ? "TERMINAL"
            : "LOOP_DETECTED",
      recoveryLevel,
      strategy: strategies[recoveryLevel],
      reasonCode:
        recoveryLevel >= 7 ? "OXRAIL_RECOVERY_EXHAUSTED" : "OXRAIL_NO_PROGRESS",
      reason:
        recoveryLevel === 3
          ? "A/B/A/B task-state oscillation detected"
          : `task-state oscillation persists; escalate to R${recoveryLevel}`,
      observableGranularity: granularity,
      prerequisiteEvidence: transitionEvidence(input),
      consumesRetry: true,
      interventionRequired: true,
    };
  }
  if (input.progress.meaningfulProgress) {
    return {
      status: "CONTINUE",
      recoveryLevel: 0,
      strategy: "VERIFY_TASK_STATE",
      reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
      reason: "task-relevant state progressed",
      observableGranularity: granularity,
      prerequisiteEvidence: [...(input.prerequisiteEvidence ?? [])],
      consumesRetry: false,
      interventionRequired: false,
    };
  }
  if (input.equivalentNoProgressAttempts >= 2) {
    const recoveryLevel = nextRecoveryLevel(input);
    return {
      status:
        recoveryLevel === 7
          ? "HANDOFF_REQUIRED"
          : recoveryLevel === 8
            ? "TERMINAL"
            : "STALL",
      recoveryLevel,
      strategy: strategies[recoveryLevel],
      reasonCode:
        recoveryLevel >= 7
          ? "OXRAIL_RECOVERY_EXHAUSTED"
          : "OXRAIL_REDUNDANT_ACTION",
      reason:
        recoveryLevel === 1
          ? `two equivalent ${granularityPlural(granularity)} made no task-relevant progress; stop the next blind repeat`
          : `no task-relevant progress after prior recovery; escalate to R${recoveryLevel}`,
      observableGranularity: granularity,
      prerequisiteEvidence: transitionEvidence(input),
      consumesRetry: true,
      interventionRequired: true,
    };
  }
  return {
    status: "OBSERVE",
    recoveryLevel: 0,
    strategy: "VERIFY_TASK_STATE",
    reasonCode: "OXRAIL_NO_PROGRESS",
    reason: `first equivalent ${granularityLabel(granularity)} made no task-relevant progress; verify state`,
    observableGranularity: granularity,
    prerequisiteEvidence: [...(input.prerequisiteEvidence ?? [])],
    consumesRetry: true,
    interventionRequired: false,
  };
}
