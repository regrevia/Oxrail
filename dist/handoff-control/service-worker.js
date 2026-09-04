// packages/handoff-extension/src/presenter.ts
var isId = (value) => Number.isSafeInteger(value) && value >= 0;
function exactTab(tab, tabId) {
  if (tab.id !== tabId || !isId(tab.windowId) || !Number.isSafeInteger(tab.index) || tab.index < 0) {
    throw new Error("Oxrail could not bind the exact existing tab");
  }
  return tab;
}
async function getExactTab(api, tabId) {
  return exactTab(await api.tabs.get(tabId), tabId);
}
function snapshot(tab) {
  return {
    tabId: tab.id,
    originalWindowId: tab.windowId,
    originalIndex: tab.index,
    wasActive: tab.active,
    wasPinned: tab.pinned,
    ...Number.isSafeInteger(tab.groupId) && tab.groupId >= 0 ? { originalGroupId: tab.groupId } : {}
  };
}
function canDetach(tab, window) {
  return window.id === tab.windowId && window.type === "normal" && window.incognito === false && ["normal", "minimized", "maximized"].includes(window.state ?? "") && (window.tabs?.length ?? 0) >= 2 && tab.incognito === false && tab.active === true && tab.pinned === false && tab.groupId === -1;
}
async function focusExistingTab(api, tabId, placement, afterDetachAttempt = false) {
  await getExactTab(api, tabId);
  const focused = exactTab(
    await api.tabs.update(tabId, { active: true }),
    tabId
  );
  await api.windows.update(focused.windowId, { focused: true });
  return {
    status: "PRESENTED",
    surface: afterDetachAttempt && focused.windowId !== placement.originalWindowId ? "DETACHED_REAL_TAB_WINDOW" : "FOCUSED_REAL_TAB",
    placement,
    presentedWindowId: focused.windowId,
    presentedIndex: focused.index
  };
}
async function presentSameTab(api, lease) {
  if (lease.state !== "ACTIVE" || lease.holder !== "USER") {
    return { status: "INACTIVE", reason: "USER_LEASE_INACTIVE" };
  }
  const tabId = lease.scope.tabId;
  if (!isId(tabId)) {
    throw new TypeError("lease tabId must be a non-negative safe integer");
  }
  const originalTab = await getExactTab(api, tabId);
  const placement = snapshot(originalTab);
  let originalWindow;
  try {
    originalWindow = await api.windows.get(originalTab.windowId, {
      populate: true
    });
  } catch {
    return focusExistingTab(api, tabId, placement);
  }
  if (!canDetach(originalTab, originalWindow)) {
    return focusExistingTab(api, tabId, placement);
  }
  try {
    const created = await api.windows.create({
      tabId,
      focused: true,
      type: "normal"
    });
    const detached = await getExactTab(api, tabId);
    if (!created || !isId(created.id ?? -1) || created.id !== detached.windowId) {
      return focusExistingTab(api, tabId, placement, true);
    }
    return {
      status: "PRESENTED",
      surface: "DETACHED_REAL_TAB_WINDOW",
      placement,
      presentedWindowId: detached.windowId,
      presentedIndex: detached.index
    };
  } catch {
    return focusExistingTab(api, tabId, placement, true);
  }
}
async function currentTab(api, tabId) {
  try {
    return await getExactTab(api, tabId);
  } catch {
    return void 0;
  }
}
function isOriginalPlacement(tab, placement) {
  return tab.windowId === placement.originalWindowId && tab.index === placement.originalIndex;
}
async function restoreSameTab(api, presentation) {
  const { placement } = presentation;
  const tab = await currentTab(api, placement.tabId);
  if (!tab) {
    return {
      status: "RETAINED",
      tabId: placement.tabId,
      reason: "TAB_UNAVAILABLE"
    };
  }
  if (isOriginalPlacement(tab, placement)) {
    return { status: "RESTORED", tabId: placement.tabId };
  }
  if (presentation.surface !== "DETACHED_REAL_TAB_WINDOW" || tab.windowId !== presentation.presentedWindowId || tab.index !== presentation.presentedIndex) {
    return {
      status: "RETAINED",
      tabId: placement.tabId,
      reason: "USER_MOVED"
    };
  }
  try {
    const originalWindow = await api.windows.get(placement.originalWindowId);
    if (originalWindow.id !== placement.originalWindowId) {
      return {
        status: "RETAINED",
        tabId: placement.tabId,
        reason: "ORIGINAL_WINDOW_MISSING"
      };
    }
  } catch {
    return {
      status: "RETAINED",
      tabId: placement.tabId,
      reason: "ORIGINAL_WINDOW_MISSING"
    };
  }
  try {
    const moved = await api.tabs.move(placement.tabId, {
      windowId: placement.originalWindowId,
      index: placement.originalIndex
    });
    const restored = Array.isArray(moved) ? moved[0] : moved;
    if (restored && isOriginalPlacement(exactTab(restored, placement.tabId), placement)) {
      return { status: "RESTORED", tabId: placement.tabId };
    }
  } catch {
    const restored = await currentTab(api, placement.tabId);
    if (restored && isOriginalPlacement(restored, placement)) {
      return { status: "RESTORED", tabId: placement.tabId };
    }
  }
  return {
    status: "RETAINED",
    tabId: placement.tabId,
    reason: "RESTORE_FAILED"
  };
}

// packages/handoff-extension/src/probe.ts
var BUILD_HASH = /^[a-f0-9]{64}$/;
var EXTENSION_ID = /^[a-p]{32}$/;
var VERSION = /^[0-9]+(?:\.[0-9]+){0,3}$/;
var CONTROLLED_FIXTURE = /^http:\/\/(?:127\.0\.0\.1|localhost):4173\/(?:index\.html)?(?:\?reset=[a-f0-9]{64})?$/;
var fixedResult = (metadata, result) => {
  const sanitized = {
    browserVersion: VERSION.test(metadata.browserVersion) ? metadata.browserVersion : "UNKNOWN",
    buildHash: BUILD_HASH.test(metadata.buildHash) ? metadata.buildHash : "UNKNOWN",
    extensionId: EXTENSION_ID.test(metadata.extensionId) ? metadata.extensionId : "UNKNOWN",
    extensionVersion: VERSION.test(metadata.extensionVersion) ? metadata.extensionVersion : "UNKNOWN",
    platform: metadata.platform === "macOS" ? "macOS" : "UNSUPPORTED",
    recordedAt: Number.isSafeInteger(metadata.recordedAt) && metadata.recordedAt >= 0 ? metadata.recordedAt : 0
  };
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
    ...sanitized
  };
};
function validMetadata(value) {
  return VERSION.test(value.browserVersion) && BUILD_HASH.test(value.buildHash) && EXTENSION_ID.test(value.extensionId) && VERSION.test(value.extensionVersion) && ["macOS", "UNSUPPORTED"].includes(value.platform) && Number.isSafeInteger(value.recordedAt) && value.recordedAt >= 0;
}
function controlledFixtureUrl(value) {
  if (!value || !CONTROLLED_FIXTURE.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}
function tabBinding(value) {
  const tab = value;
  if (!Number.isSafeInteger(tab.id) || (tab.id ?? -1) < 0 || !Number.isSafeInteger(tab.windowId) || tab.windowId < 0 || !Number.isSafeInteger(tab.index) || tab.index < 0 || typeof tab.active !== "boolean" || typeof tab.pinned !== "boolean" || !Number.isSafeInteger(tab.groupId) || tab.groupId < -1 || typeof tab.incognito !== "boolean" || !controlledFixtureUrl(tab.url) || tab.pendingUrl !== void 0) {
    return void 0;
  }
  return {
    id: tab.id,
    url: tab.url,
    windowId: tab.windowId,
    index: tab.index,
    active: tab.active,
    pinned: tab.pinned,
    groupId: tab.groupId,
    incognito: tab.incognito
  };
}
function sameBinding(left, right) {
  return left.id === right.id && left.url === right.url && left.windowId === right.windowId && left.index === right.index && left.active === right.active && left.pinned === right.pinned && left.groupId === right.groupId && left.incognito === right.incognito;
}
function expectedDetach(current, previous, createdWindowId) {
  return current.id === previous.id && current.url === previous.url && current.windowId !== previous.windowId && current.index === 0 && current.active === true && current.pinned === previous.pinned && current.groupId === previous.groupId && current.incognito === previous.incognito && (createdWindowId === void 0 || current.windowId === createdWindowId);
}
function validTarget(value) {
  const binding = tabBinding(value);
  return binding?.active === true && binding.incognito === false ? binding : void 0;
}
function monitorTarget(api, baseline) {
  let continuity = true;
  let urlStable = true;
  let targetStable = true;
  let firstGet = true;
  let mutationAttempted = false;
  let detachAttempted = false;
  let allowDetachedObservation = false;
  let createdWindowId;
  let last = baseline;
  const observe = (tab) => {
    const target = tab;
    continuity &&= target.id === baseline.id;
    urlStable &&= target.url === baseline.url && target.pendingUrl === void 0;
    const binding = tabBinding(tab);
    if (!binding) targetStable = false;
    return binding;
  };
  const acceptGet = (binding) => {
    if (!binding) return false;
    if (firstGet) {
      firstGet = false;
      return sameBinding(binding, baseline);
    }
    if (sameBinding(binding, last)) {
      allowDetachedObservation = false;
      return true;
    }
    if (allowDetachedObservation && expectedDetach(binding, last, createdWindowId)) {
      allowDetachedObservation = false;
      return true;
    }
    return false;
  };
  const preflight = async (expected) => {
    const binding = observe(await api.tabs.get(baseline.id));
    if (!binding || !sameBinding(binding, expected)) {
      targetStable = false;
      throw new Error("controlled fixture changed before Chrome mutation");
    }
    last = binding;
  };
  const monitoredApi = {
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
        last = binding;
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
          const tabs = Array.isArray(moved) ? moved : [moved];
          for (const tab of tabs) {
            const binding = observe(tab);
            if (!binding) throw new Error("fixture changed during move");
            last = binding;
          }
          return moved;
        } catch (error) {
          try {
            const binding = observe(await api.tabs.get(tabId));
            if (binding && binding.windowId === properties.windowId && binding.index === properties.index && binding.id === last.id && binding.url === last.url && binding.active === last.active && binding.pinned === last.pinned && binding.groupId === last.groupId && binding.incognito === last.incognito) {
              last = binding;
            }
          } catch {
          }
          throw error;
        }
      }
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
        if (created?.id !== void 0 && Number.isSafeInteger(created.id) && created.id >= 0) {
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
      }
    }
  };
  const placement = {
    tabId: baseline.id,
    originalWindowId: baseline.windowId,
    originalIndex: baseline.index,
    wasActive: baseline.active,
    wasPinned: baseline.pinned,
    ...baseline.groupId >= 0 ? { originalGroupId: baseline.groupId } : {}
  };
  return {
    api: monitoredApi,
    continuity: () => continuity,
    urlStable: () => urlStable,
    targetStable: () => targetStable,
    mutationAttempted: () => mutationAttempted,
    recoverPartialPresentation: async () => {
      if (!mutationAttempted) return void 0;
      let current;
      try {
        current = observe(await api.tabs.get(baseline.id));
      } catch {
        return void 0;
      }
      if (!current) return void 0;
      if (sameBinding(current, baseline)) {
        last = current;
        allowDetachedObservation = false;
        return {
          status: "PRESENTED",
          surface: "FOCUSED_REAL_TAB",
          placement,
          presentedWindowId: current.windowId,
          presentedIndex: current.index
        };
      }
      if (!detachAttempted || !allowDetachedObservation || !expectedDetach(current, last, createdWindowId)) {
        targetStable = false;
        return void 0;
      }
      last = current;
      allowDetachedObservation = false;
      return {
        status: "PRESENTED",
        surface: "DETACHED_REAL_TAB_WINDOW",
        placement,
        presentedWindowId: current.windowId,
        presentedIndex: current.index
      };
    },
    observeFinal: async () => {
      try {
        observe(await api.tabs.get(baseline.id));
      } catch {
        targetStable = false;
      }
    },
    failureReason: () => !continuity ? "TAB_IDENTITY_CHANGED" : !urlStable ? "FIXTURE_NAVIGATED" : !targetStable ? "TARGET_CHANGED" : "PRESENTATION_FAILED"
  };
}
async function runSameTabProbe(api, target, metadata) {
  const notRun = {
    chromeTabObjectContinuity: "NOT_RUN",
    fixtureUrlStable: "NOT_RUN",
    restoration: "NOT_RUN",
    surface: "NONE"
  };
  if (!validMetadata(metadata)) {
    return fixedResult(metadata, {
      ...notRun,
      status: "REJECTED",
      reason: "INVALID_METADATA"
    });
  }
  if (metadata.platform !== "macOS") {
    return fixedResult(metadata, {
      ...notRun,
      status: "REJECTED",
      reason: "UNSUPPORTED_PLATFORM"
    });
  }
  const baseline = validTarget(target);
  if (!baseline) {
    return fixedResult(metadata, {
      ...notRun,
      status: "REJECTED",
      reason: "UNCONTROLLED_TARGET"
    });
  }
  const monitor = monitorTarget(api, baseline);
  let presentation;
  let presentationFailed = false;
  let restoration = "NOT_RUN";
  try {
    const presented = await presentSameTab(monitor.api, {
      holder: "USER",
      state: "ACTIVE",
      scope: { tabId: baseline.id }
    });
    if (presented.status !== "PRESENTED") throw new Error("not presented");
    presentation = presented;
  } catch {
    presentationFailed = true;
    presentation = await monitor.recoverPartialPresentation().catch(() => void 0);
    if (!presentation && monitor.mutationAttempted()) restoration = "RETAINED";
  } finally {
    if (presentation) {
      const restored2 = await restoreSameTab(monitor.api, presentation).catch(
        () => void 0
      );
      restoration = restored2?.status ?? "RETAINED";
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
      surface: presentation?.surface === "DETACHED_REAL_TAB_WINDOW" ? presentation.surface : "NONE",
      status: "FAILED",
      reason: monitor.failureReason()
    });
  }
  const targetStable = monitor.targetStable();
  const restored = restoration === "RESTORED";
  return fixedResult(metadata, {
    chromeTabObjectContinuity: continuity ? "PASSED" : "FAILED",
    fixtureUrlStable: urlStable ? "PASSED" : "FAILED",
    surface: presentation?.surface ?? "NONE",
    restoration,
    status: continuity && urlStable && targetStable && restored ? "PASSED" : "FAILED",
    reason: !continuity ? "TAB_IDENTITY_CHANGED" : !urlStable ? "FIXTURE_NAVIGATED" : !targetStable ? "TARGET_CHANGED" : !restored ? "RESTORE_FAILED" : "NONE"
  });
}

// packages/handoff-extension/src/service-worker.ts
var runtime = globalThis.chrome;
function chromeVersion(userAgent) {
  if (/\b(?:Edg|OPR|CriOS)\//.test(userAgent)) return "UNKNOWN";
  return /\bChrome\/([0-9]+(?:\.[0-9]+){0,3})\b/.exec(userAgent)?.[1] ?? "UNKNOWN";
}
if (runtime) {
  let running = false;
  runtime.action.onClicked.addListener((tab) => {
    if (running) return;
    running = true;
    void (async () => {
      const userAgent = globalThis.navigator?.userAgent ?? "";
      const result = await runSameTabProbe(runtime, tab, {
        browserVersion: chromeVersion(userAgent),
        buildHash: "f928eb9771f04c98e06cd6d52ae11915a7698ecc65eca9e5628af4b69e2d7999",
        extensionId: runtime.runtime.id,
        extensionVersion: runtime.runtime.getManifest().version,
        platform: /\bMacintosh\b/.test(userAgent) ? "macOS" : "UNSUPPORTED",
        recordedAt: Date.now()
      });
      console.info(`OXRAIL_SAME_TAB_PROBE ${JSON.stringify(result)}`);
    })().finally(() => {
      running = false;
    });
  });
}
