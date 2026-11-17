import { createHash } from "node:crypto";
import path from "node:path";
import {
  HostProfileSchema,
  NativePrimitiveSchema,
  deterministicDigest,
  type HostProfile,
} from "../../protocol/src/index.js";
import { z } from "zod";

import { hookDefinitionHash } from "./hook.js";
import { readBoundedRegularFile } from "./bounded-file.js";
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
    if (inventory.surface.startsWith("codex-") && !inventory.codexVersion) {
      context.addIssue({
        code: "custom",
        path: ["codexVersion"],
        message: "Codex surfaces require a Codex version",
      });
    }
  });

export type HostInventory = z.infer<typeof HostInventorySchema>;

const canonicalBrowserToolNames = (inventory: HostInventory) =>
  [...inventory.browserToolNames].sort();

export const matcherEvidenceHashForInventory = (
  inventory: HostInventory,
): string =>
  deterministicDigest("oxrail-host-inventory-matchers-v1", {
    browserPath: inventory.browserPath,
    browserToolNames: canonicalBrowserToolNames(inventory),
    codexVersion: inventory.codexVersion,
    computerUsePluginVersion: inventory.computerUsePluginVersion,
    hostBuild: inventory.hostBuild,
    os: inventory.os,
    surface: inventory.surface,
    toolRoute: inventory.toolRoute,
  });

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
  const raw = await readBoundedRegularFile(
    inventoryPath,
    1_048_576,
    path.dirname(inventoryPath),
  );
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
  const matcherEvidenceHash = matcherEvidenceHashForInventory(inventory);
  const profileId = `hp_${deterministicDigest("oxrail-host-profile-id-v1", {
    definitionHash,
    matcherEvidenceHash,
  }).slice(0, 24)}`;

  const profile = HostProfileSchema.parse({
    schemaVersion: 5,
    profileId,
    setup: {
      lifecycle: "INSTALLED",
      pluginInstalled: "unknown",
      skillAvailable: "unknown",
      hooksRegistered: "unknown",
      hooksTrusted: "unknown",
      preToolUseAvailable: "unknown",
      postToolUseAvailable: "unknown",
      chromeComputerUseDetectable:
        inventory.browserPath === "chrome-extension" &&
        ["macos", "windows"].includes(inventory.os)
          ? "passed"
          : "unknown",
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
      canonicalToolMatchers: canonicalBrowserToolNames(inventory),
      matcherEvidenceHash,
      browserTools: [],
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
    credentialChannel:
      inventory.os === "macos"
        ? {
            activation: "INACTIVE",
            inactiveReasons: [
              "macOS credential helper and G15 evidence are not verified",
            ],
            capability: {
              platform: "macos",
              surface: "NONE",
              storage: "NONE",
              acceptedKinds: [],
              consumerMode: "NONE",
              consumerReadiness: "UNSUPPORTED",
              opaqueReferenceOnly: false,
              genericSecretExport: "DENIED",
            },
            helperIdentity: "unknown",
            launcherIdentity: "unknown",
            secureInput: "unknown",
            agentExecutionIsolation: "unknown",
            pasteboardHygiene: "unknown",
            registryManifestVerification: "unknown",
            secretLeakBench: "unknown",
            realConsumerProbe: "unknown",
            keychainRoundTrip: "unknown",
            opaqueRefOnly: "unknown",
            scopeBinding: "unknown",
            expiryAndRevocation: "unknown",
            genericExportDenied: "unknown",
          }
        : {
            activation: "INACTIVE",
            inactiveReasons: [
              "Secure Credential Channel is unsupported outside macOS",
            ],
            capability: {
              platform: "unsupported",
              surface: "NONE",
              storage: "NONE",
              acceptedKinds: [],
              consumerMode: "NONE",
              consumerReadiness: "UNSUPPORTED",
              opaqueReferenceOnly: false,
              genericSecretExport: "DENIED",
            },
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
        "macOS credential protection",
      ],
    },
    derived: {
      mode: "ADVISORY_ONLY",
      safety: "INACTIVE",
      handoff: "INACTIVE",
      credentialProtection: "INACTIVE",
      allowedClaims: [
        "exact browser tool candidate loaded for passive verification",
      ],
      forbiddenClaims: [
        "active optimization",
        "active safety protection",
        "active handoff protection",
        "active credential protection",
      ],
    },
  });

  return writeHostProfile(options.pluginData, profile);
}
