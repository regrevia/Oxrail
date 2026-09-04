import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { classifyTool } from "./matcher.js";
import { loadHostProfile } from "./profile.js";
import {
  digestSessionId,
  digestToolUseId,
  HOOK_EVENTS,
  oxrailDataDirectory,
  recordBrowserHookPhase,
  recordHookMarker,
  type HookEventName,
} from "./state.js";

export type HookOutput = Record<string, never> | { systemMessage: string };

interface HookInput {
  hook_event_name: HookEventName;
  session_id?: string;
  tool_name?: string;
  tool_use_id?: string;
}

export interface HookEnvironment {
  now?: () => number;
  pluginData: string;
  pluginRoot: string;
}

const isHookInput = (value: unknown): value is HookInput => {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<HookInput>;
  return (
    typeof input.hook_event_name === "string" &&
    HOOK_EVENTS.includes(input.hook_event_name as HookEventName) &&
    (input.session_id === undefined || typeof input.session_id === "string") &&
    (input.tool_name === undefined || typeof input.tool_name === "string") &&
    (input.tool_use_id === undefined || typeof input.tool_use_id === "string")
  );
};

export async function hookDefinitionHash(pluginRoot: string): Promise<string> {
  const definition = await readFile(
    path.join(pluginRoot, "hooks", "hooks.json"),
  );
  return createHash("sha256").update(definition).digest("hex");
}

const bypassMessage =
  "Oxrail optimization unavailable / BYPASSED. Native Computer Use remains available. " +
  "Oxrail safety protection: INACTIVE. Oxrail handoff protection: INACTIVE.";
const bypassOutput = (): HookOutput => ({ systemMessage: bypassMessage });

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
  await recordHookMarker(
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
  if (!profileResult.valid || !profileResult.profile)
    return browserPath ? bypassOutput() : {};
  if (!toolEvent || !value.tool_name || !browserPath) return {};
  if (profileResult.profile.setup.lifecycle === "INSTALLED")
    return bypassOutput();

  if (
    profileResult.profile.setup.lifecycle === "CONFIGURED" &&
    value.tool_use_id &&
    sessionDigest
  ) {
    await recordBrowserHookPhase(
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
    );
  }

  // Passive verification never blocks, rewrites, replays, or substitutes native I/O.
  return {};
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
      pluginData: oxrailDataDirectory(),
      pluginRoot,
    });
    process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    // Hook failure must not take down native Computer Use, and input is never logged.
    process.stdout.write(`${JSON.stringify(bypassOutput())}\n`);
  }
}
