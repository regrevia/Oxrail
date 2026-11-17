import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
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
  CredentialHostSuspensionReceiptSchema,
  HandoffCurrentTabReceiptSchema,
  deterministicDigest,
  type BrowserTaskState,
  type CredentialEnclaveTicket,
  type CredentialHostSuspensionReceipt,
  type CredentialUseRegistryEntry,
  type HandoffCurrentTabReceipt,
} from "../../protocol/src/index.js";
import {
  bindCredentialIntentToActivationAnchor,
  CredentialAdmissionError,
} from "./credential-admission.js";
import {
  activateCredentialExecutionGateLocked,
  cleanupCredentialExecutionGateLocked,
  confirmCredentialExecutionGateCleanupLocked,
  credentialExecutionBinding,
  prepareCredentialExecutionGateLocked,
  readCredentialExecutionGate,
  readCredentialExecutionGateLocked,
  type FixtureCredentialExecutionBinding,
} from "./credential-execution-gate.js";
import {
  observeCredentialToolFenceCleanupLocked,
  observeCredentialToolFenceLocked,
} from "./credential-tool-fence.js";
import { withCredentialToolFenceLock } from "./credential-tool-fence-lock.js";
import {
  evaluateCompletionCandidate,
  type CompletionCandidate,
  type CompletionCandidateInput,
} from "./handoff-completion.js";
export type { CompletionCandidateInput } from "./handoff-completion.js";
import { type HandoffLease, transitionHandoffLease } from "./handoff.js";
import {
  canonicalPersistentDocumentBinding,
  canonicalPersistentHandoffId,
  canonicalPersistentToolUseId,
  persistentDocumentBinding,
  persistentHandoffId,
} from "./safe-state.js";
import { activateUserLease, beginHandoffVerification } from "./state.js";
import {
  readBoundedPrivateFile,
  transitionBrowserTaskState,
  transitionBrowserTaskStateWithRetry,
} from "./store.js";
import {
  countActiveToolCalls,
  inspectToolCallJournal,
  retireCompletedToolCalls,
} from "./tool-call.js";

const BARRIER_DIRECTORY = "handoff-barriers";
const MAX_BARRIER_BYTES = 1_024;
const TEMPORARY = /^\.lease-[0-9]+\.[a-f0-9-]{36}\.tmp$/;
const HASH = /^[a-f0-9]{64}$/;
const PERSISTENT_ID = /^oxrail-id:[a-f0-9]{64}$/;
const SAFE_PROFILE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const COMPLETION_OBSERVER_TIMEOUT_MS = 1_000;
const CREDENTIAL_SUSPENSION_OBSERVER_TIMEOUT_MS = 1_000;
const MAX_CREDENTIAL_SUSPENSION_RECEIPT_BYTES = 4 * 1024;
const MAX_ATTEMPTED_VERIFIER_CONTEXTS = 256;
const FIXTURE_ORIGIN = "http://127.0.0.1:4173";
// ponytail: process-local fixture ceiling; replace with the authenticated
// challenge-consumption ledger before enabling a production Host adapter.
const attemptedCompletionPairs = new Map<string, number>();
// ponytail: process-local fixture ceiling; replace with a launcher-owned,
// authenticated challenge ledger before enabling the production Host adapter.
const attemptedCredentialSuspensions = new Set<string>();
const observedCredentialSuspensionFences = new Set<string>();

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

export interface HandoffCurrentTabQuery {
  activationNativeActionFenceHash: string;
  activationTabBindingReceiptHash: string;
  admissionGeneration: number;
  authority: "FIXTURE_ONLY_NON_AUTHORIZING";
  browserInstanceBindingHash: string;
  candidateDigest: string;
  hostProfileBindingHash: string;
  lastAcceptedProbeSequence: number;
  schemaVersion: 1;
  stateEpoch: number;
  tabId: number;
  verifierContextBindingHash: string;
}

export type ObserveHandoffCurrentTab = (
  query: HandoffCurrentTabQuery,
  signal: AbortSignal,
) =>
  | HandoffCurrentTabReceipt
  | undefined
  | Promise<HandoffCurrentTabReceipt | undefined>;

export interface CredentialHostSuspensionObservationInput {
  binding: FixtureCredentialExecutionBinding;
  generation: number;
  host: HandoffHostBinding;
  lease: HandoffLease;
  promptContextHash: string;
}

export interface CredentialInputAttemptPreparationInput {
  hookDefinitionHash: string;
  host: HandoffHostBinding;
  intent: unknown;
  lease: HandoffLease;
  registry: readonly CredentialUseRegistryEntry[];
  trustRootHash: string;
}

export interface CredentialFixtureGateCleanupInput {
  binding: FixtureCredentialExecutionBinding;
  generation: number;
}

type CredentialInputAttemptPreparationBase = {
  activation: "INACTIVE";
  authority: "FIXTURE_ONLY_NON_AUTHORIZING";
  credentialProtection: "INACTIVE";
};

export type CredentialInputAttemptPreparationResult =
  | (CredentialInputAttemptPreparationBase & {
      binding: FixtureCredentialExecutionBinding;
      gate: "PREPARING";
      generation: number;
      kind: "PREPARED_FIXTURE_NON_AUTHORIZING";
    })
  | (CredentialInputAttemptPreparationBase & { kind: "FAILED_SAFE" });

export interface CredentialHostSuspensionQuery {
  admissionGeneration: number;
  authority: "FIXTURE_ONLY_NON_AUTHORIZING";
  browserInstanceBindingHash: string;
  challengeHash: string;
  coverageBindingHash: string;
  credentialOperationDigest: string;
  gateSnapshotHash: string;
  handoffActivationBindingHash: string;
  hostProfileBindingHash: string;
  promptContextHash: string;
  schemaVersion: 1;
  stateEpoch: number;
  toolFenceSnapshotHash: string;
  verifierContextBindingHash: string;
}

export type CredentialHostSuspensionReceiptWire = string | Uint8Array;

export type ObserveCredentialHostSuspension = (
  query: CredentialHostSuspensionQuery,
  signal: AbortSignal,
) =>
  | CredentialHostSuspensionReceiptWire
  | undefined
  | Promise<CredentialHostSuspensionReceiptWire | undefined>;

type CredentialHostSuspensionResultBase = {
  activation: "INACTIVE";
  authority: "FIXTURE_ONLY_NON_AUTHORIZING";
  hostSuspension: "UNVERIFIED";
};

export type CredentialHostSuspensionObservationResult =
  | (CredentialHostSuspensionResultBase & {
      kind: "STRUCTURE_MATCHED_NON_AUTHORIZING";
      receiptDigest: string;
    })
  | (CredentialHostSuspensionResultBase & {
      kind: "FAILED_SAFE" | "FIXTURE_ONLY_REPLAY";
    });

type CredentialFixtureGateCommitBase = {
  activation: "INACTIVE";
  authorization: "NOT_AUTHORIZED";
  authority: "FIXTURE_ONLY_NON_AUTHORIZING";
  credentialInputLease: "NOT_ESTABLISHED";
  credentialProtection: "INACTIVE";
  hostSuspension: "UNVERIFIED";
};

export type CredentialFixtureGateCommitResult =
  | (CredentialFixtureGateCommitBase & {
      gate: "ACTIVE";
      generation: number;
      kind: "FIXTURE_GATE_COMMITTED_NON_AUTHORIZING";
      receiptDigest: string;
    })
  | (CredentialFixtureGateCommitBase & {
      kind: "FAILED_SAFE" | "FIXTURE_ONLY_REPLAY";
    });

type CredentialFixtureGateCleanupBase = {
  activation: "INACTIVE";
  agentResume: "NOT_AUTHORIZED";
  authorization: "NOT_AUTHORIZED";
  authority: "FIXTURE_ONLY_NON_AUTHORIZING";
  credentialInputLease: "NOT_ESTABLISHED";
  credentialProtection: "INACTIVE";
  externalCleanup: "NOT_VERIFIED";
  hostSuspension: "UNVERIFIED";
};

export type CredentialFixtureGateCleanupResult =
  | (CredentialFixtureGateCleanupBase & {
      gate: "OPEN";
      generation: number;
      kind:
        | "FIXTURE_GATE_ALREADY_OPEN_NON_AUTHORIZING"
        | "FIXTURE_GATE_OPENED_NON_AUTHORIZING";
    })
  | (CredentialFixtureGateCleanupBase & {
      kind: "FAILED_SAFE" | "WAITING_FOR_NATIVE";
    });

export type HandoffCompletionAdmissionResult = {
  activation: "INACTIVE";
  authority: "FIXTURE_ONLY_NON_AUTHORIZING";
  kind:
    | "CANCEL_REQUESTED"
    | "FAILED_SAFE"
    | "FIXTURE_ONLY_HANDOFF_VERIFYING"
    | "FIXTURE_ONLY_REPLAY"
    | "KEEP_USER_LEASE";
};

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

const exactCredentialSuspensionLease = (lease: HandoffLease): boolean =>
  Boolean(lease) &&
  typeof lease === "object" &&
  Object.keys(lease).sort().join(",") ===
    "acquiredAt,expiresAt,handoffId,holder,leaseEpoch,nonce,schemaVersion,scope,state" &&
  lease.schemaVersion === 1 &&
  lease.holder === "USER" &&
  lease.state === "ACTIVE" &&
  typeof lease.handoffId === "string" &&
  lease.handoffId.length > 0 &&
  lease.handoffId.length <= 4_096 &&
  typeof lease.nonce === "string" &&
  /^[A-Za-z0-9_-]{32,4096}$/.test(lease.nonce) &&
  Number.isSafeInteger(lease.leaseEpoch) &&
  lease.leaseEpoch > 0 &&
  Number.isSafeInteger(lease.acquiredAt) &&
  lease.acquiredAt >= 0 &&
  Number.isSafeInteger(lease.expiresAt) &&
  lease.expiresAt > lease.acquiredAt &&
  Boolean(lease.scope) &&
  typeof lease.scope === "object" &&
  Object.keys(lease.scope).sort().join(",") ===
    "documentBinding,sessionId,tabId,taskId,topOrigin" &&
  safeTaskScope(lease.scope) &&
  lease.scope.sessionId.length <= 4_096 &&
  lease.scope.taskId.length <= 4_096 &&
  typeof lease.scope.documentBinding === "string" &&
  lease.scope.documentBinding.length > 0 &&
  lease.scope.documentBinding.length <= 4_096 &&
  Number.isSafeInteger(lease.scope.tabId) &&
  lease.scope.tabId >= 0;

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

function matchesCredentialAdmissionState(
  state: BrowserTaskState,
  lease: HandoffLease,
  host: HandoffHostBinding,
): boolean {
  return (
    matchesActiveState(state, lease) &&
    lease.state === "ACTIVE" &&
    lease.holder === "USER" &&
    state.hostProfileStatus === "VALID" &&
    state.hostProfileId === host.profileId &&
    state.sessionId === lease.scope.sessionId &&
    state.taskId === lease.scope.taskId &&
    state.currentOrigin === lease.scope.topOrigin &&
    state.documentBinding !== undefined &&
    canonicalPersistentDocumentBinding(state.documentBinding) ===
      persistentDocumentBinding(lease.scope.documentBinding) &&
    state.pendingNativeActionIds.length === 0 &&
    state.handoffVerificationMarker === undefined
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

type ReadyCompletionCandidate = Extract<
  CompletionCandidate,
  { kind: "READY_FOR_LOCKED_VERIFY" }
>;

const completionResult = (
  kind: HandoffCompletionAdmissionResult["kind"],
): HandoffCompletionAdmissionResult => ({
  activation: "INACTIVE",
  authority: "FIXTURE_ONLY_NON_AUTHORIZING",
  kind,
});

function sameHash(left: string, right: string): boolean {
  return (
    HASH.test(left) &&
    HASH.test(right) &&
    timingSafeEqual(Buffer.from(left, "ascii"), Buffer.from(right, "ascii"))
  );
}

function matchesCompletionState(
  state: BrowserTaskState,
  candidate: ReadyCompletionCandidate,
): boolean {
  const binding = candidate.lockedBinding;
  return (
    state.phase === "USER_LEASE_ACTIVE" &&
    state.pointerOwner === "HUMAN" &&
    state.hostProfileStatus === "VALID" &&
    state.sessionId === binding.sessionId &&
    state.taskId === binding.taskId &&
    state.leaseEpoch === binding.leaseEpoch &&
    state.stateVersion === binding.expectedStateVersion &&
    state.activeHandoffId !== undefined &&
    canonicalPersistentHandoffId(state.activeHandoffId) ===
      persistentHandoffId(binding.handoffId) &&
    state.currentOrigin === FIXTURE_ORIGIN &&
    state.documentBinding !== undefined &&
    canonicalPersistentDocumentBinding(state.documentBinding) ===
      persistentDocumentBinding(binding.initialDocumentBinding) &&
    state.pendingNativeActionIds.length === 0 &&
    state.handoffVerificationMarker === undefined
  );
}

function matchesCompletionReplay(
  state: BrowserTaskState,
  candidate: ReadyCompletionCandidate,
  candidateDigest: string,
): boolean {
  return (
    state.phase === "HANDOFF_VERIFYING" &&
    state.pointerOwner === "HUMAN" &&
    state.sessionId === candidate.lockedBinding.sessionId &&
    state.taskId === candidate.lockedBinding.taskId &&
    state.leaseEpoch === candidate.lockedBinding.leaseEpoch &&
    state.stateVersion === candidate.lockedBinding.expectedStateVersion + 1 &&
    state.activeHandoffId !== undefined &&
    canonicalPersistentHandoffId(state.activeHandoffId) ===
      persistentHandoffId(candidate.lockedBinding.handoffId) &&
    state.handoffVerificationMarker?.candidateDigest === candidateDigest
  );
}

function matchesActiveCompletionBarrier(
  barrier: PersistedHandoffBarrier,
  state: BrowserTaskState,
  lease: HandoffLease,
  candidate: ReadyCompletionCandidate,
): boolean {
  return (
    matchesActiveLeaseBarrier(barrier, state, lease) &&
    barrier.leaseEpoch === candidate.lockedBinding.leaseEpoch &&
    barrier.handoffId === persistentHandoffId(candidate.lockedBinding.handoffId)
  );
}

function matchesActiveLeaseBarrier(
  barrier: PersistedHandoffBarrier,
  state: BrowserTaskState,
  lease: HandoffLease,
): boolean {
  return (
    barrier.state === "ACTIVE" &&
    barrier.leaseEpoch === lease.leaseEpoch &&
    barrier.handoffId === persistentHandoffId(lease.handoffId) &&
    barrier.expiresAt === lease.expiresAt &&
    barrier.updatedAt === lease.acquiredAt &&
    barrier.hostProfileIdHash ===
      digest("oxrail-handoff-host-profile-id-v1", state.hostProfileId) &&
    sameHash(
      barrier.nonceDigest,
      digest("oxrail-handoff-nonce-v1", lease.nonce),
    ) &&
    sameHash(barrier.scopeDigest, handoffScopeBindingHash(lease.scope)) &&
    sameHash(barrier.taskBindingDigest, taskBindingDigest(lease.scope)) &&
    barrier.browserInstanceBindingHash !== null &&
    barrier.nativeActionFenceHash !== null &&
    barrier.tabBindingReceiptHash !== null
  );
}

const handoffActivationAnchorDigest = (barrier: PersistedHandoffBarrier) =>
  deterministicDigest("oxrail-handoff-activation-anchor-v1", barrier);

const credentialHandoffActivationAnchorHash = (
  barrier: PersistedHandoffBarrier,
) =>
  deterministicDigest("oxrail-credential-handoff-activation-anchor-v1", {
    handoffActivationAnchorDigest: handoffActivationAnchorDigest(barrier),
  });

function completionQuery(
  barrier: PersistedHandoffBarrier,
  candidate: ReadyCompletionCandidate,
  candidateDigest: string,
): HandoffCurrentTabQuery {
  return {
    activationNativeActionFenceHash: barrier.nativeActionFenceHash!,
    activationTabBindingReceiptHash: barrier.tabBindingReceiptHash!,
    admissionGeneration: barrier.leaseEpoch,
    authority: "FIXTURE_ONLY_NON_AUTHORIZING",
    browserInstanceBindingHash: barrier.browserInstanceBindingHash!,
    candidateDigest,
    hostProfileBindingHash: barrier.hostProfileBindingHash,
    lastAcceptedProbeSequence:
      candidate.verificationBinding.secondProbeSequence,
    schemaVersion: 1,
    stateEpoch: candidate.verificationBinding.stateEpoch,
    tabId: candidate.lockedBinding.tabId,
    verifierContextBindingHash:
      candidate.verificationBinding.verifierContextBindingHash,
  };
}

async function observeWithTimeout<Query, Receipt>(
  observe: (
    query: Query,
    signal: AbortSignal,
  ) => Receipt | undefined | Promise<Receipt | undefined>,
  query: Query,
  timeoutMs: number,
): Promise<Receipt | undefined> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const timedOut = new Promise<undefined>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, timeoutMs);
    });
    return await Promise.race([
      Promise.resolve().then(() => observe(query, controller.signal)),
      timedOut,
    ]);
  } catch {
    return undefined;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

const credentialSuspensionResult = (
  kind: "FAILED_SAFE" | "FIXTURE_ONLY_REPLAY",
): CredentialHostSuspensionObservationResult => ({
  activation: "INACTIVE",
  authority: "FIXTURE_ONLY_NON_AUTHORIZING",
  hostSuspension: "UNVERIFIED",
  kind,
});

const credentialFixtureGateCommitResult = (
  kind: "FAILED_SAFE" | "FIXTURE_ONLY_REPLAY",
): CredentialFixtureGateCommitResult => ({
  activation: "INACTIVE",
  authorization: "NOT_AUTHORIZED",
  authority: "FIXTURE_ONLY_NON_AUTHORIZING",
  credentialInputLease: "NOT_ESTABLISHED",
  credentialProtection: "INACTIVE",
  hostSuspension: "UNVERIFIED",
  kind,
});

const credentialFixtureGateCleanupResult = (
  kind: "FAILED_SAFE" | "WAITING_FOR_NATIVE",
): CredentialFixtureGateCleanupResult => ({
  activation: "INACTIVE",
  agentResume: "NOT_AUTHORIZED",
  authorization: "NOT_AUTHORIZED",
  authority: "FIXTURE_ONLY_NON_AUTHORIZING",
  credentialInputLease: "NOT_ESTABLISHED",
  credentialProtection: "INACTIVE",
  externalCleanup: "NOT_VERIFIED",
  hostSuspension: "UNVERIFIED",
  kind,
});

const credentialFixtureGateOpenResult = (
  kind:
    | "FIXTURE_GATE_ALREADY_OPEN_NON_AUTHORIZING"
    | "FIXTURE_GATE_OPENED_NON_AUTHORIZING",
  generation: number,
): CredentialFixtureGateCleanupResult => ({
  activation: "INACTIVE",
  agentResume: "NOT_AUTHORIZED",
  authorization: "NOT_AUTHORIZED",
  authority: "FIXTURE_ONLY_NON_AUTHORIZING",
  credentialInputLease: "NOT_ESTABLISHED",
  credentialProtection: "INACTIVE",
  externalCleanup: "NOT_VERIFIED",
  gate: "OPEN",
  generation,
  hostSuspension: "UNVERIFIED",
  kind,
});

function parseBoundedCredentialSuspensionReceipt(
  value: CredentialHostSuspensionReceiptWire | undefined,
): CredentialHostSuspensionReceipt | undefined {
  try {
    if (value === undefined) return;
    if (typeof value !== "string" && !(value instanceof Uint8Array)) return;
    if (
      (typeof value === "string" &&
        (value.length > MAX_CREDENTIAL_SUSPENSION_RECEIPT_BYTES ||
          Buffer.byteLength(value) >
            MAX_CREDENTIAL_SUSPENSION_RECEIPT_BYTES)) ||
      (value instanceof Uint8Array &&
        value.byteLength > MAX_CREDENTIAL_SUSPENSION_RECEIPT_BYTES)
    ) {
      return;
    }
    const serialized =
      typeof value === "string"
        ? value
        : new TextDecoder("utf-8", { fatal: true }).decode(value);
    const parsed = CredentialHostSuspensionReceiptSchema.safeParse(
      JSON.parse(serialized),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return;
  }
}

function matchesCredentialSuspensionReceipt(
  receipt: CredentialHostSuspensionReceipt,
  query: CredentialHostSuspensionQuery,
): boolean {
  const echoedHashes = [
    query.browserInstanceBindingHash,
    query.challengeHash,
    query.coverageBindingHash,
    query.credentialOperationDigest,
    query.gateSnapshotHash,
    query.handoffActivationBindingHash,
    query.hostProfileBindingHash,
    query.promptContextHash,
    query.toolFenceSnapshotHash,
    query.verifierContextBindingHash,
  ];
  return (
    receipt.authority === query.authority &&
    receipt.admissionGeneration === query.admissionGeneration &&
    receipt.stateEpoch === query.stateEpoch &&
    sameHash(
      receipt.browserInstanceBindingHash,
      query.browserInstanceBindingHash,
    ) &&
    sameHash(receipt.challengeHash, query.challengeHash) &&
    sameHash(receipt.coverageBindingHash, query.coverageBindingHash) &&
    sameHash(
      receipt.credentialOperationDigest,
      query.credentialOperationDigest,
    ) &&
    sameHash(receipt.gateSnapshotHash, query.gateSnapshotHash) &&
    sameHash(
      receipt.handoffActivationBindingHash,
      query.handoffActivationBindingHash,
    ) &&
    sameHash(receipt.hostProfileBindingHash, query.hostProfileBindingHash) &&
    sameHash(receipt.promptContextHash, query.promptContextHash) &&
    sameHash(receipt.toolFenceSnapshotHash, query.toolFenceSnapshotHash) &&
    sameHash(
      receipt.verifierContextBindingHash,
      query.verifierContextBindingHash,
    ) &&
    HASH.test(receipt.hostSuspensionFenceHash) &&
    echoedHashes.every(
      (echoed) => !sameHash(receipt.hostSuspensionFenceHash, echoed),
    ) &&
    receipt.lanes.agentTool === "SUSPENDED" &&
    receipt.lanes.browserAction === "SUSPENDED" &&
    receipt.lanes.browserObservation === "SUSPENDED" &&
    receipt.lanes.shell === "SUSPENDED" &&
    receipt.lanes.screenCapture === "SUSPENDED" &&
    receipt.lanes.clipboard === "SUSPENDED" &&
    receipt.lanes.semanticQuery === "SUSPENDED" &&
    receipt.lanes.enclaveProtocol === "ALLOWLIST_ONLY"
  );
}

function promptAliasesCredentialControlIdentity(
  promptContextHash: string,
  input: CredentialHostSuspensionObservationInput,
  ticket: CredentialEnclaveTicket,
  barrier?: PersistedHandoffBarrier,
): boolean {
  const values = [
    input.binding.hookDefinitionHash,
    input.binding.hostProfileHash,
    input.binding.trustRootHash,
    input.host.profileBindingHash,
    input.host.profileId,
    input.lease.handoffId,
    input.lease.nonce,
    input.lease.scope.sessionId,
    input.lease.scope.taskId,
    input.lease.scope.topOrigin,
    input.lease.scope.documentBinding,
    ticket.authority,
    ticket.ticketId,
    ticket.credentialUseId,
    ticket.credentialKind,
    ticket.templateId,
    ticket.serviceId,
    ticket.provisioningOrigin,
    ticket.purposeId,
    ticket.consumerId,
    ticket.templateRegistryHash,
    ticket.consumerRegistryHash,
    ticket.registryManifestHash,
    ticket.handoff.activationAnchorHash,
    barrier?.browserInstanceBindingHash,
    barrier?.handoffId,
    barrier?.hostProfileBindingHash,
    barrier?.hostProfileIdHash,
    barrier?.nativeActionFenceHash,
    barrier?.nonceDigest,
    barrier?.scopeDigest,
    barrier?.tabBindingReceiptHash,
    barrier?.taskBindingDigest,
  ];
  return values.some(
    (value) =>
      value === promptContextHash ||
      value?.endsWith(`_${promptContextHash}`) ||
      value?.endsWith(`:${promptContextHash}`),
  );
}

function matchesCurrentTabReceipt(
  receipt: HandoffCurrentTabReceipt,
  query: HandoffCurrentTabQuery,
  candidate: ReadyCompletionCandidate,
): boolean {
  const expectedAutomaticPhase =
    candidate.phaseSignal === "MANUAL_DONE" ? undefined : candidate.phaseSignal;
  return (
    receipt.authority === query.authority &&
    receipt.candidateDigest === query.candidateDigest &&
    receipt.admissionGeneration === query.admissionGeneration &&
    sameHash(receipt.hostProfileBindingHash, query.hostProfileBindingHash) &&
    sameHash(
      receipt.browserInstanceBindingHash,
      query.browserInstanceBindingHash,
    ) &&
    sameHash(
      receipt.activationNativeActionFenceHash,
      query.activationNativeActionFenceHash,
    ) &&
    sameHash(
      receipt.activationTabBindingReceiptHash,
      query.activationTabBindingReceiptHash,
    ) &&
    !sameHash(
      receipt.completionNativeActionFenceHash,
      query.activationNativeActionFenceHash,
    ) &&
    !sameHash(
      receipt.completionNativeActionFenceHash,
      query.activationTabBindingReceiptHash,
    ) &&
    !sameHash(
      receipt.completionReceiptHash,
      query.activationNativeActionFenceHash,
    ) &&
    !sameHash(
      receipt.completionReceiptHash,
      query.activationTabBindingReceiptHash,
    ) &&
    !sameHash(
      receipt.completionReceiptHash,
      receipt.completionNativeActionFenceHash,
    ) &&
    receipt.exclusiveTabLease === "HELD" &&
    receipt.agentActionLane === "SUSPENDED" &&
    receipt.agentObservationLane === "SUSPENDED" &&
    receipt.tabId === query.tabId &&
    receipt.initialDocumentBinding ===
      candidate.lockedBinding.initialDocumentBinding &&
    receipt.observedDocumentBinding ===
      candidate.lockedBinding.observedDocumentBinding &&
    receipt.origin === candidate.lockedBinding.origin &&
    receipt.origin === FIXTURE_ORIGIN &&
    receipt.verifierContextBindingHash === query.verifierContextBindingHash &&
    receipt.stateEpoch === query.stateEpoch &&
    receipt.lastAcceptedProbeSequence === query.lastAcceptedProbeSequence &&
    receipt.completionState === "CONFIRMED" &&
    receipt.automaticPhase === expectedAutomaticPhase &&
    receipt.tabState === "BOUND" &&
    receipt.navigationState === "IDLE" &&
    receipt.redirectState === "CONTINUOUSLY_ALLOWED" &&
    receipt.sensitivePhase === "CLEARED"
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

/**
 * Mints only a fixture ticket bound to the current locked Handoff activation.
 * The anchor is not a current-tab receipt, credential lease, or launch authority.
 */
async function credentialTicketFromLockedHandoff(
  root: string,
  input: {
    host: HandoffHostBinding;
    lease: HandoffLease;
    registry: readonly CredentialUseRegistryEntry[];
    value: unknown;
  },
  expectedHost: PersistedHostBinding,
  state: BrowserTaskState | undefined,
  issuedAt: number,
): Promise<CredentialEnclaveTicket> {
  const gate = await readHandoffGate(root, input.lease.scope);
  const barrier = await readBarrier(
    barrierPath(root, input.lease.scope, input.lease.leaseEpoch),
  );
  const activeToolCalls = await countActiveToolCalls(root, input.lease.scope);
  if (
    !state ||
    !matchesCredentialAdmissionState(state, input.lease, input.host) ||
    gate.kind !== "KNOWN" ||
    gate.status !== "ACTIVE" ||
    gate.generation !== input.lease.leaseEpoch ||
    !matchesActiveLeaseBarrier(barrier, state, input.lease) ||
    barrier.hostProfileBindingHash !== expectedHost.hostProfileBindingHash ||
    barrier.hostProfileIdHash !== expectedHost.hostProfileIdHash ||
    activeToolCalls !== 0
  ) {
    throw new CredentialAdmissionError("INVALID_HANDOFF");
  }
  return bindCredentialIntentToActivationAnchor(
    input.value,
    input.registry,
    input.lease,
    issuedAt,
    credentialHandoffActivationAnchorHash(barrier),
  );
}

export async function admitCredentialIntent(
  root: string,
  value: unknown,
  registry: readonly CredentialUseRegistryEntry[],
  lease: HandoffLease,
  host: HandoffHostBinding,
  clock: () => number = Date.now,
): Promise<CredentialEnclaveTicket> {
  try {
    const input = structuredClone({ host, lease, registry, value });
    const issuedAt = clock();
    if (!safeTaskScope(input.lease.scope)) {
      throw new CredentialAdmissionError("INVALID_HANDOFF");
    }
    const expectedHost = persistedHostBinding(input.host);
    return await transitionBrowserTaskState<CredentialEnclaveTicket>(
      root,
      input.lease.scope,
      async (state) => ({
        value: await credentialTicketFromLockedHandoff(
          root,
          input,
          expectedHost,
          state,
          issuedAt,
        ),
      }),
    );
  } catch (error) {
    if (error instanceof CredentialAdmissionError) throw error;
    throw new CredentialAdmissionError("INVALID_HANDOFF");
  }
}

const failedCredentialInputAttempt =
  (): CredentialInputAttemptPreparationResult => ({
    activation: "INACTIVE",
    authority: "FIXTURE_ONLY_NON_AUTHORIZING",
    credentialProtection: "INACTIVE",
    kind: "FAILED_SAFE",
  });

/**
 * Atomically mints one fixture ticket and moves the global gate to PREPARING.
 * PREPARING is only a local blocking fact, never a credential lease or authority.
 */
export async function prepareCredentialInputAttempt(
  credentialFenceRoot: string,
  handoffRoot: string,
  value: CredentialInputAttemptPreparationInput,
): Promise<CredentialInputAttemptPreparationResult> {
  try {
    if (
      !credentialFenceRoot ||
      !handoffRoot ||
      path.resolve(credentialFenceRoot) === path.resolve(handoffRoot)
    ) {
      return failedCredentialInputAttempt();
    }
    const candidate: unknown = structuredClone(value);
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !==
        "hookDefinitionHash,host,intent,lease,registry,trustRootHash"
    ) {
      return failedCredentialInputAttempt();
    }
    const input = candidate as CredentialInputAttemptPreparationInput;
    if (
      !HASH.test(input.hookDefinitionHash) ||
      !HASH.test(input.trustRootHash) ||
      !Array.isArray(input.registry) ||
      !exactCredentialSuspensionLease(input.lease) ||
      !input.host ||
      typeof input.host !== "object" ||
      Object.keys(input.host).sort().join(",") !==
        "profileBindingHash,profileId"
    ) {
      return failedCredentialInputAttempt();
    }
    const expectedHost = persistedHostBinding(input.host);
    const admissionInput = {
      host: input.host,
      lease: input.lease,
      registry: input.registry,
      value: input.intent,
    };
    return await withCredentialToolFenceLock(credentialFenceRoot, () =>
      transitionBrowserTaskState(
        handoffRoot,
        input.lease.scope,
        async (state) => {
          const observedAt = Date.now();
          const ticket = await credentialTicketFromLockedHandoff(
            handoffRoot,
            admissionInput,
            expectedHost,
            state,
            observedAt,
          );
          const binding: FixtureCredentialExecutionBinding = {
            hookDefinitionHash: input.hookDefinitionHash,
            hostProfileHash: input.host.profileBindingHash,
            ticket,
            trustRootHash: input.trustRootHash,
          };
          const generation = await prepareCredentialExecutionGateLocked(
            credentialFenceRoot,
            binding,
            observedAt,
          );
          return {
            value: {
              activation: "INACTIVE",
              authority: "FIXTURE_ONLY_NON_AUTHORIZING",
              binding,
              credentialProtection: "INACTIVE",
              gate: "PREPARING",
              generation,
              kind: "PREPARED_FIXTURE_NON_AUTHORIZING",
            } as const,
          };
        },
      ),
    );
  } catch {
    return failedCredentialInputAttempt();
  }
}

type CredentialHostSuspensionQueryContext = Omit<
  CredentialHostSuspensionQuery,
  "challengeHash"
>;

interface CredentialHostSuspensionLockedSnapshot {
  attemptKey: string;
  context: CredentialHostSuspensionQueryContext;
  snapshotHash: string;
  wallObservedAt: number;
}

async function withCredentialHostSuspensionSnapshotLocked<Result>(
  credentialFenceRoot: string,
  handoffRoot: string,
  input: CredentialHostSuspensionObservationInput,
  operation: ReturnType<typeof credentialExecutionBinding>,
  expectedHost: PersistedHostBinding,
  visit: (
    snapshot: CredentialHostSuspensionLockedSnapshot,
  ) => Result | Promise<Result>,
): Promise<Result | undefined> {
  return transitionBrowserTaskState(
    handoffRoot,
    input.lease.scope,
    async (state) => {
      const gate = await readCredentialExecutionGateLocked(credentialFenceRoot);
      if (
        gate.state !== "PREPARING" ||
        gate.generation !== input.generation ||
        gate.operationDigest !== operation.digest ||
        gate.expiresAt !== operation.ticket.handoff.expiresAt
      ) {
        return { value: undefined };
      }
      const handoffGate = await readHandoffGate(handoffRoot, input.lease.scope);
      const barrier = await readBarrier(
        barrierPath(handoffRoot, input.lease.scope, input.lease.leaseEpoch),
      );
      const activeToolCalls = await countActiveToolCalls(
        handoffRoot,
        input.lease.scope,
      );
      const toolFence = await observeCredentialToolFenceLocked(
        credentialFenceRoot,
        gate,
      );
      const activationAnchorHash =
        credentialHandoffActivationAnchorHash(barrier);
      const observedAt = Date.now();
      if (
        !state ||
        !matchesCredentialAdmissionState(state, input.lease, input.host) ||
        handoffGate.kind !== "KNOWN" ||
        handoffGate.status !== "ACTIVE" ||
        handoffGate.generation !== input.lease.leaseEpoch ||
        !matchesActiveLeaseBarrier(barrier, state, input.lease) ||
        barrier.hostProfileBindingHash !==
          expectedHost.hostProfileBindingHash ||
        barrier.hostProfileIdHash !== expectedHost.hostProfileIdHash ||
        activeToolCalls !== 0 ||
        toolFence.kind !== "QUIESCENT" ||
        promptAliasesCredentialControlIdentity(
          input.promptContextHash,
          input,
          operation.ticket,
          barrier,
        ) ||
        !sameHash(
          operation.ticket.handoff.activationAnchorHash,
          activationAnchorHash,
        ) ||
        state.stateVersion <= 0 ||
        !Number.isSafeInteger(observedAt) ||
        observedAt < operation.ticket.issuedAt ||
        observedAt > operation.ticket.handoff.expiresAt
      ) {
        return { value: undefined };
      }

      const coverageBindingHash = deterministicDigest(
        "oxrail-credential-local-coverage-binding-v1",
        {
          hookDefinitionHash: input.binding.hookDefinitionHash,
          hostProfileHash: input.binding.hostProfileHash,
          trustRootHash: input.binding.trustRootHash,
        },
      );
      const handoffActivationBindingHash = deterministicDigest(
        "oxrail-credential-handoff-activation-binding-v1",
        { activationAnchorHash, admissionGeneration: barrier.leaseEpoch },
      );
      const gateSnapshotHash = deterministicDigest(
        "oxrail-credential-gate-snapshot-v1",
        gate,
      );
      const verifierContextBindingHash = deterministicDigest(
        "oxrail-credential-host-suspension-context-v1",
        {
          admissionGeneration: barrier.leaseEpoch,
          browserInstanceBindingHash: barrier.browserInstanceBindingHash!,
          coverageBindingHash,
          gateSnapshotHash,
          handoffActivationBindingHash,
          hostProfileBindingHash: barrier.hostProfileBindingHash,
          promptContextHash: input.promptContextHash,
          stateEpoch: state.stateVersion,
          toolFenceSnapshotHash: toolFence.snapshotHash,
        },
      );
      const context: CredentialHostSuspensionQueryContext = {
        admissionGeneration: barrier.leaseEpoch,
        authority: "FIXTURE_ONLY_NON_AUTHORIZING",
        browserInstanceBindingHash: barrier.browserInstanceBindingHash!,
        coverageBindingHash,
        credentialOperationDigest: operation.digest,
        gateSnapshotHash,
        handoffActivationBindingHash,
        hostProfileBindingHash: barrier.hostProfileBindingHash,
        promptContextHash: input.promptContextHash,
        schemaVersion: 1,
        stateEpoch: state.stateVersion,
        toolFenceSnapshotHash: toolFence.snapshotHash,
        verifierContextBindingHash,
      };
      const snapshot: CredentialHostSuspensionLockedSnapshot = {
        attemptKey: deterministicDigest(
          "oxrail-credential-host-suspension-attempt-v1",
          {
            admissionGeneration: barrier.leaseEpoch,
            credentialFenceRootHash: deterministicDigest(
              "oxrail-credential-fence-root-v1",
              path.resolve(credentialFenceRoot),
            ),
            credentialGateGeneration: gate.generation,
            handoffActivationBindingHash,
            operationDigest: operation.digest,
          },
        ),
        context,
        snapshotHash: deterministicDigest(
          "oxrail-credential-host-suspension-locked-snapshot-v1",
          {
            activationAnchorHash,
            barrier,
            gate,
            state,
            toolFenceSnapshotHash: toolFence.snapshotHash,
          },
        ),
        wallObservedAt: observedAt,
      };
      return { value: await visit(snapshot) };
    },
  );
}

const credentialHostSuspensionSnapshotLocked = (
  credentialFenceRoot: string,
  handoffRoot: string,
  input: CredentialHostSuspensionObservationInput,
  operation: ReturnType<typeof credentialExecutionBinding>,
  expectedHost: PersistedHostBinding,
): Promise<CredentialHostSuspensionLockedSnapshot | undefined> =>
  withCredentialHostSuspensionSnapshotLocked(
    credentialFenceRoot,
    handoffRoot,
    input,
    operation,
    expectedHost,
    (snapshot) => snapshot,
  );

function matchesFinalCredentialHostSuspensionSnapshot(
  initial: CredentialHostSuspensionLockedSnapshot,
  final: CredentialHostSuspensionLockedSnapshot,
  finalizedAt: number,
  afterObservation: number,
  deadline: number,
): boolean {
  return (
    Number.isSafeInteger(finalizedAt) &&
    finalizedAt >= afterObservation &&
    finalizedAt <= deadline &&
    final.wallObservedAt >= initial.wallObservedAt &&
    final.attemptKey === initial.attemptKey &&
    final.snapshotHash === initial.snapshotHash &&
    deterministicDigest(
      "oxrail-credential-host-suspension-query-context-v1",
      final.context,
    ) ===
      deterministicDigest(
        "oxrail-credential-host-suspension-query-context-v1",
        initial.context,
      )
  );
}

type CredentialHostSuspensionMode = "COMMIT_FIXTURE_GATE" | "OBSERVE_ONLY";

async function runPreparedCredentialHostSuspension(
  credentialFenceRoot: string,
  handoffRoot: string,
  value: CredentialHostSuspensionObservationInput,
  observeHostSuspension: ObserveCredentialHostSuspension,
  mode: "OBSERVE_ONLY",
): Promise<CredentialHostSuspensionObservationResult>;
async function runPreparedCredentialHostSuspension(
  credentialFenceRoot: string,
  handoffRoot: string,
  value: CredentialHostSuspensionObservationInput,
  observeHostSuspension: ObserveCredentialHostSuspension,
  mode: "COMMIT_FIXTURE_GATE",
): Promise<CredentialFixtureGateCommitResult>;
async function runPreparedCredentialHostSuspension(
  credentialFenceRoot: string,
  handoffRoot: string,
  value: CredentialHostSuspensionObservationInput,
  observeHostSuspension: ObserveCredentialHostSuspension,
  mode: CredentialHostSuspensionMode,
): Promise<
  CredentialHostSuspensionObservationResult | CredentialFixtureGateCommitResult
> {
  const failed = (kind: "FAILED_SAFE" | "FIXTURE_ONLY_REPLAY") =>
    mode === "OBSERVE_ONLY"
      ? credentialSuspensionResult(kind)
      : credentialFixtureGateCommitResult(kind);
  try {
    if (
      !credentialFenceRoot ||
      !handoffRoot ||
      path.resolve(credentialFenceRoot) === path.resolve(handoffRoot) ||
      typeof observeHostSuspension !== "function"
    ) {
      return failed("FAILED_SAFE");
    }
    const input = structuredClone(value);
    if (
      !input ||
      typeof input !== "object" ||
      Object.keys(input).sort().join(",") !==
        "binding,generation,host,lease,promptContextHash" ||
      !input.host ||
      typeof input.host !== "object" ||
      Object.keys(input.host).sort().join(",") !==
        "profileBindingHash,profileId" ||
      !Number.isSafeInteger(input.generation) ||
      input.generation <= 0 ||
      !HASH.test(input.promptContextHash) ||
      !exactCredentialSuspensionLease(input.lease)
    ) {
      return failed("FAILED_SAFE");
    }
    const operation = credentialExecutionBinding(input.binding);
    const expectedHost = persistedHostBinding(input.host);
    if (
      !sameHash(input.binding.hostProfileHash, input.host.profileBindingHash) ||
      operation.ticket.provisioningOrigin !== input.lease.scope.topOrigin ||
      operation.ticket.handoff.leaseEpoch !== input.lease.leaseEpoch ||
      operation.ticket.handoff.acquiredAt !== input.lease.acquiredAt ||
      operation.ticket.handoff.expiresAt !== input.lease.expiresAt ||
      promptAliasesCredentialControlIdentity(
        input.promptContextHash,
        input,
        operation.ticket,
      )
    ) {
      return failed("FAILED_SAFE");
    }

    const prepared = await withCredentialToolFenceLock(
      credentialFenceRoot,
      async () => {
        const snapshot = await credentialHostSuspensionSnapshotLocked(
          credentialFenceRoot,
          handoffRoot,
          input,
          operation,
          expectedHost,
        );
        if (!snapshot) return { kind: "FAILED_SAFE" as const };
        if (attemptedCredentialSuspensions.has(snapshot.attemptKey)) {
          return { kind: "FIXTURE_ONLY_REPLAY" as const };
        }
        if (
          attemptedCredentialSuspensions.size >= MAX_ATTEMPTED_VERIFIER_CONTEXTS
        ) {
          return { kind: "FAILED_SAFE" as const };
        }
        const challengeHash = createHash("sha256")
          .update("oxrail-credential-host-suspension-challenge-v1\0")
          .update(randomBytes(32))
          .update(snapshot.attemptKey, "ascii")
          .digest("hex");
        attemptedCredentialSuspensions.add(snapshot.attemptKey);
        return {
          kind: "READY" as const,
          query: Object.freeze<CredentialHostSuspensionQuery>({
            ...snapshot.context,
            challengeHash,
          }),
          snapshot,
        };
      },
    );
    if (prepared.kind !== "READY") {
      return failed(prepared.kind);
    }

    const beforeObservation = Math.floor(performance.now());
    if (
      !Number.isSafeInteger(beforeObservation) ||
      beforeObservation < 0 ||
      beforeObservation >
        Number.MAX_SAFE_INTEGER - CREDENTIAL_SUSPENSION_OBSERVER_TIMEOUT_MS
    ) {
      return failed("FAILED_SAFE");
    }
    const observed = await observeWithTimeout(
      observeHostSuspension,
      prepared.query,
      CREDENTIAL_SUSPENSION_OBSERVER_TIMEOUT_MS,
    );
    const deadline =
      beforeObservation + CREDENTIAL_SUSPENSION_OBSERVER_TIMEOUT_MS;
    const afterObservation = Math.floor(performance.now());
    const receipt = parseBoundedCredentialSuspensionReceipt(observed);
    if (
      !Number.isSafeInteger(afterObservation) ||
      afterObservation < beforeObservation ||
      afterObservation > deadline ||
      !receipt ||
      !matchesCredentialSuspensionReceipt(receipt, prepared.query) ||
      observedCredentialSuspensionFences.has(receipt.hostSuspensionFenceHash) ||
      observedCredentialSuspensionFences.size >= MAX_ATTEMPTED_VERIFIER_CONTEXTS
    ) {
      return failed("FAILED_SAFE");
    }
    observedCredentialSuspensionFences.add(receipt.hostSuspensionFenceHash);
    const receiptDigest = deterministicDigest(
      "oxrail-credential-host-suspension-receipt-v1",
      receipt,
    );

    if (mode === "OBSERVE_ONLY") {
      const finalized = await withCredentialToolFenceLock(
        credentialFenceRoot,
        async () => {
          const snapshot = await credentialHostSuspensionSnapshotLocked(
            credentialFenceRoot,
            handoffRoot,
            input,
            operation,
            expectedHost,
          );
          return { snapshot, finalizedAt: Math.floor(performance.now()) };
        },
      );
      if (
        !finalized.snapshot ||
        !matchesFinalCredentialHostSuspensionSnapshot(
          prepared.snapshot,
          finalized.snapshot,
          finalized.finalizedAt,
          afterObservation,
          deadline,
        )
      ) {
        return failed("FAILED_SAFE");
      }

      return {
        activation: "INACTIVE",
        authority: "FIXTURE_ONLY_NON_AUTHORIZING",
        hostSuspension: "UNVERIFIED",
        kind: "STRUCTURE_MATCHED_NON_AUTHORIZING",
        receiptDigest,
      };
    }

    const committed = await withCredentialToolFenceLock(
      credentialFenceRoot,
      () =>
        withCredentialHostSuspensionSnapshotLocked(
          credentialFenceRoot,
          handoffRoot,
          input,
          operation,
          expectedHost,
          async (snapshot) => {
            const beforeCommit = Math.floor(performance.now());
            if (
              !matchesFinalCredentialHostSuspensionSnapshot(
                prepared.snapshot,
                snapshot,
                beforeCommit,
                afterObservation,
                deadline,
              )
            ) {
              return "REJECTED" as const;
            }
            await activateCredentialExecutionGateLocked(
              credentialFenceRoot,
              input.binding,
              input.generation,
              receiptDigest,
              snapshot.wallObservedAt,
            );
            const afterCommit = Math.floor(performance.now());
            return Number.isSafeInteger(afterCommit) &&
              afterCommit >= beforeCommit &&
              afterCommit <= deadline
              ? ("COMMITTED" as const)
              : ("COMMITTED_UNCONFIRMED" as const);
          },
        ),
    );
    if (committed !== "COMMITTED") {
      return failed("FAILED_SAFE");
    }
    return {
      activation: "INACTIVE",
      authorization: "NOT_AUTHORIZED",
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      credentialInputLease: "NOT_ESTABLISHED",
      credentialProtection: "INACTIVE",
      gate: "ACTIVE",
      generation: input.generation,
      hostSuspension: "UNVERIFIED",
      kind: "FIXTURE_GATE_COMMITTED_NON_AUTHORIZING",
      receiptDigest,
    };
  } catch {
    return failed("FAILED_SAFE");
  }
}

/** Observe one fixture claim without changing the PREPARING gate. */
export async function observePreparedCredentialHostSuspension(
  credentialFenceRoot: string,
  handoffRoot: string,
  value: CredentialHostSuspensionObservationInput,
  observeHostSuspension: ObserveCredentialHostSuspension,
): Promise<CredentialHostSuspensionObservationResult> {
  return runPreparedCredentialHostSuspension(
    credentialFenceRoot,
    handoffRoot,
    value,
    observeHostSuspension,
    "OBSERVE_ONLY",
  );
}

/**
 * Terminally consumes the prepared one-shot observation and commits only a
 * fixture blocking-ledger fact after the final locked snapshot. It is mutually
 * exclusive with observePreparedCredentialHostSuspension and does not establish
 * Host suspension, authorization, a credential-input lease, or presentation.
 * No product adapter may call this until authenticated Host/enclave cleanup and
 * G15 exist; cleanupCredentialFixtureGate does not satisfy that requirement.
 */
export async function commitPreparedCredentialFixtureGate(
  credentialFenceRoot: string,
  handoffRoot: string,
  value: CredentialHostSuspensionObservationInput,
  observeHostSuspension: ObserveCredentialHostSuspension,
): Promise<CredentialFixtureGateCommitResult> {
  return runPreparedCredentialHostSuspension(
    credentialFenceRoot,
    handoffRoot,
    value,
    observeHostSuspension,
    "COMMIT_FIXTURE_GATE",
  );
}

/**
 * Reclaims only the local fixture blocking ledger. No external cleanup is
 * observed, so this never authorizes Agent resume or product credential use.
 * Product adapters must use a future authenticated Host/enclave cleanup path.
 */
export async function cleanupCredentialFixtureGate(
  credentialFenceRoot: string,
  value: CredentialFixtureGateCleanupInput,
): Promise<CredentialFixtureGateCleanupResult> {
  let input: CredentialFixtureGateCleanupInput;
  let operation: ReturnType<typeof credentialExecutionBinding>;
  try {
    if (!credentialFenceRoot) {
      return credentialFixtureGateCleanupResult("FAILED_SAFE");
    }
    const candidate: unknown = structuredClone(value);
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      Object.keys(candidate).sort().join(",") !== "binding,generation"
    ) {
      return credentialFixtureGateCleanupResult("FAILED_SAFE");
    }
    input = candidate as CredentialFixtureGateCleanupInput;
    if (!Number.isSafeInteger(input.generation) || input.generation <= 0) {
      return credentialFixtureGateCleanupResult("FAILED_SAFE");
    }
    operation = credentialExecutionBinding(input.binding);
  } catch {
    return credentialFixtureGateCleanupResult("FAILED_SAFE");
  }

  try {
    return await withCredentialToolFenceLock(credentialFenceRoot, async () => {
      const gate = await readCredentialExecutionGateLocked(credentialFenceRoot);
      if (gate.generation !== input.generation) {
        return credentialFixtureGateCleanupResult("FAILED_SAFE");
      }
      if (gate.state !== "OPEN") {
        if (
          gate.operationDigest !== operation.digest ||
          gate.expiresAt !== operation.ticket.handoff.expiresAt
        ) {
          return credentialFixtureGateCleanupResult("FAILED_SAFE");
        }
        const toolFence = await observeCredentialToolFenceCleanupLocked(
          credentialFenceRoot,
          gate,
        );
        if (toolFence.kind === "PENDING") {
          return credentialFixtureGateCleanupResult("WAITING_FOR_NATIVE");
        }
        if (toolFence.kind !== "QUIESCENT") {
          return credentialFixtureGateCleanupResult("FAILED_SAFE");
        }
      }

      const cleaned = await cleanupCredentialExecutionGateLocked(
        credentialFenceRoot,
        input.binding,
        input.generation,
      );
      return credentialFixtureGateOpenResult(
        cleaned === "ALREADY_OPEN"
          ? "FIXTURE_GATE_ALREADY_OPEN_NON_AUTHORIZING"
          : "FIXTURE_GATE_OPENED_NON_AUTHORIZING",
        input.generation,
      );
    });
  } catch {
    try {
      const state = await withCredentialToolFenceLock(credentialFenceRoot, () =>
        confirmCredentialExecutionGateCleanupLocked(
          credentialFenceRoot,
          input.binding,
          input.generation,
        ),
      );
      if (state === "OPEN") {
        return credentialFixtureGateOpenResult(
          "FIXTURE_GATE_OPENED_NON_AUTHORIZING",
          input.generation,
        );
      }
    } catch {
      // The exact tombstone could not be proven; keep every authority inactive.
    }
    return credentialFixtureGateCleanupResult("FAILED_SAFE");
  }
}

/**
 * Evaluates and consumes one completion candidate under the same task lock.
 * This fixture foundation never releases the user lease or activates Handoff.
 */
export async function admitHandoffCompletionCandidate(
  root: string,
  input: CompletionCandidateInput,
  observeCurrentTab: ObserveHandoffCurrentTab,
  monotonicClock: () => number = () => Math.floor(performance.now()),
): Promise<HandoffCompletionAdmissionResult> {
  try {
    const candidate = evaluateCompletionCandidate(input);
    if (candidate.kind === "KEEP_USER_LEASE") {
      return completionResult("KEEP_USER_LEASE");
    }
    if (candidate.kind === "CANCEL_REQUESTED") {
      return completionResult("CANCEL_REQUESTED");
    }
    if (candidate.kind === "FAILED_SAFE") {
      return completionResult("FAILED_SAFE");
    }
    if (
      candidate.lockedBinding.expectedStateVersion >= Number.MAX_SAFE_INTEGER ||
      candidate.lockedBinding.origin !== FIXTURE_ORIGIN ||
      input.lease.scope.topOrigin !== FIXTURE_ORIGIN
    ) {
      return completionResult("FAILED_SAFE");
    }

    const evaluatedAt = input.nowMonotonicMs;
    const lease: HandoffLease = {
      schemaVersion: input.lease.schemaVersion,
      handoffId: input.lease.handoffId,
      leaseEpoch: input.lease.leaseEpoch,
      nonce: input.lease.nonce,
      holder: input.lease.holder,
      scope: { ...input.lease.scope },
      acquiredAt: input.lease.acquiredAt,
      expiresAt: input.lease.expiresAt,
      state: input.lease.state,
    };
    const candidateDigest = deterministicDigest(
      "oxrail-handoff-verification-consume-v1",
      candidate,
    );
    const attemptKey = deterministicDigest(
      "oxrail-handoff-verification-attempt-context-v1",
      {
        handoffId: candidate.lockedBinding.handoffId,
        initialDocumentBinding: candidate.lockedBinding.initialDocumentBinding,
        leaseEpoch: candidate.lockedBinding.leaseEpoch,
        nonce: candidate.lockedBinding.nonce,
        sessionId: candidate.lockedBinding.sessionId,
        tabId: candidate.lockedBinding.tabId,
        taskId: candidate.lockedBinding.taskId,
        verifierContextBindingHash:
          candidate.verificationBinding.verifierContextBindingHash,
      },
    );
    const attemptedThrough = attemptedCompletionPairs.get(attemptKey);
    if (
      attemptedThrough !== undefined &&
      candidate.verificationBinding.firstProbeSequence <= attemptedThrough
    ) {
      return completionResult("FIXTURE_ONLY_REPLAY");
    }
    if (
      attemptedThrough === undefined &&
      attemptedCompletionPairs.size >= MAX_ATTEMPTED_VERIFIER_CONTEXTS
    ) {
      return completionResult("FAILED_SAFE");
    }
    attemptedCompletionPairs.set(
      attemptKey,
      candidate.verificationBinding.secondProbeSequence,
    );
    const scope = {
      sessionId: candidate.lockedBinding.sessionId,
      taskId: candidate.lockedBinding.taskId,
    };

    return await transitionBrowserTaskState<HandoffCompletionAdmissionResult>(
      root,
      scope,
      async (state) => {
        if (!state) return { value: completionResult("FAILED_SAFE") };
        if (matchesCompletionReplay(state, candidate, candidateDigest)) {
          return { value: completionResult("FIXTURE_ONLY_REPLAY") };
        }
        if (!matchesCompletionState(state, candidate)) {
          return { value: completionResult("FAILED_SAFE") };
        }

        const gate = await readHandoffGate(root, scope);
        if (
          gate.kind !== "KNOWN" ||
          gate.status !== "ACTIVE" ||
          gate.generation !== candidate.lockedBinding.leaseEpoch
        ) {
          return { value: completionResult("FAILED_SAFE") };
        }
        const barrier = await readBarrier(
          barrierPath(root, scope, candidate.lockedBinding.leaseEpoch),
        );
        if (!matchesActiveCompletionBarrier(barrier, state, lease, candidate)) {
          return { value: completionResult("FAILED_SAFE") };
        }
        const journal = await inspectToolCallJournal(root, scope);
        if (
          journal.kind !== "KNOWN" ||
          journal.legacyPending ||
          journal.pendingToolUseIds.length > 0
        ) {
          return { value: completionResult("FAILED_SAFE") };
        }

        const deadline = Math.min(
          candidate.verificationBinding.handoffDeadlineAtMonotonicMs,
          candidate.verificationBinding.automaticCandidateDeadlineAtMonotonicMs,
        );
        const beforeObservation = monotonicClock();
        if (
          !Number.isSafeInteger(beforeObservation) ||
          beforeObservation < evaluatedAt ||
          beforeObservation <
            candidate.verificationBinding.secondAcceptedAtMonotonicMs ||
          beforeObservation > deadline
        ) {
          return { value: completionResult("FAILED_SAFE") };
        }

        const activationAnchorDigest = handoffActivationAnchorDigest(barrier);
        const query = Object.freeze(
          completionQuery(barrier, candidate, candidateDigest),
        );
        const observed = await observeWithTimeout(
          observeCurrentTab,
          query,
          Math.min(
            COMPLETION_OBSERVER_TIMEOUT_MS,
            Math.max(0, deadline - beforeObservation),
          ),
        );
        const afterObservation = monotonicClock();
        const parsedReceipt =
          HandoffCurrentTabReceiptSchema.safeParse(observed);
        if (
          !Number.isSafeInteger(afterObservation) ||
          afterObservation < beforeObservation ||
          afterObservation > deadline ||
          !parsedReceipt.success ||
          !matchesCurrentTabReceipt(parsedReceipt.data, query, candidate)
        ) {
          return { value: completionResult("FAILED_SAFE") };
        }

        const finalGate = await readHandoffGate(root, scope);
        const finalBarrier = await readBarrier(
          barrierPath(root, scope, candidate.lockedBinding.leaseEpoch),
        );
        const finalJournal = await inspectToolCallJournal(root, scope);
        const finalNow = monotonicClock();
        if (
          !Number.isSafeInteger(finalNow) ||
          finalNow < afterObservation ||
          finalNow > deadline ||
          finalGate.kind !== "KNOWN" ||
          finalGate.status !== "ACTIVE" ||
          finalGate.generation !== candidate.lockedBinding.leaseEpoch ||
          handoffActivationAnchorDigest(finalBarrier) !==
            activationAnchorDigest ||
          finalJournal.kind !== "KNOWN" ||
          finalJournal.legacyPending ||
          finalJournal.pendingToolUseIds.length > 0
        ) {
          return { value: completionResult("FAILED_SAFE") };
        }

        return {
          state: beginHandoffVerification(state, {
            currentDocumentBinding: parsedReceipt.data.observedDocumentBinding,
            currentOrigin: parsedReceipt.data.origin,
            expectedStateVersion: candidate.lockedBinding.expectedStateVersion,
            handoffId: candidate.lockedBinding.handoffId,
            leaseEpoch: candidate.lockedBinding.leaseEpoch,
            marker: {
              activationAnchorDigest,
              authority: "FIXTURE_ONLY_NON_AUTHORIZING",
              basis: candidate.basis,
              candidateDigest,
              currentTabReceiptDigest: deterministicDigest(
                "oxrail-handoff-current-tab-receipt-v1",
                parsedReceipt.data,
              ),
              firstProbeSequence:
                candidate.verificationBinding.firstProbeSequence,
              leaseEpoch: candidate.lockedBinding.leaseEpoch,
              phaseSignal: candidate.phaseSignal,
              schemaVersion: 1,
              secondProbeSequence:
                candidate.verificationBinding.secondProbeSequence,
              stateEpoch: candidate.verificationBinding.stateEpoch,
              verifierContextBindingHash:
                candidate.verificationBinding.verifierContextBindingHash,
            },
          }),
          value: completionResult("FIXTURE_ONLY_HANDOFF_VERIFYING"),
        };
      },
    );
  } catch {
    return completionResult("FAILED_SAFE");
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
