import { createHash } from "node:crypto";

import {
  BrowserTaskStateSchema,
  type BrowserTaskState,
} from "../../protocol/src/index.js";

const sanitizedId = /^oxrail-id:[a-f0-9]{64}$/;

function digestId(domain: string, value: string): string {
  if (sanitizedId.test(value)) return value;
  return `oxrail-id:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(value)
    .digest("hex")}`;
}

export const persistentDocumentBinding = (value: string): string =>
  digestId("oxrail-persisted-document-v1", value);

export const persistentToolUseId = (value: string): string =>
  digestId("oxrail-persisted-tool-use-v1", value);

export const persistentHandoffId = (value: string): string =>
  digestId("oxrail-persisted-handoff-v1", value);

function canonicalOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) ? url.origin : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Removes user/page-derived text and opaque host identifiers before local
 * persistence. Callers still own semantic classification at ingestion time.
 */
export function sanitizeBrowserTaskStateForPersistence(
  value: BrowserTaskState,
): BrowserTaskState {
  const parsed = BrowserTaskStateSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("invalid BrowserTaskState");
  const state = parsed.data;
  const currentOrigin = canonicalOrigin(state.currentOrigin);
  const lastObservation = state.lastObservation
    ? {
        source: state.lastObservation.source,
        tier: state.lastObservation.tier,
        stateHash: state.lastObservation.stateHash,
        ...(state.lastObservation.documentBinding
          ? {
              documentBinding: persistentDocumentBinding(
                state.lastObservation.documentBinding,
              ),
            }
          : {}),
        revision: state.lastObservation.revision,
        ...(state.lastObservation.relevantRegionHash
          ? { relevantRegionHash: state.lastObservation.relevantRegionHash }
          : {}),
        ...(state.lastObservation.actionableHash
          ? { actionableHash: state.lastObservation.actionableHash }
          : {}),
        ...(state.lastObservation.payloadTokenEstimate !== undefined
          ? {
              payloadTokenEstimate: state.lastObservation.payloadTokenEstimate,
            }
          : {}),
        ...(state.lastObservation.screenshotFrameCorrelationId
          ? {
              screenshotFrameCorrelationId: digestId(
                "oxrail-screenshot-frame-v1",
                state.lastObservation.screenshotFrameCorrelationId,
              ),
            }
          : {}),
        ...(state.lastObservation.viewportBinding
          ? {
              viewportBinding: digestId(
                "oxrail-viewport-binding-v1",
                state.lastObservation.viewportBinding,
              ),
            }
          : {}),
      }
    : undefined;
  const lastAction = state.lastAction
    ? {
        ...state.lastAction,
        toolUseId: persistentToolUseId(state.lastAction.toolUseId),
      }
    : undefined;
  const {
    activeHandoffId: _activeHandoffId,
    currentOrigin: _currentOrigin,
    currentUrlKey: _currentUrlKey,
    documentBinding: _documentBinding,
    lastAction: _lastAction,
    lastObservation: _lastObservation,
    pendingNativeActionIds: _pendingNativeActionIds,
    turnId: _turnId,
    ...contentFreeState
  } = state;

  return BrowserTaskStateSchema.parse({
    ...contentFreeState,
    ...(state.turnId
      ? { turnId: digestId("oxrail-persisted-turn-v1", state.turnId) }
      : {}),
    goalSummary: "browser task",
    ...(currentOrigin ? { currentOrigin } : {}),
    ...(state.documentBinding
      ? {
          documentBinding: persistentDocumentBinding(state.documentBinding),
        }
      : {}),
    lastObservation,
    lastAction,
    ...(state.activeHandoffId
      ? {
          activeHandoffId: persistentHandoffId(state.activeHandoffId),
        }
      : {}),
    pendingNativeActionIds:
      state.pendingNativeActionIds.map(persistentToolUseId),
  });
}
