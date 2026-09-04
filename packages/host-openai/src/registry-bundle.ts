import { createHash } from "node:crypto";
import path from "node:path";

import { z } from "zod";

import {
  toolRegistryManifestBinding,
  type HostProfile,
} from "../../protocol/src/index.js";
import {
  type GuardRegistryBinding,
  ToolSchemaRegistrySchema,
  toolSchemaRegistryHash,
} from "./guard.js";
import {
  HOSTS_DIRECTORY,
  HOST_PROFILE_FILENAME,
  HOST_PROFILE_MANIFEST_FILENAME,
} from "./profile.js";
import { readBoundedRegularFile } from "./bounded-file.js";

export const TOOL_SCHEMA_REGISTRY_FILENAME = "tool-schema-registry.json";

const hash = z.string().regex(/^[a-f0-9]{64}$/i);
const safeProfileId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const browserToolPin = z.strictObject({
  canonicalToolName: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9_.:/-]+$/),
  inputSchemaHash: hash,
  registryManifestBinding: hash,
});
const canonicalToolNames = z
  .array(browserToolPin.shape.canonicalToolName)
  .min(1)
  .max(32)
  .refine(
    (names) => new Set(names).size === names.length,
    "canonical browser tool names must be unique",
  );
const browserToolPins = z
  .array(browserToolPin)
  .min(1)
  .max(32)
  .refine(
    (pins) =>
      new Set(pins.map((pin) => pin.canonicalToolName)).size === pins.length,
    "canonical browser tool pins must be unique",
  );
const externalPins = z.strictObject({
  toolSchemaRegistryHash: hash,
  toolSchemaRegistryEvidenceId: z.string().min(1).max(256),
  browserTools: browserToolPins,
});
const activeProfileBinding = externalPins.extend({
  profileId: safeProfileId,
  definitionHash: hash,
  matcherEvidenceHash: hash,
  canonicalToolMatchers: canonicalToolNames,
});
const storedProfileBinding = z.object({
  profileId: safeProfileId,
  hooks: z.object({ definitionHash: hash }),
  route: z.object({
    canonicalToolMatchers: canonicalToolNames,
    matcherEvidenceHash: hash,
    toolSchemaRegistryHash: hash,
    toolSchemaRegistryEvidenceId: z.string().min(1).max(256),
    browserTools: browserToolPins,
  }),
});
const bundleManifest = z.strictObject({
  schemaVersion: z.literal(1),
  profileId: safeProfileId,
  profileSha256: hash,
  guard: z.strictObject({
    toolSchemaRegistryFileSha256: hash,
    toolSchemaRegistryHash: hash,
    toolSchemaRegistryEvidenceId: z.string().min(1).max(256),
    browserTools: browserToolPins,
  }),
});

export type ToolSchemaRegistryBundleLoad =
  | {
      status: "VALID";
      registry: z.infer<typeof ToolSchemaRegistrySchema>;
      bindings: Record<string, GuardRegistryBinding>;
    }
  | { status: "BYPASSED"; errors: string[] };

const bypassed = (error: string): ToolSchemaRegistryBundleLoad => ({
  status: "BYPASSED",
  errors: [error],
});

const sameHash = (left: string, right: string) =>
  left.toLowerCase() === right.toLowerCase();
const pinMap = (
  pins: z.infer<typeof browserToolPins>,
): Map<string, z.infer<typeof browserToolPin>> =>
  new Map(pins.map((pin) => [pin.canonicalToolName, pin]));
const sameNames = (left: readonly string[], right: readonly string[]) =>
  left.length === right.length && left.every((name) => right.includes(name));
const samePins = (
  left: z.infer<typeof browserToolPins>,
  right: z.infer<typeof browserToolPins>,
) => {
  const rightByName = pinMap(right);
  return (
    left.length === rightByName.size &&
    left.every((pin) => {
      const other = rightByName.get(pin.canonicalToolName);
      return (
        !!other &&
        sameHash(pin.inputSchemaHash, other.inputSchemaHash) &&
        sameHash(pin.registryManifestBinding, other.registryManifestBinding)
      );
    })
  );
};

/**
 * Validates local bundle integrity against pins already imported into a Host
 * Profile from accepted Host evidence. VALID only describes this bundle; it
 * does not make the Host VERIFIED/ACTIVE. The local manifest is a drift
 * detector, not a trust root, and this loader never creates or repairs a pin.
 */
export async function loadToolSchemaRegistryBundle(
  pluginData: string,
  profile: HostProfile,
): Promise<ToolSchemaRegistryBundleLoad> {
  let active: z.infer<typeof activeProfileBinding>;
  try {
    active = activeProfileBinding.parse({
      profileId: profile.profileId,
      definitionHash: profile.hooks.definitionHash,
      matcherEvidenceHash: profile.route.matcherEvidenceHash,
      canonicalToolMatchers: profile.route.canonicalToolMatchers,
      toolSchemaRegistryHash: profile.route.toolSchemaRegistryHash,
      toolSchemaRegistryEvidenceId: profile.route.toolSchemaRegistryEvidenceId,
      browserTools: profile.route.browserTools,
    });
  } catch {
    return bypassed("Host Profile has no complete external tool registry pins");
  }
  const directory = path.join(pluginData, HOSTS_DIRECTORY, active.profileId);

  let rawProfile: Buffer;
  let rawRegistry: Buffer;
  let rawManifest: Buffer;
  try {
    [rawProfile, rawRegistry, rawManifest] = await Promise.all([
      readBoundedRegularFile(
        path.join(directory, HOST_PROFILE_FILENAME),
        1_048_576,
        pluginData,
      ),
      readBoundedRegularFile(
        path.join(directory, TOOL_SCHEMA_REGISTRY_FILENAME),
        1_048_576,
        pluginData,
      ),
      readBoundedRegularFile(
        path.join(directory, HOST_PROFILE_MANIFEST_FILENAME),
        16_384,
        pluginData,
      ),
    ]);
  } catch {
    return bypassed(
      "tool schema registry bundle is missing, unreadable, or exceeds local limits",
    );
  }

  let manifestValue: unknown;
  try {
    manifestValue = JSON.parse(rawManifest.toString("utf8"));
  } catch {
    return bypassed("tool schema registry manifest is invalid");
  }
  const parsedManifest = bundleManifest.safeParse(manifestValue);
  if (!parsedManifest.success)
    return bypassed("tool schema registry manifest is invalid");
  const manifest = parsedManifest.data;
  const profileFileHash = createHash("sha256").update(rawProfile).digest("hex");
  if (!sameHash(profileFileHash, manifest.profileSha256)) {
    return bypassed("Host Profile file hash does not match its manifest");
  }
  const fileHash = createHash("sha256").update(rawRegistry).digest("hex");
  if (!sameHash(fileHash, manifest.guard.toolSchemaRegistryFileSha256)) {
    return bypassed(
      "tool schema registry file hash does not match its manifest",
    );
  }

  let storedProfileValue: unknown;
  try {
    storedProfileValue = JSON.parse(rawProfile.toString("utf8"));
  } catch {
    return bypassed("stored Host Profile binding is invalid");
  }
  const parsedStoredProfile =
    storedProfileBinding.safeParse(storedProfileValue);
  if (!parsedStoredProfile.success)
    return bypassed("stored Host Profile binding is invalid");
  const stored = parsedStoredProfile.data;
  if (
    stored.profileId !== active.profileId ||
    !sameHash(stored.hooks.definitionHash, active.definitionHash) ||
    !sameHash(stored.route.matcherEvidenceHash, active.matcherEvidenceHash) ||
    !sameHash(
      stored.route.toolSchemaRegistryHash,
      active.toolSchemaRegistryHash,
    ) ||
    stored.route.toolSchemaRegistryEvidenceId !==
      active.toolSchemaRegistryEvidenceId ||
    !sameNames(
      stored.route.canonicalToolMatchers,
      active.canonicalToolMatchers,
    ) ||
    !samePins(stored.route.browserTools, active.browserTools)
  ) {
    return bypassed("stored Host Profile does not match the active profile");
  }

  if (
    manifest.profileId !== active.profileId ||
    !sameHash(
      manifest.guard.toolSchemaRegistryHash,
      active.toolSchemaRegistryHash,
    ) ||
    manifest.guard.toolSchemaRegistryEvidenceId !==
      active.toolSchemaRegistryEvidenceId
  ) {
    return bypassed(
      "tool schema registry manifest does not match Host evidence pins",
    );
  }

  const profilePins = pinMap(active.browserTools);
  const manifestPins = pinMap(manifest.guard.browserTools);
  if (
    profilePins.size !== manifestPins.size ||
    [...profilePins].some(([name, pin]) => {
      const manifestPin = manifestPins.get(name);
      return (
        !manifestPin ||
        !sameHash(pin.inputSchemaHash, manifestPin.inputSchemaHash) ||
        !sameHash(
          pin.registryManifestBinding,
          manifestPin.registryManifestBinding,
        )
      );
    })
  ) {
    return bypassed("canonical browser tool pins do not match the manifest");
  }
  if (
    active.browserTools.some(
      (pin) =>
        !sameHash(
          pin.registryManifestBinding,
          toolRegistryManifestBinding({
            profileId: active.profileId,
            definitionHash: active.definitionHash,
            matcherEvidenceHash: active.matcherEvidenceHash,
            toolSchemaRegistryHash: active.toolSchemaRegistryHash,
            toolSchemaRegistryEvidenceId: active.toolSchemaRegistryEvidenceId,
            canonicalToolName: pin.canonicalToolName,
            inputSchemaHash: pin.inputSchemaHash,
          }),
        ),
    )
  ) {
    return bypassed(
      "canonical browser tool registry manifest binding is invalid",
    );
  }

  let registryValue: unknown;
  try {
    registryValue = JSON.parse(rawRegistry.toString("utf8"));
  } catch {
    return bypassed("tool schema registry is invalid");
  }
  const parsedRegistry = ToolSchemaRegistrySchema.safeParse(registryValue);
  if (!parsedRegistry.success)
    return bypassed("tool schema registry is invalid");
  const registry = parsedRegistry.data;
  if (
    !sameHash(toolSchemaRegistryHash(registry), active.toolSchemaRegistryHash)
  ) {
    return bypassed(
      "tool schema registry canonical hash does not match its external pin",
    );
  }
  if (
    registry.profileId !== active.profileId ||
    !sameHash(registry.definitionHash, active.definitionHash) ||
    !sameHash(registry.matcherEvidenceHash, active.matcherEvidenceHash)
  ) {
    return bypassed(
      "tool schema registry does not match the active Host Profile",
    );
  }

  const contracts = new Map(
    registry.tools.map((contract) => [contract.toolName, contract]),
  );
  if (
    contracts.size !== profilePins.size ||
    contracts.size !== active.canonicalToolMatchers.length ||
    active.canonicalToolMatchers.some((toolName) => !contracts.has(toolName)) ||
    [...contracts].some(([toolName, contract]) => {
      const pin = profilePins.get(toolName);
      return !pin || !sameHash(contract.inputSchemaHash, pin.inputSchemaHash);
    })
  ) {
    return bypassed(
      "canonical browser tool registry coverage or schema pin drifted",
    );
  }

  return {
    status: "VALID",
    registry,
    bindings: Object.fromEntries(
      [...profilePins].map(([toolName, pin]) => [
        toolName,
        {
          expectedInputSchemaHash: pin.inputSchemaHash.toLowerCase(),
          expectedRegistryHash: active.toolSchemaRegistryHash.toLowerCase(),
        },
      ]),
    ),
  };
}
