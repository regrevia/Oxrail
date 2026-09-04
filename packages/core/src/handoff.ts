export interface HandoffLeaseScope {
  sessionId: string;
  taskId: string;
  tabId: number;
  topOrigin: string;
  documentBinding: string;
}

export interface HandoffLease {
  schemaVersion: 1;
  handoffId: string;
  leaseEpoch: number;
  nonce: string;
  holder: "USER" | "NONE" | "AGENT";
  scope: HandoffLeaseScope;
  acquiredAt: number;
  expiresAt: number;
  state:
    | "PENDING"
    | "ACTIVE"
    | "VERIFYING"
    | "RELEASING"
    | "RELEASED"
    | "CANCELLED";
  completionKind?: CompletionSignalKind;
  lastCompletionObservedAt?: number;
  verifiedAt?: number;
  resumedDocumentBinding?: string;
}

export interface PrepareHandoffLeaseInput {
  handoffId: string;
  previousLeaseEpoch: number;
  nonce: string;
  scope: HandoffLeaseScope;
  createdAt: number;
  expiresAt: number;
}

interface HandoffLeaseEventBinding {
  handoffId: string;
  leaseEpoch: number;
  nonce: string;
  scope: HandoffLeaseScope;
  observedAt: number;
}

export type CompletionSignalKind =
  | "CHALLENGE_GONE"
  | "AUTH_MARKER_PRESENT"
  | "EXPECTED_ROUTE"
  | "DIALOG_CLOSED"
  | "MANUAL_DONE";

export type HandoffLeaseEvent = HandoffLeaseEventBinding &
  (
    | { kind: "ACTIVATE" }
    | { kind: "COMPLETION_SIGNAL"; completionKind: CompletionSignalKind }
    | { kind: "VERIFICATION_INCONCLUSIVE" }
    | { kind: "VERIFICATION_PASSED" }
    | { kind: "CANCEL" }
    | {
        kind: "RESUME_READY";
        tabReady: true;
        staleTargetsInvalidated: true;
        safeObservation: {
          observedAt: number;
          topOrigin: string;
          documentBinding: string;
        };
      }
  );

export type HandoffLeaseTransition =
  | { accepted: true; lease: HandoffLease }
  | {
      accepted: false;
      lease: HandoffLease;
      reason:
        | "INVALID_STATE"
        | "BINDING_MISMATCH"
        | "LEASE_EXPIRED"
        | "REPLAYED_EVENT"
        | "STALE_SIGNAL"
        | "INVALID_RESUME_PROOF";
    };

export const COMPLETION_SIGNAL_MAX_AGE_MS = 5_000;

const completionSignalKinds: readonly CompletionSignalKind[] = [
  "CHALLENGE_GONE",
  "AUTH_MARKER_PRESENT",
  "EXPECTED_ROUTE",
  "DIALOG_CLOSED",
  "MANUAL_DONE",
];

function assertNonEmpty(value: string, name: string): void {
  if (value.length === 0 || value.includes("\0")) {
    throw new TypeError(`${name} must be non-empty text without NUL bytes`);
  }
}

function assertTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertScope(scope: HandoffLeaseScope): void {
  assertNonEmpty(scope.sessionId, "scope.sessionId");
  assertNonEmpty(scope.taskId, "scope.taskId");
  assertNonEmpty(scope.documentBinding, "scope.documentBinding");
  if (!Number.isSafeInteger(scope.tabId) || scope.tabId < 0) {
    throw new TypeError("scope.tabId must be a non-negative safe integer");
  }
  const origin = new URL(scope.topOrigin);
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== scope.topOrigin
  ) {
    throw new TypeError("scope.topOrigin must be a canonical HTTP(S) origin");
  }
}

function sameScope(left: HandoffLeaseScope, right: HandoffLeaseScope): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.taskId === right.taskId &&
    left.tabId === right.tabId &&
    left.topOrigin === right.topOrigin &&
    left.documentBinding === right.documentBinding
  );
}

export function prepareHandoffLease(
  input: PrepareHandoffLeaseInput,
): HandoffLease {
  assertNonEmpty(input.handoffId, "handoffId");
  if (!/^[A-Za-z0-9_-]{32,}$/.test(input.nonce)) {
    throw new TypeError("nonce must contain at least 32 base64url characters");
  }
  assertTimestamp(input.previousLeaseEpoch, "previousLeaseEpoch");
  assertTimestamp(input.createdAt, "createdAt");
  assertTimestamp(input.expiresAt, "expiresAt");
  assertScope(input.scope);
  if (input.expiresAt <= input.createdAt) {
    throw new TypeError("expiresAt must be later than createdAt");
  }
  return {
    schemaVersion: 1,
    handoffId: input.handoffId,
    leaseEpoch: input.previousLeaseEpoch + 1,
    nonce: input.nonce,
    holder: "NONE",
    scope: { ...input.scope },
    acquiredAt: input.createdAt,
    expiresAt: input.expiresAt,
    state: "PENDING",
  };
}

export function transitionHandoffLease(
  lease: HandoffLease,
  event: HandoffLeaseEvent,
  now: number,
): HandoffLeaseTransition {
  assertTimestamp(now, "now");
  const expectedHolder = {
    PENDING: "NONE",
    ACTIVE: "USER",
    VERIFYING: "USER",
    RELEASING: "USER",
    RELEASED: "AGENT",
    CANCELLED: "NONE",
  }[lease.state];
  if (expectedHolder === undefined || lease.holder !== expectedHolder) {
    return { accepted: false, lease, reason: "INVALID_STATE" };
  }
  if (
    lease.handoffId !== event.handoffId ||
    lease.leaseEpoch !== event.leaseEpoch ||
    lease.nonce !== event.nonce ||
    !sameScope(lease.scope, event.scope)
  ) {
    return { accepted: false, lease, reason: "BINDING_MISMATCH" };
  }
  if (
    !Number.isSafeInteger(event.observedAt) ||
    event.observedAt < 0 ||
    event.observedAt < lease.acquiredAt ||
    event.observedAt > now
  ) {
    return { accepted: false, lease, reason: "STALE_SIGNAL" };
  }
  if (event.kind === "CANCEL") {
    if (lease.state === "RELEASED" || lease.state === "CANCELLED") {
      return { accepted: false, lease, reason: "INVALID_STATE" };
    }
    return {
      accepted: true,
      lease: { ...lease, state: "CANCELLED", holder: "NONE" },
    };
  }
  if (now > lease.expiresAt || event.observedAt > lease.expiresAt) {
    return { accepted: false, lease, reason: "LEASE_EXPIRED" };
  }
  if (
    event.kind === "COMPLETION_SIGNAL" &&
    lease.lastCompletionObservedAt !== undefined &&
    event.observedAt <= lease.lastCompletionObservedAt
  ) {
    return { accepted: false, lease, reason: "REPLAYED_EVENT" };
  }
  if (event.kind === "ACTIVATE") {
    if (lease.state !== "PENDING") {
      return { accepted: false, lease, reason: "INVALID_STATE" };
    }
    return {
      accepted: true,
      lease: {
        ...lease,
        state: "ACTIVE",
        holder: "USER",
        acquiredAt: event.observedAt,
      },
    };
  }
  if (event.kind === "COMPLETION_SIGNAL") {
    if (lease.state !== "ACTIVE") {
      return { accepted: false, lease, reason: "INVALID_STATE" };
    }
    if (!completionSignalKinds.includes(event.completionKind)) {
      return { accepted: false, lease, reason: "INVALID_STATE" };
    }
    if (now - event.observedAt > COMPLETION_SIGNAL_MAX_AGE_MS) {
      return { accepted: false, lease, reason: "STALE_SIGNAL" };
    }
    return {
      accepted: true,
      lease: {
        ...lease,
        state: "VERIFYING",
        holder: "USER",
        completionKind: event.completionKind,
        lastCompletionObservedAt: event.observedAt,
      },
    };
  }
  if (event.kind === "VERIFICATION_PASSED") {
    if (
      lease.state !== "VERIFYING" ||
      lease.lastCompletionObservedAt === undefined
    ) {
      return { accepted: false, lease, reason: "INVALID_STATE" };
    }
    if (
      event.observedAt < lease.lastCompletionObservedAt ||
      now - lease.lastCompletionObservedAt > COMPLETION_SIGNAL_MAX_AGE_MS
    ) {
      return { accepted: false, lease, reason: "STALE_SIGNAL" };
    }
    return {
      accepted: true,
      lease: {
        ...lease,
        state: "RELEASING",
        holder: "USER",
        verifiedAt: event.observedAt,
      },
    };
  }
  if (event.kind === "VERIFICATION_INCONCLUSIVE") {
    if (
      lease.state !== "VERIFYING" ||
      lease.lastCompletionObservedAt === undefined
    ) {
      return { accepted: false, lease, reason: "INVALID_STATE" };
    }
    if (
      event.observedAt < lease.lastCompletionObservedAt ||
      now - lease.lastCompletionObservedAt > COMPLETION_SIGNAL_MAX_AGE_MS
    ) {
      return { accepted: false, lease, reason: "STALE_SIGNAL" };
    }
    return {
      accepted: true,
      lease: { ...lease, state: "ACTIVE", holder: "USER" },
    };
  }
  if (event.kind === "RESUME_READY") {
    if (lease.state !== "RELEASING" || lease.verifiedAt === undefined) {
      return { accepted: false, lease, reason: "INVALID_STATE" };
    }
    const observation = event.safeObservation;
    if (
      event.tabReady !== true ||
      event.staleTargetsInvalidated !== true ||
      !observation ||
      observation.topOrigin !== lease.scope.topOrigin ||
      observation.documentBinding.length === 0 ||
      observation.documentBinding === lease.scope.documentBinding ||
      !Number.isSafeInteger(observation.observedAt) ||
      observation.observedAt < lease.verifiedAt ||
      observation.observedAt > event.observedAt ||
      now - observation.observedAt > COMPLETION_SIGNAL_MAX_AGE_MS
    ) {
      return { accepted: false, lease, reason: "INVALID_RESUME_PROOF" };
    }
    return {
      accepted: true,
      lease: {
        ...lease,
        state: "RELEASED",
        holder: "AGENT",
        resumedDocumentBinding: observation.documentBinding,
      },
    };
  }
  return { accepted: false, lease, reason: "INVALID_STATE" };
}
