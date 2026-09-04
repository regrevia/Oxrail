import { describe, expect, it } from "vitest";

import {
  activateUserLease,
  beginResume,
  browserOwnershipDecision,
  completePendingTool,
  createActionDigest,
  createBrowserTaskState,
  evaluateAction,
  finishResume,
  persistentToolUseId,
  recordActionOutcome,
  sanitizeBrowserTaskStateForPersistence,
  stageToolDecision,
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
  it("stages an executed tool decision without retaining opaque ids or changing progress", () => {
    const before = {
      ...state(),
      noProgressCount: 2,
      recoveryLevel: 3,
      recoveryTransitions: 4,
    };
    const toolAction = action({
      toolUseId: "raw-call-secret",
      target: { ...action().target!, text: "sensitive fixture value" },
    });
    const decision = evaluateAction({ action: toolAction, state: before });

    const staged = stageToolDecision(before, toolAction, decision);

    expect(staged).toMatchObject({
      lastAction: {
        toolUseId:
          "oxrail-id:2a21850f2e84c1a383369fcca1c784f2f63226e310efcab9c754d40f689983e6",
        decision: "ALLOW",
      },
      pendingNativeActionIds: [
        "oxrail-id:2a21850f2e84c1a383369fcca1c784f2f63226e310efcab9c754d40f689983e6",
      ],
      noProgressCount: 2,
      recoveryLevel: 3,
      recoveryTransitions: 4,
      stateVersion: 1,
    });
    expect(JSON.stringify(staged)).not.toContain("raw-call-secret");
    expect(JSON.stringify(staged)).not.toContain("sensitive fixture value");
  });

  it("normalizes and deduplicates pending tool ids when staging repeats", () => {
    const before = {
      ...state(),
      pendingNativeActionIds: ["raw-call-secret"],
      stateVersion: 5,
    };
    const toolAction = action({ toolUseId: "raw-call-secret" });
    const decision = evaluateAction({ action: toolAction, state: before });

    const staged = stageToolDecision(before, toolAction, decision);
    const repeated = stageToolDecision(staged, toolAction, decision);

    expect(staged.pendingNativeActionIds).toEqual([
      "oxrail-id:2a21850f2e84c1a383369fcca1c784f2f63226e310efcab9c754d40f689983e6",
    ]);
    expect(repeated.pendingNativeActionIds).toEqual(
      staged.pendingNativeActionIds,
    );
    expect(repeated.stateVersion).toBe(7);
  });

  it("records denied decisions without adding a pending tool", () => {
    const before = { ...state(), noProgressCount: 2, recoveryLevel: 3 };
    const toolAction = action({ toolUseId: "denied-call" });
    const decision = {
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_REDUNDANT_ACTION",
      recoverable: true,
    } as const;

    const staged = stageToolDecision(before, toolAction, decision);

    expect(staged).toMatchObject({
      lastAction: { decision: "DENY" },
      pendingNativeActionIds: [],
      noProgressCount: 2,
      recoveryLevel: 3,
      stateVersion: 1,
    });
    expect(JSON.stringify(staged)).not.toContain("denied-call");
  });

  it("stages a semantic hint as a pending native action", () => {
    const toolAction = action({ toolUseId: "hint-call" });
    const staged = stageToolDecision(state(), toolAction, {
      disposition: "SEMANTIC_HINT_ONLY",
      reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
      recoverable: true,
    });

    expect(staged).toMatchObject({
      lastAction: { decision: "REWRITE" },
      pendingNativeActionIds: [
        expect.stringMatching(/^oxrail-id:[a-f0-9]{64}$/),
      ],
      noProgressCount: 0,
      stateVersion: 1,
    });
    expect(JSON.stringify(staged)).not.toContain("hint-call");
  });

  it("completes only a matching pending tool without treating it as progress", () => {
    const toolAction = action({ toolUseId: "raw-call-secret" });
    const before = { ...state(), noProgressCount: 2, recoveryLevel: 3 };
    const staged = stageToolDecision(
      before,
      toolAction,
      evaluateAction({ action: toolAction, state: before }),
    );

    const completed = completePendingTool(staged, "raw-call-secret");
    const missing = completePendingTool(completed, "unknown-call");

    expect(completed).toMatchObject({
      lastAction: staged.lastAction,
      pendingNativeActionIds: [],
      noProgressCount: 2,
      recoveryLevel: 3,
      stateVersion: 2,
    });
    expect(missing).toBe(completed);
  });

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

  it("blocks an action that is bound to a different known top origin", () => {
    const boundState = {
      ...state(),
      currentOrigin: "https://example.test",
    };

    expect(
      evaluateAction({
        action: action({ origin: "https://other.test" }),
        state: boundState,
      }),
    ).toMatchObject({
      disposition: "BLOCK_BEFORE_EXECUTION",
      reasonCode: "OXRAIL_UNSAFE_ORIGIN",
    });
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

  it("resumes with the raw handoff id after a persisted-state round trip", () => {
    const rawHandoffId = "raw-handoff-id";
    const leased = activateUserLease(state(), rawHandoffId);
    const reloadedLease = sanitizeBrowserTaskStateForPersistence(leased);
    expect(reloadedLease.activeHandoffId).not.toBe(rawHandoffId);
    expect(() =>
      beginResume(reloadedLease, "wrong-handoff-id", leased.leaseEpoch),
    ).toThrow("Only the active handoff");

    const resuming = beginResume(
      reloadedLease,
      rawHandoffId,
      leased.leaseEpoch,
    );
    const reloadedResume = sanitizeBrowserTaskStateForPersistence(resuming);
    expect(
      finishResume(reloadedResume, rawHandoffId, leased.leaseEpoch),
    ).toMatchObject({ phase: "RUNNING", pointerOwner: "NATIVE" });
  });

  it("rejects a user lease while an allowed native action awaits PostToolUse", () => {
    const toolAction = action({ toolUseId: "in-flight-call" });
    const before = state();
    const pending = stageToolDecision(
      before,
      toolAction,
      evaluateAction({ action: toolAction, state: before }),
    );

    expect(() => activateUserLease(pending, "handoff-1")).toThrow(
      "User lease cannot start while native actions are pending",
    );
  });

  it("keeps raw tool ids distinct from the persisted-id namespace", () => {
    const firstRawId = "call-a";
    const prefixedRawId = persistentToolUseId(firstRawId);
    const firstAction = action({ toolUseId: firstRawId });
    const secondAction = action({ toolUseId: prefixedRawId });
    const first = stageToolDecision(
      state(),
      firstAction,
      evaluateAction({ action: firstAction, state: state() }),
    );
    const second = stageToolDecision(
      first,
      secondAction,
      evaluateAction({ action: secondAction, state: first }),
    );

    expect(second.pendingNativeActionIds).toHaveLength(2);
    const afterSecondPost = completePendingTool(second, prefixedRawId);
    expect(afterSecondPost.pendingNativeActionIds).toEqual([
      persistentToolUseId(firstRawId),
    ]);
    expect(completePendingTool(afterSecondPost, firstRawId)).toMatchObject({
      pendingNativeActionIds: [],
    });
  });

  it("keeps a prefixed raw outcome id distinct after persistence", () => {
    const firstRawId = "call-a";
    const prefixedRawId = persistentToolUseId(firstRawId);
    const toolAction = action({ toolUseId: prefixedRawId });
    const recorded = recordActionOutcome(
      state(),
      toolAction,
      evaluateAction({ action: toolAction, state: state() }),
      { meaningfulProgress: true, timestamp: 1 },
    );
    const persisted = sanitizeBrowserTaskStateForPersistence(recorded);

    expect(persisted.lastAction?.toolUseId).toBe(
      persistentToolUseId(prefixedRawId),
    );
    expect(persisted.lastAction?.toolUseId).not.toBe(prefixedRawId);
    expect(sanitizeBrowserTaskStateForPersistence(persisted)).toEqual(
      persisted,
    );
  });

  it.each([
    ["USER_LEASE_ACTIVE", "HUMAN", "OXRAIL_USER_LEASE_ACTIVE"],
    ["HANDOFF_VERIFYING", "HUMAN", "OXRAIL_USER_LEASE_ACTIVE"],
    ["HANDOFF_PREPARING", "NATIVE", "OXRAIL_VERIFICATION_INCONCLUSIVE"],
    ["RESTORING_TAB", "NONE", "OXRAIL_POST_HANDOFF_TARGET_INVALIDATED"],
    ["RESUMING", "NONE", "OXRAIL_POST_HANDOFF_TARGET_INVALIDATED"],
  ] as const)(
    "blocks browser ownership while phase=%s and owner=%s",
    (phase, pointerOwner, reasonCode) => {
      expect(
        browserOwnershipDecision({ ...state(), phase, pointerOwner }),
      ).toMatchObject({ disposition: "BLOCK_BEFORE_EXECUTION", reasonCode });
    },
  );

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
