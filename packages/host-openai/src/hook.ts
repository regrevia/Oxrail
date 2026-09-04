import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  deterministicDigest,
  type ActionEnvelope,
  type BrowserTaskState,
  type HostProfile,
  type PolicyDecision,
} from "../../protocol/src/index.js";
import {
  BrowserTaskStateStoreError,
  type BrowserTaskStateTransition,
  actionIdentity,
  browserOwnershipDecision,
  completePendingTool,
  completeToolCallPost,
  createLocalDigestProtector,
  createBrowserTaskState,
  migrateLegacyActionSignatureBaseline,
  recordToolCallPre,
  stageToolDecision,
  transitionBrowserTaskState,
} from "../../core/src/index.js";
import {
  buildPreToolUseOutput,
  runGuardPreToolUse,
  type PreToolUseOutput,
} from "./guard.js";
import { classifyTool } from "./matcher.js";
import { loadHostProfile } from "./profile.js";
import { loadToolSchemaRegistryBundle } from "./registry-bundle.js";
import {
  digestSessionId,
  digestToolUseId,
  HOOK_EVENTS,
  oxrailDataDirectory,
  recordBrowserHookPhase,
  recordHookMarker,
  type HookEventName,
} from "./state.js";

export type HookOutput = PreToolUseOutput | { systemMessage: string };

interface HookInput {
  hook_event_name: HookEventName;
  session_id?: string;
  tool_input?: unknown;
  tool_name?: string;
  tool_use_id?: string;
  turn_id?: string;
}

export interface HookEnvironment {
  now?: () => number;
  pluginData: string;
  pluginRoot: string;
  /** Must be supplied only by a trusted external attestation verifier. */
  verifyGuardActivation?: (profile: HostProfile) => boolean | Promise<boolean>;
}

const isHookInput = (value: unknown): value is HookInput => {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<HookInput>;
  return (
    typeof input.hook_event_name === "string" &&
    HOOK_EVENTS.includes(input.hook_event_name as HookEventName) &&
    (input.session_id === undefined ||
      (typeof input.session_id === "string" &&
        input.session_id.length <= 4_096)) &&
    (input.tool_name === undefined ||
      (typeof input.tool_name === "string" && input.tool_name.length <= 256)) &&
    (input.tool_use_id === undefined ||
      (typeof input.tool_use_id === "string" &&
        input.tool_use_id.length <= 4_096)) &&
    (input.turn_id === undefined ||
      (typeof input.turn_id === "string" && input.turn_id.length <= 4_096))
  );
};

export const hookRuntimeStateDirectory = (pluginData: string): string =>
  path.join(pluginData, "runtime-state");

export function hookBrowserTaskScope(sessionId: string) {
  const sessionDigest = digestSessionId(sessionId);
  const taskDigest = createHash("sha256")
    .update("oxrail-hook-browser-task-v1\0")
    .update(sessionDigest)
    .digest("hex");
  // ponytail: one browser task per Host session until a stable native task id exists.
  return { sessionId: sessionDigest, taskId: taskDigest };
}

export async function hookDefinitionHash(pluginRoot: string): Promise<string> {
  const filenames = [
    ".codex-plugin/plugin.json",
    "hooks/hooks.json",
    "dist/hooks/pre-tool.mjs",
    "dist/hooks/post-tool.mjs",
  ];
  const files = await Promise.all(
    filenames.map((filename) => readFile(path.join(pluginRoot, filename))),
  );
  const digest = createHash("sha256").update("oxrail-hook-definition-v2\0");
  for (const [index, filename] of filenames.entries()) {
    digest
      .update(filename)
      .update("\0")
      .update(String(files[index]!.length))
      .update("\0")
      .update(files[index]!);
  }
  return digest.digest("hex");
}

const bypassMessage =
  "Oxrail optimization unavailable / BYPASSED. Native Computer Use remains available. " +
  "Oxrail safety protection: INACTIVE. Oxrail handoff protection: INACTIVE. " +
  "Oxrail credential protection: INACTIVE.";
const bypassOutput = (): HookOutput => ({ systemMessage: bypassMessage });

const decisionOutput = (decision: PolicyDecision): HookOutput =>
  buildPreToolUseOutput(decision);
const inconclusiveOutput = (): HookOutput =>
  decisionOutput({
    disposition: "BLOCK_BEFORE_EXECUTION",
    reasonCode: "OXRAIL_VERIFICATION_INCONCLUSIVE",
    recoverable: true,
  });

const toolCallRequestDigest = (
  toolName: string,
  action: ActionEnvelope | undefined,
  decision: PolicyDecision,
): string =>
  deterministicDigest(
    "oxrail-hook-tool-call-request-v1",
    action
      ? {
          actionIdentity: actionIdentity(action),
          impact: action.impact,
          origin: action.origin,
          revision: action.revision,
          toolName,
        }
      : {
          disposition: decision.disposition,
          reasonCode: decision.reasonCode,
          toolName,
        },
  );

const toolCallBindingDigest = (
  profile: HostProfile,
  toolName: string,
  binding: {
    expectedInputSchemaHash: string;
    expectedRegistryHash: string;
  },
): string =>
  deterministicDigest("oxrail-hook-tool-call-binding-v1", {
    definitionHash: profile.hooks.definitionHash,
    inputSchemaHash: binding.expectedInputSchemaHash,
    matcherEvidenceHash: profile.route.matcherEvidenceHash,
    profileId: profile.profileId,
    registryHash: binding.expectedRegistryHash,
    toolName,
  });

function ownershipOutput(
  state: BrowserTaskState,
  scope: ReturnType<typeof hookBrowserTaskScope>,
): HookOutput | undefined {
  if (state.sessionId !== scope.sessionId || state.taskId !== scope.taskId) {
    return undefined;
  }
  const decision = browserOwnershipDecision(state);
  return decision ? decisionOutput(decision) : undefined;
}

function alignStateToProfile(
  saved: BrowserTaskState,
  scope: ReturnType<typeof hookBrowserTaskScope>,
  profile: HostProfile,
): BrowserTaskState | undefined {
  if (
    saved.hostProfileId === profile.profileId &&
    saved.hostProfileStatus === "VALID" &&
    saved.mode === profile.derived.mode
  ) {
    return saved;
  }
  if (
    saved.phase !== "RUNNING" ||
    saved.pointerOwner !== "NATIVE" ||
    saved.pendingNativeActionIds.length > 0
  ) {
    return undefined;
  }
  const fresh = createBrowserTaskState({
    ...scope,
    hostProfileId: profile.profileId,
    mode: profile.derived.mode,
  });
  return {
    ...fresh,
    leaseEpoch: saved.leaseEpoch,
    revision: saved.revision + 1,
    stateVersion: saved.stateVersion,
    targetCacheEpoch: saved.targetCacheEpoch + 1,
  };
}

function alignStateToActionSignatureKey(
  state: BrowserTaskState,
  keyId: string,
): { ready: boolean; state: BrowserTaskState } {
  try {
    return {
      ready: true,
      state: migrateLegacyActionSignatureBaseline(state, keyId),
    };
  } catch {
    return { ready: false, state };
  }
}

const STATE_TRANSITION_ATTEMPTS = 10;
const waitForStateRetry = (attempt: number) =>
  new Promise<void>((resolve) =>
    setTimeout(resolve, Math.min(2 ** attempt, 8)),
  );

async function transitionWithRetry<Result>(
  runtimeRoot: string,
  scope: ReturnType<typeof hookBrowserTaskScope>,
  transition: (
    state: BrowserTaskState | undefined,
  ) =>
    | BrowserTaskStateTransition<Result>
    | Promise<BrowserTaskStateTransition<Result>>,
): Promise<Result> {
  for (let attempt = 0; attempt < STATE_TRANSITION_ATTEMPTS; attempt += 1) {
    try {
      return await transitionBrowserTaskState(runtimeRoot, scope, transition);
    } catch (error) {
      if (
        !(error instanceof BrowserTaskStateStoreError) ||
        error.code !== "CONFLICT" ||
        attempt === STATE_TRANSITION_ATTEMPTS - 1
      ) {
        throw error;
      }
      await waitForStateRetry(attempt);
    }
  }
  throw new BrowserTaskStateStoreError("CONFLICT");
}

async function completePostTool(
  runtimeRoot: string,
  scope: ReturnType<typeof hookBrowserTaskScope>,
  toolUseId: string,
): Promise<"COMPLETED" | "NOT_FOUND" | "UNAVAILABLE"> {
  const journal = await completeToolCallPost(runtimeRoot, {
    ...scope,
    toolUseId,
  });
  if (journal === "OUT_OF_ORDER") return "NOT_FOUND";
  if (journal === "UNAVAILABLE") return "UNAVAILABLE";
  await transitionWithRetry(runtimeRoot, scope, (state) => {
    if (!state) return { value: {} };
    const completed = completePendingTool(state, toolUseId);
    return completed.stateVersion === state.stateVersion
      ? { value: {} }
      : { state: completed, value: {} };
  });
  return "COMPLETED";
}

/** Handle one host event. Any error is deliberately fail-open in runHookCli. */
export async function handleHookEvent(
  value: unknown,
  environment: HookEnvironment,
): Promise<HookOutput> {
  if (!isHookInput(value)) return {};

  const now = environment.now?.() ?? Date.now();
  const sessionDigest = value.session_id
    ? digestSessionId(value.session_id)
    : null;
  const definitionHash = await hookDefinitionHash(environment.pluginRoot);
  const profileResult = await loadHostProfile(environment.pluginData, {
    definitionHash,
  });
  const profileId = profileResult.profile?.profileId ?? null;
  const hookMarkerRecorded = await recordHookMarker(
    environment.pluginData,
    {
      browserHook: false,
      definitionHash,
      event: value.hook_event_name,
      profileId,
      sessionDigest,
      synthetic: false,
    },
    now,
  ).then(
    () => true,
    () => false,
  );

  if (value.hook_event_name === "SessionStart")
    return profileResult.valid ? {} : bypassOutput();

  const toolEvent =
    value.hook_event_name === "PreToolUse" ||
    value.hook_event_name === "PostToolUse"
      ? value.hook_event_name
      : undefined;
  const browserPath = Boolean(
    toolEvent &&
      value.tool_name &&
      profileResult.profile &&
      classifyTool(profileResult.profile, value.tool_name) === "BROWSER",
  );
  const browserMarkerRecorded =
    profileResult.valid &&
    profileResult.profile &&
    toolEvent &&
    browserPath &&
    profileResult.profile.setup.lifecycle !== "INSTALLED" &&
    value.tool_use_id &&
    sessionDigest
      ? await recordBrowserHookPhase(
          environment.pluginData,
          toolEvent,
          {
            definitionHash,
            profileId: profileResult.profile.profileId,
            sessionDigest,
            synthetic: false,
            toolUseDigest: digestToolUseId(value.tool_use_id),
          },
          now,
        ).then(
          () => true,
          () => false,
        )
      : true;

  if (toolEvent === "PostToolUse" && value.session_id && value.tool_use_id) {
    const completion = await completePostTool(
      hookRuntimeStateDirectory(environment.pluginData),
      hookBrowserTaskScope(value.session_id),
      value.tool_use_id,
    ).catch(() => "UNAVAILABLE" as const);
    if (completion === "COMPLETED") return {};
    if (completion === "UNAVAILABLE") return bypassOutput();
  }

  if (!profileResult.valid || !profileResult.profile)
    return browserPath ? bypassOutput() : {};
  if (!toolEvent || !value.tool_name || !browserPath) return {};

  const profile = profileResult.profile;
  if (profile.setup.lifecycle === "CONFIGURED") {
    return hookMarkerRecorded && browserMarkerRecorded ? {} : bypassOutput();
  }
  if (profile.setup.lifecycle !== "VERIFIED") return bypassOutput();
  if (!value.session_id || !value.tool_use_id) {
    return bypassOutput();
  }
  let guardActivationVerified = false;
  if (environment.verifyGuardActivation) {
    try {
      guardActivationVerified =
        await environment.verifyGuardActivation(profile);
    } catch {
      // A missing/stale attestation receipt must never activate Guard.
    }
  }
  if (!guardActivationVerified) return bypassOutput();

  const scope = hookBrowserTaskScope(value.session_id);
  const runtimeRoot = hookRuntimeStateDirectory(environment.pluginData);
  if (toolEvent === "PostToolUse") {
    return bypassOutput();
  }

  const bundle = await loadToolSchemaRegistryBundle(
    environment.pluginData,
    profile,
  );
  const localDigestProtector = await createLocalDigestProtector(runtimeRoot);
  const signatureProtector = localDigestProtector
    ? {
        keyId: localDigestProtector.keyId,
        protect: (purpose: "input" | "target", digest: string) =>
          localDigestProtector.protect(
            purpose === "input" ? "action-input-v1" : "action-target-v1",
            digest,
          ),
      }
    : undefined;

  let blockingOutput: HookOutput | undefined;
  try {
    return await transitionWithRetry(runtimeRoot, scope, async (saved) => {
      let state =
        saved ??
        createBrowserTaskState({
          ...scope,
          hostProfileId: profile.profileId,
          mode: profile.derived.mode,
        });
      const ownership = ownershipOutput(state, scope);
      if (ownership) return { value: ownership };
      if (saved) {
        const aligned = alignStateToProfile(saved, scope, profile);
        if (!aligned) return { value: bypassOutput() };
        state = aligned;
      }
      const signatureState = signatureProtector
        ? alignStateToActionSignatureKey(state, signatureProtector.keyId)
        : { ready: false, state };
      state = signatureState.state;
      const binding =
        bundle.status === "VALID"
          ? bundle.bindings[value.tool_name!]
          : undefined;
      if (!guardActivationVerified || bundle.status !== "VALID" || !binding) {
        return { value: bypassOutput() };
      }
      const guarded = runGuardPreToolUse({
        ...binding,
        call: {
          toolInput: value.tool_input,
          toolName: value.tool_name!,
          toolUseId: value.tool_use_id!,
        },
        handoffAvailable: profile.handoff.activation === "ACTIVE",
        hostApprovalAvailable:
          profile.nativeCapabilities.nativeApprovalFlow === "passed",
        profile,
        registry: bundle.registry,
        ...(signatureProtector ? { signatureProtector } : {}),
        ...scope,
        state,
      });
      if (guarded.mode !== "ACTIVE") return { value: bypassOutput() };
      const blocking = ![
        "PASS_THROUGH_ORIGINAL",
        "SEMANTIC_HINT_ONLY",
      ].includes(guarded.decision.disposition);
      if (blocking) blockingOutput = guarded.output;
      if (
        !localDigestProtector ||
        !signatureProtector ||
        !signatureState.ready
      ) {
        return { value: blocking ? guarded.output : bypassOutput() };
      }
      const requestDigest = localDigestProtector.protect(
        "tool-call-request-v1",
        toolCallRequestDigest(
          value.tool_name!,
          guarded.action,
          guarded.decision,
        ),
      );
      const claim = await recordToolCallPre(runtimeRoot, {
        ...scope,
        bindingDigest: toolCallBindingDigest(
          profile,
          value.tool_name!,
          binding,
        ),
        decision: guarded.decision,
        requestDigest,
        toolUseId: value.tool_use_id!,
      });
      if (claim.kind === "MISMATCH") {
        return { value: inconclusiveOutput() };
      }
      if (claim.kind === "UNAVAILABLE") {
        return { value: blocking ? guarded.output : bypassOutput() };
      }
      if (claim.kind === "REPLAY") {
        const replayBlocks = ![
          "PASS_THROUGH_ORIGINAL",
          "SEMANTIC_HINT_ONLY",
        ].includes(claim.decision.disposition);
        return {
          value: replayBlocks
            ? decisionOutput(claim.decision)
            : inconclusiveOutput(),
        };
      }
      if (!guarded.action) return { value: guarded.output };
      return {
        state: stageToolDecision(
          state,
          guarded.action,
          claim.decision,
          signatureProtector,
        ),
        value: guarded.output,
      };
    });
  } catch {
    return blockingOutput ?? bypassOutput();
  }
}

async function readStdin(maximumBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > maximumBytes)
      throw new Error("hook input exceeds the local limit");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export async function runHookCli(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    const pluginRoot = environment.PLUGIN_ROOT;
    if (!pluginRoot) throw new Error("missing plugin environment");
    const output = await handleHookEvent(await readStdin(), {
      pluginData:
        environment.PLUGIN_DATA ??
        environment.CLAUDE_PLUGIN_DATA ??
        oxrailDataDirectory(),
      pluginRoot,
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Hook failure must not take down native Computer Use, and input is never logged.
    process.stdout.write(`${JSON.stringify(bypassOutput())}\n`);
  }
}
