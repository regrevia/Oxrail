import type {
  ActionControl,
  ReasonCode,
  StateFingerprint,
} from "../../protocol/src/index.js";

const taskSignals = [
  "originKey",
  "routeKey",
  "taskPhase",
  "relevantRegionHash",
  "actionableHash",
  "dialogHash",
  "goalSignalHash",
  "blockerHash",
] as const satisfies readonly (keyof StateFingerprint)[];

export type TaskProgressSignal = (typeof taskSignals)[number];

export interface ProgressAssessment {
  meaningfulProgress: boolean;
  reasonCode: ReasonCode;
  changedSignals: TaskProgressSignal[];
  ignoredDynamicRegions: string[];
  observableGranularity: ActionControl;
  source: "TASK_RELEVANT_STATE_FINGERPRINT";
  confidence: "DETERMINISTIC";
}

export interface AssessProgressInput {
  before: StateFingerprint;
  after: StateFingerprint;
  granularity: ActionControl;
  ignoredDynamicRegions?: readonly string[];
}

export function assessProgress(input: AssessProgressInput): ProgressAssessment {
  const changedSignals = taskSignals.filter(
    (signal) => input.before[signal] !== input.after[signal],
  );
  const meaningfulProgress = changedSignals.some((signal) => {
    if (signal === "originKey") return false;
    if (signal === "blockerHash") {
      return (
        input.before.blockerHash !== undefined &&
        input.after.blockerHash === undefined
      );
    }
    return input.after[signal] !== undefined;
  });
  return {
    meaningfulProgress,
    reasonCode: meaningfulProgress
      ? "OXRAIL_NORMAL_ACTION_PASSTHROUGH"
      : "OXRAIL_NO_PROGRESS",
    changedSignals,
    ignoredDynamicRegions: [...(input.ignoredDynamicRegions ?? [])],
    observableGranularity: input.granularity,
    source: "TASK_RELEVANT_STATE_FINGERPRINT",
    confidence: "DETERMINISTIC",
  };
}

export function sameTaskRelevantState(
  left: StateFingerprint,
  right: StateFingerprint,
): boolean {
  return taskSignals.every((signal) => left[signal] === right[signal]);
}
