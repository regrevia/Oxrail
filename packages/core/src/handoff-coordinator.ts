import { createHash, randomUUID } from "node:crypto";
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
  deterministicDigest,
  type BrowserTaskState,
} from "../../protocol/src/index.js";
import { type HandoffLease, transitionHandoffLease } from "./handoff.js";
import {
  canonicalPersistentToolUseId,
  persistentDocumentBinding,
  persistentHandoffId,
} from "./safe-state.js";
import { activateUserLease } from "./state.js";
import {
  readBoundedPrivateFile,
  transitionBrowserTaskState,
  transitionBrowserTaskStateWithRetry,
} from "./store.js";
import {
  inspectToolCallJournal,
  retireCompletedToolCalls,
} from "./tool-call.js";

const BARRIER_DIRECTORY = "handoff-barriers";
const MAX_BARRIER_BYTES = 1_024;
const TEMPORARY = /^\.lease-[0-9]+\.[a-f0-9-]{36}\.tmp$/;
const HASH = /^[a-f0-9]{64}$/;
const PERSISTENT_ID = /^oxrail-id:[a-f0-9]{64}$/;
const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

type PersistedHandoffBarrierState = "ACTIVE" | "CANCELLED" | "PREPARING";

interface PersistedHandoffBarrier {
  browserInstanceBindingHash: string | null;
  createdAt: number;
  expiresAt: number;
  handoffId: string;
  hostProfileBindingHash: string;
  hostProfileIdHash: string;
  leaseEpoch: number;
  nativeActionFenceHash: string | null;
  nonceDigest: string;
  schemaVersion: 1;
  scopeDigest: string;
  state: PersistedHandoffBarrierState;
  tabBindingReceiptHash: string | null;
  taskBindingDigest: string;
  updatedAt: number;
}

/**
 * Trusted Host output minted after this gate and all older native calls settle.
 * Hash equality checks binding consistency; only the external Host verifier can
 * establish authenticity and native-action coverage.
 */
export interface HandoffTabBindingAttestation {
  admissionGeneration: number;
  browserInstanceBindingHash: string;
  expiresAt: number;
  hostProfileBindingHash: string;
  nativeActionFenceHash: string;
  observedAt: number;
  receiptHash: string;
  scopeBindingHash: string;
}

export interface HandoffHostBinding {
  profileBindingHash: string;
  profileId: string;
}

interface PersistedHostBinding {
  hostProfileBindingHash: string;
  hostProfileIdHash: string;
}

export type VerifyHandoffTabBinding = (
  lease: HandoffLease,
) =>
  | HandoffTabBindingAttestation
  | undefined
  | Promise<HandoffTabBindingAttestation | undefined>;

export type HandoffGateSnapshot =
  | {
      generation: number;
      kind: "KNOWN";
      status: "ACTIVE" | "OPEN" | "PREPARING";
    }
  | { kind: "UNKNOWN" };

export type HandoffGateVerdict =
  | "ACTIVE"
  | "CHANGED"
  | "OPEN"
  | "PREPARING"
  | "UNKNOWN";

/** Pure admission check shared by the pre-lock and in-lock Hook paths. */
export function compareHandoffGates(
  initial: HandoffGateSnapshot,
  current: HandoffGateSnapshot,
): HandoffGateVerdict {
  if (initial.kind === "UNKNOWN" || current.kind === "UNKNOWN") {
    return "UNKNOWN";
  }
  if (initial.status === "ACTIVE" || current.status === "ACTIVE") {
    return "ACTIVE";
  }
  if (initial.status !== "OPEN" || current.status !== "OPEN") {
    return "PREPARING";
  }
  return initial.generation === current.generation ? "OPEN" : "CHANGED";
}

export type HandoffActivationResult =
  | { kind: "ACTIVE"; lease: HandoffLease }
  | { kind: "FAILED_SAFE" }
  | { kind: "WAITING_FOR_NATIVE" };

export type HandoffPreparationRecoveryResult =
  | "CANCELLED"
  | "NOT_EXPIRED"
  | "NOT_PREPARING"
  | "UNKNOWN"
  | "USER_LEASE_RECOVERY_REQUIRED";

const errorCode = (error: unknown): string | undefined =>
  error && typeof error === "object" && "code" in error
    ? String(error.code)
    : undefined;

function digest(domain: string, ...values: (number | string)[]): string {
  const hash = createHash("sha256").update(domain);
  for (const value of values) hash.update("\0").update(String(value));
  return hash.digest("hex");
}

const taskBindingDigest = (scope: { sessionId: string; taskId: string }) =>
  digest("oxrail-handoff-task-binding-v1", scope.sessionId, scope.taskId);

export const handoffScopeBindingHash = (scope: HandoffLease["scope"]) =>
  deterministicDigest("oxrail-handoff-scope-v1", {
    documentBindingHash: persistentDocumentBinding(scope.documentBinding),
    sessionId: scope.sessionId,
    tabId: scope.tabId,
    taskId: scope.taskId,
    topOrigin: scope.topOrigin,
  });

function persistedHostBinding(
  binding: HandoffHostBinding,
): PersistedHostBinding {
  if (
    !SAFE_PROFILE_ID.test(binding.profileId) ||
    !HASH.test(binding.profileBindingHash)
  ) {
    throw new TypeError("invalid Host Profile binding");
  }
  return {
    hostProfileBindingHash: binding.profileBindingHash,
    hostProfileIdHash: digest(
      "oxrail-handoff-host-profile-id-v1",
      binding.profileId,
    ),
  };
}

const safeTaskScope = (scope: { sessionId: string; taskId: string }) =>
  scope.sessionId.length > 0 &&
  !scope.sessionId.includes("\0") &&
  scope.taskId.length > 0 &&
  !scope.taskId.includes("\0");

const barrierDirectory = (
  root: string,
  scope: { sessionId: string; taskId: string },
) =>
  path.join(
    root,
    BARRIER_DIRECTORY,
    digest("oxrail-handoff-session-v1", scope.sessionId),
    digest("oxrail-handoff-task-v1", scope.taskId),
  );

const barrierPath = (
  root: string,
  scope: { sessionId: string; taskId: string },
  leaseEpoch: number,
) => path.join(barrierDirectory(root, scope), `lease-${leaseEpoch}.json`);

async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("handoff barrier path is unavailable");
  }
  await chmod(directory, 0o700);
}

async function ensureBarrierDirectory(
  root: string,
  scope: { sessionId: string; taskId: string },
): Promise<string> {
  const directory = barrierDirectory(root, scope);
  await privateDirectory(root);
  await privateDirectory(path.join(root, BARRIER_DIRECTORY));
  await privateDirectory(path.dirname(directory));
  await privateDirectory(directory);
  return directory;
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

function serializeBarrier(barrier: PersistedHandoffBarrier): string {
  const contents = `${JSON.stringify(barrier)}\n`;
  if (Buffer.byteLength(contents) > MAX_BARRIER_BYTES) {
    throw new Error("handoff barrier exceeds local limit");
  }
  return contents;
}

function parseBarrier(value: unknown): PersistedHandoffBarrier {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      "browserInstanceBindingHash,createdAt,expiresAt,handoffId,hostProfileBindingHash,hostProfileIdHash,leaseEpoch,nativeActionFenceHash,nonceDigest,schemaVersion,scopeDigest,state,tabBindingReceiptHash,taskBindingDigest,updatedAt"
  ) {
    throw new Error("invalid handoff barrier");
  }
  const barrier = value as Partial<PersistedHandoffBarrier>;
  if (
    barrier.schemaVersion !== 1 ||
    !PERSISTENT_ID.test(barrier.handoffId ?? "") ||
    !Number.isSafeInteger(barrier.leaseEpoch) ||
    barrier.leaseEpoch! <= 0 ||
    !Number.isSafeInteger(barrier.createdAt) ||
    barrier.createdAt! < 0 ||
    !Number.isSafeInteger(barrier.updatedAt) ||
    barrier.updatedAt! < barrier.createdAt! ||
    !Number.isSafeInteger(barrier.expiresAt) ||
    barrier.expiresAt! <= barrier.createdAt! ||
    !HASH.test(barrier.nonceDigest ?? "") ||
    !HASH.test(barrier.scopeDigest ?? "") ||
    !HASH.test(barrier.taskBindingDigest ?? "") ||
    !HASH.test(barrier.hostProfileBindingHash ?? "") ||
    !HASH.test(barrier.hostProfileIdHash ?? "") ||
    (barrier.browserInstanceBindingHash !== null &&
      !HASH.test(barrier.browserInstanceBindingHash ?? "")) ||
    (barrier.nativeActionFenceHash !== null &&
      !HASH.test(barrier.nativeActionFenceHash ?? "")) ||
    (barrier.tabBindingReceiptHash !== null &&
      !HASH.test(barrier.tabBindingReceiptHash ?? "")) ||
    (barrier.state === "ACTIVE" &&
      (barrier.browserInstanceBindingHash === null ||
        barrier.nativeActionFenceHash === null ||
        barrier.tabBindingReceiptHash === null)) ||
    (barrier.state !== "ACTIVE" &&
      (barrier.browserInstanceBindingHash !== null ||
        barrier.nativeActionFenceHash !== null ||
        barrier.tabBindingReceiptHash !== null)) ||
    !["ACTIVE", "CANCELLED", "PREPARING"].includes(barrier.state ?? "")
  ) {
    throw new Error("invalid handoff barrier");
  }
  return barrier as PersistedHandoffBarrier;
}

async function readBarrier(filename: string): Promise<PersistedHandoffBarrier> {
  const { contents } = await readBoundedPrivateFile(
    filename,
    MAX_BARRIER_BYTES,
    "UNAVAILABLE",
  );
  return parseBarrier(JSON.parse(contents.toString("utf8")));
}

function barrierForLease(
  lease: HandoffLease,
  state: PersistedHandoffBarrierState,
  updatedAt: number,
  host: PersistedHostBinding,
  attestation?: HandoffTabBindingAttestation,
): PersistedHandoffBarrier {
  if (
    lease.schemaVersion !== 1 ||
    lease.state !== "PENDING" ||
    lease.holder !== "NONE" ||
    !Number.isSafeInteger(lease.leaseEpoch) ||
    lease.leaseEpoch <= 0 ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < lease.acquiredAt ||
    (state !== "CANCELLED" && updatedAt > lease.expiresAt)
  ) {
    throw new TypeError("invalid pending handoff lease");
  }
  if (
    (state === "ACTIVE") !== Boolean(attestation) ||
    (attestation &&
      (attestation.admissionGeneration !== lease.leaseEpoch ||
        !HASH.test(attestation.browserInstanceBindingHash) ||
        attestation.hostProfileBindingHash !== host.hostProfileBindingHash ||
        !HASH.test(attestation.nativeActionFenceHash) ||
        !HASH.test(attestation.receiptHash) ||
        attestation.scopeBindingHash !== handoffScopeBindingHash(lease.scope)))
  ) {
    throw new TypeError("invalid handoff attestation");
  }
  return {
    browserInstanceBindingHash: attestation?.browserInstanceBindingHash ?? null,
    createdAt: lease.acquiredAt,
    expiresAt: lease.expiresAt,
    handoffId: persistentHandoffId(lease.handoffId),
    hostProfileBindingHash: host.hostProfileBindingHash,
    hostProfileIdHash: host.hostProfileIdHash,
    leaseEpoch: lease.leaseEpoch,
    nativeActionFenceHash: attestation?.nativeActionFenceHash ?? null,
    nonceDigest: digest("oxrail-handoff-nonce-v1", lease.nonce),
    schemaVersion: 1,
    scopeDigest: handoffScopeBindingHash(lease.scope),
    state,
    tabBindingReceiptHash: attestation?.receiptHash ?? null,
    taskBindingDigest: taskBindingDigest(lease.scope),
    updatedAt,
  };
}

function sameLease(
  barrier: PersistedHandoffBarrier,
  expected: PersistedHandoffBarrier,
): boolean {
  return (
    barrier.createdAt === expected.createdAt &&
    barrier.expiresAt === expected.expiresAt &&
    barrier.handoffId === expected.handoffId &&
    barrier.hostProfileBindingHash === expected.hostProfileBindingHash &&
    barrier.hostProfileIdHash === expected.hostProfileIdHash &&
    barrier.leaseEpoch === expected.leaseEpoch &&
    barrier.nonceDigest === expected.nonceDigest &&
    barrier.scopeDigest === expected.scopeDigest &&
    barrier.taskBindingDigest === expected.taskBindingDigest
  );
}

async function createBarrier(
  directory: string,
  destination: string,
  barrier: PersistedHandoffBarrier,
): Promise<"CREATED" | "EXISTS"> {
  const temporary = path.join(
    directory,
    `.lease-${barrier.leaseEpoch}.${randomUUID()}.tmp`,
  );
  let handle;
  let committed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serializeBarrier(barrier), "utf8");
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
    if (committed) return "CREATED";
    throw error;
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function replaceBarrier(
  root: string,
  lease: HandoffLease,
  updatedAt: number,
  host: PersistedHostBinding,
  attestation: HandoffTabBindingAttestation,
): Promise<void> {
  const directory = barrierDirectory(root, lease.scope);
  const destination = barrierPath(root, lease.scope, lease.leaseEpoch);
  const current = await readBarrier(destination);
  const replacement = barrierForLease(
    lease,
    "ACTIVE",
    updatedAt,
    host,
    attestation,
  );
  if (!sameLease(current, replacement) || current.state === "CANCELLED") {
    throw new Error("handoff barrier binding mismatch");
  }
  if (current.state === "ACTIVE") {
    if (
      current.browserInstanceBindingHash !==
        attestation.browserInstanceBindingHash ||
      current.nativeActionFenceHash !== attestation.nativeActionFenceHash ||
      current.tabBindingReceiptHash !== attestation.receiptHash
    ) {
      throw new Error("handoff attestation changed");
    }
    return;
  }
  if (current.state !== "PREPARING") {
    throw new Error("invalid handoff barrier transition");
  }

  const temporary = path.join(
    directory,
    `.lease-${lease.leaseEpoch}.${randomUUID()}.tmp`,
  );
  let handle;
  let committed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serializeBarrier(replacement), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    committed = true;
    await syncDirectory(directory);
  } catch (error) {
    if (!committed) throw error;
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

async function cancelBarrier(
  root: string,
  lease: HandoffLease,
  updatedAt: number,
): Promise<void> {
  const destination = barrierPath(root, lease.scope, lease.leaseEpoch);
  const current = await readBarrier(destination);
  const replacement = barrierForLease(lease, "CANCELLED", updatedAt, {
    hostProfileBindingHash: current.hostProfileBindingHash,
    hostProfileIdHash: current.hostProfileIdHash,
  });
  if (!sameLease(current, replacement) || current.state !== "PREPARING") {
    throw new Error("handoff barrier cannot be cancelled");
  }
  await writeBarrierReplacement(
    root,
    lease.scope,
    lease.leaseEpoch,
    replacement,
  );
}

async function writeBarrierReplacement(
  root: string,
  scope: { sessionId: string; taskId: string },
  leaseEpoch: number,
  replacement: PersistedHandoffBarrier,
): Promise<void> {
  const directory = barrierDirectory(root, scope);
  const destination = barrierPath(root, scope, leaseEpoch);
  const temporary = path.join(
    directory,
    `.lease-${leaseEpoch}.${randomUUID()}.tmp`,
  );
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serializeBarrier(replacement), "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    await syncDirectory(directory);
  } finally {
    await handle?.close();
    await unlink(temporary).catch(() => undefined);
  }
}

/** Persist the browser-action barrier before attempting the task-state lock. */
export async function prepareHandoffBarrier(
  root: string,
  lease: HandoffLease,
  host: HandoffHostBinding,
  clock: () => number = Date.now,
): Promise<"PREPARED" | "REPLAY"> {
  if (!safeTaskScope(lease.scope)) {
    throw new TypeError("invalid handoff task scope");
  }
  const persistedHost = persistedHostBinding(host);
  const directory = await ensureBarrierDirectory(root, lease.scope);
  const destination = barrierPath(root, lease.scope, lease.leaseEpoch);
  const preparedAt = clock();
  if (!Number.isSafeInteger(preparedAt) || preparedAt < 0) {
    throw new TypeError("invalid handoff preparation time");
  }
  const barrier = barrierForLease(
    lease,
    "PREPARING",
    preparedAt,
    persistedHost,
  );
  try {
    const existing = await readBarrier(destination);
    if (!sameLease(existing, barrier) || existing.state === "CANCELLED") {
      throw new Error("another handoff owns this lease epoch");
    }
    return "REPLAY";
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  const before = await readHandoffGate(root, lease.scope);
  if (
    before.kind === "UNKNOWN" ||
    before.status !== "OPEN" ||
    before.generation !== lease.leaseEpoch - 1
  ) {
    throw new Error("handoff admission gate is not open");
  }
  if ((await createBarrier(directory, destination, barrier)) === "CREATED") {
    return "PREPARED";
  }
  const existing = await readBarrier(destination);
  if (!sameLease(existing, barrier) || existing.state === "CANCELLED") {
    throw new Error("another handoff owns this lease epoch");
  }
  return "REPLAY";
}

/** Lock-free admission snapshot; callers re-read its generation under task lock. */
export async function readHandoffGate(
  root: string,
  scope: { sessionId: string; taskId: string },
): Promise<HandoffGateSnapshot> {
  if (!safeTaskScope(scope)) return { kind: "UNKNOWN" };
  try {
    const directory = barrierDirectory(root, scope);
    let entries;
    try {
      const metadata = await lstat(directory);
      if (
        !metadata.isDirectory() ||
        metadata.isSymbolicLink() ||
        (metadata.mode & 0o077) !== 0
      ) {
        return { kind: "UNKNOWN" };
      }
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return errorCode(error) === "ENOENT"
        ? { generation: 0, kind: "KNOWN", status: "OPEN" }
        : { kind: "UNKNOWN" };
    }
    const barriers: PersistedHandoffBarrier[] = [];
    for (const entry of entries) {
      if (entry.isFile() && TEMPORARY.test(entry.name)) continue;
      const match = /^lease-([1-9][0-9]*)\.json$/.exec(entry.name);
      if (!entry.isFile() || !match) {
        return { kind: "UNKNOWN" };
      }
      const barrier = await readBarrier(path.join(directory, entry.name));
      if (
        barrier.taskBindingDigest !== taskBindingDigest(scope) ||
        barrier.leaseEpoch !== Number(match[1])
      ) {
        return { kind: "UNKNOWN" };
      }
      barriers.push(barrier);
    }
    if (barriers.length === 0) {
      return { generation: 0, kind: "KNOWN", status: "OPEN" };
    }
    barriers.sort((left, right) => left.leaseEpoch - right.leaseEpoch);
    if (barriers.slice(0, -1).some(({ state }) => state !== "CANCELLED")) {
      return { kind: "UNKNOWN" };
    }
    const current = barriers.at(-1)!;
    return {
      generation: current.leaseEpoch,
      kind: "KNOWN",
      status: current.state === "CANCELLED" ? "OPEN" : current.state,
    };
  } catch {
    return { kind: "UNKNOWN" };
  }
}

function matchesActiveState(
  state: BrowserTaskState,
  lease: HandoffLease,
): boolean {
  return (
    state.phase === "USER_LEASE_ACTIVE" &&
    state.pointerOwner === "HUMAN" &&
    state.leaseEpoch === lease.leaseEpoch &&
    state.activeHandoffId !== undefined &&
    state.activeHandoffId === persistentHandoffId(lease.handoffId)
  );
}

function matchesPreparedState(
  state: BrowserTaskState,
  lease: HandoffLease,
): boolean {
  return (
    state.phase === "RUNNING" &&
    state.pointerOwner === "NATIVE" &&
    state.leaseEpoch + 1 === lease.leaseEpoch &&
    state.currentOrigin === lease.scope.topOrigin &&
    state.documentBinding !== undefined &&
    state.documentBinding ===
      persistentDocumentBinding(lease.scope.documentBinding)
  );
}

/** Activate only after exact journal reconciliation while holding the task lock. */
export async function activatePreparedHandoff(
  root: string,
  lease: HandoffLease,
  host: HandoffHostBinding,
  verifyTabBinding: VerifyHandoffTabBinding,
  clock: () => number = Date.now,
): Promise<HandoffActivationResult> {
  try {
    if (!safeTaskScope(lease.scope)) return { kind: "FAILED_SAFE" };
    const expectedHost = persistedHostBinding(host);
    return await transitionBrowserTaskStateWithRetry<HandoffActivationResult>(
      root,
      lease.scope,
      async (state) => {
        const gate = await readHandoffGate(root, lease.scope);
        if (
          gate.kind !== "KNOWN" ||
          !["ACTIVE", "PREPARING"].includes(gate.status) ||
          gate.generation !== lease.leaseEpoch
        ) {
          return { value: { kind: "FAILED_SAFE" } as const };
        }
        const currentBarrier = await readBarrier(
          barrierPath(root, lease.scope, lease.leaseEpoch),
        );
        const expected = barrierForLease(
          lease,
          "PREPARING",
          currentBarrier.updatedAt,
          expectedHost,
        );
        if (
          !sameLease(currentBarrier, expected) ||
          !["ACTIVE", "PREPARING"].includes(currentBarrier.state) ||
          currentBarrier.state !== gate.status ||
          !state ||
          state.hostProfileId !== host.profileId ||
          currentBarrier.hostProfileBindingHash !==
            expectedHost.hostProfileBindingHash ||
          currentBarrier.hostProfileIdHash !== expectedHost.hostProfileIdHash
        ) {
          return { value: { kind: "FAILED_SAFE" } as const };
        }
        const alreadyActive = matchesActiveState(state, lease);
        if (currentBarrier.state === "ACTIVE") {
          if (!alreadyActive) {
            return { value: { kind: "FAILED_SAFE" } as const };
          }
          const replayAt = clock();
          if (!Number.isSafeInteger(replayAt) || replayAt < 0) {
            return { value: { kind: "FAILED_SAFE" } as const };
          }
          const replay = transitionHandoffLease(
            lease,
            {
              kind: "ACTIVATE",
              handoffId: lease.handoffId,
              leaseEpoch: lease.leaseEpoch,
              nonce: lease.nonce,
              scope: lease.scope,
              observedAt: currentBarrier.updatedAt,
            },
            replayAt,
          );
          return {
            afterCommit: async () => {
              await retireCompletedToolCalls(root, lease.scope, []);
            },
            value: replay.accepted
              ? ({ kind: "ACTIVE", lease: replay.lease } as const)
              : ({ kind: "FAILED_SAFE" } as const),
          };
        }
        let reconciled = state;
        if (!alreadyActive) {
          if (!matchesPreparedState(state, lease)) {
            return { value: { kind: "FAILED_SAFE" } as const };
          }
          const journal = await inspectToolCallJournal(root, lease.scope);
          if (journal.kind === "UNKNOWN") {
            return { value: { kind: "FAILED_SAFE" } as const };
          }
          if (journal.legacyPending || journal.pendingToolUseIds.length > 0) {
            return { value: { kind: "WAITING_FOR_NATIVE" } as const };
          }
          const completed = new Set(journal.completedToolUseIds);
          const pending = state.pendingNativeActionIds.map(
            canonicalPersistentToolUseId,
          );
          if (pending.some((toolUseId) => !completed.has(toolUseId))) {
            return { value: { kind: "FAILED_SAFE" } as const };
          }
          if (pending.length) {
            reconciled = { ...state, pendingNativeActionIds: [] };
          }
        }

        // The receipt must describe the tab after every older native action drained.
        const verified = await verifyTabBinding(lease);
        const verifiedAt = clock();
        if (
          !verified ||
          !Number.isSafeInteger(verifiedAt) ||
          verifiedAt < 0 ||
          verified.admissionGeneration !== lease.leaseEpoch ||
          !HASH.test(verified.browserInstanceBindingHash) ||
          verified.hostProfileBindingHash !==
            currentBarrier.hostProfileBindingHash ||
          !HASH.test(verified.nativeActionFenceHash) ||
          !HASH.test(verified.receiptHash) ||
          verified.scopeBindingHash !== handoffScopeBindingHash(lease.scope) ||
          !Number.isSafeInteger(verified.observedAt) ||
          verified.observedAt < currentBarrier.updatedAt ||
          verified.observedAt > verifiedAt ||
          !Number.isSafeInteger(verified.expiresAt) ||
          verified.observedAt > verified.expiresAt ||
          verified.expiresAt < verifiedAt ||
          verified.expiresAt > lease.expiresAt
        ) {
          return { value: { kind: "FAILED_SAFE" } as const };
        }
        const activation = transitionHandoffLease(
          lease,
          {
            kind: "ACTIVATE",
            handoffId: lease.handoffId,
            leaseEpoch: lease.leaseEpoch,
            nonce: lease.nonce,
            scope: lease.scope,
            observedAt: verifiedAt,
          },
          verifiedAt,
        );
        if (!activation.accepted) {
          return { value: { kind: "FAILED_SAFE" } as const };
        }
        return {
          afterCommit: async () => {
            await replaceBarrier(
              root,
              lease,
              verifiedAt,
              expectedHost,
              verified,
            );
            await retireCompletedToolCalls(root, lease.scope, []);
          },
          ...(alreadyActive
            ? {}
            : {
                state: activateUserLease(
                  reconciled,
                  lease.handoffId,
                  state.stateVersion,
                ),
              }),
          value: {
            kind: "ACTIVE",
            lease: activation.lease,
          } as const,
        };
      },
    );
  } catch {
    return { kind: "FAILED_SAFE" };
  }
}

/** Cancels only an expired preparation that provably never left Native ownership. */
export async function recoverExpiredHandoffPreparation(
  root: string,
  scope: { sessionId: string; taskId: string },
  now: number,
): Promise<HandoffPreparationRecoveryResult> {
  if (!safeTaskScope(scope) || !Number.isSafeInteger(now) || now < 0) {
    return "UNKNOWN";
  }
  try {
    return await transitionBrowserTaskStateWithRetry<HandoffPreparationRecoveryResult>(
      root,
      scope,
      async (state) => {
        const gate = await readHandoffGate(root, scope);
        if (gate.kind === "UNKNOWN") return { value: "UNKNOWN" as const };
        if (gate.status === "OPEN") {
          return { value: "NOT_PREPARING" as const };
        }
        const current = await readBarrier(
          barrierPath(root, scope, gate.generation),
        );
        if (
          current.state !== gate.status ||
          !state ||
          current.hostProfileIdHash !==
            digest("oxrail-handoff-host-profile-id-v1", state.hostProfileId)
        ) {
          return { value: "UNKNOWN" as const };
        }
        const userOwned =
          state.pointerOwner === "HUMAN" &&
          state.leaseEpoch === gate.generation &&
          state.activeHandoffId !== undefined &&
          state.activeHandoffId === current.handoffId;
        if (userOwned) {
          return { value: "USER_LEASE_RECOVERY_REQUIRED" as const };
        }
        if (gate.status !== "PREPARING") {
          return { value: "UNKNOWN" as const };
        }
        if (now <= current.expiresAt) {
          return { value: "NOT_EXPIRED" as const };
        }
        if (
          state.phase !== "RUNNING" ||
          state.pointerOwner !== "NATIVE" ||
          ![gate.generation - 1, gate.generation].includes(state.leaseEpoch)
        ) {
          return { value: "UNKNOWN" as const };
        }
        const cancelled: PersistedHandoffBarrier = {
          ...current,
          browserInstanceBindingHash: null,
          nativeActionFenceHash: null,
          state: "CANCELLED",
          tabBindingReceiptHash: null,
          updatedAt: now,
        };
        return {
          afterCommit: () =>
            writeBarrierReplacement(root, scope, gate.generation, cancelled),
          ...(state.leaseEpoch === gate.generation
            ? {}
            : {
                state: {
                  ...state,
                  leaseEpoch: gate.generation,
                  stateVersion: state.stateVersion + 1,
                },
              }),
          value: "CANCELLED" as const,
        };
      },
    );
  } catch {
    return "UNKNOWN";
  }
}

/** Cancel only an intent that provably never transferred browser ownership. */
export async function abandonPreparedHandoff(
  root: string,
  lease: HandoffLease,
  now: number,
): Promise<boolean> {
  if (!safeTaskScope(lease.scope)) return false;
  try {
    return await transitionBrowserTaskState<boolean>(
      root,
      lease.scope,
      async (state) => {
        const current = await readBarrier(
          barrierPath(root, lease.scope, lease.leaseEpoch),
        );
        const expected = barrierForLease(
          lease,
          "PREPARING",
          current.updatedAt,
          {
            hostProfileBindingHash: current.hostProfileBindingHash,
            hostProfileIdHash: current.hostProfileIdHash,
          },
        );
        if (
          state &&
          state.phase === "RUNNING" &&
          state.pointerOwner === "NATIVE" &&
          state.leaseEpoch === lease.leaseEpoch &&
          current.state === "CANCELLED" &&
          sameLease(current, expected)
        ) {
          return { value: true };
        }
        if (
          !state ||
          !matchesPreparedState(state, lease) ||
          !sameLease(current, expected) ||
          !["CANCELLED", "PREPARING"].includes(current.state)
        ) {
          return { value: false };
        }
        return {
          ...(current.state === "PREPARING"
            ? { afterCommit: () => cancelBarrier(root, lease, now) }
            : {}),
          state: {
            ...state,
            leaseEpoch: lease.leaseEpoch,
            stateVersion: state.stateVersion + 1,
          },
          value: true,
        };
      },
    );
  } catch {
    return false;
  }
}
