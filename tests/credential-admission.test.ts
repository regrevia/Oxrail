import { describe, expect, it } from "vitest";

import {
  bindCredentialIntent,
  CredentialAdmissionError,
  prepareHandoffLease,
  transitionHandoffLease,
} from "../packages/core/src/index.js";
import {
  CredentialProvisionIntentSchema,
  CredentialPublicResultSchema,
  type CredentialUseRegistryEntry,
} from "../packages/protocol/src/index.js";

const now = 2_000;
const origin = "https://credentials.example.test";
const canary = "oxrail_api_key_must_never_cross_admission";
const registryEntry: CredentialUseRegistryEntry = {
  schemaVersion: 1,
  credentialUseId: "fixture.publish.api-key",
  credentialKind: "API_KEY",
  templateId: "fixture.api-key.v1",
  serviceId: "fixture-service",
  provisioningOrigin: origin,
  purposeId: "publish-post",
  consumerId: "fixture.https.publisher",
  grantTtlSeconds: 3_600,
  generation: 7,
  readiness: "FIXTURE_ONLY",
  registryVersion: 3,
  templateRegistryHash: "a".repeat(64),
  consumerRegistryHash: "b".repeat(64),
  registryManifestHash: "c".repeat(64),
};

function activeHandoff() {
  const pending = prepareHandoffLease({
    handoffId: "credential-handoff",
    previousLeaseEpoch: 0,
    nonce: "0123456789abcdef0123456789abcdef",
    scope: {
      sessionId: "session-binding",
      taskId: "task-binding",
      tabId: 42,
      topOrigin: origin,
      documentBinding: "document-binding",
    },
    createdAt: 1_000,
    expiresAt: 10_000,
  });
  const transition = transitionHandoffLease(
    pending,
    {
      kind: "ACTIVATE",
      handoffId: pending.handoffId,
      leaseEpoch: pending.leaseEpoch,
      nonce: pending.nonce,
      scope: pending.scope,
      observedAt: 1_001,
    },
    1_001,
  );
  if (!transition.accepted) throw new Error(transition.reason);
  return transition.lease;
}

describe("credential admission", () => {
  it("accepts only an allowlisted id and inherits the exact active tab binding", () => {
    const handoff = activeHandoff();
    const ticket = bindCredentialIntent(
      { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
      [registryEntry],
      handoff,
      now,
    );

    expect(ticket).toMatchObject({
      authority: "FIXTURE_ONLY_NON_AUTHORIZING",
      credentialKind: "API_KEY",
      credentialUseId: registryEntry.credentialUseId,
      templateId: registryEntry.templateId,
      serviceId: registryEntry.serviceId,
      provisioningOrigin: origin,
      purposeId: registryEntry.purposeId,
      consumerId: registryEntry.consumerId,
      grantTtlSeconds: registryEntry.grantTtlSeconds,
      generation: registryEntry.generation,
      handoff: {
        handoffId: handoff.handoffId,
        sessionId: handoff.scope.sessionId,
        taskId: handoff.scope.taskId,
        tabId: handoff.scope.tabId,
        topOrigin: handoff.scope.topOrigin,
        documentBinding: handoff.scope.documentBinding,
        leaseEpoch: handoff.leaseEpoch,
      },
    });
    expect(ticket.ticketId).toMatch(/^oct1_[a-f0-9]{64}$/);
    expect(ticket.handoff.bindingHash).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(ticket)).not.toContain(handoff.nonce);
    expect(JSON.stringify(ticket)).not.toContain(canary);
  });

  it("rejects every Agent/page-defined prompt or scope field without echoing values", () => {
    for (const field of [
      "label",
      "instruction",
      "style",
      "origin",
      "consumerId",
      "ttl",
      "apiKey",
      "value",
    ]) {
      const parsed = CredentialProvisionIntentSchema.safeParse({
        schemaVersion: 1,
        credentialUseId: registryEntry.credentialUseId,
        [field]: canary,
      });
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(canary);
      expect(() =>
        bindCredentialIntent(
          {
            schemaVersion: 1,
            credentialUseId: registryEntry.credentialUseId,
            [field]: canary,
          },
          [registryEntry],
          activeHandoff(),
          now,
        ),
      ).toThrowError(
        expect.objectContaining<Partial<CredentialAdmissionError>>({
          code: "INVALID_INTENT",
        }),
      );
    }
  });

  it("fails closed for unknown, ambiguous, inactive, expired, or wrong-origin admission", () => {
    expect(() =>
      bindCredentialIntent(
        { schemaVersion: 1, credentialUseId: "unknown.use" },
        [registryEntry],
        activeHandoff(),
        now,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CredentialAdmissionError>>({
        code: "UNKNOWN_CREDENTIAL_USE",
      }),
    );
    expect(() =>
      bindCredentialIntent(
        { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
        [registryEntry, registryEntry],
        activeHandoff(),
        now,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CredentialAdmissionError>>({
        code: "AMBIGUOUS_CREDENTIAL_USE",
      }),
    );
    expect(() =>
      bindCredentialIntent(
        { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
        [registryEntry],
        { ...activeHandoff(), state: "PENDING", holder: "NONE" },
        now,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CredentialAdmissionError>>({
        code: "HANDOFF_INACTIVE",
      }),
    );
    expect(() =>
      bindCredentialIntent(
        { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
        [registryEntry],
        activeHandoff(),
        10_001,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CredentialAdmissionError>>({
        code: "HANDOFF_EXPIRED",
      }),
    );
    expect(() =>
      bindCredentialIntent(
        { schemaVersion: 1, credentialUseId: registryEntry.credentialUseId },
        [
          {
            ...registryEntry,
            provisioningOrigin: "https://other.example.test",
          },
        ],
        activeHandoff(),
        now,
      ),
    ).toThrowError(
      expect.objectContaining<Partial<CredentialAdmissionError>>({
        code: "ORIGIN_MISMATCH",
      }),
    );
  });

  it("keeps the model-visible result limited to opaque refs and fixed codes", () => {
    const credentialRef = `ocref1_${"A".repeat(43)}`;
    for (const result of [
      { schemaVersion: 1, status: "READY", credentialRef },
      { schemaVersion: 1, status: "STORED", credentialRef },
      { schemaVersion: 1, status: "CANCELLED" },
      { schemaVersion: 1, status: "ERROR", errorCode: "SCOPE_MISMATCH" },
    ]) {
      expect(CredentialPublicResultSchema.safeParse(result).success).toBe(true);
    }
    for (const result of [
      { schemaVersion: 1, status: "READY", credentialRef, value: canary },
      { schemaVersion: 1, status: "READY", credentialRef: canary },
      { schemaVersion: 1, status: "ERROR", errorCode: "RAW", error: canary },
      {
        schemaVersion: 1,
        status: "STORED",
        credentialRef,
        keychainPersistentRef: canary,
      },
    ]) {
      const parsed = CredentialPublicResultSchema.safeParse(result);
      expect(parsed.success).toBe(false);
      expect(JSON.stringify(parsed)).not.toContain(canary);
    }
  });
});
