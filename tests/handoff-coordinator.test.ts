import { lstat, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  abandonPreparedHandoff,
  activatePreparedHandoff,
  compareHandoffGates,
  prepareHandoffBarrier,
  readHandoffGate,
  recoverExpiredHandoffPreparation,
  type HandoffTabBindingAttestation,
} from "../packages/core/src/handoff-coordinator.js";
import {
  prepareHandoffLease,
  type HandoffLease,
} from "../packages/core/src/handoff.js";
import {
  activateUserLease,
  createBrowserTaskState,
} from "../packages/core/src/state.js";
import {
  readBrowserTaskState,
  writeBrowserTaskState,
} from "../packages/core/src/store.js";
import {
  completeToolCallPost,
  inspectToolCallJournal,
  recordToolCallPre,
} from "../packages/core/src/tool-call.js";
import type {
  BrowserTaskState,
  PolicyDecision,
} from "../packages/protocol/src/index.js";

const CREATED_AT = 1_000;
const NOW = 2_000;
const HOST_PROFILE = "profile-content-canary";
const SCOPE = {
  documentBinding: "document-content-canary",
  sessionId: "session-content-canary",
  tabId: 42,
  taskId: "task-content-canary",
  topOrigin: "https://handoff-content-canary.test",
};
const allow: PolicyDecision = {
  disposition: "PASS_THROUGH_ORIGINAL",
  reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
  recoverable: true,
};
const attestation: HandoffTabBindingAttestation = {
  admissionGeneration: 1,
  browserInstanceBindingHash: "a".repeat(64),
  expiresAt: 9_000,
  nativeActionFenceHash: "e".repeat(64),
  observedAt: 1_900,
  receiptHash: "b".repeat(64),
};

const makeRoot = async () =>
  path.join(await mkdtemp(path.join(tmpdir(), "oxrail-handoff-")), "state");

const makeLease = (
  handoffId = "handoff-content-canary",
  previousLeaseEpoch = 0,
): HandoffLease =>
  prepareHandoffLease({
    createdAt: CREATED_AT,
    expiresAt: 10_000,
    handoffId,
    nonce: `${handoffId.replace(/[^A-Za-z0-9_-]/g, "_")}${"n".repeat(40)}`,
    previousLeaseEpoch,
    scope: SCOPE,
  });

const makeState = (
  pendingNativeActionIds: string[] = [],
): BrowserTaskState => ({
  ...createBrowserTaskState({
    hostProfileId: HOST_PROFILE,
    mode: "MICRO_ACTION_GUARD",
    sessionId: SCOPE.sessionId,
    taskId: SCOPE.taskId,
  }),
  currentOrigin: SCOPE.topOrigin,
  documentBinding: SCOPE.documentBinding,
  pendingNativeActionIds,
});

async function prepareFixture(
  root: string,
  lease: HandoffLease,
  pendingNativeActionIds: string[] = [],
): Promise<BrowserTaskState> {
  const state = makeState(pendingNativeActionIds);
  await writeBrowserTaskState(root, state, null);
  await prepareHandoffBarrier(root, lease, HOST_PROFILE);
  return state;
}

const verifyTab = async () => attestation;

const toolInput = (toolUseId: string) => ({
  bindingDigest: "c".repeat(64),
  decision: allow,
  requestDigest: "d".repeat(64),
  sessionId: SCOPE.sessionId,
  taskId: SCOPE.taskId,
  toolUseId,
});

async function findToolMarker(root: string): Promise<string> {
  const visit = async (directory: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await visit(filename);
        if (found) return found;
      } else if (entry.name.endsWith(".json")) {
        try {
          const value = JSON.parse(await readFile(filename, "utf8")) as {
            schemaVersion?: number;
            toolDigest?: string;
          };
          if (value.schemaVersion === 2 && value.toolDigest) return filename;
        } catch {
          // Other private state files are not tool-call markers.
        }
      }
    }
  };
  const marker = await visit(root);
  if (!marker) throw new Error("tool-call marker not found");
  return marker;
}

async function findHandoffBarrier(root: string, leaseEpoch: number) {
  const expected = `lease-${leaseEpoch}.json`;
  const visit = async (directory: string): Promise<string | undefined> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        const found = await visit(filename);
        if (found) return found;
      } else if (entry.name === expected) {
        return filename;
      }
    }
  };
  const barrier = await visit(root);
  if (!barrier) throw new Error("handoff barrier not found");
  return barrier;
}

describe("handoff coordinator", () => {
  it("rejects a stale OPEN snapshot after a terminal generation ABA", () => {
    expect(
      compareHandoffGates(
        { generation: 7, kind: "KNOWN", status: "OPEN" },
        { generation: 8, kind: "KNOWN", status: "OPEN" },
      ),
    ).toBe("CHANGED");
  });

  it("durably prepares a private content-free admission barrier", async () => {
    const root = await makeRoot();
    const lease = makeLease();

    await expect(
      prepareHandoffBarrier(root, lease, HOST_PROFILE),
    ).resolves.toBe("PREPARED");
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 1,
      kind: "KNOWN",
      status: "PREPARING",
    });

    const persisted: string[] = [];
    const inspect = async (directory: string): Promise<void> => {
      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        persisted.push(path.relative(root, filename));
        if (entry.isDirectory()) await inspect(filename);
        else {
          expect((await lstat(filename)).mode & 0o777).toBe(0o600);
          persisted.push(await readFile(filename, "utf8"));
        }
      }
    };
    await inspect(root);
    const snapshot = persisted.join("\n");
    for (const rawValue of [
      lease.handoffId,
      lease.nonce,
      HOST_PROFILE,
      SCOPE.sessionId,
      SCOPE.taskId,
      SCOPE.documentBinding,
      SCOPE.topOrigin,
    ]) {
      expect(snapshot).not.toContain(rawValue);
    }
    expect(snapshot).toContain('"state":"PREPARING"');
  });

  it("replays the same handoff and keeps the first handoff for an epoch", async () => {
    const root = await makeRoot();
    const first = makeLease("handoff-first-content-canary");
    const second = makeLease("handoff-second-content-canary");

    await expect(
      prepareHandoffBarrier(root, first, HOST_PROFILE),
    ).resolves.toBe("PREPARED");
    await expect(
      prepareHandoffBarrier(root, first, HOST_PROFILE),
    ).resolves.toBe("REPLAY");
    await expect(
      prepareHandoffBarrier(root, second, HOST_PROFILE),
    ).rejects.toThrow("another handoff owns this lease epoch");
  });

  it("admits only the next generation on a fresh root", async () => {
    const root = await makeRoot();
    const future = makeLease("future-handoff", 7);

    await expect(
      prepareHandoffBarrier(root, future, HOST_PROFILE),
    ).rejects.toThrow("handoff admission gate is not open");
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 0,
      kind: "KNOWN",
      status: "OPEN",
    });
  });

  it("cannot concurrently prepare different generations", async () => {
    const root = await makeRoot();
    const first = makeLease("concurrent-generation-one");
    const second = makeLease("concurrent-generation-two", 1);

    const [firstResult, secondResult] = await Promise.allSettled([
      prepareHandoffBarrier(root, first, HOST_PROFILE),
      prepareHandoffBarrier(root, second, HOST_PROFILE),
    ]);
    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult.status).toBe("rejected");
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 1,
      kind: "KNOWN",
      status: "PREPARING",
    });
  });

  it("activates only after a valid Host tab-binding attestation", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    await prepareFixture(root, lease);

    await expect(
      activatePreparedHandoff(root, lease, NOW, async () => undefined),
    ).resolves.toEqual({ kind: "FAILED_SAFE" });
    await expect(
      activatePreparedHandoff(root, lease, NOW, async () => ({
        ...attestation,
        admissionGeneration: 2,
      })),
    ).resolves.toEqual({ kind: "FAILED_SAFE" });
    await expect(readHandoffGate(root, SCOPE)).resolves.toMatchObject({
      generation: 1,
      status: "PREPARING",
    });

    await expect(
      activatePreparedHandoff(root, lease, NOW, verifyTab),
    ).resolves.toMatchObject({
      kind: "ACTIVE",
      lease: { holder: "USER", leaseEpoch: 1, state: "ACTIVE" },
    });
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 1,
      kind: "KNOWN",
      status: "ACTIVE",
    });
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toMatchObject({
      leaseEpoch: 1,
      pendingNativeActionIds: [],
      phase: "USER_LEASE_ACTIVE",
      pointerOwner: "HUMAN",
    });
  });

  it("waits while the exact native tool call remains pending", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    const toolUseId = "pending-native-call";
    await prepareFixture(root, lease, [toolUseId]);
    await recordToolCallPre(root, toolInput(toolUseId));

    await expect(
      activatePreparedHandoff(root, lease, NOW, verifyTab),
    ).resolves.toEqual({ kind: "WAITING_FOR_NATIVE" });
    await expect(readHandoffGate(root, SCOPE)).resolves.toMatchObject({
      status: "PREPARING",
    });
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toMatchObject({
      phase: "RUNNING",
      pointerOwner: "NATIVE",
      pendingNativeActionIds: [expect.stringMatching(/^oxrail-id:/)],
    });
  });

  it("mints the tab receipt only after older native actions drain", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    const toolUseId = "navigation-before-handoff";
    let verifications = 0;
    await prepareFixture(root, lease, [toolUseId]);
    await recordToolCallPre(root, toolInput(toolUseId));

    await expect(
      activatePreparedHandoff(root, lease, NOW, async () => {
        verifications += 1;
        return attestation;
      }),
    ).resolves.toEqual({ kind: "WAITING_FOR_NATIVE" });
    expect(verifications).toBe(0);

    await expect(
      completeToolCallPost(root, {
        sessionId: SCOPE.sessionId,
        taskId: SCOPE.taskId,
        toolUseId,
      }),
    ).resolves.toBe("COMPLETED");
    await expect(
      activatePreparedHandoff(root, lease, NOW, async () => {
        verifications += 1;
        return attestation;
      }),
    ).resolves.toMatchObject({ kind: "ACTIVE" });
    expect(verifications).toBe(1);
  });

  it("reconciles a receipt-first Post crash with the exact pending state id", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    const toolUseId = "receipt-first-native-call";
    await prepareFixture(root, lease, [toolUseId]);
    await recordToolCallPre(root, toolInput(toolUseId));
    const markerPath = await findToolMarker(root);
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
      string,
      unknown
    >;
    expect(marker).toMatchObject({ schemaVersion: 2, status: "PENDING" });
    await writeFile(
      markerPath.replace(/\.json$/, ".post"),
      `${JSON.stringify({ ...marker, status: "COMPLETE" })}\n`,
      { mode: 0o600 },
    );
    await expect(inspectToolCallJournal(root, SCOPE)).resolves.toMatchObject({
      completedToolUseIds: [expect.stringMatching(/^oxrail-id:/)],
      kind: "KNOWN",
      pendingToolUseIds: [],
    });

    await expect(
      activatePreparedHandoff(root, lease, NOW, verifyTab),
    ).resolves.toMatchObject({ kind: "ACTIVE" });
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toMatchObject({
      leaseEpoch: 1,
      pendingNativeActionIds: [],
      phase: "USER_LEASE_ACTIVE",
      pointerOwner: "HUMAN",
    });
  });

  it("fails safely for state-only pending ids and unknown journals", async () => {
    const stateOnlyRoot = await makeRoot();
    const stateOnlyLease = makeLease();
    await prepareFixture(stateOnlyRoot, stateOnlyLease, ["state-only-call"]);
    await expect(
      activatePreparedHandoff(stateOnlyRoot, stateOnlyLease, NOW, verifyTab),
    ).resolves.toEqual({ kind: "FAILED_SAFE" });
    await expect(
      readBrowserTaskState(stateOnlyRoot, SCOPE),
    ).resolves.toMatchObject({ phase: "RUNNING", pointerOwner: "NATIVE" });

    const unknownRoot = await makeRoot();
    const unknownLease = makeLease();
    await prepareFixture(unknownRoot, unknownLease);
    await recordToolCallPre(unknownRoot, toolInput("corrupt-journal-call"));
    await writeFile(await findToolMarker(unknownRoot), "not-json\n", {
      mode: 0o600,
    });
    await expect(
      activatePreparedHandoff(unknownRoot, unknownLease, NOW, verifyTab),
    ).resolves.toEqual({ kind: "FAILED_SAFE" });
    await expect(readHandoffGate(unknownRoot, SCOPE)).resolves.toMatchObject({
      status: "PREPARING",
    });
  });

  it("refuses activation when the aggregate admission gate is unknown", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    await prepareFixture(root, lease);
    const barrier = await findHandoffBarrier(root, 1);
    await writeFile(path.join(path.dirname(barrier), "lease-2.json"), "{}\n", {
      mode: 0o600,
    });

    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      kind: "UNKNOWN",
    });
    await expect(
      activatePreparedHandoff(root, lease, NOW, verifyTab),
    ).resolves.toEqual({ kind: "FAILED_SAFE" });
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toMatchObject({
      phase: "RUNNING",
      pointerOwner: "NATIVE",
    });
  });

  it("promotes PREPARING after a crash committed the active task state", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    const prepared = await prepareFixture(root, lease);
    const active = activateUserLease(
      prepared,
      lease.handoffId,
      prepared.stateVersion,
    );
    await writeBrowserTaskState(root, active, prepared.stateVersion);

    await expect(readHandoffGate(root, SCOPE)).resolves.toMatchObject({
      status: "PREPARING",
    });
    await expect(
      activatePreparedHandoff(root, lease, NOW, verifyTab),
    ).resolves.toMatchObject({ kind: "ACTIVE" });
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 1,
      kind: "KNOWN",
      status: "ACTIVE",
    });
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toMatchObject({
      stateVersion: active.stateVersion,
    });
  });

  it("idempotently confirms the same active handoff receipt", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    let verifications = 0;
    await prepareFixture(root, lease);

    await expect(
      activatePreparedHandoff(root, lease, NOW, async () => {
        verifications += 1;
        return attestation;
      }),
    ).resolves.toMatchObject({ kind: "ACTIVE" });
    const active = await readBrowserTaskState(root, SCOPE);
    await expect(
      activatePreparedHandoff(root, lease, NOW, async () => {
        verifications += 1;
        return { ...attestation, receiptHash: "f".repeat(64) };
      }),
    ).resolves.toMatchObject({ kind: "ACTIVE" });
    expect(verifications).toBe(1);
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toEqual(active);
  });

  it("serializes concurrent activations before publishing ACTIVE", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    let verifications = 0;
    await prepareFixture(root, lease);

    const results = await Promise.all([
      activatePreparedHandoff(root, lease, NOW, async () => {
        verifications += 1;
        return attestation;
      }),
      activatePreparedHandoff(root, lease, NOW, async () => {
        verifications += 1;
        return { ...attestation, receiptHash: "f".repeat(64) };
      }),
    ]);

    expect(results).toEqual([
      expect.objectContaining({ kind: "ACTIVE" }),
      expect.objectContaining({ kind: "ACTIVE" }),
    ]);
    expect(verifications).toBe(1);
    await expect(readHandoffGate(root, SCOPE)).resolves.toMatchObject({
      status: "ACTIVE",
    });
  });

  it("recovers an expired Native-owned preparation without the raw lease", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    await prepareFixture(root, lease);

    await expect(
      recoverExpiredHandoffPreparation(root, SCOPE, 10_001),
    ).resolves.toBe("CANCELLED");
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 1,
      kind: "KNOWN",
      status: "OPEN",
    });
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toMatchObject({
      leaseEpoch: 1,
      phase: "RUNNING",
      pointerOwner: "NATIVE",
    });
    await expect(
      recoverExpiredHandoffPreparation(root, SCOPE, 10_001),
    ).resolves.toBe("NOT_PREPARING");
  });

  it("keeps a half-committed user lease closed for explicit recovery", async () => {
    const root = await makeRoot();
    const lease = makeLease();
    const prepared = await prepareFixture(root, lease);
    await writeBrowserTaskState(
      root,
      activateUserLease(prepared, lease.handoffId, prepared.stateVersion),
      prepared.stateVersion,
    );

    await expect(
      recoverExpiredHandoffPreparation(root, SCOPE, 10_001),
    ).resolves.toBe("USER_LEASE_RECOVERY_REQUIRED");
    await expect(readHandoffGate(root, SCOPE)).resolves.toMatchObject({
      status: "PREPARING",
    });
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toMatchObject({
      phase: "USER_LEASE_ACTIVE",
      pointerOwner: "HUMAN",
    });
  });

  it("cancels to an open terminal generation and never reuses its ABA value", async () => {
    const root = await makeRoot();
    const first = makeLease("handoff-generation-one");
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 0,
      kind: "KNOWN",
      status: "OPEN",
    });
    await prepareFixture(root, first);

    await expect(abandonPreparedHandoff(root, first, NOW)).resolves.toBe(true);
    await expect(abandonPreparedHandoff(root, first, NOW)).resolves.toBe(true);
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 1,
      kind: "KNOWN",
      status: "OPEN",
    });
    await expect(readBrowserTaskState(root, SCOPE)).resolves.toMatchObject({
      leaseEpoch: 1,
      phase: "RUNNING",
      pointerOwner: "NATIVE",
    });

    const second = makeLease("handoff-generation-two", 1);
    await expect(
      prepareHandoffBarrier(root, second, HOST_PROFILE),
    ).resolves.toBe("PREPARED");
    await expect(readHandoffGate(root, SCOPE)).resolves.toEqual({
      generation: 2,
      kind: "KNOWN",
      status: "PREPARING",
    });
  });
});
