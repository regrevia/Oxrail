import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import {
  PolicyDecisionSchema,
  type PolicyDecision,
} from "../../protocol/src/index.js";

export const MAX_TOOL_CALL_MARKER_BYTES = 1_024;

const MAX_ID_LENGTH = 4_096;
const REQUEST_DIGEST_KEY_BYTES = 32;
const REQUEST_DIGEST_KEY_FILE = ".request-digest-key";
const DIGEST = /^[a-f0-9]{64}$/;
const TEMPORARY = /^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/;

export interface ToolCallScope {
  sessionId: string;
  taskId: string;
}

export interface ToolCallPreInput extends ToolCallScope {
  bindingDigest: string;
  decision: PolicyDecision;
  requestDigest: string;
  toolUseId: string;
}

export interface ToolCallPostInput extends ToolCallScope {
  toolUseId: string;
}

export type ToolCallJournalStatus = "COMPLETE" | "PENDING";

export type ToolCallPreResult =
  | {
      decision: PolicyDecision;
      journalStatus: ToolCallJournalStatus;
      kind: "RECORDED" | "REPLAY";
    }
  | { kind: "MISMATCH" }
  | { kind: "UNAVAILABLE" };

export type ToolCallPostResult =
  | "COMPLETED"
  | "DUPLICATE"
  | "OUT_OF_ORDER"
  | "UNAVAILABLE";

export type PendingToolCallsResult = "NONE" | "PENDING" | "UNKNOWN";

interface ToolCallMarker {
  bindingDigest: string;
  decision: PolicyDecision;
  requestDigest: string;
  schemaVersion: 1;
  status: ToolCallJournalStatus;
  toolDigest: string;
}

type MarkerRead =
  | { kind: "INVALID" | "MISSING" }
  | { kind: "VALID"; marker: ToolCallMarker };

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;

function digest(domain: string, ...values: string[]): string {
  const hash = createHash("sha256").update(domain);
  for (const value of values) {
    hash
      .update("\0")
      .update(String(Buffer.byteLength(value)))
      .update(":")
      .update(value);
  }
  return hash.digest("hex");
}

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH;

const validScope = (scope: ToolCallScope): boolean =>
  Boolean(scope) && validId(scope.sessionId) && validId(scope.taskId);

const toolDigestFor = (input: ToolCallPostInput): string =>
  digest("oxrail-tool-call-v2", input.sessionId, input.taskId, input.toolUseId);

const journalDirectory = (root: string, scope: ToolCallScope): string =>
  path.join(
    root,
    digest("oxrail-tool-call-session-v2", scope.sessionId),
    digest("oxrail-tool-call-task-v2", scope.taskId),
    "tool-calls",
  );

const markerPath = (directory: string, toolDigest: string): string =>
  path.join(directory, `${toolDigest}.json`);

const receiptPath = (directory: string, toolDigest: string): string =>
  path.join(directory, `${toolDigest}.post`);

const decisionLeavesNativeActionPending = (decision: PolicyDecision) =>
  decision.disposition === "PASS_THROUGH_ORIGINAL" ||
  decision.disposition === "SEMANTIC_HINT_ONLY";

function parseMarker(
  value: unknown,
  expectedToolDigest: string,
): ToolCallMarker | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const marker = value as Partial<ToolCallMarker>;
  const decision = PolicyDecisionSchema.safeParse(marker.decision);
  if (
    Object.keys(value).sort().join(",") !==
      "bindingDigest,decision,requestDigest,schemaVersion,status,toolDigest" ||
    marker.schemaVersion !== 1 ||
    marker.toolDigest !== expectedToolDigest ||
    !DIGEST.test(marker.bindingDigest ?? "") ||
    !DIGEST.test(marker.requestDigest ?? "") ||
    (marker.status !== "PENDING" && marker.status !== "COMPLETE") ||
    !decision.success ||
    (marker.status === "PENDING" &&
      !decisionLeavesNativeActionPending(decision.data))
  ) {
    return;
  }
  return {
    bindingDigest: marker.bindingDigest!,
    decision: decision.data,
    requestDigest: marker.requestDigest!,
    schemaVersion: 1,
    status: marker.status,
    toolDigest: marker.toolDigest,
  };
}

async function readBounded(filename: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(
      filename,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > MAX_TOOL_CALL_MARKER_BYTES ||
      (metadata.mode & 0o077) !== 0
    ) {
      throw new Error("invalid marker metadata");
    }
    const contents = Buffer.alloc(MAX_TOOL_CALL_MARKER_BYTES + 1);
    let length = 0;
    while (length < contents.byteLength) {
      const { bytesRead } = await handle.read(
        contents,
        length,
        contents.byteLength - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAX_TOOL_CALL_MARKER_BYTES) {
      throw new Error("marker exceeds local limit");
    }
    return contents.subarray(0, length);
  } finally {
    await handle?.close();
  }
}

async function readMarker(
  filename: string,
  expectedToolDigest: string,
): Promise<MarkerRead> {
  try {
    const value: unknown = JSON.parse(
      (await readBounded(filename)).toString("utf8"),
    );
    const marker = parseMarker(value, expectedToolDigest);
    return marker ? { kind: "VALID", marker } : { kind: "INVALID" };
  } catch (error) {
    return { kind: errorCode(error) === "ENOENT" ? "MISSING" : "INVALID" };
  }
}

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("journal path is not a directory");
  }
  await chmod(directory, 0o700);
}

async function ensureJournalDirectory(
  root: string,
  scope: ToolCallScope,
): Promise<string> {
  const directory = journalDirectory(root, scope);
  await privateDirectory(root);
  await privateDirectory(path.dirname(path.dirname(directory)));
  await privateDirectory(path.dirname(directory));
  await privateDirectory(directory);
  return directory;
}

async function loadRequestDigestKey(filename: string): Promise<Buffer> {
  const key = await readBounded(filename);
  if (key.byteLength !== REQUEST_DIGEST_KEY_BYTES) {
    throw new Error("invalid request digest key");
  }
  return key;
}

async function requestDigestKey(root: string): Promise<Buffer> {
  await privateDirectory(root);
  const destination = path.join(root, REQUEST_DIGEST_KEY_FILE);
  try {
    return await loadRequestDigestKey(destination);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }

  const candidate = randomBytes(REQUEST_DIGEST_KEY_BYTES);
  const temporary = path.join(root, `.${randomUUID()}.key.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(candidate);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      await syncDirectory(root);
      return candidate;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      return await loadRequestDigestKey(destination);
    }
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

/** Hides low-entropy sanitized identities in journals exported without this install key. */
export async function protectToolCallRequestDigest(
  root: string,
  unkeyedDigest: string,
): Promise<string | undefined> {
  try {
    if (!DIGEST.test(unkeyedDigest)) return;
    return createHmac("sha256", await requestDigestKey(root))
      .update("oxrail-tool-call-request-v1\0")
      .update(unkeyedDigest)
      .digest("hex");
  } catch {
    return;
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

function serializeMarker(marker: ToolCallMarker): string {
  const contents = `${JSON.stringify(marker)}\n`;
  if (Buffer.byteLength(contents) > MAX_TOOL_CALL_MARKER_BYTES) {
    throw new Error("marker exceeds local limit");
  }
  return contents;
}

async function createMarker(
  directory: string,
  destination: string,
  marker: ToolCallMarker,
): Promise<"CREATED" | "EXISTS"> {
  const temporary = path.join(
    directory,
    `.${marker.toolDigest}.${randomUUID()}.tmp`,
  );
  let handle;
  let committed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serializeMarker(marker), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
      committed = true;
    } catch (error) {
      if (errorCode(error) === "EEXIST") return "EXISTS";
      throw error;
    }
    await syncDirectory(directory);
    return "CREATED";
  } catch (error) {
    // The hard link is the visible commit point; retries will replay it.
    if (committed) return "CREATED";
    throw error;
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function replaceMarker(
  directory: string,
  destination: string,
  marker: ToolCallMarker,
): Promise<void> {
  const temporary = path.join(
    directory,
    `.${marker.toolDigest}.${randomUUID()}.tmp`,
  );
  let handle;
  let committed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serializeMarker(marker), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    committed = true;
    await syncDirectory(directory);
  } catch (error) {
    // Rename is the visible commit point; a later Post can verify the receipt.
    if (!committed) throw error;
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

const sameBinding = (
  marker: ToolCallMarker,
  input: ToolCallPreInput,
): boolean =>
  marker.bindingDigest === input.bindingDigest &&
  marker.requestDigest === input.requestDigest;

const sameCompletion = (
  receipt: ToolCallMarker,
  marker: ToolCallMarker,
): boolean =>
  receipt.status === "COMPLETE" &&
  receipt.bindingDigest === marker.bindingDigest &&
  receipt.requestDigest === marker.requestDigest &&
  receipt.decision.disposition === marker.decision.disposition &&
  receipt.decision.reasonCode === marker.decision.reasonCode &&
  receipt.decision.recoverable === marker.decision.recoverable;

/** Atomically records or replays the first decision for one tool_use_id. */
export async function recordToolCallPre(
  root: string,
  input: ToolCallPreInput,
): Promise<ToolCallPreResult> {
  try {
    if (
      !validScope(input) ||
      !validId(input.toolUseId) ||
      !DIGEST.test(input.bindingDigest) ||
      !DIGEST.test(input.requestDigest)
    ) {
      return { kind: "UNAVAILABLE" };
    }
    const decision = PolicyDecisionSchema.safeParse(input.decision);
    if (!decision.success) return { kind: "UNAVAILABLE" };
    const directory = await ensureJournalDirectory(root, input);
    const toolDigest = toolDigestFor(input);
    const marker: ToolCallMarker = {
      bindingDigest: input.bindingDigest,
      decision: decision.data,
      requestDigest: input.requestDigest,
      schemaVersion: 1,
      status: decisionLeavesNativeActionPending(decision.data)
        ? "PENDING"
        : "COMPLETE",
      toolDigest,
    };
    const destination = markerPath(directory, toolDigest);
    if ((await createMarker(directory, destination, marker)) === "CREATED") {
      return {
        decision: marker.decision,
        journalStatus: marker.status,
        kind: "RECORDED",
      };
    }
    const existing = await readMarker(destination, toolDigest);
    if (existing.kind !== "VALID") return { kind: "UNAVAILABLE" };
    if (!sameBinding(existing.marker, input)) return { kind: "MISMATCH" };
    return {
      decision: existing.marker.decision,
      journalStatus: existing.marker.status,
      kind: "REPLAY",
    };
  } catch {
    return { kind: "UNAVAILABLE" };
  }
}

/** Durably completes a pending call; completion receipts repair crash windows. */
export async function completeToolCallPost(
  root: string,
  input: ToolCallPostInput,
): Promise<ToolCallPostResult> {
  try {
    if (!validScope(input) || !validId(input.toolUseId)) return "OUT_OF_ORDER";
    const directory = journalDirectory(root, input);
    const toolDigest = toolDigestFor(input);
    const destination = markerPath(directory, toolDigest);
    const current = await readMarker(destination, toolDigest);
    if (current.kind === "MISSING") return "OUT_OF_ORDER";
    if (current.kind !== "VALID") return "UNAVAILABLE";

    const pending = decisionLeavesNativeActionPending(current.marker.decision);
    if (!pending) return "OUT_OF_ORDER";
    const receipt = receiptPath(directory, toolDigest);
    if (current.marker.status === "COMPLETE") {
      const recorded = await readMarker(receipt, toolDigest);
      return recorded.kind === "VALID" &&
        sameCompletion(recorded.marker, current.marker)
        ? "DUPLICATE"
        : "UNAVAILABLE";
    }

    const completed: ToolCallMarker = {
      ...current.marker,
      status: "COMPLETE",
    };
    const claim = await createMarker(directory, receipt, completed);
    if (claim === "EXISTS") {
      const recorded = await readMarker(receipt, toolDigest);
      if (
        recorded.kind !== "VALID" ||
        !sameCompletion(recorded.marker, current.marker)
      ) {
        return "UNAVAILABLE";
      }
    }
    await replaceMarker(directory, destination, completed);
    return claim === "CREATED" ? "COMPLETED" : "DUPLICATE";
  } catch {
    return "UNAVAILABLE";
  }
}

/**
 * Returns a conservative scope snapshot. Call it while holding the task-state
 * lock when the answer gates lease activation.
 */
export async function hasPendingToolCalls(
  root: string,
  scope: ToolCallScope,
): Promise<PendingToolCallsResult> {
  try {
    if (!validScope(scope)) return "UNKNOWN";
    const directory = journalDirectory(root, scope);
    let entries;
    try {
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0
      ) {
        return "UNKNOWN";
      }
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return errorCode(error) === "ENOENT" ? "NONE" : "UNKNOWN";
    }

    const markers = new Map<string, ToolCallMarker>();
    const receipts = new Map<string, ToolCallMarker>();
    for (const entry of entries) {
      if (entry.isFile() && TEMPORARY.test(entry.name)) continue;
      const match = /^([a-f0-9]{64})\.(json|post)$/.exec(entry.name);
      if (!entry.isFile() || !match) return "UNKNOWN";
      const toolDigest = match[1]!;
      const parsed = await readMarker(
        path.join(directory, entry.name),
        toolDigest,
      );
      if (parsed.kind !== "VALID") return "UNKNOWN";
      (match[2] === "json" ? markers : receipts).set(toolDigest, parsed.marker);
    }

    for (const [toolDigest, receipt] of receipts) {
      const marker = markers.get(toolDigest);
      if (
        !marker ||
        !decisionLeavesNativeActionPending(marker.decision) ||
        !sameCompletion(receipt, marker)
      ) {
        return "UNKNOWN";
      }
    }
    let pending = false;
    for (const [toolDigest, marker] of markers) {
      const receipt = receipts.get(toolDigest);
      if (!decisionLeavesNativeActionPending(marker.decision)) {
        if (receipt) return "UNKNOWN";
      } else if (!receipt) {
        if (marker.status === "COMPLETE") return "UNKNOWN";
        pending = true;
      }
    }
    return pending ? "PENDING" : "NONE";
  } catch {
    return "UNKNOWN";
  }
}
