import {
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { describe, expect, it } from "vitest";

import {
  MAX_ACTIVE_INDEX_ENTRIES,
  MAX_ACTIVE_TOOL_CALLS,
  completeToolCallPost,
  hasPendingToolCalls,
  inspectToolCallJournal,
  protectToolCallRequestDigest,
  recordToolCallPre,
  retireCompletedToolCall,
  retireCompletedToolCalls,
} from "../packages/core/src/tool-call.js";
import { createLocalDigestProtector } from "../packages/core/src/local-digest.js";
import { persistentToolUseId } from "../packages/core/src/safe-state.js";
import type { PolicyDecision } from "../packages/protocol/src/index.js";

const allow: PolicyDecision = {
  disposition: "PASS_THROUGH_ORIGINAL",
  reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
  recoverable: true,
};
const block: PolicyDecision = {
  disposition: "BLOCK_BEFORE_EXECUTION",
  reasonCode: "OXRAIL_REDUNDANT_ACTION",
  recoverable: true,
};
const requestDigest = "a".repeat(64);
const bindingDigest = "b".repeat(64);

const makeRoot = async () =>
  path.join(await mkdtemp(path.join(tmpdir(), "oxrail-tool-call-")), "state");

const baseInput = (toolUseId = "call-1") => ({
  bindingDigest,
  decision: allow,
  requestDigest,
  sessionId: "session-1",
  taskId: "task-1",
  toolUseId,
});

async function journalDirectory(root: string): Promise<string> {
  const [session] = await readdir(root);
  const sessionDirectory = path.join(root, session!);
  const [task] = await readdir(sessionDirectory);
  return path.join(sessionDirectory, task!, "tool-calls");
}

describe("tool call journal", () => {
  it("keys sanitized request digests with one private per-install key", async () => {
    const root = await makeRoot();
    const concurrent = await Promise.all(
      Array.from({ length: 24 }, () =>
        protectToolCallRequestDigest(root, requestDigest),
      ),
    );
    const first = concurrent[0];
    const repeated = await protectToolCallRequestDigest(root, requestDigest);
    const changed = await protectToolCallRequestDigest(root, "c".repeat(64));

    expect(first).toMatch(/^[a-f0-9]{64}$/);
    expect(new Set(concurrent)).toEqual(new Set([first]));
    expect(first).toBe(repeated);
    expect(first).not.toBe(requestDigest);
    expect(changed).not.toBe(first);
    const protector = await createLocalDigestProtector(root);
    expect(protector?.protect("action-input-v1", requestDigest)).not.toBe(
      first,
    );
    expect(protector?.protect("action-input-v1", requestDigest)).not.toBe(
      protector?.protect("action-target-v1", requestDigest),
    );
    await expect(protectToolCallRequestDigest(root, "invalid")).resolves.toBe(
      undefined,
    );
    const key = path.join(root, ".local-digest-key.json");
    expect((await stat(key)).mode & 0o777).toBe(0o600);
    expect((await readFile(key)).byteLength).toBeLessThanOrEqual(256);

    await writeFile(key, Buffer.alloc(32, 7));
    await expect(
      protectToolCallRequestDigest(root, requestDigest),
    ).resolves.toBeUndefined();

    const deletedRoot = await makeRoot();
    const beforeDelete = await createLocalDigestProtector(deletedRoot);
    await unlink(path.join(deletedRoot, ".local-digest-key.json"));
    const afterDelete = await createLocalDigestProtector(deletedRoot);
    expect(afterDelete?.keyId).not.toBe(beforeDelete?.keyId);

    const legacyRoot = await makeRoot();
    await mkdir(path.join(legacyRoot, "existing-state"), { recursive: true });
    await expect(
      protectToolCallRequestDigest(legacyRoot, requestDigest),
    ).resolves.toMatch(/^[a-f0-9]{64}$/);
  });

  it("records, replays, and completes a call without an age limit", async () => {
    const root = await makeRoot();
    const input = baseInput();

    await expect(completeToolCallPost(root, input)).resolves.toBe(
      "OUT_OF_ORDER",
    );
    await expect(recordToolCallPre(root, input)).resolves.toEqual({
      decision: allow,
      journalStatus: "PENDING",
      kind: "RECORDED",
    });
    await expect(
      recordToolCallPre(root, { ...input, decision: block }),
    ).resolves.toEqual({
      decision: allow,
      journalStatus: "PENDING",
      kind: "REPLAY",
    });
    await expect(hasPendingToolCalls(root, input)).resolves.toBe("PENDING");

    await expect(completeToolCallPost(root, input)).resolves.toBe("COMPLETED");
    await expect(completeToolCallPost(root, input)).resolves.toBe("DUPLICATE");
    await expect(hasPendingToolCalls(root, input)).resolves.toBe("NONE");
  });

  it("reports exact persistent ids for v2 pending and complete calls", async () => {
    const root = await makeRoot();
    const pending = baseInput("pending-raw-id");
    const completed = baseInput("completed-raw-id");
    await recordToolCallPre(root, pending);
    await recordToolCallPre(root, completed);
    await completeToolCallPost(root, completed);

    await expect(inspectToolCallJournal(root, pending)).resolves.toEqual({
      completedToolUseIds: [persistentToolUseId(completed.toolUseId)],
      kind: "KNOWN",
      legacyPending: false,
      pendingToolUseIds: [persistentToolUseId(pending.toolUseId)],
    });

    const directory = await journalDirectory(root);
    const markers = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    for (const filename of markers) {
      const persisted = JSON.parse(
        await readFile(path.join(directory, filename), "utf8"),
      ) as Record<string, unknown>;
      expect(persisted).toMatchObject({ schemaVersion: 2 });
      expect(persisted).not.toHaveProperty("toolUseId");
      expect(JSON.stringify(persisted)).not.toMatch(
        /pending-raw-id|completed-raw-id/,
      );
    }
  });

  it("retires only the active index and keeps the durable replay decision", async () => {
    const root = await makeRoot();
    const input = baseInput("retired-call");
    await recordToolCallPre(root, input);
    await completeToolCallPost(root, input);

    await expect(retireCompletedToolCall(root, input)).resolves.toBe("RETIRED");
    await expect(retireCompletedToolCall(root, input)).resolves.toBe(
      "ALREADY_RETIRED",
    );
    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      completedToolUseIds: [],
      kind: "KNOWN",
      legacyPending: false,
      pendingToolUseIds: [],
    });
    await expect(recordToolCallPre(root, input)).resolves.toMatchObject({
      journalStatus: "COMPLETE",
      kind: "REPLAY",
    });
  });

  it("sweeps completed entries only after state stops retaining them", async () => {
    const root = await makeRoot();
    const retained = baseInput("retained-complete-call");
    const retired = baseInput("swept-complete-call");
    for (const input of [retained, retired]) {
      await recordToolCallPre(root, input);
      await completeToolCallPost(root, input);
    }

    await expect(
      retireCompletedToolCalls(root, retained, [
        persistentToolUseId(retained.toolUseId),
      ]),
    ).resolves.toBe("RETIRED");
    await expect(inspectToolCallJournal(root, retained)).resolves.toEqual({
      completedToolUseIds: [persistentToolUseId(retained.toolUseId)],
      kind: "KNOWN",
      legacyPending: false,
      pendingToolUseIds: [],
    });
    await expect(retireCompletedToolCalls(root, retained, [])).resolves.toBe(
      "RETIRED",
    );
    await expect(inspectToolCallJournal(root, retained)).resolves.toEqual({
      completedToolUseIds: [],
      kind: "KNOWN",
      legacyPending: false,
      pendingToolUseIds: [],
    });
  });

  it("recovers an interrupted pending-index commit from Post", async () => {
    const root = await makeRoot();
    const input = baseInput("index-intent-crash-call");
    await recordToolCallPre(root, input);
    const directory = await journalDirectory(root);
    const [canonical] = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    const active = path.join(directory, "active");
    await rename(
      path.join(active, canonical!),
      path.join(active, canonical!.replace(/\.json$/, ".indexing")),
    );
    await unlink(path.join(directory, canonical!));

    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      kind: "UNKNOWN",
    });
    await expect(completeToolCallPost(root, input)).resolves.toBe("COMPLETED");
    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      completedToolUseIds: [persistentToolUseId(input.toolUseId)],
      kind: "KNOWN",
      legacyPending: false,
      pendingToolUseIds: [],
    });
  });

  it("does not erase a dirty intent that disagrees with canonical history", async () => {
    const root = await makeRoot();
    const input = baseInput("conflicting-index-intent-call");
    await recordToolCallPre(root, input);
    const directory = await journalDirectory(root);
    const [canonical] = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    const active = path.join(directory, "active");
    await rename(
      path.join(active, canonical!),
      path.join(active, canonical!.replace(/\.json$/, ".indexing")),
    );
    await unlink(path.join(directory, canonical!));

    await expect(
      recordToolCallPre(root, { ...input, decision: block }),
    ).resolves.toEqual({
      decision: block,
      journalStatus: "COMPLETE",
      kind: "RECORDED",
    });
    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      kind: "UNKNOWN",
    });
  });

  it("ignores only strict stale index temporaries", async () => {
    const root = await makeRoot();
    const input = baseInput("sentinel-temporary-call");
    await recordToolCallPre(root, input);
    const directory = await journalDirectory(root);
    const active = path.join(directory, "active");
    const [canonical] = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    await writeFile(
      path.join(
        active,
        ".active-index-v1.00000000-0000-4000-8000-000000000000.tmp",
      ),
      '{"schemaVersion":1}\n',
      { mode: 0o600 },
    );
    await writeFile(
      path.join(
        active,
        `.${canonical!.replace(/\.json$/, "")}.00000000-0000-4000-8000-000000000000.tmp`,
      ),
      "partial\n",
      { mode: 0o600 },
    );

    await expect(inspectToolCallJournal(root, input)).resolves.toMatchObject({
      kind: "KNOWN",
      pendingToolUseIds: [persistentToolUseId(input.toolUseId)],
    });
  });

  it("stops trusting an active directory with excessive temporary debris", async () => {
    const root = await makeRoot();
    const input = baseInput("temporary-debris-call");
    await recordToolCallPre(root, input);
    const directory = await journalDirectory(root);
    const active = path.join(directory, "active");
    const [canonical] = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    const digest = canonical!.replace(/\.json$/, "");
    const temporaries = Array.from(
      { length: MAX_ACTIVE_INDEX_ENTRIES },
      (_, index) =>
        path.join(
          active,
          `.${digest}.${index.toString(16).padStart(36, "0")}.tmp`,
        ),
    );
    for (let offset = 0; offset < temporaries.length; offset += 64) {
      await Promise.all(
        temporaries
          .slice(offset, offset + 64)
          .map((filename) => writeFile(filename, "partial\n", { mode: 0o600 })),
      );
    }

    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      kind: "UNKNOWN",
    });
  }, 60_000);

  it("bounds activation work when the active index exceeds its ceiling", async () => {
    const root = await makeRoot();
    const inputs = Array.from(
      { length: MAX_ACTIVE_TOOL_CALLS + 1 },
      (_, index) => baseInput(`active-ceiling-${index}`),
    );
    for (let offset = 0; offset < inputs.length; offset += 64) {
      await Promise.all(
        inputs
          .slice(offset, offset + 64)
          .map((input) => recordToolCallPre(root, input)),
      );
    }

    await expect(inspectToolCallJournal(root, inputs[0]!)).resolves.toEqual({
      kind: "UNKNOWN",
    });
  }, 60_000);

  it("keeps an unindexed legacy journal unknown and preserves duplicate replay", async () => {
    const root = await makeRoot();
    const input = baseInput("legacy-layout-call");
    await recordToolCallPre(root, input);
    await recordToolCallPre(root, baseInput("legacy-layout-other-call"));
    const directory = await journalDirectory(root);
    const active = path.join(directory, "active");
    for (const indexed of await readdir(active)) {
      await unlink(path.join(active, indexed));
    }
    await rmdir(active);

    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      kind: "UNKNOWN",
    });
    await expect(
      recordToolCallPre(root, {
        ...baseInput("unrelated-blocking-call"),
        decision: block,
      }),
    ).resolves.toMatchObject({ kind: "RECORDED" });
    await expect(recordToolCallPre(root, input)).resolves.toMatchObject({
      journalStatus: "PENDING",
      kind: "REPLAY",
    });
    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      kind: "UNKNOWN",
    });
    expect(
      (await readdir(directory)).filter((name) => name.endsWith(".json")),
    ).toHaveLength(3);
  });

  it("makes one concurrent Pre the durable decision", async () => {
    const root = await makeRoot();
    const results = await Promise.all(
      Array.from({ length: 24 }, () => recordToolCallPre(root, baseInput())),
    );

    expect(results.filter((result) => result.kind === "RECORDED")).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.kind === "REPLAY")).toHaveLength(
      23,
    );
    expect(
      results.every(
        (result) =>
          result.kind === "RECORDED" ||
          (result.kind === "REPLAY" &&
            JSON.stringify(result.decision) === JSON.stringify(allow)),
      ),
    ).toBe(true);
  });

  it("makes concurrent Post delivery idempotent", async () => {
    const root = await makeRoot();
    const input = baseInput();
    await recordToolCallPre(root, input);

    const results = await Promise.all(
      Array.from({ length: 24 }, () => completeToolCallPost(root, input)),
    );
    expect(results.filter((result) => result === "COMPLETED")).toHaveLength(1);
    expect(results.filter((result) => result === "DUPLICATE")).toHaveLength(23);
    await expect(hasPendingToolCalls(root, input)).resolves.toBe("NONE");
  });

  it("rejects reuse of one id with a different request or profile binding", async () => {
    const root = await makeRoot();
    const input = baseInput();
    await recordToolCallPre(root, input);

    await expect(
      recordToolCallPre(root, {
        ...input,
        bindingDigest: "c".repeat(64),
      }),
    ).resolves.toEqual({ kind: "MISMATCH" });
    await expect(
      recordToolCallPre(root, {
        ...input,
        requestDigest: "d".repeat(64),
      }),
    ).resolves.toEqual({ kind: "MISMATCH" });
  });

  it("keeps blocking decisions complete and rejects their Post", async () => {
    const root = await makeRoot();
    const input = { ...baseInput(), decision: block };

    await expect(recordToolCallPre(root, input)).resolves.toEqual({
      decision: block,
      journalStatus: "COMPLETE",
      kind: "RECORDED",
    });
    await expect(hasPendingToolCalls(root, input)).resolves.toBe("NONE");
    await expect(completeToolCallPost(root, input)).resolves.toBe(
      "OUT_OF_ORDER",
    );
  });

  it("keeps one active call fast after 1024 retired native calls", async () => {
    const root = await makeRoot();
    const retired = Array.from({ length: 1_024 }, (_, index) =>
      baseInput(`retired-call-${index}`),
    );
    for (let offset = 0; offset < retired.length; offset += 64) {
      const results = await Promise.all(
        retired.slice(offset, offset + 64).map(async (input) => ({
          post: await recordToolCallPre(root, input).then(async (pre) =>
            pre.kind === "RECORDED"
              ? completeToolCallPost(root, input)
              : "UNAVAILABLE",
          ),
          retired: await retireCompletedToolCall(root, input),
        })),
      );
      expect(
        results.every(
          (result) =>
            result.post === "COMPLETED" && result.retired === "RETIRED",
        ),
      ).toBe(true);
    }
    const pending = baseInput("pending-after-history");
    await expect(recordToolCallPre(root, pending)).resolves.toMatchObject({
      kind: "RECORDED",
    });

    const directory = await journalDirectory(root);
    const files = await readdir(directory);
    expect(files.filter((name) => name.endsWith(".json"))).toHaveLength(1_025);
    expect(files.filter((name) => name.endsWith(".post"))).toHaveLength(1_024);
    expect(
      (await readdir(path.join(directory, "active"))).filter((name) =>
        name.endsWith(".json"),
      ),
    ).toHaveLength(1);

    const durations: number[] = [];
    for (let run = 0; run < 10; run += 1) {
      const startedAt = performance.now();
      await expect(inspectToolCallJournal(root, pending)).resolves.toEqual({
        completedToolUseIds: [],
        kind: "KNOWN",
        legacyPending: false,
        pendingToolUseIds: [persistentToolUseId(pending.toolUseId)],
      });
      durations.push(performance.now() - startedAt);
    }
    durations.sort((left, right) => left - right);
    expect(durations[Math.ceil(durations.length * 0.95) - 1]).toBeLessThan(750);
  }, 60_000);

  it("recovers a receipt-first Post crash without reporting a pending call", async () => {
    const root = await makeRoot();
    const input = baseInput();
    await recordToolCallPre(root, input);
    const directory = await journalDirectory(root);
    const [markerName] = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    const marker = JSON.parse(
      await readFile(path.join(directory, markerName!), "utf8"),
    ) as Record<string, unknown>;
    await writeFile(
      path.join(directory, markerName!.replace(/\.json$/, ".post")),
      `${JSON.stringify({ ...marker, status: "COMPLETE" })}\n`,
      { mode: 0o600 },
    );

    await expect(hasPendingToolCalls(root, input)).resolves.toBe("NONE");
    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      completedToolUseIds: [persistentToolUseId(input.toolUseId)],
      kind: "KNOWN",
      legacyPending: false,
      pendingToolUseIds: [],
    });
    await expect(completeToolCallPost(root, input)).resolves.toBe("DUPLICATE");
    expect(
      JSON.parse(await readFile(path.join(directory, markerName!), "utf8")),
    ).toMatchObject({ status: "COMPLETE" });
  });

  it("returns unknown or unavailable for corruption and I/O failures", async () => {
    const root = await makeRoot();
    const input = baseInput();
    await recordToolCallPre(root, input);
    const directory = await journalDirectory(root);
    const [marker] = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    await writeFile(path.join(directory, marker!), "not-json\n", {
      mode: 0o600,
    });

    await expect(hasPendingToolCalls(root, input)).resolves.toBe("UNKNOWN");
    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      kind: "UNKNOWN",
    });
    await expect(recordToolCallPre(root, input)).resolves.toEqual({
      kind: "UNAVAILABLE",
    });
    await expect(completeToolCallPost(root, input)).resolves.toBe(
      "UNAVAILABLE",
    );

    const unavailableRoot = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-tool-call-")),
      "file",
    );
    await writeFile(unavailableRoot, "fixture", { mode: 0o600 });
    await expect(recordToolCallPre(unavailableRoot, input)).resolves.toEqual({
      kind: "UNAVAILABLE",
    });
    await expect(hasPendingToolCalls(unavailableRoot, input)).resolves.toBe(
      "UNKNOWN",
    );
  });

  it.each(["missing", "replaced"] as const)(
    "rejects a %s canonical marker behind a valid active index",
    async (mutation) => {
      const root = await makeRoot();
      const input = baseInput(`canonical-${mutation}`);
      await recordToolCallPre(root, input);
      const directory = await journalDirectory(root);
      const [canonical] = (await readdir(directory)).filter((name) =>
        name.endsWith(".json"),
      );
      const canonicalPath = path.join(directory, canonical!);
      if (mutation === "missing") {
        await unlink(canonicalPath);
      } else {
        const replacement = `${canonicalPath}.replacement`;
        await writeFile(replacement, "not-json\n", { mode: 0o600 });
        await rename(replacement, canonicalPath);
      }

      await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
        kind: "UNKNOWN",
      });
    },
  );

  it("rejects a terminal marker forged into the active index", async () => {
    const root = await makeRoot();
    const input = baseInput("terminal-active-entry");
    await recordToolCallPre(root, input);
    await completeToolCallPost(root, input);
    const directory = await journalDirectory(root);
    const [canonical] = (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    );
    const active = path.join(directory, "active", canonical!);
    await unlink(active);
    await link(path.join(directory, canonical!), active);

    await expect(inspectToolCallJournal(root, input)).resolves.toEqual({
      kind: "UNKNOWN",
    });
  });

  it("flags legacy pending calls but ignores completed legacy decisions", async () => {
    const root = await makeRoot();
    const scope = baseInput("legacy-pending");
    await recordToolCallPre(root, scope);
    await recordToolCallPre(root, {
      ...baseInput("legacy-complete"),
      decision: block,
    });

    const directory = await journalDirectory(root);
    let pendingPath: string | undefined;
    for (const filename of (await readdir(directory)).filter((name) =>
      name.endsWith(".json"),
    )) {
      const markerPath = path.join(directory, filename);
      const marker = JSON.parse(await readFile(markerPath, "utf8")) as Record<
        string,
        unknown
      >;
      if (marker.status === "PENDING") pendingPath = markerPath;
      delete marker.persistentToolUseId;
      marker.schemaVersion = 1;
      await writeFile(markerPath, `${JSON.stringify(marker)}\n`, {
        mode: 0o600,
      });
      if (marker.status === "PENDING") {
        await writeFile(
          path.join(directory, "active", filename),
          `${JSON.stringify(marker)}\n`,
          { mode: 0o600 },
        );
      }
    }

    await expect(inspectToolCallJournal(root, scope)).resolves.toEqual({
      completedToolUseIds: [],
      kind: "KNOWN",
      legacyPending: true,
      pendingToolUseIds: [],
    });
    expect(pendingPath).toBeDefined();
    await unlink(path.join(directory, "active", path.basename(pendingPath!)));
    await unlink(pendingPath!);
    await expect(inspectToolCallJournal(root, scope)).resolves.toEqual({
      completedToolUseIds: [],
      kind: "KNOWN",
      legacyPending: false,
      pendingToolUseIds: [],
    });
  });

  it("returns unknown for conflicting persistent ids", async () => {
    const root = await makeRoot();
    const scope = baseInput("conflict-a");
    await recordToolCallPre(root, scope);
    await recordToolCallPre(root, baseInput("conflict-b"));
    const directory = await journalDirectory(root);
    const markerPaths = (await readdir(directory))
      .filter((name) => name.endsWith(".json"))
      .map((name) => path.join(directory, name));
    const first = JSON.parse(await readFile(markerPaths[0]!, "utf8")) as Record<
      string,
      unknown
    >;
    const second = JSON.parse(
      await readFile(markerPaths[1]!, "utf8"),
    ) as Record<string, unknown>;
    second.persistentToolUseId = first.persistentToolUseId;
    await writeFile(markerPaths[1]!, `${JSON.stringify(second)}\n`, {
      mode: 0o600,
    });

    await expect(inspectToolCallJournal(root, scope)).resolves.toEqual({
      kind: "UNKNOWN",
    });
  });

  it("uses private modes and persists no raw identifiers or page data", async () => {
    const root = await makeRoot();
    const input = {
      ...baseInput("raw-tool/canary"),
      pageData: "page-secret-canary",
      sessionId: "raw-session/canary",
      taskId: "raw-task/canary",
    };
    await recordToolCallPre(root, input);
    await completeToolCallPost(root, input);

    const [session] = await readdir(root);
    const sessionDirectory = path.join(root, session!);
    const [task] = await readdir(sessionDirectory);
    const taskDirectory = path.join(sessionDirectory, task!);
    const directory = path.join(taskDirectory, "tool-calls");
    const active = path.join(directory, "active");
    const files = (await readdir(directory)).filter(
      (name) => name !== "active",
    );
    const activeFiles = await readdir(active);
    const activeJournalFiles = activeFiles.filter(
      (name) => name !== ".active-index-v1",
    );
    const persisted = (
      await Promise.all(
        [
          ...files.map((filename) => path.join(directory, filename)),
          ...activeFiles.map((filename) => path.join(active, filename)),
        ].map((filename) => readFile(filename, "utf8")),
      )
    ).join("\n");

    expect(
      `${session}/${task}/${files.join("/")}/${activeFiles.join("/")}/${persisted}`,
    ).not.toMatch(/raw-(session|task|tool)\/canary|page-secret-canary/);
    expect(files).toHaveLength(2);
    expect(activeFiles).toHaveLength(2);
    expect(activeJournalFiles).toHaveLength(1);
    expect(
      files.every((name) => /^[a-f0-9]{64}\.(json|post)$/.test(name)),
    ).toBe(true);
    expect(activeJournalFiles[0]).toMatch(/^[a-f0-9]{64}\.json$/);
    for (const filename of [
      ...files.map((name) => path.join(directory, name)),
      ...activeFiles.map((name) => path.join(active, name)),
    ]) {
      expect((await stat(filename)).mode & 0o777).toBe(0o600);
    }
    for (const item of [
      root,
      sessionDirectory,
      taskDirectory,
      directory,
      active,
    ]) {
      expect((await stat(item)).mode & 0o777).toBe(0o700);
    }
  });
});
