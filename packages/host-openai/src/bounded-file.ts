import { constants } from "node:fs";
import { chmod, lstat, mkdir, open } from "node:fs/promises";
import path from "node:path";

function relativePath(root: string, filename: string): string {
  const relative = path.relative(path.resolve(root), path.resolve(filename));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("path escapes its local root");
  }
  return relative;
}

async function rejectSymlinkPath(root: string, filename: string) {
  const relative = relativePath(root, filename);
  let current = path.resolve(root);
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) current = path.join(current, segment);
    const stats = await lstat(current);
    if (stats.isSymbolicLink())
      throw new Error("symbolic links are not allowed");
    if (current !== path.resolve(filename) && !stats.isDirectory()) {
      throw new Error("path ancestor is not a directory");
    }
  }
}

export async function readBoundedRegularFile(
  filename: string,
  maximumBytes: number,
  root = path.dirname(filename),
) {
  if (process.platform === "win32") {
    throw new Error("bounded no-follow reads are unsupported on Windows");
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new TypeError("maximumBytes must be a non-negative safe integer");
  }
  await rejectSymlinkPath(root, filename);
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("path is not a regular file");
    if (stats.size > maximumBytes) throw new Error("file exceeds local limit");

    const value = Buffer.alloc(maximumBytes + 1);
    let length = 0;
    while (length < value.length) {
      const { bytesRead } = await handle.read(
        value,
        length,
        value.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maximumBytes) throw new Error("file exceeds local limit");
    return value.subarray(0, length);
  } finally {
    await handle.close();
  }
}

/** Creates a private directory tree without traversing a pre-existing symlink. */
export async function ensurePrivateDirectoryPath(
  root: string,
  directory: string,
): Promise<void> {
  const relative = relativePath(root, directory);
  let current = path.resolve(root);
  await mkdir(current, { recursive: true, mode: 0o700 });
  for (const segment of ["", ...relative.split(path.sep).filter(Boolean)]) {
    if (segment) {
      current = path.join(current, segment);
      await mkdir(current, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    }
    const stats = await lstat(current);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("private path is not a real directory");
    }
    await chmod(current, 0o700);
  }
}
