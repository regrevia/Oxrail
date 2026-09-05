import { deterministicDigest } from "../../protocol/src/digest.js";
import {
  CredentialEnclaveTicketSchema,
  CredentialProvisionIntentSchema,
  CredentialUseRegistryEntrySchema,
  type CredentialEnclaveTicket,
  type CredentialUseRegistryEntry,
} from "../../protocol/src/schemas.js";
import type { HandoffLease } from "./handoff.js";

export type CredentialAdmissionErrorCode =
  | "INVALID_INTENT"
  | "INVALID_REGISTRY"
  | "UNKNOWN_CREDENTIAL_USE"
  | "AMBIGUOUS_CREDENTIAL_USE"
  | "INVALID_HANDOFF"
  | "HANDOFF_INACTIVE"
  | "HANDOFF_EXPIRED"
  | "ORIGIN_MISMATCH";

export class CredentialAdmissionError extends Error {
  constructor(readonly code: CredentialAdmissionErrorCode) {
    super(`credential admission denied: ${code.toLowerCase()}`);
    this.name = "CredentialAdmissionError";
  }
}

const deny = (code: CredentialAdmissionErrorCode): never => {
  throw new CredentialAdmissionError(code);
};

function canonicalHttpsOrigin(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2_048) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.origin === value;
  } catch {
    return false;
  }
}

function validateActiveHandoff(
  lease: HandoffLease,
  now: number,
): asserts lease is HandoffLease & {
  holder: "USER";
  state: "ACTIVE";
} {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    lease?.schemaVersion !== 1 ||
    typeof lease.handoffId !== "string" ||
    lease.handoffId.length === 0 ||
    lease.handoffId.length > 4_096 ||
    !Number.isSafeInteger(lease.leaseEpoch) ||
    lease.leaseEpoch <= 0 ||
    typeof lease.nonce !== "string" ||
    !/^[A-Za-z0-9_-]{32,}$/.test(lease.nonce) ||
    !Number.isSafeInteger(lease.acquiredAt) ||
    lease.acquiredAt < 0 ||
    !Number.isSafeInteger(lease.expiresAt) ||
    lease.expiresAt <= lease.acquiredAt ||
    !lease.scope ||
    typeof lease.scope.sessionId !== "string" ||
    lease.scope.sessionId.length === 0 ||
    lease.scope.sessionId.length > 4_096 ||
    typeof lease.scope.taskId !== "string" ||
    lease.scope.taskId.length === 0 ||
    lease.scope.taskId.length > 4_096 ||
    !Number.isSafeInteger(lease.scope.tabId) ||
    lease.scope.tabId < 0 ||
    !canonicalHttpsOrigin(lease.scope.topOrigin) ||
    typeof lease.scope.documentBinding !== "string" ||
    lease.scope.documentBinding.length === 0 ||
    lease.scope.documentBinding.length > 4_096
  ) {
    deny("INVALID_HANDOFF");
  }
  if (lease.state !== "ACTIVE" || lease.holder !== "USER") {
    deny("HANDOFF_INACTIVE");
  }
  if (now < lease.acquiredAt || now > lease.expiresAt) {
    deny("HANDOFF_EXPIRED");
  }
}

/** Package-internal builder; only the locked coordinator may supply the anchor. */
export function bindCredentialIntentToActivationAnchor(
  value: unknown,
  registry: readonly CredentialUseRegistryEntry[],
  handoff: HandoffLease,
  now: number,
  activationAnchorHash: string,
): CredentialEnclaveTicket {
  const intent = CredentialProvisionIntentSchema.safeParse(value);
  if (!intent.success) throw new CredentialAdmissionError("INVALID_INTENT");

  let entries: CredentialUseRegistryEntry[] = [];
  try {
    entries = registry.map((entry) =>
      CredentialUseRegistryEntrySchema.parse(entry),
    );
  } catch {
    deny("INVALID_REGISTRY");
  }
  const matches = entries.filter(
    ({ credentialUseId }) => credentialUseId === intent.data.credentialUseId,
  );
  if (matches.length === 0) deny("UNKNOWN_CREDENTIAL_USE");
  if (matches.length !== 1) deny("AMBIGUOUS_CREDENTIAL_USE");

  validateActiveHandoff(handoff, now);
  const entry = matches[0]!;
  if (entry.provisioningOrigin !== handoff.scope.topOrigin) {
    deny("ORIGIN_MISMATCH");
  }
  if (!/^[a-f0-9]{64}$/.test(activationAnchorHash)) {
    deny("INVALID_HANDOFF");
  }
  return CredentialEnclaveTicketSchema.parse({
    schemaVersion: 2,
    authority: "FIXTURE_ONLY_NON_AUTHORIZING",
    ticketId: `oct1_${deterministicDigest(
      "oxrail-credential-fixture-ticket-v2",
      { activationAnchorHash, entry, issuedAt: now },
    )}`,
    credentialUseId: entry.credentialUseId,
    credentialKind: entry.credentialKind,
    templateId: entry.templateId,
    serviceId: entry.serviceId,
    provisioningOrigin: entry.provisioningOrigin,
    purposeId: entry.purposeId,
    consumerId: entry.consumerId,
    grantTtlSeconds: entry.grantTtlSeconds,
    generation: entry.generation,
    registryVersion: entry.registryVersion,
    templateRegistryHash: entry.templateRegistryHash,
    consumerRegistryHash: entry.consumerRegistryHash,
    registryManifestHash: entry.registryManifestHash,
    issuedAt: now,
    handoff: {
      activationAnchorHash,
      leaseEpoch: handoff.leaseEpoch,
      acquiredAt: handoff.acquiredAt,
      expiresAt: handoff.expiresAt,
    },
  });
}
