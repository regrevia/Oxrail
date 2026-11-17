import { describe, expect, it } from "vitest";

import { assessProgress } from "../packages/core/src/progress.js";
import { decideRecovery } from "../packages/core/src/recovery.js";
import type { StateFingerprint } from "../packages/protocol/src/index.js";

const hash = (value: string) => value.repeat(64);

function fingerprint(
  overrides: Partial<StateFingerprint> = {},
): StateFingerprint {
  return {
    originKey: "https://example.test",
    routeKey: "/checkout",
    taskPhase: "shipping",
    relevantRegionHash: hash("a"),
    actionableHash: hash("b"),
    revision: 1,
    ...overrides,
  };
}

describe("task-relevant progress", () => {
  it("does not treat a revision-only dynamic rerender as progress", () => {
    expect(
      assessProgress({
        before: fingerprint(),
        after: fingerprint({ revision: 2 }),
        granularity: "MICRO_ACTION",
        ignoredDynamicRegions: ["spinner", "ad-carousel"],
      }),
    ).toEqual({
      meaningfulProgress: false,
      reasonCode: "OXRAIL_NO_PROGRESS",
      changedSignals: [],
      ignoredDynamicRegions: ["spinner", "ad-carousel"],
      observableGranularity: "MICRO_ACTION",
      source: "TASK_RELEVANT_STATE_FINGERPRINT",
      confidence: "DETERMINISTIC",
    });
  });

  it("reports a known task phase transition as progress", () => {
    expect(
      assessProgress({
        before: fingerprint(),
        after: fingerprint({ taskPhase: "confirmation", revision: 2 }),
        granularity: "TRANSACTION",
      }),
    ).toMatchObject({
      meaningfulProgress: true,
      reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
      changedSignals: ["taskPhase"],
      observableGranularity: "TRANSACTION",
    });
  });

  it("does not mistake a newly appearing blocker for forward progress", () => {
    expect(
      assessProgress({
        before: fingerprint(),
        after: fingerprint({ blockerHash: hash("c"), revision: 2 }),
        granularity: "MICRO_ACTION",
      }),
    ).toMatchObject({
      meaningfulProgress: false,
      reasonCode: "OXRAIL_NO_PROGRESS",
      changedSignals: ["blockerHash"],
    });

    expect(
      assessProgress({
        before: fingerprint({ blockerHash: hash("c") }),
        after: fingerprint({ revision: 2 }),
        granularity: "MICRO_ACTION",
      }),
    ).toMatchObject({
      meaningfulProgress: true,
      reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
      changedSignals: ["blockerHash"],
    });
  });
});

describe("granularity-aware recovery", () => {
  it("does not intervene when task-relevant progress occurred", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ taskPhase: "confirmation", revision: 2 }),
      granularity: "MICRO_ACTION",
    });

    expect(
      decideRecovery({ progress, equivalentNoProgressAttempts: 2 }),
    ).toMatchObject({
      status: "CONTINUE",
      recoveryLevel: 0,
      reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
      consumesRetry: false,
      interventionRequired: false,
    });
  });

  it("records the first equivalent no-progress micro-action at R0", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity: "MICRO_ACTION",
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 1,
        prerequisiteEvidence: ["trace:first-attempt"],
      }),
    ).toEqual({
      status: "OBSERVE",
      recoveryLevel: 0,
      strategy: "VERIFY_TASK_STATE",
      reasonCode: "OXRAIL_NO_PROGRESS",
      reason:
        "first equivalent micro-action made no task-relevant progress; verify state",
      observableGranularity: "MICRO_ACTION",
      prerequisiteEvidence: ["trace:first-attempt"],
      consumesRetry: true,
      interventionRequired: false,
    });
  });

  it("escalates after the second equivalent no-progress micro-action", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity: "MICRO_ACTION",
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 2,
        prerequisiteEvidence: ["trace:first", "trace:second"],
      }),
    ).toMatchObject({
      status: "STALL",
      recoveryLevel: 1,
      strategy: "RERESOLVE_TARGET",
      reasonCode: "OXRAIL_REDUNDANT_ACTION",
      reason:
        "two equivalent micro-actions made no task-relevant progress; stop the next blind repeat",
      observableGranularity: "MICRO_ACTION",
      consumesRetry: true,
      interventionRequired: true,
    });
  });

  it("refuses a recovery transition without evidence", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity: "MICRO_ACTION",
    });

    expect(() =>
      decideRecovery({ progress, equivalentNoProgressAttempts: 2 }),
    ).toThrow("recovery transition requires prerequisite evidence");
  });

  it("does not claim intervention when action granularity is unavailable", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity: "NONE",
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 3,
      }),
    ).toMatchObject({
      status: "BYPASSED",
      recoveryLevel: 0,
      strategy: "VERIFY_TASK_STATE",
      reasonCode: "OXRAIL_HOST_ROUTE_UNPROVEN",
      reason: "action granularity is unavailable; recovery is advisory only",
      observableGranularity: "NONE",
      consumesRetry: false,
      interventionRequired: false,
    });
  });

  it("advances to the next unused deterministic recovery level", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity: "TRANSACTION",
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 2,
        attemptedLevels: [1, 2],
        prerequisiteEvidence: ["trace:transaction-stall"],
      }),
    ).toMatchObject({
      status: "STALL",
      recoveryLevel: 3,
      strategy: "QUERY_ALTERNATE_CANDIDATE",
      reasonCode: "OXRAIL_REDUNDANT_ACTION",
      observableGranularity: "TRANSACTION",
      prerequisiteEvidence: ["trace:transaction-stall"],
      interventionRequired: true,
    });
  });

  it("never falls back to a lower recovery level", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity: "TRANSACTION",
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 2,
        attemptedLevels: [3],
        prerequisiteEvidence: ["trace:after-r3"],
      }),
    ).toMatchObject({
      recoveryLevel: 4,
      strategy: "EXPAND_SCOPED_STRUCTURE",
    });
  });

  it("detects an A/B/A/B task-state oscillation before treating it as progress", () => {
    const a = fingerprint({ routeKey: "/a" });
    const b = fingerprint({ routeKey: "/b", revision: 2 });
    const progress = assessProgress({
      before: a,
      after: b,
      granularity: "MICRO_ACTION",
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 0,
        fingerprintHistory: [a, b, a, b],
        prerequisiteEvidence: ["trace:oscillation"],
      }),
    ).toMatchObject({
      status: "LOOP_DETECTED",
      recoveryLevel: 3,
      strategy: "QUERY_ALTERNATE_CANDIDATE",
      reasonCode: "OXRAIL_NO_PROGRESS",
      reason: "A/B/A/B task-state oscillation detected",
      observableGranularity: "MICRO_ACTION",
      interventionRequired: true,
    });
  });

  it("routes a human boundary to R7 without consuming recovery retry", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity: "MICRO_ACTION",
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 0,
        humanBoundary: true,
        handoffAvailable: true,
        prerequisiteEvidence: ["classifier:human-boundary"],
      }),
    ).toMatchObject({
      status: "HANDOFF_REQUIRED",
      recoveryLevel: 7,
      strategy: "SECURE_MICRO_HANDOFF",
      reasonCode: "OXRAIL_HUMAN_BOUNDARY",
      reason: "human boundary requires secure micro-handoff",
      consumesRetry: false,
      interventionRequired: true,
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 0,
        humanBoundary: true,
        prerequisiteEvidence: ["classifier:human-boundary"],
      }),
    ).toMatchObject({
      status: "TERMINAL",
      recoveryLevel: 8,
      strategy: "TERMINAL_FAILURE",
      reasonCode: "OXRAIL_HUMAN_BOUNDARY",
      consumesRetry: false,
    });
  });

  it.each([
    ["TRANSACTION", "outer transactions"],
    ["SCRIPT_WRAPPER", "outer script invocations"],
  ] as const)("scopes %s stalls to its outer call", (granularity, label) => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity,
    });

    expect(
      decideRecovery({
        progress,
        equivalentNoProgressAttempts: 2,
        prerequisiteEvidence: ["trace:transaction-stall"],
      }).reason,
    ).toBe(
      `two equivalent ${label} made no task-relevant progress; stop the next blind repeat`,
    );
  });

  it("only proposes safe native navigation and terminates when it is unavailable", () => {
    const progress = assessProgress({
      before: fingerprint(),
      after: fingerprint({ revision: 2 }),
      granularity: "MICRO_ACTION",
    });
    const attemptedLevels = [1, 2, 3, 4, 5] as const;
    const proposal = decideRecovery({
      progress,
      equivalentNoProgressAttempts: 2,
      attemptedLevels,
      safeNavigationPrerequisitesMet: true,
      prerequisiteEvidence: ["trace:navigation-safe"],
    });
    const terminal = decideRecovery({
      progress,
      equivalentNoProgressAttempts: 2,
      attemptedLevels,
      prerequisiteEvidence: ["trace:navigation-unsafe"],
    });

    expect(proposal).toMatchObject({
      recoveryLevel: 6,
      strategy: "PROPOSE_SAFE_NATIVE_NAVIGATION",
    });
    expect(proposal).not.toHaveProperty("nativeActionProposal");
    expect(terminal).toMatchObject({
      status: "TERMINAL",
      recoveryLevel: 8,
      strategy: "TERMINAL_FAILURE",
      reasonCode: "OXRAIL_RECOVERY_EXHAUSTED",
    });
  });
});
