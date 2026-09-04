import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HostInventorySchema,
  bootstrapHostProfile,
} from "../packages/host-openai/src/bootstrap.js";
import {
  handleHookEvent,
  runDoctor,
} from "../packages/host-openai/src/index.js";
import {
  loadHostProfile,
  validateHostProfile,
} from "../packages/host-openai/src/profile.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

const inventory = {
  schemaVersion: 1,
  source: "host-tool-inventory",
  capturedAt: "2026-09-04T00:00:00.000Z",
  surface: "codex-desktop",
  hostBuild: "fixture-host",
  codexVersion: "fixture-codex",
  computerUsePluginVersion: "fixture-computer-use",
  browserPath: "chrome-extension",
  os: "linux",
  toolRoute: "direct-mcp",
  browserToolNames: ["fixture.native.browser"],
} as const;

describe("host profile bootstrap", () => {
  it("loads only an exact inventory candidate without claiming trust or protection", async () => {
    const pluginData = await mkdtemp(path.join(tmpdir(), "oxrail-bootstrap-"));
    temporaryDirectories.push(pluginData);
    const inventoryPath = path.join(pluginData, "inventory.json");
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);

    const profile = await bootstrapHostProfile({
      inventoryPath,
      pluginData,
      pluginRoot: process.cwd(),
    });

    expect(profile).toMatchObject({
      setup: { lifecycle: "INSTALLED", optimization: "BYPASSED" },
      hooks: { trustState: "unknown" },
      derived: {
        mode: "ADVISORY_ONLY",
        safety: "INACTIVE",
        handoff: "INACTIVE",
      },
      route: { canonicalToolMatchers: ["fixture.native.browser"] },
    });
    expect(validateHostProfile(profile).valid).toBe(true);
    expect(
      JSON.parse(
        await readFile(path.join(pluginData, "host-profile.json"), "utf8"),
      ),
    ).toEqual(profile);
  });

  it("rejects wildcard, duplicate, and non-inventory matcher input", () => {
    expect(
      HostInventorySchema.safeParse({
        ...inventory,
        browserToolNames: ["fixture.*", "fixture.*"],
      }).success,
    ).toBe(false);
    expect(
      HostInventorySchema.safeParse({
        ...inventory,
        source: "handwritten-guess",
      }).success,
    ).toBe(false);
  });

  it("changes profile identity when a bound host version changes", async () => {
    const pluginData = await mkdtemp(
      path.join(tmpdir(), "oxrail-bootstrap-version-"),
    );
    temporaryDirectories.push(pluginData);
    const inventoryPath = path.join(pluginData, "inventory.json");
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);
    const first = await bootstrapHostProfile({
      inventoryPath,
      pluginData,
      pluginRoot: process.cwd(),
    });
    await writeFile(
      inventoryPath,
      `${JSON.stringify({
        ...inventory,
        computerUsePluginVersion: "fixture-computer-use-next",
      })}\n`,
    );
    const next = await bootstrapHostProfile({
      inventoryPath,
      pluginData,
      pluginRoot: process.cwd(),
    });

    expect(next.profileId).not.toBe(first.profileId);
    expect(next.route.matcherEvidenceHash).not.toBe(
      first.route.matcherEvidenceHash,
    );
  });

  it("advances through current Hook evidence without changing host trust", async () => {
    const pluginData = await mkdtemp(
      path.join(tmpdir(), "oxrail-bootstrap-flow-"),
    );
    temporaryDirectories.push(pluginData);
    const inventoryPath = path.join(pluginData, "inventory.json");
    await writeFile(inventoryPath, `${JSON.stringify(inventory)}\n`);
    await bootstrapHostProfile({
      inventoryPath,
      pluginData,
      pluginRoot: process.cwd(),
    });

    let now = Date.parse("2026-09-04T01:00:00.000Z");
    const environment = {
      now: () => now,
      pluginData,
      pluginRoot: process.cwd(),
    };
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await handleHookEvent(
        {
          hook_event_name,
          session_id: "session-a",
          tool_name: "fixture.safe.probe",
        },
        environment,
      );
    }

    const configured = await runDoctor({
      ...environment,
      sessionId: "session-a",
    });
    expect(configured).toMatchObject({
      stage: "CONFIGURED",
      resultingMode: "ADVISORY_ONLY",
      optimization: "BYPASSED",
      safetyProtectionActive: false,
      handoffProtectionActive: false,
    });
    expect((await loadHostProfile(pluginData)).profile?.setup.lifecycle).toBe(
      "CONFIGURED",
    );

    now += 1;
    for (const hook_event_name of ["PreToolUse", "PostToolUse"] as const) {
      await handleHookEvent(
        {
          hook_event_name,
          session_id: "session-a",
          tool_name: "fixture.native.browser",
        },
        environment,
      );
    }
    const verified = await runDoctor({
      ...environment,
      sessionId: "session-a",
    });
    expect(verified).toMatchObject({
      stage: "VERIFIED",
      firstBrowserHookSeen: true,
      resultingMode: "ADVISORY_ONLY",
      optimization: "BYPASSED",
      safetyProtectionActive: false,
      handoffProtectionActive: false,
    });
    expect((await loadHostProfile(pluginData)).profile?.setup.lifecycle).toBe(
      "VERIFIED",
    );
  });
});
