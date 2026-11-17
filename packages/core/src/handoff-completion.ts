import { timingSafeEqual } from "node:crypto";

import {
  BrowserTaskStateSchema,
  HandoffCompletionSignalSchema,
  HandoffRequestSchema,
  HandoffVerificationSampleSchema,
  type HandoffCompletionSignal,
  type HandoffRequest,
  type HandoffVerificationSample,
} from "../../protocol/src/index.js";

import type { HandoffLease } from "./handoff.js";
import {
  canonicalPersistentDocumentBinding,
  canonicalPersistentHandoffId,
  persistentDocumentBinding,
  persistentHandoffId,
} from "./safe-state.js";

const MINIMUM_SETTLE_MS = 500;
const MAXIMUM_AUTOMATIC_SIGNAL_AGE_MS = 5_000;
const canonicalNonce = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/;
const lowercaseHash = /^[a-f0-9]{64}$/;
const automaticKinds = [
  "CHALLENGE_GONE",
  "AUTH_MARKER_PRESENT",
  "EXPECTED_ROUTE",
  "DIALOG_CLOSED",
] as const;

type AutomaticKind = (typeof automaticKinds)[number];

export interface AcceptedHandoffVerificationSample {
  sample: unknown;
  authenticatedChannel: unknown;
  expectedProbeSequence: number;
  acceptedAtMonotonicMs: number;
}

export interface CompletionCandidateInput {
  request: unknown;
  signal: unknown;
  lease: HandoffLease;
  taskState: unknown;
  /** Actual sender identity asserted by a trusted coordinator, never sender input. */
  authenticatedSignalSource: unknown;
  expectedVerifierContextBindingHash: unknown;
  /** Receiver-authenticated/accepted evidence; plain fields are not receipts. */
  acceptedSamples: readonly AcceptedHandoffVerificationSample[];
  requestAdmittedAtMonotonicMs: number;
  leaseActivatedAtMonotonicMs: number;
  handoffDeadlineAtMonotonicMs: number;
  signalReceivedAtMonotonicMs: number;
  nowMonotonicMs: number;
}

export type CompletionCandidate =
  | {
      kind: "KEEP_USER_LEASE";
      reason:
        | "INVALID_INPUT"
        | "INVALID_RECEIVER_TIME"
        | "UNAUTHENTICATED_SOURCE"
        | "STALE_SIGNAL"
        | "POLICY_MISMATCH"
        | "AWAITING_VERIFICATION"
        | "SIGNAL_BINDING_MISMATCH"
        | "VERIFICATION_MISMATCH"
        | "UNEXPECTED_ORIGIN";
    }
  | { kind: "CANCEL_REQUESTED" }
  | {
      kind: "FAILED_SAFE";
      reason:
        | "ACTIVE_CONTEXT_INVALID"
        | "ACTIVE_BINDING_MISMATCH"
        | "HANDOFF_DEADLINE_EXPIRED"
        | "UNSAFE_ORIGIN"
        | "TAB_CLOSED"
        | "TAB_MISMATCH";
    }
  | {
      kind: "READY_FOR_LOCKED_VERIFY";
      basis: "DETERMINISTIC" | "HEURISTIC" | "USER_ASSERTED";
      phaseSignal:
        | "CHALLENGE_GONE"
        | "AUTH_MARKER_PRESENT"
        | "EXPECTED_ROUTE"
        | "DIALOG_CLOSED"
        | "MANUAL_DONE";
      verificationBinding: {
        verifierContextBindingHash: string;
        stateEpoch: number;
        firstProbeSequence: number;
        secondProbeSequence: number;
        secondAcceptedAtMonotonicMs: number;
        handoffDeadlineAtMonotonicMs: number;
        automaticCandidateDeadlineAtMonotonicMs: number;
      };
      lockedBinding: {
        handoffId: string;
        sessionId: string;
        taskId: string;
        leaseEpoch: number;
        nonce: string;
        tabId: number;
        initialDocumentBinding: string;
        observedDocumentBinding: string;
        origin: string;
        expectedStateVersion: number;
      };
    };

const keep = (
  reason: Extract<CompletionCandidate, { kind: "KEEP_USER_LEASE" }>["reason"],
): CompletionCandidate => ({ kind: "KEEP_USER_LEASE", reason });

const failed = (
  reason: Extract<CompletionCandidate, { kind: "FAILED_SAFE" }>["reason"],
): CompletionCandidate => ({ kind: "FAILED_SAFE", reason });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeTime(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function safeNonceEqual(left: unknown, right: string): boolean {
  if (
    typeof left !== "string" ||
    !canonicalNonce.test(left) ||
    !canonicalNonce.test(right)
  ) {
    return false;
  }
  return timingSafeEqual(
    Buffer.from(left, "ascii"),
    Buffer.from(right, "ascii"),
  );
}

function validActiveLease(lease: HandoffLease): boolean {
  if (!isRecord(lease) || !isRecord(lease.scope)) return false;
  const scope = lease.scope;
  let origin: URL;
  try {
    origin = new URL(scope.topOrigin as string);
  } catch {
    return false;
  }
  return (
    lease.schemaVersion === 1 &&
    lease.state === "ACTIVE" &&
    lease.holder === "USER" &&
    typeof lease.handoffId === "string" &&
    lease.handoffId.length > 0 &&
    Number.isSafeInteger(lease.leaseEpoch) &&
    lease.leaseEpoch > 0 &&
    typeof lease.nonce === "string" &&
    canonicalNonce.test(lease.nonce) &&
    isSafeTime(lease.acquiredAt) &&
    isSafeTime(lease.expiresAt) &&
    lease.expiresAt > lease.acquiredAt &&
    typeof scope.sessionId === "string" &&
    scope.sessionId.length > 0 &&
    typeof scope.taskId === "string" &&
    scope.taskId.length > 0 &&
    Number.isSafeInteger(scope.tabId) &&
    (scope.tabId as number) >= 0 &&
    typeof scope.topOrigin === "string" &&
    origin.origin === scope.topOrigin &&
    ["http:", "https:"].includes(origin.protocol) &&
    typeof scope.documentBinding === "string" &&
    scope.documentBinding.length > 0
  );
}

function requestMatchesLease(
  request: HandoffRequest,
  lease: HandoffLease,
): boolean {
  return (
    validActiveLease(lease) &&
    lease.handoffId === request.handoffId &&
    lease.leaseEpoch === request.leaseEpoch &&
    safeNonceEqual(lease.nonce, request.nonce) &&
    lease.scope.sessionId === request.sessionId &&
    lease.scope.taskId === request.taskId &&
    lease.scope.tabId === request.tabBinding.tabId &&
    lease.scope.topOrigin === request.tabBinding.topOrigin &&
    lease.scope.documentBinding === request.tabBinding.initialDocumentBinding &&
    request.createdAt + request.timeoutMs === lease.expiresAt
  );
}

function signalMatchesRequest(
  signal: HandoffCompletionSignal,
  request: HandoffRequest,
): boolean {
  return (
    signal.handoffId === request.handoffId &&
    signal.sessionId === request.sessionId &&
    signal.taskId === request.taskId &&
    signal.leaseEpoch === request.leaseEpoch &&
    safeNonceEqual(signal.nonce, request.nonce) &&
    signal.tabId === request.tabBinding.tabId &&
    signal.initialDocumentBinding === request.tabBinding.initialDocumentBinding
  );
}

function sampleMatchesBindings(
  sample: HandoffVerificationSample,
  request: HandoffRequest,
  signal: HandoffCompletionSignal,
): boolean {
  return (
    sample.handoffId === request.handoffId &&
    sample.sessionId === request.sessionId &&
    sample.taskId === request.taskId &&
    sample.leaseEpoch === request.leaseEpoch &&
    safeNonceEqual(sample.nonce, request.nonce) &&
    sample.tabId === request.tabBinding.tabId &&
    sample.initialDocumentBinding ===
      request.tabBinding.initialDocumentBinding &&
    sample.observedDocumentBinding === signal.observedDocumentBinding &&
    sample.origin === signal.origin
  );
}

function originAllowed(request: HandoffRequest, origin: string): boolean {
  return (
    origin === request.tabBinding.topOrigin ||
    (request.tabBinding.allowedRedirectOrigins ?? []).includes(origin)
  );
}

function phaseMatchesPolicy(
  request: HandoffRequest,
  kind: AutomaticKind,
): boolean {
  return request.completionPolicy === "AUTH_FLOW_COMPLETED"
    ? ["CHALLENGE_GONE", "AUTH_MARKER_PRESENT", "EXPECTED_ROUTE"].includes(kind)
    : request.completionPolicy === "DIALOG_OR_ROUTE_COMPLETED" &&
        ["DIALOG_CLOSED", "EXPECTED_ROUTE"].includes(kind);
}

function exactSampleEnvelope(
  value: AcceptedHandoffVerificationSample,
): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 4 &&
    Object.hasOwn(value, "sample") &&
    Object.hasOwn(value, "authenticatedChannel") &&
    Object.hasOwn(value, "expectedProbeSequence") &&
    Object.hasOwn(value, "acceptedAtMonotonicMs")
  );
}

/**
 * Produces only a non-authorizing completion candidate. READY contains private
 * lock/CAS bindings and must never reach a model, log, queue, or durable store.
 * This pure gate does not authenticate transports or consume challenges; its
 * source/channel/time assertions must come from the trusted coordinator, and
 * runtime activation stays blocked until the locked consume ledger exists.
 * The caller must immediately take the per-task lock, reread current
 * origin/document/lease/gates, consume the probes, and CAS the task state;
 * this function never resumes it.
 */
export function evaluateCompletionCandidate(
  input: CompletionCandidateInput,
): CompletionCandidate {
  const parsedRequest = HandoffRequestSchema.safeParse(input.request);
  const parsedState = BrowserTaskStateSchema.safeParse(input.taskState);
  if (!parsedRequest.success || !parsedState.success) {
    return failed("ACTIVE_CONTEXT_INVALID");
  }
  const request = parsedRequest.data;
  const state = parsedState.data;
  const receiverTimes = [
    input.requestAdmittedAtMonotonicMs,
    input.leaseActivatedAtMonotonicMs,
    input.handoffDeadlineAtMonotonicMs,
    input.signalReceivedAtMonotonicMs,
    input.nowMonotonicMs,
  ];
  if (
    receiverTimes.some((value) => !isSafeTime(value)) ||
    input.requestAdmittedAtMonotonicMs >
      Number.MAX_SAFE_INTEGER - request.timeoutMs ||
    input.handoffDeadlineAtMonotonicMs !==
      input.requestAdmittedAtMonotonicMs + request.timeoutMs ||
    input.requestAdmittedAtMonotonicMs > input.leaseActivatedAtMonotonicMs ||
    input.leaseActivatedAtMonotonicMs > input.signalReceivedAtMonotonicMs ||
    input.signalReceivedAtMonotonicMs > input.nowMonotonicMs
  ) {
    return failed("ACTIVE_CONTEXT_INVALID");
  }
  if (!requestMatchesLease(request, input.lease)) {
    return failed("ACTIVE_BINDING_MISMATCH");
  }
  if (
    state.phase !== "USER_LEASE_ACTIVE" ||
    state.pointerOwner !== "HUMAN" ||
    state.activeHandoffId === undefined ||
    canonicalPersistentHandoffId(state.activeHandoffId) !==
      persistentHandoffId(request.handoffId) ||
    state.leaseEpoch !== request.leaseEpoch ||
    state.sessionId !== request.sessionId ||
    state.taskId !== request.taskId ||
    state.currentOrigin !== request.tabBinding.topOrigin ||
    state.documentBinding === undefined ||
    canonicalPersistentDocumentBinding(state.documentBinding) !==
      persistentDocumentBinding(request.tabBinding.initialDocumentBinding) ||
    state.pendingNativeActionIds.length !== 0
  ) {
    return failed("ACTIVE_BINDING_MISMATCH");
  }
  if (input.nowMonotonicMs > input.handoffDeadlineAtMonotonicMs) {
    return failed("HANDOFF_DEADLINE_EXPIRED");
  }

  const parsedSignal = HandoffCompletionSignalSchema.safeParse(input.signal);
  if (!parsedSignal.success) return keep("INVALID_INPUT");
  const signal = parsedSignal.data;
  if (!signalMatchesRequest(signal, request)) {
    return keep("SIGNAL_BINDING_MISMATCH");
  }
  if (
    input.authenticatedSignalSource !== signal.source ||
    !["ISOLATED_VERIFIER", "EXTENSION_OWNED_UI"].includes(
      input.authenticatedSignalSource as string,
    )
  ) {
    return keep("UNAUTHENTICATED_SOURCE");
  }
  if (signal.kind === "UNSAFE_ORIGIN") {
    return failed("UNSAFE_ORIGIN");
  }
  if (signal.kind === "CANCELLED") return { kind: "CANCEL_REQUESTED" };
  if (!originAllowed(request, signal.origin)) {
    return keep("UNEXPECTED_ORIGIN");
  }

  const automatic = automaticKinds.includes(signal.kind as AutomaticKind);
  if (
    automatic &&
    input.nowMonotonicMs - input.signalReceivedAtMonotonicMs >
      MAXIMUM_AUTOMATIC_SIGNAL_AGE_MS
  ) {
    return keep("STALE_SIGNAL");
  }
  if (automatic && !phaseMatchesPolicy(request, signal.kind as AutomaticKind)) {
    return keep("POLICY_MISMATCH");
  }
  if (
    typeof input.expectedVerifierContextBindingHash !== "string" ||
    !lowercaseHash.test(input.expectedVerifierContextBindingHash) ||
    !Array.isArray(input.acceptedSamples) ||
    input.acceptedSamples.length > 2
  ) {
    return keep("INVALID_INPUT");
  }
  if (input.acceptedSamples.length < 2) {
    return keep("AWAITING_VERIFICATION");
  }

  const accepted = input.acceptedSamples.map((entry) => {
    if (
      !exactSampleEnvelope(entry) ||
      entry.authenticatedChannel !== "ISOLATED_VERIFIER" ||
      !isSafeTime(entry.expectedProbeSequence) ||
      entry.expectedProbeSequence < 1 ||
      !isSafeTime(entry.acceptedAtMonotonicMs)
    ) {
      return undefined;
    }
    const parsed = HandoffVerificationSampleSchema.safeParse(entry.sample);
    return parsed.success ? { ...entry, sample: parsed.data } : undefined;
  });
  const first = accepted[0];
  const second = accepted[1];
  if (!first || !second) return keep("INVALID_INPUT");
  if (
    first.acceptedAtMonotonicMs < input.signalReceivedAtMonotonicMs ||
    second.acceptedAtMonotonicMs > input.nowMonotonicMs ||
    second.acceptedAtMonotonicMs <= first.acceptedAtMonotonicMs ||
    second.acceptedAtMonotonicMs - first.acceptedAtMonotonicMs <
      MINIMUM_SETTLE_MS ||
    second.sample.probeSequence <= first.sample.probeSequence ||
    first.sample.probeSequence !== first.expectedProbeSequence ||
    second.sample.probeSequence !== second.expectedProbeSequence
  ) {
    return keep("INVALID_RECEIVER_TIME");
  }
  for (const entry of [first, second]) {
    if (
      entry.sample.verifierContextBindingHash !==
        input.expectedVerifierContextBindingHash ||
      !sampleMatchesBindings(entry.sample, request, signal)
    ) {
      return keep("VERIFICATION_MISMATCH");
    }
  }
  for (const entry of [first, second]) {
    if (entry.sample.tabState === "CLOSED") return failed("TAB_CLOSED");
    if (entry.sample.tabState === "MISMATCH") return failed("TAB_MISMATCH");
    if (entry.sample.redirectState === "UNSAFE_SEEN") {
      return failed("UNSAFE_ORIGIN");
    }
  }
  for (const entry of [first, second]) {
    if (
      entry.sample.tabState !== "BOUND" ||
      entry.sample.navigationState !== "IDLE" ||
      entry.sample.redirectState !== "CONTINUOUSLY_ALLOWED" ||
      entry.sample.sensitivePhase !== "CLEARED" ||
      entry.sample.completionState !== "CONFIRMED"
    ) {
      return keep("AWAITING_VERIFICATION");
    }
  }
  if (
    first.sample.stateEpoch !== second.sample.stateEpoch ||
    first.sample.completionState !== second.sample.completionState ||
    first.sample.automaticPhase !== second.sample.automaticPhase
  ) {
    return keep("VERIFICATION_MISMATCH");
  }
  if (
    automatic &&
    (first.sample.automaticPhase !== signal.kind ||
      second.sample.automaticPhase !== signal.kind)
  ) {
    return keep("VERIFICATION_MISMATCH");
  }

  const automaticCandidateDeadlineAtMonotonicMs = automatic
    ? Math.min(
        input.handoffDeadlineAtMonotonicMs,
        input.signalReceivedAtMonotonicMs >
          Number.MAX_SAFE_INTEGER - MAXIMUM_AUTOMATIC_SIGNAL_AGE_MS
          ? Number.MAX_SAFE_INTEGER
          : input.signalReceivedAtMonotonicMs + MAXIMUM_AUTOMATIC_SIGNAL_AGE_MS,
      )
    : input.handoffDeadlineAtMonotonicMs;

  return {
    kind: "READY_FOR_LOCKED_VERIFY",
    basis: signal.confidence,
    phaseSignal: signal.kind,
    verificationBinding: {
      verifierContextBindingHash: input.expectedVerifierContextBindingHash,
      stateEpoch: second.sample.stateEpoch,
      firstProbeSequence: first.sample.probeSequence,
      secondProbeSequence: second.sample.probeSequence,
      secondAcceptedAtMonotonicMs: second.acceptedAtMonotonicMs,
      handoffDeadlineAtMonotonicMs: input.handoffDeadlineAtMonotonicMs,
      automaticCandidateDeadlineAtMonotonicMs,
    },
    lockedBinding: {
      handoffId: request.handoffId,
      sessionId: request.sessionId,
      taskId: request.taskId,
      leaseEpoch: request.leaseEpoch,
      nonce: request.nonce,
      tabId: request.tabBinding.tabId,
      initialDocumentBinding: request.tabBinding.initialDocumentBinding,
      observedDocumentBinding: signal.observedDocumentBinding,
      origin: signal.origin,
      expectedStateVersion: state.stateVersion,
    },
  };
}
