import { describe, expect, it } from "vitest";

import {
  activateUserLease,
  createBrowserTaskState,
  persistentHandoffId,
  prepareHandoffLease,
  transitionHandoffLease,
} from "../packages/core/src/index.js";
import {
  evaluateCompletionCandidate,
  type CompletionCandidateInput,
} from "../packages/core/src/handoff-completion.js";

const nonce = "A".repeat(43);
const contextHash = "a".repeat(64);
const initialOrigin = "https://login.example.test";
const finalOrigin = "https://app.example.test";
const initialDocument = "document-before";
const finalDocument = "document-after";

function fixture(
  signalOverrides: Record<string, unknown> = {},
): CompletionCandidateInput {
  const request = {
    schemaVersion: 1,
    handoffId: "handoff-1",
    sessionId: "session-1",
    taskId: "task-1",
    leaseEpoch: 1,
    nonce,
    type: "AUTH_REQUIRED",
    tabBinding: {
      tabId: 42,
      windowId: 7,
      index: 2,
      topOrigin: initialOrigin,
      allowedRedirectOrigins: [finalOrigin],
      initialDocumentBinding: initialDocument,
    },
    completionPolicy: "AUTH_FLOW_COMPLETED",
    timeoutMs: 10_000,
    createdAt: 1_000,
  };
  const pending = prepareHandoffLease({
    handoffId: request.handoffId,
    previousLeaseEpoch: 0,
    nonce,
    scope: {
      sessionId: request.sessionId,
      taskId: request.taskId,
      tabId: request.tabBinding.tabId,
      topOrigin: request.tabBinding.topOrigin,
      documentBinding: request.tabBinding.initialDocumentBinding,
    },
    createdAt: request.createdAt,
    expiresAt: request.createdAt + request.timeoutMs,
  });
  const activated = transitionHandoffLease(
    pending,
    {
      kind: "ACTIVATE",
      handoffId: request.handoffId,
      leaseEpoch: request.leaseEpoch,
      nonce,
      scope: pending.scope,
      observedAt: 1_100,
    },
    1_100,
  );
  if (!activated.accepted) throw new Error(activated.reason);

  const running = {
    ...createBrowserTaskState({
      sessionId: request.sessionId,
      taskId: request.taskId,
      hostProfileId: "host-profile-1",
      mode: "MICRO_ACTION_GUARD",
    }),
    currentOrigin: initialOrigin,
    documentBinding: initialDocument,
  };
  const taskState = activateUserLease(running, request.handoffId);
  const signal = {
    schemaVersion: 1,
    handoffId: request.handoffId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    leaseEpoch: request.leaseEpoch,
    nonce,
    tabId: request.tabBinding.tabId,
    initialDocumentBinding: initialDocument,
    observedDocumentBinding: finalDocument,
    origin: finalOrigin,
    source: "ISOLATED_VERIFIER",
    kind: "CHALLENGE_GONE",
    confidence: "DETERMINISTIC",
    observedAt: 1_500,
    ...signalOverrides,
  };
  const sample = (probeSequence: number) => ({
    schemaVersion: 1,
    handoffId: request.handoffId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    leaseEpoch: request.leaseEpoch,
    nonce,
    probeSequence,
    verifierContextBindingHash: contextHash,
    tabId: request.tabBinding.tabId,
    initialDocumentBinding: initialDocument,
    observedDocumentBinding: finalDocument,
    origin: finalOrigin,
    stateEpoch: 9,
    completionState: "CONFIRMED",
    ...(automatic(signal.kind) ? { automaticPhase: signal.kind } : {}),
    tabState: "BOUND",
    navigationState: "IDLE",
    redirectState: "CONTINUOUSLY_ALLOWED",
    sensitivePhase: "CLEARED",
  });

  return {
    request,
    signal,
    lease: activated.lease,
    taskState,
    authenticatedSignalSource: signal.source,
    expectedVerifierContextBindingHash: contextHash,
    acceptedSamples: [
      {
        sample: sample(10),
        authenticatedChannel: "ISOLATED_VERIFIER",
        expectedProbeSequence: 10,
        acceptedAtMonotonicMs: 300,
      },
      {
        sample: sample(11),
        authenticatedChannel: "ISOLATED_VERIFIER",
        expectedProbeSequence: 11,
        acceptedAtMonotonicMs: 800,
      },
    ],
    requestAdmittedAtMonotonicMs: 0,
    leaseActivatedAtMonotonicMs: 100,
    handoffDeadlineAtMonotonicMs: 10_000,
    signalReceivedAtMonotonicMs: 200,
    nowMonotonicMs: 800,
  };
}

function automatic(value: unknown): boolean {
  return [
    "CHALLENGE_GONE",
    "AUTH_MARKER_PRESENT",
    "EXPECTED_ROUTE",
    "DIALOG_CLOSED",
  ].includes(value as string);
}

const evaluate = (input = fixture()) => evaluateCompletionCandidate(input);

const ready = (
  basis: "DETERMINISTIC" | "HEURISTIC" | "USER_ASSERTED",
  phaseSignal: "CHALLENGE_GONE" | "MANUAL_DONE",
) => ({
  kind: "READY_FOR_LOCKED_VERIFY",
  basis,
  phaseSignal,
  verificationBinding: {
    verifierContextBindingHash: contextHash,
    stateEpoch: 9,
    firstProbeSequence: 10,
    secondProbeSequence: 11,
    secondAcceptedAtMonotonicMs: 800,
    handoffDeadlineAtMonotonicMs: 10_000,
    automaticCandidateDeadlineAtMonotonicMs:
      phaseSignal === "MANUAL_DONE" ? 10_000 : 5_200,
  },
  lockedBinding: {
    handoffId: "handoff-1",
    sessionId: "session-1",
    taskId: "task-1",
    leaseEpoch: 1,
    nonce,
    tabId: 42,
    initialDocumentBinding: initialDocument,
    observedDocumentBinding: finalDocument,
    origin: finalOrigin,
    expectedStateVersion: 1,
  },
});

describe("Handoff completion candidate gate", () => {
  it.each([
    ["DETERMINISTIC", "DETERMINISTIC"],
    ["HEURISTIC", "HEURISTIC"],
  ])("accepts two safe %s verifier samples", (confidence, basis) => {
    expect(evaluate(fixture({ confidence }))).toEqual(
      ready(basis as "DETERMINISTIC" | "HEURISTIC", "CHALLENGE_GONE"),
    );
  });

  it("lets authenticated manual Done start, but not bypass, verification", () => {
    const input = fixture({
      source: "EXTENSION_OWNED_UI",
      kind: "MANUAL_DONE",
      confidence: "USER_ASSERTED",
    });
    expect(evaluate(input)).toEqual(ready("USER_ASSERTED", "MANUAL_DONE"));
    input.acceptedSamples = input.acceptedSamples.slice(0, 1);
    expect(evaluate(input)).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "AWAITING_VERIFICATION",
    });
  });

  it("rejects source spoofing and accepts only an authenticated UI cancel", () => {
    const spoofed = fixture();
    spoofed.authenticatedSignalSource = "EXTENSION_OWNED_UI";
    expect(evaluate(spoofed)).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "UNAUTHENTICATED_SOURCE",
    });

    expect(
      evaluate(
        fixture({
          source: "EXTENSION_OWNED_UI",
          kind: "CANCELLED",
          confidence: "USER_ASSERTED",
        }),
      ),
    ).toEqual({ kind: "CANCEL_REQUESTED" });

    expect(
      evaluate(
        fixture({
          source: "EXTENSION_OWNED_UI",
          kind: "CANCELLED",
          confidence: "USER_ASSERTED",
          origin: "https://unexpected.example.test",
        }),
      ),
    ).toEqual({ kind: "CANCEL_REQUESTED" });
  });

  it("requires exact active lease, task, signal, and sample bindings", () => {
    const rawState = fixture();
    rawState.taskState = {
      ...(rawState.taskState as Record<string, unknown>),
      activeHandoffId: "handoff-1",
    };
    expect(evaluate(rawState).kind).toBe("READY_FOR_LOCKED_VERIFY");

    const persistedState = fixture();
    expect(
      (persistedState.taskState as { activeHandoffId: string }).activeHandoffId,
    ).toBe(persistentHandoffId("handoff-1"));
    expect(evaluate(persistedState).kind).toBe("READY_FOR_LOCKED_VERIFY");

    const wrongLease = fixture();
    wrongLease.lease = { ...wrongLease.lease, leaseEpoch: 2 };
    expect(evaluate(wrongLease)).toEqual({
      kind: "FAILED_SAFE",
      reason: "ACTIVE_BINDING_MISMATCH",
    });

    const wrongSignal = fixture();
    wrongSignal.signal = { ...(wrongSignal.signal as object), taskId: "other" };
    expect(evaluate(wrongSignal)).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "SIGNAL_BINDING_MISMATCH",
    });

    const wrongSample = fixture();
    wrongSample.acceptedSamples[1]!.sample = {
      ...(wrongSample.acceptedSamples[1]!.sample as object),
      observedDocumentBinding: "other-document",
    };
    expect(evaluate(wrongSample)).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "VERIFICATION_MISMATCH",
    });
  });

  it("enforces the 500ms settle boundary", () => {
    const at499 = fixture();
    at499.acceptedSamples[1]!.acceptedAtMonotonicMs = 799;
    expect(evaluate(at499)).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "INVALID_RECEIVER_TIME",
    });

    const at500 = fixture();
    expect(evaluate(at500).kind).toBe("READY_FOR_LOCKED_VERIFY");
  });

  it("enforces the 5000ms automatic signal age boundary", () => {
    const at5000 = fixture();
    at5000.nowMonotonicMs = 5_200;
    expect(evaluate(at5000).kind).toBe("READY_FOR_LOCKED_VERIFY");

    const at5001 = fixture();
    at5001.nowMonotonicMs = 5_201;
    expect(evaluate(at5001)).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "STALE_SIGNAL",
    });
  });

  it("fails expired or corrupt active Host context without trusting evidence", () => {
    const expired = fixture();
    expired.nowMonotonicMs = 10_001;
    expect(evaluate(expired)).toEqual({
      kind: "FAILED_SAFE",
      reason: "HANDOFF_DEADLINE_EXPIRED",
    });

    const corrupt = fixture();
    corrupt.taskState = {
      ...(corrupt.taskState as object),
      phase: "RUNNING",
    };
    expect(evaluate(corrupt)).toEqual({
      kind: "FAILED_SAFE",
      reason: "ACTIVE_CONTEXT_INVALID",
    });
  });

  it.each([
    ["tabState", "UNKNOWN"],
    ["navigationState", "CHANGING"],
    ["redirectState", "UNKNOWN"],
    ["sensitivePhase", "ACTIVE"],
  ])("keeps Human ownership for %s=%s", (field, value) => {
    const input = fixture();
    input.acceptedSamples[0]!.sample = {
      ...(input.acceptedSamples[0]!.sample as object),
      [field]: value,
    };
    expect(evaluate(input)).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "AWAITING_VERIFICATION",
    });
  });

  it("fails safe on unsafe origins, closed tabs, and tab mismatches", () => {
    expect(
      evaluate(fixture({ kind: "UNSAFE_ORIGIN", confidence: "DETERMINISTIC" })),
    ).toEqual({ kind: "FAILED_SAFE", reason: "UNSAFE_ORIGIN" });
    expect(
      evaluate(
        fixture({
          kind: "UNSAFE_ORIGIN",
          confidence: "DETERMINISTIC",
          origin: "https://unexpected.example.test",
        }),
      ),
    ).toEqual({ kind: "FAILED_SAFE", reason: "UNSAFE_ORIGIN" });

    for (const [tabState, reason] of [
      ["CLOSED", "TAB_CLOSED"],
      ["MISMATCH", "TAB_MISMATCH"],
    ] as const) {
      const input = fixture();
      input.acceptedSamples[0]!.sample = {
        ...(input.acceptedSamples[0]!.sample as object),
        tabState,
      };
      expect(evaluate(input)).toEqual({ kind: "FAILED_SAFE", reason });
    }

    const stickyUnsafe = fixture();
    stickyUnsafe.acceptedSamples[0]!.sample = {
      ...(stickyUnsafe.acceptedSamples[0]!.sample as object),
      redirectState: "UNSAFE_SEEN",
    };
    expect(evaluate(stickyUnsafe)).toEqual({
      kind: "FAILED_SAFE",
      reason: "UNSAFE_ORIGIN",
    });

    const laterClosed = fixture();
    laterClosed.acceptedSamples[0]!.sample = {
      ...(laterClosed.acceptedSamples[0]!.sample as object),
      navigationState: "UNKNOWN",
    };
    laterClosed.acceptedSamples[1]!.sample = {
      ...(laterClosed.acceptedSamples[1]!.sample as object),
      tabState: "CLOSED",
    };
    expect(evaluate(laterClosed)).toEqual({
      kind: "FAILED_SAFE",
      reason: "TAB_CLOSED",
    });
  });

  it("requires the automatic phase to match the Host-derived policy", () => {
    const input = fixture();
    input.request = {
      ...(input.request as object),
      type: "PERMISSION_REQUIRED",
      completionPolicy: "DIALOG_OR_ROUTE_COMPLETED",
    };
    expect(evaluate(input)).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "POLICY_MISMATCH",
    });
  });

  it("rejects secret-bearing or untrusted samples without echoing them", () => {
    const canary = "credential-must-not-cross-evaluator";
    const input = fixture();
    input.acceptedSamples[0]!.sample = {
      ...(input.acceptedSamples[0]!.sample as object),
      token: canary,
    };
    const result = evaluate(input);
    expect(result).toEqual({
      kind: "KEEP_USER_LEASE",
      reason: "INVALID_INPUT",
    });
    expect(JSON.stringify(result)).not.toContain(canary);

    const wrongChannel = fixture();
    wrongChannel.acceptedSamples[0]!.authenticatedChannel =
      "EXTENSION_OWNED_UI";
    expect(evaluate(wrongChannel).kind).toBe("KEEP_USER_LEASE");
  });

  it("returns only the private candidate fields and never mutates state", () => {
    const input = fixture();
    const before = structuredClone(input);
    const result = evaluate(input);
    expect(Object.keys(result).sort()).toEqual([
      "basis",
      "kind",
      "lockedBinding",
      "phaseSignal",
      "verificationBinding",
    ]);
    if (result.kind !== "READY_FOR_LOCKED_VERIFY") throw new Error("not ready");
    expect(Object.keys(result.lockedBinding).sort()).toEqual([
      "expectedStateVersion",
      "handoffId",
      "initialDocumentBinding",
      "leaseEpoch",
      "nonce",
      "observedDocumentBinding",
      "origin",
      "sessionId",
      "tabId",
      "taskId",
    ]);
    expect(Object.keys(result.verificationBinding).sort()).toEqual([
      "automaticCandidateDeadlineAtMonotonicMs",
      "firstProbeSequence",
      "handoffDeadlineAtMonotonicMs",
      "secondAcceptedAtMonotonicMs",
      "secondProbeSequence",
      "stateEpoch",
      "verifierContextBindingHash",
    ]);
    expect(input).toEqual(before);
  });
});
