import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  toolRegistryManifestBinding,
  type HostProfile,
} from "../packages/protocol/src/index.js";
import {
  TOOL_SCHEMA_REGISTRY_FILENAME,
  loadToolSchemaRegistryBundle,
} from "../packages/host-openai/src/registry-bundle.js";
import {
  ToolSchemaRegistrySchema,
  toolSchemaRegistryHash,
} from "../packages/host-openai/src/guard.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const hex = (character: string) => character.repeat(64);
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const profileId = "hp_registry_fixture";
const definitionHash = hex("b");
const matcherEvidenceHash = hex("a");
const evidenceId = "evidence-fixture-v1";
const canonicalToolName = "fixture.native.browser";
const inputSchemaHash = hex("d");
const registry = ToolSchemaRegistrySchema.parse({
  schemaVersion: 1,
  profileId,
  definitionHash,
  matcherEvidenceHash,
  tools: [
    {
      toolName: canonicalToolName,
      inputSchemaHash,
      route: "direct-mcp",
      granularity: "MICRO_ACTION",
      actionTypePath: ["action"],
      identityPaths: [["axis"]],
      impactByAction: { click: "reversible" },
      defaultImpact: "high-impact",
    },
  ],
});
const registryHash = toolSchemaRegistryHash(registry);
const pinFor = (
  overrides: {
    inputSchemaHash?: string;
    registryHash?: string;
  } = {},
) => {
  const pinnedInputSchemaHash = overrides.inputSchemaHash ?? inputSchemaHash;
  const pinnedRegistryHash = overrides.registryHash ?? registryHash;
  return {
    canonicalToolName,
    inputSchemaHash: pinnedInputSchemaHash,
    registryManifestBinding: toolRegistryManifestBinding({
      profileId,
      definitionHash,
      matcherEvidenceHash,
      toolSchemaRegistryHash: pinnedRegistryHash,
      toolSchemaRegistryEvidenceId: evidenceId,
      canonicalToolName,
      inputSchemaHash: pinnedInputSchemaHash,
    }),
  };
};
const toolPin = pinFor();

function profile(route: Record<string, unknown> = {}): HostProfile {
  return {
    profileId: registry.profileId,
    hooks: { definitionHash: registry.definitionHash },
    route: {
      canonicalToolMatchers: [toolPin.canonicalToolName],
      matcherEvidenceHash: registry.matcherEvidenceHash,
      toolSchemaRegistryHash: registryHash,
      toolSchemaRegistryEvidenceId: evidenceId,
      browserTools: [toolPin],
      ...route,
    },
  } as HostProfile;
}

async function writeBundle(
  activeProfile = profile(),
  registryValue: unknown = registry,
) {
  const pluginData = await mkdtemp(path.join(tmpdir(), "oxrail-registry-"));
  temporaryDirectories.push(pluginData);
  const directory = path.join(pluginData, "hosts", activeProfile.profileId);
  await mkdir(directory, { recursive: true });
  const serializedProfile = `${JSON.stringify(activeProfile, null, 2)}\n`;
  const serializedRegistry = `${JSON.stringify(registryValue, null, 2)}\n`;
  await writeFile(path.join(directory, "profile.json"), serializedProfile);
  await writeFile(
    path.join(directory, TOOL_SCHEMA_REGISTRY_FILENAME),
    serializedRegistry,
  );
  const manifest = {
    schemaVersion: 1,
    profileId: activeProfile.profileId,
    profileSha256: sha256(serializedProfile),
    guard: {
      toolSchemaRegistryFileSha256: sha256(serializedRegistry),
      toolSchemaRegistryHash: activeProfile.route.toolSchemaRegistryHash,
      toolSchemaRegistryEvidenceId:
        activeProfile.route.toolSchemaRegistryEvidenceId,
      browserTools: activeProfile.route.browserTools,
    },
  };
  await writeFile(
    path.join(directory, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return { directory, manifest, pluginData };
}

describe("evidence-bound tool schema registry bundle", () => {
  it("loads only a registry whose file, canonical hash, profile, and tool pins agree", async () => {
    const activeProfile = profile();
    const { pluginData } = await writeBundle(activeProfile);

    await expect(
      loadToolSchemaRegistryBundle(pluginData, activeProfile),
    ).resolves.toEqual({
      status: "VALID",
      registry,
      bindings: {
        [toolPin.canonicalToolName]: {
          expectedInputSchemaHash: toolPin.inputSchemaHash,
          expectedRegistryHash: activeProfile.route.toolSchemaRegistryHash,
        },
      },
    });
  });

  it("fails open when the external bundle is absent", async () => {
    const pluginData = await mkdtemp(path.join(tmpdir(), "oxrail-registry-"));
    temporaryDirectories.push(pluginData);

    await expect(
      loadToolSchemaRegistryBundle(pluginData, profile()),
    ).resolves.toEqual({
      status: "BYPASSED",
      errors: [
        "tool schema registry bundle is missing, unreadable, or exceeds local limits",
      ],
    });
  });

  it("fails open when a bundle file exceeds its local bound", async () => {
    const activeProfile = profile();
    const { directory, pluginData } = await writeBundle(activeProfile);
    await writeFile(
      path.join(directory, TOOL_SCHEMA_REGISTRY_FILENAME),
      "x".repeat(1_048_577),
    );

    await expect(
      loadToolSchemaRegistryBundle(pluginData, activeProfile),
    ).resolves.toMatchObject({ status: "BYPASSED" });
  });

  it.each(["directory", "symlink"] as const)(
    "fails open when a bundle path is a %s rather than a regular file",
    async (kind) => {
      const activeProfile = profile();
      const { directory, pluginData } = await writeBundle(activeProfile);
      const registryPath = path.join(directory, TOOL_SCHEMA_REGISTRY_FILENAME);
      await rm(registryPath);
      if (kind === "directory") await mkdir(registryPath);
      else await symlink(path.join(directory, "profile.json"), registryPath);

      await expect(
        loadToolSchemaRegistryBundle(pluginData, activeProfile),
      ).resolves.toEqual({
        status: "BYPASSED",
        errors: [
          "tool schema registry bundle is missing, unreadable, or exceeds local limits",
        ],
      });
    },
  );

  it("rejects raw file drift before trusting its parsed content", async () => {
    const activeProfile = profile();
    const { directory, pluginData } = await writeBundle(activeProfile);
    await writeFile(
      path.join(directory, TOOL_SCHEMA_REGISTRY_FILENAME),
      `${JSON.stringify({ ...registry, profileId: "hp_drifted" })}\n`,
    );

    await expect(
      loadToolSchemaRegistryBundle(pluginData, activeProfile),
    ).resolves.toEqual({
      status: "BYPASSED",
      errors: ["tool schema registry file hash does not match its manifest"],
    });
  });

  it("rejects profile file drift from its manifest hash", async () => {
    const activeProfile = profile();
    const { directory, pluginData } = await writeBundle(activeProfile);
    await writeFile(
      path.join(directory, "profile.json"),
      `${JSON.stringify(activeProfile)}\n\n`,
    );

    await expect(
      loadToolSchemaRegistryBundle(pluginData, activeProfile),
    ).resolves.toEqual({
      status: "BYPASSED",
      errors: ["Host Profile file hash does not match its manifest"],
    });
  });

  it("rejects a passed profile whose relevant binding differs from disk", async () => {
    const activeProfile = profile();
    const { pluginData } = await writeBundle(activeProfile);
    const driftedProfile = {
      ...activeProfile,
      route: {
        ...activeProfile.route,
        matcherEvidenceHash: hex("c"),
      },
    } as HostProfile;

    await expect(
      loadToolSchemaRegistryBundle(pluginData, driftedProfile),
    ).resolves.toEqual({
      status: "BYPASSED",
      errors: ["stored Host Profile does not match the active profile"],
    });
  });

  it("rejects canonical registry or Host Profile binding drift", async () => {
    const activeProfile = profile();
    const changedRegistry = { ...registry, definitionHash: hex("c") };
    const { directory, manifest, pluginData } = await writeBundle(
      activeProfile,
      changedRegistry,
    );
    const changedSerialized = `${JSON.stringify(changedRegistry, null, 2)}\n`;
    await writeFile(
      path.join(directory, "manifest.json"),
      `${JSON.stringify(
        {
          ...manifest,
          guard: {
            ...manifest.guard,
            toolSchemaRegistryFileSha256: sha256(changedSerialized),
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await loadToolSchemaRegistryBundle(
      pluginData,
      activeProfile,
    );
    expect(result).toEqual({
      status: "BYPASSED",
      errors: [
        "tool schema registry canonical hash does not match its external pin",
      ],
    });
  });

  it.each([
    ["profileId", { ...registry, profileId: "hp_other" }],
    ["definitionHash", { ...registry, definitionHash: hex("c") }],
    ["matcherEvidenceHash", { ...registry, matcherEvidenceHash: hex("c") }],
  ])(
    "rejects registry %s drift from the active profile",
    async (_field, value) => {
      const changedRegistry = ToolSchemaRegistrySchema.parse(value);
      const changedRegistryHash = toolSchemaRegistryHash(changedRegistry);
      const activeProfile = profile({
        toolSchemaRegistryHash: changedRegistryHash,
        browserTools: [pinFor({ registryHash: changedRegistryHash })],
      });
      const { pluginData } = await writeBundle(activeProfile, changedRegistry);

      await expect(
        loadToolSchemaRegistryBundle(pluginData, activeProfile),
      ).resolves.toEqual({
        status: "BYPASSED",
        errors: ["tool schema registry does not match the active Host Profile"],
      });
    },
  );

  it("rejects a missing or drifted canonical tool pin and manifest binding", async () => {
    const activeProfile = profile({
      browserTools: [{ ...toolPin, registryManifestBinding: hex("c") }],
    });
    const { directory, manifest, pluginData } =
      await writeBundle(activeProfile);
    const stored = JSON.parse(
      await readFile(path.join(directory, "manifest.json"), "utf8"),
    ) as typeof manifest;
    stored.guard.browserTools = [toolPin];
    await writeFile(
      path.join(directory, "manifest.json"),
      `${JSON.stringify(stored, null, 2)}\n`,
    );

    await expect(
      loadToolSchemaRegistryBundle(pluginData, activeProfile),
    ).resolves.toEqual({
      status: "BYPASSED",
      errors: ["canonical browser tool pins do not match the manifest"],
    });
  });

  it("rejects an arbitrary manifest binding even when profile and manifest agree", async () => {
    const activeProfile = profile({
      browserTools: [{ ...toolPin, registryManifestBinding: hex("c") }],
    });
    const { pluginData } = await writeBundle(activeProfile);

    await expect(
      loadToolSchemaRegistryBundle(pluginData, activeProfile),
    ).resolves.toEqual({
      status: "BYPASSED",
      errors: ["canonical browser tool registry manifest binding is invalid"],
    });
  });

  it("rejects a per-tool input schema pin that differs from the registry", async () => {
    const activeProfile = profile({
      browserTools: [pinFor({ inputSchemaHash: hex("c") })],
    });
    const { pluginData } = await writeBundle(activeProfile);

    await expect(
      loadToolSchemaRegistryBundle(pluginData, activeProfile),
    ).resolves.toEqual({
      status: "BYPASSED",
      errors: [
        "canonical browser tool registry coverage or schema pin drifted",
      ],
    });
  });
});
