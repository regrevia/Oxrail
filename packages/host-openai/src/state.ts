import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PermissionRequest",
  "PostToolUse",
] as const;
export type HookEventName = (typeof HOOK_EVENTS)[number];
export const HOOK_MARKER_FRESHNESS_MS = 30_000;
export const oxrailDataDirectory = (home = homedir()): string =>
  path.join(home, ".oxrail");

export interface HookMarker {
  browserHook: boolean;
  definitionHash: string;
  event: HookEventName;
  first_browser_hook_seen: boolean;
  observedAt: string;
  profileId: string | null;
  schemaVersion: 2;
  sessionDigest: string | null;
  synthetic: boolean;
}

export const digestSessionId = (sessionId: string): string =>
  createHash("sha256")
    .update("oxrail-session-v1\0")
    .update(sessionId)
    .digest("hex");

const markerNames: Record<HookEventName, string> = {
  SessionStart: "session-start.json",
  UserPromptSubmit: "user-prompt-submit.json",
  PreToolUse: "pre-tool-use.json",
  PermissionRequest: "permission-request.json",
  PostToolUse: "post-tool-use.json",
};

const stateDirectory = (pluginData: string) =>
  path.join(pluginData, "setup-verification");
const markerPath = (
  pluginData: string,
  event: HookEventName,
  browserHook: boolean,
) =>
  path.join(
    stateDirectory(pluginData),
    `${browserHook ? "browser-" : ""}${markerNames[event]}`,
  );

function isMarker(value: unknown): value is HookMarker {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<HookMarker>;
  return (
    marker.schemaVersion === 2 &&
    typeof marker.definitionHash === "string" &&
    typeof marker.browserHook === "boolean" &&
    marker.first_browser_hook_seen === marker.browserHook &&
    typeof marker.synthetic === "boolean" &&
    typeof marker.observedAt === "string" &&
    (marker.profileId === null || typeof marker.profileId === "string") &&
    (marker.sessionDigest === null ||
      (typeof marker.sessionDigest === "string" &&
        /^[a-f0-9]{64}$/.test(marker.sessionDigest))) &&
    HOOK_EVENTS.includes(marker.event as HookEventName)
  );
}

export async function recordHookMarker(
  pluginData: string,
  marker: Omit<
    HookMarker,
    "first_browser_hook_seen" | "observedAt" | "schemaVersion"
  >,
  now = Date.now(),
): Promise<void> {
  const directory = stateDirectory(pluginData);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = markerPath(pluginData, marker.event, marker.browserHook);
  const temporary = path.join(
    directory,
    `.${path.basename(destination)}.${randomUUID()}`,
  );
  const value: HookMarker = {
    ...marker,
    first_browser_hook_seen: marker.browserHook,
    observedAt: new Date(now).toISOString(),
    schemaVersion: 2,
  };
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function readHookMarker(
  pluginData: string,
  event: HookEventName,
  browserHook = false,
): Promise<HookMarker | undefined> {
  try {
    const value: unknown = JSON.parse(
      await readFile(markerPath(pluginData, event, browserHook), "utf8"),
    );
    return isMarker(value) &&
      value.event === event &&
      value.browserHook === browserHook
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

export async function markerMatches(
  pluginData: string,
  event: HookEventName,
  definitionHash: string,
  options: {
    browserHook?: boolean;
    maxAgeMs?: number;
    now?: number;
    profileId?: string;
    sessionDigest?: string;
  } = {},
): Promise<boolean> {
  const marker = await readHookMarker(
    pluginData,
    event,
    options.browserHook ?? false,
  );
  const age =
    (options.now ?? Date.now()) - Date.parse(marker?.observedAt ?? "");
  return Boolean(
    marker &&
      marker.definitionHash === definitionHash &&
      (!options.profileId || marker.profileId === options.profileId) &&
      (options.sessionDigest === undefined ||
        marker.sessionDigest === options.sessionDigest) &&
      Number.isFinite(age) &&
      age >= 0 &&
      age <= (options.maxAgeMs ?? HOOK_MARKER_FRESHNESS_MS),
  );
}
