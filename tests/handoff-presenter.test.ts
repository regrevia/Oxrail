import { describe, expect, it, vi } from "vitest";

import {
  type ChromeTabView,
  type ChromeWindowView,
  type HandoffChromeApi,
  presentSameTab,
  type PresentedSameTab,
  restoreSameTab,
} from "../packages/handoff-extension/src/presenter.js";

const activeLease = {
  state: "ACTIVE",
  holder: "USER",
  scope: { tabId: 17 },
} as const;

function tab(overrides: Partial<ChromeTabView> = {}): ChromeTabView {
  const value = {
    id: 17,
    windowId: 7,
    index: 1,
    active: true,
    pinned: false,
    groupId: -1,
    incognito: false,
    ...overrides,
  };
  for (const name of ["url", "title", "favIconUrl"]) {
    Object.defineProperty(value, name, {
      enumerable: true,
      get: () => {
        throw new Error(`${name} must not be read`);
      },
    });
  }
  return value;
}

function window(overrides: Partial<ChromeWindowView> = {}): ChromeWindowView {
  return {
    id: 7,
    type: "normal",
    state: "normal",
    incognito: false,
    tabs: [{}, {}],
    ...overrides,
  };
}

const windowWithoutTabs = (): ChromeWindowView => ({
  id: 7,
  type: "normal",
  state: "normal",
  incognito: false,
});

describe("fixture-only same-tab presenter", () => {
  it("makes zero Chrome calls while the user lease is inactive", async () => {
    const api = {
      tabs: {
        get: vi.fn(),
        update: vi.fn(),
        move: vi.fn(),
      },
      windows: {
        get: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
    } as unknown as HandoffChromeApi;

    await expect(
      presentSameTab(api, { ...activeLease, state: "PENDING", holder: "NONE" }),
    ).resolves.toEqual({
      status: "INACTIVE",
      reason: "USER_LEASE_INACTIVE",
    });
    expect([
      api.tabs.get,
      api.tabs.update,
      api.tabs.move,
      api.windows.get,
      api.windows.create,
      api.windows.update,
    ]).toSatisfy((calls: ReturnType<typeof vi.fn>[]) =>
      calls.every((call) => call.mock.calls.length === 0),
    );
  });

  it("detaches and restores the exact existing tab without reading page metadata", async () => {
    let current = tab();
    const tabsGet = vi.fn(async () => current);
    const tabsUpdate = vi.fn(async () => current);
    const tabsMove = vi.fn(async (tabId: number, target) => {
      current = tab({
        id: tabId,
        windowId: target.windowId,
        index: target.index,
      });
      return current;
    });
    const windowsGet = vi.fn(async (_windowId: number, options) =>
      options ? window() : windowWithoutTabs(),
    );
    const windowsCreate = vi.fn(async () => {
      current = tab({ windowId: 91, index: 0 });
      return window({ id: 91, tabs: [current] });
    });
    const windowsUpdate = vi.fn();
    const api: HandoffChromeApi = {
      tabs: { get: tabsGet, update: tabsUpdate, move: tabsMove },
      windows: {
        get: windowsGet,
        create: windowsCreate,
        update: windowsUpdate,
      },
    };

    const presentation = await presentSameTab(api, activeLease);

    expect(presentation).toEqual({
      status: "PRESENTED",
      surface: "DETACHED_REAL_TAB_WINDOW",
      placement: {
        tabId: 17,
        originalWindowId: 7,
        originalIndex: 1,
        wasActive: true,
        wasPinned: false,
      },
      presentedWindowId: 91,
      presentedIndex: 0,
    });
    expect(windowsCreate).toHaveBeenCalledWith({
      tabId: 17,
      focused: true,
      type: "normal",
    });
    expect(tabsUpdate).not.toHaveBeenCalled();

    await expect(
      restoreSameTab(api, presentation as PresentedSameTab),
    ).resolves.toEqual({ status: "RESTORED", tabId: 17 });
    expect(tabsMove).toHaveBeenCalledWith(17, { windowId: 7, index: 1 });
    expect(windowsUpdate).not.toHaveBeenCalled();
  });

  it.each([
    ["inactive target", { active: false }, {}],
    ["pinned target", { pinned: true }, {}],
    ["grouped target", { groupId: 3 }, {}],
    ["incognito target", { incognito: true }, {}],
    ["incognito window", {}, { incognito: true }],
    ["single-tab window", {}, { tabs: [{}] }],
    ["fullscreen window", {}, { state: "fullscreen" }],
    ["non-normal window", {}, { type: "popup" }],
  ])("uses H1 for an unsafe H0 case: %s", async (_name, tabPatch, winPatch) => {
    let current = tab(tabPatch);
    const windowsCreate = vi.fn();
    const tabsUpdate = vi.fn(async () => {
      current = tab({ ...tabPatch, active: true });
      return current;
    });
    const windowsUpdate = vi.fn();
    const api: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => current),
        update: tabsUpdate,
        move: vi.fn(),
      },
      windows: {
        get: vi.fn(async () => window(winPatch)),
        create: windowsCreate,
        update: windowsUpdate,
      },
    };

    await expect(presentSameTab(api, activeLease)).resolves.toMatchObject({
      status: "PRESENTED",
      surface: "FOCUSED_REAL_TAB",
      placement: { tabId: 17, originalWindowId: 7, originalIndex: 1 },
      presentedWindowId: 7,
    });
    expect(windowsCreate).not.toHaveBeenCalled();
    expect(tabsUpdate).toHaveBeenCalledWith(17, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(7, { focused: true });
  });

  it("re-fetches and focuses the exact tab after a partial detach failure", async () => {
    let current = tab();
    const tabsGet = vi.fn(async () => current);
    const tabsUpdate = vi.fn(async () => current);
    const windowsUpdate = vi.fn();
    const api: HandoffChromeApi = {
      tabs: { get: tabsGet, update: tabsUpdate, move: vi.fn() },
      windows: {
        get: vi.fn(async () => window()),
        create: vi.fn(async () => {
          current = tab({ windowId: 91, index: 0 });
          throw new Error("fixture: detach failed after move");
        }),
        update: windowsUpdate,
      },
    };

    await expect(presentSameTab(api, activeLease)).resolves.toMatchObject({
      status: "PRESENTED",
      surface: "DETACHED_REAL_TAB_WINDOW",
      placement: { originalWindowId: 7, originalIndex: 1 },
      presentedWindowId: 91,
      presentedIndex: 0,
    });
    expect(tabsGet).toHaveBeenCalledTimes(2);
    expect(tabsUpdate).toHaveBeenCalledWith(17, { active: true });
    expect(windowsUpdate).toHaveBeenCalledWith(91, { focused: true });
  });

  it("retains the tab when the original window is gone or the user moved it", async () => {
    const presentation: PresentedSameTab = {
      status: "PRESENTED",
      surface: "DETACHED_REAL_TAB_WINDOW",
      placement: {
        tabId: 17,
        originalWindowId: 7,
        originalIndex: 1,
        wasActive: true,
        wasPinned: false,
      },
      presentedWindowId: 91,
      presentedIndex: 0,
    };

    const moveForMissing = vi.fn();
    const missingWindowApi: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => tab({ windowId: 91, index: 0 })),
        update: vi.fn(),
        move: moveForMissing,
      },
      windows: {
        get: vi.fn(async () => {
          throw new Error("fixture: window missing");
        }),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    await expect(
      restoreSameTab(missingWindowApi, presentation),
    ).resolves.toEqual({
      status: "RETAINED",
      tabId: 17,
      reason: "ORIGINAL_WINDOW_MISSING",
    });
    expect(moveForMissing).not.toHaveBeenCalled();

    const windowsGetAfterMove = vi.fn();
    const moveAfterMove = vi.fn();
    const userMovedApi: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => tab({ windowId: 88, index: 4 })),
        update: vi.fn(),
        move: moveAfterMove,
      },
      windows: {
        get: windowsGetAfterMove,
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    await expect(restoreSameTab(userMovedApi, presentation)).resolves.toEqual({
      status: "RETAINED",
      tabId: 17,
      reason: "USER_MOVED",
    });
    expect(windowsGetAfterMove).not.toHaveBeenCalled();
    expect(moveAfterMove).not.toHaveBeenCalled();
  });

  it("recognizes a restoration that completed before tabs.move rejected", async () => {
    let current = tab({ windowId: 91, index: 0 });
    const api: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => current),
        update: vi.fn(),
        move: vi.fn(async () => {
          current = tab();
          throw new Error("fixture: result channel failed after move");
        }),
      },
      windows: {
        get: vi.fn(async () => windowWithoutTabs()),
        create: vi.fn(),
        update: vi.fn(),
      },
    };
    const presentation: PresentedSameTab = {
      status: "PRESENTED",
      surface: "DETACHED_REAL_TAB_WINDOW",
      placement: {
        tabId: 17,
        originalWindowId: 7,
        originalIndex: 1,
        wasActive: true,
        wasPinned: false,
      },
      presentedWindowId: 91,
      presentedIndex: 0,
    };

    await expect(restoreSameTab(api, presentation)).resolves.toEqual({
      status: "RESTORED",
      tabId: 17,
    });
  });
});
