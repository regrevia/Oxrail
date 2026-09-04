import { access, readFile } from "node:fs/promises";
import path from "node:path";

import {
  SetupVerificationSchema,
  type HandoffCapability,
  type HostProfile,
  type ProbeVerdict,
  type SetupVerification,
} from "../../protocol/src/index.js";
import { hookDefinitionHash } from "./hook.js";
import { loadHostProfile, writeHostProfile } from "./profile.js";
import {
  digestSessionId,
  HOOK_EVENTS,
  markerMatches,
  readHookMarker,
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
}

export type HarmlessSyntheticProbe = (request: {
  profileId: string;
  toolMatchers: readonly string[];
}) => Promise<SyntheticProbeResult>;

export interface DoctorOptions {
  browserPath?: HostProfile["identity"]["browserPath"];
  currentIdentity?: HostProfile["identity"];
  now?: () => number;
  persistProfile?: typeof writeHostProfile;
  pluginData: string;
  pluginRoot: string;
  sessionId?: string;
  surface?: HostProfile["identity"]["surface"];
  syntheticProbe?: HarmlessSyntheticProbe;
}

export type DoctorReport = SetupVerification & {
  handoffInactiveReasons: string[];
  notices: string[];
  profileErrors: string[];
  profileId?: string;
  safetyInactiveReasons: string[];
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
  const [
    genericPreMarker,
    genericPostMarker,
    browserPreMarker,
    browserPostMarker,
  ] = await Promise.all([
    readHookMarker(pluginData, "PreToolUse"),
    readHookMarker(pluginData, "PostToolUse"),
    readHookMarker(pluginData, "PreToolUse", true),
    readHookMarker(pluginData, "PostToolUse", true),
  ]);
  const [browserPre, browserPost] = await Promise.all([
    markerMatches(pluginData, "PreToolUse", definitionHash, {
      ...current,
      browserHook: true,
    }),
    markerMatches(pluginData, "PostToolUse", definitionHash, {
      ...current,
      browserHook: true,
    }),
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
  const persistedBrowserRoute = Boolean(
    profileId &&
      browserPreMarker &&
      browserPostMarker &&
      browserPreMarker.definitionHash === definitionHash &&
      browserPostMarker.definitionHash === definitionHash &&
      browserPreMarker.profileId === profileId &&
      browserPostMarker.profileId === profileId &&
      browserPreMarker.synthetic === browserPostMarker.synthetic &&
      sameSession([browserPreMarker, browserPostMarker]),
  );
  return {
    browserPost,
    browserPre,
    browserSessionBound: sameSession([browserPreMarker, browserPostMarker]),
    generic,
    genericSessionBound: sameSession([genericPreMarker, genericPostMarker]),
    persistedBrowserRoute,
    persistedSyntheticBrowser:
      persistedBrowserRoute && browserPreMarker?.synthetic === true,
    syntheticBrowser:
      browserPre &&
      browserPost &&
      sameSession([browserPreMarker, browserPostMarker]) &&
      browserPreMarker?.synthetic === true &&
      browserPostMarker?.synthetic === true,
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
        result.preToolUse
      ) {
        await recordHookMarker(
          options.pluginData,
          {
            ...common,
            browserHook: true,
            event: "PreToolUse",
          },
          now,
        );
      }
      if (
        result.chromeComputerUse &&
        result.matcherMatched &&
        result.postToolUse
      ) {
        await recordHookMarker(
          options.pluginData,
          {
            ...common,
            browserHook: true,
            event: "PostToolUse",
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
  const chromeComputerUseDetectable: ProbeVerdict =
    profileResult.valid && profile
      ? profile.identity.browserPath === "chrome-extension" &&
        Boolean(profile.identity.computerUsePluginVersion)
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
  const currentIdentity = Boolean(
    profile && matchesCurrentIdentity(profile, options.currentIdentity),
  );
  // v0.1-alpha only verifies the passive route. No runtime enforcement or
  // Handoff adapter is connected, so evidence profiles cannot activate claims.
  const resultingMode = configured ? "ADVISORY_ONLY" : "UNSUPPORTED";
  const optimization = "BYPASSED";
  const safetyProtectionActive = false;
  const handoffProtectionActive = false;
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
    matcherProfileValid: profileResult.valid,
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
        matcherProfileValid: "passed",
        syntheticProbe: verification.syntheticProbeUsed
          ? "passed"
          : profile.setup.syntheticProbe,
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
      derived: {
        ...profile.derived,
        mode: verification.resultingMode,
        safety: verification.safetyProtectionActive ? "ACTIVE" : "INACTIVE",
        handoff: verification.handoffProtectionActive ? "ACTIVE" : "INACTIVE",
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
    handoffInactiveReasons: reportedHandoffReasons,
    notices,
    profileErrors: profileResult.errors,
    safetyInactiveReasons: reportedSafetyReasons,
    ...(profile ? { profileId: profile.profileId } : {}),
  };
}

const verdict = (value: boolean | ProbeVerdict) =>
  typeof value === "boolean" ? (value ? "PASS" : "FAIL") : value.toUpperCase();

export function formatDoctorReport(report: DoctorReport): string {
  return [
    `Oxrail setup: ${report.stage}`,
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
    `Handoff surface: ${report.handoffCapability.surface}`,
    `Handoff lease: ${report.handoffCapability.lease}`,
    `Handoff resume: ${report.handoffCapability.resume}`,
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
  ].join("\n");
}
