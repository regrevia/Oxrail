import {
  ControlOwnershipStateSchema,
  type ControlOwnershipState,
} from "../../protocol/src/index.js";

export function ownershipForPhase(
  phase: ControlOwnershipState["phase"],
  leaseEpoch: number,
  targetCacheEpoch: number,
  runningObservationAllowed = true,
): ControlOwnershipState {
  if (phase === "RUNNING") {
    return {
      phase,
      pointerOwner: "NATIVE",
      keyboardOwner: "NATIVE",
      browserObservationAllowedForAgent: runningObservationAllowed,
      browserActionAllowedForAgent: true,
      leaseEpoch,
      targetCacheEpoch,
    };
  }
  if (phase === "USER_LEASE_ACTIVE") {
    return {
      phase,
      pointerOwner: "HUMAN",
      keyboardOwner: "HUMAN",
      browserObservationAllowedForAgent: false,
      browserActionAllowedForAgent: false,
      leaseEpoch,
      targetCacheEpoch,
    };
  }
  return {
    phase,
    pointerOwner: "NONE",
    keyboardOwner: "NONE",
    browserObservationAllowedForAgent: false,
    browserActionAllowedForAgent: false,
    leaseEpoch,
    targetCacheEpoch,
  };
}

export function assertOwnershipInvariant(
  input: unknown,
): ControlOwnershipState {
  const state = ControlOwnershipStateSchema.parse(input);
  const expected = ownershipForPhase(
    state.phase,
    state.leaseEpoch,
    state.targetCacheEpoch,
    state.phase === "RUNNING" ? state.browserObservationAllowedForAgent : false,
  );
  if (
    state.pointerOwner !== expected.pointerOwner ||
    state.keyboardOwner !== expected.keyboardOwner ||
    state.browserActionAllowedForAgent !==
      expected.browserActionAllowedForAgent ||
    state.browserObservationAllowedForAgent !==
      expected.browserObservationAllowedForAgent
  ) {
    throw new Error(`Illegal ${state.phase} control ownership`);
  }
  return state;
}

export const RELEASE_OVERLAY_POLICY = Object.freeze({
  allowRuntimeOverlay: false,
});
