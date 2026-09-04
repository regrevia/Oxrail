import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { deriveHostMode } from "../../core/src/index.js";
import {
  HostProfileSchema,
  type HostProfile,
} from "../../protocol/src/index.js";

export const HOST_PROFILE_FILENAME = "host-profile.json";

export interface ProfileConstraints {
  browserPath?: HostProfile["identity"]["browserPath"];
  codexVersion?: string;
  computerUsePluginVersion?: string;
  definitionHash?: string;
  hostBuild?: string;
  os?: HostProfile["identity"]["os"];
  surface?: HostProfile["identity"]["surface"];
}

export interface ProfileValidation {
  errors: string[];
  profile?: HostProfile;
  valid: boolean;
}

export function validateHostProfile(
  value: unknown,
  constraints: ProfileConstraints = {},
): ProfileValidation {
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
  profilePath = path.join(pluginData, HOST_PROFILE_FILENAME),
): Promise<ProfileValidation> {
  try {
    const value: unknown = JSON.parse(await readFile(profilePath, "utf8"));
    return validateHostProfile(value, constraints);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      errors: [
        code === "ENOENT"
          ? "host profile not found"
          : "host profile is unreadable",
      ],
      valid: false,
    };
  }
}

export async function writeHostProfile(
  pluginData: string,
  input: unknown,
): Promise<HostProfile> {
  const profile = HostProfileSchema.parse(input);
  await mkdir(pluginData, { recursive: true, mode: 0o700 });
  const destination = path.join(pluginData, HOST_PROFILE_FILENAME);
  const temporary = path.join(pluginData, `.host-profile.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(profile, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, destination);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return profile;
}
