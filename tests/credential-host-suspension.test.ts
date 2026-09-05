import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "../packages/core/src/index.js";
import {
  activatePreparedHandoff,
  admitCredentialIntent,
  createBrowserTaskState,
  credentialToolFencePre,
  handoffScopeBindingHash,
  initializeCredentialExecutionGate,
  observePreparedCredentialHostSuspension,
  prepareHandoffBarrier,
  prepareHandoffLease,
  readBrowserTaskState,
  readCredentialExecutionGate,
  transitionCredentialExecutionGate,
  writeBrowserTaskState,
  type CredentialHostSuspensionQuery,
  type FixtureCredentialExecutionBinding,
  type HandoffHostBinding,
  type HandoffLease,
  type ObserveCredentialHostSuspension,
} from "../packages/core/src/index.js";
import { withCredentialToolFenceLock } from "../packages/core/src/credential-tool-fence-lock.js";
import {
  deterministicDigest,
  type CredentialHostSuspensionReceipt,
  type CredentialUseRegistryEntry,
} from "../packages/protocol/src/index.js";

const origin = "https://credentials.example.test";
const host: HandoffHostBinding = {
  profileBindingHash: "d".repeat(64),
  profileId: "fixture-profile",
};
const scope = {
  sessionId: "credential-suspension-session",
  taskId: "credential-suspension-task",
  tabId: 42,
  topOrigin: origin,
  documentBinding: "credential-suspension-document",
};
const registryEntry: CredentialUseRegistryEntry = {
  schemaVersion: 1,
  credentialUseId: "fixture.publish.api-key",
  credentialKind: "API_KEY",
  templateId: "fixture.api-key.v1",
  serviceId: "fixture-service",
  provisioningOrigin: origin,
  purposeId: "publish-post",
  consumerId: "fixture.https.publisher",
  grantTtlSeconds: 3_600,
  generation: 1,
  readiness: "FIXTURE_ONLY",
  registryVersion: 1,
  templateRegistryHash:
    "b01287454e5727a721e941b00e6d5bf2b6a0c89c47cfb3f9edcad5820e970cdd",
  consumerRegistryHash:
    "71e4b865818705e073c556f3adea9bb296fe359f0385cb48ec6054862347b1be",
  registryManifestHash:
    "2fd54c5c4bf0672d670323d3bb181aa185ebfdec8667baedb69e13222790e4d7",
};
const canary = "credential_secret_canary_must_never_cross_suspension";
const temporaryDirectories: string[] = [];

interface SuspensionFixture {
  binding: FixtureCredentialExecutionBinding;
  credentialRoot: string;
  handoffRoot: string;
  lease: HandoffLease;
  promptContextHash: string;
}

async function makeRoot(label: string): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), `oxrail-${label}-`));
  temporaryDirectories.push(parent);
  return path.join(parent, "state");
}

async function fixture(): Promise<SuspensionFixture> {
  const handoffRoot = await makeRoot("credential-suspension-handoff");
  const credentialRoot = await makeRoot("credential-suspension-fence");
  const pending = prepareHandoffLease({
    handoffId: "credential-suspension-handoff",
    previousLeaseEpoch: 0,
    nonce: "0123456789abcdef0123456789abcdef",
    scope,
    createdAt: 1_000,
    expiresAt: 10_000,
  });
  await writeBrowserTaskState(
    handoffRoot,
    {
      ...createBrowserTaskState({
        sessionId: scope.sessionId,
        taskId: scope.taskId,
        hostProfileId: host.profileId,
        mode: "MICRO_ACTION_GUARD",
      }),
      currentOrigin: scope.topOrigin,
      documentBinding: scope.documentBinding,
    },
    null,
  );
  await prepareHandoffBarrier(handoffRoot, pending, host, () => 1_100);
  const activated = await activatePreparedHandoff(
    handoffRoot,
    pending,
    host,
    async () => ({
      admissionGeneration: 1,
      browserInstanceBindingHash: "e".repeat(64),
      expiresAt: 9_000,
      hostProfileBindingHash: host.profileBindingHash,
      nativeActionFenceHash: "f".repeat(64),
      observedAt: 1_150,
      receiptHash: "9".repeat(64),
      scopeBindingHash: handoffScopeBindingHash(scope),
    }),
    () => 1_200,
  );
  if (activated.kind !== "ACTIVE") throw new Error("fixture activation failed");
  const ticket = await admitCredentialIntent(
    handoffRoot,
    { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
    [registryEntry],
    activated.lease,
    host,
    () => 2_000,
  );
  const binding: FixtureCredentialExecutionBinding = {
    hookDefinitionHash: "6".repeat(64),
    hostProfileHash: host.profileBindingHash,
    ticket,
    trustRootHash: "8".repeat(64),
  };
  await initializeCredentialExecutionGate(credentialRoot, 1_500);
  await transitionCredentialExecutionGate(credentialRoot, {
    binding,
    generation: 1,
    kind: "PREPARE",
    observedAt: 2_000,
  });
  return {
    binding,
    credentialRoot,
    handoffRoot,
    lease: activated.lease,
    promptContextHash: deterministicDigest(
      "oxrail-credential-prompt-context-v1",
      { observedAt: 2_000, ticket },
    ),
  };
}

const receiptFor = (
  query: CredentialHostSuspensionQuery,
): CredentialHostSuspensionReceipt => ({
  ...query,
  hostSuspensionFenceHash: deterministicDigest(
    "oxrail-test-host-suspension-fence-v1",
    query.challengeHash,
  ),
  lanes: {
    agentTool: "SUSPENDED",
    browserAction: "SUSPENDED",
    browserObservation: "SUSPENDED",
    shell: "SUSPENDED",
    screenCapture: "SUSPENDED",
    clipboard: "SUSPENDED",
    semanticQuery: "SUSPENDED",
    enclaveProtocol: "ALLOWLIST_ONLY",
  },
});

const wireReceiptFor = (query: CredentialHostSuspensionQuery): string =>
  JSON.stringify(receiptFor(query));

const inputFor = (value: SuspensionFixture) => ({
  binding: value.binding,
  generation: 1,
  host,
  lease: value.lease,
  promptContextHash: value.promptContextHash,
});

async function allFiles(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else
        result[path.relative(root, filename)] = await readFile(
          filename,
          "utf8",
        );
    }
  };
  await visit(root);
  return result;
}

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(2_000);
  vi.spyOn(performance, "now").mockReturnValue(100);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("credential Host suspension observation", () => {
  it("keeps package-internal parsers and locked readers off the public barrel", () => {
    expect(Object.hasOwn(core, "credentialExecutionBinding")).toBe(false);
    expect(Object.hasOwn(core, "hasValidFixtureCredentialTicketId")).toBe(
      false,
    );
    expect(Object.hasOwn(core, "observeCredentialToolFenceLocked")).toBe(false);
  });

  it("matches one exact receipt without activating or exposing control identity", async () => {
    const value = await fixture();
    const beforeCredential = await allFiles(value.credentialRoot);
    const beforeHandoff = await allFiles(value.handoffRoot);
    let observedQuery: CredentialHostSuspensionQuery | undefined;
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        observedQuery = query;
        return wireReceiptFor(query);
      },
    );

    expect(result).toEqual({
      activation: "INACTIVE",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      hostSuspension: "UNVERIFIED",
      kind: "STRUCTURE_MATCHED_NON_AUTHORIZING",
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(observedQuery).toBeDefined();
    const serialized = JSON.stringify({ observedQuery, result });
    for (const forbidden of [
      value.binding.ticket.ticketId,
      value.binding.ticket.handoff.activationAnchorHash,
      value.lease.handoffId,
      value.lease.nonce,
      scope.sessionId,
      scope.taskId,
      scope.documentBinding,
      origin,
      canary,
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(Object.hasOwn(observedQuery!, "tabId")).toBe(false);
    expect(Object.hasOwn(observedQuery!, "origin")).toBe(false);
    expect(Object.hasOwn(observedQuery!, "documentBinding")).toBe(false);
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({
      generation: 1,
      kind: "KNOWN",
      state: "PREPARING",
    });
    expect(await allFiles(value.credentialRoot)).toEqual(beforeCredential);
    expect(await allFiles(value.handoffRoot)).toEqual(beforeHandoff);
  });

  it.each([
    [
      "prompt",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        promptContextHash: "0".repeat(64),
      }),
    ],
    [
      "gate",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        gateSnapshotHash: "0".repeat(64),
      }),
    ],
    [
      "Handoff",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        handoffActivationBindingHash: "0".repeat(64),
      }),
    ],
    [
      "Host",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        hostProfileBindingHash: "0".repeat(64),
      }),
    ],
    [
      "browser",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        browserInstanceBindingHash: "0".repeat(64),
      }),
    ],
    [
      "coverage",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        coverageBindingHash: "0".repeat(64),
      }),
    ],
    [
      "challenge",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        challengeHash: "0".repeat(64),
      }),
    ],
    [
      "credential operation",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        credentialOperationDigest: "0".repeat(64),
      }),
    ],
    [
      "tool-fence snapshot",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        toolFenceSnapshotHash: "0".repeat(64),
      }),
    ],
    [
      "verifier context",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        verifierContextBindingHash: "0".repeat(64),
      }),
    ],
    [
      "admission generation",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        admissionGeneration: receipt.admissionGeneration + 1,
      }),
    ],
    [
      "state epoch",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        stateEpoch: receipt.stateEpoch + 1,
      }),
    ],
    [
      "suspension fence freshness",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        hostSuspensionFenceHash: receipt.challengeHash,
      }),
    ],
    [
      "tool lane",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        lanes: { ...receipt.lanes, agentTool: "ACTIVE" as const },
      }),
    ],
    [
      "browser action lane",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        lanes: { ...receipt.lanes, browserAction: "ACTIVE" as const },
      }),
    ],
    [
      "browser observation lane",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        lanes: { ...receipt.lanes, browserObservation: "UNKNOWN" as const },
      }),
    ],
    [
      "shell lane",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        lanes: { ...receipt.lanes, shell: "ACTIVE" as const },
      }),
    ],
    [
      "screen-capture lane",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        lanes: { ...receipt.lanes, screenCapture: "UNKNOWN" as const },
      }),
    ],
    [
      "clipboard lane",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        lanes: { ...receipt.lanes, clipboard: "UNKNOWN" as const },
      }),
    ],
    [
      "semantic-query lane",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        lanes: { ...receipt.lanes, semanticQuery: "ACTIVE" as const },
      }),
    ],
    [
      "enclave protocol lane",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        lanes: { ...receipt.lanes, enclaveProtocol: "ACTIVE" as const },
      }),
    ],
    [
      "extra field",
      (receipt: CredentialHostSuspensionReceipt) => ({
        ...receipt,
        secret: canary,
      }),
    ],
  ] as const)("rejects a receipt with mismatched %s", async (_name, mutate) => {
    const value = await fixture();
    const before = await allFiles(value.credentialRoot);
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => JSON.stringify(mutate(receiptFor(query))),
    );
    expect(result).toEqual({
      activation: "INACTIVE",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      hostSuspension: "UNVERIFIED",
      kind: "FAILED_SAFE",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(await allFiles(value.credentialRoot)).toEqual(before);
  });

  it.each([
    ["ArrayBuffer", () => new ArrayBuffer(8)],
    ["DataView", () => new DataView(new ArrayBuffer(8))],
    ["Uint16Array", () => new Uint16Array(4)],
    ["oversized ArrayBuffer", () => new ArrayBuffer(4 * 1024 + 1)],
  ] as const)("rejects unsupported runtime wire %s", async (_name, wire) => {
    const value = await fixture();
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async () => wire() as never,
    );
    expect(result.kind).toBe("FAILED_SAFE");
  });

  it("burns the one-shot attempt before observer failure", async () => {
    const value = await fixture();
    const observer = vi.fn<ObserveCredentialHostSuspension>(async () => {
      throw new Error(canary);
    });
    const first = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      observer,
    );
    const replay = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      { ...inputFor(value), promptContextHash: "0".repeat(64) },
      observer,
    );
    expect(first.kind).toBe("FAILED_SAFE");
    expect(replay.kind).toBe("FIXTURE_ONLY_REPLAY");
    expect(observer).toHaveBeenCalledTimes(1);
    expect(JSON.stringify({ first, replay })).not.toContain(canary);
  });

  it("rejects late and oversized observations and consumes each attempt", async () => {
    const late = await fixture();
    vi.mocked(performance.now)
      .mockReset()
      .mockReturnValueOnce(100)
      .mockReturnValue(1_101);
    const lateObserver = vi.fn<ObserveCredentialHostSuspension>(async (query) =>
      wireReceiptFor(query),
    );
    const lateResult = await observePreparedCredentialHostSuspension(
      late.credentialRoot,
      late.handoffRoot,
      inputFor(late),
      lateObserver,
    );
    const lateReplay = await observePreparedCredentialHostSuspension(
      late.credentialRoot,
      late.handoffRoot,
      inputFor(late),
      lateObserver,
    );
    expect(lateResult.kind).toBe("FAILED_SAFE");
    expect(lateReplay.kind).toBe("FIXTURE_ONLY_REPLAY");
    expect(lateObserver).toHaveBeenCalledTimes(1);

    const oversized = await fixture();
    const oversizedObserver = vi.fn<ObserveCredentialHostSuspension>(async () =>
      "x".repeat(4 * 1024 + 1),
    );
    const oversizedResult = await observePreparedCredentialHostSuspension(
      oversized.credentialRoot,
      oversized.handoffRoot,
      inputFor(oversized),
      oversizedObserver,
    );
    const oversizedReplay = await observePreparedCredentialHostSuspension(
      oversized.credentialRoot,
      oversized.handoffRoot,
      inputFor(oversized),
      oversizedObserver,
    );
    expect(oversizedResult.kind).toBe("FAILED_SAFE");
    expect(oversizedReplay.kind).toBe("FIXTURE_ONLY_REPLAY");
    expect(oversizedObserver).toHaveBeenCalledTimes(1);
  });

  it("aborts a timed-out observer and will not retry it", async () => {
    const value = await fixture();
    const observer = vi.fn<ObserveCredentialHostSuspension>(
      async (_query, signal) =>
        new Promise<never>((_resolve, reject) => {
          const abort = () => reject(new Error("observer timed out"));
          if (signal.aborted) abort();
          else signal.addEventListener("abort", abort, { once: true });
        }),
    );
    const timedOut = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      observer,
    );
    const replay = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      observer,
    );
    expect(timedOut.kind).toBe("FAILED_SAFE");
    expect(replay.kind).toBe("FIXTURE_ONLY_REPLAY");
    expect(observer).toHaveBeenCalledTimes(1);
  }, 2_000);

  it("rejects caller-added fields before invoking the Host observer", async () => {
    const value = await fixture();
    const observer = vi.fn<ObserveCredentialHostSuspension>();
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      { ...inputFor(value), secret: canary } as never,
      observer,
    );
    expect(result.kind).toBe("FAILED_SAFE");
    expect(observer).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain(canary);
  });

  it("rejects prompt hashes that alias raw ticket or control identities", async () => {
    const value = await fixture();
    const barrier = Object.values(await allFiles(value.handoffRoot))
      .map((contents) => JSON.parse(contents) as Record<string, unknown>)
      .find(
        (candidate) =>
          candidate.state === "ACTIVE" &&
          typeof candidate.nativeActionFenceHash === "string",
      );
    if (!barrier) throw new Error("missing active barrier");
    const observer = vi.fn<ObserveCredentialHostSuspension>();
    const aliases = [
      value.binding.hookDefinitionHash,
      value.binding.trustRootHash,
      value.binding.ticket.ticketId.slice("oct1_".length),
      value.binding.ticket.registryManifestHash,
      value.binding.ticket.handoff.activationAnchorHash,
      barrier.nativeActionFenceHash,
      barrier.tabBindingReceiptHash,
      barrier.nonceDigest,
      barrier.scopeDigest,
      barrier.taskBindingDigest,
      String(barrier.handoffId).slice("oxrail-id:".length),
    ];
    for (const promptContextHash of aliases) {
      const result = await observePreparedCredentialHostSuspension(
        value.credentialRoot,
        value.handoffRoot,
        { ...inputFor(value), promptContextHash: String(promptContextHash) },
        observer,
      );
      expect(result.kind).toBe("FAILED_SAFE");
    }
    expect(observer).not.toHaveBeenCalled();
  });

  it("rejects a suspension-fence replay across operations", async () => {
    const first = await fixture();
    const second = await fixture();
    const reusedFence = "b".repeat(64);
    const observe: ObserveCredentialHostSuspension = async (query) =>
      JSON.stringify({
        ...receiptFor(query),
        hostSuspensionFenceHash: reusedFence,
      });
    const accepted = await observePreparedCredentialHostSuspension(
      first.credentialRoot,
      first.handoffRoot,
      inputFor(first),
      observe,
    );
    const rejected = await observePreparedCredentialHostSuspension(
      second.credentialRoot,
      second.handoffRoot,
      inputFor(second),
      observe,
    );
    expect(accepted.kind).toBe("STRUCTURE_MATCHED_NON_AUTHORIZING");
    expect(rejected.kind).toBe("FAILED_SAFE");
  });

  it("blocks a later Pre while the lock-free observer sees unchanged PREPARING", async () => {
    const value = await fixture();
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        await expect(
          withCredentialToolFenceLock(value.credentialRoot, async () => true),
        ).resolves.toBe(true);
        await expect(
          credentialToolFencePre(value.credentialRoot, {
            sessionId: "incoming-session",
            toolUseId: "incoming-call",
          }),
        ).resolves.toBe("BLOCKED");
        return wireReceiptFor(query);
      },
    );
    expect(result.kind).toBe("STRUCTURE_MATCHED_NON_AUTHORIZING");
  });

  it("rejects if external cleanup opens the gate during observation", async () => {
    const value = await fixture();
    let pre: Awaited<ReturnType<typeof credentialToolFencePre>> | undefined;
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        await transitionCredentialExecutionGate(value.credentialRoot, {
          binding: value.binding,
          generation: 1,
          kind: "ABORT_PREPARING",
          observedAt: 2_001,
          quiescenceReceiptHash: "a".repeat(64),
        });
        await transitionCredentialExecutionGate(value.credentialRoot, {
          binding: value.binding,
          cleanupEvidenceHash: "b".repeat(64),
          generation: 1,
          kind: "FINISH_CLEANUP",
          observedAt: 2_002,
        });
        pre = await credentialToolFencePre(value.credentialRoot, {
          sessionId: "incoming-session",
          toolUseId: "incoming-call",
        });
        return wireReceiptFor(query);
      },
    );
    expect(pre).toBe("NO_LEDGER_BLOCK_TRACKED");
    expect(result.kind).toBe("FAILED_SAFE");
  });

  it("rejects when the locked task snapshot drifts during observation", async () => {
    const value = await fixture();
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        const current = await readBrowserTaskState(
          value.handoffRoot,
          value.lease.scope,
        );
        if (!current) throw new Error("missing task state");
        await writeBrowserTaskState(
          value.handoffRoot,
          { ...current, stateVersion: current.stateVersion + 1 },
          current.stateVersion,
        );
        return wireReceiptFor(query);
      },
    );
    expect(result.kind).toBe("FAILED_SAFE");
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({ state: "PREPARING" });
  });

  it("rejects when the credential lease expires before the final locked read", async () => {
    const value = await fixture();
    let expired = false;
    vi.mocked(Date.now).mockImplementation(() => (expired ? 10_001 : 2_000));
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        expired = true;
        return wireReceiptFor(query);
      },
    );
    expect(result.kind).toBe("FAILED_SAFE");
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({ state: "PREPARING" });
  });

  it("rejects when final verification crosses the monotonic deadline", async () => {
    const value = await fixture();
    vi.mocked(performance.now)
      .mockReset()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValue(1_101);
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => wireReceiptFor(query),
    );
    expect(result.kind).toBe("FAILED_SAFE");
  });

  it("rejects wall-clock rollback between the locked snapshots", async () => {
    const value = await fixture();
    let rolledBack = false;
    vi.mocked(Date.now).mockImplementation(() => (rolledBack ? 2_500 : 3_000));
    const result = await observePreparedCredentialHostSuspension(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        rolledBack = true;
        return wireReceiptFor(query);
      },
    );
    expect(result.kind).toBe("FAILED_SAFE");
  });
});
