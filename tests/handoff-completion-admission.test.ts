import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  activatePreparedHandoff,
  admitHandoffCompletionCandidate,
  createBrowserTaskState,
  handoffScopeBindingHash,
  inspectToolCallJournal,
  prepareHandoffBarrier,
  prepareHandoffLease,
  readBrowserTaskState,
  readHandoffGate,
  recordToolCallPre,
  writeBrowserTaskState,
  type CompletionCandidateInput,
  type HandoffLease,
  type ObserveHandoffCurrentTab,
} from "../packages/core/src/index.js";
import type { HandoffCurrentTabReceipt } from "../packages/protocol/src/index.js";

const FIXTURE_ORIGIN = "http://127.0.0.1:4173";
const HOST_PROFILE_ID = "fixture-profile";
const HOST_PROFILE_BINDING = "d".repeat(64);
const BROWSER_INSTANCE_BINDING = "a".repeat(64);
const ACTIVATION_TAB_RECEIPT = "b".repeat(64);
const ACTIVATION_NATIVE_FENCE = "e".repeat(64);
const COMPLETION_RECEIPT = "c".repeat(64);
const COMPLETION_NATIVE_FENCE = "f".repeat(64);
const VERIFIER_CONTEXT = "9".repeat(64);
const NONCE = `${"A".repeat(42)}E`;
const HANDOFF_ID = "raw-handoff-id-must-not-persist";
const INITIAL_DOCUMENT = "raw-initial-document-must-not-persist";
const FINAL_DOCUMENT = "raw-final-document-must-not-persist";
const SECRET_CANARY = "secret-canary-must-never-persist-or-return";
let fixtureSequence = 0;

interface FixtureOptions {
  finalOrigin?: string;
  initialOrigin?: string;
}

interface AdmissionFixture {
  activeLease: HandoffLease;
  finalDocument: string;
  finalOrigin: string;
  initialDocument: string;
  input: CompletionCandidateInput;
  monotonicClock: () => number;
  root: string;
  scope: HandoffLease["scope"];
}

type Receipt = Record<string, unknown>;
type ReceiptMutation = (receipt: Receipt) => void;

const setReceipt =
  (key: string, value: unknown): ReceiptMutation =>
  (receipt) => {
    receipt[key] = value;
  };

const hostBinding = {
  profileBindingHash: HOST_PROFILE_BINDING,
  profileId: HOST_PROFILE_ID,
} as const;

const allow = {
  disposition: "PASS_THROUGH_ORIGINAL",
  reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
  recoverable: true,
} as const;

async function allFiles(directory: string): Promise<string[]> {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) => {
        const filename = path.join(directory, entry.name);
        return entry.isDirectory() ? allFiles(filename) : [filename];
      }),
    )
  ).flat();
}

async function findJson(
  root: string,
  predicate: (value: Record<string, unknown>, filename: string) => boolean,
): Promise<string> {
  for (const filename of await allFiles(root)) {
    if (!filename.endsWith(".json")) continue;
    try {
      const value = JSON.parse(await readFile(filename, "utf8")) as unknown;
      if (
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        predicate(value as Record<string, unknown>, filename)
      ) {
        return filename;
      }
    } catch {
      // Fault-injection helpers skip unrelated private JSON.
    }
  }
  throw new Error("expected private JSON fixture");
}

async function makeFixture(
  options: FixtureOptions = {},
): Promise<AdmissionFixture> {
  const initialOrigin = options.initialOrigin ?? FIXTURE_ORIGIN;
  const finalOrigin = options.finalOrigin ?? initialOrigin;
  const initialDocument = INITIAL_DOCUMENT;
  const finalDocument = FINAL_DOCUMENT;
  const root = path.join(
    await mkdtemp(path.join(tmpdir(), "oxrail-completion-admission-")),
    "state",
  );
  const fixtureId = (fixtureSequence += 1);
  const scope = {
    sessionId: `fixture-session-${fixtureId}`,
    taskId: `fixture-task-${fixtureId}`,
    tabId: 42,
    topOrigin: initialOrigin,
    documentBinding: initialDocument,
  };
  const request = {
    schemaVersion: 1 as const,
    handoffId: HANDOFF_ID,
    sessionId: scope.sessionId,
    taskId: scope.taskId,
    toolUseId: SECRET_CANARY,
    leaseEpoch: 1,
    nonce: NONCE,
    type: "AUTH_REQUIRED" as const,
    tabBinding: {
      tabId: scope.tabId,
      windowId: 7,
      index: 2,
      topOrigin: initialOrigin,
      ...(finalOrigin === initialOrigin
        ? {}
        : { allowedRedirectOrigins: [finalOrigin] }),
      initialDocumentBinding: initialDocument,
    },
    completionPolicy: "AUTH_FLOW_COMPLETED" as const,
    timeoutMs: 10_000,
    createdAt: 1_000,
  };
  const pendingLease = prepareHandoffLease({
    handoffId: request.handoffId,
    previousLeaseEpoch: 0,
    nonce: request.nonce,
    scope,
    createdAt: request.createdAt,
    expiresAt: request.createdAt + request.timeoutMs,
  });
  const running = {
    ...createBrowserTaskState({
      sessionId: scope.sessionId,
      taskId: scope.taskId,
      hostProfileId: HOST_PROFILE_ID,
      mode: "MICRO_ACTION_GUARD",
    }),
    currentOrigin: initialOrigin,
    documentBinding: initialDocument,
  };
  await writeBrowserTaskState(root, running, null);
  await prepareHandoffBarrier(root, pendingLease, hostBinding, () => 1_100);
  const activated = await activatePreparedHandoff(
    root,
    pendingLease,
    hostBinding,
    async () => ({
      admissionGeneration: 1,
      browserInstanceBindingHash: BROWSER_INSTANCE_BINDING,
      expiresAt: 9_000,
      hostProfileBindingHash: HOST_PROFILE_BINDING,
      nativeActionFenceHash: ACTIVATION_NATIVE_FENCE,
      observedAt: 1_200,
      receiptHash: ACTIVATION_TAB_RECEIPT,
      scopeBindingHash: handoffScopeBindingHash(scope),
    }),
    () => 1_300,
  );
  if (activated.kind !== "ACTIVE") {
    throw new Error("fixture handoff did not activate");
  }
  const taskState = await readBrowserTaskState(root, scope);
  if (!taskState) throw new Error("fixture task state is missing");

  const signal = {
    schemaVersion: 1 as const,
    handoffId: request.handoffId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    leaseEpoch: request.leaseEpoch,
    nonce: request.nonce,
    tabId: request.tabBinding.tabId,
    initialDocumentBinding: initialDocument,
    observedDocumentBinding: finalDocument,
    origin: finalOrigin,
    source: "ISOLATED_VERIFIER" as const,
    kind: "CHALLENGE_GONE" as const,
    confidence: "DETERMINISTIC" as const,
    observedAt: 1_500,
  };
  const sample = (probeSequence: number) => ({
    schemaVersion: 1 as const,
    handoffId: request.handoffId,
    sessionId: request.sessionId,
    taskId: request.taskId,
    leaseEpoch: request.leaseEpoch,
    nonce: request.nonce,
    probeSequence,
    verifierContextBindingHash: VERIFIER_CONTEXT,
    tabId: request.tabBinding.tabId,
    initialDocumentBinding: initialDocument,
    observedDocumentBinding: finalDocument,
    origin: finalOrigin,
    stateEpoch: 9,
    completionState: "CONFIRMED" as const,
    automaticPhase: signal.kind,
    tabState: "BOUND" as const,
    navigationState: "IDLE" as const,
    redirectState: "CONTINUOUSLY_ALLOWED" as const,
    sensitivePhase: "CLEARED" as const,
  });
  const input: CompletionCandidateInput = {
    request,
    signal,
    lease: activated.lease,
    taskState,
    authenticatedSignalSource: signal.source,
    expectedVerifierContextBindingHash: VERIFIER_CONTEXT,
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
  return {
    activeLease: activated.lease,
    finalDocument,
    finalOrigin,
    initialDocument,
    input,
    monotonicClock: () => 800,
    root,
    scope,
  };
}

function receiptFor(
  fixture: AdmissionFixture,
  candidateDigest: string,
): HandoffCurrentTabReceipt {
  return {
    schemaVersion: 1,
    authority: "FIXTURE_ONLY_NON_AUTHORIZING",
    candidateDigest,
    admissionGeneration: fixture.activeLease.leaseEpoch,
    hostProfileBindingHash: HOST_PROFILE_BINDING,
    browserInstanceBindingHash: BROWSER_INSTANCE_BINDING,
    activationTabBindingReceiptHash: ACTIVATION_TAB_RECEIPT,
    activationNativeActionFenceHash: ACTIVATION_NATIVE_FENCE,
    completionNativeActionFenceHash: COMPLETION_NATIVE_FENCE,
    completionReceiptHash: COMPLETION_RECEIPT,
    tabId: fixture.scope.tabId,
    initialDocumentBinding: fixture.initialDocument,
    observedDocumentBinding: fixture.finalDocument,
    origin: fixture.finalOrigin,
    verifierContextBindingHash: VERIFIER_CONTEXT,
    stateEpoch: 9,
    lastAcceptedProbeSequence: 11,
    exclusiveTabLease: "HELD",
    agentActionLane: "SUSPENDED",
    agentObservationLane: "SUSPENDED",
    completionState: "CONFIRMED",
    automaticPhase: "CHALLENGE_GONE",
    tabState: "BOUND",
    navigationState: "IDLE",
    redirectState: "CONTINUOUSLY_ALLOWED",
    sensitivePhase: "CLEARED",
  };
}

function observerFor(fixture: AdmissionFixture, mutate?: ReceiptMutation) {
  return vi.fn<ObserveHandoffCurrentTab>(async (query, signal) => {
    if (signal.aborted) throw new Error("fixture observer was already aborted");
    const candidateDigest =
      query &&
      typeof query === "object" &&
      !Array.isArray(query) &&
      typeof (query as { candidateDigest?: unknown }).candidateDigest ===
        "string"
        ? (query as { candidateDigest: string }).candidateDigest
        : "invalid";
    const receipt = receiptFor(fixture, candidateDigest);
    mutate?.(receipt as unknown as Receipt);
    return receipt;
  });
}

const isSuccess = (value: unknown): boolean =>
  Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (value as { kind?: unknown }).kind === "FIXTURE_ONLY_HANDOFF_VERIFYING",
  );

async function expectNoMutation(
  fixture: AdmissionFixture,
  observer: ObserveHandoffCurrentTab,
): Promise<unknown> {
  const before = await readBrowserTaskState(fixture.root, fixture.scope);
  const result = await admitHandoffCompletionCandidate(
    fixture.root,
    fixture.input,
    observer,
    fixture.monotonicClock,
  );
  expect(isSuccess(result)).toBe(false);
  await expect(
    readBrowserTaskState(fixture.root, fixture.scope),
  ).resolves.toEqual(before);
  await expect(readHandoffGate(fixture.root, fixture.scope)).resolves.toEqual({
    generation: 1,
    kind: "KNOWN",
    status: "ACTIVE",
  });
  return result;
}

describe("fixture-only locked Handoff completion admission", () => {
  it("atomically consumes one safe candidate while Human keeps the ACTIVE lease", async () => {
    const fixture = await makeFixture();
    const initialState = await readBrowserTaskState(
      fixture.root,
      fixture.scope,
    );
    if (!initialState) throw new Error("missing initial state");
    const leaseBefore = structuredClone(fixture.activeLease);
    let observedQuery: Record<string, unknown> | undefined;
    const observer = vi.fn<ObserveHandoffCurrentTab>(async (query, signal) => {
      expect(signal.aborted).toBe(false);
      expect(query).toEqual(expect.any(Object));
      observedQuery = query as unknown as Record<string, unknown>;
      const serialized = JSON.stringify(query);
      for (const forbidden of [
        NONCE,
        HANDOFF_ID,
        fixture.scope.sessionId,
        fixture.scope.taskId,
        fixture.initialDocument,
        fixture.finalDocument,
        fixture.finalOrigin,
        SECRET_CANARY,
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(query).toMatchObject({
        admissionGeneration: 1,
        activationNativeActionFenceHash: ACTIVATION_NATIVE_FENCE,
        activationTabBindingReceiptHash: ACTIVATION_TAB_RECEIPT,
        browserInstanceBindingHash: BROWSER_INSTANCE_BINDING,
        hostProfileBindingHash: HOST_PROFILE_BINDING,
        lastAcceptedProbeSequence: 11,
        stateEpoch: 9,
        tabId: 42,
        verifierContextBindingHash: VERIFIER_CONTEXT,
        candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      return receiptFor(
        fixture,
        (query as { candidateDigest: string }).candidateDigest,
      );
    });

    const result = await admitHandoffCompletionCandidate(
      fixture.root,
      fixture.input,
      observer,
      fixture.monotonicClock,
    );

    expect(result).toMatchObject({
      activation: "INACTIVE",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      kind: "FIXTURE_ONLY_HANDOFF_VERIFYING",
    });
    expect(observedQuery).toBeDefined();
    const stored = await readBrowserTaskState(fixture.root, fixture.scope);
    expect(stored).toMatchObject({
      activeHandoffId: initialState.activeHandoffId,
      currentOrigin: fixture.finalOrigin,
      documentBinding: expect.stringMatching(/^oxrail-id:[a-f0-9]{64}$/),
      leaseEpoch: 1,
      phase: "HANDOFF_VERIFYING",
      pointerOwner: "HUMAN",
      pendingNativeActionIds: [],
      stateVersion: initialState.stateVersion + 1,
      handoffVerificationMarker: {
        activationAnchorDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        authority: "FIXTURE_ONLY_NON_AUTHORIZING",
        basis: "DETERMINISTIC",
        candidateDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        currentTabReceiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
        firstProbeSequence: 10,
        leaseEpoch: 1,
        phaseSignal: "CHALLENGE_GONE",
        schemaVersion: 1,
        secondProbeSequence: 11,
        stateEpoch: 9,
        verifierContextBindingHash: VERIFIER_CONTEXT,
      },
    });
    expect(stored?.documentBinding).not.toBe(fixture.finalDocument);
    expect(stored?.handoffVerificationMarker?.currentTabReceiptDigest).not.toBe(
      COMPLETION_RECEIPT,
    );
    expect(fixture.activeLease).toEqual(leaseBefore);
    await expect(readHandoffGate(fixture.root, fixture.scope)).resolves.toEqual(
      {
        generation: 1,
        kind: "KNOWN",
        status: "ACTIVE",
      },
    );

    const persisted = (
      await Promise.all(
        (await allFiles(fixture.root)).map((filename) =>
          readFile(filename).catch(() => Buffer.alloc(0)),
        ),
      )
    )
      .map((contents) => contents.toString("utf8"))
      .join("\n");
    const publicOutput = JSON.stringify(result);
    const markerOutput = JSON.stringify(stored?.handoffVerificationMarker);
    for (const forbidden of [
      NONCE,
      HANDOFF_ID,
      fixture.scope.sessionId,
      fixture.scope.taskId,
      fixture.initialDocument,
      fixture.finalDocument,
      SECRET_CANARY,
    ]) {
      expect(publicOutput).not.toContain(forbidden);
      expect(markerOutput).not.toContain(forbidden);
    }
    for (const forbidden of [
      NONCE,
      HANDOFF_ID,
      fixture.initialDocument,
      fixture.finalDocument,
      SECRET_CANARY,
    ]) {
      expect(persisted).not.toContain(forbidden);
    }
  });

  it("consumes a concurrent/replayed candidate only once", async () => {
    const fixture = await makeFixture();
    const initialState = await readBrowserTaskState(
      fixture.root,
      fixture.scope,
    );
    if (!initialState) throw new Error("missing initial state");
    const observer = observerFor(fixture);

    const concurrent = await Promise.all([
      admitHandoffCompletionCandidate(
        fixture.root,
        fixture.input,
        observer,
        fixture.monotonicClock,
      ),
      admitHandoffCompletionCandidate(
        fixture.root,
        fixture.input,
        observer,
        fixture.monotonicClock,
      ),
    ]);
    expect(concurrent.filter(isSuccess)).toHaveLength(1);
    expect(observer).toHaveBeenCalledTimes(1);

    const replay = await admitHandoffCompletionCandidate(
      fixture.root,
      fixture.input,
      observer,
      fixture.monotonicClock,
    );
    expect(isSuccess(replay)).toBe(false);
    expect(observer).toHaveBeenCalledTimes(1);
    await expect(
      readBrowserTaskState(fixture.root, fixture.scope),
    ).resolves.toMatchObject({
      phase: "HANDOFF_VERIFYING",
      pointerOwner: "HUMAN",
      stateVersion: initialState.stateVersion + 1,
    });
  });

  it("does not reuse the same probe pair after a failed observer attempt", async () => {
    const fixture = await makeFixture();
    const invalidObserver = observerFor(
      fixture,
      setReceipt("agentObservationLane", "UNKNOWN"),
    );
    await expectNoMutation(fixture, invalidObserver);
    expect(invalidObserver).toHaveBeenCalledTimes(1);

    fixture.input.signal = {
      ...(fixture.input.signal as Record<string, unknown>),
      confidence: "HEURISTIC",
    };
    const replacementObserver = observerFor(fixture);
    await expect(
      admitHandoffCompletionCandidate(
        fixture.root,
        fixture.input,
        replacementObserver,
        fixture.monotonicClock,
      ),
    ).resolves.toEqual({
      activation: "INACTIVE",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      kind: "FIXTURE_ONLY_REPLAY",
    });
    expect(replacementObserver).not.toHaveBeenCalled();

    fixture.input.acceptedSamples = fixture.input.acceptedSamples.map(
      (accepted, index) => ({
        ...accepted,
        expectedProbeSequence: 11 + index,
        sample: {
          ...(accepted.sample as Record<string, unknown>),
          probeSequence: 11 + index,
        },
      }),
    );
    const overlappingObserver = observerFor(fixture);
    await expect(
      admitHandoffCompletionCandidate(
        fixture.root,
        fixture.input,
        overlappingObserver,
        fixture.monotonicClock,
      ),
    ).resolves.toMatchObject({ kind: "FIXTURE_ONLY_REPLAY" });
    expect(overlappingObserver).not.toHaveBeenCalled();
  });

  it("does not write for a stale state version or candidate binding", async () => {
    const stale = await makeFixture();
    const staleState = stale.input.taskState as Record<string, unknown>;
    stale.input.taskState = {
      ...staleState,
      stateVersion: (staleState.stateVersion as number) + 1,
    };
    const staleObserver = observerFor(stale);
    await expectNoMutation(stale, staleObserver);
    expect(staleObserver).not.toHaveBeenCalled();

    const mismatched = await makeFixture();
    mismatched.input.signal = {
      ...(mismatched.input.signal as Record<string, unknown>),
      taskId: "another-task",
    };
    const mismatchObserver = observerFor(mismatched);
    await expectNoMutation(mismatched, mismatchObserver);
    expect(mismatchObserver).not.toHaveBeenCalled();
  });

  it("does not write for an unknown gate, mismatched ACTIVE barrier, or pending journal", async () => {
    const unknownGate = await makeFixture();
    const barrier = await findJson(
      unknownGate.root,
      (value, filename) =>
        filename.includes("handoff-barriers") &&
        value.state === "ACTIVE" &&
        value.leaseEpoch === 1,
    );
    await writeFile(path.join(path.dirname(barrier), "lease-2.json"), "{}\n", {
      mode: 0o600,
    });
    const unknownObserver = observerFor(unknownGate);
    const unknownBefore = await readBrowserTaskState(
      unknownGate.root,
      unknownGate.scope,
    );
    const unknownResult = await admitHandoffCompletionCandidate(
      unknownGate.root,
      unknownGate.input,
      unknownObserver,
      unknownGate.monotonicClock,
    );
    expect(isSuccess(unknownResult)).toBe(false);
    expect(unknownObserver).not.toHaveBeenCalled();
    await expect(
      readBrowserTaskState(unknownGate.root, unknownGate.scope),
    ).resolves.toEqual(unknownBefore);

    const mismatchedBarrier = await makeFixture();
    const activeBarrier = await findJson(
      mismatchedBarrier.root,
      (value, filename) =>
        filename.includes("handoff-barriers") && value.state === "ACTIVE",
    );
    const barrierValue = JSON.parse(
      await readFile(activeBarrier, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      activeBarrier,
      `${JSON.stringify({
        ...barrierValue,
        browserInstanceBindingHash: "8".repeat(64),
      })}\n`,
      { mode: 0o600 },
    );
    const barrierObserver = observerFor(mismatchedBarrier);
    await expectNoMutation(mismatchedBarrier, barrierObserver);
    // The authenticated observer is the independent source that detects a
    // syntactically valid but substituted browser-instance anchor.
    expect(barrierObserver).toHaveBeenCalledTimes(1);

    const pendingJournal = await makeFixture();
    await expect(
      recordToolCallPre(pendingJournal.root, {
        sessionId: pendingJournal.scope.sessionId,
        taskId: pendingJournal.scope.taskId,
        toolUseId: "concurrent-native-call",
        bindingDigest: "1".repeat(64),
        requestDigest: "2".repeat(64),
        decision: allow,
      }),
    ).resolves.toMatchObject({ kind: "RECORDED", journalStatus: "PENDING" });
    await expect(
      inspectToolCallJournal(pendingJournal.root, pendingJournal.scope),
    ).resolves.toMatchObject({
      kind: "KNOWN",
      pendingToolUseIds: [expect.stringMatching(/^oxrail-id:/)],
    });
    const journalObserver = observerFor(pendingJournal);
    await expectNoMutation(pendingJournal, journalObserver);
    expect(journalObserver).not.toHaveBeenCalled();
  });

  it.each([
    ["candidate digest", setReceipt("candidateDigest", "0".repeat(64))],
    ["admission generation", setReceipt("admissionGeneration", 2)],
    ["Host Profile", setReceipt("hostProfileBindingHash", "0".repeat(64))],
    [
      "browser instance",
      setReceipt("browserInstanceBindingHash", "0".repeat(64)),
    ],
    [
      "activation tab receipt",
      setReceipt("activationTabBindingReceiptHash", "0".repeat(64)),
    ],
    [
      "activation fence",
      setReceipt("activationNativeActionFenceHash", "0".repeat(64)),
    ],
    ["tab", setReceipt("tabId", 43)],
    [
      "initial document",
      setReceipt("initialDocumentBinding", "other-initial-document"),
    ],
    [
      "current document",
      setReceipt("observedDocumentBinding", "other-current-document"),
    ],
    ["current origin", setReceipt("origin", "https://other.test")],
    [
      "verifier context",
      setReceipt("verifierContextBindingHash", "0".repeat(64)),
    ],
    ["state epoch", setReceipt("stateEpoch", 10)],
    ["last sequence", setReceipt("lastAcceptedProbeSequence", 10)],
    ["exclusive tab lease", setReceipt("exclusiveTabLease", "UNKNOWN")],
    ["Agent action lane", setReceipt("agentActionLane", "ACTIVE")],
    ["Agent observation lane", setReceipt("agentObservationLane", "ACTIVE")],
    [
      "fresh completion fence",
      setReceipt("completionNativeActionFenceHash", ACTIVATION_NATIVE_FENCE),
    ],
    [
      "completion fence distinct from activation tab receipt",
      setReceipt("completionNativeActionFenceHash", ACTIVATION_TAB_RECEIPT),
    ],
    [
      "lowercase completion fence",
      setReceipt("completionNativeActionFenceHash", "F".repeat(64)),
    ],
    [
      "fresh completion receipt",
      setReceipt("completionReceiptHash", ACTIVATION_TAB_RECEIPT),
    ],
    [
      "completion receipt distinct from activation fence",
      setReceipt("completionReceiptHash", ACTIVATION_NATIVE_FENCE),
    ],
    [
      "lowercase completion receipt",
      setReceipt("completionReceiptHash", "C".repeat(64)),
    ],
    ["completion state", setReceipt("completionState", "UNKNOWN")],
    ["automatic phase", setReceipt("automaticPhase", "EXPECTED_ROUTE")],
    ["bound tab state", setReceipt("tabState", "UNKNOWN")],
    ["idle navigation", setReceipt("navigationState", "CHANGING")],
    ["continuous redirect", setReceipt("redirectState", "UNKNOWN")],
    ["cleared sensitive phase", setReceipt("sensitivePhase", "ACTIVE")],
  ] as const)(
    "requires a fresh trusted receipt with exact %s binding",
    async (_name, mutate) => {
      const fixture = await makeFixture();
      await expectNoMutation(fixture, observerFor(fixture, mutate));
    },
  );

  it("keeps Human ownership when the trusted observer throws or times out", async () => {
    const thrown = await makeFixture();
    const throwingObserver = vi.fn<ObserveHandoffCurrentTab>(
      async (_query, _signal) => {
        throw new Error("fixture observer unavailable");
      },
    );
    const before = await readBrowserTaskState(thrown.root, thrown.scope);
    const result = await admitHandoffCompletionCandidate(
      thrown.root,
      thrown.input,
      throwingObserver,
      thrown.monotonicClock,
    );
    expect(isSuccess(result)).toBe(false);
    await expect(
      readBrowserTaskState(thrown.root, thrown.scope),
    ).resolves.toEqual(before);

    const timedOut = await makeFixture();
    timedOut.input.nowMonotonicMs = 5_199;
    timedOut.input.acceptedSamples[0]!.acceptedAtMonotonicMs = 4_699;
    timedOut.input.acceptedSamples[1]!.acceptedAtMonotonicMs = 5_199;
    timedOut.monotonicClock = () => 5_199;
    const timeoutObserver = vi.fn<ObserveHandoffCurrentTab>(
      async (_query, signal): Promise<HandoffCurrentTabReceipt | undefined> =>
        new Promise((_resolve, reject) => {
          const abort = () => reject(new Error("fixture observer timed out"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
    );
    const timeoutBefore = await readBrowserTaskState(
      timedOut.root,
      timedOut.scope,
    );
    const timeoutResult = await admitHandoffCompletionCandidate(
      timedOut.root,
      timedOut.input,
      timeoutObserver,
      timedOut.monotonicClock,
    );
    expect(isSuccess(timeoutResult)).toBe(false);
    await expect(
      readBrowserTaskState(timedOut.root, timedOut.scope),
    ).resolves.toEqual(timeoutBefore);
  }, 1_000);

  it("rechecks the receiver deadline after final gate and journal reads", async () => {
    const fixture = await makeFixture();
    let clockReads = 0;
    const receiverTimes = [800, 800, 10_001] as const;
    fixture.monotonicClock = () =>
      receiverTimes[Math.min(clockReads++, receiverTimes.length - 1)]!;
    const observer = vi.fn<ObserveHandoffCurrentTab>(async (query, _signal) => {
      return receiptFor(
        fixture,
        (query as { candidateDigest: string }).candidateDigest,
      );
    });
    const before = await readBrowserTaskState(fixture.root, fixture.scope);
    const result = await admitHandoffCompletionCandidate(
      fixture.root,
      fixture.input,
      observer,
      fixture.monotonicClock,
    );
    expect(isSuccess(result)).toBe(false);
    expect(observer).toHaveBeenCalledTimes(1);
    expect(clockReads).toBe(3);
    await expect(
      readBrowserTaskState(fixture.root, fixture.scope),
    ).resolves.toEqual(before);
  });

  it("does not overflow a MAX_SAFE state version", async () => {
    const fixture = await makeFixture();
    const stateFile = await findJson(
      fixture.root,
      (value) =>
        value.schemaVersion === 3 && value.phase === "USER_LEASE_ACTIVE",
    );
    const state = JSON.parse(await readFile(stateFile, "utf8")) as Record<
      string,
      unknown
    >;
    const maximum = { ...state, stateVersion: Number.MAX_SAFE_INTEGER };
    await writeFile(stateFile, `${JSON.stringify(maximum)}\n`, { mode: 0o600 });
    fixture.input.taskState = maximum;
    const observer = observerFor(fixture);

    await expectNoMutation(fixture, observer);
    expect(observer).not.toHaveBeenCalled();
    await expect(
      readBrowserTaskState(fixture.root, fixture.scope),
    ).resolves.toMatchObject({
      phase: "USER_LEASE_ACTIVE",
      pointerOwner: "HUMAN",
      stateVersion: Number.MAX_SAFE_INTEGER,
    });
  });

  it.each([
    ["initial", { initialOrigin: "https://accounts.example.test" }],
    ["final", { finalOrigin: "https://app.example.test" }],
  ] as const)(
    "keeps the %s HTTPS origin outside the fixture ceiling",
    async (_name, options) => {
      const fixture = await makeFixture(options);
      const observer = observerFor(fixture);
      await expectNoMutation(fixture, observer);
      expect(observer).not.toHaveBeenCalled();
    },
  );
});
