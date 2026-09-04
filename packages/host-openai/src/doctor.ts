import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  SetupVerificationSchema,
  type HandoffCapability,
  type HostProfile,
  type ProbeVerdict,
  type SetupVerification,
} from "../../protocol/src/index.js";
import {
  matcherEvidenceHashForInventory,
  type HostInventory,
} from "./bootstrap.js";
import { hookDefinitionHash } from "./hook.js";
import { loadHostProfile, writeHostProfile } from "./profile.js";
import {
  digestSessionId,
  digestToolUseId,
  HOOK_EVENTS,
  HOOK_MARKER_FRESHNESS_MS,
  markerMatches,
  readBrowserRouteObservations,
  readHookMarker,
  recordBrowserHookPhase,
  recordHookMarker,
  type HookEventName,
} from "./state.js";

const inactiveHandoff: HandoffCapability = {
  conversationContextPreserved: false,
  lease: "NONE",
  originalPlacementRestorable: false,
  resume: "NONE",
  sameTabBinding: false,
  surface: "NONE",
};

export interface SyntheticProbeResult {
  chromeComputerUse: boolean;
  matcherMatched: boolean;
  postToolUse: boolean;
  preToolUse: boolean;
  targetRouteEquivalent?: boolean;
}

export type HarmlessSyntheticProbe = (request: {
  profileId: string;
  toolMatchers: readonly string[];
}) => Promise<SyntheticProbeResult>;

export interface DoctorOptions {
  browserPath?: HostProfile["identity"]["browserPath"];
  currentIdentity?: HostProfile["identity"];
  hostInventory?: HostInventory;
  now?: () => number;
  persistProfile?: typeof writeHostProfile;
  pluginData: string;
  pluginRoot: string;
  sessionId?: string;
  surface?: HostProfile["identity"]["surface"];
  syntheticProbe?: HarmlessSyntheticProbe;
}

export type CredentialCheckId =
  | "platform"
  | "helper-identity"
  | "launcher-identity-and-rollback-floor"
  | "hook-trust-root-binding"
  | "sealed-registry-manifest"
  | "template-registry"
  | "consumer-registry-and-real-probe"
  | "keychain-access"
  | "agent-execution-isolation"
  | "pasteboard-hygiene"
  | "opaque-ref-scope-ttl-revocation"
  | "generic-export-denied";

export interface CredentialCheck {
  detail: string;
  id: CredentialCheckId;
  label: string;
  verdict: ProbeVerdict;
}

export type DoctorReport = SetupVerification & {
  credentialChecks: CredentialCheck[];
  credentialInactiveReasons: string[];
  currentIdentityConfirmed: boolean;
  handoffInactiveReasons: string[];
  hookDefinitionHash: string;
  hostIdentity?: HostProfile["identity"];
  notices: string[];
  profileErrors: string[];
  profileFresh: boolean;
  profileId?: string;
  safetyInactiveReasons: string[];
  syntheticProbeVerdict: ProbeVerdict;
};

const exists = (filename: string) =>
  access(filename).then(
    () => true,
    () => false,
  );

async function validPluginManifest(pluginRoot: string): Promise<boolean> {
  try {
    const manifest: unknown = JSON.parse(
      await readFile(
        path.join(pluginRoot, ".codex-plugin", "plugin.json"),
        "utf8",
      ),
    );
    return Boolean(
      manifest &&
        typeof manifest === "object" &&
        (manifest as { name?: unknown }).name === "oxrail",
    );
  } catch {
    return false;
  }
}

async function registeredHookEvents(pluginRoot: string): Promise<Set<string>> {
  try {
    const definition: unknown = JSON.parse(
      await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    );
    if (!definition || typeof definition !== "object") return new Set();
    const hooks = (definition as { hooks?: unknown }).hooks;
    if (!hooks || typeof hooks !== "object") return new Set();
    return new Set(
      HOOK_EVENTS.filter((event) => {
        const groups = (hooks as Record<string, unknown>)[event];
        return (
          Array.isArray(groups) &&
          groups.some(
            (group) =>
              group &&
              typeof group === "object" &&
              Array.isArray((group as { hooks?: unknown }).hooks) &&
              (group as { hooks: unknown[] }).hooks.length > 0,
          )
        );
      }),
    );
  } catch {
    return new Set();
  }
}

async function observe(
  pluginData: string,
  definitionHash: string,
  now: number,
  profileId?: string,
  sessionDigest?: string,
) {
  const current = {
    now,
    ...(profileId ? { profileId } : {}),
    ...(sessionDigest ? { sessionDigest } : {}),
  };
  const generic = Object.fromEntries(
    await Promise.all(
      HOOK_EVENTS.map(async (event) => [
        event,
        await markerMatches(pluginData, event, definitionHash, current),
      ]),
    ),
  ) as Record<HookEventName, boolean>;
  const [genericPreMarker, genericPostMarker, browserMarkers] =
    await Promise.all([
      readHookMarker(pluginData, "PreToolUse"),
      readHookMarker(pluginData, "PostToolUse"),
      readBrowserRouteObservations(pluginData),
    ]);
  const sameSession = (markers: Array<typeof genericPreMarker>) => {
    const digests = markers.flatMap((marker) =>
      marker?.sessionDigest ? [marker.sessionDigest] : [],
    );
    return (
      digests.length === 0 ||
      (digests.length === markers.length && new Set(digests).size === 1)
    );
  };
  const matchingBrowserMarkers = browserMarkers.filter(
    (marker) =>
      marker.definitionHash === definitionHash &&
      (!profileId || marker.profileId === profileId) &&
      (!sessionDigest || marker.sessionDigest === sessionDigest),
  );
  const ageIsCurrent = (observedAt?: string) => {
    const age = now - Date.parse(observedAt ?? "");
    return Number.isFinite(age) && age >= 0 && age <= HOOK_MARKER_FRESHNESS_MS;
  };
  const completedBrowserMarker = matchingBrowserMarkers.find(
    (marker) => marker.preObservedAt && marker.postObservedAt,
  );
  const browserPre = matchingBrowserMarkers.some((marker) =>
    ageIsCurrent(marker.preObservedAt),
  );
  const browserPost = matchingBrowserMarkers.some((marker) =>
    ageIsCurrent(marker.postObservedAt),
  );
  const persistedBrowserRoute = Boolean(completedBrowserMarker);
  return {
    browserPost,
    browserPre,
    generic,
    genericSessionBound: sameSession([genericPreMarker, genericPostMarker]),
    persistedBrowserRoute,
    persistedSyntheticBrowser:
      persistedBrowserRoute && completedBrowserMarker?.synthetic === true,
    syntheticBrowser:
      Boolean(completedBrowserMarker) &&
      completedBrowserMarker?.synthetic === true &&
      ageIsCurrent(completedBrowserMarker.preObservedAt) &&
      ageIsCurrent(completedBrowserMarker.postObservedAt),
  };
}

const matchesCurrentIdentity = (
  profile: HostProfile,
  current: HostProfile["identity"] | undefined,
) =>
  Boolean(
    current &&
      profile.identity.surface === current.surface &&
      profile.identity.hostBuild === current.hostBuild &&
      profile.identity.codexVersion === current.codexVersion &&
      profile.identity.computerUsePluginVersion ===
        current.computerUsePluginVersion &&
      profile.identity.browserPath === current.browserPath &&
      profile.identity.os === current.os,
  );

export async function runDoctor(options: DoctorOptions): Promise<DoctorReport> {
  const now = options.now?.() ?? Date.now();
  const sessionDigest = options.sessionId
    ? digestSessionId(options.sessionId)
    : undefined;
  const [pluginInstalled, skillAvailable, events] = await Promise.all([
    validPluginManifest(options.pluginRoot),
    exists(path.join(options.pluginRoot, "skills", "oxrail", "SKILL.md")),
    registeredHookEvents(options.pluginRoot),
  ]);
  const preRegistered = events.has("PreToolUse");
  const postRegistered = events.has("PostToolUse");
  const hooksRegistered = preRegistered && postRegistered;

  let definitionHash = "";
  try {
    definitionHash = await hookDefinitionHash(options.pluginRoot);
  } catch {
    // Missing definitions are represented by the checks below.
  }

  const requestedBrowserPath =
    options.browserPath ?? options.currentIdentity?.browserPath;
  const requestedSurface = options.surface ?? options.currentIdentity?.surface;
  const profileResult = await loadHostProfile(options.pluginData, {
    ...(requestedBrowserPath ? { browserPath: requestedBrowserPath } : {}),
    ...(options.currentIdentity?.codexVersion
      ? { codexVersion: options.currentIdentity.codexVersion }
      : {}),
    ...(options.currentIdentity?.computerUsePluginVersion
      ? {
          computerUsePluginVersion:
            options.currentIdentity.computerUsePluginVersion,
        }
      : {}),
    ...(definitionHash ? { definitionHash } : {}),
    ...(options.currentIdentity?.hostBuild
      ? { hostBuild: options.currentIdentity.hostBuild }
      : {}),
    ...(options.currentIdentity?.os ? { os: options.currentIdentity.os } : {}),
    ...(requestedSurface ? { surface: requestedSurface } : {}),
    ...(options.hostInventory
      ? {
          canonicalToolMatchers: [
            ...options.hostInventory.browserToolNames,
          ].sort(),
          matcherEvidenceHash: matcherEvidenceHashForInventory(
            options.hostInventory,
          ),
          toolRoute: options.hostInventory.toolRoute,
        }
      : {}),
  });
  const profile = profileResult.profile;
  let observations = await observe(
    options.pluginData,
    definitionHash,
    now,
    profile?.profileId,
    sessionDigest,
  );
  let syntheticProbeUsed = false;
  let syntheticProbeVerdict: ProbeVerdict =
    profile?.setup.syntheticProbe ?? "unknown";

  if (
    options.syntheticProbe &&
    definitionHash &&
    profileResult.valid &&
    profile
  ) {
    syntheticProbeUsed = true;
    try {
      const result = await options.syntheticProbe({
        profileId: profile.profileId,
        toolMatchers: profile.route.canonicalToolMatchers,
      });
      syntheticProbeVerdict =
        result.matcherMatched && result.preToolUse && result.postToolUse
          ? "passed"
          : result.matcherMatched || result.preToolUse || result.postToolUse
            ? "partial"
            : "failed";
      const common = {
        definitionHash,
        profileId: profile.profileId,
        sessionDigest: sessionDigest ?? null,
        synthetic: true,
      };
      if (result.preToolUse) {
        await recordHookMarker(
          options.pluginData,
          {
            ...common,
            browserHook: false,
            event: "PreToolUse",
          },
          now,
        );
      }
      if (result.postToolUse) {
        await recordHookMarker(
          options.pluginData,
          {
            ...common,
            browserHook: false,
            event: "PostToolUse",
          },
          now,
        );
      }
      if (
        result.chromeComputerUse &&
        result.matcherMatched &&
        result.preToolUse &&
        result.postToolUse &&
        result.targetRouteEquivalent === true
      ) {
        await recordBrowserHookPhase(
          options.pluginData,
          "PreToolUse",
          {
            ...common,
            toolUseDigest: digestToolUseId("oxrail-harmless-synthetic-probe"),
          },
          now,
        );
        await recordBrowserHookPhase(
          options.pluginData,
          "PostToolUse",
          {
            ...common,
            toolUseDigest: digestToolUseId("oxrail-harmless-synthetic-probe"),
          },
          now,
        );
      }
      observations = await observe(
        options.pluginData,
        definitionHash,
        now,
        profile.profileId,
        sessionDigest,
      );
    } catch {
      syntheticProbeVerdict = "failed";
      // An unavailable probe leaves setup in its prior fail-open state.
    }
  }

  const profileAllowsHooks = Boolean(
    profile &&
      !["disabled", "managed-only"].includes(profile.hooks.policy) &&
      !["disabled", "skipped"].includes(profile.hooks.trustState),
  );
  const hooksTrusted =
    profileAllowsHooks &&
    Boolean(definitionHash) &&
    (observations.generic.PreToolUse || observations.generic.PostToolUse);
  const currentIdentity = Boolean(
    profile && matchesCurrentIdentity(profile, options.currentIdentity),
  );
  const chromeComputerUseDetectable: ProbeVerdict =
    profileResult.valid && profile && options.currentIdentity
      ? currentIdentity &&
        profile.identity.browserPath === "chrome-extension" &&
        Boolean(profile.identity.computerUsePluginVersion) &&
        ["macos", "windows"].includes(profile.identity.os)
        ? "passed"
        : "unsupported"
      : "unknown";
  const configured =
    pluginInstalled &&
    skillAvailable &&
    hooksRegistered &&
    hooksTrusted &&
    observations.generic.PreToolUse &&
    observations.generic.PostToolUse &&
    observations.genericSessionBound &&
    profileResult.valid &&
    Boolean(options.hostInventory) &&
    currentIdentity &&
    chromeComputerUseDetectable === "passed";
  const priorVerificationSource =
    profile?.setup.lifecycle === "VERIFIED" &&
    (profile.setup.verificationSource === "synthetic-probe"
      ? profile.setup.syntheticProbe === "passed"
      : profile.setup.verificationSource === "passive-first-browser-call" &&
        profile.setup.firstBrowserHookSeen)
      ? profile.setup.verificationSource
      : undefined;
  const observedVerificationSource = observations.persistedBrowserRoute
    ? observations.persistedSyntheticBrowser
      ? "synthetic-probe"
      : "passive-first-browser-call"
    : undefined;
  const routeVerificationSource =
    observedVerificationSource ?? priorVerificationSource;
  const verified = configured && Boolean(routeVerificationSource);
  // v0.1-alpha only verifies the passive route. No runtime enforcement or
  // Handoff adapter is connected, so evidence profiles cannot activate claims.
  const resultingMode = configured ? "ADVISORY_ONLY" : "UNSUPPORTED";
  const optimization = "BYPASSED";
  const safetyProtectionActive = false;
  const handoffProtectionActive = false;
  const credentialProtectionActive = false;
  const credentialOs = options.currentIdentity?.os ?? profile?.identity.os;
  const credentialUnsupported = Boolean(
    credentialOs && credentialOs !== "unknown" && credentialOs !== "macos",
  );
  const credentialInactiveReasons = [
    credentialOs === "macos"
      ? "native macOS attestation verifier unavailable"
      : credentialUnsupported
        ? "Secure Credential Channel is unsupported outside macOS"
        : "current platform identity is unavailable",
  ];
  const credentialUnverifiedVerdict: ProbeVerdict = credentialUnsupported
    ? "unsupported"
    : "unknown";
  const credentialUnverifiedDetail = credentialInactiveReasons[0]!;
  const credentialChecks: CredentialCheck[] = [
    {
      id: "platform",
      label: "macOS platform",
      verdict:
        credentialOs === "macos"
          ? "passed"
          : credentialUnsupported
            ? "unsupported"
            : "unknown",
      detail:
        credentialOs === "macos"
          ? "current Host identity reports macOS"
          : credentialUnverifiedDetail,
    },
    ...(
      [
        ["helper-identity", "helper identity/signature"],
        [
          "launcher-identity-and-rollback-floor",
          "launcher identity and rollback-floor ownership",
        ],
        ["hook-trust-root-binding", "Hook credential trust-root binding"],
        ["sealed-registry-manifest", "sealed registry manifest"],
        ["template-registry", "fixed credential template registry"],
        [
          "consumer-registry-and-real-probe",
          "registered consumer registry and real probe",
        ],
        ["keychain-access", "Keychain entitlement/access"],
        ["agent-execution-isolation", "Agent execution isolation"],
        ["pasteboard-hygiene", "pasteboard hygiene"],
        [
          "opaque-ref-scope-ttl-revocation",
          "opaque ref scope, TTL, generation and revocation",
        ],
        ["generic-export-denied", "generic secret export denied"],
      ] as const
    ).map(([id, label]) => ({
      id,
      label,
      verdict: credentialUnverifiedVerdict,
      detail: credentialUnverifiedDetail,
    })),
  ];
  const safetyInactiveReasons = safetyProtectionActive
    ? []
    : [
        !verified
          ? "browser hook path is not verified"
          : "runtime safety enforcement adapter is not active in this build",
      ];
  const handoffInactiveReasons = handoffProtectionActive
    ? []
    : profile?.handoff.inactiveReasons.length
      ? profile.handoff.inactiveReasons
      : [
          !verified
            ? "browser hook path is not verified"
            : "runtime handoff adapter is not active in this build",
        ];

  const verification = SetupVerificationSchema.parse({
    schemaVersion: 1,
    stage: verified ? "VERIFIED" : configured ? "CONFIGURED" : "INSTALLED",
    pluginInstalled,
    skillAvailable,
    hooksRegistered,
    hooksTrusted,
    preToolUseAvailable: observations.generic.PreToolUse
      ? "passed"
      : preRegistered
        ? "unknown"
        : "unsupported",
    postToolUseAvailable: observations.generic.PostToolUse
      ? "passed"
      : postRegistered
        ? "unknown"
        : "unsupported",
    chromeComputerUseDetectable,
    matcherProfileValid: profileResult.valid && Boolean(options.hostInventory),
    handoffCapability: profile?.handoff.capability ?? inactiveHandoff,
    syntheticProbeUsed:
      syntheticProbeUsed ||
      observations.syntheticBrowser ||
      routeVerificationSource === "synthetic-probe",
    firstBrowserHookSeen:
      Boolean(profile?.setup.firstBrowserHookSeen) ||
      observations.browserPre ||
      observations.browserPost,
    verificationSource: verified ? routeVerificationSource : "none",
    optimization,
    safetyProtectionActive,
    handoffProtectionActive,
    credentialProtectionActive,
    resultingMode,
  });

  const notices: string[] = [];
  notices.push(
    "Package/definition checks are local file-presence checks, not host registry queries.",
    "Current-thread Skill availability is proven only by invoking doctor through the Oxrail Skill.",
  );
  if (verification.stage === "CONFIGURED") {
    notices.push("READY — awaiting first native browser call");
  }
  if (verification.optimization === "BYPASSED") {
    notices.push(
      verification.stage === "CONFIGURED"
        ? "Oxrail optimization: BYPASSED (pending route verification)."
        : "Oxrail optimization unavailable / BYPASSED; native Chrome Computer Use continues.",
    );
  }
  if (!verification.safetyProtectionActive)
    notices.push("Oxrail safety protection is INACTIVE.");
  if (!verification.handoffProtectionActive)
    notices.push("Oxrail handoff protection is INACTIVE.");
  if (!verification.hooksTrusted) {
    notices.push(
      "Review and trust the current Oxrail hook definition in the host UI.",
    );
  } else {
    notices.push(
      "Hook trust is inferred from recent current-hash execution; the host /hooks UI remains authoritative.",
    );
  }
  if (!options.hostInventory) {
    notices.push(
      "Current host route inventory is not confirmed; matcher/profile remains unavailable.",
    );
  }
  if (verification.stage === "VERIFIED" && !currentIdentity) {
    notices.push(
      "Current host version tuple is not confirmed; enforcement capabilities remain BYPASSED/INACTIVE.",
    );
  }

  let reportedVerification = verification;
  let reportedSafetyReasons = safetyInactiveReasons;
  let reportedHandoffReasons = handoffInactiveReasons;
  const preserveVerifiedRoute = Boolean(
    profile?.setup.lifecycle === "VERIFIED" &&
      routeVerificationSource &&
      !configured &&
      pluginInstalled &&
      skillAvailable &&
      hooksRegistered &&
      profileAllowsHooks &&
      chromeComputerUseDetectable === "passed",
  );
  if (profileResult.valid && profile && !preserveVerifiedRoute) {
    const nextProfile: HostProfile = {
      ...profile,
      setup: {
        lifecycle: verification.stage,
        pluginInstalled: verification.pluginInstalled ? "passed" : "failed",
        skillAvailable: verification.skillAvailable ? "passed" : "failed",
        hooksRegistered: verification.hooksRegistered ? "passed" : "failed",
        hooksTrusted: verification.hooksTrusted ? "passed" : "unknown",
        preToolUseAvailable: verification.preToolUseAvailable,
        postToolUseAvailable: verification.postToolUseAvailable,
        chromeComputerUseDetectable: verification.chromeComputerUseDetectable,
        matcherProfileValid: verification.matcherProfileValid
          ? "passed"
          : "failed",
        syntheticProbe: syntheticProbeVerdict,
        firstBrowserHookSeen:
          profile.setup.firstBrowserHookSeen ||
          verification.firstBrowserHookSeen,
        verificationSource: verification.verificationSource,
        optimization: verification.optimization,
      },
      hooks: {
        ...profile.hooks,
        trustState: verification.hooksTrusted
          ? "active"
          : !profileAllowsHooks
            ? profile.hooks.trustState
            : "review-required",
      },
      handoff: {
        ...profile.handoff,
        activation: verification.handoffProtectionActive
          ? "ACTIVE"
          : "INACTIVE",
        inactiveReasons: verification.handoffProtectionActive
          ? []
          : handoffInactiveReasons,
      },
      credentialChannel: {
        ...profile.credentialChannel,
        activation: "INACTIVE",
        inactiveReasons: credentialInactiveReasons,
      },
      derived: {
        ...profile.derived,
        mode: verification.resultingMode,
        safety: verification.safetyProtectionActive ? "ACTIVE" : "INACTIVE",
        handoff: verification.handoffProtectionActive ? "ACTIVE" : "INACTIVE",
        credentialProtection: "INACTIVE",
      },
    };
    try {
      await (options.persistProfile ?? writeHostProfile)(
        options.pluginData,
        nextProfile,
      );
    } catch {
      reportedVerification = SetupVerificationSchema.parse({
        ...verification,
        stage: "INSTALLED",
        verificationSource: "none",
        optimization: "BYPASSED",
        safetyProtectionActive: false,
        handoffProtectionActive: false,
        credentialProtectionActive: false,
        resultingMode: "UNSUPPORTED",
      });
      reportedSafetyReasons = ["setup state could not be persisted"];
      reportedHandoffReasons = ["setup state could not be persisted"];
      notices.push(
        "Oxrail could not persist setup state; protection remains unclaimed.",
      );
    }
  }

  return {
    ...reportedVerification,
    credentialChecks,
    credentialInactiveReasons,
    currentIdentityConfirmed: currentIdentity,
    handoffInactiveReasons: reportedHandoffReasons,
    hookDefinitionHash: definitionHash,
    ...(profile ? { hostIdentity: profile.identity } : {}),
    notices,
    profileErrors: profileResult.errors,
    profileFresh:
      profileResult.valid && Boolean(options.hostInventory) && currentIdentity,
    safetyInactiveReasons: reportedSafetyReasons,
    syntheticProbeVerdict,
    ...(profile ? { profileId: profile.profileId } : {}),
  };
}

const verdict = (value: boolean | ProbeVerdict) =>
  typeof value === "boolean" ? (value ? "PASS" : "FAIL") : value.toUpperCase();

export function formatDoctorReport(report: DoctorReport): string {
  return [
    "Oxrail setup verification",
    `Surface: ${report.hostIdentity?.surface ?? "unknown"}`,
    `Computer Use plugin: ${report.hostIdentity?.computerUsePluginVersion ?? "unknown"}`,
    `Hook definition hash: ${report.hookDefinitionHash || "unknown"}`,
    `Current host identity confirmed: ${verdict(report.currentIdentityConfirmed)}`,
    `Profile fresh: ${verdict(report.profileFresh)}`,
    ...report.notices,
    "",
    `Plugin package manifest present: ${verdict(report.pluginInstalled)}`,
    `Oxrail Skill definition present: ${verdict(report.skillAvailable)}`,
    `Required Hook definitions present: ${verdict(report.hooksRegistered)}`,
    `Hooks trusted (recent execution evidence): ${verdict(report.hooksTrusted)}`,
    `PreToolUse available: ${verdict(report.preToolUseAvailable)}`,
    `PostToolUse available: ${verdict(report.postToolUseAvailable)}`,
    `Chrome Computer Use detectable: ${verdict(report.chromeComputerUseDetectable)}`,
    `Matcher/profile valid: ${verdict(report.matcherProfileValid)}`,
    `Synthetic probe: ${report.syntheticProbeVerdict.toUpperCase()}`,
    `First browser hook seen: ${report.firstBrowserHookSeen ? "YES" : "NO"}`,
    `Verification source: ${report.verificationSource}`,
    `Handoff surface: ${report.handoffCapability.surface}`,
    `Handoff lease: ${report.handoffCapability.lease}`,
    `Handoff resume: ${report.handoffCapability.resume}`,
    `Lifecycle: ${report.stage}`,
    `Oxrail mode: ${report.resultingMode}`,
    `Optimization: ${report.optimization}`,
    `Safety protection: ${
      report.safetyProtectionActive
        ? "ACTIVE"
        : `INACTIVE — ${report.safetyInactiveReasons.join("; ")}`
    }`,
    `Handoff protection: ${
      report.handoffProtectionActive
        ? "ACTIVE"
        : `INACTIVE — ${report.handoffInactiveReasons.join("; ")}`
    }`,
    ...report.credentialChecks.map(
      (check) =>
        `Credential check — ${check.label}: ${check.verdict.toUpperCase()} — ${check.detail}`,
    ),
    `Credential protection: ${
      report.credentialProtectionActive
        ? "ACTIVE"
        : `INACTIVE — ${report.credentialInactiveReasons.join("; ")}`
    }`,
  ].join("\n");
}
