import { createHash, randomUUID } from "node:crypto";
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
import { protectLocalDigest } from "./local-digest.js";
import { persistentToolUseId } from "./safe-state.js";

export const MAX_TOOL_CALL_MARKER_BYTES = 1_024;
export const MAX_ACTIVE_TOOL_CALLS = 256;

const MAX_ID_LENGTH = 4_096;
const ACTIVE_DIRECTORY = "active";
const ACTIVE_INDEX = ".active-index-v1";
const ACTIVE_INDEX_CONTENTS = '{"schemaVersion":1}\n';
const ACTIVE_INDEX_TEMPORARY = /^\.active-index-v1\.[a-f0-9-]{36}\.tmp$/;
const ACTIVE_MARKER_TEMPORARY = /^\.[a-f0-9]{64}\.[a-f0-9-]{36}\.tmp$/;
const DIGEST = /^[a-f0-9]{64}$/;
const PERSISTENT_ID = /^oxrail-id:[a-f0-9]{64}$/;

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

export type ToolCallRetirementResult =
  | "ALREADY_RETIRED"
  | "NOT_COMPLETE"
  | "RETIRED"
  | "UNAVAILABLE";

export type ToolCallSweepResult =
  | "NOTHING_TO_RETIRE"
  | "RETIRED"
  | "UNAVAILABLE";

export type PendingToolCallsResult = "NONE" | "PENDING" | "UNKNOWN";

export type ToolCallJournalSnapshot =
  | {
      kind: "KNOWN";
      completedToolUseIds: string[];
      legacyPending: boolean;
      pendingToolUseIds: string[];
    }
  | { kind: "UNKNOWN" };

interface ToolCallMarkerBase {
  bindingDigest: string;
  decision: PolicyDecision;
  requestDigest: string;
  status: ToolCallJournalStatus;
  toolDigest: string;
}

type ToolCallMarker =
  | (ToolCallMarkerBase & { schemaVersion: 1 })
  | (ToolCallMarkerBase & {
      schemaVersion: 2;
      persistentToolUseId: string;
    });

type MarkerRead =
  | { kind: "INVALID" }
  | { kind: "MISSING" }
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

const activeDirectory = (directory: string): string =>
  path.join(directory, ACTIVE_DIRECTORY);

const markerPath = (directory: string, toolDigest: string): string =>
  path.join(directory, `${toolDigest}.json`);

const activeMarkerPath = (directory: string, toolDigest: string): string =>
  path.join(activeDirectory(directory), `${toolDigest}.json`);

const indexingMarkerPath = (directory: string, toolDigest: string): string =>
  path.join(activeDirectory(directory), `${toolDigest}.indexing`);

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
  const marker = value as Partial<
    ToolCallMarkerBase & {
      persistentToolUseId: string;
      schemaVersion: 1 | 2;
    }
  >;
  const decision = PolicyDecisionSchema.safeParse(marker.decision);
  const expectedKeys =
    marker.schemaVersion === 1
      ? "bindingDigest,decision,requestDigest,schemaVersion,status,toolDigest"
      : "bindingDigest,decision,persistentToolUseId,requestDigest,schemaVersion,status,toolDigest";
  if (
    Object.keys(value).sort().join(",") !== expectedKeys ||
    (marker.schemaVersion !== 1 && marker.schemaVersion !== 2) ||
    (marker.schemaVersion === 2 &&
      !PERSISTENT_ID.test(marker.persistentToolUseId ?? "")) ||
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
  const common: ToolCallMarkerBase = {
    bindingDigest: marker.bindingDigest!,
    decision: decision.data,
    requestDigest: marker.requestDigest!,
    status: marker.status,
    toolDigest: marker.toolDigest,
  };
  return marker.schemaVersion === 1
    ? { ...common, schemaVersion: 1 }
    : {
        ...common,
        persistentToolUseId: marker.persistentToolUseId!,
        schemaVersion: 2,
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

async function activeIndexReady(directory: string): Promise<boolean> {
  try {
    return (
      (
        await readBounded(path.join(activeDirectory(directory), ACTIVE_INDEX))
      ).toString("utf8") === ACTIVE_INDEX_CONTENTS
    );
  } catch {
    return false;
  }
}

async function initializeActiveIndex(directory: string): Promise<void> {
  if (await activeIndexReady(directory)) return;
  const entries = await readdir(directory);
  if (entries.some((entry) => entry !== ACTIVE_DIRECTORY)) return;
  const active = activeDirectory(directory);
  const filename = path.join(active, ACTIVE_INDEX);
  const temporary = path.join(active, `${ACTIVE_INDEX}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(ACTIVE_INDEX_CONTENTS, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, filename);
    } catch (error) {
      if (
        errorCode(error) !== "EEXIST" ||
        !(await activeIndexReady(directory))
      ) {
        throw error;
      }
    }
    await syncDirectory(active);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
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
  await privateDirectory(activeDirectory(directory));
  await initializeActiveIndex(directory);
  return directory;
}

/** Hides low-entropy sanitized identities in journals exported without this install key. */
export async function protectToolCallRequestDigest(
  root: string,
  unkeyedDigest: string,
): Promise<string | undefined> {
  return protectLocalDigest(root, "tool-call-request-v1", unkeyedDigest);
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
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serializeMarker(marker), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, destination);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return "EXISTS";
      throw error;
    }
    await syncDirectory(directory);
    return "CREATED";
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

const sameMarker = (left: ToolCallMarker, right: ToolCallMarker) =>
  left.schemaVersion === right.schemaVersion &&
  (left.schemaVersion === 1 ||
    (right.schemaVersion === 2 &&
      left.persistentToolUseId === right.persistentToolUseId)) &&
  left.bindingDigest === right.bindingDigest &&
  left.requestDigest === right.requestDigest &&
  left.status === right.status &&
  left.toolDigest === right.toolDigest &&
  left.decision.disposition === right.decision.disposition &&
  left.decision.reasonCode === right.decision.reasonCode &&
  left.decision.recoverable === right.decision.recoverable;

async function ensureActiveMarker(
  directory: string,
  marker: ToolCallMarker,
): Promise<void> {
  const active = activeDirectory(directory);
  const destination = activeMarkerPath(directory, marker.toolDigest);
  await createMarker(active, destination, marker);
  const existing = await readMarker(destination, marker.toolDigest);
  if (existing.kind !== "VALID" || !sameMarker(existing.marker, marker)) {
    throw new Error("active tool-call marker mismatch");
  }
}

async function beginActiveIndexMutation(
  directory: string,
  marker: ToolCallMarker,
): Promise<{ created: boolean; marker: ToolCallMarker }> {
  const active = activeDirectory(directory);
  const destination = indexingMarkerPath(directory, marker.toolDigest);
  const claim = await createMarker(active, destination, marker);
  const existing = await readMarker(destination, marker.toolDigest);
  if (
    existing.kind !== "VALID" ||
    existing.marker.schemaVersion !== 2 ||
    existing.marker.status !== "PENDING" ||
    !decisionLeavesNativeActionPending(existing.marker.decision)
  ) {
    throw new Error("active tool-call mutation mismatch");
  }
  return { created: claim === "CREATED", marker: existing.marker };
}

async function finishActiveIndexMutation(
  directory: string,
  marker: ToolCallMarker,
): Promise<void> {
  const destination = indexingMarkerPath(directory, marker.toolDigest);
  const existing = await readMarker(destination, marker.toolDigest);
  if (existing.kind === "MISSING") return;
  if (existing.kind !== "VALID" || !sameMarker(existing.marker, marker)) {
    throw new Error("active tool-call mutation mismatch");
  }
  try {
    await unlink(destination);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return;
    throw error;
  }
  await syncDirectory(activeDirectory(directory));
}

async function reconcilePendingActiveIndex(
  directory: string,
  marker: ToolCallMarker,
): Promise<void> {
  const intent = await beginActiveIndexMutation(directory, marker);
  if (!sameMarker(intent.marker, marker)) {
    throw new Error("active tool-call mutation mismatch");
  }
  await ensureActiveMarker(directory, marker);
  const current = await readMarker(
    markerPath(directory, marker.toolDigest),
    marker.toolDigest,
  );
  const receipt = await readMarker(
    receiptPath(directory, marker.toolDigest),
    marker.toolDigest,
  );
  if (
    current.kind !== "VALID" ||
    (!sameMarker(current.marker, marker) &&
      !(
        receipt.kind === "VALID" &&
        sameCompletion(current.marker, marker) &&
        sameCompletion(receipt.marker, marker)
      ))
  ) {
    throw new Error("tool-call index did not reach a stable state");
  }
  await finishActiveIndexMutation(directory, marker);
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
  marker.requestDigest === input.requestDigest &&
  (marker.schemaVersion === 1 ||
    marker.persistentToolUseId === persistentToolUseId(input.toolUseId));

const sameCompletion = (
  receipt: ToolCallMarker,
  marker: ToolCallMarker,
): boolean =>
  receipt.status === "COMPLETE" &&
  receipt.schemaVersion === marker.schemaVersion &&
  (receipt.schemaVersion === 1 ||
    (marker.schemaVersion === 2 &&
      receipt.persistentToolUseId === marker.persistentToolUseId)) &&
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
      persistentToolUseId: persistentToolUseId(input.toolUseId),
      requestDigest: input.requestDigest,
      schemaVersion: 2,
      status: decisionLeavesNativeActionPending(decision.data)
        ? "PENDING"
        : "COMPLETE",
      toolDigest,
    };
    const destination = markerPath(directory, toolDigest);
    let claim: "CREATED" | "EXISTS" = "EXISTS";
    let current = await readMarker(destination, toolDigest);
    if (current.kind === "INVALID") return { kind: "UNAVAILABLE" };
    if (current.kind === "MISSING") {
      let candidate: ToolCallMarker = marker;
      if (marker.status === "PENDING") {
        const intent = await beginActiveIndexMutation(directory, marker);
        candidate = intent.marker;
        if (!sameBinding(candidate, input)) return { kind: "MISMATCH" };
        if (!intent.created) {
          current = await readMarker(destination, toolDigest);
          if (current.kind === "MISSING") {
            return {
              decision: candidate.decision,
              journalStatus: candidate.status,
              kind: "REPLAY",
            };
          }
          if (current.kind === "INVALID") return { kind: "UNAVAILABLE" };
        }
      }
      if (current.kind === "MISSING") {
        claim = await createMarker(directory, destination, candidate);
        current = await readMarker(destination, toolDigest);
        if (current.kind !== "VALID") return { kind: "UNAVAILABLE" };
      }
    }

    const existing = current.marker;
    const bindingMatches = sameBinding(existing, input);
    if (existing.status === "PENDING") {
      try {
        await reconcilePendingActiveIndex(directory, existing);
      } catch {
        if (claim === "CREATED") return { kind: "UNAVAILABLE" };
      }
    }
    if (!bindingMatches) return { kind: "MISMATCH" };
    return {
      decision: existing.decision,
      journalStatus: existing.status,
      kind: claim === "CREATED" ? "RECORDED" : "REPLAY",
    };
  } catch {
    return { kind: "UNAVAILABLE" };
  }
}

interface ScannedToolCall {
  marker: ToolCallMarker;
  status: ToolCallJournalStatus;
}

async function scanToolCallJournal(
  root: string,
  scope: ToolCallScope,
  maximumCalls = MAX_ACTIVE_TOOL_CALLS,
): Promise<{ kind: "KNOWN"; calls: ScannedToolCall[] } | { kind: "UNKNOWN" }> {
  if (!validScope(scope)) return { kind: "UNKNOWN" };
  const directory = journalDirectory(root, scope);
  const active = activeDirectory(directory);
  let directoryMetadata;
  try {
    directoryMetadata = await lstat(directory);
  } catch (error) {
    return errorCode(error) === "ENOENT"
      ? { kind: "KNOWN", calls: [] }
      : { kind: "UNKNOWN" };
  }
  if (
    !directoryMetadata.isDirectory() ||
    directoryMetadata.isSymbolicLink() ||
    (directoryMetadata.mode & 0o077) !== 0 ||
    !(await activeIndexReady(directory))
  ) {
    return { kind: "UNKNOWN" };
  }
  let entries;
  try {
    const metadata = await lstat(active);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      (metadata.mode & 0o077) !== 0
    ) {
      return { kind: "UNKNOWN" };
    }
    entries = await readdir(active, { withFileTypes: true });
  } catch {
    return { kind: "UNKNOWN" };
  }

  const calls: ScannedToolCall[] = [];
  for (const entry of entries) {
    if (entry.isFile() && entry.name === ACTIVE_INDEX) continue;
    if (entry.isFile() && ACTIVE_INDEX_TEMPORARY.test(entry.name)) continue;
    if (entry.isFile() && ACTIVE_MARKER_TEMPORARY.test(entry.name)) continue;
    const match = /^([a-f0-9]{64})\.json$/.exec(entry.name);
    if (!entry.isFile() || !match) return { kind: "UNKNOWN" };
    if (calls.length === maximumCalls) return { kind: "UNKNOWN" };
    const toolDigest = match[1]!;
    const marker = await readMarker(path.join(active, entry.name), toolDigest);
    if (
      marker.kind !== "VALID" ||
      marker.marker.status !== "PENDING" ||
      !decisionLeavesNativeActionPending(marker.marker.decision)
    ) {
      return { kind: "UNKNOWN" };
    }
    const canonical = await readMarker(
      markerPath(directory, toolDigest),
      toolDigest,
    );
    if (canonical.kind !== "VALID") return { kind: "UNKNOWN" };
    const receipt = await readMarker(
      receiptPath(directory, toolDigest),
      toolDigest,
    );
    if (receipt.kind === "INVALID") return { kind: "UNKNOWN" };
    if (receipt.kind === "MISSING") {
      if (!sameMarker(canonical.marker, marker.marker)) {
        return { kind: "UNKNOWN" };
      }
      calls.push({ marker: marker.marker, status: "PENDING" });
      continue;
    }
    if (
      !sameCompletion(receipt.marker, marker.marker) ||
      (!sameMarker(canonical.marker, marker.marker) &&
        !sameCompletion(canonical.marker, marker.marker))
    ) {
      return { kind: "UNKNOWN" };
    }
    calls.push({ marker: marker.marker, status: "COMPLETE" });
  }
  return { kind: "KNOWN", calls };
}

/** Exact sanitized journal identities used only while activating a user lease. */
export async function inspectToolCallJournal(
  root: string,
  scope: ToolCallScope,
): Promise<ToolCallJournalSnapshot> {
  try {
    const scanned = await scanToolCallJournal(root, scope);
    if (scanned.kind === "UNKNOWN") {
      return { kind: "UNKNOWN" };
    }
    const completedToolUseIds: string[] = [];
    const pendingToolUseIds: string[] = [];
    for (const { marker, status } of scanned.calls) {
      if (marker.schemaVersion === 1) continue;
      (status === "COMPLETE" ? completedToolUseIds : pendingToolUseIds).push(
        marker.persistentToolUseId,
      );
    }
    if (
      new Set([...completedToolUseIds, ...pendingToolUseIds]).size !==
      completedToolUseIds.length + pendingToolUseIds.length
    ) {
      return { kind: "UNKNOWN" };
    }
    return {
      kind: "KNOWN",
      completedToolUseIds: [...new Set(completedToolUseIds)].sort(),
      legacyPending: scanned.calls.some(
        ({ marker, status }) =>
          marker.schemaVersion === 1 && status === "PENDING",
      ),
      pendingToolUseIds: [...new Set(pendingToolUseIds)].sort(),
    };
  } catch {
    return { kind: "UNKNOWN" };
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
    let current = await readMarker(destination, toolDigest);
    if (current.kind === "MISSING" && (await activeIndexReady(directory))) {
      const intent = await readMarker(
        indexingMarkerPath(directory, toolDigest),
        toolDigest,
      );
      if (
        intent.kind === "VALID" &&
        intent.marker.schemaVersion === 2 &&
        intent.marker.status === "PENDING"
      ) {
        await createMarker(directory, destination, intent.marker);
        current = await readMarker(destination, toolDigest);
      } else if (intent.kind !== "MISSING") {
        return "UNAVAILABLE";
      }
    }
    if (current.kind === "MISSING") return "OUT_OF_ORDER";
    if (current.kind !== "VALID") return "UNAVAILABLE";

    const pending = decisionLeavesNativeActionPending(current.marker.decision);
    if (!pending) return "OUT_OF_ORDER";
    const receipt = receiptPath(directory, toolDigest);
    if (current.marker.status === "COMPLETE") {
      const recorded = await readMarker(receipt, toolDigest);
      if (
        recorded.kind !== "VALID" ||
        !sameCompletion(recorded.marker, current.marker)
      ) {
        return "UNAVAILABLE";
      }
      if (await activeIndexReady(directory)) {
        await finishActiveIndexMutation(directory, {
          ...current.marker,
          status: "PENDING",
        });
      }
      return "DUPLICATE";
    }

    if (await activeIndexReady(directory)) {
      await reconcilePendingActiveIndex(directory, current.marker);
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

/** Removes only the active index after BrowserTaskState no longer lists the call. */
export async function retireCompletedToolCall(
  root: string,
  input: ToolCallPostInput,
): Promise<ToolCallRetirementResult> {
  try {
    if (!validScope(input) || !validId(input.toolUseId)) return "UNAVAILABLE";
    const directory = journalDirectory(root, input);
    const toolDigest = toolDigestFor(input);
    const current = await readMarker(
      markerPath(directory, toolDigest),
      toolDigest,
    );
    const receipt = await readMarker(
      receiptPath(directory, toolDigest),
      toolDigest,
    );
    if (
      current.kind !== "VALID" ||
      receipt.kind !== "VALID" ||
      current.marker.status !== "COMPLETE" ||
      !decisionLeavesNativeActionPending(current.marker.decision) ||
      !sameCompletion(receipt.marker, current.marker)
    ) {
      return "NOT_COMPLETE";
    }
    const active = activeMarkerPath(directory, toolDigest);
    const indexed = await readMarker(active, toolDigest);
    if (indexed.kind === "MISSING") {
      if (await activeIndexReady(directory)) {
        await finishActiveIndexMutation(directory, {
          ...current.marker,
          status: "PENDING",
        });
      }
      return "ALREADY_RETIRED";
    }
    if (
      indexed.kind !== "VALID" ||
      !sameCompletion(receipt.marker, indexed.marker)
    ) {
      return "UNAVAILABLE";
    }
    try {
      await unlink(active);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return "ALREADY_RETIRED";
      throw error;
    }
    await syncDirectory(activeDirectory(directory));
    await finishActiveIndexMutation(directory, {
      ...current.marker,
      status: "PENDING",
    });
    return "RETIRED";
  } catch {
    return "UNAVAILABLE";
  }
}

/** Removes completed index entries that durable BrowserTaskState no longer retains. */
export async function retireCompletedToolCalls(
  root: string,
  scope: ToolCallScope,
  retainedPersistentToolUseIds: readonly string[],
): Promise<ToolCallSweepResult> {
  try {
    if (
      !validScope(scope) ||
      retainedPersistentToolUseIds.some((id) => !PERSISTENT_ID.test(id))
    ) {
      return "UNAVAILABLE";
    }
    const retained = new Set(retainedPersistentToolUseIds);
    const scanned = await scanToolCallJournal(
      root,
      scope,
      Number.MAX_SAFE_INTEGER,
    );
    if (scanned.kind === "UNKNOWN") return "UNAVAILABLE";
    const persistentIds = scanned.calls.flatMap(({ marker }) =>
      marker.schemaVersion === 2 ? [marker.persistentToolUseId] : [],
    );
    if (new Set(persistentIds).size !== persistentIds.length) {
      return "UNAVAILABLE";
    }
    const completed = scanned.calls.filter(
      ({ marker, status }) =>
        status === "COMPLETE" &&
        marker.schemaVersion === 2 &&
        !retained.has(marker.persistentToolUseId),
    );
    if (!completed.length) return "NOTHING_TO_RETIRE";
    const active = activeDirectory(journalDirectory(root, scope));
    for (const { marker } of completed) {
      try {
        await unlink(path.join(active, `${marker.toolDigest}.json`));
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    await syncDirectory(active);
    return "RETIRED";
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
    const scanned = await scanToolCallJournal(root, scope);
    if (scanned.kind === "UNKNOWN") return "UNKNOWN";
    return scanned.calls.some(({ status }) => status === "PENDING")
      ? "PENDING"
      : "NONE";
  } catch {
    return "UNKNOWN";
  }
}
