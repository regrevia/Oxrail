import {
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as core from "../packages/core/src/index.js";
import * as toolCallJournal from "../packages/core/src/tool-call.js";
import {
  activatePreparedHandoff,
  admitCredentialIntent,
  completeToolCallPost,
  createBrowserTaskState,
  credentialToolFencePost,
  credentialToolFencePre,
  handoffScopeBindingHash,
  initializeCredentialExecutionGate,
  prepareCredentialInputAttempt,
  prepareHandoffBarrier,
  prepareHandoffLease,
  readBrowserTaskState,
  readCredentialExecutionGate,
  readCredentialToolFenceQuiescence,
  recordToolCallPre,
  transitionHandoffLease,
  writeBrowserTaskState,
  type HandoffHostBinding,
  type HandoffLease,
} from "../packages/core/src/index.js";
import {
  CredentialProvisionIntentSchema,
  CredentialPublicResultSchema,
  deterministicDigest,
  type CredentialUseRegistryEntry,
} from "../packages/protocol/src/index.js";

const now = 2_000;
const origin = "https://credentials.example.test";
const canary = "oxrail_api_key_must_never_cross_admission";
const host: HandoffHostBinding = {
  profileBindingHash: "d".repeat(64),
  profileId: "fixture-profile",
};
const scope = {
  sessionId: "session-binding",
  taskId: "task-binding",
  tabId: 42,
  topOrigin: origin,
  documentBinding: "document-binding",
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
const temporaryDirectories: string[] = [];

interface ActiveFixture {
  root: string;
  lease: HandoffLease;
}

interface FixtureTimeline {
  activatedAt: number;
  barrierAt: number;
  createdAt: number;
  expiresAt: number;
  receiptAt: number;
  receiptExpiresAt: number;
}

const defaultTimeline: FixtureTimeline = {
  activatedAt: 1_200,
  barrierAt: 1_100,
  createdAt: 1_000,
  expiresAt: 10_000,
  receiptAt: 1_150,
  receiptExpiresAt: 9_000,
};

async function makeRoot(): Promise<string> {
  const parent = await mkdtemp(
    path.join(tmpdir(), "oxrail-credential-admission-"),
  );
  temporaryDirectories.push(parent);
  return path.join(parent, "state");
}

function pendingHandoff(timeline = defaultTimeline): HandoffLease {
  return prepareHandoffLease({
    handoffId: "credential-handoff",
    previousLeaseEpoch: 0,
    nonce: "0123456789abcdef0123456789abcdef",
    scope,
    createdAt: timeline.createdAt,
    expiresAt: timeline.expiresAt,
  });
}

function nakedActiveHandoff(): HandoffLease {
  const pending = pendingHandoff();
  const transition = transitionHandoffLease(
    pending,
    {
      kind: "ACTIVATE",
      handoffId: pending.handoffId,
      leaseEpoch: pending.leaseEpoch,
      nonce: pending.nonce,
      scope: pending.scope,
      observedAt: 1_200,
    },
    1_200,
  );
  if (!transition.accepted) throw new Error(transition.reason);
  return transition.lease;
}

async function activeFixture(
  browserInstanceBindingHash = "e".repeat(64),
  timeline = defaultTimeline,
): Promise<ActiveFixture> {
  const root = await makeRoot();
  const pending = pendingHandoff(timeline);
  await writeBrowserTaskState(
    root,
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
  await prepareHandoffBarrier(root, pending, host, () => timeline.barrierAt);
  const activated = await activatePreparedHandoff(
    root,
    pending,
    host,
    async () => ({
      admissionGeneration: 1,
      browserInstanceBindingHash,
      expiresAt: timeline.receiptExpiresAt,
      hostProfileBindingHash: host.profileBindingHash,
      nativeActionFenceHash: "f".repeat(64),
      observedAt: timeline.receiptAt,
      receiptHash: "9".repeat(64),
      scopeBindingHash: handoffScopeBindingHash(scope),
    }),
    () => timeline.activatedAt,
  );
  if (activated.kind !== "ACTIVE") {
    throw new Error("fixture activation failed");
  }
  return { root, lease: activated.lease };
}

async function allFileContents(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(filename);
      else {
        result[path.relative(root, filename)] = await readFile(
          filename,
          "utf8",
        );
      }
    }
  };
  await visit(root);
  return result;
}

async function findBarrier(root: string): Promise<string> {
  const files = Object.keys(await allFileContents(root));
  const relative = files.find((filename) =>
    /handoff-barriers\/.+\/lease-1\.json$/.test(filename),
  );
  if (!relative) throw new Error("fixture barrier missing");
  return path.join(root, relative);
}

async function findTaskState(root: string): Promise<string> {
  const files = Object.keys(await allFileContents(root));
  const relative = files.find((filename) =>
    filename.endsWith("browser-task-state.json"),
  );
  if (!relative) throw new Error("fixture task state missing");
  return path.join(root, relative);
}

async function expectInvalidHandoffWithoutMutation(
  fixture: ActiveFixture,
  options: {
    clock?: () => number;
    host?: HandoffHostBinding;
    lease?: HandoffLease;
  } = {},
): Promise<void> {
  const before = await allFileContents(fixture.root);
  await expect(
    admitCredentialIntent(
      fixture.root,
      { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
      [registryEntry],
      options.lease ?? fixture.lease,
      options.host ?? host,
      options.clock ?? (() => now),
    ),
  ).rejects.toMatchObject({ code: "INVALID_HANDOFF" });
  expect(await allFileContents(fixture.root)).toEqual(before);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("credential admission", () => {
  it("keeps an incoming Pre behind the combined preparation", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fixture = await activeFixture();
    const credentialRoot = await makeRoot();
    await initializeCredentialExecutionGate(credentialRoot, 1_500);
    let releaseCount!: () => void;
    let countStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      countStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseCount = resolve;
    });
    const countActiveToolCalls = toolCallJournal.countActiveToolCalls;
    vi.spyOn(toolCallJournal, "countActiveToolCalls").mockImplementation(
      async (...input) => {
        countStarted();
        await release;
        return countActiveToolCalls(...input);
      },
    );

    const preparation = prepareCredentialInputAttempt(
      credentialRoot,
      fixture.root,
      {
        hookDefinitionHash: "6".repeat(64),
        host,
        intent: {
          schemaVersion: 1,
          credentialUseId: registryEntry.credentialUseId,
        },
        lease: fixture.lease,
        registry: [registryEntry],
        trustRootHash: "8".repeat(64),
      },
    );
    await started;
    let preSettled = false;
    const pre = credentialToolFencePre(credentialRoot, {
      sessionId: "waiting-session",
      toolUseId: "waiting-call",
    }).finally(() => {
      preSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(preSettled).toBe(false);

    releaseCount();
    await expect(preparation).resolves.toMatchObject({
      gate: "PREPARING",
      kind: "PREPARED_FIXTURE_NON_AUTHORIZING",
    });
    await expect(pre).resolves.toBe("BLOCKED");
  });

  it("recovers a dead gate lock before deriving the next generation", async () => {
    const current = Date.now();
    const fixture = await activeFixture("e".repeat(64), {
      activatedAt: current - 800,
      barrierAt: current - 900,
      createdAt: current - 1_000,
      expiresAt: current + 10_000,
      receiptAt: current - 850,
      receiptExpiresAt: current + 9_000,
    });
    const credentialRoot = await makeRoot();
    await initializeCredentialExecutionGate(credentialRoot, current - 500);
    const lockPath = path.join(
      credentialRoot,
      "credential-execution-gate",
      ".current.lock",
    );
    const staleAt = current - 60_000;
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        createdAt: staleAt,
        nonce: "00000000-0000-4000-8000-000000000000",
      })}\n`,
      { mode: 0o600 },
    );
    await utimes(lockPath, new Date(staleAt), new Date(staleAt));

    await expect(
      prepareCredentialInputAttempt(credentialRoot, fixture.root, {
        hookDefinitionHash: "6".repeat(64),
        host,
        intent: {
          schemaVersion: 1,
          credentialUseId: registryEntry.credentialUseId,
        },
        lease: fixture.lease,
        registry: [registryEntry],
        trustRootHash: "8".repeat(64),
      }),
    ).resolves.toMatchObject({
      gate: "PREPARING",
      generation: 1,
      kind: "PREPARED_FIXTURE_NON_AUTHORIZING",
    });
  });

  it("linearizes fixture ticket minting and PREPARING against global Pre", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const inputFor = (fixture: ActiveFixture) => ({
      hookDefinitionHash: "6".repeat(64),
      host,
      intent: {
        schemaVersion: 1 as const,
        credentialUseId: registryEntry.credentialUseId,
      },
      lease: fixture.lease,
      registry: [registryEntry],
      trustRootHash: "8".repeat(64),
    });
    const call = {
      sessionId: "global-pre-session",
      toolUseId: "global-pre-call",
    };

    const preFirst = await activeFixture();
    const preFirstCredentialRoot = await makeRoot();
    await initializeCredentialExecutionGate(preFirstCredentialRoot, 1_500);
    await expect(
      credentialToolFencePre(preFirstCredentialRoot, call),
    ).resolves.toBe("NO_LEDGER_BLOCK_TRACKED");
    const preparedAfterPre = await prepareCredentialInputAttempt(
      preFirstCredentialRoot,
      preFirst.root,
      inputFor(preFirst),
    );
    expect(preparedAfterPre).toMatchObject({
      activation: "INACTIVE",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      credentialProtection: "INACTIVE",
      gate: "PREPARING",
      generation: 1,
      kind: "PREPARED_FIXTURE_NON_AUTHORIZING",
    });
    if (preparedAfterPre.kind !== "PREPARED_FIXTURE_NON_AUTHORIZING") {
      throw new Error("fixture preparation failed");
    }
    const serializedPreparation = JSON.stringify(preparedAfterPre);
    for (const forbidden of [
      preFirst.lease.handoffId,
      preFirst.lease.nonce,
      scope.sessionId,
      scope.taskId,
      scope.documentBinding,
      host.profileId,
      "e".repeat(64),
      "f".repeat(64),
      "9".repeat(64),
      canary,
    ]) {
      expect(serializedPreparation).not.toContain(forbidden);
    }
    await expect(
      readCredentialExecutionGate(preFirstCredentialRoot),
    ).resolves.toMatchObject({
      expiresAt: preFirst.lease.expiresAt,
      generation: preparedAfterPre.generation,
      operationDigest: deterministicDigest(
        "oxrail-credential-execution-gate-v1",
        preparedAfterPre.binding,
      ),
      state: "PREPARING",
    });
    await expect(
      readCredentialToolFenceQuiescence(preFirstCredentialRoot),
    ).resolves.toBe("PENDING");
    await expect(
      credentialToolFencePost(preFirstCredentialRoot, call),
    ).resolves.toBe("COMPLETED");
    await expect(
      readCredentialToolFenceQuiescence(preFirstCredentialRoot),
    ).resolves.toBe("QUIESCENT");

    const prepareFirst = await activeFixture();
    const prepareFirstCredentialRoot = await makeRoot();
    await initializeCredentialExecutionGate(prepareFirstCredentialRoot, 1_500);
    const preparedBeforePre = await prepareCredentialInputAttempt(
      prepareFirstCredentialRoot,
      prepareFirst.root,
      inputFor(prepareFirst),
    );
    expect(preparedBeforePre.kind).toBe("PREPARED_FIXTURE_NON_AUTHORIZING");
    await expect(
      credentialToolFencePre(prepareFirstCredentialRoot, call),
    ).resolves.toBe("BLOCKED");
    await expect(
      readCredentialToolFenceQuiescence(prepareFirstCredentialRoot),
    ).resolves.toBe("QUIESCENT");

    if (preparedBeforePre.kind !== "PREPARED_FIXTURE_NON_AUTHORIZING") {
      throw new Error("fixture preparation failed");
    }
    await expect(
      admitCredentialIntent(
        prepareFirst.root,
        inputFor(prepareFirst).intent,
        [registryEntry],
        prepareFirst.lease,
        host,
        () => now,
      ),
    ).resolves.toEqual(preparedBeforePre.binding.ticket);
  });

  it("leaves the durable gate OPEN on pre-commit rejection", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const fixture = await activeFixture();
    const credentialRoot = await makeRoot();
    await initializeCredentialExecutionGate(credentialRoot, 1_500);
    const input = {
      hookDefinitionHash: "6".repeat(64),
      host,
      intent: {
        schemaVersion: 1 as const,
        credentialUseId: registryEntry.credentialUseId,
      },
      lease: fixture.lease,
      registry: [registryEntry],
      trustRootHash: "8".repeat(64),
    };
    for (const invalid of [
      { ...input, unexpected: canary },
      { ...input, hookDefinitionHash: "A".repeat(64) },
      { ...input, host: { ...host, unexpected: true } },
      { ...input, lease: { ...fixture.lease, unexpected: true } },
    ]) {
      const rejected = await prepareCredentialInputAttempt(
        credentialRoot,
        fixture.root,
        invalid,
      );
      expect(rejected).toEqual({
        activation: "INACTIVE",
        authority: "FIXTURE_ONLY_NON_AUTHORIZING",
        credentialProtection: "INACTIVE",
        kind: "FAILED_SAFE",
      });
      expect(JSON.stringify(rejected)).not.toContain(canary);
      await expect(
        readCredentialExecutionGate(credentialRoot),
      ).resolves.toEqual(
        expect.objectContaining({ generation: 0, state: "OPEN" }),
      );
    }

    const state = await readBrowserTaskState(fixture.root, scope);
    if (!state) throw new Error("fixture state missing");
    await writeBrowserTaskState(
      fixture.root,
      {
        ...state,
        hostProfileStatus: "STALE",
        stateVersion: state.stateVersion + 1,
      },
      state.stateVersion,
    );
    const result = await prepareCredentialInputAttempt(
      credentialRoot,
      fixture.root,
      input,
    );
    expect(result).toEqual({
      activation: "INACTIVE",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      credentialProtection: "INACTIVE",
      kind: "FAILED_SAFE",
    });
    await expect(readCredentialExecutionGate(credentialRoot)).resolves.toEqual(
      expect.objectContaining({ generation: 0, state: "OPEN" }),
    );
  });

  it("mints only a v2 fixture ticket anchored to the locked active Handoff", async () => {
    const fixture = await activeFixture();
    const before = await allFileContents(fixture.root);
    const ticket = await admitCredentialIntent(
      fixture.root,
      { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
      [registryEntry],
      fixture.lease,
      host,
      () => now,
    );
    const goldenTicket = JSON.parse(
      await readFile(
        path.join(
          process.cwd(),
          "native/macos/Tests/OxrailCredentialEnclaveTests/Fixtures/credential-ticket-v2.json",
        ),
        "utf8",
      ),
    ) as unknown;
    expect(ticket).toEqual(goldenTicket);
    expect(
      deterministicDigest("oxrail-credential-prompt-context-v1", {
        observedAt: now,
        ticket,
      }),
    ).toBe("19535252dec48e898f58062f0846d2585d798463b15557654afee5ca8261827b");

    expect(ticket).toMatchObject({
      schemaVersion: 2,
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      credentialKind: "API_KEY",
      credentialUseId: registryEntry.credentialUseId,
      provisioningOrigin: origin,
      handoff: {
        leaseEpoch: fixture.lease.leaseEpoch,
        acquiredAt: fixture.lease.acquiredAt,
        expiresAt: fixture.lease.expiresAt,
      },
    });
    expect(Object.keys(ticket.handoff).sort()).toEqual([
      "acquiredAt",
      "activationAnchorHash",
      "expiresAt",
      "leaseEpoch",
    ]);
    expect(ticket.ticketId).toMatch(/^oct1_[a-f0-9]{64}$/);
    expect(ticket.handoff.activationAnchorHash).toMatch(/^[a-f0-9]{64}$/);
    expect([
      host.profileBindingHash,
      "e".repeat(64),
      "f".repeat(64),
      "9".repeat(64),
    ]).not.toContain(ticket.handoff.activationAnchorHash);
    const serializedTicket = JSON.stringify(ticket);
    for (const forbidden of [
      fixture.lease.handoffId,
      fixture.lease.nonce,
      scope.sessionId,
      scope.taskId,
      scope.documentBinding,
      host.profileBindingHash,
      "e".repeat(64),
      "f".repeat(64),
      "9".repeat(64),
      canary,
    ]) {
      expect(serializedTicket).not.toContain(forbidden);
    }
    expect(await allFileContents(fixture.root)).toEqual(before);

    const other = await activeFixture("8".repeat(64));
    const otherTicket = await admitCredentialIntent(
      other.root,
      { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
      [registryEntry],
      other.lease,
      host,
      () => now,
    );
    expect(otherTicket.handoff.activationAnchorHash).not.toBe(
      ticket.handoff.activationAnchorHash,
    );
    expect(otherTicket.ticketId).not.toBe(ticket.ticketId);
  });

  it("removes the naked lease binder and rejects an in-memory ACTIVE lease", async () => {
    expect(Object.hasOwn(core, "bindCredentialIntent")).toBe(false);
    expect(Object.hasOwn(core, "bindCredentialIntentToActivationAnchor")).toBe(
      false,
    );
    expect(Object.hasOwn(core, "prepareCredentialExecutionGateLocked")).toBe(
      false,
    );
    const root = await makeRoot();
    await expect(
      admitCredentialIntent(
        root,
        { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
        [registryEntry],
        nakedActiveHandoff(),
        host,
        () => now,
      ),
    ).rejects.toMatchObject({
      code: "INVALID_HANDOFF",
    });
  });

  it.each([
    ["nonce", (lease: HandoffLease) => ({ ...lease, nonce: "z".repeat(32) })],
    [
      "tab",
      (lease: HandoffLease) => ({
        ...lease,
        scope: { ...lease.scope, tabId: lease.scope.tabId + 1 },
      }),
    ],
    [
      "document",
      (lease: HandoffLease) => ({
        ...lease,
        scope: { ...lease.scope, documentBinding: "other-document" },
      }),
    ],
    [
      "lease epoch",
      (lease: HandoffLease) => ({
        ...lease,
        leaseEpoch: lease.leaseEpoch + 1,
      }),
    ],
  ])("rejects %s drift from the durable activation", async (_name, mutate) => {
    const fixture = await activeFixture();
    await expectInvalidHandoffWithoutMutation(fixture, {
      lease: mutate(fixture.lease),
    });
  });

  it("rejects stale state, wrong Host binding, and incomplete or corrupt barriers", async () => {
    const stale = await activeFixture();
    const state = await readBrowserTaskState(stale.root, scope);
    if (!state) throw new Error("fixture state missing");
    await writeBrowserTaskState(
      stale.root,
      {
        ...state,
        hostProfileStatus: "STALE",
        stateVersion: state.stateVersion + 1,
      },
      state.stateVersion,
    );
    await expectInvalidHandoffWithoutMutation(stale);

    const wrongHost = await activeFixture();
    await expectInvalidHandoffWithoutMutation(wrongHost, {
      host: { ...host, profileBindingHash: "7".repeat(64) },
    });

    for (const field of [
      "browserInstanceBindingHash",
      "nativeActionFenceHash",
      "tabBindingReceiptHash",
    ] as const) {
      const incomplete = await activeFixture();
      const filename = await findBarrier(incomplete.root);
      const barrierValue = JSON.parse(
        await readFile(filename, "utf8"),
      ) as Record<string, unknown>;
      await writeFile(
        filename,
        `${JSON.stringify({ ...barrierValue, [field]: null })}\n`,
      );
      await expectInvalidHandoffWithoutMutation(incomplete);
    }

    const corrupt = await activeFixture();
    const barrier = await findBarrier(corrupt.root);
    const value = JSON.parse(await readFile(barrier, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      barrier,
      `${JSON.stringify({ ...value, unexpected: true })}\n`,
    );
    await expectInvalidHandoffWithoutMutation(corrupt);
  });

  it("rejects non-active gates, invalid active state, and non-empty or unknown journals", async () => {
    const nonActive = await activeFixture();
    const nonActiveBarrier = await findBarrier(nonActive.root);
    const barrierValue = JSON.parse(
      await readFile(nonActiveBarrier, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      nonActiveBarrier,
      `${JSON.stringify({
        ...barrierValue,
        browserInstanceBindingHash: null,
        nativeActionFenceHash: null,
        state: "PREPARING",
        tabBindingReceiptHash: null,
      })}\n`,
    );
    await expectInvalidHandoffWithoutMutation(nonActive);

    const marked = await activeFixture();
    const markedState = await readBrowserTaskState(marked.root, scope);
    if (!markedState) throw new Error("fixture state missing");
    await writeBrowserTaskState(
      marked.root,
      {
        ...markedState,
        handoffVerificationMarker: {
          schemaVersion: 1,
          authority: "FIXTURE_ONLY_NON_AUTHORIZING",
          leaseEpoch: markedState.leaseEpoch,
          candidateDigest: "1".repeat(64),
          activationAnchorDigest: "2".repeat(64),
          currentTabReceiptDigest: "3".repeat(64),
          verifierContextBindingHash: "4".repeat(64),
          stateEpoch: 1,
          firstProbeSequence: 1,
          secondProbeSequence: 2,
          basis: "DETERMINISTIC",
          phaseSignal: "CHALLENGE_GONE",
        },
        stateVersion: markedState.stateVersion + 1,
      },
      markedState.stateVersion,
    );
    await expectInvalidHandoffWithoutMutation(marked);

    const invalidState = await activeFixture();
    const stateFilename = await findTaskState(invalidState.root);
    const stateValue = JSON.parse(
      await readFile(stateFilename, "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      stateFilename,
      `${JSON.stringify({
        ...stateValue,
        pendingNativeActionIds: ["invalid-human-owned-pending-action"],
      })}\n`,
    );
    await expectInvalidHandoffWithoutMutation(invalidState);

    const journal = await activeFixture();
    const call = {
      sessionId: scope.sessionId,
      taskId: scope.taskId,
      toolUseId: "credential-admission-concurrent-call",
      bindingDigest: "5".repeat(64),
      requestDigest: "6".repeat(64),
      decision: {
        disposition: "PASS_THROUGH_ORIGINAL" as const,
        reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH" as const,
        recoverable: true,
      },
    };
    await expect(recordToolCallPre(journal.root, call)).resolves.toMatchObject({
      journalStatus: "PENDING",
      kind: "RECORDED",
    });
    await expectInvalidHandoffWithoutMutation(journal);
    await expect(completeToolCallPost(journal.root, call)).resolves.toBe(
      "COMPLETED",
    );
    await expectInvalidHandoffWithoutMutation(journal);

    const unknownJournal = await activeFixture();
    await recordToolCallPre(unknownJournal.root, call);
    const activeMarker = Object.keys(
      await allFileContents(unknownJournal.root),
    ).find(
      (filename) =>
        filename.includes("tool-calls/active/") && filename.endsWith(".json"),
    );
    if (!activeMarker) throw new Error("fixture active marker missing");
    await writeFile(path.join(unknownJournal.root, activeMarker), "{}\n");
    await expectInvalidHandoffWithoutMutation(unknownJournal);
  });

  it("snapshots caller-owned inputs before asynchronous admission", async () => {
    const fixture = await activeFixture();
    const mutableLease = structuredClone(fixture.lease);
    const mutableHost = structuredClone(host);
    const mutableRegistry = [structuredClone(registryEntry)];
    const mutableIntent = {
      schemaVersion: 1,
      credentialUseId: registryEntry.credentialUseId,
    };
    const ticket = await admitCredentialIntent(
      fixture.root,
      mutableIntent,
      mutableRegistry,
      mutableLease,
      mutableHost,
      () => {
        mutableIntent.credentialUseId = "changed.use";
        mutableRegistry[0]!.consumerId = "changed.consumer";
        mutableLease.expiresAt = 20_000;
        mutableHost.profileBindingHash = "7".repeat(64);
        return now;
      },
    );

    expect(ticket).toMatchObject({
      credentialUseId: registryEntry.credentialUseId,
      consumerId: registryEntry.consumerId,
      handoff: { expiresAt: fixture.lease.expiresAt },
    });
  });

  it("rejects Agent-defined fields and invalid registry or timing without echoing values", async () => {
    const fixture = await activeFixture();
    for (const field of [
      "label",
      "instruction",
      "style",
      "consumerId",
      "apiKey",
    ] as const) {
      const value = {
        schemaVersion: 1,
        credentialUseId: registryEntry.credentialUseId,
        [field]: canary,
      };
      const parsed = CredentialProvisionIntentSchema.safeParse(value);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(canary);
      await expect(
        admitCredentialIntent(
          fixture.root,
          value,
          [registryEntry],
          fixture.lease,
          host,
          () => now,
        ),
      ).rejects.toMatchObject({ code: "INVALID_INTENT" });
    }

    await expect(
      admitCredentialIntent(
        fixture.root,
        { schemaVersion: 1, credentialUseId: "unknown.use" },
        [registryEntry],
        fixture.lease,
        host,
        () => now,
      ),
    ).rejects.toMatchObject({ code: "UNKNOWN_CREDENTIAL_USE" });
    await expect(
      admitCredentialIntent(
        fixture.root,
        { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
        [registryEntry, registryEntry],
        fixture.lease,
        host,
        () => now,
      ),
    ).rejects.toMatchObject({ code: "AMBIGUOUS_CREDENTIAL_USE" });
    await expect(
      admitCredentialIntent(
        fixture.root,
        { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
        [
          {
            ...registryEntry,
            provisioningOrigin: "https://other.example.test",
          },
        ],
        fixture.lease,
        host,
        () => now,
      ),
    ).rejects.toMatchObject({ code: "ORIGIN_MISMATCH" });
    await expect(
      admitCredentialIntent(
        fixture.root,
        { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
        [registryEntry],
        fixture.lease,
        host,
        () => 10_001,
      ),
    ).rejects.toMatchObject({ code: "HANDOFF_EXPIRED" });
  });

  it("keeps the model-visible result limited to opaque refs and fixed codes", () => {
    const credentialRef = `ocref1_${"A".repeat(43)}`;
    for (const result of [
      { schemaVersion: 1, status: "READY", credentialRef },
      { schemaVersion: 1, status: "STORED", credentialRef },
      { schemaVersion: 1, status: "CANCELLED" },
      { schemaVersion: 1, status: "ERROR", errorCode: "SCOPE_MISMATCH" },
    ]) {
      expect(CredentialPublicResultSchema.safeParse(result).success).toBe(true);
    }
    for (const result of [
      { schemaVersion: 1, status: "READY", credentialRef, value: canary },
      { schemaVersion: 1, status: "READY", credentialRef: canary },
      { schemaVersion: 1, status: "ERROR", errorCode: "RAW", error: canary },
      {
        schemaVersion: 1,
        status: "STORED",
        credentialRef,
        keychainPersistentRef: canary,
      },
    ]) {
      const parsed = CredentialPublicResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(canary);
    }
  });
});
