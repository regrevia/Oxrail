import { execFileSync } from "node:child_process";
import {
  chmod,
  link,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  credentialToolFencePre,
  readCredentialToolFenceQuiescence,
} from "../packages/core/src/credential-tool-fence.js";
import { withCredentialToolFenceLock } from "../packages/core/src/credential-tool-fence-lock.js";
import * as toolCallJournal from "../packages/core/src/tool-call.js";

import {
  CredentialExecutionGateError,
  compareCredentialExecutionGates,
  credentialExecutionGateBlockStatus,
  initializeCredentialExecutionGate,
  readCredentialExecutionGate,
  transitionCredentialExecutionGate,
  type CredentialExecutionGateEvent,
  type FixtureCredentialExecutionBinding,
} from "../packages/core/src/credential-execution-gate.js";
import type { CredentialEnclaveTicket } from "../packages/protocol/src/index.js";

const canary = "oxrail_api_key_canary_must_not_persist";
const hash = (character: string) => character.repeat(64);
const ticket: CredentialEnclaveTicket = {
  schemaVersion: 2,
  authority: "FIXTURE_ONLY_NON_AUTHORIZING",
  ticketId: `oct1_${hash("1")}`,
  credentialUseId: "fixture.publish.api-key",
  credentialKind: "API_KEY",
  templateId: "fixture.api-key.v1",
  serviceId: "fixture-service",
  provisioningOrigin: "https://credentials.example.test",
  purposeId: "publish-post",
  consumerId: "fixture.https.publisher",
  grantTtlSeconds: 3_600,
  generation: 7,
  registryVersion: 3,
  templateRegistryHash: hash("2"),
  consumerRegistryHash: hash("3"),
  registryManifestHash: hash("4"),
  issuedAt: 10,
  handoff: {
    activationAnchorHash: hash("5"),
    leaseEpoch: 1,
    acquiredAt: 5,
    expiresAt: 100,
  },
};
const binding: FixtureCredentialExecutionBinding = {
  hookDefinitionHash: hash("6"),
  hostProfileHash: hash("7"),
  ticket,
  trustRootHash: hash("8"),
};

const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "oxrail-credential-gate-"));
  temporaryDirectories.push(parent);
  return path.join(parent, "state");
}

const gateDirectory = (root: string) =>
  path.join(root, "credential-execution-gate");
const currentPath = (root: string) =>
  path.join(gateDirectory(root), "current.json");
const sentinelPath = (root: string) =>
  path.join(gateDirectory(root), ".initialized-v1");

type QuiescenceEvent = Extract<
  CredentialExecutionGateEvent,
  { quiescenceReceiptHash: string }
>;
type CleanupEvent = Extract<
  CredentialExecutionGateEvent,
  { cleanupEvidenceHash: string }
>;

function event(
  kind: "PREPARE",
  generation: number,
  observedAt: number,
  eventBinding?: FixtureCredentialExecutionBinding,
): Extract<CredentialExecutionGateEvent, { kind: "PREPARE" }>;
function event(
  kind: QuiescenceEvent["kind"],
  generation: number,
  observedAt: number,
  eventBinding?: FixtureCredentialExecutionBinding,
): QuiescenceEvent;
function event(
  kind: CleanupEvent["kind"],
  generation: number,
  observedAt: number,
  eventBinding?: FixtureCredentialExecutionBinding,
): CleanupEvent;
function event(
  kind: CredentialExecutionGateEvent["kind"],
  generation: number,
  observedAt: number,
  eventBinding = binding,
): CredentialExecutionGateEvent {
  if (kind === "PREPARE") {
    return { binding: eventBinding, generation, kind, observedAt };
  }
  if (kind === "FINISH_CLEANUP") {
    return {
      binding: eventBinding,
      cleanupEvidenceHash: hash("d"),
      generation,
      kind,
      observedAt,
    };
  }
  return {
    binding: eventBinding,
    generation,
    kind,
    observedAt,
    quiescenceReceiptHash: hash("b"),
  };
}

async function initializedRoot(): Promise<string> {
  const root = await makeRoot();
  await initializeCredentialExecutionGate(root, 10);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("credential execution gate", () => {
  it("initializes a private persistent OPEN tombstone and replays safely", async () => {
    const root = await makeRoot();

    await expect(readCredentialExecutionGate(root)).resolves.toEqual({
      kind: "UNINITIALIZED",
    });
    await expect(initializeCredentialExecutionGate(root, 10)).resolves.toBe(
      "INITIALIZED",
    );
    await expect(initializeCredentialExecutionGate(root, 99)).resolves.toBe(
      "REPLAY",
    );

    const snapshot = await readCredentialExecutionGate(root);
    expect(snapshot).toEqual({
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      createdAt: 10,
      effect: "BLOCK_AGENT_EXECUTION_ONLY",
      expiresAt: null,
      generation: 0,
      kind: "KNOWN",
      operationDigest: null,
      outcome: "NONE",
      receiptDigest: null,
      schemaVersion: 1,
      state: "OPEN",
      updatedAt: 10,
    });
    expect(credentialExecutionGateBlockStatus(snapshot)).toBe(
      "NO_LEDGER_BLOCK",
    );
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(gateDirectory(root))).mode & 0o777).toBe(0o700);
    expect((await stat(currentPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(sentinelPath(root))).mode & 0o777).toBe(0o600);
    expect((await stat(currentPath(root))).size).toBeLessThanOrEqual(2 * 1024);
    if (snapshot.kind !== "KNOWN") throw new Error("expected known gate");
    expect(
      compareCredentialExecutionGates(snapshot, {
        ...snapshot,
        updatedAt: snapshot.updatedAt + 1,
      }),
    ).toBe("CHANGED");
  });

  it("allows only the strict monotonic lifecycle and exact event replays", async () => {
    const root = await initializedRoot();
    const steps: Array<{
      gateEvent: CredentialExecutionGateEvent;
      state: "ACTIVE" | "CLEANUP_PENDING" | "OPEN" | "PREPARING";
    }> = [
      { gateEvent: event("PREPARE", 1, 20), state: "PREPARING" },
      { gateEvent: event("ACTIVATE", 1, 30), state: "ACTIVE" },
      {
        gateEvent: event("BEGIN_CLEANUP", 1, 40),
        state: "CLEANUP_PENDING",
      },
      { gateEvent: event("FINISH_CLEANUP", 1, 50), state: "OPEN" },
    ];

    for (const step of steps) {
      await expect(
        transitionCredentialExecutionGate(root, step.gateEvent),
      ).resolves.toBe("APPLIED");
      const snapshot = await readCredentialExecutionGate(root);
      expect(snapshot).toMatchObject({
        authority: "FIXTURE_ONLY_NON_AUTHORIZING",
        effect: "BLOCK_AGENT_EXECUTION_ONLY",
        generation: 1,
        kind: "KNOWN",
        state: step.state,
      });
      expect(credentialExecutionGateBlockStatus(snapshot)).toBe(
        step.state === "OPEN" ? "NO_LEDGER_BLOCK" : "BLOCK_AGENT_EXECUTION",
      );
      await expect(
        transitionCredentialExecutionGate(root, step.gateEvent),
      ).resolves.toBe("REPLAY");
    }

    const terminal = await readCredentialExecutionGate(root);
    expect(terminal).toMatchObject({
      createdAt: 20,
      expiresAt: 100,
      generation: 1,
      kind: "KNOWN",
      operationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      outcome: "ACTIVATED",
      receiptDigest: null,
      state: "OPEN",
      updatedAt: 50,
    });
    await expect(
      transitionCredentialExecutionGate(root, event("PREPARE", 2, 60)),
    ).resolves.toBe("APPLIED");
  });

  it("serializes PREPARE behind an in-flight global Pre registration", async () => {
    const root = await initializedRoot();
    let releaseRegistration!: () => void;
    let registrationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      registrationStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const recordToolCallPre = toolCallJournal.recordToolCallPre;
    vi.spyOn(toolCallJournal, "recordToolCallPre").mockImplementation(
      async (...input) => {
        registrationStarted();
        await release;
        return recordToolCallPre(...input);
      },
    );

    const pre = credentialToolFencePre(root, {
      sessionId: "concurrent-session",
      toolUseId: "concurrent-call",
    });
    await started;
    let prepareSettled = false;
    const prepare = transitionCredentialExecutionGate(
      root,
      event("PREPARE", 1, 20),
    ).finally(() => {
      prepareSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(prepareSettled).toBe(false);

    releaseRegistration();
    await expect(pre).resolves.toBe("NO_LEDGER_BLOCK_TRACKED");
    await expect(prepare).resolves.toBe("APPLIED");
    await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
      "PENDING",
    );
  });

  it("serializes an incoming Pre behind the transition mutex", async () => {
    const root = await initializedRoot();
    let releaseTransition!: () => void;
    let transitionLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      transitionLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    const transition = withCredentialToolFenceLock(root, async () => {
      transitionLocked();
      await release;
    });
    await locked;

    let preSettled = false;
    const pre = credentialToolFencePre(root, {
      sessionId: "transition-first-session",
      toolUseId: "transition-first-call",
    }).finally(() => {
      preSettled = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(preSettled).toBe(false);

    releaseTransition();
    await expect(transition).resolves.toBeUndefined();
    await expect(pre).resolves.toBe("NO_LEDGER_BLOCK_TRACKED");
  });

  it("never bypasses when a transition mutex outlives Pre retries", async () => {
    const root = await initializedRoot();
    let releaseTransition!: () => void;
    let transitionLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      transitionLocked = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTransition = resolve;
    });
    const transition = withCredentialToolFenceLock(root, async () => {
      transitionLocked();
      await release;
    });
    await locked;

    await expect(
      credentialToolFencePre(root, {
        sessionId: "long-transition-session",
        toolUseId: "long-transition-call",
      }),
    ).resolves.toBe("UNKNOWN");

    releaseTransition();
    await expect(transition).resolves.toBeUndefined();
  });

  it("rejects illegal, stale, conflicting, and overflowing transitions", async () => {
    const root = await initializedRoot();
    const changedBinding: FixtureCredentialExecutionBinding = {
      ...binding,
      trustRootHash: hash("9"),
    };
    const invalid = async (gateEvent: CredentialExecutionGateEvent) => {
      await expect(
        transitionCredentialExecutionGate(root, gateEvent),
      ).rejects.toEqual(
        expect.objectContaining<Partial<CredentialExecutionGateError>>({
          code: "INVALID_TRANSITION",
        }),
      );
    };

    await invalid(event("ACTIVATE", 1, 20));
    await invalid(event("PREPARE", 2, 20));
    await transitionCredentialExecutionGate(root, event("PREPARE", 1, 20));
    await invalid(event("PREPARE", 1, 21));
    await invalid(event("ACTIVATE", 1, 30, changedBinding));
    await invalid(event("ACTIVATE", 2, 30));
    await transitionCredentialExecutionGate(root, event("ACTIVATE", 1, 30));
    await invalid({
      ...event("BEGIN_CLEANUP", 1, 40),
      quiescenceReceiptHash: hash("c"),
    });
    await invalid(event("BEGIN_CLEANUP", 1, 29));

    const maximumRoot = await initializedRoot();
    const maximum = {
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      createdAt: 10,
      effect: "BLOCK_AGENT_EXECUTION_ONLY",
      expiresAt: 100,
      generation: Number.MAX_SAFE_INTEGER,
      operationDigest: hash("a"),
      outcome: "ACTIVATED",
      receiptDigest: null,
      schemaVersion: 1,
      state: "OPEN",
      updatedAt: 10,
    };
    await writeFile(currentPath(maximumRoot), `${JSON.stringify(maximum)}\n`);
    await expect(
      transitionCredentialExecutionGate(
        maximumRoot,
        event("PREPARE", Number.MAX_SAFE_INTEGER, 20),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_TRANSITION",
      }),
    );
  });

  it("requires a bounded Host quiescence receipt and validates ticket time", async () => {
    const root = await initializedRoot();
    await expect(
      transitionCredentialExecutionGate(
        root,
        event("PREPARE", 1, 20, {
          ...binding,
          ticket: { ...ticket, schemaVersion: 1 } as never,
        }),
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_INPUT",
      }),
    );
    await expect(
      transitionCredentialExecutionGate(root, event("PREPARE", 1, 101)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_INPUT",
      }),
    );
    await transitionCredentialExecutionGate(root, event("PREPARE", 1, 20));

    const withoutReceipt = event("ACTIVATE", 1, 30) as unknown as Record<
      string,
      unknown
    >;
    delete withoutReceipt.quiescenceReceiptHash;
    await expect(
      transitionCredentialExecutionGate(
        root,
        withoutReceipt as unknown as CredentialExecutionGateEvent,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_INPUT",
      }),
    );
    await expect(
      transitionCredentialExecutionGate(root, {
        ...event("ACTIVATE", 1, 30),
        quiescenceReceiptHash: "not-a-hash",
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_INPUT",
      }),
    );

    await transitionCredentialExecutionGate(root, event("ACTIVATE", 1, 30));
    const active = await readCredentialExecutionGate(root);
    expect(active).toMatchObject({
      expiresAt: 100,
      kind: "KNOWN",
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: "ACTIVE",
    });
    expect(credentialExecutionGateBlockStatus(active)).toBe(
      "BLOCK_AGENT_EXECUTION",
    );

    await transitionCredentialExecutionGate(
      root,
      event("BEGIN_CLEANUP", 1, 40),
    );
    await expect(
      transitionCredentialExecutionGate(root, {
        ...event("BEGIN_CLEANUP", 1, 40),
        quiescenceReceiptHash: hash("c"),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_TRANSITION",
      }),
    );
    const withoutCleanupEvidence = event(
      "FINISH_CLEANUP",
      1,
      50,
    ) as unknown as Record<string, unknown>;
    delete withoutCleanupEvidence.cleanupEvidenceHash;
    await expect(
      transitionCredentialExecutionGate(
        root,
        withoutCleanupEvidence as unknown as CredentialExecutionGateEvent,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_INPUT",
      }),
    );
    await expect(
      transitionCredentialExecutionGate(root, {
        ...event("FINISH_CLEANUP", 1, 50),
        cleanupEvidenceHash: hash("b"),
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_TRANSITION",
      }),
    );
    await expect(
      transitionCredentialExecutionGate(root, event("FINISH_CLEANUP", 1, 50)),
    ).resolves.toBe("APPLIED");
  });

  it("aborts PREPARING through cleanup without claiming false activation", async () => {
    const root = await initializedRoot();
    await transitionCredentialExecutionGate(root, event("PREPARE", 1, 20));
    const abort = event("ABORT_PREPARING", 1, 101);
    await expect(transitionCredentialExecutionGate(root, abort)).resolves.toBe(
      "APPLIED",
    );
    await expect(transitionCredentialExecutionGate(root, abort)).resolves.toBe(
      "REPLAY",
    );
    const cleanup = await readCredentialExecutionGate(root);
    expect(cleanup).toMatchObject({
      kind: "KNOWN",
      outcome: "ABORTED",
      receiptDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      state: "CLEANUP_PENDING",
    });
    await expect(
      transitionCredentialExecutionGate(root, event("BEGIN_CLEANUP", 1, 101)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "INVALID_TRANSITION",
      }),
    );
    await expect(
      transitionCredentialExecutionGate(root, event("FINISH_CLEANUP", 1, 102)),
    ).resolves.toBe("APPLIED");
    await expect(readCredentialExecutionGate(root)).resolves.toMatchObject({
      kind: "KNOWN",
      outcome: "ABORTED",
      receiptDigest: null,
      state: "OPEN",
    });
  });

  it("never persists the ticket or an accepted canary", async () => {
    const root = await initializedRoot();
    await transitionCredentialExecutionGate(root, event("PREPARE", 1, 20));
    await transitionCredentialExecutionGate(root, event("ACTIVATE", 1, 30));
    await transitionCredentialExecutionGate(
      root,
      event("BEGIN_CLEANUP", 1, 40),
    );
    await transitionCredentialExecutionGate(
      root,
      event("FINISH_CLEANUP", 1, 50),
    );

    const persisted = `${await readFile(currentPath(root), "utf8")}\n${await readFile(
      sentinelPath(root),
      "utf8",
    )}`;
    expect(persisted).not.toContain(canary);
    expect(persisted).not.toContain(ticket.ticketId);
    expect(persisted).not.toContain(ticket.credentialUseId);
    expect(persisted).not.toContain(ticket.handoff.activationAnchorHash);
  });

  it("fails closed for missing initialized state, corruption, and oversize data", async () => {
    const missingRoot = await initializedRoot();
    await unlink(currentPath(missingRoot));
    const missing = await readCredentialExecutionGate(missingRoot);
    expect(missing).toEqual({ kind: "UNKNOWN" });
    expect(credentialExecutionGateBlockStatus(missing)).toBe(
      "BLOCK_AGENT_EXECUTION",
    );

    const corruptRoot = await initializedRoot();
    await writeFile(currentPath(corruptRoot), "{broken\n");
    await expect(readCredentialExecutionGate(corruptRoot)).resolves.toEqual({
      kind: "UNKNOWN",
    });

    const oversizeRoot = await initializedRoot();
    await writeFile(currentPath(oversizeRoot), "x".repeat(2 * 1024 + 1));
    await expect(readCredentialExecutionGate(oversizeRoot)).resolves.toEqual({
      kind: "UNKNOWN",
    });

    const absentSentinelRoot = await initializedRoot();
    await unlink(sentinelPath(absentSentinelRoot));
    const uninitialized = await readCredentialExecutionGate(absentSentinelRoot);
    expect(uninitialized).toEqual({ kind: "UNKNOWN" });
    expect(credentialExecutionGateBlockStatus(uninitialized)).toBe(
      "BLOCK_AGENT_EXECUTION",
    );
  });

  it("rejects unsafe permissions, symlinks, and FIFOs without blocking", async () => {
    const permissionsRoot = await initializedRoot();
    await chmod(currentPath(permissionsRoot), 0o644);
    await expect(readCredentialExecutionGate(permissionsRoot)).resolves.toEqual(
      {
        kind: "UNKNOWN",
      },
    );

    const symlinkRoot = await initializedRoot();
    const target = path.join(
      path.dirname(symlinkRoot),
      "attacker-current.json",
    );
    await writeFile(target, "{}\n", { mode: 0o600 });
    await unlink(currentPath(symlinkRoot));
    await symlink(target, currentPath(symlinkRoot));
    await expect(readCredentialExecutionGate(symlinkRoot)).resolves.toEqual({
      kind: "UNKNOWN",
    });

    const sentinelSymlinkRoot = await initializedRoot();
    const sentinelTarget = path.join(
      path.dirname(sentinelSymlinkRoot),
      "attacker-sentinel",
    );
    await writeFile(sentinelTarget, "{}\n", { mode: 0o600 });
    await unlink(sentinelPath(sentinelSymlinkRoot));
    await symlink(sentinelTarget, sentinelPath(sentinelSymlinkRoot));
    await expect(
      readCredentialExecutionGate(sentinelSymlinkRoot),
    ).resolves.toEqual({ kind: "UNKNOWN" });

    const fifoRoot = await initializedRoot();
    await unlink(currentPath(fifoRoot));
    execFileSync("mkfifo", [currentPath(fifoRoot)]);
    await chmod(currentPath(fifoRoot), 0o600);
    await expect(readCredentialExecutionGate(fifoRoot)).resolves.toEqual({
      kind: "UNKNOWN",
    });

    const directoryRoot = await initializedRoot();
    await chmod(gateDirectory(directoryRoot), 0o755);
    await expect(readCredentialExecutionGate(directoryRoot)).resolves.toEqual({
      kind: "UNKNOWN",
    });
  });

  it("recovers the exact pre-sentinel initialization crash and refuses a later generation", async () => {
    const root = await initializedRoot();
    await unlink(sentinelPath(root));
    await expect(readCredentialExecutionGate(root)).resolves.toEqual({
      kind: "UNKNOWN",
    });
    await expect(initializeCredentialExecutionGate(root, 999)).resolves.toBe(
      "INITIALIZED",
    );
    await expect(readCredentialExecutionGate(root)).resolves.toMatchObject({
      createdAt: 10,
      generation: 0,
      kind: "KNOWN",
      state: "OPEN",
    });

    await unlink(sentinelPath(root));
    const forgedLaterGeneration = {
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      createdAt: 20,
      effect: "BLOCK_AGENT_EXECUTION_ONLY",
      expiresAt: 100,
      generation: 1,
      operationDigest: hash("a"),
      outcome: "ACTIVATED",
      receiptDigest: null,
      schemaVersion: 1,
      state: "OPEN",
      updatedAt: 30,
    };
    await writeFile(
      currentPath(root),
      `${JSON.stringify(forgedLaterGeneration)}\n`,
    );
    await expect(initializeCredentialExecutionGate(root, 999)).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "UNAVAILABLE",
      }),
    );
  });

  it("recovers one dead lock and retains its deterministic tombstone", async () => {
    const root = await initializedRoot();
    const lockPath = path.join(gateDirectory(root), ".current.lock");
    const nonce = "00000000-0000-4000-8000-000000000000";
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        createdAt: 10,
        nonce,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      transitionCredentialExecutionGate(root, event("PREPARE", 1, 20)),
    ).resolves.toBe("APPLIED");
    await expect(stat(`${lockPath}.recovered-${nonce}`)).resolves.toMatchObject(
      {
        nlink: 1,
      },
    );
    await expect(readCredentialExecutionGate(root)).resolves.toMatchObject({
      generation: 1,
      kind: "KNOWN",
      state: "PREPARING",
    });
  });

  it("fails closed when a prior deterministic recovery claim survived", async () => {
    const root = await initializedRoot();
    const lockPath = path.join(gateDirectory(root), ".current.lock");
    const nonce = "11111111-1111-4111-8111-111111111111";
    await writeFile(
      lockPath,
      `${JSON.stringify({
        schemaVersion: 1,
        pid: 2_147_483_647,
        createdAt: 10,
        nonce,
      })}\n`,
      { mode: 0o600 },
    );
    await link(lockPath, `${lockPath}.recovered-${nonce}`);
    await expect(readCredentialExecutionGate(root)).resolves.toEqual({
      kind: "UNKNOWN",
    });

    await expect(
      transitionCredentialExecutionGate(root, event("PREPARE", 1, 20)),
    ).rejects.toEqual(
      expect.objectContaining<Partial<CredentialExecutionGateError>>({
        code: "CONFLICT",
      }),
    );
    await expect(readCredentialExecutionGate(root)).resolves.toEqual({
      kind: "UNKNOWN",
    });
  });

  it("does not use elapsed time to unlock PREPARING or CLEANUP_PENDING", async () => {
    const root = await initializedRoot();
    await transitionCredentialExecutionGate(root, event("PREPARE", 1, 20));
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    const preparing = await readCredentialExecutionGate(root);
    expect(preparing).toMatchObject({ kind: "KNOWN", state: "PREPARING" });
    expect(credentialExecutionGateBlockStatus(preparing)).toBe(
      "BLOCK_AGENT_EXECUTION",
    );

    await transitionCredentialExecutionGate(root, event("ACTIVATE", 1, 30));
    const expiredActive = await readCredentialExecutionGate(root);
    expect(expiredActive).toMatchObject({
      expiresAt: 100,
      kind: "KNOWN",
      state: "ACTIVE",
    });
    expect(credentialExecutionGateBlockStatus(expiredActive)).toBe(
      "BLOCK_AGENT_EXECUTION",
    );
    await transitionCredentialExecutionGate(
      root,
      event("BEGIN_CLEANUP", 1, Number.MAX_SAFE_INTEGER),
    );
    const cleanup = await readCredentialExecutionGate(root);
    expect(cleanup).toMatchObject({
      kind: "KNOWN",
      state: "CLEANUP_PENDING",
    });
    expect(credentialExecutionGateBlockStatus(cleanup)).toBe(
      "BLOCK_AGENT_EXECUTION",
    );
  });
});
