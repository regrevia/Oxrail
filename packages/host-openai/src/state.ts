import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
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

export const digestToolUseId = (toolUseId: string): string =>
  createHash("sha256")
    .update("oxrail-tool-use-v1\0")
    .update(toolUseId)
    .digest("hex");

export interface BrowserRouteObservation {
  definitionHash: string;
  postObservedAt?: string;
  preObservedAt?: string;
  profileId: string;
  schemaVersion: 1;
  sessionDigest: string | null;
  synthetic: boolean;
  toolUseDigest: string;
}

const markerNames: Record<HookEventName, string> = {
  SessionStart: "session-start.json",
  UserPromptSubmit: "user-prompt-submit.json",
  PreToolUse: "pre-tool-use.json",
  PermissionRequest: "permission-request.json",
  PostToolUse: "post-tool-use.json",
};

const stateDirectory = (pluginData: string) =>
  path.join(pluginData, "setup-verification");
const browserRouteDirectory = (pluginData: string) =>
  path.join(stateDirectory(pluginData), "browser-route");
const markerPath = (
  pluginData: string,
  event: HookEventName,
  browserHook: boolean,
) =>
  path.join(
    stateDirectory(pluginData),
    `${browserHook ? "browser-" : ""}${markerNames[event]}`,
  );

const isHash = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

function isBrowserRouteObservation(
  value: unknown,
): value is BrowserRouteObservation {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<BrowserRouteObservation>;
  return (
    marker.schemaVersion === 1 &&
    isHash(marker.definitionHash) &&
    typeof marker.profileId === "string" &&
    marker.profileId.length > 0 &&
    isHash(marker.toolUseDigest) &&
    typeof marker.synthetic === "boolean" &&
    (marker.sessionDigest === null || isHash(marker.sessionDigest)) &&
    (marker.preObservedAt === undefined ||
      Number.isFinite(Date.parse(marker.preObservedAt))) &&
    (marker.postObservedAt === undefined ||
      Number.isFinite(Date.parse(marker.postObservedAt))) &&
    (marker.preObservedAt !== undefined || marker.postObservedAt !== undefined)
  );
}

export async function recordBrowserHookPhase(
  pluginData: string,
  phase: "PreToolUse" | "PostToolUse",
  observation: Omit<
    BrowserRouteObservation,
    "postObservedAt" | "preObservedAt" | "schemaVersion"
  >,
  now = Date.now(),
): Promise<void> {
  const directory = browserRouteDirectory(pluginData);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = path.join(directory, `${observation.toolUseDigest}.json`);
  let previous: BrowserRouteObservation | undefined;
  try {
    const candidate: unknown = JSON.parse(await readFile(destination, "utf8"));
    if (
      isBrowserRouteObservation(candidate) &&
      candidate.definitionHash === observation.definitionHash &&
      candidate.profileId === observation.profileId &&
      candidate.sessionDigest === observation.sessionDigest &&
      candidate.synthetic === observation.synthetic
    ) {
      previous = candidate;
    }
  } catch {
    // A missing or invalid marker is replaced with current, sanitized evidence.
  }
  if (phase === "PostToolUse" && !previous?.preObservedAt) return;
  const observedAt = new Date(now).toISOString();
  const value: BrowserRouteObservation = {
    ...observation,
    ...previous,
    ...(phase === "PreToolUse"
      ? { preObservedAt: previous?.preObservedAt ?? observedAt }
      : { postObservedAt: previous?.postObservedAt ?? observedAt }),
    schemaVersion: 1,
  };
  const temporary = path.join(
    directory,
    `.${observation.toolUseDigest}.${randomUUID()}`,
  );
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  await rename(temporary, destination);
}

export async function readBrowserRouteObservations(
  pluginData: string,
): Promise<BrowserRouteObservation[]> {
  try {
    const directory = browserRouteDirectory(pluginData);
    const names = (await readdir(directory)).filter((name) =>
      /^[a-f0-9]{64}\.json$/.test(name),
    );
    const markers = await Promise.all(
      names.map(async (name) => {
        try {
          const value: unknown = JSON.parse(
            await readFile(path.join(directory, name), "utf8"),
          );
          return isBrowserRouteObservation(value) ? value : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    return markers.filter(
      (marker): marker is BrowserRouteObservation => marker !== undefined,
    );
  } catch {
    return [];
  }
}

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
