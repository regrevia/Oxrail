import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  ensurePrivateDirectoryPath,
  readBoundedRegularFile,
} from "../packages/host-openai/src/bounded-file.js";

const temporaryDirectories: string[] = [];
const run = promisify(execFile);

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

async function temporaryPath(name: string) {
  const directory = await mkdtemp(path.join(tmpdir(), "oxrail-bounded-file-"));
  temporaryDirectories.push(directory);
  return path.join(directory, name);
}

describe("bounded regular-file reads", () => {
  it("accepts a regular file at the byte limit and rejects one byte more", async () => {
    const filename = await temporaryPath("input.json");
    await writeFile(filename, "abc");
    await expect(readBoundedRegularFile(filename, 3)).resolves.toEqual(
      Buffer.from("abc"),
    );
    await writeFile(filename, "abcd");
    await expect(readBoundedRegularFile(filename, 3)).rejects.toThrow(
      "file exceeds local limit",
    );
  });

  it.each(["directory", "symlink"] as const)(
    "rejects a %s leaf",
    async (kind) => {
      const filename = await temporaryPath("input");
      if (kind === "directory") await mkdir(filename);
      else {
        const target = `${filename}.target`;
        await writeFile(target, "safe");
        await symlink(target, filename);
      }

      await expect(readBoundedRegularFile(filename, 16)).rejects.toThrow();
    },
  );

  it("rejects a symlinked ancestor instead of escaping its local root", async () => {
    const root = await temporaryPath("plugin-data");
    const outside = path.join(path.dirname(root), "outside");
    await mkdir(root);
    await mkdir(outside);
    await writeFile(path.join(outside, "profile.json"), "outside");
    await symlink(outside, path.join(root, "hosts"));

    await expect(
      readBoundedRegularFile(
        path.join(root, "hosts", "profile.json"),
        16,
        root,
      ),
    ).rejects.toThrow("symbolic links are not allowed");
  });

  it("does not create private descendants through a symlink", async () => {
    const root = await temporaryPath("plugin-data");
    const outside = path.join(path.dirname(root), "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, path.join(root, "hosts"));

    await expect(
      ensurePrivateDirectoryPath(root, path.join(root, "hosts", "profile")),
    ).rejects.toThrow("private path is not a real directory");
    await expect(stat(path.join(outside, "profile"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects a FIFO without waiting for a writer",
    async () => {
      const filename = await temporaryPath("input.fifo");
      await run("mkfifo", [filename]);

      await expect(readBoundedRegularFile(filename, 16)).rejects.toThrow(
        "path is not a regular file",
      );
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a special device",
    async () => {
      await expect(readBoundedRegularFile("/dev/null", 16)).rejects.toThrow(
        "path is not a regular file",
      );
    },
  );

  it.skipIf(process.platform !== "linux")(
    "enforces the read limit when fstat reports a zero-sized dynamic file",
    async () => {
      const maps = `/proc/${process.pid}/maps`;
      expect((await stat(maps)).size).toBe(0);
      await expect(readBoundedRegularFile(maps, 1)).rejects.toThrow(
        "file exceeds local limit",
      );
    },
  );
});
