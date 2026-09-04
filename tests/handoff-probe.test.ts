import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type {
  ChromeTabView,
  ChromeWindowView,
  HandoffChromeApi,
} from "../packages/handoff-extension/src/presenter.js";
import {
  runSameTabProbe,
  type SameTabProbeMetadata,
  type SameTabProbeTarget,
} from "../packages/handoff-extension/src/probe.js";

const fixtureUrl = `http://127.0.0.1:4173/?reset=${"f".repeat(64)}`;
const metadata: SameTabProbeMetadata = {
  browserVersion: "140.0.0.0",
  buildHash: "d".repeat(64),
  extensionId: "a".repeat(32),
  extensionVersion: "0.1.0",
  platform: "macOS",
  recordedAt: 2_000,
};

function tab(overrides: Partial<SameTabProbeTarget> = {}): SameTabProbeTarget {
  const value = {
    id: 17,
    windowId: 7,
    index: 1,
    active: true,
    pinned: false,
    groupId: -1,
    incognito: false,
    url: fixtureUrl,
    ...overrides,
  };
  for (const name of ["title", "favIconUrl"]) {
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

const moveTab = (
  source: SameTabProbeTarget,
  overrides: Partial<SameTabProbeTarget>,
) =>
  tab({
    ...(source.id !== undefined ? { id: source.id } : {}),
    windowId: source.windowId,
    index: source.index,
    active: source.active,
    pinned: source.pinned,
    groupId: source.groupId,
    incognito: source.incognito,
    ...(source.url ? { url: source.url } : {}),
    ...overrides,
  });

function chromeFixture(initial: SameTabProbeTarget = tab()) {
  let current = initial;
  const api: HandoffChromeApi = {
    tabs: {
      get: vi.fn(async () => current),
      update: vi.fn(async () => current),
      move: vi.fn(async (tabId, target) => {
        current = moveTab(current, {
          id: tabId,
          windowId: target.windowId,
          index: target.index,
        });
        return current;
      }),
    },
    windows: {
      get: vi.fn(async (_windowId, options) =>
        options ? window() : windowWithoutTabs(),
      ),
      create: vi.fn(async () => {
        current = moveTab(current, { windowId: 91, index: 0 });
        return window({ id: 91, tabs: [current] });
      }),
      update: vi.fn(),
    },
  };
  return { api, current: () => current };
}

const chromeCalls = (api: HandoffChromeApi) => [
  api.tabs.get,
  api.tabs.update,
  api.tabs.move,
  api.windows.get,
  api.windows.create,
  api.windows.update,
];

describe("manual MV3 same-tab evidence probe", () => {
  it("moves and restores the exact controlled fixture tab with a non-authorizing result", async () => {
    const fixture = chromeFixture();

    const result = await runSameTabProbe(fixture.api, tab(), metadata);

    expect(result).toMatchObject({
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      status: "PASSED",
      reason: "NONE",
      chromeTabObjectContinuity: "PASSED",
      fixtureUrlStable: "PASSED",
      documentBinding: "UNKNOWN",
      surface: "DETACHED_REAL_TAB_WINDOW",
      restoration: "RESTORED",
      hostNativeActionFence: "UNAVAILABLE",
      hostTabRouteBinding: "UNKNOWN",
      handoff: "INACTIVE",
      capabilityEffect: "NONE",
    });
    expect(fixture.current()).toMatchObject({ id: 17, windowId: 7, index: 1 });
    const serialized = JSON.stringify(result);
    for (const forbidden of [fixtureUrl, "tabId", "windowId", "url", "title"])
      expect(serialized).not.toContain(forbidden);
  });

  it("uses focus-only fallback without cloning pinned fixture tabs", async () => {
    const target = tab({ pinned: true });
    const fixture = chromeFixture(target);

    await expect(
      runSameTabProbe(fixture.api, target, metadata),
    ).resolves.toMatchObject({
      status: "PASSED",
      surface: "FOCUSED_REAL_TAB",
      restoration: "RESTORED",
    });
    expect(fixture.api.windows.create).not.toHaveBeenCalled();
    expect(fixture.api.tabs.update).toHaveBeenCalledWith(17, { active: true });
  });

  it("rejects a pending fixture navigation before every Chrome call", async () => {
    const fixture = chromeFixture();

    await expect(
      runSameTabProbe(fixture.api, tab({ pendingUrl: fixtureUrl }), metadata),
    ).resolves.toMatchObject({
      status: "REJECTED",
      reason: "UNCONTROLLED_TARGET",
      fixtureUrlStable: "NOT_RUN",
      documentBinding: "UNKNOWN",
    });
    expect(chromeCalls(fixture.api)).toSatisfy((calls: unknown[]) =>
      calls.every(
        (call) => (call as ReturnType<typeof vi.fn>).mock.calls.length === 0,
      ),
    );
  });

  it("rejects target drift immediately before detach", async () => {
    let current = tab();
    const create = vi.fn();
    const update = vi.fn();
    const api: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => current),
        update,
        move: vi.fn(),
      },
      windows: {
        get: vi.fn(async () => {
          current = moveTab(current, { index: 2 });
          return window();
        }),
        create,
        update: vi.fn(),
      },
    };

    await expect(runSameTabProbe(api, tab(), metadata)).resolves.toMatchObject({
      status: "FAILED",
      reason: "TARGET_CHANGED",
      restoration: "NOT_RUN",
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("rejects a pending navigation immediately before detach", async () => {
    let current = tab();
    const create = vi.fn();
    const api: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => current),
        update: vi.fn(),
        move: vi.fn(),
      },
      windows: {
        get: vi.fn(async () => {
          current = moveTab(current, { pendingUrl: fixtureUrl });
          return window();
        }),
        create,
        update: vi.fn(),
      },
    };

    await expect(runSameTabProbe(api, tab(), metadata)).resolves.toMatchObject({
      status: "FAILED",
      reason: "FIXTURE_NAVIGATED",
      fixtureUrlStable: "FAILED",
    });
    expect(create).not.toHaveBeenCalled();
  });

  it("rechecks the full binding immediately before focus", async () => {
    const target = tab({ pinned: true });
    let gets = 0;
    const update = vi.fn();
    const api: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => {
          gets += 1;
          return gets >= 3 ? moveTab(target, { index: 2 }) : target;
        }),
        update,
        move: vi.fn(),
      },
      windows: {
        get: vi.fn(async () => window()),
        create: vi.fn(),
        update: vi.fn(),
      },
    };

    await expect(runSameTabProbe(api, target, metadata)).resolves.toMatchObject(
      {
        status: "FAILED",
        reason: "TARGET_CHANGED",
        restoration: "NOT_RUN",
      },
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("restores a tab moved by windows.create before its result channel fails", async () => {
    let current = tab();
    let gets = 0;
    const move = vi.fn(async (tabId: number, target) => {
      current = moveTab(current, {
        id: tabId,
        windowId: target.windowId,
        index: target.index,
      });
      return current;
    });
    const api: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => {
          gets += 1;
          if (gets === 3) throw new Error("fixture: transient get failure");
          return current;
        }),
        update: vi.fn(),
        move,
      },
      windows: {
        get: vi.fn(async (_windowId, options) =>
          options ? window() : windowWithoutTabs(),
        ),
        create: vi.fn(async () => {
          current = moveTab(current, { windowId: 91, index: 0 });
          throw new Error("fixture: create failed after moving tab");
        }),
        update: vi.fn(),
      },
    };

    await expect(runSameTabProbe(api, tab(), metadata)).resolves.toMatchObject({
      status: "FAILED",
      reason: "PRESENTATION_FAILED",
      surface: "DETACHED_REAL_TAB_WINDOW",
      restoration: "RESTORED",
      handoff: "INACTIVE",
    });
    expect(current).toMatchObject({ id: 17, windowId: 7, index: 1 });
    expect(move).toHaveBeenCalledWith(17, { windowId: 7, index: 1 });
  });

  it("does not restore after the detached tab changes before tabs.move", async () => {
    let current = tab();
    const move = vi.fn();
    const api: HandoffChromeApi = {
      tabs: {
        get: vi.fn(async () => current),
        update: vi.fn(async () => current),
        move,
      },
      windows: {
        get: vi.fn(async (_windowId, options) => {
          if (!options) current = moveTab(current, { index: 2 });
          return options ? window() : windowWithoutTabs();
        }),
        create: vi.fn(async () => {
          current = moveTab(current, { windowId: 91, index: 0 });
          return window({ id: 91, tabs: [current] });
        }),
        update: vi.fn(),
      },
    };

    await expect(runSameTabProbe(api, tab(), metadata)).resolves.toMatchObject({
      status: "FAILED",
      reason: "TARGET_CHANGED",
      restoration: "RETAINED",
    });
    expect(move).not.toHaveBeenCalled();
  });

  it.each([
    "https://127.0.0.1:4173/",
    "http://127.0.0.1:4174/",
    "http://127.0.0.1:4173.evil.test/",
    "http://user:pass@127.0.0.1:4173/",
    "http://127.0.0.1:4173/other",
    "http://127.0.0.1:4173/?other=value",
    "http://127.0.0.1:4173/?reset=bad",
    `http://127.0.0.1:4173/?reset=${"%66".repeat(64)}`,
    "http://2130706433:4173/",
    `http://127.0.0.1:4173/?reset=${"f".repeat(64)}&reset=${"f".repeat(64)}`,
    "http://127.0.0.1:4173/#fragment",
  ])(
    "rejects uncontrolled target %s before every Chrome mutation",
    async (url) => {
      const fixture = chromeFixture();

      await expect(
        runSameTabProbe(fixture.api, tab({ url }), metadata),
      ).resolves.toMatchObject({
        status: "REJECTED",
        reason: "UNCONTROLLED_TARGET",
        chromeTabObjectContinuity: "NOT_RUN",
        handoff: "INACTIVE",
      });
      expect(chromeCalls(fixture.api)).toSatisfy((calls: unknown[]) =>
        calls.every(
          (call) => (call as ReturnType<typeof vi.fn>).mock.calls.length === 0,
        ),
      );
    },
  );

  it("does not run outside macOS", async () => {
    const fixture = chromeFixture();

    await expect(
      runSameTabProbe(fixture.api, tab(), {
        ...metadata,
        platform: "UNSUPPORTED",
      }),
    ).resolves.toMatchObject({
      status: "REJECTED",
      reason: "UNSUPPORTED_PLATFORM",
    });
    expect(chromeCalls(fixture.api)).toSatisfy((calls: unknown[]) =>
      calls.every(
        (call) => (call as ReturnType<typeof vi.fn>).mock.calls.length === 0,
      ),
    );
  });

  it("fails without echoing invalid metadata", async () => {
    const fixture = chromeFixture();
    const canary = "must-not-cross-probe-output";

    const result = await runSameTabProbe(fixture.api, tab(), {
      ...metadata,
      buildHash: canary,
      extensionId: canary,
    });

    expect(result).toMatchObject({
      status: "REJECTED",
      reason: "INVALID_METADATA",
      buildHash: "UNKNOWN",
      extensionId: "UNKNOWN",
    });
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(chromeCalls(fixture.api)).toSatisfy((calls: unknown[]) =>
      calls.every(
        (call) => (call as ReturnType<typeof vi.fn>).mock.calls.length === 0,
      ),
    );
  });

  it("reports identity changes and restoration failures without claiming Handoff", async () => {
    const identity = chromeFixture();
    identity.api.windows.create = vi.fn(async () =>
      window({ id: 91, tabs: [tab({ id: 18, windowId: 91, index: 0 })] }),
    );
    identity.api.tabs.get = vi.fn(async () =>
      tab({ id: 18, windowId: 91, index: 0 }),
    );
    await expect(
      runSameTabProbe(identity.api, tab(), metadata),
    ).resolves.toMatchObject({
      status: "FAILED",
      reason: "TAB_IDENTITY_CHANGED",
      handoff: "INACTIVE",
    });

    const retained = chromeFixture();
    retained.api.tabs.move = vi.fn(async () => {
      throw new Error("fixture: restore rejected");
    });
    await expect(
      runSameTabProbe(retained.api, tab(), metadata),
    ).resolves.toMatchObject({
      status: "FAILED",
      reason: "RESTORE_FAILED",
      restoration: "RETAINED",
      handoff: "INACTIVE",
    });
  });

  it("ships a permission-minimal manual-action MV3 manifest", async () => {
    const manifest = JSON.parse(
      await readFile("packages/handoff-extension/chrome/manifest.json", "utf8"),
    ) as Record<string, unknown>;

    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions).toEqual(["activeTab"]);
    expect(manifest).not.toHaveProperty("host_permissions");
    expect(manifest).not.toHaveProperty("content_scripts");
    expect(manifest).not.toHaveProperty("externally_connectable");
    expect(JSON.stringify(manifest)).not.toMatch(
      /cookies|debugger|tabCapture|desktopCapture|clipboard|nativeMessaging|storage/,
    );

    const worker = await readFile(
      "packages/handoff-extension/src/service-worker.ts",
      "utf8",
    );
    expect(worker).not.toMatch(/setBadgeText|setTitle/);
  });
});
