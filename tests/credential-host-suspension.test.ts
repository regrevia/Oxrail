import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as core from "../packages/core/src/index.js";
import * as executionGate from "../packages/core/src/credential-execution-gate.js";
import {
  activatePreparedHandoff,
  cleanupCredentialFixtureGate,
  commitPreparedCredentialFixtureGate,
  createBrowserTaskState,
  credentialToolFencePost,
  credentialToolFencePre,
  handoffScopeBindingHash,
  initializeCredentialExecutionGate,
  observePreparedCredentialHostSuspension,
  prepareCredentialInputAttempt,
  prepareHandoffBarrier,
  prepareHandoffLease,
  readBrowserTaskState,
  readCredentialExecutionGate,
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
  await initializeCredentialExecutionGate(credentialRoot, 1_500);
  const prepared = await prepareCredentialInputAttempt(
    credentialRoot,
    handoffRoot,
    {
      hookDefinitionHash: "6".repeat(64),
      host,
      intent: {
        schemaVersion: 1,
        credentialUseId: registryEntry.credentialUseId,
      },
      lease: activated.lease,
      registry: [registryEntry],
      trustRootHash: "8".repeat(64),
    },
  );
  if (prepared.kind !== "PREPARED_FIXTURE_NON_AUTHORIZING") {
    throw new Error("fixture preparation failed");
  }
  const { binding } = prepared;
  const { ticket } = binding;
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
    expect(Object.hasOwn(core, "activateCredentialExecutionGateLocked")).toBe(
      false,
    );
    expect(Object.hasOwn(core, "readCredentialExecutionGateLocked")).toBe(
      false,
    );
    expect(Object.hasOwn(core, "cleanupCredentialExecutionGateLocked")).toBe(
      false,
    );
    expect(
      Object.hasOwn(core, "confirmCredentialExecutionGateCleanupLocked"),
    ).toBe(false);
    expect(Object.hasOwn(core, "observeCredentialToolFenceCleanupLocked")).toBe(
      false,
    );
    expect(Object.hasOwn(core, "transitionCredentialExecutionGate")).toBe(
      false,
    );
  });

  it("keeps fixture commit and cleanup disconnected from product adapters", async () => {
    const productSources = await Promise.all(
      [
        "native/macos/Sources",
        "packages/handoff-extension/src",
        "packages/host-openai/src",
      ].map((directory) => allFiles(path.join(process.cwd(), directory))),
    );
    const serialized = JSON.stringify(productSources);
    expect(serialized).not.toContain("commitPreparedCredentialFixtureGate");
    expect(serialized).not.toContain("cleanupCredentialFixtureGate");
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

  it("commits only an inactive fixture gate under the final locked snapshot", async () => {
    const value = await fixture();
    const beforeHandoff = await allFiles(value.handoffRoot);
    let observedQuery: CredentialHostSuspensionQuery | undefined;
    let duringObservation:
      | Awaited<ReturnType<typeof credentialToolFencePre>>
      | undefined;
    let observedReceipt: CredentialHostSuspensionReceipt | undefined;
    const result = await commitPreparedCredentialFixtureGate(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        observedQuery = query;
        duringObservation = await credentialToolFencePre(value.credentialRoot, {
          sessionId: "during-activation-session",
          toolUseId: "during-activation-call",
        });
        observedReceipt = receiptFor(query);
        return JSON.stringify(observedReceipt);
      },
    );

    expect(duringObservation).toBe("BLOCKED");
    expect(result).toEqual({
      activation: "INACTIVE",
      authorization: "NOT_AUTHORIZED",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      credentialInputLease: "NOT_ESTABLISHED",
      credentialProtection: "INACTIVE",
      gate: "ACTIVE",
      generation: 1,
      hostSuspension: "UNVERIFIED",
      kind: "FIXTURE_GATE_COMMITTED_NON_AUTHORIZING",
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    if (result.kind !== "FIXTURE_GATE_COMMITTED_NON_AUTHORIZING") {
      throw new Error("fixture gate was not committed");
    }
    expect(result.receiptDigest).toBe(
      deterministicDigest(
        "oxrail-credential-host-suspension-receipt-v1",
        observedReceipt,
      ),
    );
    const operationDigest = deterministicDigest(
      "oxrail-credential-execution-gate-v1",
      value.binding,
    );
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({
      expiresAt: value.lease.expiresAt,
      generation: 1,
      kind: "KNOWN",
      operationDigest,
      outcome: "ACTIVATED",
      receiptDigest: deterministicDigest(
        "oxrail-credential-quiescence-receipt-v1",
        {
          generation: 1,
          operationDigest,
          quiescenceReceiptHash: result.receiptDigest,
        },
      ),
      state: "ACTIVE",
      updatedAt: 2_000,
    });
    await expect(
      credentialToolFencePre(value.credentialRoot, {
        sessionId: "after-activation-session",
        toolUseId: "after-activation-call",
      }),
    ).resolves.toBe("BLOCKED");
    expect(await allFiles(value.handoffRoot)).toEqual(beforeHandoff);

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
  });

  it("recovers a dead gate lock before taking the suspension snapshot", async () => {
    const value = await fixture();
    await writeFile(
      path.join(
        value.credentialRoot,
        "credential-execution-gate",
        ".current.lock",
      ),
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        createdAt: 1,
        nonce: "22222222-2222-4222-8222-222222222222",
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      commitPreparedCredentialFixtureGate(
        value.credentialRoot,
        value.handoffRoot,
        inputFor(value),
        async (query) => wireReceiptFor(query),
      ),
    ).resolves.toMatchObject({
      gate: "ACTIVE",
      kind: "FIXTURE_GATE_COMMITTED_NON_AUTHORIZING",
    });
  });

  it("does not reactivate after cleanup completes during Host observation", async () => {
    const value = await fixture();
    const result = await commitPreparedCredentialFixtureGate(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        await executionGate.transitionCredentialExecutionGate(
          value.credentialRoot,
          {
            binding: value.binding,
            generation: 1,
            kind: "ABORT_PREPARING",
            observedAt: 2_001,
            quiescenceReceiptHash: "a".repeat(64),
          },
        );
        await executionGate.transitionCredentialExecutionGate(
          value.credentialRoot,
          {
            binding: value.binding,
            cleanupEvidenceHash: "b".repeat(64),
            generation: 1,
            kind: "FINISH_CLEANUP",
            observedAt: 2_002,
          },
        );
        return wireReceiptFor(query);
      },
    );

    expect(result).toEqual({
      activation: "INACTIVE",
      authorization: "NOT_AUTHORIZED",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      credentialInputLease: "NOT_ESTABLISHED",
      credentialProtection: "INACTIVE",
      hostSuspension: "UNVERIFIED",
      kind: "FAILED_SAFE",
    });
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({ state: "OPEN" });
  });

  it("does not apply a stale receipt to a new preparation generation", async () => {
    const value = await fixture();
    let nextOperationDigest: string | undefined;
    const result = await commitPreparedCredentialFixtureGate(
      value.credentialRoot,
      value.handoffRoot,
      inputFor(value),
      async (query) => {
        await executionGate.transitionCredentialExecutionGate(
          value.credentialRoot,
          {
            binding: value.binding,
            generation: 1,
            kind: "ABORT_PREPARING",
            observedAt: 2_001,
            quiescenceReceiptHash: "a".repeat(64),
          },
        );
        await executionGate.transitionCredentialExecutionGate(
          value.credentialRoot,
          {
            binding: value.binding,
            cleanupEvidenceHash: "b".repeat(64),
            generation: 1,
            kind: "FINISH_CLEANUP",
            observedAt: 2_002,
          },
        );
        vi.mocked(Date.now).mockReturnValue(2_003);
        const next = await prepareCredentialInputAttempt(
          value.credentialRoot,
          value.handoffRoot,
          {
            hookDefinitionHash: "6".repeat(64),
            host,
            intent: {
              schemaVersion: 1,
              credentialUseId: registryEntry.credentialUseId,
            },
            lease: value.lease,
            registry: [registryEntry],
            trustRootHash: "8".repeat(64),
          },
        );
        expect(next).toMatchObject({
          gate: "PREPARING",
          generation: 2,
          kind: "PREPARED_FIXTURE_NON_AUTHORIZING",
        });
        if (next.kind !== "PREPARED_FIXTURE_NON_AUTHORIZING") {
          throw new Error("next fixture preparation failed");
        }
        nextOperationDigest = deterministicDigest(
          "oxrail-credential-execution-gate-v1",
          next.binding,
        );
        await expect(
          credentialToolFencePre(value.credentialRoot, {
            sessionId: "next-generation-session",
            toolUseId: "next-generation-call",
          }),
        ).resolves.toBe("BLOCKED");
        return wireReceiptFor(query);
      },
    );

    expect(result.kind).toBe("FAILED_SAFE");
    expect(nextOperationDigest).toMatch(/^[a-f0-9]{64}$/);
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({
      generation: 2,
      operationDigest: nextOperationDigest,
      state: "PREPARING",
    });
  });

  it("fails closed on both sides of the final commit deadline", async () => {
    const beforeCommit = await fixture();
    vi.mocked(performance.now)
      .mockReset()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValue(1_101);
    await expect(
      commitPreparedCredentialFixtureGate(
        beforeCommit.credentialRoot,
        beforeCommit.handoffRoot,
        inputFor(beforeCommit),
        async (query) => wireReceiptFor(query),
      ),
    ).resolves.toMatchObject({ kind: "FAILED_SAFE" });
    await expect(
      readCredentialExecutionGate(beforeCommit.credentialRoot),
    ).resolves.toMatchObject({ state: "PREPARING" });

    const afterCommit = await fixture();
    vi.mocked(performance.now)
      .mockReset()
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValueOnce(100)
      .mockReturnValue(1_101);
    await expect(
      commitPreparedCredentialFixtureGate(
        afterCommit.credentialRoot,
        afterCommit.handoffRoot,
        inputFor(afterCommit),
        async (query) => wireReceiptFor(query),
      ),
    ).resolves.toMatchObject({ kind: "FAILED_SAFE" });
    await expect(
      readCredentialExecutionGate(afterCommit.credentialRoot),
    ).resolves.toMatchObject({ state: "ACTIVE" });
  });

  it("reclaims PREPARING without claiming external cleanup or Agent resume", async () => {
    const value = await fixture();
    const beforeHandoff = await allFiles(value.handoffRoot);
    const result = await cleanupCredentialFixtureGate(value.credentialRoot, {
      binding: value.binding,
      generation: 1,
    });

    expect(result).toEqual({
      activation: "INACTIVE",
      agentResume: "NOT_AUTHORIZED",
      authorization: "NOT_AUTHORIZED",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      credentialInputLease: "NOT_ESTABLISHED",
      credentialProtection: "INACTIVE",
      externalCleanup: "NOT_VERIFIED",
      gate: "OPEN",
      generation: 1,
      hostSuspension: "UNVERIFIED",
      kind: "FIXTURE_GATE_OPENED_NON_AUTHORIZING",
    });
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({
      generation: 1,
      outcome: "ABORTED",
      receiptDigest: null,
      state: "OPEN",
    });
    expect(await allFiles(value.handoffRoot)).toEqual(beforeHandoff);
  });

  it("reclaims ACTIVE idempotently while preserving its non-authorizing outcome", async () => {
    const value = await fixture();
    const input = inputFor(value);
    const committed = await commitPreparedCredentialFixtureGate(
      value.credentialRoot,
      value.handoffRoot,
      input,
      async (query) => wireReceiptFor(query),
    );
    expect(committed.kind).toBe("FIXTURE_GATE_COMMITTED_NON_AUTHORIZING");

    const cleanupInput = { binding: value.binding, generation: 1 };
    const opened = await cleanupCredentialFixtureGate(
      value.credentialRoot,
      cleanupInput,
    );
    const replay = await cleanupCredentialFixtureGate(
      value.credentialRoot,
      cleanupInput,
    );
    expect(opened).toMatchObject({
      agentResume: "NOT_AUTHORIZED",
      externalCleanup: "NOT_VERIFIED",
      gate: "OPEN",
      kind: "FIXTURE_GATE_OPENED_NON_AUTHORIZING",
    });
    expect(replay).toMatchObject({
      agentResume: "NOT_AUTHORIZED",
      externalCleanup: "NOT_VERIFIED",
      gate: "OPEN",
      kind: "FIXTURE_GATE_ALREADY_OPEN_NON_AUTHORIZING",
    });
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({
      generation: 1,
      outcome: "ACTIVATED",
      receiptDigest: null,
      state: "OPEN",
    });
  });

  it("confirms the exact OPEN tombstone after a post-commit cleanup error", async () => {
    const value = await fixture();
    const realCleanup = executionGate.cleanupCredentialExecutionGateLocked;
    const cleanup = vi
      .spyOn(executionGate, "cleanupCredentialExecutionGateLocked")
      .mockImplementationOnce(async (root, binding, generation) => {
        await realCleanup(root, binding, generation);
        throw new Error("post-open uncertainty");
      });

    await expect(
      cleanupCredentialFixtureGate(value.credentialRoot, {
        binding: value.binding,
        generation: 1,
      }),
    ).resolves.toMatchObject({
      agentResume: "NOT_AUTHORIZED",
      externalCleanup: "NOT_VERIFIED",
      gate: "OPEN",
      generation: 1,
      kind: "FIXTURE_GATE_OPENED_NON_AUTHORIZING",
    });
    expect(cleanup).toHaveBeenCalledTimes(1);
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({
      generation: 1,
      outcome: "ABORTED",
      state: "OPEN",
    });
  });

  it("rejects stale or caller-extended cleanup input without changing the gate", async () => {
    const value = await fixture();
    const before = await allFiles(value.credentialRoot);
    const changedBinding = {
      ...value.binding,
      trustRootHash: "0".repeat(64),
    };

    for (const input of [
      { binding: value.binding, generation: 2 },
      { binding: changedBinding, generation: 1 },
      { binding: value.binding, generation: 1, secret: canary },
    ]) {
      await expect(
        cleanupCredentialFixtureGate(value.credentialRoot, input as never),
      ).resolves.toMatchObject({
        agentResume: "NOT_AUTHORIZED",
        externalCleanup: "NOT_VERIFIED",
        kind: "FAILED_SAFE",
      });
    }
    expect(await allFiles(value.credentialRoot)).toEqual(before);
  });

  it("waits for a real Post before reopening a fixture generation", async () => {
    const value = await fixture();
    await executionGate.transitionCredentialExecutionGate(
      value.credentialRoot,
      {
        binding: value.binding,
        generation: 1,
        kind: "ABORT_PREPARING",
        observedAt: 2_001,
        quiescenceReceiptHash: "a".repeat(64),
      },
    );
    await executionGate.transitionCredentialExecutionGate(
      value.credentialRoot,
      {
        binding: value.binding,
        cleanupEvidenceHash: "b".repeat(64),
        generation: 1,
        kind: "FINISH_CLEANUP",
        observedAt: 2_002,
      },
    );
    const call = {
      sessionId: "cleanup-pending-session",
      toolUseId: "cleanup-pending-call",
    };
    await expect(
      credentialToolFencePre(value.credentialRoot, call),
    ).resolves.toBe("NO_LEDGER_BLOCK_TRACKED");
    await executionGate.transitionCredentialExecutionGate(
      value.credentialRoot,
      {
        binding: value.binding,
        generation: 2,
        kind: "PREPARE",
        observedAt: 2_003,
      },
    );

    await expect(
      cleanupCredentialFixtureGate(value.credentialRoot, {
        binding: value.binding,
        generation: 2,
      }),
    ).resolves.toMatchObject({
      agentResume: "NOT_AUTHORIZED",
      kind: "WAITING_FOR_NATIVE",
    });
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({ generation: 2, state: "PREPARING" });

    await expect(
      credentialToolFencePost(value.credentialRoot, call),
    ).resolves.toBe("COMPLETED");
    vi.mocked(Date.now).mockReturnValue(2_004);
    await expect(
      cleanupCredentialFixtureGate(value.credentialRoot, {
        binding: value.binding,
        generation: 2,
      }),
    ).resolves.toMatchObject({
      gate: "OPEN",
      kind: "FIXTURE_GATE_OPENED_NON_AUTHORIZING",
    });
  });

  it("does not let an old cleanup touch a newer preparation generation", async () => {
    const value = await fixture();
    await expect(
      cleanupCredentialFixtureGate(value.credentialRoot, {
        binding: value.binding,
        generation: 1,
      }),
    ).resolves.toMatchObject({ gate: "OPEN" });
    await executionGate.transitionCredentialExecutionGate(
      value.credentialRoot,
      {
        binding: value.binding,
        generation: 2,
        kind: "PREPARE",
        observedAt: 2_001,
      },
    );

    await expect(
      cleanupCredentialFixtureGate(value.credentialRoot, {
        binding: value.binding,
        generation: 1,
      }),
    ).resolves.toMatchObject({ kind: "FAILED_SAFE" });
    await expect(
      readCredentialExecutionGate(value.credentialRoot),
    ).resolves.toMatchObject({ generation: 2, state: "PREPARING" });
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
        await executionGate.transitionCredentialExecutionGate(
          value.credentialRoot,
          {
            binding: value.binding,
            generation: 1,
            kind: "ABORT_PREPARING",
            observedAt: 2_001,
            quiescenceReceiptHash: "a".repeat(64),
          },
        );
        await executionGate.transitionCredentialExecutionGate(
          value.credentialRoot,
          {
            binding: value.binding,
            cleanupEvidenceHash: "b".repeat(64),
            generation: 1,
            kind: "FINISH_CLEANUP",
            observedAt: 2_002,
          },
        );
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
