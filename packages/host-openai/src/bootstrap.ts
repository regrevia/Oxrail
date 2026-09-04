import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import {
  HostProfileSchema,
  NativePrimitiveSchema,
  deterministicDigest,
  type HostProfile,
} from "../../protocol/src/index.js";
import { z } from "zod";

import { hookDefinitionHash } from "./hook.js";
import { writeHostProfile } from "./profile.js";

const exactToolName = z
  .string()
  .min(1)
  .max(256)
  .regex(
    /^[A-Za-z0-9_.:/-]+$/,
    "expected an exact tool name, not a matcher expression",
  );

export const HostInventorySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    source: z.literal("host-tool-inventory"),
    capturedAt: z.string().datetime(),
    surface: z.enum([
      "chatgpt-chat",
      "chatgpt-work",
      "codex-desktop",
      "codex-cli",
    ]),
    hostBuild: z.string().min(1).max(256),
    codexVersion: z.string().min(1).max(256).optional(),
    computerUsePluginVersion: z.string().min(1).max(256),
    browserPath: z.enum([
      "chrome-extension",
      "built-in-browser",
      "other-browser-extension",
    ]),
    os: z.enum(["macos", "windows", "linux", "unknown"]),
    toolRoute: z.enum([
      "direct-mcp",
      "code-mode-nested-mcp",
      "outer-transaction",
      "script-wrapper",
      "local-function",
      "specialized",
      "opaque",
    ]),
    browserToolNames: z.array(exactToolName).min(1).max(32),
  })
  .superRefine((inventory, context) => {
    if (
      new Set(inventory.browserToolNames).size !==
      inventory.browserToolNames.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["browserToolNames"],
        message: "browser tool names must be unique",
      });
    }
  });

export type HostInventory = z.infer<typeof HostInventorySchema>;

const unknownPrimitives = () =>
  Object.fromEntries(
    NativePrimitiveSchema.options.map((primitive) => [primitive, "unknown"]),
  );

export interface BootstrapOptions {
  inventoryPath: string;
  pluginData: string;
  pluginRoot: string;
}

export async function readHostInventory(inventoryPath: string): Promise<{
  inventory: HostInventory;
  sha256: string;
}> {
  const raw = await readFile(inventoryPath);
  if (raw.length > 1_048_576) throw new Error("host inventory exceeds 1 MiB");
  return {
    inventory: HostInventorySchema.parse(JSON.parse(raw.toString("utf8"))),
    sha256: createHash("sha256").update(raw).digest("hex"),
  };
}

export async function bootstrapHostProfile(
  options: BootstrapOptions,
): Promise<HostProfile> {
  const { inventory, sha256: traceManifestHash } = await readHostInventory(
    options.inventoryPath,
  );
  const definitionHash = await hookDefinitionHash(options.pluginRoot);
  const matcherEvidenceHash = deterministicDigest(
    "oxrail-host-inventory-matchers-v1",
    {
      browserPath: inventory.browserPath,
      browserToolNames: inventory.browserToolNames,
      codexVersion: inventory.codexVersion,
      computerUsePluginVersion: inventory.computerUsePluginVersion,
      hostBuild: inventory.hostBuild,
      os: inventory.os,
      surface: inventory.surface,
      toolRoute: inventory.toolRoute,
    },
  );
  const profileId = `hp_${deterministicDigest("oxrail-host-profile-id-v1", {
    definitionHash,
    matcherEvidenceHash,
  }).slice(0, 24)}`;

  const profile = HostProfileSchema.parse({
    schemaVersion: 3,
    profileId,
    setup: {
      lifecycle: "INSTALLED",
      pluginInstalled: "unknown",
      skillAvailable: "unknown",
      hooksRegistered: "unknown",
      hooksTrusted: "unknown",
      preToolUseAvailable: "unknown",
      postToolUseAvailable: "unknown",
      chromeComputerUseDetectable: "passed",
      matcherProfileValid: "passed",
      syntheticProbe: "unknown",
      firstBrowserHookSeen: false,
      verificationSource: "none",
      optimization: "BYPASSED",
    },
    identity: {
      surface: inventory.surface,
      hostBuild: inventory.hostBuild,
      ...(inventory.codexVersion
        ? { codexVersion: inventory.codexVersion }
        : {}),
      computerUsePluginVersion: inventory.computerUsePluginVersion,
      browserPath: inventory.browserPath,
      os: inventory.os,
    },
    route: {
      toolRoute: inventory.toolRoute,
      canonicalToolMatchers: inventory.browserToolNames,
      matcherEvidenceHash,
    },
    action: {
      control: "NONE",
      preToolCoverage: {
        observed: 0,
        expected: 0,
        bypassCases: [],
        confidence: "UNKNOWN",
      },
      denyPreventedSideEffect: "unknown",
      rewriteFidelity: "unknown",
    },
    nativeInteraction: {
      fidelity: "UNKNOWN",
      pointerOwnerInRunning: "unknown",
      passThroughFingerprint: "unknown",
      primitiveParity: unknownPrimitives(),
      cursorVisualization: "unknown",
      viewportCoordinateMapping: "unknown",
      screenshotFrameFeedback: "unknown",
      unexpectedPointerInterference: "unknown",
      unexpectedFocusInterference: "unknown",
      unexpectedScrollInterference: "unknown",
      incorrectNormalActionBlocks: "unknown",
      overlayPolicy: "unknown",
    },
    result: {
      postToolCoverage: {
        observed: 0,
        expected: 0,
        bypassCases: [],
        confidence: "UNKNOWN",
      },
      control: "NONE",
      replacementTiming: "unknown",
      media: {
        text: "unknown",
        structured: "unknown",
        image: "unknown",
        error: "unknown",
        attachment: "unknown",
      },
      codeModePromiseSemantics: "unknown",
      controlCriticalContract: {
        status: "unknown",
        requiredFields: [],
        conditionalFields: [],
        unknownFields: ["native-result"],
        testedNextStepPrimitives: [],
      },
      rawPersistence: ["unknown"],
    },
    hooks: {
      policy: "plugin",
      trustState: "unknown",
      definitionHash,
      concurrentConflictProbe: "unknown",
    },
    nativeCapabilities: {
      outputTokenLimit: "unknown",
      webMcp: "unknown",
      structuredObservation: "unknown",
      readOnlyDeveloperTools: "unknown",
      nativeApprovalFlow: "unknown",
    },
    handoff: {
      activation: "INACTIVE",
      inactiveReasons: ["handoff capabilities are not verified"],
      capability: {
        surface: "NONE",
        lease: "NONE",
        resume: "NONE",
        conversationContextPreserved: false,
        sameTabBinding: false,
        originalPlacementRestorable: false,
      },
      conversationContinuity: "unknown",
      sameTabBinding: "unknown",
      detachRealTabWindow: "unknown",
      focusExistingTab: "unknown",
      exclusiveBrowserLease: "unknown",
      noAgentObservationDuringLease: "unknown",
      nonSecretCompletionDetector: "unknown",
      originAndStateVerification: "unknown",
      restoreOriginalWindowIndex: "unknown",
      restorePinnedAndGroupState: "unknown",
      automaticToolOrEventResume: "unknown",
      oneClickFallback: "unknown",
      chatMessageRequired: "unknown",
    },
    evidence: {
      probeSuiteVersion: "bootstrap-v1",
      fixtureRevision: "host-inventory",
      traceManifestHash,
      testedAt: inventory.capturedAt,
      validUntilHostChange: true,
      unresolved: [
        "hook trust and availability",
        "browser route passive verification",
        "native interaction fidelity",
        "safety and handoff",
      ],
    },
    derived: {
      mode: "ADVISORY_ONLY",
      safety: "INACTIVE",
      handoff: "INACTIVE",
      allowedClaims: [
        "exact browser tool candidate loaded for passive verification",
      ],
      forbiddenClaims: [
        "active optimization",
        "active safety protection",
        "active handoff protection",
      ],
    },
  });

  return writeHostProfile(options.pluginData, profile);
}
