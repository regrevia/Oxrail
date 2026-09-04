import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  stat,
  symlink,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  activateUserLease,
  beginHandoffVerification,
  beginResume,
  createBrowserTaskState,
  finishResume,
} from "../packages/core/src/state.js";
import {
  MAX_BROWSER_TASK_STATE_BYTES,
  readBoundedPrivateFile,
  readBrowserTaskState,
  writeBrowserTaskState,
} from "../packages/core/src/store.js";

const run = promisify(execFile);

const verificationMarker = () => ({
  schemaVersion: 1 as const,
  authority: "FIXTURE_ONLY_NON_AUTHORIZING" as const,
  leaseEpoch: 1,
  candidateDigest: "a".repeat(64),
  activationAnchorDigest: "b".repeat(64),
  currentTabReceiptDigest: "c".repeat(64),
  verifierContextBindingHash: "d".repeat(64),
  stateEpoch: 3,
  firstProbeSequence: 10,
  secondProbeSequence: 11,
  basis: "DETERMINISTIC" as const,
  phaseSignal: "AUTH_MARKER_PRESENT" as const,
});

async function storedStatePath(root: string): Promise<string> {
  const [sessionDirectory] = await readdir(root);
  const [taskDirectory] = await readdir(path.join(root, sessionDirectory!));
  return path.join(
    root,
    sessionDirectory!,
    taskDirectory!,
    "browser-task-state.json",
  );
}

async function injectLock(
  root: string,
  metadata: { createdAt: number; pid: number },
  modifiedAt = new Date(),
): Promise<string> {
  const lockPath = path.join(
    path.dirname(await storedStatePath(root)),
    ".browser-task-state.lock",
  );
  await writeFile(
    lockPath,
    `${JSON.stringify({
      schemaVersion: 1,
      nonce: "00000000-0000-4000-8000-000000000000",
      ...metadata,
    })}\n`,
    { mode: 0o600 },
  );
  await utimes(lockPath, modifiedAt, modifiedAt);
  return lockPath;
}

const taskScope = (state: { sessionId: string; taskId: string }) => ({
  sessionId: state.sessionId,
  taskId: state.taskId,
});

async function storedFixture() {
  const root = path.join(
    await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
    "state",
  );
  const state = createBrowserTaskState({
    sessionId: "session-1",
    taskId: "task-1",
    hostProfileId: "profile-1",
    mode: "MICRO_ACTION_GUARD",
  });
  await writeBrowserTaskState(root, state, null);
  const filename = await storedStatePath(root);
  return {
    filename,
    lockPath: path.join(path.dirname(filename), ".browser-task-state.lock"),
    root,
    state,
  };
}

describe("BrowserTaskState store", () => {
  it("round-trips one task through a private session/task namespace", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const state = createBrowserTaskState({
      sessionId: "session/one",
      taskId: "task/one",
      hostProfileId: "profile-1",
      mode: "MICRO_ACTION_GUARD",
    });

    await writeBrowserTaskState(root, state, null);

    await expect(
      readBrowserTaskState(root, {
        sessionId: state.sessionId,
        taskId: state.taskId,
      }),
    ).resolves.toEqual(state);
    await expect(
      readBrowserTaskState(root, {
        sessionId: state.sessionId,
        taskId: "another-task",
      }),
    ).resolves.toBeUndefined();

    const [sessionDirectory] = await readdir(root);
    const sessionPath = path.join(root, sessionDirectory!);
    const [taskDirectory] = await readdir(sessionPath);
    const taskPath = path.join(sessionPath, taskDirectory!);
    expect(sessionDirectory).not.toContain("session");
    expect(taskDirectory).not.toContain("task");
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(sessionPath)).mode & 0o777).toBe(0o700);
    expect((await stat(taskPath)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(path.join(taskPath, "browser-task-state.json"))).mode & 0o777,
    ).toBe(0o600);
  });

  it("allows only one concurrent writer for an expected state version", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const initial = createBrowserTaskState({
      sessionId: "session-1",
      taskId: "task-1",
      hostProfileId: "profile-1",
      mode: "MICRO_ACTION_GUARD",
    });
    await writeBrowserTaskState(root, initial, null);
    const candidates = [1, 2].map((recoveryLevel) => ({
      ...initial,
      recoveryLevel,
      stateVersion: 1,
    }));

    const results = await Promise.allSettled(
      candidates.map((candidate) =>
        writeBrowserTaskState(root, candidate, initial.stateVersion),
      ),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await expect(
      readBrowserTaskState(root, {
        sessionId: initial.sessionId,
        taskId: initial.taskId,
      }),
    ).resolves.toMatchObject({ stateVersion: 1 });
    await expect(
      writeBrowserTaskState(
        root,
        { ...initial, stateVersion: 1 },
        initial.stateVersion,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("atomically persists the fixture-only verification consume marker with Human ownership", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const handoffId = "raw-handoff-content-canary";
    const initialDocument = "raw-initial-document-content-canary";
    const currentDocument = "raw-current-document-content-canary";
    const running = {
      ...createBrowserTaskState({
        sessionId: "session-1",
        taskId: "task-1",
        hostProfileId: "profile-1",
        mode: "MICRO_ACTION_GUARD",
      }),
      currentOrigin: "https://login.example.test",
      currentUrlKey: "stale-route-key",
      documentBinding: initialDocument,
    };
    await writeBrowserTaskState(root, running, null);
    const active = activateUserLease(running, handoffId);
    await writeBrowserTaskState(root, active, running.stateVersion);
    const persistedActive = await readBrowserTaskState(
      root,
      taskScope(running),
    );
    if (!persistedActive) throw new Error("active state was not persisted");

    const verifying = beginHandoffVerification(persistedActive, {
      currentDocumentBinding: currentDocument,
      currentOrigin: "https://app.example.test",
      expectedStateVersion: persistedActive.stateVersion,
      handoffId,
      leaseEpoch: active.leaseEpoch,
      marker: verificationMarker(),
    });
    await writeBrowserTaskState(root, verifying, persistedActive.stateVersion);

    await expect(
      readBrowserTaskState(root, taskScope(running)),
    ).resolves.toMatchObject({
      currentOrigin: "https://app.example.test",
      documentBinding: expect.stringMatching(/^oxrail-id:[a-f0-9]{64}$/),
      handoffVerificationMarker: verificationMarker(),
      phase: "HANDOFF_VERIFYING",
      pointerOwner: "HUMAN",
      stateVersion: persistedActive.stateVersion + 1,
    });
    const stored = await readFile(await storedStatePath(root), "utf8");
    expect(stored).not.toContain(handoffId);
    expect(stored).not.toContain(initialDocument);
    expect(stored).not.toContain(currentDocument);
    expect(stored).not.toContain("stale-route-key");
    expect(stored).toContain('"candidateDigest":"');
  });

  it("rejects verification marker replay and counter overflow before mutation", () => {
    const handoffId = "handoff-1";
    const running = createBrowserTaskState({
      sessionId: "session-1",
      taskId: "task-1",
      hostProfileId: "profile-1",
      mode: "MICRO_ACTION_GUARD",
    });
    const active = activateUserLease(running, handoffId);
    const input = {
      currentDocumentBinding: "document-2",
      currentOrigin: "https://example.test",
      expectedStateVersion: active.stateVersion,
      handoffId,
      leaseEpoch: active.leaseEpoch,
      marker: verificationMarker(),
    };
    const verifying = beginHandoffVerification(active, input);
    expect(() =>
      beginHandoffVerification(
        { ...active, activeHandoffId: handoffId },
        input,
      ),
    ).toThrow("Only the unconsumed active Human lease");
    expect(() =>
      beginHandoffVerification(
        { ...verifying, phase: "USER_LEASE_ACTIVE" },
        { ...input, expectedStateVersion: verifying.stateVersion },
      ),
    ).toThrow("Only the unconsumed active Human lease");

    expect(() =>
      activateUserLease(
        { ...running, stateVersion: Number.MAX_SAFE_INTEGER },
        handoffId,
      ),
    ).toThrow("stateVersion cannot advance");
    expect(() =>
      beginHandoffVerification(
        { ...active, stateVersion: Number.MAX_SAFE_INTEGER },
        { ...input, expectedStateVersion: Number.MAX_SAFE_INTEGER },
      ),
    ).toThrow("stateVersion cannot advance");

    const resuming = beginResume(active, handoffId, active.leaseEpoch);
    expect(() =>
      finishResume(
        { ...resuming, stateVersion: Number.MAX_SAFE_INTEGER },
        handoffId,
        active.leaseEpoch,
      ),
    ).toThrow("stateVersion cannot advance");
  });

  it("rejects an oversized update without damaging the current state", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const initial = createBrowserTaskState({
      sessionId: "session-1",
      taskId: "task-1",
      hostProfileId: "profile-1",
      mode: "MICRO_ACTION_GUARD",
    });
    await writeBrowserTaskState(root, initial, null);
    const oversized = {
      ...initial,
      pendingNativeActionIds: Array.from(
        { length: MAX_BROWSER_TASK_STATE_BYTES / 32 },
        (_, index) => `pending-${index.toString().padStart(64, "0")}`,
      ),
      stateVersion: 1,
    };

    await expect(
      writeBrowserTaskState(root, oversized, initial.stateVersion),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });
    await expect(
      readBrowserTaskState(root, {
        sessionId: initial.sessionId,
        taskId: initial.taskId,
      }),
    ).resolves.toEqual(initial);
  });

  it("bounds the actual state bytes and rejects non-private files", async () => {
    const { filename, root, state } = await storedFixture();

    await writeFile(filename, Buffer.alloc(MAX_BROWSER_TASK_STATE_BYTES + 1), {
      mode: 0o600,
    });
    await expect(
      readBrowserTaskState(root, taskScope(state)),
    ).rejects.toMatchObject({ code: "TOO_LARGE" });

    await writeFile(filename, "{}\n", { mode: 0o600 });
    await chmod(filename, 0o644);
    await expect(
      readBrowserTaskState(root, taskScope(state)),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it.skipIf(process.platform !== "linux")(
    "enforces the read bound when a dynamic file reports size zero",
    async () => {
      const filename = `/proc/${process.pid}/environ`;
      expect((await stat(filename)).size).toBe(0);
      await expect(
        readBoundedPrivateFile(filename, 0, "TOO_LARGE"),
      ).rejects.toMatchObject({ code: "TOO_LARGE" });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a device as non-regular state storage",
    async () => {
      await expect(
        readBoundedPrivateFile("/dev/null", 16, "TOO_LARGE"),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    },
  );

  it("does not follow a state-file symlink", async () => {
    const { filename, root, state } = await storedFixture();
    const target = `${filename}.target`;
    await writeFile(target, JSON.stringify(state), { mode: 0o600 });
    await unlink(filename);
    await symlink(target, filename);

    await expect(
      readBrowserTaskState(root, taskScope(state)),
    ).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it.each(["directory", "fifo"] as const)(
    "rejects a non-regular %s state leaf without blocking",
    async (kind) => {
      if (kind === "fifo" && process.platform === "win32") return;
      const { filename, root, state } = await storedFixture();
      await unlink(filename);
      if (kind === "directory") await mkdir(filename, { mode: 0o700 });
      else {
        await run("mkfifo", [filename]);
        await chmod(filename, 0o600);
      }

      await expect(
        readBrowserTaskState(root, taskScope(state)),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    },
  );

  it("rejects unsafe lock leaves and enforces the 512-byte lock bound", async () => {
    const fixtures = ["symlink", "fifo", "oversized", "public"] as const;
    for (const fixture of fixtures) {
      if (fixture === "fifo" && process.platform === "win32") continue;
      const { lockPath, root, state } = await storedFixture();
      if (fixture === "symlink") {
        const target = `${lockPath}.target`;
        await writeFile(target, "{}\n", { mode: 0o600 });
        await symlink(target, lockPath);
      } else if (fixture === "fifo") {
        await run("mkfifo", [lockPath]);
        await chmod(lockPath, 0o600);
      } else if (fixture === "public") {
        await writeFile(lockPath, "{}\n", { mode: 0o644 });
      } else {
        await writeFile(lockPath, Buffer.alloc(513), { mode: 0o600 });
      }

      await expect(
        writeBrowserTaskState(
          root,
          { ...state, stateVersion: 1 },
          state.stateVersion,
        ),
      ).rejects.toMatchObject({ code: "UNAVAILABLE" });
    }
  });

  it("fails safely on corrupt state without exposing or overwriting its contents", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const initial = createBrowserTaskState({
      sessionId: "session-1",
      taskId: "task-1",
      hostProfileId: "profile-1",
      mode: "MICRO_ACTION_GUARD",
    });
    await writeBrowserTaskState(root, initial, null);
    const canary = "raw-secret-canary";
    await writeFile(await storedStatePath(root), `{broken:${canary}`, "utf8");

    let error: unknown;
    try {
      await readBrowserTaskState(root, {
        sessionId: initial.sessionId,
        taskId: initial.taskId,
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "CORRUPT" });
    expect(String(error)).not.toContain(canary);
    await expect(
      writeBrowserTaskState(
        root,
        { ...initial, stateVersion: 1 },
        initial.stateVersion,
      ),
    ).rejects.toMatchObject({ code: "CORRUPT" });
  });

  it("sanitizes content-bearing state before the first persistent write", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const canary = "OXRAIL_SECRET_CANARY_STORE_9630";
    const state = {
      ...createBrowserTaskState({
        sessionId: "session-1",
        taskId: "task-1",
        hostProfileId: "profile-1",
        mode: "MICRO_ACTION_GUARD",
      }),
      goalSummary: `use ${canary}`,
      currentOrigin: "https://example.test",
      currentUrlKey: `https://example.test/private?token=${canary}`,
      pendingNativeActionIds: [`call-${canary}`],
    };

    await writeBrowserTaskState(root, state, null);

    const persisted = await readFile(await storedStatePath(root), "utf8");
    expect(persisted).not.toContain(canary);
    expect(persisted).not.toContain("/private");
    await expect(
      readBrowserTaskState(root, {
        sessionId: state.sessionId,
        taskId: state.taskId,
      }),
    ).resolves.toMatchObject({
      goalSummary: "browser task",
      currentOrigin: "https://example.test",
      pendingNativeActionIds: [expect.stringMatching(/^oxrail-id:/)],
    });
  });

  it("recovers a stale lock only after its owner process has exited", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const initial = createBrowserTaskState({
      sessionId: "session-1",
      taskId: "task-1",
      hostProfileId: "profile-1",
      mode: "MICRO_ACTION_GUARD",
    });
    await writeBrowserTaskState(root, initial, null);
    const staleAt = new Date(Date.now() - 60_000);
    await injectLock(
      root,
      { createdAt: staleAt.getTime(), pid: 2_147_483_647 },
      staleAt,
    );

    await writeBrowserTaskState(
      root,
      { ...initial, stateVersion: 1 },
      initial.stateVersion,
    );

    await expect(
      readBrowserTaskState(root, {
        sessionId: initial.sessionId,
        taskId: initial.taskId,
      }),
    ).resolves.toMatchObject({ stateVersion: 1 });
  });

  it("allows only one reaper to claim a stale lock generation", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const initial = createBrowserTaskState({
      sessionId: "session-1",
      taskId: "task-1",
      hostProfileId: "profile-1",
      mode: "MICRO_ACTION_GUARD",
    });
    await writeBrowserTaskState(root, initial, null);
    const staleAt = new Date(Date.now() - 60_000);
    const lockPath = await injectLock(
      root,
      { createdAt: staleAt.getTime(), pid: 2_147_483_647 },
      staleAt,
    );

    const results = await Promise.allSettled(
      [1, 2].map((recoveryLevel) =>
        writeBrowserTaskState(
          root,
          { ...initial, recoveryLevel, stateVersion: 1 },
          initial.stateVersion,
        ),
      ),
    );

    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    expect(results.filter(({ status }) => status === "rejected")).toHaveLength(
      1,
    );
    await expect(
      stat(`${lockPath}.recovered-00000000-0000-4000-8000-000000000000`),
    ).resolves.toMatchObject({ mode: expect.any(Number) });
  });

  it("does not steal a live or fresh lock", async () => {
    const staleAt = new Date(Date.now() - 60_000);
    const cases = [
      { createdAt: staleAt.getTime(), modifiedAt: staleAt, pid: process.pid },
      { createdAt: Date.now(), modifiedAt: new Date(), pid: 2_147_483_647 },
    ];

    for (const lock of cases) {
      const root = path.join(
        await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
        "state",
      );
      const initial = createBrowserTaskState({
        sessionId: "session-1",
        taskId: "task-1",
        hostProfileId: "profile-1",
        mode: "MICRO_ACTION_GUARD",
      });
      await writeBrowserTaskState(root, initial, null);
      await injectLock(
        root,
        { createdAt: lock.createdAt, pid: lock.pid },
        lock.modifiedAt,
      );

      await expect(
        writeBrowserTaskState(
          root,
          { ...initial, stateVersion: 1 },
          initial.stateVersion,
        ),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      await expect(
        readBrowserTaskState(root, {
          sessionId: initial.sessionId,
          taskId: initial.taskId,
        }),
      ).resolves.toEqual(initial);
    }
  });

  it("does not release a lock that a different owner replaced", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-state-")),
      "state",
    );
    const initial = createBrowserTaskState({
      sessionId: "session-1",
      taskId: "task-1",
      hostProfileId: "profile-1",
      mode: "MICRO_ACTION_GUARD",
    });
    await writeBrowserTaskState(root, initial, null);
    const lockPath = path.join(
      path.dirname(await storedStatePath(root)),
      ".browser-task-state.lock",
    );
    const replacement = (async () => {
      for (let attempt = 0; attempt < 10_000; attempt++) {
        try {
          const contents = await readFile(lockPath, "utf8");
          if (contents.includes("00000000-0000-4000-8000-000000000000")) {
            await new Promise<void>((resolve) => setImmediate(resolve));
            continue;
          }
          await unlink(lockPath);
          return injectLock(root, {
            createdAt: Date.now(),
            pid: process.pid,
          });
        } catch {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }
      throw new Error("lock was not observed before replacement");
    })();

    const writing = writeBrowserTaskState(
      root,
      {
        ...initial,
        pendingNativeActionIds: Array.from(
          { length: 700 },
          (_, index) => `pending-${index.toString().padStart(64, "0")}`,
        ),
        stateVersion: 1,
      },
      initial.stateVersion,
    );
    await replacement;
    await writing;

    await expect(readFile(lockPath, "utf8")).resolves.toContain(
      "00000000-0000-4000-8000-000000000000",
    );
  });
});
