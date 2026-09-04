import { describe, expect, it } from "vitest";

import {
  activateUserLease,
  beginResume,
  createActionDigest,
  createBrowserTaskState,
  evaluateAction,
  finishResume,
  recordActionOutcome,
  stateFingerprintDigest,
  StateVersionConflictError,
} from "../packages/core/src/index.js";
import type { ActionEnvelope } from "../packages/protocol/src/index.js";

function action(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    toolUseId: "call-1",
    route: "direct-mcp",
    granularity: "MICRO_ACTION",
    actionType: "click",
    target: {
      source: "NATIVE_VISUAL",
      sourceRevision: 0,
      documentBinding: "doc-1",
      fingerprint: "button-1",
      confidence: 1,
      risk: [],
    },
    revision: 0,
    impact: "reversible",
    ...overrides,
  };
}

function state() {
  return {
    ...createBrowserTaskState({
      sessionId: "session",
      taskId: "task",
      hostProfileId: "profile",
      mode: "MICRO_ACTION_GUARD",
    }),
    documentBinding: "doc-1",
  };
}

describe("v0.1 core policy", () => {
  it("passes ordinary actions through unchanged and blocks the third proven no-progress attempt", () => {
    const firstAction = action();
    const firstDecision = evaluateAction({
      action: firstAction,
      state: state(),
    });
    expect(firstDecision.disposition).toBe("PASS_THROUGH_ORIGINAL");

    const afterFirst = recordActionOutcome(
      state(),
      firstAction,
      firstDecision,
      {
        meaningfulProgress: false,
        timestamp: 1,
      },
    );
    const secondAction = action({ toolUseId: "call-2" });
    const secondDecision = evaluateAction({
      action: secondAction,
      state: afterFirst,
    });
    expect(secondDecision.disposition).toBe("PASS_THROUGH_ORIGINAL");

    const afterSecond = recordActionOutcome(
      afterFirst,
      secondAction,
      secondDecision,
      {
        meaningfulProgress: false,
        timestamp: 2,
      },
    );
    const thirdDecision = evaluateAction({
      action: action({ toolUseId: "call-3" }),
      state: afterSecond,
    });
    expect(thirdDecision).toMatchObject({
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_REDUNDANT_ACTION",
    });
  });

  it("blocks risky stale targets but fails open for a harmless read", () => {
    const stale = action({
      revision: 0,
      target: { ...action().target!, sourceRevision: 0 },
    });
    const revised = { ...state(), revision: 1 };
    expect(evaluateAction({ action: stale, state: revised }).reasonCode).toBe(
      "OXRAIL_STALE_TARGET",
    );
    expect(
      evaluateAction({ action: { ...stale, impact: "read" }, state: revised })
        .disposition,
    ).toBe("PASS_THROUGH_ORIGINAL");
  });

  it("routes high-impact work only to native approval or handoff", () => {
    const risky = action({ impact: "high-impact" });
    expect(
      evaluateAction({
        action: risky,
        state: state(),
        hostApprovalAvailable: true,
      }).disposition,
    ).toBe("REQUEST_HOST_APPROVAL");
    expect(
      evaluateAction({ action: risky, state: state(), handoffAvailable: true })
        .disposition,
    ).toBe("REQUEST_HUMAN_HANDOFF");
    expect(evaluateAction({ action: risky, state: state() }).disposition).toBe(
      "BLOCK_BEFORE_EXECUTION",
    );
    expect(
      evaluateAction({ action: risky, state: state(), routeCovered: false })
        .disposition,
    ).toBe("PASS_THROUGH_ORIGINAL");
  });

  it("denies an active lease and invalidates pre-handoff action state before resume", () => {
    const leased = activateUserLease(state(), "handoff-1");
    expect(evaluateAction({ action: action(), state: leased }).reasonCode).toBe(
      "OXRAIL_USER_LEASE_ACTIVE",
    );
    const resuming = beginResume(leased, "handoff-1", leased.leaseEpoch);
    expect(resuming).toMatchObject({
      phase: "RESUMING",
      pointerOwner: "NONE",
      revision: 1,
      targetCacheEpoch: 1,
      pendingNativeActionIds: [],
    });
    const resumed = finishResume(resuming, "handoff-1", leased.leaseEpoch);
    expect(resumed).toMatchObject({ phase: "RUNNING", pointerOwner: "NATIVE" });
    expect(resumed).not.toHaveProperty("activeHandoffId");
  });

  it("detects optimistic state-version conflicts", () => {
    expect(() =>
      recordActionOutcome(
        state(),
        action(),
        evaluateAction({ action: action(), state: state() }),
        {
          meaningfulProgress: false,
          expectedStateVersion: 1,
        },
      ),
    ).toThrow(StateVersionConflictError);
  });

  it("produces deterministic digests without retaining action text", () => {
    const secretAction = action({
      target: { ...action().target!, text: "sensitive fixture value" },
    });
    const decision = evaluateAction({ action: secretAction, state: state() });
    const digest = createActionDigest(secretAction, decision, 123);
    expect(JSON.stringify(digest)).not.toContain("sensitive fixture value");
    expect(createActionDigest(secretAction, decision, 123)).toEqual(digest);
    const fingerprint = {
      originKey: "https://example.test",
      relevantRegionHash: "a".repeat(64),
      revision: 1,
    } as const;
    expect(stateFingerprintDigest(fingerprint)).toBe(
      stateFingerprintDigest({ ...fingerprint }),
    );
  });
});
