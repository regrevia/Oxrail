import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  open,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import { deriveHostMode } from "../../core/src/index.js";
import {
  HostProfileSchema,
  type HostProfile,
} from "../../protocol/src/index.js";

export const HOSTS_DIRECTORY = "hosts";
export const HOST_PROFILE_FILENAME = "profile.json";
export const HOST_PROFILE_MANIFEST_FILENAME = "manifest.json";
export const ACTIVE_HOST_PROFILE_FILENAME = "active-profile.json";
export const CREDENTIAL_ACTIVATION_UNAVAILABLE_ERROR =
  "credential activation denied: independent macOS attestation verifier unavailable";

export interface ProfileConstraints {
  browserPath?: HostProfile["identity"]["browserPath"];
  canonicalToolMatchers?: string[];
  codexVersion?: string;
  computerUsePluginVersion?: string;
  definitionHash?: string;
  hostBuild?: string;
  matcherEvidenceHash?: string;
  os?: HostProfile["identity"]["os"];
  surface?: HostProfile["identity"]["surface"];
  toolRoute?: HostProfile["route"]["toolRoute"];
}

export interface ProfileValidation {
  errors: string[];
  profile?: HostProfile;
  valid: boolean;
}

const safeProfileId = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const sha256 = (value: Uint8Array | string) =>
  createHash("sha256").update(value).digest("hex");
const profileDirectory = (pluginData: string, profileId: string) =>
  path.join(pluginData, HOSTS_DIRECTORY, profileId);

async function readLimited(filename: string, maximumBytes: number) {
  const handle = await open(filename, "r");
  try {
    if ((await handle.stat()).size > maximumBytes)
      throw new Error("file exceeds local limit");
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

async function writePrivate(filename: string, value: string) {
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporary, value, { flag: "wx", mode: 0o600 });
    await rename(temporary, filename);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export function validateHostProfile(
  value: unknown,
  constraints: ProfileConstraints = {},
): ProfileValidation {
  if (
    value &&
    typeof value === "object" &&
    (value as { schemaVersion?: unknown }).schemaVersion === 3
  ) {
    return {
      errors: [
        "host profile schema v3 is stale; run Oxrail setup to create a v4 profile",
      ],
      valid: false,
    };
  }
  const parsed = HostProfileSchema.safeParse(value);
  if (!parsed.success) {
    return {
      errors: parsed.error.issues.map((issue) =>
        issue.path.length
          ? `${issue.path.join(".")}: ${issue.message}`
          : issue.message,
      ),
      valid: false,
    };
  }

  const profile = parsed.data;
  const errors: string[] = [];
  if (profile.credentialChannel.activation === "ACTIVE")
    errors.push(CREDENTIAL_ACTIVATION_UNAVAILABLE_ERROR);
  if (!profile.evidence.validUntilHostChange)
    errors.push("host profile is stale");
  if (
    new Set(profile.route.canonicalToolMatchers).size !==
    profile.route.canonicalToolMatchers.length
  ) {
    errors.push("canonical tool matchers must be unique");
  }
  if (profile.route.canonicalToolMatchers.length === 0) {
    errors.push("profile has no evidence-backed tool matcher");
  }
  if (
    constraints.definitionHash &&
    profile.hooks.definitionHash !== constraints.definitionHash
  ) {
    errors.push("hook definition hash changed");
  }
  if (constraints.surface && profile.identity.surface !== constraints.surface) {
    errors.push("profile surface does not match the requested surface");
  }
  if (
    constraints.browserPath &&
    profile.identity.browserPath !== constraints.browserPath
  ) {
    errors.push(
      "profile browser path does not match the requested browser path",
    );
  }
  for (const field of [
    "hostBuild",
    "codexVersion",
    "computerUsePluginVersion",
    "os",
  ] as const) {
    if (
      constraints[field] !== undefined &&
      profile.identity[field] !== constraints[field]
    ) {
      errors.push(`profile ${field} does not match the current host`);
    }
  }
  if (
    constraints.toolRoute &&
    profile.route.toolRoute !== constraints.toolRoute
  ) {
    errors.push("profile tool route does not match the current host");
  }
  if (
    constraints.matcherEvidenceHash &&
    profile.route.matcherEvidenceHash !== constraints.matcherEvidenceHash
  ) {
    errors.push("profile matcher evidence does not match the current host");
  }
  if (
    constraints.canonicalToolMatchers &&
    JSON.stringify(profile.route.canonicalToolMatchers) !==
      JSON.stringify(constraints.canonicalToolMatchers)
  ) {
    errors.push("profile browser tool names do not match the current host");
  }

  const evidenceMode = deriveHostMode(profile);
  if (
    !["ADVISORY_ONLY", "UNSUPPORTED"].includes(profile.derived.mode) &&
    profile.derived.mode !== evidenceMode
  ) {
    errors.push(`derived mode exceeds evidence (${evidenceMode})`);
  }

  return { errors, profile, valid: errors.length === 0 };
}

export async function loadHostProfile(
  pluginData: string,
  constraints: ProfileConstraints = {},
  explicitProfilePath?: string,
): Promise<ProfileValidation> {
  let profileId: string;
  let profilePath: string;
  try {
    if (explicitProfilePath) {
      profilePath = explicitProfilePath;
      profileId = path.basename(path.dirname(profilePath));
    } else {
      const active = JSON.parse(
        (
          await readLimited(
            path.join(pluginData, ACTIVE_HOST_PROFILE_FILENAME),
            16_384,
          )
        ).toString("utf8"),
      ) as unknown;
      if (
        !active ||
        typeof active !== "object" ||
        (active as { schemaVersion?: unknown }).schemaVersion !== 1 ||
        !safeProfileId((active as { profileId?: unknown }).profileId)
      ) {
        throw new Error("invalid active profile selection");
      }
      profileId = (active as { profileId: string }).profileId;
      profilePath = path.join(
        profileDirectory(pluginData, profileId),
        HOST_PROFILE_FILENAME,
      );
    }
  } catch (error) {
    return {
      errors: [
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "host profile not found"
          : "host profile selection is unreadable",
      ],
      valid: false,
    };
  }

  try {
    if (!safeProfileId(profileId))
      throw new Error("unsafe host profile identifier");
    const [rawProfile, rawManifest] = await Promise.all([
      readLimited(profilePath, 1_048_576),
      readLimited(
        path.join(path.dirname(profilePath), HOST_PROFILE_MANIFEST_FILENAME),
        16_384,
      ),
    ]);
    const manifest = JSON.parse(rawManifest.toString("utf8")) as unknown;
    if (
      !manifest ||
      typeof manifest !== "object" ||
      (manifest as { schemaVersion?: unknown }).schemaVersion !== 1 ||
      (manifest as { profileId?: unknown }).profileId !== profileId ||
      (manifest as { profileSha256?: unknown }).profileSha256 !==
        sha256(rawProfile)
    ) {
      throw new Error("profile integrity mismatch");
    }
    const value: unknown = JSON.parse(rawProfile.toString("utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      (value as { profileId?: unknown }).profileId !== profileId
    ) {
      throw new Error("profile identifier mismatch");
    }
    return validateHostProfile(value, constraints);
  } catch {
    return {
      errors: ["host profile integrity check failed"],
      valid: false,
    };
  }
}

export async function writeHostProfile(
  pluginData: string,
  input: unknown,
): Promise<HostProfile> {
  const validation = validateHostProfile(input);
  if (!validation.valid || !validation.profile) {
    throw new Error(`invalid host profile: ${validation.errors.join("; ")}`);
  }
  const profile = validation.profile;
  if (!safeProfileId(profile.profileId))
    throw new Error("unsafe host profile identifier");
  const directory = profileDirectory(pluginData, profile.profileId);
  const traces = path.join(directory, "sanitized-traces");
  await mkdir(traces, { recursive: true, mode: 0o700 });
  await Promise.all([
    chmod(pluginData, 0o700),
    chmod(path.join(pluginData, HOSTS_DIRECTORY), 0o700),
    chmod(directory, 0o700),
    chmod(traces, 0o700),
  ]);

  const serialized = `${JSON.stringify(profile, null, 2)}\n`;
  await writePrivate(path.join(directory, HOST_PROFILE_FILENAME), serialized);
  await writePrivate(
    path.join(directory, HOST_PROFILE_MANIFEST_FILENAME),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        profileId: profile.profileId,
        profileSha256: sha256(serialized),
      },
      null,
      2,
    )}\n`,
  );
  await writePrivate(
    path.join(pluginData, ACTIVE_HOST_PROFILE_FILENAME),
    `${JSON.stringify({ schemaVersion: 1, profileId: profile.profileId })}\n`,
  );
  return profile;
}
