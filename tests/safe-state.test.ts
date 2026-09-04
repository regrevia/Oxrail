import { describe, expect, it } from "vitest";

import {
  createBrowserTaskState,
  sanitizeBrowserTaskStateForPersistence,
} from "../packages/core/src/index.js";
import type { BrowserTaskState } from "../packages/protocol/src/index.js";

const hash = (character: string) => character.repeat(64);

describe("persistent BrowserTaskState boundary", () => {
  it("removes user/page content before state reaches disk", () => {
    const canary = "OXRAIL_SECRET_CANARY_STATE_7419";
    const state: BrowserTaskState = {
      ...createBrowserTaskState({
        sessionId: "session-1",
        taskId: "task-1",
        hostProfileId: "profile-1",
        mode: "MICRO_ACTION_GUARD",
      }),
      goalSummary: `finish checkout with ${canary}`,
      currentOrigin: "https://example.test",
      currentUrlKey: `https://example.test/private?token=${canary}`,
      documentBinding: "document-raw-id",
      lastObservation: {
        source: "NATIVE_VISUAL",
        tier: "O1",
        stateHash: hash("a"),
        urlKey: `/private?token=${canary}`,
        documentBinding: "observation-document-id",
        revision: 1,
        blockerType: canary,
        omittedFields: [canary],
        controlCriticalFieldsRetained: [canary],
        screenshotFrameCorrelationId: "frame-raw-id",
        viewportBinding: "viewport-raw-id",
      },
      lastAction: {
        toolUseId: `tool-${canary}`,
        route: "direct-mcp",
        granularity: "MICRO_ACTION",
        actionType: "click",
        targetSignature: hash("b"),
        inputSignature: hash("c"),
        decision: "ALLOW",
        reasonCode: "OXRAIL_NORMAL_ACTION_PASSTHROUGH",
        timestamp: 1,
      },
      activeHandoffId: `handoff-${canary}`,
      pendingNativeActionIds: [`pending-${canary}`],
    };

    const sanitized = sanitizeBrowserTaskStateForPersistence(state);
    const serialized = JSON.stringify(sanitized);

    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("/private");
    expect(serialized).not.toContain("document-raw-id");
    expect(serialized).not.toContain("observation-document-id");
    expect(serialized).not.toContain("frame-raw-id");
    expect(serialized).not.toContain("viewport-raw-id");
    expect(sanitized).toMatchObject({
      goalSummary: "browser task",
      currentOrigin: "https://example.test",
      lastObservation: {
        source: "NATIVE_VISUAL",
        tier: "O1",
        stateHash: hash("a"),
        revision: 1,
      },
      lastAction: {
        actionType: "click",
        targetSignature: hash("b"),
        inputSignature: hash("c"),
      },
    });
    expect(sanitized).not.toHaveProperty("currentUrlKey");
    expect(sanitized.lastObservation).not.toHaveProperty("urlKey");
    expect(sanitized.lastObservation).not.toHaveProperty("blockerType");
    expect(sanitized.lastObservation).not.toHaveProperty("omittedFields");
    expect(sanitized.lastObservation).not.toHaveProperty(
      "controlCriticalFieldsRetained",
    );
  });

  it("is deterministic and idempotent for already-sanitized identifiers", () => {
    const state = {
      ...createBrowserTaskState({
        sessionId: "session-1",
        taskId: "task-1",
        hostProfileId: "profile-1",
        mode: "MICRO_ACTION_GUARD",
      }),
      documentBinding: "document-1",
      pendingNativeActionIds: ["call-1"],
    };

    const once = sanitizeBrowserTaskStateForPersistence(state);
    const twice = sanitizeBrowserTaskStateForPersistence(once);

    expect(twice).toEqual(once);
    expect(once.documentBinding).toMatch(/^oxrail-id:[a-f0-9]{64}$/);
    expect(once.pendingNativeActionIds[0]).toMatch(/^oxrail-id:[a-f0-9]{64}$/);
  });

  it("rejects invalid state without echoing its contents", () => {
    const canary = "OXRAIL_SECRET_CANARY_INVALID_8521";
    let error: unknown;
    try {
      sanitizeBrowserTaskStateForPersistence({
        goalSummary: canary,
      } as unknown as BrowserTaskState);
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(TypeError);
    expect(String(error)).not.toContain(canary);
  });
});
