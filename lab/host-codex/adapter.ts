import { createHmac, randomUUID } from "node:crypto";

import {
  SafeEventSchema,
  ToolNameSchema,
  type SafeEvent,
} from "../protocol/index.js";

export type ToolAlias =
  | "NATIVE_BROWSER"
  | "BUILTIN_BROWSER"
  | "OTHER_REGISTERED";

export type HookProjectionConfig = Readonly<{
  runId: string;
  pairId: string | null;
  sessionToken: string;
  toolBindings: Readonly<Record<string, ToolAlias>>;
}>;

type ProjectionClock = Readonly<{
  eventId?: string;
  nowMs?: number;
}>;

const privateId = (key: string, namespace: string, value: string): string =>
  createHmac("sha256", key)
    .update(namespace)
    .update("\0")
    .update(value)
    .digest("hex");

const safeString = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length > 0 && value.length <= max
    ? value
    : null;

export const projectCodexHookEvent = (
  input: unknown,
  config: HookProjectionConfig,
  clock: ProjectionClock = {},
): SafeEvent => {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("INVALID_HOOK_METADATA");
  const candidate = input as Record<string, unknown>;
  const hookEvent = candidate.hook_event_name;
  const sessionId = safeString(candidate.session_id, 512);
  const toolUseId = safeString(candidate.tool_use_id, 512);
  const toolNameResult = ToolNameSchema.safeParse(candidate.tool_name);
  if (
    (hookEvent !== "PreToolUse" && hookEvent !== "PostToolUse") ||
    sessionId === null ||
    toolUseId === null ||
    !toolNameResult.success
  ) {
    throw new Error("INVALID_HOOK_METADATA");
  }

  const nowMs = clock.nowMs ?? performance.now();
  return SafeEventSchema.parse({
    schemaVersion: 1,
    eventId: clock.eventId ?? randomUUID(),
    runId: config.runId,
    pairId: config.pairId,
    source: "HOST_HOOK",
    sourceClockId: `hook-${process.pid}`,
    sourceSequence: 0,
    observedMonotonicMs: nowMs,
    receivedMonotonicMs: nowMs,
    sessionRef: privateId(config.sessionToken, "session", sessionId),
    callRef: privateId(config.sessionToken, "call", toolUseId),
    actor: "AGENT",
    kind:
      hookEvent === "PreToolUse"
        ? "TOOL_REQUEST_OBSERVED"
        : "TOOL_RESULT_OBSERVED",
    toolAlias: config.toolBindings[toolNameResult.data] ?? null,
    toolName: toolNameResult.data,
    granularity: "UNKNOWN",
    outcome: "UNKNOWN",
    metrics: {
      [hookEvent === "PreToolUse" ? "toolRequests" : "toolCompletions"]: {
        value: 1,
        quality: "MEASURED",
        source: "HOST_HOOK",
        basis: "OBSERVED_EVENT_COUNT",
        missingReason: null,
      },
    },
  });
};
