import { randomUUID } from "node:crypto";
import { open, mkdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import {
  EvidenceManifestSchema,
  EvidenceTraceSchema,
  type EvidenceManifest,
  type EvidenceTrace,
} from "../../protocol/src/index.js";

import { sanitizeForEvidence, sanitizedJson } from "./sanitize.js";

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      !error ||
      typeof error !== "object" ||
      !("code" in error) ||
      !["EINVAL", "ENOTSUP", "EPERM", "EISDIR"].includes(String(error.code))
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteSanitizedJson(
  path: string,
  value: unknown,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporaryPath = join(
    directory,
    `.${basename(path)}.${randomUUID()}.tmp`,
  );
  const contents = sanitizedJson(value);
  let handle;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, path);
    await syncDirectory(directory);
  } catch (error) {
    await handle?.close();
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function writeEvidenceManifest(
  path: string,
  input: unknown,
): Promise<EvidenceManifest> {
  const parsed = EvidenceManifestSchema.parse(input);
  const sanitized = EvidenceManifestSchema.parse(sanitizeForEvidence(parsed));
  await atomicWriteSanitizedJson(path, sanitized);
  return sanitized;
}

export async function writeEvidenceTrace(
  path: string,
  input: unknown,
): Promise<EvidenceTrace> {
  const parsed = EvidenceTraceSchema.parse(input);
  const sanitized = EvidenceTraceSchema.parse(sanitizeForEvidence(parsed));
  await atomicWriteSanitizedJson(path, sanitized);
  return sanitized;
}
