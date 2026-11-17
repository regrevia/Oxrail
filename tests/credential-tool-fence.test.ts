import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import * as core from "../packages/core/src/index.js";
import * as executionGate from "../packages/core/src/credential-execution-gate.js";
import * as toolCallJournal from "../packages/core/src/tool-call.js";
import {
  credentialToolFencePost,
  credentialToolFencePre,
  observeCredentialToolFenceCleanupLocked,
  observeCredentialToolFenceLocked,
  readCredentialToolFenceQuiescence,
  type CredentialToolFenceCall,
} from "../packages/core/src/credential-tool-fence.js";
import { withCredentialToolFenceLock } from "../packages/core/src/credential-tool-fence-lock.js";

const canary = "oxrail_secret_canary_must_not_persist";
const hash = (character: string) => character.repeat(64);
const temporaryDirectories: string[] = [];

async function makeRoot(): Promise<string> {
  const parent = await mkdtemp(path.join(tmpdir(), "oxrail-tool-fence-"));
  temporaryDirectories.push(parent);
  return path.join(parent, "state");
}

async function setPreparing(root: string, updatedAt = 2): Promise<void> {
  return setGateState(root, "PREPARING", updatedAt);
}

async function setGateState(
  root: string,
  state: "ACTIVE" | "CLEANUP_PENDING" | "PREPARING",
  updatedAt = 2,
): Promise<void> {
  await writeFile(
    path.join(root, "credential-execution-gate", "current.json"),
    `${JSON.stringify({
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      createdAt: 2,
      effect: "BLOCK_AGENT_EXECUTION_ONLY",
      expiresAt: 100,
      generation: 1,
      operationDigest: hash("a"),
      outcome: state === "PREPARING" ? "NONE" : "ACTIVATED",
      receiptDigest: state === "PREPARING" ? null : hash("b"),
      schemaVersion: 1,
      state,
      updatedAt,
    })}\n`,
  );
}

async function persistedText(directory: string): Promise<string> {
  const chunks: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    chunks.push(entry.name);
    if (entry.isDirectory()) chunks.push(await persistedText(filename));
    else if (entry.isFile()) chunks.push(await readFile(filename, "utf8"));
  }
  return chunks.join("\n");
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("credential tool fence", () => {
  it("keeps the cleanup observation off the public barrel", () => {
    expect(Object.hasOwn(core, "observeCredentialToolFenceCleanupLocked")).toBe(
      false,
    );
  });

  it("bypasses without explicit fixture initialization and creates no state", async () => {
    const root = await makeRoot();
    const call = { sessionId: "session", toolUseId: "call" };

    await expect(credentialToolFencePre(root, call)).resolves.toBe("BYPASS");
    await expect(credentialToolFencePost(root, call)).resolves.toBe("BYPASS");
    await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
      "UNKNOWN",
    );
    await expect(readdir(root)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("treats an existing runtime root without a gate as UNKNOWN without creating a digest key", async () => {
    const root = await makeRoot();
    await mkdir(root, { mode: 0o700 });
    const call = { sessionId: "session", toolUseId: "call" };

    await expect(credentialToolFencePre(root, call)).resolves.toBe("UNKNOWN");
    await expect(credentialToolFencePost(root, call)).resolves.toBe("UNKNOWN");
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("tracks every admitted call globally, drains it after PREPARING, and persists only digests", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    const first: CredentialToolFenceCall = {
      sessionId: `${canary}-session-a`,
      toolUseId: `${canary}-call-a`,
    };
    const second: CredentialToolFenceCall = {
      sessionId: `${canary}-session-b`,
      toolUseId: `${canary}-call-b`,
    };

    await expect(
      credentialToolFencePre(root, {
        ...first,
        toolInput: canary,
      } as unknown as CredentialToolFenceCall),
    ).resolves.toBe("UNKNOWN");
    await expect(credentialToolFencePre(root, first)).resolves.toBe(
      "NO_LEDGER_BLOCK_TRACKED",
    );
    await expect(credentialToolFencePre(root, second)).resolves.toBe(
      "NO_LEDGER_BLOCK_TRACKED",
    );
    await setPreparing(root);
    await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
      "PENDING",
    );
    await expect(
      credentialToolFencePre(root, {
        sessionId: "blocked-session",
        toolUseId: "blocked-call",
      }),
    ).resolves.toBe("BLOCKED");

    await expect(credentialToolFencePost(root, first)).resolves.toBe(
      "COMPLETED",
    );
    await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
      "PENDING",
    );
    await expect(credentialToolFencePost(root, second)).resolves.toBe(
      "COMPLETED",
    );
    await expect(credentialToolFencePost(root, second)).resolves.toBe(
      "COMPLETED",
    );
    await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
      "QUIESCENT",
    );

    const persisted = await persistedText(root);
    expect(persisted).not.toContain(canary);
    expect(persisted).not.toContain(first.sessionId);
    expect(persisted).not.toContain(first.toolUseId);
    expect(persisted).not.toContain(second.sessionId);
    expect(persisted).not.toContain(second.toolUseId);
  });

  it("blocks a duplicate Pre instead of authorizing a second execution", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    const call = { sessionId: "duplicate-session", toolUseId: "duplicate" };

    await expect(credentialToolFencePre(root, call)).resolves.toBe(
      "NO_LEDGER_BLOCK_TRACKED",
    );
    await expect(credentialToolFencePre(root, call)).resolves.toBe("BLOCKED");
    await expect(credentialToolFencePost(root, call)).resolves.toBe(
      "COMPLETED",
    );
    await expect(credentialToolFencePre(root, call)).resolves.toBe("BLOCKED");
  });

  it("refuses registration at the bounded global active-index ceiling", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    vi.spyOn(toolCallJournal, "inspectToolCallJournal").mockResolvedValue({
      completedToolUseIds: [],
      kind: "KNOWN",
      legacyPending: false,
      pendingToolUseIds: Array.from(
        { length: toolCallJournal.MAX_ACTIVE_TOOL_CALLS },
        (_, index) => `oxrail-id:${index.toString(16).padStart(64, "0")}`,
      ),
    });
    vi.spyOn(toolCallJournal, "countActiveToolCalls").mockResolvedValue(
      toolCallJournal.MAX_ACTIVE_TOOL_CALLS,
    );
    const record = vi.spyOn(toolCallJournal, "recordToolCallPre");

    await expect(
      credentialToolFencePre(root, {
        sessionId: "ceiling-session",
        toolUseId: "ceiling-call",
      }),
    ).resolves.toBe("OPEN_DEGRADED");
    expect(record).not.toHaveBeenCalled();
  });

  it("serializes concurrent registration at the last active-index slot", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    let activeCount = toolCallJournal.MAX_ACTIVE_TOOL_CALLS - 1;
    vi.spyOn(toolCallJournal, "inspectToolCallJournal").mockImplementation(
      async () => ({
        completedToolUseIds: [],
        kind: "KNOWN",
        legacyPending: false,
        pendingToolUseIds: Array.from(
          { length: activeCount },
          (_, index) => `oxrail-id:${index.toString(16).padStart(64, "0")}`,
        ),
      }),
    );
    vi.spyOn(toolCallJournal, "countActiveToolCalls").mockImplementation(
      async () => activeCount,
    );
    const record = vi
      .spyOn(toolCallJournal, "recordToolCallPre")
      .mockImplementation(async (_root, input) => {
        activeCount += 1;
        return {
          decision: input.decision,
          journalStatus: "PENDING",
          kind: "RECORDED",
        };
      });

    const results = await Promise.all([
      credentialToolFencePre(root, {
        sessionId: "concurrent-session-a",
        toolUseId: "concurrent-call-a",
      }),
      credentialToolFencePre(root, {
        sessionId: "concurrent-session-b",
        toolUseId: "concurrent-call-b",
      }),
    ]);

    expect(results.sort()).toEqual([
      "NO_LEDGER_BLOCK_TRACKED",
      "OPEN_DEGRADED",
    ]);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it("completes an older call even if the gate directory disappears", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    const call = { sessionId: "old-session", toolUseId: "old-call" };
    await expect(credentialToolFencePre(root, call)).resolves.toBe(
      "NO_LEDGER_BLOCK_TRACKED",
    );
    await rm(path.join(root, "credential-execution-gate"), {
      recursive: true,
    });

    await expect(
      credentialToolFencePre(root, {
        sessionId: "new-session",
        toolUseId: "new-call",
      }),
    ).resolves.toBe("UNKNOWN");
    await expect(credentialToolFencePost(root, call)).resolves.toBe(
      "COMPLETED",
    );
    await expect(credentialToolFencePost(root, call)).resolves.toBe("UNKNOWN");
  });

  it("keeps a changed-snapshot registration pending until a real Post", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    const initial = await executionGate.readCredentialExecutionGate(root);
    if (initial.kind !== "KNOWN") throw new Error("expected known gate");
    const changed = { ...initial, updatedAt: initial.updatedAt + 1 };
    vi.spyOn(executionGate, "readCredentialExecutionGate")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);
    const call = { sessionId: "racing-session", toolUseId: "racing-call" };

    await expect(credentialToolFencePre(root, call)).resolves.toBe("BLOCKED");
    vi.restoreAllMocks();
    await setPreparing(root);
    await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
      "PENDING",
    );
    await expect(credentialToolFencePost(root, call)).resolves.toBe(
      "COMPLETED",
    );
    await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
      "QUIESCENT",
    );
  });

  it("reports UNKNOWN if PREPARING changes during the bounded scan", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    await setPreparing(root);
    const initial = await executionGate.readCredentialExecutionGate(root);
    if (initial.kind !== "KNOWN") throw new Error("expected known gate");
    const changed = { ...initial, updatedAt: initial.updatedAt + 1 };
    vi.spyOn(executionGate, "readCredentialExecutionGate")
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(changed);

    await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
      "UNKNOWN",
    );
  });

  it.each(["PREPARING", "ACTIVE", "CLEANUP_PENDING"] as const)(
    "proves an empty %s cleanup snapshot without changing PREPARING observation semantics",
    async (state) => {
      const root = await makeRoot();
      await executionGate.initializeCredentialExecutionGate(root, 1);
      await setGateState(root, state);
      const expected = await executionGate.readCredentialExecutionGate(root);

      await expect(
        withCredentialToolFenceLock(root, () =>
          observeCredentialToolFenceCleanupLocked(root, expected),
        ),
      ).resolves.toMatchObject({
        kind: "QUIESCENT",
        snapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      if (state !== "PREPARING") {
        await expect(
          withCredentialToolFenceLock(root, () =>
            observeCredentialToolFenceLocked(root, expected),
          ),
        ).resolves.toEqual({ kind: "UNKNOWN" });
        await expect(readCredentialToolFenceQuiescence(root)).resolves.toBe(
          "UNKNOWN",
        );
      }
    },
  );

  it("sweeps only a durable completed Post before reporting cleanup quiescence", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    const call = {
      sessionId: "completed-session",
      toolUseId: "completed-call",
    };
    await expect(credentialToolFencePre(root, call)).resolves.toBe(
      "NO_LEDGER_BLOCK_TRACKED",
    );
    const retirement = vi
      .spyOn(toolCallJournal, "retireCompletedToolCall")
      .mockResolvedValue("UNAVAILABLE");
    await expect(credentialToolFencePost(root, call)).resolves.toBe("UNKNOWN");
    retirement.mockRestore();
    await setGateState(root, "CLEANUP_PENDING");
    const expected = await executionGate.readCredentialExecutionGate(root);
    const sweep = vi.spyOn(toolCallJournal, "retireCompletedToolCalls");

    await expect(
      withCredentialToolFenceLock(root, () =>
        observeCredentialToolFenceCleanupLocked(root, expected),
      ),
    ).resolves.toMatchObject({ kind: "QUIESCENT" });
    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it("keeps a real pending call pending until its Post arrives", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    const call = { sessionId: "pending-session", toolUseId: "pending-call" };
    await expect(credentialToolFencePre(root, call)).resolves.toBe(
      "NO_LEDGER_BLOCK_TRACKED",
    );
    await setGateState(root, "CLEANUP_PENDING");
    const expected = await executionGate.readCredentialExecutionGate(root);

    await expect(
      withCredentialToolFenceLock(root, () =>
        observeCredentialToolFenceCleanupLocked(root, expected),
      ),
    ).resolves.toEqual({ kind: "PENDING" });
    await expect(credentialToolFencePost(root, call)).resolves.toBe(
      "COMPLETED",
    );
    await expect(
      withCredentialToolFenceLock(root, () =>
        observeCredentialToolFenceCleanupLocked(root, expected),
      ),
    ).resolves.toMatchObject({ kind: "QUIESCENT" });
  });

  it.each([
    [
      "legacy pending",
      {
        completedToolUseIds: [],
        kind: "KNOWN" as const,
        legacyPending: true,
        pendingToolUseIds: [],
      },
      1,
      "PENDING",
    ],
    ["unknown journal", { kind: "UNKNOWN" as const }, 0, "UNKNOWN"],
    [
      "unknown physical count",
      {
        completedToolUseIds: [],
        kind: "KNOWN" as const,
        legacyPending: false,
        pendingToolUseIds: [],
      },
      "UNKNOWN",
      "UNKNOWN",
    ],
  ] as const)(
    "reports %s conservatively",
    async (_label, journal, physicalCount, result) => {
      const root = await makeRoot();
      await executionGate.initializeCredentialExecutionGate(root, 1);
      await setGateState(root, "CLEANUP_PENDING");
      const expected = await executionGate.readCredentialExecutionGate(root);
      vi.spyOn(toolCallJournal, "inspectToolCallJournal").mockResolvedValue(
        journal.kind === "KNOWN"
          ? {
              ...journal,
              completedToolUseIds: [...journal.completedToolUseIds],
              pendingToolUseIds: [...journal.pendingToolUseIds],
            }
          : journal,
      );
      vi.spyOn(toolCallJournal, "countActiveToolCalls").mockResolvedValue(
        physicalCount,
      );

      await expect(
        withCredentialToolFenceLock(root, () =>
          observeCredentialToolFenceCleanupLocked(root, expected),
        ),
      ).resolves.toEqual({ kind: result });
    },
  );

  it("reports UNKNOWN if the cleanup gate snapshot drifts during the bounded scan", async () => {
    const root = await makeRoot();
    await executionGate.initializeCredentialExecutionGate(root, 1);
    await setGateState(root, "CLEANUP_PENDING");
    const expected = await executionGate.readCredentialExecutionGate(root);
    if (expected.kind !== "KNOWN") throw new Error("expected known gate");
    const changed = { ...expected, updatedAt: expected.updatedAt + 1 };
    vi.spyOn(executionGate, "readCredentialExecutionGate")
      .mockResolvedValueOnce(expected)
      .mockResolvedValueOnce(changed);

    await expect(
      withCredentialToolFenceLock(root, () =>
        observeCredentialToolFenceCleanupLocked(root, expected),
      ),
    ).resolves.toEqual({ kind: "UNKNOWN" });
  });
});
