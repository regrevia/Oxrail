import { randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";

import {
  CredentialEnclaveTicketSchema,
  deterministicDigest,
  type CredentialEnclaveTicket,
} from "../../protocol/src/index.js";
import { hasValidFixtureCredentialTicketId } from "./credential-admission.js";
import { BrowserTaskStateStoreError, readBoundedPrivateFile } from "./store.js";
import { withCredentialToolFenceLock } from "./credential-tool-fence-lock.js";

const DIRECTORY = "credential-execution-gate";
const CURRENT = "current.json";
const SENTINEL = ".initialized-v1";
const LOCK = ".current.lock";
const MAX_CURRENT_BYTES = 2 * 1024;
const MAX_SENTINEL_BYTES = 256;
const MAX_LOCK_BYTES = 512;
const HASH = /^[a-f0-9]{64}$/;
const AUTHORITY = "FIXTURE_ONLY_NON_AUTHORIZING" as const;
const EFFECT = "BLOCK_AGENT_EXECUTION_ONLY" as const;
const FIXTURE_RESET_EFFECT = "FIXTURE_LOCAL_LEDGER_RESET_ONLY" as const;

export type CredentialExecutionGateState =
  | "ACTIVE"
  | "CLEANUP_PENDING"
  | "OPEN"
  | "PREPARING";

interface PersistedGate {
  authority: typeof AUTHORITY;
  createdAt: number;
  effect: typeof EFFECT;
  expiresAt: number | null;
  generation: number;
  operationDigest: string | null;
  outcome: "ABORTED" | "ACTIVATED" | "NONE";
  receiptDigest: string | null;
  schemaVersion: 1;
  state: CredentialExecutionGateState;
  updatedAt: number;
}

export type CredentialExecutionGateSnapshot =
  | { kind: "UNINITIALIZED" }
  | { kind: "UNKNOWN" }
  | ({ kind: "KNOWN" } & PersistedGate);

export type CredentialExecutionGateEventKind =
  | "ACTIVATE"
  | "ABORT_PREPARING"
  | "BEGIN_CLEANUP"
  | "FINISH_CLEANUP"
  | "PREPARE";

/** Strictly secret-free fixture binding. It cannot authorize a helper or consumer. */
export interface FixtureCredentialExecutionBinding {
  hookDefinitionHash: string;
  hostProfileHash: string;
  ticket: CredentialEnclaveTicket;
  trustRootHash: string;
}

interface CredentialExecutionGateEventBase {
  binding: FixtureCredentialExecutionBinding;
  generation: number;
  observedAt: number;
}

export type CredentialExecutionGateEvent =
  | (CredentialExecutionGateEventBase & { kind: "PREPARE" })
  | (CredentialExecutionGateEventBase & {
      kind: "ACTIVATE" | "ABORT_PREPARING" | "BEGIN_CLEANUP";
      quiescenceReceiptHash: string;
    })
  | (CredentialExecutionGateEventBase & {
      cleanupEvidenceHash: string;
      kind: "FINISH_CLEANUP";
    });

export type CredentialExecutionGateErrorCode =
  | "CONFLICT"
  | "INVALID_INPUT"
  | "INVALID_TRANSITION"
  | "UNAVAILABLE";

export class CredentialExecutionGateError extends Error {
  constructor(readonly code: CredentialExecutionGateErrorCode) {
    super(`credential execution gate: ${code.toLowerCase()}`);
    this.name = "CredentialExecutionGateError";
  }
}

interface LockSnapshot {
  createdAt: number;
  device: bigint;
  inode: bigint;
  modifiedAt: number;
  nonce: string;
  pid: number;
}

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;

const gateDirectory = (root: string) => path.join(root, DIRECTORY);
const gatePath = (root: string, name: string) =>
  path.join(gateDirectory(root), name);

function currentUid(): number {
  if (typeof process.getuid !== "function") {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  return process.getuid();
}

function isOwnedPrivateDirectory(metadata: {
  mode: number | bigint;
  uid: number | bigint;
}): boolean {
  return (
    Number(metadata.uid) === currentUid() &&
    (Number(metadata.mode) & 0o777) === 0o700
  );
}

function isOwnedPrivateFile(
  metadata: {
    mode: number | bigint;
    nlink: number | bigint;
    uid: number | bigint;
  },
  allowClaimLink = false,
): boolean {
  const links = Number(metadata.nlink);
  return (
    Number(metadata.uid) === currentUid() &&
    (Number(metadata.mode) & 0o777) === 0o600 &&
    (allowClaimLink ? links >= 1 : links === 1)
  );
}

async function inspectPrivateDirectory(
  directory: string,
): Promise<"MISSING" | "PRIVATE" | "UNSAFE"> {
  try {
    const metadata = await lstat(directory);
    return metadata.isDirectory() &&
      !metadata.isSymbolicLink() &&
      isOwnedPrivateDirectory(metadata)
      ? "PRIVATE"
      : "UNSAFE";
  } catch (error) {
    return errorCode(error) === "ENOENT" ? "MISSING" : "UNSAFE";
  }
}

async function ensurePrivateDirectory(
  directory: string,
  recursive: boolean,
): Promise<void> {
  try {
    try {
      await mkdir(directory, { recursive, mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    if ((await inspectPrivateDirectory(directory)) !== "PRIVATE") {
      throw new CredentialExecutionGateError("UNAVAILABLE");
    }
  } catch (error) {
    if (error instanceof CredentialExecutionGateError) throw error;
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  let handle;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function readPrivateFile(
  filename: string,
  maximumBytes: number,
  allowClaimLink = false,
) {
  try {
    const { contents, metadata } = await readBoundedPrivateFile(
      filename,
      maximumBytes,
      "UNAVAILABLE",
    );
    if (!isOwnedPrivateFile(metadata, allowClaimLink)) {
      throw new CredentialExecutionGateError("UNAVAILABLE");
    }
    return { contents, metadata };
  } catch (error) {
    if (
      errorCode(error) === "ENOENT" ||
      error instanceof CredentialExecutionGateError
    ) {
      throw error;
    }
    if (error instanceof BrowserTaskStateStoreError) {
      throw new CredentialExecutionGateError("UNAVAILABLE");
    }
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
}

function parseCurrent(value: unknown): PersistedGate {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "authority,createdAt,effect,expiresAt,generation,operationDigest,outcome,receiptDigest,schemaVersion,state,updatedAt"
  ) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  const current = value as Partial<PersistedGate>;
  if (
    current.schemaVersion !== 1 ||
    current.authority !== AUTHORITY ||
    current.effect !== EFFECT ||
    !["ACTIVE", "CLEANUP_PENDING", "OPEN", "PREPARING"].includes(
      current.state ?? "",
    ) ||
    !Number.isSafeInteger(current.generation) ||
    current.generation! < 0 ||
    !Number.isSafeInteger(current.createdAt) ||
    current.createdAt! < 0 ||
    !Number.isSafeInteger(current.updatedAt) ||
    current.updatedAt! < current.createdAt! ||
    (current.generation === 0
      ? current.state !== "OPEN" ||
        current.operationDigest !== null ||
        current.outcome !== "NONE" ||
        current.receiptDigest !== null ||
        current.expiresAt !== null ||
        current.createdAt !== current.updatedAt
      : !HASH.test(current.operationDigest ?? "") ||
        !Number.isSafeInteger(current.expiresAt) ||
        current.expiresAt! < current.createdAt! ||
        !["ABORTED", "ACTIVATED", "NONE"].includes(current.outcome ?? "") ||
        (current.state === "PREPARING" && current.outcome !== "NONE") ||
        (current.state === "ACTIVE" && current.outcome !== "ACTIVATED") ||
        (current.state === "CLEANUP_PENDING" &&
          !["ABORTED", "ACTIVATED"].includes(current.outcome ?? "")) ||
        (current.state === "OPEN" && current.outcome === "NONE") ||
        (["ACTIVE", "CLEANUP_PENDING"].includes(current.state ?? "")
          ? !HASH.test(current.receiptDigest ?? "")
          : current.receiptDigest !== null))
  ) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  return current as PersistedGate;
}

async function readCurrent(filename: string): Promise<PersistedGate> {
  const { contents } = await readPrivateFile(filename, MAX_CURRENT_BYTES);
  try {
    const current = parseCurrent(JSON.parse(contents.toString("utf8")));
    if (contents.toString("utf8") !== serializeCurrent(current)) {
      throw new CredentialExecutionGateError("UNAVAILABLE");
    }
    return current;
  } catch {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
}

const sentinelContents = `${JSON.stringify({
  authority: AUTHORITY,
  schemaVersion: 1,
  state: "INITIALIZED",
})}\n`;

async function readSentinel(filename: string): Promise<void> {
  const { contents } = await readPrivateFile(filename, MAX_SENTINEL_BYTES);
  if (contents.toString("utf8") !== sentinelContents) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
}

function serializeCurrent(current: PersistedGate): string {
  const parsed = parseCurrent(current);
  const contents = `${JSON.stringify({
    authority: parsed.authority,
    createdAt: parsed.createdAt,
    effect: parsed.effect,
    expiresAt: parsed.expiresAt,
    generation: parsed.generation,
    operationDigest: parsed.operationDigest,
    outcome: parsed.outcome,
    receiptDigest: parsed.receiptDigest,
    schemaVersion: parsed.schemaVersion,
    state: parsed.state,
    updatedAt: parsed.updatedAt,
  })}\n`;
  if (Buffer.byteLength(contents) > MAX_CURRENT_BYTES) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  return contents;
}

async function atomicWrite(
  directory: string,
  destination: string,
  contents: string,
  replace: boolean,
): Promise<void> {
  const temporary = path.join(directory, `.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isOwnedPrivateFile(metadata)) {
      throw new CredentialExecutionGateError("UNAVAILABLE");
    }
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (replace) {
      await rename(temporary, destination);
    } else {
      await link(temporary, destination);
      await unlink(temporary);
    }
    await syncDirectory(directory);
  } catch (error) {
    if (error instanceof CredentialExecutionGateError) throw error;
    if (!replace && errorCode(error) === "EEXIST") {
      throw new CredentialExecutionGateError("CONFLICT");
    }
    throw new CredentialExecutionGateError("UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

function parseLock(
  value: unknown,
  metadata: {
    dev: number | bigint;
    ino: number | bigint;
    mtimeMs: number | bigint;
  },
): LockSnapshot {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== "createdAt,nonce,pid,schemaVersion"
  ) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
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
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  return {
    createdAt: lock.createdAt!,
    device: BigInt(metadata.dev),
    inode: BigInt(metadata.ino),
    modifiedAt: Number(metadata.mtimeMs),
    nonce: lock.nonce,
    pid: lock.pid!,
  };
}

async function readLock(
  filename: string,
  allowClaimLink = false,
): Promise<LockSnapshot> {
  const { contents, metadata } = await readPrivateFile(
    filename,
    MAX_LOCK_BYTES,
    allowClaimLink,
  );
  let value: unknown;
  try {
    value = JSON.parse(contents.toString("utf8"));
  } catch {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  const parsed = parseLock(value, metadata);
  if (
    contents.toString("utf8") !==
    `${JSON.stringify({
      schemaVersion: 1,
      pid: parsed.pid,
      createdAt: parsed.createdAt,
      nonce: parsed.nonce,
    })}\n`
  ) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  return parsed;
}

const sameLock = (left: LockSnapshot, right: LockSnapshot) =>
  left.createdAt === right.createdAt &&
  left.device === right.device &&
  left.inode === right.inode &&
  left.modifiedAt === right.modifiedAt &&
  left.nonce === right.nonce &&
  left.pid === right.pid;

function processIsDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return errorCode(error) === "ESRCH";
  }
}

async function recoverDeadLock(
  directory: string,
  filename: string,
): Promise<boolean> {
  let stale: LockSnapshot;
  try {
    stale = await readLock(filename);
  } catch {
    return false;
  }
  if (!processIsDead(stale.pid)) return false;
  const claim = `${filename}.recovered-${stale.nonce}`;
  try {
    await link(filename, claim);
    const claimed = await readLock(claim, true);
    const current = await readLock(filename, true);
    if (
      !sameLock(stale, claimed) ||
      !sameLock(claimed, current) ||
      !processIsDead(current.pid)
    ) {
      return false;
    }
    await unlink(filename);
    await syncDirectory(directory);
    return true;
  } catch {
    return false;
  }
}

async function tryCreateLock(
  directory: string,
  filename: string,
): Promise<LockSnapshot | undefined> {
  const nonce = randomUUID();
  const createdAt = Date.now();
  const temporary = path.join(directory, `.${nonce}.lock.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(
      `${JSON.stringify({ schemaVersion: 1, pid: process.pid, createdAt, nonce })}\n`,
      "utf8",
    );
    await handle.sync();
    const metadata = await handle.stat({ bigint: true });
    if (!metadata.isFile() || !isOwnedPrivateFile(metadata)) {
      throw new CredentialExecutionGateError("UNAVAILABLE");
    }
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, filename);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return undefined;
      throw error;
    }
    await unlink(temporary);
    await syncDirectory(directory);
    return parseLock(
      { schemaVersion: 1, pid: process.pid, createdAt, nonce },
      metadata,
    );
  } catch (error) {
    if (error instanceof CredentialExecutionGateError) throw error;
    throw new CredentialExecutionGateError("UNAVAILABLE");
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

async function acquireLock(root: string): Promise<LockSnapshot> {
  const directory = gateDirectory(root);
  const filename = gatePath(root, LOCK);
  const acquired = await tryCreateLock(directory, filename);
  if (acquired) return acquired;
  if (!(await recoverDeadLock(directory, filename))) {
    throw new CredentialExecutionGateError("CONFLICT");
  }
  const recovered = await tryCreateLock(directory, filename);
  if (!recovered) throw new CredentialExecutionGateError("CONFLICT");
  return recovered;
}

async function releaseLock(root: string, ownership: LockSnapshot) {
  const filename = gatePath(root, LOCK);
  const current = await readLock(filename).catch(() => undefined);
  if (!current || !sameLock(current, ownership)) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  await unlink(filename);
  await syncDirectory(gateDirectory(root));
}

function initialCurrent(initializedAt: number): PersistedGate {
  if (!Number.isSafeInteger(initializedAt) || initializedAt < 0) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  return {
    authority: AUTHORITY,
    createdAt: initializedAt,
    effect: EFFECT,
    expiresAt: null,
    generation: 0,
    operationDigest: null,
    outcome: "NONE",
    receiptDigest: null,
    schemaVersion: 1,
    state: "OPEN",
    updatedAt: initializedAt,
  };
}

/** Initialize only a fail-closed fixture coordination ledger, never authority. */
export async function initializeCredentialExecutionGate(
  root: string,
  initializedAt: number,
): Promise<"INITIALIZED" | "REPLAY"> {
  const initial = initialCurrent(initializedAt);
  if (!root) throw new CredentialExecutionGateError("INVALID_INPUT");
  await ensurePrivateDirectory(root, true);
  await ensurePrivateDirectory(gateDirectory(root), false);
  const ownership = await acquireLock(root);
  let result: "INITIALIZED" | "REPLAY" = "INITIALIZED";
  try {
    let initialized = false;
    try {
      await readSentinel(gatePath(root, SENTINEL));
      initialized = true;
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
    }
    if (initialized) {
      await readCurrent(gatePath(root, CURRENT));
      result = "REPLAY";
    } else {
      try {
        const partial = await readCurrent(gatePath(root, CURRENT));
        if (
          partial.generation !== 0 ||
          partial.state !== "OPEN" ||
          partial.operationDigest !== null ||
          partial.outcome !== "NONE" ||
          partial.receiptDigest !== null ||
          partial.expiresAt !== null
        ) {
          throw new CredentialExecutionGateError("UNAVAILABLE");
        }
      } catch (currentError) {
        if (errorCode(currentError) !== "ENOENT") throw currentError;
        await atomicWrite(
          gateDirectory(root),
          gatePath(root, CURRENT),
          serializeCurrent(initial),
          false,
        );
      }
      await atomicWrite(
        gateDirectory(root),
        gatePath(root, SENTINEL),
        sentinelContents,
        false,
      );
    }
  } finally {
    await releaseLock(root, ownership);
  }
  return result;
}

/** Only an absent gate directory is uninitialized; partial setup is UNKNOWN. */
export async function readCredentialExecutionGate(
  root: string,
): Promise<CredentialExecutionGateSnapshot> {
  if (!root) return { kind: "UNKNOWN" };
  try {
    const rootState = await inspectPrivateDirectory(root);
    if (rootState === "MISSING") return { kind: "UNINITIALIZED" };
    if (rootState !== "PRIVATE") return { kind: "UNKNOWN" };
    const directoryState = await inspectPrivateDirectory(gateDirectory(root));
    if (directoryState === "MISSING") return { kind: "UNINITIALIZED" };
    if (directoryState !== "PRIVATE") return { kind: "UNKNOWN" };
    try {
      await readSentinel(gatePath(root, SENTINEL));
    } catch {
      return { kind: "UNKNOWN" };
    }
    try {
      await lstat(gatePath(root, LOCK));
      return { kind: "UNKNOWN" };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return { kind: "UNKNOWN" };
    }
    const snapshot: CredentialExecutionGateSnapshot = {
      kind: "KNOWN",
      ...(await readCurrent(gatePath(root, CURRENT))),
    };
    try {
      await lstat(gatePath(root, LOCK));
      return { kind: "UNKNOWN" };
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return { kind: "UNKNOWN" };
    }
    return snapshot;
  } catch {
    return { kind: "UNKNOWN" };
  }
}

/** NO_LEDGER_BLOCK is not permission; every other admission gate still applies. */
export function credentialExecutionGateBlockStatus(
  snapshot: CredentialExecutionGateSnapshot,
): "BLOCK_AGENT_EXECUTION" | "NO_LEDGER_BLOCK" {
  return snapshot.kind === "KNOWN" && snapshot.state === "OPEN"
    ? "NO_LEDGER_BLOCK"
    : "BLOCK_AGENT_EXECUTION";
}

export type CredentialExecutionGateComparison =
  | "BLOCKED"
  | "CHANGED"
  | "OPEN"
  | "UNKNOWN";

/** Future Host Pre paths must compare snapshots before and after their lock. */
export function compareCredentialExecutionGates(
  initial: CredentialExecutionGateSnapshot,
  current: CredentialExecutionGateSnapshot,
): CredentialExecutionGateComparison {
  if (initial.kind !== "KNOWN" || current.kind !== "KNOWN") return "UNKNOWN";
  if (initial.state !== "OPEN" || current.state !== "OPEN") return "BLOCKED";
  return initial.authority === current.authority &&
    initial.createdAt === current.createdAt &&
    initial.effect === current.effect &&
    initial.expiresAt === current.expiresAt &&
    initial.generation === current.generation &&
    initial.operationDigest === current.operationDigest &&
    initial.outcome === current.outcome &&
    initial.receiptDigest === current.receiptDigest &&
    initial.schemaVersion === current.schemaVersion &&
    initial.updatedAt === current.updatedAt
    ? "OPEN"
    : "CHANGED";
}

/** Package-internal parser shared by the locked credential coordinator. */
export function credentialExecutionBinding(
  binding: FixtureCredentialExecutionBinding,
): {
  digest: string;
  ticket: CredentialEnclaveTicket;
} {
  if (
    !binding ||
    typeof binding !== "object" ||
    Object.keys(binding).sort().join(",") !==
      "hookDefinitionHash,hostProfileHash,ticket,trustRootHash" ||
    !HASH.test(binding.hookDefinitionHash) ||
    !HASH.test(binding.hostProfileHash) ||
    !HASH.test(binding.trustRootHash)
  ) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  let ticket: CredentialEnclaveTicket;
  try {
    ticket = CredentialEnclaveTicketSchema.parse(binding.ticket);
  } catch {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  if (!hasValidFixtureCredentialTicketId(ticket)) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  return {
    digest: deterministicDigest("oxrail-credential-execution-gate-v1", {
      hookDefinitionHash: binding.hookDefinitionHash,
      hostProfileHash: binding.hostProfileHash,
      ticket,
      trustRootHash: binding.trustRootHash,
    }),
    ticket,
  };
}

const targetState: Record<
  CredentialExecutionGateEventKind,
  CredentialExecutionGateState
> = {
  ACTIVATE: "ACTIVE",
  ABORT_PREPARING: "CLEANUP_PENDING",
  BEGIN_CLEANUP: "CLEANUP_PENDING",
  FINISH_CLEANUP: "OPEN",
  PREPARE: "PREPARING",
};

const predecessor: Record<
  CredentialExecutionGateEventKind,
  CredentialExecutionGateState
> = {
  ACTIVATE: "PREPARING",
  ABORT_PREPARING: "PREPARING",
  BEGIN_CLEANUP: "ACTIVE",
  FINISH_CLEANUP: "CLEANUP_PENDING",
  PREPARE: "OPEN",
};

function quiescenceReceiptDigest(
  receiptHash: string,
  operation: string,
  generation: number,
): string {
  if (!HASH.test(receiptHash)) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  return deterministicDigest("oxrail-credential-quiescence-receipt-v1", {
    generation,
    operationDigest: operation,
    quiescenceReceiptHash: receiptHash,
  });
}

function cleanupEvidenceDigest(
  evidenceHash: string,
  operation: string,
  generation: number,
): string {
  if (!HASH.test(evidenceHash)) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  return deterministicDigest("oxrail-credential-cleanup-evidence-v1", {
    cleanupEvidenceHash: evidenceHash,
    generation,
    operationDigest: operation,
  });
}

function cleanupTombstoneDigest(
  evidenceHash: string,
  operation: string,
  generation: number,
): string {
  return deterministicDigest("oxrail-credential-cleanup-tombstone-v1", {
    cleanupEvidenceDigest: cleanupEvidenceDigest(
      evidenceHash,
      operation,
      generation,
    ),
    operationDigest: operation,
  });
}

function fixtureResetMarker(
  operation: string,
  generation: number,
  expiresAt: number,
  outcome: "ABORTED" | "ACTIVATED",
): string {
  return deterministicDigest(
    "oxrail-credential-fixture-local-ledger-reset-v1",
    {
      effect: FIXTURE_RESET_EFFECT,
      expiresAt,
      generation,
      operationDigest: operation,
      outcome,
    },
  );
}

function credentialFixtureCleanupState(
  current: PersistedGate,
  parsed: ReturnType<typeof credentialExecutionBinding>,
  generation: number,
): "BLOCKED" | "OPEN" {
  if (
    current.generation !== generation ||
    current.expiresAt !== parsed.ticket.handoff.expiresAt ||
    current.createdAt < parsed.ticket.issuedAt ||
    current.createdAt > parsed.ticket.handoff.expiresAt
  ) {
    throw new CredentialExecutionGateError("INVALID_TRANSITION");
  }
  if (current.state === "OPEN") {
    if (
      current.outcome === "NONE" ||
      current.operationDigest !==
        cleanupTombstoneDigest(
          fixtureResetMarker(
            parsed.digest,
            generation,
            parsed.ticket.handoff.expiresAt,
            current.outcome,
          ),
          parsed.digest,
          generation,
        )
    ) {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    return "OPEN";
  }
  if (
    current.operationDigest !== parsed.digest ||
    !["ACTIVE", "CLEANUP_PENDING", "PREPARING"].includes(current.state)
  ) {
    throw new CredentialExecutionGateError("INVALID_TRANSITION");
  }
  return "BLOCKED";
}

function validateTransition(
  root: string,
  event: CredentialExecutionGateEvent,
): ReturnType<typeof credentialExecutionBinding> {
  if (
    !root ||
    !event ||
    typeof event !== "object" ||
    Object.keys(event).sort().join(",") !==
      (event.kind === "PREPARE"
        ? "binding,generation,kind,observedAt"
        : event.kind === "FINISH_CLEANUP"
          ? "binding,cleanupEvidenceHash,generation,kind,observedAt"
          : "binding,generation,kind,observedAt,quiescenceReceiptHash") ||
    !Object.hasOwn(targetState, event.kind) ||
    !Number.isSafeInteger(event.generation) ||
    event.generation <= 0 ||
    !Number.isSafeInteger(event.observedAt) ||
    event.observedAt < 0
  ) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  const parsed = credentialExecutionBinding(event.binding);
  if (
    parsed.ticket.issuedAt < parsed.ticket.handoff.acquiredAt ||
    parsed.ticket.issuedAt > parsed.ticket.handoff.expiresAt ||
    parsed.ticket.handoff.expiresAt <= parsed.ticket.handoff.acquiredAt ||
    (["ACTIVATE", "PREPARE"].includes(event.kind) &&
      (event.observedAt < parsed.ticket.handoff.acquiredAt ||
        event.observedAt < parsed.ticket.issuedAt ||
        event.observedAt > parsed.ticket.handoff.expiresAt))
  ) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  return parsed;
}

async function applyCredentialExecutionGateTransition(
  root: string,
  event: CredentialExecutionGateEvent,
  current: PersistedGate,
  parsed: ReturnType<typeof credentialExecutionBinding>,
): Promise<"APPLIED" | "REPLAY"> {
  const { digest, ticket: parsedTicket } = parsed;
  const target = targetState[event.kind];
  const suppliedQuiescenceReceipt =
    event.kind === "PREPARE" || event.kind === "FINISH_CLEANUP"
      ? null
      : quiescenceReceiptDigest(
          event.quiescenceReceiptHash,
          digest,
          event.generation,
        );
  const resultingReceipt =
    event.kind === "ACTIVATE" || event.kind === "ABORT_PREPARING"
      ? suppliedQuiescenceReceipt
      : event.kind === "BEGIN_CLEANUP"
        ? current.receiptDigest
        : null;
  const resultingOutcome =
    event.kind === "ACTIVATE" || event.kind === "BEGIN_CLEANUP"
      ? "ACTIVATED"
      : event.kind === "ABORT_PREPARING"
        ? "ABORTED"
        : event.kind === "PREPARE"
          ? "NONE"
          : current.outcome;
  const resultingOperation =
    event.kind === "FINISH_CLEANUP"
      ? cleanupTombstoneDigest(
          event.cleanupEvidenceHash,
          digest,
          event.generation,
        )
      : digest;
  if (
    current.state === target &&
    current.generation === event.generation &&
    current.operationDigest === resultingOperation &&
    current.updatedAt === event.observedAt &&
    (target === "OPEN" || current.receiptDigest === resultingReceipt) &&
    (event.kind !== "BEGIN_CLEANUP" ||
      current.receiptDigest === suppliedQuiescenceReceipt) &&
    current.outcome === resultingOutcome
  ) {
    return "REPLAY";
  }
  const generationMatches =
    event.kind === "PREPARE"
      ? current.generation < Number.MAX_SAFE_INTEGER &&
        event.generation === current.generation + 1
      : event.generation === current.generation;
  if (
    current.state !== predecessor[event.kind] ||
    !generationMatches ||
    (event.kind !== "PREPARE" && current.operationDigest !== digest) ||
    (event.kind !== "PREPARE" &&
      current.expiresAt !== parsedTicket.handoff.expiresAt) ||
    (event.kind === "BEGIN_CLEANUP" &&
      current.receiptDigest !== suppliedQuiescenceReceipt) ||
    (event.kind === "FINISH_CLEANUP" &&
      (current.receiptDigest === null ||
        current.receiptDigest ===
          quiescenceReceiptDigest(
            event.cleanupEvidenceHash,
            digest,
            event.generation,
          ))) ||
    event.observedAt < current.updatedAt
  ) {
    throw new CredentialExecutionGateError("INVALID_TRANSITION");
  }
  const replacement: PersistedGate = {
    authority: AUTHORITY,
    createdAt: event.kind === "PREPARE" ? event.observedAt : current.createdAt,
    effect: EFFECT,
    expiresAt:
      event.kind === "PREPARE"
        ? parsedTicket.handoff.expiresAt
        : current.expiresAt,
    generation: event.generation,
    operationDigest: resultingOperation,
    outcome: resultingOutcome,
    receiptDigest: resultingReceipt,
    schemaVersion: 1,
    state: target,
    updatedAt: event.observedAt,
  };
  await atomicWrite(
    gateDirectory(root),
    gatePath(root, CURRENT),
    serializeCurrent(replacement),
    true,
  );
  return "APPLIED";
}

async function withCredentialExecutionGateFileLock<Result>(
  root: string,
  operation: (current: PersistedGate) => Promise<Result>,
): Promise<Result> {
  if (
    (await inspectPrivateDirectory(root)) !== "PRIVATE" ||
    (await inspectPrivateDirectory(gateDirectory(root))) !== "PRIVATE"
  ) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  const ownership = await acquireLock(root);
  try {
    await readSentinel(gatePath(root, SENTINEL));
    const current = await readCurrent(gatePath(root, CURRENT));
    return await operation(current);
  } catch (error) {
    if (error instanceof CredentialExecutionGateError) throw error;
    throw new CredentialExecutionGateError("UNAVAILABLE");
  } finally {
    await releaseLock(root, ownership);
  }
}

/**
 * Package-internal read used only while the coordinator holds the global
 * credential fence. Callers coupling Handoff state also hold its task lock.
 * The read recovers a dead gate file lock.
 */
export async function readCredentialExecutionGateLocked(
  root: string,
): Promise<Extract<CredentialExecutionGateSnapshot, { kind: "KNOWN" }>> {
  return withCredentialExecutionGateFileLock(root, async (current) => ({
    ...current,
    kind: "KNOWN",
  }));
}

/**
 * Advance the global fixture ledger. ACTIVE is a conservative blocking fact;
 * it never proves protection, launches a helper, or authorizes secret use.
 */
async function transitionCredentialExecutionGateLocked(
  root: string,
  event: CredentialExecutionGateEvent,
): Promise<"APPLIED" | "REPLAY"> {
  const parsed = validateTransition(root, event);
  return withCredentialExecutionGateFileLock(root, (current) =>
    applyCredentialExecutionGateTransition(root, event, current, parsed),
  );
}

/** Package-internal PREPARE entry; the caller must hold the global fence lock. */
export async function prepareCredentialExecutionGateLocked(
  root: string,
  binding: FixtureCredentialExecutionBinding,
  observedAt: number,
): Promise<number> {
  const input = {
    binding,
    generation: 1,
    kind: "PREPARE",
    observedAt,
  } as const;
  const parsed = validateTransition(root, input);
  return withCredentialExecutionGateFileLock(root, async (current) => {
    if (
      current.state !== "OPEN" ||
      current.generation >= Number.MAX_SAFE_INTEGER
    ) {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    const generation = current.generation + 1;
    const result = await applyCredentialExecutionGateTransition(
      root,
      { ...input, generation },
      current,
      parsed,
    );
    if (result !== "APPLIED") {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    return generation;
  });
}

/**
 * Package-internal ACTIVATE entry; the coordinator must hold the global fence
 * and the matching Handoff task lock for the complete final snapshot + commit.
 */
export async function activateCredentialExecutionGateLocked(
  root: string,
  binding: FixtureCredentialExecutionBinding,
  generation: number,
  quiescenceReceiptHash: string,
  minimumObservedAt: number,
): Promise<number> {
  if (
    !root ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !HASH.test(quiescenceReceiptHash) ||
    !Number.isSafeInteger(minimumObservedAt) ||
    minimumObservedAt < 0
  ) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  credentialExecutionBinding(binding);
  return withCredentialExecutionGateFileLock(root, async (current) => {
    const observedAt = Date.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < minimumObservedAt) {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    const event = {
      binding,
      generation,
      kind: "ACTIVATE",
      observedAt,
      quiescenceReceiptHash,
    } as const;
    const parsed = validateTransition(root, event);
    const result = await applyCredentialExecutionGateTransition(
      root,
      event,
      current,
      parsed,
    );
    if (result !== "APPLIED") {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    const committedAt = Date.now();
    if (
      !Number.isSafeInteger(committedAt) ||
      committedAt < observedAt ||
      committedAt > parsed.ticket.handoff.expiresAt
    ) {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    return observedAt;
  });
}

/**
 * Package-internal reset for the no-external-effects fixture only. The caller
 * must hold the global credential fence mutex. Its marker is not cleanup
 * evidence, Host verification, credential authority, or permission to resume.
 */
export async function cleanupCredentialExecutionGateLocked(
  root: string,
  binding: FixtureCredentialExecutionBinding,
  generation: number,
): Promise<"ALREADY_OPEN" | "OPENED"> {
  if (!root || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  const parsed = credentialExecutionBinding(binding);
  return withCredentialExecutionGateFileLock(root, async (current) => {
    if (credentialFixtureCleanupState(current, parsed, generation) === "OPEN") {
      return "ALREADY_OPEN";
    }
    const outcome = current.state === "PREPARING" ? "ABORTED" : current.outcome;
    if (outcome === "NONE") {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    const resetMarker = fixtureResetMarker(
      parsed.digest,
      generation,
      parsed.ticket.handoff.expiresAt,
      outcome,
    );
    const transitionAt = Date.now();
    if (
      !Number.isSafeInteger(transitionAt) ||
      transitionAt < current.updatedAt
    ) {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }

    let cleanupPending = current;
    if (current.state === "PREPARING") {
      const abort = {
        binding,
        generation,
        kind: "ABORT_PREPARING",
        observedAt: transitionAt,
        quiescenceReceiptHash: deterministicDigest(
          "oxrail-credential-fixture-reset-abort-intent-v1",
          { resetMarker },
        ),
      } as const;
      const result = await applyCredentialExecutionGateTransition(
        root,
        abort,
        current,
        validateTransition(root, abort),
      );
      if (result !== "APPLIED") {
        throw new CredentialExecutionGateError("INVALID_TRANSITION");
      }
      cleanupPending = await readCurrent(gatePath(root, CURRENT));
    } else if (current.state === "ACTIVE") {
      cleanupPending = {
        ...current,
        state: "CLEANUP_PENDING",
        updatedAt: transitionAt,
      };
      await atomicWrite(
        gateDirectory(root),
        gatePath(root, CURRENT),
        serializeCurrent(cleanupPending),
        true,
      );
    }

    const openedAt = Date.now();
    if (
      !Number.isSafeInteger(openedAt) ||
      openedAt < cleanupPending.updatedAt
    ) {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    const finish = {
      binding,
      cleanupEvidenceHash: resetMarker,
      generation,
      kind: "FINISH_CLEANUP",
      observedAt: openedAt,
    } as const;
    const result = await applyCredentialExecutionGateTransition(
      root,
      finish,
      cleanupPending,
      validateTransition(root, finish),
    );
    if (result !== "APPLIED") {
      throw new CredentialExecutionGateError("INVALID_TRANSITION");
    }
    return "OPENED";
  });
}

/** Package-internal, read-only reconciliation after a cleanup error. */
export async function confirmCredentialExecutionGateCleanupLocked(
  root: string,
  binding: FixtureCredentialExecutionBinding,
  generation: number,
): Promise<"BLOCKED" | "OPEN"> {
  if (!root || !Number.isSafeInteger(generation) || generation <= 0) {
    throw new CredentialExecutionGateError("INVALID_INPUT");
  }
  const parsed = credentialExecutionBinding(binding);
  return withCredentialExecutionGateFileLock(root, async (current) =>
    credentialFixtureCleanupState(current, parsed, generation),
  );
}

export async function transitionCredentialExecutionGate(
  root: string,
  event: CredentialExecutionGateEvent,
): Promise<"APPLIED" | "REPLAY"> {
  validateTransition(root, event);
  if (
    (await inspectPrivateDirectory(root)) !== "PRIVATE" ||
    (await inspectPrivateDirectory(gateDirectory(root))) !== "PRIVATE"
  ) {
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
  try {
    return await withCredentialToolFenceLock(root, () =>
      transitionCredentialExecutionGateLocked(root, event),
    );
  } catch (error) {
    if (error instanceof CredentialExecutionGateError) throw error;
    throw new CredentialExecutionGateError("UNAVAILABLE");
  }
}
