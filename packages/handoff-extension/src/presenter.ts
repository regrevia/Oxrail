export interface HandoffLeaseView {
  readonly state: string;
  readonly holder: string;
  readonly scope: { readonly tabId: number };
}

export interface ChromeTabView {
  readonly id?: number;
  readonly windowId: number;
  readonly index: number;
  readonly active: boolean;
  readonly pinned: boolean;
  readonly groupId: number;
  readonly incognito: boolean;
}

export interface ChromeWindowView {
  readonly id?: number;
  readonly type?: string;
  readonly state?: string;
  readonly incognito: boolean;
  readonly tabs?: readonly unknown[];
}

export interface HandoffChromeApi {
  readonly tabs: {
    get(tabId: number): Promise<ChromeTabView>;
    update(tabId: number, properties: { active: true }): Promise<ChromeTabView>;
    move(
      tabId: number,
      properties: { windowId: number; index: number },
    ): Promise<ChromeTabView | readonly ChromeTabView[]>;
  };
  readonly windows: {
    get(
      windowId: number,
      options?: { populate: true },
    ): Promise<ChromeWindowView>;
    create(properties: {
      tabId: number;
      focused: true;
      type: "normal";
    }): Promise<ChromeWindowView | undefined>;
    update(windowId: number, properties: { focused: true }): Promise<unknown>;
  };
}

export interface TabPlacementSnapshot {
  readonly tabId: number;
  readonly originalWindowId: number;
  readonly originalIndex: number;
  readonly wasActive: boolean;
  readonly wasPinned: boolean;
  readonly originalGroupId?: number;
}

export type SameTabPresentation =
  | { readonly status: "INACTIVE"; readonly reason: "USER_LEASE_INACTIVE" }
  | {
      readonly status: "PRESENTED";
      readonly surface: "DETACHED_REAL_TAB_WINDOW" | "FOCUSED_REAL_TAB";
      readonly placement: TabPlacementSnapshot;
      readonly presentedWindowId: number;
      readonly presentedIndex: number;
    };

export type PresentedSameTab = Extract<
  SameTabPresentation,
  { status: "PRESENTED" }
>;

export type SameTabRestoreResult =
  | { readonly status: "RESTORED"; readonly tabId: number }
  | {
      readonly status: "RETAINED";
      readonly tabId: number;
      readonly reason:
        | "TAB_UNAVAILABLE"
        | "USER_MOVED"
        | "ORIGINAL_WINDOW_MISSING"
        | "RESTORE_FAILED";
    };

const isId = (value: number): boolean =>
  Number.isSafeInteger(value) && value >= 0;

function exactTab(tab: ChromeTabView, tabId: number): ChromeTabView {
  if (
    tab.id !== tabId ||
    !isId(tab.windowId) ||
    !Number.isSafeInteger(tab.index) ||
    tab.index < 0
  ) {
    throw new Error("Oxrail could not bind the exact existing tab");
  }
  return tab;
}

async function getExactTab(
  api: HandoffChromeApi,
  tabId: number,
): Promise<ChromeTabView> {
  return exactTab(await api.tabs.get(tabId), tabId);
}

function snapshot(tab: ChromeTabView): TabPlacementSnapshot {
  return {
    tabId: tab.id as number,
    originalWindowId: tab.windowId,
    originalIndex: tab.index,
    wasActive: tab.active,
    wasPinned: tab.pinned,
    ...(Number.isSafeInteger(tab.groupId) && tab.groupId >= 0
      ? { originalGroupId: tab.groupId }
      : {}),
  };
}

function canDetach(tab: ChromeTabView, window: ChromeWindowView): boolean {
  return (
    window.id === tab.windowId &&
    window.type === "normal" &&
    window.incognito === false &&
    ["normal", "minimized", "maximized"].includes(window.state ?? "") &&
    (window.tabs?.length ?? 0) >= 2 &&
    tab.incognito === false &&
    tab.active === true &&
    tab.pinned === false &&
    tab.groupId === -1
  );
}

async function focusExistingTab(
  api: HandoffChromeApi,
  tabId: number,
  placement: TabPlacementSnapshot,
  afterDetachAttempt = false,
): Promise<PresentedSameTab> {
  await getExactTab(api, tabId);
  const focused = exactTab(
    await api.tabs.update(tabId, { active: true }),
    tabId,
  );
  await api.windows.update(focused.windowId, { focused: true });
  return {
    status: "PRESENTED",
    surface:
      afterDetachAttempt && focused.windowId !== placement.originalWindowId
        ? "DETACHED_REAL_TAB_WINDOW"
        : "FOCUSED_REAL_TAB",
    placement,
    presentedWindowId: focused.windowId,
    presentedIndex: focused.index,
  };
}

/** Fixture-only primitive. It does not activate or update Host Profile status. */
export async function presentSameTab(
  api: HandoffChromeApi,
  lease: HandoffLeaseView,
): Promise<SameTabPresentation> {
  if (lease.state !== "ACTIVE" || lease.holder !== "USER") {
    return { status: "INACTIVE", reason: "USER_LEASE_INACTIVE" };
  }
  const tabId = lease.scope.tabId;
  if (!isId(tabId)) {
    throw new TypeError("lease tabId must be a non-negative safe integer");
  }

  const originalTab = await getExactTab(api, tabId);
  const placement = snapshot(originalTab);
  let originalWindow: ChromeWindowView | undefined;
  try {
    originalWindow = await api.windows.get(originalTab.windowId, {
      populate: true,
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
      type: "normal",
    });
    const detached = await getExactTab(api, tabId);
    if (
      !created ||
      !isId(created.id ?? -1) ||
      created.id !== detached.windowId
    ) {
      return focusExistingTab(api, tabId, placement, true);
    }
    return {
      status: "PRESENTED",
      surface: "DETACHED_REAL_TAB_WINDOW",
      placement,
      presentedWindowId: detached.windowId,
      presentedIndex: detached.index,
    };
  } catch {
    // windows.create can fail after moving the tab; re-bind before focusing.
    return focusExistingTab(api, tabId, placement, true);
  }
}

async function currentTab(
  api: HandoffChromeApi,
  tabId: number,
): Promise<ChromeTabView | undefined> {
  try {
    return await getExactTab(api, tabId);
  } catch {
    return undefined;
  }
}

function isOriginalPlacement(
  tab: ChromeTabView,
  placement: TabPlacementSnapshot,
): boolean {
  return (
    tab.windowId === placement.originalWindowId &&
    tab.index === placement.originalIndex
  );
}

export async function restoreSameTab(
  api: HandoffChromeApi,
  presentation: PresentedSameTab,
): Promise<SameTabRestoreResult> {
  const { placement } = presentation;
  const tab = await currentTab(api, placement.tabId);
  if (!tab) {
    return {
      status: "RETAINED",
      tabId: placement.tabId,
      reason: "TAB_UNAVAILABLE",
    };
  }
  if (isOriginalPlacement(tab, placement)) {
    return { status: "RESTORED", tabId: placement.tabId };
  }
  if (
    presentation.surface !== "DETACHED_REAL_TAB_WINDOW" ||
    tab.windowId !== presentation.presentedWindowId ||
    tab.index !== presentation.presentedIndex
  ) {
    return {
      status: "RETAINED",
      tabId: placement.tabId,
      reason: "USER_MOVED",
    };
  }

  try {
    const originalWindow = await api.windows.get(placement.originalWindowId);
    if (originalWindow.id !== placement.originalWindowId) {
      return {
        status: "RETAINED",
        tabId: placement.tabId,
        reason: "ORIGINAL_WINDOW_MISSING",
      };
    }
  } catch {
    return {
      status: "RETAINED",
      tabId: placement.tabId,
      reason: "ORIGINAL_WINDOW_MISSING",
    };
  }

  try {
    const moved = await api.tabs.move(placement.tabId, {
      windowId: placement.originalWindowId,
      index: placement.originalIndex,
    });
    const restored = Array.isArray(moved) ? moved[0] : moved;
    if (
      restored &&
      isOriginalPlacement(exactTab(restored, placement.tabId), placement)
    ) {
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
    reason: "RESTORE_FAILED",
  };
}
