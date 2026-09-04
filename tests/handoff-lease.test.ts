import { describe, expect, it } from "vitest";

import {
  prepareHandoffLease,
  transitionHandoffLease,
  type HandoffLeaseEvent,
} from "../packages/core/src/index.js";

const scope = {
  sessionId: "session-1",
  taskId: "task-1",
  tabId: 17,
  topOrigin: "https://accounts.example.test",
  documentBinding: "document-1",
} as const;

const nonce = "0123456789abcdef0123456789abcdef";

function event(
  kind: HandoffLeaseEvent["kind"],
  observedAt: number,
): HandoffLeaseEvent {
  return {
    kind,
    handoffId: "handoff-1",
    leaseEpoch: 8,
    nonce,
    scope,
    observedAt,
  } as HandoffLeaseEvent;
}

describe("handoff lease state machine", () => {
  it("prepares and activates one bound, monotonic user lease", () => {
    const pending = prepareHandoffLease({
      handoffId: "handoff-1",
      previousLeaseEpoch: 7,
      nonce,
      scope,
      createdAt: 1_000,
      expiresAt: 10_000,
    });

    expect(pending).toMatchObject({
      handoffId: "handoff-1",
      leaseEpoch: 8,
      nonce,
      scope,
      state: "PENDING",
      holder: "NONE",
    });
    expect(
      transitionHandoffLease(pending, event("ACTIVATE", 1_001), 1_001),
    ).toMatchObject({
      accepted: true,
      lease: { state: "ACTIVE", holder: "USER", acquiredAt: 1_001 },
    });
  });

  it("holds a verified completion until safe resume prerequisites pass", () => {
    const pending = prepareHandoffLease({
      handoffId: "handoff-1",
      previousLeaseEpoch: 7,
      nonce,
      scope,
      createdAt: 1_000,
      expiresAt: 10_000,
    });
    const activated = transitionHandoffLease(
      pending,
      event("ACTIVATE", 1_001),
      1_001,
    );
    if (!activated.accepted) throw new Error("fixture activation failed");

    const signalled = transitionHandoffLease(
      activated.lease,
      {
        ...event("ACTIVATE", 2_000),
        kind: "COMPLETION_SIGNAL",
        completionKind: "AUTH_MARKER_PRESENT",
      } as HandoffLeaseEvent,
      2_000,
    );
    expect(signalled).toMatchObject({
      accepted: true,
      lease: {
        state: "VERIFYING",
        holder: "USER",
        lastCompletionObservedAt: 2_000,
      },
    });
    if (!signalled.accepted) throw new Error("fixture signal failed");

    const verified = transitionHandoffLease(
      signalled.lease,
      {
        ...event("ACTIVATE", 2_001),
        kind: "VERIFICATION_PASSED",
      } as HandoffLeaseEvent,
      2_001,
    );
    expect(verified).toMatchObject({
      accepted: true,
      lease: { state: "RELEASING", holder: "USER", verifiedAt: 2_001 },
    });
    if (!verified.accepted) throw new Error("fixture verification failed");

    expect(
      transitionHandoffLease(
        verified.lease,
        {
          ...event("ACTIVATE", 2_002),
          kind: "RESUME_READY",
          tabReady: true,
          staleTargetsInvalidated: false,
          safeObservation: {
            observedAt: 2_002,
            topOrigin: scope.topOrigin,
            documentBinding: "document-2",
          },
        } as unknown as HandoffLeaseEvent,
        2_002,
      ),
    ).toMatchObject({
      accepted: false,
      reason: "INVALID_RESUME_PROOF",
      lease: { state: "RELEASING", holder: "USER" },
    });

    expect(
      transitionHandoffLease(
        verified.lease,
        {
          ...event("ACTIVATE", 2_002),
          kind: "RESUME_READY",
          tabReady: true,
          staleTargetsInvalidated: true,
          safeObservation: {
            observedAt: 2_002,
            topOrigin: scope.topOrigin,
            documentBinding: "document-2",
          },
        } as HandoffLeaseEvent,
        2_002,
      ),
    ).toMatchObject({
      accepted: true,
      lease: {
        state: "RELEASED",
        holder: "AGENT",
        resumedDocumentBinding: "document-2",
      },
    });
  });

  it("rejects expired, stale, replayed, and mismatched completion signals", () => {
    const pending = prepareHandoffLease({
      handoffId: "handoff-1",
      previousLeaseEpoch: 7,
      nonce,
      scope,
      createdAt: 1_000,
      expiresAt: 20_000,
    });
    const activated = transitionHandoffLease(
      pending,
      event("ACTIVATE", 1_001),
      1_001,
    );
    if (!activated.accepted) throw new Error("fixture activation failed");
    const completion = {
      ...event("ACTIVATE", 2_000),
      kind: "COMPLETION_SIGNAL",
      completionKind: "AUTH_MARKER_PRESENT",
    } as HandoffLeaseEvent;

    for (const badEvent of [
      { ...completion, leaseEpoch: 7 },
      { ...completion, nonce: "fedcba9876543210fedcba9876543210" },
      { ...completion, scope: { ...scope, sessionId: "other-session" } },
      {
        ...completion,
        scope: { ...scope, topOrigin: "https://evil.example.test" },
      },
      {
        ...completion,
        scope: { ...scope, documentBinding: "replacement-document" },
      },
    ]) {
      expect(
        transitionHandoffLease(activated.lease, badEvent, 2_000),
      ).toMatchObject({
        accepted: false,
        reason: "BINDING_MISMATCH",
        lease: { state: "ACTIVE", holder: "USER" },
      });
    }

    expect(
      transitionHandoffLease(activated.lease, completion, 7_001),
    ).toMatchObject({
      accepted: false,
      reason: "STALE_SIGNAL",
      lease: { state: "ACTIVE", holder: "USER" },
    });

    const signalled = transitionHandoffLease(
      activated.lease,
      completion,
      2_000,
    );
    if (!signalled.accepted) throw new Error("fixture signal failed");
    expect(
      transitionHandoffLease(signalled.lease, completion, 2_001),
    ).toMatchObject({
      accepted: false,
      reason: "REPLAYED_EVENT",
      lease: { state: "VERIFYING", holder: "USER" },
    });

    const expiredLease = { ...activated.lease, expiresAt: 1_500 };
    expect(
      transitionHandoffLease(expiredLease, completion, 2_000),
    ).toMatchObject({
      accepted: false,
      reason: "LEASE_EXPIRED",
      lease: { state: "ACTIVE", holder: "USER" },
    });
  });

  it("fails closed on unknown signals and corrupted lease ownership", () => {
    const pending = prepareHandoffLease({
      handoffId: "handoff-1",
      previousLeaseEpoch: 7,
      nonce,
      scope,
      createdAt: 1_000,
      expiresAt: 10_000,
    });
    const activated = transitionHandoffLease(
      pending,
      event("ACTIVATE", 1_001),
      1_001,
    );
    if (!activated.accepted) throw new Error("fixture activation failed");

    expect(
      transitionHandoffLease(
        activated.lease,
        {
          ...event("ACTIVATE", 2_000),
          kind: "COMPLETION_SIGNAL",
          completionKind: "PAGE_SAYS_DONE",
        } as unknown as HandoffLeaseEvent,
        2_000,
      ),
    ).toMatchObject({ accepted: false, reason: "INVALID_STATE" });

    expect(
      transitionHandoffLease(
        { ...activated.lease, holder: "NONE" },
        {
          ...event("ACTIVATE", 2_000),
          kind: "COMPLETION_SIGNAL",
          completionKind: "AUTH_MARKER_PRESENT",
        } as HandoffLeaseEvent,
        2_000,
      ),
    ).toMatchObject({
      accepted: false,
      reason: "INVALID_STATE",
      lease: { state: "ACTIVE", holder: "NONE" },
    });
  });

  it("keeps the user lease after inconclusive verification and cancels safely after expiry", () => {
    const pending = prepareHandoffLease({
      handoffId: "handoff-1",
      previousLeaseEpoch: 7,
      nonce,
      scope,
      createdAt: 1_000,
      expiresAt: 1_500,
    });
    const activated = transitionHandoffLease(
      pending,
      event("ACTIVATE", 1_001),
      1_001,
    );
    if (!activated.accepted) throw new Error("fixture activation failed");
    const signal = transitionHandoffLease(
      activated.lease,
      {
        ...event("ACTIVATE", 1_100),
        kind: "COMPLETION_SIGNAL",
        completionKind: "MANUAL_DONE",
      } as HandoffLeaseEvent,
      1_100,
    );
    if (!signal.accepted) throw new Error("fixture signal failed");

    expect(
      transitionHandoffLease(
        signal.lease,
        {
          ...event("ACTIVATE", 1_101),
          kind: "VERIFICATION_INCONCLUSIVE",
        } as unknown as HandoffLeaseEvent,
        1_101,
      ),
    ).toMatchObject({
      accepted: true,
      lease: { state: "ACTIVE", holder: "USER" },
    });
    expect(
      transitionHandoffLease(
        activated.lease,
        {
          ...event("ACTIVATE", 2_000),
          kind: "CANCEL",
        } as unknown as HandoffLeaseEvent,
        2_000,
      ),
    ).toMatchObject({
      accepted: true,
      lease: { state: "CANCELLED", holder: "NONE" },
    });
  });
});
