import {
  type ChromeTabView,
  type HandoffChromeApi,
  type PresentedSameTab,
  presentSameTab,
  restoreSameTab,
} from "./presenter.js";

const BUILD_HASH = /^[a-f0-9]{64}$/;
const EXTENSION_ID = /^[a-p]{32}$/;
const VERSION = /^[0-9]+(?:\.[0-9]+){0,3}$/;
const CONTROLLED_FIXTURE =
  /^http:\/\/(?:127\.0\.0\.1|localhost):4173\/(?:index\.html)?(?:\?reset=[a-f0-9]{64})?$/;

export interface SameTabProbeTarget extends ChromeTabView {
  readonly url?: string;
  readonly pendingUrl?: string;
}

export interface SameTabProbeMetadata {
  readonly browserVersion: string;
  readonly buildHash: string;
  readonly extensionId: string;
  readonly extensionVersion: string;
  readonly platform: "macOS" | "UNSUPPORTED";
  readonly recordedAt: number;
}

export type SameTabProbeResult = Readonly<{
  schemaVersion: 1;
  probe: "CHROME_SAME_TAB_PRIMITIVE";
  authority: "FIXTURE_ONLY_NON_AUTHORIZING";
  status: "FAILED" | "PASSED" | "REJECTED";
  reason:
    | "FIXTURE_NAVIGATED"
    | "INVALID_METADATA"
    | "NONE"
    | "PRESENTATION_FAILED"
    | "RESTORE_FAILED"
    | "TAB_IDENTITY_CHANGED"
    | "TARGET_CHANGED"
    | "UNCONTROLLED_TARGET"
    | "UNSUPPORTED_PLATFORM";
  chromeTabObjectContinuity: "FAILED" | "NOT_RUN" | "PASSED";
  fixtureUrlStable: "FAILED" | "NOT_RUN" | "PASSED";
  documentBinding: "UNKNOWN";
  surface: "DETACHED_REAL_TAB_WINDOW" | "FOCUSED_REAL_TAB" | "NONE";
  restoration: "NOT_RUN" | "RESTORED" | "RETAINED";
  hostNativeActionFence: "UNAVAILABLE";
  hostTabRouteBinding: "UNKNOWN";
  handoff: "INACTIVE";
  capabilityEffect: "NONE";
  browserVersion: string;
  buildHash: string;
  extensionId: string;
  extensionVersion: string;
  platform: "macOS" | "UNSUPPORTED";
  recordedAt: number;
}>;

type ProbeTabBinding = Readonly<{
  id: number;
  url: string;
  windowId: number;
  index: number;
  active: boolean;
  pinned: boolean;
  groupId: number;
  incognito: boolean;
}>;

const fixedResult = (
  metadata: SameTabProbeMetadata,
  result: Pick<
    SameTabProbeResult,
    | "chromeTabObjectContinuity"
    | "fixtureUrlStable"
    | "reason"
    | "restoration"
    | "status"
    | "surface"
  >,
): SameTabProbeResult => {
  const sanitized = {
    browserVersion: VERSION.test(metadata.browserVersion)
      ? metadata.browserVersion
      : "UNKNOWN",
    buildHash: BUILD_HASH.test(metadata.buildHash)
      ? metadata.buildHash
      : "UNKNOWN",
    extensionId: EXTENSION_ID.test(metadata.extensionId)
      ? metadata.extensionId
      : "UNKNOWN",
    extensionVersion: VERSION.test(metadata.extensionVersion)
      ? metadata.extensionVersion
      : "UNKNOWN",
    platform: metadata.platform === "macOS" ? "macOS" : "UNSUPPORTED",
    recordedAt:
      Number.isSafeInteger(metadata.recordedAt) && metadata.recordedAt >= 0
        ? metadata.recordedAt
        : 0,
  } as const;
  return {
    schemaVersion: 1,
    probe: "CHROME_SAME_TAB_PRIMITIVE",
    authority: "FIXTURE_ONLY_NON_AUTHORIZING",
    ...result,
    documentBinding: "UNKNOWN",
    hostNativeActionFence: "UNAVAILABLE",
    hostTabRouteBinding: "UNKNOWN",
    handoff: "INACTIVE",
    capabilityEffect: "NONE",
    ...sanitized,
  };
};

function validMetadata(value: SameTabProbeMetadata): boolean {
  return (
    VERSION.test(value.browserVersion) &&
    BUILD_HASH.test(value.buildHash) &&
    EXTENSION_ID.test(value.extensionId) &&
    VERSION.test(value.extensionVersion) &&
    ["macOS", "UNSUPPORTED"].includes(value.platform) &&
    Number.isSafeInteger(value.recordedAt) &&
    value.recordedAt >= 0
  );
}

function controlledFixtureUrl(value: string | undefined): value is string {
  if (!value || !CONTROLLED_FIXTURE.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

function tabBinding(value: ChromeTabView): ProbeTabBinding | undefined {
  const tab = value as SameTabProbeTarget;
  if (
    !Number.isSafeInteger(tab.id) ||
    (tab.id ?? -1) < 0 ||
    !Number.isSafeInteger(tab.windowId) ||
    tab.windowId < 0 ||
    !Number.isSafeInteger(tab.index) ||
    tab.index < 0 ||
    typeof tab.active !== "boolean" ||
    typeof tab.pinned !== "boolean" ||
    !Number.isSafeInteger(tab.groupId) ||
    tab.groupId < -1 ||
    typeof tab.incognito !== "boolean" ||
    !controlledFixtureUrl(tab.url) ||
    tab.pendingUrl !== undefined
  ) {
    return undefined;
  }
  return {
    id: tab.id as number,
    url: tab.url,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    groupId: tab.groupId,
    incognito: tab.incognito,
  };
}

function sameBinding(left: ProbeTabBinding, right: ProbeTabBinding): boolean {
  return (
    left.id === right.id &&
    left.url === right.url &&
    left.windowId === right.windowId &&
    left.index === right.index &&
    left.active === right.active &&
    left.pinned === right.pinned &&
    left.groupId === right.groupId &&
    left.incognito === right.incognito
  );
}

function expectedDetach(
  current: ProbeTabBinding,
  previous: ProbeTabBinding,
  createdWindowId: number | undefined,
): boolean {
  return (
    current.id === previous.id &&
    current.url === previous.url &&
    current.windowId !== previous.windowId &&
    current.index === 0 &&
    current.active === true &&
    current.pinned === previous.pinned &&
    current.groupId === previous.groupId &&
    current.incognito === previous.incognito &&
    (createdWindowId === undefined || current.windowId === createdWindowId)
  );
}

function validTarget(value: SameTabProbeTarget): ProbeTabBinding | undefined {
  const binding = tabBinding(value);
  return binding?.active === true && binding.incognito === false
    ? binding
    : undefined;
}

interface TabMonitor {
  api: HandoffChromeApi;
  continuity: () => boolean;
  urlStable: () => boolean;
  targetStable: () => boolean;
  mutationAttempted: () => boolean;
  recoverPartialPresentation: () => Promise<PresentedSameTab | undefined>;
  observeFinal: () => Promise<void>;
  failureReason: () => SameTabProbeResult["reason"];
}

function monitorTarget(
  api: HandoffChromeApi,
  baseline: ProbeTabBinding,
): TabMonitor {
  let continuity = true;
  let urlStable = true;
  let targetStable = true;
  let firstGet = true;
  let mutationAttempted = false;
  let detachAttempted = false;
  let allowDetachedObservation = false;
  let createdWindowId: number | undefined;
  let last = baseline;

  const observe = (tab: ChromeTabView): ProbeTabBinding | undefined => {
    const target = tab as SameTabProbeTarget;
    continuity &&= target.id === baseline.id;
    urlStable &&=
      target.url === baseline.url && target.pendingUrl === undefined;
    const binding = tabBinding(tab);
    if (!binding) targetStable = false;
    return binding;
  };

  const acceptGet = (binding: ProbeTabBinding | undefined): boolean => {
    if (!binding) return false;
    if (firstGet) {
      firstGet = false;
      return sameBinding(binding, baseline);
    }
    if (sameBinding(binding, last)) {
      allowDetachedObservation = false;
      return true;
    }
    if (
      allowDetachedObservation &&
      expectedDetach(binding, last, createdWindowId)
    ) {
      allowDetachedObservation = false;
      return true;
    }
    return false;
  };

  const preflight = async (expected: ProbeTabBinding) => {
    const binding = observe(await api.tabs.get(baseline.id));
    if (!binding || !sameBinding(binding, expected)) {
      targetStable = false;
      throw new Error("controlled fixture changed before Chrome mutation");
    }
    last = binding;
  };

  const monitoredApi: HandoffChromeApi = {
    tabs: {
      get: async (tabId) => {
        if (tabId !== baseline.id) {
          continuity = false;
          throw new Error("probe tab identity changed");
        }
        const tab = await api.tabs.get(tabId);
        const binding = observe(tab);
        if (!acceptGet(binding)) {
          targetStable = false;
          throw new Error("controlled fixture changed before probe");
        }
        last = binding as ProbeTabBinding;
        return tab;
      },
      update: async (tabId, properties) => {
        if (tabId !== baseline.id) {
          continuity = false;
          throw new Error("probe tab identity changed");
        }
        await preflight(last);
        mutationAttempted = true;
        const updated = await api.tabs.update(tabId, properties);
        const binding = observe(updated);
        if (!binding) throw new Error("fixture changed during focus");
        last = binding;
        return updated;
      },
      move: async (tabId, properties) => {
        if (tabId !== baseline.id) {
          continuity = false;
          throw new Error("probe tab identity changed");
        }
        await preflight(last);
        mutationAttempted = true;
        try {
          const moved = await api.tabs.move(tabId, properties);
          const tabs = Array.isArray(moved) ? moved : [moved as ChromeTabView];
          for (const tab of tabs) {
            const binding = observe(tab);
            if (!binding) throw new Error("fixture changed during move");
            last = binding;
          }
          return moved;
        } catch (error) {
          try {
            const binding = observe(await api.tabs.get(tabId));
            if (
              binding &&
              binding.windowId === properties.windowId &&
              binding.index === properties.index &&
              binding.id === last.id &&
              binding.url === last.url &&
              binding.active === last.active &&
              binding.pinned === last.pinned &&
              binding.groupId === last.groupId &&
              binding.incognito === last.incognito
            ) {
              last = binding;
            }
          } catch {
            // The caller will conservatively report RETAINED.
          }
          throw error;
        }
      },
    },
    windows: {
      get: api.windows.get.bind(api.windows),
      create: async (properties) => {
        if (properties.tabId !== baseline.id) {
          continuity = false;
          throw new Error("probe tab identity changed");
        }
        await preflight(last);
        mutationAttempted = true;
        detachAttempted = true;
        allowDetachedObservation = true;
        const created = await api.windows.create(properties);
        if (
          created?.id !== undefined &&
          Number.isSafeInteger(created.id) &&
          created.id >= 0
        ) {
          createdWindowId = created.id;
        }
        return created;
      },
      update: async (windowId, properties) => {
        await preflight(last);
        if (windowId !== last.windowId) {
          targetStable = false;
          throw new Error("probe window identity changed");
        }
        mutationAttempted = true;
        return api.windows.update(windowId, properties);
      },
    },
  };

  const placement = {
    tabId: baseline.id,
    originalWindowId: baseline.windowId,
    originalIndex: baseline.index,
    wasActive: baseline.active,
    wasPinned: baseline.pinned,
    ...(baseline.groupId >= 0 ? { originalGroupId: baseline.groupId } : {}),
  } as const;

  return {
    api: monitoredApi,
    continuity: () => continuity,
    urlStable: () => urlStable,
    targetStable: () => targetStable,
    mutationAttempted: () => mutationAttempted,
    recoverPartialPresentation: async () => {
      if (!mutationAttempted) return undefined;
      let current: ProbeTabBinding | undefined;
      try {
        current = observe(await api.tabs.get(baseline.id));
      } catch {
        return undefined;
      }
      if (!current) return undefined;
      if (sameBinding(current, baseline)) {
        last = current;
        allowDetachedObservation = false;
        return {
          status: "PRESENTED",
          surface: "FOCUSED_REAL_TAB",
          placement,
          presentedWindowId: current.windowId,
          presentedIndex: current.index,
        };
      }
      if (
        !detachAttempted ||
        !allowDetachedObservation ||
        !expectedDetach(current, last, createdWindowId)
      ) {
        targetStable = false;
        return undefined;
      }
      last = current;
      allowDetachedObservation = false;
      return {
        status: "PRESENTED",
        surface: "DETACHED_REAL_TAB_WINDOW",
        placement,
        presentedWindowId: current.windowId,
        presentedIndex: current.index,
      };
    },
    observeFinal: async () => {
      try {
        observe(await api.tabs.get(baseline.id));
      } catch {
        targetStable = false;
      }
    },
    failureReason: () =>
      !continuity
        ? "TAB_IDENTITY_CHANGED"
        : !urlStable
          ? "FIXTURE_NAVIGATED"
          : !targetStable
            ? "TARGET_CHANGED"
            : "PRESENTATION_FAILED",
  };
}

/**
 * Explicit Chrome primitive probe only. It never activates Handoff, mints a
 * receipt, navigates, clones a tab, or accepts a target from an Agent/page.
 */
export async function runSameTabProbe(
  api: HandoffChromeApi,
  target: SameTabProbeTarget,
  metadata: SameTabProbeMetadata,
): Promise<SameTabProbeResult> {
  const notRun = {
    chromeTabObjectContinuity: "NOT_RUN",
    fixtureUrlStable: "NOT_RUN",
    restoration: "NOT_RUN",
    surface: "NONE",
  } as const;
  if (!validMetadata(metadata)) {
    return fixedResult(metadata, {
      ...notRun,
      status: "REJECTED",
      reason: "INVALID_METADATA",
    });
  }
  if (metadata.platform !== "macOS") {
    return fixedResult(metadata, {
      ...notRun,
      status: "REJECTED",
      reason: "UNSUPPORTED_PLATFORM",
    });
  }
  const baseline = validTarget(target);
  if (!baseline) {
    return fixedResult(metadata, {
      ...notRun,
      status: "REJECTED",
      reason: "UNCONTROLLED_TARGET",
    });
  }

  const monitor = monitorTarget(api, baseline);
  let presentation: PresentedSameTab | undefined;
  let presentationFailed = false;
  let restoration: SameTabProbeResult["restoration"] = "NOT_RUN";
  try {
    const presented = await presentSameTab(monitor.api, {
      holder: "USER",
      state: "ACTIVE",
      scope: { tabId: baseline.id },
    });
    if (presented.status !== "PRESENTED") throw new Error("not presented");
    presentation = presented;
  } catch {
    presentationFailed = true;
    presentation = await monitor
      .recoverPartialPresentation()
      .catch(() => undefined);
    if (!presentation && monitor.mutationAttempted()) restoration = "RETAINED";
  } finally {
    if (presentation) {
      const restored = await restoreSameTab(monitor.api, presentation).catch(
        () => undefined,
      );
      restoration = restored?.status ?? "RETAINED";
    }
    if (monitor.mutationAttempted()) await monitor.observeFinal();
  }

  const continuity = monitor.continuity();
  const urlStable = monitor.urlStable();
  if (presentationFailed) {
    return fixedResult(metadata, {
      chromeTabObjectContinuity: continuity ? "PASSED" : "FAILED",
      fixtureUrlStable: urlStable ? "PASSED" : "FAILED",
      restoration,
      surface:
        presentation?.surface === "DETACHED_REAL_TAB_WINDOW"
          ? presentation.surface
          : "NONE",
      status: "FAILED",
      reason: monitor.failureReason(),
    });
  }

  const targetStable = monitor.targetStable();
  const restored = restoration === "RESTORED";
  return fixedResult(metadata, {
    chromeTabObjectContinuity: continuity ? "PASSED" : "FAILED",
    fixtureUrlStable: urlStable ? "PASSED" : "FAILED",
    surface: presentation?.surface ?? "NONE",
    restoration,
    status:
      continuity && urlStable && targetStable && restored ? "PASSED" : "FAILED",
    reason: !continuity
      ? "TAB_IDENTITY_CHANGED"
      : !urlStable
        ? "FIXTURE_NAVIGATED"
        : !targetStable
          ? "TARGET_CHANGED"
          : !restored
            ? "RESTORE_FAILED"
            : "NONE",
  });
}
