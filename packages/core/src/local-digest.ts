import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";

import { readBoundedPrivateFile } from "./store.js";

const KEY_BYTES = 32;
const KEY_FILE = ".local-digest-key.json";
const KEY_FILE_BYTES = 256;
const DIGEST = /^[a-f0-9]{64}$/;
const PURPOSES = new Set<LocalDigestPurpose>([
  "action-input-v1",
  "action-target-v1",
  "tool-call-request-v1",
]);

export type LocalDigestPurpose =
  | "action-input-v1"
  | "action-target-v1"
  | "tool-call-request-v1";

export interface LocalDigestProtector {
  readonly keyId: string;
  protect(purpose: LocalDigestPurpose, digest: string): string;
}

interface LocalDigestKeyRecord {
  algorithm: "HMAC-SHA256";
  key: string;
  keyId: string;
  schemaVersion: 1;
}

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;

const keyId = (key: Buffer): string =>
  createHash("sha256")
    .update("oxrail-local-digest-key-id-v1\0")
    .update(key)
    .digest("hex");

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("local digest path is not a directory");
  }
  await chmod(directory, 0o700);
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

function parseKeyRecord(value: unknown): {
  key: Buffer;
  record: LocalDigestKeyRecord;
} {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "algorithm,key,keyId,schemaVersion"
  ) {
    throw new Error("invalid local digest key record");
  }
  const record = value as Partial<LocalDigestKeyRecord>;
  const key =
    typeof record.key === "string" ? Buffer.from(record.key, "base64") : null;
  if (
    record.schemaVersion !== 1 ||
    record.algorithm !== "HMAC-SHA256" ||
    !key ||
    key.byteLength !== KEY_BYTES ||
    key.toString("base64") !== record.key ||
    record.keyId !== keyId(key)
  ) {
    throw new Error("invalid local digest key record");
  }
  return { key, record: record as LocalDigestKeyRecord };
}

async function loadKeyRecord(filename: string) {
  const { contents } = await readBoundedPrivateFile(
    filename,
    KEY_FILE_BYTES,
    "UNAVAILABLE",
  );
  return parseKeyRecord(JSON.parse(contents.toString("utf8")));
}

async function localDigestKey(root: string) {
  await privateDirectory(root);
  const destination = path.join(root, KEY_FILE);
  try {
    return await loadKeyRecord(destination);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const key = randomBytes(KEY_BYTES);
  const record: LocalDigestKeyRecord = {
    algorithm: "HMAC-SHA256",
    key: key.toString("base64"),
    keyId: keyId(key),
    schemaVersion: 1,
  };
  const temporary = path.join(root, `.${randomUUID()}.key.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(record)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      await syncDirectory(root);
      return { key, record };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return await loadKeyRecord(destination);
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

/** Creates purpose-separated HMACs for derived values persisted by Oxrail. */
export async function createLocalDigestProtector(
  root: string,
): Promise<LocalDigestProtector | undefined> {
  try {
    const { key, record } = await localDigestKey(root);
    return {
      keyId: record.keyId,
      protect(purpose, digest) {
        if (!PURPOSES.has(purpose) || !DIGEST.test(digest)) {
          throw new TypeError("invalid local digest input");
        }
        return createHmac("sha256", key)
          .update("oxrail-local-digest-v1\0")
          .update(purpose)
          .update("\0")
          .update(digest)
          .digest("hex");
      },
    };
  } catch {
    return;
  }
}

export async function protectLocalDigest(
  root: string,
  purpose: LocalDigestPurpose,
  digest: string,
): Promise<string | undefined> {
  try {
    return (await createLocalDigestProtector(root))?.protect(purpose, digest);
  } catch {
    return;
  }
}
