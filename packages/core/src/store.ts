import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  BrowserTaskStateSchema,
  type BrowserTaskState,
} from "../../protocol/src/index.js";
import { sanitizeBrowserTaskStateForPersistence } from "./safe-state.js";

export const MAX_BROWSER_TASK_STATE_BYTES = 64 * 1024;
const LOCK_STALE_MS = 30_000;
const MAX_LOCK_BYTES = 512;

export type BrowserTaskStateStoreErrorCode =
  | "CONFLICT"
  | "CORRUPT"
  | "INVALID_STATE"
  | "TOO_LARGE"
  | "UNAVAILABLE";

const errorMessages: Record<BrowserTaskStateStoreErrorCode, string> = {
  CONFLICT: "BrowserTaskState version conflict",
  CORRUPT: "BrowserTaskState is corrupt",
  INVALID_STATE: "BrowserTaskState is invalid",
  TOO_LARGE: "BrowserTaskState exceeds the local size limit",
  UNAVAILABLE: "BrowserTaskState storage is unavailable",
};

export class BrowserTaskStateStoreError extends Error {
  constructor(readonly code: BrowserTaskStateStoreErrorCode) {
    super(errorMessages[code]);
    this.name = "BrowserTaskStateStoreError";
  }
}

export interface BrowserTaskScope {
  sessionId: string;
  taskId: string;
}

const digestName = (domain: string, value: string) =>
  createHash("sha256").update(domain).update("\0").update(value).digest("hex");

function assertScope(scope: BrowserTaskScope): void {
  if (!scope.sessionId || !scope.taskId) {
    throw new BrowserTaskStateStoreError("INVALID_STATE");
  }
}

const taskDirectory = (root: string, scope: BrowserTaskScope) =>
  path.join(
    root,
    digestName("oxrail-session-state-v1", scope.sessionId),
    digestName("oxrail-browser-task-state-v1", scope.taskId),
  );

const statePath = (root: string, scope: BrowserTaskScope) =>
  path.join(taskDirectory(root, scope), "browser-task-state.json");

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;

interface LockSnapshot {
  createdAt: number;
  device: bigint;
  inode: bigint;
  modifiedAt: number;
  nonce: string;
  pid: number;
}

async function readLock(lockPath: string): Promise<LockSnapshot | undefined> {
  let handle;
  try {
    handle = await open(lockPath, "r");
    const metadata = await handle.stat({ bigint: true });
    if (metadata.size > BigInt(MAX_LOCK_BYTES)) return undefined;
    const contents = await handle.readFile();
    if (contents.byteLength > MAX_LOCK_BYTES) return undefined;
    const value: unknown = JSON.parse(contents.toString("utf8"));
    if (!value || typeof value !== "object") return undefined;
    const lock = value as Partial<{
      createdAt: number;
      nonce: string;
      pid: number;
      schemaVersion: number;
    }>;
    if (
      lock.schemaVersion !== 1 ||
      !Number.isSafeInteger(lock.createdAt) ||
      lock.createdAt! < 0 ||
      !Number.isSafeInteger(lock.pid) ||
      lock.pid! <= 0 ||
      typeof lock.nonce !== "string" ||
      !/^[a-f0-9-]{36}$/.test(lock.nonce)
    ) {
      return undefined;
    }
    return {
      createdAt: lock.createdAt!,
      device: metadata.dev,
      inode: metadata.ino,
      modifiedAt: Number(metadata.mtimeMs),
      nonce: lock.nonce,
      pid: lock.pid!,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close();
  }
}

function processIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

const sameLock = (left: LockSnapshot, right: LockSnapshot) =>
  left.createdAt === right.createdAt &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.modifiedAt === right.modifiedAt &&
  left.nonce === right.nonce &&
  left.pid === right.pid;

async function recoverStaleLock(
  lockPath: string,
  now: number,
): Promise<boolean> {
  const stale = await readLock(lockPath);
  if (
    !stale ||
    now - Math.max(stale.createdAt, stale.modifiedAt) < LOCK_STALE_MS ||
    !processIsDead(stale.pid)
  ) {
    return false;
  }
  const claimPath = `${lockPath}.recovered-${stale.nonce}`;
  try {
    await link(lockPath, claimPath);
  } catch {
    return false;
  }
  const claimed = await readLock(claimPath);
  const current = await readLock(lockPath);
  if (
    !claimed ||
    !current ||
    !sameLock(stale, claimed) ||
    !sameLock(claimed, current) ||
    !processIsDead(current.pid)
  ) {
    await unlink(claimPath).catch(() => undefined);
    return false;
  }
  try {
    await unlink(lockPath);
    // ponytail: keep one <=512-byte generation tombstone per recovered crash;
    // add retention only if recovery artifacts become material.
    return true;
  } catch {
    await unlink(claimPath).catch(() => undefined);
    return false;
  }
}

async function tryCreateLock(
  lockPath: string,
): Promise<LockSnapshot | undefined> {
  const nonce = randomUUID();
  const createdAt = Date.now();
  const temporary = `${lockPath}.${nonce}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt, nonce })}\n`,
      "utf8",
    );
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    await handle.close();
    handle = undefined;
    await link(temporary, lockPath);
    return {
      createdAt,
      device: metadata.dev,
      inode: metadata.ino,
      modifiedAt: Number(metadata.mtimeMs),
      nonce,
      pid: process.pid,
    };
  } catch (error) {
    if (errorCode(error) === "EEXIST") return undefined;
    throw new BrowserTaskStateStoreError("UNAVAILABLE");
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function acquireLock(lockPath: string): Promise<LockSnapshot> {
  const acquired = await tryCreateLock(lockPath);
  if (acquired) return acquired;
  if (!(await recoverStaleLock(lockPath, Date.now()))) {
    throw new BrowserTaskStateStoreError("CONFLICT");
  }
  const recovered = await tryCreateLock(lockPath);
  if (!recovered) throw new BrowserTaskStateStoreError("CONFLICT");
  return recovered;
}

async function releaseLock(
  lockPath: string,
  ownership: LockSnapshot,
): Promise<void> {
  const current = await readLock(lockPath);
  if (!current || !sameLock(current, ownership)) return;
  await unlink(lockPath).catch(() => undefined);
}

async function readStateFile(
  filename: string,
  scope: BrowserTaskScope,
): Promise<BrowserTaskState | undefined> {
  let handle;
  try {
    handle = await open(filename, "r");
    if ((await handle.stat()).size > MAX_BROWSER_TASK_STATE_BYTES) {
      throw new BrowserTaskStateStoreError("TOO_LARGE");
    }
    const contents = await handle.readFile();
    if (contents.byteLength > MAX_BROWSER_TASK_STATE_BYTES) {
      throw new BrowserTaskStateStoreError("TOO_LARGE");
    }
    let value: unknown;
    try {
      value = JSON.parse(contents.toString("utf8"));
    } catch {
      throw new BrowserTaskStateStoreError("CORRUPT");
    }
    const parsed = BrowserTaskStateSchema.safeParse(value);
    if (
      !parsed.success ||
      parsed.data.sessionId !== scope.sessionId ||
      parsed.data.taskId !== scope.taskId
    ) {
      throw new BrowserTaskStateStoreError("CORRUPT");
    }
    return parsed.data;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    if (error instanceof BrowserTaskStateStoreError) throw error;
    throw new BrowserTaskStateStoreError("UNAVAILABLE");
  } finally {
    await handle?.close();
  }
}

async function makePrivateDirectory(directory: string): Promise<void> {
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  } catch {
    throw new BrowserTaskStateStoreError("UNAVAILABLE");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      !["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(errorCode(error) ?? "")
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export async function readBrowserTaskState(
  root: string,
  scope: BrowserTaskScope,
): Promise<BrowserTaskState | undefined> {
  assertScope(scope);
  return readStateFile(statePath(root, scope), scope);
}

export async function writeBrowserTaskState(
  root: string,
  state: BrowserTaskState,
  expectedStateVersion: number | null,
): Promise<void> {
  const parsed = BrowserTaskStateSchema.safeParse(state);
  if (!parsed.success) throw new BrowserTaskStateStoreError("INVALID_STATE");
  if (
    expectedStateVersion !== null &&
    (!Number.isSafeInteger(expectedStateVersion) || expectedStateVersion < 0)
  ) {
    throw new BrowserTaskStateStoreError("INVALID_STATE");
  }
  const scope = { sessionId: state.sessionId, taskId: state.taskId };
  assertScope(scope);
  const sanitized = sanitizeBrowserTaskStateForPersistence(parsed.data);
  const contents = `${JSON.stringify(sanitized)}\n`;
  if (Buffer.byteLength(contents) > MAX_BROWSER_TASK_STATE_BYTES) {
    throw new BrowserTaskStateStoreError("TOO_LARGE");
  }

  const directory = taskDirectory(root, scope);
  await makePrivateDirectory(root);
  await makePrivateDirectory(path.dirname(directory));
  await makePrivateDirectory(directory);
  const destination = statePath(root, scope);
  const lockPath = path.join(directory, ".browser-task-state.lock");
  const ownership = await acquireLock(lockPath);
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  try {
    const current = await readStateFile(destination, scope);
    if (
      expectedStateVersion === null
        ? current !== undefined || state.stateVersion !== 0
        : current?.stateVersion !== expectedStateVersion ||
          state.stateVersion !== expectedStateVersion + 1
    ) {
      throw new BrowserTaskStateStoreError("CONFLICT");
    }

    let handle;
    try {
      handle = await open(temporary, "wx", 0o600);
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, destination);
      await chmod(destination, 0o600);
      await syncDirectory(directory);
    } catch (error) {
      await handle?.close();
      await unlink(temporary).catch(() => undefined);
      if (error instanceof BrowserTaskStateStoreError) throw error;
      throw new BrowserTaskStateStoreError("UNAVAILABLE");
    }
  } finally {
    await releaseLock(lockPath, ownership);
  }
}
