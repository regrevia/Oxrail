import { lstat } from "node:fs/promises";

import { deterministicDigest } from "../../protocol/src/index.js";
import {
  compareCredentialExecutionGates,
  readCredentialExecutionGate,
  type CredentialExecutionGateSnapshot,
} from "./credential-execution-gate.js";
import {
  MAX_ACTIVE_TOOL_CALLS,
  completeToolCallPost,
  countActiveToolCalls,
  inspectToolCallJournal,
  protectToolCallRequestDigest,
  recordToolCallPre,
  retireCompletedToolCall,
  retireCompletedToolCalls,
  type ToolCallPostInput,
  type ToolCallPreInput,
} from "./tool-call.js";
import { transitionBrowserTaskStateWithRetry } from "./store.js";

const MAX_ID_LENGTH = 4_096;
// Reserved internal scope; it never contains a Host session/task identifier.
const GLOBAL_SCOPE = {
  sessionId: "__oxrail_internal_credential_tool_fence_global_v1__",
  taskId: "__oxrail_internal_credential_tool_fence_global_v1__",
} as const;
const BINDING_DIGEST = deterministicDigest(
  "oxrail-credential-tool-fence-binding-v1",
  {
    authority: "FIXTURE_ONLY_NON_AUTHORIZING",
    scope: "GLOBAL",
    schemaVersion: 1,
  },
);
// The reused journal needs a pending disposition; this record is never a policy result.
const TRACKING_DECISION = {
  disposition: "PASS_THROUGH_ORIGINAL",
  reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
  recoverable: true,
} as const;

export interface CredentialToolFenceCall {
  sessionId: string;
  toolUseId: string;
}

export type CredentialToolFencePreResult =
  | "BLOCKED"
  | "BYPASS"
  | "NO_LEDGER_BLOCK_TRACKED"
  | "UNKNOWN";

export type CredentialToolFencePostResult = "BYPASS" | "COMPLETED" | "UNKNOWN";

export type CredentialToolFenceQuiescence = "PENDING" | "QUIESCENT" | "UNKNOWN";

const validId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= MAX_ID_LENGTH;

async function journalInput(
  root: string,
  input: CredentialToolFenceCall,
): Promise<ToolCallPreInput | undefined> {
  if (
    !input ||
    typeof input !== "object" ||
    Object.keys(input).sort().join(",") !== "sessionId,toolUseId" ||
    !validId(input.sessionId) ||
    !validId(input.toolUseId)
  ) {
    return;
  }
  const unkeyedDigest = deterministicDigest(
    "oxrail-credential-tool-fence-call-v1",
    {
      sessionId: input.sessionId,
      toolUseId: input.toolUseId,
    },
  );
  const callDigest = await protectToolCallRequestDigest(root, unkeyedDigest);
  if (!callDigest) return;
  return {
    ...GLOBAL_SCOPE,
    bindingDigest: BINDING_DIGEST,
    decision: TRACKING_DECISION,
    requestDigest: callDigest,
    toolUseId: callDigest,
  };
}

async function completeAndRetire(
  root: string,
  input: ToolCallPostInput,
): Promise<boolean> {
  const completed = await completeToolCallPost(root, input);
  if (completed !== "COMPLETED" && completed !== "DUPLICATE") return false;
  const retired = await retireCompletedToolCall(root, input);
  return retired === "RETIRED" || retired === "ALREADY_RETIRED";
}

async function withGlobalFenceLock<Result>(
  root: string,
  operation: () => Promise<Result>,
): Promise<Result> {
  return transitionBrowserTaskStateWithRetry(
    root,
    GLOBAL_SCOPE,
    async (state) => {
      if (state) throw new Error("reserved credential fence scope is occupied");
      return { value: await operation() };
    },
  );
}

async function activeIndexHasCapacity(root: string): Promise<boolean> {
  let active = await inspectToolCallJournal(root, GLOBAL_SCOPE);
  if (active.kind !== "KNOWN" || active.legacyPending) return false;
  if (active.completedToolUseIds.length > 0) {
    if (
      (await retireCompletedToolCalls(root, GLOBAL_SCOPE, [])) !== "RETIRED"
    ) {
      return false;
    }
    active = await inspectToolCallJournal(root, GLOBAL_SCOPE);
  }
  const activeCount = await countActiveToolCalls(root, GLOBAL_SCOPE);
  return (
    active.kind === "KNOWN" &&
    !active.legacyPending &&
    active.completedToolUseIds.length === 0 &&
    activeCount !== "UNKNOWN" &&
    activeCount < MAX_ACTIVE_TOOL_CALLS
  );
}

const sameSnapshot = (
  left: CredentialExecutionGateSnapshot,
  right: CredentialExecutionGateSnapshot,
): boolean =>
  deterministicDigest("oxrail-credential-tool-fence-gate-snapshot-v1", left) ===
  deterministicDigest("oxrail-credential-tool-fence-gate-snapshot-v1", right);

async function globalJournalIsKnownEmpty(root: string): Promise<boolean> {
  const active = await inspectToolCallJournal(root, GLOBAL_SCOPE);
  return (
    active.kind === "KNOWN" &&
    !active.legacyPending &&
    active.completedToolUseIds.length === 0 &&
    active.pendingToolUseIds.length === 0
  );
}

async function runtimeRootIsMissing(root: string): Promise<boolean> {
  try {
    await lstat(root);
    return false;
  } catch (error) {
    return (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      String(error.code) === "ENOENT"
    );
  }
}

/**
 * Tracks one fixture call against two complete gate reads. The positive result
 * means only that this local ledger did not block; it is not permission, a Host
 * fence, capability evidence, or authority to execute. BYPASS proves only that
 * no local runtime root exists.
 */
export async function credentialToolFencePre(
  root: string,
  input: CredentialToolFenceCall,
): Promise<CredentialToolFencePreResult> {
  try {
    const initial = await readCredentialExecutionGate(root);
    if (initial.kind === "UNINITIALIZED") {
      return (await runtimeRootIsMissing(root)) ? "BYPASS" : "UNKNOWN";
    }
    if (initial.kind !== "KNOWN") return "UNKNOWN";
    if (initial.state !== "OPEN") return "BLOCKED";

    const journal = await journalInput(root, input);
    if (!journal) return "UNKNOWN";
    return await withGlobalFenceLock(root, async () => {
      const locked = await readCredentialExecutionGate(root);
      const lockedComparison = compareCredentialExecutionGates(initial, locked);
      if (lockedComparison !== "OPEN") {
        return lockedComparison === "UNKNOWN" ? "UNKNOWN" : "BLOCKED";
      }
      if (!(await activeIndexHasCapacity(root))) return "UNKNOWN";

      const claim = await recordToolCallPre(root, journal);
      if (claim.kind === "MISMATCH" || claim.kind === "UNAVAILABLE") {
        return "UNKNOWN";
      }
      const current = await readCredentialExecutionGate(root);
      const comparison = compareCredentialExecutionGates(initial, current);
      if (claim.kind === "RECORDED" && comparison === "OPEN") {
        return "NO_LEDGER_BLOCK_TRACKED";
      }

      if (
        claim.kind === "RECORDED" &&
        !(await completeAndRetire(root, journal))
      ) {
        return "UNKNOWN";
      }
      if (claim.kind === "REPLAY" && claim.journalStatus === "COMPLETE") {
        await retireCompletedToolCall(root, journal);
      }
      return comparison === "UNKNOWN" ? "UNKNOWN" : "BLOCKED";
    });
  } catch {
    return "UNKNOWN";
  }
}

/** Completes an older tracked call regardless of the gate's current state. */
export async function credentialToolFencePost(
  root: string,
  input: CredentialToolFenceCall,
): Promise<CredentialToolFencePostResult> {
  try {
    const gate = await readCredentialExecutionGate(root);
    if (gate.kind === "UNINITIALIZED") {
      if (await runtimeRootIsMissing(root)) return "BYPASS";
      if (await globalJournalIsKnownEmpty(root)) return "UNKNOWN";
    }
    const journal = await journalInput(root, input);
    if (!journal) return "UNKNOWN";
    return await withGlobalFenceLock(root, async () => {
      const completed = await completeToolCallPost(root, journal);
      if (completed === "OUT_OF_ORDER" || completed === "UNAVAILABLE") {
        return "UNKNOWN";
      }
      const retired = await retireCompletedToolCall(root, journal);
      return retired === "RETIRED" || retired === "ALREADY_RETIRED"
        ? "COMPLETED"
        : "UNKNOWN";
    });
  } catch {
    return "UNKNOWN";
  }
}

/**
 * A bounded local observation for one unchanged PREPARING snapshot. QUIESCENT
 * is never a Host receipt, admission fence, capability claim, or authority.
 * Gate PREPARE does not share this mutex, and the final Host admission window
 * remains deliberately unresolved until an external Host-wide fence exists.
 */
export async function readCredentialToolFenceQuiescence(
  root: string,
): Promise<CredentialToolFenceQuiescence> {
  try {
    const initial = await readCredentialExecutionGate(root);
    if (initial.kind !== "KNOWN" || initial.state !== "PREPARING") {
      return "UNKNOWN";
    }
    return await withGlobalFenceLock(root, async () => {
      const locked = await readCredentialExecutionGate(root);
      if (
        locked.kind !== "KNOWN" ||
        locked.state !== "PREPARING" ||
        !sameSnapshot(initial, locked)
      ) {
        return "UNKNOWN";
      }
      const active = await inspectToolCallJournal(root, GLOBAL_SCOPE);
      const current = await readCredentialExecutionGate(root);
      if (
        current.kind !== "KNOWN" ||
        current.state !== "PREPARING" ||
        !sameSnapshot(initial, current) ||
        active.kind === "UNKNOWN"
      ) {
        return "UNKNOWN";
      }
      return active.legacyPending || active.pendingToolUseIds.length > 0
        ? "PENDING"
        : "QUIESCENT";
    });
  } catch {
    return "UNKNOWN";
  }
}
