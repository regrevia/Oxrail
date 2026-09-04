import { describe, expect, it, vi } from "vitest";

import {
  type CacheValidation,
  WorkflowCache,
  type WorkflowCacheKey,
  type WorkflowRecipe,
} from "../packages/core/src/cache.js";

const digest = (character: string) => character.repeat(64);

const key = (overrides: Partial<WorkflowCacheKey> = {}): WorkflowCacheKey => ({
  sessionId: "session-1",
  taskId: "task-1",
  hostProfileId: "profile-1",
  browserPath: "chrome-extension",
  topOrigin: "https://example.test",
  routePattern: "/checkout/:step",
  documentFingerprint: digest("a"),
  goalSignature: digest("b"),
  schemaVersion: 6,
  rankingVersion: "ranking-1",
  revision: 7,
  targetCacheEpoch: 3,
  ...overrides,
});

const recipe: WorkflowRecipe = {
  recipeVersion: 1,
  goalSignature: digest("b"),
  originPattern: "https://example.test",
  routePattern: "/checkout/:step",
  prerequisiteSignals: ["checkout-form-present"],
  targetRecipe: [
    {
      role: "button",
      namePattern: "submit-order",
      regionPattern: "main",
      verification: "enabled-submit-control",
    },
  ],
  expectedPostconditions: ["confirmation-visible"],
  riskClass: "HIGH_IMPACT",
  invalidationRules: ["document-or-risk-change"],
};

const valid = {
  originMatches: true,
  routeMatches: true,
  prerequisiteSignalsMatch: true,
  targetResolvedRevision: 7,
  risk: "UNCHANGED" as const,
};

describe("session-local Workflow Cache", () => {
  it("hits only the exact content-free scope and requires fresh target/risk validation", () => {
    const cache = new WorkflowCache({ ttlMs: 1_000, now: () => 10 });
    cache.put(key(), recipe);
    const validator = vi.fn((_recipe, request) => {
      expect(request).toEqual({
        currentRevision: 7,
        targetCacheEpoch: 3,
        reResolveTarget: true,
        revalidateRisk: true,
        verifyOriginAndRoute: true,
        verifyPrerequisites: true,
      });
      return valid;
    });

    const hit = cache.lookup(key(), validator);

    expect(validator).toHaveBeenCalledOnce();
    expect(hit).toMatchObject({
      status: "HIT",
      recipe,
      requirements: {
        nativeComputerUseExecutes: true,
        postconditionVerificationRequired: true,
        riskRevalidated: true,
        targetReResolvedOnRevision: 7,
      },
    });

    const changedScopes: WorkflowCacheKey[] = [
      key({ sessionId: "session-2" }),
      key({ taskId: "task-2" }),
      key({ hostProfileId: "profile-2" }),
      key({ browserPath: "built-in-browser" }),
      key({ topOrigin: "https://other.test" }),
      key({ routePattern: "/account" }),
      key({ documentFingerprint: digest("c") }),
      key({ goalSignature: digest("d") }),
      key({ schemaVersion: 7 }),
      key({ rankingVersion: "ranking-2" }),
      key({ revision: 8 }),
      key({ targetCacheEpoch: 4 }),
    ];
    expect(
      changedScopes.every(
        (changed) => cache.lookup(changed, () => valid).status === "MISS",
      ),
    ).toBe(true);
  });

  it("expires entries and flushes the whole session on handoff", () => {
    let now = 20;
    const cache = new WorkflowCache({ ttlMs: 100, now: () => now });
    cache.put(key(), recipe);
    cache.put(key({ taskId: "task-2" }), recipe);

    now = 121;
    expect(cache.lookup(key(), () => valid)).toEqual({
      status: "MISS",
      reason: "EXPIRED",
    });

    cache.put(key(), recipe);
    cache.invalidateForHandoff("session-1");
    expect(cache.lookup(key(), () => valid).status).toBe("MISS");
    expect(cache.lookup(key({ taskId: "task-2" }), () => valid).status).toBe(
      "MISS",
    );
  });

  it("turns every page, target, or risk validation failure into a safe miss", () => {
    const cache = new WorkflowCache({ ttlMs: 1_000 });
    cache.put(key(), recipe);

    for (const invalid of [
      { ...valid, originMatches: false },
      { ...valid, routeMatches: false },
      { ...valid, prerequisiteSignalsMatch: false },
      { ...valid, targetResolvedRevision: null },
      { ...valid, targetResolvedRevision: 6 },
      { ...valid, risk: "INVALID" as const },
    ]) {
      expect(cache.lookup(key(), () => invalid).status).toBe("MISS");
    }
    expect(
      cache.lookup(key(), () => {
        throw new Error("unavailable validator");
      }),
    ).toEqual({ status: "MISS", reason: "VALIDATION_FAILED" });
    expect(
      cache.lookup(key(), () => ({ ...valid, risk: "APPROVAL_REQUIRED" })),
    ).toEqual({
      status: "MISS",
      reason: "RISK_CHANGED",
      fallback: "NATIVE_APPROVAL",
    });
    expect(
      cache.lookup(key(), () => ({ ...valid, risk: "HANDOFF_REQUIRED" })),
    ).toEqual({
      status: "MISS",
      reason: "RISK_CHANGED",
      fallback: "HANDOFF",
    });
  });

  it("rejects malformed or content-bearing entries before they reach memory", () => {
    expect(() => new WorkflowCache({ ttlMs: 0 })).toThrow();
    expect(
      () => new WorkflowCache({ ttlMs: Number.POSITIVE_INFINITY }),
    ).toThrow();

    const cache = new WorkflowCache({ ttlMs: 1_000 });
    const marker = "SENSITIVE-MARKER-DO-NOT-ECHO";
    const rejectWithoutEcho = (
      candidateKey: unknown,
      candidateRecipe: unknown,
    ) => {
      try {
        cache.put(
          candidateKey as WorkflowCacheKey,
          candidateRecipe as WorkflowRecipe,
        );
        throw new Error("expected cache input rejection");
      } catch (error) {
        expect(String(error)).not.toContain(marker);
        expect(String(error)).not.toContain("expected cache input rejection");
      }
    };

    rejectWithoutEcho({ ...key(), rawPage: marker }, recipe);
    rejectWithoutEcho(key({ sessionId: "" }), recipe);
    rejectWithoutEcho(
      key({ topOrigin: "https://example.test/private" }),
      recipe,
    );
    rejectWithoutEcho(key({ documentFingerprint: marker }), recipe);
    rejectWithoutEcho(key({ revision: Number.MAX_SAFE_INTEGER + 1 }), recipe);
    rejectWithoutEcho(
      key({ targetCacheEpoch: Number.MAX_SAFE_INTEGER + 1 }),
      recipe,
    );
    rejectWithoutEcho(key(), { ...recipe, goalSignature: digest("c") });
    rejectWithoutEcho(key(), {
      ...recipe,
      originPattern: "https://other.test",
    });
    rejectWithoutEcho(key(), { ...recipe, routePattern: "/other" });
    for (const field of [
      "bbox",
      "x",
      "y",
      "coordinates",
      "semanticRef",
      "input",
      "keyStream",
      "value",
      "rawPage",
      "secret",
    ]) {
      rejectWithoutEcho(key(), { ...recipe, [field]: marker });
      rejectWithoutEcho(key(), {
        ...recipe,
        targetRecipe: [{ ...recipe.targetRecipe[0], [field]: marker }],
      });
    }
    rejectWithoutEcho(key(), {
      ...recipe,
      prerequisiteSignals: [`Bearer ${marker}`],
    });
    rejectWithoutEcho(key(), {
      ...recipe,
      targetRecipe: Array.from({ length: 65 }, () => recipe.targetRecipe[0]),
    });
  });

  it("bounds session memory and treats an unusable clock or validator as a miss", () => {
    let now = 30;
    const cache = new WorkflowCache({
      ttlMs: 1_000,
      maxEntries: 2,
      now: () => now,
    });
    cache.put(key({ taskId: "task-1" }), recipe);
    cache.put(key({ taskId: "task-2" }), recipe);
    cache.put(key({ taskId: "task-3" }), recipe);

    expect(cache.lookup(key({ taskId: "task-1" }), () => valid).status).toBe(
      "MISS",
    );
    expect(cache.lookup(key({ taskId: "task-2" }), () => valid).status).toBe(
      "HIT",
    );
    expect(
      cache.lookup(
        key({ taskId: "task-2" }),
        () => null as unknown as CacheValidation,
      ),
    ).toEqual({ status: "MISS", reason: "VALIDATION_FAILED" });
    expect(
      cache.lookup(key({ taskId: "task-2" }), () => ({
        ...valid,
        targetResolvedRevision: Number.MAX_SAFE_INTEGER + 1,
      })),
    ).toEqual({ status: "MISS", reason: "VALIDATION_FAILED" });

    now = Number.NaN;
    expect(cache.lookup(key({ taskId: "task-2" }), () => valid)).toEqual({
      status: "MISS",
      reason: "CLOCK_INVALID",
    });
    now = 31;
    expect(cache.lookup(key({ taskId: "task-2" }), () => valid).status).toBe(
      "MISS",
    );
  });
});
