import {
  mkdtemp,
  readFile,
  readdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  MAX_TOOL_CALL_SLOTS,
  TOOL_CALL_POST_MAX_AGE_MS,
  claimToolCallPhase,
} from "../packages/core/src/tool-call.js";

describe("tool call phase claims", () => {
  it("claims each ordered phase once within one session/task namespace", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-tool-call-")),
      "state",
    );
    const input = {
      sessionId: "raw-session/canary",
      taskId: "raw-task/canary",
      toolUseId: "raw-tool/canary",
    };

    await expect(
      claimToolCallPhase(root, { ...input, phase: "PostToolUse" }),
    ).resolves.toBe("IGNORED");
    await expect(
      claimToolCallPhase(root, { ...input, phase: "PreToolUse" }),
    ).resolves.toBe("CLAIMED");
    await expect(
      claimToolCallPhase(root, { ...input, phase: "PreToolUse" }),
    ).resolves.toBe("IGNORED");
    await expect(
      claimToolCallPhase(root, { ...input, phase: "PostToolUse" }),
    ).resolves.toBe("CLAIMED");
    await expect(
      claimToolCallPhase(root, { ...input, phase: "PostToolUse" }),
    ).resolves.toBe("IGNORED");
    await expect(
      claimToolCallPhase(root, {
        ...input,
        taskId: "another-task",
        phase: "PreToolUse",
      }),
    ).resolves.toBe("CLAIMED");
  });

  it("allows only one concurrent claim for each phase", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-tool-call-")),
      "state",
    );
    const input = {
      sessionId: "session-1",
      taskId: "task-1",
      toolUseId: "call-1",
    };

    const pre = await Promise.all(
      Array.from({ length: 16 }, () =>
        claimToolCallPhase(root, { ...input, phase: "PreToolUse" }),
      ),
    );
    expect(pre.filter((result) => result === "CLAIMED")).toHaveLength(1);
    expect(pre.filter((result) => result === "IGNORED")).toHaveLength(15);

    const post = await Promise.all(
      Array.from({ length: 16 }, () =>
        claimToolCallPhase(root, { ...input, phase: "PostToolUse" }),
      ),
    );
    expect(post.filter((result) => result === "CLAIMED")).toHaveLength(1);
    expect(post.filter((result) => result === "IGNORED")).toHaveLength(15);
  });

  it("does not let an orphaned candidate block its fixed claim slot", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-tool-call-")),
      "state",
    );
    const input = {
      sessionId: "session-1",
      taskId: "task-1",
      toolUseId: "call-1",
    };
    await claimToolCallPhase(root, { ...input, phase: "PreToolUse" });
    const [sessionName] = await readdir(root);
    const sessionDirectory = path.join(root, sessionName!);
    const [taskName] = await readdir(sessionDirectory);
    const claimDirectory = path.join(sessionDirectory, taskName!, "tool-calls");
    const [preName] = (await readdir(claimDirectory)).filter((name) =>
      name.endsWith(".pre.json"),
    );
    await unlink(path.join(claimDirectory, preName!));
    await writeFile(
      path.join(claimDirectory, `.${preName!.slice(0, 3)}.pre.tmp`),
      "interrupted candidate",
      { mode: 0o600 },
    );

    await expect(
      claimToolCallPhase(root, { ...input, phase: "PreToolUse" }),
    ).resolves.toBe("CLAIMED");
  });

  it("persists only private, bounded, digest-addressed claims", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-tool-call-")),
      "state",
    );
    const input = {
      sessionId: "raw-session/canary",
      taskId: "raw-task/canary",
      toolUseId: "raw-tool/canary",
    };
    await claimToolCallPhase(root, { ...input, phase: "PreToolUse" });
    await claimToolCallPhase(root, { ...input, phase: "PostToolUse" });

    const [sessionName] = await readdir(root);
    const sessionDirectory = path.join(root, sessionName!);
    const [taskName] = await readdir(sessionDirectory);
    const taskDirectory = path.join(sessionDirectory, taskName!);
    const claimDirectory = path.join(taskDirectory, "tool-calls");
    const files = await readdir(claimDirectory);
    const persisted = (
      await Promise.all(
        files.map((filename) =>
          readFile(path.join(claimDirectory, filename), "utf8"),
        ),
      )
    ).join("\n");

    expect(
      `${sessionName}/${taskName}/${files.join("/")}/${persisted}`,
    ).not.toMatch(/raw-(session|task|tool)\/canary/);
    expect(files).toHaveLength(2);
    expect(files.every((filename) => !filename.endsWith(".tmp"))).toBe(true);
    for (const filename of files) {
      const slot = Number.parseInt(filename.slice(0, 3), 16);
      expect(slot).toBeLessThan(MAX_TOOL_CALL_SLOTS);
      expect(
        (await stat(path.join(claimDirectory, filename))).mode & 0o777,
      ).toBe(0o600);
    }
    for (const directory of [
      root,
      sessionDirectory,
      taskDirectory,
      claimDirectory,
    ]) {
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
  });

  it("ignores a Post claim after its matching Pre claim expires", async () => {
    const root = path.join(
      await mkdtemp(path.join(tmpdir(), "oxrail-tool-call-")),
      "state",
    );
    const input = {
      sessionId: "session-1",
      taskId: "task-1",
      toolUseId: "call-1",
    };
    await claimToolCallPhase(root, { ...input, phase: "PreToolUse" });
    const [sessionName] = await readdir(root);
    const sessionDirectory = path.join(root, sessionName!);
    const [taskName] = await readdir(sessionDirectory);
    const claimDirectory = path.join(sessionDirectory, taskName!, "tool-calls");
    const [preName] = (await readdir(claimDirectory)).filter((name) =>
      name.endsWith(".pre.json"),
    );
    const prePath = path.join(claimDirectory, preName!);
    const marker = JSON.parse(await readFile(prePath, "utf8")) as Record<
      string,
      unknown
    >;
    await writeFile(
      prePath,
      `${JSON.stringify({
        ...marker,
        createdAt: Date.now() - TOOL_CALL_POST_MAX_AGE_MS - 1,
      })}\n`,
      { mode: 0o600 },
    );

    await expect(
      claimToolCallPhase(root, { ...input, phase: "PostToolUse" }),
    ).resolves.toBe("IGNORED");
  });

  it("returns IGNORED without exposing invalid input or filesystem errors", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "oxrail-tool-call-"));
    const root = path.join(directory, "not-a-directory");
    await writeFile(root, "filesystem-canary", { mode: 0o600 });
    const input = {
      sessionId: "private-session-canary",
      taskId: "private-task-canary",
      toolUseId: "private-tool-canary",
      phase: "PreToolUse",
    } as const;

    await expect(claimToolCallPhase(root, input)).resolves.toBe("IGNORED");
    await expect(
      claimToolCallPhase(directory, { ...input, toolUseId: "" }),
    ).resolves.toBe("IGNORED");
  });
});
