import { describe, expect, it } from "vitest";

import {
  assertNativeInputPassThrough,
  assertOwnershipInvariant,
  checkNativeInputPassThrough,
  NativeInputMutationError,
  ownershipForPhase,
  RELEASE_OVERLAY_POLICY,
  resultTransformationAllowed,
} from "../packages/native-fidelity/src/index.js";

describe("Native interaction fidelity", () => {
  it("fingerprints ordinary inputs exactly and never repairs low-level fields", () => {
    const input = { action: "click", pointer: { x: 10, y: 20 }, clickCount: 1 };
    expect(
      checkNativeInputPassThrough(input, structuredClone(input)),
    ).toMatchObject({
      disposition: "PASS_THROUGH_ORIGINAL",
      primitiveHashMatches: true,
    });
    expect(() =>
      assertNativeInputPassThrough(input, {
        ...input,
        pointer: { x: 11, y: 20 },
      }),
    ).toThrow(NativeInputMutationError);
  });

  it("isolates only an explicitly evidenced semantic hint path", () => {
    const original = { action: "click", pointer: { x: 10, y: 20 } };
    const forwarded = {
      ...original,
      semantic_target_hint: { role: "button", name: "Continue" },
    };
    expect(
      assertNativeInputPassThrough(original, forwarded, [
        "semantic_target_hint",
      ]).disposition,
    ).toBe("SEMANTIC_HINT_ONLY");
    expect(() => assertNativeInputPassThrough(original, forwarded)).toThrow(
      NativeInputMutationError,
    );
    expect(() =>
      assertNativeInputPassThrough(
        original,
        { ...original, pointer: { x: 11, y: 20 } },
        ["pointer.x"],
      ),
    ).toThrow(NativeInputMutationError);
  });

  it("enforces Native/Human/None ownership and zero runtime overlay", () => {
    expect(
      assertOwnershipInvariant(ownershipForPhase("RUNNING", 0, 0)).pointerOwner,
    ).toBe("NATIVE");
    expect(
      assertOwnershipInvariant(ownershipForPhase("USER_LEASE_ACTIVE", 1, 0)),
    ).toMatchObject({
      pointerOwner: "HUMAN",
      keyboardOwner: "HUMAN",
      browserActionAllowedForAgent: false,
      browserObservationAllowedForAgent: false,
    });
    expect(() =>
      assertOwnershipInvariant({
        ...ownershipForPhase("RESUMING", 1, 1),
        pointerOwner: "NATIVE",
      }),
    ).toThrow(/Illegal RESUMING/);
    expect(RELEASE_OVERLAY_POLICY.allowRuntimeOverlay).toBe(false);
  });

  it("keeps native results when any control-critical field is unknown", () => {
    const contract = {
      contractId: "contract",
      hostProfileId: "profile",
      resultMedia: "structured",
      rules: [
        {
          fieldPath: "frame.id",
          criticality: "UNKNOWN",
          nextPrimitivesTested: [],
          hostProfileId: "profile",
          evidenceIds: [],
          rationale: "not tested",
        },
      ],
      originalResultTiming: "UNKNOWN",
      verdict: "INCOMPLETE",
      matrixHash: "a".repeat(64),
    } as const;
    expect(resultTransformationAllowed(contract)).toBe(false);
  });
});
